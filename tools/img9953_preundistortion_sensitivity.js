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
const {
    normalizeSavedCase,
    undistortCollection,
} = require("./img9953_undistorted_asterism_report.js");

const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "test-report", "img9953-preundistortion-sensitivity");
const CASE_DIR = path.join(ROOT, "test_cases", "IMG_9953");

const DETECTOR_OPTIONS = {
    maxDetections: 650,
    scanStep: 1,
    thresholdSigma: 1.5,
    localThresholdSigma: 1.5,
    requireGlobalThreshold: false,
    maxRadiusPx: 5,
    maxElongation: 4,
    suppressionRadiusPx: 10,
    crowdingRadiusPx: 36,
    maxCrowding: 7,
    crowdingScorePower: 1.25,
};
const MATCHER_OPTIONS = {
    maxDistancePx: 35,
    minMatches: 8,
    maxDetectionTriangleStars: 80,
    maxCatalogTriangleStars: 160,
    maxDetectionTriangles: 2600,
    maxCatalogTriangles: 16000,
    triangleSignatureRadius: 0.02,
    maxNeighborTriangles: 8,
    maxCandidateTransforms: 3000,
};

const MAX_MAG = 6.5;
const SWEEP_POINTS = 13;

const PARAMETERS = [
    {index: 0, name: "f1", label: "f1", mode: "relative", span: 0.85, unit: "fraction"},
    {index: 1, name: "f2", label: "f2", mode: "relative", span: 0.85, unit: "fraction"},
    {index: 5, name: "du", label: "du", mode: "absolute", span: 0.22, unit: "normalized image"},
    {index: 6, name: "dv", label: "dv", mode: "absolute", span: 0.22, unit: "normalized image"},
    {index: 7, name: "k1", label: "k1", mode: "absolute", span: 1.20, unit: "coefficient"},
    {index: 8, name: "k2", label: "k2", mode: "absolute", span: 2.40, unit: "coefficient"},
    {index: 10, name: "p1", label: "p1", mode: "absolute", span: 0.16, unit: "coefficient"},
    {index: 11, name: "p2", label: "p2", mode: "absolute", span: 0.16, unit: "coefficient"},
];

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, ch => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;",
    }[ch]));
}

