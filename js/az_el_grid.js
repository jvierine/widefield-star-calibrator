(function (root, factory) {
    "use strict";
    const api = factory();
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    }
    root.AidaAzElGrid = api;
}(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    function cornerGridSpec(width, height) {
        const imageWidth = Math.max(0, Math.floor(Number(width) || 0));
        const imageHeight = Math.max(0, Math.floor(Number(height) || 0));
        const gridWidth = imageWidth + 1;
        const gridHeight = imageHeight + 1;
        return {
            imageWidth,
            imageHeight,
            gridWidth,
            gridHeight,
            count: gridWidth * gridHeight,
        };
    }

    function rawPixelCorner(index) {
        return Number(index) - 0.5;
    }

    return {cornerGridSpec, rawPixelCorner};
}));
