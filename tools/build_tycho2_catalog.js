#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const zlib = require("node:zlib");

const ROOT = path.resolve(__dirname, "..");
const defaultInputs = [
    {
        path: path.join(ROOT, "data", "catalog.dat"),
        raIndex: 24,
        decIndex: 25,
        vtIndex: 19,
        name: "catalog.dat",
    },
    {
        path: path.join(ROOT, "data", "suppl_1.dat"),
        raIndex: 2,
        decIndex: 3,
        vtIndex: 13,
        name: "suppl_1.dat",
    },
    {
        path: path.join(ROOT, "data", "suppl_2.dat"),
        raIndex: 2,
        decIndex: 3,
        vtIndex: 13,
        name: "suppl_2.dat",
    },
];
const inputArgs = process.argv.slice(2).filter(arg => arg !== "--");
const singleArgIsInput = inputArgs.length === 1 && /\.dat$/i.test(inputArgs[0]);
const explicitInputs = singleArgIsInput ? inputArgs :
    (inputArgs.length > 1 ? inputArgs.slice(0, -1) : []);
const inputFiles = explicitInputs.length > 0 ?
    explicitInputs.map(input => ({
        path: path.resolve(input),
        raIndex: 24,
        decIndex: 25,
        vtIndex: 19,
        name: path.basename(input),
    })) :
    defaultInputs;
const outputPath = inputArgs.length > 0 && !singleArgIsInput ?
    path.resolve(inputArgs[inputArgs.length - 1]) :
    path.join(ROOT, "data", "tycho2_mag8.bin.gz");
const metaPath = outputPath.replace(/\.bin(?:\.gz)?$/i, ".json");
const maxMagnitude = Number(process.env.TYCHO2_MAX_MAG || 8);

const binaryFormat = {
    container: "gzip-compressed byte stream",
    payloadMagic: "WISCAT1\\0",
    byteOrder: "little-endian",
    integerEncoding: "unsigned 32-bit little-endian",
    floatEncoding: "IEEE-754 binary32 little-endian",
    headerBytes: 16,
    header: [
        "bytes 0..7: ASCII magic WISCAT1\\0",
        "bytes 8..11: uint32 star count",
        "bytes 12..15: uint32 float stride, currently 3",
    ],
    record: [
        "float32 right ascension in hours, ICRS/J2000",
        "float32 declination in degrees, ICRS/J2000",
        "float32 Tycho V_T magnitude",
    ],
};

async function main() {
    const stars = [];
    const stats = [];
    const seen = new Set();

    for (const input of inputFiles) {
        let read = 0;
        let accepted = 0;
        let skipped = 0;
        let duplicates = 0;
        if (!fs.existsSync(input.path)) {
            throw new Error(`Tycho-2 input file not found: ${input.path}`);
        }
        const rl = readline.createInterface({
            input: fs.createReadStream(input.path),
            crlfDelay: Infinity,
        });

        for await (const line of rl) {
            read += 1;
            const fields = line.split("|").map(value => value.trim());
            const raDeg = Number(fields[input.raIndex]);
            const decDeg = Number(fields[input.decIndex]);
            const vtMag = Number(fields[input.vtIndex]);
            if (!Number.isFinite(raDeg) || !Number.isFinite(decDeg) ||
                    !Number.isFinite(vtMag) || vtMag >= maxMagnitude) {
                skipped += 1;
                continue;
            }
            const key = `${raDeg.toFixed(7)}:${decDeg.toFixed(7)}:${vtMag.toFixed(3)}`;
            if (seen.has(key)) {
                duplicates += 1;
                continue;
            }
            seen.add(key);
            stars.push([raDeg / 15, decDeg, vtMag]);
            accepted += 1;
        }

        stats.push({
            source: path.relative(ROOT, input.path),
            rightAscensionColumn: input.raIndex + 1,
            declinationColumn: input.decIndex + 1,
            vtMagnitudeColumn: input.vtIndex + 1,
            inputRows: read,
            acceptedRows: accepted,
            skippedRows: skipped,
            duplicateRows: duplicates,
        });
    }

    stars.sort((a, b) => a[2] - b[2] || a[0] - b[0] || a[1] - b[1]);

    const headerBytes = 16;
    const buffer = Buffer.alloc(headerBytes + stars.length * 3 * 4);
    buffer.write("WISCAT1\0", 0, "ascii");
    buffer.writeUInt32LE(stars.length, 8);
    buffer.writeUInt32LE(3, 12);
    let offset = headerBytes;
    for (const [raHours, decDeg, vtMag] of stars) {
        buffer.writeFloatLE(raHours, offset); offset += 4;
        buffer.writeFloatLE(decDeg, offset); offset += 4;
        buffer.writeFloatLE(vtMag, offset); offset += 4;
    }

    fs.mkdirSync(path.dirname(outputPath), {recursive: true});
    const compressed = /\.gz$/i.test(outputPath) ?
        zlib.gzipSync(buffer, {level: 9}) :
        buffer;
    fs.writeFileSync(outputPath, compressed);
    fs.writeFileSync(metaPath, `${JSON.stringify({
        sources: stats,
        output: path.relative(ROOT, outputPath),
        selection: "merged Tycho-2 main catalogue plus supplement-1 and supplement-2, filtered to V_T < maxMagnitudeExclusive",
        format: binaryFormat,
        maxMagnitudeExclusive: maxMagnitude,
        stars: stars.length,
        uncompressedBytes: buffer.length,
        compressedBytes: compressed.length,
        generatedAtUtc: new Date().toISOString(),
    }, null, 2)}\n`);

    console.log(`Wrote ${stars.length} Tycho-2 stars to ${outputPath}`);
    console.log(`Wrote metadata to ${metaPath}`);
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
