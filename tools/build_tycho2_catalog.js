#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const zlib = require("node:zlib");
const {Readable} = require("node:stream");

const ROOT = path.resolve(__dirname, "..");
const defaultInputs = [
    {
        path: path.join(ROOT, "data", "catalog.dat"),
        raIndex: 2,
        decIndex: 3,
        vtIndex: 19,
        name: "catalog.dat",
        fallbackRaIndex:24,
        fallbackDecIndex:25,
    },
    {
        path: path.join(ROOT, "data", "suppl_1.dat"),
        raIndex: 2,
        decIndex: 3,
        vtIndex: 13,
        name: "suppl_1.dat",
        epoch: 1991.25,
    },
    {
        path: path.join(ROOT, "data", "suppl_2.dat"),
        raIndex: 2,
        decIndex: 3,
        vtIndex: 13,
        name: "suppl_2.dat",
        epoch: 1991.25,
    },
];
const remote = process.argv.includes("--fetch");
const inputArgs = process.argv.slice(2).filter(arg => !["--", "--fetch"].includes(arg));
const singleArgIsInput = inputArgs.length === 1 && /\.dat$/i.test(inputArgs[0]);
const explicitInputs = singleArgIsInput ? inputArgs :
    (inputArgs.length > 1 ? inputArgs.slice(0, -1) : []);
const inputFiles = explicitInputs.length > 0 ?
    explicitInputs.map(input => ({
        path: path.resolve(input),
        raIndex: 2,
        decIndex: 3,
        vtIndex: 19,
        name: path.basename(input),
    })) :
    defaultInputs;
const outputPath = inputArgs.length > 0 && !singleArgIsInput ?
    path.resolve(inputArgs[inputArgs.length - 1]) :
    path.join(ROOT, "data", "tycho2_mag8.bin.gz");
const metaPath = outputPath.replace(/\.bin(?:\.gz)?$/i, ".json");
const maxMagnitude = Number(process.env.TYCHO2_MAX_MAG || 8);

const binaryFormat = {
    container: "gzip-compressed byte stream",
    payloadMagic: "WISCAT1\\0",
    byteOrder: "little-endian",
    integerEncoding: "unsigned 32-bit little-endian",
    floatEncoding: "IEEE-754 binary32 little-endian",
    headerBytes: 16,
    header: [
        "bytes 0..7: ASCII magic WISCAT1\\0",
        "bytes 8..11: uint32 star count",
        "bytes 12..15: uint32 float stride, currently 3",
    ],
    record: [
        "float32 right ascension in hours, ICRS/J2000",
        "float32 declination in degrees, ICRS/J2000",
        "float32 Tycho V_T magnitude",
    ],
};

function parseRow(line, input) {
    const fields = line.split("|").map(value => value.trim());
    const number = index => fields[index] === undefined || fields[index] === "" ? NaN : Number(fields[index]);
    let raDeg=number(input.raIndex),decDeg=number(input.decIndex);
    let fallback=false;
    if ((!Number.isFinite(raDeg) || !Number.isFinite(decDeg)) && input.fallbackRaIndex!==undefined) {
        raDeg=number(input.fallbackRaIndex);decDeg=number(input.fallbackDecIndex);fallback=true;
    }
    const vtMag=number(input.vtIndex);
    if (![raDeg,decDeg,vtMag].every(Number.isFinite) || raDeg<0 || raDeg>=360 || decDeg < -90 || decDeg>90 || vtMag>=maxMagnitude) return null;
    // Supplements give ICRS positions at J1991.25. Propagate their tangent
    // proper motion to J2000 without a division by cos(dec) near a pole.
    if (input.epoch === 1991.25) {
        const pmRa=number(4),pmDec=number(5);
        if (Number.isFinite(pmRa) && Number.isFinite(pmDec)) {
            const r=raDeg*Math.PI/180,d=decDeg*Math.PI/180,k=8.75*Math.PI/(180*3600000);
            const x=Math.cos(d)*Math.cos(r)+k*(-pmRa*Math.sin(r)-pmDec*Math.sin(d)*Math.cos(r));
            const y=Math.cos(d)*Math.sin(r)+k*(pmRa*Math.cos(r)-pmDec*Math.sin(d)*Math.sin(r));
            const z=Math.sin(d)+k*pmDec*Math.cos(d);
            raDeg=(Math.atan2(y,x)*180/Math.PI+360)%360;
            decDeg=Math.atan2(z,Math.hypot(x,y))*180/Math.PI;
        }
    }
    const row=[raDeg/15,decDeg,vtMag];
    Object.defineProperty(row,"observedFallback",{value:fallback});
    Object.defineProperty(row,"tycId",{value:`TYC ${fields[0].split(/\s+/).join('-')}`});
    return row;
}

