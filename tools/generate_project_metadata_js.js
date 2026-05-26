#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const metadata = JSON.parse(fs.readFileSync(path.join(ROOT, "project_metadata.json"), "utf8"));
const outFile = path.join(ROOT, "js", "project_metadata.js");

const source = `(function () {
    "use strict";

    window.WISC_PROJECT_METADATA = ${JSON.stringify(metadata, null, 8).replace(/^/gm, "    ").trimStart()};
})();
`;

fs.writeFileSync(outFile, source, "utf8");
console.log(`Generated ${path.relative(ROOT, outFile)} from project_metadata.json`);
