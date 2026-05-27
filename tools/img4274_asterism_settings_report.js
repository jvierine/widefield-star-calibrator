#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const {performance} = require("node:perf_hooks");

const AutoIdentifier = require("../js/auto_identifier.js");
const AidaCentroid = require("../js/centroid.js");
const StarDetector = require("../js/star_detector.js");
const {
    AidaTools,
    buildCases,
    readPngImageData,
    testCaseImagePath,
} = require("./generate_test_report.js");

const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "test-report", "img4274-asterism-settings");
const DEG = Math.PI / 180;

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, ch => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;",
    }[ch]));
}

function fmt(value, digits = 2) {
    return Number.isFinite(value) ? Number(value).toFixed(digits) : "n/a";
}

function median(values) {
    const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!finite.length) {
        return NaN;
    }
    const mid = Math.floor(finite.length / 2);
    return finite.length % 2 ? finite[mid] : 0.5 * (finite[mid - 1] + finite[mid]);
}

function catalogKey(star) {
    if (star && star.id) {
        return String(star.id);
    }
    return `${star.name || ""}|${Number(star.raHours).toFixed(7)}|${Number(star.decDeg).toFixed(7)}`;
}

function skySeparationDeg(a, b) {
    const ra1 = Number(a.raHours) * 15 * DEG;
    const ra2 = Number(b.raHours) * 15 * DEG;
    const de1 = Number(a.decDeg) * DEG;
    const de2 = Number(b.decDeg) * DEG;
    const dot = Math.sin(de1) * Math.sin(de2) + Math.cos(de1) * Math.cos(de2) * Math.cos(ra1 - ra2);
    return Math.acos(Math.max(-1, Math.min(1, dot))) / DEG;
}

function loadTycho2Rows() {
    const filename = path.join(ROOT, "data", "tycho2_mag8.bin.gz");
    const compressed = fs.readFileSync(filename);
    const buffer = zlib.gunzipSync(compressed);
    if (buffer.subarray(0, 8).toString("ascii") !== "WISCAT1\0") {
        throw new Error("bad Tycho-2 catalogue magic");
    }
    const count = buffer.readUInt32LE(8);
    const stride = buffer.readUInt32LE(12);
    if (stride !== 3) {
        throw new Error(`unsupported Tycho-2 stride ${stride}`);
    }
    const rows = new Array(count);
    let offset = 16;
    for (let i = 0; i < count; i += 1) {
        rows[i] = [
            buffer.readFloatLE(offset),
            buffer.readFloatLE(offset + 4),
            buffer.readFloatLE(offset + 8),
            "",
            `TYCHO2-${i + 1}`,
        ];
        offset += 12;
    }
    return rows;
}

function loadYaleRows() {
    const source = fs.readFileSync(path.join(ROOT, "js", "star_catalog.js"), "utf8");
    const window = {};
    // The generated catalogue script assigns to window.AIDA_STAR_CATALOG.
    Function("window", source)(window);
    return window.AIDA_STAR_CATALOG;
}

function visibleStarsFromRows(rows, testCase, maxMag) {
    const maxZenithDeg = Number.isFinite(testCase.maxZenithDeg) ? testCase.maxZenithDeg : 88;
    return AidaTools.visibleStars(rows, testCase.date, testCase.latDeg, testCase.lonDeg, maxMag, maxZenithDeg)
        .map(star => ({...star, key: catalogKey(star)}));
}

function manualTruth(testCase, maxMag = 99) {
    return (testCase.matches || [])
        .filter(match => match && match.image && match.catalog && Number(match.catalog.mag) <= maxMag)
        .map((match, index) => ({
            id: `truth-${index}`,
            x: Number(match.image.x),
            y: Number(match.image.y),
            key: match.catalog.key || catalogKey(match.catalog),
            name: match.catalog.name || match.catalog.key || "",
            raHours: Number(match.catalog.raHours),
            decDeg: Number(match.catalog.decDeg),
            mag: Number(match.catalog.mag),
        }))
        .filter(row => Number.isFinite(row.x) && Number.isFinite(row.y) &&
            Number.isFinite(row.raHours) && Number.isFinite(row.decDeg) && Number.isFinite(row.mag));
}

function oracleDetectionsFromTruth(truth, maxDetections) {
    return truth
        .slice()
        .sort((a, b) => a.mag - b.mag || a.key.localeCompare(b.key))
        .slice(0, maxDetections)
        .map((row, index) => ({
            id: `oracle-${index}`,
            x: row.x,
            y: row.y,
            score: 100000 - 100 * row.mag - index,
            strength: 100000 - 100 * row.mag - index,
            localSnr: Math.max(1, 12 - row.mag),
            peakContrast: Math.max(1, 255 - 18 * row.mag),
            truthKey: row.key,
        }));
}

