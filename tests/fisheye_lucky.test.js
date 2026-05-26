const assert = require("node:assert/strict");
const test = require("node:test");

const {runFisheyeLuckyCase} = require("../tools/fisheye_lucky_report.js");

const RUN_FISHEYE_LUCKY_TESTS = process.env.AIDA_FISHEYE_LUCKY_TESTS === "1";

test("KRN fisheye lucky mode detects annulus and finds blind star associations", {
    skip: !RUN_FISHEYE_LUCKY_TESTS,
    timeout: 120000,
}, async () => {
    const result = await runFisheyeLuckyCase("2026-02-12T19-04-00-000KRN", {writeReport: false});
    assert.equal(result.detection.detected, true);
    assert.ok(result.reference, "saved KRN calibration should provide an optmod 2 horizon reference");
    assert.ok(
        Math.abs(result.detection.radiusPx - result.reference.radiusPx) < 45,
        `detected radius ${result.detection.radiusPx}, reference ${result.reference.radiusPx}`,
    );
    assert.ok(
        Math.hypot(
            result.detection.centerX - result.reference.centerX,
            result.detection.centerY - result.reference.centerY,
        ) < 75,
        "annulus center should be close to saved calibration center",
    );
    assert.ok(
        (result.identification.matches || []).length >= 8,
        `expected at least 8 blind matches, got ${(result.identification.matches || []).length}`,
    );
});
