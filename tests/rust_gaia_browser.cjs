// Local GAIA protocol fixtures only: no request is sent to a real GAIA server.
const {chromium}=require('playwright');
const assert=require('node:assert/strict'), http=require('node:http'), fs=require('node:fs/promises'), path=require('node:path'), os=require('node:os');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'), fixture='BACC_NYA_20200218_010731';
(async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'wisc-gaia-'));
 const saved=JSON.parse(await fs.readFile(path.join(root,'test_cases',fixture,'case.json'),'utf8')).testCase;
 const image=await fs.readFile(path.join(root,'test_cases',fixture,saved.image));
 const proposal={optmod:saved.optpar[0],optpar:saved.optpar.slice(1),matches:saved.matches.map(m=>({image_x:m.image.x,image_y:m.image.y,ra_hours:m.catalog.raHours,dec_deg:m.catalog.decDeg,mag:m.catalog.mag,azimuth_deg:m.catalog.az*180/Math.PI,zenith_deg:m.catalog.ze*180/Math.PI,star_key:m.catalog.name}))};
 const settings={crop:{left:0.05,right:0.95,top:0,bottom:1},mask:{coordinate_system:'normalized_image',polygons:[[[0.1,0.1],[0.2,0.1],[0.2,0.2],[0.1,0.2]]]}};
 const uploads=[];let browser,server;
 try {
  server=http.createServer(async(req,res)=>{
   try {
    if(req.url.startsWith('/gaia/api/')) {
     if(req.method==='POST') {
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const form=await new Request('http://localhost'+req.url,{method:'POST',headers:req.headers,body:Buffer.concat(chunks)}).formData();
      const file=form.get('calibration');assert.ok(file);const bytes=Buffer.from(await file.arrayBuffer());assert.equal(bytes.subarray(0,8).toString('hex'),'894844460d0a1a0a');
      uploads.push({endpoint:req.url,source:form.get('source_id'),record:form.get('record_id'),time:form.get('valid_from_utc'),count:form.get('star_count'),rms:form.get('residual_px'),bytes});
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url.includes('/events/')?{projection_error:'local fixture projection failure'}:{ok:true}));return;
     }
     if(req.url.endsWith('/settings')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(settings));return;}
     if(req.url.endsWith('/refit-proposal')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(proposal));return;}
     if(req.url.endsWith('/latest')||req.url.endsWith('/image')||req.url.endsWith('/original')) {
      res.setHeader('Content-Type','image/png');res.setHeader('X-GAIA-Observation-UTC',saved.timestampUtc);res.setHeader('X-GAIA-Latitude-Deg',String(saved.latDeg));res.setHeader('X-GAIA-Longitude-Deg',String(saved.lonDeg));res.setHeader('X-GAIA-Altitude-M','10');res.end(image);return;
     }
     throw Error('unknown GAIA endpoint');
    }
    const file=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));if(!file.startsWith(root+path.sep))throw Error('path');
    res.setHeader('Content-Type',({'.js':'text/javascript','.wasm':'application/wasm','.html':'text/html','.css':'text/css'})[path.extname(file)]||'application/octet-stream');res.end(await fs.readFile(file));
   }catch(error){res.writeHead(500);res.end(error.message);}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}/tests/fixtures/rust_ui_harness.html`;
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,args:['--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  await page.goto(url+'?gaia=1&source_id=local-camera&proposal=1');
  await page.waitForFunction(()=>document.querySelector('#gaiaStatus').textContent.startsWith('GAIA image loaded'));
  const read=async()=>JSON.parse(await page.inputValue('#fitJob'));
  let job=await read();assert.equal(job.pairs.length,50);assert.equal(job.observation.latitude_deg,saved.latDeg);assert.equal(await page.inputValue('#altitude'),'10');
  assert.ok(Math.abs(job.pairs[0].azimuth_rad-saved.matches[0].catalog.az)<1e-12,'GAIA degrees converted exactly once');
  assert.equal(uploads.length,0,'no automatic submission');
  await page.click('#fitPairsLm');await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Fit complete'));
  await page.locator('details').filter({has:page.locator('#gaiaStatus')}).evaluate(e=>e.open=true);
  await page.click('#sendGaia');await page.waitForFunction(()=>document.querySelector('#gaiaStatus').textContent==='GAIA calibration saved successfully.');
  assert.equal(uploads.length,1);assert.equal(uploads[0].source,'local-camera');assert.equal(uploads[0].count,'50');assert.ok(Number(uploads[0].rms)<1.4);
  const hdf=path.join(temp,'gaia.h5');await fs.writeFile(hdf,uploads[0].bytes);
  const native=process.env.WISC_NATIVE||path.join(root,'target/release/wisc');
  execFileSync(native,['fit',hdf,'--max-iterations','1','--output',path.join(temp,'roundtrip.json')]);
  const roundtrip=JSON.parse(await fs.readFile(path.join(temp,'roundtrip.json'),'utf8'));
  assert.deepEqual(roundtrip.session.metadata.gaiaSettings,settings);assert.equal(roundtrip.session.metadata.gaiaContext.source_id,'local-camera');
  await page.goto(url+'?gaia_event=1&event_id=20260402&record_id=local-record');
  await page.waitForFunction(()=>document.querySelector('#gaiaStatus').textContent.startsWith('GAIA image loaded'));
  assert.equal((await read()).pairs.length,0);assert.equal(uploads.length,1);
  // Copy the fitted source model/pairs into this event observation, preserving
  // its loaded event identity and masks instead of importing another session.
  job=roundtrip.session.job;
  await page.locator('details').filter({has:page.locator('#fitJob')}).evaluate(e=>e.open=true);
  await page.fill('#fitJob',JSON.stringify(job));await page.click('#fitPairsLm');
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Fit complete'));
  await page.locator('details').filter({has:page.locator('#gaiaStatus')}).evaluate(e=>e.open=true);
  await page.click('#sendGaia');await page.waitForFunction(()=>document.querySelector('#gaiaStatus').textContent.includes('projection failed'));
  assert.equal(uploads.length,2);assert.equal(uploads[1].record,'local-record');assert.equal(uploads[1].endpoint,'/gaia/api/events/20260402/calibrations');
  assert.deepEqual(errors,[]);
  console.log('Rust GAIA acceptance passed: source/event images, observation headers, crop/polygon masks, proposal degree conversion, explicit HDF5 upload, native rich-session roundtrip, projection-failure reporting.');
 }finally {if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));await fs.rm(temp,{recursive:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
