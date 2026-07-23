(function (root, factory) {
    "use strict";
    const api = factory();
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    }
    root.AidaDisplayStretch = api;
}(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    function clippedPercent(value) {
        const number = Number(value);
        return Number.isFinite(number) ? Math.max(0, Math.min(50, number)) : 5;
    }

    function intensityHistogram(floatPixels, binCount = 65536) {
        const data = floatPixels && floatPixels.data;
        const range = floatPixels && floatPixels.dataRange || {};
        let low = Number.isFinite(Number(range.low)) ? Number(range.low) : Infinity;
        let high = Number.isFinite(Number(range.high)) ? Number(range.high) : -Infinity;
        if ((!Number.isFinite(low) || !Number.isFinite(high)) && data) {
            for (let i = 0; i < data.length; i += 1) {
                const value = data[i];
                if (Number.isFinite(value)) {
                    low = Math.min(low, value);
                    high = Math.max(high, value);
                }
            }
        }
        if (!Number.isFinite(low) || !Number.isFinite(high)) {
            low = 0;
            high = 1;
        }
        const bins = Math.max(2, Math.round(Number(binCount) || 65536));
        const counts = new Uint32Array(bins);
        let count = 0;
        if (data) {
            const span = high - low;
            const scale = span > 0 ? (bins - 1) / span : 0;
            for (let i = 0; i < data.length; i += 1) {
                const value = data[i];
                if (!Number.isFinite(value)) {
                    continue;
                }
                const index = scale > 0 ?
                    Math.max(0, Math.min(bins - 1, Math.floor((value - low) * scale))) :
                    0;
                counts[index] += 1;
                count += 1;
            }
        }
        return {low, high, counts, count};
    }

    function histogramQuantile(histogram, fraction) {
        if (!histogram || histogram.count <= 0 || !histogram.counts.length) {
            return 0;
        }
        const q = Math.max(0, Math.min(1, Number(fraction) || 0));
        const target = q * (histogram.count - 1);
        let cumulative = 0;
        let index = histogram.counts.length - 1;
        for (let i = 0; i < histogram.counts.length; i += 1) {
            cumulative += histogram.counts[i];
            if (cumulative > target) {
                index = i;
                break;
            }
        }
        if (!(histogram.high > histogram.low)) {
            return histogram.low;
        }
        return histogram.low + index * (histogram.high - histogram.low) / (histogram.counts.length - 1);
    }

    function percentileBounds(histogram, percent) {
        const clip = clippedPercent(percent);
        const tailFraction = clip / 200;
        const low = clip === 0 ? histogram.low : histogramQuantile(histogram, tailFraction);
        const high = clip === 0 ? histogram.high : histogramQuantile(histogram, 1 - tailFraction);
        const minimumSpan = Math.max(1e-6, Math.abs(low) * 1e-9, Math.abs(high) * 1e-9);
        return {
            low,
            high: high > low ? high : low + minimumSpan,
            clippedPercent: clip,
            lowPercentile: 100 * tailFraction,
            highPercentile: 100 * (1 - tailFraction),
        };
    }

    return {
        clippedPercent,
        intensityHistogram,
        histogramQuantile,
        percentileBounds,
    };
}));
