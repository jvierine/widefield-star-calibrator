use super::*;
use web_sys::{HtmlAnchorElement, HtmlOptionElement, HtmlSelectElement, MouseEvent};
use wisc_core::workflow::{
    automatic_fit_preserving, parse_job, tycho_catalog, visible_catalog, CalibrationDocument,
    FitJob, Observation,
};
use wisc_core::{default_optpar, OpticalModel};

fn read_job() -> Result<FitJob, JsValue> {
    parse_job(&element::<HtmlTextAreaElement>("fitJob")?.value()).map_err(js_error)
}

fn write_job(job: &FitJob) -> Result<(), JsValue> {
    element::<HtmlTextAreaElement>("fitJob")?.set_value(
        &serde_json::to_string_pretty(job).map_err(|error| js_error(error.to_string()))?,
    );
    Ok(())
}

fn input_number(id: &str) -> Result<f64, JsValue> {
    let value = element::<HtmlInputElement>(id)?.value_as_number();
    if value.is_finite() {
        Ok(value)
    } else {
        Err(js_error(format!("enter a valid {id}")))
    }
}

fn controls_from_job(job: &FitJob) -> Result<(), JsValue> {
    if let Some(observation) = &job.observation {
        let date = js_sys::Date::new(&JsValue::from_f64(observation.unix_millis as f64));
        let iso = String::from(date.to_iso_string());
        element::<HtmlInputElement>("utc")?.set_value(iso.trim_end_matches('Z'));
        element::<HtmlInputElement>("latitude")?.set_value(&observation.latitude_deg.to_string());
        element::<HtmlInputElement>("longitude")?.set_value(&observation.longitude_deg.to_string());
    }
    element::<HtmlSelectElement>("model")?.set_value(&u8::from(job.initial.model).to_string());
    for (id, index) in [
        ("focalX", 0),
        ("focalY", 1),
        ("alpha", 2),
        ("beta", 3),
        ("gamma", 4),
        ("radial", 7),
    ] {
        element::<HtmlInputElement>(id)?.set_value(&job.initial.optpar[index].to_string());
    }
    Ok(())
}

fn sync_observation(job: &mut FitJob) -> Result<(), JsValue> {
    let utc = element::<HtmlInputElement>("utc")?.value();
    if utc.is_empty() {
        return Ok(());
    }
    let timestamp = js_sys::Date::parse(&format!("{utc}Z"));
    if !timestamp.is_finite() {
        return Err(js_error("invalid UTC time"));
    }
    let observation = Observation {
        unix_millis: timestamp as i64,
        latitude_deg: input_number("latitude")?,
        longitude_deg: input_number("longitude")?,
    };
    observation.validate().map_err(js_error)?;
    if !job.pairs.is_empty()
        && job
            .observation
            .as_ref()
            .is_some_and(|previous| previous != &observation)
    {
        return Err(js_error(
            "time or site changed; clear the old pairs before pairing this observation",
        ));
    }
    job.observation = Some(observation);
    Ok(())
}

fn ensure_dimensions(app: &App, job: &FitJob) -> Result<(), JsValue> {
    if app.width > 0 && (app.width != job.initial.width || app.height != job.initial.height) {
        Err(js_error(
            "calibration dimensions differ from the loaded image",
        ))
    } else {
        Ok(())
    }
}

fn refresh_overlay(app: &mut App, job: &FitJob) -> Result<(), JsValue> {
    app.catalog_points.clear();
    app.pair_points = job
        .pairs
        .iter()
        .map(|pair| [pair.x_px as f32, pair.y_px as f32])
        .collect();
    app.sky.clear();
    let selector = element::<HtmlSelectElement>("catalogStar")?;
    selector.set_text_content(None);
    if let Some(observation) = &job.observation {
        app.sky = visible_catalog(
            &tycho_catalog().map_err(js_error)?,
            observation,
            input_number("magnitude")?,
        )
        .map_err(js_error)?;
        let document = web_sys::window().unwrap().document().unwrap();
        for (index, star) in app.sky.iter().enumerate() {
            let Some(pixel) = job.initial.project(star.azimuth_rad, star.zenith_rad) else {
                continue;
            };
            if pixel[0] < 0.0
                || pixel[1] < 0.0
                || pixel[0] >= f64::from(job.initial.width)
                || pixel[1] >= f64::from(job.initial.height)
            {
                continue;
            }
            app.catalog_points.push([pixel[0] as f32, pixel[1] as f32]);
            let option = document
                .create_element("option")?
                .dyn_into::<HtmlOptionElement>()?;
            option.set_value(&index.to_string());
            option.set_text(&format!(
                "Tycho row {} · mag {:.1} · x {:.0}, y {:.0}",
                star.catalog_index, star.magnitude, pixel[0], pixel[1]
            ));
            selector.append_child(&option)?;
        }
    }
    element::<web_sys::HtmlElement>("pairCount")?.set_text_content(Some(&format!(
        "{} pairs · {} catalogue stars in view",
        job.pairs.len(),
        app.catalog_points.len()
    )));
    app.draw();
    Ok(())
}

