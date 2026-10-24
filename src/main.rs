use std::{
    convert::Infallible,
    env,
    ffi::OsStr,
    fs::{self, OpenOptions},
    io::{self, Write},
    net::{IpAddr, SocketAddr},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    body::{to_bytes, Body},
    extract::{Path as AxumPath, Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use bytes::Bytes;
use chrono::{SecondsFormat, Utc};
use futures_util::stream;
use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use serde_json::{json, Map, Value};
use subtle::ConstantTimeEq;

const DEFAULT_TEST_CASE_DIR: &str = "/mnt/shovel/aida";
const DEFAULT_MAX_JSON_BODY_BYTES: usize = 128 * 1024 * 1024;
const DEFAULT_MAX_IMAGE_BYTES: usize = 64 * 1024 * 1024;
const DEFAULT_MAX_METADATA_BYTES: usize = 2 * 1024 * 1024;
// Matches JavaScript encodeURIComponent for path-segment values.
const URI_COMPONENT: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'$')
    .add(b'%')
    .add(b'&')
    .add(b'+')
    .add(b',')
    .add(b'/')
    .add(b':')
    .add(b';')
    .add(b'<')
    .add(b'=')
    .add(b'>')
    .add(b'?')
    .add(b'@')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}');

#[derive(Clone, Debug)]
struct Config {
    host: IpAddr,
    port: u16,
    test_case_dir: PathBuf,
    submit_passkey: String,
    max_json_body_bytes: usize,
    max_image_bytes: usize,
    max_metadata_bytes: usize,
    max_multipart_body_bytes: usize,
}

impl Config {
    fn from_env_and_args() -> Result<Self, String> {
        let max_image_bytes = env_usize("AIDA_MAX_IMAGE_BYTES", DEFAULT_MAX_IMAGE_BYTES)?;
        let max_metadata_bytes = env_usize("AIDA_MAX_METADATA_BYTES", DEFAULT_MAX_METADATA_BYTES)?;
        let mut config = Self {
            host: "127.0.0.1".parse().unwrap(),
            port: 8790,
            test_case_dir: PathBuf::from(
                env::var_os("AIDA_TEST_CASE_DIR").unwrap_or_else(|| DEFAULT_TEST_CASE_DIR.into()),
            ),
            submit_passkey: env::var("AIDA_SUBMIT_PASSKEY").unwrap_or_default(),
            max_json_body_bytes: env_usize(
                "AIDA_MAX_JSON_BODY_BYTES",
                DEFAULT_MAX_JSON_BODY_BYTES,
            )?,
            max_image_bytes,
            max_metadata_bytes,
            max_multipart_body_bytes: env_usize(
                "AIDA_MAX_MULTIPART_BODY_BYTES",
                max_image_bytes
                    .checked_add(max_metadata_bytes)
                    .and_then(|v| v.checked_add(1024 * 1024))
                    .ok_or("multipart limit overflow")?,
            )?,
        };

        let args: Vec<String> = env::args().skip(1).collect();
        let mut index = 0;
        while index < args.len() {
            let (name, inline) = args[index]
                .split_once('=')
                .map(|(a, b)| (a, Some(b)))
                .unwrap_or((&args[index], None));
            let value = if let Some(value) = inline {
                value.to_owned()
            } else {
                index += 1;
                args.get(index)
                    .cloned()
                    .ok_or_else(|| format!("missing value for {name}"))?
            };
            match name {
                "--host" => config.host = value.parse().map_err(|_| "invalid --host")?,
                "--port" => config.port = value.parse().map_err(|_| "invalid --port")?,
                "--test-case-dir" => config.test_case_dir = PathBuf::from(value),
                "--submit-passkey" => config.submit_passkey = value,
                _ => return Err(format!("unknown argument: {name}")),
            }
            index += 1;
        }
        if config.max_image_bytes == 0
            || config.max_metadata_bytes == 0
            || config.max_json_body_bytes < config.max_image_bytes
            || config.max_multipart_body_bytes < config.max_image_bytes
        {
            return Err("invalid AIDA request-size limits".into());
        }
        config.test_case_dir = absolute_path(&config.test_case_dir)?;
        Ok(config)
    }
}

