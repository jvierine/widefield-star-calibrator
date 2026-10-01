const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
// Juha's nine manually selected TD-1 stars, exported 2026-10-01. Columns:
// azimuth, altitude (degrees), raw image column/row (zero based).
const picks=[
 [-103.117462624262,-86.0612895875799,83.525,183.975],
 [-120.854221524366,-85.9198004190087,59.2997994652406,243.932934131737],
 [-147.100016030350,-85.7170934675967,62.2347800378430,343.712558058523],
 [106.703027729551,-85.9961146191128,395.379906876791,433.944597232080],
 [-8.95587538820606,-86.0465917478708,365.375,92.975],
 [-10.3227323390202,-85.3673100441054,379.954864080635,52.7943572195384],
 [-30.8729368513466,-85.2894789029200,298.749696499153,24.2787301587302],
 [-59.7948592407201,-86.0198347685009,191.620970181504,73.6973740392827],
 [-145.946711799160,-84.8687823708930,22.3992835855112,352.401946064140],
];
function harness() {
 const ctx={window:{},Math,Date,Number,Array,Float32Array,Uint8Array,ArrayBuffer,DataView,TextDecoder};
 vm.createContext(ctx);
 for(const name of ['aidatools','spacecraft'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/'+name+'.js'),'utf8'),ctx);
 const A=ctx.window.AidaTools,S=ctx.window.AidaSpacecraft;
 const start=S.seed([32842.59832894,56014.92525168,76368.44137199],
  [-.32207495897000166,-.5609220838117577,-.7626494192594306],
  [.2234866067827312,-.8278550598764823,.514499500899317],9.354519905066068,512,512,A);
 ctx.AidaTools=A;ctx.BROWN_CONRADY_OPTMOD=20;
 ctx.state={image:{width:512,height:512},modelOptpar:start.concat([0,0,0,0])};
 ctx.state.modelOptpar[7]=0;
 ctx.controls={optmod:{value:'20'},timestampUtc:{value:'2026-07-24T00:00'},latDeg:{value:'49.63885'},lonDeg:{value:'59.6161'}};
 ctx.spacecraftMode=()=>true;
 ctx.currentFitVector=()=>ctx.state.modelOptpar.slice();
 ctx.rawImagePixelFromModelImagePixel=(x,y)=>[x,y];
 ctx.observerRaDec=i=>({az:picks[i][0]*A.DEG,ze:(90-picks[i][1])*A.DEG});
 ctx.matches=picks.map((p,i)=>({catalog:{raHours:i,decDeg:0},image:{x:p[2],y:p[3]}}));
 const src=fs.readFileSync(path.join(__dirname,'../js/app.js'),'utf8');
 const definitions=[...src.matchAll(/^    (?:async )?function (\w+)\(/gm)];
 for(const name of ['requiredOptparLength','radialAlphaBoundsForFit','fitParameterBounds','clampFitVectorToBounds','fitPenalty','optparFromFitVector','cameraFrameDirectionForAzEl','matchResidualFactory','residualSumSquares','solveLinearSystem','levenbergMarquardt']) {
  const i=definitions.findIndex(m=>m[1]===name);
  vm.runInContext(src.slice(definitions[i].index,definitions[i+1].index),ctx);
 }
 return {ctx,A,S,start};
}
test('nine real UV pairs fit the forward camera and retain a projected Earth limb',()=>{
 const {ctx,A,S}=harness();
 const residual=ctx.matchResidualFactory(ctx.matches),start=ctx.currentFitVector();
 const before=ctx.residualSumSquares(residual(start));
 const fit=ctx.levenbergMarquardt(residual,start,160,20);
 const rms=Math.sqrt(ctx.residualSumSquares(residual(fit.x))/picks.length);
 console.log('real UV pairs RMS:',Math.sqrt(before/picks.length),'->',rms,'optpar',fit.x);
 assert.ok(rms<5,`UV fit RMS ${rms}`);
 assert.ok(fit.x[0]>0&&fit.x[1]>0);
 assert.ok(Math.abs(fit.x[5]-start[5])<=.05&&Math.abs(fit.x[6]-start[6])<=.05);
 assert.deepEqual(Array.from(fit.x.slice(8)),[0,0,0,0]);
 const limb=S.projectEarthLimb([32842.59832894,56014.92525168,76368.44137199],fit.x,20,512,512,A);
 assert.ok(limb.filter(p=>p&&p.x>=0&&p.x<512&&p.y>=0&&p.y<512).length>250);
});
test('the previous back-facing Brown solution is rejected even with finite pixel projections',()=>{
 const {ctx}=harness();
 const old=[-5.66506619886,5.64583717885,-3.20313775275,-2.44639545754,56.6113615568,.292206159538,.00245170080765,5,5,-.00179329351439,-.169282965803,-.160381078132];
 ctx.state.modelOptpar=old;
 assert.equal(ctx.matchResidualFactory(ctx.matches)(old),null);
});
test('changing spacecraft radial models retains attitude, principal point and local scale',()=>{
 const {A,S,start}=harness();
 for(const model of [2,3,4,5,6,12,20]) {
  const defaults=Array(model===20?12:8).fill(0);defaults[7]=model===20||model===12?0:model===4?1:model===6||model===5?.5:.35;
  const next=S.changeLensModel(start,1,model,defaults,A);
  assert.deepEqual(Array.from(next.slice(2,7)),Array.from(start.slice(2,7)));
  assert.ok(next[0]>0&&next[1]>0);
  const p=[32842.59832894,56014.92525168,76368.44137199];
  assert.ok(S.projectEarthLimb(p,next,model,512,512,A).filter(Boolean).length>300);
 }
 const brown=S.changeLensModel(start,1,20,Array(12).fill(0),A);
 assert.ok(Math.abs(brown[0]-start[0])<1e-8);
});
