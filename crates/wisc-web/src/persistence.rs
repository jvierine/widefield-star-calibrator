//! Image-bound sessions. Passkeys and source image bytes are never stored.
use super::*;
use serde_json::{json, Value};
use wisc_core::session::{Session, SCHEMA};

const NUMBERS: &[&str] = &[
    "brightness",
    "contrast",
    "gammaDisplay",
    "highPassSigma",
    "displayClip",
    "magnitude",
    "matchRadius",
    "altitude",
];
const CHECKS: &[&str] = &[
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
];

pub(super) struct EditState {
    pub job: wisc_core::workflow::FitJob,
    pub metadata: Value,
    pub masks: Vec<[u32; 2]>,
    pub display: Value,
}

pub(super) fn restore_edit(app: &mut App, state: EditState) -> Result<(), JsValue> {
    app.original_metadata = state.metadata;
    app.masked_tiles = state.masks;
    apply_display(app, &state.display)?;
    ui::write_job(&state.job)?;
    ui::controls_from_job(&state.job)?;
    viewer::update_texture(app)?;
    ui::refresh_overlay(app, &state.job)
}

pub(super) fn snapshot(app: &App) -> Result<Session, JsValue> {
    if app.width == 0 {
        return Err(js_error("load an image before saving a session"));
    }
    let mut display = json!({"zoom":app.viewport.zoom,"center":app.viewport.center,"show_image":app.show_image,"show_markers":app.show_markers});
    for id in NUMBERS {
        let number = element::<HtmlInputElement>(id)?.value_as_number();
        if !number.is_finite() {
            return Err(js_error(format!("invalid {id}")));
        }
        display[*id] = json!(number);
    }
    for id in CHECKS {
        display[*id] = json!(element::<HtmlInputElement>(id)?.checked());
    }
    display["catalogue"] = json!(element::<web_sys::HtmlSelectElement>("starCatalogue")?.value());
    display["fitsByteOrder"] =
        json!(element::<web_sys::HtmlSelectElement>("fitsByteOrder")?.value());
    display["pure_view"] = json!(app.pure_view);
    for id in ["caseId", "caseTitle"] {
        display[id] = json!(element::<HtmlInputElement>(id)?.value());
    }
    let session = Session {
        schema: SCHEMA.into(),
        image_sha256: app.image_hash.clone(),
        image_name: app.image_name.clone(),
        job: ui::read_job()?,
        metadata: app.original_metadata.clone(),
        display,
        masked_tiles: app.masked_tiles.clone(),
    };
    if session.job.initial.width != app.width || session.job.initial.height != app.height {
        return Err(js_error("calibration dimensions differ from this image"));
    }
    session.validate().map_err(js_error)?;
    Ok(session)
}

pub(super) fn apply_display(app: &mut App, display: &Value) -> Result<(), JsValue> {
    if let Some(order) = display
        .get("fitsByteOrder")
        .and_then(Value::as_str)
        .filter(|s| ["auto", "big", "little"].contains(s))
    {
        element::<web_sys::HtmlSelectElement>("fitsByteOrder")?.set_value(order);
    }
    for id in ["caseId", "caseTitle"] {
        if let Some(value) = display.get(id).and_then(Value::as_str) {
            element::<HtmlInputElement>(id)?.set_value(value);
        }
    }
    if let Some(value) = display.get("pure_view").and_then(Value::as_bool) {
        app.pure_view = value;
    }
    if let Some(kind) = display
        .get("catalogue")
        .and_then(Value::as_str)
        .filter(|s| ["tycho2", "yale", "td1"].contains(s))
    {
        element::<web_sys::HtmlSelectElement>("starCatalogue")?.set_value(kind);
    }
    for id in NUMBERS {
        if let Some(value) = display
            .get(*id)
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite())
        {
            element::<HtmlInputElement>(id)?.set_value(&value.to_string());
        }
    }
    for id in CHECKS {
        if let Some(value) = display.get(*id).and_then(Value::as_bool) {
            element::<HtmlInputElement>(id)?.set_checked(value);
        }
    }
    if let (Some(zoom), Some(center)) = (
        display.get("zoom").and_then(Value::as_f64),
        display.get("center").and_then(Value::as_array),
    ) {
        if center.len() == 2 && (1.0..=16.0).contains(&zoom) {
            if let (Some(x), Some(y)) = (center[0].as_f64(), center[1].as_f64()) {
                app.viewport.zoom = zoom;
                app.viewport.center = [x.clamp(0.0, 1.0), y.clamp(0.0, 1.0)];
                app.viewport.pan([0.0; 2]);
            }
        }
    }
    if let Some(value) = display.get("show_image").and_then(Value::as_bool) {
        app.show_image = value;
    }
    if let Some(value) = display.get("show_markers").and_then(Value::as_bool) {
        app.show_markers = value;
    }
    Ok(())
}

