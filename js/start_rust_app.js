// GUI glue only. Keep index.html/style.css/app.js as the existing interface;
// delegate scientific operations to the native/shared Rust engine.
import init, * as wasm from "../pkg/wisc_web.js";

try {
    await init();
    const tools = window.AidaTools;
    tools.cameraModel = (az, ze, parameters, model, width, height) => {
        const result = wasm.engine_project(new Float64Array([az, ze]), new Float64Array(parameters), model, width, height);
        return {x: result[0], y: result[1]};
    };
    tools.cameraRot = (alpha, beta, gamma) => Array.from(wasm.engine_rotation(alpha, beta, gamma));
    tools.cameraAnglesFromRotation = rotation => {
        const [alpha, beta, gamma] = wasm.engine_angles(new Float64Array(rotation));
        return {alpha, beta, gamma};
    };
    tools.radecToAzZe = (ra, dec, date, latitude, longitude) => {
        const result = wasm.engine_radec(new Float64Array([ra, dec]), date.getTime(), latitude, longitude);
        return {az: result[0], ze: result[1]};
    };
    tools.visibleStars = (catalogue, date, latitude, longitude, magnitude, maxZenith) => {
        const selected = catalogue.filter(row => row[2] <= magnitude);
        const sky = wasm.engine_radec(new Float64Array(selected.flatMap(row => [row[0], row[1]])), date.getTime(), latitude, longitude);
        return selected.map((row, i) => ({raHours: row[0], decDeg: row[1], mag: row[2], name: row[3], id: row[4], az: sky[2*i], ze: sky[2*i+1]}))
            .filter(star => Number.isFinite(star.az) && Number.isFinite(star.ze) && star.ze * tools.RAD < maxZenith)
            .sort((a, b) => a.mag - b.mag);
    };
    window.WiscRustEngine = Object.freeze({
        fit: (job, method, iterations) => JSON.parse(wasm.engine_fit(JSON.stringify(job), method, iterations)),
        residualPlot: (canvas, rows) => wasm.engine_residual_plot(canvas, new Float64Array(rows.flatMap(row => [row.dx, row.dy]))),
    });
    document.body.dataset.calibrationEngine = "rust";
    const script = document.createElement("script");
    script.src = new URL("app.js", import.meta.url).href;
    script.onerror = () => { document.getElementById("status").textContent = "Could not load the original GUI."; };
    document.body.appendChild(script);
} catch (error) {
    // Do not silently substitute a different numerical engine in production.
    document.getElementById("status").textContent = `Rust engine could not start: ${error}`;
}