function scoreMatches(matches, truth, radiusPx = 16, skyToleranceDeg = 0.12) {
    let correct = 0;
    let wrong = 0;
    let unknown = 0;
    const residuals = [];
    const wrongRows = [];
    for (const match of matches || []) {
        let nearest = null;
        let nearestDistance = Infinity;
        for (const row of truth) {
            const distance = Math.hypot(match.detection.x - row.x, match.detection.y - row.y);
            if (distance < nearestDistance) {
                nearest = row;
                nearestDistance = distance;
            }
        }
        if (!nearest || nearestDistance > radiusPx) {
            unknown += 1;
            continue;
        }
        const sepDeg = skySeparationDeg(match.star, nearest);
        if (sepDeg <= skyToleranceDeg) {
            correct += 1;
            residuals.push(nearestDistance);
        } else {
            wrong += 1;
            if (wrongRows.length < 8) {
                wrongRows.push({
                    got: match.star.name || match.star.key,
                    expected: nearest.name || nearest.key,
                    sepDeg,
                    pixelDistance: nearestDistance,
                });
            }
        }
    }
    return {
        correct,
        wrong,
        unknown,
        total: (matches || []).length,
        medianTruthPx: median(residuals),
        wrongRows,
    };
}

function circle(cx, cy, r, klass, title = "") {
    return `<circle class="${klass}" cx="${fmt(cx, 2)}" cy="${fmt(cy, 2)}" r="${fmt(r, 2)}">` +
        `${title ? `<title>${escapeHtml(title)}</title>` : ""}</circle>`;
}

function line(x1, y1, x2, y2, klass) {
    return `<line class="${klass}" x1="${fmt(x1, 2)}" y1="${fmt(y1, 2)}" x2="${fmt(x2, 2)}" y2="${fmt(y2, 2)}"/>`;
}

function overlaySvg(testCase, truth, detections, result) {
    const items = [];
    for (const row of truth.filter(row => row.mag <= 6.5)) {
        items.push(circle(row.x, row.y, 8, "truth", row.name || row.key));
    }
    for (const detection of detections.slice(0, 650)) {
        items.push(circle(detection.x, detection.y, 5, "detection"));
    }
    for (const match of result.matches || []) {
        let nearest = null;
        let nearestDistance = Infinity;
        for (const row of truth) {
            const distance = Math.hypot(match.detection.x - row.x, match.detection.y - row.y);
            if (distance < nearestDistance) {
                nearest = row;
                nearestDistance = distance;
            }
        }
        const correct = nearest && nearestDistance <= 16 && skySeparationDeg(match.star, nearest) <= 0.12;
        items.push(circle(match.detection.x, match.detection.y, 14, correct ? "match-good" : "match-bad",
            `${match.star.name || match.star.key}`));
    }
    const edgeLimit = 80;
    for (const edge of (result.debugEdges || []).slice(0, edgeLimit)) {
        items.push(line(edge[0].x, edge[0].y, edge[1].x, edge[1].y, "edge"));
    }
    return `<svg viewBox="0 0 ${testCase.width} ${testCase.height}" aria-label="Asterism study overlay">${items.join("\n")}</svg>`;
}

function extractDebugEdges(result) {
    const edges = [];
    const snapshots = result.triangleDebugSnapshots || [];
    for (const snapshot of snapshots) {
        const accepted = snapshot.supportTriangles && snapshot.supportTriangles.acceptedEdges;
        if (Array.isArray(accepted)) {
            for (const edge of accepted) {
                if (edge && edge.length === 2) {
                    edges.push(edge);
                }
            }
        }
    }
    return edges;
}

async function detectorRun(label, imageData, options) {
    const t0 = performance.now();
    const result = await StarDetector.detectBrightStars(imageData, {
        maxDetections: 900,
        scanStep: 1,
        thresholdSigma: 1.5,
        localThresholdSigma: 1.5,
        requireGlobalThreshold: false,
        maxRadiusPx: 5,
        maxElongation: 4.0,
        suppressionRadiusPx: 10,
        crowdingRadiusPx: 36,
        maxCrowding: 7,
        crowdingScorePower: 1.25,
        ...options,
    });
    return {
        label,
        timeMs: performance.now() - t0,
        status: result.status,
        detections: result.detections,
    };
}

function imageGrayInterpolated(imageData, x, y) {
    const width = imageData.width;
    const height = imageData.height;
    const data = imageData.data;
    const xx = Math.max(0, Math.min(width - 1, x));
    const yy = Math.max(0, Math.min(height - 1, y));
    const x0 = Math.floor(xx);
    const y0 = Math.floor(yy);
    const x1 = Math.min(width - 1, x0 + 1);
    const y1 = Math.min(height - 1, y0 + 1);
    const tx = xx - x0;
    const ty = yy - y0;
    const gray = (px, py) => {
        const k = 4 * (py * width + px);
        return 0.2126 * data[k] + 0.7152 * data[k + 1] + 0.0722 * data[k + 2];
    };
    const a = gray(x0, y0) * (1 - tx) + gray(x1, y0) * tx;
    const b = gray(x0, y1) * (1 - tx) + gray(x1, y1) * tx;
    return a * (1 - ty) + b * ty;
}

function refineDetectionsWithKde(label, imageData, detections, maxRefine = 120) {
    const t0 = performance.now();
    const refined = detections.map((detection, index) => {
        if (index >= maxRefine) {
            return detection;
        }
        const centroid = AidaCentroid.estimateCentroid(
            detection.x,
            detection.y,
            (x, y) => imageGrayInterpolated(imageData, x, y),
            {
                imageWidth: imageData.width,
                patchRadiusWidthFraction: 8 / 4032,
                upsample: 20,
            }
        );
        return {
            ...detection,
            x: centroid.x,
            y: centroid.y,
            rawDetectorX: detection.x,
            rawDetectorY: detection.y,
            centroidMethod: "upsampled KDE diagnostic",
        };
    });
    return {
        label,
        timeMs: performance.now() - t0,
        status: `KDE-refined first ${Math.min(maxRefine, detections.length)} detections from automatic detector`,
        detections: refined,
    };
}

