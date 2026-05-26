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

function median(values) {
    if (!values.length) {
        return NaN;
    }
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid]);
}

function peakDensityValue(values, binWidth = 2) {
    if (!values.length) {
        return NaN;
    }
    const width = Math.max(1, Number(binWidth) || 2);
    const bins = Math.ceil(256 / width);
    const hist = new Array(bins).fill(0);
    for (const value of values) {
        const idx = Math.max(0, Math.min(bins - 1, Math.floor(Math.max(0, Math.min(255, value)) / width)));
        hist[idx] += 1;
    }
    let bestIdx = 0;
    let bestCount = -Infinity;
    for (let i = 0; i < bins; i += 1) {
        const count = hist[i] + 0.5 * (hist[i - 1] || 0) + 0.5 * (hist[i + 1] || 0);
        if (count > bestCount) {
            bestCount = count;
            bestIdx = i;
        }
    }
    return (bestIdx + 0.5) * width;
}

function luminanceAt(imageData, x, y) {
    const width = imageData.width;
    const height = imageData.height;
    const data = imageData.data;
    const ix = Math.max(0, Math.min(width - 1, Math.round(x)));
    const iy = Math.max(0, Math.min(height - 1, Math.round(y)));
    const k = 4 * (iy * width + ix);
    return 0.2126 * data[k] + 0.7152 * data[k + 1] + 0.0722 * data[k + 2];
}

function radialHorizonDiagnostic(imageData, detection, reference = null) {
    const width = imageData.width;
    const height = imageData.height;
    const minSide = Math.min(width, height);
    const cx = Number.isFinite(detection && detection.centerX) ? detection.centerX : 0.5 * (width - 1);
    const cy = Number.isFinite(detection && detection.centerY) ? detection.centerY : 0.5 * (height - 1);
    const step = Number.isFinite(detection && detection.profileStepPx) ? detection.profileStepPx : Math.max(1, Math.round(minSide / 1400));
    const samples = Number.isFinite(detection && detection.profileSamples) ? detection.profileSamples : minSide >= 1200 ? 720 : 192;
    const binWidth = Number.isFinite(detection && detection.densityBinWidth) ? detection.densityBinWidth : 2;
    const blackThreshold = Number.isFinite(detection && detection.blackThreshold) ? detection.blackThreshold : 25;
    const r0 = 0.40 * minSide;
    const r1 = 0.505 * minSide;
    const profile = [];
    for (let radius = r0; radius <= r1 + 1e-9; radius += step) {
        const values = [];
        for (let i = 0; i < samples; i += 1) {
            const a = 2 * Math.PI * i / samples;
            const x = cx + radius * Math.cos(a);
            const y = cy + radius * Math.sin(a);
            if (x >= 0 && x < width && y >= 0 && y < height) {
                values.push(luminanceAt(imageData, x, y));
            }
        }
        if (values.length >= samples * 0.80) {
            profile.push({
                radius,
                peakDensity: peakDensityValue(values, binWidth),
                blackFraction: values.filter(value => value <= blackThreshold).length / values.length,
                validFraction: values.length / samples,
            });
        }
    }
    const halfWindow = Math.max(2, Math.round(Math.max(5, 0.004 * minSide) / step));
    const drops = [];
    for (let i = halfWindow; i < profile.length - halfWindow - 1; i += 1) {
        const insideRows = profile.slice(i - halfWindow, i);
        const outsideRows = profile.slice(i + 1, i + halfWindow + 1);
        const inside = insideRows.reduce((acc, row) => acc + row.peakDensity, 0) / insideRows.length;
        const outside = outsideRows.reduce((acc, row) => acc + row.peakDensity, 0) / outsideRows.length;
        drops.push({
            radius: profile[i].radius,
            drop: inside - outside,
            inside,
            outside,
        });
    }
    return {
        centerX: cx,
        centerY: cy,
        step,
        samples,
        binWidth,
        blackThreshold,
        profile,
        drops,
        detectedRadius: Number(detection && detection.radiusPx),
        referenceRadius: reference ? Number(reference.radiusPx) : NaN,
    };
}

