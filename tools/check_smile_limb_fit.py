"""Diagnostic July 24 SMILE star/limb fit; does not deploy a calibration.

Run with conda run -n base python tools/check_smile_limb_fit.py archive.zip.
The bright edge is assumed to be a 110 km shell; the planning orbit is fixed.
The instrument paper documents an intensifier-induced 2D fourth-order warp:
https://doi.org/10.1007/s11214-025-01160-y (section 4.1.1).
Whether this press-release frame already has that correction is unresolved.
"""
import io
import argparse
import json
import subprocess
import zipfile
from pathlib import Path

import h5py
import numpy as np
from scipy.optimize import least_squares

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('archive', type=Path)
parser.add_argument('--output', type=Path, help='Optional new HDF5 diagnostic, never a live calibration')
args = parser.parse_args()
archive = args.archive.resolve()
with zipfile.ZipFile(archive) as z:
    name = next(n for n in z.namelist() if n.endswith("_calibration.h5"))
    with h5py.File(io.BytesIO(z.read(name))) as h:
        rows = h["selected_stars"][:]
        obs = json.loads(h.attrs["spacecraft_observation"])

# Use the same deployed edge detector and WGS84 geometry as the browser.
script = r'''
const fs=require('fs'),vm=require('vm'),sharp=require('sharp'),{execFileSync}=require('child_process');
const ctx={window:{}};vm.createContext(ctx);for(const n of ['aidatools','spacecraft'])vm.runInContext(fs.readFileSync('js/'+n+'.js','utf8'),ctx);
const A=ctx.window.AidaTools,S=ctx.window.AidaSpacecraft,obs=JSON.parse(process.argv[1]);
(async()=>{const image=await sharp(execFileSync('unzip',['-p',process.argv[2],'base_image.png'])).ensureAlpha().raw().toBuffer({resolveWithObject:true});
if(image.info.width!==512||image.info.height!==512)throw Error('This diagnostic expects a 512x512 SMILE frame');
const initial=A.fitCircleToEdgePoints(S.projectEarthLimb(obs.position_ecef_km,obs.optpar,obs.optmod,512,512,A,110).filter(Boolean).map(q=>[q.x,q.y]));
const detected=S.detectEarthDisc({width:512,height:512,data:image.data},initial,A);
const discFit=S.fitEarthDisc({width:512,height:512,data:image.data},obs.position_ecef_km,obs.optpar,1,A,{altitudeKm:110});
const limb=S.earthLimb(obs.position_ecef_km,720,110);
const rays=limb.map(p=>S.ecefToEnu(S.unit(p.map((v,i)=>v-obs.position_ecef_km[i])),obs.position_ecef_km));
console.log(JSON.stringify({detected,rays,discFit}));})();
'''
geometry = json.loads(subprocess.check_output(["node", "-e", script, json.dumps(obs), str(archive)], cwd=root))
edges = np.array(geometry["detected"]["points"])
rays = np.array(geometry["rays"])
az = np.deg2rad(rows[:, 3]); ze = np.deg2rad(90 - rows[:, 2])
stars = np.array([np.sin(ze)*np.sin(az), np.sin(ze)*np.cos(az), np.cos(ze)]).T
target = rows[:, [5, 4]] - 1

def project(v, p, roll=0):
    a, b, g = np.deg2rad(p[2:5])
    r1 = np.array([[np.cos(g), -np.sin(g), 0], [np.sin(g), np.cos(g), 0], [0, 0, 1]])
    r2 = np.array([[np.cos(a), 0, np.sin(a)], [0, 1, 0], [-np.sin(a), 0, np.cos(a)]])
    r3 = np.array([[1, 0, 0], [0, np.cos(b), np.sin(b)], [0, -np.sin(b), np.cos(b)]])
    rz = np.array([[np.cos(roll), -np.sin(roll), 0], [np.sin(roll), np.cos(roll), 0], [0, 0, 1]])
    c = v @ (r2 @ r3 @ r1 @ rz)
    xy = c[:, :2] / c[:, 2, None]
    r = np.sum(xy**2, axis=1)
    return (xy * (1 + p[7]*r)[:, None] * p[:2] + .5 + p[5:7]) * 512 - 1

