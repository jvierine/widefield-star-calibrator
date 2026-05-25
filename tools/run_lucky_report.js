#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const {performance} = require("node:perf_hooks");

const AutoIdentifier = require("../js/auto_identifier.js");
const StarDetector = require("../js/star_detector.js");
const {
    AidaTools,
    fitFromPairs,
    projectStars,
    readPngImageData,
    visibleStars,
} = require("./generate_test_report.js");

const ROOT = path.join(__dirname, "..");
const IMAGE_DIR = path.join(ROOT, "calibration_images");
const TEST_CASE_DIR = path.join(ROOT, "test_cases");
const OUT_DIR = path.join(ROOT, "lucky-report");
const ASSET_DIR = path.join(OUT_DIR, "assets");
const SUPPORTED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".heic", ".heif"]);
const BROWN_CONRADY_OPTMOD = 20;
const DEG = Math.PI / 180;

function parseArgs(argv) {
    const options = {
        limit: Infinity,
        filter: "",
        optmod: null,
        lat: null,
        lon: null,
        alt: 0,
        timestampUtc: "",
        outDir: OUT_DIR,
        keepGoing: true,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = () => argv[++i];
        if (arg === "--limit") {
            options.limit = Number(next());
        } else if (arg === "--filter") {
            options.filter = String(next() || "");
        } else if (arg === "--optmod") {
            options.optmod = Number(next());
        } else if (arg === "--lat") {
            options.lat = Number(next());
        } else if (arg === "--lon") {
            options.lon = Number(next());
        } else if (arg === "--alt") {
            options.alt = Number(next());
        } else if (arg === "--time" || arg === "--timestamp") {
            options.timestampUtc = String(next() || "");
        } else if (arg === "--out") {
            options.outDir = path.resolve(next());
        } else if (arg === "--stop-on-error") {
            options.keepGoing = false;
        } else if (arg === "--help" || arg === "-h") {
            usage();
            process.exit(0);
        } else {
            options.filter = arg;
        }
    }
    if (!Number.isFinite(options.limit) || options.limit <= 0) {
        options.limit = Infinity;
    }
    return options;
}

function usage() {
    console.log(`Usage:
  npm run lucky:report
  npm run lucky:report -- --filter IMG_0537
  npm run lucky:report -- --limit 5
  npm run lucky:report -- --lat 69.65 --lon 18.95 --time 2025-01-29T18:45:02Z

The script scans calibration_images/, runs the command-line lucky matcher on
each supported image, logs progress and timing, and writes lucky-report/index.html.
HEIC/JPEG inputs are converted to PNG report assets with macOS sips.`);
}

function sanitizeId(value) {
    return String(value)
        .replace(/\.[^.]+$/, "")
        .replace(/[^A-Za-z0-9_.-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "image";
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, ch => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;",
    }[ch]));
}

