(function (root, factory) {
    const api = factory();
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    }
    root.WiscViewZoom = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const MIN_ZOOM = 1;
    const MAX_ZOOM = 16;

    function clamp(value, minimum, maximum) {
        return Math.max(minimum, Math.min(maximum, value));
    }

    function imageViewport(canvasWidth, canvasHeight, imageWidth, imageHeight,
            zoom = 1, centerX = imageWidth / 2, centerY = imageHeight / 2) {
        const safeCanvasWidth = Math.max(1, Number(canvasWidth) || 1);
        const safeCanvasHeight = Math.max(1, Number(canvasHeight) || 1);
        const safeImageWidth = Math.max(1, Number(imageWidth) || 1);
        const safeImageHeight = Math.max(1, Number(imageHeight) || 1);
        const safeZoom = clamp(Number(zoom) || 1, MIN_ZOOM, MAX_ZOOM);
        const fitScale = Math.min(
            safeCanvasWidth / safeImageWidth,
            safeCanvasHeight / safeImageHeight
        );
        const scale = fitScale * safeZoom;
        let safeCenterX = Number.isFinite(Number(centerX)) ? Number(centerX) : safeImageWidth / 2;
        let safeCenterY = Number.isFinite(Number(centerY)) ? Number(centerY) : safeImageHeight / 2;

        if (safeImageWidth * scale <= safeCanvasWidth) {
            safeCenterX = safeImageWidth / 2;
        } else {
            const halfVisibleWidth = safeCanvasWidth / (2 * scale);
            safeCenterX = clamp(safeCenterX, halfVisibleWidth, safeImageWidth - halfVisibleWidth);
        }
        if (safeImageHeight * scale <= safeCanvasHeight) {
            safeCenterY = safeImageHeight / 2;
        } else {
            const halfVisibleHeight = safeCanvasHeight / (2 * scale);
            safeCenterY = clamp(safeCenterY, halfVisibleHeight, safeImageHeight - halfVisibleHeight);
        }

        return {
            x: safeCanvasWidth / 2 - safeCenterX * scale,
            y: safeCanvasHeight / 2 - safeCenterY * scale,
            w: safeImageWidth * scale,
            h: safeImageHeight * scale,
            scale,
            zoom: safeZoom,
            centerX: safeCenterX,
            centerY: safeCenterY,
        };
    }

    function centerForAnchor(anchorCanvasX, anchorCanvasY, anchorImageX, anchorImageY,
            newScale, canvasWidth, canvasHeight) {
        const scale = Math.max(Number.EPSILON, Number(newScale) || 1);
        return {
            centerX: Number(anchorImageX) - (Number(anchorCanvasX) - Number(canvasWidth) / 2) / scale,
            centerY: Number(anchorImageY) - (Number(anchorCanvasY) - Number(canvasHeight) / 2) / scale,
        };
    }

    return {MIN_ZOOM, MAX_ZOOM, imageViewport, centerForAnchor};
});
