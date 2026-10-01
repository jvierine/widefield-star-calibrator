(function (root) {
    "use strict";
    const D = Math.PI / 180;
    const WGS84_AXES_KM = Object.freeze([6378.137,6378.137,6356.752314245]);
    function earthAxes(altitudeKm=0) {
        if(!Number.isFinite(altitudeKm)||altitudeKm<0||altitudeKm>2000)throw Error("Invalid Earth shell altitude");
        return WGS84_AXES_KM.map(a=>a+altitudeKm);
    }
    const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
    const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
    function unit(v) {
        if (!Array.isArray(v) || v.length !== 3 || !v.every(Number.isFinite) || Math.hypot(...v) < 1e-12) throw Error("Expected a finite nonzero Cartesian vector");
        const n = Math.hypot(...v); return v.map(x => x/n);
    }
    function siteFromEcef(positionKm) {
        unit(positionKm);
        const [x,y,z] = positionKm, a=6378.137, e2=6.69437999014e-3, p=Math.hypot(x,y);
        if (Math.hypot(...positionKm) < 6378.137) throw Error("Spacecraft position must be outside Earth (ECEF km)");
        let lat=Math.atan2(z,p*(1-e2));
        for(let i=0;i<12;i++){const n=a/Math.sqrt(1-e2*Math.sin(lat)**2);lat=Math.atan2(z+e2*n*Math.sin(lat),p);}
        const n=a/Math.sqrt(1-e2*Math.sin(lat)**2);
        const h=p>1e-8?p/Math.cos(lat)-n:Math.abs(z)-a*Math.sqrt(1-e2);
        return {latDeg:lat/D,lonDeg:Math.atan2(y,x)/D,altM:h*1000};
    }
    function enuBasis(positionKm) {
        const site=siteFromEcef(positionKm),p=site.latDeg*D,l=site.lonDeg*D;
        return [[-Math.sin(l),Math.cos(l),0],[-Math.sin(p)*Math.cos(l),-Math.sin(p)*Math.sin(l),Math.cos(p)],[Math.cos(p)*Math.cos(l),Math.cos(p)*Math.sin(l),Math.sin(p)]];
    }
    function enuToEcef(v, positionKm) {const b=enuBasis(positionKm);return [0,1,2].map(i=>v.reduce((s,x,j)=>s+x*b[j][i],0));}
    function ecefToEnu(v, positionKm) {return enuBasis(positionKm).map(b=>dot(v,b));}
    function azZeToEcef(az, ze, positionKm) {return enuToEcef([Math.sin(ze)*Math.sin(az),Math.sin(ze)*Math.cos(az),Math.cos(ze)],positionKm);}
    function rayIntersection(origin, direction, radius=6371) {
        const d=unit(direction), b=dot(origin,d), c=dot(origin,origin)-radius*radius, disc=b*b-c;
        if(disc<0)return null;
        const t=-b-Math.sqrt(disc);
        return t>0?origin.map((v,i)=>v+t*d[i]):null;
    }
    function starVisible(az, ze, positionKm) {
        // An orbiting observer can see below the local horizontal; reject Earth occultation only.
        return rayIntersection(positionKm,azZeToEcef(az,ze,positionKm),6378.137)===null;
    }
    function starAzZe(raHours,decDeg,positionKm,rotation,basis=enuBasis(positionKm)) {
        const ra=raHours*15*D,dec=decDeg*D,v=[Math.cos(dec)*Math.cos(ra),Math.cos(dec)*Math.sin(ra),Math.sin(dec)];
        const ecef=[0,1,2].map(i=>dot(rotation.slice(i*3,i*3+3),v)),enu=basis.map(b=>dot(b,ecef));
        return {az:Math.atan2(enu[0],enu[1]),ze:Math.acos(Math.max(-1,Math.min(1,enu[2])))};
    }
    function catalogStars(catalog,date,positionKm,magnitude,tools,{hideOcculted=false,rotation=null}={}) {
        const site=siteFromEcef(positionKm),basis=rotation?enuBasis(positionKm):null,stars=[];
        for(const row of catalog){
            if(row[2]>magnitude)continue;
            const azze=rotation?starAzZe(row[0],row[1],positionKm,rotation,basis):tools.radecToAzZe(row[0],row[1],date,site.latDeg,site.lonDeg);
            if(!Number.isFinite(azze.az)||!Number.isFinite(azze.ze)||(hideOcculted&&!starVisible(azze.az,azze.ze,positionKm)))continue;
            stars.push({raHours:row[0],decDeg:row[1],mag:row[2],name:row[3],id:row[4],...azze});
        }
        return stars.sort((a,b)=>a.mag-b.mag);
    }
    // Changing the radial law must not replace the spacecraft attitude with a
    // ground-camera default. Match the angular scale near the image centre.
    function changeLensModel(optpar,fromModel,toModel,defaults,tools) {
        const next=defaults.slice();
        for(let i=0;i<7;i++)next[i]=optpar[i];
        if(fromModel===toModel)return optpar.slice();
        const rot=tools.cameraRot(...optpar.slice(2,5));
        const theta=Math.min(.05,.25/Math.max(Math.abs(optpar[0]),Math.abs(optpar[1])));
        for(let axis=0;axis<2;axis++) {
            const cam=[0,0,Math.cos(theta)];cam[axis]=Math.sin(theta);
            const enu=[0,1,2].map(i=>dot(rot.slice(3*i,3*i+3),cam));
            const az=Math.atan2(enu[0],enu[1]),ze=Math.acos(Math.max(-1,Math.min(1,enu[2])));
            const old=tools.cameraModel(az,ze,optpar,fromModel,1,1);
            const probe=next.slice();probe[axis]=1;
            const fresh=tools.cameraModel(az,ze,probe,toModel,1,1);
            const center=-.5+next[5+axis],key=axis===0?'x':'y';
            next[axis]=(old[key]-center)/(fresh[key]-center);
        }
        return next;
    }
    function seed(positionKm, lookEcef, upEcef, fovDeg, width, height, tools) {
        if(!(fovDeg>0.01&&fovDeg<179))throw Error("Horizontal FOV must be between 0.01 and 179 degrees");
        const look=unit(lookEcef),up=unit(upEcef);
        const right=unit(cross(look,up)),down=unit(cross(look,right));
        const cols=[right,down,look].map(v=>ecefToEnu(v,positionKm));
        const rotation=[0,1,2].flatMap(i=>cols.map(c=>c[i]));
        const angles=tools.cameraAnglesFromRotation(rotation),f=0.5/Math.tan(fovDeg*D/2);
        // AIDA uses a historical one-based normalized principal point.
        return [f,f*width/height,angles.alpha,angles.beta,angles.gamma,0.5/width,0.5/height,0];
    }
    function cameraAxes(positionKm,optpar,tools) {
        const r=tools.cameraRot(optpar[2],optpar[3],optpar[4]);
        return [0,1,2].map(i=>enuToEcef([r[i],r[3+i],r[6+i]],positionKm));
    }
    function rotateCamera(optpar, rotation, tools) {
        const current=tools.cameraRot(optpar[2],optpar[3],optpar[4]);
        const combined=Array.from({length:9},(_,i)=>{
            const row=Math.floor(i/3),col=i%3;
            return current[row*3]*rotation[col]+current[row*3+1]*rotation[3+col]+current[row*3+2]*rotation[6+col];
        });
        const angles=tools.cameraAnglesFromRotation(combined),result=optpar.slice();
        result.splice(2,3,angles.alpha,angles.beta,angles.gamma);
        return result;
    }
    function dragCamera(optpar, fromRay, toRay, tools) {
        // R_new * toRay = R_old * fromRay: the grabbed sky point follows the cursor.
        const a=unit(toRay),b=unit(fromRay),v=cross(a,b),c=dot(a,b);
        if(c < -1+1e-10) return optpar.slice();
        const [x,y,z]=v,k=1/(1+c);
        return rotateCamera(optpar,[
            1-k*(y*y+z*z),-z+k*x*y,y+k*x*z,
            z+k*x*y,1-k*(x*x+z*z),-x+k*y*z,
            -y+k*x*z,x+k*y*z,1-k*(x*x+y*y)
        ],tools);
    }
    function rollCamera(optpar, radians, tools) {
        const c=Math.cos(radians),s=Math.sin(radians);
        return rotateCamera(optpar,[c,-s,0,s,c,0,0,0,1],tools);
    }
    function earthLimb(positionKm, segments=360, altitudeKm=0) {
        unit(positionKm);
        if(!Number.isInteger(segments)||segments<12||segments>4096)throw Error("Invalid limb sampling");
        const axes=earthAxes(altitudeKm);
        const q=positionKm.map((x,i)=>x/axes[i]),distance=Math.hypot(...q);
        if(distance<=1)throw Error("Observer must be outside the WGS84 ellipsoid");
        // Scale the ellipsoid to a unit sphere; its tangent circle satisfies q.x = 1.
        const n=unit(q),u=unit(cross(n,Math.abs(n[2])>.95?[1,0,0]:[0,0,1])),v=cross(n,u);
        const radius=Math.sqrt(1-1/(distance*distance));
        return Array.from({length:segments+1},(_,j)=>{
            const t=2*Math.PI*j/segments;
            return axes.map((a,i)=>a*(n[i]/distance+radius*(u[i]*Math.cos(t)+v[i]*Math.sin(t))));
        });
    }
    function projectEcefPoints(points,positionKm,optpar,optmod,width,height,tools) {
        const basis=enuBasis(positionKm),rotation=tools.cameraRot(optpar[2],optpar[3],optpar[4]);
        return points.map(point=>{
            if(!point)return null;
            const direction=unit(point.map((x,i)=>x-positionKm[i]));
            const enu=basis.map(b=>dot(b,direction));
            if(enu[0]*rotation[2]+enu[1]*rotation[5]+enu[2]*rotation[8]<=1e-8)return null;
            const xy=tools.cameraModel(Math.atan2(enu[0],enu[1]),Math.acos(Math.max(-1,Math.min(1,enu[2]))),optpar,optmod,width,height);
            return Number.isFinite(xy.x)&&Number.isFinite(xy.y)?xy:null;
        });
    }
    function projectEarthLimb(positionKm,optpar,optmod,width,height,tools,altitudeKm=0) {
        return projectEcefPoints(earthLimb(positionKm,360,altitudeKm),positionKm,optpar,optmod,width,height,tools);
    }
    function detectEarthDisc(image,initial,tools) {
        const {width,height,data}=image,{centerX:cx,centerY:cy,radiusPx:r}=initial;
        const gray=new Float32Array(width*height);
        for(let i=0;i<gray.length;i++)gray[i]=(data[4*i]+2*data[4*i+1]+data[4*i+2])/4;
        const sample=(x,y)=>{
            if(x<1||y<1||x>=width-2||y>=height-2)return NaN;
            const ix=Math.floor(x),iy=Math.floor(y),a=x-ix,b=y-iy,k=iy*width+ix;
            return (1-b)*((1-a)*gray[k]+a*gray[k+1])+b*((1-a)*gray[k+width]+a*gray[k+width+1]);
        };
        const points=[],band=Math.max(24,r*.18);
        for(let i=0;i<180;i++){
            const angle=i*Math.PI/90,c=Math.cos(angle),s=Math.sin(angle);
            const profile=t=>[-2,-1,0,1,2].reduce((sum,u)=>sum+sample(cx+t*c-u*s,cy+t*s+u*c),0)/5;
            let best=null;
            for(let t=r-band;t<=r+band;t+=.5){
                const x=cx+t*c,y=cy+t*s;
                // Exclude coloured timestamp/annotation pixels, not a fixed image strip.
                const k=4*(Math.round(y)*width+Math.round(x));
                if(data[k]>data[k+1]*1.35&&data[k]>data[k+2]*1.2)continue;
                const inner=profile(t-5),outer=profile(t+5),gradient=(profile(t-2)-profile(t+2))/4;
                if(!Number.isFinite(gradient)||gradient<2||inner-outer<18)continue;
                // Point sources are bright on both sides of their falling edge only briefly.
                if(profile(t-10)-outer<10)continue;
                const score=gradient*Math.exp(-.5*((t-r)/band)**2);
                if(!best||score>best.score)best={x,y,score};
            }
            if(best)points.push([best.x,best.y]);
        }
        if(points.length<30)throw Error('Not enough illuminated outer limb for a disc fit');
        // Deterministic consensus removes stars and internal auroral boundaries.
        let seed=7351,best=[];
        const random=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296;};
        for(let trial=0;trial<600;trial++){
            const p=Array.from({length:3},()=>points[Math.floor(random()*points.length)]);
            const circle=tools.fitCircleToEdgePoints(p);
            if(!circle||Math.hypot(circle.centerX-cx,circle.centerY-cy)>band||Math.abs(circle.radiusPx-r)>band)continue;
            const kept=points.filter(([x,y])=>Math.abs(Math.hypot(x-circle.centerX,y-circle.centerY)-circle.radiusPx)<2.5);
            if(kept.length>best.length)best=kept;
        }
        if(best.length<30)throw Error('No consistent Earth limb found');
        let circle=tools.fitCircleToEdgePoints(best);
        for(let i=0;i<4;i++){
            best=points.filter(([x,y])=>Math.abs(Math.hypot(x-circle.centerX,y-circle.centerY)-circle.radiusPx)<2.5);
            circle=tools.fitCircleToEdgePoints(best);
            if(!circle)throw Error('Degenerate Earth limb');
        }
        const angleOf=([x,y])=>Math.atan2(y-circle.centerY,x-circle.centerX);
        best=best.filter(p=>best.filter(q=>Math.abs(Math.atan2(Math.sin(angleOf(p)-angleOf(q)),Math.cos(angleOf(p)-angleOf(q))))<6*D).length>=4);
        if(best.length<30)throw Error('Insufficient coherent limb edge');
        circle=tools.fitCircleToEdgePoints(best);
        const angles=best.map(p=>(angleOf(p)+2*Math.PI)%(2*Math.PI)).sort((a,b)=>a-b);
        const gap=Math.max(...angles.map((a,i)=>(i+1<angles.length?angles[i+1]:angles[0]+2*Math.PI)-a));
        const coverageDeg=(2*Math.PI-gap)/D;
        if(coverageDeg<110)throw Error('Visible limb arc is too short for a reliable disc fit');
        const rms=Math.sqrt(best.reduce((sum,[x,y])=>sum+(Math.hypot(x-circle.centerX,y-circle.centerY)-circle.radiusPx)**2,0)/best.length);
        return {...circle,rmsPx:rms,coverageDeg,points:best,candidates:points.length};
    }
    function fitEarthDisc(image,positionKm,optpar,optmod,tools,{flipX=false,flipY=false,altitudeKm=0}={}) {
        if(optmod!==1)throw Error('Earth disc fitting requires a rectilinear lens');
        const {width,height}=image;
        const projected=p=>projectEarthLimb(positionKm,p,1,width,height,tools,altitudeKm).filter(Boolean).map(q=>[q.x,q.y]);
        const initial=tools.fitCircleToEdgePoints(projected(optpar));
        if(!initial||initial.radiusPx<15||initial.radiusPx>Math.max(width,height))throw Error('Point the camera towards Earth before fitting');
        const raw={...initial,centerX:flipX?width-1-initial.centerX:initial.centerX,centerY:flipY?height-1-initial.centerY:initial.centerY};
        const detection=detectEarthDisc(image,raw,tools);
        const target={...detection,centerX:flipX?width-1-detection.centerX:detection.centerX,centerY:flipY?height-1-detection.centerY:detection.centerY};
        let p=optpar.slice();
        // Fit focal scale and pointing; never infer roll or distortion from a partial disc.
        for(let i=0;i<12;i++){
            const current=tools.fitCircleToEdgePoints(projected(p)),scale=target.radiusPx/current.radiusPx;
            p[0]*=scale;p[1]*=scale;
            const c=tools.fitCircleToEdgePoints(projected(p));
            const ray=(x,y)=>unit([((x+1)/width-.5-p[5])/p[0],((y+1)/height-.5-p[6])/p[1],1]);
            p=dragCamera(p,ray(c.centerX,c.centerY),ray(target.centerX,target.centerY),tools);
            if(Math.hypot(c.centerX-target.centerX,c.centerY-target.centerY)<1e-4&&Math.abs(scale-1)<1e-6)break;
        }
        const points=detection.points.map(([x,y])=>[flipX?width-1-x:x,flipY?height-1-y:y]);
        const residual=par=>{
            const ring=projected(par);
            return Math.sqrt(points.reduce((sum,[x,y])=>{
                let nearest=Infinity;
                for(let i=1;i<ring.length;i++){
                    const [a,b]=ring[i-1],[c,d]=ring[i],dx=c-a,dy=d-b,t=Math.max(0,Math.min(1,((x-a)*dx+(y-b)*dy)/(dx*dx+dy*dy)));
                    nearest=Math.min(nearest,(x-a-t*dx)**2+(y-b-t*dy)**2);
                }
                return sum+nearest;
            },0)/points.length);
        };
        const beforeRmsPx=residual(optpar),rmsPx=residual(p);
        if(!Number.isFinite(rmsPx)||rmsPx>3||rmsPx>beforeRmsPx+.25)throw Error('Disc fit did not improve the projected limb');
        return {optpar:p,centerX:detection.centerX,centerY:detection.centerY,radiusPx:detection.radiusPx,
            rmsPx,beforeRmsPx,coverageDeg:detection.coverageDeg,edgePoints:points.length,altitudeKm,method:'illuminated-limb-v2'};
    }
    function earthTerminator(sun,positionKm=null,segments=360) {
        const axes=WGS84_AXES_KM,n=unit(sun.map((s,i)=>s/axes[i]));
        const u=unit(cross(n,Math.abs(n[2])>.95?[1,0,0]:[0,0,1])),v=cross(n,u);
        return Array.from({length:segments+1},(_,j)=>{
            const t=2*Math.PI*j/segments,p=axes.map((a,i)=>a*(u[i]*Math.cos(t)+v[i]*Math.sin(t)));
            // Only the observer-facing part of the physical surface is drawable.
            return positionKm&&p.reduce((s,x,i)=>s+x*(positionKm[i]-x)/axes[i]**2,0)<0?null:p;
        });
    }
    function observationEphemeris(observation,date) {
        return observation&&Math.abs(Date.parse(observation.ephemeris_utc||observation.utc)-date.getTime())<1?observation:null;
    }
    function validateObservation(value) {
        if(!value||value.schema!=="aida.spacecraft-observation/v1")throw Error("Unsupported spacecraft observation");
        if(typeof value.utc!=="string"||!value.utc.endsWith("Z")||!Number.isFinite(Date.parse(value.utc)))throw Error("Invalid observation UTC");
        siteFromEcef(value.position_ecef_km);unit(value.look_ecef);unit(value.up_ecef);
        unit(cross(value.look_ecef,value.up_ecef));
        if(!(value.fov_deg>0.01&&value.fov_deg<179))throw Error("Invalid FOV");
        if(!Number.isInteger(value.width)||!Number.isInteger(value.height)||value.width<1||value.height<1||value.width>65536||value.height>65536)throw Error("Invalid image dimensions");
        if(typeof value.frame_id!=="string"||!value.frame_id||value.frame_id.length>256||typeof value.image_url!=="string")throw Error("Invalid frame identity");
        if(value.optpar!==undefined){
            if(![1,2,3,4,5,6,12,20].includes(value.optmod)||!Array.isArray(value.optpar)||value.optpar.length<8||value.optpar.length>12||!value.optpar.every(Number.isFinite)||Math.abs(value.optpar[0])<1e-8||Math.abs(value.optpar[1])<1e-8)throw Error("Invalid lens model");
            if(value.optmod===20&&value.optpar.length!==12)throw Error("Incomplete radial lens model");
        }
        if(value.sun_ecef!==undefined)unit(value.sun_ecef);
        if(value.j2000_to_ecef!==undefined){
            const r=value.j2000_to_ecef;
            if(!Array.isArray(r)||r.length!==9||!r.every(Number.isFinite))throw Error("Invalid inertial-to-Earth rotation");
            for(let i=0;i<3;i++)for(let j=0;j<3;j++)if(Math.abs(dot(r.slice(i*3,i*3+3),r.slice(j*3,j*3+3))-(i===j?1:0))>1e-6)throw Error("Non-orthonormal inertial-to-Earth rotation");
            if(dot(cross(r.slice(0,3),r.slice(3,6)),r.slice(6,9))<.999999)throw Error("Reflected inertial-to-Earth rotation");
        }
        if(value.ephemeris_utc!==undefined&&(!value.ephemeris_utc.endsWith("Z")||!Number.isFinite(Date.parse(value.ephemeris_utc))))throw Error("Invalid ephemeris UTC");
        return value;
    }
    root.AidaSpacecraft={earthAxes,dot,cross,unit,siteFromEcef,enuBasis,enuToEcef,ecefToEnu,azZeToEcef,rayIntersection,starVisible,starAzZe,catalogStars,changeLensModel,seed,cameraAxes,dragCamera,rollCamera,earthLimb,projectEarthLimb,detectEarthDisc,fitEarthDisc,earthTerminator,projectEcefPoints,observationEphemeris,validateObservation};
    if(typeof module!=="undefined")module.exports=root.AidaSpacecraft;
}(typeof window!=="undefined"?window:globalThis));
