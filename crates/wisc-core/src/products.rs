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
    encode_calibration(job, result, None, None)
}

pub fn calibration_with_metadata_hdf5(
    job: &FitJob,
    result: Option<&FitResult>,
    metadata: &serde_json::Value,
) -> Result<Vec<u8>, String> {
    encode_calibration(job, result, None, Some(metadata))
}

pub fn session_hdf5(
    session: &crate::session::Session,
    result: Option<&FitResult>,
) -> Result<Vec<u8>, String> {
    session.validate()?;
    encode_calibration(&session.job, result, Some(session), None)
}

fn encode_calibration(
    job: &FitJob,
    result: Option<&FitResult>,
    session: Option<&crate::session::Session>,
    source_metadata: Option<&serde_json::Value>,
) -> Result<Vec<u8>, String> {
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
    builder
        .create_dataset("best_fit_wisc_optpar_with_optmod")
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
    let json = if let Some(source) = source_metadata {
        let mut document: serde_json::Value =
            serde_json::from_slice(&json).map_err(|e| e.to_string())?;
        document["source_metadata"] = source.clone();
        serde_json::to_vec(&document).map_err(|e| e.to_string())?
    } else {
        json
    };
    builder
        .create_dataset("calibration_json")
        .with_u8_data(&json)
        .set_attr("encoding", AttrValue::String("UTF-8".into()));
    if let Some(session) = session {
        rich_metadata(&mut builder, session, calibration)?;
    }
    builder.finish().map_err(|error| error.to_string())
}