def limb_distances(ring):
    # Shortest distance to polyline: an edge constraint, not point correspondences.
    delta = ring[1:] - ring[:-1]
    diff = edges[:, None, :] - ring[:-1]
    t = np.clip(np.sum(diff*delta, axis=2)/np.sum(delta**2, axis=1), 0, 1)
    dist = np.sqrt(np.min(np.sum((diff-t[:, :, None]*delta)**2, axis=2), axis=1))
    return dist

def residual(p, limb_weight=0):
    star_r = (project(stars, p) - target).ravel()
    return np.r_[star_r, limb_weight * limb_distances(project(rays, p)) * np.sqrt(len(stars)/len(edges))]

start = np.array(obs["optpar"][:8]); start[7] = 0
lo = [3, 3, -190, -10, 125, -.05, -.05, -100]
hi = [12, 12, -170, 10, 160, .05, .05, 100]
results = []
for weight in [0, 1, 3, 10]:
    fit = least_squares(lambda p: residual(p, weight), start, bounds=(lo, hi), x_scale="jac", max_nfev=1000)
    r = residual(fit.x, 1)
    result = {"method": "brown_k1", "limb_weight": weight,
              "star_rms_px": float(np.sqrt(np.sum(r[:2*len(stars)]**2)/len(stars))),
              "limb_rms_px": float(np.sqrt(np.sum(r[2*len(stars):]**2)/len(stars))),
              "optpar": fit.x.tolist()}
    results.append(result)
    print(json.dumps(result))

# Compare against the no-distortion hypothesis instead of assuming that a
# lower training RMS proves a distortion law from just nine peripheral stars.
rect = least_squares(lambda p: residual(np.r_[p, 0], 0), start[:7],
                     bounds=(lo[:7], hi[:7]), x_scale="jac", max_nfev=1000)
rect_p = np.r_[rect.x, 0]
r = residual(rect_p, 1)
result = {"method": "rectilinear_star_only", "star_rms_px": float(np.sqrt(np.sum(r[:2*len(stars)]**2)/len(stars))),
          "limb_rms_px": float(np.sqrt(np.sum(r[2*len(stars):]**2)/len(stars))), "optpar": rect_p.tolist()}
results.append(result)
print(json.dumps(result))

# User's conservative fallback: hold the limb-derived focal scale, principal
# point and boresight fixed; optimise only rotation ABOUT that camera boresight.
# This is not the Euler gamma angle (which would also move the boresight).
disc_p = np.array(geometry["discFit"]["optpar"][:8]); disc_p[7] = 0
roll_fit = least_squares(lambda roll: (project(stars, disc_p, roll[0])-target).ravel(),
                         [0.], bounds=(-np.pi, np.pi))
roll_r = project(stars, disc_p, roll_fit.x[0])-target
result = {"method": "limb_rectilinear_plus_star_roll_only", "roll_adjustment_deg": float(np.rad2deg(roll_fit.x[0])),
          "star_rms_px": float(np.sqrt(np.sum(roll_r**2)/len(stars))),
          "limb_rms_px": float(np.sqrt(np.mean(limb_distances(project(rays, disc_p, roll_fit.x[0]))**2))),
          "optpar_before_roll": disc_p.tolist(),
          "provisional": True}
results.append(result)
print(json.dumps(result))

if args.output:
    with h5py.File(args.output, 'x') as h:
        h.attrs['source_archive'] = str(archive)
        h.attrs['script'] = 'tools/check_smile_limb_fit.py'
        h.attrs['limb_altitude_km'] = 110
        h.attrs['orbit_quality'] = 'Fixed ESA planning orbit; not reconstructed'
        h.attrs['summary'] = json.dumps(results)
        h.create_dataset('picked_xy_px', data=target)
        h.create_dataset('star_directions_enu', data=stars)
        h.create_dataset('detected_limb_xy_px', data=edges)
        h.create_dataset('limb_directions_enu', data=rays)
