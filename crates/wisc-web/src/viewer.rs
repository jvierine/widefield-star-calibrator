//! Browser-only event wiring; all pixel measurements live in wisc-core.
use super::*;
use web_sys::{KeyboardEvent, MouseEvent, WheelEvent};

pub(super) fn checked(id: &str) -> bool {
    element::<HtmlInputElement>(id).is_ok_and(|input| input.checked())
}

pub(super) fn raw_point(app: &App, point: [f64; 2]) -> [f64; 2] {
    wisc_core::inspection::Viewport::mirror_pixel(
        app.viewport
            .image_coordinate(point, [app.width, app.height]),
        [app.width, app.height],
        [checked("imageFlipX"), checked("imageFlipY")],
    )
}

pub(super) fn draw_labels(app: &App) {
    let draw = (|| -> Result<(), JsValue> {
        let canvas = element::<HtmlCanvasElement>("starLabels")?;
        if canvas.width() != app.width || canvas.height() != app.height {
            canvas.set_width(app.width);
            canvas.set_height(app.height);
        }
        let context = canvas
            .get_context("2d")?
            .ok_or_else(|| js_error("annotation canvas unavailable"))?
            .dyn_into::<web_sys::CanvasRenderingContext2d>()?;
        context.clear_rect(0.0, 0.0, app.width as f64, app.height as f64);
        if app.width == 0
            || app.height == 0
            || !checked("showNames")
            || !app.show_markers
            || app.pure_view
        {
            return Ok(());
        }
        let job = ui::read_job()?;
        let rect = app.canvas.get_bounding_client_rect();
        let scale = app.width as f64 / rect.width().max(1.0);
        context.set_font(&format!(
            "{}px RustplotlibPagella, Palatino, serif",
            13.0 * scale
        ));
        context.set_fill_style_str("#fff4d7");
        context.set_stroke_style_str("#07101b");
        context.set_line_width(3.0 * scale);
        let mut occupied = std::collections::HashSet::new();
        for star in &app.sky {
            let Some(pixel) = job.initial.project(star.azimuth_rad, star.zenith_rad) else {
                continue;
            };
            let pixel = wisc_core::inspection::Viewport::mirror_pixel(
                pixel,
                [app.width, app.height],
                [checked("imageFlipX"), checked("imageFlipY")],
            );
            let normalized = [
                ((pixel[0] + 0.5) / app.width as f64 - app.viewport.center[0]) * app.viewport.zoom
                    + 0.5,
                ((pixel[1] + 0.5) / app.height as f64 - app.viewport.center[1]) * app.viewport.zoom
                    + 0.5,
            ];
            if normalized.iter().any(|v| !(0.0..=1.0).contains(v)) {
                continue;
            }
            let cell = (
                (normalized[0] * rect.width() / 110.0) as i32,
                (normalized[1] * rect.height() / 20.0) as i32,
            );
            if !occupied.insert(cell) {
                continue;
            }
            if let Some(entry) = app.catalog.get(star.catalog_index) {
                let (x, y) = (
                    normalized[0] * app.width as f64 + 6.0 * scale,
                    normalized[1] * app.height as f64 - 5.0 * scale,
                );
                context.stroke_text(&entry.name, x, y)?;
                context.fill_text(&entry.name, x, y)?;
            }
        }
        Ok(())
    })();
    if let Err(error) = draw {
        web_sys::console::warn_1(&error);
    }
}

pub(super) fn screen(app: &App, event: &MouseEvent) -> [f64; 2] {
    let rect = app.canvas.get_bounding_client_rect();
    [
        (f64::from(event.client_x()) - rect.left()) / rect.width(),
        (f64::from(event.client_y()) - rect.top()) / rect.height(),
    ]
}