function fmt(value, digits = 3) {
    return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

function commandSnippetHtml(command) {
    return `<section class="note">
<h2>Repeat From Command Line</h2>
<pre><code>${escapeHtml(command)}</code></pre>
</section>`;
}

function linspace(lo, hi, n) {
    if (n <= 1) {
        return [lo];
    }
    return Array.from({length: n}, (_, i) => lo + (hi - lo) * i / (n - 1));
}

function cloneOptpar(optpar) {
    return optpar.map(Number);
}

function perturbParameter(optpar, spec, delta) {
    const perturbed = cloneOptpar(optpar);
    if (spec.mode === "relative") {
        perturbed[spec.index] = optpar[spec.index] * (1 + delta);
    } else {
        perturbed[spec.index] = optpar[spec.index] + delta;
    }
    return perturbed;
}

function perturbZoom(optpar, z) {
    const perturbed = cloneOptpar(optpar);
    perturbed[0] = optpar[0] * z;
    perturbed[1] = optpar[1] * z;
    return perturbed;
}

function defaultBrownConradyOptpar(testCase) {
    return [
        1.0,
        testCase.width / Math.max(1, testCase.height),
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
    ];
}

function deltaForValue(optpar, spec, value) {
    if (spec.mode === "relative") {
        return value / optpar[spec.index] - 1;
    }
    return value - optpar[spec.index];
}

function sortedUniqueSweepValues(values) {
    const seen = new Set();
    return values
        .filter(value => Number.isFinite(value.delta) && Number.isFinite(value.value))
        .sort((a, b) => a.delta - b.delta)
        .filter(value => {
            const key = `${value.kind || "grid"}:${value.delta.toPrecision(12)}`;
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
}

function scoreIdentificationByDetectionId(matches, validation) {
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
        }
    }
    return {total: matches.length, correct, incorrect, unknown};
}

function evaluateAsterism(testCase, rawDetections, catalogRaw, validation, undistortOptpar) {
    const oracleDetectionIds = new Set(validation.matches.map(match => match.detection.id));
    const asterismRawDetections = rawDetections.filter(detection => oracleDetectionIds.has(detection.id));
    const undistortedDetections = undistortCollection(asterismRawDetections, testCase, undistortOptpar);
    const catalogUndistorted = undistortCollection(catalogRaw, testCase, undistortOptpar);
    const identification = AutoIdentifier.identifyStarsByAsterisms(catalogUndistorted, undistortedDetections, {
        imageWidth: testCase.width,
        imageHeight: testCase.height,
        maxMagnitude: MAX_MAG,
        maxDetections: DETECTOR_OPTIONS.maxDetections,
        maxCatalogStars: Math.max(200, Math.min(650, catalogUndistorted.length)),
        ...MATCHER_OPTIONS,
    });
    const score = scoreIdentificationByDetectionId(identification.matches, validation);
    return {
        ...score,
        medianDistance: identification.medianDistance,
        status: identification.status,
    };
}

async function buildSensitivityData() {
    const testCase = normalizeSavedCase(CASE_DIR);
    const imageData = readPngImageData(testCase.imagePath);
    const detectionResult = await StarDetector.detectBrightStars(imageData, DETECTOR_OPTIONS);
    const catalogRaw = projectStars(testCase, testCase.optpar, MAX_MAG);
    const validation = knownLensValidationMap(detectionResult.detections, catalogRaw, testCase.matchRadiusPx);
    const defaultOptpar = defaultBrownConradyOptpar(testCase);
    const baseline = evaluateAsterism(
        testCase,
        detectionResult.detections,
        catalogRaw,
        validation,
        testCase.optpar,
    );
    process.stderr.write("evaluating Brown-Conrady default optpar\n");
    const brownConradyDefault = evaluateAsterism(
        testCase,
        detectionResult.detections,
        catalogRaw,
        validation,
        defaultOptpar,
    );
    const sweeps = [];
    for (const spec of PARAMETERS) {
        process.stderr.write(`sweeping ${spec.label}\n`);
        const grid = linspace(-spec.span, spec.span, SWEEP_POINTS).map(delta => ({
            kind: "grid",
            delta,
            value: spec.mode === "relative" ?
                testCase.optpar[spec.index] * (1 + delta) :
                testCase.optpar[spec.index] + delta,
            ...evaluateAsterism(
                testCase,
                detectionResult.detections,
                catalogRaw,
                validation,
                perturbParameter(testCase.optpar, spec, delta),
            ),
        }));
        const defaultValue = defaultOptpar[spec.index];
        const defaultDelta = deltaForValue(testCase.optpar, spec, defaultValue);
        const defaultPoint = {
            kind: "default",
            delta: defaultDelta,
            value: defaultValue,
            ...evaluateAsterism(
                testCase,
                detectionResult.detections,
                catalogRaw,
                validation,
                perturbParameter(testCase.optpar, spec, defaultDelta),
            ),
        };
        const points = sortedUniqueSweepValues(grid.concat([defaultPoint]));
        sweeps.push({...spec, points});
    }
    process.stderr.write("sweeping common f1/f2 zoom\n");
    const zoomSweep = {
        name: "zoom",
        label: "common f1/f2 zoom",
        unit: "scale",
        mode: "absolute",
        points: linspace(0.20, 2.40, SWEEP_POINTS).map(z => ({
            delta: z - 1,
            value: z,
            ...evaluateAsterism(
                testCase,
                detectionResult.detections,
                catalogRaw,
                validation,
                perturbZoom(testCase.optpar, z),
            ),
        })),
    };
    return {
        testCase: {
            id: testCase.id,
            image: path.relative(ROOT, testCase.imagePath),
            width: testCase.width,
            height: testCase.height,
            optmod: testCase.optmod,
        },
        maxMag: MAX_MAG,
        detectorOptions: DETECTOR_OPTIONS,
        matcherOptions: MATCHER_OPTIONS,
        detectorStatus: detectionResult.status,
        rawDetections: detectionResult.detections.length,
        oracleDetectorHits: validation.matches.length,
        baseline,
        brownConradyDefault,
        brownConradyDefaultOptpar: defaultOptpar,
        sweeps,
        zoomSweep,
        generatedUtc: new Date().toISOString(),
    };
}

function toleranceText(sweep, baselineCorrect) {
    const threshold = baselineCorrect * 0.9;
    const ok = sweep.points.filter(point => point.correct >= threshold);
    if (!ok.length) {
        return "less than sampled spacing";
    }
    const lo = Math.min(...ok.map(point => point.delta));
    const hi = Math.max(...ok.map(point => point.delta));
    if (sweep.mode === "relative") {
        return `${fmt(100 * lo, 1)}% to ${fmt(100 * hi, 1)}%`;
    }
    return `${fmt(lo)} to ${fmt(hi)} ${sweep.unit}`;
}

function makeRecommendation(data) {
    const baseline = data.baseline.correct;
    const zoomOk = data.zoomSweep.points.filter(point => point.correct >= baseline * 0.9);
    const zoomLo = Math.min(...zoomOk.map(point => point.value));
    const zoomHi = Math.max(...zoomOk.map(point => point.value));
    const worst = data.sweeps
        .map(sweep => ({name: sweep.label, tolerance: toleranceText(sweep, baseline)}));
    return {
        baselineCorrect: baseline,
        zoomTolerance90Percent: `${fmt(zoomLo, 2)}x to ${fmt(zoomHi, 2)}x`,
        strategy: [
            "Use full-resolution star scanning for iPhone/Brown-Conrady images before drawing conclusions about the asterism matcher.",
            "For pre-undistortion, search a coarse common focal zoom grid first because triangle ratios are partly scale-invariant but pixel-side gates still matter.",
            "Keep f1/f2 aspect ratio close to the EXIF/image-width initialization; sweep common zoom more aggressively than differential f1-vs-f2 changes.",
            "Treat principal point offsets and low-order radial terms as the most important pre-flattening parameters after focal scale.",
            "Keep tangential coefficients p1 and p2 fixed at zero during blind pre-flattening and early fitting; only release them in the final pixel-space fit after robust star identities exist.",
        ],
        parameterTolerance90Percent: worst,
    };
}

function plotSvg(sweep, baselineCorrect) {
    const w = 520;
    const h = 320;
    const pad = 58;
    const xs = sweep.points.map(point => point.delta);
    const ys = sweep.points.map(point => point.correct);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const maxY = Math.max(baselineCorrect, ...ys, 1);
    const sx = x => pad + (x - minX) / Math.max(1e-12, maxX - minX) * (w - 2 * pad);
    const sy = y => h - pad - y / maxY * (h - 2 * pad);
    const d = sweep.points.map((point, index) =>
        `${index === 0 ? "M" : "L"} ${fmt(sx(point.delta), 1)} ${fmt(sy(point.correct), 1)}`
    ).join(" ");
    const pointSvg = sweep.points.map(point => {
        const cls = point.kind === "default" ? "point default-point" : "point";
        const r = point.kind === "default" ? 6 : 4;
        const title = point.kind === "default" ?
            `${sweep.label} Brown-Conrady default ${fmt(point.value)}: ${point.correct} correct` :
            `${sweep.label} ${fmt(point.value)}: ${point.correct} correct`;
        return `<circle class="${cls}" cx="${fmt(sx(point.delta), 1)}" cy="${fmt(sy(point.correct), 1)}" r="${r}"><title>${escapeHtml(title)}</title></circle>`;
    }).join("\n");
    const zero = minX <= 0 && maxX >= 0 ?
        `<line class="zero" x1="${fmt(sx(0), 1)}" y1="${pad}" x2="${fmt(sx(0), 1)}" y2="${h - pad}"></line>` :
        "";
    const thresholdY = sy(0.9 * baselineCorrect);
    const xLabel = sweep.name === "zoom" ? "zoom factor minus one" :
        sweep.mode === "relative" ? "relative perturbation" : "absolute perturbation";
    const actualLabel = sweep.name === "zoom" ? "actual common zoom factor" : `actual ${sweep.label} value`;
    const ticks = [minX, 0, maxX]
        .filter((value, index, arr) => Number.isFinite(value) && value >= minX && value <= maxX &&
            arr.findIndex(other => Math.abs(other - value) < 1e-10) === index);
    const actualValueForDelta = delta => {
        if (sweep.name === "zoom") {
            return 1 + delta;
        }
        if (sweep.mode === "relative") {
            const zeroPoint = sweep.points.find(point => Math.abs(point.delta) < 1e-10);
            const trueValue = zeroPoint ? zeroPoint.value : NaN;
            return Number.isFinite(trueValue) ? trueValue * (1 + delta) : NaN;
        }
        const zeroPoint = sweep.points.find(point => Math.abs(point.delta) < 1e-10);
        const trueValue = zeroPoint ? zeroPoint.value : NaN;
        return Number.isFinite(trueValue) ? trueValue + delta : NaN;
    };
    const bottomTicks = ticks.map(value =>
        `<text class="tick" x="${fmt(sx(value), 1)}" y="${h - pad + 16}" text-anchor="middle">${fmt(value, 2)}</text>`
    ).join("\n");
    const topTicks = ticks.map(value =>
        `<text class="tick top-tick" x="${fmt(sx(value), 1)}" y="${pad - 12}" text-anchor="middle">${fmt(actualValueForDelta(value), 3)}</text>`
    ).join("\n");
    const defaultLines = sweep.points
        .filter(point => point.kind === "default")
        .map(point => `<line class="default-line" x1="${fmt(sx(point.delta), 1)}" y1="${pad}" x2="${fmt(sx(point.delta), 1)}" y2="${h - pad}"></line>`)
        .join("\n");
    return `<svg class="plot" viewBox="0 0 ${w} ${h}">
        <rect class="plot-bg" x="0" y="0" width="${w}" height="${h}"></rect>
        <rect class="frame" x="${pad}" y="${pad}" width="${w - 2 * pad}" height="${h - 2 * pad}"></rect>
        ${zero}
        ${defaultLines}
        <line class="threshold" x1="${pad}" y1="${fmt(thresholdY, 1)}" x2="${w - pad}" y2="${fmt(thresholdY, 1)}"></line>
        <path class="line" d="${d}"></path>
        ${pointSvg}
        <text class="title" x="${w / 2}" y="20" text-anchor="middle">${escapeHtml(sweep.label)}</text>
        <text class="axis" x="${w / 2}" y="${h - 10}" text-anchor="middle">${escapeHtml(xLabel)}</text>
        <text class="axis" x="${w / 2}" y="${pad - 28}" text-anchor="middle">${escapeHtml(actualLabel)}</text>
        <text class="axis" x="14" y="${h / 2}" text-anchor="middle" transform="rotate(-90 14 ${h / 2})">correct matches</text>
        ${bottomTicks}
        ${topTicks}
        <text class="tick" x="${pad - 8}" y="${fmt(sy(maxY), 1)}" text-anchor="end">${Math.round(maxY)}</text>
        <text class="tick" x="${pad - 8}" y="${fmt(sy(0), 1)}" text-anchor="end">0</text>
    </svg>`;
}

function processingStepsHtml(data) {
    const matcherOptions = {
        ...data.matcherOptions,
        maxMagnitude: data.maxMag,
        maxDetections: data.detectorOptions.maxDetections,
        maxCatalogStars: "clamped to 200..650 from the perturbed catalog",
    };
    return `<section class="note">
<h2>Processing Steps Per Point</h2>
<p><b>Important:</b> this is a sensitivity diagnostic, not a full blind lucky run. It intentionally removes most false detections before the sweep so that the plot isolates how the asterism matcher responds to pre-undistortion errors.</p>
<ol>
<li>Load the saved PNG test image and run the automatic star detector once with the detector options below.</li>
<li>Project the Yale catalogue through the saved calibrated Brown-Conrady optpar. This creates the reference catalogue positions for the test case.</li>
<li>Build an oracle validation map by matching automatic detections to those saved-calibration catalogue positions within the case match radius.</li>
<li>For every sweep point, keep only automatic detections that were oracle-validated in step 3. This means the sweep is not measuring false-positive rejection.</li>
<li>Pre-undistort both the oracle-validated detections and the catalogue positions with the perturbed optpar for that sweep point.</li>
<li>Run <code>identifyStarsByAsterisms</code> on those pre-undistorted positions using the matcher options below.</li>
<li>Score the returned matches against the oracle validation map as correct, incorrect, or unknown.</li>
</ol>
<p>The plots can therefore look better than a real GUI run if the live star finder produces many false positives, misses the useful stars, or if the initial blind optpar is much worse than the tested perturbation grid.</p>
<h3>Detector options</h3>
<pre>${escapeHtml(JSON.stringify(data.detectorOptions, null, 2))}</pre>
<h3>Asterism matcher options</h3>
<pre>${escapeHtml(JSON.stringify(matcherOptions, null, 2))}</pre>
</section>`;
}

function pageHtml(data) {
    const recommendation = makeRecommendation(data);
    const allSweeps = data.sweeps.concat([data.zoomSweep]);
    const plots = allSweeps.map(sweep => `<section class="card">${plotSvg(sweep, data.baseline.correct)}
        <p><b>90% basin:</b> ${escapeHtml(toleranceText(sweep, data.baseline.correct))}</p>
    </section>`).join("\n");
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>IMG_9953 Pre-Undistortion Sensitivity</title>
<style>
body { margin: 0; background: #f5f7fa; color: #17202a; font: 15px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { max-width: 1180px; margin: 0 auto; padding: 24px; }
h1 { margin: 0 0 8px; font-size: 24px; }
.metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; margin: 18px 0; }
.metric, .card, .note { background: white; border: 1px solid #d9e1ea; border-radius: 8px; padding: 12px; }
.metric b { display: block; font-size: 24px; }
.plots { display: grid; grid-template-columns: repeat(auto-fit, minmax(470px, 1fr)); gap: 14px; }
.plot { width: 100%; height: auto; }
.plot-bg { fill: #fff; }
.frame { fill: none; stroke: #cbd5df; }
.line { fill: none; stroke: #1565c0; stroke-width: 3; }
.point { fill: #1565c0; stroke: white; stroke-width: 1; }
.default-point { fill: #f9a825; stroke: #3c2a00; stroke-width: 1.5; }
.zero { stroke: #8794a3; stroke-dasharray: 4 4; }
.default-line { stroke: #f9a825; stroke-dasharray: 3 5; }
.threshold { stroke: #c62828; stroke-dasharray: 5 5; }
.title { font-weight: 700; font-size: 16px; }
.axis, .tick { fill: #46515f; font-size: 12px; }
.top-tick { fill: #6a4a00; }
pre { background: #eef2f7; border-radius: 6px; padding: 12px; overflow-x: auto; }
</style>
</head>
<body>
<main>
<h1>IMG_9953 Pre-Undistortion Sensitivity</h1>
<p>This report perturbs the pre-undistortion lens parameters around the saved Brown-Conrady calibration, then reruns the asterism matcher on the same oracle-validated automatic detections.</p>
${commandSnippetHtml("cd /Users/j/src/AIDA_tools/aida_js_calibrator && npm run report:img9953-sensitivity")}
<div class="metrics">
<div class="metric"><span>Baseline correct matches</span><b>${data.baseline.correct}</b></div>
<div class="metric"><span>Default BC matches</span><b>${data.brownConradyDefault.correct}</b></div>
<div class="metric"><span>Oracle detector hits</span><b>${data.oracleDetectorHits}</b></div>
<div class="metric"><span>Raw detections</span><b>${data.rawDetections}</b></div>
<div class="metric"><span>Max magnitude</span><b>${fmt(data.maxMag, 1)}</b></div>
</div>
<section class="note">
<h2>Recommendation</h2>
<p><b>Common zoom 90% basin:</b> ${escapeHtml(recommendation.zoomTolerance90Percent)}.</p>
<p>Gold markers show the app's Brown-Conrady default parameter value for each one-parameter sweep.</p>
<ul>${recommendation.strategy.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
</section>
${processingStepsHtml(data)}
<section class="plots">${plots}</section>
<h2>Summary JSON</h2>
<pre>${escapeHtml(JSON.stringify({recommendation, detectorStatus: data.detectorStatus}, null, 2))}</pre>
</main>
</body>
</html>`;
}

async function main() {
    fs.mkdirSync(OUT_DIR, {recursive: true});
    const data = await buildSensitivityData();
    const recommendation = makeRecommendation(data);
    fs.writeFileSync(path.join(OUT_DIR, "summary.json"), JSON.stringify({recommendation, ...data}, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, "index.html"), pageHtml(data));
    console.log(`baseline correct matches: ${data.baseline.correct}`);
    console.log(`zoom 90% basin: ${recommendation.zoomTolerance90Percent}`);
    console.log(path.join(OUT_DIR, "index.html"));
}

if (require.main === module) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}

module.exports = {
    buildSensitivityData,
};
