// Build the exact existing GUI, changing only its engine bootstrap.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const web=path.join(root,'web');
let html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const original=/<script src="js\/app\.js[^\"]*"><\/script>/;
if(!original.test(html))throw Error('Original GUI app script not found; refusing to substitute a different layout');
html=html.replace(original,'<script type="module" src="js/start_rust_app.js"></script>');
fs.writeFileSync(path.join(web,'index.html'),html);
for(const name of ['style.css','phone.css','js','data'])fs.cpSync(path.join(root,name),path.join(web,name),{recursive:true});
fs.mkdirSync(path.join(web,'calibration_images'),{recursive:true});
fs.copyFileSync(path.join(root,'calibration_images/IMG_0180.png'),path.join(web,'calibration_images/IMG_0180.png'));
console.log('Built original WISC GUI with shared Rust engine and phone gear drawer');
