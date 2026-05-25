#!/usr/bin/env node
"use strict";

const path = require("node:path");

const {
    buildCases,
    knownLensValidationMap,
    projectStars,
    readPngImageData,
    scoreIdentificationAgainstKnownLens,
    simulateGuiAutoIdentify,
} = require("./generate_test_report.js");

const ROOT = path.join(__dirname, "..");
const IMAGE_DIR = path.join(ROOT, "calibration_images");

async function main() {
    const filters = process.argv.slice(2);
    const cases = buildCases().filter(testCase =>
        filters.length === 0 ||
        filters.some(filter => testCase.id.includes(filter) || testCase.title.includes(filter))
    );
    if (cases.length === 0) {
        throw new Error(`no matching test cases for: ${filters.join(", ")}`);
    }
    for (const testCase of cases) {
        const imageData = readPngImageData(path.join(IMAGE_DIR, testCase.image));
        const guiAuto = await simulateGuiAutoIdentify(testCase, imageData);
        const stageDetection = await require("../js/star_detector.js").detectBrightStars(
            imageData,
            testCase.detectorOptions
        );
        const validation = knownLensValidationMap(
            stageDetection.detections,
            projectStars(testCase, testCase.optpar, testCase.maxMag),
            testCase.matchRadiusPx
        );
        const score = scoreIdentificationAgainstKnownLens(guiAuto.matches, validation);
        console.log(`\n${testCase.id}`);
        console.log(`  ${score.correct}/${score.total} correct, ${score.incorrect} wrong, ${score.unknown} outside truth map`);
        console.log(`  ${guiAuto.summaries.join(" / ")}`);
        for (const wrong of score.wrong) {
            const truthName = String(wrong.truth).split("|")[0];
            const match = wrong.match;
            console.log(
                `  wrong d${match.detection.id}: got ${match.star.name || match.star.key}, ` +
                `truth ${truthName}, metric ${Number(match.distance).toFixed(3)}`
            );
        }
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
