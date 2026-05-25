#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const AutoIdentifier = require("../js/auto_identifier.js");
const StarDetector = require("../js/star_detector.js");
const {
    knownLensValidationMap,
    projectStars,
    readPngImageData,
} = require("./generate_test_report.js");

const ROOT = path.join(__dirname, "..");
const DEFAULT_CASE_DIR = path.join(ROOT, "test_cases", "IMG_9953");
const DEFAULT_OUT_DIR = path.join(ROOT, "test-report", "img9953-undistorted-asterisms");
const DEFAULT_DETECTOR_OPTIONS = {
    maxDetections: 650,
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
};
const DEFAULT_MAX_MAG = 6.5;

function normalizeSavedCase(caseDir = DEFAULT_CASE_DIR) {
    const metadataFile = path.join(caseDir, "metadata.json");
    const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
    const rawOptpar = Array.isArray(metadata.optpar) ? metadata.optpar.map(Number) : [];
    const optmod = rawOptpar.length === 13 && Math.round(rawOptpar[0]) === 20 ?
        20 :
        Number(metadata.optmod || 20);
    const optpar = rawOptpar.length === 13 && Math.round(rawOptpar[0]) === 20 ?
        rawOptpar.slice(1) :
        rawOptpar;
    return {
        id: metadata.id || path.basename(caseDir),
        title: metadata.title || "IMG_9953 undistorted asterism diagnostic",
        image: metadata.image || "IMG_9953.png",
        imagePath: path.join(caseDir, metadata.image || "IMG_9953.png"),
        width: Number(metadata.width),
        height: Number(metadata.height),
        date: new Date(metadata.timestampUtc || metadata.date),
        latDeg: Number(metadata.latDeg),
        lonDeg: Number(metadata.lonDeg),
        altM: Number(metadata.altM || 0),
        optmod,
        optpar,
        maxMag: Number.isFinite(metadata.maxMag) ? metadata.maxMag : 5.1,
        matchRadiusPx: Number.isFinite(metadata.matchRadiusPx) ? metadata.matchRadiusPx : 22,
        detectorOptions: metadata.detectorOptions || DEFAULT_DETECTOR_OPTIONS,
    };
}

function brownConradyForwardNormalized(xn, yn, optpar) {
    const r2 = xn * xn + yn * yn;
    const r4 = r2 * r2;
    const r6 = r4 * r2;
    const k1 = optpar[7] || 0;
    const k2 = optpar[8] || 0;
    const k3 = optpar[9] || 0;
    const p1 = optpar[10] || 0;
    const p2 = optpar[11] || 0;
    const radial = 1 + k1 * r2 + k2 * r4 + k3 * r6;
    return {
        x: xn * radial + 2 * p1 * xn * yn + p2 * (r2 + 2 * xn * xn),
        y: yn * radial + p1 * (r2 + 2 * yn * yn) + 2 * p2 * xn * yn,
    };
}

function invertBrownConradyNormalized(xd, yd, optpar) {
    let xu = xd;
    let yu = yd;
    for (let iter = 0; iter < 12; iter += 1) {
        const f = brownConradyForwardNormalized(xu, yu, optpar);
        const ex = f.x - xd;
        const ey = f.y - yd;
        if (Math.hypot(ex, ey) < 1e-10) {
            break;
        }
        const eps = 1e-5;
        const fx = brownConradyForwardNormalized(xu + eps, yu, optpar);
        const fy = brownConradyForwardNormalized(xu, yu + eps, optpar);
        const j00 = (fx.x - f.x) / eps;
        const j10 = (fx.y - f.y) / eps;
        const j01 = (fy.x - f.x) / eps;
        const j11 = (fy.y - f.y) / eps;
        const det = j00 * j11 - j01 * j10;
        if (Math.abs(det) < 1e-12) {
            break;
        }
        const dx = (j11 * ex - j01 * ey) / det;
        const dy = (-j10 * ex + j00 * ey) / det;
        xu -= dx;
        yu -= dy;
        if (Math.hypot(dx, dy) < 1e-10) {
            break;
        }
    }
    return {x: xu, y: yu};
}

