#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const README = path.join(ROOT, "README.md");
const HELP = path.join(ROOT, "help.html");

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function inlineMarkdown(text) {
    let out = escapeHtml(text);
    out = out.replace(/\[!\[([^\]]*)\]\(([^)]+)\)\]\(([^)]+)\)/g, (_m, alt, src, href) =>
        `<a href="${escapeHtml(href)}"><img alt="${escapeHtml(alt)}" src="${escapeHtml(src)}"></a>`);
    out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, src) =>
        `<img alt="${escapeHtml(alt)}" src="${escapeHtml(src)}">`);
    out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) =>
        `<a href="${escapeHtml(href)}">${label}</a>`);
    return out;
}

function isTableStart(lines, index) {
    return index + 1 < lines.length &&
        /^\s*\|.*\|\s*$/.test(lines[index]) &&
        /^\s*\|?[\s:-]+\|[\s|:-]*\|?\s*$/.test(lines[index + 1]);
}

function splitTableRow(line) {
    return line.trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map(cell => cell.trim());
}

function renderTable(lines, start) {
    const rows = [];
    let index = start;
    while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
    }
    const header = rows[0] || [];
    const body = rows.slice(2);
    const html = [
        "<table>",
        "<thead><tr>",
        ...header.map(cell => `<th>${inlineMarkdown(cell)}</th>`),
        "</tr></thead>",
        "<tbody>",
        ...body.map(row => `<tr>${row.map(cell => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`),
        "</tbody>",
        "</table>",
    ].join("\n");
    return {html, index};
}

function renderMarkdown(markdown) {
    const rawLines = markdown.replace(/\r\n/g, "\n").split("\n");
    const lines = [];
    let inFence = false;
    let inMathBlock = false;
    for (const line of rawLines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("```")) {
            inFence = !inFence;
            lines.push(line);
            continue;
        }
        if (trimmed === "$$") {
            inMathBlock = !inMathBlock;
            lines.push(line);
            continue;
        }
        if (!inFence && !inMathBlock && /^\s+\S/.test(line) && lines.length > 0) {
            const previous = lines[lines.length - 1];
            if (/^\s*(?:[-*]|\d+\.)\s+/.test(previous)) {
                lines[lines.length - 1] = `${previous} ${trimmed}`;
                continue;
            }
        }
        lines.push(line);
    }
    const html = [];
    let paragraph = [];
    let listType = null;
    let inCode = false;
    let codeLang = "";
    let codeLines = [];
    let inMath = false;
    let mathLines = [];

    function flushParagraph() {
        if (!paragraph.length) {
            return;
        }
        html.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
        paragraph = [];
    }

    function closeList() {
        if (listType) {
            html.push(`</${listType}>`);
            listType = null;
        }
    }

    function openList(type) {
        if (listType !== type) {
            closeList();
            html.push(`<${type}>`);
            listType = type;
        }
    }

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const trimmed = line.trim();

        if (inCode) {
            if (trimmed.startsWith("```")) {
                html.push(`<pre><code${codeLang ? ` class="language-${escapeHtml(codeLang)}"` : ""}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
                inCode = false;
                codeLang = "";
                codeLines = [];
            } else {
                codeLines.push(line);
            }
            continue;
        }

        if (inMath) {
            mathLines.push(line);
            if (trimmed === "$$") {
                html.push(`<div class="math-block">${escapeHtml(mathLines.join("\n"))}</div>`);
                inMath = false;
                mathLines = [];
            }
            continue;
        }

        if (trimmed.startsWith("```")) {
            flushParagraph();
            closeList();
            inCode = true;
            codeLang = trimmed.replace(/^```/, "").trim();
            codeLines = [];
            continue;
        }

        if (trimmed === "$$") {
            flushParagraph();
            closeList();
            inMath = true;
            mathLines = [line];
            continue;
        }

        if (isTableStart(lines, i)) {
            flushParagraph();
            closeList();
            const table = renderTable(lines, i);
            html.push(table.html);
            i = table.index - 1;
            continue;
        }

        if (trimmed === "") {
            flushParagraph();
            closeList();
            continue;
        }

        const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
        if (heading) {
            flushParagraph();
            closeList();
            const level = heading[1].length;
            html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
            continue;
        }

        const ordered = /^\d+\.\s+(.+)$/.exec(trimmed);
        if (ordered) {
            flushParagraph();
            openList("ol");
            html.push(`<li>${inlineMarkdown(ordered[1])}</li>`);
            continue;
        }

        const unordered = /^[-*]\s+(.+)$/.exec(trimmed);
        if (unordered) {
            flushParagraph();
            openList("ul");
            html.push(`<li>${inlineMarkdown(unordered[1])}</li>`);
            continue;
        }

        paragraph.push(trimmed);
    }
    flushParagraph();
    closeList();
    return html.join("\n");
}

function pageHtml(body) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WISC Help</title>
<style>
    body { margin: 0; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111827; background: #f8fafc; line-height: 1.55; }
    main { max-width: 980px; margin: 0 auto; padding: 28px 18px 42px; }
    h1 { margin: 0 0 10px; font-size: 30px; line-height: 1.15; }
    h2 { margin: 30px 0 8px; font-size: 20px; }
    h3 { margin: 22px 0 8px; font-size: 17px; }
    p { margin: 0 0 12px; }
    a { color: #1d4ed8; }
    code, kbd { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    code { font-size: 0.95em; background: #eef2ff; padding: 1px 4px; border-radius: 4px; }
    pre { overflow-x: auto; padding: 12px; border: 1px solid #dbeafe; border-radius: 6px; background: #0f172a; color: #e5e7eb; }
    pre code { background: transparent; color: inherit; padding: 0; }
    table { border-collapse: collapse; width: 100%; margin: 14px 0; background: #fff; }
    th, td { border: 1px solid #d1d5db; padding: 8px 10px; vertical-align: top; }
    th { background: #e0f2fe; text-align: left; }
    img { max-width: 100%; height: auto; border-radius: 6px; }
    .generated { margin: 0 0 18px; color: #4b5563; font-size: 13px; font-weight: 650; }
    .math-block { overflow-x: auto; margin: 12px 0; padding: 8px 0; }
    .back-link { margin-top: 26px; }
</style>
<script>
window.MathJax = {
    tex: {inlineMath: [["\\\\(", "\\\\)"], ["$", "$"]]},
    startup: {typeset: true}
};
</script>
<script defer src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js"></script>
</head>
<body>
<main>
<p class="generated">Generated from <code>README.md</code>. Edit the README and run <code>npm run help:generate</code> to update this page.</p>
${body}
<p class="back-link"><a href="index.html">Back to the calibrator</a></p>
</main>
</body>
</html>
`;
}

const markdown = fs.readFileSync(README, "utf8");
fs.writeFileSync(HELP, pageHtml(renderMarkdown(markdown)));
console.log(`Generated ${path.relative(ROOT, HELP)} from ${path.relative(ROOT, README)}`);
