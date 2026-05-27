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
const OUT_DIR = path.join(ROOT, "test-report", "lucky-first-stage-survival");
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

function detectorRecipes(optmod) {
    const common = {
        scanStep: 1,
        requireGlobalThreshold: false,
        maxRadiusPx: optmod === 2 ? 7 : 5,
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
        autoMorphologyMaxRadiusPx: optmod === 2 ? 9 : 7,
    };
    return [
        {
            label: "strict balanced",
            maxDetections: 450,
            options: {...common, thresholdSigma: 3.2, localThresholdSigma: 3.2},
        },
        {
            label: "weak balanced",
            maxDetections: 650,
            options: {...common, thresholdSigma: 1.55, localThresholdSigma: 1.65},
        },
        {
            label: "weak top-score",
            maxDetections: 650,
            options: {
                ...common,
                thresholdSigma: 1.55,
                localThresholdSigma: 1.65,
                spatialBalance: false,
            },
        },
    ];
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
    const f1 = Math.abs(Number(optpar[1]) || 1);
    const f2 = Math.abs(Number(optpar[2]) || testCase.width / Math.max(1, testCase.height));
    const du = Number(optpar[6]) || 0;
    const dv = Number(optpar[7]) || 0;
    const xn = ((detection.x + 1) / testCase.width - 0.5 - du) / f1;
    const yn = ((detection.y + 1) / testCase.height - 0.5 - dv) / f2;
    const n = Math.hypot(xn, yn, 1);
    return [xn / n, yn / n, 1 / n];
}

