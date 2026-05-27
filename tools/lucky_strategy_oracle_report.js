#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const AutoIdentifier = require("../js/auto_identifier.js");
const {
    AidaTools,
    buildCases,
} = require("./generate_test_report.js");

const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "test-report", "lucky-strategy-oracle");
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

function visibleCatalog(testCase, maxMag) {
    return AidaTools.visibleStars(
        globalThis.WISC_ORACLE_YALE_CATALOG,
        testCase.date,
        testCase.latDeg,
        testCase.lonDeg,
        maxMag,
        89
    )
        .map((star, index) => ({
            ...star,
            key: catalogKey(star),
            vector: skyVectorAzZe(star.az, star.ze),
            rank: index + 1,
        }))
        .sort((a, b) => a.mag - b.mag || String(a.key).localeCompare(String(b.key)))
        .slice(0, 520)
        .map((star, index) => ({...star, rank: index + 1}));
}

function loadYaleCatalog() {
    const source = fs.readFileSync(path.join(ROOT, "js", "star_catalog.js"), "utf8");
    const window = {};
    Function("window", source)(window);
    return window.AIDA_STAR_CATALOG;
}

function truthRows(testCase, maxMag = 7.5) {
    return (testCase.matches || [])
        .filter(match => match && match.image && match.catalog && Number(match.catalog.mag) <= maxMag)
        .map((match, index) => {
            const azze = AidaTools.radecToAzZe(
                Number(match.catalog.raHours),
                Number(match.catalog.decDeg),
                testCase.date,
                testCase.latDeg,
                testCase.lonDeg
            );
            return {
                id: `truth-${index}`,
                x: Number(match.image.x),
                y: Number(match.image.y),
                raHours: Number(match.catalog.raHours),
                decDeg: Number(match.catalog.decDeg),
                mag: Number(match.catalog.mag),
                name: match.catalog.name || match.catalog.key || "",
                key: match.catalog.key || catalogKey(match.catalog),
                vectorSky: skyVectorAzZe(azze.az, azze.ze),
                az: azze.az,
                ze: azze.ze,
            };
        })
        .filter(row => Number.isFinite(row.x) && Number.isFinite(row.y) &&
            Number.isFinite(row.raHours) && Number.isFinite(row.decDeg) && Number.isFinite(row.mag));
}

function skySeparationDeg(a, b) {
    const ra1 = Number(a.raHours) * 15 * DEG;
    const ra2 = Number(b.raHours) * 15 * DEG;
    const de1 = Number(a.decDeg) * DEG;
    const de2 = Number(b.decDeg) * DEG;
    const dot = Math.sin(de1) * Math.sin(de2) + Math.cos(de1) * Math.cos(de2) * Math.cos(ra1 - ra2);
    return Math.acos(Math.max(-1, Math.min(1, dot))) / DEG;
}

function optmod2PreflattenVector(row, testCase, radialAlpha) {
    const optpar = testCase.optpar || [];
    const f1 = Math.abs(Number(optpar[1]) || 1);
    const f2 = Math.abs(Number(optpar[2]) || testCase.width / Math.max(1, testCase.height));
    const du = Number(optpar[6]) || 0;
    const dv = Number(optpar[7]) || 0;
    const a = Number(radialAlpha);
    if (!(f1 > 0 && f2 > 0 && a > 0)) {
        return null;
    }
    const xn = ((row.x + 1) / testCase.width - 0.5 - du) / f1;
    const yn = ((row.y + 1) / testCase.height - 0.5 - dv) / f2;
    const rho = Math.hypot(xn, yn);
    if (!Number.isFinite(rho) || rho >= 0.999999) {
        return null;
    }
    if (rho <= 1e-12) {
        return [0, 0, 1];
    }
    const theta = Math.asin(rho) / a;
    const sint = Math.sin(theta);
    const cost = Math.cos(theta);
    const v = [sint * xn / rho, sint * yn / rho, cost];
    const n = Math.hypot(v[0], v[1], v[2]);
    return n > 0 && Number.isFinite(n) ? [v[0] / n, v[1] / n, v[2] / n] : null;
}

function pinholeVector(row, testCase) {
    const optpar = testCase.optpar || [];
    const f1 = Math.abs(Number(optpar[1]) || 1);
    const f2 = Math.abs(Number(optpar[2]) || testCase.width / Math.max(1, testCase.height));
    const du = Number(optpar[6]) || 0;
    const dv = Number(optpar[7]) || 0;
    const xn = ((row.x + 1) / testCase.width - 0.5 - du) / f1;
    const yn = ((row.y + 1) / testCase.height - 0.5 - dv) / f2;
    const n = Math.hypot(xn, yn, 1);
    return [xn / n, yn / n, 1 / n];
}