fn env_usize(name: &str, default: usize) -> Result<usize, String> {
    match env::var(name) {
        Ok(value) => value
            .parse::<usize>()
            .map_err(|_| format!("{name} must be a positive integer"))
            .and_then(|v| {
                (v > 0)
                    .then_some(v)
                    .ok_or_else(|| format!("{name} must be positive"))
            }),
        Err(env::VarError::NotPresent) => Ok(default),
        Err(_) => Err(format!("{name} is not valid UTF-8")),
    }
}

fn absolute_path(path: &Path) -> Result<PathBuf, String> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        env::current_dir()
            .map(|cwd| cwd.join(path))
            .map_err(|error| format!("cannot resolve test-case directory: {error}"))
    }
}

#[derive(Clone)]
struct AppState {
    config: Arc<Config>,
    save_lock: Arc<Mutex<()>>,
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    fn forbidden(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            message: message.into(),
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
        }
    }

    fn internal(context: &str, error: impl std::fmt::Display) -> Self {
        eprintln!("{context}: {error}");
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: context.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        json_response(self.status, &json!({"error": self.message}))
    }
}

fn json_response(status: StatusCode, value: &Value) -> Response {
    let body = serde_json::to_vec_pretty(value)
        .unwrap_or_else(|_| b"{\"error\":\"serialization failed\"}".to_vec());
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    response
}

fn json_bytes_response(status: StatusCode, body: Vec<u8>) -> Response {
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    response
}

fn router(config: Config) -> Router {
    let state = AppState {
        config: Arc::new(config),
        save_lock: Arc::new(Mutex::new(())),
    };
    Router::new()
        .route("/healthz", get(health))
        .route("/api/test-cases", get(list_cases).post(save_case))
        .route("/api/test-cases/:id", get(load_case))
        .route("/api/test-cases/:id/image/:image", get(load_image))
        .fallback(not_found)
        .with_state(state)
}

async fn health() -> Response {
    json_response(StatusCode::OK, &json!({"ok": true, "backend": "rust"}))
}

async fn not_found() -> Response {
    json_response(StatusCode::NOT_FOUND, &json!({"error": "not found"}))
}

async fn list_cases(State(state): State<AppState>) -> Result<Response, ApiError> {
    let value = list_test_cases(&state.config.test_case_dir)?;
    Ok(json_response(StatusCode::OK, &Value::Array(value)))
}

async fn load_case(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Response, ApiError> {
    load_test_case(&state.config.test_case_dir, &id)
}

async fn save_case(State(state): State<AppState>, request: Request) -> Result<Response, ApiError> {
    require_submit_passkey(request.headers(), &state.config.submit_passkey)?;
    let content_type = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let payload = if content_type
        .to_ascii_lowercase()
        .starts_with("multipart/form-data")
    {
        let body = to_bytes(request.into_body(), state.config.max_multipart_body_bytes)
            .await
            .map_err(|_| {
                ApiError::bad_request(format!(
                    "request body too large; limit is {} bytes",
                    state.config.max_multipart_body_bytes
                ))
            })?;
        multipart_payload(&content_type, body).await?
    } else {
        let body = to_bytes(request.into_body(), state.config.max_json_body_bytes)
            .await
            .map_err(|_| {
                ApiError::bad_request(format!(
                    "request body too large; limit is {} bytes",
                    state.config.max_json_body_bytes
                ))
            })?;
        serde_json::from_slice::<UploadPayload>(&body)
            .map_err(|error| ApiError::bad_request(format!("invalid JSON: {error}")))?
    };
    let _guard = state
        .save_lock
        .lock()
        .map_err(|_| ApiError::internal("save lock failed", "poisoned"))?;
    let result = save_test_case(&state.config, payload)?;
    Ok(json_response(StatusCode::OK, &result))
}

async fn load_image(
    State(state): State<AppState>,
    AxumPath((id, image)): AxumPath<(String, String)>,
) -> Result<Response, ApiError> {
    validate_case_id(&id)?;
    let image = safe_basename(&image)?;
    let case_dir = checked_case_dir(&state.config.test_case_dir, &id, false)?;
    let image_path = case_dir.join(&image);
    ensure_regular_file_inside(&state.config.test_case_dir, &image_path)?;
    let mime = content_type(&image_path);
    if image_kind(mime).is_none() {
        return Err(ApiError::forbidden("forbidden image type"));
    }
    let bytes = tokio::fs::read(&image_path)
        .await
        .map_err(|error| ApiError::internal("cannot read test case image", error))?;
    let mut response = Response::new(Body::from(bytes));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(mime)
            .map_err(|error| ApiError::internal("invalid content type", error))?,
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    Ok(response)
}

fn require_submit_passkey(headers: &HeaderMap, expected: &str) -> Result<(), ApiError> {
    if expected.is_empty() {
        return Ok(());
    }
    let submitted = headers
        .get("x-aida-submit-passkey")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let same_length = submitted.len() == expected.len();
    let equal = submitted.as_bytes().ct_eq(expected.as_bytes()).unwrap_u8() == 1;
    if same_length && equal {
        Ok(())
    } else {
        Err(ApiError::forbidden("invalid submit pass key"))
    }
}

#[derive(Debug)]
struct UploadPayload {
    test_case: Value,
    image_data_url: Option<String>,
    image_upload: Option<ImageUpload>,
}

impl<'de> serde::Deserialize<'de> for UploadPayload {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let mut value = Map::<String, Value>::deserialize(deserializer)?;
        let test_case = value.remove("testCase").unwrap_or(Value::Null);
        let image_data_url = value
            .remove("imageDataUrl")
            .and_then(|v| v.as_str().map(str::to_owned));
        Ok(Self {
            test_case,
            image_data_url,
            image_upload: None,
        })
    }
}

