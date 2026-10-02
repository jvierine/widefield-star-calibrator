// Optional real-frame browser check. Run with Playwright on NODE_PATH and
// SMILE_URL set to a same-origin SMILE/AIDA deployment (local Vite proxy works).
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  for(const width of [1440,390]){
   const context=await browser.newContext({viewport:{width,height:1000}});
   const smile=await context.newPage(),errors=[];
   const base=process.env.SMILE_URL||'http://127.0.0.1:5184/smile/';
   await smile.route('**/uvi-auto-lens-20260724.json',async route=>{
    const response=await route.fetch(),bundle=await response.json();
    // The science bundle records the published origin; local round-trip
    // fixtures must point at the identical image on the local origin.
    for(const c of bundle.calibrations)c.image_url=new URL(new URL(c.image_url).pathname,base).href;
    await route.fulfill({json:bundle});
   });
   await smile.goto(base);
   await smile.waitForFunction(()=>window.smile,{timeout:60000});
   const popup=smile.waitForEvent('popup');await smile.click('#aida');const page=await popup;
   page.on('pageerror',e=>errors.push(e.message));
   await page.waitForSelector('#returnSpacecraft:not([hidden])',{timeout:20000}).catch(async e=>{
    console.error({url:page.url(),errors,status:await page.locator('#status').textContent(),spacecraft:await page.locator('#spacecraftStatus').textContent()});throw e;
   });
   await page.waitForFunction(()=>!document.getElementById('loadingOverlay').classList.contains('visible'));
   if(await page.locator('#starPickingLegendClose').isVisible())await page.click('#starPickingLegendClose');
   assert.equal(await page.inputValue('#optmod'),'20');
   await page.selectOption('#starCatalog','td1');
   await page.waitForFunction(()=>document.getElementById('status').textContent.includes('17762 stars'));
   assert.equal(await page.getAttribute('#maxMag','max'),'13');
   await page.locator('#maxMag').evaluate(el=>{el.value='13';el.dispatchEvent(new Event('input'));});
   assert.equal(await page.inputValue('#maxMag'),'13');
   assert.equal(await page.textContent('#magValue'),'13.0');
   const parameters=()=>page.locator('#optmod,#fScaleX,#fScaleY,#rotAlpha,#rotBeta,#rotGamma,#du,#dv,#k1,#k2,#p1,#p2').evaluateAll(els=>els.map(e=>[e.id,e.value]));
   const original=await parameters();
   const read=()=>page.evaluate(()=>{
    const c=document.getElementById('glCanvas'),gl=c.getContext('webgl'),p=new Uint8Array(c.width*c.height*4);
    gl.readPixels(0,0,c.width,c.height,gl.RGBA,gl.UNSIGNED_BYTE,p);return [...p];
   });
   const before=await read();
   await page.click('#toggleRaDecGrid',{timeout:5000}).catch(async e=>{
    console.error({width,layout:await page.evaluate(()=>{
     const b=document.getElementById('toggleRaDecGrid').getBoundingClientRect(),s=document.querySelector('.controls');
     return {button:[b.x,b.y,b.width,b.height],panel:s.getBoundingClientRect().toJSON(),scroll:s.scrollTop,hit:document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)?.outerHTML.slice(0,200)};
    })});throw e;
   });
   await page.waitForSelector('.radec-label');
   assert.ok(await page.locator('.radec-label').count()>5,'Grid and labels must be visible within UVI field');
   const after=await read();let changed=0;
   for(let i=0;i<before.length;i+=4)if(Math.abs(before[i]-after[i])+Math.abs(before[i+1]-after[i+1])+Math.abs(before[i+2]-after[i+2])>10)changed++;
   assert.ok(changed>100,`Grid must change rendered pixels (${changed})`);
   assert.deepEqual(await parameters(),original,'Coordinate overlay cannot change the calibration');
   const labels=()=>page.locator('.radec-label').evaluateAll(els=>els.map(e=>[e.textContent,e.style.left,e.style.top]));
   const positions=await labels();await page.click('#flipImageX');
   assert.notDeepEqual(await labels(),positions,'Grid follows image flips');await page.click('#flipImageX');
   await page.click('#viewZoomIn');assert.notDeepEqual(await labels(),positions,'Grid follows zoom');await page.click('#viewZoomReset');
   fs.mkdirSync('test-report',{recursive:true});
   await page.screenshot({path:`test-report/spacecraft-radec-uv13-${width}.png`,fullPage:true});
   await page.click('#toggleRaDecGrid');assert.equal(await page.locator('.radec-label').count(),0);
   assert.deepEqual(await parameters(),original);assert.deepEqual(errors,[]);
   await context.close();
  }
 }finally{await browser.close();}
 console.log('Live UVI RA/Dec grid renders on desktop/mobile, follows flips/zoom, preserves calibration and exposes UV magnitude 13');
})().catch(e=>{console.error(e);process.exit(1);});
