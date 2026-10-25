//! Portable report bundles. Plot pixels/vectors are supplied by Rustplotlib
//! clients; all scientific products and archive generation are shared Rust.
use crate::{
    session::{image_digest, Session},
    workflow::CalibrationDocument,
    FitResult,
};
use std::io::{Cursor, Read, Write};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

pub fn archive_calibration(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.len() > 128 * 1024 * 1024 {
        return Err("report archive exceeds 128 MiB".into());
    }
    let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(|e| e.to_string())?;
    if archive.len() > 128 {
        return Err("report archive has too many entries".into());
    }
    let names: Vec<_> = archive.file_names().map(str::to_owned).collect();
    let preferred = if names.iter().any(|n| n == "session.json") {
        Some("session.json".to_owned())
    } else if names.iter().any(|n| n == "calibration.json") {
        Some("calibration.json".to_owned())
    } else {
        None
    };
    let candidates: Vec<_> = if let Some(name) = preferred {
        names.into_iter().filter(|n| *n == name).collect()
    } else {
        names
            .into_iter()
            .filter(|n| n.ends_with("_calibration.h5") || n == "calibration.h5")
            .collect()
    };
    if candidates.len() != 1 {
        return Err("report must contain one unambiguous calibration/session".into());
    }
    let file = archive.by_name(&candidates[0]).map_err(|e| e.to_string())?;
    if file.size() > 8 * 1024 * 1024 {
        return Err("calibration inside report exceeds 8 MiB".into());
    }
    let mut data = Vec::new();
    file.take(8 * 1024 * 1024 + 1)
        .read_to_end(&mut data)
        .map_err(|e| e.to_string())?;
    if data.len() > 8 * 1024 * 1024 || data.starts_with(b"PK\x03\x04") {
        return Err("oversized or nested calibration archive".into());
    }
    Ok(data)
}

