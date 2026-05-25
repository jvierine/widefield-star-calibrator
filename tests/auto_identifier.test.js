const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const zlib = require("node:zlib");

const AutoIdentifier = require("../js/auto_identifier.js");
const StarDetector = require("../js/star_detector.js");
const StarPatchNN = require("../js/star_patch_nn.js");
const {
    runImg9953UndistortedAsterismCase,
} = require("../tools/img9953_undistorted_asterism_report.js");
const {
    buildSensitivityData: buildImg9953SensitivityData,
} = require("../tools/img9953_preundistortion_sensitivity.js");
const {
    buildSensitivityData: buildAllsky010031SensitivityData,
} = require("../tools/allsky010031_ams0221_preundistortion_sensitivity.js");
const {
    detectionOracleMetrics,
} = require("../tools/star_detector_oracle_report.js");
const RUN_FULL_TESTS = process.env.AIDA_FULL_TESTS === "1";
const RUN_SENSITIVITY_TESTS = process.env.AIDA_SENSITIVITY_TESTS === "1";

function fullTest(name, fn) {
    test(name, {skip: !RUN_FULL_TESTS, timeout: 1000}, fn);
}

function slowFullTest(name, fn) {
    test(name, {skip: !RUN_FULL_TESTS, timeout: 10000}, fn);
}

function sensitivityTest(name, fn) {
    test(name, {skip: !RUN_SENSITIVITY_TESTS, timeout: 180000}, fn);
}

function loadBrowserScript(filename) {
    const source = fs.readFileSync(path.join(__dirname, "..", "js", filename), "utf8");
    const context = {
        window: {},
        Math,
        Date,
        Number,
        Array,
        Uint8Array,
        ArrayBuffer,
        DataView,
    };
    vm.createContext(context);
    vm.runInContext(source, context, {filename});
    return context.window;
}

const AidaTools = loadBrowserScript("aidatools.js").AidaTools;
const YaleCatalog = loadBrowserScript("star_catalog.js").AIDA_STAR_CATALOG;
const WIDTH = 1920;
const HEIGHT = 1080;
const DATE = new Date(Date.UTC(2025, 1, 19, 3, 47, 1));
const LAT_DEG = 51.4492;
const LON_DEG = 14.2794;
const MODELS = [1, 2, 3, 4, 5, 12, 20];
const REAL_CASE_IMAGE = path.join(
    __dirname,
    "..",
    "calibration_images",
    "2025_02_19_03_46_00_000_010095_first1s.png",
);
const REAL_CASE = {
    width: 1920,
    height: 1080,
    date: new Date(Date.UTC(2025, 1, 19, 3, 46, 0)),
    latDeg: 52.495090,
    lonDeg: 12.630850,
    optmod: 2,
    optpar: [
        0.784905000000,
        1.39364100000,
        -60.8000000000,
        35.2000000000,
        74.5000000000,
        0.0422890000000,
        0.00841000000000,
        0.895509000000,
    ],
};
const REAL_CASE_010095_0345_IMAGE = path.join(
    __dirname,
    "..",
    "calibration_images",
    "2025_02_19_03_45_00_000_010095_first1s.png",
);
const REAL_CASE_010095_0345 = {
    width: 1920,
    height: 1080,
    date: new Date(Date.UTC(2025, 1, 19, 3, 45, 0)),
    latDeg: 52.495090,
    lonDeg: 12.630850,
    optmod: 2,
    optpar: [
        0.7904385249067769,
        1.4035288342150167,
        -60.72396720176118,
        34.8979397956113,
        74.59441732664129,
        0.04223220907820682,
        0.008203915653934874,
        0.888744565694376,
    ],
};
const REAL_CASE_010760_IMAGE = path.join(
    __dirname,
    "..",
    "calibration_images",
    "2025_02_19_03_44_00_000_010760_first1s.png",
);
const REAL_CASE_010760 = {
    width: 1920,
    height: 1080,
    date: new Date(Date.UTC(2025, 1, 19, 3, 44, 0)),
    latDeg: 50.992500,
    lonDeg: 7.185110,
    altM: 0,
    optmod: 2,
    optpar: [
        0.780325000000,
        1.37950600000,
        -22.5000000000,
        60.3000000000,
        25.6000000000,
        0.0371770000000,
        0.0252550000000,
        0.904231000000,
    ],
};
const REAL_CASE_010880_AMS0881_IMAGE = path.join(
    __dirname,
    "..",
    "calibration_images",
    "2025_02_19_03_46_00_000_010880_ams0881_first1s.png",
);
const REAL_CASE_010880_AMS0881 = {
    width: 1920,
    height: 1080,
    date: new Date(Date.UTC(2025, 1, 19, 3, 46, 0)),
    latDeg: 51.449200,
    lonDeg: 14.279400,
    altM: 384.3,
    optmod: 2,
    optpar: [
        0.776864000000,
        1.37317200000,
        -19.3000000000,
        62.6000000000,
        20.5000000000,
        0.00325700000000,
        0.00125800000000,
        0.904396000000,
    ],
};
const REAL_CASE_010881_AMS0882_IMAGE = path.join(
    __dirname,
    "..",
    "calibration_images",
    "2025_02_19_03_46_01_000_010881_ams0882_first1s.png",
);
const REAL_CASE_010881_AMS0882 = {
    width: 1920,
    height: 1080,
    date: new Date(Date.UTC(2025, 1, 19, 3, 46, 1)),
    latDeg: 51.449200,
    lonDeg: 14.279440,
    altM: 0,
    optmod: 2,
    optpar: [
        -0.784268026036,
        -1.39221901359,
        63.4544680739,
        26.148372555,
        99.3189955262,
        0.00659931326285,
        0.071043416356,
        0.895491331699,
    ],
};
const REAL_CASE_012165_IMAGE = path.join(
    __dirname,
    "..",
    "calibration_images",
    "2025_02_19_03_44_00_000_012165_first1s.png",
);
const REAL_CASE_012165 = {
    width: 1920,
    height: 1080,
    date: new Date(Date.UTC(2025, 1, 19, 3, 44, 0)),
    latDeg: 51.463056,
    lonDeg: 7.221944,
    altM: 0,
    optmod: 2,
    optpar: [
        0.7914106446441598,
        1.4061233878845243,
        -60.61347322115929,
        23.5420580383797,
        76.41065372374601,
        0.03262639938574017,
        0.00038474576397199757,
        0.8876163379356129,
    ],
};
const REAL_CASE_IMG_9371_IMAGE = path.join(
    __dirname,
    "..",
    "calibration_images",
    "IMG_9371.png",
);
const REAL_CASE_IMG_9371 = {
    width: 3024,
    height: 4032,
    date: new Date(Date.UTC(2024, 9, 19, 17, 29, 8)),
    latDeg: 69.600625,
    lonDeg: 18.961947,
    altM: 384.3,
    optmod: 20,
    optpar: [
        1.41164100000,
        1.05299500000,
        -79.7000000000,
        -27.0000000000,
        93.0000000000,
        -0.00657100000000,
        0.0144680000000,
        0.239385000000,
        -0.846254000000,
        1.04222700000,
        -0.000576000000000,
        -0.00337100000000,
    ],
};
const IMG_9953_ASTERISM_HIGH_WATER_FILE = path.join(
    __dirname,
    "..",
    "test_cases",
    "IMG_9953",
    "asterism_high_water.json",
);
const SCENARIOS = [
    {name: "centered", f1: 0.52, f2: 0.92, alpha: 0, beta: 0, gamma: 0, du: 0, dv: 0},
    {name: "tilted", f1: 0.48, f2: 0.84, alpha: 8, beta: -5, gamma: 18, du: 0.03, dv: -0.02},
    {name: "wide-offset", f1: 0.60, f2: 1.05, alpha: -12, beta: 6, gamma: -25, du: -0.015, dv: 0.025},
];

function catalogKey(star) {
    return `${star.name}|${star.raHours.toFixed(7)}|${star.decDeg.toFixed(7)}`;
}

function paethPredictor(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) {
        return a;
    }
    return pb <= pc ? b : c;
}

