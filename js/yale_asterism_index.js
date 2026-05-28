(function () {
    "use strict";

    const MAGIC = "WISAST1\0";
    const DEFAULT_URL = "data/yale_asterisms_mag4_min1p5_max40.bin.gz?v=20260527a";
    const BRIGHT_MAG3_URL = "data/yale_asterisms_mag3_min0p5_max40.bin.gz?v=20260528a";

    async function maybeDecompressAsterismBuffer(buffer) {
        const bytes = new Uint8Array(buffer);
        const magic = bytes.length >= 8 ? String.fromCharCode(...bytes.subarray(0, 8)) : "";
        if (magic === MAGIC) {
            return buffer;
        }
        const looksGzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
        if (!looksGzip) {
            throw new Error("unknown Yale asterism index compression");
        }
        if (typeof DecompressionStream !== "function") {
            throw new Error("browser does not support gzip DecompressionStream");
        }
        const stream = new Blob([buffer])
            .stream()
            .pipeThrough(new DecompressionStream("gzip"));
        return await new Response(stream).arrayBuffer();
    }

    function parseYaleAsterismIndex(buffer) {
        const view = new DataView(buffer);
        const magic = String.fromCharCode(...new Uint8Array(buffer, 0, 8));
        if (magic !== MAGIC) {
            throw new Error("bad Yale asterism index header");
        }
        const count = view.getUint32(8, true);
        const sourceStarCount = view.getUint32(12, true);
        const strideBytes = view.getUint32(16, true);
        const maxMag = view.getFloat32(20, true);
        const minSepDeg = view.getFloat32(24, true);
        const maxSepDeg = view.getFloat32(28, true);
        const headerBytes = 32;
        if (strideBytes !== 20 || buffer.byteLength < headerBytes + count * strideBytes) {
            throw new Error("bad Yale asterism index dimensions");
        }
        const ac = new Float32Array(count);
        const bc = new Float32Array(count);
        const cDeg = new Float32Array(count);
        const star0 = new Uint16Array(count);
        const star1 = new Uint16Array(count);
        const star2 = new Uint16Array(count);
        let offset = headerBytes;
        for (let i = 0; i < count; i += 1) {
            ac[i] = view.getFloat32(offset, true);
            bc[i] = view.getFloat32(offset + 4, true);
            star0[i] = view.getUint16(offset + 8, true);
            star1[i] = view.getUint16(offset + 10, true);
            star2[i] = view.getUint16(offset + 12, true);
            cDeg[i] = view.getFloat32(offset + 16, true);
            offset += strideBytes;
        }
        return createYaleAsterismIndex({ac, bc, cDeg, star0, star1, star2}, {
            count,
            sourceStarCount,
            maxMag,
            minSepDeg,
            maxSepDeg,
        });
    }

    function lowerBound(values, target) {
        let lo = 0;
        let hi = values.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (values[mid] < target) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        return lo;
    }

    function upperBound(values, target) {
        let lo = 0;
        let hi = values.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (values[mid] <= target) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        return lo;
    }

    function createYaleAsterismIndex(arrays, metadata = {}) {
        function getRecord(index) {
            return {
                index,
                ac: arrays.ac[index],
                bc: arrays.bc[index],
                cDeg: arrays.cDeg[index],
                stars: [arrays.star0[index], arrays.star1[index], arrays.star2[index]],
            };
        }

        function get_asterisms(ac, bc, deltaAc, deltaBc, options = {}) {
            const maxHits = Number.isFinite(options.maxHits) ? Math.max(0, Math.floor(options.maxHits)) : Infinity;
            const loAc = ac - Math.abs(deltaAc);
            const hiAc = ac + Math.abs(deltaAc);
            const loBc = bc - Math.abs(deltaBc);
            const hiBc = bc + Math.abs(deltaBc);
            const hits = [];
            const start = lowerBound(arrays.ac, loAc);
            const stop = upperBound(arrays.ac, hiAc);
            for (let i = start; i < stop && hits.length < maxHits; i += 1) {
                const y = arrays.bc[i];
                if (y >= loBc && y <= hiBc) {
                    hits.push(i);
                }
            }
            return hits;
        }

        function getAsterisms(ac, bc, deltaAc, deltaBc, options = {}) {
            return get_asterisms(ac, bc, deltaAc, deltaBc, options);
        }

        function getRecords(indices) {
            return indices.map(getRecord);
        }

        function getCandidateStarSet(indices) {
            const stars = new Set();
            for (const index of indices) {
                stars.add(arrays.star0[index]);
                stars.add(arrays.star1[index]);
                stars.add(arrays.star2[index]);
            }
            return stars;
        }

        return {
            ...metadata,
            arrays,
            get_asterisms,
            getAsterisms,
            getRecord,
            getRecords,
            getCandidateStarSet,
        };
    }

    async function load(url = DEFAULT_URL, options = {}) {
        if (!window.fetch) {
            throw new Error("browser fetch API missing");
        }
        const response = await fetch(url, {cache: options.cache || "no-cache"});
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const buffer = await maybeDecompressAsterismBuffer(await response.arrayBuffer());
        return parseYaleAsterismIndex(buffer);
    }

    window.WiscYaleAsterismIndex = {
        load,
        parseYaleAsterismIndex,
        createYaleAsterismIndex,
        maybeDecompressAsterismBuffer,
        defaultUrl: DEFAULT_URL,
        brightMag3Url: BRIGHT_MAG3_URL,
    };
}());
