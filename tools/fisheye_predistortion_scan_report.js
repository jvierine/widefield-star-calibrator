#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const AutoIdentifier = require("../js/auto_identifier.js");
const StarDetector = require("../js/star_detector.js");
const {
    AidaTools,
    buildCases,
    readPngImageData,
    testCaseImagePath,
} = require("./generate_test_report.js");

const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "test-report", "fisheye-predistortion-scan");
const DEG = Math.PI / 180;
const BASE_ALPHA_GRID = [0.30, 0.50, 0.60, 0.80, 0.90, 1.00];

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
    return Number.isFinite(value) ? Number(value).toFixed(digits) : "n/a";
}

function mean(values) {
    const finite = values.filter(Number.isFinite);
    return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : NaN;
}

function median(values) {
    const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!finite.length) {
        return NaN;
    }
    const mid = Math.floor(finite.length / 2);
    return finite.length % 2 ? finite[mid] : 0.5 * (finite[mid - 1] + finite[mid]);
}

function skyVectorAzZe(az, ze) {
    const sinze = Math.sin(ze);
    return [
        sinze * Math.sin(az),
        sinze * Math.cos(az),
        Math.cos(ze),
    ];
}

function catalogKey(star) {
    return `${star.name || ""}|${Number(star.raHours).toFixed(7)}|${Number(star.decDeg).toFixed(7)}`;
}

function trueAlpha(testCase) {
    const optpar = testCase.optpar || [];
    return Number(optpar[7]);
}

function alphaGridForCase(testCase) {
    const truth = trueAlpha(testCase);
    const grid = BASE_ALPHA_GRID.slice();
    if (Number.isFinite(truth) && !grid.some(value => Math.abs(value - truth) < 1e-9)) {
        grid.push(truth);
    }
    return grid.sort((a, b) => a - b);
}

function truthRows(testCase, maxMag = 7.5) {
    return (testCase.matches || [])
        .filter(match => match && match.image && match.catalog && Number(match.catalog.mag) <= maxMag)
        .map((match, index) => {
            const raHours = Number(match.catalog.raHours);
            const decDeg = Number(match.catalog.decDeg);
            const azze = AidaTools.radecToAzZe(raHours, decDeg, testCase.date, testCase.latDeg, testCase.lonDeg);
            return {
                id: `truth-${index}`,
                x: Number(match.image.x),
                y: Number(match.image.y),
                raHours,
                decDeg,
                mag: Number(match.catalog.mag),
                name: match.catalog.name || match.catalog.key || "",
                key: match.catalog.key || catalogKey(match.catalog),
                vector: skyVectorAzZe(azze.az, azze.ze),
                az: azze.az,
                ze: azze.ze,
                rank: index + 1,
            };
        })
        .filter(row => Number.isFinite(row.x) && Number.isFinite(row.y) &&
            Number.isFinite(row.raHours) && Number.isFinite(row.decDeg) && Number.isFinite(row.mag))
        .sort((a, b) => a.mag - b.mag || a.key.localeCompare(b.key))
        .slice(0, 90)
        .map((row, index) => ({...row, rank: index + 1}));
}

function detectorOptionsForOptmod2() {
    return {
        maxDetections: 450,
        scanStep: 1,
        requireGlobalThreshold: false,
        maxRadiusPx: 7,
        maxElongation: 4.2,
        suppressionRadiusPx: 12,
        crowdingRadiusPx: 34,
        maxCrowding: 8,
        crowdingScorePower: 1.2,
        spatialBalance: true,
        balanceGridCols: 6,
        balanceGridRows: 4,
        balanceMaxPerCell: 12,
        autoMorphology: true,
        autoMorphologyMaxRadiusPx: 9,
        thresholdSigma: 3.2,
        localThresholdSigma: 3.2,
    };
}

function attachTruth(detections, truth, radiusPx = 16) {
    const used = new Set();
    const tagged = detections.map((detection, index) => {
        let best = null;
        let bestDistance = Infinity;
        for (const row of truth) {
            if (used.has(row.key)) {
                continue;
            }
            const distance = Math.hypot(detection.x - row.x, detection.y - row.y);
            if (distance < bestDistance) {
                best = row;
                bestDistance = distance;
            }
        }
        if (best && bestDistance <= radiusPx) {
            used.add(best.key);
            return {
                ...detection,
                id: detection.id || index + 1,
                truthKey: best.key,
                truthName: best.name,
                truthMag: best.mag,
                truthDistancePx: bestDistance,
            };
        }
        return {...detection, id: detection.id || index + 1};
    });
    return {
        detections: tagged,
        foundTruthKeys: new Set(tagged.filter(row => row.truthKey).map(row => row.truthKey)),
    };
}

