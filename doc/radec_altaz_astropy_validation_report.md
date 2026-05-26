# RA/Dec to Azimuth/Elevation Astropy Validation Report

Date: 2026-05-26

This report documents the validation of the `AidaTools.radecToAzZe()` function
against Astropy.  The purpose of the test is to verify that catalogue RA/Dec
coordinates are converted to local azimuth/elevation consistently, without
atmospheric refraction corrections.

## Reference Calculation

The reference calculation uses Astropy `SkyCoord(..., frame="icrs")`
transformed into an `AltAz` frame.  The `AltAz` frame is explicitly configured
with:

```python
pressure = 0 * u.hPa
```

Astropy applies atmospheric refraction in `AltAz` only when pressure is nonzero.
The validation therefore uses unrefracted topocentric azimuth/elevation
coordinates, matching the browser calculation.

The unit test also asserts that the Astropy frame pressure is exactly `0 hPa`
for every direct comparison.

## Precession Issue

The earlier AIDA calculation treated catalogue RA/Dec values as if they were
date-of-observation coordinates.  The star catalogue coordinates are effectively
J2000/ICRS coordinates, so this produced an azimuth bias of order 0.25 degrees
for present-day observations.

The fix is to precess the catalogue RA/Dec from J2000 to the observation date
before applying the local spherical astronomy formula.  After this correction,
the all-case comparison against Astropy improved to:

| Quantity | Value |
|---|---:|
| Comparable cases | 23 |
| Star comparisons | 1556 |
| RMS angular error | 0.0063 deg |
| Median angular error | 0.0062 deg |
| Maximum angular error | 0.0082 deg |
| Maximum absolute azimuth error | 0.0500 deg |
| Maximum absolute elevation error | 0.0080 deg |

The maximum raw azimuth error is larger than the angular error because azimuth is
ill-conditioned near zenith.  The angular separation is the more relevant sky
error metric.

## Pixel Residuals

For saved matched stars, the report also records the image-plane residuals from
the saved model-vs-image star pairings:

| Quantity | Value |
|---|---:|
| Pixel residual count | 1556 |
| RMS pixel residual | 0.780 px |
| Median pixel residual | 0.549 px |
| Maximum pixel residual | 3.604 px |
| Maximum absolute dx | 3.114 px |
| Maximum absolute dy | 3.354 px |

These pixel residuals validate the saved lens solutions and star pairings, not
the RA/Dec to azimuth/elevation transform alone.

## Exposure-Time Drift

Exposure timing can also produce apparent azimuth/elevation differences.  The
table below estimates how far catalogue star positions move during a centered
exposure of different durations.  The azimuth drift is reported separately, but
near zenith it can be much larger than the true great-circle sky smear.

| Exposure (s) | Median az drift (arcsec) | Max az drift (arcsec) | Median angular drift (arcsec) | Max angular drift (arcsec) |
|---:|---:|---:|---:|---:|
| 0.1 | 1.19 | 4.65 | 1.22 | 1.50 |
| 0.5 | 5.93 | 23.28 | 6.10 | 7.52 |
| 1.0 | 11.86 | 46.56 | 12.21 | 15.04 |
| 2.0 | 23.72 | 93.12 | 24.41 | 30.08 |
| 5.0 | 59.30 | 232.79 | 61.03 | 75.20 |
| 10.0 | 118.60 | 465.58 | 122.06 | 150.41 |
| 30.0 | 355.79 | 1396.74 | 366.19 | 451.23 |
| 60.0 | 711.59 | 2793.47 | 732.39 | 902.45 |

This means that long exposures or incorrect timestamp conventions
(start-of-exposure instead of mid-exposure, for example) can create apparent
offsets that are much larger than the remaining numerical disagreement between
AIDA and Astropy.

## Tests

The direct validation is gated because it depends on Python and Astropy:

```bash
npm run test:astropy-altaz
```

This runs two checks:

1. A direct unit test comparing selected RA/Dec/site/time cases from
   `AidaTools.radecToAzZe()` against unrefracted Astropy `AltAz`.
2. An all-saved-case report test comparing tracked calibration cases with saved
   lens models and matched catalogue stars.

The full generated HTML/JSON report can be regenerated with:

```bash
npm run report:astropy-altaz
```

The generated report is written to `test-report/astropy-altaz/`, which is
intentionally ignored by git.
