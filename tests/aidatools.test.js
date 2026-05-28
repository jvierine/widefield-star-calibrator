const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const RUN_FULL_TESTS = process.env.AIDA_FULL_TESTS === "1";

function fullTest(name, fn) {
    test(name, {skip: !RUN_FULL_TESTS, timeout: 1000}, fn);
}

function loadAidaTools() {
    const source = fs.readFileSync(path.join(__dirname, "..", "js", "aidatools.js"), "utf8");
    const context = {
        window: {},
        ArrayBuffer,
        DataView,
        Math,
        Uint8Array,
        Date,
        Number,
        Array,
        TextDecoder,
        console,
    };
    vm.createContext(context);
    vm.runInContext(source, context, {filename: "aidatools.js"});
    return context.window.AidaTools;
}

function assertNear(actual, expected, tolerance = 1e-12) {
    assert.ok(
        Math.abs(actual - expected) <= tolerance,
        `expected ${actual} to be within ${tolerance} of ${expected}`,
    );
}

const AidaTools = loadAidaTools();

function loadStarCatalog() {
    const source = fs.readFileSync(path.join(__dirname, "..", "js", "star_catalog.js"), "utf8");
    const context = {window: {}};
    vm.createContext(context);
    vm.runInContext(source, context, {filename: "star_catalog.js"});
    return context.window.AIDA_STAR_CATALOG;
}

function bufferToArrayBuffer(buffer) {
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function fitsCard(key, value = null) {
    let text = key.padEnd(8, " ");
    if (value !== null) {
        text += `= ${value}`;
    }
    return text.padEnd(80, " ").slice(0, 80);
}

function makeSyntheticFits() {
    const cards = [
        fitsCard("SIMPLE", "T"),
        fitsCard("BITPIX", "16"),
        fitsCard("NAXIS", "3"),
        fitsCard("NAXIS1", "2"),
        fitsCard("NAXIS2", "2"),
        fitsCard("NAXIS3", "2"),
        fitsCard("BSCALE", "1"),
        fitsCard("BZERO", "0"),
        fitsCard("DATE-OBS", "'2026-05-28T12:34:56.000000'"),
        fitsCard("END"),
    ];
    const headerText = cards.join("").padEnd(2880, " ");
    const data = Buffer.alloc(2880, 0);
    [1, 2, 3, 4, 10, 20, 30, 40].forEach((value, index) => {
        data.writeInt16BE(value, index * 2);
    });
    return Buffer.concat([Buffer.from(headerText, "ascii"), data]);
}

function makeExifJpeg() {
    const tiff = Buffer.alloc(512, 0);
    let p = 0;
    tiff.write("II", p, "ascii"); p += 2;
    tiff.writeUInt16LE(42, p); p += 2;
    tiff.writeUInt32LE(8, p);

    const writeEntry = (offset, tag, type, count, value) => {
        tiff.writeUInt16LE(tag, offset);
        tiff.writeUInt16LE(type, offset + 2);
        tiff.writeUInt32LE(count, offset + 4);
        if (Buffer.isBuffer(value)) {
            value.copy(tiff, offset + 8, 0, 4);
        } else {
            tiff.writeUInt32LE(value, offset + 8);
        }
    };
    const writeAscii = (offset, text) => {
        tiff.write(text, offset, "ascii");
        tiff.writeUInt8(0, offset + text.length);
    };
    const writeRationals = (offset, values) => {
        values.forEach(([num, den], i) => {
            tiff.writeUInt32LE(num, offset + i * 8);
            tiff.writeUInt32LE(den, offset + i * 8 + 4);
        });
    };

    const ifd0 = 8;
    tiff.writeUInt16LE(2, ifd0);
    const exifIfd = 38;
    const gpsIfd = 114;
    writeEntry(ifd0 + 2, 0x8769, 4, 1, exifIfd);
    writeEntry(ifd0 + 14, 0x8825, 4, 1, gpsIfd);
    tiff.writeUInt32LE(0, ifd0 + 26);

    tiff.writeUInt16LE(2, exifIfd);
    const dateText = 68;
    const offsetText = 88;
    writeEntry(exifIfd + 2, 0x9003, 2, 20, dateText);
    writeEntry(exifIfd + 14, 0x9011, 2, 7, offsetText);
    tiff.writeUInt32LE(0, exifIfd + 26);
    writeAscii(dateText, "2025:02:19 03:47:01");
    writeAscii(offsetText, "+02:00");

    tiff.writeUInt16LE(6, gpsIfd);
    const latValue = 192;
    const lonValue = 216;
    const altValue = 240;
    writeEntry(gpsIfd + 2, 1, 2, 2, Buffer.from("N\0\0\0", "binary"));
    writeEntry(gpsIfd + 14, 2, 5, 3, latValue);
    writeEntry(gpsIfd + 26, 3, 2, 2, Buffer.from("E\0\0\0", "binary"));
    writeEntry(gpsIfd + 38, 4, 5, 3, lonValue);
    writeEntry(gpsIfd + 50, 5, 1, 1, Buffer.from([0, 0, 0, 0]));
    writeEntry(gpsIfd + 62, 6, 5, 1, altValue);
    tiff.writeUInt32LE(0, gpsIfd + 74);
    writeRationals(latValue, [[51, 1], [26, 1], [5712, 100]]);
    writeRationals(lonValue, [[14, 1], [16, 1], [4584, 100]]);
    writeRationals(altValue, [[1234, 10]]);

    const exifPayload = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff.subarray(0, 248)]);
    const app1Length = exifPayload.length + 2;
    return Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xe1, app1Length >> 8, app1Length & 0xff]),
        exifPayload,
        Buffer.from([0xff, 0xd9]),
    ]);
}