function pinholeVector(detection, testCase) {
    const optpar = testCase.optpar || [];
    const f1 = Math.abs(Number(optpar[0]) || 1);
    const f2 = Math.abs(Number(optpar[1]) || testCase.width / Math.max(1, testCase.height));
    const du = Number(optpar[5]) || 0;
    const dv = Number(optpar[6]) || 0;
    const xn = ((detection.x + 1) / testCase.width - 0.5 - du) / f1;
    const yn = ((detection.y + 1) / testCase.height - 0.5 - dv) / f2;
    const n = Math.hypot(xn, yn, 1);
    return [xn / n, yn / n, 1 / n];
}

function optmod2Vector(detection, testCase, radialAlpha) {
    const optpar = testCase.optpar || [];
    const f1 = Math.abs(Number(optpar[0]) || 1);
    const f2 = Math.abs(Number(optpar[1]) || testCase.width / Math.max(1, testCase.height));
    const du = Number(optpar[5]) || 0;
    const dv = Number(optpar[6]) || 0;
    const a = Number(radialAlpha);
    const xn = ((detection.x + 1) / testCase.width - 0.5 - du) / f1;
    const yn = ((detection.y + 1) / testCase.height - 0.5 - dv) / f2;
    const rho = Math.hypot(xn, yn);
    if (!(a > 0) || !Number.isFinite(rho) || rho >= 0.999999) {
        return pinholeVector(detection, testCase);
    }
    if (rho <= 1e-12) {
        return [0, 0, 1];
    }
    const theta = Math.asin(rho) / a;
    const sint = Math.sin(theta);
    const cost = Math.cos(theta);
    const v = [sint * xn / rho, sint * yn / rho, cost];
    const n = Math.hypot(v[0], v[1], v[2]);
    return n > 0 && Number.isFinite(n) ? [v[0] / n, v[1] / n, v[2] / n] : pinholeVector(detection, testCase);
}

function vectorize(points, testCase, radialAlpha) {
    return points.map((point, index) => ({
        ...point,
        id: point.id || index + 1,
        rank: Number.isFinite(point.rank) ? point.rank : index + 1,
        vector: optmod2Vector(point, testCase, radialAlpha),
    }));
}

function farthestFromSet(pool, chosen) {
    let best = null;
    let bestDistance = -Infinity;
    for (const candidate of pool) {
        if (chosen.includes(candidate)) {
            continue;
        }
        const minDistance = Math.min(...chosen.map(point => Math.hypot(candidate.x - point.x, candidate.y - point.y)));
        if (minDistance > bestDistance) {
            bestDistance = minDistance;
            best = candidate;
        }
    }
    return best;
}

function localQuadRecordsFromGrid(points, width, height) {
    const step = Math.max(16, 0.05 * width);
    const seen = new Set();
    const quads = [];
    const imageDiag = Math.hypot(width, height);
    const maxWideRadius = 0.55 * imageDiag;
    const addQuad = quadPoints => {
        if (!quadPoints || quadPoints.length < 4) {
            return;
        }
        const key = quadPoints.map(point => point.id).sort().join("-");
        if (seen.has(key)) {
            return;
        }
        const quad = AutoIdentifier.sphericalQuadRecords(quadPoints, {
            maxQuads: 1,
            maxQuadPoints: 4,
            minSidePx: 1,
            maxSidePx: Infinity,
            minHeightPx: 1,
        })[0];
        if (quad) {
            seen.add(key);
            quads.push(quad);
        }
    };
    for (let y = 0.5 * step; y < height; y += step) {
        for (let x = 0.5 * step; x < width; x += step) {
            const ordered = points
                .map(point => ({point, distance: Math.hypot(point.x - x, point.y - y)}))
                .sort((a, b) => a.distance - b.distance || a.point.rank - b.point.rank);
            if (ordered.length < 4) {
                continue;
            }
            addQuad(ordered.slice(0, 4).map(item => item.point));
            const mediumPool = ordered.slice(0, Math.min(14, ordered.length)).map(item => item.point);
            if (mediumPool.length >= 4) {
                const medium = [mediumPool[0], mediumPool[1]];
                while (medium.length < 4) {
                    const next = farthestFromSet(mediumPool, medium);
                    if (!next) {
                        break;
                    }
                    medium.push(next);
                }
                addQuad(medium);
            }
            const widePool = ordered
                .filter(item => item.distance <= maxWideRadius)
                .slice(0, Math.min(34, ordered.length))
                .map(item => item.point);
            if (widePool.length >= 4) {
                const wide = [widePool[0]];
                while (wide.length < 4) {
                    const next = farthestFromSet(widePool, wide);
                    if (!next) {
                        break;
                    }
                    wide.push(next);
                }
                addQuad(wide);
            }
        }
    }
    return quads;
}

