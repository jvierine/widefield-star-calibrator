(function () {
    "use strict";

    async function maybeDecompressCatalogBuffer(buffer) {
        const bytes = new Uint8Array(buffer);
        const magic = bytes.length >= 8 ? String.fromCharCode(...bytes.subarray(0, 8)) : "";
        if (magic === "WISCAT1\0") {
            return buffer;
        }
        const looksGzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
        if (!looksGzip) {
            throw new Error("unknown catalogue compression");
        }
        if (typeof DecompressionStream !== "function") {
            throw new Error("browser does not support gzip DecompressionStream");
        }
        const stream = new Blob([buffer])
            .stream()
            .pipeThrough(new DecompressionStream("gzip"));
        return await new Response(stream).arrayBuffer();
    }

    function parseWiscatFloat32Catalog(buffer) {
        const view = new DataView(buffer);
        const magic = String.fromCharCode(...new Uint8Array(buffer, 0, 8));
        if (magic !== "WISCAT1\0") {
            throw new Error("bad catalogue binary header");
        }
        const count = view.getUint32(8, true);
        const stride = view.getUint32(12, true);
        if (stride !== 3 || buffer.byteLength < 16 + count * stride * 4) {
            throw new Error("bad catalogue binary dimensions");
        }
        const rows = new Array(count);
        let offset = 16;
        for (let i = 0; i < count; i += 1) {
            rows[i] = [
                view.getFloat32(offset, true),
                view.getFloat32(offset + 4, true),
                view.getFloat32(offset + 8, true),
                "",
                `TYCHO2-${i + 1}`,
            ];
            offset += 12;
        }
        return rows;
    }

    async function loadWiscatFloat32Catalog(url, options = {}) {
        if (!window.fetch) {
            throw new Error("browser fetch API missing");
        }
        const response = await fetch(url, {cache: options.cache || "no-cache"});
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const buffer = await maybeDecompressCatalogBuffer(await response.arrayBuffer());
        return parseWiscatFloat32Catalog(buffer);
    }

    window.WiscCatalogs = {
        loadWiscatFloat32Catalog,
        parseWiscatFloat32Catalog,
    };
}());
