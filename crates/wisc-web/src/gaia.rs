//! Same-origin GAIA source/event handoff. Upload is always an explicit action.
use super::hosted::{encoded, get, json, response};
use super::*;
use serde_json::{json, Value};
use wasm_bindgen_futures::{spawn_local, JsFuture};
use web_sys::{Request, RequestInit, RequestMode, UrlSearchParams};

fn message(text: &str) {
    if let Ok(output) = element::<web_sys::HtmlElement>("gaiaStatus") {
        output.set_text_content(Some(text));
    }
}

async fn load(app: Rc<RefCell<App>>, params: UrlSearchParams) -> Result<(), JsValue> {
    let event = params.get("gaia_event").as_deref() == Some("1");
    let source = params.get("source_id").unwrap_or_default();
    let event_id = params.get("event_id").unwrap_or_default();
    let record = params.get("record_id").unwrap_or_default();
    if event
        && (event_id.len() != 8
            || !event_id.bytes().all(|v| v.is_ascii_digit())
            || record.is_empty())
        || !event && source.is_empty()
    {
        return Err(js_error("missing GAIA source/event image identity"));
    }
    let generation = {
        let mut app = app.borrow_mut();
        app.load_generation = app.load_generation.wrapping_add(1);
        app.load_generation
    };
    let base = format!(
        "/gaia/api/events/{}/records/{}",
        encoded(&event_id),
        encoded(&record)
    );
    let image_id = params.get("image_id");
    let image_url = if event {
        format!("{base}/image")
    } else if let Some(id) = &image_id {
        format!("/gaia/api/images/{}/original", encoded(id))
    } else {
        format!("/gaia/api/sources/{}/latest", encoded(&source))
    };
    let settings_url = if event {
        format!("{base}/settings")
    } else {
        format!("/gaia/api/sources/{}/settings", encoded(&source))
    };
    message("Loading GAIA image and star-search masks…");
    let image = get(&image_url).await?;
    let settings = json(get(&settings_url).await?).await?;
    wisc_core::gaia::validate(&settings).map_err(js_error)?;
    let header = |name: &str, query: &str| -> Result<Option<String>, JsValue> {
        Ok(image.headers().get(name)?.or_else(|| params.get(query)))
    };
    let utc = header("X-GAIA-Observation-UTC", "observation_utc")?;
    let latitude = header("X-GAIA-Latitude-Deg", "latitude_deg")?;
    let longitude = header("X-GAIA-Longitude-Deg", "longitude_deg")?;
    let altitude = header("X-GAIA-Altitude-M", "altitude_m")?;
    let proposal = if !event && params.get("proposal").as_deref() == Some("1") {
        Some(
            json(
                get(&format!(
                    "/gaia/api/sources/{}/calibration/refit-proposal",
                    encoded(&source)
                ))
                .await?,
            )
            .await?,
        )
    } else {
        None
    };
    let bytes = Uint8Array::new(&JsFuture::from(image.array_buffer()?).await?).to_vec();
    let decoded = decode(&bytes, FitsByteOrder::Auto).map_err(js_error)?;
    let mut observation = None;
    if let (Some(utc), Some(lat), Some(lon)) = (&utc, &latitude, &longitude) {
        let time = js_sys::Date::parse(utc);
        if !time.is_finite() {
            return Err(js_error("invalid GAIA observation UTC"));
        }
        let obs = wisc_core::workflow::Observation {
            unix_millis: time as i64,
            latitude_deg: lat.parse().map_err(|_| js_error("invalid GAIA latitude"))?,
            longitude_deg: lon
                .parse()
                .map_err(|_| js_error("invalid GAIA longitude"))?,
        };
        obs.validate().map_err(js_error)?;
        observation = Some(obs);
    }
    let altitude = altitude
        .map(|v| v.parse::<f64>())
        .transpose()
        .map_err(|_| js_error("invalid GAIA altitude"))?;
    if altitude.is_some_and(|v| !v.is_finite()) {
        return Err(js_error("invalid GAIA altitude"));
    }
    // Build and validate a proposal before changing the current image.
    let proposed = if let Some(proposal) = proposal {
        let parameters = proposal
            .get("optpar")
            .and_then(Value::as_array)
            .ok_or_else(|| js_error("GAIA proposal lacks lens parameters"))?;
        let mut optpar = vec![proposal
            .get("optmod")
            .cloned()
            .ok_or_else(|| js_error("GAIA proposal lacks optical model"))?];
        optpar.extend(parameters.iter().cloned());
        let matches=proposal.get("matches").and_then(Value::as_array).ok_or_else(||js_error("GAIA proposal lacks matches"))?.iter().enumerate().map(|(i,m)| {
            let number=|key:&str|->Result<f64,JsValue>{m.get(key).and_then(Value::as_f64).filter(|v|v.is_finite()).ok_or_else(||js_error(format!("invalid GAIA proposal {key}")))};
            Ok(json!({"id":i+1,"image":{"x":number("image_x")?,"y":number("image_y")?,"method":"gaia-auto"},"catalog":{"name":m.get("star_key").and_then(Value::as_str).unwrap_or("GAIA star"),"raHours":number("ra_hours")?,"decDeg":number("dec_deg")?,"mag":number("mag")?,"az":number("azimuth_deg")?*wisc_core::DEG,"ze":number("zenith_deg")?*wisc_core::DEG}}))
        }).collect::<Result<Vec<_>,JsValue>>()?;
        let mut value = json!({"width":decoded.width,"height":decoded.height,"optpar":optpar,"modelCoordinates":"raw_image_pixel_centers","matches":matches});
        if let Some(obs) = &observation {
            value["timestampUtc"] = json!(String::from(
                js_sys::Date::new(&JsValue::from_f64(obs.unix_millis as f64)).to_iso_string()
            ));
            value["latDeg"] = json!(obs.latitude_deg);
            value["lonDeg"] = json!(obs.longitude_deg);
        }
        wisc_core::workflow::parse_job(&value.to_string()).map_err(js_error)?;
        Some(value)
    } else {
        None
    };
    let mut app = app.borrow_mut();
    if app.load_generation != generation {
        return Err(js_error(
            "image changed during GAIA load; stale response discarded",
        ));
    }
    app.load_image(
        &bytes,
        if event {
            "gaia-event-image"
        } else {
            "gaia-source-image"
        },
    )?;
    if let Some(proposed) = proposed {
        ui::import_job(
            &mut app,
            &serde_json::to_vec(&proposed).map_err(|e| js_error(e.to_string()))?,
        )?;
    }
    if !app.original_metadata.is_object() {
        app.original_metadata = json!({});
    }
    app.original_metadata["gaiaSettings"] = settings;
    app.original_metadata["gaiaContext"] =
        json!({"event":event,"source_id":source,"event_id":event_id,"record_id":record});
    if let Some(altitude) = altitude {
        element::<HtmlInputElement>("altitude")?.set_value(&altitude.to_string());
    }
    let mut job = ui::read_job()?;
    if observation.is_some() {
        job.observation = observation;
        ui::controls_from_job(&job)?;
        ui::write_job(&job)?;
    }
    app.session_ready = true;
    ui::refresh_overlay(&mut app, &job)?;
    element::<web_sys::HtmlButtonElement>("sendGaia")?.set_disabled(false);
    message("GAIA image loaded. Review identifications, fit, then explicitly send the calibration back. No upload has occurred.");
    Ok(())
}

