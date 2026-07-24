"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");


function pythonCommand() {
    if (process.env.PYTHON) {
        return process.env.PYTHON;
    }
    return [
        "/opt/miniconda3/bin/python",
        "/opt/anaconda3/bin/python",
    ].find(candidate => fs.existsSync(candidate)) || "python3";
}


test("Python MIRACLE evaluator agrees for an exactly equidistant synthetic camera", () => {
    const root = path.join(__dirname, "..");
    const script = `
import json
import math
from pathlib import Path
import numpy as np
import evaluate_miracle_error as evaluator

width = height = 800
k = 4.0
f = -k * (180.0 / math.pi) / width
calibration = evaluator.Calibration(
    path=Path("synthetic_calibration.h5"),
    width=width,
    height=height,
    optmod=12,
    optpar=np.array([f, f, 0, 0, 0, 0, 0, 0], dtype=float),
    miracle=np.array([69, 20, height / 2, width / 2, k, 0], dtype=float),
)

errors = []
for zenith_deg in (10, 30, 60):
    for azimuth_deg in range(0, 360, 30):
        theta = math.radians(azimuth_deg)
        distance = k * zenith_deg
        row = height / 2 - distance * math.cos(theta)
        col = width / 2 - distance * math.sin(theta)
        errors.append(evaluator.angular_error_deg(row, col, calibration))

rows, cols, grid = evaluator.sample_error_grid(calibration, 64)
print(json.dumps({
    "max_error": max(errors),
    "grid_max": float(np.nanmax(grid)),
    "shape": list(grid.shape),
    "rows": len(rows),
    "cols": len(cols),
}))
`;
    const result = childProcess.spawnSync(
        pythonCommand(),
        ["-c", script],
        {cwd: root, encoding: "utf8"},
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.ok(output.max_error < 1e-6, `sample error ${output.max_error} deg`);
    assert.ok(output.grid_max < 1e-5, `grid error ${output.grid_max} deg`);
    assert.deepEqual(output.shape, [64, 64]);
    assert.equal(output.rows, 64);
    assert.equal(output.cols, 64);
});