pub(super) fn import_job(app: &mut App, source: &[u8]) -> Result<(), JsValue> {
    let job = wisc_core::products::import_job(source).map_err(js_error)?;
    ensure_dimensions(app, &job)?;
    if let Ok(previous) = read_job() {
        app.history.push(previous);
    }
    app.invalidate_fit();
    write_job(&job)?;
    controls_from_job(&job)?;
    refresh_overlay(app, &job)?;
    status(&format!(
        "Imported calibration with {} measured star pairs",
        job.pairs.len()
    ));
    Ok(())
}

pub(super) fn image_loaded(
    app: &mut App,
    image: &wisc_core::imaging::CalibrationImage,
) -> Result<(), JsValue> {
    let mut job = read_job()?;
    job.initial.width = image.width;
    job.initial.height = image.height;
    job.pairs.clear();
    app.history.clear();
    app.invalidate_fit();
    for id in ["utc", "latitude", "longitude"] {
        element::<HtmlInputElement>(id)?.set_value("");
    }
    if let Some(timestamp) = image.fits_header.get("DATE-OBS") {
        element::<HtmlInputElement>("utc")?
            .set_value(timestamp.trim_end_matches('Z').replace(' ', "T").as_str());
    }
    for (id, keys) in [
        ("latitude", &["LATITUDE"][..]),
        ("longitude", &["LONGITUD", "LONGITUDE"][..]),
    ] {
        if let Some(value) = keys.iter().find_map(|key| image.fits_header.get(*key)) {
            element::<HtmlInputElement>(id)?.set_value(value);
        }
    }
    // A new image cannot inherit another exposure's sky coordinates.
    job.observation = None;
    if !element::<HtmlInputElement>("utc")?.value().is_empty()
        && input_number("latitude").is_ok()
        && input_number("longitude").is_ok()
    {
        sync_observation(&mut job)?;
    }
    write_job(&job)?;
    controls_from_job(&job)?;
    refresh_overlay(app, &job)
}

fn apply_controls(app: &mut App) -> Result<(), JsValue> {
    let mut job = read_job()?;
    ensure_dimensions(app, &job)?;
    let model = OpticalModel::try_from(
        element::<HtmlSelectElement>("model")?
            .value()
            .parse::<u8>()
            .map_err(|error| js_error(error.to_string()))?,
    )
    .map_err(js_error)?;
    let previous = job.clone();
    if job.initial.model != model {
        job.initial.model = model;
        job.initial.optpar = default_optpar(job.initial.width, job.initial.height, model);
    }
    for (id, index) in [
        ("focalX", 0),
        ("focalY", 1),
        ("alpha", 2),
        ("beta", 3),
        ("gamma", 4),
        ("radial", 7),
    ] {
        job.initial.optpar[index] = input_number(id)?;
    }
    sync_observation(&mut job)?;
    job.initial.validate().map_err(js_error)?;
    app.history.push(previous);
    app.invalidate_fit();
    write_job(&job)?;
    refresh_overlay(app, &job)?;
    status("Camera and catalogue updated. Select a catalogue star and click its image position.");
    Ok(())
}

fn run_fit(app: &mut App, mode: u8) -> Result<(), JsValue> {
    let mut job = read_job()?;
    ensure_dimensions(app, &job)?;
    sync_observation(&mut job)?;
    let previous = job.clone();
    let result = if mode > 0 {
        if app.width == 0 {
            return Err(js_error("load an image before automatic matching"));
        }
        let observation = job
            .observation
            .as_ref()
            .ok_or_else(|| js_error("set UTC time and observer position"))?;
        let sky = visible_catalog(
            &tycho_catalog().map_err(js_error)?,
            observation,
            input_number("magnitude")?,
        )
        .map_err(js_error)?;
        let matcher = if mode == 2 {
            wisc_core::asterism::triangle_fit
        } else {
            automatic_fit_preserving
        };
        let (result, pairs) = matcher(
            &job.initial,
            &app.detections,
            &sky,
            &job.pairs,
            input_number("matchRadius")?,
            2000,
        )
        .map_err(js_error)?;
        job.pairs = pairs;
        result
    } else {
        fit(&job.initial, &job.pairs, 2000).map_err(js_error)?
    };
    render_residuals(&result, &job.pairs)?;
    app.fitted = Some(CalibrationDocument::from_fit(&result, &job).map_err(js_error)?);
    app.history.push(previous);
    job.initial = result.calibration;
    write_job(&job)?;
    controls_from_job(&job)?;
    refresh_overlay(app, &job)?;
    status(&format!(
        "Fit complete: {} pairs, RMS {:.4} px",
        job.pairs.len(),
        result.rms_px
    ));
    Ok(())
}

