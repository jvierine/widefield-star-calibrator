#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const zlib = require("node:zlib");

const {AidaTools} = require("./generate_test_report.js");

const ROOT = path.join(__dirname, "..");
const TEST_CASE_DIR = path.join(ROOT, "test_cases");
const OUT_DIR = path.join(ROOT, "test-report", "lucky2-consistency-study");
const ASTERISM_FILE = path.join(ROOT, "data", "yale_asterisms_mag4_min1p5_max40.bin.gz");
const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

const ROTATION_TOLERANCES_DEG = [10, 15, 20, 30, 45, 60, 90, 180];
const SCALE_RATIOS = [1.2, 1.4, 1.6, 1.8, 2.2, 3.0, 5.0, Infinity];
const DELTA_AC = 0.02;
const DELTA_BC = 0.02;
const MAX_MATCHES_PER_CASE = 35;

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
    if (!Number.isFinite(value)) {
        return "n/a";
    }
    return value.toFixed(digits);
}

function loadBrowserScript(filename, symbol) {
    const source = fs.readFileSync(path.join(ROOT, "js", filename), "utf8");
    const context = {window: {}, Math, Date, Number, Array, Uint8Array, ArrayBuffer, DataView};
    vm.createContext(context);
    vm.runInContext(source, context, {filename});
    return context.window[symbol];
}

function catalogKey(star) {
    return `${star.name || ""}|${Number(star.raHours).toFixed(7)}|${Number(star.decDeg).toFixed(7)}`;
}

function loadYaleCatalog() {
    return loadBrowserScript("star_catalog.js", "AIDA_STAR_CATALOG")
        .map((row, index) => ({
            index,
            raHours: Number(row[0]),
            decDeg: Number(row[1]),
            mag: Number(row[2]),
            name: String(row[3] || ""),
            key: `${String(row[3] || "")}|${Number(row[0]).toFixed(7)}|${Number(row[1]).toFixed(7)}`,
        }));
}

