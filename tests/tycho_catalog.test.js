const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const zlib = require("node:zlib");

function angularSeparationDeg(a, b) {
    const ra1 = a.raDeg * Math.PI / 180;
    const ra2 = b.raDeg * Math.PI / 180;
    const dec1 = a.decDeg * Math.PI / 180;
    const dec2 = b.decDeg * Math.PI / 180;
    const cosSep = Math.sin(dec1) * Math.sin(dec2) +
        Math.cos(dec1) * Math.cos(dec2) * Math.cos(ra1 - ra2);
    return Math.acos(Math.max(-1, Math.min(1, cosSep))) * 180 / Math.PI;
}

function loadTychoRows() {
    const file = path.join(__dirname, "..", "data", "tycho2_mag8.bin.gz");
    const buffer = zlib.gunzipSync(fs.readFileSync(file));
    const count = buffer.readUInt32LE(8);
    const stride = buffer.readUInt32LE(12);
    const rows = [];
    for (let i = 0; i < count; i += 1) {
        const offset = 16 + i * stride * 4;
        rows.push({
            raDeg: buffer.readFloatLE(offset) * 15,
            decDeg: buffer.readFloatLE(offset + 4),
            vtMag: buffer.readFloatLE(offset + 8),
        });
    }
    return {buffer, rows};
}

test("Tycho-2 browser catalogue is compact Float32 RA/Dec/VT data", () => {
    const compressed = fs.readFileSync(path.join(__dirname, "..", "data", "tycho2_mag8.bin.gz"));
    assert.ok(compressed.length < 380000, `compressed catalogue should stay compact, got ${compressed.length} bytes`);
    const {buffer} = loadTychoRows();
    assert.equal(buffer.subarray(0, 8).toString("ascii"), "WISCAT1\0");
    assert.equal(buffer[0], 0x57);
    assert.equal(buffer[7], 0x00);
    const count = buffer.readUInt32LE(8);
    const stride = buffer.readUInt32LE(12);
    assert.equal(stride, 3);
    assert.notEqual(count, buffer.readUInt32BE(8), "catalogue count must be interpreted as little-endian");
    assert.equal(buffer.length, 16 + count * stride * 4);
    assert.ok(count > 40000, `expected more than 40000 Tycho-2 stars, got ${count}`);
    assert.ok(buffer.length < 600000, `catalogue binary should stay compact, got ${buffer.length} bytes`);

    let previousMag = -Infinity;
    for (let i = 0; i < count; i += Math.max(1, Math.floor(count / 100))) {
        const offset = 16 + i * stride * 4;
        const raHours = buffer.readFloatLE(offset);
        const decDeg = buffer.readFloatLE(offset + 4);
        const vtMag = buffer.readFloatLE(offset + 8);
        assert.ok(raHours >= 0 && raHours <= 24, `bad RA hours ${raHours}`);
        assert.ok(decDeg >= -90 && decDeg <= 90, `bad Dec deg ${decDeg}`);
        assert.ok(vtMag > -2 && vtMag < 8, `bad VT magnitude ${vtMag}`);
        assert.ok(vtMag >= previousMag, "catalogue should be sorted by VT magnitude");
        previousMag = vtMag;
    }
});

test("Tycho-2 metadata specifies the portable binary layout", () => {
    const metadata = JSON.parse(
        fs.readFileSync(path.join(__dirname, "..", "data", "tycho2_mag8.json"), "utf8"),
    );
    assert.equal(metadata.format.payloadMagic, "WISCAT1\\0");
    assert.equal(metadata.format.byteOrder, "little-endian");
    assert.equal(metadata.format.floatEncoding, "IEEE-754 binary32 little-endian");
    assert.deepEqual(
        metadata.sources.map(source => source.source),
        ["data/catalog.dat", "data/suppl_1.dat", "data/suppl_2.dat"],
    );
    assert.equal(metadata.sources[0].rightAscensionColumn, 25);
    assert.equal(metadata.sources[0].declinationColumn, 26);
    assert.equal(metadata.sources[0].vtMagnitudeColumn, 20);
    assert.equal(metadata.maxMagnitudeExclusive, 8);
});

test("Tycho-2 browser catalogue contains all Yale stars brighter than magnitude 4", () => {
    const context = {window: {}};
    vm.createContext(context);
    vm.runInContext(
        fs.readFileSync(path.join(__dirname, "..", "js", "star_catalog.js"), "utf8"),
        context,
    );
    const yaleBright = context.window.AIDA_STAR_CATALOG
        .filter(star => star[2] < 4)
        .map(star => ({
            raDeg: star[0] * 15,
            decDeg: star[1],
            mag: star[2],
            name: star[3] || star[4] || "",
        }));
    const {rows: tychoRows} = loadTychoRows();
    const missing = [];
    let worstMatchDeg = 0;
    for (const yaleStar of yaleBright) {
        let nearestDeg = Infinity;
        for (const tychoStar of tychoRows) {
            const separationDeg = angularSeparationDeg(yaleStar, tychoStar);
            if (separationDeg < nearestDeg) nearestDeg = separationDeg;
        }
        if (nearestDeg >= 0.1) {
            missing.push(`${yaleStar.name || "unnamed"} nearest ${nearestDeg.toFixed(4)} deg`);
        }
        worstMatchDeg = Math.max(worstMatchDeg, nearestDeg);
    }
    assert.deepEqual(missing, []);
    assert.ok(worstMatchDeg < 0.01, `worst bright-star match should be tight, got ${worstMatchDeg} deg`);
});