fn download_json(app: &mut App) -> Result<(), JsValue> {
    let job = read_job()?;
    let (name, text) = if let Some(result) = &app.fitted {
        if result.calibration != job.initial
            || result.pairs != job.pairs
            || result.observation != job.observation
        {
            return Err(js_error(
                "calibration changed; fit again before downloading results",
            ));
        }
        ("calibration.json", serde_json::to_string_pretty(result))
    } else {
        ("fit-job.json", serde_json::to_string_pretty(&job))
    };
    let parts = js_sys::Array::new();
    parts.push(&JsValue::from_str(
        &text.map_err(|error| js_error(error.to_string()))?,
    ));
    let blob = web_sys::Blob::new_with_str_sequence(&parts)?;
    let url = web_sys::Url::create_object_url_with_blob(&blob)?;
    let anchor = web_sys::window()
        .unwrap()
        .document()
        .unwrap()
        .create_element("a")?
        .dyn_into::<HtmlAnchorElement>()?;
    anchor.set_href(&url);
    anchor.set_download(name);
    anchor.click();
    web_sys::Url::revoke_object_url(&url)?;
    status(&format!("Downloaded {name}"));
    Ok(())
}

fn action(
    app: Rc<RefCell<App>>,
    id: &str,
    callback: fn(&mut App) -> Result<(), JsValue>,
) -> Result<(), JsValue> {
    let button = element::<web_sys::HtmlButtonElement>(id)?;
    let closure = Closure::<dyn FnMut(Event)>::new(move |_| {
        if let Err(error) = callback(&mut app.borrow_mut()) {
            status(&error.as_string().unwrap_or_else(|| format!("{error:?}")));
        }
    });
    button.add_event_listener_with_callback("click", closure.as_ref().unchecked_ref())?;
    closure.forget();
    Ok(())
}

fn download_bytes(name: &str, bytes: &[u8]) -> Result<(), JsValue> {
    let parts = js_sys::Array::new();
    parts.push(&Uint8Array::from(bytes));
    let blob = web_sys::Blob::new_with_u8_array_sequence(&parts)?;
    let url = web_sys::Url::create_object_url_with_blob(&blob)?;
    let anchor = web_sys::window()
        .unwrap()
        .document()
        .unwrap()
        .create_element("a")?
        .dyn_into::<HtmlAnchorElement>()?;
    anchor.set_href(&url);
    anchor.set_download(name);
    anchor.click();
    web_sys::Url::revoke_object_url(&url)?;
    status(&format!("Downloaded {name}"));
    Ok(())
}

