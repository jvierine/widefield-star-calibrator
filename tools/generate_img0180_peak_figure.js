#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const StarDetector = require("../js/star_detector.js");
const Centroid = require("../js/centroid.js");

const ROOT = path.resolve(__dirname, "..");
const IMAGE_PATH = path.join(ROOT, "calibration_images", "IMG_0180.png");
const OUT_DIR = path.join(ROOT, "doc", "figures");
const OUT_SVG = path.join(OUT_DIR, "img0180_star_peak_measurement.svg");
const OUT_PNG = path.join(OUT_DIR, "img0180_star_peak_measurement.png");

const DETECTOR_OPTIONS = {
    maxDetections: 80,
    thresholdSigma: 1.8,
    localThresholdSigma: 1.8,
    requireGlobalThreshold: false,
    maxRadiusPx: 5,
    maxElongation: 4.0,
    suppressionRadiusPx: 10,
    crowdingRadiusPx: 36,
    maxCrowding: 7,
    crowdingScorePower: 1.25,
};

function esc(value) {
    return String(value).replace(/[&<>"']/g, c => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;",
    }[c]));
}

function grayAt(image, x, y) {
    const ix = Math.max(0, Math.min(image.width - 1, Math.round(x)));
    const iy = Math.max(0, Math.min(image.height - 1, Math.round(y)));
    const k = 4 * (iy * image.width + ix);
    const data = image.data;
    return 0.2126 * data[k] + 0.7152 * data[k + 1] + 0.0722 * data[k + 2];
}

function bilinearGray(image, x, y) {
    const x0 = Math.floor(Math.max(0, Math.min(image.width - 1, x)));
    const y0 = Math.floor(Math.max(0, Math.min(image.height - 1, y)));
    const x1 = Math.min(image.width - 1, x0 + 1);
    const y1 = Math.min(image.height - 1, y0 + 1);
    const tx = Math.max(0, Math.min(1, x - x0));
    const ty = Math.max(0, Math.min(1, y - y0));
    const g00 = grayAt(image, x0, y0);
    const g10 = grayAt(image, x1, y0);
    const g01 = grayAt(image, x0, y1);
    const g11 = grayAt(image, x1, y1);
    return (1 - tx) * (1 - ty) * g00 + tx * (1 - ty) * g10 + (1 - tx) * ty * g01 + tx * ty * g11;
}

function colorMap(t) {
    const stops = [
        [12, 16, 32],
        [31, 75, 122],
        [42, 157, 143],
        [233, 196, 106],
        [252, 244, 210],
    ];
    const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(x));
    const f = x - i;
    const c = stops[i].map((v, k) => Math.round(v * (1 - f) + stops[i + 1][k] * f));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function heatmapRects(values, width, height, x0, y0, w, h, minValue, maxValue, stride = 1) {
    const rects = [];
    const denom = Math.max(1e-9, maxValue - minValue);
    const cellW = w / Math.ceil(width / stride);
    const cellH = h / Math.ceil(height / stride);
    for (let y = 0; y < height; y += stride) {
        for (let x = 0; x < width; x += stride) {
            let sum = 0;
            let n = 0;
            for (let yy = y; yy < Math.min(height, y + stride); yy += 1) {
                for (let xx = x; xx < Math.min(width, x + stride); xx += 1) {
                    sum += values[yy * width + xx];
                    n += 1;
                }
            }
            const t = (sum / n - minValue) / denom;
            rects.push(`<rect x="${(x0 + (x / stride) * cellW).toFixed(2)}" y="${(y0 + (y / stride) * cellH).toFixed(2)}" width="${(cellW + 0.15).toFixed(2)}" height="${(cellH + 0.15).toFixed(2)}" fill="${colorMap(t)}"/>`);
        }
    }
    return rects.join("\n");
}

function percentile(values, p) {
    const sorted = values.slice().sort((a, b) => a - b);
    if (!sorted.length) {
        return NaN;
    }
    const idx = Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * p)));
    return sorted[idx];
}

