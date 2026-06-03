#!/usr/bin/env node
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const {URL} = require("url");

const ROOT = path.join(__dirname, "..");
const DEFAULT_TEST_CASE_DIR = "/mnt/shovel/aida";
const MAX_JSON_BODY_BYTES = Number(process.env.AIDA_MAX_JSON_BODY_BYTES || 128 * 1024 * 1024);
const MAX_IMAGE_BYTES = Number(process.env.AIDA_MAX_IMAGE_BYTES || 64 * 1024 * 1024);
const MAX_METADATA_BYTES = Number(process.env.AIDA_MAX_METADATA_BYTES || 2 * 1024 * 1024);
const MAX_MULTIPART_BODY_BYTES = Number(process.env.AIDA_MAX_MULTIPART_BODY_BYTES || MAX_IMAGE_BYTES + MAX_METADATA_BYTES + 1024 * 1024);
const ALLOWED_IMAGE_TYPES = new Map([
    ["image/png", {ext: ".png", signatures: [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]}],
    ["image/jpeg", {ext: ".jpg", signatures: [Buffer.from([0xff, 0xd8, 0xff])]}],
    ["image/heic", {ext: ".heic", signatures: []}],
    ["image/heif", {ext: ".heif", signatures: []}],
    ["image/fits", {ext: ".fits", signatures: [Buffer.from("SIMPLE  ", "ascii")]}],
    ["image/x-fits", {ext: ".fits", signatures: [Buffer.from("SIMPLE  ", "ascii")]}],
    ["application/fits", {ext: ".fits", signatures: [Buffer.from("SIMPLE  ", "ascii")]}],
    ["application/x-fits", {ext: ".fits", signatures: [Buffer.from("SIMPLE  ", "ascii")]}],
    ["application/fits-image", {ext: ".fits", signatures: [Buffer.from("SIMPLE  ", "ascii")]}],
    ["application/octet-stream", {ext: ".fits", signatures: [Buffer.from("SIMPLE  ", "ascii")]}],
]);

function parseArgs(argv) {
    const options = {
        host: "127.0.0.1",
        port: 8790,
        testCaseDir: process.env.AIDA_TEST_CASE_DIR || DEFAULT_TEST_CASE_DIR,
        submitPassKey: process.env.AIDA_SUBMIT_PASSKEY || "",
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
        } else if (arg === "--test-case-dir" && argv[i + 1]) {
            options.testCaseDir = argv[i + 1];
            i += 1;
        } else if (arg.startsWith("--test-case-dir=")) {
            options.testCaseDir = arg.slice("--test-case-dir=".length);
        } else if (arg === "--submit-passkey" && argv[i + 1]) {
            options.submitPassKey = argv[i + 1];
            i += 1;
        } else if (arg.startsWith("--submit-passkey=")) {
            options.submitPassKey = arg.slice("--submit-passkey=".length);
        }
    }
    options.testCaseDir = path.resolve(options.testCaseDir);
    return options;
}

function requireSubmitPassKey(req, options) {
    if (!options.submitPassKey) {
        return;
    }
    const submitted = String(req.headers["x-aida-submit-passkey"] || "");
    if (submitted !== options.submitPassKey) {
        const error = new Error("invalid submit pass key");
        error.statusCode = 403;
        throw error;
    }
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
        ".heic": "image/heic",
        ".heif": "image/heif",
        ".fits": "application/fits",
        ".fit": "application/fits",
        ".fts": "application/fits",
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
        let bytes = 0;
        let tooLarge = false;
        req.setEncoding("utf8");
        req.on("data", chunk => {
            bytes += Buffer.byteLength(chunk, "utf8");
            if (bytes > MAX_JSON_BODY_BYTES) {
                tooLarge = true;
                return;
            }
            if (!tooLarge) {
                body += chunk;
            }
        });
        req.on("end", () => {
            if (tooLarge) {
                reject(new Error(`request body too large; limit is ${MAX_JSON_BODY_BYTES} bytes`));
                return;
            }
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (error) {
                reject(error);
            }
        });
        req.on("error", reject);
    });
}

