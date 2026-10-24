//! Browser-only event wiring; all pixel measurements live in wisc-core.
use super::*;
use web_sys::{KeyboardEvent, MouseEvent, WheelEvent};

fn checked(id: &str) -> bool {
    element::<HtmlInputElement>(id).is_ok_and(|input| input.checked())
}

pub(super) fn screen(app: &App, event: &MouseEvent) -> [f64; 2] {
    let rect = app.canvas.get_bounding_client_rect();
    [
        (f64::from(event.client_x()) - rect.left()) / rect.width(),
        (f64::from(event.client_y()) - rect.top()) / rect.height(),
    ]
}

pub(super) fn draw_diagnostics(app: &App) {
    if checked("showResiduals") {
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
    let pixels = if checked("highPass") {
        let sigma = element::<HtmlInputElement>("highPassSigma")?.value_as_number();
        if !sigma.is_finite() || !(0.1..=256.0).contains(&sigma) {
            return Err(js_error("Gaussian width must be 0.1–256 pixels"));
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
        let maximum = difference.iter().copied().fold(f32::EPSILON, f32::max);
        difference
            .iter()
            .flat_map(|p| {
                let v = (p / maximum * 255.0).round() as u8;
                [v, v, v, 255]
            })
            .collect()
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
    let target = app.clone();
    let wheel = Closure::<dyn FnMut(WheelEvent)>::new(move |event: WheelEvent| {
        event.prevent_default();
        let mut app = target.borrow_mut();
        let anchor = screen(&app, &event);
        app.viewport.zoom_at(
            anchor,
            (-event.delta_y().clamp(-500.0, 500.0) * 0.002).exp(),
        );
        app.draw();
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
                app.viewport.pan(delta);
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
        target.borrow_mut().drag = None;
    });
    window.add_event_listener_with_callback("mouseup", up.as_ref().unchecked_ref())?;
    up.forget();
    for id in [
        "brightness",
        "contrast",
        "gammaDisplay",
        "showGrid",
        "showResiduals",
    ] {
        let target = app.clone();
        let change = Closure::<dyn FnMut(Event)>::new(move |_| {
            target.borrow().draw();
        });
        element::<HtmlInputElement>(id)?
            .add_event_listener_with_callback("input", change.as_ref().unchecked_ref())?;
        change.forget();
    }
    for id in ["highPass", "highPassSigma"] {
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
    for id in ["resetView", "clearMask", "toggleImage", "toggleMarkers"] {
        let target = app.clone();
        let click = Closure::<dyn FnMut(Event)>::new(move |_| {
            let mut app = target.borrow_mut();
            match id {
                "resetView" => app.viewport = Default::default(),
                "clearMask" => app.masked_tiles.clear(),
                "toggleImage" => app.show_image = !app.show_image,
                _ => app.show_markers = !app.show_markers,
            }
            app.draw();
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
            "h" | "H" => app.show_markers = !app.show_markers,
            "c" | "C" => app.show_image = !app.show_image,
            "x" | "X" => {
                app.show_image = true;
                app.show_markers = !app.show_markers;
            }
            "0" => app.viewport = Default::default(),
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