function quadL2(a, b) {
    return Math.hypot(
        b.coords[0] - a.coords[0],
        b.coords[1] - a.coords[1],
        b.coords[2] - a.coords[2],
        b.coords[3] - a.coords[3]
    );
}

function minQuadNorms(imageQuads, catalogQuads) {
    const norms = [];
    for (const imageQuad of imageQuads) {
        let bestNorm = Infinity;
        for (const catalogQuad of catalogQuads) {
            const norm = quadL2(imageQuad, catalogQuad);
            if (norm < bestNorm) {
                bestNorm = norm;
            }
        }
        norms.push(bestNorm);
    }
    return norms;
}

function scoreAlpha(points, testCase, catalogQuads, radialAlpha) {
    const vectorPoints = vectorize(points, testCase, radialAlpha);
    const imageQuads = localQuadRecordsFromGrid(vectorPoints, testCase.width, testCase.height);
    const norms = minQuadNorms(imageQuads, catalogQuads);
    const finiteNorms = norms.filter(Number.isFinite);
    const goodAt004 = finiteNorms.filter(value => value <= 0.04).length;
    return {
        radialAlpha,
        imageQuads: imageQuads.length,
        meanMinL2: mean(finiteNorms),
        medianMinL2: median(finiteNorms),
        p10MinL2: percentile(finiteNorms, 0.10),
        goodAt004,
    };
}

function percentile(values, fraction) {
    const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!finite.length) {
        return NaN;
    }
    const index = Math.min(finite.length - 1, Math.max(0, Math.floor(fraction * (finite.length - 1))));
    return finite[index];
}

function nearestGridAlpha(truth) {
    let best = BASE_ALPHA_GRID[0];
    let bestDistance = Math.abs(best - truth);
    for (const alpha of BASE_ALPHA_GRID) {
        const distance = Math.abs(alpha - truth);
        if (distance < bestDistance) {
            best = alpha;
            bestDistance = distance;
        }
    }
    return best;
}

function bestTrial(trials, key = "meanMinL2", gridOnly = false) {
    return trials
        .filter(trial => !gridOnly || BASE_ALPHA_GRID.some(alpha => Math.abs(alpha - trial.radialAlpha) < 1e-9))
        .filter(trial => Number.isFinite(trial[key]))
        .sort((a, b) => a[key] - b[key] || a.radialAlpha - b.radialAlpha)[0] || null;
}

async function detectorPoints(testCase, truth) {
    const imagePath = testCaseImagePath(testCase);
    if (!imagePath || !fs.existsSync(imagePath)) {
        return null;
    }
    const imageData = readPngImageData(imagePath);
    const result = await StarDetector.detectBrightStars(imageData, detectorOptionsForOptmod2());
    return {
        label: "detector",
        points: attachTruth(result.detections, truth, 16).detections,
        count: result.detections.length,
        detectorStatus: result.status,
    };
}

async function analyzeCase(testCase) {
    const truth = truthRows(testCase);
    if (testCase.optmod !== 2 || truth.length < 4 || !Number.isFinite(trueAlpha(testCase))) {
        return null;
    }
    const catalogQuads = AutoIdentifier.sphericalQuadRecords(truth, {
        maxQuads: 16000,
        maxQuadPoints: truth.length,
        localNeighborPoolSize: 18,
        localQuadMaxSideDeg: 75,
    });
    if (!catalogQuads.length) {
        return null;
    }
    const modes = [{
        label: "oracle saved pairings",
        points: truth,
        count: truth.length,
        detectorStatus: "saved truth stars",
    }];
    const detected = await detectorPoints(testCase, truth);
    if (detected && detected.points.length >= 4) {
        modes.push(detected);
    }
    const alphas = alphaGridForCase(testCase);
    return {
        id: testCase.id,
        image: testCase.image,
        width: testCase.width,
        height: testCase.height,
        truthAlpha: trueAlpha(testCase),
        nearestGridAlpha: nearestGridAlpha(trueAlpha(testCase)),
        truthStars: truth.length,
        catalogQuads: catalogQuads.length,
        modes: modes.map(mode => {
            const trials = alphas.map(alpha => scoreAlpha(mode.points, testCase, catalogQuads, alpha));
            const gridWinner = bestTrial(trials, "meanMinL2", true);
            const exactWinner = bestTrial(trials, "meanMinL2", false);
            const medianWinner = bestTrial(trials, "medianMinL2", true);
            return {
                label: mode.label,
                pointCount: mode.count,
                detectorStatus: mode.detectorStatus,
                trials,
                gridWinner,
                exactWinner,
                medianWinner,
                gridWinnerIsNearestTruth: Boolean(gridWinner &&
                    Math.abs(gridWinner.radialAlpha - nearestGridAlpha(trueAlpha(testCase))) < 1e-9),
            };
        }),
    };
}

