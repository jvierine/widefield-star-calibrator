//! HDF5 products written directly in Rust on both native and WASM targets.
use crate::{
    geometry::pixel_to_azimuth_zenith,
    workflow::{parse_job, CalibrationDocument, FitJob, Observation},
    Calibration, FitResult, RAD,
};
use hdf5_pure::{AttrValue, File, FileBuilder};

fn metadata(
    builder: &mut FileBuilder,
    calibration: &Calibration,
    observation: Option<&Observation>,
) {
    builder.set_attr("creator", AttrValue::String("WISC Rust".into()));
    builder.set_attr("image_width", AttrValue::I32(calibration.width as i32));
    builder.set_attr("image_height", AttrValue::I32(calibration.height as i32));
    builder.set_attr(
        "optmod",
        AttrValue::I32(i32::from(u8::from(calibration.model))),
    );
    builder.set_attr("optpar", AttrValue::F64Array(calibration.optpar.clone()));
    builder.set_attr(
        "model_coordinates",
        AttrValue::String("raw_image_pixel_centers".into()),
    );
    let mut parameters = vec![f64::from(u8::from(calibration.model))];
    parameters.extend(&calibration.optpar);
    builder.set_attr("optpar_with_optmod", AttrValue::F64Array(parameters));
    if let Some(observation) = observation {
        builder.set_attr("site_lat_deg", AttrValue::F64(observation.latitude_deg));
        builder.set_attr("site_lon_deg", AttrValue::F64(observation.longitude_deg));
        builder.set_attr("unix_millis", AttrValue::I64(observation.unix_millis));
        if let Some(date) = chrono::DateTime::from_timestamp_millis(observation.unix_millis) {
            builder.set_attr(
                "timestamp_utc",
                AttrValue::String(date.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
            );
        }
    }
}

/// Compact model and measured pairs; large coordinate arrays are separate.
pub fn calibration_hdf5(job: &FitJob, result: Option<&FitResult>) -> Result<Vec<u8>, String> {
    let calibration = result
        .map(|result| &result.calibration)
        .unwrap_or(&job.initial);
    calibration.validate()?;
    let mut builder = FileBuilder::new();
    metadata(&mut builder, calibration, job.observation.as_ref());
    builder
        .create_dataset("wisc_optpar")
        .with_f64_data(&calibration.optpar);
    let mut parameters = vec![f64::from(u8::from(calibration.model))];
    parameters.extend(&calibration.optpar);
    builder
        .create_dataset("wisc_optpar_with_optmod")
        .with_f64_data(&parameters);
    if !job.pairs.is_empty() {
        let values: Vec<_> = job
            .pairs
            .iter()
            .flat_map(|pair| [pair.azimuth_rad, pair.zenith_rad, pair.x_px, pair.y_px])
            .collect();
        builder
            .create_dataset("star_pairs")
            .with_f64_data(&values)
            .with_shape(&[job.pairs.len() as u64, 4])
            .set_attr(
                "columns",
                AttrValue::StringArray(vec![
                    "azimuth_rad".into(),
                    "zenith_rad".into(),
                    "x_px".into(),
                    "y_px".into(),
                ]),
            );
    }
    let json = if let Some(result) = result {
        let document = CalibrationDocument::from_fit(result, job)?;
        let values: Vec<_> = document.residuals_px.iter().flatten().copied().collect();
        if !values.is_empty() {
            builder
                .create_dataset("residuals_px")
                .with_f64_data(&values)
                .with_shape(&[document.pairs.len() as u64, 2]);
        }
        builder
            .create_dataset("rms_px")
            .with_f64_data(&[result.rms_px]);
        serde_json::to_vec(&document)
    } else {
        serde_json::to_vec(job)
    }
    .map_err(|error| error.to_string())?;
    builder
        .create_dataset("calibration_json")
        .with_u8_data(&json)
        .set_attr("encoding", AttrValue::String("UTF-8".into()));
    builder.finish().map_err(|error| error.to_string())
}

/// Full pixel-corner grid, preserving the legacy pcolormesh contract:
/// [height+1,width+1], from (-0.5,-0.5) to (width-0.5,height-0.5).
pub fn azel_hdf5(
    calibration: &Calibration,
    observation: Option<&Observation>,
) -> Result<Vec<u8>, String> {
    calibration.validate()?;
    let width = u64::from(calibration.width) + 1;
    let height = u64::from(calibration.height) + 1;
    let count = width
        .checked_mul(height)
        .filter(|count| *count <= 64_000_000)
        .ok_or("coordinate grid is too large")?;
    let mut builder = FileBuilder::new();
    metadata(&mut builder, calibration, observation);
    let mut azimuth = Vec::with_capacity(count as usize);
    let mut elevation = Vec::with_capacity(count as usize);
    for y in 0..height {
        for x in 0..width {
            let sky = pixel_to_azimuth_zenith(calibration, [x as f64 - 0.5, y as f64 - 0.5]);
            azimuth.push(sky.map(|[az, _]| (az * RAD) as f32).unwrap_or(f32::NAN));
            elevation.push(
                sky.map(|[_, ze]| (90.0 - ze * RAD) as f32)
                    .unwrap_or(f32::NAN),
            );
        }
    }
    for (name, data) in [("azimuth_deg", azimuth), ("elevation_deg", elevation)] {
        builder
            .create_dataset(name)
            .with_f32_data(&data)
            .with_shape(&[height, width])
            .with_chunks(&[height.min(128), width.min(128)])
            .with_deflate(4)
            .set_attr("units", AttrValue::String("degree".into()));
    }
    builder.set_attr("coordinate_grid_width", AttrValue::U64(width));
    builder.set_attr("coordinate_grid_height", AttrValue::U64(height));
    builder.set_attr("pixel_corner_x_start", AttrValue::F64(-0.5));
    builder.set_attr("pixel_corner_y_start", AttrValue::F64(-0.5));
    builder.set_attr("pixel_corner_step", AttrValue::F64(1.0));
    builder.set_attr("description",AttrValue::String("Azimuth/elevation at raw image pixel corners in degrees; shape [image_height+1,image_width+1], compatible with pcolormesh.".into()));
    builder.finish().map_err(|error| error.to_string())
}

pub fn import_job(bytes: &[u8]) -> Result<FitJob, String> {
    if bytes.starts_with(b"\x89HDF\r\n\x1a\n") {
        let file = File::from_bytes(bytes.to_vec()).map_err(|error| error.to_string())?;
        if let Ok(dataset) = file.dataset("calibration_json") {
            let json = dataset.read_u8().map_err(|error| error.to_string())?;
            parse_job(std::str::from_utf8(&json).map_err(|error| error.to_string())?)
        } else {
            import_legacy_hdf5(&file)
        }
    } else {
        parse_job(std::str::from_utf8(bytes).map_err(|error| error.to_string())?)
    }
}

/// Legacy compact products contain measured one-based row/column positions,
/// not the model positions. Preserve that distinction and trust named columns,
/// never their accidental order in a particular writer version.
fn import_legacy_hdf5(file: &File) -> Result<FitJob, String> {
    let attrs = file.root().attrs().map_err(|error| error.to_string())?;
    let text = |key: &str| attrs.get(key).and_then(AttrValue::as_str);
    let number = |key: &str| -> Result<f64, String> {
        attrs
            .get(key)
            .and_then(|value| {
                value
                    .as_f64()
                    .or_else(|| value.as_i64().map(|v| v as f64))
                    .or_else(|| value.as_u64().map(|v| v as f64))
            })
            .filter(|v| v.is_finite())
            .ok_or_else(|| format!("missing or invalid HDF5 {key}"))
    };
    let dimension = |key: &str| -> Result<u32, String> {
        let n = number(key)?;
        if n < 1.0 || n > u32::MAX as f64 || n.fract() != 0.0 {
            return Err(format!("invalid HDF5 {key}"));
        }
        Ok(n as u32)
    };
    if text("observer_mode") == Some("spacecraft") || attrs.contains_key("spacecraft_observation") {
        return Err("spacecraft HDF5 requires the spacecraft workflow; refusing a ground-observer conversion".into());
    }
    if text("model_coordinates") != Some("raw_image_pixel_centers") {
        return Err(
            "legacy HDF5 lacks an unambiguous raw-image model coordinate convention".into(),
        );
    }
    let mut parameters = match file.dataset("best_fit_wisc_optpar_with_optmod") {
        Ok(dataset) => dataset.read_f64().map_err(|error| error.to_string())?,
        Err(_) => match file.dataset("wisc_optpar_with_optmod") {
            Ok(dataset) => dataset.read_f64().map_err(|error| error.to_string())?,
            Err(_) => {
                let mut parameters = vec![number("optmod")?];
                parameters.extend(
                    file.dataset("wisc_optpar")
                        .and_then(|d| d.read_f64())
                        .map_err(|error| error.to_string())?,
                );
                parameters
            }
        },
    };
    if parameters.is_empty()
        || !parameters[0].is_finite()
        || parameters[0].fract() != 0.0
        || !(1.0..=255.0).contains(&parameters[0])
    {
        return Err("invalid HDF5 optical model".into());
    }
    let model = crate::OpticalModel::try_from(parameters.remove(0) as u8)?;
    let observation = if let Some(timestamp) = text("timestamp_utc").filter(|s| !s.is_empty()) {
        Some(Observation {
            unix_millis: chrono::DateTime::parse_from_rfc3339(timestamp)
                .map_err(|error| error.to_string())?
                .timestamp_millis(),
            latitude_deg: number("site_lat_deg")?,
            longitude_deg: number("site_lon_deg")?,
        })
    } else {
        None
    };
    let mut pairs = Vec::new();
    if let Ok(dataset) = file.dataset("selected_stars") {
        let columns: Vec<_> = text("selected_star_columns")
            .ok_or("missing HDF5 selected_star_columns")?
            .split_whitespace()
            .collect();
        let column = |key: &str| {
            columns
                .iter()
                .position(|name| *name == key)
                .ok_or_else(|| format!("missing selected-star column {key}"))
        };
        let (x, y, az, alt) = (
            column("star_col_px_1based")?,
            column("star_row_px_1based")?,
            column("azimuth_deg")?,
            column("altitude_deg")?,
        );
        let included = columns.iter().position(|key| *key == "included_in_fit");
        let shape = dataset.shape().map_err(|error| error.to_string())?;
        if shape.len() != 2 || shape[1] != columns.len() as u64 || shape[0] > 10_000 {
            return Err("invalid HDF5 selected-star table shape".into());
        }
        let values = dataset.read_f64().map_err(|error| error.to_string())?;
        if values.len() != shape[0] as usize * columns.len() {
            return Err("truncated HDF5 selected-star table".into());
        }
        for row in values.chunks_exact(columns.len()) {
            if let Some(index) = included {
                if row[index] != 0.0 && row[index] != 1.0 {
                    return Err("invalid HDF5 included_in_fit flag".into());
                }
                if row[index] == 0.0 {
                    continue;
                }
            }
            if ![row[x], row[y], row[az], row[alt]]
                .iter()
                .all(|v| v.is_finite())
                || !(-90.0..=90.0).contains(&row[alt])
            {
                return Err("invalid HDF5 selected-star coordinates".into());
            }
            pairs.push(crate::StarPair {
                x_px: row[x] - 1.0,
                y_px: row[y] - 1.0,
                azimuth_rad: row[az] * crate::DEG,
                zenith_rad: (90.0 - row[alt]) * crate::DEG,
            });
        }
    }
    let job = FitJob {
        initial: Calibration {
            width: dimension("image_width")?,
            height: dimension("image_height")?,
            model,
            optpar: parameters,
        },
        pairs,
        observation,
    };
    // Use the same scientific validation as JSON and Rust-HDF5 imports.
    parse_job(&serde_json::to_string(&job).map_err(|error| error.to_string())?)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn legacy_fixture(coordinates: &str, spacecraft: bool) -> Vec<u8> {
        let mut builder = FileBuilder::new();
        builder.set_attr("image_width", AttrValue::I32Array(vec![1024]));
        builder.set_attr("image_height", AttrValue::I32Array(vec![768]));
        builder.set_attr("model_coordinates", AttrValue::String(coordinates.into()));
        builder.set_attr(
            "timestamp_utc",
            AttrValue::String("2020-02-18T01:07:31Z".into()),
        );
        builder.set_attr("site_lat_deg", AttrValue::F64Array(vec![78.9]));
        builder.set_attr("site_lon_deg", AttrValue::F64Array(vec![11.9]));
        if spacecraft {
            builder.set_attr("observer_mode", AttrValue::String("spacecraft".into()));
        }
        let mut parameters = vec![2.0];
        parameters.extend(crate::default_optpar(1024, 768, crate::OpticalModel::Sine));
        builder
            .create_dataset("wisc_optpar_with_optmod")
            .with_f64_data(&parameters);
        builder.set_attr(
            "selected_star_columns",
            AttrValue::String(
                "star_col_px_1based altitude_deg included_in_fit star_row_px_1based azimuth_deg"
                    .into(),
            ),
        );
        builder
            .create_dataset("selected_stars")
            .with_f64_data(&[
                101.25, 45.0, 1.0, 201.75, 180.0, 400.0, 50.0, 0.0, 300.0, 270.0,
            ])
            .with_shape(&[2, 5]);
        builder.finish().unwrap()
    }
    #[test]
    fn legacy_hdf5_import_uses_named_measured_columns_and_one_based_pixels() {
        let job = import_job(&legacy_fixture("raw_image_pixel_centers", false)).unwrap();
        assert_eq!((job.initial.width, job.initial.height), (1024, 768));
        assert_eq!(job.pairs.len(), 1);
        assert_eq!([job.pairs[0].x_px, job.pairs[0].y_px], [100.25, 200.75]);
        assert!((job.pairs[0].azimuth_rad - std::f64::consts::PI).abs() < 1e-12);
        assert!((job.pairs[0].zenith_rad - std::f64::consts::FRAC_PI_4).abs() < 1e-12);
        assert_eq!(job.observation.unwrap().latitude_deg, 78.9);
    }
    #[test]
    fn legacy_hdf5_rejects_ambiguous_coordinates_and_spacecraft_frames() {
        assert!(import_job(&legacy_fixture("display", false))
            .unwrap_err()
            .contains("coordinate convention"));
        assert!(import_job(&legacy_fixture("raw_image_pixel_centers", true))
            .unwrap_err()
            .contains("spacecraft"));
    }
    #[test]
    fn compact_hdf5_roundtrips_full_precision_model_and_measurements() {
        let job = parse_job(include_str!(
            "../../../test_cases/BACC_NYA_20200218_010731/case.json"
        ))
        .unwrap();
        let bytes = calibration_hdf5(&job, None).unwrap();
        let restored = import_job(&bytes).unwrap();
        assert_eq!(restored.initial, job.initial);
        assert_eq!(restored.pairs, job.pairs);
        assert_eq!(restored.observation, job.observation);
    }
    #[test]
    fn corner_grid_has_full_outer_boundaries_and_expected_shape() {
        let calibration = Calibration {
            width: 8,
            height: 6,
            model: crate::OpticalModel::Sine,
            optpar: crate::default_optpar(8, 6, crate::OpticalModel::Sine),
        };
        let file = File::from_bytes(azel_hdf5(&calibration, None).unwrap()).unwrap();
        let dataset = file.dataset("azimuth_deg").unwrap();
        let values = dataset.read_f32().unwrap();
        assert_eq!(values.len(), 9 * 7);
        let expected = pixel_to_azimuth_zenith(&calibration, [-0.5, -0.5]).unwrap()[0] * RAD;
        assert!((f64::from(values[0]) - expected).abs() < 1e-5);
        let expected = pixel_to_azimuth_zenith(&calibration, [7.5, 5.5]).unwrap()[0] * RAD;
        assert!((f64::from(values[62]) - expected).abs() < 1e-5);
    }
}