function readPngImageData(filename) {
    const buffer = fs.readFileSync(filename);
    assert.equal(buffer.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    let offset = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    const idat = [];
    while (offset < buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
        const data = buffer.subarray(offset + 8, offset + 8 + length);
        if (type === "IHDR") {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            bitDepth = data[8];
            colorType = data[9];
            const interlace = data[12];
            assert.equal(bitDepth, 8, "test PNG decoder expects 8-bit images");
            assert.equal(interlace, 0, "test PNG decoder expects non-interlaced images");
        } else if (type === "IDAT") {
            idat.push(data);
        } else if (type === "IEND") {
            break;
        }
        offset += 12 + length;
    }
    const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
    assert.ok(channels > 0, `unsupported PNG color type ${colorType}`);
    const inflated = zlib.inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    const raw = Buffer.alloc(height * stride);
    let src = 0;
    for (let y = 0; y < height; y += 1) {
        const filter = inflated[src];
        src += 1;
        const row = raw.subarray(y * stride, (y + 1) * stride);
        const prev = y > 0 ? raw.subarray((y - 1) * stride, y * stride) : null;
        for (let x = 0; x < stride; x += 1) {
            const value = inflated[src + x];
            const left = x >= channels ? row[x - channels] : 0;
            const up = prev ? prev[x] : 0;
            const upLeft = prev && x >= channels ? prev[x - channels] : 0;
            if (filter === 0) {
                row[x] = value;
            } else if (filter === 1) {
                row[x] = (value + left) & 0xff;
            } else if (filter === 2) {
                row[x] = (value + up) & 0xff;
            } else if (filter === 3) {
                row[x] = (value + Math.floor((left + up) / 2)) & 0xff;
            } else if (filter === 4) {
                row[x] = (value + paethPredictor(left, up, upLeft)) & 0xff;
            } else {
                throw new Error(`unsupported PNG filter ${filter}`);
            }
        }
        src += stride;
    }
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0, j = 0; i < raw.length; i += channels, j += 4) {
        rgba[j] = raw[i];
        rgba[j + 1] = raw[i + 1];
        rgba[j + 2] = raw[i + 2];
        rgba[j + 3] = channels === 4 ? raw[i + 3] : 255;
    }
    return {width, height, data: rgba};
}

function optparForModel(optmod, scenario = SCENARIOS[0]) {
    const common = [
        scenario.f1,
        scenario.f2,
        scenario.alpha,
        scenario.beta,
        scenario.gamma,
        scenario.du,
        scenario.dv,
    ];
    if (optmod === 20) {
        return common.concat([-0.15, 0.02, -0.001, 0.0005, -0.0003]);
    }
    if (optmod === 1 || optmod === 4) {
        return common.concat([1.0]);
    }
    if (optmod === 5) {
        return common.concat([0.5]);
    }
    if (optmod === 12) {
        return common.concat([0.45]);
    }
    return common.concat([0.7]);
}

function projectedYaleStars(optmod, maxMag = 6.5, scenario = SCENARIOS[0]) {
    const optpar = optparForModel(optmod, scenario);
    const visible = AidaTools.visibleStars(YaleCatalog, DATE, LAT_DEG, LON_DEG, maxMag, 88);
    const projected = [];
    for (const star of visible) {
        const xy = AidaTools.cameraModel(star.az, star.ze, optpar, optmod, WIDTH, HEIGHT);
        if (Number.isFinite(xy.x) && Number.isFinite(xy.y) &&
                xy.x >= 20 && xy.x < WIDTH - 20 && xy.y >= 20 && xy.y < HEIGHT - 20) {
            projected.push({...star, x: xy.x, y: xy.y, key: catalogKey(star)});
        }
    }
    projected.sort((a, b) => a.mag - b.mag || a.key.localeCompare(b.key));
    return projected;
}

function projectedRealCaseStars(optpar = REAL_CASE.optpar, maxMag = 4.0, realCase = REAL_CASE) {
    const visible = visibleRealCaseStars(maxMag, realCase);
    const projected = [];
    for (const star of visible) {
        const xy = AidaTools.cameraModel(
            star.az,
            star.ze,
            optpar,
            realCase.optmod,
            realCase.width,
            realCase.height,
        );
        if (Number.isFinite(xy.x) && Number.isFinite(xy.y) &&
                xy.x >= 0 && xy.x < realCase.width &&
                xy.y >= 0 && xy.y < realCase.height) {
            projected.push({...star, x: xy.x, y: xy.y, key: catalogKey(star)});
        }
    }
    projected.sort((a, b) => a.mag - b.mag || a.key.localeCompare(b.key));
    return projected;
}

function visibleRealCaseStars(maxMag = 4.0, realCase = REAL_CASE) {
    return AidaTools.visibleStars(
        YaleCatalog,
        realCase.date,
        realCase.latDeg,
        realCase.lonDeg,
        maxMag,
        88,
    ).map(star => ({...star, key: catalogKey(star)}));
}

function matchDetectionsToKnownStars(detections, knownStars, maxDistancePx = 18) {
    const pairs = [];
    for (const detection of detections) {
        for (const star of knownStars) {
            const distance = Math.hypot(detection.x - star.x, detection.y - star.y);
            if (distance <= maxDistancePx) {
                pairs.push({detection, star, distance});
            }
        }
    }
    pairs.sort((a, b) => a.distance - b.distance);
    const usedDetections = new Set();
    const usedStars = new Set();
    const matches = [];
    for (const pair of pairs) {
        if (usedDetections.has(pair.detection.id) || usedStars.has(pair.star.key)) {
            continue;
        }
        usedDetections.add(pair.detection.id);
        usedStars.add(pair.star.key);
        matches.push(pair);
    }
    return matches;
}

function nearestDetectionDistance(point, detections) {
    let best = Infinity;
    for (const detection of detections) {
        best = Math.min(best, Math.hypot(point.x - detection.x, point.y - detection.y));
    }
    return best;
}

function knownLensValidationMap(detections, knownStars, maxDistancePx = 18) {
    const matches = matchDetectionsToKnownStars(detections, knownStars, maxDistancePx);
    return {
        matches,
        detectionToStar: new Map(matches.map(match => [match.detection.id, match.star.key])),
        starToDetection: new Map(matches.map(match => [match.star.key, match.detection.id])),
    };
}

function scoreIdentificationAgainstKnownLens(matches, validation) {
    const wrong = [];
    let correct = 0;
    let incorrect = 0;
    let unknown = 0;
    for (const match of matches) {
        const truthKey = validation.detectionToStar.get(match.detection.id);
        if (!truthKey) {
            unknown += 1;
        } else if (truthKey === match.star.key) {
            correct += 1;
        } else {
            incorrect += 1;
            wrong.push({
                detectionId: match.detection.id,
                identified: match.star.key,
                truth: truthKey,
            });
        }
    }
    return {total: matches.length, correct, incorrect, unknown, wrong};
}

function readImg9953AsterismHighWater() {
    return JSON.parse(fs.readFileSync(IMG_9953_ASTERISM_HIGH_WATER_FILE, "utf8"));
}

function writeImg9953AsterismHighWater(previous, result) {
    const score = result.identificationScore;
    const next = {
        ...previous,
        correctIdentifiedStars: score.correct,
        oracleDetectorHits: result.validation.matches.length,
        asterismIdentifiedStars: score.total,
        incorrectIdentifiedStars: score.incorrect,
        unknownIdentifiedStars: score.unknown,
        maxMag: result.summary && Number.isFinite(result.summary.maxMag) ?
            result.summary.maxMag : previous.maxMag,
        detectorOptions: result.summary && result.summary.detectorOptions ?
            result.summary.detectorOptions : previous.detectorOptions,
        updatedUtc: new Date().toISOString(),
    };
    fs.writeFileSync(IMG_9953_ASTERISM_HIGH_WATER_FILE, `${JSON.stringify(next, null, 2)}\n`);
}

function solveLinearSystem(a, b) {
    const n = b.length;
    const m = a.map((row, i) => row.slice().concat([b[i]]));
    for (let col = 0; col < n; col += 1) {
        let pivot = col;
        for (let row = col + 1; row < n; row += 1) {
            if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) {
                pivot = row;
            }
        }
        if (Math.abs(m[pivot][col]) < 1e-12) {
            return null;
        }
        if (pivot !== col) {
            const tmp = m[col];
            m[col] = m[pivot];
            m[pivot] = tmp;
        }
        const pivotValue = m[col][col];
        for (let j = col; j <= n; j += 1) {
            m[col][j] /= pivotValue;
        }
        for (let row = 0; row < n; row += 1) {
            if (row === col) {
                continue;
            }
            const factor = m[row][col];
            for (let j = col; j <= n; j += 1) {
                m[row][j] -= factor * m[col][j];
            }
        }
    }
    return m.map(row => row[n]);
}

function optmod2FitPenalty(optpar) {
    if (optpar.length !== 8 ||
            Math.abs(optpar[0]) < 0.05 || Math.abs(optpar[0]) > 10 ||
            Math.abs(optpar[1]) < 0.05 || Math.abs(optpar[1]) > 10 ||
            Math.abs(optpar[2]) > 90 || Math.abs(optpar[3]) > 90 ||
            Math.abs(optpar[4]) > 720 || Math.abs(optpar[5]) > 0.5 ||
            Math.abs(optpar[6]) > 0.5 || optpar[7] < 0.05 || optpar[7] > 2.5) {
        return true;
    }
    return false;
}

function lensFitResidualsOptmod2(optpar, pairs, realCase) {
    if (optmod2FitPenalty(optpar)) {
        return null;
    }
    const residuals = [];
    for (const pair of pairs) {
        const xy = AidaTools.cameraModel(
            pair.star.az,
            pair.star.ze,
            optpar,
            2,
            realCase.width,
            realCase.height,
        );
        if (!Number.isFinite(xy.x) || !Number.isFinite(xy.y)) {
            return null;
        }
        residuals.push(xy.x - pair.detection.x, xy.y - pair.detection.y);
    }
    return residuals;
}

function residualSumSquares(residuals) {
    return residuals ? residuals.reduce((acc, value) => acc + value * value, 0) : 1e12;
}