function undistortPixelToPlane(point, testCase, scale = Math.min(testCase.width, testCase.height) * 0.32, overrideOptpar = null) {
    const optpar = Array.isArray(overrideOptpar) ? overrideOptpar : testCase.optpar;
    const xd = (((point.x + 1) / testCase.width) - 0.5 - optpar[5]) / optpar[0];
    const yd = (((point.y + 1) / testCase.height) - 0.5 - optpar[6]) / optpar[1];
    const undistorted = invertBrownConradyNormalized(xd, yd, optpar);
    return {
        x: testCase.width * 0.5 + undistorted.x * scale,
        y: testCase.height * 0.5 + undistorted.y * scale,
        planeX: undistorted.x,
        planeY: undistorted.y,
    };
}

function undistortCollection(points, testCase, overrideOptpar = null) {
    return points.map(point => {
        const undistorted = undistortPixelToPlane(point, testCase, undefined, overrideOptpar);
        return {
            ...point,
            rawX: point.x,
            rawY: point.y,
            x: undistorted.x,
            y: undistorted.y,
            planeX: undistorted.planeX,
            planeY: undistorted.planeY,
        };
    });
}

function triangleRecords(points, options = {}) {
    const maxPoints = Number.isFinite(options.maxPoints) ? options.maxPoints : Math.min(points.length, 24);
    const maxTriangles = Number.isFinite(options.maxTriangles) ? options.maxTriangles : 120;
    const p = points.slice(0, maxPoints);
    const records = [];
    for (let i = 0; i < p.length - 2; i += 1) {
        for (let j = i + 1; j < p.length - 1; j += 1) {
            for (let k = j + 1; k < p.length; k += 1) {
                const a = p[i];
                const b = p[j];
                const c = p[k];
                const ab = Math.hypot(a.x - b.x, a.y - b.y);
                const bc = Math.hypot(b.x - c.x, b.y - c.y);
                const ca = Math.hypot(c.x - a.x, c.y - a.y);
                const longest = Math.max(ab, bc, ca);
                const shortest = Math.min(ab, bc, ca);
                const area2 = Math.abs(
                    (b.x - a.x) * (c.y - a.y) -
                    (b.y - a.y) * (c.x - a.x)
                );
                const height = longest > 0 ? area2 / longest : 0;
                if (shortest < 50 || longest > options.maxSidePx || height < 20) {
                    continue;
                }
                records.push({points: [a, b, c], rankScore: i + j + k, area2});
            }
        }
    }
    records.sort((a, b) => a.rankScore - b.rankScore || b.area2 - a.area2);
    return records.slice(0, maxTriangles);
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

function fmt(value, digits = 2) {
    return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

function scoreIdentificationByDetectionId(matches, validation) {
    const wrong = [];
    let correct = 0;
    let incorrect = 0;
    let unknown = 0;
    for (const match of matches) {
        const truthKey = validation.detectionToStar.get(match.detection.id);
        if (!truthKey) {
            unknown += 1;
        } else if (truthKey === match.star.key) {
            correct += 1;
        } else {
            incorrect += 1;
            wrong.push({
                detectionId: match.detection.id,
                identified: match.star.key,
                truth: truthKey,
            });
        }
    }
    return {total: matches.length, correct, incorrect, unknown, wrong};
}

function circle(point, radius, cls, title = "") {
    return `<circle class="${cls}" cx="${fmt(point.x)}" cy="${fmt(point.y)}" r="${fmt(radius)}">${title ? `<title>${escapeHtml(title)}</title>` : ""}</circle>`;
}

function rawPoint(point) {
    return {x: Number.isFinite(point.rawX) ? point.rawX : point.x, y: Number.isFinite(point.rawY) ? point.rawY : point.y};
}

function overlaySvg(result) {
    const items = [];
    for (const triangle of result.matchTriangles) {
        const p = triangle.points.map(rawPoint);
        items.push(`<path class="asterism" d="M ${fmt(p[0].x)} ${fmt(p[0].y)} L ${fmt(p[1].x)} ${fmt(p[1].y)} L ${fmt(p[2].x)} ${fmt(p[2].y)} Z"></path>`);
    }
    for (const star of result.catalogRaw) {
        items.push(circle(star, star.mag <= 3 ? 8 : star.mag <= 5 ? 5 : 3, "catalog", `${star.name || "star"} mag ${fmt(star.mag, 1)}`));
    }
    for (const detection of result.rawDetections) {
        items.push(circle(detection, 11, "detection"));
    }
    for (const match of result.identification.matches) {
        const truth = result.validation.detectionToStar.get(match.detection.id);
        const cls = truth === match.star.key ? "identified correct" : truth ? "identified wrong" : "identified unknown";
        items.push(circle(rawPoint(match.detection), 9, cls,
            `${match.star.name || "star"}; ${truth === match.star.key ? "correct" : "not oracle-confirmed"}`));
    }
    return `<svg class="overlay" viewBox="0 0 ${result.case.width} ${result.case.height}" preserveAspectRatio="none">${items.join("\n")}</svg>`;
}

function planeSvg(result) {
    const width = 720;
    const height = 540;
    const xs = result.catalogUndistorted.concat(result.undistortedDetections).map(p => p.x);
    const ys = result.catalogUndistorted.concat(result.undistortedDetections).map(p => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const pad = 28;
    const sx = x => pad + (x - minX) / Math.max(1, maxX - minX) * (width - 2 * pad);
    const sy = y => pad + (y - minY) / Math.max(1, maxY - minY) * (height - 2 * pad);
    const items = [];
    for (const triangle of result.matchTriangles) {
        const p = triangle.points;
        items.push(`<path class="asterism" d="M ${fmt(sx(p[0].x))} ${fmt(sy(p[0].y))} L ${fmt(sx(p[1].x))} ${fmt(sy(p[1].y))} L ${fmt(sx(p[2].x))} ${fmt(sy(p[2].y))} Z"></path>`);
    }
    for (const star of result.catalogUndistorted) {
        items.push(`<circle class="catalog" cx="${fmt(sx(star.x))}" cy="${fmt(sy(star.y))}" r="3"></circle>`);
    }
    for (const detection of result.undistortedDetections) {
        items.push(`<circle class="detection" cx="${fmt(sx(detection.x))}" cy="${fmt(sy(detection.y))}" r="2"></circle>`);
    }
    for (const match of result.identification.matches) {
        const p = match.detection;
        const truth = result.validation.detectionToStar.get(match.detection.id);
        const cls = truth === match.star.key ? "identified correct" : truth ? "identified wrong" : "identified unknown";
        items.push(`<circle class="${cls}" cx="${fmt(sx(p.x))}" cy="${fmt(sy(p.y))}" r="6"></circle>`);
    }
    return `<svg class="plane" viewBox="0 0 ${width} ${height}">${items.join("\n")}</svg>`;
}

function pageHtml(result) {
    const score = result.identificationScore;
    const imageName = path.basename(result.case.imagePath);
    const generated = new Date().toISOString();
    const command = "cd /Users/j/src/AIDA_tools/aida_js_calibrator && npm run report:img9953-asterisms";
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(result.case.id)} undistorted asterism report</title>
<style>
body { margin: 0; font: 15px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #17202a; background: #f5f7fa; }
main { max-width: 1180px; margin: 0 auto; padding: 24px; }
h1 { margin: 0 0 8px; font-size: 24px; }
.summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; margin: 18px 0; }
.metric { background: white; border: 1px solid #d9e1ea; border-radius: 8px; padding: 10px 12px; }
.metric b { display: block; font-size: 22px; }
.image-wrap { position: relative; background: #111; border: 1px solid #26313d; }
.image-wrap img { display: block; width: 100%; height: auto; }
.overlay { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.plane { width: 100%; max-width: 720px; background: white; border: 1px solid #d9e1ea; border-radius: 8px; }
.asterism { fill: rgba(0, 170, 255, 0.04); stroke: rgba(0, 170, 255, 0.55); stroke-width: 2; }
.catalog { fill: none; stroke: rgba(255, 60, 60, 0.75); stroke-width: 2; }
.detection { fill: none; stroke: rgba(255, 218, 67, 0.95); stroke-width: 4; }
.identified { fill: none; stroke-width: 4; }
.correct { stroke: #00c46a; }
.wrong { stroke: #ff3158; }
.unknown { stroke: #b04cff; }
code, pre { background: #eef2f7; border-radius: 5px; padding: 2px 4px; }
pre { padding: 12px; overflow-x: auto; }
.legend { display: flex; flex-wrap: wrap; gap: 14px; margin: 12px 0 18px; }
.swatch { display: inline-block; width: 14px; height: 14px; border-radius: 50%; vertical-align: -2px; margin-right: 5px; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(result.case.id)} Undistorted Asterism Report</h1>
<p>Generated ${escapeHtml(generated)}. The automatic star detections were pre-undistorted with the saved Brown-Conrady optpar before running the sky-plane asterism matcher.</p>
<section class="metric">
<h2>Repeat From Command Line</h2>
<pre><code>${escapeHtml(command)}</code></pre>
</section>
<div class="summary">
<div class="metric"><span>Detected stars</span><b>${result.rawDetections.length}</b></div>
<div class="metric"><span>Oracle detector hits</span><b>${result.validation.matches.length}</b></div>
<div class="metric"><span>Asterism inputs</span><b>${result.asterismRawDetections.length}</b></div>
<div class="metric"><span>Asterism IDs</span><b>${score.total}</b></div>
<div class="metric"><span>Correct IDs</span><b>${score.correct}</b></div>
<div class="metric"><span>Incorrect IDs</span><b>${score.incorrect}</b></div>
<div class="metric"><span>Unknown IDs</span><b>${score.unknown}</b></div>
</div>
<p><b>Status:</b> ${escapeHtml(result.identification.status)}</p>
<p><b>Triangle counts:</b> catalogue ${result.identification.catalogTriangleCount || 0}, image ${result.identification.detectionTriangleCount || 0}, scored transforms ${result.identification.scoredTransforms || 0}.</p>
<div class="legend">
<span><span class="swatch" style="background:#ffda43"></span>raw detections</span>
<span><span class="swatch" style="border:2px solid #ff3c3c"></span>catalogue stars</span>
<span><span class="swatch" style="border:3px solid #00c46a"></span>correct asterism IDs</span>
<span><span class="swatch" style="border:3px solid #ff3158"></span>wrong IDs</span>
<span><span class="swatch" style="border:3px solid #00aaff"></span>sampled matched-star asterisms</span>
</div>
<section class="image-wrap">
<img src="${escapeHtml(imageName)}" alt="${escapeHtml(result.case.id)}">
${overlaySvg(result)}
</section>
<h2>Undistorted Plane</h2>
${planeSvg(result)}
<h2>Details</h2>
<pre>${escapeHtml(JSON.stringify(result.summary, null, 2))}</pre>
</main>
</body>
</html>`;
}

async function runImg9953UndistortedAsterismCase(options = {}) {
    const caseDir = options.caseDir || DEFAULT_CASE_DIR;
    const outDir = options.outDir || DEFAULT_OUT_DIR;
    const testCase = normalizeSavedCase(caseDir);
    const maxMag = Number.isFinite(options.maxMag) ? options.maxMag : Math.max(DEFAULT_MAX_MAG, testCase.maxMag);
    const imageData = readPngImageData(testCase.imagePath);
    const detectorOptions = {...testCase.detectorOptions, ...(options.detectorOptions || {})};
    const detectionResult = await StarDetector.detectBrightStars(imageData, detectorOptions);
    const rawDetections = detectionResult.detections;
    const catalogRaw = projectStars(testCase, testCase.optpar, maxMag);
    const validation = knownLensValidationMap(rawDetections, catalogRaw, testCase.matchRadiusPx);
    const oracleDetectionIds = new Set(validation.matches.map(match => match.detection.id));
    const asterismRawDetections = options.useAllDetectionsForAsterism === true ?
        rawDetections :
        rawDetections.filter(detection => oracleDetectionIds.has(detection.id));
    const undistortOptpar = Array.isArray(options.undistortOptpar) ?
        options.undistortOptpar : testCase.optpar;
    const undistortedDetections = undistortCollection(asterismRawDetections, testCase, undistortOptpar);
    const catalogUndistorted = undistortCollection(catalogRaw, testCase, undistortOptpar);
    const identification = AutoIdentifier.identifyStarsByAsterisms(catalogUndistorted, undistortedDetections, {
        imageWidth: testCase.width,
        imageHeight: testCase.height,
        maxMagnitude: maxMag,
        maxDetections: detectorOptions.maxDetections,
        maxCatalogStars: Math.max(200, Math.min(600, catalogUndistorted.length)),
        maxDistancePx: Number.isFinite(options.maxDistancePx) ? options.maxDistancePx : 35,
        minMatches: Number.isFinite(options.minMatches) ? options.minMatches : 8,
        maxDetectionTriangleStars: Number.isFinite(options.maxDetectionTriangleStars) ?
            options.maxDetectionTriangleStars : 80,
        maxCatalogTriangleStars: Number.isFinite(options.maxCatalogTriangleStars) ?
            options.maxCatalogTriangleStars : 160,
        maxDetectionTriangles: Number.isFinite(options.maxDetectionTriangles) ?
            options.maxDetectionTriangles : 4000,
        maxCatalogTriangles: Number.isFinite(options.maxCatalogTriangles) ?
            options.maxCatalogTriangles : 30000,
        triangleSignatureRadius: Number.isFinite(options.triangleSignatureRadius) ?
            options.triangleSignatureRadius : 0.02,
        maxNeighborTriangles: Number.isFinite(options.maxNeighborTriangles) ?
            options.maxNeighborTriangles : 8,
        maxCandidateTransforms: Number.isFinite(options.maxCandidateTransforms) ?
            options.maxCandidateTransforms : 7000,
    });
    const identificationScore = scoreIdentificationByDetectionId(identification.matches, validation);
    const matchedDetections = identification.matches
        .map(match => match.detection)
        .sort((a, b) => (a.rank || 0) - (b.rank || 0));
    const matchTriangles = triangleRecords(matchedDetections, {
        maxPoints: Math.min(18, matchedDetections.length),
        maxTriangles: 90,
        maxSidePx: testCase.width * AutoIdentifier.N_MAX_ANGLE_IMAGE_WIDTH_FRACTION,
    });
    const summary = {
        image: path.relative(ROOT, testCase.imagePath),
        maxMag,
        detectorStatus: detectionResult.status,
        detectorOptions,
        detectedStars: rawDetections.length,
        oracleDetectorHits: validation.matches.length,
        asterismInputDetections: asterismRawDetections.length,
        asterismInput: options.useAllDetectionsForAsterism === true ?
            "all automatic detections" :
            "oracle-validated automatic detections",
        asterismIdentifiedStars: identificationScore.total,
        correctIdentifiedStars: identificationScore.correct,
        incorrectIdentifiedStars: identificationScore.incorrect,
        unknownIdentifiedStars: identificationScore.unknown,
        wrong: identificationScore.wrong,
        status: identification.status,
        catalogTriangleCount: identification.catalogTriangleCount || 0,
        detectionTriangleCount: identification.detectionTriangleCount || 0,
        scoredTransforms: identification.scoredTransforms || 0,
    };
    const result = {
        case: testCase,
        rawDetections,
        asterismRawDetections,
        detectionResult,
        catalogRaw,
        validation,
        undistortedDetections,
        catalogUndistorted,
        identification,
        identificationScore,
        matchTriangles,
        summary,
    };
    if (options.writeReport !== false) {
        fs.mkdirSync(outDir, {recursive: true});
        fs.copyFileSync(testCase.imagePath, path.join(outDir, path.basename(testCase.imagePath)));
        fs.writeFileSync(path.join(outDir, "index.html"), pageHtml(result));
        fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
    }
    return result;
}

async function main() {
    const result = await runImg9953UndistortedAsterismCase({writeReport: true});
    const score = result.identificationScore;
    console.log(`IMG_9953 detected stars: ${result.rawDetections.length}`);
    console.log(`IMG_9953 oracle detector hits: ${result.validation.matches.length}`);
    console.log(`IMG_9953 asterism IDs: ${score.total} (${score.correct} correct, ${score.incorrect} incorrect, ${score.unknown} unknown)`);
    console.log(`IMG_9953 status: ${result.identification.status}`);
    console.log(path.join(DEFAULT_OUT_DIR, "index.html"));
}

if (require.main === module) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}

module.exports = {
    runImg9953UndistortedAsterismCase,
    normalizeSavedCase,
    undistortPixelToPlane,
    undistortCollection,
};
