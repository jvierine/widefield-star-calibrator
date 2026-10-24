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
        let json = file
            .dataset("calibration_json")
            .and_then(|dataset| dataset.read_u8())
            .map_err(|error| format!("not a Rust WISC calibration HDF5: {error}"))?;
        parse_job(std::str::from_utf8(&json).map_err(|error| error.to_string())?)
    } else {
        parse_job(std::str::from_utf8(bytes).map_err(|error| error.to_string())?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
