#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const AutoIdentifier = require("../js/auto_identifier.js");
const StarDetector = require("../js/star_detector.js");
const {
    AidaTools,
    readPngImageData,
    visibleStars,
} = require("./generate_test_report.js");

const ROOT = path.join(__dirname, "..");
const DEFAULT_CASE_ID = "2026-02-12T19-04-00-000KRN";
const OUT_DIR = path.join(ROOT, "test-report", "fisheye-lucky");

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, ch => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;",
    }[ch]));
}

function catalogKey(star) {
    return `${star.name}|${Number(star.raHours).toFixed(7)}|${Number(star.decDeg).toFixed(7)}`;
}

function splitOptpar(metadata) {
    const raw = Array.isArray(metadata.optpar) ? metadata.optpar.map(Number) : [];
    if (raw.length > 8 && Number.isInteger(raw[0]) && raw[0] > 0 && raw[0] < 100) {
        return {optmod: raw[0], optpar: raw.slice(1)};
    }
    return {optmod: Number(metadata.optmod) || 2, optpar: raw};
}

function horizonFromOptpar(metadata, width, height) {
    const {optmod, optpar} = splitOptpar(metadata);
    if (optmod !== 2 || optpar.length < 8) {
        return null;
    }
    const alpha = optpar[7];
    return {
        centerX: (0.5 + optpar[5]) * width - 1,
        centerY: (0.5 + optpar[6]) * height - 1,
        radiusPx: optpar[0] * Math.sin(alpha * Math.PI / 2) * width,
        alpha,
    };
}

function scoreAgainstManual(matches, metadata, radiusPx = 18) {
    const manual = new Map((metadata.matches || []).map(match => [match.catalog.key, match]));
    let correct = 0;
    let wrong = 0;
    let unknown = 0;
    for (const match of matches) {
        const key = match.star.key || catalogKey(match.star);
        const seed = manual.get(key);
        if (!seed) {
            unknown += 1;
            continue;
        }
        const distance = Math.hypot(match.detection.x - seed.image.x, match.detection.y - seed.image.y);
        if (distance <= radiusPx) {
            correct += 1;
        } else {
            wrong += 1;
        }
    }
    return {correct, wrong, unknown};
}

async function runFisheyeLuckyCase(caseId = DEFAULT_CASE_ID, options = {}) {
    const caseDir = path.join(ROOT, "test_cases", caseId);
    const metadata = JSON.parse(fs.readFileSync(path.join(caseDir, "metadata.json"), "utf8"));
    const imagePath = path.join(caseDir, metadata.image);
    const imageData = await readPngImageData(imagePath);
    const detection = AidaTools.detectFisheyeAnnulus(imageData, {
        filename: metadata.image || caseId,
        alpha: 0.46,
        samples: 128,
    });
    const reference = horizonFromOptpar(metadata, imageData.width, imageData.height);
    const maxMagnitude = Number.isFinite(options.maxMagnitude) ? options.maxMagnitude : 4.5;
    const visible = visibleStars({
        date: new Date(metadata.timestampUtc),
        latDeg: Number(metadata.latDeg),
        lonDeg: Number(metadata.lonDeg),
        maxMag: maxMagnitude,
    }, maxMagnitude);
    const detectedStars = await StarDetector.detectBrightStars(imageData, {
        maxDetections: Number.isFinite(options.maxDetections) ? options.maxDetections : 90,
        thresholdSigma: 2.1,
        localThresholdSigma: 2.1,
        requireGlobalThreshold: false,
        maxRadiusPx: 9,
        maxElongation: 4.8,
        suppressionRadiusPx: 10,
        crowdingRadiusPx: 34,
        maxCrowding: 8,
        crowdingScorePower: 1.15,
        ...(options.detectorOptions || {}),
    });
    const preflatten = detection.detected ? AidaTools.fisheyePreflattenFromAnnulus(detection) : {};
    if (preflatten && Array.isArray(preflatten.preflattenRadialAlphaCandidates)) {
        preflatten.preflattenRadialAlphaCandidates = [0.42, 0.46, 0.50, 0.54];
        preflatten.preflattenF1Candidates = preflatten.preflattenRadialAlphaCandidates.map(alpha =>
            Number((detection.radiusPx / imageData.width / Math.sin(alpha * Math.PI / 2)).toFixed(4))
        );
    }
    const identification = AutoIdentifier.identifyStarsBlind(visible, detectedStars.detections, {
        imageWidth: imageData.width,
        imageHeight: imageData.height,
        maxMagnitude,
        maxDetections: Number.isFinite(options.maxDetections) ? options.maxDetections : 90,
        maxBlindVerifyDetections: 90,
        maxCatalogStars: 260,
        maxCatalogTriangleStars: 240,
        maxCatalogTriangles: 32000,
        maxAmbiguityCatalogStars: 360,
        maxDetectionTriangleStars: 80,
        maxDetectionTriangles: 3200,
        maxBlindCandidateRotations: 9000,
        maxCatalogLocalNeighbors: 20,
        maxBlindNeighborTriangles: 8,
        blindEarlyAcceptMatches: 10,
        blindEarlyAcceptMedianDeg: 0.70,
        rejectAmbiguousBlindMatches: true,
        blindAmbiguityRadiusDeg: 0.85,
        blindAmbiguityDistanceSlackDeg: 0.28,
        blindPixelMatchRadiusPx: 60,
        blindPixelAmbiguityRadiusPx: 14,
        blindPixelAmbiguityDistanceSlackPx: 7,
        ambiguityMaxMagnitude: 7.0,
        preflattenSignCandidates: [[1, 1], [-1, -1], [1, -1], [-1, 1]],
        ...preflatten,
    });
    const score = scoreAgainstManual(identification.matches || [], metadata, options.manualRadiusPx || 18);
    const result = {
        caseId,
        metadata,
        imagePath,
        imageData,
        detection,
        reference,
        detectedStars: detectedStars.detections,
        visible,
        identification,
        score,
    };
    if (options.writeReport !== false) {
        result.report = writeReport(result, options);
    }
    return result;
}

