(function (root, factory) {
    "use strict";

    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.AidaStarDetector = factory();
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    function median(values) {
        if (!values.length) {
            return 0;
        }
        const sorted = values.slice().sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid]);
    }

    function grayAt(data, width, x, y) {
        const k = 4 * (y * width + x);
        return 0.2126 * data[k] + 0.7152 * data[k + 1] + 0.0722 * data[k + 2];
    }

    function isStrictLocalMaximum(data, width, x, y, value) {
        let equal = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
            for (let dx = -1; dx <= 1; dx += 1) {
                if (dx === 0 && dy === 0) {
                    continue;
                }
                const neighbor = grayAt(data, width, x + dx, y + dy);
                if (neighbor > value) {
                    return false;
                }
                if (neighbor === value) {
                    equal += 1;
                    if (value < 250) {
                        continue;
                    }
                    // Saturated stars often form a small flat-topped plateau. Keep one
                    // deterministic representative from the plateau instead of rejecting
                    // the whole star as "not a strict maximum".
                    const ny = y + dy;
                    const nx = x + dx;
                    if (ny < y || ny === y && nx < x) {
                        return false;
                    }
                }
            }
        }
        return value >= 250 || equal <= 1;
    }

    function weightedCentroid(pixelData, cx, cy, radius, background, maskPredicate = null) {
        const width = pixelData.width;
        const height = pixelData.height;
        const data = pixelData.data;
        let sum = 0;
        let sx = 0;
        let sy = 0;
        const sigma2 = Math.max(1, Math.pow(radius / 1.7, 2));
        for (let dy = -radius; dy <= radius; dy += 1) {
            const y = Math.max(0, Math.min(height - 1, cy + dy));
            for (let dx = -radius; dx <= radius; dx += 1) {
                const r2 = dx * dx + dy * dy;
                if (r2 > radius * radius) {
                    continue;
                }
                const x = Math.max(0, Math.min(width - 1, cx + dx));
                if (maskPredicate && maskPredicate(x, y)) {
                    continue;
                }
                const value = grayAt(data, width, x, y);
                const weight = Math.max(0, value - background) * Math.exp(-0.5 * r2 / sigma2);
                sum += weight;
                sx += weight * x;
                sy += weight * y;
            }
        }
        return sum > 1e-9 ? {x: sx / sum, y: sy / sum} : {x: cx, y: cy};
    }

    function localAnnulusStats(pixelData, cx, cy, inner, outer, maskPredicate = null) {
        const width = pixelData.width;
        const height = pixelData.height;
        const data = pixelData.data;
        const samples = [];
        const outerCeil = Math.ceil(outer);
        for (let dy = -outerCeil; dy <= outerCeil; dy += 1) {
            const y = cy + dy;
            if (y < 0 || y >= height) {
                continue;
            }
            for (let dx = -outerCeil; dx <= outerCeil; dx += 1) {
                const x = cx + dx;
                if (x < 0 || x >= width || maskPredicate && maskPredicate(x, y)) {
                    continue;
                }
                const r = Math.hypot(dx, dy);
                if (r >= inner && r <= outer) {
                    samples.push(grayAt(data, width, x, y));
                }
            }
        }
        if (!samples.length) {
            return {background: 0, sigma: 1};
        }
        const background = median(samples);
        const sigma = Math.max(1, 1.4826 * median(samples.map(value => Math.abs(value - background))));
        return {background, sigma};
    }

    function robustStats(samples) {
        if (!samples.length) {
            return {background: 0, sigma: 1};
        }
        const background = median(samples);
        const sigma = Math.max(1, 1.4826 * median(samples.map(value => Math.abs(value - background))));
        return {background, sigma};
    }

    function buildBackgroundMap(pixelData, options = {}) {
        const width = pixelData.width;
        const height = pixelData.height;
        const data = pixelData.data;
        const maskPredicate = typeof options.maskPredicate === "function" ? options.maskPredicate : null;
        const meshSize = Number.isFinite(options.backgroundMeshSizePx) ?
            Math.max(16, Math.floor(options.backgroundMeshSizePx)) :
            Math.max(48, Math.min(128, Math.round(Math.min(width, height) / 14)));
        const sampleStep = Number.isFinite(options.backgroundSampleStepPx) ?
            Math.max(1, Math.floor(options.backgroundSampleStepPx)) : 4;
        const cols = Math.ceil(width / meshSize);
        const rows = Math.ceil(height / meshSize);
        const backgrounds = new Array(cols * rows);
        const sigmas = new Array(cols * rows);
        for (let row = 0; row < rows; row += 1) {
            const y0 = row * meshSize;
            const y1 = Math.min(height, y0 + meshSize);
            for (let col = 0; col < cols; col += 1) {
                const x0 = col * meshSize;
                const x1 = Math.min(width, x0 + meshSize);
                const samples = [];
                for (let y = y0 + Math.floor(sampleStep / 2); y < y1; y += sampleStep) {
                    for (let x = x0 + Math.floor(sampleStep / 2); x < x1; x += sampleStep) {
                        if (!maskPredicate || !maskPredicate(x, y)) {
                            samples.push(grayAt(data, width, x, y));
                        }
                    }
                }
                const stats = robustStats(samples);
                const k = row * cols + col;
                backgrounds[k] = stats.background;
                sigmas[k] = stats.sigma;
            }
        }

        const smooth = values => values.map((value, index) => {
            const row = Math.floor(index / cols);
            const col = index - row * cols;
            const local = [];
            for (let dy = -1; dy <= 1; dy += 1) {
                const yy = row + dy;
                if (yy < 0 || yy >= rows) {
                    continue;
                }
                for (let dx = -1; dx <= 1; dx += 1) {
                    const xx = col + dx;
                    if (xx >= 0 && xx < cols && Number.isFinite(values[yy * cols + xx])) {
                        local.push(values[yy * cols + xx]);
                    }
                }
            }
            return local.length ? median(local) : value;
        });
        const smoothBackgrounds = smooth(backgrounds);
        const smoothSigmas = smooth(sigmas).map(value => Math.max(1, value));
        const at = (values, x, y) => {
            const col = Math.max(0, Math.min(cols - 1, Math.floor(x / meshSize)));
            const row = Math.max(0, Math.min(rows - 1, Math.floor(y / meshSize)));
            return values[row * cols + col];
        };
        return {
            meshSize,
            cols,
            rows,
            backgrounds: smoothBackgrounds,
            sigmas: smoothSigmas,
            backgroundAt: (x, y) => at(smoothBackgrounds, x, y),
            sigmaAt: (x, y) => at(smoothSigmas, x, y),
        };
    }

    const MATCHED_KERNEL = [
        [1, 2, 3, 2, 1],
        [2, 3, 5, 3, 2],
        [3, 5, 8, 5, 3],
        [2, 3, 5, 3, 2],
        [1, 2, 3, 2, 1],
    ];
    const MATCHED_KERNEL_NORM = Math.sqrt(MATCHED_KERNEL
        .flat()
        .reduce((sum, value) => sum + value * value, 0));

    function matchedFilterSnr(pixelData, cx, cy, background, sigma, maskPredicate = null) {
        const width = pixelData.width;
        const height = pixelData.height;
        const data = pixelData.data;
        let weighted = 0;
        let weight2 = 0;
        for (let ky = 0; ky < MATCHED_KERNEL.length; ky += 1) {
            const y = cy + ky - 2;
            if (y < 0 || y >= height) {
                continue;
            }
            for (let kx = 0; kx < MATCHED_KERNEL[ky].length; kx += 1) {
                const x = cx + kx - 2;
                if (x < 0 || x >= width || maskPredicate && maskPredicate(x, y)) {
                    continue;
                }
                const kernel = MATCHED_KERNEL[ky][kx];
                weighted += kernel * (grayAt(data, width, x, y) - background);
                weight2 += kernel * kernel;
            }
        }
        const norm = Math.sqrt(Math.max(1e-9, weight2)) || MATCHED_KERNEL_NORM;
        return weighted / Math.max(1, sigma) / norm;
    }

    function apertureShape(pixelData, cx, cy, radius, background, maskPredicate = null) {
        const width = pixelData.width;
        const height = pixelData.height;
        const data = pixelData.data;
        let flux = 0;
        let coreFlux = 0;
        let outerFlux = 0;
        let shoulderFlux = 0;
        let shoulderCount = 0;
        let moment = 0;
        let mxx = 0;
        let myy = 0;
        let mxy = 0;
        let saturated = 0;
        const coreRadius2 = Math.pow(Math.max(1.1, Math.min(1.8, radius * 0.38)), 2);
        const outerRadius2 = Math.pow(Math.max(1.8, radius * 0.62), 2);
        const shoulderInner2 = Math.pow(1.4, 2);
        const shoulderOuter2 = Math.pow(Math.min(radius, 3.4), 2);
        for (let dy = -radius; dy <= radius; dy += 1) {
            const y = Math.max(0, Math.min(height - 1, cy + dy));
            for (let dx = -radius; dx <= radius; dx += 1) {
                const r2 = dx * dx + dy * dy;
                if (r2 > radius * radius) {
                    continue;
                }
                const x = Math.max(0, Math.min(width - 1, cx + dx));
                if (maskPredicate && maskPredicate(x, y)) {
                    continue;
                }
                const sample = grayAt(data, width, x, y);
                const w = Math.max(0, sample - background);
                flux += w;
                if (r2 <= coreRadius2) {
                    coreFlux += w;
                }
                if (r2 >= outerRadius2) {
                    outerFlux += w;
                }
                if (r2 >= shoulderInner2 && r2 <= shoulderOuter2) {
                    shoulderFlux += w;
                    shoulderCount += 1;
                }
                moment += w * r2;
                mxx += w * dx * dx;
                myy += w * dy * dy;
                mxy += w * dx * dy;
                if (sample >= 252) {
                    saturated += 1;
                }
            }
        }
        if (flux <= 1e-9) {
            return null;
        }
        const radius2 = moment / flux;
        const trace = (mxx + myy) / flux;
        const delta = Math.hypot((mxx - myy) / flux, 2 * mxy / flux);
        const minor = Math.max(1e-6, 0.5 * (trace - delta));
        const major = Math.max(minor, 0.5 * (trace + delta));
        const centerExcess = Math.max(0, grayAt(data, width, cx, cy) - background);
        const shoulderMean = shoulderCount > 0 ? shoulderFlux / shoulderCount : 0;
        return {
            flux,
            radius: Math.sqrt(Math.max(0, radius2)),
            elongation: Math.sqrt(major / minor),
            coreFluxFraction: coreFlux / flux,
            outerFluxFraction: outerFlux / flux,
            peakDominance: centerExcess / Math.max(1, shoulderMean),
            saturated,
        };
    }

    function selectSuppressedCandidates(candidates, maxDetections, suppressionRadius) {
        const selected = [];
        const suppression2 = suppressionRadius * suppressionRadius;
        for (const candidate of candidates) {
            let tooClose = false;
            for (const existing of selected) {
                const dx = existing.x - candidate.x;
                const dy = existing.y - candidate.y;
                if (dx * dx + dy * dy < suppression2) {
                    tooClose = true;
                    break;
                }
            }
            if (!tooClose) {
                selected.push({...candidate, id: selected.length + 1});
            }
            if (selected.length >= maxDetections) {
                break;
            }
        }
        return selected.map((detection, index) => ({...detection, rank: index + 1}));
    }

    async function maybeYield(options, percent, text, force = false) {
        if (typeof options.onProgress === "function") {
            options.onProgress(percent, text);
        }
        if (typeof options.yieldFn === "function" && force) {
            await options.yieldFn();
        }
    }

    async function detectBrightStars(pixelData, options = {}) {
        const width = pixelData.width;
        const height = pixelData.height;
        const data = pixelData.data;
        const maxDetections = Number.isFinite(options.maxDetections) ? options.maxDetections : 50;
        const maskPredicate = typeof options.maskPredicate === "function" ? options.maskPredicate : null;
        const scanStep = Number.isFinite(options.scanStep) ? options.scanStep :
            width * height >= 8000000 ? 2 : 1;
        const cellSize = Number.isFinite(options.cellSize) ? options.cellSize :
            width * height >= 8000000 ? 16 : 12;
        const cellsX = Math.ceil(width / cellSize);
        const cellsY = Math.ceil(height / cellSize);
        const cellPeaks = Array.from({length: cellsX * cellsY}, () => ({value: -Infinity, x: 0, y: 0}));
        const useSpatialBackground = options.useSpatialBackground === true;
        await maybeYield(
            options,
            8,
            useSpatialBackground ? "Estimating spatial background and noise..." : "Estimating image background and noise...",
            true
        );
        const backgroundMap = useSpatialBackground ? buildBackgroundMap(pixelData, {
            ...options,
            maskPredicate,
        }) : null;
        const samples = [];
        for (let y = 4; y < height; y += 8) {
            for (let x = 4; x < width; x += 8) {
                if (!maskPredicate || !maskPredicate(x, y)) {
                    samples.push(grayAt(data, width, x, y));
                }
            }
        }
        const bg = median(samples);
        const sigma = Math.max(1, 1.4826 * median(samples.map(value => Math.abs(value - bg))));
        const globalThreshold = bg + Math.max(
            Number.isFinite(options.minPeakAboveBg) ? options.minPeakAboveBg : 4,
            (Number.isFinite(options.thresholdSigma) ? options.thresholdSigma : 2.5) * sigma
        );
        const scanThreshold = bg + Math.max(
            Number.isFinite(options.minPeakAboveBg) ? options.minPeakAboveBg : 4,
            (Number.isFinite(options.scanThresholdSigma) ? options.scanThresholdSigma : 0.5) * sigma
        );

        await maybeYield(options, 25, "Scanning image for local star peaks...", true);
        let lastYield = typeof performance === "object" && performance.now ? performance.now() : Date.now();
        let scannedLocalPeaks = 0;
        for (let y = 2; y < height - 2; y += scanStep) {
            for (let x = 2; x < width - 2; x += scanStep) {
                if (maskPredicate && maskPredicate(x, y)) {
                    continue;
                }
                const value = grayAt(data, width, x, y);
                const localBgForScan = backgroundMap ? backgroundMap.backgroundAt(x, y) : bg;
                const localSigmaForScan = backgroundMap ? backgroundMap.sigmaAt(x, y) : sigma;
                const localScanThreshold = localBgForScan + Math.max(
                    Number.isFinite(options.minPeakAboveBg) ? options.minPeakAboveBg : 4,
                    (Number.isFinite(options.scanThresholdSigma) ? options.scanThresholdSigma : 0.5) * localSigmaForScan
                );
                if (value < Math.max(scanThreshold, localScanThreshold) ||
                        !isStrictLocalMaximum(data, width, x, y, value)) {
                    continue;
                }
                const scanMatchedSnr = matchedFilterSnr(
                    pixelData,
                    x,
                    y,
                    localBgForScan,
                    localSigmaForScan,
                    maskPredicate
                );
                scannedLocalPeaks += 1;
                const cellIndex = Math.floor(y / cellSize) * cellsX + Math.floor(x / cellSize);
                const localPeakScore = scanMatchedSnr * Math.max(0, (value - localBgForScan) / Math.max(1, localSigmaForScan));
                if (localPeakScore > cellPeaks[cellIndex].score || !Number.isFinite(cellPeaks[cellIndex].score)) {
                    cellPeaks[cellIndex] = {
                        value,
                        score: localPeakScore,
                        scanMatchedSnr,
                        x,
                        y,
                    };
                }
            }
            const now = typeof performance === "object" && performance.now ? performance.now() : Date.now();
            if (now - lastYield > 35) {
                await maybeYield(options, 25 + 40 * y / height, `Scanning bright peaks: ${Math.round(100 * y / height)}%`, true);
                lastYield = now;
            }
        }

        await maybeYield(options, 70, "Measuring star-like peak shape...", true);
        const candidates = [];
        const annulusInner = Number.isFinite(options.annulusInnerPx) ? options.annulusInnerPx : 6;
        const annulusOuter = Number.isFinite(options.annulusOuterPx) ? options.annulusOuterPx : 12;
        const centroidRadius = Number.isFinite(options.centroidRadiusPx) ? options.centroidRadiusPx : 5;
        const apertureRadius = Number.isFinite(options.apertureRadiusPx) ? options.apertureRadiusPx : 5;
        const minLocalSigma = Number.isFinite(options.localThresholdSigma) ? options.localThresholdSigma : 2.5;
        const maxRadius = Number.isFinite(options.maxRadiusPx) ? options.maxRadiusPx : 3.0;
        const maxElongation = Number.isFinite(options.maxElongation) ? options.maxElongation : 2.7;
        const maxSaturated = Number.isFinite(options.maxSaturatedPixels) ? options.maxSaturatedPixels : 12;
        const requireGlobalThreshold = options.requireGlobalThreshold === true;
        const rejectCounts = {
            belowScanThreshold: 0,
            belowGlobalThreshold: 0,
            belowLocalContrast: 0,
            invalidCentroid: 0,
            nonStarShape: 0,
            crowdedRegion: 0,
        };

        lastYield = typeof performance === "object" && performance.now ? performance.now() : Date.now();
        for (let peakIndex = 0; peakIndex < cellPeaks.length; peakIndex += 1) {
            const peak = cellPeaks[peakIndex];
            const now = typeof performance === "object" && performance.now ? performance.now() : Date.now();
            if (now - lastYield > 35) {
                await maybeYield(
                    options,
                    70 + 18 * peakIndex / Math.max(1, cellPeaks.length),
                    `Measuring star-like peak shape: ${Math.round(100 * peakIndex / Math.max(1, cellPeaks.length))}%`,
                    true
                );
                lastYield = now;
            }
            if (!Number.isFinite(peak.value) || peak.value < scanThreshold) {
                rejectCounts.belowScanThreshold += 1;
                continue;
            }
            if (requireGlobalThreshold && peak.value < globalThreshold) {
                rejectCounts.belowGlobalThreshold += 1;
                continue;
            }
            const annulus = localAnnulusStats(pixelData, peak.x, peak.y, annulusInner, annulusOuter, maskPredicate);
            const meshBackground = backgroundMap ? backgroundMap.backgroundAt(peak.x, peak.y) : annulus.background;
            const meshSigma = backgroundMap ? backgroundMap.sigmaAt(peak.x, peak.y) : annulus.sigma;
            const localBackground = Math.min(annulus.background, meshBackground);
            const localSigmaEstimate = Math.max(1, Math.min(annulus.sigma, meshSigma));
            const contrast = peak.value - localBackground;
            const localSnr = contrast / Math.max(1e-9, localSigmaEstimate);
            const globalSnr = (peak.value - bg) / Math.max(1e-9, sigma);
            const matchedSnr = matchedFilterSnr(
                pixelData,
                peak.x,
                peak.y,
                localBackground,
                localSigmaEstimate,
                maskPredicate
            );
            const minMatchedSnr = Number.isFinite(options.minMatchedFilterSnr) ?
                options.minMatchedFilterSnr : 1.2;
            if (contrast < Math.max(5, minLocalSigma * localSigmaEstimate) ||
                    matchedSnr < minMatchedSnr) {
                rejectCounts.belowLocalContrast += 1;
                continue;
            }
            const centroid = weightedCentroid(pixelData, peak.x, peak.y, centroidRadius, localBackground, maskPredicate);
            if (!Number.isFinite(centroid.x) || !Number.isFinite(centroid.y)) {
                rejectCounts.invalidCentroid += 1;
                continue;
            }
            const cx = Math.round(centroid.x);
            const cy = Math.round(centroid.y);
            const shape = apertureShape(pixelData, cx, cy, apertureRadius, localBackground, maskPredicate);
            if (!shape || shape.radius < 0.25 || shape.radius > maxRadius ||
                    shape.elongation > maxElongation || shape.saturated > maxSaturated) {
                rejectCounts.nonStarShape += 1;
                continue;
            }
            const minCoreFluxFraction = Number.isFinite(options.minCoreFluxFraction) ?
                options.minCoreFluxFraction : 0.14;
            const maxOuterFluxFraction = Number.isFinite(options.maxOuterFluxFraction) ?
                options.maxOuterFluxFraction : 0.58;
            if (shape.coreFluxFraction < minCoreFluxFraction && shape.outerFluxFraction > maxOuterFluxFraction) {
                rejectCounts.nonStarShape += 1;
                continue;
            }
            const minPeakDominance = Number.isFinite(options.minPeakDominance) ?
                options.minPeakDominance : 1.08;
            const corePower = Number.isFinite(options.coreFluxPenaltyPower) ?
                options.coreFluxPenaltyPower : 1.5;
            const peakPower = Number.isFinite(options.peakDominancePenaltyPower) ?
                options.peakDominancePenaltyPower : 1.4;
            const outerPower = Number.isFinite(options.outerFluxPenaltyPower) ?
                options.outerFluxPenaltyPower : 1.35;
            const elongationPower = Number.isFinite(options.elongationPenaltyPower) ?
                options.elongationPenaltyPower : 1.7;
            const centroidOffsetPower = Number.isFinite(options.centroidOffsetPenaltyPower) ?
                options.centroidOffsetPenaltyPower : 1.15;
            const centroidOffset = Math.hypot(centroid.x - peak.x, centroid.y - peak.y);
            const coreShapeFactor = Math.pow(
                Math.max(0.12, Math.min(1, shape.coreFluxFraction / minCoreFluxFraction)),
                corePower
            );
            const peakShapeFactor = Math.pow(
                Math.max(0.12, Math.min(1, shape.peakDominance / minPeakDominance)),
                peakPower
            );
            const outerShapePenalty = Math.pow(
                1 + Math.max(0, shape.outerFluxFraction - maxOuterFluxFraction) * 6.0,
                outerPower
            );
            const elongationPenalty = Math.pow(Math.max(1, shape.elongation), elongationPower);
            const centroidOffsetPenalty = Math.pow(1 + Math.max(0, centroidOffset - 0.8), centroidOffsetPower);
            const compactness = contrast / Math.pow(Math.max(1, shape.radius), 2.8);
            const saturationPenalty = 1 + 0.18 * shape.saturated;
            const roundnessFactor = coreShapeFactor * peakShapeFactor;
            const matchedFactor = Math.pow(Math.max(0.2, matchedSnr), 0.25);
            const score = compactness * Math.pow(Math.max(1, shape.flux), 0.25) * roundnessFactor * matchedFactor /
                (elongationPenalty * outerShapePenalty * centroidOffsetPenalty * saturationPenalty);
            candidates.push({
                x: centroid.x,
                y: centroid.y,
                peakValue: peak.value,
                peakContrast: contrast,
                localSigma: annulus.sigma,
                localSnr,
                globalSnr,
                peak: peak.value,
                flux: shape.flux,
                background: localBackground,
                meshBackground,
                meshSigma,
                radius: shape.radius,
                elongation: shape.elongation,
                coreFluxFraction: shape.coreFluxFraction,
                outerFluxFraction: shape.outerFluxFraction,
                peakDominance: shape.peakDominance,
                centroidOffset,
                roundnessFactor,
                matchedFilterSnr: matchedSnr,
                saturated: shape.saturated,
                score,
            });
        }
        const crowdingRadius = Number.isFinite(options.crowdingRadiusPx) ? options.crowdingRadiusPx : 0;
        const maxCrowding = Number.isFinite(options.maxCrowding) ? options.maxCrowding : Infinity;
        const crowdingPower = Number.isFinite(options.crowdingScorePower) ? options.crowdingScorePower : 1.15;
        let filteredCandidates = candidates;
        if (crowdingRadius > 0 && candidates.length > 0) {
            const r2 = crowdingRadius * crowdingRadius;
            filteredCandidates = [];
            lastYield = typeof performance === "object" && performance.now ? performance.now() : Date.now();
            for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
                const candidate = candidates[candidateIndex];
                const now = typeof performance === "object" && performance.now ? performance.now() : Date.now();
                if (now - lastYield > 35) {
                    await maybeYield(
                        options,
                        88 + 8 * candidateIndex / Math.max(1, candidates.length),
                        `Rejecting cluttered peaks: ${Math.round(100 * candidateIndex / Math.max(1, candidates.length))}%`,
                        true
                    );
                    lastYield = now;
                }
                let neighbors = 0;
                for (const other of candidates) {
                    const dx = candidate.x - other.x;
                    const dy = candidate.y - other.y;
                    if (dx * dx + dy * dy <= r2) {
                        neighbors += 1;
                    }
                }
                const localCrowding = Math.max(0, neighbors - 1);
                if (localCrowding > maxCrowding) {
                    rejectCounts.crowdedRegion += 1;
                    continue;
                }
                const crowdingPenalty = Math.pow(1 + localCrowding, crowdingPower);
                filteredCandidates.push({
                    ...candidate,
                    localCrowding,
                    score: candidate.score / crowdingPenalty,
                });
            }
        }
        filteredCandidates.sort((a, b) => b.score - a.score);
        const suppressionRadius = Number.isFinite(options.suppressionRadiusPx) ?
            options.suppressionRadiusPx :
            Math.max(18, Math.min(60, 0.010 * Math.hypot(width, height)));
        const detections = selectSuppressedCandidates(filteredCandidates, maxDetections, suppressionRadius);
        return {
            detections,
            candidates: filteredCandidates,
            bg,
            sigma,
            globalThreshold,
            scanThreshold,
            backgroundMeshSize: backgroundMap ? backgroundMap.meshSize : null,
            scannedLocalPeaks,
            rejectCounts,
            status: `bright-star detector: bg ${bg.toFixed(1)}, sigma ${sigma.toFixed(1)}, ` +
                `thresholds scan/global ${scanThreshold.toFixed(1)}/${globalThreshold.toFixed(1)}, ` +
                `${backgroundMap ? `mesh ${backgroundMap.meshSize} px, ` : ""}` +
                `${scannedLocalPeaks} local peaks, ${filteredCandidates.length}/${candidates.length} star-like candidates after clutter, ` +
                `selected top ${detections.length}/${maxDetections}, suppression radius ${suppressionRadius.toFixed(0)} px`,
        };
    }

    return {
        detectBrightStars,
        grayAt,
        median,
    };
});