function matMul3(a, b) {
    const out = new Array(9).fill(0);
    for (let r = 0; r < 3; r++) {
        for (let col = 0; col < 3; col++) {
            out[r * 3 + col] =
                a[r * 3 + 0] * b[0 * 3 + col] +
                a[r * 3 + 1] * b[1 * 3 + col] +
                a[r * 3 + 2] * b[2 * 3 + col];
        }
    }
    return out;
}

function matlabCameraRot(alphaDeg, betaDeg, gammaDeg) {
    const a = alphaDeg * Math.PI / 180.0;
    const b = betaDeg * Math.PI / 180.0;
    const g = gammaDeg * Math.PI / 180.0;
    const rot1 = [
        Math.cos(g), -Math.sin(g), 0,
        Math.sin(g), Math.cos(g), 0,
        0, 0, 1,
    ];
    const rot2 = [
        Math.cos(a), 0, Math.sin(a),
        0, 1, 0,
        -Math.sin(a), 0, Math.cos(a),
    ];
    const rot3 = [
        1, 0, 0,
        0, Math.cos(b), Math.sin(b),
        0, -Math.sin(b), Math.cos(b),
    ];
    return matMul3(matMul3(rot2, rot3), rot1);
}

function matlabCameraModel(az, ze, optpar, optmod, width, height) {
    const rot = matlabCameraRot(optpar[2], optpar[3], optpar[4]);
    const e1 = [rot[0], rot[3], rot[6]];
    const e2 = [rot[1], rot[4], rot[7]];
    const e3 = [rot[2], rot[5], rot[8]];
    const sinze = Math.sin(ze);
    const es1 = sinze * Math.sin(az);
    const es2 = sinze * Math.cos(az);
    const es3 = Math.cos(ze);
    const sese1 = es1 * e1[0] + es2 * e1[1] + es3 * e1[2];
    const sese2 = es1 * e2[0] + es2 * e2[1] + es3 * e2[2];
    const sese3 = es1 * e3[0] + es2 * e3[1] + es3 * e3[2];
    const f1 = optpar[0];
    const f2 = optpar[1];
    const dx = optpar[5];
    const dy = optpar[6];
    const alpha = optpar[7];
    const radial = Math.sqrt(sese1 * sese1 + sese2 * sese2);
    let u;
    let w;
    if (optmod === 1) {
        u = f1 * sese1 / sese3 + 0.5 + dx;
        w = f2 * sese2 / sese3 + 0.5 + dy;
    } else if (optmod === 2) {
        const theta = Math.atan(radial / sese3);
        const u2 = radial === 0 ? 0 : f1 * sese1 / radial * Math.sin(alpha * theta);
        const w2 = radial === 0 ? 0 : f2 * sese2 / radial * Math.sin(alpha * theta);
        u = u2 + 0.5 + dx;
        w = w2 + 0.5 + dy;
    } else if (optmod === 3) {
        const theta = Math.atan(radial / sese3);
        const u1 = f1 * (1.0 - alpha) * sese1 / sese3;
        const w1 = f2 * (1.0 - alpha) * sese2 / sese3;
        const u2 = radial === 0 ? 0 : f1 * alpha * sese1 / radial * theta;
        const w2 = radial === 0 ? 0 : f2 * alpha * sese2 / radial * theta;
        u = u1 + u2 + 0.5 + dx;
        w = w1 + w2 + 0.5 + dy;
    } else if (optmod === 4) {
        const theta = Math.abs(Math.atan(radial / sese3));
        const r = Math.pow(theta, alpha);
        u = (radial === 0 ? 0 : f1 * sese1 / radial * r) + 0.5 + dx;
        w = (radial === 0 ? 0 : f2 * sese2 / radial * r) + 0.5 + dy;
    } else if (optmod === 5) {
        const theta = Math.atan(radial / sese3);
        const r = Math.tan(alpha * theta);
        u = (radial === 0 ? 0 : f1 * sese1 / radial * r) + 0.5 + dx;
        w = (radial === 0 ? 0 : f2 * sese2 / radial * r) + 0.5 + dy;
    } else if (optmod === 12) {
        const theta = Math.atan(radial / sese3);
        let r;
        if (alpha > 0) {
            r = Math.tan(alpha * theta) / alpha;
        } else if (alpha < 0) {
            r = Math.sin(alpha * theta) / alpha;
        } else {
            r = Math.abs(theta);
        }
        u = (radial === 0 ? 0 : f1 * sese1 / radial * r) + 0.5 + dx;
        w = (radial === 0 ? 0 : f2 * sese2 / radial * r) + 0.5 + dy;
    } else {
        throw new Error(`unsupported MATLAB reference optmod ${optmod}`);
    }
    return {x: u * width, y: w * height};
}

