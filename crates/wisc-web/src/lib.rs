use std::{cell::RefCell, rc::Rc};

use image::ImageReader;
use js_sys::{Float32Array, Uint8Array};
use rustplotlib_web::SeriesView;
use wasm_bindgen::{closure::Closure, prelude::*, JsCast};
use web_sys::{
    Event, FileReader, HtmlCanvasElement, HtmlInputElement, HtmlTextAreaElement,
    WebGl2RenderingContext as Gl, WebGlBuffer, WebGlProgram, WebGlShader, WebGlTexture,
};
use wisc_core::{detect_stars, fit, DetectorConfig, FitResult, StarPair};

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
            in vec2 uv;
            out vec4 color;
            void main() { color = texture(image_texture, vec2(uv.x, 1.0 - uv.y)); }"#,
        )?;
        let point_program = program(
            &gl,
            r#"#version 300 es
            in vec2 point_px;
            uniform vec2 image_size;
            void main() {
                vec2 clip = vec2(2.0 * point_px.x / image_size.x - 1.0,
                                 1.0 - 2.0 * point_px.y / image_size.y);
                gl_Position = vec4(clip, 0.0, 1.0);
                gl_PointSize = 7.0;
            }"#,
            r#"#version 300 es
            precision highp float;
            out vec4 color;
            void main() {
                vec2 d = gl_PointCoord - vec2(0.5);
                if (dot(d,d) > 0.25 || dot(d,d) < 0.12) discard;
                color = vec4(0.3, 1.0, 0.45, 1.0);
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
        })
    }

    fn load_image(&mut self, bytes: &[u8]) -> Result<(), JsValue> {
        let image = ImageReader::new(std::io::Cursor::new(bytes))
            .with_guessed_format()
            .map_err(|error| js_error(format!("cannot identify image: {error}")))?
            .decode()
            .map_err(|error| js_error(format!("cannot decode image: {error}")))?
            .to_rgba8();
        self.width = image.width();
        self.height = image.height();
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
                Some(image.as_raw()),
            )?;
        let luminance: Vec<f32> = image
            .pixels()
            .map(|pixel| {
                0.2126 * f32::from(pixel[0])
                    + 0.7152 * f32::from(pixel[1])
                    + 0.0722 * f32::from(pixel[2])
            })
            .collect();
        self.detections = detect_stars(
            &luminance,
            self.width,
            self.height,
            DetectorConfig::default(),
        );
        self.draw();
        status(&format!(
            "Loaded {} × {} image; Rust detector found {} stars",
            self.width,
            self.height,
            self.detections.len()
        ));
        Ok(())
    }

    fn draw(&self) {
        self.gl
            .viewport(0, 0, self.width as i32, self.height as i32);
        self.gl.clear_color(0.02, 0.025, 0.04, 1.0);
        self.gl.clear(Gl::COLOR_BUFFER_BIT);
        if self.width == 0 || self.height == 0 {
            return;
        }
        self.gl.use_program(Some(&self.image_program));
        self.gl.bind_texture(Gl::TEXTURE_2D, Some(&self.texture));
        self.gl.draw_arrays(Gl::TRIANGLES, 0, 3);

        let points: Vec<f32> = self
            .detections
            .iter()
            .flat_map(|detection| [detection.x as f32, detection.y as f32])
            .collect();
        self.gl.use_program(Some(&self.point_program));
        self.gl
            .bind_buffer(Gl::ARRAY_BUFFER, Some(&self.point_buffer));
        unsafe {
            self.gl.buffer_data_with_array_buffer_view(
                Gl::ARRAY_BUFFER,
                &Float32Array::view(&points),
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
        self.gl
            .draw_arrays(Gl::POINTS, 0, self.detections.len() as i32);
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
        300.0,
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

fn connect_file_input(app: Rc<RefCell<App>>) -> Result<(), JsValue> {
    let input = element::<HtmlInputElement>("imageFile")?;
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
        let loaded = Closure::<dyn FnMut(Event)>::once(move |_| {
            let result = loaded_reader.result().and_then(|value| {
                let bytes = Uint8Array::new(&value).to_vec();
                loaded_app.borrow_mut().load_image(&bytes)
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

fn connect_fit_button() -> Result<(), JsValue> {
    let button = element::<web_sys::HtmlButtonElement>("fitPairs")?;
    let closure = Closure::<dyn FnMut(Event)>::new(move |_| {
        let result = (|| -> Result<(), JsValue> {
            let source = element::<HtmlTextAreaElement>("fitJob")?.value();
            let value: serde_json::Value = serde_json::from_str(&source)
                .map_err(|error| js_error(format!("invalid fit JSON: {error}")))?;
            let initial = serde_json::from_value(
                value
                    .get("initial")
                    .cloned()
                    .ok_or_else(|| js_error("missing initial calibration"))?,
            )
            .map_err(|error| js_error(format!("invalid calibration: {error}")))?;
            let pairs: Vec<StarPair> = serde_json::from_value(
                value
                    .get("pairs")
                    .cloned()
                    .ok_or_else(|| js_error("missing pairs"))?,
            )
            .map_err(|error| js_error(format!("invalid pairs: {error}")))?;
            let result = fit(&initial, &pairs, 2000).map_err(js_error)?;
            render_residuals(&result, &pairs)?;
            status(&format!(
                "Rust fit complete: {} pairs, RMS {:.4} px",
                pairs.len(),
                result.rms_px
            ));
            Ok(())
        })();
        if let Err(error) = result {
            status(&format!("Fit failed: {error:?}"));
        }
    });
    button.add_event_listener_with_callback("click", closure.as_ref().unchecked_ref())?;
    closure.forget();
    Ok(())
}

#[wasm_bindgen(start)]
pub fn start() -> Result<(), JsValue> {
    let canvas = element::<HtmlCanvasElement>("glCanvas")?;
    let app = Rc::new(RefCell::new(App::new(canvas)?));
    connect_file_input(app.clone())?;
    connect_fit_button()?;
    APP.with(|slot| *slot.borrow_mut() = Some(app));
    status("Rust/WASM calibration core ready; load a PNG or JPEG image");
    Ok(())
}