pub(super) fn connect(app: Rc<RefCell<App>>) -> Result<(), JsValue> {
    controls_from_job(&read_job()?)?;
    action(app.clone(), "applyControls", apply_controls)?;
    action(app.clone(), "fitPairs", |app| run_fit(app, 0))?;
    action(app.clone(), "autoFit", |app| run_fit(app, 1))?;
    action(app.clone(), "triangleFit", |app| run_fit(app, 2))?;
    action(app.clone(), "downloadMap", |app| {
        let job = read_job()?;
        ensure_dimensions(app, &job)?;
        let step = input_number("mapStep")?;
        if !(1.0..=4096.0).contains(&step) || step.fract() != 0.0 {
            return Err(js_error("map step must be a positive integer"));
        }
        let mut bytes = Vec::new();
        wisc_core::imaging::write_azel_fits(&mut bytes, &job.initial, step as u32)
            .map_err(js_error)?;
        let parts = js_sys::Array::new();
        parts.push(&Uint8Array::from(bytes.as_slice()));
        let blob = web_sys::Blob::new_with_u8_array_sequence(&parts)?;
        let url = web_sys::Url::create_object_url_with_blob(&blob)?;
        let anchor = web_sys::window()
            .unwrap()
            .document()
            .unwrap()
            .create_element("a")?
            .dyn_into::<HtmlAnchorElement>()?;
        anchor.set_href(&url);
        anchor.set_download("azel.fits");
        anchor.click();
        web_sys::Url::revoke_object_url(&url)?;
        status("Downloaded azel.fits: azimuth and elevation planes in degrees");
        Ok(())
    })?;
    action(app.clone(), "download", download_json)?;
    action(app.clone(), "downloadHdf5", |app| {
        let job = read_job()?;
        let result = if let Some(document) = &app.fitted {
            if document.calibration != job.initial
                || document.pairs != job.pairs
                || document.observation != job.observation
            {
                return Err(js_error(
                    "calibration changed; fit again before downloading results",
                ));
            }
            Some(wisc_core::FitResult {
                calibration: document.calibration.clone(),
                rms_px: document.rms_px,
                iterations: document.iterations,
            })
        } else {
            None
        };
        let bytes =
            wisc_core::products::calibration_hdf5(&job, result.as_ref()).map_err(js_error)?;
        download_bytes("calibration.h5", &bytes)
    })?;
    action(app.clone(), "downloadHdf5Map", |app| {
        let job = read_job()?;
        ensure_dimensions(app, &job)?;
        let bytes = wisc_core::products::azel_hdf5(&job.initial, job.observation.as_ref())
            .map_err(js_error)?;
        download_bytes("azel.h5", &bytes)
    })?;
    action(app.clone(), "undo", |app| {
        let job = app
            .history
            .pop()
            .ok_or_else(|| js_error("nothing to undo"))?;
        app.invalidate_fit();
        write_job(&job)?;
        controls_from_job(&job)?;
        refresh_overlay(app, &job)?;
        status("Previous calibration restored");
        Ok(())
    })?;
    action(app.clone(), "clearPairs", |app| {
        let mut job = read_job()?;
        app.history.push(job.clone());
        job.pairs.clear();
        app.invalidate_fit();
        write_job(&job)?;
        refresh_overlay(app, &job)?;
        status("Pairs cleared; Undo restores them");
        Ok(())
    })?;
    let canvas = app.borrow().canvas.clone();
    let picked = Closure::<dyn FnMut(MouseEvent)>::new(move |event: MouseEvent| {
        let result = (|| -> Result<(), JsValue> {
            let mut app = app.borrow_mut();
            if app.width == 0 {
                return Err(js_error("load an image first"));
            }
            let mut job = read_job()?;
            let rect = app.canvas.get_bounding_client_rect();
            let point = [
                (f64::from(event.client_x()) - rect.left()) * f64::from(app.width) / rect.width()
                    - 0.5,
                (f64::from(event.client_y()) - rect.top()) * f64::from(app.height) / rect.height()
                    - 0.5,
            ];
            if event.shift_key() {
                let nearest = job
                    .pairs
                    .iter()
                    .enumerate()
                    .min_by(|(_, a), (_, b)| {
                        (a.x_px - point[0])
                            .hypot(a.y_px - point[1])
                            .total_cmp(&(b.x_px - point[0]).hypot(b.y_px - point[1]))
                    })
                    .map(|(index, pair)| {
                        (index, (pair.x_px - point[0]).hypot(pair.y_px - point[1]))
                    });
                let (index, distance) =
                    nearest.ok_or_else(|| js_error("there are no pairs to remove"))?;
                if distance > 20.0 {
                    return Err(js_error("Shift-click closer to a paired star"));
                }
                app.history.push(job.clone());
                job.pairs.remove(index);
            } else {
                let index = element::<HtmlSelectElement>("catalogStar")?
                    .value()
                    .parse::<usize>()
                    .map_err(|_| js_error("update the catalogue and select a star first"))?;
                let star = app
                    .sky
                    .get(index)
                    .ok_or_else(|| js_error("selected catalogue star is no longer visible"))?
                    .clone();
                let picked = app
                    .detections
                    .iter()
                    .min_by(|a, b| {
                        (a.x - point[0])
                            .hypot(a.y - point[1])
                            .total_cmp(&(b.x - point[0]).hypot(b.y - point[1]))
                    })
                    .filter(|detection| {
                        (detection.x - point[0]).hypot(detection.y - point[1]) <= 12.0
                    });
                let xy = picked
                    .map(|detection| [detection.x, detection.y])
                    .unwrap_or(point);
                app.history.push(job.clone());
                job.pairs.retain(|pair| {
                    (pair.azimuth_rad - star.azimuth_rad).abs() > 1e-10
                        || (pair.zenith_rad - star.zenith_rad).abs() > 1e-10
                });
                job.pairs.push(StarPair {
                    azimuth_rad: star.azimuth_rad,
                    zenith_rad: star.zenith_rad,
                    x_px: xy[0],
                    y_px: xy[1],
                });
            }
            app.invalidate_fit();
            write_job(&job)?;
            refresh_overlay(&mut app, &job)?;
            status(&format!("{} measured star pairs", job.pairs.len()));
            Ok(())
        })();
        if let Err(error) = result {
            status(&error.as_string().unwrap_or_default());
        }
    });
    canvas.add_event_listener_with_callback("click", picked.as_ref().unchecked_ref())?;
    picked.forget();
    Ok(())
}