function pythonCameraModel(cases) {
    const python = process.env.PYTHON || "/opt/miniconda3/bin/python";
    const script = `
import json
import sys
from pathlib import Path
import numpy as np

python_dir = Path.cwd().parent / "python"
sys.path.insert(0, str(python_dir))
from aida_tools_py.camera import camera_model

cases = json.loads(sys.stdin.read())
out = []
for case in cases:
    u, v = camera_model(
        np.array([case["az"]], dtype=float),
        np.array([case["ze"]], dtype=float),
        np.array(case["optpar"], dtype=float),
        int(case["optmod"]),
        (int(case["height"]), int(case["width"])),
    )
    out.append({"x": float(u[0]), "y": float(v[0])})
print(json.dumps(out))
`;
    const result = childProcess.spawnSync(
        python,
        ["-c", script],
        {
            cwd: path.join(__dirname, ".."),
            input: JSON.stringify(cases),
            encoding: "utf8",
        },
    );
    if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout || `python exited ${result.status}`);
    }
    return JSON.parse(result.stdout);
}

test("datetime-local conversion preserves UTC milliseconds", () => {
    const date = new Date(Date.UTC(2025, 1, 19, 3, 44, 0, 12));
    const value = AidaTools.dateToDatetimeLocal(date);
    assert.equal(value, "2025-02-19T03:44:00.012");
    assert.equal(AidaTools.datetimeLocalToDate(value).toISOString(), "2025-02-19T03:44:00.012Z");
});

test("allsky7 filename timestamp parser handles underscores and milliseconds", () => {
    const date = AidaTools.guessTimestampFromAllsky7Name(
        "2025_02_19_03_44_00_000_012165_first1s.png",
    );
    assert.equal(date.toISOString(), "2025-02-19T03:44:00.000Z");

    const shortMs = AidaTools.guessTimestampFromAllsky7Name("2025-02-19-03-44-00-7.png");
    assert.equal(shortMs.toISOString(), "2025-02-19T03:44:00.700Z");
});

test("allsky7 station metadata parser handles known camera ids and aliases", () => {
    const station = AidaTools.guessAllsky7StationMetadata("2025_02_19_03_46_00_000_010095_first1s.png");
    assert.equal(station.latDeg, 52.5);
    assert.equal(station.lonDeg, 12.6);

    const aliasStation = AidaTools.guessAllsky7StationMetadata(
        "2025_02_19_03_46_00_000_010880_ams0881_first1s.png",
    );
    assert.equal(aliasStation.latDeg, 51.4);
    assert.equal(aliasStation.lonDeg, 14.3);
    assert.equal(AidaTools.guessAllsky7StationMetadata("unknown_first1s.png"), null);
});