#[derive(Debug)]
struct ImageUpload {
    filename: String,
    mime: String,
    bytes: Vec<u8>,
}

async fn multipart_payload(content_type: &str, body: Bytes) -> Result<UploadPayload, ApiError> {
    let boundary = multer::parse_boundary(content_type)
        .map_err(|_| ApiError::bad_request("missing multipart boundary"))?;
    let input = stream::once(async move { Ok::<Bytes, Infallible>(body) });
    let mut multipart = multer::Multipart::new(input, boundary);
    let mut test_case = None;
    let mut image_upload = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|error| ApiError::bad_request(format!("invalid multipart body: {error}")))?
    {
        let name = field.name().unwrap_or("").to_owned();
        if name == "testCase" {
            let text = field.text().await.map_err(|error| {
                ApiError::bad_request(format!("invalid testCase field: {error}"))
            })?;
            test_case = Some(serde_json::from_str(&text).map_err(|error| {
                ApiError::bad_request(format!("invalid testCase JSON: {error}"))
            })?);
        } else if name == "image" {
            let filename = field.file_name().unwrap_or("").to_owned();
            let mime = field
                .content_type()
                .map(ToString::to_string)
                .unwrap_or_default();
            let bytes = field
                .bytes()
                .await
                .map_err(|error| ApiError::bad_request(format!("invalid image field: {error}")))?;
            image_upload = Some(ImageUpload {
                filename,
                mime,
                bytes: bytes.to_vec(),
            });
        }
    }
    Ok(UploadPayload {
        test_case: test_case.unwrap_or(Value::Null),
        image_data_url: None,
        image_upload,
    })
}

#[derive(Debug)]
struct ImageData {
    mime: &'static str,
    extension: &'static str,
    bytes: Vec<u8>,
}

fn image_from_payload(config: &Config, payload: &UploadPayload) -> Result<ImageData, ApiError> {
    if let Some(upload) = &payload.image_upload {
        return image_from_upload(config, upload);
    }
    image_from_data_url(config, payload.image_data_url.as_deref().unwrap_or(""))
}