function residualRmsPx(residuals) {
    return Math.sqrt(residualSumSquares(residuals) / Math.max(1, residuals ? residuals.length / 2 : 1));
}

function fitOptmod2FromPairs(pairs, realCase, startOptpar, maxIter = 100) {
    const diffSteps = [1e-4, 1e-4, 1e-3, 1e-3, 1e-3, 1e-5, 1e-5, 1e-4];
    let x = startOptpar.slice();
    let residuals = lensFitResidualsOptmod2(x, pairs, realCase);
    let fx = residualSumSquares(residuals);
    let lambda = 1e-3;
    let accepted = 0;
    let iterations = 0;
    for (; iterations < maxIter; iterations += 1) {
        if (!residuals || !Number.isFinite(fx)) {
            break;
        }
        const jac = Array.from({length: residuals.length}, () => Array(x.length).fill(0));
        for (let col = 0; col < x.length; col += 1) {
            const xp = x.slice();
            xp[col] += diffSteps[col];
            const rp = lensFitResidualsOptmod2(xp, pairs, realCase);
            if (!rp) {
                continue;
            }
            for (let row = 0; row < residuals.length; row += 1) {
                jac[row][col] = (rp[row] - residuals[row]) / diffSteps[col];
            }
        }
        const jtj = Array.from({length: x.length}, () => Array(x.length).fill(0));
        const jtr = Array(x.length).fill(0);
        for (let row = 0; row < residuals.length; row += 1) {
            for (let i = 0; i < x.length; i += 1) {
                jtr[i] += jac[row][i] * residuals[row];
                for (let j = 0; j < x.length; j += 1) {
                    jtj[i][j] += jac[row][i] * jac[row][j];
                }
            }
        }
        let improved = false;
        for (let attempt = 0; attempt < 8; attempt += 1) {
            const a = jtj.map((row, i) => row.map((value, j) =>
                i === j ? value + lambda * Math.max(1, Math.abs(value)) : value));
            const step = solveLinearSystem(a, jtr.map(value => -value));
            if (!step) {
                lambda *= 10;
                continue;
            }
            const candidate = x.map((value, i) => value + step[i]);
            const candidateResiduals = lensFitResidualsOptmod2(candidate, pairs, realCase);
            const candidateFx = residualSumSquares(candidateResiduals);
            if (candidateResiduals && candidateFx < fx) {
                x = candidate;
                residuals = candidateResiduals;
                fx = candidateFx;
                accepted += 1;
                lambda = Math.max(lambda / 3, 1e-9);
                improved = true;
                if (Math.hypot(...step) < 1e-7) {
                    return {optpar: x, residuals, rms: residualRmsPx(residuals), iterations: iterations + 1, accepted};
                }
                break;
            }
            lambda *= 10;
        }
        if (!improved) {
            break;
        }
    }
    return {optpar: x, residuals, rms: residualRmsPx(residuals), iterations, accepted};
}

function perturbedOptmod2Start(optpar) {
    const start = optpar.slice();
    start[0] *= 1.025;
    start[1] *= 0.975;
    start[2] += 0.8;
    start[3] -= 0.6;
    start[4] += 1.2;
    start[5] += 0.004;
    start[6] -= 0.004;
    start[7] *= 1.015;
    return start;
}

function brownConradyFitPenalty(optpar) {
    if (optpar.length !== 12 ||
            Math.abs(optpar[0]) < 0.05 || Math.abs(optpar[0]) > 10 ||
            Math.abs(optpar[1]) < 0.05 || Math.abs(optpar[1]) > 10 ||
            Math.abs(optpar[2]) > 90 || Math.abs(optpar[3]) > 90 ||
            Math.abs(optpar[4]) > 720 || Math.abs(optpar[5]) > 0.5 ||
            Math.abs(optpar[6]) > 0.5 || Math.abs(optpar[7]) > 5 ||
            Math.abs(optpar[8]) > 5 || Math.abs(optpar[9]) > 5 ||
            Math.abs(optpar[10]) > 1 || Math.abs(optpar[11]) > 1) {
        return true;
    }
    return false;
}

function lensFitResidualsBrownConrady(optpar, pairs, realCase, includeRegularization = false) {
    if (brownConradyFitPenalty(optpar)) {
        return null;
    }
    const residuals = [];
    for (const pair of pairs) {
        const xy = AidaTools.cameraModel(
            pair.star.az,
            pair.star.ze,
            optpar,
            20,
            realCase.width,
            realCase.height,
        );
        if (!Number.isFinite(xy.x) || !Number.isFinite(xy.y)) {
            return null;
        }
        residuals.push(xy.x - pair.detection.x, xy.y - pair.detection.y);
    }
    if (includeRegularization) {
        residuals.push(optpar[7] * 0.4, optpar[8] * 0.8, optpar[9] * 1.6, optpar[10] * 8, optpar[11] * 8);
    }
    return residuals;
}

function fitBrownConradyFromPairs(pairs, realCase, startOptpar, maxIter = 80) {
    const diffSteps = [1e-4, 1e-4, 1e-3, 1e-3, 1e-3, 1e-5, 1e-5, 1e-5, 1e-6, 1e-6, 1e-6, 1e-6];
    let x = startOptpar.slice();
    let residuals = lensFitResidualsBrownConrady(x, pairs, realCase, true);
    let fx = residualSumSquares(residuals);
    let lambda = 1e-3;
    let accepted = 0;
    let iterations = 0;
    for (; iterations < maxIter; iterations += 1) {
        if (!residuals || !Number.isFinite(fx)) {
            break;
        }
        const jac = Array.from({length: residuals.length}, () => Array(x.length).fill(0));
        for (let col = 0; col < x.length; col += 1) {
            const xp = x.slice();
            xp[col] += diffSteps[col];
            const rp = lensFitResidualsBrownConrady(xp, pairs, realCase, true);
            if (!rp) {
                continue;
            }
            for (let row = 0; row < residuals.length; row += 1) {
                jac[row][col] = (rp[row] - residuals[row]) / diffSteps[col];
            }
        }
        const jtj = Array.from({length: x.length}, () => Array(x.length).fill(0));
        const jtr = Array(x.length).fill(0);
        for (let row = 0; row < residuals.length; row += 1) {
            for (let i = 0; i < x.length; i += 1) {
                jtr[i] += jac[row][i] * residuals[row];
                for (let j = 0; j < x.length; j += 1) {
                    jtj[i][j] += jac[row][i] * jac[row][j];
                }
            }
        }
        let improved = false;
        for (let attempt = 0; attempt < 8; attempt += 1) {
            const a = jtj.map((row, i) => row.map((value, j) =>
                i === j ? value + lambda * Math.max(1, Math.abs(value)) : value));
            const step = solveLinearSystem(a, jtr.map(value => -value));
            if (!step) {
                lambda *= 10;
                continue;
            }
            const candidate = x.map((value, i) => value + step[i]);
            const candidateResiduals = lensFitResidualsBrownConrady(candidate, pairs, realCase, true);
            const candidateFx = residualSumSquares(candidateResiduals);
            if (candidateResiduals && candidateFx < fx) {
                x = candidate;
                residuals = candidateResiduals;
                fx = candidateFx;
                accepted += 1;
                lambda = Math.max(lambda / 3, 1e-9);
                improved = true;
                break;
            }
            lambda *= 10;
        }
        if (!improved) {
            break;
        }
    }
    const rawResiduals = lensFitResidualsBrownConrady(x, pairs, realCase, false);
    return {optpar: x, residuals: rawResiduals, rms: residualRmsPx(rawResiduals), iterations, accepted};
}

function perturbedBrownConradyStart(optpar) {
    const start = optpar.slice();
    start[0] *= 1.01;
    start[1] *= 0.99;
    start[2] += 0.4;
    start[3] -= 0.3;
    start[4] += 0.5;
    start[5] += 0.001;
    start[6] -= 0.001;
    start[7] *= 1.02;
    start[8] *= 0.98;
    start[9] *= 1.01;
    start[10] += 0.0002;
    start[11] -= 0.0002;
    return start;
}

function pseudoNoise(index, salt = 0) {
    const value = Math.sin((index + 1) * 12.9898 + salt * 78.233) * 43758.5453;
    return value - Math.floor(value);
}

function syntheticDetections(projected, offset = {dx: 23.4, dy: -16.2}) {
    const detections = [];
    let detectionId = 1;
    const selected = projected.slice(0, 90);
    for (let i = 0; i < selected.length; i += 1) {
        const star = selected[i];
        if (i % 11 === 0) {
            continue;
        }
        const nx = (pseudoNoise(i, 1) - 0.5) * 0.9;
        const ny = (pseudoNoise(i, 2) - 0.5) * 0.9;
        detections.push({
            id: detectionId,
            x: star.x + offset.dx + nx,
            y: star.y + offset.dy + ny,
            score: 1e6 * Math.pow(10, -0.4 * star.mag) + 5000 / (i + 1),
            flux: 1e5 * Math.pow(10, -0.4 * star.mag),
            truthKey: star.key,
        });
        detectionId += 1;
    }
    for (let i = 0; i < 45; i += 1) {
        detections.push({
            id: detectionId,
            x: 30 + pseudoNoise(i, 5) * (WIDTH - 60),
            y: 30 + pseudoNoise(i, 6) * (HEIGHT - 60),
            score: 1200 + pseudoNoise(i, 7) * 900,
            flux: 500 + pseudoNoise(i, 8) * 500,
            truthKey: null,
        });
        detectionId += 1;
    }
    detections.sort((a, b) => b.score - a.score);
    detections.forEach((detection, index) => {
        detection.rank = index + 1;
    });
    return detections;
}

