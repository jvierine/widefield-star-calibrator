//! Preserve the original WISC layout; phones hide the same sidebar behind ⚙.
use super::*;
use web_sys::{HtmlButtonElement, HtmlElement, KeyboardEvent};

fn body() -> Result<HtmlElement, JsValue> {
    web_sys::window()
        .unwrap()
        .document()
        .unwrap()
        .body()
        .ok_or_else(|| js_error("missing document body"))
}

pub(super) fn phone() -> bool {
    body().is_ok_and(|body| body.class_list().contains("phone-mode"))
}

fn drawer(open: bool) -> Result<(), JsValue> {
    let open = open && phone();
    let body = body()?;
    if open {
        body.class_list().add_1("settings-open")?;
    } else {
        body.class_list().remove_1("settings-open")?;
    }
    element::<HtmlButtonElement>("settingsToggle")?
        .set_attribute("aria-expanded", if open { "true" } else { "false" })?;
    element::<HtmlElement>("settingsBackdrop")?.set_hidden(!open);
    let panel = element::<HtmlElement>("settingsPanel")?;
    panel.set_attribute(
        "aria-hidden",
        if phone() && !open { "true" } else { "false" },
    )?;
    if open {
        panel.set_attribute("role", "dialog")?;
        panel.set_attribute("aria-modal", "true")?;
    } else {
        panel.remove_attribute("role")?;
        panel.remove_attribute("aria-modal")?;
    }
    let document = web_sys::window().unwrap().document().unwrap();
    for element in [
        Some(element::<HtmlElement>("viewerPanel")?.into()),
        document.query_selector("header")?,
    ]
    .into_iter()
    .flatten()
    {
        if open {
            element.set_attribute("inert", "")?;
        } else {
            element.remove_attribute("inert")?;
        }
    }
    if open {
        element::<HtmlElement>("settingsClose")?.focus()?;
    }
    Ok(())
}

fn mode(phone: bool) -> Result<(), JsValue> {
    let body = body()?;
    if phone {
        body.class_list().add_1("phone-mode")?;
    } else {
        body.class_list().remove_1("phone-mode")?;
    }
    let button = element::<HtmlButtonElement>("phoneModeToggle")?;
    button.set_attribute("aria-pressed", if phone { "true" } else { "false" })?;
    button.set_text_content(Some(if phone { "Desktop" } else { "Phone mode" }));
    drawer(false)
}

pub(super) fn fit_viewer(app: &App) -> Result<(), JsValue> {
    let rect = element::<HtmlElement>("viewerPanel")?.get_bounding_client_rect();
    let width = if app.width > 0 {
        app.width as f64
    } else {
        960.0
    };
    let height = if app.height > 0 {
        app.height as f64
    } else {
        540.0
    };
    let scale = (rect.width() / width)
        .min(rect.height() / height)
        .max(0.001);
    // Size the actual canvas box, not merely its pixels via object-fit. Picking
    // must use the true image rectangle, excluding the black letterbox margins.
    element::<HtmlElement>("imagePanel")?.set_attribute(
        "style",
        &format!(
            "width:{:.3}px;height:{:.3}px",
            width * scale,
            height * scale
        ),
    )?;
    element::<HtmlElement>("canvasHint")?.set_hidden(app.width > 0);
    element::<HtmlElement>("zoomValue")?
        .set_text_content(Some(&format!("{:.1}×", app.viewport.zoom)));
    Ok(())
}

pub(super) fn connect(app: Rc<RefCell<App>>) -> Result<(), JsValue> {
    let window = web_sys::window().unwrap();
    let preference = Rc::new(RefCell::new(
        window
            .local_storage()
            .ok()
            .flatten()
            .and_then(|s| s.get_item("wisc-phone-mode").ok().flatten())
            .and_then(|s| match s.as_str() {
                "phone" => Some(true),
                "desktop" => Some(false),
                _ => None,
            }),
    ));
    mode(
        preference
            .borrow()
            .unwrap_or(window.inner_width()?.as_f64().unwrap_or(1024.0) <= 760.0),
    )?;
    for id in [
        "settingsToggle",
        "settingsClose",
        "settingsBackdrop",
        "phoneModeToggle",
    ] {
        let target = app.clone();
        let preference = preference.clone();
        let callback = Closure::<dyn FnMut(Event)>::new(move |_| {
            let result = (|| -> Result<(), JsValue> {
                match id {
                    "settingsToggle" => drawer(true)?,
                    "phoneModeToggle" => {
                        let next = !phone();
                        *preference.borrow_mut() = Some(next);
                        mode(next)?;
                        if let Ok(Some(storage)) = web_sys::window().unwrap().local_storage() {
                            let _ = storage.set_item(
                                "wisc-phone-mode",
                                if next { "phone" } else { "desktop" },
                            );
                        }
                    }
                    _ => {
                        drawer(false)?;
                        element::<HtmlElement>("settingsToggle")?.focus()?;
                    }
                }
                target.borrow().draw();
                Ok(())
            })();
            if let Err(error) = result {
                status(&format!("Layout failed: {error:?}"));
            }
        });
        element::<HtmlElement>(id)?
            .add_event_listener_with_callback("click", callback.as_ref().unchecked_ref())?;
        callback.forget();
    }
    let target = app.clone();
    let callback = Closure::<dyn FnMut(Event)>::new(move |_| {
        if preference.borrow().is_none() {
            let small = web_sys::window()
                .unwrap()
                .inner_width()
                .ok()
                .and_then(|v| v.as_f64())
                .unwrap_or(1024.0)
                <= 760.0;
            if small != phone() {
                let _ = mode(small);
            }
        }
        target.borrow().draw();
    });
    window.add_event_listener_with_callback("resize", callback.as_ref().unchecked_ref())?;
    callback.forget();
    let callback = Closure::<dyn FnMut(KeyboardEvent)>::new(move |event: KeyboardEvent| {
        if event.key() == "Escape" && body().is_ok_and(|b| b.class_list().contains("settings-open"))
        {
            event.prevent_default();
            let _ = drawer(false);
            if let Ok(button) = element::<HtmlElement>("settingsToggle") {
                let _ = button.focus();
            }
        }
    });
    window.add_event_listener_with_callback("keydown", callback.as_ref().unchecked_ref())?;
    callback.forget();
    let callback = Closure::<dyn FnMut(Event)>::new(move |_| {
        if let (Ok(model), Ok(fields)) = (
            element::<web_sys::HtmlSelectElement>("model"),
            element::<HtmlElement>("brownFields"),
        ) {
            fields.set_hidden(model.value() != "20");
        }
    });
    element::<HtmlElement>("model")?
        .add_event_listener_with_callback("change", callback.as_ref().unchecked_ref())?;
    callback.forget();
    app.borrow().draw();
    Ok(())
}
