(function (root, factory) {
    "use strict";

    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.AidaStarPatchNN = factory();
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const PATCH_RADIUS = 4;
    const PATCH_SIZE = 2 * PATCH_RADIUS + 1;
    const NO_STAR_MAG = 99;
    const MAG_SCALE = 8;

    function median(values) {
        if (!values.length) {
            return 0;
        }
        const sorted = values.slice().sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid]);
    }

    function grayAt(pixelData, x, y) {
        const width = pixelData.width;
        const height = pixelData.height;
        const xx = Math.max(0, Math.min(width - 1, Math.round(x)));
        const yy = Math.max(0, Math.min(height - 1, Math.round(y)));
        const k = 4 * (yy * width + xx);
        const data = pixelData.data;
        return 0.2126 * data[k] + 0.7152 * data[k + 1] + 0.0722 * data[k + 2];
    }

    function localStats(pixelData, cx, cy, radius = 9) {
        const samples = [];
        for (let dy = -radius; dy <= radius; dy += 1) {
            for (let dx = -radius; dx <= radius; dx += 1) {
                const r = Math.hypot(dx, dy);
                if (r >= PATCH_RADIUS + 1 && r <= radius) {
                    samples.push(grayAt(pixelData, cx + dx, cy + dy));
                }
            }
        }
        const background = median(samples);
        const sigma = Math.max(1, 1.4826 * median(samples.map(value => Math.abs(value - background))));
        return {background, sigma};
    }

    function clamp(value, lo, hi) {
        return Math.max(lo, Math.min(hi, value));
    }

    function normalizedPatchFeatures(pixelData, x, y) {
        const stats = localStats(pixelData, x, y);
        const values = [];
        for (let dy = -PATCH_RADIUS; dy <= PATCH_RADIUS; dy += 1) {
            for (let dx = -PATCH_RADIUS; dx <= PATCH_RADIUS; dx += 1) {
                const value = (grayAt(pixelData, x + dx, y + dy) - stats.background) / stats.sigma;
                values.push(clamp(value / 10, -1, 1));
            }
        }
        return {values, background: stats.background, sigma: stats.sigma};
    }

    function detectionFeatureVector(detection = {}) {
        const log1p = value => Math.log1p(Math.max(0, Number(value) || 0));
        return [
            clamp((Number(detection.localSnr) || 0) / 50, -1, 1),
            clamp((Number(detection.globalSnr) || 0) / 50, -1, 1),
            clamp((Number(detection.matchedFilterSnr) || 0) / 30, -1, 1),
            clamp(log1p(detection.flux) / 12, 0, 1),
            clamp(log1p(detection.peakContrast) / 8, 0, 1),
            clamp((Number(detection.radius) || 0) / 6, 0, 1),
            clamp((Number(detection.elongation) || 1) / 6, 0, 1),
            clamp(Number(detection.coreFluxFraction) || 0, 0, 1),
            clamp(Number(detection.outerFluxFraction) || 0, 0, 1),
            clamp((Number(detection.peakDominance) || 0) / 8, 0, 1),
            clamp((Number(detection.centroidOffset) || 0) / 5, 0, 1),
            clamp((Number(detection.localCrowding) || 0) / 12, 0, 1),
        ];
    }

    function featureVector(pixelData, x, y, detection = {}) {
        const patch = normalizedPatchFeatures(pixelData, x, y);
        return patch.values.concat(detectionFeatureVector(detection));
    }

    function sigmoid(x) {
        if (x < -40) {
            return 0;
        }
        if (x > 40) {
            return 1;
        }
        return 1 / (1 + Math.exp(-x));
    }

    function hiddenActivations(model, features) {
        const hidden = new Array(model.hidden);
        for (let h = 0; h < model.hidden; h += 1) {
            let sum = model.b1[h];
            const row = h * model.input;
            for (let i = 0; i < model.input; i += 1) {
                sum += model.w1[row + i] * features[i];
            }
            hidden[h] = Math.tanh(sum);
        }
        return hidden;
    }

    function legacyPredictRaw(model, hidden) {
        let out = model.b2 && model.b2.length ? model.b2[0] : 0;
        for (let h = 0; h < model.hidden; h += 1) {
            out += (model.w2 && model.w2[h] || 0) * hidden[h];
        }
        return sigmoid(out);
    }

    function predictRaw(model, features) {
        const hidden = hiddenActivations(model, features);
        if (!model.wClass || !model.wMag) {
            const noStarProbability = legacyPredictRaw(model, hidden);
            return {
                starProbability: 1 - noStarProbability,
                noStarProbability,
                predictedMagnitude: NO_STAR_MAG * noStarProbability,
            };
        }
        let classLogit = model.bClass || 0;
        let magLogit = model.bMag || 0;
        for (let h = 0; h < model.hidden; h += 1) {
            classLogit += model.wClass[h] * hidden[h];
            magLogit += model.wMag[h] * hidden[h];
        }
        const starProbability = sigmoid(classLogit);
        const predictedMagnitude = MAG_SCALE * sigmoid(magLogit);
        return {
            starProbability,
            noStarProbability: 1 - starProbability,
            predictedMagnitude,
        };
    }

    function predictMagnitude(model, features) {
        return predictRaw(model, features).predictedMagnitude;
    }

    function scoreCandidate(model, pixelData, detection) {
        if (!model || !pixelData || !detection) {
            return null;
        }
        const features = featureVector(pixelData, detection.x, detection.y, detection);
        const prediction = predictRaw(model, features);
        return {
            predictedMagnitude: prediction.predictedMagnitude,
            starProbability: clamp(prediction.starProbability, 0, 1),
            noStarProbability: clamp(prediction.noStarProbability, 0, 1),
            features,
        };
    }

    function defaultModel(rootObject = typeof globalThis !== "undefined" ? globalThis : null) {
        return rootObject && rootObject.AIDA_STAR_PATCH_NN_MODEL || null;
    }

    return {
        PATCH_RADIUS,
        PATCH_SIZE,
        NO_STAR_MAG,
        MAG_SCALE,
        detectionFeatureVector,
        featureVector,
        hiddenActivations,
        localStats,
        normalizedPatchFeatures,
        predictMagnitude,
        predictRaw,
        scoreCandidate,
        defaultModel,
    };
});
