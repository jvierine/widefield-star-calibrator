#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "test-report", "unit-tests");

function fastTestFiles() {
    return fs.readdirSync(path.join(ROOT, "tests"))
        .filter((filename) => filename.endsWith(".test.js"))
        .sort()
        .map((filename) => path.join("tests", filename));
}

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

function parseDurationMs(text) {
    if (!text) {
        return null;
    }
    const match = text.match(/([\d.]+)\s*(ms|s)\s*$/i);
    if (!match) {
        return null;
    }
    const value = Number(match[1]);
    return match[2].toLowerCase() === "s" ? value * 1000 : value;
}

function parseTestOutput(output) {
    const tests = [];
    const summary = {};
    const diagnostics = [];
    let activeFailure = null;
    for (const line of output.split(/\r?\n/)) {
        const testMatch = line.match(/^([✔✖﹣])\s+(.+?)(?:\s+\(([^()]*)\))?(?:\s+#\s*(.*))?$/u);
        if (testMatch) {
            const marker = testMatch[1];
            const test = {
                status: marker === "✔" ? "pass" : marker === "﹣" ? "skip" : "fail",
                name: testMatch[2].trim(),
                durationMs: parseDurationMs(testMatch[3]),
                note: testMatch[4] ? testMatch[4].trim() : "",
                diagnostics: [],
            };
            tests.push(test);
            activeFailure = test.status === "fail" ? test : null;
            continue;
        }

        const summaryMatch = line.match(/^ℹ\s+([A-Za-z_]+)\s+(.+)$/u);
        if (summaryMatch) {
            const key = summaryMatch[1];
            const rawValue = summaryMatch[2].trim();
            const value = Number(rawValue);
            summary[key] = Number.isFinite(value) ? value : rawValue;
            continue;
        }

        if (line.startsWith("  ") && activeFailure) {
            activeFailure.diagnostics.push(line);
        } else if (line.trim()) {
            diagnostics.push(line);
        }
    }
    return {tests, summary, diagnostics};
}

function formatMs(value) {
    if (!Number.isFinite(value)) {
        return "";
    }
    if (value >= 1000) {
        return `${(value / 1000).toFixed(2)} s`;
    }
    return `${value.toFixed(1)} ms`;
}

function statusClass(status) {
    if (status === "pass") {
        return "pass";
    }
    if (status === "skip") {
        return "skip";
    }
    return "fail";
}

function renderReport({result, parsed, generatedAtIso, commandText}) {
    const totals = parsed.summary;
    const rows = parsed.tests.map((test) => `
<tr class="${statusClass(test.status)}">
<td>${escapeHtml(test.status)}</td>
<td>${escapeHtml(test.name)}${test.note ? `<div class="note">${escapeHtml(test.note)}</div>` : ""}${test.diagnostics.length ? `<pre>${escapeHtml(test.diagnostics.join("\n"))}</pre>` : ""}</td>
<td>${escapeHtml(formatMs(test.durationMs))}</td>
</tr>`).join("\n");
    const rawPath = "raw-output.txt";
    const summaryJsonPath = "summary.json";
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>WISC fast unit test report</title>
<style>
body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 2rem; color: #111827; background: #f8fafc; }
h1 { margin-bottom: 0.25rem; }
.meta, .note { color: #64748b; }
.summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 0.75rem; margin: 1rem 0; }
.card { background: white; border: 1px solid #d8e0eb; border-radius: 8px; padding: 0.8rem; }
.card strong { display: block; font-size: 1.4rem; }
code, pre { background: #0f172a; color: #e2e8f0; border-radius: 6px; padding: 0.2rem 0.4rem; }
pre { white-space: pre-wrap; overflow-x: auto; padding: 0.75rem; }
table { width: 100%; border-collapse: collapse; background: white; border: 1px solid #d8e0eb; }
th, td { padding: 0.55rem 0.7rem; border-bottom: 1px solid #e5e7eb; vertical-align: top; text-align: left; }
tr.pass td:first-child { color: #15803d; font-weight: 700; }
tr.fail td:first-child { color: #b91c1c; font-weight: 700; }
tr.skip td:first-child { color: #64748b; font-weight: 700; }
.result-pass { color: #15803d; }
.result-fail { color: #b91c1c; }
a { color: #1d4ed8; }
</style>
</head>
<body>
<h1>WISC fast unit test report</h1>
<p class="meta">Generated ${escapeHtml(generatedAtIso)} from <code>${escapeHtml(commandText)}</code>.</p>
<p class="${result.status === 0 ? "result-pass" : "result-fail"}"><strong>Exit code: ${result.status}</strong></p>
<div class="summary">
${["tests", "pass", "fail", "cancelled", "skipped", "todo", "duration_ms"].map((key) => `
<div class="card"><span>${escapeHtml(key)}</span><strong>${escapeHtml(key === "duration_ms" ? formatMs(totals[key]) : totals[key] ?? "n/a")}</strong></div>`).join("\n")}
</div>
<p>Slow reports and optional Astropy/full-suite tests are intentionally not enabled here. This report mirrors the fast CI command.</p>
<p><a href="${rawPath}">Raw output</a> · <a href="${summaryJsonPath}">Summary JSON</a></p>
<table>
<thead><tr><th>Status</th><th>Test</th><th>Duration</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</body>
</html>
`;
}

function main() {
    fs.mkdirSync(OUT_DIR, {recursive: true});
    const generatedAtIso = new Date().toISOString();
    const command = ["node", "--test", ...fastTestFiles()];
    const result = childProcess.spawnSync(command[0], command.slice(1), {
        cwd: ROOT,
        encoding: "utf8",
        env: {
            ...process.env,
            AIDA_FULL_TESTS: "",
            AIDA_ASTROPY_TESTS: "",
            AIDA_SENSITIVITY_TESTS: "",
        },
    });
    const output = `${result.stdout || ""}${result.stderr || ""}`;
    const parsed = parseTestOutput(output);
    const summary = {
        generatedAt: generatedAtIso,
        command: command.join(" "),
        exitCode: result.status,
        signal: result.signal,
        summary: parsed.summary,
        tests: parsed.tests,
    };
    fs.writeFileSync(path.join(OUT_DIR, "raw-output.txt"), output);
    fs.writeFileSync(path.join(OUT_DIR, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    fs.writeFileSync(path.join(OUT_DIR, "index.html"), renderReport({
        result,
        parsed,
        generatedAtIso,
        commandText: command.join(" "),
    }));
    console.log(`Fast unit test report: ${path.join(OUT_DIR, "index.html")}`);
    console.log(`Exit code: ${result.status}`);
    process.exitCode = result.status || 0;
}

if (require.main === module) {
    main();
}