function syntheticGrayImage(width, height, background = 12) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i += 1) {
        data[4 * i] = background;
        data[4 * i + 1] = background;
        data[4 * i + 2] = background;
        data[4 * i + 3] = 255;
    }
    const addGaussian = (cx, cy, sx, sy, amplitude) => {
        const r = Math.ceil(4 * Math.max(sx, sy));
        for (let y = Math.max(0, cy - r); y <= Math.min(height - 1, cy + r); y += 1) {
            for (let x = Math.max(0, cx - r); x <= Math.min(width - 1, cx + r); x += 1) {
                const dx = (x - cx) / sx;
                const dy = (y - cy) / sy;
                const value = amplitude * Math.exp(-0.5 * (dx * dx + dy * dy));
                const k = 4 * (y * width + x);
                const gray = Math.min(255, data[k] + value);
                data[k] = gray;
                data[k + 1] = gray;
                data[k + 2] = gray;
            }
        }
    };
    return {width, height, data, addGaussian};
}

function skyPlaneYaleStars(maxMag = 4.0) {
    return AidaTools.visibleStars(YaleCatalog, DATE, LAT_DEG, LON_DEG, maxMag, 88)
        .map((star, index) => {
            const r = star.ze / (Math.PI / 2);
            return {
                ...star,
                x: r * Math.sin(star.az),
                y: -r * Math.cos(star.az),
                key: catalogKey(star),
                rank: index + 1,
            };
        })
        .sort((a, b) => a.mag - b.mag || a.key.localeCompare(b.key));
}

function affinePoint(point) {
    return {
        x: 500 * point.x - 85 * point.y + WIDTH / 2,
        y: 60 * point.x + 500 * point.y + HEIGHT / 2,
    };
}

function syntheticAsterismDetections(catalog) {
    const detections = [];
    let id = 1;
    for (let i = 0; i < Math.min(50, catalog.length); i += 1) {
        if (i % 13 === 0) {
            continue;
        }
        const star = catalog[i];
        const xy = affinePoint(star);
        if (xy.x < 40 || xy.x > WIDTH - 40 || xy.y < 40 || xy.y > HEIGHT - 40) {
            continue;
        }
        detections.push({
            id,
            x: xy.x + (pseudoNoise(i, 11) - 0.5) * 1.2,
            y: xy.y + (pseudoNoise(i, 12) - 0.5) * 1.2,
            score: 1e6 * Math.pow(10, -0.4 * star.mag) + 1000 / (i + 1),
            truthKey: star.key,
        });
        id += 1;
    }
    for (let i = 0; i < 15; i += 1) {
        detections.push({
            id,
            x: 50 + pseudoNoise(i, 13) * (WIDTH - 100),
            y: 50 + pseudoNoise(i, 14) * (HEIGHT - 100),
            score: 800 + pseudoNoise(i, 15) * 400,
            truthKey: null,
        });
        id += 1;
    }
    detections.sort((a, b) => b.score - a.score);
    detections.forEach((detection, index) => {
        detection.rank = index + 1;
    });
    return detections;
}

test("auto identifier recovers synthetic Yale-catalog stars for all lens models", () => {
    for (const optmod of MODELS) {
        for (const scenario of SCENARIOS) {
            const projected = projectedYaleStars(optmod, 6.5, scenario);
            assert.ok(
                projected.length > 80,
                `optmod ${optmod} ${scenario.name} should project enough Yale stars`,
            );
            const detections = syntheticDetections(projected);
            const result = AutoIdentifier.identifyStars(projected, detections, {
                imageWidth: WIDTH,
                imageHeight: HEIGHT,
                maxMagnitude: 6.5,
                maxDistancePx: 20,
                translationSearchRadiusPx: 80,
                minMatches: 12,
            });
            const correct = result.matches.filter(match => match.detection.truthKey === match.star.key);
            assert.ok(
                result.matches.length >= 60,
                `optmod ${optmod} ${scenario.name}: expected at least 60 matches, got ${result.matches.length}`,
            );
            assert.ok(
                correct.length / result.matches.length >= 0.95,
                `optmod ${optmod} ${scenario.name}: expected >=95% correct matches, ` +
                    `got ${correct.length}/${result.matches.length}`,
            );
            assert.ok(
                Math.abs(result.offset.dx - 23.4) < 1.0 && Math.abs(result.offset.dy + 16.2) < 1.0,
                `optmod ${optmod} ${scenario.name}: expected translation near 23.4/-16.2, ` +
                    `got ${result.offset.dx}/${result.offset.dy}`,
            );
        }
    }
});

test("auto identifier respects existing pairings and deleted detections", () => {
    const projected = projectedYaleStars(2);
    const detections = syntheticDetections(projected, {dx: 9.5, dy: 11.25});
    const existingCatalogKeys = new Set([projected[1].key, projected[2].key]);
    const deletedDetectionIds = new Set([detections[0].id]);
    const result = AutoIdentifier.identifyStars(projected, detections, {
        imageWidth: WIDTH,
        imageHeight: HEIGHT,
        maxMagnitude: 6.5,
        maxDistancePx: 20,
        translationSearchRadiusPx: 60,
        existingCatalogKeys,
        deletedDetectionIds,
    });
    assert.ok(result.matches.length > 50);
    assert.ok(result.matches.every(match => !existingCatalogKeys.has(match.star.key)));
    assert.ok(result.matches.every(match => !deletedDetectionIds.has(match.detection.id)));
});

test("auto identifier reports no matches without a rough geometric agreement", () => {
    const projected = projectedYaleStars(20).slice(0, 80);
    const detections = syntheticDetections(projected, {dx: 420, dy: -280});
    const result = AutoIdentifier.identifyStars(projected, detections, {
        imageWidth: WIDTH,
        imageHeight: HEIGHT,
        maxMagnitude: 6.5,
        maxDistancePx: 20,
        translationSearchRadiusPx: 60,
        minMatches: 12,
    });
    assert.ok(result.matches.length < 12);
    assert.match(result.status, /rough-align/);
});

test("KD-tree range queries return nearby two-dimensional points", () => {
    const tree = new AutoIdentifier.KdTree2([
        {x: 0, y: 0, payload: "origin"},
        {x: 3, y: 4, payload: "five"},
        {x: 12, y: 0, payload: "far"},
    ]);
    const hits = tree.range(0, 0, 5.1);
    assert.deepEqual(hits.map(hit => hit.payload), ["origin", "five"]);
});

test("regional detection coverage keeps bright local stars from overlapping image regions", () => {
    const detections = [];
    let id = 1;
    for (let i = 0; i < 40; i += 1) {
        detections.push({
            id: id++,
            x: 40 + (i % 5) * 14,
            y: 45 + Math.floor(i / 5) * 9,
            score: 10000 - i,
        });
    }
    for (let row = 0; row < 2; row += 1) {
        for (let col = 0; col < 3; col += 1) {
            for (let i = 0; i < 4; i += 1) {
                detections.push({
                    id: id++,
                    x: (col + 0.5) * WIDTH / 3 + (i - 1.5) * 12,
                    y: (row + 0.5) * HEIGHT / 2 + (i - 1.5) * 12,
                    score: 1000 - row * 100 - col * 10 - i,
                });
            }
        }
    }
    const normalized = AutoIdentifier.normalizeDetections(detections, {
        imageWidth: WIDTH,
        imageHeight: HEIGHT,
        maxDetections: 12,
        enableRegionalDetectionCoverage: true,
        regionalDetectionCols: 3,
        regionalDetectionRows: 2,
        regionalDetectionMinPerRegion: 4,
        regionalDetectionOverlap: 0.2,
    });
    assert.ok(normalized.length >= 24);
    for (let region = 0; region < 6; region += 1) {
        const inRegion = normalized.filter(detection =>
            Array.isArray(detection.regionIds) && detection.regionIds.includes(region));
        assert.ok(inRegion.length >= 4, `expected at least 4 detections in region ${region}`);
    }
    assert.ok(normalized.slice(0, 24).every(detection => detection.regionalRequired));
});

test("star detector ranks compact center-bright peaks above broad lumpy peaks", async () => {
    const image = syntheticGrayImage(96, 64, 12);
    image.addGaussian(28, 32, 1.15, 1.15, 140);
    image.addGaussian(68, 32, 3.1, 3.1, 190);
    const result = await StarDetector.detectBrightStars(image, {
        maxDetections: 6,
        thresholdSigma: 1.5,
        localThresholdSigma: 1.5,
        requireGlobalThreshold: false,
        maxRadiusPx: 5,
        maxElongation: 10,
        suppressionRadiusPx: 5,
    });
    const compact = result.candidates.find(candidate => Math.hypot(candidate.x - 28, candidate.y - 32) < 2);
    const broad = result.candidates.find(candidate => Math.hypot(candidate.x - 68, candidate.y - 32) < 2);
    assert.ok(compact, "expected compact synthetic star candidate");
    assert.ok(broad, "expected broad synthetic peak candidate");
    assert.ok(
        compact.score > broad.score,
        `expected compact score ${compact.score} > broad score ${broad.score}`,
    );
    assert.ok(compact.coreFluxFraction > broad.coreFluxFraction);
    assert.ok(compact.outerFluxFraction < broad.outerFluxFraction);
});