pub(super) fn draw_diagnostics(app: &App) {
    if checked("showResiduals") && !app.pure_view && app.show_markers {
        if let Ok(job) = ui::read_job() {
            let mut vectors = Vec::new();
            for pair in &job.pairs {
                if let Some(pixel) = job.initial.project(pair.azimuth_rad, pair.zenith_rad) {
                    vectors.extend([
                        pair.x_px as f32,
                        pair.y_px as f32,
                        (pair.x_px + 20.0 * (pixel[0] - pair.x_px)) as f32,
                        (pair.y_px + 20.0 * (pixel[1] - pair.y_px)) as f32,
                    ]);
                }
            }
            app.draw_geometry(&vectors, [1.0, 0.3, 0.4], Gl::LINES);
        }
    }
    if checked("showGrid") {
        if let Ok(job) = ui::read_job() {
            let mut lines = Vec::new();
            // Split at invalid projections and projection discontinuities.
            for az_line in [true, false] {
                let n = if az_line { 12 } else { 6 };
                let length = if az_line { 90 } else { 360 };
                for fixed in 0..n {
                    let mut previous: Option<[f64; 2]> = None;
                    for moving in 0..=length {
                        let az = if az_line {
                            fixed as f64 * 30.0
                        } else {
                            moving as f64
                        };
                        let ze = if az_line {
                            moving as f64
                        } else {
                            fixed as f64 * 15.0
                        };
                        let pixel = job
                            .initial
                            .project(az * wisc_core::DEG, ze * wisc_core::DEG)
                            .filter(|p| {
                                p[0] >= 0.0
                                    && p[1] >= 0.0
                                    && p[0] < app.width as f64
                                    && p[1] < app.height as f64
                            });
                        if let (Some(a), Some(b)) = (previous, pixel) {
                            if (a[0] - b[0]).hypot(a[1] - b[1])
                                < app.width.max(app.height) as f64 * 0.1
                            {
                                lines.extend([a[0] as f32, a[1] as f32, b[0] as f32, b[1] as f32]);
                            }
                        }
                        previous = pixel;
                    }
                }
            }
            app.draw_geometry(&lines, [0.45, 0.5, 0.65], Gl::LINES);
        }
    }
    if checked("showCelestial") {
        if let Ok(job) = ui::read_job() {
            if let Some(observation) = &job.observation {
                let mut lines = Vec::new();
                for ra_line in [true, false] {
                    for fixed in 0..12 {
                        let mut previous: Option<[f64; 2]> = None;
                        for moving in 0..=360 {
                            let (ra, dec) = if ra_line {
                                (fixed as f64 * 2.0, -89.0 + moving as f64 / 360.0 * 178.0)
                            } else {
                                (moving as f64 / 15.0, -82.5 + fixed as f64 * 15.0)
                            };
                            let [az, ze] = wisc_core::radec_to_azimuth_zenith(
                                ra,
                                dec,
                                observation.unix_millis,
                                observation.latitude_deg,
                                observation.longitude_deg,
                            );
                            let pixel = if ze <= std::f64::consts::FRAC_PI_2 {
                                job.initial.project(az, ze).filter(|p| {
                                    p[0] >= 0.0
                                        && p[1] >= 0.0
                                        && p[0] < app.width as f64
                                        && p[1] < app.height as f64
                                })
                            } else {
                                None
                            };
                            if let (Some(a), Some(b)) = (previous, pixel) {
                                if (a[0] - b[0]).hypot(a[1] - b[1])
                                    < (app.width.max(app.height) as f64) * 0.1
                                {
                                    lines.extend([
                                        a[0] as f32,
                                        a[1] as f32,
                                        b[0] as f32,
                                        b[1] as f32,
                                    ]);
                                }
                            }
                            previous = pixel;
                        }
                    }
                }
                app.draw_geometry(&lines, [0.65, 0.45, 0.85], Gl::LINES);
            }
        }
    }
    if app.pure_view {
        return;
    }
    let mut boxes = Vec::new();
    for tile in &app.masked_tiles {
        let x = (tile[0] * 128) as f32 - 0.5;
        let y = (tile[1] * 128) as f32 - 0.5;
        let right = (x + 128.0).min(app.width as f32 - 0.5);
        let bottom = (y + 128.0).min(app.height as f32 - 0.5);
        boxes.extend([
            x, y, right, y, right, y, right, bottom, right, bottom, x, bottom, x, bottom, x, y,
        ]);
    }
    app.draw_geometry(&boxes, [1.0, 0.25, 0.25], Gl::LINES);
}

