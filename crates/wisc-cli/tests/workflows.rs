use std::{
    fs,
    path::Path,
    process::{Command, Output},
};
use wisc_core::workflow::{parse_job, tycho_catalog, visible_catalog, FitJob, Observation};
use wisc_core::{Calibration, OpticalModel};

fn run(args: &[&str]) -> Output {
    let output = Command::new(env!("CARGO_BIN_EXE_wisc"))
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

fn as_str(path: &Path) -> &str {
    path.to_str().unwrap()
}

#[test]
fn native_lm_and_kde_commands_use_the_shared_scientific_core() {
    let directory = tempfile::tempdir().unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let case = root.join("test_cases/BACC_NYA_20200218_010731/case.json");
    let output = directory.path().join("lm.json");
    run(&[
        "fit",
        as_str(&case),
        "--lm",
        "--max-iterations",
        "200",
        "--output",
        as_str(&output),
    ]);
    let result: serde_json::Value = serde_json::from_slice(&fs::read(&output).unwrap()).unwrap();
    assert!(result["rms_px"].as_f64().unwrap() < 1.4);
    let job = parse_job(&fs::read_to_string(&case).unwrap()).unwrap();
    let first = &job.pairs[0];
    let image = root.join("test_cases/BACC_NYA_20200218_010731/BACC_NYA_20200218_010731.png");
    let output = directory.path().join("centroid.json");
    run(&[
        "centroid",
        as_str(&image),
        "--x",
        &first.x_px.to_string(),
        "--y",
        &first.y_px.to_string(),
        "--output",
        as_str(&output),
    ]);
    let result: serde_json::Value = serde_json::from_slice(&fs::read(&output).unwrap()).unwrap();
    assert!((result["x_px"].as_f64().unwrap() - first.x_px).abs() < 2.0);
    assert!((result["y_px"].as_f64().unwrap() - first.y_px).abs() < 2.0);
}

#[test]
fn saved_case_fit_export_is_directly_usable_by_project_and_fit() {
    let directory = tempfile::tempdir().unwrap();
    let saved = directory.path().join("saved.json");
    let fitted = directory.path().join("calibration.json");
    let refitted = directory.path().join("refitted.json");
    let samples = directory.path().join("sky.json");
    fs::write(
        &saved,
        include_str!("../../../test_cases/BACC_NYA_20200218_010731/case.json"),
    )
    .unwrap();
    run(&[
        "fit",
        as_str(&saved),
        "--output",
        as_str(&fitted),
        "--max-iterations",
        "400",
    ]);
    let result = parse_job(&fs::read_to_string(&fitted).unwrap()).unwrap();
    assert_eq!(result.pairs.len(), 50);
    let point = &result.pairs[0];
    fs::write(
        &samples,
        serde_json::to_vec(&vec![
            serde_json::json!({"azimuth_rad":point.azimuth_rad,"zenith_rad":point.zenith_rad}),
        ])
        .unwrap(),
    )
    .unwrap();
    let output = run(&["project", as_str(&fitted), as_str(&samples)]);
    let projected: Vec<Option<[f64; 2]>> = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        projected[0],
        result.initial.project(point.azimuth_rad, point.zenith_rad)
    );
    run(&[
        "fit",
        as_str(&fitted),
        "--output",
        as_str(&refitted),
        "--max-iterations",
        "200",
    ]);
    assert_eq!(
        parse_job(&fs::read_to_string(refitted).unwrap())
            .unwrap()
            .pairs
            .len(),
        50
    );
    let map = directory.path().join("azel.fits");
    run(&[
        "map",
        as_str(&fitted),
        "--output",
        as_str(&map),
        "--step",
        "16",
    ]);
    let bytes = fs::read(&map).unwrap();
    let header = std::str::from_utf8(&bytes[..2880]).unwrap();
    assert!(header.contains("BUNIT   = 'deg'"));
    assert!(header.contains("PLANE2  = 'ELEVATION'"));
    let metadata =
        wisc_core::imaging::decode(&bytes, wisc_core::imaging::FitsByteOrder::Big).unwrap();
    assert_eq!(metadata.fits_header["CDELT1"], "16");
    let compact = directory.path().join("calibration.h5");
    run(&[
        "fit",
        as_str(&fitted),
        "--output",
        as_str(&compact),
        "--max-iterations",
        "200",
    ]);
    let restored = wisc_core::products::import_job(&fs::read(&compact).unwrap()).unwrap();
    assert_eq!(restored.pairs, result.pairs);
    run(&["project", as_str(&compact), as_str(&samples)]);
    // Reject sampled HDF5 before opening or overwriting the destination.
    let grid = directory.path().join("azel.h5");
    fs::write(&grid, b"preserve existing file").unwrap();
    let failure = Command::new(env!("CARGO_BIN_EXE_wisc"))
        .args([
            "map",
            as_str(&compact),
            "--output",
            as_str(&grid),
            "--step",
            "2",
        ])
        .output()
        .unwrap();
    assert!(!failure.status.success());
    assert_eq!(fs::read(&grid).unwrap(), b"preserve existing file");
}

