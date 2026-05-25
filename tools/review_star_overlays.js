#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const {URL} = require("node:url");

const StarDetector = require("../js/star_detector.js");
const {
    buildCases,
    projectStars,
    readPngImageData,
} = require("./generate_test_report.js");

const ROOT = path.join(__dirname, "..");
const IMAGE_DIR = path.join(ROOT, "calibration_images");
const TEST_CASE_DIR = path.join(ROOT, "test_cases");
const REJECTED_DIR = path.join(TEST_CASE_DIR, "rejected");

function parseArgs(argv) {
    const options = {
        host: "127.0.0.1",
        port: 8791,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--host" && argv[i + 1]) {
            options.host = argv[i + 1];
            i += 1;
        } else if (arg.startsWith("--host=")) {
            options.host = arg.slice("--host=".length);
        } else if (arg === "--port" && argv[i + 1]) {
            options.port = Number(argv[i + 1]);
            i += 1;
        } else if (arg.startsWith("--port=")) {
            options.port = Number(arg.slice("--port=".length));
        }
    }
    return options;
}

function escapeXml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, ch => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;",
    }[ch]));
}

function safeJsonCaseFilename(id) {
    const file = `${String(id || "").replace(/[^A-Za-z0-9_-]+/g, "-")}.json`;
    const source = path.join(TEST_CASE_DIR, file);
    return fs.existsSync(source) ? {file, source} : null;
}

function magnitudeRadius(mag) {
    if (mag <= 2.0) {
        return 16;
    }
    if (mag <= 4.0) {
        return 12;
    }
    return 9;
}

function circleSvg(x, y, radius, stroke, title = "") {
    const maybeTitle = title ? `<title>${escapeXml(title)}</title>` : "";
    return `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${radius.toFixed(2)}" ` +
        `fill="none" stroke="${stroke}" stroke-width="2" vector-effect="non-scaling-stroke">${maybeTitle}</circle>`;
}

function listCases() {
    return buildCases().map(testCase => ({
        id: testCase.id,
        title: testCase.title,
        image: testCase.image,
        sourceJson: testCase.sourceJson || null,
        optmod: testCase.optmod,
        width: testCase.width,
        height: testCase.height,
    }));
}

async function overlaySvg(testCase) {
    const imagePath = path.join(IMAGE_DIR, testCase.image);
    const imageData = readPngImageData(imagePath);
    const detectionResult = await StarDetector.detectBrightStars(imageData, {
        maxDetections: 240,
        thresholdSigma: testCase.detectorOptions && Number.isFinite(testCase.detectorOptions.thresholdSigma) ?
            testCase.detectorOptions.thresholdSigma : 2.5,
        localThresholdSigma: testCase.detectorOptions && Number.isFinite(testCase.detectorOptions.localThresholdSigma) ?
            testCase.detectorOptions.localThresholdSigma : 2.5,
        requireGlobalThreshold: testCase.detectorOptions && testCase.detectorOptions.requireGlobalThreshold === true,
        maxRadiusPx: 5,
        maxElongation: 4.0,
        suppressionRadiusPx: 18,
    });
    const stars = projectStars(testCase, testCase.optpar, Math.max(7, testCase.maxMag || 7));
    const imageHref = `/image/${encodeURIComponent(testCase.image)}`;
    const items = [
        `<image href="${escapeXml(imageHref)}" x="0" y="0" width="${testCase.width}" height="${testCase.height}" />`,
    ];
    for (const detection of detectionResult.detections) {
        items.push(circleSvg(detection.x, detection.y, 8, "#000"));
        items.push(circleSvg(detection.x, detection.y, 7, "#ffd940"));
    }
    for (const star of stars) {
        const radius = magnitudeRadius(star.mag);
        items.push(circleSvg(star.x, star.y, radius + 1, "#000"));
        items.push(circleSvg(star.x, star.y, radius, "#ff4040",
            `${star.name || "star"} mag ${star.mag.toFixed(1)}`));
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${testCase.width} ${testCase.height}" ` +
        `width="${testCase.width}" height="${testCase.height}">\n${items.join("\n")}\n</svg>\n`;
}

function sendJson(res, status, payload) {
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
    });
    res.end(JSON.stringify(payload, null, 2));
}

function sendText(res, status, contentType, text) {
    res.writeHead(status, {
        "content-type": contentType,
        "cache-control": "no-store",
    });
    res.end(text);
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", chunk => {
            body += chunk;
            if (body.length > 100_000) {
                reject(new Error("request body too large"));
                req.destroy();
            }
        });
        req.on("end", () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (error) {
                reject(error);
            }
        });
        req.on("error", reject);
    });
}

function rejectCase(id) {
    const jsonCase = safeJsonCaseFilename(id);
    if (!jsonCase) {
        throw new Error(`no editable JSON test case found for ${id}`);
    }
    fs.mkdirSync(REJECTED_DIR, {recursive: true});
    const destination = path.join(REJECTED_DIR, jsonCase.file);
    fs.renameSync(jsonCase.source, destination);
    return destination;
}