test("IRF all-sky filename parser handles KRN timestamps and station metadata", () => {
    const date = AidaTools.guessTimestampFromImageName("2026-01-23T20.05.00.000KRN.jpeg");
    assert.equal(date.toISOString(), "2026-01-23T20:05:00.000Z");

    const station = AidaTools.guessStationMetadataFromName("2026-01-23T20.05.00.000KRN.jpeg");
    assert.equal(station.code, "KRN");
    assert.equal(station.name, "Kiruna IRF");
    assertNear(station.latDeg, 67 + 50 / 60 + 26.588 / 3600, 1e-12);
    assertNear(station.lonDeg, 20 + 24 / 60 + 40.045 / 3600, 1e-12);
    assert.equal(station.altM, 425);
});

test("ALIS station metadata parser handles station codes from IRF report 279", () => {
    const silDate = AidaTools.guessTimestampFromImageName("2026-01-23T20.05.00.000SIL.jpeg");
    assert.equal(silDate.toISOString(), "2026-01-23T20:05:00.000Z");

    const sil = AidaTools.guessStationMetadataFromName("2026-01-23T20.05.00.000SIL.jpeg");
    assert.equal(sil.code, "SIL");
    assert.equal(sil.name, "Silkkimuotka");
    assertNear(sil.latDeg, 68 + 1 / 60 + 47.0 / 3600, 1e-12);
    assertNear(sil.lonDeg, 21 + 41 / 60 + 13.4 / 3600, 1e-12);
    assert.equal(sil.altM, 385);

    const legacy = AidaTools.guessTimestampFromImageName("xMER20260123T200500E01000Q.JPG");
    assert.equal(legacy.toISOString(), "2026-01-23T20:05:00.000Z");
    const mer = AidaTools.guessStationMetadataFromName("xMER20260123T200500E01000Q.JPG");
    assert.equal(mer.code, "MER");
    assert.equal(mer.name, "Merasjärvi");
});

test("compact station filename parser handles Ramfjordmoen timestamps and coordinates", () => {
    const date = AidaTools.guessTimestampFromImageName("20260112173523_RAM.jpg");
    assert.equal(date.toISOString(), "2026-01-12T17:35:23.000Z");

    const missingLeadingTwo = AidaTools.guessTimestampFromImageName("0260112173523_RAM.jpg");
    assert.equal(missingLeadingTwo.toISOString(), "2026-01-12T17:35:23.000Z");

    const station = AidaTools.guessStationMetadataFromName("20260112173523_RAM.jpg");
    assert.equal(station.code, "RAM");
    assert.equal(station.name, "Ramfjordmoen");
    assertNear(station.latDeg, 69.5860, 1e-12);
    assertNear(station.lonDeg, 19.2247, 1e-12);
    assert.equal(station.altM, 0);
});

test("default focal ratios follow image width and height", () => {
    const square = AidaTools.defaultOptparForImageSize(2832, 2832, 2);
    assert.equal(square[0], 1.0);
    assert.equal(square[1], 1.0);
    assert.equal(square[7], 0.35);

    const wide = AidaTools.defaultOptparForImageSize(1920, 1080, 2);
    assert.equal(wide[0], 1.0);
    assertNear(wide[1], 1920 / 1080);

    const brown = AidaTools.defaultOptparForImageSize(2832, 2832, 20);
    assert.equal(brown.length, 12);
    assert.equal(brown[1], 1.0);
    assert.equal(brown[7], 0.0);
});

function syntheticFisheyeImage(width = 320, height = 320, cx = 159.5, cy = 159.5, radius = 138, includeAnnotations = true) {
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const distance = Math.hypot(x - cx, y - cy);
            const inside = distance <= radius;
            const annulus = Math.abs(distance - radius) <= 2.2;
            const texture = 6 * Math.sin(0.09 * x) + 4 * Math.cos(0.07 * y);
            const annotation = includeAnnotations &&
                ((x > 120 && x < 200 && y > 8 && y < 24) || (x > 292 && y > 140 && y < 180));
            const value = Math.max(0, Math.min(255, (inside ? 82 : 4) + texture + (annulus ? 25 : 0) +
                (annotation ? 180 : 0)));
            const k = 4 * (y * width + x);
            data[k] = value;
            data[k + 1] = value;
            data[k + 2] = value;
            data[k + 3] = 255;
        }
    }
    return {width, height, data};
}

