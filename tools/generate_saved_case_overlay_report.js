#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
    buildCases,
    projectStars,
    testCaseImagePath,
} = require("./generate_test_report.js");

const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "test_cases", "report");
const OUT_FILE = path.join(OUT_DIR, "index.html");
const LIMITING_MAG = 5.0;

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, ch => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;",
    }[ch]));
}

function magnitudeRadius(mag) {
    if (mag <= 1.5) {
        return 20;
    }
    if (mag <= 2.5) {
        return 17;
    }
    if (mag <= 3.5) {
        return 14;
    }
    if (mag <= 4.5) {
        return 12;
    }
    return 10;
}

function isSelectedStar(star, selectedStars) {
    return selectedStars.some(selected =>
        Math.abs(Number(selected.raHours) - Number(star.raHours)) < 1e-5 &&
        Math.abs(Number(selected.decDeg) - Number(star.decDeg)) < 1e-5);
}

function circleSvg(star, selectedStars) {
    const selected = isSelectedStar(star, selectedStars);
    return `<circle class="${selected ? "selected-star" : "catalog-star"}" cx="${star.x.toFixed(2)}" cy="${star.y.toFixed(2)}" ` +
        `r="${magnitudeRadius(star.mag).toFixed(1)}"><title>${escapeHtml(star.name || "star")} ` +
        `mag ${star.mag.toFixed(2)}${selected ? " selected" : ""}</title></circle>`;
}

function casePanel(testCase, index) {
    const imagePath = path.relative(OUT_DIR, testCaseImagePath(testCase)).replace(/\\/g, "/");
    const stars = projectStars(testCase, testCase.optpar, LIMITING_MAG);
    const selectedStars = (testCase.matches || [])
        .map(match => match.catalog)
        .filter(Boolean);
    const residual = testCase.residual || {};
    const optpar = [testCase.optmod, ...testCase.optpar]
        .map(value => Number.isFinite(value) ? Number(value).toPrecision(8) : String(value))
        .join(", ");
    return `<section class="case ${index === 0 ? "active" : ""}" data-index="${index}">
        <div class="stage" style="aspect-ratio: ${testCase.width} / ${testCase.height}">
            <img src="${escapeHtml(imagePath)}" alt="${escapeHtml(testCase.id)}">
            <svg viewBox="0 0 ${testCase.width} ${testCase.height}" preserveAspectRatio="none">
                ${stars.map(star => circleSvg(star, selectedStars)).join("\n")}
            </svg>
        </div>
        <aside class="info">
            <h2>${escapeHtml(testCase.id)}</h2>
            <p>${escapeHtml(testCase.timestampUtc || testCase.date.toISOString())}</p>
            <p>lat ${Number(testCase.latDeg).toFixed(6)}, lon ${Number(testCase.lonDeg).toFixed(6)}, alt ${Number(testCase.altM || 0).toFixed(1)} m</p>
            <p>optmod ${testCase.optmod}, ${stars.length} catalogue stars with mag &le; ${LIMITING_MAG.toFixed(1)}</p>
            <p>${Array.isArray(testCase.matches) ? testCase.matches.length : 0} saved pairings; RMS ${
                Number.isFinite(residual.rmsPx) ? residual.rmsPx.toFixed(2) : "n/a"
            } px</p>
            <pre>[${escapeHtml(optpar)}]</pre>
        </aside>
    </section>`;
}