function shellQuote(value) {
    const text = String(value);
    return /^[A-Za-z0-9_./:=@+-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

function reportCommand(args = []) {
    const suffix = args.length ? ` -- ${args.map(shellQuote).join(" ")}` : "";
    return `cd /Users/j/src/AIDA_tools/aida_js_calibrator && npm run lucky:report${suffix}`;
}

function fmtMs(value) {
    return Number.isFinite(value) ? `${value.toFixed(value >= 1000 ? 0 : 1)} ms` : "n/a";
}

function fmt(value, digits = 2) {
    return Number.isFinite(value) ? Number(value).toFixed(digits) : "n/a";
}

function run(command, args, options = {}) {
    const result = childProcess.spawnSync(command, args, {
        encoding: "utf8",
        stdio: options.quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "pipe"],
    });
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout || result.status}`);
    }
    return result.stdout || "";
}

function ensureSips() {
    const result = childProcess.spawnSync("which", ["sips"], {encoding: "utf8"});
    if (result.status !== 0) {
        throw new Error("sips not found; HEIC/JPEG normalization on macOS needs /usr/bin/sips");
    }
}

function listImages(options) {
    return fs.readdirSync(IMAGE_DIR)
        .filter(name => SUPPORTED_EXTENSIONS.has(path.extname(name).toLowerCase()))
        .filter(name => !options.filter || name.includes(options.filter))
        .sort((a, b) => a.localeCompare(b))
        .slice(0, Number.isFinite(options.limit) ? options.limit : undefined)
        .map(name => path.join(IMAGE_DIR, name));
}

function testCaseMetadataMap() {
    const map = new Map();
    if (!fs.existsSync(TEST_CASE_DIR)) {
        return map;
    }
    for (const name of fs.readdirSync(TEST_CASE_DIR)) {
        const metadataFile = path.join(TEST_CASE_DIR, name, "metadata.json");
        if (!fs.existsSync(metadataFile)) {
            continue;
        }
        try {
            const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
            const keys = new Set([
                name,
                sanitizeId(name),
                metadata.id && sanitizeId(metadata.id),
                metadata.image && sanitizeId(metadata.image),
                metadata.sourceImage && sanitizeId(metadata.sourceImage),
            ].filter(Boolean));
            for (const key of keys) {
                map.set(key, metadata);
            }
        } catch (error) {
            console.warn(`warning: could not read ${metadataFile}: ${error.message}`);
        }
    }
    return map;
}

function sipsProperties(filename) {
    try {
        const text = run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", "-g", "creation", filename], {quiet: true});
        const out = {};
        for (const line of text.split(/\r?\n/)) {
            const match = line.match(/^\s*([^:]+):\s*(.+)$/);
            if (match) {
                out[match[1].trim()] = match[2].trim();
            }
        }
        return out;
    } catch {
        return {};
    }
}

function parseSipsCreation(value) {
    const match = String(value || "").match(/^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (!match) {
        return null;
    }
    const [, y, mo, d, h, mi, s] = match.map(Number);
    const date = new Date(y, mo - 1, d, h, mi, s);
    return Number.isFinite(date.getTime()) ? date : null;
}

function timestampFromNameOrMetadata(filename, metadata, props, options) {
    if (options.timestampUtc) {
        const date = new Date(options.timestampUtc);
        if (Number.isFinite(date.getTime())) {
            return {date, source: "command line"};
        }
    }
    if (metadata && metadata.timestampUtc) {
        const date = new Date(metadata.timestampUtc);
        if (Number.isFinite(date.getTime())) {
            return {date, source: "test case metadata"};
        }
    }
    const guessed = AidaTools.guessTimestampFromAllsky7Name(path.basename(filename));
    if (guessed) {
        return {date: guessed, source: "allsky7 filename"};
    }
    const created = parseSipsCreation(props.creation);
    if (created) {
        return {date: created, source: "sips creation time"};
    }
    return {date: new Date(), source: "current time fallback"};
}

function siteFromNameOrMetadata(filename, metadata, options) {
    if (Number.isFinite(options.lat) && Number.isFinite(options.lon)) {
        return {latDeg: options.lat, lonDeg: options.lon, altM: options.alt || 0, source: "command line"};
    }
    if (metadata && Number.isFinite(metadata.latDeg) && Number.isFinite(metadata.lonDeg)) {
        return {
            latDeg: Number(metadata.latDeg),
            lonDeg: Number(metadata.lonDeg),
            altM: Number(metadata.altM) || 0,
            source: "test case metadata",
        };
    }
    const station = AidaTools.guessAllsky7StationMetadata(path.basename(filename));
    if (station) {
        return {
            latDeg: Number(station.latDeg),
            lonDeg: Number(station.lonDeg),
            altM: Number(station.altM) || 0,
            source: "allsky7 filename",
        };
    }
    return {latDeg: 69.65, lonDeg: 18.95, altM: 0, source: "Tromso fallback"};
}

function normalizeImage(filename, outAssetDir) {
    fs.mkdirSync(outAssetDir, {recursive: true});
    const ext = path.extname(filename).toLowerCase();
    const id = sanitizeId(path.basename(filename));
    const outPng = path.join(outAssetDir, `${id}.png`);
    if (ext === ".png") {
        fs.copyFileSync(filename, outPng);
    } else {
        ensureSips();
        run("sips", ["-s", "format", "png", filename, "--out", outPng], {quiet: true});
    }
    return outPng;
}

function defaultRadialAlphaForOptmod(optmod) {
    if (optmod === BROWN_CONRADY_OPTMOD || optmod === 12) {
        return 0;
    }
    if (optmod === 1 || optmod === 4) {
        return 1;
    }
    if (optmod === 5) {
        return 0.5;
    }
    return 0.35;
}

function defaultOptparForCase(testCase) {
    const common = [
        1.0,
        testCase.width / Math.max(1, testCase.height),
        0,
        0,
        0,
        0,
        0,
        defaultRadialAlphaForOptmod(testCase.optmod),
    ];
    return testCase.optmod === BROWN_CONRADY_OPTMOD ? common.concat([0, 0, 0, 0]) : common;
}

function seedOptparFromBlindIdentification(testCase, result) {
    const angles = result && result.rotation &&
        typeof AidaTools.cameraAnglesFromRotation === "function" ?
        AidaTools.cameraAnglesFromRotation(result.rotation) :
        null;
    if (!angles) {
        return null;
    }
    const seed = defaultOptparForCase(testCase);
    const f1 = Number.isFinite(result.f1) ? Math.max(0.12, Math.min(6.0, Math.abs(result.f1))) : seed[0];
    seed[0] = (result.signX === -1 ? -1 : 1) * f1;
    seed[1] = (result.signY === -1 ? -1 : 1) * Math.max(0.12, Math.min(6.0, f1 * testCase.width / Math.max(1, testCase.height)));
    seed[2] = Math.max(-89.5, Math.min(89.5, angles.alpha));
    seed[3] = Math.max(-89.5, Math.min(89.5, angles.beta));
    seed[4] = angles.gamma;
    if (Number.isFinite(result.du)) {
        seed[5] = Math.max(-0.25, Math.min(0.25, result.du));
    }
    if (Number.isFinite(result.dv)) {
        seed[6] = Math.max(-0.25, Math.min(0.25, result.dv));
    }
    if (testCase.optmod !== BROWN_CONRADY_OPTMOD && Number.isFinite(result.radialAlpha)) {
        seed[7] = Math.max(testCase.optmod === 12 ? -2.5 : 0.05, Math.min(2.5, result.radialAlpha));
    }
    return seed;
}

function angularSeparationRad(a, b) {
    const sinZa = Math.sin(a.ze);
    const sinZb = Math.sin(b.ze);
    const dot = sinZa * sinZb * Math.cos(a.az - b.az) + Math.cos(a.ze) * Math.cos(b.ze);
    return Math.acos(Math.max(-1, Math.min(1, dot)));
}

function pruneCatalogByAngularSeparation(stars, minSeparationDeg) {
    if (!Number.isFinite(minSeparationDeg) || minSeparationDeg <= 0) {
        return stars;
    }
    const minSeparationRad = minSeparationDeg * DEG;
    const kept = [];
    for (const star of stars.slice().sort((a, b) => a.mag - b.mag || String(a.key).localeCompare(String(b.key)))) {
        if (!kept.some(existing => angularSeparationRad(star, existing) < minSeparationRad)) {
            kept.push(star);
        }
    }
    return kept;
}

function skyPlaneStarsForAsterisms(testCase, maxMag, options = {}) {
    return pruneCatalogByAngularSeparation(visibleStars(testCase, maxMag), options.minSeparationDeg)
        .map(star => {
            const r = star.ze / (Math.PI / 2);
            return {
                ...star,
                x: r * Math.sin(star.az),
                y: -r * Math.cos(star.az),
            };
        });
}

function imagePointAlreadyInMatches(matches, x, y, radiusPx = 7) {
    return matches.some(match => Math.hypot(match.detection.x - x, match.detection.y - y) <= radiusPx);
}

function addMatches(matches, result, options = {}) {
    const existingKeys = new Set(matches.map(match => match.star.key));
    const maxDistance = Number.isFinite(options.maxDistancePx) ? options.maxDistancePx : Infinity;
    if (Number.isFinite(options.maxMedianDistance) &&
            Number.isFinite(result.medianDistance) &&
            result.medianDistance > options.maxMedianDistance) {
        return 0;
    }
    const maxAdd = Number.isFinite(options.maxAdd) ? Math.max(0, Math.floor(options.maxAdd)) : Infinity;
    let added = 0;
    for (const match of result.matches || []) {
        if (added >= maxAdd) {
            break;
        }
        if (Number.isFinite(match.distance) && match.distance > maxDistance) {
            continue;
        }
        if (existingKeys.has(match.star.key) ||
                imagePointAlreadyInMatches(matches, match.detection.x, match.detection.y)) {
            continue;
        }
        matches.push({
            star: match.star,
            detection: match.detection,
            distance: match.distance,
            stage: options.stageLabel || "",
        });
        existingKeys.add(match.star.key);
        added += 1;
    }
    return added;
}

function asterismEdgeKey(a, b) {
    const p = a.x < b.x || (a.x === b.x && a.y <= b.y) ? [a, b] : [b, a];
    return `${Math.round(p[0].x * 10)},${Math.round(p[0].y * 10)}:` +
        `${Math.round(p[1].x * 10)},${Math.round(p[1].y * 10)}`;
}

function recordAsterismEdges(edges, result, label, image) {
    if (!result || !Array.isArray(result.matches) || result.matches.length < 3) {
        return 0;
    }
    const points = result.matches
        .filter(match => match && match.detection &&
            Number.isFinite(match.detection.x) && Number.isFinite(match.detection.y))
        .slice()
        .sort((a, b) => (a.star && b.star ? a.star.mag - b.star.mag : 0) ||
            Math.hypot(a.detection.x, a.detection.y) - Math.hypot(b.detection.x, b.detection.y))
        .slice(0, 40);
    const edgeKeys = new Set(edges.map(edge => asterismEdgeKey(edge.a, edge.b)));
    const diag = image ? Math.hypot(image.width, image.height) : Infinity;
    const maxEdge = Math.max(80, Math.min(0.28 * diag, 900));
    let added = 0;
    for (let i = 0; i < points.length; i += 1) {
        const a = points[i].detection;
        const neighbors = [];
        for (let j = 0; j < points.length; j += 1) {
            if (i === j) {
                continue;
            }
            const b = points[j].detection;
            const distance = Math.hypot(a.x - b.x, a.y - b.y);
            if (distance <= maxEdge) {
                neighbors.push({point: b, distance});
            }
        }
        neighbors.sort((m, n) => m.distance - n.distance);
        for (const neighbor of neighbors.slice(0, 2)) {
            const key = asterismEdgeKey(a, neighbor.point);
            if (edgeKeys.has(key)) {
                continue;
            }
            edgeKeys.add(key);
            edges.push({
                a: {x: a.x, y: a.y},
                b: {x: neighbor.point.x, y: neighbor.point.y},
                label,
            });
            added += 1;
        }
    }
    return added;
}

function luckyFitSweepCounts(totalMatches, optmod) {
    const minPairs = Math.ceil((optmod === BROWN_CONRADY_OPTMOD ? 12 : 8) / 2);
    const base = [minPairs, minPairs + 2, 8, 10, 12, 16, 20, 28, 40, totalMatches];
    const counts = [];
    for (const count of base) {
        const clipped = Math.min(totalMatches, Math.max(minPairs, count));
        if (clipped <= totalMatches && !counts.includes(clipped)) {
            counts.push(clipped);
        }
    }
    return counts.sort((a, b) => a - b);
}

function fitSelectedModel(testCase, matches, optpar, timings, label) {
    const sorted = matches.slice().sort((a, b) => a.star.mag - b.star.mag);
    const minPairs = Math.ceil((testCase.optmod === BROWN_CONRADY_OPTMOD ? 12 : 8) / 2);
    if (sorted.length < minPairs) {
        return {optpar, accepted: 0, attempted: 0, rms: Infinity, counts: []};
    }
    let current = optpar.slice();
    let accepted = 0;
    let attempted = 0;
    let rms = Infinity;
    const counts = luckyFitSweepCounts(sorted.length, testCase.optmod);
    const t0 = performance.now();
    for (const count of counts) {
        const fit = fitFromPairs(sorted.slice(0, count), testCase, current, 80);
        attempted += 1;
        if (Number.isFinite(fit.rms) && fit.rms < Math.min(rms, 1e9)) {
            current = fit.optpar.slice();
            rms = fit.rms;
            accepted += 1;
        }
    }
    const fitMs = performance.now() - t0;
    timings.fit += fitMs;
    return {optpar: current, accepted, attempted, rms, counts, label, fitMs};
}

function weakAsterismFallbackOptions(options = {}) {
    return {
        summaryLabel: options.summaryLabel || "weak-star bootstrap fallback",
        maxMagnitude: Number.isFinite(options.maxMagnitude) ? options.maxMagnitude : 6.5,
        maxDetections: options.maxDetections || 120,
        maxCatalogStars: options.maxCatalogStars || 260,
        maxCatalogTriangleStars: options.maxCatalogTriangleStars || 180,
        maxCatalogTriangles: options.maxCatalogTriangles || 25000,
        maxDetectionTriangleStars: options.maxDetectionTriangleStars || 90,
        maxDetectionTriangles: options.maxDetectionTriangles || 4500,
        maxCandidateTransforms: options.maxCandidateTransforms || 8000,
        maxNeighborTriangles: options.maxNeighborTriangles || 8,
        exhaustiveCatalogTriangles: options.exhaustiveCatalogTriangles === true,
        catalogMinSeparationDeg: options.catalogMinSeparationDeg,
        asterismMatchRadiusPx: options.asterismMatchRadiusPx,
        triangleSignatureRadius: options.triangleSignatureRadius || 0.02,
        minMatches: options.minMatches || 4,
    };
}

function deepAsterismFallbackStages(options = {}) {
    const prefix = options.summaryLabel || "weak-star";
    return [
        weakAsterismFallbackOptions({
            summaryLabel: `${prefix} asterism fallback`,
            maxMagnitude: 6.5,
            maxDetections: 140,
            maxCatalogStars: 320,
            maxCatalogTriangleStars: 220,
            maxCatalogTriangles: 36000,
            maxDetectionTriangleStars: 110,
            maxDetectionTriangles: 6500,
            maxCandidateTransforms: 10000,
            maxNeighborTriangles: 10,
            triangleSignatureRadius: 0.022,
        }),
        weakAsterismFallbackOptions({
            summaryLabel: `${prefix} deep asterism fallback`,
            maxMagnitude: 7.0,
            maxDetections: 220,
            maxCatalogStars: 10000,
            maxCatalogTriangleStars: 10000,
            maxCatalogTriangles: Number.MAX_SAFE_INTEGER,
            maxDetectionTriangleStars: 180,
            maxDetectionTriangles: 26000,
            maxCandidateTransforms: 32000,
            maxNeighborTriangles: 16,
            triangleSignatureRadius: 0.024,
            asterismMatchRadiusPx: options.deepRadiusPx,
            exhaustiveCatalogTriangles: true,
            catalogMinSeparationDeg: 3,
        }),
    ];
}

function luckyStages(optmod) {
    const stages = [
        {
            phase: "blind bright-star bootstrap",
            maxDetections: 80,
            maxMagnitude: 4.0,
            seedFromBlind: true,
            includeBlind: true,
            includeAsterisms: true,
            detectorOptions: {thresholdSigma: 1.8, localThresholdSigma: 1.8, requireGlobalThreshold: false, maxRadiusPx: 5, maxElongation: 4.0, suppressionRadiusPx: 10, crowdingRadiusPx: 36, maxCrowding: 7, crowdingScorePower: 1.25},
            blindOptions: {maxDetections: 80, maxBlindVerifyDetections: 80, maxCatalogStars: 220, maxCatalogTriangleStars: 220, maxCatalogTriangles: 30000, preflattenModelCandidates: ["pinhole", "fisheye"], preflattenF1Candidates: [0.70, 0.85, 1.00], preflattenRadialAlphaCandidates: [0.30, 0.60, 0.90], maxCatalogLocalNeighbors: 20, maxBlindNeighborTriangles: 8, blindEarlyAcceptMatches: 12, maxBlindCandidateRotations: 12000, rejectAmbiguousBlindMatches: true, blindAmbiguityRadiusDeg: 1.0, blindAmbiguityDistanceSlackDeg: 0.35, blindPixelAmbiguityRadiusPx: 18, blindPixelAmbiguityDistanceSlackPx: 8, ambiguityMaxMagnitude: 6.0},
            maxAddDistancePx: 0.8,
            maxMedianDistance: 0.42,
            weakAsterismOptions: deepAsterismFallbackStages({summaryLabel: "lucky bright bootstrap"}),
        },
        {
            phase: "extended blind bright-star bootstrap",
            maxDetections: 160,
            maxMagnitude: 4.0,
            seedFromBlind: true,
            includeBlind: true,
            includeAsterisms: true,
            runOnlyWithoutSeed: true,
            detectorOptions: {thresholdSigma: 1.8, localThresholdSigma: 1.8, requireGlobalThreshold: false, maxRadiusPx: 5, maxElongation: 4.0, suppressionRadiusPx: 10, crowdingRadiusPx: 36, maxCrowding: 7, crowdingScorePower: 1.25},
            blindOptions: {maxDetections: 160, maxBlindVerifyDetections: 140, maxCatalogStars: 220, maxCatalogTriangleStars: 220, maxCatalogTriangles: 30000, maxDetectionTriangleStars: 120, maxDetectionTriangles: 6000, preflattenModelCandidates: ["pinhole", "fisheye"], preflattenF1Candidates: [0.70, 0.85, 1.00], preflattenRadialAlphaCandidates: [0.30, 0.60, 0.90], maxCatalogLocalNeighbors: 20, maxBlindNeighborTriangles: 8, blindEarlyAcceptMatches: 12, maxBlindCandidateRotations: 12000, rejectAmbiguousBlindMatches: true, blindAmbiguityRadiusDeg: 1.0, blindAmbiguityDistanceSlackDeg: 0.35, blindPixelAmbiguityRadiusPx: 18, blindPixelAmbiguityDistanceSlackPx: 8, ambiguityMaxMagnitude: 6.0},
            maxAddDistancePx: 0.8,
            maxMedianDistance: 0.42,
            weakAsterismOptions: deepAsterismFallbackStages({summaryLabel: "lucky extended bootstrap"}),
        },
        {
            phase: "phone deep blind bootstrap",
            maxDetections: 320,
            maxMagnitude: 6.0,
            seedFromBlind: true,
            includeBlind: true,
            includeAsterisms: true,
            runOnlyWithoutSeed: true,
            detectorOptions: {thresholdSigma: 1.5, localThresholdSigma: 1.5, requireGlobalThreshold: false, maxRadiusPx: 5, maxElongation: 4.0, suppressionRadiusPx: 10, crowdingRadiusPx: 36, maxCrowding: 7, crowdingScorePower: 1.25},
            blindOptions: {maxDetections: 320, maxBlindVerifyDetections: 220, maxCatalogStars: 420, maxCatalogTriangleStars: 360, maxCatalogTriangles: 50000, maxAmbiguityCatalogStars: 520, maxDetectionTriangleStars: 180, maxDetectionTriangles: 14000, preflattenModelCandidates: ["pinhole", "fisheye"], preflattenF1Candidates: [0.55, 0.65, 0.75, 0.85, 0.95, 1.10], preflattenRadialAlphaCandidates: [0.15, 0.30, 0.45, 0.60, 0.75, 0.90, 0.98], maxCatalogLocalNeighbors: 24, maxBlindNeighborTriangles: 10, blindEarlyAcceptMatches: 11, blindEarlyAcceptMedianDeg: 0.75, maxBlindCandidateRotations: 18000, rejectAmbiguousBlindMatches: true, blindAmbiguityRadiusDeg: 0.9, blindAmbiguityDistanceSlackDeg: 0.3, blindPixelMatchRadiusPx: 58, blindPixelAmbiguityRadiusPx: 16, blindPixelAmbiguityDistanceSlackPx: 8, ambiguityMaxMagnitude: 7.0},
            maxAddDistancePx: 1.2,
            maxMedianDistance: 0.42,
        },
        {
            phase: "projected refinement",
            maxDetections: 90,
            maxMagnitude: 5.0,
            includeBlind: false,
            includeAsterisms: false,
            detectorOptions: {thresholdSigma: 3.6, localThresholdSigma: 3.4, requireGlobalThreshold: true, maxElongation: 3.0},
            projectedOptions: {maxDetections: 90, maxCatalogStars: 130, maxDistancePx: 34, translationSearchRadiusPx: 90, rejectAmbiguousMatches: true, ambiguityRadiusPx: 18, ambiguityDistanceSlackPx: 16},
            maxAddDistancePx: 8,
        },
        {
            phase: "deeper projected refinement",
            maxDetections: 180,
            maxMagnitude: 6.5,
            includeBlind: false,
            includeAsterisms: false,
            detectorOptions: {thresholdSigma: 2.7, localThresholdSigma: 2.9, requireGlobalThreshold: false, maxElongation: 3.1, suppressionRadiusPx: 8, crowdingRadiusPx: 30, maxCrowding: 8, crowdingScorePower: 1.15},
            projectedOptions: {maxDetections: 180, maxCatalogStars: 260, maxDistancePx: 18, translationSearchRadiusPx: 35, minMatches: 8, rejectAmbiguousMatches: true, ambiguityRadiusPx: 14, ambiguityDistanceSlackPx: 10},
            maxAddDistancePx: 5,
            maxMedianDistance: 10,
        },
        {
            phase: "final model-guided expansion",
            maxDetections: 260,
            maxMagnitude: 7.0,
            includeBlind: false,
            includeAsterisms: false,
            detectorOptions: {thresholdSigma: 2.35, localThresholdSigma: 2.7, requireGlobalThreshold: false, maxElongation: 3.2, suppressionRadiusPx: 8, crowdingRadiusPx: 30, maxCrowding: 8, crowdingScorePower: 1.15},
            projectedOptions: {maxDetections: 260, maxCatalogStars: 420, maxDistancePx: 14, translationSearchRadiusPx: 24, minMatches: 10, rejectAmbiguousMatches: true, ambiguityRadiusPx: 12, ambiguityDistanceSlackPx: 8},
            maxAddDistancePx: 4,
            maxMedianDistance: 8,
            skipFit: true,
        },
    ];
    if (optmod === 2) {
        const v010 = {
            preflattenF1Candidates: [0.80, 0.70, 0.90, 1.00, 0.60],
            preflattenRadialAlphaCandidates: [0.90, 0.75, 1.05, 0.60],
        };
        Object.assign(stages[0], {
            maxDetections: 50,
            detectorOptions: {thresholdSigma: 2.2, localThresholdSigma: 2.2, requireGlobalThreshold: false, maxRadiusPx: 5, maxElongation: 4.0},
            blindOptions: {maxDetections: 50, maxCatalogStars: 220, maxCatalogTriangleStars: 220, maxCatalogTriangles: 30000, preflattenModelCandidates: ["fisheye"], ...v010, maxCatalogLocalNeighbors: 20, maxBlindNeighborTriangles: 8, blindEarlyAcceptMatches: 12, maxBlindCandidateRotations: 12000, rejectAmbiguousBlindMatches: true, blindAmbiguityRadiusDeg: 1.0, blindAmbiguityDistanceSlackDeg: 0.35, blindPixelAmbiguityRadiusPx: 18, blindPixelAmbiguityDistanceSlackPx: 8, ambiguityMaxMagnitude: 6.0},
            weakAsterismOptions: null,
        });
        Object.assign(stages[1], {
            maxDetections: 100,
            detectorOptions: {thresholdSigma: 2.2, localThresholdSigma: 2.2, requireGlobalThreshold: false, maxRadiusPx: 5, maxElongation: 4.0},
            blindOptions: {maxDetections: 100, maxBlindVerifyDetections: 100, maxCatalogStars: 220, maxCatalogTriangleStars: 220, maxCatalogTriangles: 30000, maxDetectionTriangleStars: 80, maxDetectionTriangles: 2800, preflattenModelCandidates: ["pinhole", "fisheye"], ...v010, maxCatalogLocalNeighbors: 20, maxBlindNeighborTriangles: 8, blindEarlyAcceptMatches: 12, maxBlindCandidateRotations: 12000, rejectAmbiguousBlindMatches: true, blindAmbiguityRadiusDeg: 1.0, blindAmbiguityDistanceSlackDeg: 0.35, blindPixelAmbiguityRadiusPx: 18, blindPixelAmbiguityDistanceSlackPx: 8, ambiguityMaxMagnitude: 6.0},
            weakAsterismOptions: null,
        });
        Object.assign(stages[2].blindOptions, {
            preflattenRadialAlphaCandidates: [0.20, 0.35, 0.55, 0.75, 0.95, 1.15],
            maxDetectionTriangleStars: 100,
            maxDetectionTriangles: 5200,
        });
        Object.assign(stages[4], {
            maxDetections: 120,
            maxMagnitude: 6.0,
            detectorOptions: {thresholdSigma: 3.1, localThresholdSigma: 3.2, requireGlobalThreshold: false, maxElongation: 3.1},
            projectedOptions: {maxDetections: 120, maxCatalogStars: 180, maxDistancePx: 24, translationSearchRadiusPx: 55, rejectAmbiguousMatches: true, ambiguityRadiusPx: 18, ambiguityDistanceSlackPx: 16},
            maxAddDistancePx: 8,
        });
        Object.assign(stages[5], {
            maxDetections: 150,
            maxMagnitude: 6.5,
            detectorOptions: {thresholdSigma: 2.9, localThresholdSigma: 3.0, requireGlobalThreshold: false, maxElongation: 3.2},
            projectedOptions: {maxDetections: 150, maxCatalogStars: 220, maxDistancePx: 18, translationSearchRadiusPx: 35, minMatches: 6, rejectAmbiguousMatches: true, ambiguityRadiusPx: 18, ambiguityDistanceSlackPx: 16},
            maxAddDistancePx: 6,
            skipFit: false,
        });
    }
    return stages;
}

async function identifyStage(testCase, imageData, detections, optpar, matches, stage, timings) {
    const common = {
        imageWidth: testCase.width,
        imageHeight: testCase.height,
        maxMagnitude: stage.maxMagnitude,
        existingCatalogKeys: null,
        existingDetectionIds: new Set(),
    };
    let result = {matches: [], status: "no matcher stage"};
    if (stage.includeBlind !== false) {
        const maxMag = Math.max(stage.maxMagnitude, Number(stage.blindOptions && stage.blindOptions.ambiguityMaxMagnitude) || stage.maxMagnitude);
        const t0 = performance.now();
        result = AutoIdentifier.identifyStarsBlind(visibleStars(testCase, maxMag), detections, {
            ...common,
            maxDetections: 80,
            maxCatalogStars: 80,
            minMatches: stage.minBlindMatches || 6,
            ...(stage.blindOptions || {}),
        });
        timings.blind += performance.now() - t0;
    }
    if (stage.includeAsterisms !== false && result.matches.length < (stage.minBlindMatches || 6)) {
        const t0 = performance.now();
        result = AutoIdentifier.identifyStarsByAsterisms(
            skyPlaneStarsForAsterisms(testCase, stage.maxMagnitude),
            detections,
            {
                ...common,
                maxDetections: 50,
                maxCatalogStars: 90,
                asterismMatchRadiusPx: Math.max(32, Math.min(70, 0.012 * Math.hypot(testCase.width, testCase.height))),
                minMatches: stage.minAsterismMatches || 4,
                ...(stage.asterismOptions || {}),
            }
        );
        timings.asterism += performance.now() - t0;
        const weakStages = Array.isArray(stage.weakAsterismOptions) ? stage.weakAsterismOptions : stage.weakAsterismOptions ? [stage.weakAsterismOptions] : [];
        for (const weak of weakStages) {
            if (result.matches.length >= (stage.minAsterismMatches || 4)) {
                break;
            }
            const weakMaxMag = Number(weak.maxMagnitude);
            if (!Number.isFinite(weakMaxMag) || weakMaxMag <= stage.maxMagnitude) {
                continue;
            }
            const tWeak = performance.now();
            result = AutoIdentifier.identifyStarsByAsterisms(
                skyPlaneStarsForAsterisms(testCase, weakMaxMag, {minSeparationDeg: weak.catalogMinSeparationDeg}),
                detections,
                {
                    ...common,
                    maxMagnitude: weakMaxMag,
                    maxDetections: 80,
                    maxCatalogStars: 220,
                    asterismMatchRadiusPx: Math.max(36, Math.min(84, 0.015 * Math.hypot(testCase.width, testCase.height))),
                    minMatches: stage.minAsterismMatches || 4,
                    ...(stage.asterismOptions || {}),
                    ...weak,
                }
            );
            timings.asterism += performance.now() - tWeak;
        }
    }
    if (stage.includeProjected !== false &&
            result.matches.length < Math.max(stage.minAsterismMatches || 4, stage.minProjectedMatches || 4)) {
        const t0 = performance.now();
        result = AutoIdentifier.identifyStars(
            projectStars(testCase, optpar, stage.maxMagnitude),
            detections,
            {
                ...common,
                maxDetections: 50,
                maxCatalogStars: 90,
                maxDistancePx: Math.max(22, Math.min(48, 0.018 * Math.hypot(testCase.width, testCase.height))),
                translationSearchRadiusPx: Math.max(80, Math.min(240, 0.10 * Math.hypot(testCase.width, testCase.height))),
                minMatches: stage.minProjectedMatches || 4,
                ...(stage.projectedOptions || {}),
            }
        );
        timings.projected += performance.now() - t0;
    }
    const added = addMatches(matches, result, {
        maxDistancePx: stage.maxAddDistancePx,
        maxMedianDistance: stage.maxMedianDistance,
        stageLabel: stage.phase,
    });
    return {result, added};
}

async function runLucky(testCase, imageData, log) {
    const timings = {decode: 0, detection: 0, blind: 0, asterism: 0, projected: 0, fit: 0, total: 0};
    const stageRows = [];
    const matches = [];
    const asterismEdges = [];
    let optpar = testCase.initialOptpar.slice();
    let seeded = false;
    let acceptedFits = 0;
    const detectionByKey = new Map();
    const tTotal = performance.now();
    const stages = luckyStages(testCase.optmod);
    for (let i = 0; i < stages.length; i += 1) {
        const stage = stages[i];
        if (stage.runOnlyWithoutSeed === true && matches.length > 0) {
            stageRows.push({phase: stage.phase, skipped: "seed already accepted"});
            continue;
        }
        log(`    stage ${i + 1}/${stages.length}: ${stage.phase}`);
        const displayDetections = Math.max(stage.maxDetections, Math.min(520, Math.max(160, stage.maxDetections * 2)));
        const tDetect = performance.now();
        const detectionResult = await StarDetector.detectBrightStars(imageData, {
            maxDetections: displayDetections,
            ...stage.detectorOptions,
        });
        const detectionMs = performance.now() - tDetect;
        timings.detection += detectionMs;
        const detections = detectionResult.detections;
        for (const detection of detections) {
            const key = `${Math.round(detection.x * 10)}:${Math.round(detection.y * 10)}`;
            if (!detectionByKey.has(key)) {
                detectionByKey.set(key, detection);
            }
        }
        const before = matches.length;
        const tIdentify = performance.now();
        const pass = await identifyStage(testCase, imageData, detections, optpar, matches, stage, timings);
        const identifyMs = performance.now() - tIdentify;
        const asterismEdgesAdded = stage.includeBlind !== false || stage.includeAsterisms !== false ?
            recordAsterismEdges(asterismEdges, pass.result, stage.phase, testCase) :
            0;
        let fit = {accepted: 0, attempted: 0, rms: Infinity, counts: []};
        if (stage.seedFromBlind && pass.result.matches.length >= 4) {
            const seed = seedOptparFromBlindIdentification(testCase, pass.result);
            if (seed) {
                optpar = seed;
                seeded = true;
            }
        }
        if (!stage.skipFit) {
            fit = fitSelectedModel(testCase, matches, optpar, timings, stage.phase);
            optpar = fit.optpar.slice();
            acceptedFits += fit.accepted;
        }
        stageRows.push({
            phase: stage.phase,
            detections: detections.length,
            candidates: detectionResult.candidates ? detectionResult.candidates.length : null,
            added: pass.added,
            before,
            after: matches.length,
            status: pass.result.status,
            detectionMs,
            identifyMs,
            fitMs: fit.fitMs,
            rms: fit.rms,
            fitCounts: fit.counts,
            asterismEdgesAdded,
        });
        log(`      detections ${detections.length}, added ${pass.added}, matches ${before}->${matches.length}, ` +
            `asterism edges +${asterismEdgesAdded}, rms ${fmt(fit.rms)} px, ` +
            `detect ${fmtMs(detectionMs)}, identify ${fmtMs(identifyMs)}, fit ${fmtMs(fit.fitMs)}`);
        if (i >= 2 && pass.added === 0 && matches.length === before) {
            break;
        }
    }
    const finalFit = fitSelectedModel(testCase, matches, optpar, timings, "final");
    optpar = finalFit.optpar.slice();
    timings.total = performance.now() - tTotal;
    return {
        testCase,
        matches,
        optpar,
        seeded,
        acceptedFits,
        finalRms: finalFit.rms,
        finalCounts: finalFit.counts,
        stageRows,
        timings,
        detections: Array.from(detectionByKey.values()),
        asterismEdges,
    };
}

function buildTestCase(filename, metadataMap, imagePng, imageData, props, options) {
    const id = sanitizeId(path.basename(filename));
    const metadata = metadataMap.get(id);
    const timestamp = timestampFromNameOrMetadata(filename, metadata, props, options);
    const site = siteFromNameOrMetadata(filename, metadata, options);
    const optmod = Number.isFinite(options.optmod) ? options.optmod :
        metadata && Array.isArray(metadata.optpar) && Number.isFinite(Number(metadata.optpar[0])) ? Number(metadata.optpar[0]) :
            metadata && /iphone|img_/i.test(id) ? BROWN_CONRADY_OPTMOD : 2;
    const knownOptpar = metadata && Array.isArray(metadata.optpar) ?
        metadata.optpar.slice(1) :
        null;
    return {
        id,
        title: id,
        image: path.basename(filename),
        imagePath: path.relative(ROOT, filename),
        reportImage: path.relative(OUT_DIR, imagePng).replace(/\\/g, "/"),
        width: imageData.width,
        height: imageData.height,
        date: timestamp.date,
        timestampSource: timestamp.source,
        latDeg: site.latDeg,
        lonDeg: site.lonDeg,
        altM: site.altM,
        siteSource: site.source,
        optmod,
        maxMag: metadata && Number.isFinite(metadata.maxMag) ? Number(metadata.maxMag) : optmod === BROWN_CONRADY_OPTMOD ? 7.0 : 6.5,
        initialOptpar: defaultOptparForCase({width: imageData.width, height: imageData.height, optmod}),
        knownOptpar,
        metadataFound: Boolean(metadata),
    };
}

function circleSvg(x, y, r, className, title = "") {
    return `<circle class="${className}" cx="${fmt(x)}" cy="${fmt(y)}" r="${fmt(r, 1)}">${title ? `<title>${escapeHtml(title)}</title>` : ""}</circle>`;
}

function lineSvg(x1, y1, x2, y2, className) {
    return `<line class="${className}" x1="${fmt(x1)}" y1="${fmt(y1)}" x2="${fmt(x2)}" y2="${fmt(y2)}"></line>`;
}

function asterismLineSvg(edge) {
    const title = edge.label ? `<title>${escapeHtml(edge.label)}</title>` : "";
    return `<line class="asterism-line" x1="${fmt(edge.a.x)}" y1="${fmt(edge.a.y)}" ` +
        `x2="${fmt(edge.b.x)}" y2="${fmt(edge.b.y)}">${title}</line>`;
}

function magnitudeRadius(mag) {
    if (mag <= 1.5) return 18;
    if (mag <= 2.5) return 15;
    if (mag <= 3.5) return 12;
    if (mag <= 4.5) return 10;
    return 8;
}

function overlaySvg(result) {
    const c = result.testCase;
    const fitted = projectStars(c, result.optpar, c.maxMag).slice(0, 450);
    const fittedByKey = new Map(fitted.map(star => [star.key, star]));
    const items = [];
    for (const star of fitted) {
        items.push(circleSvg(star.x, star.y, magnitudeRadius(star.mag), "catalog-star", `${star.name || star.key} mag ${fmt(star.mag, 1)} final projection`));
    }
    for (const edge of result.asterismEdges || []) {
        items.push(asterismLineSvg(edge));
    }
    for (const detection of result.detections || []) {
        items.push(circleSvg(detection.x, detection.y, 3, "detected-star", `raw detection score ${fmt(detection.score, 1)}`));
    }
    for (const match of result.matches) {
        const star = fittedByKey.get(match.star.key);
        if (star) {
            items.push(lineSvg(match.detection.x, match.detection.y, star.x, star.y, "residual-line"));
            items.push(circleSvg(star.x, star.y, magnitudeRadius(match.star.mag), "fit-star", `${match.star.name || match.star.key} fitted`));
        }
        items.push(circleSvg(match.detection.x, match.detection.y, magnitudeRadius(match.star.mag) + 2, "matched-star", `${match.star.name || match.star.key} detection`));
    }
    return `<svg class="overlay" viewBox="0 0 ${c.width} ${c.height}" preserveAspectRatio="none">${items.join("\n")}</svg>`;
}

function timingRows(timings) {
    const totalBuckets = timings.decode + timings.detection + timings.blind + timings.asterism + timings.projected + timings.fit;
    return ["decode", "detection", "blind", "asterism", "projected", "fit"].map(key => {
        const value = timings[key] || 0;
        return `<tr><td>${key}</td><td>${fmtMs(value)}</td><td>${fmt(100 * value / Math.max(1, totalBuckets), 1)}%</td></tr>`;
    }).join("\n");
}

function resultPanel(result, index) {
    const c = result.testCase;
    const status = result.error ?
        `<p class="bad">error: ${escapeHtml(result.error)}</p>` :
        `<p class="${Number.isFinite(result.finalRms) && result.finalRms < 5 ? "good" : "warn"}">matches ${result.matches.length}, ` +
            `asterism edges ${(result.asterismEdges || []).length}, final RMS ${fmt(result.finalRms)} px, ${result.seeded ? "seeded" : "not seeded"}</p>`;
    const stageRows = (result.stageRows || []).map(row => `<tr>
        <td>${escapeHtml(row.phase)}</td>
        <td>${row.skipped ? escapeHtml(row.skipped) : `${row.before || 0}->${row.after || 0}`}</td>
        <td>${row.detections ?? ""}</td>
        <td>${row.added ?? ""}</td>
        <td>${row.asterismEdgesAdded ?? ""}</td>
        <td>${fmt(row.rms)}</td>
        <td>${fmtMs(row.detectionMs)}</td>
        <td>${fmtMs(row.identifyMs)}</td>
        <td>${escapeHtml(row.status || "")}</td>
    </tr>`).join("\n");
    return `<section class="case ${index === 0 ? "active" : ""}" data-index="${index}">
        <div class="stage" style="aspect-ratio: ${c.width} / ${c.height}">
            <img src="${escapeHtml(c.reportImage)}" alt="${escapeHtml(c.id)}">
            ${result.error ? "" : overlaySvg(result)}
        </div>
        <aside class="info">
            <h2>${escapeHtml(c.id)}</h2>
            ${status}
            <p>optmod ${c.optmod}; ${c.width}x${c.height}; ${escapeHtml(c.date.toISOString())}</p>
            <p>site lat ${fmt(c.latDeg, 5)}, lon ${fmt(c.lonDeg, 5)} (${escapeHtml(c.siteSource)}); time from ${escapeHtml(c.timestampSource)}</p>
            <p>${c.metadataFound ? "matched saved test-case metadata" : "no saved metadata; used inferred/fallback metadata"}</p>
            <h3>Timing</h3>
            <table><tbody>${timingRows(result.timings || {})}</tbody></table>
            <h3>Stages</h3>
            <table><thead><tr><th>stage</th><th>matches</th><th>detections</th><th>added</th><th>edges</th><th>RMS</th><th>detect</th><th>identify</th><th>status</th></tr></thead><tbody>${stageRows}</tbody></table>
        </aside>
    </section>`;
}

function summaryHtml(results, generated) {
    const totals = {decode: 0, detection: 0, blind: 0, asterism: 0, projected: 0, fit: 0};
    for (const result of results) {
        for (const key of Object.keys(totals)) {
            totals[key] += result.timings && Number.isFinite(result.timings[key]) ? result.timings[key] : 0;
        }
    }
    const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
    const rows = sorted.map(([key, value]) => `<tr><td>${key}</td><td>${fmtMs(value)}</td></tr>`).join("\n");
    const solved = results.filter(r => !r.error && r.matches.length >= 4).length;
    return `<div class="summary">
        <strong>${solved}/${results.length}</strong> images produced at least four lucky pairings. Generated ${escapeHtml(generated)}.
        <table><tbody>${rows}</tbody></table>
    </div>`;
}

function pageHtml(results, command = reportCommand()) {
    const generated = new Date().toISOString();
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AIDA I'm Feeling Lucky Calibration Report</title>
<style>
html, body { margin: 0; min-height: 100%; background: #10131a; color: #eef2f7; font-family: system-ui, sans-serif; }
.bar { position: sticky; top: 0; z-index: 10; display: flex; gap: 10px; align-items: center; padding: 10px 12px; background: #1a1f2b; border-bottom: 1px solid #313949; }
button, select { color: #eef2f7; background: #263041; border: 1px solid #4b566b; border-radius: 4px; padding: 7px 10px; font: inherit; }
button { cursor: pointer; font-weight: 800; }
.summary { padding: 12px 16px; color: #cbd5e1; background: #151a23; border-bottom: 1px solid #313949; }
.summary table { display: inline-table; margin-left: 18px; vertical-align: middle; }
.reproduce { padding: 12px 16px; color: #cbd5e1; background: #111722; border-bottom: 1px solid #313949; }
.reproduce h2 { margin: 0 0 6px; font-size: 13px; color: #fff; }
.reproduce pre { margin: 0; padding: 10px; overflow-x: auto; background: #070b12; border: 1px solid #303746; border-radius: 6px; color: #b7f7c8; }
.case { display: none; grid-template-columns: minmax(0, 1fr) 430px; gap: 14px; padding: 14px; min-height: calc(100vh - 110px); box-sizing: border-box; }
.case.active { display: grid; }
.stage { position: relative; align-self: start; max-width: 100%; max-height: calc(100vh - 140px); background: #05070c; overflow: hidden; }
.stage img, .stage svg { position: absolute; inset: 0; width: 100%; height: 100%; display: block; object-fit: contain; }
.overlay { pointer-events: none; }
.catalog-star { fill: none; stroke: rgba(255, 74, 74, 0.75); stroke-width: 2.2; vector-effect: non-scaling-stroke; }
.asterism-line { stroke: rgba(255, 190, 65, 0.68); stroke-width: 1.7; stroke-dasharray: 7 6; vector-effect: non-scaling-stroke; }
.detected-star { fill: rgba(255, 214, 80, 0.72); stroke: none; }
.matched-star { fill: none; stroke: #22c55e; stroke-width: 3.4; vector-effect: non-scaling-stroke; }
.fit-star { fill: none; stroke: #38bdf8; stroke-width: 2.6; vector-effect: non-scaling-stroke; }
.residual-line { stroke: rgba(255,255,255,0.7); stroke-width: 1.6; vector-effect: non-scaling-stroke; }
.info { min-width: 0; overflow: auto; padding: 12px; border-left: 1px solid #313949; color: #cbd5e1; }
.info h2 { margin: 0 0 8px; font-size: 18px; overflow-wrap: anywhere; color: #fff; }
.info h3 { margin: 16px 0 6px; font-size: 13px; color: #fff; }
.good { color: #86efac; } .warn { color: #fde68a; } .bad { color: #fca5a5; }
table { border-collapse: collapse; width: 100%; font-size: 12px; }
td, th { border-bottom: 1px solid #303746; padding: 5px 6px; vertical-align: top; text-align: left; }
td:last-child { overflow-wrap: anywhere; }
@media (max-width: 980px) { .case.active { display: block; } .stage { max-height: none; } .info { border-left: 0; border-top: 1px solid #313949; } }
</style>
</head>
<body>
<div class="bar">
    <button id="prev" type="button">&larr;</button>
    <button id="next" type="button">&rarr;</button>
    <select id="caseSelect"></select>
    <span id="counter"></span>
    <span>yellow raw detections/asterisms, red final catalogue, green lucky detections, cyan fitted stars</span>
</div>
${summaryHtml(results, generated)}
<section class="reproduce">
<h2>Repeat From Command Line</h2>
<pre><code>${escapeHtml(command)}</code></pre>
</section>
${results.map(resultPanel).join("\n")}
<script>
const cases = ${JSON.stringify(results.map(result => ({id: result.testCase.id})))};
let index = 0;
const select = document.getElementById("caseSelect");
const counter = document.getElementById("counter");
for (let i = 0; i < cases.length; i += 1) {
  const option = document.createElement("option");
  option.value = String(i);
  option.textContent = cases[i].id;
  select.appendChild(option);
}
function show(i) {
  if (!cases.length) return;
  document.querySelectorAll(".case").forEach(el => el.classList.remove("active"));
  index = (i + cases.length) % cases.length;
  document.querySelector('.case[data-index="' + index + '"]').classList.add("active");
  select.value = String(index);
  counter.textContent = (index + 1) + "/" + cases.length;
}
document.getElementById("prev").addEventListener("click", () => show(index - 1));
document.getElementById("next").addEventListener("click", () => show(index + 1));
select.addEventListener("change", () => show(Number(select.value)));
window.addEventListener("keydown", event => {
  if (event.key === "ArrowLeft") show(index - 1);
  if (event.key === "ArrowRight" || event.key === " ") show(index + 1);
});
show(0);
</script>
</body>
</html>`;
}

