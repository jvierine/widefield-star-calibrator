//! Local Rustplotlib/report exports. Image data never leaves the browser.
use super::*;
use base64::Engine;

fn canvas_png(canvas: &HtmlCanvasElement) -> Result<Vec<u8>, JsValue> {
    let url = canvas.to_data_url_with_type("image/png")?;
    let data = url
        .strip_prefix("data:image/png;base64,")
        .ok_or_else(|| js_error("PNG export failed"))?;
    base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| js_error(e.to_string()))
}

fn plot_png(points: &[[f64; 2]]) -> Result<Vec<u8>, JsValue> {
    let canvas = web_sys::window()
        .unwrap()
        .document()
        .unwrap()
        .create_element("canvas")?
        .dyn_into::<HtmlCanvasElement>()?;
    let mut plot = SeriesView::new(canvas.clone())?;
    let extent = points
        .iter()
        .flatten()
        .map(|v| v.abs())
        .fold(1.0_f64, f64::max)
        * 1.1;
    plot.begin(
        560.0,
        560.0,
        1.0,
        -extent,
        extent,
        -extent,
        extent,
        "Δx [pixel]",
        "Δy [pixel]",
    )?;
    plot.series(
        &points.iter().flatten().copied().collect::<Vec<_>>(),
        "#2b73a8",
        false,
        3.5,
    )?;
    canvas_png(&canvas)
}

pub(super) fn connect(app: Rc<RefCell<App>>) -> Result<(), JsValue> {
    for id in ["flipModelX", "flipModelY", "resetPointing"] {
        ui::action(app.clone(), id, move |app| {
            let mut job = ui::read_job()?;
            app.remember(job.clone());
            match id {
                "flipModelX" => job.initial.optpar[0] = -job.initial.optpar[0],
                "flipModelY" => job.initial.optpar[1] = -job.initial.optpar[1],
                _ => job.initial.optpar[2..5].fill(0.0),
            }
            app.invalidate_fit();
            app.session_ready = app.width > 0;
            ui::write_job(&job)?;
            ui::controls_from_job(&job)?;
            ui::refresh_overlay(app, &job)
        })?;
    }
    ui::action(app.clone(), "downloadMiracle", |app| {
        let product = wisc_core::miracle::product(&ui::read_job()?).map_err(js_error)?;
        persistence::autosave(app);
        ui::download_bytes(
            "miracle.txt",
            wisc_core::miracle::ascii(&product).as_bytes(),
        )
    })?;
    ui::action(app.clone(), "downloadResiduals", |app| {
        let fit = app
            .fitted
            .as_ref()
            .ok_or_else(|| js_error("fit the selected stars before exporting residuals"))?;
        let job = ui::read_job()?;
        if fit.calibration != job.initial
            || fit.pairs != job.pairs
            || fit.observation != job.observation
        {
            return Err(js_error("calibration changed; fit again before exporting"));
        }
        ui::download_bytes("residuals.png", &plot_png(&fit.residuals_px)?)
    })?;
    ui::action(app.clone(), "downloadReport", |app| {
        let fit = app
            .fitted
            .as_ref()
            .ok_or_else(|| js_error("fit the selected stars before exporting a report"))?;
        let job = ui::read_job()?;
        if fit.calibration != job.initial
            || fit.pairs != job.pairs
            || fit.observation != job.observation
        {
            return Err(js_error("calibration changed; fit again before exporting"));
        }
        let residuals = plot_png(&fit.residuals_px)?;
        let product = wisc_core::miracle::product(&job).map_err(js_error)?;
        let equidistant = plot_png(
            &product
                .equidistant_residuals
                .iter()
                .map(|r| [r[1], r[0]])
                .collect::<Vec<_>>(),
        )?;
        let equisolid = plot_png(
            &product
                .equisolid_residuals
                .iter()
                .map(|r| [r[1], r[0]])
                .collect::<Vec<_>>(),
        )?;
        // Capture immediately, before the browser may discard the GPU buffer.
        app.draw();
        let canvas = web_sys::window()
            .unwrap()
            .document()
            .unwrap()
            .create_element("canvas")?
            .dyn_into::<HtmlCanvasElement>()?;
        canvas.set_width(app.width);
        canvas.set_height(app.height);
        let context = canvas
            .get_context("2d")?
            .ok_or_else(|| js_error("canvas export unavailable"))?
            .dyn_into::<web_sys::CanvasRenderingContext2d>()?;
        context.draw_image_with_html_canvas_element(&app.canvas, 0.0, 0.0)?;
        context.draw_image_with_html_canvas_element(
            &element::<HtmlCanvasElement>("starLabels")?,
            0.0,
            0.0,
        )?;
        let viewer = canvas_png(&canvas)?;
        let session = persistence::snapshot(app)?;
        let bytes = wisc_core::report::bundle(
            &session,
            &app.image_bytes,
            &[
                ("residuals.png", residuals),
                ("miracle_equidistant.png", equidistant),
                ("miracle_equisolid.png", equisolid),
                ("viewer.png", viewer),
            ],
        )
        .map_err(js_error)?;
        ui::download_bytes("wisc-calibration-report.zip", &bytes)
    })?;
    Ok(())
}
