const test=require('node:test');
const assert=require('node:assert/strict');
const G=require('../js/celestial_grid');
test('celestial grid inverts the supplied J2000-to-ECEF rotation',()=>{
    const r=[0,-1,0,1,0,0,0,0,1];
    const c=G.inertialDirection([0,1,0],r);
    assert.equal(c.raHours,0);assert.equal(c.decDeg,0);
    assert.equal(G.inertialDirection([0,0,1],r).decDeg,90);
});
test('local celestial grid covers narrow fields, RA wrap and polar views',()=>{
    for(const [ra,dec] of [[12,-60],[23.9,20],[0.1,-20],[0,89],[12,-89]]){
        const lines=G.localLines(ra,dec,10);
        assert.ok(lines.filter(l=>l.kind==='dec').length>=10);
        assert.ok(lines.filter(l=>l.kind==='ra').length>=5);
        assert.ok(lines.some(l=>l.kind==='dec'&&Math.abs(l.value-dec)<1));
        for(const line of lines)for(const [r,d] of line.points){
            assert.ok(r>=0&&r<24&&d>=-90&&d<=90);
        }
        assert.ok(lines.reduce((n,l)=>n+l.points.length,0)<40000,'Bound work near poles');
    }
});