pub fn bundle(
    session: &Session,
    original: &[u8],
    assets: &[(&str, Vec<u8>)],
) -> Result<Vec<u8>, String> {
    session.verify_image(
        original,
        session.job.initial.width,
        session.job.initial.height,
    )?;
    if original.len() > 64 * 1024 * 1024
        || assets.iter().map(|(_, b)| b.len()).sum::<usize>() > 64 * 1024 * 1024
    {
        return Err("report images exceed 64 MiB; export large products separately".into());
    }
    let job = &session.job;
    if job.pairs.is_empty() {
        return Err("select stars before generating a calibration report".into());
    }
    let legacy = crate::session::legacy_document(job, &session.metadata)?;
    let rms = legacy
        .pointer("/residual/rmsPx")
        .and_then(serde_json::Value::as_f64)
        .ok_or("no finite residual summary")?;
    let fit = FitResult {
        calibration: job.initial.clone(),
        rms_px: rms,
        iterations: 0,
    };
    let document = CalibrationDocument::from_fit(&fit, job)?;
    let order = match session
        .display
        .get("fitsByteOrder")
        .and_then(serde_json::Value::as_str)
    {
        Some("big") => crate::imaging::FitsByteOrder::Big,
        Some("little") => crate::imaging::FitsByteOrder::Little,
        _ => crate::imaging::FitsByteOrder::Auto,
    };
    let image = crate::imaging::decode(original, order)?;
    if (image.width, image.height) != (job.initial.width, job.initial.height) {
        return Err("report source image dimensions do not match calibration".into());
    }
    let rgba = image::RgbaImage::from_raw(image.width, image.height, image.rgba)
        .ok_or("invalid base image")?;
    let mut png = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(rgba)
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .unix_permissions(0o644);
    let mut names = std::collections::HashSet::new();
    let mut add = |name: &str, bytes: &[u8]| -> Result<(), String> {
        if !names.insert(name.to_owned()) {
            return Err(format!("duplicate report asset {name}"));
        }
        zip.start_file(name, options).map_err(|e| e.to_string())?;
        zip.write_all(bytes).map_err(|e| e.to_string())?;
        Ok(())
    };
    add(
        "session.json",
        &serde_json::to_vec_pretty(session).map_err(|e| e.to_string())?,
    )?;
    add(
        "calibration.json",
        &serde_json::to_vec_pretty(&document).map_err(|e| e.to_string())?,
    )?;
    add(
        "metadata.json",
        &serde_json::to_vec_pretty(&legacy).map_err(|e| e.to_string())?,
    )?;
    add(
        "calibration.h5",
        &crate::products::session_hdf5(session, Some(&fit))?,
    )?;
    let original_is_png = original.starts_with(b"\x89PNG\r\n\x1a\n");
    add(
        "base.png",
        if original_is_png {
            original
        } else {
            png.get_ref()
        },
    )?;
    let extension = session
        .image_name
        .rsplit_once('.')
        .map(|(_, s)| s.to_ascii_lowercase())
        .filter(|s| {
            ["png", "jpg", "jpeg", "heic", "heif", "fits", "fit", "fts"].contains(&s.as_str())
        })
        .unwrap_or_else(|| "bin".into());
    let source_file = if original_is_png {
        "base.png".to_owned()
    } else {
        format!("original.{extension}")
    };
    if !original_is_png {
        add(&source_file, original)?;
    }
    add(
        "manifest.json",
        &serde_json::to_vec_pretty(&serde_json::json!({
            "schema":"wisc.report/v1", "source_file":source_file,
            "source_name":session.image_name,"source_sha256":session.image_sha256,
            "base_image":"base.png", "scientific_calibration":"calibration.h5"
        }))
        .map_err(|e| e.to_string())?,
    )?;
    let compatibility = crate::miracle::product(job)?;
    add(
        "miracle.json",
        &serde_json::to_vec_pretty(&compatibility).map_err(|e| e.to_string())?,
    )?;
    add(
        "miracle.txt",
        crate::miracle::ascii(&compatibility).as_bytes(),
    )?;
    for (language, extension) in [
        ("python", "py"),
        ("julia", "jl"),
        ("matlab", "m"),
        ("c", "c"),
    ] {
        add(
            &format!("wisc_mapper.{extension}"),
            crate::code_exports::mapper(&job.initial, language)?.as_bytes(),
        )?;
    }
    add("wisc_lens.py", include_bytes!("../../../wisc_lens.py"))?;
    add(
        "read_calibration_hdf5.py",
        include_bytes!("../assets/read_calibration_hdf5.py"),
    )?;
    add(
        "read_calibration_hdf5.m",
        include_bytes!("../assets/read_calibration_hdf5.m"),
    )?;
    add("overlay.py", include_bytes!("../assets/overlay.py"))?;
    add(
        "create_az_el_table.py",
        include_bytes!("../assets/create_az_el_table.py"),
    )?;
    let mut residual_name = None;
    for (name, bytes) in assets {
        if ![
            "residuals.png",
            "residuals.svg",
            "residuals.pdf",
            "viewer.png",
            "overlay.png",
            "overlay.svg",
            "miracle_equidistant.png",
            "miracle_equisolid.png",
        ]
        .contains(name)
        {
            return Err("unsupported report asset name".into());
        }
        if name.starts_with("residuals.") {
            residual_name = Some(*name);
        }
        add(name, bytes)?;
    }
    let title = legacy
        .get("title")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(&session.image_name);
    let mut latex_plot = residual_name
        .filter(|n| !n.ends_with(".svg"))
        .map(|n| format!("\\includegraphics[width=0.85\\linewidth]{{{n}}}\n"))
        .unwrap_or_default();
    for (name, _) in assets {
        if [
            "viewer.png",
            "overlay.png",
            "miracle_equidistant.png",
            "miracle_equisolid.png",
        ]
        .contains(name)
        {
            latex_plot.push_str(&format!(
                "\\includegraphics[width=0.85\\linewidth]{{{name}}}\n"
            ));
        }
    }
    let report_tex=format!("\\documentclass{{article}}\n\\usepackage[T1]{{fontenc}}\n\\usepackage{{graphicx}}\n\\begin{{document}}\n\\section*{{WISC camera calibration}}\n{}\\par\nImage: {} by {} pixels. Optical model: {}. Selected stars: {}. RMS: {:.6} pixels.\\par\n\\includegraphics[width=\\linewidth]{{base.png}}\n{}\\par\nThe full native WISC model is authoritative. MIRACLE models are compatibility approximations. No model was re-fitted while generating this report.\n\\end{{document}}\n",tex(title),job.initial.width,job.initial.height,u8::from(job.initial.model),job.pairs.len(),rms,latex_plot);
    add("report.tex", report_tex.as_bytes())?;
    let mut html_plot = residual_name
        .map(|n| format!("<img src=\"{n}\" alt=\"Rustplotlib residual plot\"> "))
        .unwrap_or_default();
    for (name, _) in assets {
        if [
            "viewer.png",
            "overlay.png",
            "miracle_equidistant.png",
            "miracle_equisolid.png",
        ]
        .contains(name)
        {
            html_plot.push_str(&format!("<figure><img src=\"{name}\" alt=\"{name}\"><figcaption>{name}</figcaption></figure>"));
        }
    }
    let html=format!("<!doctype html><meta charset=utf-8><title>WISC calibration report</title><style>body{{font:18px serif;max-width:70rem;margin:2rem auto;padding:1rem}}img{{max-width:100%}}code{{overflow-wrap:anywhere}}</style><h1>{}</h1><p>{} × {} pixels; model {}; {} selected stars; RMS {:.6} pixels.</p><p>Source SHA-256: <code>{}</code></p><img src=\"base.png\" alt=\"Unfiltered base image\">{}<p>Scientific products: <a href=\"calibration.h5\">HDF5</a>, <a href=\"session.json\">full session</a>, <a href=\"miracle.txt\">MIRACLE approximations</a>. The native WISC model is authoritative. Viewer snapshots are display products, not scientific pixels.</p>",html(title),job.initial.width,job.initial.height,u8::from(job.initial.model),job.pairs.len(),rms,image_digest(original),html_plot);
    add("report.html", html.as_bytes())?;
    add("README.txt",format!("WISC Rust report bundle\n\nSource image: {}\nSHA-256: {}\n\nOpen report.html or compile report.tex. Every plot asset is generated by Rustplotlib.\nOriginal source bytes and unfiltered base.png are included once. Viewer/overlay PNGs are visualization products only.\ncalibration.h5 contains the authoritative native lens model, measured stars, session metadata and MIRACLE approximations.\nJSON star x/y coordinates use zero-based pixel centres; HDF5 selected_stars uses one-based rows/columns. Azimuth/zenith in JSON is radians; map planes are degrees.\nNo fitting is performed by the report generator. The full pixel-corner az/el grid is deliberately separate to keep reports small: run python create_az_el_table.py with the native wisc binary installed.\nThe standalone mappers do not require WISC; Python requires NumPy. HDF5 reader/overlay examples require h5py, NumPy and Pillow.\n",session.image_name,session.image_sha256).as_bytes())?;
    zip.finish()
        .map(|c| c.into_inner())
        .map_err(|e| e.to_string())
}

