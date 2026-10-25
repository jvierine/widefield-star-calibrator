//! Portable, image-bound calibration sessions and legacy interchange.
use crate::{
    precess_j2000,
    workflow::{parse_job, FitJob, Observation},
    DEG, RAD,
};
use nalgebra::{Matrix3, Vector3};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const SCHEMA: &str = "wisc.session/v1";

pub fn image_digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Session {
    pub schema: String,
    pub image_sha256: String,
    pub image_name: String,
    pub job: FitJob,
    #[serde(default)]
    pub metadata: Value,
    #[serde(default)]
    pub display: Value,
    #[serde(default)]
    pub masked_tiles: Vec<[u32; 2]>,
}

impl Session {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema != SCHEMA {
            return Err("unsupported calibration session version".into());
        }
        if self.image_sha256.len() != 64
            || !self.image_sha256.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("invalid session image digest".into());
        }
        parse_job(&serde_json::to_string(&self.job).map_err(|e| e.to_string())?)?;
        validate_metadata(
            &self.metadata,
            self.job.initial.width,
            self.job.initial.height,
        )?;
        validate_display(&self.display)?;
        if self.masked_tiles.len() > 100_000
            || self.masked_tiles.iter().any(|tile| {
                tile[0] >= self.job.initial.width.div_ceil(128)
                    || tile[1] >= self.job.initial.height.div_ceil(128)
            })
        {
            return Err("session contains invalid detection-mask tiles".into());
        }
        Ok(())
    }
    pub fn verify_image(&self, bytes: &[u8], width: u32, height: u32) -> Result<(), String> {
        self.validate()?;
        if self.job.initial.width != width
            || self.job.initial.height != height
            || self.image_sha256 != image_digest(bytes)
        {
            return Err(
                "session belongs to a different image; measured stars were not restored".into(),
            );
        }
        Ok(())
    }
}

/// Validate imported UI state before replacing any current image or selections.
pub fn validate_display(display: &Value) -> Result<(), String> {
    if !display.is_null() && !display.is_object() {
        return Err("session display must be an object".into());
    }
    for (key, low, high) in [
        ("brightness", -1.0, 1.0),
        ("contrast", 0.1, 10.0),
        ("gammaDisplay", 0.1, 4.0),
        ("highPassSigma", 0.1, 300.0),
        ("displayClip", 0.0, 50.0),
        ("zoom", 1.0, 16.0),
        ("magnitude", -10.0, 30.0),
        ("matchRadius", 0.01, 1e6),
        ("altitude", -1e6, 1e12),
    ] {
        if let Some(value) = display.get(key) {
            if !value
                .as_f64()
                .is_some_and(|v| v.is_finite() && (low..=high).contains(&v))
            {
                return Err(format!("invalid session display {key}"));
            }
        }
    }
    for key in [
        "highPass",
        "showGrid",
        "showResiduals",
        "kdePick",
        "magnifier",
        "showCelestial",
        "showNames",
        "showDetections",
        "imageFlipX",
        "imageFlipY",
        "show_image",
        "show_markers",
        "pure_view",
    ] {
        if display.get(key).is_some_and(|v| !v.is_boolean()) {
            return Err(format!("invalid session flag {key}"));
        }
    }
    for (key, values) in [
        ("fitsByteOrder", &["auto", "big", "little"][..]),
        ("catalogue", &["tycho2", "yale", "td1"][..]),
    ] {
        if display
            .get(key)
            .is_some_and(|v| !v.as_str().is_some_and(|s| values.contains(&s)))
        {
            return Err(format!("invalid session {key}"));
        }
    }
    if let Some(center) = display.get("center") {
        if !center.as_array().is_some_and(|a| {
            a.len() == 2
                && a.iter().all(|v| {
                    v.as_f64()
                        .is_some_and(|n| n.is_finite() && (0.0..=1.0).contains(&n))
                })
        }) {
            return Err("invalid session viewport centre".into());
        }
    }
    Ok(())
}