function svgScatterPlot({title, xLabel, yLabel, points, yAccessor, detectedRadius, referenceRadius, width = 920, height = 380}) {
    if (!Array.isArray(points) || points.length === 0) {
        return "";
    }
    const margin = {left: 82, right: 34, top: 58, bottom: 70};
    const xMin = Math.min(...points.map(point => point.radius));
    const xMax = Math.max(...points.map(point => point.radius));
    const yValues = points.map(yAccessor).filter(Number.isFinite);
    const yMin = Math.min(0, Math.min(...yValues));
    const yMax = Math.max(...yValues);
    const yPad = Math.max(1, 0.06 * (yMax - yMin || 1));
    const sx = value => margin.left + (value - xMin) / Math.max(1e-9, xMax - xMin) * (width - margin.left - margin.right);
    const sy = value => height - margin.bottom - (value - (yMin - yPad)) / Math.max(1e-9, yMax - yMin + 2 * yPad) *
        (height - margin.top - margin.bottom);
    const ticks = [0, 0.25, 0.5, 0.75, 1].map(frac => xMin + frac * (xMax - xMin));
    const yTicks = [0, 0.25, 0.5, 0.75, 1].map(frac => yMin + frac * (yMax - yMin));
    const circles = points.map(point =>
        `<circle cx="${sx(point.radius).toFixed(1)}" cy="${sy(yAccessor(point)).toFixed(1)}" r="3.0"/>`
    ).join("\n");
    const vline = (radius, color, label, dash = "") => Number.isFinite(radius) ?
        `<line x1="${sx(radius).toFixed(1)}" x2="${sx(radius).toFixed(1)}" y1="${margin.top}" y2="${height - margin.bottom}" ` +
        `stroke="${color}" stroke-width="3" ${dash ? `stroke-dasharray="${dash}"` : ""}/>` +
        `<text x="${(sx(radius) + 8).toFixed(1)}" y="${margin.top - 16}" fill="${color}" font-size="18" font-weight="700">${escapeHtml(label)}</text>` :
        "";
    return `<figure class="plot">
<figcaption>${escapeHtml(title)}</figcaption>
<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}">
<rect x="0" y="0" width="${width}" height="${height}" fill="#0f172a" rx="6"/>
<rect x="${margin.left}" y="${margin.top}" width="${width - margin.left - margin.right}" height="${height - margin.top - margin.bottom}" fill="#020617" stroke="#64748b" stroke-width="1"/>
<g stroke="#334155" stroke-width="1">
${ticks.map(tick => `<line x1="${sx(tick).toFixed(1)}" x2="${sx(tick).toFixed(1)}" y1="${margin.top}" y2="${height - margin.bottom}"/>`).join("\n")}
${yTicks.map(tick => `<line x1="${margin.left}" x2="${width - margin.right}" y1="${sy(tick).toFixed(1)}" y2="${sy(tick).toFixed(1)}"/>`).join("\n")}
</g>
<g fill="#67e8f9" opacity="0.9">${circles}</g>
${vline(detectedRadius, "#38bdf8", "detected")}
${vline(referenceRadius, "#f97316", "reference", "7 5")}
<line x1="${margin.left}" x2="${width - margin.right}" y1="${height - margin.bottom}" y2="${height - margin.bottom}" stroke="#cbd5e1" stroke-width="2"/>
<line x1="${margin.left}" x2="${margin.left}" y1="${margin.top}" y2="${height - margin.bottom}" stroke="#cbd5e1" stroke-width="2"/>
${ticks.map(tick => `<text x="${sx(tick).toFixed(1)}" y="${height - 38}" text-anchor="middle" fill="#f8fafc" font-size="16">${tick.toFixed(0)}</text>`).join("\n")}
${yTicks.map(tick => `<text x="${margin.left - 12}" y="${(sy(tick) + 5).toFixed(1)}" text-anchor="end" fill="#f8fafc" font-size="16">${tick.toFixed(0)}</text>`).join("\n")}
<text x="${width / 2}" y="${height - 12}" text-anchor="middle" fill="#ffffff" font-size="18" font-weight="700">${escapeHtml(xLabel)}</text>
<text transform="translate(24 ${height / 2}) rotate(-90)" text-anchor="middle" fill="#ffffff" font-size="18" font-weight="700">${escapeHtml(yLabel)}</text>
</svg>
</figure>`;
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

function fisheyeHorizonMask(detection, marginDiameterFraction = 0.10) {
    if (!detection || !detection.detected) {
        return null;
    }
    const margin = Math.max(0, Number(marginDiameterFraction) || 0) * 2 * Number(detection.radiusPx);
    const usableRadius = Math.max(0, Number(detection.radiusPx) - margin);
    const r2 = usableRadius * usableRadius;
    return {
        usableRadius,
        maskPredicate: (x, y) => {
            const dx = x - detection.centerX;
            const dy = y - detection.centerY;
            return dx * dx + dy * dy > r2;
        },
    };
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
        radiusPx: Math.abs(optpar[0] * Math.sin(alpha * Math.PI / 2) * width),
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
    const catalogMaxZenithDeg = Number.isFinite(options.catalogMaxZenithDeg) ? options.catalogMaxZenithDeg : 80;
    const visible = visibleStars({
        date: new Date(metadata.timestampUtc),
        latDeg: Number(metadata.latDeg),
        lonDeg: Number(metadata.lonDeg),
        maxMag: maxMagnitude,
        maxZenithDeg: catalogMaxZenithDeg,
    }, maxMagnitude);
    const horizonMask = fisheyeHorizonMask(detection, 0.10);
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
        maskPredicate: horizonMask ? horizonMask.maskPredicate : null,
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
        catalogMaxZenithDeg,
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
        horizonMask,
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
    const horizonDiagnostic = radialHorizonDiagnostic(result.imageData, ann, ref);
    const radialPlot = svgScatterPlot({
        title: "Peak-density radial intensity profile used for horizon detection",
        xLabel: "Radius from image center (px)",
        yLabel: "Peak density intensity",
        points: horizonDiagnostic.profile,
        yAccessor: point => point.peakDensity,
        detectedRadius: horizonDiagnostic.detectedRadius,
        referenceRadius: horizonDiagnostic.referenceRadius,
    });
    const dropPlot = svgScatterPlot({
        title: "Radial matched-filter edge response",
        xLabel: "Radius from image center (px)",
        yLabel: "Inside minus outside peak",
        points: horizonDiagnostic.drops,
        yAccessor: point => point.drop,
        detectedRadius: horizonDiagnostic.detectedRadius,
        referenceRadius: horizonDiagnostic.referenceRadius,
    });
    const rows = [
        ["Annulus detected", ann.detected ? "yes" : "no"],
        ["Annulus score", Number(ann.score).toFixed(3)],
        ["Detected center", `${Number(ann.centerX).toFixed(1)}, ${Number(ann.centerY).toFixed(1)} px`],
        ["Detected horizon radius", `${Number(ann.radiusPx).toFixed(1)} px`],
        ["Threshold circle seed", ann.thresholdCircle ?
            `${ann.thresholdCircle.centerX.toFixed(1)}, ${ann.thresholdCircle.centerY.toFixed(1)} px; r=${ann.thresholdCircle.radiusPx.toFixed(1)} px` :
            "n/a"],
        ["Bootstrap usable radius", result.horizonMask ? `${result.horizonMask.usableRadius.toFixed(1)} px` : "n/a"],
        ["Bootstrap catalog zenith limit", "80 deg (stars >=10 deg elevation)"],
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
body{font-family:system-ui,sans-serif;margin:28px;background:#111827;color:#f8fafc;font-size:18px;line-height:1.45}
h1{font-size:32px;margin:0 0 16px}h2{font-size:26px;margin:30px 0 12px}
.wrap{position:relative;width:min(100%,${width}px)}
img,svg{display:block;width:100%;height:auto}
.wrap>svg{position:absolute;inset:0}
table{border-collapse:collapse;margin:18px 0 24px;background:#0f172a;border:1px solid #475569}
td,th{padding:9px 14px;border-bottom:1px solid #334155;text-align:left}
th{color:#ffffff;font-weight:750}td{color:#e2e8f0}
.note{max-width:1100px;line-height:1.55;color:#e2e8f0}
.plots{display:grid;grid-template-columns:1fr;gap:28px;max-width:980px}
.plot{margin:0;background:#0f172a;border:1px solid #475569;border-radius:8px;padding:14px}
.plot figcaption{margin:0 0 10px;color:#ffffff;font-weight:750;font-size:20px}
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
</div>
<h2>Horizon Detection Diagnostics</h2>
<p class="note">The fisheye detector searches for a circular horizon center within 10% of the image size
around the midpoint and then looks for the large drop in the peak value of the pixel-intensity
density between the illuminated circular field and the nearly black pixels outside it. The
peak-density statistic is insensitive to sparse station labels, timestamps, and cardinal-direction text.</p>
<div class="plots">
${radialPlot}
${dropPlot}
</div>`;
    const htmlPath = path.join(outDir, `${result.caseId}.html`);
    const jsonPath = path.join(outDir, `${result.caseId}.json`);
    fs.writeFileSync(htmlPath, html);
    fs.writeFileSync(jsonPath, JSON.stringify({
        caseId: result.caseId,
        detection: result.detection,
        reference: result.reference,
        horizonDiagnostic: {
            centerX: horizonDiagnostic.centerX,
            centerY: horizonDiagnostic.centerY,
            step: horizonDiagnostic.step,
            samples: horizonDiagnostic.samples,
            binWidth: horizonDiagnostic.binWidth,
            profile: horizonDiagnostic.profile,
            drops: horizonDiagnostic.drops,
        },
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