function optmod2Vector(detection, testCase, radialAlpha) {
    const optpar = testCase.optpar || [];
    const f1 = Math.abs(Number(optpar[1]) || 1);
    const f2 = Math.abs(Number(optpar[2]) || testCase.width / Math.max(1, testCase.height));
    const du = Number(optpar[6]) || 0;
    const dv = Number(optpar[7]) || 0;
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

function vectorizeDetections(detections, testCase, radialAlpha = null) {
    return detections.map((detection, index) => ({
        ...detection,
        id: detection.id || index + 1,
        rank: Number.isFinite(detection.rank) ? detection.rank : index + 1,
        vector: testCase.optmod === 2 && Number.isFinite(radialAlpha) ?
            optmod2Vector(detection, testCase, radialAlpha) :
            pinholeVector(detection, testCase),
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

function bestQuadMatches(imageQuads, catalogQuads, threshold) {
    const good = [];
    const norms = [];
    for (const imageQuad of imageQuads) {
        let bestNorm = Infinity;
        let bestQuad = null;
        for (const catalogQuad of catalogQuads) {
            const norm = quadL2(imageQuad, catalogQuad);
            if (norm < bestNorm) {
                bestNorm = norm;
                bestQuad = catalogQuad;
            }
        }
        norms.push(bestNorm);
        if (bestQuad && bestNorm <= threshold) {
            good.push({imageQuad, catalogQuad: bestQuad, norm: bestNorm});
        }
    }
    return {good, norms};
}

function selectPreflatten(detections, testCase, catalogQuads) {
    const candidates = testCase.optmod === 2 ? [0.30, 0.50, 0.60, 0.80, 0.90, 1.00] : [null];
    let best = null;
    for (const radialAlpha of candidates) {
        const vectorDetections = vectorizeDetections(detections, testCase, radialAlpha);
        const imageQuads = localQuadRecordsFromGrid(vectorDetections, testCase.width, testCase.height);
        const norms = bestQuadMatches(imageQuads, catalogQuads, Infinity).norms;
        const score = median(norms);
        const trial = {radialAlpha, vectorDetections, imageQuads, score};
        if (!best || trial.score < best.score) {
            best = trial;
        }
    }
    return best;
}

function survivalStats(truth, foundTruthKeys, goodMatches) {
    const inGoodQuad = new Set();
    const correctlyPaired = new Set();
    for (const match of goodMatches) {
        const imagePoints = match.imageQuad.points || [];
        const catalogPoints = match.catalogQuad.points || [];
        for (let i = 0; i < Math.min(4, imagePoints.length, catalogPoints.length); i += 1) {
            if (imagePoints[i].truthKey) {
                inGoodQuad.add(imagePoints[i].truthKey);
                if (imagePoints[i].truthKey === catalogPoints[i].key) {
                    correctlyPaired.add(imagePoints[i].truthKey);
                }
            }
        }
    }
    const truthKeys = new Set(truth.map(row => row.key));
    return {
        truth: truthKeys.size,
        found: foundTruthKeys.size,
        inGoodQuad: Array.from(inGoodQuad).filter(key => truthKeys.has(key)).length,
        correctlyPaired: Array.from(correctlyPaired).filter(key => truthKeys.has(key)).length,
    };
}

async function analyzeCase(testCase) {
    const imagePath = testCaseImagePath(testCase);
    if (!imagePath || !fs.existsSync(imagePath)) {
        return null;
    }
    const truth = truthRows(testCase);
    if (truth.length < 4) {
        return null;
    }
    const imageData = readPngImageData(imagePath);
    const catalogQuads = AutoIdentifier.sphericalQuadRecords(truth, {
        maxQuads: 12000,
        maxQuadPoints: truth.length,
        localNeighborPoolSize: 18,
        localQuadMaxSideDeg: 75,
    });
    const rows = [];
    for (const recipe of detectorRecipes(testCase.optmod)) {
        const result = await StarDetector.detectBrightStars(imageData, {
            maxDetections: recipe.maxDetections,
            ...recipe.options,
        });
        const tagged = attachTruth(result.detections, truth, 16);
        const pre = selectPreflatten(tagged.detections, testCase, catalogQuads);
        for (const threshold of [0.02, 0.04, 0.08]) {
            const matched = bestQuadMatches(pre.imageQuads, catalogQuads, threshold);
            const survival = survivalStats(truth, tagged.foundTruthKeys, matched.good);
            rows.push({
                recipe: recipe.label,
                threshold,
                selectedDetections: result.detections.length,
                detectorStatus: result.status,
                radialAlpha: pre.radialAlpha,
                imageQuads: pre.imageQuads.length,
                goodQuads: matched.good.length,
                medianBestL2: median(matched.norms),
                ...survival,
            });
        }
    }
    rows.sort((a, b) =>
        b.correctlyPaired - a.correctlyPaired ||
        b.inGoodQuad - a.inGoodQuad ||
        b.found - a.found ||
        a.threshold - b.threshold
    );
    return {testCase, truthCount: truth.length, rows};
}

function pct(num, den) {
    return den > 0 ? `${fmt(100 * num / den, 0)}%` : "n/a";
}

function pageHtml(results) {
    const summaryRows = results.map(item => {
        const best = item.rows[0];
        return `<tr>
<td>${escapeHtml(item.testCase.id)}</td>
<td>${item.testCase.optmod}</td>
<td>${item.truthCount}</td>
<td>${escapeHtml(best.recipe)}</td>
<td>${best.selectedDetections}</td>
<td>${best.found}/${best.truth} (${pct(best.found, best.truth)})</td>
<td>${best.inGoodQuad}/${best.found} (${pct(best.inGoodQuad, best.found)})</td>
<td>${best.correctlyPaired}/${best.found} (${pct(best.correctlyPaired, best.found)})</td>
<td>${fmt(best.radialAlpha, 2)}</td>
<td>${best.threshold}</td>
<td>${fmt(best.medianBestL2, 4)}</td>
</tr>`;
    }).join("\n");
    const details = results.map(item => `<section>
<h2>${escapeHtml(item.testCase.id)}</h2>
<table><thead><tr><th>recipe</th><th>L2 cutoff</th><th>detections</th><th>truth found</th><th>found truth in good quad</th><th>correctly paired by best quad</th><th>a_r</th><th>image quads</th><th>good quads</th><th>median best L2</th></tr></thead>
<tbody>${item.rows.map(row => `<tr>
<td>${escapeHtml(row.recipe)}</td>
<td>${row.threshold}</td>
<td>${row.selectedDetections}</td>
<td>${row.found}/${row.truth} (${pct(row.found, row.truth)})</td>
<td>${row.inGoodQuad}/${row.found} (${pct(row.inGoodQuad, row.found)})</td>
<td>${row.correctlyPaired}/${row.found} (${pct(row.correctlyPaired, row.found)})</td>
<td>${fmt(row.radialAlpha, 2)}</td>
<td>${row.imageQuads}</td>
<td>${row.goodQuads}</td>
<td>${fmt(row.medianBestL2, 4)}</td>
</tr>`).join("\n")}</tbody></table>
</section>`).join("\n");
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>WISC lucky first-stage survival report</title>
<style>
body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:24px;color:#111827;background:#f8fafc}
h1,h2{color:#111827}
table{border-collapse:collapse;width:100%;margin:14px 0;background:white}
th,td{border:1px solid #d0d7e2;padding:6px 8px;text-align:left;vertical-align:top;font-size:13px}
th{background:#e9eef7}
.note{max-width:1050px;line-height:1.45}
code{background:#eef2f7;padding:2px 4px;border-radius:3px}
</style>
</head>
<body>
<h1>WISC lucky first-stage survival report</h1>
<p class="note">This report uses saved test-case star pairings as the oracle. It answers a narrow question: before any fitting or later ranking, how many known good stars survive star detection and the blind quad L2 filter? The catalogue used for the quad filter is the saved paired-star set itself, so catalogue incompleteness is not part of this report.</p>
<p class="note">No GUI lucky path and no debug stops are used. Command: <code>node tools/lucky_first_stage_survival_report.js</code></p>
<h2>Best survival per case</h2>
<table><thead><tr><th>case</th><th>optmod</th><th>truth stars</th><th>best detector recipe</th><th>detections</th><th>truth found by detector</th><th>found truth in good quad</th><th>correctly paired by best quad</th><th>a_r</th><th>L2 cutoff</th><th>median best L2</th></tr></thead><tbody>${summaryRows}</tbody></table>
${details}
</body>
</html>`;
}

async function main() {
    fs.mkdirSync(OUT_DIR, {recursive: true});
    const filters = process.argv.slice(2).map(value => value.toLowerCase());
    const cases = buildCases()
        .filter(testCase => Array.isArray(testCase.matches) && testCase.matches.length >= 4)
        .filter(testCase => filters.length === 0 || filters.some(filter => String(testCase.id).toLowerCase().includes(filter)));
    const results = [];
    for (const testCase of cases) {
        process.stderr.write(`first-stage survival ${testCase.id}\n`);
        const result = await analyzeCase(testCase);
        if (result) {
            results.push(result);
        }
    }
    fs.writeFileSync(path.join(OUT_DIR, "index.html"), pageHtml(results));
    fs.writeFileSync(path.join(OUT_DIR, "summary.json"), JSON.stringify(results.map(item => ({
        id: item.testCase.id,
        optmod: item.testCase.optmod,
        truthCount: item.truthCount,
        best: item.rows[0],
        rows: item.rows,
    })), null, 2));
    console.log(path.join(OUT_DIR, "index.html"));
}

if (require.main === module) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