test("fisheye annulus detector finds a circular horizon and initial optmod 2 guess", () => {
    const image = syntheticFisheyeImage();
    const detection = AidaTools.detectFisheyeAnnulus(image, {
        filename: "2026-02-12T19.04.00.000KRN.jpeg",
        centerStepPx: 12,
        radiusStepPx: 5,
        samples: 96,
    });
    assert.equal(detection.detected, true);
    assert.equal(detection.method, "peak-density-radial-edge");
    assert.ok(Math.abs(detection.centerX - 159.5) < 5, `center x ${detection.centerX}`);
    assert.ok(Math.abs(detection.centerY - 159.5) < 5, `center y ${detection.centerY}`);
    assert.ok(Math.abs(detection.radiusPx - 138) < 8, `radius ${detection.radiusPx}`);
    assert.equal(detection.initialOptpar.length, 8);
    assertNear(detection.initialOptpar[7], 0.46, 1e-12);
    assert.deepEqual(Array.from(detection.preflatten.preflattenModelCandidates), ["fisheye"]);
    assert.ok(detection.preflatten.preflattenF1Candidates.length >= 3);
});

test("fisheye annulus detector searches for modest optical center offsets", () => {
    const image = syntheticFisheyeImage(320, 320, 173, 146, 136, false);
    const detection = AidaTools.detectFisheyeAnnulus(image, {
        filename: "2026-02-12T19.04.00.000KRN.jpeg",
        centerMaxOffsetFraction: 0.10,
        radialCenterStepPx: 10,
        radialProfileSamples: 128,
    });
    assert.equal(detection.detected, true);
    assert.ok(Math.abs(detection.centerX - 173) < 8, `center x ${detection.centerX}`);
    assert.ok(Math.abs(detection.centerY - 146) < 8, `center y ${detection.centerY}`);
    assert.ok(Math.abs(detection.radiusPx - 136) < 8, `radius ${detection.radiusPx}`);
    assert.ok(detection.centerOffsetFraction > 0.04, `offset ${detection.centerOffsetFraction}`);
    assert.ok(Math.abs(detection.initialOptpar[5]) > 0.02, `du ${detection.initialOptpar[5]}`);
    assert.ok(Math.abs(detection.initialOptpar[6]) > 0.02, `dv ${detection.initialOptpar[6]}`);
    assert.ok(Math.abs(detection.preflatten.detectedCenterDu) > 0.02);
    assert.ok(Math.abs(detection.preflatten.detectedCenterDv) > 0.02);
});

test("fisheye annulus detector rejects flat images", () => {
    const width = 240;
    const height = 240;
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
        data[i] = 40;
        data[i + 1] = 40;
        data[i + 2] = 40;
        data[i + 3] = 255;
    }
    const detection = AidaTools.detectFisheyeAnnulus({width, height, data}, {
        filename: "flat.png",
        centerStepPx: 12,
        radiusStepPx: 5,
    });
    assert.equal(detection.detected, false);
});

test("EXIF parser extracts GPS position, altitude, and timestamp", () => {
    const metadata = AidaTools.parseExifMetadata(bufferToArrayBuffer(makeExifJpeg()));
    assert.equal(metadata.timestampUtc.toISOString(), "2025-02-19T01:47:01.000Z");
    assertNear(metadata.latDeg, 51 + 26 / 60 + 57.12 / 3600, 1e-10);
    assertNear(metadata.lonDeg, 14 + 16 / 60 + 45.84 / 3600, 1e-10);
    assertNear(metadata.altM, 123.4, 1e-10);
});