async function* lines(input) {
    const parts=remote ? input.name === "catalog.dat" ? Array.from({length:20},(_,i)=>`tyc2.dat.${String(i).padStart(2,"0")}.gz`) : [`${input.name}.gz`] : [null];
    for (const part of parts) {
        let stream;
        if (part) {
            const url=`https://cdsarc.cds.unistra.fr/ftp/I/259/${part}`;
            console.log(`Streaming ${url}`);
            const response=await fetch(url,{signal:AbortSignal.timeout(120000)});
            if (!response.ok) throw Error(`Catalogue download HTTP ${response.status}: ${url}`);
            stream=Readable.fromWeb(response.body).pipe(zlib.createGunzip());
        } else {
            if (!fs.existsSync(input.path)) throw Error(`Tycho-2 input file not found: ${input.path}; use --fetch to stream CDS originals`);
            stream=fs.createReadStream(input.path);
        }
        const reader=readline.createInterface({input:stream,crlfDelay:Infinity});
        for await (const line of reader) yield line;
    }
}

async function main() {
    const stars = [];
    const stats = [];
    const seen = new Set();

    for (const input of inputFiles) {
        let read = 0;
        let accepted = 0;
        let skipped = 0;
        let duplicates = 0;
        let observedFallbacks=0;
        for await (const line of lines(input)) {
            read += 1;
            const row=parseRow(line,input);
            if (!row) {
                skipped += 1;
                continue;
            }
            const key = row.map(value=>value.toFixed(9)).join(":");
            if (seen.has(key)) {
                duplicates += 1;
                continue;
            }
            seen.add(key);
            stars.push(row);
            accepted += 1;
            if(row.observedFallback)observedFallbacks+=1;
        }

        stats.push({
            source: path.relative(ROOT, input.path),
            rightAscensionColumn: input.raIndex + 1,
            declinationColumn: input.decIndex + 1,
            vtMagnitudeColumn: input.vtIndex + 1,
            positionEpoch: "Mean J2000 preferred; supplements propagated from J1991.25 where proper motion exists; main X-flag stars retain observed ICRS positions when no mean/PM is published",
            observedPositionFallbacks:observedFallbacks,
            ...(remote?{downloadBase:"https://cdsarc.cds.unistra.fr/ftp/I/259/"}:{}),
            inputRows: read,
            acceptedRows: accepted,
            skippedRows: skipped,
            duplicateRows: duplicates,
        });
    }

    stars.sort((a, b) => a[2] - b[2] || a[0] - b[0] || a[1] - b[1]);

    const headerBytes = 16;
    const buffer = Buffer.alloc(headerBytes + stars.length * 3 * 4);
    buffer.write("WISCAT1\0", 0, "ascii");
    buffer.writeUInt32LE(stars.length, 8);
    buffer.writeUInt32LE(3, 12);
    let offset = headerBytes;
    for (const [raHours, decDeg, vtMag] of stars) {
        buffer.writeFloatLE(raHours, offset); offset += 4;
        buffer.writeFloatLE(decDeg, offset); offset += 4;
        buffer.writeFloatLE(vtMag, offset); offset += 4;
    }

    fs.mkdirSync(path.dirname(outputPath), {recursive: true});
    const compressed = /\.gz$/i.test(outputPath) ?
        zlib.gzipSync(buffer, {level: 9}) :
        buffer;
    fs.writeFileSync(outputPath, compressed);
    const identifiers=outputPath.replace(/\.bin(?:\.gz)?$/i,".ids.json.gz");
    fs.writeFileSync(identifiers,zlib.gzipSync(JSON.stringify(stars.map(row=>row.tycId)),{level:9}));
    fs.writeFileSync(metaPath, `${JSON.stringify({
        sources: stats,
        output: path.relative(ROOT, outputPath),
        selection: "merged Tycho-2 main catalogue plus supplement-1 and supplement-2, filtered to V_T < maxMagnitudeExclusive",
        format: binaryFormat,
        maxMagnitudeExclusive: maxMagnitude,
        stars: stars.length,
        uncompressedBytes: buffer.length,
        compressedBytes: compressed.length,
        generatedAtUtc: new Date().toISOString(),
    }, null, 2)}\n`);

    console.log(`Wrote ${stars.length} Tycho-2 stars to ${outputPath}`);
    console.log(`Wrote metadata to ${metaPath}`);
}

if (require.main === module) main().catch(error => {
    console.error(error);
    process.exit(1);
});
module.exports={parseRow};