pub fn validate_metadata(metadata: &Value, width: u32, height: u32) -> Result<(), String> {
    let root = metadata.get("testCase").unwrap_or(metadata);
    if let Some(settings) = root.get("gaiaSettings") {
        crate::gaia::validate(settings)?;
    }
    if let Some(tiles) = root.get("rustMaskedTiles") {
        let tiles: Vec<[u32; 2]> =
            serde_json::from_value(tiles.clone()).map_err(|_| "invalid saved detection mask")?;
        if tiles.len() > 100_000
            || tiles
                .iter()
                .any(|t| t[0] >= width.div_ceil(128) || t[1] >= height.div_ceil(128))
        {
            return Err("saved detection mask is outside the image".into());
        }
    }
    if let Some(value) = root.pointer("/display/highPassWidthPx") {
        if !value
            .as_f64()
            .is_some_and(|v| v.is_finite() && (0.1..=300.0).contains(&v))
        {
            return Err("invalid saved Gaussian width".into());
        }
    }
    if let Some(value) = root.pointer("/display/displayClipPercent") {
        if !value
            .as_f64()
            .is_some_and(|v| v.is_finite() && (0.0..=50.0).contains(&v))
        {
            return Err("invalid saved display clipping".into());
        }
    }
    Ok(())
}

/// Inverse of WISC's J2000-precession + unrefracted local-horizontal transform.
/// Unit-vector inversion avoids RA wrap and declination-pole singularities.
pub fn azze_to_radec(az: f64, ze: f64, observation: &Observation) -> Result<[f64; 2], String> {
    observation.validate()?;
    if !az.is_finite() || !ze.is_finite() || !(0.0..=std::f64::consts::PI).contains(&ze) {
        return Err("invalid sky direction".into());
    }
    let jd = crate::julian_date(observation.unix_millis);
    let t = (jd - 2_451_545.0) / 36_525.0;
    let sidereal =
        (280.460_618_37 + 360.985_647_366_29 * (jd - 2_451_545.0) + 0.000_387_933 * t * t
            - t * t * t / 38_710_000.0
            + observation.longitude_deg)
            * DEG;
    let lat = observation.latitude_deg * DEG;
    let (east, north, up) = (ze.sin() * az.sin(), ze.sin() * az.cos(), ze.cos());
    let dec = (north * lat.cos() + up * lat.sin()).clamp(-1.0, 1.0).asin();
    let ra = sidereal + east.atan2(up * lat.cos() - north * lat.sin());
    let direction = Vector3::new(dec.cos() * ra.cos(), dec.cos() * ra.sin(), dec.sin());
    let basis: Vec<_> = [(0.0, 0.0), (6.0, 0.0), (0.0, 90.0)]
        .iter()
        .map(|&(ra, dec)| {
            let [ra, dec] = precess_j2000(ra, dec, observation.unix_millis);
            Vector3::new(dec.cos() * ra.cos(), dec.cos() * ra.sin(), dec.sin())
        })
        .collect();
    let original = Matrix3::from_columns(&[basis[0], basis[1], basis[2]]).transpose() * direction;
    Ok([
        (original.y.atan2(original.x) * RAD / 15.0).rem_euclid(24.0),
        original.z.clamp(-1.0, 1.0).asin() * RAD,
    ])
}