function radialProfile(image, detection, maxRadius = 16, binWidth = 1) {
    const bins = Array.from({length: Math.ceil(maxRadius / binWidth)}, () => []);
    const rMax = Math.ceil(maxRadius);
    for (let dy = -rMax; dy <= rMax; dy += 1) {
        for (let dx = -rMax; dx <= rMax; dx += 1) {
            const r = Math.hypot(dx, dy);
            const bin = Math.floor(r / binWidth);
            if (bin >= 0 && bin < bins.length) {
                bins[bin].push(grayAt(image, detection.x + dx, detection.y + dy));
            }
        }
    }
    return bins.map((values, i) => ({
        r: (i + 0.5) * binWidth,
        median: percentile(values, 0.5),
        p25: percentile(values, 0.25),
        p75: percentile(values, 0.75),
    }));
}

function polyline(points) {
    return points.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
}

function plotRadialProfile(profile, detection, x0, y0, w, h) {
    const yMin = Math.min(detection.background - 10, ...profile.map(p => p.p25));
    const yMax = Math.max(detection.peak + 8, ...profile.map(p => p.p75));
    const sx = r => x0 + (r / 16) * w;
    const sy = v => y0 + h - ((v - yMin) / (yMax - yMin)) * h;
    const medianPoints = profile.map(p => ({x: sx(p.r), y: sy(p.median)}));
    const upperPoints = profile.map(p => ({x: sx(p.r), y: sy(p.p75)}));
    const lowerPoints = profile.slice().reverse().map(p => ({x: sx(p.r), y: sy(p.p25)}));
    const bgY = sy(detection.background);
    const apertureX = sx(5);
    const annulusInnerX = sx(6);
    const annulusOuterX = sx(12);
    return `
      <rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="#ffffff" stroke="#cbd5e1"/>
      <line x1="${x0}" y1="${bgY.toFixed(2)}" x2="${x0 + w}" y2="${bgY.toFixed(2)}" stroke="#64748b" stroke-dasharray="7 5"/>
      <rect x="${annulusInnerX.toFixed(2)}" y="${y0}" width="${(annulusOuterX - annulusInnerX).toFixed(2)}" height="${h}" fill="#fef3c7" opacity="0.55"/>
      <line x1="${apertureX.toFixed(2)}" y1="${y0}" x2="${apertureX.toFixed(2)}" y2="${y0 + h}" stroke="#ef4444" stroke-dasharray="6 4"/>
      <polygon points="${polyline(upperPoints.concat(lowerPoints))}" fill="#93c5fd" opacity="0.38"/>
      <polyline points="${polyline(medianPoints)}" fill="none" stroke="#1d4ed8" stroke-width="3"/>
      <text x="${x0}" y="${y0 + h + 28}" class="axis">radius from measured centroid (px)</text>
      <text x="${x0 - 8}" y="${y0 - 12}" class="axis">gray value</text>
      <text x="${x0 + apertureX - x0 + 8}" y="${y0 + 18}" class="tiny">aperture</text>
      <text x="${annulusInnerX + 8}" y="${y0 + h - 12}" class="tiny">background annulus</text>
      <text x="${x0 + 8}" y="${bgY - 8}" class="tiny">local background</text>
    `;
}

function renderMetrics(detection, x0, y0) {
    const rows = [
        ["peak", detection.peak.toFixed(1)],
        ["local bg", detection.background.toFixed(1)],
        ["local SNR", detection.localSnr.toFixed(1)],
        ["matched SNR", detection.matchedFilterSnr.toFixed(1)],
        ["flux", detection.flux.toFixed(0)],
        ["radius", `${detection.radius.toFixed(2)} px`],
        ["elongation", detection.elongation.toFixed(2)],
        ["core flux", detection.coreFluxFraction.toFixed(2)],
        ["outer flux", detection.outerFluxFraction.toFixed(2)],
        ["peak dominance", detection.peakDominance.toFixed(2)],
        ["score", detection.score.toFixed(1)],
    ];
    return rows.map((row, i) => `
      <text x="${x0}" y="${y0 + i * 24}" class="metric-key">${esc(row[0])}</text>
      <text x="${x0 + 160}" y="${y0 + i * 24}" class="metric-value">${esc(row[1])}</text>
    `).join("\n");
}

