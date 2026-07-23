#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const [aliasArg, targetArg] = process.argv.slice(2);

function usage() {
    console.error("Usage: node tools/create_quick_link.js <short-name> <test-case-id>");
    console.error("Example: node tools/create_quick_link.js tc01 IMG_9953");
}

function safeCaseId(value) {
    return String(value || "")
        .replace(/\.[^.]*$/, "")
        .replace(/[^A-Za-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

if (!aliasArg || !targetArg) {
    usage();
    process.exit(2);
}

const alias = safeCaseId(aliasArg);
const target = safeCaseId(targetArg);
if (!alias || alias !== aliasArg || !target || target !== targetArg) {
    console.error("error: use only letters, numbers, underscore, and dash in names");
    process.exit(2);
}

const linksPath = path.join(repoRoot, "quick_links.json");
let links = {};
if (fs.existsSync(linksPath)) {
    links = JSON.parse(fs.readFileSync(linksPath, "utf8"));
}
links[alias] = target;
fs.writeFileSync(linksPath, `${JSON.stringify(links, null, 2)}\n`);

const linkDir = path.join(repoRoot, alias);
fs.mkdirSync(linkDir, {recursive: true});
fs.writeFileSync(path.join(linkDir, "index.html"), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="0; url=../?tc=${alias}">
<title>WISC ${alias}</title>
</head>
<body>
<script>
location.replace("../?tc=${alias}");
</script>
<p><a href="../?tc=${alias}">Open WISC test case ${alias}</a></p>
</body>
</html>
`);

console.log(`${alias} -> ${target}`);
console.log(`After deploy: https://juha.no/aida/${alias}`);