function readRawBody(req, limitBytes = MAX_MULTIPART_BODY_BYTES) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let bytes = 0;
        let tooLarge = false;
        req.on("data", chunk => {
            bytes += chunk.length;
            if (bytes > limitBytes) {
                tooLarge = true;
                return;
            }
            if (!tooLarge) {
                chunks.push(chunk);
            }
        });
        req.on("end", () => {
            if (tooLarge) {
                reject(new Error(`request body too large; limit is ${limitBytes} bytes`));
                return;
            }
            resolve(Buffer.concat(chunks));
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

function assertStoragePath(testCaseDir, target) {
    const relative = path.relative(testCaseDir, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("invalid storage path");
    }
}

function imageInfoFromDataUrl(dataUrl) {
    const match = String(dataUrl || "").match(/^data:((?:image\/(?:png|jpeg|heic|heif|x-fits|fits))|(?:application\/(?:x-fits|fits|fits-image|octet-stream)));base64,([A-Za-z0-9+/=\s]+)$/i);
    if (!match) {
        throw new Error("missing imageDataUrl; allowed types are PNG, JPEG, HEIC, HEIF, and FITS");
    }
    const mime = match[1].toLowerCase();
    const allowed = ALLOWED_IMAGE_TYPES.get(mime);
    if (!allowed) {
        throw new Error("unsupported image type");
    }
    const base64 = match[2].replace(/\s+/g, "");
    const estimatedBytes = Math.floor(base64.length * 3 / 4);
    if (estimatedBytes > MAX_IMAGE_BYTES) {
        throw new Error(`image too large; limit is ${MAX_IMAGE_BYTES} bytes`);
    }
    const buffer = Buffer.from(base64, "base64");
    if (buffer.length === 0) {
        throw new Error("empty image");
    }
    if (buffer.length > MAX_IMAGE_BYTES) {
        throw new Error(`image too large; limit is ${MAX_IMAGE_BYTES} bytes`);
    }
    if (!imageBufferMatchesMime(buffer, mime)) {
        throw new Error(`image content does not look like ${mime}`);
    }
    return {mime, ext: allowed.ext, buffer};
}

function imageInfoFromUpload(part) {
    const filename = path.basename(String(part && part.filename || ""));
    let mime = String(part && part.mime || "").toLowerCase();
    const buffer = part && part.buffer;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw new Error("empty image");
    }
    if (buffer.length > MAX_IMAGE_BYTES) {
        throw new Error(`image too large; limit is ${MAX_IMAGE_BYTES} bytes`);
    }
    const ext = path.extname(filename).toLowerCase();
    if (!ALLOWED_IMAGE_TYPES.has(mime) || mime === "application/octet-stream") {
        if (ext === ".fits" || ext === ".fit" || ext === ".fts") {
            mime = "application/fits";
        }
    }
    const allowed = ALLOWED_IMAGE_TYPES.get(mime);
    if (!allowed) {
        throw new Error("unsupported image type");
    }
    if (!imageBufferMatchesMime(buffer, mime)) {
        throw new Error(`image content does not look like ${mime}`);
    }
    return {mime, ext: allowed.ext, buffer};
}

function parseContentDisposition(value) {
    const out = {};
    for (const item of String(value || "").split(";")) {
        const trimmed = item.trim();
        const eq = trimmed.indexOf("=");
        if (eq < 0) {
            out.type = trimmed.toLowerCase();
            continue;
        }
        const key = trimmed.slice(0, eq).trim().toLowerCase();
        let val = trimmed.slice(eq + 1).trim();
        if (val.startsWith("\"") && val.endsWith("\"")) {
            val = val.slice(1, -1).replace(/\\"/g, "\"");
        }
        out[key] = val;
    }
    return out;
}

function parseMultipartPayload(contentTypeHeader, body) {
    const boundaryMatch = String(contentTypeHeader || "").match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!boundaryMatch) {
        throw new Error("missing multipart boundary");
    }
    const boundary = Buffer.from(`--${boundaryMatch[1] || boundaryMatch[2]}`);
    const payload = {};
    let offset = 0;
    for (;;) {
        const start = body.indexOf(boundary, offset);
        if (start < 0) {
            break;
        }
        let partStart = start + boundary.length;
        if (body.subarray(partStart, partStart + 2).toString("ascii") === "--") {
            break;
        }
        if (body.subarray(partStart, partStart + 2).toString("ascii") === "\r\n") {
            partStart += 2;
        }
        const next = body.indexOf(boundary, partStart);
        if (next < 0) {
            break;
        }
        let part = body.subarray(partStart, next);
        if (part.length >= 2 && part.subarray(part.length - 2).toString("ascii") === "\r\n") {
            part = part.subarray(0, part.length - 2);
        }
        const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
        if (headerEnd < 0) {
            offset = next;
            continue;
        }
        const headerText = part.subarray(0, headerEnd).toString("utf8");
        const content = part.subarray(headerEnd + 4);
        const headers = {};
        for (const line of headerText.split("\r\n")) {
            const colon = line.indexOf(":");
            if (colon > 0) {
                headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
            }
        }
        const disposition = parseContentDisposition(headers["content-disposition"]);
        if (disposition.name === "testCase") {
            payload.testCase = JSON.parse(content.toString("utf8"));
        } else if (disposition.name === "image") {
            payload.imageUpload = {
                filename: disposition.filename || "",
                mime: headers["content-type"] || "",
                buffer: content,
            };
        }
        offset = next;
    }
    return payload;
}