test("external EXIF metadata normalizer handles HEIC-style fields", () => {
    const metadata = AidaTools.normalizeExternalExifMetadata({
        Make: "Apple",
        Model: "iPhone 15 Pro",
        DateTimeOriginal: "2025:02:19 03:47:01",
        OffsetTimeOriginal: "+02:00",
        latitude: 51.4492,
        longitude: 14.2794,
        GPSAltitude: 123.4,
    });
    assert.equal(metadata.timestampUtc.toISOString(), "2025-02-19T01:47:01.000Z");
    assertNear(metadata.latDeg, 51.4492);
    assertNear(metadata.lonDeg, 14.2794);
    assertNear(metadata.altM, 123.4);
    assert.equal(metadata.cameraMake, "Apple");
    assert.equal(metadata.cameraModel, "iPhone 15 Pro");
});

test("FITS parser integrates multiple image frames into one grayscale image", () => {
    const parsed = AidaTools.parseFitsImage(bufferToArrayBuffer(makeSyntheticFits()), {low: 11, high: 44});
    assert.equal(parsed.width, 2);
    assert.equal(parsed.height, 2);
    assert.equal(parsed.frameCount, 2);
    assert.equal(parsed.header.BITPIX, 16);
    assert.equal(parsed.metadata.timestampUtc, "2026-05-28T12:34:56.000000Z");

    const gray = [];
    for (let i = 0; i < parsed.imageData.data.length; i += 4) {
        gray.push(parsed.imageData.data[i]);
        assert.equal(parsed.imageData.data[i], parsed.imageData.data[i + 1]);
        assert.equal(parsed.imageData.data[i], parsed.imageData.data[i + 2]);
        assert.equal(parsed.imageData.data[i + 3], 255);
    }
    assert.deepEqual(gray, [0, 85, 170, 255]);
});

test("star catalog preserves negative zero-degree declinations", () => {
    const mintaka = loadStarCatalog().find(row => row[3] === "Mintaka");
    assert.ok(mintaka, "Mintaka must be present in the catalog");
    assertNear(mintaka[0], 5.5334444, 1e-7);
    assertNear(mintaka[1], -0.2991667, 1e-7);
});

test("optmod 2 projects zenith to the calibrated image center", () => {
    const optpar = [0.75, 0.75, 0, 0, 0, 0, 0, 1.0];
    const projected = AidaTools.cameraModel(0, 0, optpar, 2, 1024, 768);
    assertNear(projected.x, 511.0);
    assertNear(projected.y, 383.0);
});

