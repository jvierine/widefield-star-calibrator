use std::{cell::RefCell, rc::Rc};

use js_sys::{Float32Array, Uint8Array};
use rustplotlib_web::SeriesView;
use wasm_bindgen::{closure::Closure, prelude::*, JsCast};
use web_sys::{
    Event, FileReader, HtmlCanvasElement, HtmlInputElement, HtmlTextAreaElement,
    WebGl2RenderingContext as Gl, WebGlBuffer, WebGlProgram, WebGlShader, WebGlTexture,
};
use wisc_core::imaging::{decode, FitsByteOrder};
use wisc_core::{detect_stars, fit, DetectorConfig, FitResult, StarPair};

mod ui;
mod viewer;

thread_local! {
    static APP: RefCell<Option<Rc<RefCell<App>>>> = const { RefCell::new(None) };
}

fn js_error(message: impl Into<String>) -> JsValue {
    JsValue::from_str(&message.into())
}

fn element<T: JsCast>(id: &str) -> Result<T, JsValue> {
    web_sys::window()
        .and_then(|window| window.document())
        .and_then(|document| document.get_element_by_id(id))
        .ok_or_else(|| js_error(format!("missing #{id}")))?
        .dyn_into::<T>()
        .map_err(|_| js_error(format!("#{id} has the wrong element type")))
}

fn status(message: &str) {
    if let Ok(output) = element::<web_sys::HtmlElement>("status") {
        output.set_text_content(Some(message));
    }
}

fn shader(gl: &Gl, kind: u32, source: &str) -> Result<WebGlShader, JsValue> {
    let shader = gl
        .create_shader(kind)
        .ok_or_else(|| js_error("cannot allocate shader"))?;
    gl.shader_source(&shader, source);
    gl.compile_shader(&shader);
    if gl
        .get_shader_parameter(&shader, Gl::COMPILE_STATUS)
        .as_bool()
        != Some(true)
    {
        return Err(js_error(
            gl.get_shader_info_log(&shader).unwrap_or_default(),
        ));
    }
    Ok(shader)
}

fn program(gl: &Gl, vertex: &str, fragment: &str) -> Result<WebGlProgram, JsValue> {
    let program = gl
        .create_program()
        .ok_or_else(|| js_error("cannot allocate program"))?;
    let vertex = shader(gl, Gl::VERTEX_SHADER, vertex)?;
    let fragment = shader(gl, Gl::FRAGMENT_SHADER, fragment)?;
    gl.attach_shader(&program, &vertex);
    gl.attach_shader(&program, &fragment);
    gl.link_program(&program);
    gl.delete_shader(Some(&vertex));
    gl.delete_shader(Some(&fragment));
    if gl
        .get_program_parameter(&program, Gl::LINK_STATUS)
        .as_bool()
        != Some(true)
    {
        return Err(js_error(
            gl.get_program_info_log(&program).unwrap_or_default(),
        ));
    }
    Ok(program)
}

struct App {
    gl: Gl,
    canvas: HtmlCanvasElement,
    image_program: WebGlProgram,
    point_program: WebGlProgram,
    texture: WebGlTexture,
    point_buffer: WebGlBuffer,
    width: u32,
    height: u32,
    detections: Vec<wisc_core::Detection>,
    sky: Vec<wisc_core::workflow::SkyStar>,
    catalog_points: Vec<[f32; 2]>,
    pair_points: Vec<[f32; 2]>,
    history: Vec<wisc_core::workflow::FitJob>,
    fitted: Option<wisc_core::workflow::CalibrationDocument>,
    viewport: wisc_core::inspection::Viewport,
    luminance: Vec<f32>,
    original_rgba: Vec<u8>,
    masked_tiles: Vec<[u32; 2]>,
    drag: Option<[f64; 2]>,
    drag_distance: f64,
    suppress_click: bool,
    show_image: bool,
    show_markers: bool,
    image_metadata: wisc_core::metadata::ImageMetadata,
    density_plot: Option<rustplotlib_web::HeatmapView>,
}