function trueOnlyDetections(label, detections, truth, radiusPx = 16) {
    const tagged = attachTruthKeysToDetections(detections, truth, radiusPx);
    return {
        label,
        timeMs: 0,
        status: `diagnostic oracle filter: kept ${tagged.filter(d => d.truthKey).length}/${detections.length} detections that are near saved true stars`,
        detections: tagged.filter(d => d.truthKey),
    };
}

function rerankDetections(label, detections, scoreFn) {
    return {
        label,
        timeMs: 0,
        status: "diagnostic reranking of the same automatic detections",
        detections: detections
            .map((detection, index) => ({
                ...detection,
                score: scoreFn(detection, index),
                strength: scoreFn(detection, index),
                originalRank: index,
            }))
            .sort((a, b) => b.score - a.score || a.originalRank - b.originalRank),
    };
}

function localBackgroundForLargeFlux(imageData, x, y) {
    const samples = [];
    for (let dy = -18; dy <= 18; dy += 3) {
        for (let dx = -18; dx <= 18; dx += 3) {
            const r = Math.hypot(dx, dy);
            if (r >= 13 && r <= 18) {
                samples.push(imageGrayInterpolated(imageData, x + dx, y + dy));
            }
        }
    }
    return median(samples);
}

function largeApertureFlux(imageData, x, y) {
    const background = localBackgroundForLargeFlux(imageData, x, y);
    let flux = 0;
    let core = 0;
    for (let dy = -12; dy <= 12; dy += 1) {
        for (let dx = -12; dx <= 12; dx += 1) {
            const r = Math.hypot(dx, dy);
            if (r <= 12) {
                const value = Math.max(0, imageGrayInterpolated(imageData, x + dx, y + dy) - background);
                flux += value;
                if (r <= 4) {
                    core += value;
                }
            }
        }
    }
    return flux + 0.35 * core;
}

function rerankByLargeApertureFlux(label, imageData, detections) {
    const scored = detections.map((detection, index) => ({
        ...detection,
        largeApertureFlux: largeApertureFlux(imageData, detection.x, detection.y),
        originalRank: index,
    }));
    return {
        label,
        timeMs: 0,
        status: "diagnostic reranking by 12 px aperture flux",
        detections: scored
            .map(detection => ({
                ...detection,
                score: detection.largeApertureFlux,
                strength: detection.largeApertureFlux,
            }))
            .sort((a, b) => b.largeApertureFlux - a.largeApertureFlux || a.originalRank - b.originalRank),
    };
}

function settingGrid() {
    const common = {
        maxCatalogLocalNeighbors: 24,
        maxBlindNeighborTriangles: 10,
        maxBlindVerifyDetections: 650,
        maxBlindCandidateRotations: 4500,
        maxBlindCandidateRotationsPerSign: 1800,
        rejectAmbiguousBlindMatches: true,
        blindAmbiguityRadiusDeg: 0.9,
        blindAmbiguityDistanceSlackDeg: 0.3,
        blindPixelMatchRadiusPx: 58,
        blindPixelAmbiguityRadiusPx: 16,
        blindPixelAmbiguityDistanceSlackPx: 8,
        blindEarlyAcceptMatches: 10,
        blindEarlyAcceptMedianDeg: 0.75,
        ambiguityMaxMagnitude: 7.0,
    };
    return [
        {
            label: "mag 6 bootstrap",
            maxMag: 6.0,
            maxDetections: 140,
            maxCatalogStars: 220,
            maxCatalogTriangleStars: 180,
            maxDetectionTriangleStars: 100,
            maxDetectionTriangles: 3200,
            maxCatalogTriangles: 18000,
            preflattenModelCandidates: ["pinhole", "fisheye"],
            preflattenF1Candidates: [0.55, 0.65, 0.75, 0.85, 0.95, 1.10],
            preflattenRadialAlphaCandidates: [0.15, 0.30, 0.45, 0.60, 0.75, 0.90, 0.98],
            preflattenSignCandidates: [[1, 1], [-1, -1]],
            ...common,
        },
        {
            label: "mag 6 all sign candidates",
            maxMag: 6.0,
            maxDetections: 140,
            maxCatalogStars: 220,
            maxCatalogTriangleStars: 180,
            maxDetectionTriangleStars: 100,
            maxDetectionTriangles: 3200,
            maxCatalogTriangles: 18000,
            preflattenModelCandidates: ["pinhole", "fisheye"],
            preflattenF1Candidates: [0.55, 0.65, 0.75, 0.85, 0.95, 1.10],
            preflattenRadialAlphaCandidates: [0.15, 0.30, 0.45, 0.60, 0.75, 0.90, 0.98],
            preflattenSignCandidates: [[1, 1], [-1, -1], [1, -1], [-1, 1]],
            ...common,
        },
        {
            label: "fainter catalogue",
            maxMag: 7.5,
            maxDetections: 320,
            maxCatalogStars: 1000,
            maxCatalogTriangleStars: 420,
            maxDetectionTriangleStars: 160,
            maxDetectionTriangles: 8500,
            maxCatalogTriangles: 56000,
            preflattenModelCandidates: ["pinhole", "fisheye"],
            preflattenF1Candidates: [0.50, 0.60, 0.70, 0.80, 0.90, 1.05],
            preflattenRadialAlphaCandidates: [0.10, 0.20, 0.35, 0.50, 0.65, 0.80, 0.95],
            preflattenSignCandidates: [[1, 1], [-1, -1], [1, -1], [-1, 1]],
            blindTriangleSignatureRadius: 0.022,
            ...common,
        },
        {
            label: "strict geometry relaxed signature",
            maxMag: 7.0,
            maxDetections: 300,
            maxCatalogStars: 900,
            maxCatalogTriangleStars: 400,
            maxDetectionTriangleStars: 150,
            maxDetectionTriangles: 7200,
            maxCatalogTriangles: 52000,
            minDetectionTriangleSidePx: 70,
            minDetectionTriangleHeightPx: 30,
            blindTriangleSignatureRadius: 0.024,
            preflattenModelCandidates: ["pinhole", "fisheye"],
            preflattenF1Candidates: [0.55, 0.65, 0.75, 0.85, 0.95],
            preflattenRadialAlphaCandidates: [0.15, 0.30, 0.45, 0.60, 0.75, 0.90],
            preflattenSignCandidates: [[1, 1], [-1, -1], [1, -1], [-1, 1]],
            ...common,
        },
        {
            label: "disable neighbor support test",
            maxMag: 7.0,
            maxDetections: 300,
            maxCatalogStars: 900,
            maxCatalogTriangleStars: 400,
            maxDetectionTriangleStars: 150,
            maxDetectionTriangles: 7200,
            maxCatalogTriangles: 52000,
            disableBlindAsterismNeighborSupport: true,
            preflattenModelCandidates: ["pinhole", "fisheye"],
            preflattenF1Candidates: [0.55, 0.65, 0.75, 0.85, 0.95],
            preflattenRadialAlphaCandidates: [0.15, 0.30, 0.45, 0.60, 0.75, 0.90],
            preflattenSignCandidates: [[1, 1], [-1, -1], [1, -1], [-1, 1]],
            ...common,
        },
    ];
}