function imageBufferMatchesMime(buffer, mime) {
    if (mime === "image/heic" || mime === "image/heif") {
        return looksLikeIsoBmffImage(buffer, mime);
    }
    const allowed = ALLOWED_IMAGE_TYPES.get(mime);
    return allowed.signatures.some(signature => buffer.subarray(0, signature.length).equals(signature));
}

function looksLikeIsoBmffImage(buffer, mime) {
    if (buffer.length < 12 || buffer.toString("ascii", 4, 8) !== "ftyp") {
        return false;
    }
    const brand = buffer.toString("ascii", 8, 12).toLowerCase();
    const compatible = buffer.subarray(16, Math.min(buffer.length, 128)).toString("ascii").toLowerCase();
    const brands = mime === "image/heic" ? ["heic", "heix", "hevc", "hevx"] : ["heif", "heim", "mif1", "msf1"];
    return brands.some(value => brand === value || compatible.includes(value));
}

function listTestCases(testCaseDir) {
    if (!fs.existsSync(testCaseDir)) {
        return [];
    }
    return fs.readdirSync(testCaseDir)
        .sort((a, b) => a.localeCompare(b))
        .map(name => {
            const dir = path.join(testCaseDir, name);
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
                    metadata: path.relative(testCaseDir, metadataPath),
                };
            } catch (error) {
                return null;
            }
        })
        .filter(Boolean);
}

