#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");

const StarDetector = require("../js/star_detector.js");
const {
    knownLensValidationMap,
    projectStars,
    readPngImageData,
} = require("./generate_test_report.js");
const {
    normalizeSavedCase,
} = require("./img9953_undistorted_asterism_report.js");

const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "test-report", "star-detector-oracle");
const PYTHON = fs.existsSync(path.join(ROOT, ".venv", "bin", "python"))
    ? path.join(ROOT, ".venv", "bin", "python")
    : "python3";

const ALLSKY_CASE = {
    id: "allsky010031-ams0221",
    title: "Allsky 010031 AMS0221",
    image: "2025_02_19_03_46_01_000_010031_ams0221_first1s.png",
    imagePath: path.join(ROOT, "calibration_images", "2025_02_19_03_46_01_000_010031_ams0221_first1s.png"),
    width: 1920,
    height: 1080,
    date: new Date("2025-02-19T03:46:01.000Z"),
    latDeg: 52.208700,
    lonDeg: 14.121500,
    altM: 56.0,
    optmod: 2,
    optpar: [
        0.789796553852,
        1.40015321373,
        -67.3425021144,
        10.9882272129,
        84.8281249152,
        0.0181070490333,
        -0.00554827918225,
        0.889505824512,
    ],
    maxMag: 6.5,
    matchRadiusPx: 18,
};