pub(super) fn show_density(
    app: &mut App,
    centroid: &wisc_core::inspection::Centroid,
) -> Result<(), JsValue> {
    if app.density_plot.is_none() {
        app.density_plot = Some(rustplotlib_web::HeatmapView::new(
            element::<HtmlCanvasElement>("densityPlot")?,
            element::<HtmlCanvasElement>("densityAxes")?,
        )?);
    }
    let plot = app.density_plot.as_mut().unwrap();
    let maximum = centroid
        .density
        .iter()
        .copied()
        .fold(0.0_f32, f32::max)
        .max(f32::EPSILON);
    // Rustplotlib owns the raster, axes, palette, and colorbar. Negating y
    // keeps raw image top-down orientation while using increasing plot axes.
    let values: Vec<_> = centroid
        .density
        .chunks_exact(centroid.size)
        .rev()
        .flatten()
        .copied()
        .collect();
    let half = 0.5 / 40.0;
    let span = centroid.size as f64 / 40.0;
    plot.set_data(
        centroid.size as u32,
        centroid.size as u32,
        &values,
        centroid.origin[0] - half,
        centroid.origin[0] + span - half,
        -(centroid.origin[1] + span - half),
        -(centroid.origin[1] - half),
    )?;
    plot.set_labels("x [pixel]", "−y [pixel]", "KDE density", false)?;
    plot.set_palette("viridis")?;
    plot.set_scale(0.0, maximum)?;
    plot.resize(
        600.0,
        500.0,
        web_sys::window()
            .map(|w| w.device_pixel_ratio())
            .unwrap_or(1.0),
    )?;
    element::<web_sys::HtmlElement>("densityInfo")?.set_text_content(Some(&format!(
        "40× KDE: x={:.4}, y={:.4}; background {:.3}",
        centroid.position[0], centroid.position[1], centroid.background
    )));
    Ok(())
}

pub(super) fn update_texture(app: &App) -> Result<(), JsValue> {
    if app.width == 0 {
        return Ok(());
    }
    let clip = element::<HtmlInputElement>("displayClip")?.value_as_number();
    if !clip.is_finite() || !(0.0..=50.0).contains(&clip) {
        return Err(js_error(
            "display clipping must be between 0 and 50 percent",
        ));
    }
    let pixels = if checked("highPass") {
        let sigma = element::<HtmlInputElement>("highPassSigma")?.value_as_number();
        if !sigma.is_finite() || !(0.1..=300.0).contains(&sigma) {
            return Err(js_error("Gaussian width must be 0.1–300 pixels"));
        }
        let clean: Vec<_> = app
            .luminance
            .iter()
            .map(|p| if p.is_finite() { *p } else { 0.0 })
            .collect();
        let background = wisc_core::inspection::gaussian_blur(
            &clean,
            app.width as usize,
            app.height as usize,
            sigma,
        )
        .map_err(js_error)?;
        let difference: Vec<_> = clean
            .iter()
            .zip(background)
            .map(|(p, b)| (p - b).max(0.0))
            .collect();
        let [low, high] =
            wisc_core::inspection::percentile_bounds(&difference, clip).map_err(js_error)?;
        difference
            .iter()
            .flat_map(|p| {
                let v = ((f64::from(*p) - low) / (high - low) * 255.0)
                    .clamp(0.0, 255.0)
                    .round() as u8;
                [v, v, v, 255]
            })
            .collect()
    } else if clip > 0.0 {
        let [low, high] =
            wisc_core::inspection::percentile_bounds(&app.luminance, clip).map_err(js_error)?;
        if app.image_bytes.starts_with(b"SIMPLE  ") {
            app.luminance
                .iter()
                .flat_map(|p| {
                    let v = ((f64::from(*p) - low) / (high - low) * 255.0)
                        .clamp(0.0, 255.0)
                        .round() as u8;
                    [v, v, v, 255]
                })
                .collect()
        } else {
            app.original_rgba
                .as_chunks::<4>()
                .0
                .iter()
                .flat_map(|pixel| {
                    let value = |i| {
                        ((f64::from(pixel[i]) - low) / (high - low) * 255.0)
                            .clamp(0.0, 255.0)
                            .round() as u8
                    };
                    [value(0), value(1), value(2), pixel[3]]
                })
                .collect()
        }
    } else {
        app.original_rgba.clone()
    };
    app.gl.bind_texture(Gl::TEXTURE_2D, Some(&app.texture));
    app.gl
        .tex_image_2d_with_i32_and_i32_and_i32_and_format_and_type_and_opt_u8_array(
            Gl::TEXTURE_2D,
            0,
            Gl::RGBA as i32,
            app.width as i32,
            app.height as i32,
            0,
            Gl::RGBA,
            Gl::UNSIGNED_BYTE,
            Some(&pixels),
        )?;
    app.draw();
    Ok(())
}