function angularDistanceDeg(a, b) {
    const sinZa = Math.sin(a.ze);
    const sinZb = Math.sin(b.ze);
    const dot = sinZa * sinZb * Math.cos(a.az - b.az) + Math.cos(a.ze) * Math.cos(b.ze);
    return Math.acos(Math.max(-1, Math.min(1, dot))) / DEG;
}

function triangleAreaHeight(p1, p2, p3) {
    const a = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const b = Math.hypot(p3.x - p2.x, p3.y - p2.y);
    const c = Math.hypot(p1.x - p3.x, p1.y - p3.y);
    const longest = Math.max(a, b, c);
    const area2 = Math.abs(
        (p2.x - p1.x) * (p3.y - p1.y) -
        (p2.y - p1.y) * (p3.x - p1.x)
    );
    return longest > 1e-9 ? area2 / longest : 0;
}

function triangleSignatureFromLengths(lengths) {
    const sorted = lengths.slice().sort((a, b) => a - b);
    const c = sorted[2];
    if (!(c > 0)) {
        return null;
    }
    return {
        aOverC: sorted[0] / c,
        bOverC: sorted[1] / c,
        longest: c,
    };
}

function imageTriangleSignature(p1, p2, p3) {
    return triangleSignatureFromLengths([
        Math.hypot(p2.x - p1.x, p2.y - p1.y),
        Math.hypot(p3.x - p2.x, p3.y - p2.y),
        Math.hypot(p1.x - p3.x, p1.y - p3.y),
    ]);
}

function skyTriangleSignature(p1, p2, p3) {
    return triangleSignatureFromLengths([
        angularDistanceDeg(p1, p2),
        angularDistanceDeg(p2, p3),
        angularDistanceDeg(p1, p3),
    ]);
}

function truthKeyForSkyPoint(point, truth, toleranceDeg = 0.12) {
    let best = null;
    let bestDistance = Infinity;
    for (const row of truth) {
        const distance = skySeparationDeg(point, row);
        if (distance < bestDistance) {
            best = row;
            bestDistance = distance;
        }
    }
    return best && bestDistance <= toleranceDeg ? best.key : "";
}

function attachTruthKeysToDetections(detections, truth, radiusPx = 16) {
    return detections.map((detection, index) => {
        let best = null;
        let bestDistance = Infinity;
        for (const row of truth) {
            const distance = Math.hypot(detection.x - row.x, detection.y - row.y);
            if (distance < bestDistance) {
                best = row;
                bestDistance = distance;
            }
        }
        return {
            ...detection,
            id: detection.id || `det-${index}`,
            truthKey: best && bestDistance <= radiusPx ? best.key : "",
            truthDistancePx: bestDistance,
        };
    });
}

function triangleTruthKey(points) {
    const keys = points.map(point => point.truthKey).filter(Boolean).sort();
    return keys.length === 3 && new Set(keys).size === 3 ? keys.join("|") : "";
}

