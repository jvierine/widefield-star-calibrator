const assert = require("node:assert/strict");
const test = require("node:test");

const {
    contentType,
    imageInfoFromDataUrl,
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