fn rich_metadata(
    builder: &mut FileBuilder,
    session: &crate::session::Session,
    calibration: &Calibration,
) -> Result<(), String> {
    let mut session = session.clone();
    session.job.initial = calibration.clone();
    let legacy = crate::session::legacy_document(&session.job, &session.metadata)?;
    builder
        .create_dataset("session_json")
        .with_u8_data(&serde_json::to_vec(&session).map_err(|e| e.to_string())?);
    builder.set_attr("image_name", AttrValue::String(session.image_name.clone()));
    builder.set_attr(
        "image_sha256",
        AttrValue::String(session.image_sha256.clone()),
    );
    builder.set_attr(
        "site_alt_m",
        AttrValue::F64(
            session
                .display
                .get("altitude")
                .or_else(|| legacy.get("altM"))
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(0.0),
        ),
    );
    builder.set_attr(
        "recommended_camera_dataset",
        AttrValue::String("/best_fit_wisc_optpar_with_optmod".into()),
    );
    builder.set_attr("selected_star_columns",AttrValue::String("index included_in_fit altitude_deg azimuth_deg star_row_px_1based star_col_px_1based ra_hours_j2000 dec_deg_j2000 magnitude model_row_px_1based model_col_px_1based residual_row_px residual_col_px residual_norm_px".into()));
    builder.set_attr(
        "selected_star_count",
        AttrValue::I32(session.job.pairs.len() as i32),
    );
    builder.set_attr(
        "fit_star_count",
        AttrValue::I32(session.job.pairs.len() as i32),
    );
    builder.set_attr("image_coordinate_convention",AttrValue::String("Rows/columns are 1-based with (1,1) at the upper-left; row is vertical and column is horizontal.".into()));
    let mut stars = Vec::new();
    let mut names = Vec::new();
    let mut ids = Vec::new();
    let mut residuals = Vec::new();
    for (index, pair) in session.job.pairs.iter().enumerate() {
        let row = &legacy["matches"][index];
        let catalog = &row["catalog"];
        names.push(
            catalog
                .get("name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_owned(),
        );
        ids.push(row["id"].clone());
        let pixel = calibration
            .project(pair.azimuth_rad, pair.zenith_rad)
            .ok_or("invalid selected-star projection")?;
        let (dx, dy) = (pixel[0] - pair.x_px, pixel[1] - pair.y_px);
        let norm = dx.hypot(dy);
        let angle = crate::geometry::pixel_to_azimuth_zenith(calibration, [pair.x_px, pair.y_px])
            .map(|[az, ze]| {
                ((pair.zenith_rad.sin() * ze.sin() * (pair.azimuth_rad - az).cos()
                    + pair.zenith_rad.cos() * ze.cos())
                .clamp(-1.0, 1.0))
                .acos()
                    * RAD
            })
            .unwrap_or(f64::NAN);
        stars.extend([
            index as f64 + 1.0,
            1.0,
            90.0 - pair.zenith_rad * RAD,
            pair.azimuth_rad * RAD,
            pair.y_px + 1.0,
            pair.x_px + 1.0,
            catalog["raHours"].as_f64().unwrap_or(f64::NAN),
            catalog["decDeg"].as_f64().unwrap_or(f64::NAN),
            catalog["mag"].as_f64().unwrap_or(f64::NAN),
            pixel[1] + 1.0,
            pixel[0] + 1.0,
            dy,
            dx,
            norm,
        ]);
        residuals.extend([dy, dx, norm, angle]);
    }
    if !stars.is_empty() {
        builder
            .create_dataset("selected_stars")
            .with_f64_data(&stars)
            .with_shape(&[session.job.pairs.len() as u64, 14]);
        builder
            .create_dataset("best_fit_wisc_residuals")
            .with_f64_data(&residuals)
            .with_shape(&[session.job.pairs.len() as u64, 4]);
    }
    builder.set_attr(
        "selected_star_names",
        AttrValue::String(serde_json::to_string(&names).map_err(|e| e.to_string())?),
    );
    builder.set_attr(
        "selected_star_ids",
        AttrValue::String(serde_json::to_string(&ids).map_err(|e| e.to_string())?),
    );
    builder.set_attr(
        "miracle_residual_columns",
        AttrValue::String(
            "model_minus_observed_row_px model_minus_observed_col_px norm_px angular_error_deg"
                .into(),
        ),
    );
    for (field, key) in [
        ("imageFlipX", "flip_image_x"),
        ("imageFlipY", "flip_image_y"),
    ] {
        builder.set_attr(
            key,
            AttrValue::U8(u8::from(
                session
                    .display
                    .get(field)
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
            )),
        );
    }
    builder.set_attr("flip_overlay_x", AttrValue::U8(0));
    builder.set_attr("flip_overlay_y", AttrValue::U8(0));
    let native_rows = residuals.as_chunks::<4>().0.to_vec();
    let stats = crate::miracle::summary(&native_rows);
    let center = calibration
        .project(0.0, 0.0)
        .map(|p| [p[1] + 1.0, p[0] + 1.0])
        .unwrap_or([f64::NAN; 2]);
    builder
        .create_dataset("best_fit_wisc_summary")
        .with_f64_data(&[
            center[0],
            center[1],
            center[0] - (calibration.height as f64 + 1.0) / 2.0,
            center[1] - (calibration.width as f64 + 1.0) / 2.0,
            stats.rms_pixel.unwrap_or(f64::NAN),
            stats.std_pixel.unwrap_or(f64::NAN),
            stats.rms_angle_deg.unwrap_or(f64::NAN),
            stats.std_angle_deg.unwrap_or(f64::NAN),
        ]);
    builder.set_attr("best_fit_wisc_summary_names",AttrValue::String("Xc_zenithRow_px_1based Yc_zenithCol_px_1based Xc_offset_from_image_center_px Yc_offset_from_image_center_px rms_pixel_px std_pixel_px rms_angle_deg std_angle_deg".into()));
    match crate::miracle::product(&session.job) {
        Ok(product) => {
            let a = &product.equidistant;
            let b = &product.equisolid;
            let sa = &product.equidistant_summary;
            let sb = &product.equisolid_summary;
            let v = |n: Option<f64>| n.unwrap_or(f64::NAN);
            builder
                .create_dataset("miracle_parameters")
                .with_f64_data(&[
                    a.glat_deg,
                    a.glon_deg,
                    a.xc_px,
                    a.yc_px,
                    a.scale_px / RAD,
                    a.rotation_rad,
                ]);
            builder
                .create_dataset("miracle_equidistant_parameters")
                .with_f64_data(&[
                    a.glat_deg,
                    a.glon_deg,
                    a.xc_px,
                    a.yc_px,
                    a.center_offset_row_px,
                    a.center_offset_col_px,
                    a.scale_px,
                    a.scale_px / RAD,
                    a.rotation_rad,
                    v(sa.rms_pixel),
                    v(sa.std_pixel),
                    v(sa.rms_angle_deg),
                    v(sa.std_angle_deg),
                ]);
            builder
                .create_dataset("miracle_equisolid_parameters")
                .with_f64_data(&[
                    b.glat_deg,
                    b.glon_deg,
                    b.xc_px,
                    b.yc_px,
                    b.center_offset_row_px,
                    b.center_offset_col_px,
                    b.scale_px,
                    b.rotation_rad,
                    v(sb.rms_pixel),
                    v(sb.std_pixel),
                    v(sb.rms_angle_deg),
                    v(sb.std_angle_deg),
                ]);
            for (key, rows) in [
                (
                    "miracle_equidistant_residuals",
                    &product.equidistant_residuals,
                ),
                ("miracle_equisolid_residuals", &product.equisolid_residuals),
            ] {
                if !rows.is_empty() {
                    builder
                        .create_dataset(key)
                        .with_f64_data(&rows.iter().flatten().copied().collect::<Vec<_>>())
                        .with_shape(&[rows.len() as u64, 4]);
                }
            }
            builder.set_attr(
                "miracle_fit_source",
                AttrValue::String(a.fit_source.clone()),
            );
            builder.set_attr(
                "miracle_fit_sample_count",
                AttrValue::I32(a.sample_count as i32),
            );
            builder.set_attr(
                "miracle_equidistant_equation",
                AttrValue::String("d_px = k_equidistant_px_per_rad * z_rad".into()),
            );
            builder.set_attr(
                "miracle_equisolid_equation",
                AttrValue::String("d_px = k_equisolid_px * sin(z_rad / 2)".into()),
            );
            builder.set_attr("miracle_residual_statistics",AttrValue::String("RMS and population standard deviation (ddof=0) of residual norm in pixels and absolute angular residual in degrees.".into()));
            builder.set_attr(
                "miracle_pixel_error_rms_deg",
                AttrValue::F64(product.reference_rms_angle_deg),
            );
            builder.set_attr(
                "miracle_pixel_error_max_deg",
                AttrValue::F64(product.reference_max_angle_deg),
            );
            builder.set_attr("miracle_status",AttrValue::String("lower-accuracy compatibility approximations; native WISC model is authoritative".into()));
        }
        Err(error) => builder.set_attr(
            "miracle_status",
            AttrValue::String(format!("unavailable: {error}")),
        ),
    }
    Ok(())
}

pub fn read_session(bytes: &[u8]) -> Result<Option<crate::session::Session>, String> {
    if bytes.starts_with(b"PK\x03\x04") {
        return read_session(&crate::report::archive_calibration(bytes)?);
    }
    let session = if bytes.starts_with(b"\x89HDF\r\n\x1a\n") {
        let file = File::from_bytes(bytes.to_vec()).map_err(|e| e.to_string())?;
        if let Ok(dataset) = file.dataset("session_json") {
            Some(
                serde_json::from_slice::<crate::session::Session>(
                    &dataset.read_u8().map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string())?,
            )
        } else {
            None
        }
    } else {
        let mut value: serde_json::Value =
            serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
        if let Some(session) = value.get("session") {
            value = session.clone();
        }
        if value
            .get("schema")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|s| s.starts_with("wisc.session/"))
        {
            Some(serde_json::from_value(value).map_err(|e| e.to_string())?)
        } else {
            None
        }
    };
    if let Some(session) = &session {
        session.validate()?;
    }
    Ok(session)
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
    if bytes.starts_with(b"PK\x03\x04") {
        return import_job(&crate::report::archive_calibration(bytes)?);
    }
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

/// Recover legacy star identities and site/display metadata without pretending
/// that older products contain an image digest. Excluded rows remain in the
/// provenance table; only included measurements enter the fitting job.
pub fn source_metadata(bytes: &[u8]) -> Result<serde_json::Value, String> {
    use serde_json::{json, Value};
    if bytes.starts_with(b"PK\x03\x04") {
        return source_metadata(&crate::report::archive_calibration(bytes)?);
    }
    if let Some(session) = read_session(bytes)? {
        return Ok(session.metadata);
    }
    if !bytes.starts_with(b"\x89HDF\r\n\x1a\n") {
        let value: Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
        return Ok(value.get("source_metadata").unwrap_or(&value).clone());
    }
    let file = File::from_bytes(bytes.to_vec()).map_err(|e| e.to_string())?;
    if let Ok(dataset) = file.dataset("calibration_json") {
        let value: Value = serde_json::from_slice(&dataset.read_u8().map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        if let Some(metadata) = value.get("source_metadata") {
            return Ok(metadata.clone());
        }
    }
    let job = import_job(bytes)?;
    let mut metadata = crate::session::legacy_document(&job, &Value::Null)?;
    let attrs = file.root().attrs().map_err(|e| e.to_string())?;
    let number = |key: &str| {
        attrs.get(key).and_then(|v| {
            v.as_f64()
                .or_else(|| v.as_i64().map(|n| n as f64))
                .or_else(|| v.as_u64().map(|n| n as f64))
        })
    };
    if let Some(altitude) = number("site_alt_m").filter(|v| v.is_finite()) {
        metadata["altM"] = json!(altitude);
    }
    if let Some(name) = attrs.get("image_name").and_then(AttrValue::as_str) {
        metadata["image"] = json!(name);
    }
    metadata["display"] = json!({"imageFlipX":number("flip_image_x").unwrap_or(0.0)!=0.0,"imageFlipY":number("flip_image_y").unwrap_or(0.0)!=0.0});
    if let Ok(dataset) = file.dataset("selected_stars") {
        let columns: Vec<_> = attrs
            .get("selected_star_columns")
            .and_then(AttrValue::as_str)
            .ok_or("missing selected star columns")?
            .split_whitespace()
            .collect();
        let values = dataset.read_f64().map_err(|e| e.to_string())?;
        let shape = dataset.shape().map_err(|e| e.to_string())?;
        if shape.len() != 2
            || columns.is_empty()
            || shape[1] != columns.len() as u64
            || shape[0] > 10_000
            || values.len() != shape[0] as usize * columns.len()
        {
            return Err("invalid selected star provenance table".into());
        }
        let array = |key: &str| -> Result<Vec<Value>, String> {
            attrs
                .get(key)
                .and_then(AttrValue::as_str)
                .map(|text| serde_json::from_str(text).map_err(|e| e.to_string()))
                .unwrap_or_else(|| Ok(vec![]))
        };
        let names = array("selected_star_names")?;
        let ids = array("selected_star_ids")?;
        if !names.is_empty() && names.len() != shape[0] as usize
            || !ids.is_empty() && ids.len() != shape[0] as usize
        {
            return Err("selected star identity count does not match table".into());
        }
        let mut included_index = 0;
        for (index, row) in values.chunks(columns.len()).enumerate() {
            let value = |key: &str| columns.iter().position(|c| *c == key).map(|i| row[i]);
            if value("included_in_fit") == Some(0.0) {
                continue;
            }
            let matched = &mut metadata["matches"][included_index];
            included_index += 1;
            if let Some(name) = names.get(index) {
                matched["catalog"]["name"] = name.clone();
            }
            if let Some(id) = ids.get(index) {
                matched["id"] = id.clone();
            }
            for (column, key) in [
                ("ra_hours_j2000", "raHours"),
                ("dec_deg_j2000", "decDeg"),
                ("magnitude", "mag"),
            ] {
                if let Some(value) = value(column).filter(|v| v.is_finite()) {
                    matched["catalog"][key] = json!(value);
                }
            }
        }
        metadata["legacySelectedStarTable"] = json!({"columns":columns,"rows":values.chunks(columns.len()).collect::<Vec<_>>(),"names":names,"ids":ids});
    }
    Ok(metadata)
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
    #[test]
    fn rich_hdf5_roundtrips_image_bound_session_and_legacy_selected_star_columns() {
        let original: serde_json::Value = serde_json::from_str(include_str!(
            "../../../test_cases/BACC_NYA_20200218_010731/case.json"
        ))
        .unwrap();
        let job = parse_job(&original.to_string()).unwrap();
        let session = crate::session::Session {
            schema: crate::session::SCHEMA.into(),
            image_sha256: crate::session::image_digest(b"fixture"),
            image_name: "image.png".into(),
            job: job.clone(),
            metadata: original,
            display: serde_json::json!({"altitude":10.0}),
            masked_tiles: vec![[1, 1]],
        };
        let bytes = session_hdf5(&session, None).unwrap();
        let restored = read_session(&bytes).unwrap().unwrap();
        assert_eq!(restored.metadata, session.metadata);
        assert_eq!(restored.masked_tiles, session.masked_tiles);
        assert_eq!(restored.image_sha256, session.image_sha256);
        assert_eq!(restored.job.pairs, job.pairs);
        let file = File::from_bytes(bytes.clone()).unwrap();
        let stars = file.dataset("selected_stars").unwrap();
        assert_eq!(stars.shape().unwrap(), [50, 14]);
        let values = stars.read_f64().unwrap();
        assert_eq!(values[4], job.pairs[0].y_px + 1.0);
        assert_eq!(values[5], job.pairs[0].x_px + 1.0);
        let names = file.root().attrs().unwrap();
        assert!(names["selected_star_names"].as_str().unwrap().contains("["));
        assert_eq!(import_job(&bytes).unwrap().pairs, job.pairs);
    }
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
        builder.set_attr("site_alt_m", AttrValue::F64Array(vec![123.5]));
        builder.set_attr("flip_image_x", AttrValue::U8Array(vec![1]));
        builder.set_attr(
            "selected_star_names",
            AttrValue::String("[\"Included star\",\"Excluded star\"]".into()),
        );
        builder.set_attr(
            "selected_star_ids",
            AttrValue::String("[\"TYC 1-2-1\",\"TYC 3-4-1\"]".into()),
        );
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
    fn legacy_hdf5_provenance_keeps_names_site_flips_and_excluded_star_table() {
        let bytes = legacy_fixture("raw_image_pixel_centers", false);
        let job = import_job(&bytes).unwrap();
        let metadata = source_metadata(&bytes).unwrap();
        assert_eq!(metadata["matches"][0]["catalog"]["name"], "Included star");
        assert_eq!(metadata["matches"][0]["id"], "TYC 1-2-1");
        assert_eq!(metadata["altM"], 123.5);
        assert_eq!(metadata["display"]["imageFlipX"], true);
        assert_eq!(
            metadata["legacySelectedStarTable"]["names"][1],
            "Excluded star"
        );
        assert_eq!(
            metadata["legacySelectedStarTable"]["rows"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        let converted = calibration_with_metadata_hdf5(&job, None, &metadata).unwrap();
        assert_eq!(source_metadata(&converted).unwrap(), metadata);
        let document = serde_json::json!({"initial":job.initial,"pairs":job.pairs,"observation":job.observation,"source_metadata":metadata});
        assert_eq!(
            source_metadata(&serde_json::to_vec(&document).unwrap()).unwrap(),
            metadata
        );
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
