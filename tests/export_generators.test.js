const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadExportGenerators() {
    const source = fs.readFileSync(path.join(__dirname, "..", "js", "export_generators.js"), "utf8");
    const context = {
        window: {},
        Number,
    };
    vm.createContext(context);
    vm.runInContext(source, context, {filename: "export_generators.js"});
    return context.window.AidaExportGenerators;
}

function loadAidaTools() {
    const source = fs.readFileSync(path.join(__dirname, "..", "js", "aidatools.js"), "utf8");
    const context = {
        window: {},
        Math,
        Date,
        Number,
        Array,
        Uint8Array,
        ArrayBuffer,
        DataView,
    };
    vm.createContext(context);
    vm.runInContext(source, context, {filename: "aidatools.js"});
    return context.window.AidaTools;
}

const ExportGenerators = loadExportGenerators();
const AidaTools = loadAidaTools();
const LANGUAGES = ["python", "julia", "c", "matlab"];
const MODELS = [1, 2, 3, 4, 5, 6, 12, ExportGenerators.BROWN_CONRADY_OPTMOD];
const RAD = 180 / Math.PI;
const RUN_FULL_TESTS = process.env.AIDA_FULL_TESTS === "1";
const GENERATED_MAPPER_REPORT_DIR = path.join(__dirname, "..", "test-report", "generated-mapper-exports");

function fullTest(name, fn) {
    test(name, {skip: !RUN_FULL_TESTS, timeout: 20000}, fn);
}

function pythonCommand() {
    if (process.env.PYTHON) {
        return process.env.PYTHON;
    }
    const localCondaCandidates = [
        "/opt/miniconda3/bin/python",
        "/opt/anaconda3/bin/python",
    ];
    return localCondaCandidates.find(candidate => fs.existsSync(candidate)) || "python3";
}

function contextForOptmod(optmod) {
    const optpar = optmod === ExportGenerators.BROWN_CONRADY_OPTMOD ?
        [0.9, 1.2, 1.0, -2.0, 3.0, 0.01, -0.02, 0.02, -0.005, 0.0004, 0.0001, -0.0002] :
        [0.9, 1.2, 1.0, -2.0, 3.0, 0.01, -0.02, optmod === 12 ? -0.25 : 0.7];
    return {optpar, optmod, width: 1920, height: 1080};
}

function assertCleanGeneratedText(text, language, optmod) {
    assert.equal(typeof text, "string");
    assert.ok(text.length > 100, `${language} optmod ${optmod} export should be non-trivial`);
    assert.ok(!text.includes("undefined"), `${language} optmod ${optmod} export contains undefined`);
    assert.ok(!text.includes("[object Object]"), `${language} optmod ${optmod} export contains object stringification`);
    assert.ok(text.includes(String(optmod)), `${language} optmod ${optmod} export should mention optmod`);
}

