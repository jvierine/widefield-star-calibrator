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

    function solveLinearSystem(matrix, values) {
        const n = values.length;
        const augmented = matrix.map((row, index) => row.slice().concat(values[index]));
        for (let column = 0; column < n; column += 1) {
            let pivot = column;
            for (let row = column + 1; row < n; row += 1) {
                if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) {
                    pivot = row;
                }
            }
            if (Math.abs(augmented[pivot][column]) < 1e-10) {
                throw new Error("selected stars do not constrain a MIRACLE calibration");
            }
            [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
            const divisor = augmented[column][column];
            for (let j = column; j <= n; j += 1) {
                augmented[column][j] /= divisor;
            }
            for (let row = 0; row < n; row += 1) {
                if (row === column) {
                    continue;
                }
                const factor = augmented[row][column];
                for (let j = column; j <= n; j += 1) {
                    augmented[row][j] -= factor * augmented[column][j];
                }
            }
        }
        return augmented.map(row => row[n]);
    }

    function leastSquares(designRows, observed) {
        const columns = designRows[0].length;
        const normal = Array.from({length: columns}, () => new Array(columns).fill(0));
        const rhs = new Array(columns).fill(0);
        for (let row = 0; row < designRows.length; row += 1) {
            for (let i = 0; i < columns; i += 1) {
                rhs[i] += designRows[row][i] * observed[row];
                for (let j = 0; j < columns; j += 1) {
                    normal[i][j] += designRows[row][i] * designRows[row][j];
                }
            }
        }
        return solveLinearSystem(normal, rhs);
    }

    function projectionCoordinate(zenithDeg, projection) {
        const zenithRad = zenithDeg / RAD;
        return projection === "equisolid" ? Math.sin(0.5 * zenithRad) : zenithRad;
    }

    function fitProjectionCalibration(samples, options = {}) {
        const projection = options.projection === "equisolid" ? "equisolid" : "equidistant";
        const rows = (samples || []).filter(sample =>
            Number.isFinite(sample.rowPx) &&
            Number.isFinite(sample.colPx) &&
            Number.isFinite(sample.azimuthDeg) &&
            Number.isFinite(sample.zenithDeg) &&
            sample.zenithDeg > 1e-9
        );
        if (rows.length < 2) {
            throw new Error("MIRACLE calibration needs at least two valid stars");
        }
        const design = [];
        const observed = [];
        for (const row of rows) {
            const theta = row.azimuthDeg / RAD;
            const radiusCoordinate = projectionCoordinate(row.zenithDeg, projection);
            const cosTheta = Math.cos(theta);
            const sinTheta = Math.sin(theta);
            // Reparameterize k*cos(rotAngle) and k*sin(rotAngle), making the
            // position-error minimization a linear least-squares problem.
            design.push([1, 0, -radiusCoordinate * cosTheta, radiusCoordinate * sinTheta]);
            observed.push(row.rowPx);
            design.push([0, 1, -radiusCoordinate * sinTheta, -radiusCoordinate * cosTheta]);
            observed.push(row.colPx);
        }
        const [zenithRowPx, zenithColPx, kCosRotation, kSinRotation] =
            leastSquares(design, observed);
        const scalePx = Math.hypot(kCosRotation, kSinRotation);
        if (!Number.isFinite(scalePx) || scalePx <= 0) {
            throw new Error("MIRACLE scale fit did not produce a positive k");
        }
        const rotationRad = wrapRadians(Math.atan2(kSinRotation, kCosRotation));
        const imageWidth = Number(options.imageWidth);
        const imageHeight = Number(options.imageHeight);
        const calibration = {
            glatDeg: Number(options && options.glatDeg) || 0,
            glonDeg: Number(options && options.glonDeg) || 0,
            // MIRACLE uses 1-based row/column image coordinates.
            xcPx: zenithRowPx,
            ycPx: zenithColPx,
            projection,
            scalePx,
            rotationRad,
            sampleCount: rows.length,
            fitSource: options && options.fitSource || "selected WISC stars",
        };
        if (projection === "equisolid") {
            calibration.kPx = scalePx;
            calibration.equation = "d_px = k_px * sin(z_rad / 2)";
        } else {
            calibration.kPxPerRad = scalePx;
            calibration.kPxPerDeg = scalePx / RAD;
            calibration.equation = "d_px = k_px_per_rad * z_rad";
        }
        calibration.centerOffsetRowPx = Number.isFinite(imageHeight) ?
            zenithRowPx - (imageHeight + 1) / 2 : null;
        calibration.centerOffsetColPx = Number.isFinite(imageWidth) ?
            zenithColPx - (imageWidth + 1) / 2 : null;
        return calibration;
    }

    function fitCalibration(samples, options = {}) {
        return fitProjectionCalibration(samples, {...options, projection: "equidistant"});
    }

    function fitEquisolidCalibration(samples, options = {}) {
        return fitProjectionCalibration(samples, {...options, projection: "equisolid"});
    }

    function radialDistanceForZenith(zenithDeg, calibration) {
        const z = zenithDeg / RAD;
        if (calibration.projection === "equisolid") {
            return calibration.kPx * Math.sin(0.5 * z);
        }
        return Number(calibration.kPxPerRad ?? calibration.scalePx) * z;
    }

    function approximateUnitVectorAtPixel(rowPx, colPx, calibration) {
        const vertical = rowPx - calibration.xcPx;
        const horizontal = colPx - calibration.ycPx;
        const distancePx = Math.hypot(vertical, horizontal);
        const cosRotation = Math.cos(calibration.rotationRad);
        const sinRotation = Math.sin(calibration.rotationRad);
        let cosAzimuth = 1;
        let sinAzimuth = 0;
        if (distancePx > 1e-12) {
            cosAzimuth = (
                -vertical * cosRotation -
                horizontal * sinRotation
            ) / distancePx;
            sinAzimuth = (
                -horizontal * cosRotation +
                vertical * sinRotation
            ) / distancePx;
        }
        const projection = calibration.projection || "equidistant";
        let zenithRad;
        if (projection === "equisolid") {
            const normalizedRadius = distancePx / calibration.kPx;
            zenithRad = normalizedRadius <= 1 ? 2 * Math.asin(normalizedRadius) : NaN;
        } else {
            const scalePx = Number(
                calibration.kPxPerRad ?? calibration.scalePx ?? calibration.kPxPerDeg * RAD
            );
            zenithRad = distancePx / scalePx;
        }
        const sinZenith = Math.sin(zenithRad);
        return {
            east: sinZenith * sinAzimuth,
            north: sinZenith * cosAzimuth,
            up: Math.cos(zenithRad),
            zenithRad,
            zenithDeg: zenithRad * RAD,
            distancePx,
        };
    }

    function approximateSkyAtPixel(rowPx, colPx, calibration) {
        const direction = approximateUnitVectorAtPixel(rowPx, colPx, calibration);
        return {
            azRad: wrapRadians(Math.atan2(direction.east, direction.north)),
            zenithDeg: direction.zenithDeg,
            distancePx: direction.distancePx,
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
            const approximate = approximateSkyAtPixel(sample.rowPx, sample.colPx, calibration);
            const trueAzRad = sample.azimuthDeg / RAD;
            const trueZenithRad = sample.zenithDeg / RAD;
            const approximateZenithRad = approximate.zenithDeg / RAD;
            return {
                ...sample,
                distancePx: approximate.distancePx,
                approximateAzDeg: ((approximate.azRad * RAD) % 360 + 360) % 360,
                approximateZenithDeg: approximate.zenithDeg,
                zenithErrorDeg: approximate.zenithDeg - sample.zenithDeg,
                angularErrorDeg: angularSeparationDeg(
                    trueAzRad,
                    trueZenithRad,
                    approximate.azRad,
                    approximateZenithRad,
                ),
            };
        }).filter(row =>
            Number.isFinite(row.angularErrorDeg) &&
            Number.isFinite(row.zenithErrorDeg)
        );
    }

    function projectionResiduals(samples, calibration) {
        return (samples || []).map(sample => {
            const theta = sample.azimuthDeg / RAD;
            const distancePx = radialDistanceForZenith(sample.zenithDeg, calibration);
            const predictedRowPx = calibration.xcPx -
                distancePx * Math.cos(theta + calibration.rotationRad);
            const predictedColPx = calibration.ycPx -
                distancePx * Math.sin(theta + calibration.rotationRad);
            const residualRowPx = predictedRowPx - sample.rowPx;
            const residualColPx = predictedColPx - sample.colPx;
            const angular = approximationErrors([sample], calibration)[0];
            return {
                ...sample,
                predictedRowPx,
                predictedColPx,
                residualRowPx,
                residualColPx,
                residualNormPx: Math.hypot(residualRowPx, residualColPx),
                angularErrorDeg: angular ? angular.angularErrorDeg : NaN,
            };
        }).filter(row =>
            Number.isFinite(row.residualNormPx) && Number.isFinite(row.angularErrorDeg)
        );
    }

    function projectionResidualSummary(residuals) {
        const rows = (residuals || []).filter(row =>
            Number.isFinite(row.residualNormPx) && Number.isFinite(row.angularErrorDeg)
        );
        if (!rows.length) {
            return {
                count: 0,
                rmsPixel: null,
                stdPixel: null,
                rmsAngleDeg: null,
                stdAngleDeg: null,
            };
        }
        const pixel = rows.map(row => row.residualNormPx);
        const angle = rows.map(row => row.angularErrorDeg);
        const meanPixel = pixel.reduce((sum, value) => sum + value, 0) / pixel.length;
        const meanAngle = angle.reduce((sum, value) => sum + value, 0) / angle.length;
        return {
            count: rows.length,
            rmsPixel: Math.sqrt(pixel.reduce((sum, value) => sum + value ** 2, 0) / pixel.length),
            stdPixel: Math.sqrt(pixel.reduce((sum, value) => sum + (value - meanPixel) ** 2, 0) / pixel.length),
            rmsAngleDeg: Math.sqrt(angle.reduce((sum, value) => sum + value ** 2, 0) / angle.length),
            stdAngleDeg: Math.sqrt(angle.reduce((sum, value) => sum + (value - meanAngle) ** 2, 0) / angle.length),
        };
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

    function formatMiracleAscii(calibration, product = null) {
        const comment =
            "% MIRACLE_equidistant Glat[deg] Glon[deg] " +
            "Xc=zenithRow[pixel,1-based] Yc=zenithCol[pixel,1-based] " +
            "k_equdist[pixel/degree] rotAngle[radian] equation:d_px=k_equdist*z_degree";
        const values = [
            calibration.glatDeg,
            calibration.glonDeg,
            calibration.xcPx,
            calibration.ycPx,
            calibration.kPxPerDeg,
            calibration.rotationRad,
        ].map(asciiNumber).join(" ");
        const lines = [comment, values];
        if (product && product.equidistant && product.equisolid) {
            lines.push(
                "% MIRACLE_equisolid Glat[deg] Glon[deg] " +
                "Xc=zenithRow[pixel,1-based] Yc=zenithCol[pixel,1-based] " +
                "k_equisolid[pixel] a[dimensionless,fixed] p[pixel,fixed] " +
                "rotAngle[radian] RMS[pixel] " +
                "equation:d_px=k_equisolid*sin(0.5*z_rad) a=0.5 p=0"
            );
            lines.push([
                product.equisolid.glatDeg,
                product.equisolid.glonDeg,
                product.equisolid.xcPx,
                product.equisolid.ycPx,
                product.equisolid.kPx,
                0.5,
                0,
                product.equisolid.rotationRad,
                product.equisolidFitSummary.rmsPixel,
            ].map(asciiNumber).join(" "));
            const appendFit = (name, fit, summary, scaleName, scaleValue) => {
                lines.push(
                    `% WISC_${name} ${scaleName}=${asciiNumber(scaleValue)} ` +
                    `Xc_offset_from_image_center[pixel]=${asciiNumber(fit.centerOffsetRowPx)} ` +
                    `Yc_offset_from_image_center[pixel]=${asciiNumber(fit.centerOffsetColPx)} ` +
                    `rotAngle[radian]=${asciiNumber(fit.rotationRad)} ` +
                    `rms_pixel[pixel]=${asciiNumber(summary.rmsPixel)} ` +
                    `std_pixel[pixel]=${asciiNumber(summary.stdPixel)} ` +
                    `rms_angle[degree]=${asciiNumber(summary.rmsAngleDeg)} ` +
                    `std_angle[degree]=${asciiNumber(summary.stdAngleDeg)}`
                );
            };
            appendFit(
                "equidistant_d=k*z_rad",
                product.equidistant,
                product.equidistantFitSummary,
                "k_equdist[pixel/radian]",
                product.equidistant.kPxPerRad,
            );
            appendFit(
                "equisolid_d=k*sin(z_rad/2)",
                product.equisolid,
                product.equisolidFitSummary,
                "k_equisolid[pixel]",
                product.equisolid.kPx,
            );
        }
        return `${lines.join("\n")}\n`;
    }

    return {
        angularSeparationDeg,
        approximationErrors,
        approximateSkyAtPixel,
        approximateUnitVectorAtPixel,
        errorSummary,
        fitCalibration,
        fitEquisolidCalibration,
        fitProjectionCalibration,
        formatMiracleAscii,
        imagePrefix,
        projectionResiduals,
        projectionResidualSummary,
        wrapDegrees,
        wrapRadians,
    };
});