function loadTestCase(testCaseDir, id) {
    const safeId = safeCaseId(id);
    if (safeId !== id) {
        throw new Error("invalid test case id");
    }
    const dir = path.join(testCaseDir, safeId);
    assertStoragePath(testCaseDir, dir);
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

function saveTestCase(testCaseDir, payload) {
    const testCase = payload && payload.testCase;
    if (!testCase || typeof testCase !== "object") {
        throw new Error("missing testCase object");
    }
    if (Number(testCase.width) > 100_000 || Number(testCase.height) > 100_000) {
        throw new Error("unreasonable image dimensions");
    }
    const id = safeCaseId(testCase.id || testCase.image);
    const image = payload.imageUpload ?
        imageInfoFromUpload(payload.imageUpload) :
        imageInfoFromDataUrl(payload.imageDataUrl);
    fs.mkdirSync(testCaseDir, {recursive: true});
    const caseDir = path.join(testCaseDir, id);
    assertStoragePath(testCaseDir, caseDir);
    const updated = fs.existsSync(path.join(caseDir, "metadata.json"));
    fs.mkdirSync(caseDir, {recursive: true});
    const imageName = `${path.basename(caseDir)}${image.ext}`;
    const metadata = {
        ...testCase,
        id: path.basename(caseDir),
        image: imageName,
        source: "aida browser manual calibration",
        imageMimeType: image.mime,
        imageBytes: image.buffer.length,
        savedUtc: new Date().toISOString(),
        updatedUtc: updated ? new Date().toISOString() : undefined,
    };
    const metadataJson = `${JSON.stringify(metadata, null, 2)}\n`;
    if (Buffer.byteLength(metadataJson, "utf8") > MAX_METADATA_BYTES) {
        throw new Error(`metadata too large; limit is ${MAX_METADATA_BYTES} bytes`);
    }
    fs.writeFileSync(path.join(caseDir, imageName), image.buffer, {mode: 0o640});
    fs.writeFileSync(path.join(caseDir, "metadata.json"), metadataJson, {mode: 0o640});
    return {
        caseId: metadata.id,
        relativeDir: path.relative(testCaseDir, caseDir),
        metadata: path.relative(testCaseDir, path.join(caseDir, "metadata.json")),
        image: path.relative(testCaseDir, path.join(caseDir, imageName)),
        imageBytes: image.buffer.length,
        imageMimeType: image.mime,
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

async function handle(req, res, options) {
    const url = new URL(req.url, "http://localhost");
    try {
        if (req.method === "GET" && url.pathname === "/api/test-cases") {
            sendJson(res, 200, listTestCases(options.testCaseDir));
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/test-cases") {
            requireSubmitPassKey(req, options);
            const contentTypeHeader = String(req.headers["content-type"] || "");
            const payload = /^multipart\/form-data/i.test(contentTypeHeader) ?
                parseMultipartPayload(contentTypeHeader, await readRawBody(req)) :
                await readJsonBody(req);
            sendJson(res, 200, saveTestCase(options.testCaseDir, payload));
            return;
        }
        const caseMatch = url.pathname.match(/^\/api\/test-cases\/([^/]+)$/);
        if (req.method === "GET" && caseMatch) {
            sendJson(res, 200, loadTestCase(options.testCaseDir, decodeURIComponent(caseMatch[1])));
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
            const imagePath = path.join(options.testCaseDir, id, image);
            assertStoragePath(options.testCaseDir, imagePath);
            if (!fs.existsSync(imagePath)) {
                sendJson(res, 404, {error: "image not found"});
                return;
            }
            const type = contentType(imagePath);
            if (!ALLOWED_IMAGE_TYPES.has(type)) {
                sendJson(res, 403, {error: "forbidden image type"});
                return;
            }
            res.writeHead(200, {"content-type": type, "cache-control": "no-store"});
            fs.createReadStream(imagePath).pipe(res);
            return;
        }
        if (req.method === "GET") {
            serveStatic(req, res, url);
            return;
        }
        sendJson(res, 405, {error: "method not allowed"});
    } catch (error) {
        const message = error.message || String(error);
        const clientError = /^(empty|invalid|missing|request body too large|image too large|metadata too large|unsupported|unreasonable|image content)/i.test(message);
        sendJson(res, error.statusCode || (clientError ? 400 : 500), {error: message});
    }
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    const server = http.createServer((req, res) => {
        handle(req, res, options);
    });
    server.listen(options.port, options.host, () => {
        console.log(`WISC: http://${options.host}:${options.port}/`);
        console.log(`WISC test-case submissions: ${options.testCaseDir}`);
        console.log(`WISC submit pass key: ${options.submitPassKey ? "required" : "not configured"}`);
    });
}

if (require.main === module) {
    main();
}

module.exports = {
    ALLOWED_IMAGE_TYPES,
    DEFAULT_TEST_CASE_DIR,
    MAX_JSON_BODY_BYTES,
    MAX_IMAGE_BYTES,
    MAX_MULTIPART_BODY_BYTES,
    contentType,
    imageInfoFromDataUrl,
    imageInfoFromUpload,
    parseMultipartPayload,
    parseArgs,
    safeCaseId,
};
