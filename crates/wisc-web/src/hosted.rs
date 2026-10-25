//! Same-origin test-case API integration. Network I/O never holds an App borrow.
use super::*;
use serde_json::Value;
use wasm_bindgen_futures::{spawn_local, JsFuture};
use web_sys::{HtmlOptionElement, HtmlSelectElement, Request, RequestInit, RequestMode, Response};

fn report(message: &str) {
    if let Ok(output) = element::<web_sys::HtmlElement>("hostedStatus") {
        output.set_text_content(Some(message));
    }
}
pub(super) fn encoded(value: &str) -> String {
    String::from(js_sys::encode_uri_component(value))
}
pub(super) async fn response(request: &Request) -> Result<Response, JsValue> {
    let response = JsFuture::from(web_sys::window().unwrap().fetch_with_request(request))
        .await?
        .dyn_into::<Response>()?;
    if !response.ok() {
        let text = JsFuture::from(response.text()?)
            .await?
            .as_string()
            .unwrap_or_default();
        let message = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_owned))
            .unwrap_or_else(|| format!("server returned HTTP {}", response.status()));
        return Err(js_error(message));
    }
    Ok(response)
}
pub(super) async fn get(url: &str) -> Result<Response, JsValue> {
    let options = RequestInit::new();
    options.set_mode(RequestMode::SameOrigin);
    response(&Request::new_with_str_and_init(url, &options)?).await
}
pub(super) async fn json(response: Response) -> Result<Value, JsValue> {
    let text = JsFuture::from(response.text()?)
        .await?
        .as_string()
        .ok_or_else(|| js_error("invalid API response"))?;
    serde_json::from_str(&text).map_err(|e| js_error(format!("invalid API JSON: {e}")))
}
async fn reload() -> Result<(), JsValue> {
    let value = json(get("/api/test-cases").await?).await?;
    let rows = value
        .as_array()
        .ok_or_else(|| js_error("invalid test-case list"))?;
    let select = element::<HtmlSelectElement>("hostedCase")?;
    select.set_text_content(None);
    let document = web_sys::window().unwrap().document().unwrap();
    for row in rows {
        let Some(id) = row.get("id").and_then(Value::as_str) else {
            continue;
        };
        let option = document
            .create_element("option")?
            .dyn_into::<HtmlOptionElement>()?;
        option.set_value(id);
        option.set_text(row.get("title").and_then(Value::as_str).unwrap_or(id));
        select.append_child(&option)?;
    }
    report(&format!("{} saved test cases available", rows.len()));
    Ok(())
}

async fn load(app: Rc<RefCell<App>>, id: String) -> Result<(), JsValue> {
    if id.is_empty() {
        return Err(js_error("select a saved test case"));
    }
    let generation = {
        let mut app = app.borrow_mut();
        app.load_generation = app.load_generation.wrapping_add(1);
        app.load_generation
    };
    let value = json(get(&format!("/api/test-cases/{}", encoded(&id))).await?).await?;
    let source = value
        .get("testCase")
        .ok_or_else(|| js_error("missing test case"))?;
    // Validate all scientific metadata before replacing the current image.
    let job = wisc_core::workflow::parse_job(&source.to_string()).map_err(js_error)?;
    wisc_core::session::validate_metadata(source, job.initial.width, job.initial.height)
        .map_err(js_error)?;
    let image_url = value
        .get("imageUrl")
        .and_then(Value::as_str)
        .ok_or_else(|| js_error("missing saved image URL"))?;
    let location = web_sys::window().unwrap().location();
    let url = web_sys::Url::new_with_base(image_url, &location.href()?)?;
    if url.origin() != location.origin()? {
        return Err(js_error("refusing a cross-origin test-case image"));
    }
    let image = get(&url.href()).await?;
    let bytes = Uint8Array::new(&JsFuture::from(image.array_buffer()?).await?).to_vec();
    let order = element::<HtmlSelectElement>("fitsByteOrder")?.value();
    let order = match order.as_str() {
        "big" => FitsByteOrder::Big,
        "little" => FitsByteOrder::Little,
        _ => FitsByteOrder::Auto,
    };
    let decoded = decode(&bytes, order).map_err(js_error)?;
    if (decoded.width, decoded.height) != (job.initial.width, job.initial.height) {
        return Err(js_error("saved image dimensions do not match calibration"));
    }
    let mut app = app.borrow_mut();
    if app.load_generation != generation {
        return Err(js_error(
            "image changed while the test case was downloading; stale load discarded",
        ));
    }
    let name = source
        .get("image")
        .and_then(Value::as_str)
        .unwrap_or("test-case.png");
    app.load_image(&bytes, name)?;
    ui::import_job(
        &mut app,
        &serde_json::to_vec(source).map_err(|e| js_error(e.to_string()))?,
    )?;
    element::<HtmlInputElement>("caseId")?.set_value(&id);
    report(&format!(
        "Loaded {id}; changes stay local until you explicitly submit"
    ));
    Ok(())
}

