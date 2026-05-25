#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const StarDetector = require("../js/star_detector.js");
const StarPatchNN = require("../js/star_patch_nn.js");
const {
    buildCases,
    knownLensValidationMap,
    projectStars,
    readPngImageData,
    testCaseImagePath,
} = require("./generate_test_report.js");

const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "test-report", "star-patch-nn");
const MODEL_FILE = path.join(OUT_DIR, "star_patch_nn_model.json");
const NO_STAR_MAG = StarPatchNN.NO_STAR_MAG;
const MAG_SCALE = StarPatchNN.MAG_SCALE;
const EPOCHS = 28;
const HIDDEN = 24;
const LEARNING_RATE = 0.010;
const MAG_LOSS_WEIGHT = 0.35;

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

function mulberry32(seed) {
    let state = seed >>> 0;
    return () => {
        state += 0x6D2B79F5;
        let t = state;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

function shuffle(items, rand) {
    for (let i = items.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rand() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
}

function nearestCatalogStar(point, catalog) {
    let best = null;
    let bestDistance = Infinity;
    for (const star of catalog) {
        const distance = Math.hypot(point.x - star.x, point.y - star.y);
        if (distance < bestDistance) {
            best = star;
            bestDistance = distance;
        }
    }
    return best ? {star: best, distance: bestDistance} : null;
}

function syntheticDetection(x, y) {
    return {
        x,
        y,
        localSnr: 0,
        globalSnr: 0,
        matchedFilterSnr: 0,
        flux: 0,
        peakContrast: 0,
        radius: 0,
        elongation: 1,
        coreFluxFraction: 0,
        outerFluxFraction: 0,
        peakDominance: 0,
        centroidOffset: 0,
        localCrowding: 0,
    };
}

function sampleFromPoint(testCase, imageData, catalog, point, detection, source, targetMag) {
    const features = StarPatchNN.featureVector(imageData, point.x, point.y, detection || syntheticDetection(point.x, point.y));
    return {
        caseId: testCase.id,
        source,
        x: point.x,
        y: point.y,
        targetMag,
        isStar: targetMag < 20,
        features,
    };
}

function randomNegativeSamples(testCase, imageData, catalog, count, rand) {
    const samples = [];
    const minDistance = Math.max(26, 1.5 * (testCase.matchRadiusPx || 18));
    let attempts = 0;
    while (samples.length < count && attempts < count * 80) {
        attempts += 1;
        const point = {
            x: 8 + rand() * Math.max(1, imageData.width - 16),
            y: 8 + rand() * Math.max(1, imageData.height - 16),
        };
        const nearest = nearestCatalogStar(point, catalog);
        if (!nearest || nearest.distance > minDistance) {
            samples.push(sampleFromPoint(testCase, imageData, catalog, point, null, "random-negative", NO_STAR_MAG));
        }
    }
    return samples;
}

async function caseSamples(testCase, caseIndex) {
    const imagePath = testCaseImagePath(testCase);
    const imageData = readPngImageData(imagePath);
    const catalog = projectStars(testCase, testCase.optpar, Math.max(6.5, testCase.maxMag || 6.5));
    const detectorOptions = {
        ...(testCase.detectorOptions || {}),
        maxDetections: Math.max(700, (testCase.detectorOptions && testCase.detectorOptions.maxDetections) || 180),
        thresholdSigma: Math.min(1.8, Number(testCase.detectorOptions && testCase.detectorOptions.thresholdSigma) || 1.8),
        localThresholdSigma: Math.min(1.8, Number(testCase.detectorOptions && testCase.detectorOptions.localThresholdSigma) || 1.8),
        requireGlobalThreshold: false,
        maxRadiusPx: 5,
        maxElongation: 4.2,
        suppressionRadiusPx: 6,
        crowdingRadiusPx: 0,
    };
    const detectionResult = await StarDetector.detectBrightStars(imageData, detectorOptions);
    const samples = [];
    const candidates = detectionResult.candidates.slice(0, 1800);
    const matchRadius = testCase.matchRadiusPx || 18;
    for (const candidate of candidates) {
        const nearest = nearestCatalogStar(candidate, catalog);
        const targetMag = nearest && nearest.distance <= matchRadius ? nearest.star.mag : NO_STAR_MAG;
        samples.push(sampleFromPoint(testCase, imageData, catalog, candidate, candidate, "detector-candidate", targetMag));
    }
    const rand = mulberry32(0xA15A0000 + caseIndex);
    for (const star of catalog) {
        if (star.mag <= Math.max(6.5, testCase.maxMag || 6.5)) {
            samples.push(sampleFromPoint(testCase, imageData, catalog, star, null, "catalog-positive", star.mag));
        }
    }
    const positives = samples.filter(sample => sample.isStar).length;
    samples.push(...randomNegativeSamples(testCase, imageData, catalog, Math.min(positives * 2, 900), rand));
    const maxDetections = Math.max(40, Math.min(700, detectorOptions.maxDetections));
    return {
        testCase,
        imageData,
        catalog,
        detectionResult,
        samples,
        maxDetections,
        matchRadius,
    };
}

function initModel(input, hidden, rand) {
    const scale1 = Math.sqrt(2 / input);
    const scale2 = Math.sqrt(2 / hidden);
    return {
        version: 1,
        kind: "aida-star-patch-mlp",
        target: "two headed: star probability and visual magnitude",
        input,
        hidden,
        noStarMagnitude: NO_STAR_MAG,
        magnitudeScale: MAG_SCALE,
        patchRadius: StarPatchNN.PATCH_RADIUS,
        w1: Array.from({length: input * hidden}, () => (rand() * 2 - 1) * scale1),
        b1: Array.from({length: hidden}, () => 0),
        wClass: Array.from({length: hidden}, () => (rand() * 2 - 1) * scale2),
        bClass: 0,
        wMag: Array.from({length: hidden}, () => (rand() * 2 - 1) * scale2),
        bMag: 0,
    };
}

function sigmoid(x) {
    if (x < -40) {
        return 0;
    }
    if (x > 40) {
        return 1;
    }
    return 1 / (1 + Math.exp(-x));
}

function sampleTargetAndWeight(sample) {
    const classTarget = sample.isStar ? 1 : 0;
    const magTarget = Math.max(0, Math.min(1, sample.targetMag / MAG_SCALE));
    const starWeight = sample.isStar ? 8 + Math.max(0, 7 - sample.targetMag) : 1;
    const sourceWeight = sample.source === "catalog-positive" ? 0.7 : 1;
    return {classTarget, magTarget, weight: starWeight * sourceWeight};
}

function forwardModel(model, features) {
    const x = features;
    const hidden = new Array(model.hidden);
    for (let h = 0; h < model.hidden; h += 1) {
        let sum = model.b1[h];
        const row = h * model.input;
        for (let i = 0; i < model.input; i += 1) {
            sum += model.w1[row + i] * x[i];
        }
        hidden[h] = Math.tanh(sum);
    }
    let classLogit = model.bClass;
    let magLogit = model.bMag;
    for (let h = 0; h < model.hidden; h += 1) {
        classLogit += model.wClass[h] * hidden[h];
        magLogit += model.wMag[h] * hidden[h];
    }
    return {
        hidden,
        starProbability: sigmoid(classLogit),
        magUnit: sigmoid(magLogit),
    };
}

function sampleLoss(model, sample) {
    const {classTarget, magTarget, weight} = sampleTargetAndWeight(sample);
    const {starProbability, magUnit} = forwardModel(model, sample.features);
    const classLoss = -weight * (classTarget * Math.log(Math.max(1e-9, starProbability)) +
        (1 - classTarget) * Math.log(Math.max(1e-9, 1 - starProbability)));
    const magLoss = sample.isStar ?
        weight * MAG_LOSS_WEIGHT * (magUnit - magTarget) * (magUnit - magTarget) :
        0;
    return {
        total: classLoss + magLoss,
        classLoss,
        magLoss,
    };
}

function meanLoss(model, samples) {
    if (!samples.length) {
        return {total: NaN, classLoss: NaN, magLoss: NaN};
    }
    const loss = {total: 0, classLoss: 0, magLoss: 0};
    for (const sample of samples) {
        const item = sampleLoss(model, sample);
        loss.total += item.total;
        loss.classLoss += item.classLoss;
        loss.magLoss += item.magLoss;
    }
    loss.total /= samples.length;
    loss.classLoss /= samples.length;
    loss.magLoss /= samples.length;
    return loss;
}

function trainOne(model, sample, learningRate) {
    const x = sample.features;
    const {hidden, starProbability, magUnit} = forwardModel(model, x);
    const {classTarget, magTarget, weight} = sampleTargetAndWeight(sample);
    const dClass = weight * (starProbability - classTarget);
    const dMag = sample.isStar ?
        weight * MAG_LOSS_WEIGHT * 2 * (magUnit - magTarget) * magUnit * (1 - magUnit) :
        0;
    for (let h = 0; h < model.hidden; h += 1) {
        const oldWClass = model.wClass[h];
        const oldWMag = model.wMag[h];
        model.wClass[h] -= learningRate * dClass * hidden[h];
        model.wMag[h] -= learningRate * dMag * hidden[h];
        const dh = (dClass * oldWClass + dMag * oldWMag) * (1 - hidden[h] * hidden[h]);
        const row = h * model.input;
        for (let i = 0; i < model.input; i += 1) {
            model.w1[row + i] -= learningRate * dh * x[i];
        }
        model.b1[h] -= learningRate * dh;
    }
    model.bClass -= learningRate * dClass;
    model.bMag -= learningRate * dMag;
    return sampleLoss(model, sample).total;
}

function predictHeads(model, features) {
    return StarPatchNN.predictRaw(model, features);
}

function metricsAtTopN(items, catalog, matchRadius, topN, scoreAccessor) {
    const detections = items
        .slice()
        .sort((a, b) => scoreAccessor(b) - scoreAccessor(a))
        .slice(0, topN)
        .map((item, index) => ({...item.candidate, id: index + 1}));
    const validation = knownLensValidationMap(detections, catalog, matchRadius);
    const correct = validation.matches.length;
    const precision = detections.length ? correct / detections.length : 0;
    const recall = catalog.length ? correct / catalog.length : 0;
    const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
    return {
        selected: detections.length,
        correct,
        falsePositive: Math.max(0, detections.length - correct),
        missed: Math.max(0, catalog.length - correct),
        precision,
        recall,
        f1,
    };
}

function evaluateCase(model, caseData) {
    const items = caseData.detectionResult.candidates.map(candidate => {
        const features = StarPatchNN.featureVector(caseData.imageData, candidate.x, candidate.y, candidate);
        const heads = predictHeads(model, features);
        const predictedMag = heads.predictedMagnitude;
        const nnScore = heads.starProbability;
        const detectorScore = Math.log1p(Math.max(0, candidate.score || 0));
        const magnitudeRank = nnScore + Math.max(0, (MAG_SCALE - predictedMag) / MAG_SCALE) * 0.25;
        return {
            candidate,
            predictedMag,
            nnScore,
            starProbability: heads.starProbability,
            magnitudeRank,
            blendScore: detectorScore + 2.0 * nnScore,
        };
    });
    const baseline = metricsAtTopN(
        items,
        caseData.catalog,
        caseData.matchRadius,
        caseData.maxDetections,
        item => item.candidate.score
    );
    const nn = metricsAtTopN(
        items,
        caseData.catalog,
        caseData.matchRadius,
        caseData.maxDetections,
        item => item.nnScore
    );
    const blended = metricsAtTopN(
        items,
        caseData.catalog,
        caseData.matchRadius,
        caseData.maxDetections,
        item => item.blendScore
    );
    return {
        id: caseData.testCase.id,
        title: caseData.testCase.title,
        split: caseData.split,
        catalogStars: caseData.catalog.length,
        candidates: items.length,
        topN: caseData.maxDetections,
        baseline,
        nn,
        blended,
        deltaCorrect: nn.correct - baseline.correct,
        blendedDeltaCorrect: blended.correct - baseline.correct,
        samplePredictions: items
            .slice()
            .sort((a, b) => a.predictedMag - b.predictedMag)
            .slice(0, 18)
            .map(item => ({
                x: item.candidate.x,
                y: item.candidate.y,
                predictedMag: item.predictedMag,
                starProbability: item.starProbability,
                detectorScore: item.candidate.score,
            })),
    };
}

function aggregate(rows) {
    const sum = rows.reduce((acc, row) => {
        for (const key of ["correct", "selected", "falsePositive", "missed"]) {
            acc.baseline[key] += row.baseline[key];
            acc.nn[key] += row.nn[key];
            acc.blended[key] += row.blended[key];
        }
        acc.catalogStars += row.catalogStars;
        return acc;
    }, {
        baseline: {correct: 0, selected: 0, falsePositive: 0, missed: 0},
        nn: {correct: 0, selected: 0, falsePositive: 0, missed: 0},
        blended: {correct: 0, selected: 0, falsePositive: 0, missed: 0},
        catalogStars: 0,
    });
    for (const item of [sum.baseline, sum.nn, sum.blended]) {
        item.precision = item.selected ? item.correct / item.selected : 0;
        item.recall = sum.catalogStars ? item.correct / sum.catalogStars : 0;
        item.f1 = item.precision + item.recall > 0 ? 2 * item.precision * item.recall / (item.precision + item.recall) : 0;
    }
    return sum;
}

function reportTable(rows) {
    return `<table>
<thead><tr><th>case</th><th>split</th><th>catalog</th><th>candidates</th><th>top N</th><th>baseline correct</th><th>NN correct</th><th>blend correct</th><th>NN delta</th><th>blend delta</th><th>baseline F1</th><th>NN F1</th><th>blend F1</th></tr></thead>
<tbody>${rows.map(row => `<tr>
<td>${escapeHtml(row.id)}</td>
<td>${escapeHtml(row.split)}</td>
<td>${row.catalogStars}</td>
<td>${row.candidates}</td>
<td>${row.topN}</td>
<td>${row.baseline.correct}</td>
<td>${row.nn.correct}</td>
<td>${row.blended.correct}</td>
<td class="${row.deltaCorrect >= 0 ? "good" : "bad"}">${row.deltaCorrect >= 0 ? "+" : ""}${row.deltaCorrect}</td>
<td class="${row.blendedDeltaCorrect >= 0 ? "good" : "bad"}">${row.blendedDeltaCorrect >= 0 ? "+" : ""}${row.blendedDeltaCorrect}</td>
<td>${fmt(row.baseline.f1, 3)}</td>
<td>${fmt(row.nn.f1, 3)}</td>
<td>${fmt(row.blended.f1, 3)}</td>
</tr>`).join("")}</tbody>
</table>`;
}

function lossPlotSvg(lossHistory) {
    const width = 760;
    const height = 320;
    const pad = {left: 54, right: 18, top: 22, bottom: 42};
    const values = lossHistory.flatMap(row => [row.trainingLoss, row.validationLoss])
        .filter(Number.isFinite);
    if (!values.length) {
        return "<p>No loss history available.</p>";
    }
    const minLoss = Math.min(...values);
    const maxLoss = Math.max(...values);
    const span = Math.max(1e-6, maxLoss - minLoss);
    const minY = Math.max(0, minLoss - 0.08 * span);
    const maxY = maxLoss + 0.08 * span;
    const maxEpoch = Math.max(1, ...lossHistory.map(row => row.epoch));
    const sx = epoch => pad.left + (epoch - 1) / Math.max(1, maxEpoch - 1) * (width - pad.left - pad.right);
    const sy = loss => height - pad.bottom - (loss - minY) / Math.max(1e-6, maxY - minY) * (height - pad.top - pad.bottom);
    const pathFor = key => lossHistory
        .filter(row => Number.isFinite(row[key]))
        .map((row, index) => `${index === 0 ? "M" : "L"} ${sx(row.epoch).toFixed(2)} ${sy(row[key]).toFixed(2)}`)
        .join(" ");
    const grid = [];
    for (let i = 0; i <= 4; i += 1) {
        const yValue = minY + (maxY - minY) * i / 4;
        const y = sy(yValue);
        grid.push(`<line class="plot-grid" x1="${pad.left}" y1="${y.toFixed(2)}" x2="${width - pad.right}" y2="${y.toFixed(2)}"></line>`);
        grid.push(`<text class="plot-tick" x="${pad.left - 8}" y="${(y + 4).toFixed(2)}" text-anchor="end">${fmt(yValue, 3)}</text>`);
    }
    for (let i = 0; i <= 4; i += 1) {
        const epoch = 1 + (maxEpoch - 1) * i / 4;
        const x = sx(epoch);
        grid.push(`<line class="plot-grid" x1="${x.toFixed(2)}" y1="${pad.top}" x2="${x.toFixed(2)}" y2="${height - pad.bottom}"></line>`);
        grid.push(`<text class="plot-tick" x="${x.toFixed(2)}" y="${height - 16}" text-anchor="middle">${fmt(epoch, 0)}</text>`);
    }
    return `<svg class="loss-plot" viewBox="0 0 ${width} ${height}" role="img" aria-label="Training and validation loss by epoch">
<rect class="plot-bg" x="0" y="0" width="${width}" height="${height}"></rect>
${grid.join("\n")}
<rect class="plot-frame" x="${pad.left}" y="${pad.top}" width="${width - pad.left - pad.right}" height="${height - pad.top - pad.bottom}"></rect>
<path class="loss-line training" d="${pathFor("trainingLoss")}"></path>
<path class="loss-line validation" d="${pathFor("validationLoss")}"></path>
<text class="axis-label" x="${width / 2}" y="${height - 4}" text-anchor="middle">epoch</text>
<text class="axis-label" x="14" y="${height / 2}" text-anchor="middle" transform="rotate(-90 14 ${height / 2})">weighted cross-entropy loss</text>
<text class="legend-label training-label" x="${width - 220}" y="28">training</text>
<text class="legend-label validation-label" x="${width - 120}" y="28">validation</text>
</svg>`;
}

function componentLossPlotSvg(lossHistory) {
    const width = 760;
    const height = 320;
    const pad = {left: 54, right: 18, top: 22, bottom: 42};
    const keys = [
        ["validationClassLoss", "class", "#7c3aed"],
        ["validationMagnitudeLoss", "magnitude", "#ea580c"],
    ];
    const values = lossHistory.flatMap(row => keys.map(([key]) => row[key])).filter(Number.isFinite);
    if (!values.length) {
        return "<p>No component loss history available.</p>";
    }
    const minY = 0;
    const maxY = Math.max(...values) * 1.08;
    const maxEpoch = Math.max(1, ...lossHistory.map(row => row.epoch));
    const sx = epoch => pad.left + (epoch - 1) / Math.max(1, maxEpoch - 1) * (width - pad.left - pad.right);
    const sy = loss => height - pad.bottom - (loss - minY) / Math.max(1e-6, maxY - minY) * (height - pad.top - pad.bottom);
    const pathFor = key => lossHistory
        .filter(row => Number.isFinite(row[key]))
        .map((row, index) => `${index === 0 ? "M" : "L"} ${sx(row.epoch).toFixed(2)} ${sy(row[key]).toFixed(2)}`)
        .join(" ");
    const grid = [];
    for (let i = 0; i <= 4; i += 1) {
        const yValue = minY + (maxY - minY) * i / 4;
        const y = sy(yValue);
        grid.push(`<line class="plot-grid" x1="${pad.left}" y1="${y.toFixed(2)}" x2="${width - pad.right}" y2="${y.toFixed(2)}"></line>`);
        grid.push(`<text class="plot-tick" x="${pad.left - 8}" y="${(y + 4).toFixed(2)}" text-anchor="end">${fmt(yValue, 3)}</text>`);
    }
    const paths = keys.map(([key, label, color]) =>
        `<path class="component-line" style="stroke:${color}" d="${pathFor(key)}"></path>` +
        `<text class="legend-label" style="fill:${color}" x="${width - 230 + keys.findIndex(item => item[0] === key) * 105}" y="28">${label}</text>`
    ).join("\n");
    return `<svg class="loss-plot" viewBox="0 0 ${width} ${height}" role="img" aria-label="Validation class and magnitude loss by epoch">
<rect class="plot-bg" x="0" y="0" width="${width}" height="${height}"></rect>
${grid.join("\n")}
<rect class="plot-frame" x="${pad.left}" y="${pad.top}" width="${width - pad.left - pad.right}" height="${height - pad.top - pad.bottom}"></rect>
${paths}
<text class="axis-label" x="${width / 2}" y="${height - 4}" text-anchor="middle">epoch</text>
<text class="axis-label" x="14" y="${height / 2}" text-anchor="middle" transform="rotate(-90 14 ${height / 2})">validation component loss</text>
</svg>`;
}

function pageHtml(report) {
    const command = "cd /Users/j/src/AIDA_tools/aida_js_calibrator && npm run train:star-nn";
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>AIDA Star Patch NN Report</title>
<style>
body { margin: 0; background: #f5f7fa; color: #17202a; font: 15px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { max-width: 1180px; margin: 0 auto; padding: 24px; }
h1 { margin: 0 0 8px; font-size: 24px; }
.card { background: white; border: 1px solid #d9e1ea; border-radius: 8px; padding: 14px; margin: 14px 0; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { border-bottom: 1px solid #e2e8f0; padding: 6px 8px; text-align: right; }
th:first-child, td:first-child { text-align: left; }
pre { background: #eef2f7; border-radius: 6px; padding: 10px; overflow-x: auto; }
.good { color: #087f3f; font-weight: 800; }
.bad { color: #b42318; font-weight: 800; }
.metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; }
.metric { background: #f8fafc; border: 1px solid #d9e1ea; border-radius: 8px; padding: 10px; }
.metric b { display: block; font-size: 24px; }
.loss-plot { width: 100%; height: auto; display: block; }
.plot-bg { fill: #ffffff; }
.plot-frame { fill: none; stroke: #94a3b8; }
.plot-grid { stroke: #e2e8f0; stroke-width: 1; }
.plot-tick, .axis-label, .legend-label { fill: #475569; font-size: 12px; }
.loss-line, .component-line { fill: none; stroke-width: 3; }
.loss-line.training { stroke: #2563eb; }
.loss-line.validation { stroke: #dc2626; }
.training-label { fill: #2563eb; font-weight: 800; }
.validation-label { fill: #dc2626; font-weight: 800; }
</style>
</head>
<body>
<main>
<h1>AIDA Star Patch Neural Network Report</h1>
<p>This is an offline validation report only. The GUI workflow does not use this neural network yet.</p>
<section class="card">
<h2>Repeat From Command Line</h2>
<pre><code>${escapeHtml(command)}</code></pre>
</section>
<section class="card">
<h2>Model</h2>
<p>Input: ${report.model.input} features from a ${2 * report.model.patchRadius + 1}x${2 * report.model.patchRadius + 1} normalized patch plus detector shape statistics. Hidden units: ${report.model.hidden}. The model has two heads: star/no-star probability, and magnitude regression trained only on positive star samples.</p>
<p>Model JSON: <code>${escapeHtml(path.relative(OUT_DIR, MODEL_FILE))}</code></p>
</section>
<section class="card metrics">
<div class="metric"><span>Training samples</span><b>${report.trainingSamples}</b></div>
<div class="metric"><span>Validation samples</span><b>${report.validationSamples}</b></div>
<div class="metric"><span>Validation baseline stars</span><b>${report.validationAggregate.baseline.correct}</b></div>
<div class="metric"><span>Validation NN stars</span><b>${report.validationAggregate.nn.correct}</b></div>
<div class="metric"><span>Validation blend stars</span><b>${report.validationAggregate.blended.correct}</b></div>
</section>
<section class="card">
<h2>Validation Cases</h2>
${reportTable(report.validationRows)}
</section>
<section class="card">
<h2>Training Cases</h2>
${reportTable(report.trainingRows)}
</section>
<section class="card">
<h2>Epoch Loss</h2>
${lossPlotSvg(report.lossHistory)}
<h3>Validation Component Loss</h3>
${componentLossPlotSvg(report.lossHistory)}
<pre>${escapeHtml(JSON.stringify(report.lossHistory, null, 2))}</pre>
</section>
</main>
</body>
</html>`;
}

async function buildTrainingReport() {
    const cases = buildCases()
        .filter(testCase => testCase.optpar && testCase.optpar.length >= 8)
        .filter(testCase => fs.existsSync(testCaseImagePath(testCase)));
    const caseData = [];
    for (let i = 0; i < cases.length; i += 1) {
        const testCase = cases[i];
        process.stderr.write(`[${i + 1}/${cases.length}] building NN samples for ${testCase.id}\n`);
        const data = await caseSamples(testCase, i);
        data.split = i % 5 === 0 ? "validation" : "train";
        caseData.push(data);
    }
    const trainingSamples = caseData
        .filter(item => item.split === "train")
        .flatMap(item => item.samples);
    const validationSamples = caseData
        .filter(item => item.split === "validation")
        .flatMap(item => item.samples);
    if (!trainingSamples.length) {
        throw new Error("no training samples produced");
    }
    const rand = mulberry32(0xA1DA2026);
    const model = initModel(trainingSamples[0].features.length, HIDDEN, rand);
    const lossHistory = [];
    for (let epoch = 0; epoch < EPOCHS; epoch += 1) {
        shuffle(trainingSamples, rand);
        let loss = 0;
        for (const sample of trainingSamples) {
            loss += trainOne(model, sample, LEARNING_RATE);
        }
        const trainingLoss = loss / trainingSamples.length;
        const trainingParts = meanLoss(model, trainingSamples);
        const validationParts = meanLoss(model, validationSamples);
        lossHistory.push({
            epoch: epoch + 1,
            trainingLoss,
            validationLoss: validationParts.total,
            trainingClassLoss: trainingParts.classLoss,
            validationClassLoss: validationParts.classLoss,
            trainingMagnitudeLoss: trainingParts.magLoss,
            validationMagnitudeLoss: validationParts.magLoss,
        });
        process.stderr.write(
            `epoch ${epoch + 1}/${EPOCHS} training ${trainingLoss.toFixed(5)} validation ${fmt(validationParts.total, 5)} ` +
            `(class ${fmt(validationParts.classLoss, 5)}, mag ${fmt(validationParts.magLoss, 5)})\n`
        );
    }
    model.createdUtc = new Date().toISOString();
    model.training = {
        cases: cases.length,
        trainingSamples: trainingSamples.length,
        validationSamples: validationSamples.length,
        epochs: EPOCHS,
        learningRate: LEARNING_RATE,
        magLossWeight: MAG_LOSS_WEIGHT,
    };
    const rows = caseData.map(item => evaluateCase(model, item));
    const trainingRows = rows.filter(row => row.split === "train");
    const validationRows = rows.filter(row => row.split === "validation");
    return {
        generatedUtc: new Date().toISOString(),
        model,
        trainingSamples: trainingSamples.length,
        validationSamples: validationSamples.length,
        lossHistory,
        trainingRows,
        validationRows,
        trainingAggregate: aggregate(trainingRows),
        validationAggregate: aggregate(validationRows),
    };
}

async function main() {
    fs.mkdirSync(OUT_DIR, {recursive: true});
    const report = await buildTrainingReport();
    fs.writeFileSync(MODEL_FILE, JSON.stringify(report.model, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, "summary.json"), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, "index.html"), pageHtml(report));
    console.log(`validation baseline correct: ${report.validationAggregate.baseline.correct}`);
    console.log(`validation NN correct: ${report.validationAggregate.nn.correct}`);
    console.log(`validation blended correct: ${report.validationAggregate.blended.correct}`);
    console.log(path.join(OUT_DIR, "index.html"));
}

if (require.main === module) {
    main().catch(error => {
        console.error(error.stack || error.message || error);
        process.exitCode = 1;
    });
}

module.exports = {
    buildTrainingReport,
};