const CASES = [
    {
        ...normalizeSavedCase(path.join(ROOT, "test_cases", "IMG_9953")),
        title: "IMG_9953 phone Brown-Conrady",
        maxMag: 6.5,
        matchRadiusPx: 22,
        detectorOptions: {
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
        },
    },
    {
        ...ALLSKY_CASE,
        detectorOptions: {
            maxDetections: 120,
            thresholdSigma: 3.1,
            localThresholdSigma: 3.2,
            requireGlobalThreshold: false,
            maxElongation: 3.1,
        },
    },
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

function htmlPath(filename) {
    return filename.replace(/\\/g, "/");
}

function commandSnippetHtml(command) {
    return `<section class="case">
<h2>Repeat From Command Line</h2>
<pre><code>${escapeHtml(command)}</code></pre>
</section>`;
}

function circleSvg(x, y, r, cls, title = "") {
    return `<circle class="${cls}" cx="${fmt(x, 2)}" cy="${fmt(y, 2)}" r="${fmt(r, 2)}">${title ? `<title>${escapeHtml(title)}</title>` : ""}</circle>`;
}

function detectionOracleMetrics(detections, catalog, matchRadiusPx) {
    const validation = knownLensValidationMap(detections, catalog, matchRadiusPx);
    const correct = validation.matches.length;
    const selected = detections.length;
    const truth = catalog.length;
    const falsePositive = Math.max(0, selected - correct);
    const missed = Math.max(0, truth - correct);
    const precision = selected > 0 ? correct / selected : 0;
    const recall = truth > 0 ? correct / truth : 0;
    const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
    const distances = validation.matches.map(match => match.distance).sort((a, b) => a - b);
    const percentile = p => distances.length ?
        distances[Math.min(distances.length - 1, Math.floor(p * (distances.length - 1)))] :
        NaN;
    return {
        selected,
        truth,
        correct,
        falsePositive,
        missed,
        precision,
        recall,
        f1,
        medianDistancePx: percentile(0.5),
        p95DistancePx: percentile(0.95),
        validation,
    };
}

function runPythonSepDetector(testCase, options) {
    const args = [
        path.join(ROOT, "tools", "python_sep_detector.py"),
        testCase.imagePath,
        "--threshold", String(options.threshold || 1.5),
        "--max-detections", String(options.maxDetections || testCase.detectorOptions.maxDetections),
        "--min-area", String(options.minArea || 1),
        "--filter-type", options.filterType || "matched",
        "--deblend-cont", String(options.deblendCont ?? 0.005),
        "--bw", String(options.bw || 64),
        "--bh", String(options.bh || 64),
        "--fw", String(options.fw || 3),
        "--fh", String(options.fh || 3),
    ];
    if (Array.isArray(options.sweep) && options.sweep.length) {
        args.push("--sweep-json", JSON.stringify(options.sweep));
    }
    const child = childProcess.spawnSync(PYTHON, args, {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
    });
    if (child.error || child.status !== 0) {
        const reason = child.error ? child.error.message : child.stderr.trim();
        return {
            name: "Python SEP unavailable",
            note: "Could not run the real Python SEP package.",
            options,
            elapsedMs: 0,
            status: reason,
            rejectCounts: {},
            backgroundMeshSize: null,
            candidates: 0,
            detections: [],
            sepSweep: [],
            unavailable: true,
        };
    }
    return JSON.parse(child.stdout);
}

function sepOptionGrid(testCase) {
    const maxDetections = testCase.detectorOptions.maxDetections;
    const thresholds = testCase.id === "allsky010031-ams0221"
        ? [1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0]
        : [8.0, 10.0, 12.0, 15.0];
    const minAreas = testCase.id === "allsky010031-ams0221" ? [1, 2, 3] : [2, 3];
    const variants = [];
    for (const threshold of thresholds) {
        for (const minArea of minAreas) {
            variants.push({
                threshold,
                minArea,
                maxDetections,
                filterType: "matched",
                deblendCont: 0.005,
            });
        }
    }
    return variants;
}

function sepResultSortKey(result) {
    return [
        result.metrics.f1,
        result.metrics.correct,
        result.metrics.precision,
        -result.metrics.falsePositive,
    ];
}

function compareSortKey(a, b) {
    const ak = sepResultSortKey(a);
    const bk = sepResultSortKey(b);
    for (let i = 0; i < ak.length; i += 1) {
        if (ak[i] !== bk[i]) {
            return bk[i] - ak[i];
        }
    }
    return 0;
}

function pythonSepOracleSweep(testCase, catalog) {
    const grid = sepOptionGrid(testCase);
    const sepBatch = runPythonSepDetector(testCase, {sweep: grid});
    const sweep = (sepBatch.results || [sepBatch]).map((sepResult, index) => {
        const detections = sepResult.detections || [];
        const metrics = detectionOracleMetrics(detections, catalog, testCase.matchRadiusPx);
        return {
            ...sepResult,
            elapsedMs: index === 0 ? sepBatch.elapsedMs : 0,
            options: sepResult.options || grid[index],
            detections,
            metrics,
        };
    });
    sweep.sort(compareSortKey);
    const best = sweep[0];
    return {
        name: "real Python SEP best oracle sweep",
        note: "Offline report-only comparison using Python sep.Background + sep.extract. The browser GUI does not and should not use Python SEP. The listed threshold/minarea is selected by oracle F1 over a small automatic sweep, so this is an optimistic upper bound for SEP on this image.",
        options: best.options,
        elapsedMs: sweep.reduce((sum, item) => sum + (item.elapsedMs || 0), 0),
        status: `${best.status}; best of ${sweep.length} SEP settings by oracle F1`,
        rejectCounts: {},
        backgroundMeshSize: null,
        candidates: best.objectCount || best.detections.length,
        detections: best.detections,
        sepSweep: sweep.map(item => ({
            threshold: item.options.threshold,
            minArea: item.options.min_area || item.options.minArea,
            filterType: item.options.filter_type || item.options.filterType,
            objectCount: item.objectCount,
            correct: item.metrics.correct,
            selected: item.metrics.selected,
            falsePositive: item.metrics.falsePositive,
            precision: item.metrics.precision,
            recall: item.metrics.recall,
            f1: item.metrics.f1,
            elapsedMs: item.elapsedMs,
        })),
        metrics: best.metrics,
    };
}

async function analyzeCase(testCase) {
    const imageData = readPngImageData(testCase.imagePath);
    const catalog = projectStars(testCase, testCase.optpar, testCase.maxMag);
    const variants = [
        {
            name: "automatic matched-filter",
            note: "Current automatic detector: local annulus background plus compact SEP-style matched-filter scoring.",
            options: {
                ...testCase.detectorOptions,
            },
        },
        {
            name: "mesh background diagnostic",
            note: "Optional SEP-style spatial mesh background/RMS, retained as a diagnostic because it can help some images but is not always better.",
            options: {
                ...testCase.detectorOptions,
                useSpatialBackground: true,
            },
        },
    ];
    const results = [];
    for (const variant of variants) {
        const t0 = Date.now();
        const detectionResult = await StarDetector.detectBrightStars(imageData, variant.options);
        const elapsedMs = Date.now() - t0;
        const metrics = detectionOracleMetrics(detectionResult.detections, catalog, testCase.matchRadiusPx);
        results.push({
            ...variant,
            elapsedMs,
            status: detectionResult.status,
            rejectCounts: detectionResult.rejectCounts,
            backgroundMeshSize: detectionResult.backgroundMeshSize,
            candidates: detectionResult.candidates.length,
            detections: detectionResult.detections,
            metrics,
        });
    }
    results.push(pythonSepOracleSweep(testCase, catalog));
    return {
        id: testCase.id,
        title: testCase.title,
        image: htmlPath(path.relative(ROOT, testCase.imagePath)),
        imageSrc: htmlPath(path.relative(OUT_DIR, testCase.imagePath)),
        width: testCase.width,
        height: testCase.height,
        maxMag: testCase.maxMag,
        matchRadiusPx: testCase.matchRadiusPx,
        catalogStars: catalog.length,
        results,
    };
}

function metricTable(result) {
    return `<table>
<thead><tr><th>variant</th><th>correct</th><th>false +</th><th>missed</th><th>precision</th><th>recall</th><th>F1</th><th>time</th></tr></thead>
<tbody>${result.results.map(item => `<tr>
<td>${escapeHtml(item.name)}</td>
<td>${item.metrics.correct}/${item.metrics.selected}</td>
<td>${item.metrics.falsePositive}</td>
<td>${item.metrics.missed}</td>
<td>${fmt(100 * item.metrics.precision, 1)}%</td>
<td>${fmt(100 * item.metrics.recall, 1)}%</td>
<td>${fmt(item.metrics.f1, 3)}</td>
<td>${item.elapsedMs} ms</td>
</tr>`).join("")}</tbody>
</table>`;
}

function detectorOverlaySvg(result, item) {
    const matchedDetectionIds = new Set(item.metrics.validation.matches.map(match => match.detection.id));
    const matchedStarKeys = new Set(item.metrics.validation.matches.map(match => match.star.key));
    const catalog = item.metrics.validation.knownStars || [];
    const items = [];
    for (const star of catalog) {
        const cls = matchedStarKeys.has(star.key) ? "catalog catalog-hit" : "catalog catalog-missed";
        const radius = star.mag <= 2.5 ? 8 : star.mag <= 4.5 ? 6 : 4;
        items.push(circleSvg(star.x, star.y, radius, cls,
            `${star.name || "catalog star"} mag ${fmt(star.mag, 1)}${matchedStarKeys.has(star.key) ? " matched" : " missed"}`));
    }
    for (const detection of item.detections) {
        const matched = matchedDetectionIds.has(detection.id);
        const cls = matched ? "detection detection-correct" : "detection detection-false";
        const title = matched
            ? `correct detection; local SNR ${fmt(detection.localSnr, 1)}, score ${fmt(detection.score, 1)}`
            : `false positive; local SNR ${fmt(detection.localSnr, 1)}, score ${fmt(detection.score, 1)}`;
        items.push(circleSvg(detection.x, detection.y, matched ? 12 : 9, cls, title));
    }
    for (const match of item.metrics.validation.matches) {
        items.push(`<line class="match-line" x1="${fmt(match.detection.x, 2)}" y1="${fmt(match.detection.y, 2)}" x2="${fmt(match.star.x, 2)}" y2="${fmt(match.star.y, 2)}"></line>`);
    }
    return `<svg class="overlay" viewBox="0 0 ${result.width} ${result.height}" preserveAspectRatio="none">${items.join("\n")}</svg>`;
}

function detectorStageHtml(result, item) {
    return `<figure class="stage">
<img src="${escapeHtml(result.imageSrc)}" alt="${escapeHtml(result.title)}">
${detectorOverlaySvg(result, item)}
</figure>
<p class="legend">
<span class="swatch catalog-swatch"></span>catalogue truth
<span class="swatch hit-swatch"></span>correct detector hits
<span class="swatch false-swatch"></span>false positives
<span class="swatch missed-swatch"></span>missed catalogue stars
</p>`;
}

function pageHtml(results) {
    const generated = new Date().toISOString();
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Star Detector Oracle Report</title>
<style>
body { margin: 0; background: #f5f7fa; color: #17202a; font: 15px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { max-width: 1160px; margin: 0 auto; padding: 24px; }
h1 { margin: 0 0 8px; font-size: 24px; }
.case { background: white; border: 1px solid #d9e1ea; border-radius: 8px; padding: 16px; margin: 18px 0; }
table { border-collapse: collapse; width: 100%; margin: 10px 0; }
th, td { border-bottom: 1px solid #e2e8f0; padding: 6px 8px; text-align: right; }
th:first-child, td:first-child { text-align: left; }
pre { background: #eef2f7; border-radius: 6px; padding: 10px; overflow-x: auto; }
.note { color: #46515f; }
.stage { position: relative; margin: 12px 0 6px; width: 100%; background: #111820; border: 1px solid #202b38; border-radius: 6px; overflow: hidden; }
.stage img, .stage svg { display: block; width: 100%; height: auto; }
.stage svg { position: absolute; inset: 0; pointer-events: none; }
.catalog { fill: none; stroke: rgba(255, 55, 55, 0.95); stroke-width: 2.5; vector-effect: non-scaling-stroke; }
.catalog-hit { stroke: rgba(255, 80, 80, 0.72); }
.catalog-missed { stroke: rgba(255, 40, 40, 0.95); stroke-dasharray: 5 4; }
.detection { fill: none; stroke-width: 3.5; vector-effect: non-scaling-stroke; }
.detection-correct { stroke: rgba(20, 235, 120, 0.98); }
.detection-false { stroke: rgba(255, 230, 0, 0.98); }
.match-line { stroke: rgba(40, 220, 255, 0.55); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.legend { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin: 4px 0 14px; color: #46515f; font-size: 13px; }
.swatch { display: inline-block; width: 16px; height: 10px; border-radius: 2px; margin-right: -6px; border: 2px solid currentColor; }
.catalog-swatch { color: rgb(255, 55, 55); background: transparent; }
.hit-swatch { color: rgb(20, 235, 120); background: transparent; }
.false-swatch { color: rgb(255, 230, 0); background: transparent; }
.missed-swatch { color: rgb(255, 55, 55); border-style: dashed; background: transparent; }
</style>
</head>
<body>
<main>
<h1>Star Detector Oracle Report</h1>
<p class="note">Generated ${escapeHtml(generated)}. A known lens model and Yale catalogue act as the oracle: detections within the case match radius of projected catalogue stars count as correct. This evaluates the detector only, before any asterism identification.</p>
${commandSnippetHtml("cd /Users/j/src/AIDA_tools/aida_js_calibrator && npm run report:star-detector-oracle")}
${results.map(result => `<section class="case">
<h2>${escapeHtml(result.title)}</h2>
<p>${escapeHtml(result.image)}; ${result.catalogStars} catalogue stars to mag ${fmt(result.maxMag, 1)}; match radius ${result.matchRadiusPx} px.</p>
${metricTable(result)}
${result.results.map(item => `<h3>${escapeHtml(item.name)}</h3>
<p>${escapeHtml(item.note)}</p>
<p>${escapeHtml(item.status)}</p>
${detectorStageHtml(result, item)}
<pre>${escapeHtml(JSON.stringify({
    options: item.options,
    rejectCounts: item.rejectCounts,
    sepSweep: item.sepSweep,
    metrics: {
        correct: item.metrics.correct,
        selected: item.metrics.selected,
        falsePositive: item.metrics.falsePositive,
        missed: item.metrics.missed,
        precision: item.metrics.precision,
        recall: item.metrics.recall,
        f1: item.metrics.f1,
    },
}, null, 2))}</pre>`).join("")}
</section>`).join("")}
</main>
</body>
</html>`;
}

async function buildStarDetectorOracleReport() {
    const results = [];
    for (const testCase of CASES) {
        process.stderr.write(`oracle-scoring ${testCase.title}\n`);
        results.push(await analyzeCase(testCase));
    }
    return {
        generatedUtc: new Date().toISOString(),
        results,
    };
}

async function main() {
    fs.mkdirSync(OUT_DIR, {recursive: true});
    const report = await buildStarDetectorOracleReport();
    fs.writeFileSync(path.join(OUT_DIR, "summary.json"), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, "index.html"), pageHtml(report.results));
    for (const result of report.results) {
        const best = result.results[0];
        console.log(`${result.title}: ${best.metrics.correct}/${best.metrics.selected} correct, ` +
            `precision ${fmt(100 * best.metrics.precision, 1)}%, recall ${fmt(100 * best.metrics.recall, 1)}%`);
    }
    console.log(path.join(OUT_DIR, "index.html"));
}

if (require.main === module) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}

module.exports = {
    analyzeCase,
    buildStarDetectorOracleReport,
    detectionOracleMetrics,
};