fn image_from_data_url(config: &Config, data_url: &str) -> Result<ImageData, ApiError> {
    let rest = data_url.strip_prefix("data:").ok_or_else(|| {
        ApiError::bad_request(
            "missing imageDataUrl; allowed types are PNG, JPEG, HEIC, HEIF, and FITS",
        )
    })?;
    let (mime, encoded) = rest.split_once(";base64,").ok_or_else(|| {
        ApiError::bad_request(
            "missing imageDataUrl; allowed types are PNG, JPEG, HEIC, HEIF, and FITS",
        )
    })?;
    let normalized_mime = mime.to_ascii_lowercase();
    let kind = image_kind(&normalized_mime)
        .ok_or_else(|| ApiError::bad_request("unsupported image type"))?;
    let compact: String = encoded
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect();
    if compact.len().saturating_mul(3) / 4 > config.max_image_bytes {
        return Err(ApiError::bad_request(format!(
            "image too large; limit is {} bytes",
            config.max_image_bytes
        )));
    }
    let bytes = BASE64
        .decode(compact.as_bytes())
        .map_err(|_| ApiError::bad_request("invalid base64 image data"))?;
    validate_image(
        config,
        mime_for_storage(&normalized_mime, kind),
        kind,
        bytes,
    )
}

fn image_from_upload(config: &Config, upload: &ImageUpload) -> Result<ImageData, ApiError> {
    let basename = Path::new(&upload.filename)
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or("");
    let extension = Path::new(basename)
        .extension()
        .and_then(OsStr::to_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    let mut mime = upload.mime.to_ascii_lowercase();
    if (image_kind(&mime).is_none() || mime == "application/octet-stream")
        && matches!(extension.as_str(), "fits" | "fit" | "fts")
    {
        mime = "application/fits".into();
    }
    let kind = image_kind(&mime).ok_or_else(|| ApiError::bad_request("unsupported image type"))?;
    validate_image(
        config,
        mime_for_storage(&mime, kind),
        kind,
        upload.bytes.clone(),
    )
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ImageKind {
    Png,
    Jpeg,
    Heic,
    Heif,
    Fits,
}

fn image_kind(mime: &str) -> Option<ImageKind> {
    match mime {
        "image/png" => Some(ImageKind::Png),
        "image/jpeg" => Some(ImageKind::Jpeg),
        "image/heic" => Some(ImageKind::Heic),
        "image/heif" => Some(ImageKind::Heif),
        "image/fits"
        | "image/x-fits"
        | "application/fits"
        | "application/x-fits"
        | "application/fits-image"
        | "application/octet-stream" => Some(ImageKind::Fits),
        _ => None,
    }
}

fn mime_for_storage(mime: &str, kind: ImageKind) -> &str {
    if kind == ImageKind::Fits && mime == "application/octet-stream" {
        "application/fits"
    } else {
        mime
    }
}

fn validate_image(
    config: &Config,
    mime: &str,
    kind: ImageKind,
    bytes: Vec<u8>,
) -> Result<ImageData, ApiError> {
    if bytes.is_empty() {
        return Err(ApiError::bad_request("empty image"));
    }
    if bytes.len() > config.max_image_bytes {
        return Err(ApiError::bad_request(format!(
            "image too large; limit is {} bytes",
            config.max_image_bytes
        )));
    }
    let matches = match kind {
        ImageKind::Png => bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]),
        ImageKind::Jpeg => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        ImageKind::Fits => bytes.starts_with(b"SIMPLE  "),
        ImageKind::Heic | ImageKind::Heif => looks_like_iso_bmff(&bytes, kind),
    };
    if !matches {
        return Err(ApiError::bad_request(format!(
            "image content does not look like {mime}"
        )));
    }
    let mime: &'static str = match mime {
        "image/png" => "image/png",
        "image/jpeg" => "image/jpeg",
        "image/heic" => "image/heic",
        "image/heif" => "image/heif",
        "image/fits" => "image/fits",
        "image/x-fits" => "image/x-fits",
        "application/x-fits" => "application/x-fits",
        "application/fits-image" => "application/fits-image",
        _ => "application/fits",
    };
    let extension = match kind {
        ImageKind::Png => ".png",
        ImageKind::Jpeg => ".jpg",
        ImageKind::Heic => ".heic",
        ImageKind::Heif => ".heif",
        ImageKind::Fits => ".fits",
    };
    Ok(ImageData {
        mime,
        extension,
        bytes,
    })
}