pub(super) fn connect(app: Rc<RefCell<App>>) -> Result<(), JsValue> {
    let canvas = app.borrow().canvas.clone();
    connect_touch_and_drop(app.clone())?;
    connect_magnifier(app.clone())?;
    let target = app.clone();
    let wheel = Closure::<dyn FnMut(WheelEvent)>::new(move |event: WheelEvent| {
        event.prevent_default();
        let mut app = target.borrow_mut();
        let anchor = screen(&app, &event);
        if event.ctrl_key() || event.meta_key() {
            let result = (|| -> Result<(), JsValue> {
                let mut job = ui::read_job()?;
                app.remember(job.clone());
                let scale = (-event.delta_y().clamp(-500.0, 500.0) * 0.001).exp();
                for f in &mut job.initial.optpar[..2] {
                    *f = (*f * scale).signum() * (*f * scale).abs().max(0.05);
                }
                job.initial.validate().map_err(js_error)?;
                app.invalidate_fit();
                app.session_ready = true;
                ui::write_job(&job)?;
                ui::controls_from_job(&job)?;
                ui::refresh_overlay(&mut app, &job)
            })();
            if let Err(error) = result {
                status(&format!("Lens zoom failed: {error:?}"));
            }
            return;
        }
        app.viewport.zoom_at(
            anchor,
            (-event.delta_y().clamp(-500.0, 500.0) * 0.002).exp(),
        );
        app.draw();
        persistence::autosave(&app);
    });
    let options = web_sys::AddEventListenerOptions::new();
    options.set_passive(false);
    canvas.add_event_listener_with_callback_and_add_event_listener_options(
        "wheel",
        wheel.as_ref().unchecked_ref(),
        &options,
    )?;
    wheel.forget();
    let target = app.clone();
    let down = Closure::<dyn FnMut(MouseEvent)>::new(move |event: MouseEvent| {
        if event.button() != 0 {
            return;
        }
        event.prevent_default();
        let mut app = target.borrow_mut();
        app.drag = Some(screen(&app, &event));
        app.drag_distance = 0.0;
        app.suppress_click = false;
        if event.ctrl_key() || event.meta_key() || checked("maskMode") {
            if let Ok(job) = ui::read_job() {
                app.remember(job);
            }
        }
    });
    canvas.add_event_listener_with_callback("mousedown", down.as_ref().unchecked_ref())?;
    down.forget();
    let target = app.clone();
    let movement = Closure::<dyn FnMut(MouseEvent)>::new(move |event: MouseEvent| {
        let mut app = target.borrow_mut();
        if let Some(previous) = app.drag {
            let point = screen(&app, &event);
            let delta = [point[0] - previous[0], point[1] - previous[1]];
            let rect = app.canvas.get_bounding_client_rect();
            app.drag_distance += (delta[0] * rect.width()).hypot(delta[1] * rect.height());
            if app.drag_distance > 4.0 {
                if checked("maskMode") {
                    let raw = raw_point(&app, point);
                    if raw[0] >= 0.0
                        && raw[1] >= 0.0
                        && raw[0] < app.width as f64
                        && raw[1] < app.height as f64
                    {
                        let tile = [(raw[0] as u32) / 128, (raw[1] as u32) / 128];
                        if !app.masked_tiles.contains(&tile) {
                            app.masked_tiles.push(tile);
                        }
                    }
                } else if event.ctrl_key() || event.meta_key() {
                    let result = (|| -> Result<(), JsValue> {
                        let mut job = ui::read_job()?;
                        job.initial = if event.shift_key() {
                            wisc_core::geometry::roll_camera(
                                &job.initial,
                                -delta[0] * std::f64::consts::PI,
                            )
                        } else {
                            wisc_core::geometry::drag_camera(
                                &job.initial,
                                raw_point(&app, previous),
                                raw_point(&app, point),
                            )
                        }
                        .map_err(js_error)?;
                        app.invalidate_fit();
                        app.session_ready = true;
                        ui::write_job(&job)?;
                        ui::controls_from_job(&job)?;
                        ui::refresh_overlay(&mut app, &job)
                    })();
                    if let Err(error) = result {
                        status(&format!("Camera drag failed: {error:?}"));
                    }
                } else {
                    app.viewport.pan(delta);
                }
                app.suppress_click = true;
                app.draw();
            }
            app.drag = Some(point);
        }
    });
    let window = web_sys::window().unwrap();
    window.add_event_listener_with_callback("mousemove", movement.as_ref().unchecked_ref())?;
    movement.forget();
    let target = app.clone();
    let up = Closure::<dyn FnMut(MouseEvent)>::new(move |_| {
        let mut app = target.borrow_mut();
        app.drag = None;
        persistence::autosave(&app);
    });
    window.add_event_listener_with_callback("mouseup", up.as_ref().unchecked_ref())?;
    up.forget();
    for id in [
        "brightness",
        "contrast",
        "gammaDisplay",
        "showGrid",
        "showResiduals",
        "showNames",
        "showCelestial",
        "showDetections",
        "imageFlipX",
        "imageFlipY",
    ] {
        let target = app.clone();
        let change = Closure::<dyn FnMut(Event)>::new(move |_| {
            target.borrow().draw();
        });
        element::<HtmlInputElement>(id)?
            .add_event_listener_with_callback("input", change.as_ref().unchecked_ref())?;
        change.forget();
    }
    for id in ["highPass", "highPassSigma", "displayClip"] {
        let target = app.clone();
        let change = Closure::<dyn FnMut(Event)>::new(move |_| {
            if let Err(error) = update_texture(&target.borrow()) {
                status(&format!("Display update failed: {error:?}"));
            }
        });
        element::<HtmlInputElement>(id)?
            .add_event_listener_with_callback("change", change.as_ref().unchecked_ref())?;
        change.forget();
    }
    for id in [
        "zoomIn",
        "zoomOut",
        "resetView",
        "clearMask",
        "toggleImage",
        "toggleMarkers",
    ] {
        let target = app.clone();
        let click = Closure::<dyn FnMut(Event)>::new(move |_| {
            let mut app = target.borrow_mut();
            match id {
                "zoomIn" => app.viewport.zoom_at([0.5, 0.5], 1.5),
                "zoomOut" => app.viewport.zoom_at([0.5, 0.5], 1.0 / 1.5),
                "resetView" => app.viewport = Default::default(),
                "clearMask" => {
                    if let Ok(job) = ui::read_job() {
                        app.remember(job);
                    }
                    app.masked_tiles.clear();
                    let root = if app.original_metadata.get("testCase").is_some() {
                        &mut app.original_metadata["testCase"]
                    } else {
                        &mut app.original_metadata
                    };
                    if root.is_object() {
                        root["badStarFinderRegions"] = serde_json::json!([]);
                        root["badStarFinderDetections"] = serde_json::json!([]);
                        root["rustMaskedTiles"] = serde_json::json!([]);
                    }
                }
                "toggleImage" => {
                    app.show_image = !app.show_image;
                    app.show_markers = true;
                    app.pure_view = false;
                }
                _ => {
                    if let Ok(input) = element::<HtmlInputElement>("showDetections") {
                        input.set_checked(!input.checked());
                    }
                }
            }
            app.draw();
            persistence::autosave(&app);
        });
        element::<web_sys::HtmlButtonElement>(id)?
            .add_event_listener_with_callback("click", click.as_ref().unchecked_ref())?;
        click.forget();
    }
    let key = Closure::<dyn FnMut(KeyboardEvent)>::new(move |event: KeyboardEvent| {
        let tag = event
            .target()
            .and_then(|t| t.dyn_into::<web_sys::Element>().ok())
            .map(|e| e.tag_name())
            .unwrap_or_default();
        if ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].contains(&tag.as_str())
            || event.ctrl_key()
            || event.meta_key()
            || event.alt_key()
        {
            return;
        }
        let mut app = app.borrow_mut();
        match event.key().as_str() {
            "h" | "H" => {
                if let Ok(input) = element::<HtmlInputElement>("showDetections") {
                    input.set_checked(!input.checked());
                }
            }
            "n" | "N" => {
                if let Ok(input) = element::<HtmlInputElement>("showNames") {
                    input.set_checked(!input.checked());
                }
            }
            "c" | "C" => {
                app.show_image = !app.show_image;
                app.show_markers = true;
                app.pure_view = false;
            }
            "x" | "X" => {
                if !app.pure_view || !app.show_image {
                    app.show_image = true;
                    app.show_markers = false;
                } else {
                    app.show_image = false;
                    app.show_markers = true;
                }
                app.pure_view = true;
            }
            "0" => app.viewport = Default::default(),
            "+" | "=" => app.viewport.zoom_at([0.5, 0.5], 1.5),
            "-" | "_" => app.viewport.zoom_at([0.5, 0.5], 1.0 / 1.5),
            "r" | "R" => {
                if let Ok(input) = element::<HtmlInputElement>("showResiduals") {
                    input.set_checked(!input.checked());
                }
            }
            "a" | "A" => {
                if let Ok(input) = element::<HtmlInputElement>("showGrid") {
                    input.set_checked(!input.checked());
                }
            }
            _ => return,
        }
        event.prevent_default();
        app.draw();
    });
    window.add_event_listener_with_callback("keydown", key.as_ref().unchecked_ref())?;
    key.forget();
    Ok(())
}