impl App {
    fn new(canvas: HtmlCanvasElement) -> Result<Self, JsValue> {
        let gl = canvas
            .get_context("webgl2")?
            .ok_or_else(|| js_error("WebGL2 is required"))?
            .dyn_into::<Gl>()?;
        let image_program = program(
            &gl,
            r#"#version 300 es
            out vec2 uv;
            void main() {
                vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
                uv = p;
                gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
            }"#,
            r#"#version 300 es
            precision highp float;
            uniform sampler2D image_texture;
            uniform vec3 view; // centre x/y (top-down), zoom
            uniform vec3 display; // brightness, contrast, gamma
            in vec2 uv;
            out vec4 color;
            void main() {
                vec2 q = view.xy + (vec2(uv.x, 1.0-uv.y)-0.5)/view.z;
                vec3 rgb = texture(image_texture, q).rgb;
                rgb = clamp((rgb-0.5)*display.y + 0.5 + display.x, 0.0, 1.0);
                color = vec4(pow(rgb, vec3(1.0/display.z)), 1.0);
            }"#,
        )?;
        let point_program = program(
            &gl,
            r#"#version 300 es
            in vec2 point_px;
            uniform vec2 image_size;
            uniform vec3 view;
            void main() {
                vec2 q = ((point_px+0.5)/image_size-view.xy)*view.z;
                vec2 clip = vec2(2.0*q.x, -2.0*q.y);
                gl_Position = vec4(clip, 0.0, 1.0);
                gl_PointSize = 7.0;
            }"#,
            r#"#version 300 es
            precision highp float;
            uniform vec3 point_color;
            uniform bool line_mode;
            out vec4 color;
            void main() {
                vec2 d = gl_PointCoord - vec2(0.5);
                if (!line_mode && (dot(d,d) > 0.25 || dot(d,d) < 0.12)) discard;
                color = vec4(point_color, 1.0);
            }"#,
        )?;
        let texture = gl
            .create_texture()
            .ok_or_else(|| js_error("cannot allocate image texture"))?;
        gl.bind_texture(Gl::TEXTURE_2D, Some(&texture));
        gl.tex_parameteri(Gl::TEXTURE_2D, Gl::TEXTURE_MIN_FILTER, Gl::LINEAR as i32);
        gl.tex_parameteri(Gl::TEXTURE_2D, Gl::TEXTURE_MAG_FILTER, Gl::LINEAR as i32);
        gl.tex_parameteri(Gl::TEXTURE_2D, Gl::TEXTURE_WRAP_S, Gl::CLAMP_TO_EDGE as i32);
        gl.tex_parameteri(Gl::TEXTURE_2D, Gl::TEXTURE_WRAP_T, Gl::CLAMP_TO_EDGE as i32);
        let point_buffer = gl
            .create_buffer()
            .ok_or_else(|| js_error("cannot allocate point buffer"))?;
        Ok(Self {
            gl,
            canvas,
            image_program,
            point_program,
            texture,
            point_buffer,
            width: 0,
            height: 0,
            detections: Vec::new(),
            sky: Vec::new(),
            catalog_points: Vec::new(),
            pair_points: Vec::new(),
            history: Vec::new(),
            fitted: None,
            viewport: Default::default(),
            luminance: Vec::new(),
            original_rgba: Vec::new(),
            masked_tiles: Vec::new(),
            drag: None,
            drag_distance: 0.0,
            suppress_click: false,
            show_image: true,
            show_markers: true,
            image_metadata: Default::default(),
            density_plot: None,
        })
    }

    fn invalidate_fit(&mut self) {
        self.fitted = None;
        if let Ok(plot) = element::<HtmlCanvasElement>("residualPlot") {
            plot.set_width(plot.width());
        }
    }