/// Keep unknown legacy metadata and exact original star identities. All optical
/// parameters and measured coordinates in the output come from the current job.
pub fn legacy_document(job: &FitJob, original: &Value) -> Result<Value, String> {
    parse_job(&serde_json::to_string(job).map_err(|e| e.to_string())?)?;
    let source = original.get("testCase").unwrap_or(original);
    let mut out = source.as_object().cloned().unwrap_or_default();
    for key in [
        "initial",
        "calibration",
        "pairs",
        "observation",
        "schema",
        "solved",
        "rms_px",
        "iterations",
        "residuals_px",
    ] {
        out.remove(key);
    }
    let mut parameters = vec![f64::from(u8::from(job.initial.model))];
    parameters.extend(&job.initial.optpar);
    out.insert("width".into(), json!(job.initial.width));
    out.insert("height".into(), json!(job.initial.height));
    out.insert("optpar".into(), json!(parameters));
    out.insert("modelCoordinates".into(), json!("raw_image_pixel_centers"));
    if let Some(observation) = &job.observation {
        out.insert(
            "timestampUtc".into(),
            json!(
                chrono::DateTime::from_timestamp_millis(observation.unix_millis)
                    .ok_or("invalid observation date")?
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            ),
        );
        out.insert("latDeg".into(), json!(observation.latitude_deg));
        out.insert("lonDeg".into(), json!(observation.longitude_deg));
    } else {
        for key in ["timestampUtc", "latDeg", "lonDeg"] {
            out.remove(key);
        }
    }
    let original_pairs = source.get("matches").and_then(Value::as_array);
    let mut matches = Vec::with_capacity(job.pairs.len());
    for (i, pair) in job.pairs.iter().enumerate() {
        let old = original_pairs.and_then(|rows| {
            rows.iter().find(|row| {
                let direction = row.get("catalog").and_then(|catalog| {
                    if let (Some(az), Some(ze)) = (
                        catalog.get("az").and_then(Value::as_f64),
                        catalog.get("ze").and_then(Value::as_f64),
                    ) {
                        Some([az, ze])
                    } else if let (Some(ra), Some(dec), Some(obs)) = (
                        catalog.get("raHours").and_then(Value::as_f64),
                        catalog.get("decDeg").and_then(Value::as_f64),
                        job.observation.as_ref(),
                    ) {
                        Some(crate::radec_to_azimuth_zenith(
                            ra,
                            dec,
                            obs.unix_millis,
                            obs.latitude_deg,
                            obs.longitude_deg,
                        ))
                    } else {
                        None
                    }
                });
                if !direction.is_some_and(|[az, ze]| {
                    ((az - pair.azimuth_rad).sin()).abs() < 1e-8
                        && (az - pair.azimuth_rad).cos() > 0.0
                        && (ze - pair.zenith_rad).abs() < 1e-8
                }) {
                    return false;
                }
                row.pointer("/image/x")
                    .and_then(Value::as_f64)
                    .is_some_and(|x| (x - pair.x_px).abs() < 1e-8)
                    && row
                        .pointer("/image/y")
                        .and_then(Value::as_f64)
                        .is_some_and(|y| (y - pair.y_px).abs() < 1e-8)
            })
        });
        let mut row = old.and_then(Value::as_object).cloned().unwrap_or_default();
        row.entry("id").or_insert(json!(i + 1));
        row.insert(
            "image".into(),
            json!({"x":pair.x_px,"y":pair.y_px,"method":"Rust measured pixel centre"}),
        );
        let mut catalog = old
            .and_then(|r| r.get("catalog"))
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        catalog.insert("az".into(), json!(pair.azimuth_rad));
        catalog.insert("ze".into(), json!(pair.zenith_rad));
        if !catalog.contains_key("raHours") || !catalog.contains_key("decDeg") {
            if let Some(observation) = &job.observation {
                let [ra, dec] = azze_to_radec(pair.azimuth_rad, pair.zenith_rad, observation)?;
                catalog.insert("raHours".into(), json!(ra));
                catalog.insert("decDeg".into(), json!(dec));
            }
        }
        catalog
            .entry("name")
            .or_insert(json!(format!("Star {}", i + 1)));
        row.insert("catalog".into(), Value::Object(catalog));
        matches.push(Value::Object(row));
    }
    out.insert("matches".into(), Value::Array(matches));
    out.remove("residual");
    let mut norms = Vec::new();
    for pair in &job.pairs {
        let pixel = job
            .initial
            .project(pair.azimuth_rad, pair.zenith_rad)
            .ok_or("model cannot project all selected stars")?;
        norms.push((pixel[0] - pair.x_px).hypot(pixel[1] - pair.y_px));
    }
    if !norms.is_empty() {
        let rms = (norms.iter().map(|r| r * r).sum::<f64>() / norms.len() as f64).sqrt();
        let median = crate::median(&mut norms);
        out.insert(
            "residual".into(),
            json!({"count":norms.len(),"rmsPx":rms,"medianPx":median,"maxPx":norms.last()}),
        );
    }
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn job() -> FitJob {
        parse_job(include_str!(
            "../../../test_cases/BACC_NYA_20200218_010731/case.json"
        ))
        .unwrap()
    }
    #[test]
    fn inverse_sky_transform_roundtrips_epochs_and_near_poles() {
        for date in [0, 1_582_000_000_000, 1_790_000_000_000] {
            let observation = Observation {
                unix_millis: date,
                latitude_deg: 78.9,
                longitude_deg: 11.9,
            };
            for (ra, dec) in [(0.001, -45.0), (23.999, 89.0), (12.5, 0.0), (3.2, -89.0)] {
                let [az, ze] = crate::radec_to_azimuth_zenith(
                    ra,
                    dec,
                    date,
                    observation.latitude_deg,
                    observation.longitude_deg,
                );
                let actual = azze_to_radec(az, ze, &observation).unwrap();
                assert!((actual[0] - ra).abs() < 1e-8, "{actual:?}");
                assert!((actual[1] - dec).abs() < 1e-8);
            }
        }
    }
    #[test]
    fn legacy_export_keeps_star_names_extra_metadata_and_exact_measurements() {
        let original: Value = serde_json::from_str(include_str!(
            "../../../test_cases/BACC_NYA_20200218_010731/case.json"
        ))
        .unwrap();
        let job = job();
        let exported = legacy_document(&job, &original).unwrap();
        assert_eq!(
            exported["matches"][0]["catalog"]["name"],
            original["testCase"]["matches"][0]["catalog"]["name"]
        );
        assert_eq!(exported["altM"], original["testCase"]["altM"]);
        let imported = parse_job(&exported.to_string()).unwrap();
        assert_eq!(imported.pairs, job.pairs);
        assert_eq!(imported.initial, job.initial);
        assert_eq!(imported.observation, job.observation);
    }
    #[test]
    fn same_size_wrong_image_cannot_restore_session() {
        let session = Session {
            schema: SCHEMA.into(),
            image_sha256: image_digest(b"right"),
            image_name: "image.png".into(),
            job: job(),
            metadata: Value::Null,
            display: Value::Null,
            masked_tiles: vec![[1, 1]],
        };
        session.verify_image(b"right", 608, 608).unwrap();
        assert!(session.verify_image(b"wrong", 608, 608).is_err());
        assert!(session.verify_image(b"right", 609, 608).is_err());
    }
    #[test]
    fn changing_a_pair_identity_does_not_reuse_the_old_star_at_the_same_pixel() {
        let original: Value = serde_json::from_str(include_str!(
            "../../../test_cases/BACC_NYA_20200218_010731/case.json"
        ))
        .unwrap();
        let mut job = job();
        job.pairs[0].azimuth_rad += 0.02;
        let exported = legacy_document(&job, &original).unwrap();
        assert_eq!(exported["matches"][0]["catalog"]["name"], "Star 1");
        let obs = job.observation.as_ref().unwrap();
        let ra = exported["matches"][0]["catalog"]["raHours"]
            .as_f64()
            .unwrap();
        let dec = exported["matches"][0]["catalog"]["decDeg"]
            .as_f64()
            .unwrap();
        let [az, ze] = crate::radec_to_azimuth_zenith(
            ra,
            dec,
            obs.unix_millis,
            obs.latitude_deg,
            obs.longitude_deg,
        );
        assert!((az - job.pairs[0].azimuth_rad).abs() < 1e-8);
        assert!((ze - job.pairs[0].zenith_rad).abs() < 1e-8);
    }
}