function buildImageTriangles(points, options) {
    const triangles = [];
    const maxSidePx = options.maxSideFraction * options.width;
    const maxPoints = Math.min(points.length, options.maxPoints);
    for (let i = 0; i < maxPoints - 2; i += 1) {
        for (let j = i + 1; j < maxPoints - 1; j += 1) {
            for (let k = j + 1; k < maxPoints; k += 1) {
                const p1 = points[i];
                const p2 = points[j];
                const p3 = points[k];
                const sig = imageTriangleSignature(p1, p2, p3);
                if (!sig || sig.longest > maxSidePx || sig.longest < options.minSidePx) {
                    continue;
                }
                const shortest = sig.aOverC * sig.longest;
                if (shortest < options.minSidePx ||
                        triangleAreaHeight(p1, p2, p3) < options.minHeightPx) {
                    continue;
                }
                triangles.push({
                    ...sig,
                    truthKey: triangleTruthKey([p1, p2, p3]),
                    points: [p1, p2, p3],
                });
            }
        }
    }
    return triangles;
}

function buildSkyTriangles(points, options) {
    const triangles = [];
    const maxPoints = Math.min(points.length, options.maxPoints);
    for (let i = 0; i < maxPoints - 2; i += 1) {
        for (let j = i + 1; j < maxPoints - 1; j += 1) {
            for (let k = j + 1; k < maxPoints; k += 1) {
                const p1 = points[i];
                const p2 = points[j];
                const p3 = points[k];
                const sig = skyTriangleSignature(p1, p2, p3);
                if (!sig || sig.longest > options.maxSideDeg || sig.longest < options.minSideDeg) {
                    continue;
                }
                triangles.push({
                    ...sig,
                    truthKey: triangleTruthKey([p1, p2, p3]),
                    points: [p1, p2, p3],
                });
            }
        }
    }
    return triangles;
}

function indexTrianglesBySignature(triangles, radius) {
    const binSize = radius;
    const bins = new Map();
    for (const triangle of triangles) {
        const ix = Math.floor(triangle.aOverC / binSize);
        const iy = Math.floor(triangle.bOverC / binSize);
        const key = `${ix},${iy}`;
        if (!bins.has(key)) {
            bins.set(key, []);
        }
        bins.get(key).push(triangle);
    }
    return {bins, binSize};
}

function querySignature(index, triangle, radius) {
    const ix = Math.floor(triangle.aOverC / index.binSize);
    const iy = Math.floor(triangle.bOverC / index.binSize);
    const out = [];
    for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
            const local = index.bins.get(`${ix + dx},${iy + dy}`) || [];
            for (const candidate of local) {
                if (Math.hypot(candidate.aOverC - triangle.aOverC, candidate.bOverC - triangle.bOverC) <= radius) {
                    out.push(candidate);
                }
            }
        }
    }
    return out;
}

function signatureSweepRows({testCase, truth, catalogSets, detectorRuns}) {
    const sweep = [];
    const settings = [];
    for (const topDetections of [30, 50, 70, 90]) {
        for (const maxMag of [6.0, 6.5, 7.0]) {
            for (const signatureRadius of [0.018, 0.024, 0.032]) {
                settings.push({
                    topDetections,
                    maxMag,
                    signatureRadius,
                    minSidePx: 50,
                    minHeightPx: 20,
                    maxSideFraction: 0.25,
                    maxCatalogSideDeg: 70,
                    maxCatalogPoints: maxMag > 6.5 ? 90 : 70,
                });
            }
        }
    }
    for (const catalogSet of catalogSets) {
        for (const detector of detectorRuns) {
            const detectionsWithTruth = attachTruthKeysToDetections(detector.detections, truth)
                .slice(0, 340);
            for (const setting of settings) {
                const visible = visibleStarsFromRows(catalogSet.rows, testCase, setting.maxMag)
                    .slice(0, setting.maxCatalogPoints)
                    .map(star => ({...star, truthKey: truthKeyForSkyPoint(star, truth)}));
                const imageTriangles = buildImageTriangles(
                    detectionsWithTruth.slice(0, setting.topDetections),
                    {
                        width: testCase.width,
                        maxPoints: setting.topDetections,
                        minSidePx: setting.minSidePx,
                        minHeightPx: setting.minHeightPx,
                        maxSideFraction: setting.maxSideFraction,
                    }
                );
                const skyTriangles = buildSkyTriangles(visible, {
                    maxPoints: visible.length,
                    minSideDeg: 1.5,
                    maxSideDeg: setting.maxCatalogSideDeg,
                });
                if (imageTriangles.length > 70000 || skyTriangles.length > 120000) {
                    continue;
                }
                const skyIndex = indexTrianglesBySignature(skyTriangles, setting.signatureRadius);
                let trueRecoverable = 0;
                let trueImageTriangles = 0;
                let totalSignatureHits = 0;
                let trueSignatureHits = 0;
                let falseSignatureHits = 0;
                for (const triangle of imageTriangles) {
                    if (triangle.truthKey) {
                        trueImageTriangles += 1;
                    }
                    const hits = querySignature(skyIndex, triangle, setting.signatureRadius);
                    totalSignatureHits += hits.length;
                    if (triangle.truthKey) {
                        const hasTrue = hits.some(hit => hit.truthKey && hit.truthKey === triangle.truthKey);
                        if (hasTrue) {
                            trueRecoverable += 1;
                        }
                        trueSignatureHits += hits.filter(hit => hit.truthKey && hit.truthKey === triangle.truthKey).length;
                        falseSignatureHits += hits.filter(hit => !hit.truthKey || hit.truthKey !== triangle.truthKey).length;
                    }
                }
                const score = 1000 * trueRecoverable + 0.5 * trueSignatureHits - 0.015 * falseSignatureHits;
                sweep.push({
                    catalogName: catalogSet.name,
                    sourceLabel: detector.label,
                    ...setting,
                    visibleStars: visible.length,
                    detections: Math.min(detector.detections.length, setting.topDetections),
                    truthDetections: detectionsWithTruth.slice(0, setting.topDetections).filter(d => d.truthKey).length,
                    imageTriangles: imageTriangles.length,
                    trueImageTriangles,
                    skyTriangles: skyTriangles.length,
                    trueRecoverable,
                    totalSignatureHits,
                    trueSignatureHits,
                    falseSignatureHits,
                    ambiguityPerTrueTriangle: trueImageTriangles ? falseSignatureHits / trueImageTriangles : Infinity,
                    score,
                });
            }
        }
    }
    return sweep.sort((a, b) => b.score - a.score || b.trueRecoverable - a.trueRecoverable ||
        a.ambiguityPerTrueTriangle - b.ambiguityPerTrueTriangle);
}

