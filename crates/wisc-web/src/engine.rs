//! Thin WASM bindings for the unchanged JavaScript GUI. Mathematics lives in
//! wisc-core, the same crate used by the standalone native executable.
use super::*;
use wisc_core::{Calibration, OpticalModel};

#[wasm_bindgen]
pub fn engine_project(
    sky: &[f64],
    parameters: &[f64],
    model: u8,
    width: u32,
    height: u32,
) -> Result<Vec<f64>, JsValue> {
    if !sky.len().is_multiple_of(2) {
        return Err(js_error("sky samples must be azimuth/zenith pairs"));
    }
    let calibration = Calibration {
        width,
        height,
        model: OpticalModel::try_from(model).map_err(js_error)?,
        optpar: parameters.to_vec(),
    };
    calibration.validate().map_err(js_error)?;
    Ok(sky
        .as_chunks::<2>()
        .0
        .iter()
        .flat_map(|p| calibration.project(p[0], p[1]).unwrap_or([f64::NAN; 2]))
        .collect())
}

#[wasm_bindgen]
pub fn engine_rotation(alpha: f64, beta: f64, gamma: f64) -> Result<Vec<f64>, JsValue> {
    if ![alpha, beta, gamma].iter().all(|v| v.is_finite()) {
        return Err(js_error("invalid camera angles"));
    }
    Ok(wisc_core::camera_rotation(alpha, beta, gamma).to_vec())
}

#[wasm_bindgen]
pub fn engine_angles(rotation: &[f64]) -> Result<Vec<f64>, JsValue> {
    let matrix: &[f64; 9] = rotation
        .try_into()
        .map_err(|_| js_error("rotation requires nine elements"))?;
    if !matrix.iter().all(|v| v.is_finite()) {
        return Err(js_error("nonfinite rotation"));
    }
    Ok(wisc_core::camera_angles(matrix).to_vec())
}

#[wasm_bindgen]
pub fn engine_radec(
    stars: &[f64],
    unix_millis: f64,
    latitude: f64,
    longitude: f64,
) -> Result<Vec<f64>, JsValue> {
    if !stars.len().is_multiple_of(2) || !unix_millis.is_finite() {
        return Err(js_error("invalid catalogue/time"));
    }
    let observation = wisc_core::workflow::Observation {
        unix_millis: unix_millis as i64,
        latitude_deg: latitude,
        longitude_deg: longitude,
    };
    observation.validate().map_err(js_error)?;
    Ok(stars
        .as_chunks::<2>()
        .0
        .iter()
        .flat_map(|p| {
            wisc_core::radec_to_azimuth_zenith(
                p[0],
                p[1],
                observation.unix_millis,
                latitude,
                longitude,
            )
        })
        .collect())
}

#[wasm_bindgen]
pub fn engine_fit(source: &str, method: &str, max_iterations: usize) -> Result<String, JsValue> {
    if max_iterations > 20_000 {
        return Err(js_error("iteration limit exceeds 20000"));
    }
    let job = wisc_core::workflow::parse_job(source).map_err(js_error)?;
    let value: serde_json::Value =
        serde_json::from_str(source).map_err(|e| js_error(e.to_string()))?;
    let fixed: Vec<usize> = value
        .get("fixed_parameters")
        .map(|v| serde_json::from_value(v.clone()))
        .transpose()
        .map_err(|e| js_error(e.to_string()))?
        .unwrap_or_default();
    let active = wisc_core::active_parameters(&job.initial, &fixed).map_err(js_error)?;
    let result = match method {
        "nm" => wisc_core::fit_with_active(&job.initial, &job.pairs, max_iterations, &active),
        "lm" => wisc_core::optimization::fit_lm_with_active(
            &job.initial,
            &job.pairs,
            max_iterations,
            &active,
        ),
        _ => return Err(js_error("unknown fitting method")),
    }
    .map_err(js_error)?;
    serde_json::to_string(&result).map_err(|e| js_error(e.to_string()))
}

#[wasm_bindgen]
pub fn engine_residual_plot(canvas: HtmlCanvasElement, residuals: &[f64]) -> Result<(), JsValue> {
    if !residuals.len().is_multiple_of(2) || residuals.iter().any(|v| !v.is_finite()) {
        return Err(js_error("invalid residuals"));
    }
    let span = residuals.iter().map(|v| v.abs()).fold(1.0_f64, f64::max) * 1.15;
    let mut plot = SeriesView::new(canvas)?;
    plot.begin(
        240.0,
        180.0,
        web_sys::window().unwrap().device_pixel_ratio(),
        -span,
        span,
        -span,
        span,
        "Δx [pixel]",
        "Δy [pixel]",
    )?;
    plot.series(residuals, "#ff3030", false, 3.4)?;
    Ok(())
}