async fn save(app: Rc<RefCell<App>>) -> Result<(), JsValue> {
    let (form, endpoint, context) = {
        let app = app.borrow();
        let session = persistence::snapshot(&app)?;
        let context = session
            .metadata
            .get("gaiaContext")
            .ok_or_else(|| js_error("this image has no GAIA handoff identity"))?
            .clone();
        let fitted = app
            .fitted
            .as_ref()
            .ok_or_else(|| js_error("fit before sending to GAIA"))?;
        if fitted.calibration != session.job.initial
            || fitted.pairs != session.job.pairs
            || fitted.observation != session.job.observation
        {
            return Err(js_error(
                "calibration changed; refit before sending to GAIA",
            ));
        }
        if !web_sys::window().unwrap().confirm_with_message("Save this fitted calibration in GAIA? Event calibrations will also request map projection.")? {return Ok(());}
        let result = FitResult {
            calibration: fitted.calibration.clone(),
            rms_px: fitted.rms_px,
            iterations: fitted.iterations,
        };
        let bytes = wisc_core::products::session_hdf5(&session, Some(&result)).map_err(js_error)?;
        let form = web_sys::FormData::new()?;
        let text = |key: &str| {
            context
                .get(key)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| js_error("invalid GAIA handoff identity"))
        };
        let event = context.get("event").and_then(Value::as_bool) == Some(true);
        let endpoint = if event {
            form.append_with_str("record_id", text("record_id")?)?;
            format!(
                "/gaia/api/events/{}/calibrations",
                encoded(text("event_id")?)
            )
        } else {
            form.append_with_str("source_id", text("source_id")?)?;
            let time = session
                .job
                .observation
                .as_ref()
                .ok_or_else(|| js_error("GAIA calibration requires observation time"))?
                .unix_millis;
            form.append_with_str(
                "valid_from_utc",
                &String::from(js_sys::Date::new(&JsValue::from_f64(time as f64)).to_iso_string()),
            )?;
            "/gaia/api/calibrations".into()
        };
        form.append_with_str("residual_px", &fitted.rms_px.to_string())?;
        form.append_with_str("star_count", &session.job.pairs.len().to_string())?;
        let parts = js_sys::Array::new();
        parts.push(&Uint8Array::from(bytes.as_slice()));
        let options = web_sys::BlobPropertyBag::new();
        options.set_type("application/x-hdf5");
        let blob = web_sys::Blob::new_with_u8_array_sequence_and_options(&parts, &options)?;
        form.append_with_blob_and_filename("calibration", &blob, "calibration.h5")?;
        (form, endpoint, context)
    };
    let options = RequestInit::new();
    options.set_method("POST");
    options.set_mode(RequestMode::SameOrigin);
    options.set_body(form.as_ref());
    let result =
        json(response(&Request::new_with_str_and_init(&endpoint, &options)?).await?).await?;
    if let Some(error) = result
        .get("projection_error")
        .filter(|v| !v.is_null() && v.as_str() != Some(""))
    {
        message(&format!(
            "GAIA calibration saved, but projection failed: {error}"
        ));
        return Ok(());
    }
    if context.get("event").and_then(Value::as_bool) == Some(true) {
        if let Ok(opener) = web_sys::window()
            .unwrap()
            .opener()?
            .dyn_into::<web_sys::Window>()
        {
            let notification = json!({"type":"gaia-event-calibrated","eventId":context["event_id"],"recordId":context["record_id"]});
            let value = js_sys::JSON::parse(&notification.to_string())?;
            opener.post_message(&value, &web_sys::window().unwrap().location().origin()?)?;
        }
    }
    message("GAIA calibration saved successfully.");
    Ok(())
}

pub(super) fn connect(app: Rc<RefCell<App>>) -> Result<(), JsValue> {
    let target = app.clone();
    let callback = Closure::<dyn FnMut(Event)>::new(move |_| {
        let app = target.clone();
        spawn_local(async move {
            let button = element::<web_sys::HtmlButtonElement>("sendGaia");
            if let Ok(b) = &button {
                b.set_disabled(true);
            }
            if let Err(error) = save(app).await {
                message(&format!(
                    "GAIA save failed: {}",
                    error.as_string().unwrap_or_default()
                ));
            }
            if let Ok(b) = button {
                b.set_disabled(false);
            }
        });
    });
    element::<web_sys::HtmlButtonElement>("sendGaia")?
        .add_event_listener_with_callback("click", callback.as_ref().unchecked_ref())?;
    callback.forget();
    let params = UrlSearchParams::new_with_str(&web_sys::window().unwrap().location().search()?)?;
    if params.get("gaia").as_deref() == Some("1")
        || params.get("gaia_event").as_deref() == Some("1")
    {
        spawn_local(async move {
            if let Err(error) = load(app, params).await {
                message(&format!(
                    "GAIA load failed: {}",
                    error.as_string().unwrap_or_default()
                ));
            }
        });
    }
    Ok(())
}