test("star detector oracle metric rewards true compact detections and penalizes false positives", async () => {
    const image = syntheticGrayImage(128, 96, 14);
    const truth = [
        {key: "a", x: 24, y: 22},
        {key: "b", x: 66, y: 28},
        {key: "c", x: 98, y: 54},
        {key: "d", x: 42, y: 76},
    ];
    for (const star of truth) {
        image.addGaussian(star.x, star.y, 1.05, 1.1, 150);
    }
    image.addGaussian(105, 18, 4.2, 1.1, 180);
    image.addGaussian(82, 78, 5.5, 5.5, 95);
    const result = await StarDetector.detectBrightStars(image, {
        maxDetections: truth.length,
        thresholdSigma: 1.4,
        localThresholdSigma: 1.4,
        requireGlobalThreshold: false,
        maxRadiusPx: 4.5,
        maxElongation: 3.5,
        suppressionRadiusPx: 6,
    });
    const metrics = detectionOracleMetrics(result.detections, truth, 3.0);
    assert.equal(metrics.correct, truth.length);
    assert.ok(metrics.falsePositive <= 1, `expected at most one false positive; ${result.status}`);
    assert.ok(metrics.precision >= 0.8, `expected high precision; ${JSON.stringify(metrics)}`);
    assert.equal(metrics.recall, 1);
});

test("star patch NN helper extracts fixed-size browser-safe features", () => {
    const width = 17;
    const height = 17;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const k = 4 * (y * width + x);
            const r2 = (x - 8) * (x - 8) + (y - 8) * (y - 8);
            const value = Math.round(20 + 180 * Math.exp(-0.5 * r2 / 2.2));
            data[k] = value;
            data[k + 1] = value;
            data[k + 2] = value;
            data[k + 3] = 255;
        }
    }
    const features = StarPatchNN.featureVector({width, height, data}, 8, 8, {
        localSnr: 12,
        globalSnr: 9,
        matchedFilterSnr: 7,
        flux: 400,
        peakContrast: 170,
        radius: 1.6,
        elongation: 1.1,
        coreFluxFraction: 0.4,
        outerFluxFraction: 0.2,
        peakDominance: 3,
        centroidOffset: 0.2,
        localCrowding: 0,
    });
    assert.equal(features.length, 93);
    assert.ok(features.every(Number.isFinite));
    const model = {
        input: features.length,
        hidden: 2,
        w1: new Array(features.length * 2).fill(0),
        b1: [0, 0],
        wClass: [0, 0],
        bClass: 0,
        wMag: [0, 0],
        bMag: 0,
    };
    const prediction = StarPatchNN.predictRaw(model, features);
    assert.equal(prediction.starProbability, 0.5);
    assert.equal(prediction.predictedMagnitude, 4);
});

test("asterism matcher identifies bright Yale stars without current lens projection", () => {
    const catalog = skyPlaneYaleStars(4.0);
    assert.ok(catalog.length > 40);
    const detections = syntheticAsterismDetections(catalog);
    const debugSnapshots = [];
    const result = AutoIdentifier.identifyStarsByAsterisms(catalog, detections, {
        imageWidth: WIDTH,
        imageHeight: HEIGHT,
        maxMagnitude: 4.0,
        maxDetections: 50,
        maxCatalogStars: 80,
        asterismMatchRadiusPx: 18,
        triangleSignatureRadius: 0.012,
        maxDetectionTriangleSidePx: WIDTH,
        minMatches: 10,
        onTriangleDebug: snapshot => debugSnapshots.push(snapshot),
    });
    const correct = result.matches.filter(match => match.detection.truthKey === match.star.key);
    assert.equal(debugSnapshots.length, 1);
    assert.ok(debugSnapshots[0].catalog.count > 0);
    assert.ok(debugSnapshots[0].image.count > 0);
    assert.equal(debugSnapshots[0].catalog.points.length, debugSnapshots[0].catalog.count);
    assert.equal(debugSnapshots[0].image.points.length, debugSnapshots[0].image.count);
    assert.ok(debugSnapshots[0].catalog.points.every(point => point.x <= point.y && point.y <= 1));
    assert.ok(debugSnapshots[0].image.points.every(point => point.x <= point.y && point.y <= 1));
    assert.ok(debugSnapshots[0].quality.occupiedOverlap > 0.6);
    assert.ok(debugSnapshots[0].quality.bhattacharyya > 0.6);
    assert.ok(result.scoredTransforms > 0);
    assert.ok(result.matches.length >= 20, `expected >=20 asterism matches, got ${result.matches.length}`);
    assert.ok(
        correct.length / result.matches.length >= 0.95,
        `expected >=95% correct asterism matches, got ${correct.length}/${result.matches.length}`,
    );
});

test("asterism matcher rejects detection triangles with too-short pixel sides", () => {
    assert.equal(AutoIdentifier.N_MIN_ANGLE_PIX, 50);
    assert.equal(AutoIdentifier.N_MIN_TRIANGLE_HGT_PIX, 20);
    assert.equal(AutoIdentifier.N_MAX_ANGLE_IMAGE_WIDTH_FRACTION, 0.25);
    const catalog = skyPlaneYaleStars(4.0);
    const detections = syntheticAsterismDetections(catalog).map(detection => ({
        ...detection,
        x: 800 + (detection.x % 16),
        y: 500 + (detection.y % 16),
    }));
    const result = AutoIdentifier.identifyStarsByAsterisms(catalog, detections, {
        imageWidth: WIDTH,
        imageHeight: HEIGHT,
        maxMagnitude: 4.0,
        maxDetections: 50,
        maxCatalogStars: 80,
        asterismMatchRadiusPx: 18,
        triangleSignatureRadius: 0.012,
        minMatches: 10,
    });
    assert.equal(result.detectionTriangleCount, 0);
    assert.equal(result.matches.length, 0);
});

test("asterism matcher rejects detection triangles with too-small pixel height", () => {
    const catalog = skyPlaneYaleStars(4.0);
    const detections = syntheticAsterismDetections(catalog).map((detection, index) => ({
        ...detection,
        x: 180 + index * 72,
        y: 500 + (index % 2) * 18,
    }));
    const result = AutoIdentifier.identifyStarsByAsterisms(catalog, detections, {
        imageWidth: WIDTH,
        imageHeight: HEIGHT,
        maxMagnitude: 4.0,
        maxDetections: 50,
        maxCatalogStars: 80,
        asterismMatchRadiusPx: 18,
        triangleSignatureRadius: 0.012,
        maxDetectionTriangleSidePx: WIDTH,
        minMatches: 10,
    });
    assert.equal(result.detectionTriangleCount, 0);
    assert.equal(result.matches.length, 0);
});

test("asterism matcher rejects detection triangles spanning more than one quarter image width", () => {
    const catalog = skyPlaneYaleStars(4.0);
    const detections = syntheticAsterismDetections(catalog).map((detection, index) => ({
        ...detection,
        x: index % 2 === 0 ? 120 + (index % 5) * 5 : WIDTH - 120 - (index % 5) * 5,
        y: 520 + (index % 7) * 4,
    }));
    const result = AutoIdentifier.identifyStarsByAsterisms(catalog, detections, {
        imageWidth: WIDTH,
        imageHeight: HEIGHT,
        maxMagnitude: 4.0,
        maxDetections: 50,
        maxCatalogStars: 80,
        asterismMatchRadiusPx: 18,
        triangleSignatureRadius: 0.012,
        minMatches: 10,
    });
    assert.equal(result.detectionTriangleCount, 0);
    assert.equal(result.matches.length, 0);
});

test("asterism matcher can lower the minimum detection triangle side for synthetic diagnostics", () => {
    const catalog = skyPlaneYaleStars(4.0);
    const detections = syntheticAsterismDetections(catalog);
    const result = AutoIdentifier.identifyStarsByAsterisms(catalog, detections, {
        imageWidth: WIDTH,
        imageHeight: HEIGHT,
        maxMagnitude: 4.0,
        maxDetections: 50,
        maxCatalogStars: 80,
        asterismMatchRadiusPx: 18,
        triangleSignatureRadius: 0.012,
        minDetectionTriangleSidePx: 1,
        maxDetectionTriangleSidePx: WIDTH,
        minMatches: 10,
    });
    assert.ok(result.detectionTriangleCount > 0);
    assert.ok(result.matches.length >= 20);
});