function scoreCurveSvg(mode, truthAlpha, nearestGrid) {
    const trials = mode.trials.filter(trial => Number.isFinite(trial.meanMinL2));
    if (!trials.length) {
        return "";
    }
    const width = 420;
    const height = 170;
    const pad = 32;
    const minX = Math.min(...trials.map(t => t.radialAlpha));
    const maxX = Math.max(...trials.map(t => t.radialAlpha));
    const maxY = Math.max(...trials.map(t => t.meanMinL2));
    const minY = Math.min(...trials.map(t => t.meanMinL2));
    const x = value => pad + (value - minX) / Math.max(1e-9, maxX - minX) * (width - 2 * pad);
    const y = value => height - pad - (value - minY) / Math.max(1e-9, maxY - minY) * (height - 2 * pad);
    const points = trials.map(trial => `${x(trial.radialAlpha)},${y(trial.meanMinL2)}`).join(" ");
    const circles = trials.map(trial => {
        const isTruth = Math.abs(trial.radialAlpha - truthAlpha) < 1e-9;
        const isGrid = Math.abs(trial.radialAlpha - nearestGrid) < 1e-9;
        const fill = isTruth ? "#16a34a" : isGrid ? "#2563eb" : "#111827";
        return `<circle cx="${x(trial.radialAlpha)}" cy="${y(trial.meanMinL2)}" r="${isTruth || isGrid ? 4 : 3}" fill="${fill}"><title>a_r=${fmt(trial.radialAlpha, 4)}, mean=${fmt(trial.meanMinL2, 5)}</title></circle>`;
    }).join("");
    return `<svg class="curve" viewBox="0 0 ${width} ${height}" role="img">
<rect x="0" y="0" width="${width}" height="${height}" fill="#fff"/>
<line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" stroke="#64748b"/>
<line x1="${pad}" y1="${pad}" x2="${pad}" y2="${height - pad}" stroke="#64748b"/>
<polyline points="${points}" fill="none" stroke="#0f766e" stroke-width="2"/>
${circles}
<text x="${pad}" y="${height - 8}" font-size="11">a_r</text>
<text x="6" y="${pad - 10}" font-size="11">mean min L2</text>
<text x="${x(truthAlpha) + 5}" y="${pad + 12}" font-size="11" fill="#16a34a">truth</text>
</svg>`;
}

