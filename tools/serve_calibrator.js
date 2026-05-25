#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const {URL} = require("node:url");

const ROOT = path.join(__dirname, "..");
const TEST_CASE_DIR = path.join(ROOT, "test_cases");

function parseArgs(argv) {
    const options = {host: "127.0.0.1", port: 8790};
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

function contentType(filename) {
    const ext = path.extname(filename).toLowerCase();
    return {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".svg": "image/svg+xml; charset=utf-8",
    }[ext] || "application/octet-stream";
}

function safeCaseId(value) {
    return String(value || "aida_case")
        .replace(/\.[^.]*$/, "")
        .replace(/[^A-Za-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 120) || "aida_case";
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", chunk => {
            body += chunk;
            if (body.length > 200_000_000) {
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

function sendJson(res, status, payload) {
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
    });
    res.end(JSON.stringify(payload, null, 2));
}

function listTestCases() {
    if (!fs.existsSync(TEST_CASE_DIR)) {
        return [];
    }
    return fs.readdirSync(TEST_CASE_DIR)
        .sort((a, b) => a.localeCompare(b))
        .map(name => {
            const dir = path.join(TEST_CASE_DIR, name);
            const metadataPath = path.join(dir, "metadata.json");
            if (!fs.existsSync(metadataPath)) {
                return null;
            }
            try {
                const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
                return {
                    id: name,
                    title: metadata.title || name,
                    image: metadata.image || "",
                    timestampUtc: metadata.timestampUtc || "",
                    matches: Array.isArray(metadata.matches) ? metadata.matches.length : 0,
                    residualRmsPx: metadata.residual && Number.isFinite(metadata.residual.rmsPx) ?
                        metadata.residual.rmsPx : null,
                    metadata: path.relative(ROOT, metadataPath),
                };
            } catch (error) {
                return null;
            }
        })
        .filter(Boolean);
}

function loadTestCase(id) {
    const safeId = safeCaseId(id);
    if (safeId !== id) {
        throw new Error("invalid test case id");
    }
    const dir = path.join(TEST_CASE_DIR, safeId);
    const metadataPath = path.join(dir, "metadata.json");
    if (!fs.existsSync(metadataPath)) {
        throw new Error("test case not found");
    }
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    const image = path.basename(metadata.image || `${safeId}.png`);
    const imagePath = path.join(dir, image);
    if (!fs.existsSync(imagePath)) {
        throw new Error("test case image not found");
    }
    return {
        testCase: metadata,
        imageUrl: `/api/test-cases/${encodeURIComponent(safeId)}/image/${encodeURIComponent(image)}`,
    };
}

function saveTestCase(payload) {
    const testCase = payload && payload.testCase;
    if (!testCase || typeof testCase !== "object") {
        throw new Error("missing testCase object");
    }
    const dataUrl = String(payload.imageDataUrl || "");
    const match = dataUrl.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
    if (!match) {
        throw new Error("missing PNG imageDataUrl");
    }
    const id = safeCaseId(testCase.id || testCase.image);
    fs.mkdirSync(TEST_CASE_DIR, {recursive: true});
    const caseDir = path.join(TEST_CASE_DIR, id);
    const updated = fs.existsSync(path.join(caseDir, "metadata.json"));
    fs.mkdirSync(caseDir, {recursive: true});
    const imageName = `${path.basename(caseDir)}.png`;
    const metadata = {
        ...testCase,
        id: path.basename(caseDir),
        image: imageName,
        source: "aida browser manual calibration",
        savedUtc: new Date().toISOString(),
        updatedUtc: updated ? new Date().toISOString() : undefined,
    };
    fs.writeFileSync(path.join(caseDir, imageName), Buffer.from(match[1], "base64"));
    fs.writeFileSync(path.join(caseDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
    return {
        caseId: metadata.id,
        relativeDir: path.relative(ROOT, caseDir),
        metadata: path.relative(ROOT, path.join(caseDir, "metadata.json")),
        image: path.relative(ROOT, path.join(caseDir, imageName)),
        updated,
    };
}

function serveStatic(req, res, url) {
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") {
        pathname = "/index.html";
    }
    const requested = path.normalize(path.join(ROOT, pathname));
    if (!requested.startsWith(ROOT + path.sep) && requested !== ROOT) {
        sendJson(res, 403, {error: "forbidden"});
        return;
    }
    fs.stat(requested, (error, stat) => {
        if (error || !stat.isFile()) {
            sendJson(res, 404, {error: "not found"});
            return;
        }
        res.writeHead(200, {
            "content-type": contentType(requested),
            "cache-control": "no-store",
        });
        fs.createReadStream(requested).pipe(res);
    });
}

async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    try {
        if (req.method === "GET" && url.pathname === "/api/test-cases") {
            sendJson(res, 200, listTestCases());
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/test-cases") {
            sendJson(res, 200, saveTestCase(await readJsonBody(req)));
            return;
        }
        const caseMatch = url.pathname.match(/^\/api\/test-cases\/([^/]+)$/);
        if (req.method === "GET" && caseMatch) {
            sendJson(res, 200, loadTestCase(decodeURIComponent(caseMatch[1])));
            return;
        }
        const imageMatch = url.pathname.match(/^\/api\/test-cases\/([^/]+)\/image\/([^/]+)$/);
        if (req.method === "GET" && imageMatch) {
            const id = decodeURIComponent(imageMatch[1]);
            const image = path.basename(decodeURIComponent(imageMatch[2]));
            if (safeCaseId(id) !== id) {
                sendJson(res, 400, {error: "invalid test case id"});
                return;
            }
            const imagePath = path.join(TEST_CASE_DIR, id, image);
            if (!fs.existsSync(imagePath)) {
                sendJson(res, 404, {error: "image not found"});
                return;
            }
            res.writeHead(200, {"content-type": "image/png", "cache-control": "no-store"});
            fs.createReadStream(imagePath).pipe(res);
            return;
        }
        if (req.method === "GET") {
            serveStatic(req, res, url);
            return;
        }
        sendJson(res, 405, {error: "method not allowed"});
    } catch (error) {
        sendJson(res, 500, {error: error.message || String(error)});
    }
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    const server = http.createServer((req, res) => {
        handle(req, res);
    });
    server.listen(options.port, options.host, () => {
        console.log(`AIDA calibrator: http://${options.host}:${options.port}/`);
    });
}

if (require.main === module) {
    main();
}