fn looks_like_iso_bmff(bytes: &[u8], kind: ImageKind) -> bool {
    if bytes.len() < 12 || &bytes[4..8] != b"ftyp" {
        return false;
    }
    let haystack = &bytes[8..bytes.len().min(128)];
    haystack.chunks(4).any(|brand| match kind {
        ImageKind::Heic => matches!(brand, b"heic" | b"heix" | b"hevc" | b"hevx"),
        ImageKind::Heif => matches!(brand, b"heif" | b"heim" | b"mif1" | b"msf1"),
        _ => false,
    })
}

fn safe_case_id(value: &str) -> String {
    let stemmed = value
        .rsplit_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(value);
    let mut result = String::new();
    let mut pending_dash = false;
    for character in stemmed.chars() {
        if character.is_ascii_alphanumeric() || character == '_' || character == '-' {
            if pending_dash && !result.is_empty() && !result.ends_with('-') {
                result.push('-');
            }
            pending_dash = false;
            if result.len() < 120 {
                result.push(character);
            }
        } else {
            pending_dash = true;
        }
        if result.len() >= 120 {
            break;
        }
    }
    result
        .trim_matches('-')
        .to_owned()
        .chars()
        .take(120)
        .collect::<String>()
        .trim_matches('-')
        .to_owned()
}

fn validate_case_id(id: &str) -> Result<(), ApiError> {
    if id.is_empty() || safe_case_id(id) != id {
        Err(ApiError::bad_request("invalid test case id"))
    } else {
        Ok(())
    }
}

fn checked_case_dir(root: &Path, id: &str, create: bool) -> Result<PathBuf, ApiError> {
    validate_case_id(id)?;
    reject_symlink(root)?;
    let case_dir = root.join(id);
    if case_dir.exists() {
        reject_symlink(&case_dir)?;
        if !case_dir.is_dir() {
            return Err(ApiError::bad_request("invalid storage path"));
        }
    } else if create {
        fs::create_dir_all(&case_dir)
            .map_err(|error| ApiError::internal("cannot create test case directory", error))?;
        fs::set_permissions(&case_dir, fs::Permissions::from_mode(0o750))
            .map_err(|error| ApiError::internal("cannot secure test case directory", error))?;
    }
    Ok(case_dir)
}

fn reject_symlink(path: &Path) -> Result<(), ApiError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(ApiError::forbidden("symlink storage path is not allowed"))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(ApiError::internal("cannot inspect storage path", error)),
    }
}

fn safe_basename(value: &str) -> Result<String, ApiError> {
    let path = Path::new(value);
    if value.is_empty()
        || path.components().count() != 1
        || !matches!(path.components().next(), Some(Component::Normal(_)))
    {
        return Err(ApiError::bad_request("invalid image filename"));
    }
    Ok(value.to_owned())
}

fn ensure_regular_file_inside(root: &Path, target: &Path) -> Result<(), ApiError> {
    reject_symlink(target)?;
    let canonical_root = fs::canonicalize(root)
        .map_err(|error| ApiError::internal("cannot resolve storage root", error))?;
    let canonical_target = fs::canonicalize(target).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            ApiError::not_found("image not found")
        } else {
            ApiError::internal("cannot resolve image path", error)
        }
    })?;
    if !canonical_target.starts_with(&canonical_root) || !canonical_target.is_file() {
        return Err(ApiError::forbidden("invalid storage path"));
    }
    Ok(())
}