function pageHtml(results) {
    const flat = results.flatMap(result => result.modes.map(mode => ({result, mode})));
    const oracleRows = flat.filter(row => row.mode.label === "oracle saved pairings");
    const detectorRows = flat.filter(row => row.mode.label === "detector");
    const agreement = rows => {
        const valid = rows.filter(row => row.mode.gridWinner);
        const good = valid.filter(row => row.mode.gridWinnerIsNearestTruth);
        return `${good.length}/${valid.length}`;
    };
    const meanGridError = rows => {
        const values = rows
            .filter(row => row.mode.gridWinner)
            .map(row => Math.abs(row.mode.gridWinner.radialAlpha - row.result.truthAlpha));
        return mean(values);
    };
    const summaryRows = flat.map(({result, mode}) => `<tr>
<td>${escapeHtml(result.id)}</td>
<td>${escapeHtml(mode.label)}</td>
<td>${result.truthStars}</td>
<td>${mode.pointCount}</td>
<td>${fmt(result.truthAlpha, 4)}</td>
<td>${fmt(result.nearestGridAlpha, 2)}</td>
<td>${mode.gridWinner ? fmt(mode.gridWinner.radialAlpha, 2) : "n/a"}</td>
<td>${mode.gridWinnerIsNearestTruth ? "yes" : "no"}</td>
<td>${mode.gridWinner ? fmt(mode.gridWinner.meanMinL2, 5) : "n/a"}</td>
<td>${mode.exactWinner ? fmt(mode.exactWinner.radialAlpha, 4) : "n/a"}</td>
<td>${mode.exactWinner ? fmt(mode.exactWinner.meanMinL2, 5) : "n/a"}</td>
</tr>`).join("\n");
    const details = results.map(result => `<section>
<h2>${escapeHtml(result.id)}</h2>
<p>True <code>a_r</code>: <b>${fmt(result.truthAlpha, 5)}</b>. Nearest production-grid value: <b>${fmt(result.nearestGridAlpha, 2)}</b>. Truth stars: ${result.truthStars}. Oracle catalogue quads: ${result.catalogQuads}.</p>
${result.modes.map(mode => `<h3>${escapeHtml(mode.label)}</h3>
${scoreCurveSvg(mode, result.truthAlpha, result.nearestGridAlpha)}
<table><thead><tr><th>a_r</th><th>image quads</th><th>mean min L2</th><th>median min L2</th><th>p10 min L2</th><th>quads <= 0.04</th></tr></thead>
<tbody>${mode.trials.map(trial => `<tr class="${Math.abs(trial.radialAlpha - result.truthAlpha) < 1e-9 ? "truth" : ""}">
<td>${fmt(trial.radialAlpha, 5)}</td>
<td>${trial.imageQuads}</td>
<td>${fmt(trial.meanMinL2, 5)}</td>
<td>${fmt(trial.medianMinL2, 5)}</td>
<td>${fmt(trial.p10MinL2, 5)}</td>
<td>${trial.goodAt004}</td>
</tr>`).join("\n")}</tbody></table>`).join("\n")}
</section>`).join("\n");
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>WISC fisheye predistortion scan report</title>
<style>
body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:24px;color:#111827;background:#f8fafc}
h1,h2,h3{color:#111827}
table{border-collapse:collapse;width:100%;margin:14px 0;background:white}
th,td{border:1px solid #d0d7e2;padding:6px 8px;text-align:left;vertical-align:top;font-size:13px}
th{background:#e9eef7}
section{margin:28px 0;padding-top:8px;border-top:2px solid #dbe3ef}
.note{max-width:1050px;line-height:1.45}
code{background:#eef2f7;padding:2px 4px;border-radius:3px}
.truth{background:#ecfdf5}
.curve{width:420px;height:170px;border:1px solid #d0d7e2;background:white}
</style>
</head>
<body>
<h1>WISC Fisheye Predistortion Scan Report</h1>
<p class="note">This report asks whether the optmod 2 pre-dedistortion scan chooses the same radial parameter as the known saved lens model. The score is the mean of the nearest catalogue-quad L2 distance for each local image quad. The production grid is <code>${BASE_ALPHA_GRID.join(", ")}</code>; the exact truth value is also inserted into each curve as a green point so we can see whether the metric itself prefers the known solution.</p>
<p class="note"><b>Oracle agreement:</b> ${agreement(oracleRows)} cases selected the nearest production-grid value to truth, mean absolute grid error ${fmt(meanGridError(oracleRows), 4)}. <b>Detector agreement:</b> ${agreement(detectorRows)} cases selected the nearest production-grid value to truth, mean absolute grid error ${fmt(meanGridError(detectorRows), 4)}.</p>
<h2>Summary</h2>
<table><thead><tr><th>case</th><th>mode</th><th>truth stars</th><th>points</th><th>true a_r</th><th>nearest grid</th><th>grid winner</th><th>winner is nearest truth?</th><th>winner mean L2</th><th>exact winner</th><th>exact mean L2</th></tr></thead>
<tbody>${summaryRows}</tbody></table>
${details}
</body>
</html>`;
}

async function main() {
    fs.mkdirSync(OUT_DIR, {recursive: true});
    const cases = buildCases()
        .filter(testCase => testCase.optmod === 2 && Number.isFinite(trueAlpha(testCase)) && (testCase.matches || []).length >= 4)
        .sort((a, b) => a.id.localeCompare(b.id));
    console.log(`Studying fisheye predistortion scan on ${cases.length} known optmod 2 cases`);
    const results = [];
    for (const testCase of cases) {
        process.stdout.write(`  ${testCase.id} ... `);
        const result = await analyzeCase(testCase);
        if (result) {
            results.push(result);
            const oracle = result.modes.find(mode => mode.label === "oracle saved pairings");
            console.log(`truth a_r=${fmt(result.truthAlpha, 4)}, grid winner=${oracle && oracle.gridWinner ? fmt(oracle.gridWinner.radialAlpha, 2) : "n/a"}`);
        } else {
            console.log("skipped");
        }
    }
    fs.writeFileSync(path.join(OUT_DIR, "summary.json"), JSON.stringify(results, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, "index.html"), pageHtml(results));
    console.log(`Report: ${path.join(OUT_DIR, "index.html")}`);
}

if (require.main === module) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}

module.exports = {
    analyzeCase,
    scoreAlpha,
};
