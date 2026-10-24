//! Portable catalogue, calibration-job import, and seeded automatic matching.

use crate::{
    fit, radec_to_azimuth_zenith, Calibration, Detection, FitResult, OpticalModel, StarPair,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{f64::consts::PI, io::Read};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct Observation {
    pub unix_millis: i64,
    pub latitude_deg: f64,
    pub longitude_deg: f64,
}

impl Observation {
    pub fn validate(&self) -> Result<(), String> {
        if !self.latitude_deg.is_finite()
            || self.latitude_deg.abs() > 90.0
            || !self.longitude_deg.is_finite()
            || self.longitude_deg.abs() > 180.0
        {
            return Err("observer latitude/longitude is out of range".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct FitJob {
    pub initial: Calibration,
    #[serde(default)]
    pub pairs: Vec<StarPair>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observation: Option<Observation>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct CalibrationDocument {
    pub schema: String,
    pub solved: bool,
    pub rms_px: f64,
    pub iterations: usize,
    pub calibration: Calibration,
    pub residuals_px: Vec<[f64; 2]>,
    pub pairs: Vec<StarPair>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observation: Option<Observation>,
}

impl CalibrationDocument {
    pub fn from_fit(result: &FitResult, job: &FitJob) -> Result<Self, String> {
        let residuals_px = job
            .pairs
            .iter()
            .map(|pair| {
                result
                    .calibration
                    .project(pair.azimuth_rad, pair.zenith_rad)
                    .map(|pixel| [pixel[0] - pair.x_px, pixel[1] - pair.y_px])
                    .ok_or_else(|| "fitted projection is not finite".to_owned())
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            schema: "wisc.calibration/v1".into(),
            solved: true,
            rms_px: result.rms_px,
            iterations: result.iterations,
            calibration: result.calibration.clone(),
            residuals_px,
            pairs: job.pairs.clone(),
            observation: job.observation.clone(),
        })
    }
}

fn field<T: for<'de> Deserialize<'de>>(value: &Value, key: &str) -> Result<T, String> {
    serde_json::from_value(
        value
            .get(key)
            .cloned()
            .ok_or_else(|| format!("missing {key}"))?,
    )
    .map_err(|error| format!("invalid {key}: {error}"))
}

/// Accept the shared job, a previous fit result, or a legacy saved test case.
/// Legacy saved az/ze values are retained exactly, avoiding epoch changes.
pub fn parse_job(source: &str) -> Result<FitJob, String> {
    let root: Value = serde_json::from_str(source).map_err(|error| error.to_string())?;
    let value = root.get("testCase").unwrap_or(&root);
    let job = if value.get("initial").is_some() {
        serde_json::from_value::<FitJob>(value.clone()).map_err(|error| error.to_string())?
    } else if value.get("calibration").is_some() {
        FitJob {
            initial: field(value, "calibration")?,
            pairs: value
                .get("pairs")
                .map(|value| serde_json::from_value(value.clone()))
                .transpose()
                .map_err(|error| error.to_string())?
                .unwrap_or_default(),
            observation: value
                .get("observation")
                .map(|value| serde_json::from_value(value.clone()))
                .transpose()
                .map_err(|error| error.to_string())?,
        }
    } else if value.get("optpar").is_some() && value.get("model").is_none() {
        let width: u32 = field(value, "width")?;
        let height: u32 = field(value, "height")?;
        let mut optpar: Vec<f64> = field(value, "optpar")?;
        if optpar.is_empty() {
            return Err("empty legacy optpar".into());
        }
        let model_number = optpar.remove(0);
        if model_number.fract() != 0.0 || !(0.0..=255.0).contains(&model_number) {
            return Err("invalid optical model".into());
        }
        let model = OpticalModel::try_from(model_number as u8)?;
        if value.get("modelCoordinates").and_then(Value::as_str) != Some("raw_image_pixel_centers")
        {
            // Old saved models used the GUI's image flips. Convert to raw
            // pixel centres before accepting their measured image positions.
            let display = value.get("display");
            for (index, offset, size, key) in [(0, 5, width, "flipX"), (1, 6, height, "flipY")] {
                let flipped = display
                    .and_then(|display| display.get(key))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let image_key = if key == "flipX" {
                    "imageFlipX"
                } else {
                    "imageFlipY"
                };
                let image_flipped = display
                    .and_then(|display| display.get(image_key))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if flipped != image_flipped && optpar.len() > offset {
                    optpar[index] = -optpar[index];
                    optpar[offset] = 1.0 / f64::from(size) - optpar[offset];
                }
            }
        }
        let observation = if let Some(timestamp) = value.get("timestampUtc").and_then(Value::as_str)
        {
            let date = chrono::DateTime::parse_from_rfc3339(timestamp)
                .map_err(|error| error.to_string())?;
            Some(Observation {
                unix_millis: date.timestamp_millis(),
                latitude_deg: field(value, "latDeg")?,
                longitude_deg: field(value, "lonDeg")?,
            })
        } else {
            None
        };
        let mut pairs = Vec::new();
        if let Some(matches) = value.get("matches").and_then(Value::as_array) {
            for matched in matches {
                let image = matched.get("image").ok_or("missing match image")?;
                let catalog = matched.get("catalog").ok_or("missing match catalogue")?;
                let sky = if catalog.get("az").is_some() && catalog.get("ze").is_some() {
                    [field(catalog, "az")?, field(catalog, "ze")?]
                } else {
                    let observation = observation
                        .as_ref()
                        .ok_or("RA/Dec matches need an observation")?;
                    radec_to_azimuth_zenith(
                        field(catalog, "raHours")?,
                        field(catalog, "decDeg")?,
                        observation.unix_millis,
                        observation.latitude_deg,
                        observation.longitude_deg,
                    )
                };
                pairs.push(StarPair {
                    azimuth_rad: sky[0],
                    zenith_rad: sky[1],
                    x_px: field(image, "x")?,
                    y_px: field(image, "y")?,
                });
            }
        }
        FitJob {
            initial: Calibration {
                width,
                height,
                model,
                optpar,
            },
            pairs,
            observation,
        }
    } else {
        FitJob {
            initial: serde_json::from_value(value.clone()).map_err(|error| error.to_string())?,
            pairs: Vec::new(),
            observation: None,
        }
    };
    job.initial.validate()?;
    if let Some(observation) = &job.observation {
        observation.validate()?;
    }
    if !job.pairs.iter().all(|pair| {
        [pair.azimuth_rad, pair.zenith_rad, pair.x_px, pair.y_px]
            .iter()
            .all(|value| value.is_finite())
    }) {
        return Err("star pairs contain nonfinite values".into());
    }
    Ok(job)
}

#[derive(Clone, Debug)]
pub struct CatalogStar {
    pub index: usize,
    pub ra_hours: f64,
    pub dec_deg: f64,
    pub magnitude: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SkyStar {
    pub catalog_index: usize,
    pub azimuth_rad: f64,
    pub zenith_rad: f64,
    pub magnitude: f64,
}

pub fn tycho_catalog() -> Result<Vec<CatalogStar>, String> {
    let mut bytes = Vec::new();
    flate2::read::GzDecoder::new(&include_bytes!("../../../data/tycho2_mag8.bin.gz")[..])
        .take(1_000_001)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    parse_catalog(&bytes)
}

pub fn parse_catalog(bytes: &[u8]) -> Result<Vec<CatalogStar>, String> {
    if bytes.len() < 16 || &bytes[..8] != b"WISCAT1\0" {
        return Err("invalid catalogue header".into());
    }
    let count = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
    let stride = u32::from_le_bytes(bytes[12..16].try_into().unwrap());
    if stride != 3
        || count.checked_mul(12).and_then(|size| size.checked_add(16)) != Some(bytes.len())
    {
        return Err("invalid catalogue length/stride".into());
    }
    bytes[16..]
        .as_chunks::<12>()
        .0
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let value = |offset| {
                f64::from(f32::from_le_bytes(
                    row[offset..offset + 4].try_into().unwrap(),
                ))
            };
            let star = CatalogStar {
                index,
                ra_hours: value(0),
                dec_deg: value(4),
                magnitude: value(8),
            };
            if !(0.0..=24.0).contains(&star.ra_hours)
                || !(-90.0..=90.0).contains(&star.dec_deg)
                || !star.magnitude.is_finite()
            {
                return Err("invalid catalogue coordinate".into());
            }
            Ok(star)
        })
        .collect()
}

pub fn visible_catalog(
    catalog: &[CatalogStar],
    observation: &Observation,
    max_magnitude: f64,
) -> Result<Vec<SkyStar>, String> {
    observation.validate()?;
    if !max_magnitude.is_finite() {
        return Err("invalid magnitude limit".into());
    }
    Ok(catalog
        .iter()
        .filter(|star| star.magnitude <= max_magnitude)
        .filter_map(|star| {
            let [azimuth_rad, zenith_rad] = radec_to_azimuth_zenith(
                star.ra_hours,
                star.dec_deg,
                observation.unix_millis,
                observation.latitude_deg,
                observation.longitude_deg,
            );
            (zenith_rad < PI / 2.0).then_some(SkyStar {
                catalog_index: star.index,
                azimuth_rad,
                zenith_rad,
                magnitude: star.magnitude,
            })
        })
        .collect())
}

/// Associate each source and catalogue star at most once, after rough alignment.
pub fn associate(
    calibration: &Calibration,
    detections: &[Detection],
    sky: &[SkyStar],
    radius_px: f64,
) -> Result<Vec<StarPair>, String> {
    calibration.validate()?;
    if !radius_px.is_finite() || radius_px <= 0.0 {
        return Err("matching radius must be positive and finite".into());
    }
    let mut candidates = Vec::new();
    for (star_index, star) in sky.iter().enumerate() {
        let Some(pixel) = calibration.project(star.azimuth_rad, star.zenith_rad) else {
            continue;
        };
        if pixel[0] < 0.0
            || pixel[1] < 0.0
            || pixel[0] >= f64::from(calibration.width)
            || pixel[1] >= f64::from(calibration.height)
        {
            continue;
        }
        for (detection_index, detection) in detections.iter().enumerate() {
            let distance = (pixel[0] - detection.x).hypot(pixel[1] - detection.y);
            if distance <= radius_px {
                candidates.push((distance, star_index, detection_index));
            }
        }
    }
    candidates.sort_by(|left, right| left.0.total_cmp(&right.0));
    let mut used_stars = vec![false; sky.len()];
    let mut used_detections = vec![false; detections.len()];
    let mut pairs = Vec::new();
    for (_, star_index, detection_index) in candidates {
        if used_stars[star_index] || used_detections[detection_index] {
            continue;
        }
        used_stars[star_index] = true;
        used_detections[detection_index] = true;
        let star = &sky[star_index];
        let detection = &detections[detection_index];
        pairs.push(StarPair {
            azimuth_rad: star.azimuth_rad,
            zenith_rad: star.zenith_rad,
            x_px: detection.x,
            y_px: detection.y,
        });
    }
    Ok(pairs)
}

pub fn automatic_fit(
    start: &Calibration,
    detections: &[Detection],
    sky: &[SkyStar],
    radius_px: f64,
    max_iterations: usize,
) -> Result<(FitResult, Vec<StarPair>), String> {
    automatic_fit_preserving(start, detections, sky, &[], radius_px, max_iterations)
}

/// Keep every manually measured position while expanding automatic matches.
pub fn automatic_fit_preserving(
    start: &Calibration,
    detections: &[Detection],
    sky: &[SkyStar],
    manual: &[StarPair],
    radius_px: f64,
    max_iterations: usize,
) -> Result<(FitResult, Vec<StarPair>), String> {
    let mut calibration = start.clone();
    let mut accepted = None;
    let mut radius = radius_px;
    for _ in 0..3 {
        let mut pairs = manual.to_vec();
        for candidate in associate(&calibration, detections, sky, radius)? {
            if manual.iter().any(|pair| {
                (pair.x_px - candidate.x_px).hypot(pair.y_px - candidate.y_px) < 2.0 || {
                    let a = nalgebra::Vector3::new(
                        pair.zenith_rad.sin() * pair.azimuth_rad.sin(),
                        pair.zenith_rad.sin() * pair.azimuth_rad.cos(),
                        pair.zenith_rad.cos(),
                    );
                    let b = nalgebra::Vector3::new(
                        candidate.zenith_rad.sin() * candidate.azimuth_rad.sin(),
                        candidate.zenith_rad.sin() * candidate.azimuth_rad.cos(),
                        candidate.zenith_rad.cos(),
                    );
                    a.dot(&b) > (0.02 * crate::DEG).cos()
                }
            }) {
                continue;
            }
            pairs.push(candidate);
        }
        if pairs.len() < start.model.parameter_count().max(6) {
            break;
        }
        let result = fit(&calibration, &pairs, max_iterations)?;
        if result.rms_px >= radius * 0.6 {
            break;
        }
        // A dense catalogue and many detections produce accidental close
        // pairs even for the wrong pointing. Require excess tight support
        // above the random-overlap expectation before accepting the fit.
        let tight_radius = radius.min(3.0);
        let in_view = sky
            .iter()
            .filter(|star| {
                result
                    .calibration
                    .project(star.azimuth_rad, star.zenith_rad)
                    .is_some_and(|pixel| {
                        pixel[0] >= 0.0
                            && pixel[1] >= 0.0
                            && pixel[0] < f64::from(start.width)
                            && pixel[1] < f64::from(start.height)
                    })
            })
            .count();
        let area = f64::from(start.width) * f64::from(start.height);
        let occupancy = 1.0
            - (-(in_view as f64) * std::f64::consts::PI * tight_radius * tight_radius / area).exp();
        let expected = detections.len() as f64 * occupancy;
        let threshold = (expected + 5.0 * (expected + 1.0).sqrt()).ceil() as usize;
        let tight = pairs
            .iter()
            .filter(|pair| {
                result
                    .calibration
                    .project(pair.azimuth_rad, pair.zenith_rad)
                    .is_some_and(|pixel| {
                        (pixel[0] - pair.x_px).hypot(pixel[1] - pair.y_px) <= tight_radius
                    })
            })
            .count();
        if tight < threshold.max(start.model.parameter_count() + 2) {
            break;
        }
        radius = (result.rms_px * 3.0).clamp(2.0, radius.max(2.0));
        calibration = result.calibration.clone();
        accepted = Some((result, pairs));
    }
    accepted.ok_or_else(|| {
        "no reliable association; align the initial model or add manual pairs first".into()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bundled_catalog_preserves_binary_layout_and_magnitude_order() {
        let stars = tycho_catalog().unwrap();
        assert_eq!(stars.len(), 42072);
        assert!(stars
            .windows(2)
            .all(|pair| pair[0].magnitude <= pair[1].magnitude));
        assert!(parse_catalog(b"WISCAT1\0").is_err());
    }

    #[test]
    fn real_saved_calibration_keeps_pixel_coordinates_and_roundtrips_export() {
        let job = parse_job(include_str!(
            "../../../test_cases/BACC_NYA_20200218_010731/case.json"
        ))
        .unwrap();
        assert_eq!(job.pairs.len(), 50);
        let radii: Vec<_> = job
            .pairs
            .iter()
            .map(|pair| {
                let pixel = job
                    .initial
                    .project(pair.azimuth_rad, pair.zenith_rad)
                    .unwrap();
                (pixel[0] - pair.x_px).hypot(pixel[1] - pair.y_px)
            })
            .collect();
        let rms =
            (radii.iter().map(|radius| radius * radius).sum::<f64>() / radii.len() as f64).sqrt();
        assert!((rms - 1.386361152883242).abs() < 1e-9, "{rms}");
        let result = FitResult {
            calibration: job.initial.clone(),
            rms_px: rms,
            iterations: 1,
        };
        let document = CalibrationDocument::from_fit(&result, &job).unwrap();
        let restored = parse_job(&serde_json::to_string(&document).unwrap()).unwrap();
        assert_eq!(restored.pairs.len(), job.pairs.len());
        assert_eq!(restored.initial.optpar, job.initial.optpar);
    }

    #[test]
    fn associations_are_unique_and_wrong_seed_fails() {
        let calibration = Calibration {
            width: 1024,
            height: 768,
            model: OpticalModel::Sine,
            optpar: vec![1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.35],
        };
        let sky: Vec<_> = (0..20)
            .map(|index| SkyStar {
                catalog_index: index,
                azimuth_rad: index as f64 * 0.31,
                zenith_rad: 0.2 + index as f64 * 0.025,
                magnitude: 2.0,
            })
            .collect();
        let mut detections: Vec<_> = sky
            .iter()
            .map(|star| {
                let pixel = calibration
                    .project(star.azimuth_rad, star.zenith_rad)
                    .unwrap();
                Detection {
                    x: pixel[0],
                    y: pixel[1],
                    flux: 100.0,
                }
            })
            .collect();
        detections.push(detections[0]);
        let pairs = associate(&calibration, &detections, &sky, 5.0).unwrap();
        assert_eq!(pairs.len(), 20);
        let measured = [StarPair {
            x_px: pairs[0].x_px + 0.1,
            ..pairs[0]
        }];
        let (_, expanded) =
            automatic_fit_preserving(&calibration, &detections, &sky, &measured, 5.0, 300).unwrap();
        assert_eq!(expanded[0], measured[0]);
        assert_eq!(expanded.len(), 20);
        let (fit, pairs) = automatic_fit(&calibration, &detections, &sky, 5.0, 300).unwrap();
        assert!(fit.rms_px < 1e-7);
        assert_eq!(pairs.len(), 20);
        for detection in &mut detections {
            detection.x += 3000.0;
        }
        assert!(automatic_fit(&calibration, &detections, &sky, 5.0, 300).is_err());
    }
}
