// Preserve the actual original GUI; test its Rust engine and phone gear drawer.
const {chromium}=require('playwright');
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),fixture='BACC_NYA_20200218_010731';
(async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'wisc-original-gui-'));
 const saved=JSON.parse(await fs.readFile(path.join(root,'test_cases',fixture,'case.json'),'utf8')).testCase;
 let browser,server;
 try {
  const source=await fs.readFile(path.join(root,'index.html'),'utf8');
  const built=await fs.readFile(path.join(root,'web/index.html'),'utf8');
  assert.equal(built,source.replace(/<script src="js\/app\.js[^\"]*"><\/script>/,'<script type="module" src="js/start_rust_app.js"></script>'),'The production GUI must be the original HTML, not a replacement layout');
  assert.deepEqual(await fs.readFile(path.join(root,'web/style.css')),await fs.readFile(path.join(root,'style.css')),'Use the original stylesheet byte-for-byte');
  server=http.createServer(async(req,res)=>{
   try {
    res.setHeader('Cache-Control','no-store');
    if(req.url==='/api/test-cases'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify([{id:fixture,title:'Local BACC fixture'}]));return;}
    if(req.url===`/api/test-cases/${fixture}`){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({testCase:saved,imageUrl:`/test_cases/${fixture}/${saved.image}`}));return;}
    const file=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));if(!file.startsWith(root+path.sep))throw Error('path');
    res.setHeader('Content-Type',({'.js':'text/javascript','.wasm':'application/wasm','.html':'text/html','.css':'text/css','.json':'application/json','.png':'image/png'})[path.extname(file)]||'application/octet-stream');res.end(await fs.readFile(file));
   }catch{res.writeHead(404);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}/web/index.html?tc=${fixture}`;
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,args:['--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.route(/https:\/\/(cdn\.jsdelivr\.net|unpkg\.com)\//,route=>route.fulfill({status:200,contentType:'text/javascript',body:''}));
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(()=>document.body.dataset.calibrationEngine==='rust' && document.querySelector('#status').textContent.includes('BACC'),{timeout:60000});
  await page.waitForFunction(()=>!document.querySelector('#loadingOverlay').classList.contains('visible'));
  assert.equal(await page.locator('#settingsToggle').isVisible(),false);
  assert.equal(await page.locator('#settingsPanel').isVisible(),true);
  const appearance=await page.evaluate(()=>({font:getComputedStyle(document.body).fontFamily,card:getComputedStyle(document.querySelector('.controls section')).backgroundColor,overflow:document.documentElement.scrollWidth>innerWidth}));
  assert.match(appearance.font,/system-ui/);assert.equal(appearance.card,'rgb(255, 255, 255)');assert.equal(appearance.overflow,false);
  await page.evaluate(()=>{const engine=window.WiscRustEngine;window.WiscRustEngine={...engine,fit:(job,method,iterations)=>{const result=engine.fit(job,method,iterations);window.__rustFit={job,method,iterations,result};return result;}};});
  await page.click('#fitLensLm');
  await page.waitForFunction(()=>window.__rustFit && document.querySelector('#status').textContent.includes('shared Rust engine'));
  await page.waitForFunction(()=>!document.querySelector('#loadingOverlay').classList.contains('visible'));
  const fit=await page.evaluate(()=>window.__rustFit);assert.equal(fit.method,'lm');assert.ok(fit.job.pairs.length>=4);
  const input=path.join(temp,'job.json'),output=path.join(temp,'native.json');await fs.writeFile(input,JSON.stringify(fit.job));
  execFileSync(process.env.WISC_NATIVE||path.join(root,'target/release/wisc'),['fit',input,'--lm','--max-iterations',String(fit.iterations),'--output',output]);
  const native=JSON.parse(await fs.readFile(output,'utf8'));
  assert.ok(Math.abs(native.rms_px-fit.result.rms_px)<1e-7,'The original GUI uses the same fitter as the Rust-only CLI');
  await page.click('#toggleFitResiduals');assert.equal(await page.locator('#residualHistogram canvas').count(),1,'Rustplotlib renders inside the original residual panel');
  const reports=path.join(root,'test-report/rust-migration');await fs.mkdir(reports,{recursive:true});
  await page.locator('#settingsPanel').evaluate(el=>el.scrollTop=0);
  await page.screenshot({path:path.join(reports,'original-gui-desktop.png')});
  const phone=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2});
  await phone.route(/https:\/\/(cdn\.jsdelivr\.net|unpkg\.com)\//,route=>route.fulfill({status:200,contentType:'text/javascript',body:''}));
  const mobile=await phone.newPage();mobile.on('pageerror',e=>errors.push(e.message));await mobile.goto(url);
  await mobile.waitForFunction(()=>document.body.dataset.calibrationEngine==='rust' && document.querySelector('#status').textContent.includes('BACC'),{timeout:60000});
  await mobile.waitForFunction(()=>!document.querySelector('#loadingOverlay').classList.contains('visible'));
  assert.equal(await mobile.locator('#settingsToggle').isVisible(),true);assert.equal(await mobile.locator('#settingsPanel').isVisible(),false);
  assert.equal(await mobile.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'No horizontal page overflow');
  const viewer=await mobile.locator('#viewerPanel').boundingBox();assert.ok(viewer.width>=374 && viewer.height>650,'The viewer occupies the phone instead of a stacked settings panel');
  await mobile.screenshot({path:path.join(reports,'original-gui-phone.png')});
  await mobile.tap('#settingsToggle');assert.equal(await mobile.getAttribute('#settingsToggle','aria-expanded'),'true');assert.equal(await mobile.locator('#settingsPanel').isVisible(),true);
  assert.equal(await mobile.getAttribute('#settingsPanel','aria-modal'),'true');
  const button=await mobile.locator('#settingsClose').boundingBox();assert.ok(button.height>=44);
  await mobile.screenshot({path:path.join(reports,'original-gui-phone-settings.png')});
  await mobile.tap('#settingsClose');assert.equal(await mobile.locator('#settingsPanel').isVisible(),false);
  await mobile.tap('#settingsToggle');await mobile.keyboard.press('Escape');assert.equal(await mobile.locator('#settingsPanel').isVisible(),false);
  await mobile.tap('#settingsToggle');await mobile.tap('#phonePickStar');assert.equal(await mobile.locator('#settingsPanel').isVisible(),false);
  const points=await mobile.evaluate(saved=>{
    const canvas=document.querySelector('#glCanvas'),rect=canvas.getBoundingClientRect();
    const viewport=WiscViewZoom.imageViewport(canvas.width,canvas.height,saved.width,saved.height,1);
    const screen=(x,y)=>({x:rect.left+(viewport.x+(x+.5)*viewport.scale)*rect.width/canvas.width,y:rect.top+(viewport.y+(y+.5)*viewport.scale)*rect.height/canvas.height});
    const first=saved.matches[0],p=AidaTools.cameraModel(first.catalog.az,first.catalog.ze,saved.optpar.slice(1),saved.optpar[0],saved.width,saved.height);
    return {image:screen(first.image.x,first.image.y),catalogue:screen(p.x,p.y)};
  },saved);
  await mobile.touchscreen.tap(points.image.x,points.image.y);
  await mobile.waitForFunction(()=>document.querySelector('#status').textContent.includes('(select catalog star)'));
  await mobile.touchscreen.tap(points.catalogue.x,points.catalogue.y);
  await mobile.waitForFunction(()=>/updated paired star|paired star \d/.test(document.querySelector('#status').textContent));
  const pairsBefore=(await mobile.textContent('#status')).match(/matched star pairs: (\d+)/)[1];
  const touch=await phone.newCDPSession(mobile),bounds=await mobile.locator('#glCanvas').boundingBox();
  const y=bounds.y+bounds.height/2,x=bounds.x+bounds.width/2;
  await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:x-40,y},{x:x+40,y}]});
  await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-80,y},{x:x+80,y}]});
  await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  assert.notEqual((await mobile.textContent('#viewZoomValue')).trim(),'1.0×','Two-finger pinch zooms the original viewer');
  assert.equal((await mobile.textContent('#status')).match(/matched star pairs: (\d+)/)[1],pairsBefore,'Pinching must not add pairings');
  await mobile.tap('#settingsToggle');await mobile.tap('#phonePan');
  await mobile.setViewportSize({width:844,height:390});assert.equal(await mobile.locator('#settingsToggle').isVisible(),true,'Phone landscape keeps the gear drawer');
  assert.deepEqual(errors,[]);
  console.log('Original GUI acceptance passed: original HTML/CSS, Rust-native/WASM fit agreement, Rustplotlib residual panel, 390px phone full viewer, gear drawer, touch targets, Escape/focus, landscape.');
 } finally {if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));await fs.rm(temp,{recursive:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