fn image_mime(app: &App) -> Result<&'static str, JsValue> {
    let bytes = &app.image_bytes;
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Ok("image/png")
    } else if bytes.starts_with(&[255, 216, 255]) {
        Ok("image/jpeg")
    } else if bytes.starts_with(b"SIMPLE  ") {
        Ok("application/fits")
    } else if bytes.get(4..8) == Some(b"ftyp") {
        Ok(if app.image_name.to_ascii_lowercase().ends_with(".heif") {
            "image/heif"
        } else {
            "image/heic"
        })
    } else {
        Err(js_error("unsupported image for submission"))
    }
}

async fn save(app: Rc<RefCell<App>>) -> Result<(), JsValue> {
    let (form, passkey) = {
        let app = app.borrow();
        if app.width == 0 {
            return Err(js_error("load an image before submitting"));
        }
        let id = element::<HtmlInputElement>("caseId")?.value();
        if id.trim().is_empty() {
            return Err(js_error("enter a test-case ID"));
        }
        let value = persistence::legacy(&app)?;
        if !web_sys::window().unwrap().confirm_with_message(&format!("Submit calibration and original image as '{id}'? An existing test case with this ID will be updated."))? {return Ok(());}
        let form = web_sys::FormData::new()?;
        form.append_with_str("testCase", &value.to_string())?;
        let parts = js_sys::Array::new();
        parts.push(&Uint8Array::from(app.image_bytes.as_slice()));
        let options = web_sys::BlobPropertyBag::new();
        options.set_type(image_mime(&app)?);
        let blob = web_sys::Blob::new_with_u8_array_sequence_and_options(&parts, &options)?;
        form.append_with_blob_and_filename("image", &blob, &app.image_name)?;
        (form, element::<HtmlInputElement>("submitPasskey")?.value())
    };
    let options = RequestInit::new();
    options.set_method("POST");
    options.set_mode(RequestMode::SameOrigin);
    options.set_body(form.as_ref());
    let request = Request::new_with_str_and_init("/api/test-cases", &options)?;
    if !passkey.is_empty() {
        request.headers().set("x-aida-submit-passkey", &passkey)?;
    }
    let result = json(response(&request).await?).await?;
    let id = result
        .get("caseId")
        .and_then(Value::as_str)
        .ok_or_else(|| js_error("server did not return a saved case ID"))?;
    element::<HtmlInputElement>("submitPasskey")?.set_value("");
    let url = web_sys::Url::new(&web_sys::window().unwrap().location().href()?)?;
    url.set_search(&format!("?case={}", encoded(id)));
    url.set_hash("");
    element::<HtmlInputElement>("shareLink")?.set_value(&url.href());
    report(&format!(
        "Saved {id}. Share link is ready; your submission passkey was cleared."
    ));
    Ok(())
}

pub(super) fn connect(app: Rc<RefCell<App>>) -> Result<(), JsValue> {
    for id in ["reloadCases", "loadHosted", "submitHosted"] {
        let target = app.clone();
        let button = element::<web_sys::HtmlButtonElement>(id)?;
        let owned = button.clone();
        let callback = Closure::<dyn FnMut(Event)>::new(move |_| {
            let app = target.clone();
            let button = owned.clone();
            button.set_disabled(true);
            spawn_local(async move {
                let result = match id {
                    "reloadCases" => reload().await,
                    "loadHosted" => match element::<HtmlSelectElement>("hostedCase") {
                        Ok(input) => load(app, input.value()).await,
                        Err(error) => Err(error),
                    },
                    _ => save(app).await,
                };
                if let Err(error) = result {
                    report(&format!(
                        "Test-case operation failed: {}",
                        error.as_string().unwrap_or_else(|| format!("{error:?}"))
                    ));
                }
                button.set_disabled(false);
            });
        });
        button.add_event_listener_with_callback("click", callback.as_ref().unchecked_ref())?;
        callback.forget();
    }
    let params =
        web_sys::UrlSearchParams::new_with_str(&web_sys::window().unwrap().location().search()?)?;
    if let Some(token) = params
        .get("tc")
        .or_else(|| params.get("testCase"))
        .or_else(|| params.get("case"))
    {
        let links: Value = serde_json::from_str(include_str!("../../../quick_links.json"))
            .map_err(|e| js_error(e.to_string()))?;
        let id = links
            .get(&token)
            .and_then(Value::as_str)
            .unwrap_or(&token)
            .to_owned();
        spawn_local(async move {
            if let Err(error) = load(app, id).await {
                report(&format!("Quick-link load failed: {error:?}"));
            }
        });
    }
    Ok(())
}