async function analyzeImage(filename, index, total, metadataMap, options) {
    const base = path.basename(filename);
    const log = text => console.log(text);
    log(`[${index + 1}/${total}] ${base}`);
    const result = {timings: {decode: 0, detection: 0, blind: 0, asterism: 0, projected: 0, fit: 0}};
    const tDecode = performance.now();
    const props = sipsProperties(filename);
    const assetDir = path.join(options.outDir, "assets");
    const imagePng = normalizeImage(filename, assetDir);
    const imageData = readPngImageData(imagePng);
    result.timings.decode = performance.now() - tDecode;
    const testCase = buildTestCase(filename, metadataMap, imagePng, imageData, props, options);
    try {
        const lucky = await runLucky(testCase, imageData, log);
        lucky.timings.decode = result.timings.decode;
        log(`    done: ${lucky.matches.length} matches, final RMS ${fmt(lucky.finalRms)} px, total ${fmtMs(lucky.timings.total + lucky.timings.decode)}`);
        return lucky;
    } catch (error) {
        console.error(`    failed: ${error.stack || error.message || error}`);
        if (!options.keepGoing) {
            throw error;
        }
        return {
            testCase,
            matches: [],
            optpar: testCase.initialOptpar,
            finalRms: Infinity,
            stageRows: [],
            timings: result.timings,
            error: error.message || String(error),
        };
    }
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const images = listImages(options);
    if (images.length === 0) {
        throw new Error("no supported images found in calibration_images/");
    }
    fs.rmSync(options.outDir, {recursive: true, force: true});
    fs.mkdirSync(path.join(options.outDir, "assets"), {recursive: true});
    const metadataMap = testCaseMetadataMap();
    console.log(`Running lucky calibration report for ${images.length} image${images.length === 1 ? "" : "s"}`);
    console.log(`Output directory: ${options.outDir}`);
    const results = [];
    for (let i = 0; i < images.length; i += 1) {
        results.push(await analyzeImage(images[i], i, images.length, metadataMap, options));
    }
    const outFile = path.join(options.outDir, "index.html");
    fs.writeFileSync(outFile, pageHtml(results, reportCommand(process.argv.slice(2))));
    const total = results.reduce((acc, result) => {
        for (const [key, value] of Object.entries(result.timings || {})) {
            acc[key] = (acc[key] || 0) + (Number.isFinite(value) ? value : 0);
        }
        return acc;
    }, {});
    console.log("\nTiming totals:");
    for (const [key, value] of Object.entries(total).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${key.padEnd(10)} ${fmtMs(value)}`);
    }
    console.log(`\nReport: ${outFile}`);
}

if (require.main === module) {
    main().catch(error => {
        console.error(error.stack || error.message || error);
        process.exitCode = 1;
    });
}