fn save_test_case(config: &Config, payload: UploadPayload) -> Result<Value, ApiError> {
    let mut test_case = payload
        .test_case
        .as_object()
        .cloned()
        .ok_or_else(|| ApiError::bad_request("missing testCase object"))?;
    for key in ["width", "height"] {
        if number_like(test_case.get(key)).is_some_and(|value| value > 100_000.0) {
            return Err(ApiError::bad_request("unreasonable image dimensions"));
        }
    }
    let raw_id = string_like(test_case.get("id"))
        .filter(|value| !value.is_empty())
        .or_else(|| string_like(test_case.get("image")))
        .unwrap_or_else(|| "aida_case".into());
    let id = {
        let value = safe_case_id(&raw_id);
        if value.is_empty() {
            "aida_case".into()
        } else {
            value
        }
    };
    let image = image_from_payload(config, &payload)?;
    fs::create_dir_all(&config.test_case_dir)
        .map_err(|error| ApiError::internal("cannot create test-case storage", error))?;
    reject_symlink(&config.test_case_dir)?;
    let case_dir = checked_case_dir(&config.test_case_dir, &id, true)?;
    let metadata_path = case_dir.join("metadata.json");
    let updated = metadata_path.is_file();
    let image_name = format!("{id}{}", image.extension);
    let image_path = case_dir.join(&image_name);
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    test_case.insert("id".into(), Value::String(id.clone()));
    test_case.insert("image".into(), Value::String(image_name.clone()));
    test_case.insert(
        "source".into(),
        Value::String("aida browser manual calibration".into()),
    );
    test_case.insert("imageMimeType".into(), Value::String(image.mime.into()));
    test_case.insert("imageBytes".into(), json!(image.bytes.len()));
    test_case.insert("savedUtc".into(), Value::String(now.clone()));
    if updated {
        test_case.insert("updatedUtc".into(), Value::String(now));
    } else {
        test_case.remove("updatedUtc");
    }
    let mut metadata = serde_json::to_vec_pretty(&Value::Object(test_case))
        .map_err(|error| ApiError::internal("cannot encode metadata", error))?;
    metadata.push(b'\n');
    if metadata.len() > config.max_metadata_bytes {
        return Err(ApiError::bad_request(format!(
            "metadata too large; limit is {} bytes",
            config.max_metadata_bytes
        )));
    }
    atomic_write(&image_path, &image.bytes)?;
    atomic_write(&metadata_path, &metadata)?;
    Ok(json!({
        "caseId": id,
        "relativeDir": id,
        "metadata": format!("{id}/metadata.json"),
        "image": format!("{id}/{image_name}"),
        "imageBytes": image.bytes.len(),
        "imageMimeType": image.mime,
        "updated": updated,
    }))
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), ApiError> {
    static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);
    reject_symlink(path)?;
    let parent = path
        .parent()
        .ok_or_else(|| ApiError::bad_request("invalid storage path"))?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary = parent.join(format!(
        ".{}.{}.{}.{}.tmp",
        path.file_name().and_then(OsStr::to_str).unwrap_or("aida"),
        std::process::id(),
        nonce,
        TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed),
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o640)
        .open(&temporary)
        .map_err(|error| ApiError::internal("cannot create temporary file", error))?;
    let result = (|| -> io::Result<()> {
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|error| ApiError::internal("cannot save test case", error))
}

fn list_test_cases(root: &Path) -> Result<Vec<Value>, ApiError> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    reject_symlink(root)?;
    let mut entries: Vec<_> = fs::read_dir(root)
        .map_err(|error| ApiError::internal("cannot list test cases", error))?
        .filter_map(Result::ok)
        .collect();
    entries.sort_by_key(|entry| entry.file_name().to_string_lossy().to_ascii_lowercase());
    let mut cases = Vec::new();
    for entry in entries {
        let id = entry.file_name().to_string_lossy().into_owned();
        if validate_case_id(&id).is_err() || entry.file_type().map(|t| !t.is_dir()).unwrap_or(true)
        {
            continue;
        }
        let path = entry.path().join("metadata.json");
        if reject_symlink(&path).is_err() {
            continue;
        }
        let Ok(bytes) = fs::read(&path) else { continue };
        let Ok(metadata) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        let title = metadata.get("title").and_then(Value::as_str).unwrap_or(&id);
        let image = metadata.get("image").and_then(Value::as_str).unwrap_or("");
        let timestamp = metadata
            .get("timestampUtc")
            .and_then(Value::as_str)
            .unwrap_or("");
        let matches = metadata
            .get("matches")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0);
        let rms = metadata
            .pointer("/residual/rmsPx")
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite());
        cases.push(json!({
            "id": id,
            "title": title,
            "image": image,
            "timestampUtc": timestamp,
            "matches": matches,
            "residualRmsPx": rms,
            "metadata": format!("{id}/metadata.json"),
        }));
    }
    Ok(cases)
}

