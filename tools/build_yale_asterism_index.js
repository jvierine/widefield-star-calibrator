#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const zlib = require("zlib");

const ROOT = path.resolve(__dirname, "..");
const STAR_CATALOG = path.join(ROOT, "js", "star_catalog.js");
const OUT_DIR = path.join(ROOT, "data");

const DEG = Math.PI / 180.0;
const RAD = 180.0 / Math.PI;

const DEFAULTS = {
    maxMag: 4.0,
    minSepDeg: 1.5,
    maxSepDeg: 40.0,
    minSideRatio: 0.08,
};

function envNumber(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) ? value : fallback;
}

function formatNumberForName(value) {
    return String(value).replace(/\./g, "p").replace(/-/g, "m");
}

function loadYaleCatalog() {
    const code = fs.readFileSync(STAR_CATALOG, "utf8");
    const sandbox = {window: {}};
    vm.runInNewContext(code, sandbox, {filename: STAR_CATALOG});
    if (!Array.isArray(sandbox.window.AIDA_STAR_CATALOG)) {
        throw new Error("js/star_catalog.js did not define window.AIDA_STAR_CATALOG");
    }
    return sandbox.window.AIDA_STAR_CATALOG;
}

function unitVector(raHours, decDeg) {
    const ra = raHours * 15.0 * DEG;
    const dec = decDeg * DEG;
    const c = Math.cos(dec);
    return [c * Math.cos(ra), c * Math.sin(ra), Math.sin(dec)];
}

function dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function clamp(value, lo, hi) {
    return Math.max(lo, Math.min(hi, value));
}

function angularDistanceRad(a, b) {
    return Math.acos(clamp(dot(a, b), -1.0, 1.0));
}

function makeStars(raw, maxMag) {
    return raw
        .map((row, catalogIndex) => ({
            catalogIndex,
            raHours: Number(row[0]),
            decDeg: Number(row[1]),
            mag: Number(row[2]),
            name: String(row[3] || ""),
        }))
        .filter(star => Number.isFinite(star.raHours) &&
            Number.isFinite(star.decDeg) &&
            Number.isFinite(star.mag) &&
            star.mag <= maxMag)
        .sort((a, b) => a.mag - b.mag || a.catalogIndex - b.catalogIndex)
        .map((star, localIndex) => ({
            ...star,
            localIndex,
            unit: unitVector(star.raHours, star.decDeg),
        }));
}

function buildNeighborLists(stars, minSepRad, maxSepRad) {
    const neighbors = Array.from({length: stars.length}, () => []);
    let pairCount = 0;
    for (let i = 0; i < stars.length; i += 1) {
        if (i > 0 && i % 250 === 0) {
            console.log(`  neighbor pass: ${i}/${stars.length} stars, ${pairCount} pairs`);
        }
        for (let j = i + 1; j < stars.length; j += 1) {
            const sep = angularDistanceRad(stars[i].unit, stars[j].unit);
            if (sep >= minSepRad && sep <= maxSepRad) {
                neighbors[i].push({j, sep});
                neighbors[j].push({j: i, sep});
                pairCount += 1;
            }
        }
    }
    return {neighbors, pairCount};
}

function buildTriangleRecords(stars, neighbors, minSepRad, maxSepRad, minSideRatio) {
    const neighborSets = neighbors.map(list => {
        const set = new Map();
        for (const item of list) {
            set.set(item.j, item.sep);
        }
        return set;
    });
    const records = [];
    const minLongest = minSepRad;
    for (let i = 0; i < stars.length; i += 1) {
        if (i > 0 && i % 100 === 0) {
            console.log(`  triangle pass: ${i}/${stars.length} stars, ${records.length} records`);
        }
        const above = neighbors[i].filter(item => item.j > i);
        for (let m = 0; m < above.length; m += 1) {
            const j = above[m].j;
            const dij = above[m].sep;
            for (let n = m + 1; n < above.length; n += 1) {
                const k = above[n].j;
                const dik = above[n].sep;
                const djk = neighborSets[j].get(k);
                if (!Number.isFinite(djk) || djk < minSepRad || djk > maxSepRad) {
                    continue;
                }
                const sides = [dij, dik, djk].sort((a, b) => a - b);
                const a = sides[0];
                const b = sides[1];
                const c = sides[2];
                if (c < minLongest || c > maxSepRad) {
                    continue;
                }
                const ac = a / c;
                if (ac < minSideRatio) {
                    continue;
                }
                records.push({
                    ac,
                    bc: b / c,
                    cDeg: c * RAD,
                    i0: stars[i].catalogIndex,
                    i1: stars[j].catalogIndex,
                    i2: stars[k].catalogIndex,
                });
            }
        }
    }
    records.sort((a, b) => a.ac - b.ac || a.bc - b.bc || a.cDeg - b.cDeg);
    return records;
}