fn connect_magnifier(app: Rc<RefCell<App>>) -> Result<(), JsValue> {
    let held = Rc::new(RefCell::new(false));
    let window = web_sys::window().unwrap();
    for kind in ["keydown", "keyup"] {
        let held = held.clone();
        let callback = Closure::<dyn FnMut(KeyboardEvent)>::new(move |event: KeyboardEvent| {
            let tag = event
                .target()
                .and_then(|t| t.dyn_into::<web_sys::Element>().ok())
                .map(|e| e.tag_name())
                .unwrap_or_default();
            if ["INPUT", "TEXTAREA", "SELECT"].contains(&tag.as_str()) {
                return;
            }
            if event.key().eq_ignore_ascii_case("s") && !event.ctrl_key() && !event.meta_key() {
                *held.borrow_mut() = kind == "keydown";
                if kind == "keyup" && !checked("magnifier") {
                    if let Ok(canvas) = element::<web_sys::HtmlElement>("magnifierCanvas") {
                        canvas.set_hidden(true);
                    }
                }
            }
        });
        window.add_event_listener_with_callback(kind, callback.as_ref().unchecked_ref())?;
        callback.forget();
    }
    let canvas = app.borrow().canvas.clone();
    let callback = Closure::<dyn FnMut(MouseEvent)>::new(move |event: MouseEvent| {
        let result = (|| -> Result<(), JsValue> {
            let magnifier = element::<HtmlCanvasElement>("magnifierCanvas")?;
            let active = *held.borrow() || checked("magnifier");
            magnifier.set_hidden(!active);
            if !active {
                return Ok(());
            }
            let app = app.borrow();
            if app.width == 0 {
                return Ok(());
            }
            let point = screen(&app, &event);
            let raw = raw_point(&app, point);
            app.draw();
            let context = magnifier
                .get_context("2d")?
                .ok_or_else(|| js_error("magnifier context unavailable"))?
                .dyn_into::<web_sys::CanvasRenderingContext2d>()?;
            context.set_image_smoothing_enabled(false);
            context.set_fill_style_str("#000");
            context.fill_rect(0.0, 0.0, 288.0, 288.0);
            let side = 48.0;
            context.draw_image_with_html_canvas_element_and_sw_and_sh_and_dx_and_dy_and_dw_and_dh(
                &app.canvas,
                point[0] * app.canvas.width() as f64 - side / 2.0,
                point[1] * app.canvas.height() as f64 - side / 2.0,
                side,
                side,
                0.0,
                0.0,
                288.0,
                288.0,
            )?;
            context.set_stroke_style_str("#f9c74f");
            context.begin_path();
            context.move_to(144.0, 0.0);
            context.line_to(144.0, 288.0);
            context.move_to(0.0, 144.0);
            context.line_to(288.0, 144.0);
            context.stroke();
            context.set_fill_style_str("#f9c74f");
            context.set_font("13px sans-serif");
            context.fill_text(&format!("raw x {:.2}, y {:.2}", raw[0], raw[1]), 8.0, 18.0)?;
            let window = web_sys::window().unwrap();
            let max_x = window.inner_width()?.as_f64().unwrap_or(1000.0) - 300.0;
            let max_y = window.inner_height()?.as_f64().unwrap_or(1000.0) - 300.0;
            magnifier.set_attribute(
                "style",
                &format!(
                    "left:{}px;top:{}px",
                    (event.client_x() as f64 + 16.0).min(max_x).max(0.0),
                    (event.client_y() as f64 + 16.0).min(max_y).max(0.0)
                ),
            )?;
            Ok(())
        })();
        if let Err(error) = result {
            status(&format!("Magnifier failed: {error:?}"));
        }
    });
    canvas.add_event_listener_with_callback("mousemove", callback.as_ref().unchecked_ref())?;
    callback.forget();
    let callback = Closure::<dyn FnMut(Event)>::new(move |_| {
        if let Ok(canvas) = element::<web_sys::HtmlElement>("magnifierCanvas") {
            canvas.set_hidden(true);
        }
    });
    canvas.add_event_listener_with_callback("mouseleave", callback.as_ref().unchecked_ref())?;
    callback.forget();
    Ok(())
}