test("blind matcher can reject candidate triangles with inconsistent cosine ordering", () => {
    const catalog = visibleRealCaseStars(4.0).slice(0, 8).map((star, index) => ({
        ...star,
        vector: [
            Math.sin(star.ze) * Math.sin(star.az),
            Math.sin(star.ze) * Math.cos(star.az),
            Math.cos(star.ze),
        ],
        rank: index + 1,
    }));
    const detections = [
        {id: 1, vector: [0, 0, 1], rank: 1},
        {id: 2, vector: [0.10, 0, Math.sqrt(1 - 0.10 * 0.10)], rank: 2},
        {id: 3, vector: [0, 0.30, Math.sqrt(1 - 0.30 * 0.30)], rank: 3},
    ];
    const detectionTriangle = {
        points: detections,
    };
    const catalogTriangle = {
        points: [
            catalog[0],
            catalog[2],
            catalog[1],
        ],
    };
    assert.equal(
        AutoIdentifier.triangleCosinesQuasiMonotonic(detectionTriangle, detectionTriangle),
        true,
    );
    assert.equal(
        AutoIdentifier.triangleCosinesQuasiMonotonic(detectionTriangle, catalogTriangle, {
            triangleCosineOrderTolerance: 1e-9,
        }),
        false,
    );
});

test("blind asterism neighbor support accepts extendable triangle hypotheses", () => {
    const catalog = [
        {key: "c1", vector: [0, 0, 1], rank: 1, mag: 1},
        {key: "c2", vector: [0.10, 0, Math.sqrt(1 - 0.10 * 0.10)], rank: 2, mag: 2},
        {key: "c3", vector: [0, 0.12, Math.sqrt(1 - 0.12 * 0.12)], rank: 3, mag: 2},
        {key: "c4", vector: [0.08, 0.09, Math.sqrt(1 - 0.08 * 0.08 - 0.09 * 0.09)], rank: 4, mag: 3},
        {key: "c5", vector: [-0.07, 0.05, Math.sqrt(1 - 0.07 * 0.07 - 0.05 * 0.05)], rank: 5, mag: 3},
    ].map(star => ({...star, vector: star.vector.map(Number)}));
    const detections = catalog.map((star, index) => ({
        id: index + 1,
        vector: star.vector,
        x: 100 + index * 80,
        y: 200 + (index % 2) * 70,
        rank: index + 1,
    }));
    const support = AutoIdentifier.blindAsterismNeighborSupport(
        catalog,
        detections,
        [1, 0, 0, 0, 1, 0, 0, 0, 1],
        {points: detections.slice(0, 3)},
        {points: catalog.slice(0, 3)},
        {
            imageWidth: WIDTH,
            imageHeight: HEIGHT,
            minBlindAsterismSupportMatches: 2,
            minBlindAsterismSupportedVertices: 2,
            minBlindAsterismSupportTriangles: 2,
            blindAsterismSupportSignatureRadius: 0.02,
        }
    );
    assert.equal(support.accepted, true);
    assert.ok(support.extraMatches >= 2);
    assert.ok(support.supportedVertices >= 2);
    assert.ok(support.supportRecords.length > 0);
    assert.ok(support.supportRecords.some(record =>
        record.accepted &&
            Number.isFinite(record.image.x) &&
            Number.isFinite(record.image.y)));
});

fullTest("bright-star detector finds known 010095 stars with calibrated optmod 2", async () => {
    const imageData = readPngImageData(REAL_CASE_IMAGE);
    assert.equal(imageData.width, REAL_CASE.width);
    assert.equal(imageData.height, REAL_CASE.height);
    const detectionResult = await StarDetector.detectBrightStars(imageData, {
        maxDetections: 50,
        thresholdSigma: 3.5,
        localThresholdSigma: 2.5,
    });
    const projected = projectedRealCaseStars(REAL_CASE.optpar, 4.0);
    assert.ok(projected.length >= 20, `expected projected bright stars, got ${projected.length}`);
    const identification = AutoIdentifier.identifyStars(projected, detectionResult.detections, {
        imageWidth: REAL_CASE.width,
        imageHeight: REAL_CASE.height,
        maxMagnitude: 4.0,
        maxDetections: 50,
        maxCatalogStars: 80,
        maxDistancePx: 12,
        translationSearchRadiusPx: 20,
        minMatches: 6,
    });
    assert.ok(
        identification.matches.length >= 10,
        `expected at least 10 known-model matches, got ${identification.matches.length}; ${detectionResult.status}`,
    );
    assert.ok(
        identification.medianDistance < 7,
        `expected known-model median residual below 7 px, got ${identification.medianDistance}`,
    );
});

fullTest("automatic star finder detects real bright stars without catalogue matching", async () => {
    const cases = [
        {
            name: "010095",
            image: REAL_CASE_IMAGE,
            realCase: REAL_CASE,
            minTrueDetections: 18,
            maxMedianCentroidErrorPx: 8,
        },
        {
            name: "012165 high-pass",
            image: REAL_CASE_012165_IMAGE,
            realCase: REAL_CASE_012165,
            minTrueDetections: 16,
            maxMedianCentroidErrorPx: 8,
        },
        {
            name: "010880 AMS0881",
            image: REAL_CASE_010880_AMS0881_IMAGE,
            realCase: REAL_CASE_010880_AMS0881,
            minTrueDetections: 25,
            maxMedianCentroidErrorPx: 8,
        },
    ];
    for (const testCase of cases) {
        const imageData = readPngImageData(testCase.image);
        const detectionResult = await StarDetector.detectBrightStars(imageData, {maxDetections: 50});
        const knownStars = projectedRealCaseStars(testCase.realCase.optpar, 4.0, testCase.realCase);
        const matches = matchDetectionsToKnownStars(detectionResult.detections, knownStars, 18);
        const sortedErrors = matches.map(match => match.distance).sort((a, b) => a - b);
        const medianCentroidError = sortedErrors.length ?
            sortedErrors[Math.floor(sortedErrors.length / 2)] : Infinity;
        assert.ok(
            matches.length >= testCase.minTrueDetections,
            `${testCase.name}: expected at least ${testCase.minTrueDetections} raw star detections, ` +
                `got ${matches.length}; ${detectionResult.status}`,
        );
        assert.ok(
            medianCentroidError <= testCase.maxMedianCentroidErrorPx,
            `${testCase.name}: expected median detector centroid error below ` +
                `${testCase.maxMedianCentroidErrorPx} px, got ${medianCentroidError}`,
        );
    }
});

fullTest("known lens model maps Yale catalogue stars to image detections for auto-ID validation", async () => {
    const cases = [
        {
            name: "010095",
            image: REAL_CASE_IMAGE,
            realCase: REAL_CASE,
            maxMag: 4.0,
            matchRadiusPx: 18,
            detectorOptions: {maxDetections: 50},
            minTruthMatches: 18,
            minCorrect: 20,
            maxIncorrect: 1,
            maxUnknown: 0,
        },
        {
            name: "010095 03:45 deeper detector",
            image: REAL_CASE_010095_0345_IMAGE,
            realCase: REAL_CASE_010095_0345,
            maxMag: 6.0,
            matchRadiusPx: 18,
            detectorOptions: {
                maxDetections: 120,
                thresholdSigma: 3.1,
                localThresholdSigma: 3.2,
                requireGlobalThreshold: false,
                maxElongation: 3.1,
            },
            minTruthMatches: 60,
            minCorrect: 55,
            maxIncorrect: 4,
            maxUnknown: 0,
        },
        {
            name: "010760 known-good optpar",
            image: REAL_CASE_010760_IMAGE,
            realCase: REAL_CASE_010760,
            maxMag: 6.0,
            matchRadiusPx: 18,
            detectorOptions: {
                maxDetections: 120,
                thresholdSigma: 3.1,
                localThresholdSigma: 3.2,
                requireGlobalThreshold: false,
                maxElongation: 3.1,
            },
            minTruthMatches: 40,
            minCorrect: 40,
            maxIncorrect: 0,
            maxUnknown: 0,
        },
        {
            name: "012165 high-pass",
            image: REAL_CASE_012165_IMAGE,
            realCase: REAL_CASE_012165,
            maxMag: 4.0,
            matchRadiusPx: 18,
            detectorOptions: {maxDetections: 50},
            minTruthMatches: 16,
            minCorrect: 16,
            maxIncorrect: 2,
            maxUnknown: 0,
        },
        {
            name: "010880 AMS0881",
            image: REAL_CASE_010880_AMS0881_IMAGE,
            realCase: REAL_CASE_010880_AMS0881,
            maxMag: 5.0,
            matchRadiusPx: 18,
            detectorOptions: {maxDetections: 50},
            minTruthMatches: 40,
            minCorrect: 40,
            maxIncorrect: 0,
            maxUnknown: 0,
        },
        {
            name: "IMG_9371 Brown-Conrady",
            image: REAL_CASE_IMG_9371_IMAGE,
            realCase: REAL_CASE_IMG_9371,
            maxMag: 7.0,
            matchRadiusPx: 18,
            detectorOptions: {
                maxDetections: 120,
                thresholdSigma: 2,
                localThresholdSigma: 2,
                maxRadiusPx: 4,
                maxElongation: 3.5,
            },
            minTruthMatches: 14,
            minCorrect: 14,
            maxIncorrect: 0,
            maxUnknown: 0,
        },
    ];

    for (const testCase of cases) {
        const imageData = readPngImageData(testCase.image);
        const detectionResult = await StarDetector.detectBrightStars(imageData, testCase.detectorOptions);
        const knownStars = projectedRealCaseStars(
            testCase.realCase.optpar,
            testCase.maxMag,
            testCase.realCase,
        );
        const validation = knownLensValidationMap(
            detectionResult.detections,
            knownStars,
            testCase.matchRadiusPx,
        );
        assert.ok(
            validation.matches.length >= testCase.minTruthMatches,
            `${testCase.name}: expected the known lens model to map at least ` +
                `${testCase.minTruthMatches} Yale stars to image detections, got ` +
                `${validation.matches.length}; ${detectionResult.status}`,
        );

        const identification = AutoIdentifier.identifyStars(knownStars, detectionResult.detections, {
            imageWidth: testCase.realCase.width,
            imageHeight: testCase.realCase.height,
            maxMagnitude: testCase.maxMag,
            maxDetections: testCase.detectorOptions.maxDetections,
            maxCatalogStars: 200,
            maxDistancePx: testCase.matchRadiusPx,
            translationSearchRadiusPx: 25,
            minMatches: 8,
        });
        const score = scoreIdentificationAgainstKnownLens(identification.matches, validation);
        const report = `${score.correct}/${score.total} correct, ${score.incorrect} incorrect, ` +
            `${score.unknown} unknown; ${identification.status}`;
        assert.ok(
            score.correct >= testCase.minCorrect,
            `${testCase.name}: expected at least ${testCase.minCorrect} correct known-lens-validated IDs; ${report}`,
        );
        assert.ok(
            score.incorrect <= testCase.maxIncorrect,
            `${testCase.name}: expected at most ${testCase.maxIncorrect} incorrect IDs; ${report}`,
        );
        assert.ok(
            score.unknown <= testCase.maxUnknown,
            `${testCase.name}: expected at most ${testCase.maxUnknown} IDs outside the known-lens truth map; ${report}`,
        );
    }
});

