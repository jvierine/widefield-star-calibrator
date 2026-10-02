const {test}=require('node:test');
const assert=require('node:assert/strict');
const {collect}=require('../js/spacecraft_sessions.js');
test('sequence export preserves saved matches and ignores unrelated storage',()=>{
    const match={image:{x:12,y:34},catalog:{raHours:11,decDeg:-50,mag:3,name:'HD test'}};
    const data={'unrelated':'secret','aida-spacecraft-session:frame':JSON.stringify({utc:'2026-07-24T00:28:08Z',matches:[match]})};
    const before=JSON.stringify(data);
    const storage={length:2,key:i=>Object.keys(data)[i],getItem:k=>data[k]||null};
    const frames=collect(storage);
    assert.deepEqual(frames[0].rows,[[12,34,11,-50,3]]);
    assert.equal(JSON.stringify(data),before);
    assert.equal(frames.length,1);
});