    fn load_image(&mut self, bytes: &[u8], filename: &str) -> Result<(), JsValue> {
        let order = element::<web_sys::HtmlSelectElement>("fitsByteOrder")?.value();
        let order = match order.as_str() {
            "big" => FitsByteOrder::Big,
            "little" => FitsByteOrder::Little,
            _ => FitsByteOrder::Auto,
        };
        let image = decode(bytes, order).map_err(js_error)?;
        self.image_metadata = wisc_core::metadata::read(bytes, filename);
        self.width = image.width;
        self.height = image.height;
        self.viewport = Default::default();
        self.masked_tiles.clear();
        self.luminance.clone_from(&image.luminance);
        self.original_rgba.clone_from(&image.rgba);
        self.canvas.set_width(self.width);
        self.canvas.set_height(self.height);
        self.gl.bind_texture(Gl::TEXTURE_2D, Some(&self.texture));
        self.gl
            .tex_image_2d_with_i32_and_i32_and_i32_and_format_and_type_and_opt_u8_array(
                Gl::TEXTURE_2D,
                0,
                Gl::RGBA as i32,
                self.width as i32,
                self.height as i32,
                0,
                Gl::RGBA,
                Gl::UNSIGNED_BYTE,
                Some(&image.rgba),
            )?;
        self.detections = detect_stars(
            &image.luminance,
            self.width,
            self.height,
            DetectorConfig::default(),
        );
        ui::image_loaded(self, &image)?;
        viewer::update_texture(self)?;
        status(&format!(
            "Loaded {} × {} image; {} detections. Import a saved calibration or set time and site.",
            self.width,
            self.height,
            self.detections.len()
        ));
        Ok(())
    }

    fn draw(&self) {
        if let Ok(output) = element::<web_sys::HtmlElement>("viewStatus") {
            output.set_text_content(Some(&format!(
                "Zoom {:.2}× · centre {:.4}, {:.4} · {} masked tiles",
                self.viewport.zoom,
                self.viewport.center[0],
                self.viewport.center[1],
                self.masked_tiles.len()
            )));
        }
        self.gl
            .viewport(0, 0, self.width as i32, self.height as i32);
        self.gl.clear_color(0.02, 0.025, 0.04, 1.0);
        self.gl.clear(Gl::COLOR_BUFFER_BIT);
        if self.width == 0 || self.height == 0 {
            return;
        }
        if self.show_image {
            self.gl.use_program(Some(&self.image_program));
            self.set_view(&self.image_program);
            let number = |id, fallback| {
                element::<HtmlInputElement>(id)
                    .ok()
                    .map(|input| input.value_as_number())
                    .filter(|v| v.is_finite())
                    .unwrap_or(fallback)
            };
            self.gl.uniform3f(
                self.gl
                    .get_uniform_location(&self.image_program, "display")
                    .as_ref(),
                number("brightness", 0.0) as f32,
                number("contrast", 1.0) as f32,
                number("gammaDisplay", 1.0) as f32,
            );
            self.gl.bind_texture(Gl::TEXTURE_2D, Some(&self.texture));
            self.gl.draw_arrays(Gl::TRIANGLES, 0, 3);
        }
        if !self.show_markers {
            return;
        }

        let points: Vec<f32> = self
            .detections
            .iter()
            .filter(|d| !self.is_masked([d.x, d.y]))
            .flat_map(|detection| [detection.x as f32, detection.y as f32])
            .collect();
        self.draw_points(&points, [0.3, 1.0, 0.45]);
        self.draw_points(
            &self
                .catalog_points
                .iter()
                .flatten()
                .copied()
                .collect::<Vec<_>>(),
            [1.0, 0.55, 0.2],
        );
        self.draw_points(
            &self
                .pair_points
                .iter()
                .flatten()
                .copied()
                .collect::<Vec<_>>(),
            [0.3, 0.65, 1.0],
        );
        viewer::draw_diagnostics(self);
    }

    fn draw_points(&self, points: &[f32], color: [f32; 3]) {
        self.draw_geometry(points, color, Gl::POINTS);
    }

    fn set_view(&self, program: &WebGlProgram) {
        self.gl.uniform3f(
            self.gl.get_uniform_location(program, "view").as_ref(),
            self.viewport.center[0] as f32,
            self.viewport.center[1] as f32,
            self.viewport.zoom as f32,
        );
    }

    fn is_masked(&self, point: [f64; 2]) -> bool {
        self.masked_tiles.contains(&[
            (point[0].max(0.0) as u32) / 128,
            (point[1].max(0.0) as u32) / 128,
        ])
    }

