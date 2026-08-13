#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(process.argv[2] || "test_cases");
const write = process.argv.includes("--write");
let changed = 0;

for (const name of fs.readdirSync(root)) {
    const metadataPath = path.join(root, name, "metadata.json");
    if (!fs.existsSync(metadataPath)) {
        continue;
    }
    const testCase = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    if (testCase.modelCoordinates === "raw_image_pixel_centers") {
        continue;
    }
    const display = testCase.display || {};
    const flipX = Boolean(display.flipX) !== Boolean(display.imageFlipX);
    const flipY = Boolean(display.flipY) !== Boolean(display.imageFlipY);
    if (!flipX && !flipY) {
        testCase.modelCoordinates = "raw_image_pixel_centers";
    } else {
        const optpar = testCase.optpar;
        if (!Array.isArray(optpar) || optpar.length < 9 || !testCase.width || !testCase.height) {
            throw new Error(`${name}: cannot migrate invalid optpar/image dimensions`);
        }
        if (flipX) {
            optpar[1] = -optpar[1];
            optpar[6] = 1 / testCase.width - optpar[6];
        }
        if (flipY) {
            optpar[2] = -optpar[2];
            optpar[7] = 1 / testCase.height - optpar[7];
        }
        testCase.modelCoordinates = "raw_image_pixel_centers";
    }
    testCase.display = {...display, flipX: false, flipY: false};
    console.log(`${write ? "migrating" : "would migrate"} ${name}: x=${flipX} y=${flipY}`);
    changed += 1;
    if (write) {
        const backup = `${metadataPath}.pre-raw-pixel-model`;
        if (!fs.existsSync(backup)) {
            fs.copyFileSync(metadataPath, backup);
        }
        const temporary = `${metadataPath}.tmp-${process.pid}`;
        fs.writeFileSync(temporary, JSON.stringify(testCase, null, 2) + "\n");
        fs.renameSync(temporary, metadataPath);
    }
}

console.log(`${write ? "migrated" : "found"} ${changed} test cases`);