fn connect_touch_and_drop(app: Rc<RefCell<App>>) -> Result<(), JsValue> {
    let canvas = app.borrow().canvas.clone();
    // Centre and pinch span in normalized screen coordinates. A single finger
    // pans; two fingers zoom at their midpoint without changing measured stars.
    let previous = Rc::new(RefCell::new(None::<([f64; 2], f64)>));
    for kind in ["touchstart", "touchmove", "touchend", "touchcancel"] {
        let target = app.clone();
        let previous = previous.clone();
        let callback =
            Closure::<dyn FnMut(web_sys::TouchEvent)>::new(move |event: web_sys::TouchEvent| {
                if kind == "touchmove" {
                    event.prevent_default();
                }
                let mut app = target.borrow_mut();
                let rect = app.canvas.get_bounding_client_rect();
                let touches = event.touches();
                let Some(first) = touches.item(0) else {
                    *previous.borrow_mut() = None;
                    persistence::autosave(&app);
                    return;
                };
                let a = [
                    (first.client_x() as f64 - rect.left()) / rect.width(),
                    (first.client_y() as f64 - rect.top()) / rect.height(),
                ];
                let (center, span) = if let Some(second) = touches.item(1) {
                    let b = [
                        (second.client_x() as f64 - rect.left()) / rect.width(),
                        (second.client_y() as f64 - rect.top()) / rect.height(),
                    ];
                    (
                        [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0],
                        (a[0] - b[0]).hypot(a[1] - b[1]),
                    )
                } else {
                    (a, 0.0)
                };
                if kind == "touchmove" {
                    if let Some((old, distance)) = *previous.borrow() {
                        if span > 0.0 && distance > 0.0 {
                            app.viewport.zoom_at(old, span / distance);
                        }
                        app.viewport.pan([center[0] - old[0], center[1] - old[1]]);
                        app.suppress_click = true;
                        app.draw();
                    }
                } else if kind == "touchstart" {
                    app.suppress_click = false;
                }
                *previous.borrow_mut() = Some((center, span));
            });
        let options = web_sys::AddEventListenerOptions::new();
        options.set_passive(false);
        canvas.add_event_listener_with_callback_and_add_event_listener_options(
            kind,
            callback.as_ref().unchecked_ref(),
            &options,
        )?;
        callback.forget();
    }
    for kind in ["dragover", "drop"] {
        let target = app.clone();
        let callback =
            Closure::<dyn FnMut(web_sys::DragEvent)>::new(move |event: web_sys::DragEvent| {
                event.prevent_default();
                if kind == "drop" {
                    if let Some(file) = event
                        .data_transfer()
                        .and_then(|d| d.files())
                        .and_then(|f| f.get(0))
                    {
                        let name = file.name().to_ascii_lowercase();
                        let calibration = [".json", ".h5", ".hdf5", ".zip"]
                            .iter()
                            .any(|e| name.ends_with(e));
                        read_file(target.clone(), file, calibration);
                    }
                }
            });
        canvas.add_event_listener_with_callback(kind, callback.as_ref().unchecked_ref())?;
        callback.forget();
    }
    Ok(())
}