function pageHtml(cases) {
    const generated = new Date().toISOString();
    const command = "cd /Users/j/src/AIDA_tools/aida_js_calibrator && npm run report:saved-overlays";
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AIDA Saved Test Case Star Overlays</title>
<style>
html, body { margin: 0; min-height: 100%; background: #101217; color: #eef1f7; font-family: system-ui, sans-serif; }
.bar { position: sticky; top: 0; z-index: 5; display: flex; gap: 10px; align-items: center; padding: 10px 12px; background: #191d26; border-bottom: 1px solid #303746; }
button, select { color: #eef1f7; background: #252b38; border: 1px solid #485064; border-radius: 4px; padding: 7px 10px; font: inherit; }
button { cursor: pointer; font-weight: 800; }
.meta { color: #b8c0d4; font-size: 13px; }
.legend { margin-left: auto; display: flex; gap: 14px; color: #b8c0d4; font-size: 13px; }
.swatch { display: inline-block; width: 16px; height: 16px; border: 2px solid #ff4a4a; border-radius: 50%; vertical-align: -4px; margin-right: 5px; }
.swatch.selected { border-color: #22c55e; }
.case { display: none; grid-template-columns: minmax(0, 1fr) 360px; gap: 14px; padding: 14px; height: calc(100vh - 55px); box-sizing: border-box; }
.case.active { display: grid; }
.stage { position: relative; align-self: start; max-width: 100%; max-height: calc(100vh - 84px); background: #05060a; overflow: hidden; }
.stage img, .stage svg { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.stage img { object-fit: contain; }
.stage svg { pointer-events: none; }
.catalog-star { fill: none; stroke: #ff4a4a; stroke-width: 2.5; vector-effect: non-scaling-stroke; }
.selected-star { fill: none; stroke: #22c55e; stroke-width: 3.2; vector-effect: non-scaling-stroke; }
.info { min-width: 0; overflow: auto; padding: 12px; border-left: 1px solid #303746; color: #c9d2e3; }
.info h2 { margin: 0 0 10px; font-size: 17px; color: #fff; overflow-wrap: anywhere; }
.info p { margin: 8px 0; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; padding: 10px; background: #0b0f18; border: 1px solid #303746; border-radius: 6px; color: #b7f7c8; font-size: 11px; }
.reproduce { padding: 10px 12px; background: #121723; border-bottom: 1px solid #303746; color: #c9d2e3; }
.reproduce h2 { margin: 0 0 6px; font-size: 13px; color: #fff; }
.reproduce pre { margin: 0; }
@media (max-width: 900px) { .case.active { display: block; height: auto; } .stage { height: auto; } .info { border-left: 0; border-top: 1px solid #303746; } }
</style>
</head>
<body>
<div class="bar">
    <button id="prev" type="button">&larr;</button>
    <button id="next" type="button">&rarr;</button>
    <select id="caseSelect"></select>
    <span id="counter" class="meta"></span>
    <span class="legend"><span><span class="swatch selected"></span>selected</span><span><span class="swatch"></span>catalogue mag &le; ${LIMITING_MAG.toFixed(1)}</span></span>
</div>
<section class="reproduce">
<h2>Repeat From Command Line</h2>
<pre><code>${escapeHtml(command)}</code></pre>
</section>
${cases.map(casePanel).join("\n")}
<script>
const cases = ${JSON.stringify(cases.map(testCase => ({id: testCase.id})))};
let index = 0;
const select = document.getElementById("caseSelect");
const counter = document.getElementById("counter");
for (let i = 0; i < cases.length; i += 1) {
  const option = document.createElement("option");
  option.value = String(i);
  option.textContent = cases[i].id;
  select.appendChild(option);
}
function show(i) {
  if (!cases.length) return;
  document.querySelectorAll(".case").forEach(el => el.classList.remove("active"));
  index = (i + cases.length) % cases.length;
  document.querySelector('.case[data-index="' + index + '"]').classList.add("active");
  select.value = String(index);
  counter.textContent = (index + 1) + "/" + cases.length + " · generated ${generated}";
}
document.getElementById("prev").addEventListener("click", () => show(index - 1));
document.getElementById("next").addEventListener("click", () => show(index + 1));
select.addEventListener("change", () => show(Number(select.value)));
window.addEventListener("keydown", event => {
  if (event.key === "ArrowLeft") show(index - 1);
  if (event.key === "ArrowRight" || event.key === " ") show(index + 1);
});
show(0);
</script>
</body>
</html>
`;
}

function main() {
    const cases = buildCases();
    fs.mkdirSync(OUT_DIR, {recursive: true});
    fs.writeFileSync(OUT_FILE, pageHtml(cases));
    console.log(OUT_FILE);
}

if (require.main === module) {
    main();
}