function detectionRows(truth, testCase, vectorMode, radialAlpha) {
    return truth.map((row, index) => {
        let vector = null;
        if (vectorMode === "truth-sky") {
            vector = row.vectorSky;
        } else if (vectorMode === "optmod2") {
            vector = optmod2PreflattenVector(row, testCase, radialAlpha) || pinholeVector(row, testCase);
        } else {
            vector = pinholeVector(row, testCase);
        }
        return {
            ...row,
            id: `det-${index}`,
            vector,
            rank: index + 1,
            score: Math.pow(10, -0.4 * row.mag),
            imageBrightness: Math.pow(10, -0.4 * row.mag),
        };
    }).filter(row => Array.isArray(row.vector));
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
                const brightWide = widePool
                    .slice()
                    .sort((a, b) => a.rank - b.rank)
                    .slice(0, Math.min(12, widePool.length));
                const bright = [brightWide[0]];
                while (bright.length < 4) {
                    const next = farthestFromSet(brightWide, bright);
                    if (!next) {
                        break;
                    }
                    bright.push(next);
                }
                addQuad(bright);
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

function matchImageQuads(imageQuads, catalogQuads, threshold, bestOnly) {
    const matches = [];
    const bestNorms = [];
    for (let index = 0; index < imageQuads.length; index += 1) {
        const imageQuad = imageQuads[index];
        let bestNorm = Infinity;
        let bestQuad = null;
        const under = [];
        for (const catalogQuad of catalogQuads) {
            const norm = quadL2(imageQuad, catalogQuad);
            if (norm < bestNorm) {
                bestNorm = norm;
                bestQuad = catalogQuad;
            }
            if (!bestOnly && norm <= threshold) {
                under.push({imageQuad, catalogQuad, norm, index});
            }
        }
        bestNorms.push(bestNorm);
        if (bestOnly) {
            if (bestQuad && bestNorm <= threshold) {
                matches.push({imageQuad, catalogQuad: bestQuad, norm: bestNorm, index});
            }
        } else {
            matches.push(...under);
        }
    }
    return {matches, bestNorms};
}

function pairKey(detection, star) {
    const detectionKey = String(detection.id);
    const starKey = String(star.key || catalogKey(star));
    return `${detectionKey}|${starKey}`;
}

function voteEdges(quadMatches) {
    const byDetection = new Map();
    for (const match of quadMatches) {
        const imagePoints = match.imageQuad.points || [];
        const catalogPoints = match.catalogQuad.points || [];
        for (let i = 0; i < Math.min(4, imagePoints.length, catalogPoints.length); i += 1) {
            const detection = imagePoints[i];
            const star = catalogPoints[i];
            const detectionKey = String(detection.id);
            const starKey = String(star.key || catalogKey(star));
            if (!byDetection.has(detectionKey)) {
                byDetection.set(detectionKey, {detection, stars: new Map()});
            }
            const record = byDetection.get(detectionKey);
            const edge = record.stars.get(starKey) || {
                detection,
                star,
                detectionKey,
                starKey,
                count: 0,
                normSum: 0,
            };
            edge.count += 1;
            edge.normSum += Number.isFinite(match.norm) ? match.norm : 1;
            record.stars.set(starKey, edge);
        }
    }
    const edges = [];
    for (const record of byDetection.values()) {
        const votes = Array.from(record.stars.values())
            .map(edge => ({...edge, avgNorm: edge.normSum / Math.max(1, edge.count)}))
            .sort((a, b) => b.count - a.count || a.avgNorm - b.avgNorm);
        if (!votes.length) {
            continue;
        }
        const best = votes[0];
        const second = votes[1] || null;
        edges.push({
            ...best,
            alternatives: votes.length,
            secondCount: second ? second.count : 0,
            voteMargin: best.count - (second ? second.count : 0),
            voteFraction: best.count / votes.reduce((sum, edge) => sum + edge.count, 0),
            imageBrightness: best.detection.imageBrightness || best.detection.score || 0,
        });
    }
    return edges;
}

function rankEdges(edges, mode) {
    const rows = edges.slice();
    if (mode === "count-l2") {
        rows.sort((a, b) => b.count - a.count || a.avgNorm - b.avgNorm || b.imageBrightness - a.imageBrightness);
    } else if (mode === "l2-count") {
        rows.sort((a, b) => a.avgNorm - b.avgNorm || b.count - a.count || b.imageBrightness - a.imageBrightness);
    } else {
        rows.sort((a, b) => b.count - a.count || b.imageBrightness - a.imageBrightness || a.avgNorm - b.avgNorm);
    }
    return rows;
}

function greedyOneToOne(edges, minCount) {
    const usedDetections = new Set();
    const usedStars = new Set();
    const selected = [];
    for (const edge of edges) {
        if (edge.count < minCount) {
            continue;
        }
        if (usedDetections.has(edge.detectionKey) || usedStars.has(edge.starKey)) {
            continue;
        }
        usedDetections.add(edge.detectionKey);
        usedStars.add(edge.starKey);
        selected.push(edge);
    }
    return selected;
}

function scoreAssignments(assignments) {
    const scored = assignments.map(edge => ({
        ...edge,
        correct: skySeparationDeg(edge.detection, edge.star) <= 0.18,
        skyErrorDeg: skySeparationDeg(edge.detection, edge.star),
    }));
    const top = n => {
        const subset = scored.slice(0, n);
        return {
            n: subset.length,
            correct: subset.filter(row => row.correct).length,
            purity: subset.length ? subset.filter(row => row.correct).length / subset.length : 0,
            medianSkyErrorDeg: median(subset.map(row => row.skyErrorDeg)),
        };
    };
    return {
        total: scored.length,
        correct: scored.filter(row => row.correct).length,
        purity: scored.length ? scored.filter(row => row.correct).length / scored.length : 0,
        top3: top(3),
        top6: top(6),
        top12: top(12),
        firstBadIndex: scored.findIndex(row => !row.correct),
        rows: scored,
    };
}

function strategyGrid(optmod) {
    const main = optmod === 2 ?
        {name: "a_r grid mean-min-L2", mode: "optmod2", radialAlphas: [0.30, 0.50, 0.60, 0.80, 0.90, 1.00]} :
        {name: "pinhole preflatten", mode: "pinhole", radialAlphas: [null]};
    const oracle = {name: "known true sky vectors", mode: "truth-sky", radialAlphas: [null]};
    return [
        {vector: main, catalogMag: 6.0, threshold: 0.04, bestOnly: true, rank: "count-bright-l2"},
        {vector: main, catalogMag: 6.0, threshold: 0.04, bestOnly: true, rank: "count-l2"},
        {vector: main, catalogMag: 6.0, threshold: 0.04, bestOnly: true, rank: "l2-count"},
        {vector: main, catalogMag: 6.0, threshold: 0.02, bestOnly: true, rank: "count-bright-l2"},
        {vector: main, catalogMag: 6.0, threshold: 0.08, bestOnly: true, rank: "count-bright-l2"},
        {vector: main, catalogMag: 7.0, threshold: 0.04, bestOnly: true, rank: "count-bright-l2"},
        {vector: main, catalogMag: 6.0, threshold: 0.04, bestOnly: false, rank: "count-bright-l2"},
        {vector: oracle, catalogMag: 6.0, threshold: 0.04, bestOnly: true, rank: "count-bright-l2"},
    ];
}

function selectBestPreflatten(testCase, truth, catalogQuads, strategy) {
    let best = null;
    for (const radialAlpha of strategy.vector.radialAlphas) {
        const detections = detectionRows(truth, testCase, strategy.vector.mode, radialAlpha);
        const imageQuads = localQuadRecordsFromGrid(detections, testCase.width, testCase.height);
        const bestNorms = matchImageQuads(imageQuads, catalogQuads, Infinity, true).bestNorms;
        const meanMinL2 = median(bestNorms);
        const trial = {radialAlpha, detections, imageQuads, meanMinL2};
        if (!best || trial.meanMinL2 < best.meanMinL2) {
            best = trial;
        }
    }
    return best;
}

function evaluateStrategy(testCase, truth, catalogQuads, strategy) {
    const pre = selectBestPreflatten(testCase, truth, catalogQuads, strategy);
    if (!pre || pre.imageQuads.length === 0) {
        return null;
    }
    const matched = matchImageQuads(pre.imageQuads, catalogQuads, strategy.threshold, strategy.bestOnly);
    const edges = voteEdges(matched.matches);
    const minCount = strategy.bestOnly ? 1 : 2;
    const selected = greedyOneToOne(rankEdges(edges, strategy.rank), minCount);
    const score = scoreAssignments(selected);
    return {
        ...strategy,
        vectorName: strategy.vector.name,
        vectorMode: strategy.vector.mode,
        radialAlpha: pre.radialAlpha,
        meanMinL2: pre.meanMinL2,
        imageQuads: pre.imageQuads.length,
        quadMatches: matched.matches.length,
        edges: edges.length,
        minCount,
        score,
    };
}

function strategyLabel(result) {
    return [
        result.vectorName,
        `cat<${result.catalogMag}`,
        `L2<=${result.threshold}`,
        result.bestOnly ? "best/quad" : "all under threshold",
        result.rank,
    ].join(", ");
}

function compareResults(a, b) {
    return b.score.top6.correct - a.score.top6.correct ||
        b.score.top6.purity - a.score.top6.purity ||
        b.score.top12.correct - a.score.top12.correct ||
        b.score.correct - a.score.correct ||
        a.score.firstBadIndex - b.score.firstBadIndex ||
        a.meanMinL2 - b.meanMinL2;
}

function analyzeCase(testCase) {
    const truth = truthRows(testCase, 7.5)
        .sort((a, b) => a.mag - b.mag || a.key.localeCompare(b.key))
        .slice(0, 60);
    if (truth.length < 4 || !Array.isArray(testCase.optpar) || testCase.optpar.length < 9) {
        return null;
    }
    const catalogCache = new Map();
    const results = [];
    for (const strategy of strategyGrid(testCase.optmod)) {
        if (!catalogCache.has(strategy.catalogMag)) {
            const catalogStars = visibleCatalog(testCase, strategy.catalogMag);
            catalogCache.set(strategy.catalogMag, AutoIdentifier.sphericalQuadRecords(catalogStars, {
                maxQuads: 12000,
                maxQuadPoints: catalogStars.length,
                localNeighborPoolSize: 18,
                localQuadMaxSideDeg: 75,
            }));
        }
        const result = evaluateStrategy(testCase, truth, catalogCache.get(strategy.catalogMag), strategy);
        if (result) {
            results.push(result);
        }
    }
    results.sort(compareResults);
    return {
        testCase,
        truthCount: truth.length,
        best: results[0],
        top: results.slice(0, 8),
    };
}

function aggregate(caseResults) {
    const rows = new Map();
    for (const item of caseResults) {
        for (const result of item.top) {
            const key = strategyLabel(result);
            const row = rows.get(key) || {
                key,
                cases: 0,
                top6Correct: 0,
                top6Total: 0,
                top12Correct: 0,
                top12Total: 0,
                totalCorrect: 0,
                totalAssigned: 0,
                wins: 0,
            };
            row.cases += 1;
            row.top6Correct += result.score.top6.correct;
            row.top6Total += result.score.top6.n;
            row.top12Correct += result.score.top12.correct;
            row.top12Total += result.score.top12.n;
            row.totalCorrect += result.score.correct;
            row.totalAssigned += result.score.total;
            if (strategyLabel(item.best) === key) {
                row.wins += 1;
            }
            rows.set(key, row);
        }
    }
    return Array.from(rows.values()).sort((a, b) =>
        b.wins - a.wins ||
        (b.top6Correct / Math.max(1, b.top6Total)) - (a.top6Correct / Math.max(1, a.top6Total)) ||
        b.top6Correct - a.top6Correct
    );
}

function pageHtml(caseResults) {
    const agg = aggregate(caseResults);
    const caseRows = caseResults.map(item => {
        const best = item.best;
        return `<tr>
<td>${escapeHtml(item.testCase.id)}</td>
<td>${escapeHtml(item.testCase.optmod)}</td>
<td>${item.truthCount}</td>
<td>${escapeHtml(strategyLabel(best))}</td>
<td>${fmt(best.radialAlpha, 2)}</td>
<td>${fmt(best.meanMinL2, 4)}</td>
<td>${best.imageQuads}</td>
<td>${best.quadMatches}</td>
<td>${best.score.top6.correct}/${best.score.top6.n} (${fmt(100 * best.score.top6.purity, 0)}%)</td>
<td>${best.score.top12.correct}/${best.score.top12.n} (${fmt(100 * best.score.top12.purity, 0)}%)</td>
<td>${best.score.correct}/${best.score.total} (${fmt(100 * best.score.purity, 0)}%)</td>
</tr>`;
    }).join("\n");
    const aggRows = agg.slice(0, 20).map(row => `<tr>
<td>${escapeHtml(row.key)}</td>
<td>${row.wins}</td>
<td>${row.cases}</td>
<td>${row.top6Correct}/${row.top6Total} (${fmt(100 * row.top6Correct / Math.max(1, row.top6Total), 0)}%)</td>
<td>${row.top12Correct}/${row.top12Total} (${fmt(100 * row.top12Correct / Math.max(1, row.top12Total), 0)}%)</td>
<td>${row.totalCorrect}/${row.totalAssigned} (${fmt(100 * row.totalCorrect / Math.max(1, row.totalAssigned), 0)}%)</td>
</tr>`).join("\n");
    const detail = caseResults.map(item => `<section>
<h2>${escapeHtml(item.testCase.id)}</h2>
<table><thead><tr><th>rank</th><th>strategy</th><th>a_r</th><th>mean min L2</th><th>quads</th><th>quad matches</th><th>top 6</th><th>top 12</th><th>all</th></tr></thead>
<tbody>${item.top.map((result, index) => `<tr>
<td>${index + 1}</td>
<td>${escapeHtml(strategyLabel(result))}</td>
<td>${fmt(result.radialAlpha, 2)}</td>
<td>${fmt(result.meanMinL2, 4)}</td>
<td>${result.imageQuads}</td>
<td>${result.quadMatches}</td>
<td>${result.score.top6.correct}/${result.score.top6.n}</td>
<td>${result.score.top12.correct}/${result.score.top12.n}</td>
<td>${result.score.correct}/${result.score.total}</td>
</tr>`).join("\n")}</tbody></table>
</section>`).join("\n");
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>WISC lucky strategy oracle report</title>
<style>
body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:24px;color:#101828;background:#f8fafc}
h1,h2{color:#111827}
table{border-collapse:collapse;width:100%;margin:14px 0;background:white}
th,td{border:1px solid #d0d7e2;padding:6px 8px;text-align:left;vertical-align:top;font-size:13px}
th{background:#e9eef7}
code{background:#eef2f7;padding:2px 4px;border-radius:3px}
.note{max-width:980px;line-height:1.45}
</style>
</head>
<body>
<h1>WISC lucky strategy oracle report</h1>
<p class="note">This report uses saved test-case pairings as perfect star detections. It scores quad-search strategies by whether the selected catalogue star agrees with the saved paired catalogue star within 0.18 degrees. It intentionally separates the asterism strategy from the star detector.</p>
<p class="note">Command: <code>node tools/lucky_strategy_oracle_report.js</code></p>
<h2>Recommendation</h2>
<p class="note">The best strategy should maximize top-6 correctness and purity, because the GUI currently lets the user inspect/select a small number of stars before fitting. Prefer strategies that keep the first bad match far down the ranked list.</p>
<h2>Aggregate top strategies</h2>
<table><thead><tr><th>strategy</th><th>wins</th><th>cases in top 8</th><th>top 6</th><th>top 12</th><th>all selected</th></tr></thead><tbody>${aggRows}</tbody></table>
<h2>Best per case</h2>
<table><thead><tr><th>case</th><th>optmod</th><th>truth stars</th><th>best strategy</th><th>a_r</th><th>mean min L2</th><th>image quads</th><th>quad matches</th><th>top 6</th><th>top 12</th><th>all</th></tr></thead><tbody>${caseRows}</tbody></table>
${detail}
</body>
</html>`;
}

function main() {
    globalThis.WISC_ORACLE_YALE_CATALOG = loadYaleCatalog();
    fs.mkdirSync(OUT_DIR, {recursive: true});
    const filters = process.argv.slice(2).map(value => value.toLowerCase());
    const cases = buildCases()
        .filter(testCase => Array.isArray(testCase.matches) && testCase.matches.length >= 4)
        .filter(testCase => filters.length === 0 || filters.some(filter => String(testCase.id).toLowerCase().includes(filter)));
    const results = [];
    for (const testCase of cases) {
        process.stderr.write(`oracle strategy ${testCase.id}\n`);
        const result = analyzeCase(testCase);
        if (result && result.best) {
            results.push(result);
        }
    }
    const out = path.join(OUT_DIR, "index.html");
    fs.writeFileSync(out, pageHtml(results));
    fs.writeFileSync(path.join(OUT_DIR, "summary.json"), JSON.stringify(results.map(item => ({
        id: item.testCase.id,
        optmod: item.testCase.optmod,
        truthCount: item.truthCount,
        best: {
            strategy: strategyLabel(item.best),
            radialAlpha: item.best.radialAlpha,
            meanMinL2: item.best.meanMinL2,
            top6: item.best.score.top6,
            top12: item.best.score.top12,
            total: {
                correct: item.best.score.correct,
                assigned: item.best.score.total,
                purity: item.best.score.purity,
            },
        },
    })), null, 2));
    console.log(out);
}

if (require.main === module) {
    main();
}
