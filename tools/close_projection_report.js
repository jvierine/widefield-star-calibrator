#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const zlib = require("node:zlib");

const AutoIdentifier = require("../js/auto_identifier.js");
const StarDetector = require("../js/star_detector.js");

const ROOT = path.join(__dirname, "..");
const DEFAULT_CASE_ID = "2026-01-23T20-05-00-000KRN";

function loadBrowserScript(filename) {
    const source = fs.readFileSync(path.join(ROOT, "js", filename), "utf8");
    const context = {window: {}, Math, Date, Number, Array, Uint8Array, ArrayBuffer, DataView};
    vm.createContext(context);
    vm.runInContext(source, context, {filename});
    return context.window;
}

const AidaTools = loadBrowserScript("aidatools.js").AidaTools;
const YaleCatalog = loadBrowserScript("star_catalog.js").AIDA_STAR_CATALOG;

function catalogKey(star) {
    return `${star.name}|${Number(star.raHours).toFixed(7)}|${Number(star.decDeg).toFixed(7)}`;
}

function paethPredictor(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) {
        return a;
    }
    return pb <= pc ? b : c;
}

async function readImageData(filename) {
    const buffer = fs.readFileSync(filename);
    if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
        throw new Error(`close projection report currently expects a PNG image: ${filename}`);
    }
    let offset = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    const idat = [];
    while (offset < buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
        const data = buffer.subarray(offset + 8, offset + 8 + length);
        if (type === "IHDR") {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            bitDepth = data[8];
            colorType = data[9];
            const interlace = data[12];
            if (bitDepth !== 8 || interlace !== 0) {
                throw new Error("close projection report PNG reader expects 8-bit non-interlaced images");
            }
        } else if (type === "IDAT") {
            idat.push(data);
        } else if (type === "IEND") {
            break;
        }
        offset += 12 + length;
    }
    const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
    if (!channels) {
        throw new Error(`unsupported PNG color type ${colorType}`);
    }
    const inflated = zlib.inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    const raw = Buffer.alloc(height * stride);
    let src = 0;
    for (let y = 0; y < height; y += 1) {
        const filter = inflated[src];
        src += 1;
        const row = raw.subarray(y * stride, (y + 1) * stride);
        const prev = y > 0 ? raw.subarray((y - 1) * stride, y * stride) : null;
        for (let x = 0; x < stride; x += 1) {
            const value = inflated[src + x];
            const left = x >= channels ? row[x - channels] : 0;
            const up = prev ? prev[x] : 0;
            const upLeft = prev && x >= channels ? prev[x - channels] : 0;
            if (filter === 0) {
                row[x] = value;
            } else if (filter === 1) {
                row[x] = (value + left) & 0xff;
            } else if (filter === 2) {
                row[x] = (value + up) & 0xff;
            } else if (filter === 3) {
                row[x] = (value + Math.floor((left + up) / 2)) & 0xff;
            } else if (filter === 4) {
                row[x] = (value + paethPredictor(left, up, upLeft)) & 0xff;
            } else {
                throw new Error(`unsupported PNG filter ${filter}`);
            }
        }
        src += stride;
    }
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0, j = 0; i < raw.length; i += channels, j += 4) {
        rgba[j] = raw[i];
        rgba[j + 1] = raw[i + 1];
        rgba[j + 2] = raw[i + 2];
        rgba[j + 3] = channels === 4 ? raw[i + 3] : 255;
    }
    return {
        width,
        height,
        data: rgba,
    };
}

function optmodAndOptpar(metadata) {
    const raw = Array.isArray(metadata.optpar) ? metadata.optpar.map(Number) : [];
    if (Number.isFinite(Number(metadata.optmod))) {
        return {optmod: Number(metadata.optmod), optpar: raw.slice()};
    }
    if (raw.length > 0 && Number.isInteger(raw[0]) && raw[0] > 0 && raw[0] < 100) {
        return {optmod: raw[0], optpar: raw.slice(1)};
    }
    return {optmod: 2, optpar: raw};
}