fullTest("optmod 2 lens fitting works from automatically found real stars", async () => {
    const cases = [
        {
            name: "010095",
            image: REAL_CASE_IMAGE,
            realCase: REAL_CASE,
            minStablePairs: 12,
            maxStableRmsPx: 5.0,
            minStableFits: 3,
        },
        {
            name: "012165 high-pass",
            image: REAL_CASE_012165_IMAGE,
            realCase: REAL_CASE_012165,
            minStablePairs: 12,
            maxStableRmsPx: 5.0,
            minStableFits: 3,
        },
        {
            name: "010880 AMS0881",
            image: REAL_CASE_010880_AMS0881_IMAGE,
            realCase: REAL_CASE_010880_AMS0881,
            minStablePairs: 12,
            maxStableRmsPx: 5.0,
            minStableFits: 3,
        },
    ];
    const sweepCounts = [8, 10, 12, 14, 16, 18];
    for (const testCase of cases) {
        const imageData = readPngImageData(testCase.image);
        const detectionResult = await StarDetector.detectBrightStars(imageData, {maxDetections: 50});
        const knownStars = projectedRealCaseStars(testCase.realCase.optpar, 4.0, testCase.realCase);
        const autoPairs = matchDetectionsToKnownStars(detectionResult.detections, knownStars, 18)
            .sort((a, b) => a.star.mag - b.star.mag || a.distance - b.distance);
        assert.ok(
            autoPairs.length >= Math.max(...sweepCounts),
            `${testCase.name}: expected at least ${Math.max(...sweepCounts)} auto-identified stars for fit sweep, ` +
                `got ${autoPairs.length}; ${detectionResult.status}`,
        );

        const start = perturbedOptmod2Start(testCase.realCase.optpar);
        const results = [];
        for (const count of sweepCounts) {
            const pairs = autoPairs.slice(0, count);
            const fit = fitOptmod2FromPairs(pairs, testCase.realCase, start);
            results.push({count, ...fit});
        }
        const stable = results.filter(result =>
            result.count >= testCase.minStablePairs &&
            result.rms <= testCase.maxStableRmsPx &&
            result.accepted > 0);
        const report = results
            .map(result => `${result.count}:${result.rms.toFixed(2)}px/${result.accepted}step`)
            .join(", ");
        assert.ok(
            stable.length >= testCase.minStableFits,
            `${testCase.name}: expected at least ${testCase.minStableFits} stable automated-star fits ` +
                `with >=${testCase.minStablePairs} stars and RMS <= ${testCase.maxStableRmsPx}px; sweep ${report}`,
        );
        assert.ok(
            results.at(-1).rms <= testCase.maxStableRmsPx,
            `${testCase.name}: expected the largest automatic-star fit to stay stable; sweep ${report}`,
        );
    }
});

fullTest("IMG_9371 Brown-Conrady fit converges from automatic star detections", async () => {
    const imageData = readPngImageData(REAL_CASE_IMG_9371_IMAGE);
    assert.equal(imageData.width, REAL_CASE_IMG_9371.width);
    assert.equal(imageData.height, REAL_CASE_IMG_9371.height);
    const detectionResult = await StarDetector.detectBrightStars(imageData, {
        maxDetections: 120,
        thresholdSigma: 2,
        localThresholdSigma: 2,
        maxRadiusPx: 4,
        maxElongation: 3.5,
    });
    const knownStars = projectedRealCaseStars(
        REAL_CASE_IMG_9371.optpar,
        7.0,
        REAL_CASE_IMG_9371,
    );
    const autoPairs = matchDetectionsToKnownStars(detectionResult.detections, knownStars, 18)
        .sort((a, b) => a.star.mag - b.star.mag || a.distance - b.distance);
    assert.ok(
        autoPairs.length >= 14,
        `IMG_9371 Brown-Conrady: expected at least 14 automatically detected stars, ` +
            `got ${autoPairs.length}; ${detectionResult.status}`,
    );

    const sweepCounts = [8, 10, 12, 14];
    const results = [];
    for (const count of sweepCounts) {
        const fit = fitBrownConradyFromPairs(
            autoPairs.slice(0, count),
            REAL_CASE_IMG_9371,
            perturbedBrownConradyStart(REAL_CASE_IMG_9371.optpar),
        );
        results.push({count, ...fit});
    }
    const report = results
        .map(result => `${result.count}:${result.rms.toFixed(2)}px/${result.accepted}step`)
        .join(", ");
    assert.ok(
        results.every(result => result.rms <= 4.0 && result.accepted > 0),
        `IMG_9371 Brown-Conrady: expected all automatic-star fits to stay below 4 px RMS; sweep ${report}`,
    );
});

slowFullTest("IMG_9953 pre-undistorted automatic stars exercise the asterism finder", async () => {
    const result = await runImg9953UndistortedAsterismCase({writeReport: false});
    const score = result.identificationScore;
    const highWater = readImg9953AsterismHighWater();
    assert.ok(
        result.rawDetections.length >= 600,
        `IMG_9953: expected the star finder to return many candidates, got ${result.rawDetections.length}`,
    );
    assert.ok(
        result.validation.matches.length >= 140,
        `IMG_9953: expected at least 140 automatic detections to be oracle catalogue stars, ` +
            `got ${result.validation.matches.length}`,
    );
    assert.ok(
        score.correct >= highWater.correctIdentifiedStars,
        `IMG_9953: high-water regression: expected at least ` +
            `${highWater.correctIdentifiedStars} correct pre-undistorted asterism matches, ` +
            `got ${score.correct}/${score.total} correct, ${score.incorrect} incorrect; ` +
            result.identification.status,
    );
    if (score.correct > highWater.correctIdentifiedStars) {
        writeImg9953AsterismHighWater(highWater, result);
    }
});

sensitivityTest("IMG_9953 pre-undistortion sensitivity quantifies focal-scale tolerance", async () => {
    const data = await buildImg9953SensitivityData();
    assert.ok(
        data.baseline.correct >= 120,
        `IMG_9953 sensitivity: expected baseline >= 120 correct matches, got ${data.baseline.correct}`,
    );
    assert.ok(
        data.brownConradyDefault && Number.isFinite(data.brownConradyDefault.correct),
        "IMG_9953 sensitivity: expected a Brown-Conrady default optpar sensitivity case",
    );
    assert.ok(
        data.sweeps.every(sweep => sweep.points.some(point => point.kind === "default")),
        "IMG_9953 sensitivity: expected every one-parameter sweep to include the Brown-Conrady default value",
    );
    const zoom90 = data.zoomSweep.points
        .filter(point => point.correct >= data.baseline.correct * 0.9)
        .map(point => point.value);
    assert.ok(
        Math.min(...zoom90) <= 0.65 && Math.max(...zoom90) >= 1.20,
        `IMG_9953 sensitivity: expected common focal zoom to remain useful over a broad range, ` +
            `got ${Math.min(...zoom90).toFixed(2)}x..${Math.max(...zoom90).toFixed(2)}x`,
    );
});