async function main() {
    fs.mkdirSync(OUT_DIR, {recursive: true});
    const {data, info} = await sharp(IMAGE_PATH).ensureAlpha().raw().toBuffer({resolveWithObject: true});
    const image = {data, width: info.width, height: info.height};
    const result = await StarDetector.detectBrightStars(image, DETECTOR_OPTIONS);
    const detection = result.detections.find(d =>
        d.x > 180 && d.y > 180 && d.x < image.width - 180 && d.y < image.height * 0.67 &&
        d.localSnr > 15 && d.radius > 2 && d.radius < 4.5
    ) || result.detections[0];

    const patchRadius = 16;
    const patchSize = 2 * patchRadius + 1;
    const patchValues = new Float32Array(patchSize * patchSize);
    for (let py = 0; py < patchSize; py += 1) {
        for (let px = 0; px < patchSize; px += 1) {
            patchValues[py * patchSize + px] = grayAt(
                image,
                Math.round(detection.x) - patchRadius + px,
                Math.round(detection.y) - patchRadius + py
            );
        }
    }

    const density = Centroid.estimateCentroid(
        detection.x,
        detection.y,
        (x, y) => bilinearGray(image, x, y),
        {patchRadius: 8, upsample: 40, imageWidth: image.width}
    ).density;
    const profile = radialProfile(image, detection);

    const thumbWidth = 445;
    const thumbHeight = Math.round(image.height * thumbWidth / image.width);
    const thumbPng = await sharp(IMAGE_PATH)
        .resize({width: thumbWidth})
        .modulate({brightness: 1.08, saturation: 0.72})
        .png()
        .toBuffer();
    const thumbHref = `data:image/png;base64,${thumbPng.toString("base64")}`;
    const thumbX = 60;
    const thumbY = 115;
    const thumbScale = thumbWidth / image.width;
    const detThumbX = thumbX + detection.x * thumbScale;
    const detThumbY = thumbY + detection.y * thumbScale;

    const patchX = 575;
    const patchY = 115;
    const patchW = 360;
    const patchH = 360;
    const densX = 990;
    const densY = 115;
    const densW = 360;
    const densH = 360;
    const plotX = 575;
    const plotY = 575;
    const plotW = 475;
    const plotH = 295;

    const patchMin = percentile(Array.from(patchValues), 0.02);
    const patchMax = percentile(Array.from(patchValues), 0.99);
    const densityValues = Array.from(density.values);
    const densityMin = percentile(densityValues, 0.01);
    const densityMax = percentile(densityValues, 0.995);
    const cPatchX = patchX + patchW / 2 + (detection.x - Math.round(detection.x)) * (patchW / patchSize);
    const cPatchY = patchY + patchH / 2 + (detection.y - Math.round(detection.y)) * (patchH / patchSize);
    const peakPatchX = patchX + patchW / 2;
    const peakPatchY = patchY + patchH / 2;
    const apertureRadiusSvg = 5 * patchW / patchSize;
    const annulusInnerSvg = 6 * patchW / patchSize;
    const annulusOuterSvg = 12 * patchW / patchSize;
    const selectedDensityX = densX + density.selectedFineX / (density.width - 1) * densW;
    const selectedDensityY = densY + density.selectedFineY / (density.height - 1) * densH;

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="980" viewBox="0 0 1400 980">
<style>
  .title { font: 700 28px Helvetica, Arial, sans-serif; fill: #0f172a; }
  .subtitle { font: 16px Helvetica, Arial, sans-serif; fill: #475569; }
  .panel { font: 700 18px Helvetica, Arial, sans-serif; fill: #0f172a; }
  .axis { font: 14px Helvetica, Arial, sans-serif; fill: #334155; }
  .tiny { font: 12px Helvetica, Arial, sans-serif; fill: #334155; }
  .metric-key { font: 15px Helvetica, Arial, sans-serif; fill: #475569; }
  .metric-value { font: 700 15px Helvetica, Arial, sans-serif; fill: #0f172a; }
</style>
<rect width="1400" height="930" fill="#ffffff"/>
<text x="60" y="48" class="title">Star peak measurement in IMG_0180</text>
<text x="60" y="78" class="subtitle">Detected sky peak rank ${detection.rank}; image position (${detection.x.toFixed(2)}, ${detection.y.toFixed(2)}) px; ${result.scannedLocalPeaks} local maxima scanned, ${result.candidates.length} star-like candidates, ${result.detections.length} retained detections.</text>

<text x="${thumbX}" y="${thumbY - 20}" class="panel">A. Full image context</text>
<image x="${thumbX}" y="${thumbY}" width="${thumbWidth}" height="${thumbHeight}" href="${thumbHref}"/>
<circle cx="${detThumbX.toFixed(2)}" cy="${detThumbY.toFixed(2)}" r="13" fill="none" stroke="#facc15" stroke-width="4"/>
<line x1="${(detThumbX - 22).toFixed(2)}" y1="${detThumbY.toFixed(2)}" x2="${(detThumbX + 22).toFixed(2)}" y2="${detThumbY.toFixed(2)}" stroke="#facc15" stroke-width="3"/>
<line x1="${detThumbX.toFixed(2)}" y1="${(detThumbY - 22).toFixed(2)}" x2="${detThumbX.toFixed(2)}" y2="${(detThumbY + 22).toFixed(2)}" stroke="#facc15" stroke-width="3"/>

<text x="${patchX}" y="${patchY - 20}" class="panel">B. Local gray-value patch</text>
${heatmapRects(patchValues, patchSize, patchSize, patchX, patchY, patchW, patchH, patchMin, patchMax, 1)}
<rect x="${patchX}" y="${patchY}" width="${patchW}" height="${patchH}" fill="none" stroke="#0f172a" stroke-width="1.5"/>
<circle cx="${cPatchX.toFixed(2)}" cy="${cPatchY.toFixed(2)}" r="${apertureRadiusSvg.toFixed(2)}" fill="none" stroke="#ef4444" stroke-width="2.5"/>
<circle cx="${cPatchX.toFixed(2)}" cy="${cPatchY.toFixed(2)}" r="${annulusInnerSvg.toFixed(2)}" fill="none" stroke="#f59e0b" stroke-width="2" stroke-dasharray="7 5"/>
<circle cx="${cPatchX.toFixed(2)}" cy="${cPatchY.toFixed(2)}" r="${annulusOuterSvg.toFixed(2)}" fill="none" stroke="#f59e0b" stroke-width="2" stroke-dasharray="7 5"/>
<line x1="${(cPatchX - 16).toFixed(2)}" y1="${cPatchY.toFixed(2)}" x2="${(cPatchX + 16).toFixed(2)}" y2="${cPatchY.toFixed(2)}" stroke="#111827" stroke-width="3"/>
<line x1="${cPatchX.toFixed(2)}" y1="${(cPatchY - 16).toFixed(2)}" x2="${cPatchX.toFixed(2)}" y2="${(cPatchY + 16).toFixed(2)}" stroke="#111827" stroke-width="3"/>
<circle cx="${peakPatchX}" cy="${peakPatchY}" r="5" fill="#fef08a" stroke="#0f172a"/>
<text x="${patchX}" y="${patchY + patchH + 24}" class="tiny">black cross: centroid; yellow dot: local maximum;</text>
<text x="${patchX}" y="${patchY + patchH + 42}" class="tiny">red circle: flux aperture; dashed: background annulus</text>

<text x="${densX}" y="${densY - 20}" class="panel">C. Upsampled peak density</text>
${heatmapRects(density.values, density.width, density.height, densX, densY, densW, densH, densityMin, densityMax, 8)}
<rect x="${densX}" y="${densY}" width="${densW}" height="${densH}" fill="none" stroke="#0f172a" stroke-width="1.5"/>
<line x1="${(selectedDensityX - 18).toFixed(2)}" y1="${selectedDensityY.toFixed(2)}" x2="${(selectedDensityX + 18).toFixed(2)}" y2="${selectedDensityY.toFixed(2)}" stroke="#fef08a" stroke-width="3"/>
<line x1="${selectedDensityX.toFixed(2)}" y1="${(selectedDensityY - 18).toFixed(2)}" x2="${selectedDensityX.toFixed(2)}" y2="${(selectedDensityY + 18).toFixed(2)}" stroke="#fef08a" stroke-width="3"/>
<text x="${densX}" y="${densY + densH + 24}" class="tiny">background-subtracted, smoothed, 40x upsampled</text>
<text x="${densX}" y="${densY + densH + 42}" class="tiny">density used for subpixel picking</text>

<text x="${plotX}" y="${plotY - 20}" class="panel">D. Radial profile and accepted shape metrics</text>
${plotRadialProfile(profile, detection, plotX, plotY, plotW, plotH)}
${renderMetrics(detection, 1100, plotY + 18)}
</svg>`;

    fs.writeFileSync(OUT_SVG, svg);
    await sharp(Buffer.from(svg)).png({compressionLevel: 9}).toFile(OUT_PNG);
    console.log(`Wrote ${path.relative(ROOT, OUT_SVG)}`);
    console.log(`Wrote ${path.relative(ROOT, OUT_PNG)}`);
}

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