function projectedStars(metadata, width, height, maxMag) {
    const {optmod, optpar} = optmodAndOptpar(metadata);
    const visible = AidaTools.visibleStars(
        YaleCatalog,
        new Date(metadata.timestampUtc || metadata.date),
        Number(metadata.latDeg),
        Number(metadata.lonDeg),
        maxMag,
        88,
    );
    const projected = [];
    for (const star of visible) {
        const xy = AidaTools.cameraModel(star.az, star.ze, optpar, optmod, width, height);
        if (Number.isFinite(xy.x) && Number.isFinite(xy.y) &&
                xy.x >= 0 && xy.x < width && xy.y >= 0 && xy.y < height) {
            projected.push({...star, x: xy.x, y: xy.y, key: catalogKey(star)});
        }
    }
    projected.sort((a, b) => a.mag - b.mag || a.key.localeCompare(b.key));
    return projected;
}

function scoreAgainstManualMatches(matches, metadata, radiusPx = 12) {
    const manualByKey = new Map((metadata.matches || []).map(match => [match.catalog.key, match]));
    let correct = 0;
    let wrong = 0;
    let unknown = 0;
    const rows = [];
    for (const match of matches) {
        const manual = manualByKey.get(match.star.key);
        if (!manual) {
            unknown += 1;
            rows.push({match, status: "not in manual set", manualDistance: Infinity});
            continue;
        }
        const distance = Math.hypot(match.detection.x - manual.image.x, match.detection.y - manual.image.y);
        if (distance <= radiusPx) {
            correct += 1;
            rows.push({match, status: "correct", manualDistance: distance});
        } else {
            wrong += 1;
            rows.push({match, status: "wrong centroid", manualDistance: distance});
        }
    }
    return {correct, wrong, unknown, rows};
}