#[test]
fn solve_detects_and_matches_synthetic_fits_sky_and_rejects_bad_seed() {
    let directory = tempfile::tempdir().unwrap();
    let observation = Observation {
        unix_millis: 1_581_988_051_000,
        latitude_deg: 69.0,
        longitude_deg: 18.0,
    };
    let truth = Calibration {
        width: 512,
        height: 512,
        model: OpticalModel::Sine,
        optpar: vec![0.85, 0.85, 0.0, 0.0, 15.0, 0.0, 0.0, 0.35],
    };
    let sky = visible_catalog(&tycho_catalog().unwrap(), &observation, 4.5).unwrap();
    let mut pixels = vec![100.0f32; 512 * 512];
    for star in &sky {
        let Some([x, y]) = truth.project(star.azimuth_rad, star.zenith_rad) else {
            continue;
        };
        if !(5.0..507.0).contains(&x) || !(5.0..507.0).contains(&y) {
            continue;
        }
        for py in (y as usize - 4)..=(y as usize + 4) {
            for px in (x as usize - 4)..=(x as usize + 4) {
                let radius = (px as f64 - x).powi(2) + (py as f64 - y).powi(2);
                pixels[py * 512 + px] +=
                    (2000.0 * 10.0f64.powf(-0.2 * star.magnitude) * (-radius / 2.0).exp()) as f32;
            }
        }
    }
    let mut bytes = Vec::new();
    for (key, value) in [
        ("SIMPLE", "T"),
        ("BITPIX", "-32"),
        ("NAXIS", "2"),
        ("NAXIS1", "512"),
        ("NAXIS2", "512"),
    ] {
        bytes.extend(format!("{:<80}", format!("{key:<8}= {value}")).as_bytes());
    }
    bytes.extend(format!("{:<80}", "END").as_bytes());
    bytes.resize(2880, b' ');
    bytes.extend(pixels.iter().flat_map(|value| value.to_be_bytes()));
    let image = directory.path().join("sky.fits");
    fs::write(&image, bytes).unwrap();
    let mut initial = truth.clone();
    initial.optpar[4] += 0.2;
    initial.optpar[5] += 0.002;
    let mut job = FitJob {
        initial,
        pairs: Vec::new(),
        observation: Some(observation),
    };
    let source = directory.path().join("initial.json");
    fs::write(&source, serde_json::to_vec(&job).unwrap()).unwrap();
    let result = directory.path().join("solved.json");
    run(&[
        "solve",
        as_str(&image),
        "--initial",
        as_str(&source),
        "--output",
        as_str(&result),
        "--max-magnitude",
        "4.5",
        "--match-radius",
        "5",
    ]);
    let output: serde_json::Value = serde_json::from_slice(&fs::read(&result).unwrap()).unwrap();
    assert!(output["rms_px"].as_f64().unwrap() < 0.6, "{output}");
    assert!(output["pairs"].as_array().unwrap().len() > 20);
    job.initial.optpar[5] = 10.0;
    fs::write(&source, serde_json::to_vec(&job).unwrap()).unwrap();
    let failed_result = directory.path().join("failed.json");
    let failed = Command::new(env!("CARGO_BIN_EXE_wisc"))
        .args([
            "solve",
            as_str(&image),
            "--initial",
            as_str(&source),
            "--output",
            as_str(&failed_result),
        ])
        .output()
        .unwrap();
    assert!(!failed.status.success());
    assert!(!failed_result.exists());
}