async function evaluateRun({testCase, catalogName, catalogRows, truth, detections, sourceLabel, settings}) {
    const catalog = visibleStarsFromRows(catalogRows, testCase, settings.maxMag);
    const snapshots = [];
    const t0 = performance.now();
    const result = AutoIdentifier.identifyStarsBlind(catalog, detections, {
        ...settings,
        maxMagnitude: settings.maxMag,
        minMatches: 4,
        imageWidth: testCase.width,
        imageHeight: testCase.height,
        triangleDebugCallback: snapshot => snapshots.push(snapshot),
    });
    const timeMs = performance.now() - t0;
    result.triangleDebugSnapshots = snapshots;
    result.debugEdges = extractDebugEdges(result);
    const score = scoreMatches(result.matches, truth);
    return {
        catalogName,
        sourceLabel,
        settingsLabel: settings.label,
        settings,
        result,
        score,
        timeMs,
        catalogCount: catalog.length,
        detectionCount: detections.length,
    };
}

function resultSort(a, b) {
    return b.score.correct - a.score.correct ||
        a.score.wrong - b.score.wrong ||
        b.score.total - a.score.total ||
        a.timeMs - b.timeMs;
}

function tableRows(results) {
    return results.map((row, index) => `<tr class="${index === 0 ? "best" : ""}">
<td>${index + 1}</td>
<td>${escapeHtml(row.catalogName)}</td>
<td>${escapeHtml(row.sourceLabel)}</td>
<td>${escapeHtml(row.settingsLabel)}</td>
<td>${row.score.correct}</td>
<td>${row.score.wrong}</td>
<td>${row.score.unknown}</td>
<td>${row.score.total}</td>
<td>${row.catalogCount}</td>
<td>${row.detectionCount}</td>
<td>${fmt(row.result.medianDistance, 2)}</td>
<td>${fmt(row.result.f1, 2)}</td>
<td>${fmt(row.result.radialAlpha, 2)}</td>
<td>${row.result.signX || ""}/${row.result.signY || ""}</td>
<td>${fmt(row.timeMs / 1000, 1)}</td>
<td>${escapeHtml(row.result.status || "")}</td>
</tr>`).join("\n");
}

function signatureRows(rows) {
    return rows.map((row, index) => `<tr class="${index === 0 ? "best" : ""}">
<td>${index + 1}</td>
<td>${escapeHtml(row.catalogName)}</td>
<td>${escapeHtml(row.sourceLabel)}</td>
<td>${row.maxMag}</td>
<td>${row.topDetections}</td>
<td>${row.truthDetections}</td>
<td>${fmt(row.signatureRadius, 3)}</td>
<td>${row.trueRecoverable}</td>
<td>${row.trueImageTriangles}</td>
<td>${row.falseSignatureHits}</td>
<td>${fmt(row.ambiguityPerTrueTriangle, 1)}</td>
<td>${row.imageTriangles}</td>
<td>${row.skyTriangles}</td>
<td>${fmt(row.score, 1)}</td>
</tr>`).join("\n");
}

function topFigures(testCase, imageRel, truth, resultRows) {
    return resultRows.slice(0, 4).map(row => `<section class="figure">
<h3>${escapeHtml(row.catalogName)} / ${escapeHtml(row.sourceLabel)} / ${escapeHtml(row.settingsLabel)}</h3>
<div class="stage" style="aspect-ratio:${testCase.width}/${testCase.height}">
<img src="${escapeHtml(imageRel)}" alt="IMG_4274">
${overlaySvg(testCase, truth, row.result.detections || [], row.result)}
</div>
<p>${row.score.correct} correct, ${row.score.wrong} wrong, ${row.score.unknown} unknown. ${escapeHtml(row.result.status || "")}</p>
</section>`).join("\n");
}