sensitivityTest("allsky 010031 AMS0221 optmod 2 pre-undistortion sensitivity runs", async () => {
    const data = await buildAllsky010031SensitivityData();
    assert.ok(
        data.baseline.correct >= 40,
        `allsky 010031 AMS0221 sensitivity: expected baseline >= 40 correct matches, got ${data.baseline.correct}`,
    );
    assert.ok(
        data.defaultCase && Number.isFinite(data.defaultCase.correct),
        "allsky 010031 AMS0221 sensitivity: expected an optmod 2 default parameter case",
    );
    assert.ok(
        data.sweeps.every(sweep => sweep.points.some(point => point.kind === "default")),
        "allsky 010031 AMS0221 sensitivity: expected every one-parameter sweep to include the optmod 2 default value",
    );
});

fullTest("bright-star detector finds known 012165 stars with calibrated optmod 2", async () => {
    const imageData = readPngImageData(REAL_CASE_012165_IMAGE);
    assert.equal(imageData.width, REAL_CASE_012165.width);
    assert.equal(imageData.height, REAL_CASE_012165.height);
    const detectionResult = await StarDetector.detectBrightStars(imageData, {
        maxDetections: 50,
        thresholdSigma: 3.5,
        localThresholdSigma: 2.5,
    });
    const projected = projectedRealCaseStars(REAL_CASE_012165.optpar, 4.0, REAL_CASE_012165);
    assert.ok(projected.length >= 20, `expected projected bright stars, got ${projected.length}`);
    const identification = AutoIdentifier.identifyStars(projected, detectionResult.detections, {
        imageWidth: REAL_CASE_012165.width,
        imageHeight: REAL_CASE_012165.height,
        maxMagnitude: 4.0,
        maxDetections: 50,
        maxCatalogStars: 80,
        maxDistancePx: 12,
        translationSearchRadiusPx: 20,
        minMatches: 6,
    });
    assert.ok(
        identification.matches.length >= 10,
        `expected at least 10 known-model matches, got ${identification.matches.length}; ${detectionResult.status}`,
    );
    assert.ok(
        identification.medianDistance < 7,
        `expected known-model median residual below 7 px, got ${identification.medianDistance}`,
    );
});

fullTest("bright-star detector recovers saved 012165 manual pairings", async () => {
    const metadataPath = path.join(
        __dirname,
        "..",
        "test_cases",
        "2025_02_19_03_44_00_000_012165_first1s",
        "metadata.json",
    );
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    const imageData = readPngImageData(path.join(path.dirname(metadataPath), metadata.image));
    const detectionResult = await StarDetector.detectBrightStars(imageData, {
        maxDetections: 100,
        thresholdSigma: 2.2,
        localThresholdSigma: 2.2,
        requireGlobalThreshold: false,
        maxRadiusPx: 5,
        maxElongation: 4.0,
    });
    const selected = metadata.matches.map(match => ({
        x: match.image.x,
        y: match.image.y,
        name: match.catalog.name,
    }));
    const missedCandidates = selected
        .map(point => ({...point, distance: nearestDetectionDistance(point, detectionResult.candidates)}))
        .filter(point => point.distance > 2);
    const topDetections = selected
        .map(point => ({...point, distance: nearestDetectionDistance(point, detectionResult.detections)}))
        .filter(point => point.distance > 16);
    assert.deepEqual(
        missedCandidates.map(point => `${point.name}:${point.distance.toFixed(1)}px`),
        [],
        `expected detector candidates to recover all saved selected 012165 stars; ${detectionResult.status}`,
    );
    assert.ok(
        topDetections.length <= 4,
        `expected top suppressed detections to keep most saved 012165 stars; missed ` +
            `${topDetections.map(point => `${point.name}:${point.distance.toFixed(1)}px`).join(", ")}; ` +
            detectionResult.status,
    );
});

fullTest("real 010095 detections stay useful as the lens start moves away", async () => {
    const imageData = readPngImageData(REAL_CASE_IMAGE);
    const detectionResult = await StarDetector.detectBrightStars(imageData, {maxDetections: 50});
    const perturbations = [
        {label: "calibrated", dAlpha: 0, dBeta: 0, dGamma: 0, f: 1, minMatches: 10},
        {label: "mild", dAlpha: 1.5, dBeta: -1.0, dGamma: 2.0, f: 1.02, minMatches: 8},
        {label: "rough", dAlpha: 3.0, dBeta: -2.0, dGamma: 4.0, f: 1.05, minMatches: 6},
    ];
    for (const perturbation of perturbations) {
        const optpar = REAL_CASE.optpar.slice();
        optpar[0] *= perturbation.f;
        optpar[1] *= perturbation.f;
        optpar[2] += perturbation.dAlpha;
        optpar[3] += perturbation.dBeta;
        optpar[4] += perturbation.dGamma;
        const projected = projectedRealCaseStars(optpar, 4.0);
        const result = AutoIdentifier.identifyStars(projected, detectionResult.detections, {
            imageWidth: REAL_CASE.width,
            imageHeight: REAL_CASE.height,
            maxMagnitude: 4.0,
            maxDetections: 50,
            maxCatalogStars: 80,
            maxDistancePx: perturbation.label === "calibrated" ? 12 : 35,
            translationSearchRadiusPx: 160,
            minMatches: 5,
        });
        assert.ok(
            result.matches.length >= perturbation.minMatches,
            `${perturbation.label}: expected at least ${perturbation.minMatches} matches, got ${result.matches.length}`,
        );
    }
});

fullTest("blind spherical matcher identifies 010095 stars from image-load initial lens values", async () => {
    const imageData = readPngImageData(REAL_CASE_IMAGE);
    const detectionResult = await StarDetector.detectBrightStars(imageData, {maxDetections: 50});
    const knownStars = projectedRealCaseStars(REAL_CASE.optpar, 4.0);
    const knownByKey = new Map(knownStars.map(star => [star.key, star]));
    const validation = knownLensValidationMap(detectionResult.detections, knownStars, 18);
    assert.ok(
        validation.matches.length >= 18,
        `expected at least 18 real bright-star detections, got ${validation.matches.length}; ${detectionResult.status}`,
    );
    const result = AutoIdentifier.identifyStarsBlind(
        visibleRealCaseStars(4.0),
        detectionResult.detections,
        {
            imageWidth: REAL_CASE.width,
            imageHeight: REAL_CASE.height,
            maxMagnitude: 4.0,
            maxDetections: 50,
            maxCatalogStars: 80,
            minMatches: 8,
        },
    );
    const correct = result.matches.filter(match => {
        if (validation.detectionToStar.get(match.detection.id) === match.star.key) {
            return true;
        }
        const known = knownByKey.get(match.star.key);
        return known && Math.hypot(match.detection.x - known.x, match.detection.y - known.y) <= 18;
    });
    assert.ok(
        result.matches.length >= 8,
        `expected at least 8 blind matches, got ${result.matches.length}; ${result.status}`,
    );
    assert.ok(
        correct.length >= 8,
        `expected at least 8 correct blind matches, got ${correct.length}/${result.matches.length}; ${result.status}`,
    );
    assert.ok(
        result.medianDistance < 2.0,
        `expected median blind angular residual below 2 deg, got ${result.medianDistance}`,
    );
});

fullTest("blind spherical matcher bootstraps 010881 AMS0882 without known optpar seed", async () => {
    const imageData = readPngImageData(REAL_CASE_010881_AMS0882_IMAGE);
    const detectionResult = await StarDetector.detectBrightStars(imageData, {
        maxDetections: 50,
        thresholdSigma: 4.417,
        localThresholdSigma: 4.417,
        requireGlobalThreshold: true,
        maxElongation: 2.7,
    });
    const knownStars = projectedRealCaseStars(
        REAL_CASE_010881_AMS0882.optpar,
        4.0,
        REAL_CASE_010881_AMS0882,
    );
    const validation = knownLensValidationMap(detectionResult.detections, knownStars, 18);
    assert.ok(
        validation.matches.length >= 20,
        `expected at least 20 known 010881 bright-star detections, got ${validation.matches.length}`,
    );

    const result = AutoIdentifier.identifyStarsBlind(
        visibleRealCaseStars(4.0, REAL_CASE_010881_AMS0882),
        detectionResult.detections,
        {
            imageWidth: REAL_CASE_010881_AMS0882.width,
            imageHeight: REAL_CASE_010881_AMS0882.height,
            maxMagnitude: 4.0,
            maxDetections: 50,
            maxCatalogStars: 220,
            maxCatalogTriangleStars: 220,
            maxCatalogTriangles: 30000,
            maxCatalogLocalNeighbors: 20,
            maxBlindNeighborTriangles: 8,
            blindEarlyAcceptMatches: 12,
            maxBlindCandidateRotations: 12000,
            minMatches: 6,
        },
    );
    const tightMatches = result.matches.filter(match => match.distance <= 0.8);
    const score = scoreIdentificationAgainstKnownLens(tightMatches, validation);
    assert.ok(
        score.correct >= 20,
        `expected at least 20 correct blind 010881 bootstrap IDs, got ` +
            `${score.correct}/${tightMatches.length}; ${result.status}`,
    );
    assert.equal(
        score.incorrect,
        0,
        `expected no incorrect tight blind 010881 IDs; ${JSON.stringify(score.wrong)}`,
    );
    assert.ok(
        score.unknown <= 1,
        `expected at most one tight blind 010881 ID outside the known-lens map, ` +
            `got ${score.unknown}; ${result.status}`,
    );
});
