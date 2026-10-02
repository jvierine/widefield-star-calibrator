(function (root, factory) {
    "use strict";
    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    root.AidaCelestialGrid = api;
}(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";
    function inertialDirection(ecef, rotation) {
        const v = [0, 1, 2].map(i => ecef.reduce((s, x, j) => s + x * rotation[j * 3 + i], 0));
        const n = Math.hypot(...v);
        return {raHours: ((Math.atan2(v[1], v[0]) * 12 / Math.PI) + 24) % 24,
            decDeg: Math.asin(Math.max(-1, Math.min(1, v[2] / n))) * 180 / Math.PI};
    }
    function localLines(raHours, decDeg, radiusDeg) {
        const radius = Math.max(2, Math.min(30, radiusDeg));
        const decLow = Math.max(-89.9, decDeg - radius), decHigh = Math.min(89.9, decDeg + radius);
        const cos = Math.cos(Math.max(Math.abs(decLow), Math.abs(decHigh)) * Math.PI / 180);
        const halfRa = Math.min(180, radius / Math.max(.02, cos));
        const raStep = cos > .2 ? 3.75 : cos > .08 ? 7.5 : 15;
        const decStep = radius <= 15 ? 1 : 5;
        const low = raHours * 15 - halfRa, high = raHours * 15 + halfRa;
        const lines = [];
        for (let ra = Math.ceil(low / raStep) * raStep; ra < high; ra += raStep) {
            const h = ((ra / 15) % 24 + 24) % 24, points = [];
            for (let dec = decLow; dec <= decHigh; dec += .2) points.push([h, dec]);
            const minutes = Math.round(h * 60) % 1440;
            lines.push({kind: "ra", value: h, label: `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`, points});
        }
        for (let dec = Math.ceil(decLow / decStep) * decStep; dec <= decHigh; dec += decStep) {
            const points = [];
            // Bound the sample count near a pole without introducing RA-wrap joins.
            const step = Math.max(.25, (high - low) / 720);
            for (let ra = low; ra <= high; ra += step) points.push([((ra / 15) % 24 + 24) % 24, dec]);
            lines.push({kind: "dec", value: dec, label: `${dec > 0 ? "+" : ""}${dec}°`, points});
        }
        return lines;
    }
    return {inertialDirection, localLines};
}));