function pageHtml(testCase, detectorRuns, results, imageRel, signatureRowsData) {
    const best = signatureRowsData[0];
    const bestOracle = results.find(row => row.sourceLabel === "oracle saved pair centers");
    const bestAutomatic = results.find(row => row.sourceLabel !== "oracle saved pair centers");
    const recommendation = best ?
        `Best triangle-signature setting: ${best.catalogName}, ${best.sourceLabel}, ` +
        `top ${best.topDetections} detections, mag <= ${best.maxMag}, signature radius ${fmt(best.signatureRadius, 3)}. ` +
        `It recovers ${best.trueRecoverable} known-good true triangles while producing about ` +
        `${fmt(best.ambiguityPerTrueTriangle, 1)} false signature hits per true image triangle.` :
        "No useful triangle-signature setting was found.";
    const conclusion = bestOracle && bestAutomatic ?
        `Full matcher spot checks: saved star centers recover ${bestOracle.score.correct}/${bestOracle.score.total} ` +
        `correct matches, while the best automatic detection variant recovers ` +
        `${bestAutomatic.score.correct}/${bestAutomatic.score.total}. This isolates the failure to detector ranking / ` +
        `false-positive rejection for the bootstrap, not to the catalogue or basic asterism geometry.` :
        "";
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>IMG_4274 Asterism Settings Study</title>
<style>
body { margin: 0; font: 15px/1.45 system-ui, -apple-system, Segoe UI, sans-serif; color: #d9e2ef; background: #0b1020; }
main { max-width: 1400px; margin: 0 auto; padding: 24px; }
h1, h2, h3 { color: #f8fafc; }
.note, table, .figure { background: #111827; border: 1px solid #263244; border-radius: 8px; }
.note { padding: 14px 16px; margin: 12px 0 18px; }
table { width: 100%; border-collapse: collapse; overflow: hidden; font-size: 13px; }
th, td { padding: 7px 8px; border-bottom: 1px solid #263244; text-align: left; vertical-align: top; }
th { color: #93c5fd; background: #182235; position: sticky; top: 0; }
tr.best { background: rgba(34, 197, 94, 0.12); }
.stage { position: relative; background: #05070c; overflow: hidden; border-radius: 6px; }
.stage img, .stage svg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; display: block; }
.stage svg { pointer-events: none; }
.truth { fill: none; stroke: rgba(147, 197, 253, 0.9); stroke-width: 3; }
.detection { fill: none; stroke: rgba(250, 204, 21, 0.42); stroke-width: 3; }
.match-good { fill: none; stroke: rgba(34, 197, 94, 0.95); stroke-width: 5; }
.match-bad { fill: none; stroke: rgba(239, 68, 68, 0.95); stroke-width: 5; }
.edge { stroke: rgba(125, 211, 252, 0.45); stroke-width: 2; }
.figure { padding: 14px; margin: 18px 0; }
code { color: #bfdbfe; }
</style>
</head>
<body>
<main>
<h1>IMG_4274 Asterism Settings Study</h1>
<div class="note">
<p>${escapeHtml(recommendation)}</p>
${conclusion ? `<p>${escapeHtml(conclusion)}</p>` : ""}
<p>This report uses the saved manual IMG_4274 calibration as an oracle. Blue circles are known paired stars, yellow circles are detector outputs, green rings are correct recovered blind matches, and red rings are wrong recovered matches.</p>
<p>Command: <code>node tools/img4274_asterism_settings_report.js</code></p>
</div>
<h2>Detector Inputs</h2>
<table><thead><tr><th>source</th><th>detections</th><th>time</th><th>status</th></tr></thead><tbody>
${detectorRuns.map(run => `<tr><td>${escapeHtml(run.label)}</td><td>${run.detections.length}</td><td>${fmt(run.timeMs / 1000, 1)} s</td><td>${escapeHtml(run.status)}</td></tr>`).join("\n")}
</tbody></table>
<h2>Fast Triangle-Signature Sweep</h2>
<table><thead><tr><th>#</th><th>catalog</th><th>detections</th><th>mag</th><th>top det</th><th>true det</th><th>sig r</th><th>true recovered</th><th>true image tri</th><th>false hits</th><th>false/true</th><th>image tri</th><th>sky tri</th><th>score</th></tr></thead><tbody>
${signatureRows(signatureRowsData)}
</tbody></table>
<h2>Full Blind Matcher Spot Checks</h2>
<table><thead><tr><th>#</th><th>catalog</th><th>detections</th><th>setting</th><th>correct</th><th>wrong</th><th>unknown</th><th>matches</th><th>catalog</th><th>det</th><th>med deg</th><th>f1</th><th>α</th><th>sign</th><th>time</th><th>status</th></tr></thead><tbody>
${tableRows(results)}
</tbody></table>
<h2>Best Overlays</h2>
${topFigures(testCase, imageRel, manualTruth(testCase, 7.5), results)}
</main>
</body>
</html>`;
}

async function main() {
    fs.mkdirSync(OUT_DIR, {recursive: true});
    const testCase = buildCases().find(row => row.id === "IMG_4274");
    if (!testCase) {
        throw new Error("IMG_4274 test case not found");
    }
    const imagePath = testCaseImagePath(testCase);
    const imageData = readPngImageData(imagePath);
    const truth = manualTruth(testCase, 7.5);
    const catalogSets = [
        {name: "tycho2", rows: loadTycho2Rows()},
        {name: "yale", rows: loadYaleRows()},
    ];
    const currentDeep = await detectorRun("auto current deep", imageData, {});
    const weakSpatial = await detectorRun("auto weak + spatial background", imageData, {
        useSpatialBackground: true,
        thresholdSigma: 1.25,
        localThresholdSigma: 1.35,
        minMatchedFilterSnr: 1.0,
        maxElongation: 4.5,
    });
    const detectorRuns = [
        {
            label: "oracle saved pair centers",
            timeMs: 0,
            status: "manual saved pair centers sorted by catalogue magnitude",
            detections: oracleDetectionsFromTruth(truth, 900),
        },
        currentDeep,
        rerankDetections("auto current ranked by peak contrast", currentDeep.detections,
            (detection, index) => Number(detection.peakContrast) || Number(detection.peakValue) || -index),
        rerankDetections("auto current ranked by flux", currentDeep.detections,
            (detection, index) => Number(detection.flux) || Number(detection.peakContrast) || -index),
        rerankByLargeApertureFlux("auto current ranked by large aperture flux", imageData, currentDeep.detections),
        trueOnlyDetections("auto current deep true-only", currentDeep.detections, truth),
        refineDetectionsWithKde("auto current deep + KDE centers", imageData, currentDeep.detections),
        weakSpatial,
        trueOnlyDetections("auto weak spatial true-only", weakSpatial.detections, truth),
        refineDetectionsWithKde("auto weak spatial + KDE centers", imageData, weakSpatial.detections),
    ];
    process.stderr.write("running fast triangle-signature sweep\n");
    const signatureStudy = signatureSweepRows({testCase, truth, catalogSets, detectorRuns});
    const topSignatureRuns = [];
    for (const catalogName of ["yale", "tycho2"]) {
        const oracleRow = signatureStudy.find(row =>
            row.catalogName === catalogName &&
            row.sourceLabel === "oracle saved pair centers" &&
            row.topDetections === 30 &&
            row.maxMag === 6.0 &&
            row.signatureRadius === 0.018
        );
        if (oracleRow) {
            topSignatureRuns.push(oracleRow);
        }
    }
    topSignatureRuns.push(...signatureStudy.slice(0, 3));
    for (const sourceLabel of [
        "auto current deep",
        "auto current ranked by peak contrast",
        "auto current ranked by flux",
        "auto current ranked by large aperture flux",
        "auto current deep true-only",
        "auto current deep + KDE centers",
        "auto weak + spatial background",
        "auto weak spatial true-only",
        "auto weak spatial + KDE centers",
    ]) {
        const autoRow = signatureStudy.find(row => row.sourceLabel === sourceLabel && row.topDetections === 30 && row.maxMag === 6.0);
        if (autoRow) {
            topSignatureRuns.push(autoRow);
        }
    }
    const fullSettings = settingGrid().slice(0, 2);
    const results = [];
    for (const row of topSignatureRuns) {
        const catalogSet = catalogSets.find(item => item.name === row.catalogName);
        const detector = detectorRuns.find(item => item.label === row.sourceLabel);
        const base = fullSettings.find(item => item.maxMag >= row.maxMag) || fullSettings[fullSettings.length - 1];
        const settings = {
            ...base,
            label: `spot check from signature sweep: mag ${row.maxMag}, top ${row.topDetections}, r ${fmt(row.signatureRadius, 3)}`,
            maxMag: row.maxMag,
            maxDetections: row.topDetections,
            blindTriangleSignatureRadius: row.signatureRadius,
            maxCatalogStars: Math.max(base.maxCatalogStars, row.visibleStars),
            maxDetectionTriangleStars: Math.min(row.topDetections, base.maxDetectionTriangleStars),
            maxBlindCandidateRotations: 1800,
            maxBlindCandidateRotationsPerSign: 900,
        };
        process.stderr.write(`spot checking ${catalogSet.name} / ${detector.label} / ${settings.label}\n`);
        results.push(await evaluateRun({
            testCase,
            catalogName: catalogSet.name,
            catalogRows: catalogSet.rows,
            truth,
            detections: detector.detections.slice(0, settings.maxDetections),
            sourceLabel: detector.label,
            settings,
        }));
    }
    results.sort(resultSort);
    const imageRel = path.relative(OUT_DIR, imagePath).replace(/\\/g, "/");
    fs.writeFileSync(path.join(OUT_DIR, "index.html"), pageHtml(testCase, detectorRuns, results, imageRel, signatureStudy));
    fs.writeFileSync(path.join(OUT_DIR, "results.json"), `${JSON.stringify({
        generatedAtUtc: new Date().toISOString(),
        testCase: testCase.id,
        detectorRuns: detectorRuns.map(run => ({
            label: run.label,
            detections: run.detections.length,
            timeMs: run.timeMs,
            status: run.status,
        })),
        signatureStudy,
        results: results.map(row => ({
            catalogName: row.catalogName,
            sourceLabel: row.sourceLabel,
            settingsLabel: row.settingsLabel,
            score: row.score,
            status: row.result.status,
            timeMs: row.timeMs,
            catalogCount: row.catalogCount,
            detectionCount: row.detectionCount,
            f1: row.result.f1,
            radialAlpha: row.result.radialAlpha,
            signX: row.result.signX,
            signY: row.result.signY,
            medianDistance: row.result.medianDistance,
        })),
    }, null, 2)}\n`);
    console.log(path.join(OUT_DIR, "index.html"));
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