    fn draw_geometry(&self, points: &[f32], color: [f32; 3], mode: u32) {
        self.gl.use_program(Some(&self.point_program));
        self.set_view(&self.point_program);
        self.gl.uniform1i(
            self.gl
                .get_uniform_location(&self.point_program, "line_mode")
                .as_ref(),
            i32::from(mode != Gl::POINTS),
        );
        self.gl.uniform3f(
            self.gl
                .get_uniform_location(&self.point_program, "point_color")
                .as_ref(),
            color[0],
            color[1],
            color[2],
        );
        self.gl
            .bind_buffer(Gl::ARRAY_BUFFER, Some(&self.point_buffer));
        unsafe {
            self.gl.buffer_data_with_array_buffer_view(
                Gl::ARRAY_BUFFER,
                &Float32Array::view(points),
                Gl::STATIC_DRAW,
            );
        }
        let attribute = self.gl.get_attrib_location(&self.point_program, "point_px");
        if attribute >= 0 {
            self.gl.enable_vertex_attrib_array(attribute as u32);
            self.gl
                .vertex_attrib_pointer_with_i32(attribute as u32, 2, Gl::FLOAT, false, 0, 0);
        }
        self.gl.uniform2f(
            self.gl
                .get_uniform_location(&self.point_program, "image_size")
                .as_ref(),
            self.width as f32,
            self.height as f32,
        );
        self.gl.draw_arrays(mode, 0, (points.len() / 2) as i32);
    }
}

fn render_residuals(result: &FitResult, pairs: &[StarPair]) -> Result<(), JsValue> {
    let residuals: Vec<f64> = pairs
        .iter()
        .filter_map(|pair| {
            result
                .calibration
                .project(pair.azimuth_rad, pair.zenith_rad)
                .map(|pixel| [pixel[0] - pair.x_px, pixel[1] - pair.y_px])
        })
        .flatten()
        .collect();
    let extent = residuals
        .iter()
        .map(|value| value.abs())
        .fold(1.0_f64, f64::max)
        * 1.1;
    let canvas = element::<HtmlCanvasElement>("residualPlot")?;
    let mut plot = SeriesView::new(canvas)?;
    let dpr = web_sys::window()
        .map(|window| window.device_pixel_ratio())
        .unwrap_or(1.0);
    plot.begin(
        560.0,
        560.0,
        dpr,
        -extent,
        extent,
        -extent,
        extent,
        "Δx [pixel]",
        "Δy [pixel]",
    )?;
    plot.series(&residuals, "#2b73a8", false, 3.5)?;
    Ok(())
}

fn connect_file_input(app: Rc<RefCell<App>>, id: &str, job_file: bool) -> Result<(), JsValue> {
    let input = element::<HtmlInputElement>(id)?;
    let closure = Closure::<dyn FnMut(Event)>::new(move |event: Event| {
        let Some(input) = event
            .target()
            .and_then(|target| target.dyn_into::<HtmlInputElement>().ok())
        else {
            return;
        };
        let Some(file) = input.files().and_then(|files| files.get(0)) else {
            return;
        };
        let reader = match FileReader::new() {
            Ok(reader) => reader,
            Err(error) => {
                status(&format!("FileReader failed: {error:?}"));
                return;
            }
        };
        let loaded_reader = reader.clone();
        let loaded_app = app.clone();
        let filename = file.name();
        let loaded = Closure::<dyn FnMut(Event)>::once(move |_| {
            let result = loaded_reader.result().and_then(|value| {
                let bytes = Uint8Array::new(&value).to_vec();
                if job_file {
                    ui::import_job(&mut loaded_app.borrow_mut(), &bytes)
                } else {
                    loaded_app.borrow_mut().load_image(&bytes, &filename)
                }
            });
            if let Err(error) = result {
                status(&format!("Image load failed: {error:?}"));
            }
        });
        reader.set_onloadend(Some(loaded.as_ref().unchecked_ref()));
        loaded.forget();
        if let Err(error) = reader.read_as_array_buffer(&file) {
            status(&format!("Cannot read image: {error:?}"));
        }
    });
    input.add_event_listener_with_callback("change", closure.as_ref().unchecked_ref())?;
    closure.forget();
    Ok(())
}

#[wasm_bindgen(start)]
pub fn start() -> Result<(), JsValue> {
    let canvas = element::<HtmlCanvasElement>("glCanvas")?;
    let app = Rc::new(RefCell::new(App::new(canvas)?));
    connect_file_input(app.clone(), "imageFile", false)?;
    connect_file_input(app.clone(), "jobFile", true)?;
    ui::connect(app.clone())?;
    viewer::connect(app.clone())?;
    APP.with(|slot| *slot.borrow_mut() = Some(app));
    status("Load a PNG, JPEG, HEIC/HEIF, or FITS image to begin");
    Ok(())
}