pub(super) fn apply_legacy_metadata(app: &mut App) -> Result<(), JsValue> {
    let root = app
        .original_metadata
        .get("testCase")
        .unwrap_or(&app.original_metadata);
    for (field, id) in [
        ("maxMag", "magnitude"),
        ("matchRadiusPx", "matchRadius"),
        ("altM", "altitude"),
    ] {
        if let Some(value) = root
            .get(field)
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite())
        {
            element::<HtmlInputElement>(id)?.set_value(&value.to_string());
        }
    }
    if let Some(display) = root.get("display") {
        for (field, id) in [
            ("brightness", "brightness"),
            ("contrast", "contrast"),
            ("highPassWidthPx", "highPassSigma"),
            ("displayClipPercent", "displayClip"),
        ] {
            if let Some(value) = display
                .get(field)
                .and_then(Value::as_f64)
                .filter(|v| v.is_finite())
            {
                element::<HtmlInputElement>(id)?.set_value(&value.to_string());
            }
        }
        if let Some(value) = display.get("highPassImage").and_then(Value::as_bool) {
            element::<HtmlInputElement>("highPass")?.set_checked(value);
        }
        for id in ["imageFlipX", "imageFlipY"] {
            if let Some(value) = display.get(id).and_then(Value::as_bool) {
                element::<HtmlInputElement>(id)?.set_checked(value);
            }
        }
    }
    for (field, id) in [("id", "caseId"), ("title", "caseTitle")] {
        if let Some(value) = root.get(field).and_then(Value::as_str) {
            element::<HtmlInputElement>(id)?.set_value(value);
        }
    }
    if let Some(tiles) = root.get("rustMaskedTiles") {
        let tiles: Vec<[u32; 2]> = serde_json::from_value(tiles.clone())
            .map_err(|_| js_error("invalid saved detection mask"))?;
        if tiles.len() > 100_000
            || tiles
                .iter()
                .any(|t| t[0] >= app.width.div_ceil(128) || t[1] >= app.height.div_ceil(128))
        {
            return Err(js_error("saved detection mask is outside the image"));
        }
        app.masked_tiles = tiles;
    }
    Ok(())
}

fn storage() -> Result<web_sys::Storage, JsValue> {
    web_sys::window()
        .unwrap()
        .local_storage()?
        .ok_or_else(|| js_error("browser storage unavailable"))
}
fn key(app: &App) -> String {
    format!("wisc-session:{}", app.image_hash)
}
pub(super) fn autosave(app: &App) {
    if !app.session_ready || app.width == 0 {
        return;
    }
    let saved = (|| -> Result<(), JsValue> {
        let session = snapshot(app)?;
        storage()?.set_item(
            &key(app),
            &serde_json::to_string(&session).map_err(|e| js_error(e.to_string()))?,
        )?;
        Ok(())
    })();
    if saved.is_ok() {
        if let Ok(button) = element::<web_sys::HtmlButtonElement>("restoreSession") {
            button.set_disabled(false);
        }
    }
    if let Ok(output) = element::<web_sys::HtmlElement>("sessionStatus") {
        output.set_text_content(Some(if saved.is_ok() {
            "Session saved locally for this exact image. Image pixels and passkeys are not stored."
        } else {
            "Local autosave unavailable; download a session JSON to preserve your work."
        }));
    }
}
pub(super) fn restore_hint(app: &App) -> Result<(), JsValue> {
    let available = storage()
        .ok()
        .and_then(|s| s.get_item(&key(app)).ok().flatten())
        .is_some();
    element::<web_sys::HtmlButtonElement>("restoreSession")?.set_disabled(!available);
    element::<web_sys::HtmlElement>("sessionStatus")?.set_text_content(Some(if available {
        "A saved session matches this image. Click Restore local session to resume."
    } else {
        "No local session for this image. Calibration changes will be autosaved locally."
    }));
    Ok(())
}
pub(super) fn restore(app: &mut App, session: Session) -> Result<(), JsValue> {
    session
        .verify_image(&app.image_bytes, app.width, app.height)
        .map_err(js_error)?;
    if let Ok(job) = ui::read_job() {
        app.remember(job);
    }
    app.invalidate_fit();
    app.original_metadata = session.metadata;
    apply_legacy_metadata(app)?;
    app.masked_tiles = session.masked_tiles;
    apply_display(app, &session.display)?;
    ui::write_job(&session.job)?;
    ui::controls_from_job(&session.job)?;
    app.session_ready = true;
    viewer::update_texture(app)?;
    ui::refresh_overlay(app, &session.job)?;
    status("Restored image-verified calibration session, display and detection masks");
    Ok(())
}