fn load_test_case(root: &Path, id: &str) -> Result<Response, ApiError> {
    validate_case_id(id)?;
    let case_dir = checked_case_dir(root, id, false)?;
    let metadata_path = case_dir.join("metadata.json");
    ensure_regular_file_inside(root, &metadata_path).map_err(|error| {
        if error.status == StatusCode::NOT_FOUND {
            ApiError::not_found("test case not found")
        } else {
            error
        }
    })?;
    let bytes = fs::read(&metadata_path)
        .map_err(|error| ApiError::internal("cannot read test case", error))?;
    let metadata: Value = serde_json::from_slice(&bytes)
        .map_err(|error| ApiError::internal("cannot decode test case", error))?;
    let fallback = format!("{id}.png");
    let image = metadata
        .get("image")
        .and_then(Value::as_str)
        .unwrap_or(&fallback);
    let image = safe_basename(image)?;
    let image_path = case_dir.join(&image);
    ensure_regular_file_inside(root, &image_path).map_err(|error| {
        if error.status == StatusCode::NOT_FOUND {
            ApiError::not_found("test case image not found")
        } else {
            error
        }
    })?;
    // Preserve the exact JSON number spellings already stored in metadata.json.
    // Parsing and serializing the document through serde_json can choose a
    // slightly different (but equivalent) shortest f64 representation from V8.
    let metadata_bytes = bytes.as_slice();
    let image_url = format!(
        "/api/test-cases/{}/image/{}",
        id,
        utf8_percent_encode(&image, URI_COMPONENT)
    );
    let encoded_url = serde_json::to_vec(&image_url)
        .map_err(|error| ApiError::internal("cannot encode image URL", error))?;
    let mut body = Vec::with_capacity(metadata_bytes.len() + encoded_url.len() + 40);
    body.extend_from_slice(b"{\n  \"testCase\": ");
    body.extend_from_slice(metadata_bytes);
    body.extend_from_slice(b",\n  \"imageUrl\": ");
    body.extend_from_slice(&encoded_url);
    body.extend_from_slice(b"\n}\n");
    Ok(json_bytes_response(StatusCode::OK, body))
}

fn number_like(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(number)) => number.as_f64(),
        Some(Value::String(string)) => string.parse().ok(),
        _ => None,
    }
}

fn string_like(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(value)) => Some(value.clone()),
        Some(Value::Number(value)) => Some(value.to_string()),
        Some(Value::Bool(value)) => Some(value.to_string()),
        _ => None,
    }
}

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(OsStr::to_str)
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "fits" | "fit" | "fts" => "application/fits",
        _ => "application/octet-stream",
    }
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("install SIGTERM handler");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}

