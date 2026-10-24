// Real Chromium/WebGL acceptance checks for the Rust replacement, not the
// compatibility JavaScript UI. Build with scripts/build_web.sh first.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {execFileSync} = require('node:child_process');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const mime = {'.html':'text/html','.js':'text/javascript','.wasm':'application/wasm','.css':'text/css'};
const server = http.createServer(async (request, response) => {
  try {
    const requested = decodeURIComponent(new URL(request.url,'http://localhost').pathname);
    const file = path.resolve(root, '.' + requested);
    if (!file.startsWith(root+path.sep)) throw Error('invalid path');
    response.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
    response.end(await fs.readFile(file));
  } catch { response.writeHead(404); response.end(); }
});
(async () => {
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  let browser;
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'wisc-rust-browser-'));
  try {
    const reference={window:{},console,ArrayBuffer,DataView,Float32Array,Math,Uint8Array,Date,Number,Array,TextDecoder};
    vm.runInNewContext(await fs.readFile(path.join(root,'js/aidatools.js'),'utf8'),reference);
    const legacyProjection=reference.window.AidaTools;
    browser = await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,args:['--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
    const page = await browser.newPage({viewport:{width:1440,height:1000}});
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/web/index.html`);
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('to begin'));
    const casePath=path.join(root,'test_cases/BACC_NYA_20200218_010731/case.json');
    const directory=path.dirname(casePath);
    const files=await fs.readdir(directory);
    const image=files.find(name=>/\.(png|jpe?g)$/i.test(name));
    assert.ok(image,'BACC image fixture');
    await page.setInputFiles('#imageFile',path.join(directory,image));
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Loaded'));
    await page.setInputFiles('#jobFile',casePath);
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Imported'));
    await page.click('#fitPairs');
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Fit complete'));
    const nmJob=JSON.parse(await page.inputValue('#fitJob'));
    await page.click('#fitPairsLm');
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Fit complete'));
    const readJob=async()=>JSON.parse(await page.inputValue('#fitJob'));
    const fitted=await readJob();
    const native=process.env.WISC_NATIVE || path.join(root,'target/release/wisc');
    const nativeInput=path.join(temporary,'lm-input.json'),nativeOutput=path.join(temporary,'lm-output.json');
    await fs.writeFile(nativeInput,JSON.stringify(nmJob));
    execFileSync(native,['fit',nativeInput,'--lm','--max-iterations','200','--output',nativeOutput]);
    const nativeResult=JSON.parse(await fs.readFile(nativeOutput,'utf8'));
    assert.ok(nativeResult.rms_px<1.4,'native real-case LM fit');
    for(const pair of fitted.pairs) {
      const project=cal=>legacyProjection.cameraModel(pair.azimuth_rad,pair.zenith_rad,cal.optpar,cal.model,cal.width,cal.height);
      const a=project(fitted.initial),b=project(nativeResult.calibration);
      assert.ok(Math.hypot(a.x-b.x,a.y-b.y)<1e-5,'native/WASM LM projections agree within 0.00001 pixel');
    }
    const canvas=page.locator('#glCanvas');
    const bounds=await canvas.boundingBox();
    const center={x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2};
    await page.mouse.move(center.x,center.y);
    await page.mouse.wheel(0,-600);
    await page.waitForFunction(()=>!document.querySelector('#viewStatus').textContent.includes('Zoom 1.00'));
    await page.mouse.down(); await page.mouse.move(center.x+60,center.y+20,{steps:6}); await page.mouse.up();
    assert.deepEqual((await readJob()).pairs,fitted.pairs,'panning must not add a pair');
    await page.click('#resetView');
    assert.match(await page.textContent('#viewStatus'),/Zoom 1.00×/);
    const original=await canvas.screenshot();
    await page.check('#showGrid'); await page.check('#showResiduals');
    assert.notDeepEqual(await canvas.screenshot(),original,'scientific overlays change the rendered image');
    await page.uncheck('#showGrid'); await page.uncheck('#showResiduals');
    await page.locator('#brightness').evaluate(input=>{input.value='0.3';input.dispatchEvent(new Event('input'));});
    assert.notDeepEqual(await canvas.screenshot(),original,'brightness changes display');
    assert.deepEqual((await readJob()).pairs,fitted.pairs,'display controls must not alter measured coordinates');
    await page.check('#highPass');
    await page.uncheck('#highPass');
    await page.check('#maskMode');
    await canvas.click({position:{x:bounds.width/2,y:bounds.height/2}});
    assert.match(await page.textContent('#viewStatus'),/1 masked tiles/);
    await page.click('#clearMask');
    assert.match(await page.textContent('#viewStatus'),/0 masked tiles/);
    await page.uncheck('#maskMode');
    await page.locator('#catalogStar').selectOption({index:0});
    const first=fitted.pairs[0];
    await canvas.click({position:{x:(first.x_px+0.5)*bounds.width/fitted.initial.width,y:(first.y_px+0.5)*bounds.height/fitted.initial.height}});
    await page.waitForFunction(()=>document.querySelector('#densityInfo').textContent.includes('40× KDE:'));
    await page.click('#undo');
    assert.deepEqual((await readJob()).pairs,fitted.pairs,'undo restores exact scientific pairs');
    const [download]=await Promise.all([page.waitForEvent('download'),page.click('#downloadHdf5')]);
    assert.equal(download.suggestedFilename(),'calibration.h5');
    await page.locator('details').first().evaluate(details=>{details.open=true;});
    const reports=path.join(root,'test-report/rust-migration');
    await fs.mkdir(reports,{recursive:true});
    await page.screenshot({path:path.join(reports,'rust-web-inspection.png'),fullPage:true});
    assert.deepEqual(errors,[]);
    console.log(`Rust/WASM browser acceptance passed: ${fitted.initial.width}×${fitted.initial.height}, ${fitted.pairs.length} pairs; NM/LM fit, zoom/pan, overlays, display, masks, KDE, undo, HDF5.`);
  } finally {
    if(browser) await browser.close();
    await fs.rm(temporary,{recursive:true});
    await new Promise(resolve=>server.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