pub(super) fn remember_star(
    app: &mut App,
    star: &wisc_core::workflow::SkyStar,
    xy: [f64; 2],
) -> Result<(), JsValue> {
    let source = app
        .catalog
        .get(star.catalog_index)
        .ok_or_else(|| js_error("invalid catalogue identity"))?;
    if !app.original_metadata.is_object() {
        app.original_metadata = json!({});
    }
    let root = if app.original_metadata.get("testCase").is_some() {
        &mut app.original_metadata["testCase"]
    } else {
        &mut app.original_metadata
    };
    if !root.get("matches").is_some_and(Value::is_array) {
        root["matches"] = json!([]);
    }
    root["matches"].as_array_mut().unwrap().push(json!({"id":source.id,"image":{"x":xy[0],"y":xy[1]},"catalog":{"az":star.azimuth_rad,"ze":star.zenith_rad,"raHours":source.star.ra_hours,"decDeg":source.star.dec_deg,"mag":source.star.magnitude,"name":source.name}}));
    Ok(())
}

pub(super) fn legacy(app: &App) -> Result<Value, JsValue> {
    snapshot(app)?;
    let job = ui::read_job()?;
    let mut value =
        wisc_core::session::legacy_document(&job, &app.original_metadata).map_err(js_error)?;
    for (key, id) in [("id", "caseId"), ("title", "caseTitle")] {
        value[key] = json!(element::<HtmlInputElement>(id)?.value());
    }
    value["image"] = json!(app.image_name);
    value["altM"] = json!(element::<HtmlInputElement>("altitude")?.value_as_number());
    value["maxMag"] = json!(element::<HtmlInputElement>("magnitude")?.value_as_number());
    value["matchRadiusPx"] = json!(element::<HtmlInputElement>("matchRadius")?.value_as_number());
    value["display"] = json!({"flipX":false,"flipY":false,"imageFlipX":element::<HtmlInputElement>("imageFlipX")?.checked(),"imageFlipY":element::<HtmlInputElement>("imageFlipY")?.checked(),
        "brightness":element::<HtmlInputElement>("brightness")?.value_as_number(),"contrast":element::<HtmlInputElement>("contrast")?.value_as_number(),
        "highPassImage":element::<HtmlInputElement>("highPass")?.checked(),"highPassWidthPx":element::<HtmlInputElement>("highPassSigma")?.value_as_number(),"displayClipPercent":element::<HtmlInputElement>("displayClip")?.value_as_number()});
    value["rustMaskedTiles"] = json!(app.masked_tiles);
    Ok(value)
}

pub(super) fn connect(app: Rc<RefCell<App>>) -> Result<(), JsValue> {
    ui::action(app.clone(), "downloadMapper", |_| {
        let language = element::<web_sys::HtmlSelectElement>("exportLanguage")?.value();
        let text = wisc_core::code_exports::mapper(&ui::read_job()?.initial, &language)
            .map_err(js_error)?;
        let extension = match language.as_str() {
            "c" => "c",
            "julia" => "jl",
            "matlab" => "m",
            _ => "py",
        };
        ui::download_bytes(&format!("wisc_mapper.{extension}"), text.as_bytes())
    })?;
    ui::action(app.clone(), "copyParameters", |_| {
        let language = element::<web_sys::HtmlSelectElement>("exportLanguage")?.value();
        let text = wisc_core::code_exports::parameters(&ui::read_job()?.initial, &language)
            .map_err(js_error)?;
        wasm_bindgen_futures::spawn_local(async move {
            match wasm_bindgen_futures::JsFuture::from(
                web_sys::window()
                    .unwrap()
                    .navigator()
                    .clipboard()
                    .write_text(&text),
            )
            .await
            {
                Ok(_) => status("Full-precision optpar copied"),
                Err(_) => status(
                    "Clipboard unavailable; download a mapper to obtain the full-precision optpar",
                ),
            }
        });
        Ok(())
    })?;
    ui::action(app.clone(), "downloadSession", |app| {
        app.session_ready = true;
        autosave(app);
        let bytes =
            serde_json::to_vec_pretty(&snapshot(app)?).map_err(|e| js_error(e.to_string()))?;
        ui::download_bytes("wisc-session.json", &bytes)
    })?;
    ui::action(app.clone(), "downloadLegacy", |app| {
        let bytes =
            serde_json::to_vec_pretty(&legacy(app)?).map_err(|e| js_error(e.to_string()))?;
        ui::download_bytes("metadata.json", &bytes)
    })?;
    ui::action(app.clone(), "restoreSession", |app| {
        let text = storage()?
            .get_item(&key(app))?
            .ok_or_else(|| js_error("no saved session for this image"))?;
        let session = serde_json::from_str(&text).map_err(|e| js_error(e.to_string()))?;
        restore(app, session)
    })?;
    for id in NUMBERS.iter().chain(CHECKS.iter()) {
        let target = app.clone();
        let callback = Closure::<dyn FnMut(Event)>::new(move |_| {
            autosave(&target.borrow());
        });
        element::<HtmlInputElement>(id)?
            .add_event_listener_with_callback("change", callback.as_ref().unchecked_ref())?;
        callback.forget();
    }
    Ok(())
}