test("cameraRot is exported for rotation visualization", () => {
    const rot = AidaTools.cameraRot(0, 0, 0);
    assert.deepEqual(rot, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
});

test("cameraAnglesFromRotation inverts cameraRot for lucky fit seeding", () => {
    const cases = [
        [-60.8, 35.2, 74.5],
        [-19.3, 62.6, 20.5],
        [-79.7, -27.0, 93.0],
        [10.0, 20.0, 30.0],
    ];
    for (const angles of cases) {
        const recovered = AidaTools.cameraAnglesFromRotation(AidaTools.cameraRot(...angles));
        assertNear(recovered.alpha, angles[0], 1e-10);
        assertNear(recovered.beta, angles[1], 1e-10);
        assertNear(recovered.gamma, angles[2], 1e-10);
    }
});

test("optmod 2 follows the sin(alpha * theta) radial model", () => {
    const optpar = [0.8, 0.6, 0, 0, 0, 0.02, -0.03, 0.9];
    const az = Math.PI / 2;
    const ze = 30 * AidaTools.DEG;
    const width = 1000;
    const height = 800;
    const projected = AidaTools.cameraModel(az, ze, optpar, 2, width, height);

    const r = Math.sin(optpar[7] * ze);
    const expectedX = (optpar[0] * r + 0.5 + optpar[5]) * width - 1;
    const expectedY = (0.5 + optpar[6]) * height - 1;
    assertNear(projected.x, expectedX);
    assertNear(projected.y, expectedY);
});

test("optmod 20 follows the Brown-Conrady radial and tangential model", () => {
    const optpar = [0.8, 0.6, 0, 0, 0, 0.02, -0.03, 0.15, -0.04, 0.01, 0.002, -0.003];
    const az = Math.PI / 2;
    const ze = 30 * AidaTools.DEG;
    const width = 1000;
    const height = 800;
    const projected = AidaTools.cameraModel(az, ze, optpar, 20, width, height);

    const xn = Math.tan(ze);
    const r2 = xn * xn;
    const r4 = r2 * r2;
    const r6 = r4 * r2;
    const radial = 1 + optpar[7] * r2 + optpar[8] * r4 + optpar[9] * r6;
    const xDistorted = xn * radial + optpar[11] * (r2 + 2 * xn * xn);
    const yDistorted = optpar[10] * r2 + 2 * optpar[11] * xn * 0;
    const expectedX = (optpar[0] * xDistorted + 0.5 + optpar[5]) * width - 1;
    const expectedY = (optpar[1] * yDistorted + 0.5 + optpar[6]) * height - 1;
    assertNear(projected.x, expectedX);
    assertNear(projected.y, expectedY);
});

test("visibleStars filters by magnitude and zenith angle", () => {
    const catalog = [
        [0, 0, 1.0, "bright"],
        [0, 0, 6.5, "too dim"],
    ];
    const stars = AidaTools.visibleStars(
        catalog,
        new Date(Date.UTC(2025, 0, 1, 0, 0, 0)),
        0,
        0,
        2.0,
        180,
    );
    assert.equal(Array.from(stars, (star) => star.name).join(","), "bright");
});

fullTest("cameraModel matches Python and MATLAB parametric optmod reference coordinates", () => {
    const cases = [
        {
            optmod: 1,
            width: 1024,
            height: 768,
            optpar: [0.71, 0.68, 4.0, -3.0, 12.0, 0.015, -0.02, 0.82],
            az: 12 * AidaTools.DEG,
            ze: 8 * AidaTools.DEG,
        },
        {
            optmod: 2,
            width: 1024,
            height: 768,
            optpar: [0.71, 0.68, 4.0, -3.0, 12.0, 0.015, -0.02, 0.82],
            az: 12 * AidaTools.DEG,
            ze: 8 * AidaTools.DEG,
        },
        {
            optmod: 2,
            width: 1024,
            height: 768,
            optpar: [0.71, 0.68, 4.0, -3.0, 12.0, 0.015, -0.02, 0.82],
            az: 146 * AidaTools.DEG,
            ze: 42 * AidaTools.DEG,
        },
        {
            optmod: 3,
            width: 1280,
            height: 960,
            optpar: [-0.74, 0.72, -2.5, 5.0, -8.0, -0.01, 0.018, 0.47],
            az: 74 * AidaTools.DEG,
            ze: 18 * AidaTools.DEG,
        },
        {
            optmod: 3,
            width: 1280,
            height: 960,
            optpar: [-0.74, 0.72, -2.5, 5.0, -8.0, -0.01, 0.018, 0.47],
            az: 223 * AidaTools.DEG,
            ze: 50 * AidaTools.DEG,
        },
        {
            optmod: 4,
            width: 960,
            height: 720,
            optpar: [0.64, 0.62, 3.0, -2.0, 7.0, 0.01, -0.012, 0.96],
            az: 142 * AidaTools.DEG,
            ze: 38 * AidaTools.DEG,
        },
        {
            optmod: 5,
            width: 960,
            height: 720,
            optpar: [0.64, 0.62, 3.0, -2.0, 7.0, 0.01, -0.012, 0.82],
            az: 78 * AidaTools.DEG,
            ze: 31 * AidaTools.DEG,
        },
        {
            optmod: 12,
            width: 960,
            height: 720,
            optpar: [0.64, 0.62, 3.0, -2.0, 7.0, 0.01, -0.012, -0.55],
            az: 204 * AidaTools.DEG,
            ze: 28 * AidaTools.DEG,
        },
    ];
    const pythonExpected = pythonCameraModel(cases);
    for (const [i, item] of cases.entries()) {
        const js = AidaTools.cameraModel(
            item.az,
            item.ze,
            item.optpar,
            item.optmod,
            item.width,
            item.height,
        );
        const matlab = matlabCameraModel(
            item.az,
            item.ze,
            item.optpar,
            item.optmod,
            item.width,
            item.height,
        );

        // Python and MATLAB use AIDA/Matlab 1-based pixel coordinates.
        // The browser intentionally returns 0-based canvas/image pixels.
        assertNear(js.x + 1, pythonExpected[i].x, 1e-9);
        assertNear(js.y + 1, pythonExpected[i].y, 1e-9);
        assertNear(js.x + 1, matlab.x, 1e-9);
        assertNear(js.y + 1, matlab.y, 1e-9);
    }
});