#[tokio::main(worker_threads = 4)]
async fn main() {
    let config = Config::from_env_and_args().unwrap_or_else(|error| {
        eprintln!("aida-calibrator-server: {error}");
        std::process::exit(2);
    });
    let address = SocketAddr::new(config.host, config.port);
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .unwrap_or_else(|error| {
            eprintln!("cannot listen on {address}: {error}");
            std::process::exit(1);
        });
    println!("AIDA Rust API: http://{address}/api/test-cases");
    println!(
        "AIDA test-case submissions: {}",
        config.test_case_dir.display()
    );
    println!(
        "AIDA submit pass key: {}",
        if config.submit_passkey.is_empty() {
            "not configured"
        } else {
            "required"
        }
    );
    axum::serve(listener, router(config))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .unwrap_or_else(|error| {
            eprintln!("AIDA server failed: {error}");
            std::process::exit(1);
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{http::Request, response::Response};
    use tempfile::TempDir;
    use tower::ServiceExt;

    fn test_config(root: &Path) -> Config {
        Config {
            host: "127.0.0.1".parse().unwrap(),
            port: 8790,
            test_case_dir: root.to_path_buf(),
            submit_passkey: "secret".into(),
            max_json_body_bytes: DEFAULT_MAX_JSON_BODY_BYTES,
            max_image_bytes: DEFAULT_MAX_IMAGE_BYTES,
            max_metadata_bytes: DEFAULT_MAX_METADATA_BYTES,
            max_multipart_body_bytes: DEFAULT_MAX_IMAGE_BYTES
                + DEFAULT_MAX_METADATA_BYTES
                + 1024 * 1024,
        }
    }

    fn fits() -> Vec<u8> {
        let mut data = b"SIMPLE  = T".to_vec();
        data.resize(5760, b' ');
        data
    }

    async fn body_json(response: Response) -> Value {
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[test]
    fn case_id_matches_legacy_sanitization() {
        assert_eq!(safe_case_id(" IMG 9953.fits "), "IMG-9953");
        assert_eq!(safe_case_id("../../etc/passwd"), "");
        assert!(validate_case_id("../bad").is_err());
    }

    #[test]
    fn validates_fits_and_rejects_false_signature() {
        let root = TempDir::new().unwrap();
        let config = test_config(root.path());
        let good = ImageUpload {
            filename: "frame.fit".into(),
            mime: "application/octet-stream".into(),
            bytes: fits(),
        };
        assert_eq!(
            image_from_upload(&config, &good).unwrap().extension,
            ".fits"
        );
        let bad = ImageUpload {
            filename: "frame.fits".into(),
            mime: "application/fits".into(),
            bytes: b"not FITS".to_vec(),
        };
        assert!(image_from_upload(&config, &bad).is_err());
    }

    #[tokio::test]
    async fn json_api_round_trip_and_passkey() {
        let root = TempDir::new().unwrap();
        let app = router(test_config(root.path()));
        let payload = json!({
            "testCase": {"id":"round trip.fits", "width":1, "height":1, "matches":[1,2]},
            "imageDataUrl": format!("data:application/fits;base64,{}", BASE64.encode(fits())),
        });
        let unauthorized = app
            .clone()
            .oneshot(
                Request::post("/api/test-cases")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(payload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unauthorized.status(), StatusCode::FORBIDDEN);
        let saved = app
            .clone()
            .oneshot(
                Request::post("/api/test-cases")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header("x-aida-submit-passkey", "secret")
                    .body(Body::from(payload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(saved.status(), StatusCode::OK);
        assert_eq!(body_json(saved).await["caseId"], "round-trip");
        let loaded = app
            .clone()
            .oneshot(
                Request::get("/api/test-cases/round-trip")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(loaded.status(), StatusCode::OK);
        let loaded = body_json(loaded).await;
        assert_eq!(loaded["testCase"]["image"], "round-trip.fits");
        let listed = app
            .oneshot(Request::get("/api/test-cases").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(body_json(listed).await.as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn multipart_api_round_trip() {
        let root = TempDir::new().unwrap();
        let app = router(test_config(root.path()));
        let boundary = "aida-test-boundary";
        let metadata = r#"{"id":"multipart.fits","width":2,"height":2}"#;
        let mut body = Vec::new();
        body.extend_from_slice(
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"testCase\"\r\n\r\n{metadata}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"frame.fits\"\r\nContent-Type: application/fits\r\n\r\n").as_bytes(),
        );
        body.extend_from_slice(&fits());
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        let saved = app
            .oneshot(
                Request::post("/api/test-cases")
                    .header(
                        header::CONTENT_TYPE,
                        format!("multipart/form-data; boundary={boundary}"),
                    )
                    .header("x-aida-submit-passkey", "secret")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(saved.status(), StatusCode::OK);
        assert_eq!(body_json(saved).await["caseId"], "multipart");
        assert_eq!(
            fs::read(root.path().join("multipart/multipart.fits")).unwrap(),
            fits()
        );
    }

    #[tokio::test]
    async fn preserves_legacy_v8_number_spelling() {
        let root = TempDir::new().unwrap();
        let case_dir = root.path().join("legacy-number");
        fs::create_dir(&case_dir).unwrap();
        fs::write(
            case_dir.join("metadata.json"),
            br#"{"id":"legacy-number","image":"legacy-number.fits","residual":{"rmsPx":1.8574648297574605}}"#,
        )
        .unwrap();
        fs::write(case_dir.join("legacy-number.fits"), fits()).unwrap();
        let app = router(test_config(root.path()));

        for path in ["/api/test-cases", "/api/test-cases/legacy-number"] {
            let response = app
                .clone()
                .oneshot(Request::get(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            assert!(String::from_utf8(body.to_vec())
                .unwrap()
                .contains("1.8574648297574605"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlink_case_directory() {
        use std::os::unix::fs::symlink;
        let root = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        symlink(outside.path(), root.path().join("escape")).unwrap();
        assert!(checked_case_dir(root.path(), "escape", true).is_err());
    }
}
