const assert = require("node:assert/strict");
const test = require("node:test");

const {
    contentType,
    imageInfoFromDataUrl,
    imageInfoFromUpload,
    MAX_IMAGE_BYTES,
    MAX_JSON_BODY_BYTES,
    parseMultipartPayload,
} = require("../tools/serve_calibrator.js");

function dataUrl(mime, buffer) {
    return `data:${mime};base64,${buffer.toString("base64")}`;
}

function minimalFitsBuffer() {
    const cards = [
        "SIMPLE  = T",
        "BITPIX  = 16",
        "NAXIS   = 2",
        "NAXIS1  = 1",
        "NAXIS2  = 1",
        "END",
    ];
    const header = Buffer.from(cards.map(card => card.padEnd(80, " ")).join("").padEnd(2880, " "), "ascii");
    const data = Buffer.alloc(2880, 0);
    data.writeInt16BE(123, 0);
    return Buffer.concat([header, data]);
}

test("test-case image parser accepts FITS uploads", () => {
    const image = imageInfoFromDataUrl(dataUrl("application/fits", minimalFitsBuffer()));
    assert.equal(image.mime, "application/fits");
    assert.equal(image.ext, ".fits");
    assert.equal(image.buffer.readInt16BE(2880), 123);
});

test("test-case image parser accepts generic FITS MIME fallbacks", () => {
    for (const mime of ["image/fits", "image/x-fits", "application/x-fits", "application/octet-stream"]) {
        const image = imageInfoFromDataUrl(dataUrl(mime, minimalFitsBuffer()));
        assert.equal(image.mime, mime);
        assert.equal(image.ext, ".fits");
    }
});

test("test-case image parser accepts uploaded original FITS files", () => {
    const image = imageInfoFromUpload({
        filename: "camera_frame.fit",
        mime: "application/octet-stream",
        buffer: minimalFitsBuffer(),
    });
    assert.equal(image.mime, "application/fits");
    assert.equal(image.ext, ".fits");
    assert.equal(image.buffer.readInt16BE(2880), 123);
});

test("multipart parser extracts metadata and original FITS file", () => {
    const boundary = "aida-test-boundary";
    const testCase = {id: "multipart-fits", image: "camera_frame.fits", width: 1, height: 1};
    const chunks = [
        `--${boundary}\r\n`,
        "Content-Disposition: form-data; name=\"testCase\"\r\n\r\n",
        JSON.stringify(testCase),
        "\r\n",
        `--${boundary}\r\n`,
        "Content-Disposition: form-data; name=\"image\"; filename=\"camera_frame.fits\"\r\n",
        "Content-Type: application/fits\r\n\r\n",
        minimalFitsBuffer(),
        "\r\n",
        `--${boundary}--\r\n`,
    ];
    const payload = parseMultipartPayload(
        `multipart/form-data; boundary=${boundary}`,
        Buffer.concat(chunks.map(chunk => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"))),
    );
    assert.deepEqual(payload.testCase, testCase);
    assert.equal(payload.imageUpload.filename, "camera_frame.fits");
    assert.equal(payload.imageUpload.mime, "application/fits");
    assert.equal(payload.imageUpload.buffer.readInt16BE(2880), 123);
});

test("test-case image parser rejects mislabeled FITS uploads", () => {
    assert.throws(
        () => imageInfoFromDataUrl(dataUrl("application/fits", Buffer.from("not a fits file"))),
        /image content does not look like application\/fits/,
    );
});

test("server content type recognizes FITS extensions", () => {
    assert.equal(contentType("case.fits"), "application/fits");
    assert.equal(contentType("case.fit"), "application/fits");
    assert.equal(contentType("case.fts"), "application/fits");
});

test("JSON body limit can hold a maximum-size base64 image payload", () => {
    const base64Bytes = Math.ceil(MAX_IMAGE_BYTES * 4 / 3);
    const jsonOverheadBytes = 4096;
    assert.ok(
        MAX_JSON_BODY_BYTES >= base64Bytes + jsonOverheadBytes,
        `JSON limit ${MAX_JSON_BODY_BYTES} should fit base64 image payload ${base64Bytes}`,
    );
});