function htmlPage() {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AIDA Star Overlay QA</title>
<style>
html, body { margin: 0; min-height: 100%; background: #101217; color: #eef1f7; font-family: system-ui, sans-serif; }
.bar { position: sticky; top: 0; z-index: 2; display: flex; gap: 10px; align-items: center; padding: 10px 12px; background: #191d26; border-bottom: 1px solid #303746; }
button, select { color: #eef1f7; background: #252b38; border: 1px solid #485064; border-radius: 4px; padding: 7px 10px; }
button { cursor: pointer; font-weight: 700; }
.danger { background: #7f1d1d; border-color: #b91c1c; }
.meta { color: #b8c0d4; font-size: 13px; white-space: nowrap; }
.legend { margin-left: auto; display: flex; gap: 14px; align-items: center; color: #b8c0d4; font-size: 13px; }
.swatch { display: inline-block; width: 12px; height: 12px; border: 2px solid currentColor; border-radius: 50%; vertical-align: -2px; margin-right: 4px; }
.red { color: #ff4040; }
.yellow { color: #ffd940; }
.stage { height: calc(100vh - 54px); overflow: auto; display: grid; place-items: start center; }
iframe { border: 0; background: #05060a; }
</style>
</head>
<body>
<div class="bar">
<button id="prev" type="button">←</button>
<button id="next" type="button">→</button>
<select id="caseSelect"></select>
<button class="danger" id="reject" type="button">delete bad test case</button>
<span class="meta" id="meta"></span>
<span class="legend"><span><span class="swatch red"></span>catalogue</span><span><span class="swatch yellow"></span>detections</span></span>
</div>
<div class="stage"><iframe id="viewer" title="Star overlay"></iframe></div>
<script>
let cases = [];
let index = 0;
const select = document.getElementById("caseSelect");
const viewer = document.getElementById("viewer");
const meta = document.getElementById("meta");

async function loadCases(keepId = null) {
  const response = await fetch("/api/cases");
  cases = await response.json();
  select.textContent = "";
  for (let i = 0; i < cases.length; i += 1) {
    const option = document.createElement("option");
    option.value = String(i);
    option.textContent = cases[i].id;
    select.appendChild(option);
  }
  const keepIndex = keepId ? cases.findIndex(item => item.id === keepId) : -1;
  show(keepIndex >= 0 ? keepIndex : Math.min(index, cases.length - 1));
}

function show(i) {
  if (!cases.length) {
    viewer.removeAttribute("src");
    meta.textContent = "no test cases";
    return;
  }
  index = (i + cases.length) % cases.length;
  const item = cases[index];
  select.value = String(index);
  viewer.src = "/overlay/" + encodeURIComponent(item.id) + ".svg";
  sizeViewer();
  meta.textContent = (index + 1) + "/" + cases.length + " · optmod " + item.optmod + " · " + item.width + "x" + item.height;
}

function sizeViewer() {
  if (!cases.length) return;
  const item = cases[index];
  const maxW = window.innerWidth;
  const maxH = Math.max(320, window.innerHeight - 64);
  const scale = Math.min(maxW / item.width, maxH / item.height, 1);
  viewer.style.width = Math.max(320, Math.round(item.width * scale)) + "px";
  viewer.style.height = Math.max(240, Math.round(item.height * scale)) + "px";
}

async function rejectCurrent() {
  if (!cases.length) return;
  const item = cases[index];
  if (!confirm("Move this test case to test_cases/rejected/?\\n\\n" + item.id)) return;
  const response = await fetch("/api/reject", {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({id: item.id}),
  });
  const result = await response.json();
  if (!response.ok) {
    alert(result.error || "failed to reject case");
    return;
  }
  await loadCases();
}

document.getElementById("prev").addEventListener("click", () => show(index - 1));
document.getElementById("next").addEventListener("click", () => show(index + 1));
document.getElementById("reject").addEventListener("click", rejectCurrent);
select.addEventListener("change", () => show(Number(select.value)));
window.addEventListener("resize", sizeViewer);
window.addEventListener("keydown", event => {
  if (event.key === "ArrowLeft") show(index - 1);
  if (event.key === "ArrowRight" || event.key === " ") show(index + 1);
  if (event.key.toLowerCase() === "d") rejectCurrent();
});
loadCases();
</script>
</body>
</html>`;
}

async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    try {
        if (req.method === "GET" && url.pathname === "/") {
            sendText(res, 200, "text/html; charset=utf-8", htmlPage());
            return;
        }
        if (req.method === "GET" && url.pathname === "/api/cases") {
            sendJson(res, 200, listCases());
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/reject") {
            const body = await readJsonBody(req);
            const rejectedPath = rejectCase(body.id);
            sendJson(res, 200, {ok: true, rejectedPath});
            return;
        }
        if (req.method === "GET" && url.pathname.startsWith("/overlay/")) {
            const id = decodeURIComponent(path.basename(url.pathname, ".svg"));
            const testCase = buildCases().find(candidate => candidate.id === id);
            if (!testCase) {
                sendJson(res, 404, {error: "case not found"});
                return;
            }
            sendText(res, 200, "image/svg+xml; charset=utf-8", await overlaySvg(testCase));
            return;
        }
        if (req.method === "GET" && url.pathname.startsWith("/image/")) {
            const name = path.basename(decodeURIComponent(url.pathname.slice("/image/".length)));
            const file = path.join(IMAGE_DIR, name);
            if (!fs.existsSync(file)) {
                sendJson(res, 404, {error: "image not found"});
                return;
            }
            res.writeHead(200, {"content-type": "image/png", "cache-control": "no-store"});
            fs.createReadStream(file).pipe(res);
            return;
        }
        sendJson(res, 404, {error: "not found"});
    } catch (error) {
        sendJson(res, 500, {error: error.message});
    }
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    const server = http.createServer((req, res) => {
        handle(req, res);
    });
    server.listen(options.port, options.host, () => {
        console.log(`AIDA star overlay QA: http://${options.host}:${options.port}/`);
    });
}

if (require.main === module) {
    main();
}
