const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const context={window:{},Math,Date,Number,Array,Float32Array,Uint8Array,ArrayBuffer,DataView,TextDecoder};
vm.createContext(context);
for(const name of ['aidatools','spacecraft'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/'+name+'.js'),'utf8'),context);
const S=context.window.AidaSpacecraft,A=context.window.AidaTools;
const near=(a,b,tol=1e-7)=>assert.ok(Math.abs(a-b)<tol,`${a} vs ${b}`);
const transform=(r,v)=>[0,1,2].map(i=>r[3*i]*v[0]+r[3*i+1]*v[1]+r[3*i+2]*v[2]);
function discImage({cx=272,cy=262,r=200,arc=190,blank=false}={}) {
  const width=512,height=512,data=new Uint8ClampedArray(width*height*4);
  let seed=42;const random=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296;};
  const stars=[[465,250],[350,60],[100,400],[250,80],[290,475]];
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const radius=Math.hypot(x-cx,y-cy),theta=Math.atan2(y-cy,x-cx);
    const limb=!blank&&Math.abs(theta)<arc*Math.PI/360?145/(1+Math.exp((radius-r)/1.3)):0;
    let value=55+10*(random()-.5)+limb;
    if(!blank){
      value+=45*Math.exp(-(((radius-r*.65)/3)**2));
      for(const [sx,sy]of stars)value+=150*Math.exp(-((x-sx)**2+(y-sy)**2)/5);
    }
    const k=4*(y*width+x);data[k]=value;data[k+1]=value;data[k+2]=Math.min(255,value+30);data[k+3]=255;
    if(y<25&&x<260){data[k]=220;data[k+1]=15;data[k+2]=30;}
  }
  return {width,height,data};
}
test('disc detection recovers a partial limb despite stars, auroral ring and timestamp',()=>{
  const fit=S.detectEarthDisc(discImage(),{centerX:267,centerY:265,radiusPx:192},A);
  near(fit.centerX,272,.5);near(fit.centerY,262,.5);near(fit.radiusPx,200,.5);
  assert.ok(fit.rmsPx<.5);assert.ok(fit.coverageDeg>175&&fit.coverageDeg<205);
});
test('blank images and short illuminated arcs do not produce a confident disc fit',()=>{
  for(const options of [{blank:true},{arc:60}])assert.throws(()=>S.detectEarthDisc(discImage(options),{centerX:267,centerY:265,radiusPx:192},A));
});
test('disc fitting adjusts WGS84 projection without fitting roll and handles image flips',()=>{
  const position=[32842,56014,76368],opt=S.seed(position,position.map(v=>-v),[0,0,1],9.5,512,512,A),image=discImage();
  for(const [flipX,flipY]of [[false,false],[true,false],[false,true],[true,true]]){
    const fit=S.fitEarthDisc(image,position,opt,1,A,{flipX,flipY});
    assert.ok(fit.rmsPx<.7);assert.ok(fit.beforeRmsPx>5);
    near(fit.optpar[0]/fit.optpar[1],opt[0]/opt[1]);
    for(const i of [5,6,7])assert.equal(fit.optpar[i],opt[i]);
    const p=S.projectEarthLimb(position,fit.optpar,1,512,512,A).map(q=>[q.x,q.y]);
    const circle=A.fitCircleToEdgePoints(p);
    near(flipX?511-circle.centerX:circle.centerX,272,.5);near(flipY?511-circle.centerY:circle.centerY,262,.5);
  }
  assert.throws(()=>S.fitEarthDisc(image,position,opt,2,A),/rectilinear/);
});
test('spacecraft pointing drag keeps the grabbed ray under the cursor at any attitude',()=>{
  for(const angles of [[175,-10,35],[-179,89.99,178],[0,-89.99,0],[90,0,0]]){
    const opt=[5,-6,...angles,.01,-.02,.4],a=S.unit([.05,-.07,1]),b=S.unit([-.03,.06,1]);
    const updated=S.dragCamera(opt,a,b,A);
    const before=transform(A.cameraRot(...angles),a),after=transform(A.cameraRot(...updated.slice(2,5)),b);
    before.forEach((x,i)=>near(x,after[i],1e-10));
    for(const i of [0,1,5,6,7])assert.equal(updated[i],opt[i]);
    const back=S.dragCamera(updated,b,a,A),r=A.cameraRot(...back.slice(2,5));
    A.cameraRot(...angles).forEach((x,i)=>near(x,r[i],1e-10));
  }
});
test('UVI limb fitting uses the emission shell, not the solid Earth radius',()=>{
  const p=[32842,56014,76368],opt=S.seed(p,p.map(v=>-v),[0,0,1],9.5,512,512,A);
  const fit=S.fitEarthDisc(discImage(),p,opt,1,A,{altitudeKm:110});
  assert.equal(fit.altitudeKm,110);assert.equal(fit.method,'illuminated-limb-v2');
  const circle=h=>A.fitCircleToEdgePoints(S.projectEarthLimb(p,fit.optpar,1,512,512,A,h).map(q=>[q.x,q.y]));
  near(circle(110).radiusPx,200,.5);
  assert.ok(circle(0).radiusPx<197,'The solid Earth must be inside the fitted atmospheric limb');
  const axes=S.earthAxes(110);
  for(const q of S.earthLimb(p,360,110)){
    near(q.reduce((s,x,i)=>s+(x/axes[i])**2,0),1,1e-12);
    near(q.reduce((s,x,i)=>s+x*(p[i]-x)/axes[i]**2,0),0,1e-12);
  }
  assert.throws(()=>S.earthAxes(-10));
});
test('spacecraft roll uses the optical axis, not ground zenith',()=>{
  const p=[32842,56014,76368],opt=S.seed(p,S.unit(p.map(x=>-x)),[0,0,1],10,512,512,A);
  for(const angle of [-3,-.6,.3,3]){
    const updated=S.rollCamera(opt,angle,A),before=S.cameraAxes(p,opt,A),after=S.cameraAxes(p,updated,A);
    before[2].forEach((x,i)=>near(x,after[2][i],1e-10));
    near(S.dot(before[0],after[0]),Math.cos(angle),1e-10);
  }
});
test('spacecraft WGS84 position and ENU transforms round trip',()=>{
  const p=[100000,0,0],s=S.siteFromEcef(p);near(s.latDeg,0);near(s.lonDeg,0);near(s.altM,(100000-6378.137)*1000);
  const q=[.2,.5,-.3],back=S.enuToEcef(S.ecefToEnu(q,p),p);q.forEach((x,i)=>near(x,back[i]));
});
test('spacecraft can see stars below the local horizon but not through Earth',()=>{
  const p=[100000,0,0];
  assert.equal(S.starVisible(0,100*Math.PI/180,p),true);
  assert.equal(S.starVisible(0,Math.PI,p),false);
  assert.equal(S.starVisible(0,0,p),true);
});
test('calibration catalog includes magnitude 8 and occulted stars unless explicitly hidden',()=>{
  const p=[100000,0,0],r=[1,0,0,0,1,0,0,0,1],date=new Date('2026-07-24T00:00:00Z');
  const rows=[[12,0,7.8,'behind Earth',1],[0,0,6,'outward',2],[6,0,8.1,'too faint',3]];
  const options={rotation:r};
  const all=S.catalogStars(rows,date,p,8,A,options);
  assert.equal(all.length,2);assert.equal(all[1].name,'behind Earth');
  assert.equal(S.catalogStars(rows,date,p,7,A,options).length,1);
  const hidden=S.catalogStars(rows,date,p,8,A,{...options,hideOcculted:true});
  assert.equal(hidden.length,1);assert.equal(hidden[0].name,'outward');
});
test('inertial star ray and Earth point use exactly the same ECEF camera projection',()=>{
  const p=[100000,0,0],r=[0,-1,0,1,0,0,0,0,1];
  const opt=S.seed(p,[-1,0,0],[0,0,1],12,512,512,A);
  const star=S.starAzZe(6,2,p,r),d=S.azZeToEcef(star.az,star.ze,p);
  const xy=A.cameraModel(star.az,star.ze,opt,1,512,512);
  const point=p.map((x,i)=>x+d[i]*5000),projected=S.projectEcefPoints([point],p,opt,1,512,512,A)[0];
  near(xy.x,projected.x,1e-8);near(xy.y,projected.y,1e-8);
});
test('terminator lies on WGS84 and has zero solar incidence on its surface normal',()=>{
  const sun=S.unit([-.94,-.027,.34]),axes=[6378.137,6378.137,6356.752314245];
  const points=S.earthTerminator(sun);
  for(const p of points){near(p.reduce((s,x,i)=>s+(x/axes[i])**2,0),1,1e-12);near(p.reduce((s,x,i)=>s+x*sun[i]/axes[i]**2,0),0,1e-12);}
  const visible=S.earthTerminator(sun,[32842,56014,76368]);
  assert.ok(visible.some(p=>p===null));assert.ok(visible.some(p=>p!==null));
});
test('handoff ephemeris is not silently reused after UTC changes',()=>{
  const o={utc:'2026-07-24T00:00:00Z'};
  assert.equal(S.observationEphemeris(o,new Date(o.utc)),o);
  assert.equal(S.observationEphemeris(o,new Date('2026-07-26T00:00:00Z')),null);
});
test('display, fitting and exports all use the same observer astrometry entrypoint',()=>{
  const app=fs.readFileSync(path.join(__dirname,'../js/app.js'),'utf8');
  assert.equal((app.match(/AidaTools\.radecToAzZe\(/g)||[]).length,1,'Only the ground/fallback entrypoint may bypass observerRaDec');
  assert.match(app,/function matchResidualFactory[\s\S]*?observerRaDec\(match\.catalog/);
  assert.match(fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),/id="maxMag"[^>]*max="8"/);
});
test('ECEF seed places Earth centre on image centre and gives correct handedness',()=>{
  const p=[32842.5983,56014.9253,76368.4414],look=S.unit(p.map(x=>-x)),up=[0,0,1];
  const opt=S.seed(p,look,up,10,512,512,A),enu=S.ecefToEnu(look,p),xy=A.cameraModel(Math.atan2(enu[0],enu[1]),Math.acos(enu[2]),opt,1,512,512);
  near(xy.x,255.5);near(xy.y,255.5);
  const axes=S.cameraAxes(p,opt,A);near(S.dot(S.cross(axes[0],axes[1]),axes[2]),1);
  look.forEach((v,i)=>near(v,axes[2][i]));
});
test('shell intersection chooses visible near side',()=>{
  const p=S.rayIntersection([100000,0,0],[-1,0,0],6481);near(p[0],6481);
  assert.equal(S.rayIntersection([100000,0,0],[1,0,0],6481),null);
});
test('rejects invalid position, collinear up direction and malformed observation',()=>{
  assert.throws(()=>S.siteFromEcef([0,0,0]));
  assert.throws(()=>S.seed([100000,0,0],[-1,0,0],[1,0,0],10,512,512,A));
  assert.throws(()=>S.validateObservation({schema:'wrong'}));
});
test('handoff validation rejects malformed lens models but allows mirrored focal signs',()=>{
  const observation={schema:'aida.spacecraft-observation/v1',utc:'2026-07-24T00:00:00Z',frame_id:'test',image_url:'/smile/frames/000.png',width:512,height:512,position_ecef_km:[100000,0,0],look_ecef:[-1,0,0],up_ecef:[0,0,1],fov_deg:10,optmod:1,optpar:[-5,5,0,0,0,0,0,0]};
  assert.equal(S.validateObservation(observation),observation);
  assert.throws(()=>S.validateObservation({...observation,optpar:[NaN]}));
  assert.throws(()=>S.validateObservation({...observation,up_ecef:[1,0,0]}));
  assert.throws(()=>S.validateObservation({...observation,utc:'2026-07-24T00:00:00'}));
});
test('Earth limb is closed, lies on WGS84 and is tangent from the observer',()=>{
  const axes=[6378.137,6378.137,6356.752314245];
  for(const p of [[100000,0,0],[0,0,100000],[32842,56014,76368]]){
    const points=S.earthLimb(p);assert.equal(points.length,361);
    points[0].forEach((x,i)=>near(x,points.at(-1)[i]));
    for(const q of points){
      near(q.reduce((s,x,i)=>s+(x/axes[i])**2,0),1,1e-12);
      near(q.reduce((s,x,i)=>s+x*(p[i]-x)/axes[i]**2,0),0,1e-12);
    }
  }
  assert.throws(()=>S.earthLimb([100,0,0]));
});
test('limb projection follows focal scale, shifts and all supported lens models',()=>{
  const p=[100000,0,0],opt=S.seed(p,[-1,0,0],[0,0,1],10,512,512,A);
  const limb=S.projectEarthLimb(p,opt,1,512,512,A);
  const min=Math.min(...limb.map(q=>q.x)),max=Math.max(...limb.map(q=>q.x));near((min+max)/2,255.5);
  const scaled=opt.slice();scaled[0]*=2;scaled[5]+=.1;
  const changed=S.projectEarthLimb(p,scaled,1,512,512,A);
  limb.forEach((q,i)=>near(changed[i].x,(q.x-255.5)*2+255.5+51.2));
  for(const model of [1,2,3,4,5,6,12,20]){
    const params=[...opt.slice(0,7),.5,0,0,0,0];
    assert.ok(S.projectEarthLimb(p,params,model,512,512,A).every(q=>q&&Number.isFinite(q.x)&&Number.isFinite(q.y)));
  }
  const away=S.seed(p,[1,0,0],[0,0,1],10,512,512,A);
  assert.ok(S.projectEarthLimb(p,away,1,512,512,A).every(q=>q===null));
});