function loadAsterismIndex(filename = ASTERISM_FILE) {
    const buffer = zlib.gunzipSync(fs.readFileSync(filename));
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const magic = buffer.subarray(0, 8).toString("ascii");
    if (magic !== "WISAST1\0") {
        throw new Error(`bad asterism magic in ${filename}`);
    }
    const count = view.getUint32(8, true);
    const strideBytes = view.getUint32(16, true);
    if (strideBytes !== 20) {
        throw new Error(`unexpected asterism stride ${strideBytes}`);
    }
    const ac = new Float32Array(count);
    const bc = new Float32Array(count);
    const star0 = new Uint16Array(count);
    const star1 = new Uint16Array(count);
    const star2 = new Uint16Array(count);
    let offset = 32;
    for (let i = 0; i < count; i += 1) {
        ac[i] = view.getFloat32(offset, true);
        bc[i] = view.getFloat32(offset + 4, true);
        star0[i] = view.getUint16(offset + 8, true);
        star1[i] = view.getUint16(offset + 10, true);
        star2[i] = view.getUint16(offset + 12, true);
        offset += strideBytes;
    }
    function lowerBound(values, target) {
        let lo = 0;
        let hi = values.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (values[mid] < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }
    function upperBound(values, target) {
        let lo = 0;
        let hi = values.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (values[mid] <= target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }
    function getAsterisms(sigAc, sigBc, deltaAc, deltaBc) {
        const hits = [];
        const start = lowerBound(ac, sigAc - Math.abs(deltaAc));
        const stop = upperBound(ac, sigAc + Math.abs(deltaAc));
        for (let i = start; i < stop; i += 1) {
            if (bc[i] >= sigBc - Math.abs(deltaBc) && bc[i] <= sigBc + Math.abs(deltaBc)) {
                hits.push(i);
            }
        }
        return hits;
    }
    function getRecord(i) {
        return {index: i, ac: ac[i], bc: bc[i], stars: [star0[i], star1[i], star2[i]]};
    }
    return {count, ac, bc, star0, star1, star2, getAsterisms, getRecord};
}

function normalizeOptpar(metadata) {
    const raw = Array.isArray(metadata.optpar) ? metadata.optpar.map(Number) : [];
    if (raw.length === 13 && Math.round(raw[0]) === 20) {
        return {optmod: 20, optpar: raw.slice(1)};
    }
    return {optmod: Number(metadata.optmod) || 2, optpar: raw};
}

function loadCase(caseDir, yaleByKey) {
    const metadataFile = path.join(caseDir, "metadata.json");
    const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
    const matches = Array.isArray(metadata.matches) ? metadata.matches : [];
    const {optmod, optpar} = normalizeOptpar(metadata);
    const rows = [];
    for (const match of matches) {
        const image = match.image || {};
        const catalog = match.catalog || {};
        const key = catalog.key || catalogKey(catalog);
        const yale = yaleByKey.get(key);
        if (!yale || !Number.isFinite(image.x) || !Number.isFinite(image.y) || yale.mag > 4.0) {
            continue;
        }
        rows.push({
            id: rows.length + 1,
            x: Number(image.x),
            y: Number(image.y),
            yaleIndex: yale.index,
            mag: yale.mag,
            name: yale.name,
        });
    }
    rows.sort((a, b) => a.mag - b.mag || a.id - b.id);
    return {
        id: metadata.id || path.basename(caseDir),
        caseDir,
        width: Number(metadata.width),
        height: Number(metadata.height),
        date: new Date(metadata.timestampUtc || metadata.date),
        latDeg: Number(metadata.latDeg),
        lonDeg: Number(metadata.lonDeg),
        optmod,
        optpar,
        matches: rows.slice(0, MAX_MATCHES_PER_CASE),
        allUsableMatches: rows.length,
    };
}

function visibleYaleSet(testCase, yale, maxZenithDeg = 90.0) {
    const visible = new Set();
    for (const star of yale) {
        if (star.mag > 4.0) {
            continue;
        }
        const azze = AidaTools.radecToAzZe(star.raHours, star.decDeg, testCase.date, testCase.latDeg, testCase.lonDeg);
        if (Number.isFinite(azze.az) && Number.isFinite(azze.ze) && azze.ze * RAD <= maxZenithDeg) {
            visible.add(star.index);
        }
    }
    return visible;
}

function skyPlaneMap(testCase, yale, allowed) {
    const map = new Map();
    for (const star of yale) {
        if (!allowed.has(star.index)) {
            continue;
        }
        const azze = AidaTools.radecToAzZe(star.raHours, star.decDeg, testCase.date, testCase.latDeg, testCase.lonDeg);
        if (!Number.isFinite(azze.az) || !Number.isFinite(azze.ze)) {
            continue;
        }
        map.set(star.index, {
            x: azze.ze * Math.sin(azze.az),
            y: -azze.ze * Math.cos(azze.az),
        });
    }
    return map;
}

function triangleSignature(a, b, c) {
    const sides = [
        Math.hypot(a.x - b.x, a.y - b.y),
        Math.hypot(a.x - c.x, a.y - c.y),
        Math.hypot(b.x - c.x, b.y - c.y),
    ].sort((x, y) => x - y);
    const [shortSide, midSide, longSide] = sides;
    if (!Number.isFinite(longSide) || longSide <= 0) {
        return null;
    }
    const area2 = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
    return {
        ac: shortSide / longSide,
        bc: midSide / longSide,
        shortSide,
        midSide,
        longSide,
        height: area2 / longSide,
    };
}

function signedTriangleArea2(points) {
    const [a, b, c] = points;
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function signNonzero(value, epsilon = 1e-12) {
    if (!Number.isFinite(value) || Math.abs(value) <= epsilon) {
        return 0;
    }
    return value > 0 ? 1 : -1;
}

function circularMeanAngle(angles) {
    let x = 0;
    let y = 0;
    for (const angle of angles) {
        x += Math.cos(angle);
        y += Math.sin(angle);
    }
    return Math.atan2(y, x);
}

function wrappedAngleDistance(a, b) {
    let d = a - b;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return Math.abs(d);
}

function triangleHypotheses(imageStars, records, skyMap, maxSamples = Infinity) {
    const permutations = [
        [0, 1, 2], [0, 2, 1], [1, 0, 2],
        [1, 2, 0], [2, 0, 1], [2, 1, 0],
    ];
    const edgePairs = [[0, 1], [0, 2], [1, 2]];
    const hypotheses = [];
    const finiteMax = Number.isFinite(maxSamples) ? maxSamples : Infinity;
    const stride = Number.isFinite(finiteMax) && records.length > 0 ?
        Math.max(1, Math.ceil(records.length / Math.max(1, Math.floor(finiteMax / 6)))) :
        1;
    for (let recordIndex = 0; recordIndex < records.length && hypotheses.length < finiteMax; recordIndex += stride) {
        const record = records[recordIndex];
        for (const permutation of permutations) {
            const skyTriangle = permutation.map(sourceIndex => skyMap.get(record.stars[sourceIndex]));
            if (skyTriangle.some(point => !point)) {
                continue;
            }
            const imageHandedness = signNonzero(signedTriangleArea2(imageStars), 1e-6);
            const skyHandedness = signNonzero(signedTriangleArea2(skyTriangle), 1e-12);
            if (imageHandedness === 0 || skyHandedness === 0) {
                continue;
            }
            const edgeAngles = [];
            const edgeScales = [];
            for (const [u, v] of edgePairs) {
                const imgU = imageStars[u];
                const imgV = imageStars[v];
                const skyU = skyTriangle[u];
                const skyV = skyTriangle[v];
                const imageAngle = Math.atan2(imgV.y - imgU.y, imgV.x - imgU.x);
                const skyAngle = Math.atan2(skyV.y - skyU.y, skyV.x - skyU.x);
                const pixelDistance = Math.hypot(imgV.x - imgU.x, imgV.y - imgU.y);
                const skyDistance = Math.hypot(skyV.x - skyU.x, skyV.y - skyU.y);
                if (pixelDistance <= 1e-9 || skyDistance <= 1e-9) {
                    continue;
                }
                edgeAngles.push(imageAngle - skyAngle);
                edgeScales.push(skyDistance / pixelDistance);
            }
            if (edgeAngles.length === 3 && edgeScales.length === 3) {
                const scaleMean = edgeScales.reduce((sum, value) => sum + value, 0) / edgeScales.length;
                const scaleSpread = Math.max(...edgeScales) / Math.max(1e-12, Math.min(...edgeScales));
                if (Number.isFinite(scaleMean) && scaleSpread <= 2.2) {
                    hypotheses.push({
                        assignments: permutation.map(sourceIndex => record.stars[sourceIndex]),
                        rotation: circularMeanAngle(edgeAngles),
                        scale: scaleMean,
                        handedness: imageHandedness * skyHandedness,
                    });
                }
            }
        }
    }
    return hypotheses;
}

function lookupTriangle(a, b, c, index, allowed, skyMap, imageScale, maxSamples = Infinity) {
    const sig = triangleSignature(a, b, c);
    if (!sig || sig.shortSide < 50 || sig.longSide > 0.55 * imageScale ||
            sig.ac < 0.18 || sig.bc < 0.35 || sig.height < 20) {
        return {accepted: false, reason: "geometry", sig, hypotheses: [], hits: 0};
    }
    const hitIndices = index.getAsterisms(sig.ac, sig.bc, DELTA_AC, DELTA_BC);
    const records = [];
    for (const hitIndex of hitIndices) {
        const record = index.getRecord(hitIndex);
        if (record.stars.every(starIndex => allowed.has(starIndex))) {
            records.push(record);
        }
    }
    records.sort((u, v) => {
        const du = Math.hypot(u.ac - sig.ac, u.bc - sig.bc);
        const dv = Math.hypot(v.ac - sig.ac, v.bc - sig.bc);
        return du - dv;
    });
    if (!records.length) {
        return {accepted: false, reason: "nohits", sig, hypotheses: [], hits: hitIndices.length};
    }
    const hypotheses = triangleHypotheses([a, b, c], records, skyMap, maxSamples);
    return {accepted: hypotheses.length > 0, reason: hypotheses.length ? "accepted" : "nohypotheses", sig, hypotheses, hits: records.length};
}

function trueAssignmentKey(stars) {
    return stars.map(star => star.yaleIndex).join(":");
}

function findTrueHypothesis(hypotheses, stars) {
    const key = trueAssignmentKey(stars);
    return hypotheses.find(hypothesis => hypothesis.assignments.join(":") === key) || null;
}

function supportTrueHypothesis(seedStars, seedHypothesis, supportStars, supportHypothesis, rotationTolRad, scaleRatioTol) {
    const shared = [];
    for (let i = 0; i < seedStars.length; i += 1) {
        for (let j = 0; j < supportStars.length; j += 1) {
            if (seedStars[i].id === supportStars[j].id) {
                shared.push({seedIndex: i, supportIndex: j});
            }
        }
    }
    if (shared.length < 2) {
        return false;
    }
    for (const item of shared) {
        if (seedHypothesis.assignments[item.seedIndex] !== supportHypothesis.assignments[item.supportIndex]) {
            return false;
        }
    }
    if (wrappedAngleDistance(seedHypothesis.rotation, supportHypothesis.rotation) > rotationTolRad) {
        return false;
    }
    const minScale = Math.min(seedHypothesis.scale, supportHypothesis.scale);
    const maxScale = Math.max(seedHypothesis.scale, supportHypothesis.scale);
    return minScale > 0 && maxScale / minScale <= scaleRatioTol;
}

function supportMetricsForTriangle(seedStars, seedLookup, matches, limit, lookupForStars) {
    const seedHypothesis = findTrueHypothesis(seedLookup.hypotheses, seedStars);
    if (!seedHypothesis) {
        return [];
    }
    const baseIds = new Set(seedStars.map(star => star.id));
    const cx = seedStars.reduce((sum, star) => sum + star.x, 0) / 3;
    const cy = seedStars.reduce((sum, star) => sum + star.y, 0) / 3;
    const neighbors = matches
        .slice(0, limit)
        .filter(star => !baseIds.has(star.id))
        .map(star => ({
            star,
            distance: Math.min(
                ...seedStars.map(seed => Math.hypot(star.x - seed.x, star.y - seed.y)),
                0.6 * Math.hypot(star.x - cx, star.y - cy)
            ),
        }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 12)
        .map(row => row.star);
    const edges = [[seedStars[0], seedStars[1]], [seedStars[0], seedStars[2]], [seedStars[1], seedStars[2]]];
    const metrics = [];
    for (const neighbor of neighbors) {
        for (const [u, v] of edges) {
            const supportStars = [u, v, neighbor];
            const supportLookup = lookupForStars(supportStars);
            if (!supportLookup.accepted) {
                continue;
            }
            const supportHypothesis = findTrueHypothesis(supportLookup.hypotheses, supportStars);
            if (!supportHypothesis) {
                continue;
            }
            const sharedIdentityOk = supportTrueHypothesis(seedStars, seedHypothesis, supportStars, supportHypothesis, Infinity, Infinity);
            if (!sharedIdentityOk) {
                continue;
            }
            const minScale = Math.min(seedHypothesis.scale, supportHypothesis.scale);
            const maxScale = Math.max(seedHypothesis.scale, supportHypothesis.scale);
            metrics.push({
                rotationDiffRad: wrappedAngleDistance(seedHypothesis.rotation, supportHypothesis.rotation),
                scaleRatio: minScale > 0 ? maxScale / minScale : Infinity,
            });
        }
    }
    return metrics;
}

function analyzeCase(testCase, yale, index) {
    const imageScale = Math.max(testCase.width, testCase.height);
    const allowed = visibleYaleSet(testCase, yale);
    const skyMap = skyPlaneMap(testCase, yale, allowed);
    const matches = testCase.matches.filter(match => allowed.has(match.yaleIndex));
    const result = {
        id: testCase.id,
        optmod: testCase.optmod,
        usableMatches: matches.length,
        totalSavedMag4Matches: testCase.allUsableMatches,
        eligibleTriangles: 0,
        lookupTriangles: 0,
        trueInExhaustive: 0,
        trueInSampled720: 0,
        trueInRanked6000: 0,
        hitCounts: [],
        sweep: new Map(),
    };
    const lookupCache = new Map();
    function lookupForStars(stars, maxSamples = Infinity) {
        const key = `${stars.map(star => star.id).join(":")}:${Number.isFinite(maxSamples) ? maxSamples : "all"}`;
        if (!lookupCache.has(key)) {
            lookupCache.set(key, lookupTriangle(stars[0], stars[1], stars[2], index, allowed, skyMap, imageScale, maxSamples));
        }
        return lookupCache.get(key);
    }
    for (const rot of ROTATION_TOLERANCES_DEG) {
        for (const scale of SCALE_RATIOS) {
            result.sweep.set(`${rot}:${scale}`, {rot, scale, supported: 0});
        }
    }
    const limit = matches.length;
    for (let i = 0; i < matches.length - 2; i += 1) {
        for (let j = i + 1; j < matches.length - 1; j += 1) {
            for (let k = j + 1; k < matches.length; k += 1) {
                const seedStars = [matches[i], matches[j], matches[k]];
                const lookup = lookupForStars(seedStars, Infinity);
                if (lookup.reason === "geometry") {
                    continue;
                }
                result.eligibleTriangles += 1;
                if (!lookup.accepted) {
                    continue;
                }
                result.lookupTriangles += 1;
                result.hitCounts.push(lookup.hits);
                const trueHypothesis = findTrueHypothesis(lookup.hypotheses, seedStars);
                if (!trueHypothesis) {
                    continue;
                }
                result.trueInExhaustive += 1;
                const sampled = lookupTriangle(seedStars[0], seedStars[1], seedStars[2], index, allowed, skyMap, imageScale, 720);
                if (findTrueHypothesis(sampled.hypotheses, seedStars)) {
                    result.trueInSampled720 += 1;
                }
                const ranked = lookupTriangle(seedStars[0], seedStars[1], seedStars[2], index, allowed, skyMap, imageScale, 6000);
                if (findTrueHypothesis(ranked.hypotheses, seedStars)) {
                    result.trueInRanked6000 += 1;
                }
                const supportMetrics = supportMetricsForTriangle(seedStars, lookup, matches, limit, lookupForStars);
                for (const row of result.sweep.values()) {
                    if (supportMetrics.some(metric =>
                        metric.rotationDiffRad <= row.rot * DEG &&
                        metric.scaleRatio <= row.scale
                    )) {
                        row.supported += 1;
                    }
                }
            }
        }
    }
    result.sweepRows = Array.from(result.sweep.values());
    result.recommended = result.sweepRows
        .filter(row => row.supported >= 0.90 * result.trueInExhaustive)
        .sort((a, b) => a.rot - b.rot || a.scale - b.scale)[0] || null;
    result.hitMedian = percentile(result.hitCounts, 0.50);
    result.hitP95 = percentile(result.hitCounts, 0.95);
    return result;
}

function percentile(values, p) {
    if (!values.length) {
        return NaN;
    }
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
}

function summarize(results) {
    const rows = [];
    for (const rot of ROTATION_TOLERANCES_DEG) {
        for (const scale of SCALE_RATIOS) {
            let supported = 0;
            let truth = 0;
            for (const result of results) {
                truth += result.trueInExhaustive;
                supported += result.sweep.get(`${rot}:${scale}`).supported;
            }
            rows.push({rot, scale, supported, truth, survival: truth > 0 ? supported / truth : 0});
        }
    }
    return rows;
}

function pageHtml(results, summaryRows) {
    const generated = new Date().toISOString();
    function everyCaseSurvives(row, threshold) {
        return results.every(result => {
            if (result.trueInExhaustive <= 0) {
                return true;
            }
            const caseRow = result.sweep.get(`${row.rot}:${row.scale}`);
            return caseRow && caseRow.supported / result.trueInExhaustive >= threshold;
        });
    }
    const bestEvery90 = summaryRows
        .filter(row => everyCaseSurvives(row, 0.90))
        .sort((a, b) => a.rot - b.rot || a.scale - b.scale)[0];
    const bestGlobal95 = summaryRows
        .filter(row => row.survival >= 0.95)
        .sort((a, b) => a.rot - b.rot || a.scale - b.scale)[0];
    const summaryTable = summaryRows.map(row => {
        const cls = row.survival >= 0.95 ? "good" : row.survival >= 0.90 ? "warn" : "bad";
        return `<tr class="${cls}"><td>${row.rot}</td><td>${row.scale === Infinity ? "off" : fmt(row.scale, 1)}</td><td>${row.supported}/${row.truth}</td><td>${fmt(100 * row.survival, 1)}%</td></tr>`;
    }).join("\n");
    const caseRows = results.map(result => `<tr>
<td>${escapeHtml(result.id)}</td>
<td>${result.optmod}</td>
<td>${result.usableMatches}/${result.totalSavedMag4Matches}</td>
<td>${result.eligibleTriangles}</td>
<td>${result.lookupTriangles}</td>
<td>${result.trueInExhaustive}</td>
<td>${result.trueInSampled720}</td>
<td>${result.trueInRanked6000}</td>
<td>${fmt(result.hitMedian, 0)} / ${fmt(result.hitP95, 0)}</td>
<td>${result.recommended ? `${result.recommended.rot} deg, ${result.recommended.scale === Infinity ? "scale off" : `${fmt(result.recommended.scale, 1)}x`}` : "none >=90%"}</td>
</tr>`).join("\n");
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Lucky2 Consistency Study</title>
<style>
body { font-family: system-ui, -apple-system, sans-serif; margin: 24px; color: #172033; }
table { border-collapse: collapse; width: 100%; margin: 16px 0 28px; font-size: 14px; }
th, td { border: 1px solid #d6dde8; padding: 7px 9px; text-align: right; }
th:first-child, td:first-child { text-align: left; }
th { background: #eef3f8; }
.good { background: #e7f7ed; }
.warn { background: #fff7da; }
.bad { background: #ffe9e9; }
code, pre { background: #f5f7fa; border-radius: 4px; padding: 2px 4px; }
.note { max-width: 980px; line-height: 1.45; }
</style>
</head>
<body>
<h1>Lucky2 Consistency Study</h1>
<p class="note">Generated ${escapeHtml(generated)}. This report uses saved test-case star pairings as oracle detections. It asks whether the true Yale catalogue triangle survives the asterism lookup and then whether a neighboring support triangle with the same shared edge agrees in local rotation and image-to-sky scale. This isolates consistency checking from star detector failures.</p>
<p class="note"><b>Recommendation:</b> ${bestEvery90 ? `to keep at least 90% of true triangles in every saved case, use about ${bestEvery90.rot} deg rotation and ${bestEvery90.scale === Infinity ? "no scale limit" : `${fmt(bestEvery90.scale, 1)}x scale`}.` : bestGlobal95 ? `globally, ${bestGlobal95.rot} deg rotation and ${bestGlobal95.scale === Infinity ? "no scale limit" : `${fmt(bestGlobal95.scale, 1)}x scale`} keeps at least 95% of true triangles, but at least one difficult case needs looser thresholds.` : "no tested setting preserved enough true triangles; loosen the support gate or improve the triangle lookup first."} The old sampled-720 path is shown because it can drop true triangles before any consistency test; the browser now ranks hits by signature distance before applying a 6000-hypothesis cap.</p>
<h2>Global Sweep</h2>
<table>
<thead><tr><th>rotation tolerance deg</th><th>scale ratio</th><th>true supported / true lookup</th><th>survival</th></tr></thead>
<tbody>${summaryTable}</tbody>
</table>
<h2>Cases</h2>
<table>
<thead><tr><th>case</th><th>optmod</th><th>used / saved mag<=4 matches</th><th>eligible triangles</th><th>lookups with hits</th><th>true in exhaustive lookup</th><th>true in old sampled-720 lookup</th><th>true in ranked-6000 lookup</th><th>hit median / p95</th><th>strictest >=90%</th></tr></thead>
<tbody>${caseRows}</tbody>
</table>
<h2>Repeat</h2>
<pre><code>cd ${escapeHtml(ROOT)}
node tools/lucky2_consistency_study.js</code></pre>
</body>
</html>`;
}

async function main() {
    fs.mkdirSync(OUT_DIR, {recursive: true});
    const yale = loadYaleCatalog();
    const yaleByKey = new Map(yale.map(star => [star.key, star]));
    const index = loadAsterismIndex();
    const caseDirs = fs.readdirSync(TEST_CASE_DIR)
        .map(name => path.join(TEST_CASE_DIR, name))
        .filter(dir => fs.existsSync(path.join(dir, "metadata.json")));
    const cases = caseDirs
        .map(dir => loadCase(dir, yaleByKey))
        .filter(testCase => testCase.matches.length >= 8);
    const results = [];
    for (const testCase of cases) {
        console.log(`Lucky2 consistency oracle: ${testCase.id} (${testCase.matches.length} mag<=4 matches)`);
        results.push(analyzeCase(testCase, yale, index));
    }
    const summaryRows = summarize(results);
    const outFile = path.join(OUT_DIR, "index.html");
    fs.writeFileSync(outFile, pageHtml(results, summaryRows));
    fs.writeFileSync(path.join(OUT_DIR, "summary.json"), JSON.stringify({generatedUtc: new Date().toISOString(), summaryRows, results}, null, 2));
    console.log(outFile);
}

if (require.main === module) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
