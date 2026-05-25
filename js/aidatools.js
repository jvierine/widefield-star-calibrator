(function () {
    "use strict";

    const DEG = Math.PI / 180.0;
    const RAD = 180.0 / Math.PI;
    const BROWN_CONRADY_OPTMOD = 20;

    function mod(x, n) {
        return ((x % n) + n) % n;
    }

    function julianDate(date) {
        let year = date.getUTCFullYear();
        let month = date.getUTCMonth() + 1;
        const day = date.getUTCDate();
        const hour = date.getUTCHours();
        const minute = date.getUTCMinutes();
        const second = date.getUTCSeconds() + date.getUTCMilliseconds() / 1000.0;

        if (month <= 2) {
            year -= 1;
            month += 12;
        }
        const a = Math.floor(year / 100);
        const b = 2 - a + Math.floor(a / 4);
        const dayFraction = (hour + minute / 60.0 + second / 3600.0) / 24.0;
        return Math.floor(365.25 * (year + 4716)) +
            Math.floor(30.6001 * (month + 1)) +
            day + dayFraction + b - 1524.5;
    }

    function gmstDegrees(date) {
        const jd = julianDate(date);
        const t = (jd - 2451545.0) / 36525.0;
        return mod(
            280.46061837 +
            360.98564736629 * (jd - 2451545.0) +
            0.000387933 * t * t -
            t * t * t / 38710000.0,
            360.0
        );
    }

    function starAzZe(raHours, decDeg, date, latDeg, lonDeg) {
        const rsidtime = (gmstDegrees(date) + lonDeg) * DEG;
        const rra = raHours / 12.0 * Math.PI;
        const rdecl = decDeg * DEG;
        const rlat = latDeg * DEG;
        const alt = Math.asin(
            Math.cos(rsidtime - rra) * Math.cos(rdecl) * Math.cos(rlat) +
            Math.sin(rdecl) * Math.sin(rlat)
        );
        const ze = Math.PI / 2.0 - alt;
        const cosAlt = Math.max(Math.cos(alt), 1e-12);
        const sina = Math.sin(rsidtime - rra) * Math.cos(rdecl) / cosAlt;
        const cosa = (
            Math.cos(rsidtime - rra) * Math.cos(rdecl) * Math.sin(rlat) -
            Math.sin(rdecl) * Math.cos(rlat)
        ) / cosAlt;
        const az = mod(Math.atan2(sina, cosa) + Math.PI, 2.0 * Math.PI);
        return {az, ze};
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

    function cameraRot(alphaDeg, betaDeg, gammaDeg) {
        const a = alphaDeg * DEG;
        const b = betaDeg * DEG;
        const g = gammaDeg * DEG;
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

    function cameraAnglesFromRotation(rot) {
        if (!Array.isArray(rot) || rot.length < 9) {
            return null;
        }
        const beta = Math.asin(Math.max(-1, Math.min(1, rot[5])));
        const cb = Math.cos(beta);
        let alpha = 0;
        let gamma = 0;
        if (Math.abs(cb) > 1e-9) {
            alpha = Math.atan2(rot[2], rot[8]);
            gamma = Math.atan2(rot[3], rot[4]);
        } else {
            gamma = Math.atan2(-rot[1], rot[0]);
        }
        return {
            alpha: alpha * RAD,
            beta: beta * RAD,
            gamma: gamma * RAD,
        };
    }

    function cameraModel(az, ze, optpar, optmod, width, height) {
        const rot = cameraRot(optpar[2], optpar[3], optpar[4]);
        const sinze = Math.sin(ze);
        const es1 = sinze * Math.sin(az);
        const es2 = sinze * Math.cos(az);
        const es3 = Math.cos(ze);

        const sese1 = es1 * rot[0] + es2 * rot[3] + es3 * rot[6];
        const sese2 = es1 * rot[1] + es2 * rot[4] + es3 * rot[7];
        const sese3 = es1 * rot[2] + es2 * rot[5] + es3 * rot[8];

        const f1 = optpar[0];
        const f2 = optpar[1];
        const dx = optpar[5];
        const dy = optpar[6];
        const alpha = optpar[7];
        const radial = Math.sqrt(sese1 * sese1 + sese2 * sese2);
        const theta = Math.atan2(radial, sese3);
        let uNorm;
        let vNorm;

        if (radial <= 1e-12) {
            uNorm = 0.5 + dx;
            vNorm = 0.5 + dy;
        } else if (optmod === 1) {
            const safeSese3 = Math.abs(sese3) > 1e-12 ? sese3 : 1e-12;
            uNorm = f1 * sese1 / safeSese3 + 0.5 + dx;
            vNorm = f2 * sese2 / safeSese3 + 0.5 + dy;
        } else if (optmod === 2) {
            const r = Math.sin(alpha * theta);
            uNorm = f1 * sese1 / radial * r + 0.5 + dx;
            vNorm = f2 * sese2 / radial * r + 0.5 + dy;
        } else if (optmod === 3) {
            const safeSese3 = Math.max(sese3, 1e-12);
            const u1 = f1 * (1.0 - alpha) * sese1 / safeSese3;
            const v1 = f2 * (1.0 - alpha) * sese2 / safeSese3;
            const u2 = f1 * alpha * sese1 / radial * theta;
            const v2 = f2 * alpha * sese2 / radial * theta;
            uNorm = u1 + u2 + 0.5 + dx;
            vNorm = v1 + v2 + 0.5 + dy;
        } else if (optmod === 4) {
            const r = Math.pow(Math.abs(theta), alpha);
            uNorm = f1 * sese1 / radial * r + 0.5 + dx;
            vNorm = f2 * sese2 / radial * r + 0.5 + dy;
        } else if (optmod === 5) {
            const r = Math.tan(alpha * theta);
            uNorm = f1 * sese1 / radial * r + 0.5 + dx;
            vNorm = f2 * sese2 / radial * r + 0.5 + dy;
        } else if (optmod === 12) {
            let r;
            if (alpha > 0) {
                r = Math.tan(alpha * theta) / alpha;
            } else if (alpha < 0) {
                r = Math.sin(alpha * theta) / alpha;
            } else {
                r = Math.abs(theta);
            }
            uNorm = f1 * sese1 / radial * r + 0.5 + dx;
            vNorm = f2 * sese2 / radial * r + 0.5 + dy;
        } else if (optmod === BROWN_CONRADY_OPTMOD) {
            const safeSese3 = Math.abs(sese3) > 1e-12 ? sese3 : 1e-12;
            const xn = sese1 / safeSese3;
            const yn = sese2 / safeSese3;
            const r2 = xn * xn + yn * yn;
            const r4 = r2 * r2;
            const r6 = r4 * r2;
            const k1 = optpar[7] || 0;
            const k2 = optpar[8] || 0;
            const k3 = optpar[9] || 0;
            const p1 = optpar[10] || 0;
            const p2 = optpar[11] || 0;
            const radialDistortion = 1.0 + k1 * r2 + k2 * r4 + k3 * r6;
            const xDistorted = xn * radialDistortion + 2.0 * p1 * xn * yn + p2 * (r2 + 2.0 * xn * xn);
            const yDistorted = yn * radialDistortion + p1 * (r2 + 2.0 * yn * yn) + 2.0 * p2 * xn * yn;
            uNorm = f1 * xDistorted + 0.5 + dx;
            vNorm = f2 * yDistorted + 0.5 + dy;
        } else {
            return {x: NaN, y: NaN};
        }

        // AIDA/Matlab calibration files use 1-based pixel coordinates. The
        // browser works in true 0-based image pixel coordinates.
        return {x: uNorm * width - 1, y: vNorm * height - 1};
    }

    function visibleStars(catalog, date, latDeg, lonDeg, maxMagnitude, maxZenithDeg) {
        const out = [];
        for (const row of catalog) {
            const mag = row[2];
            if (mag > maxMagnitude) {
                continue;
            }
            const azze = starAzZe(row[0], row[1], date, latDeg, lonDeg);
            if (Number.isFinite(azze.az) && Number.isFinite(azze.ze) && azze.ze * RAD < maxZenithDeg) {
                out.push({raHours: row[0], decDeg: row[1], mag, name: row[3], az: azze.az, ze: azze.ze});
            }
        }
        out.sort((a, b) => a.mag - b.mag);
        return out;
    }

    function guessTimestampFromAllsky7Name(name) {
        const match = name.match(/(20\d{2})[_-](\d{2})[_-](\d{2})[_-](\d{2})[_-](\d{2})[_-](\d{2})(?:[_-](\d{1,3}))?/);
        if (!match) {
            return null;
        }
        const [, yy, mm, dd, hh, mi, ss, ms] = match;
        const milli = ms ? Number(ms.padEnd(3, "0").slice(0, 3)) : 0;
        return new Date(Date.UTC(Number(yy), Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss), milli));
    }

    const ALLSKY7_STATION_METADATA = [
        {tokens: ["010760"], latDeg: 50.9925, lonDeg: 7.18511},
        {tokens: ["012165"], latDeg: 51.463056, lonDeg: 7.221944},
        {tokens: ["010095", "010096"], latDeg: 52.49509, lonDeg: 12.63085},
        {tokens: ["010125"], latDeg: 52.1236, lonDeg: 8.70178},
        {tokens: ["010314", "cam5"], latDeg: 50.3773, lonDeg: 11.1898},
        {tokens: ["010880", "010881", "ams0881", "ams0882"], latDeg: 51.4492, lonDeg: 14.2794},
        {tokens: ["010028", "010031", "ams0228", "ams0221"], latDeg: 52.2087, lonDeg: 14.1215},
    ];

    function guessAllsky7StationMetadata(name) {
        const filename = String(name || "").split(/[\\/]/).pop().toLowerCase();
        for (const station of ALLSKY7_STATION_METADATA) {
            if (station.tokens.some(token => filename.includes(token))) {
                return {
                    latDeg: station.latDeg,
                    lonDeg: station.lonDeg,
                };
            }
        }
        return null;
    }

    function dateToDatetimeLocal(date) {
        const pad = (value, len = 2) => String(value).padStart(len, "0");
        return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
            `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.` +
            `${pad(date.getUTCMilliseconds(), 3)}`;
    }

    function datetimeLocalToDate(value) {
        if (!value) {
            return new Date();
        }
        const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?/);
        if (!match) {
            return new Date(value);
        }
        const [, yy, mm, dd, hh, mi, ss = "0", ms = "0"] = match;
        return new Date(Date.UTC(
            Number(yy), Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss),
            Number(ms.padEnd(3, "0").slice(0, 3))
        ));
    }

    function parseExifDate(text, offsetText = "") {
        const match = String(text || "").match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
        if (!match) {
            return null;
        }
        const [, yy, mm, dd, hh, mi, ss] = match;
        let utcMillis = Date.UTC(Number(yy), Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss));
        const offsetMatch = String(offsetText || "").match(/^([+-])(\d{2}):?(\d{2})$/);
        if (offsetMatch) {
            const sign = offsetMatch[1] === "+" ? 1 : -1;
            const offsetMinutes = sign * (Number(offsetMatch[2]) * 60 + Number(offsetMatch[3]));
            utcMillis -= offsetMinutes * 60000;
        }
        return new Date(utcMillis);
    }

    function parseExifMetadata(buffer) {
        const bytes = buffer instanceof ArrayBuffer ? buffer : buffer.buffer;
        const view = new DataView(bytes);
        if (view.byteLength < 4 || view.getUint16(0, false) !== 0xffd8) {
            return null;
        }

        let app1Offset = -1;
        let offset = 2;
        while (offset + 4 <= view.byteLength) {
            if (view.getUint8(offset) !== 0xff) {
                break;
            }
            const marker = view.getUint8(offset + 1);
            const length = view.getUint16(offset + 2, false);
            if (marker === 0xe1 && offset + 4 + length <= view.byteLength &&
                    readAscii(view, offset + 4, 6) === "Exif\0\0") {
                app1Offset = offset + 10;
                break;
            }
            if (length < 2) {
                break;
            }
            offset += 2 + length;
        }
        if (app1Offset < 0 || app1Offset + 8 > view.byteLength) {
            return null;
        }

        const byteOrder = readAscii(view, app1Offset, 2);
        const little = byteOrder === "II";
        if (!little && byteOrder !== "MM") {
            return null;
        }
        const u16 = at => view.getUint16(at, little);
        const u32 = at => view.getUint32(at, little);
        const i32 = at => view.getInt32(at, little);
        if (u16(app1Offset + 2) !== 42) {
            return null;
        }
        const firstIfd = app1Offset + u32(app1Offset + 4);
        const metadata = {};
        const ifd0 = readIfd(view, app1Offset, firstIfd, little);
        const exifIfdOffset = ifd0.get(0x8769);
        const gpsIfdOffset = ifd0.get(0x8825);
        const exifIfd = exifIfdOffset ? readIfd(view, app1Offset, app1Offset + exifIfdOffset.value, little) : new Map();
        const gpsIfd = gpsIfdOffset ? readIfd(view, app1Offset, app1Offset + gpsIfdOffset.value, little) : new Map();

        const makeEntry = ifd0.get(0x010f);
        const modelEntry = ifd0.get(0x0110);
        if (makeEntry && typeof makeEntry.value === "string") {
            metadata.cameraMake = cleanExifText(makeEntry.value);
        }
        if (modelEntry && typeof modelEntry.value === "string") {
            metadata.cameraModel = cleanExifText(modelEntry.value);
        }

        const dateEntry = exifIfd.get(0x9003) || exifIfd.get(0x9004) || ifd0.get(0x0132);
        const offsetEntry = exifIfd.get(0x9011) || exifIfd.get(0x9012);
        if (dateEntry) {
            const parsedDate = parseExifDate(dateEntry.value, offsetEntry ? offsetEntry.value : "");
            if (parsedDate) {
                metadata.timestampUtc = parsedDate;
            }
        }

        const lat = gpsCoordinate(gpsIfd.get(1), gpsIfd.get(2));
        const lon = gpsCoordinate(gpsIfd.get(3), gpsIfd.get(4));
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
            metadata.latDeg = lat;
            metadata.lonDeg = lon;
        }
        const alt = gpsAltitude(gpsIfd.get(5), gpsIfd.get(6));
        if (Number.isFinite(alt)) {
            metadata.altM = alt;
        }
        return Object.keys(metadata).length ? metadata : null;

        function readEntryValue(type, count, valueOffset) {
            const size = typeSize(type) * count;
            const valueAt = size <= 4 ? valueOffset : app1Offset + u32(valueOffset);
            if (valueAt < 0 || valueAt + Math.max(0, size) > view.byteLength) {
                return null;
            }
            if (type === 2) {
                return readAscii(view, valueAt, count).replace(/\0+$/, "");
            }
            if (type === 1) {
                return count === 1 ? view.getUint8(valueAt) :
                    Array.from({length: count}, (_, i) => view.getUint8(valueAt + i));
            }
            if (type === 3) {
                return count === 1 ? u16(valueAt) : Array.from({length: count}, (_, i) => u16(valueAt + 2 * i));
            }
            if (type === 4) {
                return count === 1 ? u32(valueAt) : Array.from({length: count}, (_, i) => u32(valueAt + 4 * i));
            }
            if (type === 5) {
                const read = i => {
                    const den = u32(valueAt + 8 * i + 4);
                    return den === 0 ? NaN : u32(valueAt + 8 * i) / den;
                };
                return count === 1 ? read(0) : Array.from({length: count}, (_, i) => read(i));
            }
            if (type === 9) {
                return count === 1 ? i32(valueAt) : Array.from({length: count}, (_, i) => i32(valueAt + 4 * i));
            }
            if (type === 10) {
                const read = i => {
                    const den = i32(valueAt + 8 * i + 4);
                    return den === 0 ? NaN : i32(valueAt + 8 * i) / den;
                };
                return count === 1 ? read(0) : Array.from({length: count}, (_, i) => read(i));
            }
            return null;
        }

        function readIfd(_view, tiffBase, ifdOffset, _little) {
            const out = new Map();
            if (ifdOffset < tiffBase || ifdOffset + 2 > view.byteLength) {
                return out;
            }
            const entries = u16(ifdOffset);
            for (let i = 0; i < entries; i++) {
                const entryOffset = ifdOffset + 2 + i * 12;
                if (entryOffset + 12 > view.byteLength) {
                    break;
                }
                const tag = u16(entryOffset);
                const type = u16(entryOffset + 2);
                const count = u32(entryOffset + 4);
                const value = readEntryValue(type, count, entryOffset + 8);
                out.set(tag, {type, count, value});
            }
            return out;
        }
    }

    function cleanExifText(value) {
        return String(value || "").replace(/\0+$/g, "").trim();
    }

    function readAscii(view, offset, count) {
        let out = "";
        for (let i = 0; i < count && offset + i < view.byteLength; i++) {
            out += String.fromCharCode(view.getUint8(offset + i));
        }
        return out;
    }

    function typeSize(type) {
        return {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8}[type] || 0;
    }

    function gpsCoordinate(refEntry, valueEntry) {
        if (!refEntry || !valueEntry || !Array.isArray(valueEntry.value) || valueEntry.value.length < 3) {
            return NaN;
        }
        const sign = /[SW]/i.test(refEntry.value) ? -1 : 1;
        const [deg, min, sec] = valueEntry.value;
        return sign * (deg + min / 60 + sec / 3600);
    }

    function gpsAltitude(refEntry, valueEntry) {
        if (!valueEntry || !Number.isFinite(valueEntry.value)) {
            return NaN;
        }
        const sign = refEntry && Number(refEntry.value) === 1 ? -1 : 1;
        return sign * valueEntry.value;
    }

    function normalizeExternalExifMetadata(raw) {
        if (!raw || typeof raw !== "object") {
            return null;
        }
        const metadata = {};
        const make = cleanExifText(raw.Make || raw.make || raw.CameraMake || raw.cameraMake || "");
        const model = cleanExifText(raw.Model || raw.model || raw.CameraModel || raw.cameraModel || "");
        if (make) {
            metadata.cameraMake = make;
        }
        if (model) {
            metadata.cameraModel = model;
        }
        const timestamp = coerceExifDate(
            raw.DateTimeOriginal || raw.CreateDate || raw.DateTimeDigitized || raw.ModifyDate,
            raw.OffsetTimeOriginal || raw.OffsetTimeDigitized || raw.OffsetTime
        );
        if (timestamp) {
            metadata.timestampUtc = timestamp;
        }

        const lat = coerceGpsCoordinate(
            firstFinite(raw.latitude, raw.GPSLatitude),
            raw.GPSLatitudeRef
        );
        const lon = coerceGpsCoordinate(
            firstFinite(raw.longitude, raw.GPSLongitude),
            raw.GPSLongitudeRef
        );
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
            metadata.latDeg = lat;
            metadata.lonDeg = lon;
        }

        const alt = firstFinite(raw.altitude, raw.GPSAltitude);
        if (Number.isFinite(alt)) {
            const sign = Number(raw.GPSAltitudeRef) === 1 ? -1 : 1;
            metadata.altM = sign * alt;
        }
        const imageDirection = firstFinite(
            raw.imageDirection,
            raw.ImageDirection,
            raw.GPSImgDirection,
            raw.GPSDestBearing
        );
        if (Number.isFinite(imageDirection)) {
            metadata.imageDirectionDeg = ((imageDirection % 360) + 360) % 360;
        }
        return Object.keys(metadata).length ? metadata : null;
    }

    function coerceExifDate(value, offsetText = "") {
        if (value instanceof Date && !Number.isNaN(value.getTime())) {
            return value;
        }
        if (typeof value !== "string") {
            return null;
        }
        const exifDate = parseExifDate(value, offsetText);
        if (exifDate) {
            return exifDate;
        }
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    function coerceGpsCoordinate(value, ref) {
        let out = NaN;
        if (Number.isFinite(value)) {
            out = value;
        } else if (Array.isArray(value) && value.length >= 3) {
            out = value[0] + value[1] / 60 + value[2] / 3600;
        }
        if (Number.isFinite(out) && /[SW]/i.test(String(ref || ""))) {
            out = -Math.abs(out);
        }
        return out;
    }

    function firstFinite(...values) {
        for (const value of values) {
            if (Number.isFinite(value)) {
                return value;
            }
            if (Array.isArray(value)) {
                return value;
            }
        }
        return NaN;
    }

    window.AidaTools = {
        DEG,
        RAD,
        dateToDatetimeLocal,
        datetimeLocalToDate,
        guessAllsky7StationMetadata,
        guessTimestampFromAllsky7Name,
        parseExifMetadata,
        normalizeExternalExifMetadata,
        cameraRot,
        cameraAnglesFromRotation,
        cameraModel,
        radecToAzZe: starAzZe,
        visibleStars,
    };
})();