test("optpar array generators support every language and model", () => {
    for (const optmod of MODELS) {
        const context = contextForOptmod(optmod);
        for (const language of LANGUAGES) {
            const text = ExportGenerators.optparArrayText(context, language);
            assert.equal(typeof text, "string");
            assert.ok(!text.includes("undefined"), `${language} optmod ${optmod} optpar contains undefined`);
            assert.ok(!text.includes("[object Object]"), `${language} optmod ${optmod} optpar contains object stringification`);
            assert.ok(text.includes(String(optmod)), `${language} optmod ${optmod} optpar should include model number`);
            if (language === "c") {
                assert.match(text, /^static const double optpar\[\d+\] = \{/);
                assert.ok(text.endsWith("};"));
            } else if (language === "matlab") {
                assert.match(text, /^optpar = \[/);
                assert.ok(text.endsWith("];"));
            } else {
                assert.match(text, /^optpar = \[/);
                assert.ok(text.endsWith("]"));
            }
        }
    }
});

test("mapper code generators support every language and model", () => {
    for (const optmod of MODELS) {
        const context = contextForOptmod(optmod);
        for (const language of LANGUAGES) {
            const text = ExportGenerators.mapperCode(context, language);
            assertCleanGeneratedText(text, language, optmod);
            if (language === "python") {
                assert.match(text, /def az_el_to_image/);
                assert.match(text, /def image_to_az_el/);
                assert.match(text, /class WiscCamera/);
                assert.match(text, /camera = WiscCamera/);
                assert.doesNotMatch(text, /from wisc_lens import/);
            } else if (language === "julia") {
                assert.match(text, /function az_el_to_image/);
                assert.doesNotMatch(text, /function image_to_az_el/);
            } else if (language === "c") {
                assert.match(text, /void aida_az_el_to_image/);
                assert.match(text, /#include <math.h>/);
            } else if (language === "matlab") {
                assert.match(text, /function \[x, y\] = az_el_to_image/);
            }
        }
    }
});

test("python mapper exports are syntactically valid for every model", () => {
    const python = pythonCommand();
    for (const optmod of MODELS) {
        const text = ExportGenerators.mapperCode(contextForOptmod(optmod), "python");
        const result = childProcess.spawnSync(
            python,
            ["-c", "import ast, sys; ast.parse(sys.stdin.read())"],
            {input: text, encoding: "utf8"},
        );
        assert.equal(result.status, 0, result.stderr || result.stdout);
    }
});

test("wisc_lens Python module reproduces JS projections for every model", () => {
    const python = pythonCommand();
    const cases = [];
    const samples = [
        {azDeg: 15, elDeg: 70},
        {azDeg: 120, elDeg: 50},
        {azDeg: 240, elDeg: 35},
    ];
    for (const optmod of MODELS) {
        const context = contextForOptmod(optmod);
        for (const sample of samples) {
            const expected = AidaTools.cameraModel(
                sample.azDeg / RAD,
                (90 - sample.elDeg) / RAD,
                context.optpar,
                context.optmod,
                context.width,
                context.height,
            );
            cases.push({...context, sample, expected});
        }
    }
    const script = `
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path.cwd()))
import wisc_lens

cases = json.loads(${JSON.stringify(JSON.stringify(cases))})
out = []
for case in cases:
    optpar = [case["optmod"]] + case["optpar"]
    x, y = wisc_lens.az_el_to_pixel(
        case["sample"]["azDeg"],
        case["sample"]["elDeg"],
        optpar,
        case["width"],
        case["height"],
    )
    explicit_x, explicit_y = wisc_lens.az_el_to_pixel(
        case["sample"]["azDeg"],
        case["sample"]["elDeg"],
        case["optpar"],
        case["width"],
        case["height"],
        optmod=case["optmod"],
    )
    az, el, err = wisc_lens.pixel_to_az_el(
        x,
        y,
        optpar,
        case["width"],
        case["height"],
        return_error=True,
    )
    explicit_az, explicit_el, explicit_err = wisc_lens.pixel_to_az_el(
        explicit_x,
        explicit_y,
        case["optpar"],
        case["width"],
        case["height"],
        optmod=case["optmod"],
        return_error=True,
    )
    out.append({
        "x": x, "y": y, "az": az, "el": el, "err": err,
        "explicit_x": explicit_x, "explicit_y": explicit_y,
        "explicit_az": explicit_az, "explicit_el": explicit_el,
        "explicit_err": explicit_err,
    })
print(json.dumps(out))
`;
    const result = childProcess.spawnSync(python, ["-c", script], {
        cwd: path.join(__dirname, ".."),
        encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const actual = JSON.parse(result.stdout);
    assert.equal(actual.length, cases.length);
    actual.forEach((row, index) => {
        const expected = cases[index].expected;
        assert.ok(Math.abs(row.x - expected.x) < 1e-6,
            `case ${index} x ${row.x} should match JS ${expected.x}`);
        assert.ok(Math.abs(row.y - expected.y) < 1e-6,
            `case ${index} y ${row.y} should match JS ${expected.y}`);
        assert.ok(row.err < 0.1, `case ${index} inverse reprojection error ${row.err} px`);
        assert.ok(Math.abs(row.explicit_x - row.x) < 1e-12,
            `case ${index} explicit optmod x should match prefixed optpar`);
        assert.ok(Math.abs(row.explicit_y - row.y) < 1e-12,
            `case ${index} explicit optmod y should match prefixed optpar`);
        assert.ok(row.explicit_err < 0.1,
            `case ${index} explicit optmod inverse error ${row.explicit_err} px`);
    });
});

function loadSavedCase(caseId) {
    const metadataPath = path.join(__dirname, "..", "test_cases", caseId, "metadata.json");
    return JSON.parse(fs.readFileSync(metadataPath, "utf8"));
}

function exportContextFromSavedCase(savedCase) {
    const optpar = savedCase.optpar || [];
    return {
        optmod: Math.round(Number(optpar[0])),
        optpar: optpar.slice(1).map(Number),
        width: Number(savedCase.width),
        height: Number(savedCase.height),
    };
}

function projectionSamples(savedCase, maxSamples = 5) {
    return (savedCase.matches || [])
        .filter(match => match.catalog &&
            Number.isFinite(Number(match.catalog.az)) &&
            Number.isFinite(Number(match.catalog.ze)))
        .slice(0, maxSamples)
        .map(match => ({
            azDeg: Number(match.catalog.az) * RAD,
            elDeg: 90 - Number(match.catalog.ze) * RAD,
        }));
}

function referenceProjections(context, samples) {
    return samples.map(sample => AidaTools.cameraModel(
        sample.azDeg / RAD,
        (90 - sample.elDeg) / RAD,
        context.optpar,
        context.optmod,
        context.width,
        context.height,
    ));
}

function assertProjectionClose(actual, expected, label) {
    assert.ok(Number.isFinite(actual.x), `${label} x should be finite`);
    assert.ok(Number.isFinite(actual.y), `${label} y should be finite`);
    assert.ok(Math.abs(actual.x - expected.x) < 1e-6,
        `${label} x ${actual.x} should match JS ${expected.x}`);
    assert.ok(Math.abs(actual.y - expected.y) < 1e-6,
        `${label} y ${actual.y} should match JS ${expected.y}`);
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function commandSnippet() {
    return "AIDA_FULL_TESTS=1 node --test --test-timeout=20000 tests/export_generators.test.js";
}

function writeGeneratedMapperReport(report) {
    fs.mkdirSync(GENERATED_MAPPER_REPORT_DIR, {recursive: true});
    fs.writeFileSync(
        path.join(GENERATED_MAPPER_REPORT_DIR, "summary.json"),
        JSON.stringify(report, null, 2),
    );
    fs.writeFileSync(path.join(GENERATED_MAPPER_REPORT_DIR, "index.html"), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>AIDA Generated Mapper Export Test Report</title>
<style>
body { margin: 24px; background: #111318; color: #eef2f7; font: 14px/1.45 system-ui, sans-serif; }
h1, h2 { margin: 0.8rem 0 0.5rem; }
code, pre { background: #1c212b; color: #dbe7ff; border-radius: 4px; }
pre { padding: 12px; overflow-x: auto; }
table { width: 100%; border-collapse: collapse; margin: 12px 0 28px; }
th, td { padding: 6px 8px; border-bottom: 1px solid #2b3340; text-align: right; }
th:first-child, td:first-child, th:nth-child(2), td:nth-child(2) { text-align: left; }
th { color: #aebbd0; font-weight: 600; }
.ok { color: #7ee787; }
.warn { color: #ffb86b; }
.meta { color: #aebbd0; }
</style>
</head>
<body>
<h1>Generated Mapper Export Test Report</h1>
<p class="meta">Generated ${escapeHtml(report.generatedAt)}. This report compares GUI-generated Python and C mapper code against the JavaScript camera model using known optpars from saved test cases.</p>
<h2>Repeat Command</h2>
<pre>${escapeHtml(report.command)}</pre>
${report.cases.map(testCase => `
<h2>${escapeHtml(testCase.id)} <span class="${testCase.pass ? "ok" : "warn"}">${testCase.pass ? "PASS" : "FAIL"}</span></h2>
<p class="meta">optmod ${escapeHtml(testCase.optmod)}, image ${escapeHtml(testCase.width)} x ${escapeHtml(testCase.height)}, samples ${escapeHtml(testCase.samples.length)}, max Python error ${testCase.maxPythonErrorPx.toExponential(3)} px, max C error ${testCase.maxCErrorPx.toExponential(3)} px.</p>
<table>
<thead><tr><th>#</th><th>az/el deg</th><th>JS x</th><th>JS y</th><th>Python dx</th><th>Python dy</th><th>C dx</th><th>C dy</th></tr></thead>
<tbody>
${testCase.samples.map((sample, index) => `
<tr>
<td>${index + 1}</td>
<td>${sample.azDeg.toFixed(6)}, ${sample.elDeg.toFixed(6)}</td>
<td>${sample.expected.x.toFixed(6)}</td>
<td>${sample.expected.y.toFixed(6)}</td>
<td>${sample.pythonDx.toExponential(3)}</td>
<td>${sample.pythonDy.toExponential(3)}</td>
<td>${sample.cDx.toExponential(3)}</td>
<td>${sample.cDy.toExponential(3)}</td>
</tr>`).join("")}
</tbody>
</table>`).join("")}
</body>
</html>
`);
}

function runGeneratedPythonMapper(context, samples) {
    const python = pythonCommand();
    const script = `${ExportGenerators.mapperCode(context, "python")}
import json
samples = ${JSON.stringify(samples)}
print(json.dumps([az_el_to_image(s["azDeg"], s["elDeg"]).tolist() for s in samples]))
`;
    const result = childProcess.spawnSync(python, ["-c", script], {encoding: "utf8"});
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout).map(([x, y]) => ({x, y}));
}

function runGeneratedCMapper(context, samples) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aida-export-c-"));
    const sourcePath = path.join(tmpDir, "mapper_test.c");
    const binaryPath = path.join(tmpDir, "mapper_test");
    const calls = samples.map((sample, index) =>
        `    aida_az_el_to_image(${sample.azDeg.toPrecision(17)}, ${sample.elDeg.toPrecision(17)}, &x, &y);\n` +
        `    printf("${index} %.17g %.17g\\n", x, y);`
    ).join("\n");
    fs.writeFileSync(sourcePath, `${ExportGenerators.mapperCode(context, "c")}
#include <stdio.h>
int main(void) {
    double x = 0.0;
    double y = 0.0;
${calls}
    return 0;
}
`);
    const compile = childProcess.spawnSync("cc", [sourcePath, "-lm", "-o", binaryPath], {encoding: "utf8"});
    assert.equal(compile.status, 0, compile.stderr || compile.stdout);
    const run = childProcess.spawnSync(binaryPath, [], {encoding: "utf8"});
    assert.equal(run.status, 0, run.stderr || run.stdout);
    return run.stdout.trim().split(/\n+/).map(line => {
        const [, x, y] = line.trim().split(/\s+/).map(Number);
        return {x, y};
    });
}

fullTest("generated Python and C mappers reproduce JS projections for saved test-case optpars", () => {
    const savedCases = [
        loadSavedCase("2025_02_19_03_47_01_000_010881_ams0882_first1s"),
        loadSavedCase("IMG_9953"),
    ];
    const report = {
        generatedAt: new Date().toISOString(),
        command: commandSnippet(),
        tolerancePx: 1e-6,
        cases: [],
    };
    for (const savedCase of savedCases) {
        const context = exportContextFromSavedCase(savedCase);
        const samples = projectionSamples(savedCase);
        assert.ok(samples.length >= 3, `${savedCase.id} should provide projection samples`);
        const expected = referenceProjections(context, samples);
        const pythonActual = runGeneratedPythonMapper(context, samples);
        const cActual = runGeneratedCMapper(context, samples);
        const rows = samples.map((sample, index) => {
            const pythonDx = pythonActual[index].x - expected[index].x;
            const pythonDy = pythonActual[index].y - expected[index].y;
            const cDx = cActual[index].x - expected[index].x;
            const cDy = cActual[index].y - expected[index].y;
            return {
                ...sample,
                expected: expected[index],
                python: pythonActual[index],
                c: cActual[index],
                pythonDx,
                pythonDy,
                cDx,
                cDy,
                pythonErrorPx: Math.hypot(pythonDx, pythonDy),
                cErrorPx: Math.hypot(cDx, cDy),
            };
        });
        const maxPythonErrorPx = Math.max(...rows.map(row => row.pythonErrorPx));
        const maxCErrorPx = Math.max(...rows.map(row => row.cErrorPx));
        report.cases.push({
            id: savedCase.id,
            optmod: context.optmod,
            width: context.width,
            height: context.height,
            pass: maxPythonErrorPx < report.tolerancePx && maxCErrorPx < report.tolerancePx,
            maxPythonErrorPx,
            maxCErrorPx,
            samples: rows,
        });
    }
    writeGeneratedMapperReport(report);
    for (const testCase of report.cases) {
        for (let i = 0; i < testCase.samples.length; i += 1) {
            assertProjectionClose(testCase.samples[i].python, testCase.samples[i].expected,
                `${testCase.id} Python sample ${i}`);
            assertProjectionClose(testCase.samples[i].c, testCase.samples[i].expected,
                `${testCase.id} C sample ${i}`);
        }
    }
});
