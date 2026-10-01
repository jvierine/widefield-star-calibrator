"""Build AIDA's TD-1 UV overlay: conda run -n base python tools/build_td1_catalog.py INPUT.gz.

Source: CDS II/59B, Thompson et al. (1978). No proper motions are supplied;
FK4/B1950 positions are transformed to FK5/J2000, not propagated to 2026.
"""
import gzip
import hashlib
import json
from pathlib import Path
import sys

import h5py
import numpy as np
from astropy.coordinates import SkyCoord, FK4, FK5
import astropy.units as u


def build(source, destination):
    raw = Path(source).read_bytes()
    records = []
    for line in gzip.decompress(raw).decode('ascii').splitlines():
        flux, error = float(line[91:97]), float(line[97:102])
        if flux <= 0 or error <= 0 or flux / error < 5:
            continue
        # cW/m2/nm equals erg/s/cm2/Angstrom numerically.
        flux *= 10 ** int(line[102:106])
        magnitude = -2.5 * np.log10(flux) - 5 * np.log10(1565) - 2.406
        records.append((int(line[:5]), int(line[6:12]), float(line[40:48]),
                        float(line[49:58]), flux, magnitude))
    a = np.asarray(records)
    sky = SkyCoord(ra=a[:, 2]*u.rad, dec=a[:, 3]*u.rad,
                   frame=FK4(equinox='B1950')).transform_to(FK5(equinox='J2000'))
    rows = [[round(float(sky.ra.hour[i]), 8), round(float(sky.dec.deg[i]), 7),
             round(float(r[5]), 4), f'HD {int(r[1])}' if r[1] else f'TD1 {int(r[0])}',
             f'TD1-{int(r[0])}'] for i, r in enumerate(a)]
    rows.sort(key=lambda r: r[2])
    metadata = dict(source='https://cdsarc.cds.unistra.fr/ftp/II/59B/catalog.dat.gz',
                    source_sha256=hashlib.sha256(raw).hexdigest(),
                    reference='Thompson et al. 1978, CDS II/59B',
                    frame='FK5 J2000; no proper-motion propagation',
                    selection='F1565 > 0, uncertainty > 0, S/N >= 5',
                    magnitude='AB magnitude at 156.5 nm; proxy, not SMILE band-integrated flux')
    destination.mkdir(parents=True, exist_ok=True)
    with h5py.File(destination / 'td1_uv.hdf5', 'w') as out:
        out.attrs.update(metadata)
        for name, values in [('td1_id', a[:, 0].astype(int)), ('hd_id', a[:, 1].astype(int)),
                             ('ra_deg_j2000', sky.ra.deg), ('dec_deg_j2000', sky.dec.deg),
                             ('flux1565_erg_s_cm2_angstrom', a[:, 4]), ('ab1565', a[:, 5])]:
            out.create_dataset(name, data=values, compression='gzip')
    # Browser delivery asset; HDF5 above retains the scientific data product.
    (destination / 'td1_uv.json').write_text(json.dumps(dict(metadata=metadata, rows=rows), separators=(',', ':')))
    print(f'Built {len(rows)} TD-1 stars; AB range {rows[0][2]} to {rows[-1][2]}')


if __name__ == '__main__':
    build(sys.argv[1], Path(__file__).resolve().parents[1] / 'data')
