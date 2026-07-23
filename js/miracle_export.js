(function (root, factory) {
    "use strict";
    const api = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.AidaMiracleExport = api;
    }
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const RAD = 180 / Math.PI;

    function wrapRadians(angle) {
        return ((angle + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    }

    function wrapDegrees(angle) {
        return wrapRadians(angle / RAD) * RAD;
    }

    function imagePrefix(filename, fallback = "wisc") {
        const safe = String(filename || fallback)
            .replace(/[\\/]+/g, "_")
            .replace(/[\x00-\x1f\x7f]+/g, "")
            .trim()
            .replace(/\.[^.]*$/, "");
        return safe || fallback;
    }

    function fitCalibration(samples, options) {
        const rows = (samples || []).filter(sample =>
            Number.isFinite(sample.rawX) &&
            Number.isFinite(sample.rawY) &&
            Number.isFinite(sample.azRad) &&
            Number.isFinite(sample.zenithRad) &&
            sample.zenithRad > 1e-9
        );
        if (!rows.length) {
            throw new Error("cannot fit MIRACLE calibration without valid sky samples");
        }
        const zenithRawX = Number(options && options.zenithRawX);
        const zenithRawY = Number(options && options.zenithRawY);
        if (!Number.isFinite(zenithRawX) || !Number.isFinite(zenithRawY)) {
            throw new Error("MIRACLE calibration needs a finite zenith image position");
        }

        let sumZd = 0;
        let sumZ2 = 0;
        let rotationSin = 0;
        let rotationCos = 0;
        for (const row of rows) {
            const vertical = row.rawY - zenithRawY;
            const horizontal = row.rawX - zenithRawX;
            const distancePx = Math.hypot(vertical, horizontal);
            sumZd += row.zenithRad * distancePx;
            sumZ2 += row.zenithRad * row.zenithRad;

            // With rotation=0, north points toward decreasing vertical X.
            // Rotating the image counter-clockwise makes this angle positive.
            const imageAzRad = Math.atan2(horizontal, -vertical);
            const rotation = wrapRadians(row.azRad - imageAzRad);
            rotationSin += Math.sin(rotation);
            rotationCos += Math.cos(rotation);
        }
        const kPxPerRad = sumZd / sumZ2;
        if (!Number.isFinite(kPxPerRad) || kPxPerRad <= 0) {
            throw new Error("MIRACLE scale fit did not produce a positive k");
        }
        const rotationRad = Math.atan2(rotationSin, rotationCos);
        return {
            glatDeg: Number(options && options.glatDeg) || 0,
            glonDeg: Number(options && options.glonDeg) || 0,
            // MIRACLE's historical axes are intentionally twisted:
            // X is vertical/image row and Y is horizontal/image column.
            xcPx: zenithRawY,
            ycPx: zenithRawX,
            kPxPerRad,
            rotationDeg: wrapDegrees(rotationRad * RAD),
            rotationRad,
            sampleCount: rows.length,
        };
    }

    function approximateSkyAtPixel(rawX, rawY, calibration) {
        const vertical = rawY - calibration.xcPx;
        const horizontal = rawX - calibration.ycPx;
        const distancePx = Math.hypot(vertical, horizontal);
        const imageAzRad = Math.atan2(horizontal, -vertical);
        return {
            azRad: wrapRadians(imageAzRad + calibration.rotationRad),
            zenithRad: distancePx / calibration.kPxPerRad,
            distancePx,
        };
    }

    function angularSeparationDeg(aAzRad, aZenithRad, bAzRad, bZenithRad) {
        const cosSeparation =
            Math.cos(aZenithRad) * Math.cos(bZenithRad) +
            Math.sin(aZenithRad) * Math.sin(bZenithRad) *
                Math.cos(aAzRad - bAzRad);
        return Math.acos(Math.max(-1, Math.min(1, cosSeparation))) * RAD;
    }

    function approximationErrors(samples, calibration) {
        return (samples || []).map(sample => {
            const approximate = approximateSkyAtPixel(sample.rawX, sample.rawY, calibration);
            return {
                ...sample,
                distancePx: approximate.distancePx,
                approximateAzDeg: ((approximate.azRad * RAD) % 360 + 360) % 360,
                approximateZenithDeg: approximate.zenithRad * RAD,
                zenithErrorDeg: (approximate.zenithRad - sample.zenithRad) * RAD,
                angularErrorDeg: angularSeparationDeg(
                    sample.azRad,
                    sample.zenithRad,
                    approximate.azRad,
                    approximate.zenithRad,
                ),
            };
        }).filter(row =>
            Number.isFinite(row.angularErrorDeg) &&
            Number.isFinite(row.zenithErrorDeg)
        );
    }

    function errorSummary(errors) {
        if (!errors.length) {
            return {
                count: 0,
                rmsAngularDeg: null,
                maxAngularDeg: null,
                rmsZenithDeg: null,
                maxAbsZenithDeg: null,
            };
        }
        return {
            count: errors.length,
            rmsAngularDeg: Math.sqrt(
                errors.reduce((sum, row) => sum + row.angularErrorDeg ** 2, 0) / errors.length
            ),
            maxAngularDeg: Math.max(...errors.map(row => row.angularErrorDeg)),
            rmsZenithDeg: Math.sqrt(
                errors.reduce((sum, row) => sum + row.zenithErrorDeg ** 2, 0) / errors.length
            ),
            maxAbsZenithDeg: Math.max(...errors.map(row => Math.abs(row.zenithErrorDeg))),
        };
    }

    function asciiNumber(value) {
        if (!Number.isFinite(Number(value))) {
            throw new Error("MIRACLE output contains a non-finite value");
        }
        return Number(value).toPrecision(15);
    }

    function formatMiracleAscii(calibration) {
        // Keep this file deliberately minimal for legacy readers: one ASCII
        // row in the documented order, with no JSON, labels, or punctuation.
        return [
            calibration.glatDeg,
            calibration.glonDeg,
            calibration.xcPx,
            calibration.ycPx,
            calibration.kPxPerRad,
            calibration.rotationDeg,
        ].map(asciiNumber).join(" ") + "\n";
    }

    return {
        angularSeparationDeg,
        approximationErrors,
        approximateSkyAtPixel,
        errorSummary,
        fitCalibration,
        formatMiracleAscii,
        imagePrefix,
        wrapDegrees,
        wrapRadians,
    };
});