function circle(x, y, r, color, title = "") {
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="none" ` +
        `stroke="${color}" stroke-width="2"><title>${escapeHtml(title)}</title></circle>`;
}

function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, ch => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;",
    }[ch]));
}

function writeReport(result, options = {}) {
    const outDir = options.outDir || path.join(ROOT, "test-report", "close-projection");
    fs.mkdirSync(outDir, {recursive: true});
    const imageRel = path.relative(outDir, result.imagePath).replaceAll(path.sep, "/");
    const width = result.imageData.width;
    const height = result.imageData.height;
    const matched = result.identification.matches.map(match =>
        circle(match.detection.x, match.detection.y, 8, "#22c55e", `${match.star.name} ${match.distance.toFixed(1)} px`)
    ).join("\n");
    const manual = (result.metadata.matches || []).map(match =>
        circle(match.image.x, match.image.y, 5, "#ef4444", match.catalog.name)
    ).join("\n");
    const html = `<!doctype html>
<meta charset="utf-8">
<title>Close projection association report</title>
<style>
body{font-family:system-ui,sans-serif;margin:24px;background:#111827;color:#e5e7eb}
.wrap{position:relative;width:min(100%,${width}px)}
img,svg{width:100%;height:auto;display:block}
svg{position:absolute;inset:0}
.ok{color:#22c55e}.bad{color:#f87171}
table{border-collapse:collapse}td,th{padding:4px 8px;border-bottom:1px solid #374151}
</style>
<h1>Close projection association report: ${escapeHtml(result.caseId)}</h1>
<p>${escapeHtml(result.identification.status)}</p>
<p>detections ${result.detections.length}, projected catalog stars ${result.projected.length},
matches ${result.identification.matches.length}, median residual ${result.identification.medianDistance.toFixed(2)} px.</p>
<p>manual overlap: <span class="ok">${result.score.correct} correct</span>,
<span class="bad">${result.score.wrong} wrong</span>, ${result.score.unknown} not in manual seed set.</p>
<div class="wrap">
<img src="${imageRel}">
<svg viewBox="0 0 ${width} ${height}">
${manual}
${matched}
</svg>
</div>
<p>Red circles are manually paired seed stars. Green circles are automatically associated detections.</p>`;
    const htmlPath = path.join(outDir, `${result.caseId}.html`);
    const jsonPath = path.join(outDir, `${result.caseId}.json`);
    fs.writeFileSync(htmlPath, html);
    fs.writeFileSync(jsonPath, JSON.stringify({
        caseId: result.caseId,
        status: result.identification.status,
        detections: result.detections.length,
        projected: result.projected.length,
        matches: result.identification.matches.length,
        medianDistance: result.identification.medianDistance,
        score: {
            correct: result.score.correct,
            wrong: result.score.wrong,
            unknown: result.score.unknown,
        },
    }, null, 2) + "\n");
    return {htmlPath, jsonPath};
}

async function runCloseProjectionCase(caseId = DEFAULT_CASE_ID, options = {}) {
    const caseDir = path.join(ROOT, "test_cases", caseId);
    const metadataPath = path.join(caseDir, "metadata.json");
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    const imagePath = path.join(caseDir, metadata.image);
    const imageData = await readImageData(imagePath);
    const maxMag = Number.isFinite(options.maxMagnitude) ? options.maxMagnitude : 6.5;
    const detections = await StarDetector.detectBrightStars(imageData, {
        maxDetections: Number.isFinite(options.maxDetections) ? options.maxDetections : 650,
        scanStep: 1,
        thresholdSigma: 1.5,
        localThresholdSigma: 1.6,
        requireGlobalThreshold: false,
        maxRadiusPx: 9,
        maxElongation: 4.5,
        suppressionRadiusPx: 8,
        crowdingRadiusPx: 30,
        maxCrowding: 10,
        crowdingScorePower: 1.1,
        ...(options.detectorOptions || {}),
    });
    const projected = projectedStars(metadata, imageData.width, imageData.height, maxMag);
    const diag = Math.hypot(imageData.width, imageData.height);
    const identification = AutoIdentifier.identifyStarsNearProjection(projected, detections.detections, {
        imageWidth: imageData.width,
        imageHeight: imageData.height,
        maxMagnitude: maxMag,
        maxDetections: Number.isFinite(options.maxDetections) ? options.maxDetections : 650,
        maxCatalogStars: 700,
        maxDistancePx: Math.max(9, Math.min(18, 0.0045 * diag)),
        translationSearchRadiusPx: Math.max(18, Math.min(55, 0.015 * diag)),
        nelderMeadStepPx: 5,
        nelderMeadMaxIter: 100,
        rejectAmbiguousMatches: true,
        ambiguityRadiusPx: 10,
        ambiguityDistanceSlackPx: 7,
        minMatches: 10,
        ...(options.matcherOptions || {}),
    });
    const score = scoreAgainstManualMatches(identification.matches, metadata, options.manualRadiusPx || 12);
    const result = {caseId, metadata, imagePath, imageData, detections: detections.detections, projected, identification, score};
    if (options.writeReport !== false) {
        result.report = writeReport(result, options);
    }
    return result;
}

async function main() {
    const caseId = process.argv[2] || DEFAULT_CASE_ID;
    const result = await runCloseProjectionCase(caseId, {writeReport: true});
    console.log(`${result.caseId}: ${result.identification.status}`);
    console.log(`detections=${result.detections.length} projected=${result.projected.length} matches=${result.identification.matches.length}`);
    console.log(`manual overlap correct=${result.score.correct} wrong=${result.score.wrong} unknown=${result.score.unknown}`);
    console.log(`wrote ${result.report.htmlPath}`);
}

if (require.main === module) {
    main().catch(error => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = {
    runCloseProjectionCase,
    scoreAgainstManualMatches,
};
