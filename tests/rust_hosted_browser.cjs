// End-to-end Rust frontend + real Axum API. All writes stay in a temporary
// local fixture directory; this test never submits to a production server.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const fixture='BACC_NYA_20200218_010731';
const listen=s=>new Promise(resolve=>s.listen(0,'127.0.0.1',()=>resolve(s.address().port)));
const close=s=>new Promise(resolve=>s.close(resolve));
const mime={'.js':'text/javascript','.html':'text/html','.wasm':'application/wasm','.css':'text/css'};
(async()=>{
 const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'wisc-hosted-'));
 let child,browser,staticServer;
 try {
  const data=path.join(temporary,'cases'),directory=path.join(data,fixture);
  await fs.mkdir(directory,{recursive:true});
  const saved=JSON.parse(await fs.readFile(path.join(root,'test_cases',fixture,'case.json'),'utf8')).testCase;
  await fs.writeFile(path.join(directory,'metadata.json'),JSON.stringify(saved));
  const imagePath=path.join(directory,saved.image);
  await fs.copyFile(path.join(root,'test_cases',fixture,saved.image),imagePath);
  const reservation=http.createServer(),apiPort=await listen(reservation);await close(reservation);
  child=spawn(process.env.WISC_SERVER||path.join(root,'target/debug/aida-calibrator-server'),['--host','127.0.0.1','--port',String(apiPort),'--test-case-dir',data,'--submit-passkey','local-test-key'],{stdio:['ignore','pipe','pipe']});
  let output='';child.stderr.on('data',chunk=>output+=chunk);child.on('error',error=>output+=error.message);
  let ready=false;
  for(let i=0;i<200;i++) {
   try {if((await fetch(`http://127.0.0.1:${apiPort}/healthz`)).ok){ready=true;break;}} catch{}
   if(child.exitCode!==null)break;
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.ok(ready,output||'Rust API did not start');
  staticServer=http.createServer(async(req,res)=>{
   if(req.url.startsWith('/api/')) {
    // Buffer this small fixture request. A streaming Node http.request proxy
    // can surface EPIPE before delivering Rust's deliberately early 403 when
    // a wrong passkey is rejected while image bytes are still arriving.
    try {
     const chunks=[];for await(const chunk of req)chunks.push(chunk);
     const headers={...req.headers};for(const key of ['host','connection','content-length','transfer-encoding'])delete headers[key];
     const upstream=await fetch(`http://127.0.0.1:${apiPort}${req.url}`,{method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(chunks)});
     res.writeHead(upstream.status,Object.fromEntries(upstream.headers));res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch(error) {res.writeHead(502,{'Content-Type':'application/json'});res.end(JSON.stringify({error:`proxy: ${error.message}; Rust exit=${child.exitCode}; ${output}`}));}
    return;
   }
   try {
    const requested=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    const file=path.resolve(root,'.'+requested);
    if(!file.startsWith(root+path.sep))throw Error('invalid path');
    res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(await fs.readFile(file));
   } catch{res.writeHead(404);res.end();}
  });
  const port=await listen(staticServer),url=`http://127.0.0.1:${port}/tests/fixtures/rust_ui_harness.html`;
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,args:['--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
  await page.goto(`${url}?case=${fixture}`);
  await page.waitForFunction(()=>document.querySelector('#hostedStatus').textContent.startsWith('Loaded '));
  const readJob=async()=>JSON.parse(await page.inputValue('#fitJob'));
  const job=await readJob();assert.equal(job.pairs.length,50);
  assert.equal(await page.inputValue('#altitude'),'10');assert.equal(await page.inputValue('#magnitude'),'4.3');
  await page.locator('#brightness').evaluate(el=>{el.value='0.25';el.dispatchEvent(new Event('change'));});
  await page.check('#maskMode');const canvas=page.locator('#glCanvas');const bounds=await canvas.boundingBox();await canvas.click({position:{x:bounds.width/2,y:bounds.height/2}});await page.uncheck('#maskMode');
  const [download]=await Promise.all([page.waitForEvent('download'),page.click('#downloadSession')]);
  const sessionPath=path.join(temporary,'session.json');await download.saveAs(sessionPath);
  const session=JSON.parse(await fs.readFile(sessionPath,'utf8'));
  assert.equal(session.masked_tiles.length,1);assert.equal(session.job.pairs.length,50);
  assert.equal(session.metadata.matches[0].catalog.name,saved.matches[0].catalog.name);
  assert.equal(session.display.altitude,10);assert.equal(session.image_sha256.length,64);
  await page.goto(url);await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('to begin'));
  await page.setInputFiles('#imageFile',imagePath);await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Loaded'));
  assert.equal((await readJob()).pairs.length,0);
  await page.click('#restoreSession');assert.equal((await readJob()).pairs.length,50);
  assert.match(await page.textContent('#viewStatus'),/1 masked tiles/);assert.equal(await page.inputValue('#brightness'),'0.25');
  const wrong=path.join(temporary,'wrong-image-session.json');
  await fs.writeFile(wrong,JSON.stringify({...session,image_sha256:'f'.repeat(64)}));
  await page.setInputFiles('#jobFile',wrong);await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('different image'));
  assert.deepEqual((await readJob()).pairs,job.pairs);
  const panel=page.locator('details').last();await panel.evaluate(el=>{el.open=true;});
  await page.click('#reloadCases');await page.waitForFunction(()=>document.querySelector('#hostedStatus').textContent.includes('saved test cases available'));
  await page.fill('#caseId','local-browser-copy');await page.fill('#caseTitle','Rust browser round-trip');
  await page.fill('#submitPasskey','wrong');await page.click('#submitHosted');
  await page.waitForFunction(()=>document.querySelector('#hostedStatus').textContent.includes('invalid submit pass key')).catch(async error=>{throw new Error(`${error.message}; hosted=${await page.textContent('#hostedStatus')}; status=${await page.textContent('#status')}`);});
  await assert.rejects(fs.access(path.join(data,'local-browser-copy')));
  await page.fill('#submitPasskey','local-test-key');await page.click('#submitHosted');
  await page.waitForFunction(()=>document.querySelector('#hostedStatus').textContent.startsWith('Saved local-browser-copy'));
  assert.equal(await page.inputValue('#submitPasskey'),'');
  const stored=JSON.parse(await fs.readFile(path.join(data,'local-browser-copy/metadata.json'),'utf8'));
  assert.equal(stored.matches.length,50);assert.equal(stored.altM,10);assert.equal(stored.rustMaskedTiles.length,1);
  assert.equal(stored.matches[0].catalog.name,saved.matches[0].catalog.name);
  assert.deepEqual(await fs.readFile(path.join(data,'local-browser-copy',stored.image)),await fs.readFile(imagePath));
  const share=await page.inputValue('#shareLink');assert.match(share,/\?case=local-browser-copy$/);
  await page.goto(share);await page.waitForFunction(()=>document.querySelector('#hostedStatus').textContent.startsWith('Loaded local-browser-copy'));
  assert.deepEqual((await readJob()).pairs,job.pairs);assert.match(await page.textContent('#viewStatus'),/1 masked tiles/);
  // Bad display data must not partially restore a session or mutate the job.
  const invalid=path.join(temporary,'invalid-display.json');
  await fs.writeFile(invalid,JSON.stringify({...session,display:{...session.display,highPassSigma:1e9}}));
  await page.setInputFiles('#jobFile',invalid);
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('invalid session display'));
  assert.deepEqual((await readJob()).pairs,job.pairs);
  await page.click('#fitPairsLm');
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('RMS'));
  const fitted=await readJob();
  const [report]=await Promise.all([page.waitForEvent('download'),page.click('#downloadReport')]);
  const reportPath=path.join(temporary,'report.zip');await report.saveAs(reportPath);
  assert.ok((await fs.stat(reportPath)).size>10000);
  await page.click('#clearPairs');assert.equal((await readJob()).pairs.length,0);
  await page.setInputFiles('#jobFile',reportPath);
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Restored image-verified'));
  assert.deepEqual((await readJob()).pairs,fitted.pairs);
  assert.deepEqual((await readJob()).initial,fitted.initial);
  assert.equal(await page.inputValue('#altitude'),'10');
  assert.deepEqual(errors,[]);
  console.log('Rust hosted/session/report acceptance passed: real Axum load/save, auth failure, share link, altitude, names, masks, autosave, SHA-256 image binding, invalid display rejection, Rustplotlib report ZIP export/import, unchanged original image.');
 } finally {
  if(browser)await browser.close();if(staticServer)await close(staticServer);
  if(child&&child.exitCode===null){const ended=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await ended;}
  await fs.rm(temporary,{recursive:true});
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