function writeBinary(records, metadata, outputBase) {
    const magic = Buffer.from("WISAST1\0", "ascii");
    const headerBytes = 32;
    const strideBytes = 20;
    const payload = Buffer.alloc(headerBytes + records.length * strideBytes);
    magic.copy(payload, 0);
    payload.writeUInt32LE(records.length, 8);
    payload.writeUInt32LE(metadata.sourceStarCount, 12);
    payload.writeUInt32LE(strideBytes, 16);
    payload.writeFloatLE(metadata.maxMag, 20);
    payload.writeFloatLE(metadata.minSepDeg, 24);
    payload.writeFloatLE(metadata.maxSepDeg, 28);

    let offset = headerBytes;
    for (const record of records) {
        payload.writeFloatLE(record.ac, offset);
        payload.writeFloatLE(record.bc, offset + 4);
        payload.writeUInt16LE(record.i0, offset + 8);
        payload.writeUInt16LE(record.i1, offset + 10);
        payload.writeUInt16LE(record.i2, offset + 12);
        payload.writeUInt16LE(0, offset + 14);
        payload.writeFloatLE(record.cDeg, offset + 16);
        offset += strideBytes;
    }

    const compressed = zlib.gzipSync(payload, {level: 9});
    const binPath = `${outputBase}.bin.gz`;
    const jsonPath = `${outputBase}.json`;
    fs.writeFileSync(binPath, compressed);
    fs.writeFileSync(jsonPath, `${JSON.stringify({
        ...metadata,
        recordCount: records.length,
        binary: path.basename(binPath),
        format: {
            compression: "gzip",
            byteOrder: "little-endian",
            magic: "WISAST1\\0",
            headerBytes,
            recordStrideBytes: strideBytes,
            record: [
                "float32 ac = a/c",
                "float32 bc = b/c",
                "uint16 yaleStarIndex0",
                "uint16 yaleStarIndex1",
                "uint16 yaleStarIndex2",
                "uint16 reserved",
                "float32 longestSideDeg",
            ],
        },
    }, null, 2)}\n`);
    return {binPath, jsonPath, rawBytes: payload.length, gzipBytes: compressed.length};
}

function main() {
    const options = {
        maxMag: envNumber("YALE_ASTERISM_MAX_MAG", DEFAULTS.maxMag),
        minSepDeg: envNumber("YALE_ASTERISM_MIN_SEP_DEG", DEFAULTS.minSepDeg),
        maxSepDeg: envNumber("YALE_ASTERISM_MAX_SEP_DEG", DEFAULTS.maxSepDeg),
        minSideRatio: envNumber("YALE_ASTERISM_MIN_SIDE_RATIO", DEFAULTS.minSideRatio),
    };
    fs.mkdirSync(OUT_DIR, {recursive: true});
    console.log("Building Yale asterism index");
    console.log(`  maxMag=${options.maxMag}, minSep=${options.minSepDeg} deg, maxSep=${options.maxSepDeg} deg`);
    const raw = loadYaleCatalog();
    const stars = makeStars(raw, options.maxMag);
    console.log(`  selected ${stars.length}/${raw.length} Yale stars`);
    const minSepRad = options.minSepDeg * DEG;
    const maxSepRad = options.maxSepDeg * DEG;
    const {neighbors, pairCount} = buildNeighborLists(stars, minSepRad, maxSepRad);
    console.log(`  usable catalogue pairs: ${pairCount}`);
    const records = buildTriangleRecords(stars, neighbors, minSepRad, maxSepRad, options.minSideRatio);
    console.log(`  usable catalogue triangles: ${records.length}`);

    const baseName = `yale_asterisms_mag${formatNumberForName(options.maxMag)}_min${formatNumberForName(options.minSepDeg)}_max${formatNumberForName(options.maxSepDeg)}`;
    const outputBase = path.join(OUT_DIR, baseName);
    const result = writeBinary(records, {
        generatedUtc: new Date().toISOString(),
        source: "js/star_catalog.js Yale Bright Star Catalogue extract",
        sourceStarCount: raw.length,
        selectedStarCount: stars.length,
        maxMag: options.maxMag,
        minSepDeg: options.minSepDeg,
        maxSepDeg: options.maxSepDeg,
        minSideRatio: options.minSideRatio,
        signature: ["a/c", "b/c"],
        notes: "Triangle sides are angular separations sorted as a <= b <= c. Star indices refer to rows in window.AIDA_STAR_CATALOG.",
    }, outputBase);
    console.log(`  wrote ${path.relative(ROOT, result.binPath)} (${result.gzipBytes} bytes gzip, ${result.rawBytes} bytes raw)`);
    console.log(`  wrote ${path.relative(ROOT, result.jsonPath)}`);
}

if (require.main === module) {
    main();
}