fn html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
fn tex(value: &str) -> String {
    let mut out = String::new();
    for c in value.chars() {
        match c {
            '\\' => out.push_str("\\textbackslash{}"),
            '&' | '%' | '$' | '#' | '_' | '{' | '}' => {
                out.push('\\');
                out.push(c);
            }
            '^' => out.push_str("\\textasciicircum{}"),
            '~' => out.push_str("\\textasciitilde{}"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn report_roundtrip_keeps_source_digest_and_scientific_products() {
        let original = include_bytes!(
            "../../../test_cases/BACC_NYA_20200218_010731/BACC_NYA_20200218_010731.png"
        );
        let metadata: serde_json::Value = serde_json::from_str(include_str!(
            "../../../test_cases/BACC_NYA_20200218_010731/case.json"
        ))
        .unwrap();
        let session = Session {
            schema: crate::session::SCHEMA.into(),
            image_sha256: image_digest(original),
            image_name: "BACC.png".into(),
            job: crate::workflow::parse_job(&metadata.to_string()).unwrap(),
            metadata,
            display: serde_json::json!({"altitude":10.0}),
            masked_tiles: vec![],
        };
        let bytes = bundle(&session, original, &[]).unwrap();
        let restored = crate::products::read_session(&bytes).unwrap().unwrap();
        assert_eq!(restored.job.pairs, session.job.pairs);
        assert_eq!(restored.image_sha256, session.image_sha256);
        let mut zip = ZipArchive::new(Cursor::new(bytes)).unwrap();
        assert!(zip.by_name("calibration.h5").is_ok());
        assert!(zip.by_name("report.tex").is_ok());
        assert!(zip.by_name("wisc_mapper.c").is_ok());
        assert!(zip.by_name("original.png").is_err());
        let mut source = Vec::new();
        zip.by_name("base.png")
            .unwrap()
            .read_to_end(&mut source)
            .unwrap();
        assert_eq!(image_digest(&source), session.image_sha256);
        assert!(zip.by_name("manifest.json").is_ok());
        assert!(bundle(&session, b"wrong image", &[]).is_err());
    }
}