function writeReport(result, options = {}) {
    const outDir = options.outDir || OUT_DIR;
    fs.mkdirSync(outDir, {recursive: true});
    const imageRel = path.relative(outDir, result.imagePath).replaceAll(path.sep, "/");
    const ann = result.detection;
    const ref = result.reference;
    const rows = [
        ["Annulus detected", ann.detected ? "yes" : "no"],
        ["Annulus score", Number(ann.score).toFixed(3)],
        ["Detected center", `${Number(ann.centerX).toFixed(1)}, ${Number(ann.centerY).toFixed(1)} px`],
        ["Detected horizon radius", `${Number(ann.radiusPx).toFixed(1)} px`],
        ["Reference center", ref ? `${ref.centerX.toFixed(1)}, ${ref.centerY.toFixed(1)} px` : "n/a"],
        ["Reference horizon radius", ref ? `${ref.radiusPx.toFixed(1)} px` : "n/a"],
        ["Detected stars", result.detectedStars.length],
        ["Visible catalog stars", result.visible.length],
        ["Blind lucky matches", (result.identification.matches || []).length],
        ["Manual overlap", `${result.score.correct} correct, ${result.score.wrong} wrong, ${result.score.unknown} unknown`],
    ];
    const width = result.imageData.width;
    const height = result.imageData.height;
    const circle = ann.detected ?
        `<circle cx="${ann.centerX.toFixed(1)}" cy="${ann.centerY.toFixed(1)}" r="${ann.radiusPx.toFixed(1)}" ` +
        `fill="none" stroke="#38bdf8" stroke-width="4"/>` :
        "";
    const refCircle = ref ?
        `<circle cx="${ref.centerX.toFixed(1)}" cy="${ref.centerY.toFixed(1)}" r="${ref.radiusPx.toFixed(1)}" ` +
        `fill="none" stroke="#f97316" stroke-width="3" stroke-dasharray="10 8"/>` :
        "";
    const matched = (result.identification.matches || []).slice(0, 80).map(match =>
        `<circle cx="${match.detection.x.toFixed(1)}" cy="${match.detection.y.toFixed(1)}" r="9" ` +
        `fill="none" stroke="#22c55e" stroke-width="2"><title>${escapeHtml(match.star.name || "")}</title></circle>`
    ).join("\n");
    const html = `<!doctype html>
<meta charset="utf-8">
<title>Fisheye lucky validation: ${escapeHtml(result.caseId)}</title>
<style>
body{font-family:system-ui,sans-serif;margin:24px;background:#111827;color:#e5e7eb}
.wrap{position:relative;width:min(100%,${width}px)}
img,svg{display:block;width:100%;height:auto}
svg{position:absolute;inset:0}
table{border-collapse:collapse;margin:16px 0}td,th{padding:5px 10px;border-bottom:1px solid #374151;text-align:left}
.note{max-width:900px;line-height:1.45}
</style>
<h1>Fisheye lucky validation: ${escapeHtml(result.caseId)}</h1>
<p class="note">This report checks the fast circular-annulus fisheye detector and runs the same
blind pre-undistorted star-identification settings used by the fisheye “I'm feeling lucky” mode.
Blue is the detected horizon annulus, orange is the manually calibrated horizon, and green marks
blindly associated star detections.</p>
<table>${rows.map(row => `<tr><th>${escapeHtml(row[0])}</th><td>${escapeHtml(row[1])}</td></tr>`).join("\n")}</table>
<p>${escapeHtml(result.identification.status || "")}</p>
<div class="wrap">
<img src="${imageRel}">
<svg viewBox="0 0 ${width} ${height}">
${circle}
${refCircle}
${matched}
</svg>
</div>`;
    const htmlPath = path.join(outDir, `${result.caseId}.html`);
    const jsonPath = path.join(outDir, `${result.caseId}.json`);
    fs.writeFileSync(htmlPath, html);
    fs.writeFileSync(jsonPath, JSON.stringify({
        caseId: result.caseId,
        detection: result.detection,
        reference: result.reference,
        detectedStars: result.detectedStars.length,
        visibleStars: result.visible.length,
        identification: {
            status: result.identification.status,
            matches: (result.identification.matches || []).length,
            medianDistance: result.identification.medianDistance,
            f1: result.identification.f1,
            radialAlpha: result.identification.radialAlpha,
            du: result.identification.du,
            dv: result.identification.dv,
            preflattenQuality: result.identification.preflattenQuality,
        },
        score: result.score,
    }, null, 2) + "\n");
    return {htmlPath, jsonPath};
}

async function main() {
    const caseId = process.argv[2] || DEFAULT_CASE_ID;
    const result = await runFisheyeLuckyCase(caseId, {writeReport: true});
    console.log(`${result.caseId}: fisheye=${result.detection.detected} score=${Number(result.detection.score).toFixed(3)}`);
    console.log(`detections=${result.detectedStars.length} visible=${result.visible.length} matches=${(result.identification.matches || []).length}`);
    console.log(`manual overlap correct=${result.score.correct} wrong=${result.score.wrong} unknown=${result.score.unknown}`);
    console.log(`wrote ${result.report.htmlPath}`);
}

if (require.main === module) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}

module.exports = {
    runFisheyeLuckyCase,
    scoreAgainstManual,
};
