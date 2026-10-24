//! Platform-independent calibration algorithms shared by WISC's CLI and WASM UI.

use nalgebra::Matrix3;
use ndarray::ArrayView2;
use serde::{Deserialize, Serialize};
use std::f64::consts::PI;

pub mod asterism;
pub mod geometry;
pub mod imaging;
pub mod workflow;

pub const DEG: f64 = PI / 180.0;
pub const RAD: f64 = 180.0 / PI;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(try_from = "u8", into = "u8")]
pub enum OpticalModel {
    Pinhole = 1,
    Sine = 2,
    Mixed = 3,
    Power = 4,
    Tangent = 5,
    Equisolid = 6,
    Unified = 12,
    BrownConrady = 20,
}

impl TryFrom<u8> for OpticalModel {
    type Error = String;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::Pinhole),
            2 => Ok(Self::Sine),
            3 => Ok(Self::Mixed),
            4 => Ok(Self::Power),
            5 => Ok(Self::Tangent),
            6 => Ok(Self::Equisolid),
            12 => Ok(Self::Unified),
            20 => Ok(Self::BrownConrady),
            _ => Err(format!("unsupported optical model {value}")),
        }
    }
}

impl From<OpticalModel> for u8 {
    fn from(value: OpticalModel) -> Self {
        value as u8
    }
}

impl OpticalModel {
    pub fn parameter_count(self) -> usize {
        if self == Self::BrownConrady {
            12
        } else {
            8
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct Calibration {
    pub width: u32,
    pub height: u32,
    pub model: OpticalModel,
    pub optpar: Vec<f64>,
}

impl Calibration {
    pub fn validate(&self) -> Result<(), String> {
        if self.width == 0 || self.height == 0 {
            return Err("image dimensions must be positive".into());
        }
        if self.optpar.len() != self.model.parameter_count() {
            return Err(format!(
                "model {} needs {} parameters, got {}",
                u8::from(self.model),
                self.model.parameter_count(),
                self.optpar.len()
            ));
        }
        if !self.optpar.iter().all(|value| value.is_finite()) {
            return Err("optpar contains a non-finite value".into());
        }
        if self.optpar[0].abs() < 0.05 || self.optpar[1].abs() < 0.05 {
            return Err("focal parameters must have magnitude >= 0.05".into());
        }
        Ok(())
    }

    pub fn project(&self, azimuth_rad: f64, zenith_rad: f64) -> Option<[f64; 2]> {
        project(
            azimuth_rad,
            zenith_rad,
            &self.optpar,
            self.model,
            self.width,
            self.height,
        )
    }
}

pub fn default_optpar(width: u32, height: u32, model: OpticalModel) -> Vec<f64> {
    let alpha = match model {
        OpticalModel::BrownConrady | OpticalModel::Unified => 0.0,
        OpticalModel::Pinhole | OpticalModel::Power => 1.0,
        OpticalModel::Tangent | OpticalModel::Equisolid => 0.5,
        _ => 0.35,
    };
    let mut values = vec![
        1.0,
        width as f64 / height.max(1) as f64,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        alpha,
    ];
    if model == OpticalModel::BrownConrady {
        values.extend([0.0; 4]);
    }
    values
}

pub fn camera_rotation(alpha_deg: f64, beta_deg: f64, gamma_deg: f64) -> [f64; 9] {
    let (a, b, g) = (alpha_deg * DEG, beta_deg * DEG, gamma_deg * DEG);
    let rot1 = Matrix3::new(g.cos(), -g.sin(), 0.0, g.sin(), g.cos(), 0.0, 0.0, 0.0, 1.0);
    let rot2 = Matrix3::new(a.cos(), 0.0, a.sin(), 0.0, 1.0, 0.0, -a.sin(), 0.0, a.cos());
    let rot3 = Matrix3::new(1.0, 0.0, 0.0, 0.0, b.cos(), b.sin(), 0.0, -b.sin(), b.cos());
    let rotation = rot2 * rot3 * rot1;
    std::array::from_fn(|index| rotation[(index / 3, index % 3)])
}

pub fn camera_angles(rotation: &[f64; 9]) -> [f64; 3] {
    let beta = rotation[5].clamp(-1.0, 1.0).asin();
    let (alpha, gamma) = if beta.cos().abs() > 1e-9 {
        (
            rotation[2].atan2(rotation[8]),
            rotation[3].atan2(rotation[4]),
        )
    } else {
        (0.0, (-rotation[1]).atan2(rotation[0]))
    };
    [alpha * RAD, beta * RAD, gamma * RAD]
}

pub fn project(
    azimuth_rad: f64,
    zenith_rad: f64,
    optpar: &[f64],
    model: OpticalModel,
    width: u32,
    height: u32,
) -> Option<[f64; 2]> {
    if width == 0
        || height == 0
        || optpar.len() != model.parameter_count()
        || !optpar.iter().all(|value| value.is_finite())
    {
        return None;
    }
    let rotation = camera_rotation(optpar[2], optpar[3], optpar[4]);
    let sin_zenith = zenith_rad.sin();
    let east = sin_zenith * azimuth_rad.sin();
    let north = sin_zenith * azimuth_rad.cos();
    let up = zenith_rad.cos();
    let x = east * rotation[0] + north * rotation[3] + up * rotation[6];
    let y = east * rotation[1] + north * rotation[4] + up * rotation[7];
    let z = east * rotation[2] + north * rotation[5] + up * rotation[8];
    let radial = x.hypot(y);
    let theta = radial.atan2(z);
    let (f1, f2, dx, dy, alpha) = (optpar[0], optpar[1], optpar[5], optpar[6], optpar[7]);
    let (u, v) = if radial <= 1e-12 {
        (0.5 + dx, 0.5 + dy)
    } else {
        let unit_x = x / radial;
        let unit_y = y / radial;
        match model {
            OpticalModel::Pinhole => {
                let safe_z = if z.abs() > 1e-12 { z } else { 1e-12 };
                (f1 * x / safe_z + 0.5 + dx, f2 * y / safe_z + 0.5 + dy)
            }
            OpticalModel::Sine => {
                let radius = (alpha * theta).sin();
                (
                    f1 * unit_x * radius + 0.5 + dx,
                    f2 * unit_y * radius + 0.5 + dy,
                )
            }
            OpticalModel::Mixed => {
                let safe_z = z.max(1e-12);
                (
                    f1 * (1.0 - alpha) * x / safe_z + f1 * alpha * unit_x * theta + 0.5 + dx,
                    f2 * (1.0 - alpha) * y / safe_z + f2 * alpha * unit_y * theta + 0.5 + dy,
                )
            }
            OpticalModel::Power => {
                let radius = theta.abs().powf(alpha);
                (
                    f1 * unit_x * radius + 0.5 + dx,
                    f2 * unit_y * radius + 0.5 + dy,
                )
            }
            OpticalModel::Tangent => {
                let radius = (alpha * theta).tan();
                (
                    f1 * unit_x * radius + 0.5 + dx,
                    f2 * unit_y * radius + 0.5 + dy,
                )
            }
            OpticalModel::Equisolid => {
                let radius = (0.5 * theta).sin();
                (
                    f1 * unit_x * radius + 0.5 + dx,
                    f2 * unit_y * radius + 0.5 + dy,
                )
            }
            OpticalModel::Unified => {
                let radius = if alpha > 0.0 {
                    (alpha * theta).tan() / alpha
                } else if alpha < 0.0 {
                    (alpha * theta).sin() / alpha
                } else {
                    theta.abs()
                };
                (
                    f1 * unit_x * radius + 0.5 + dx,
                    f2 * unit_y * radius + 0.5 + dy,
                )
            }
            OpticalModel::BrownConrady => {
                let safe_z = if z.abs() > 1e-12 { z } else { 1e-12 };
                let xn = x / safe_z;
                let yn = y / safe_z;
                let r2 = xn * xn + yn * yn;
                let (k1, k2, k3, p1, p2) =
                    (optpar[7], optpar[8], optpar[9], optpar[10], optpar[11]);
                let distortion = 1.0 + k1 * r2 + k2 * r2.powi(2) + k3 * r2.powi(3);
                let xd = xn * distortion + 2.0 * p1 * xn * yn + p2 * (r2 + 2.0 * xn * xn);
                let yd = yn * distortion + p1 * (r2 + 2.0 * yn * yn) + 2.0 * p2 * xn * yn;
                (f1 * xd + 0.5 + dx, f2 * yd + 0.5 + dy)
            }
        }
    };
    let pixel = [u * width as f64 - 1.0, v * height as f64 - 1.0];
    pixel.iter().all(|value| value.is_finite()).then_some(pixel)
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
pub struct StarPair {
    pub azimuth_rad: f64,
    pub zenith_rad: f64,
    pub x_px: f64,
    pub y_px: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct FitResult {
    pub calibration: Calibration,
    pub rms_px: f64,
    pub iterations: usize,
}

fn parameter_bounds(model: OpticalModel, index: usize) -> (f64, f64) {
    match index {
        0 | 1 => (-10.0, 10.0),
        2 | 4 => (-720.0, 720.0),
        3 => (-90.0, 90.0),
        5 | 6 => (-0.5, 0.5),
        7 if model == OpticalModel::BrownConrady => (-5.0, 5.0),
        7 if model == OpticalModel::Unified => (-2.0, 2.0),
        7 => (0.01, 2.0),
        8 | 9 => (-5.0, 5.0),
        10 | 11 => (-1.0, 1.0),
        _ => (f64::NEG_INFINITY, f64::INFINITY),
    }
}

fn clamp_parameters(values: &mut [f64], model: OpticalModel) {
    for (index, value) in values.iter_mut().enumerate() {
        let (low, high) = parameter_bounds(model, index);
        *value = value.clamp(low, high);
    }
    for value in &mut values[..2] {
        if value.abs() < 0.05 {
            *value = if value.is_sign_negative() {
                -0.05
            } else {
                0.05
            };
        }
    }
    if model == OpticalModel::Equisolid {
        values[7] = 0.5;
    }
}

fn residual_radii(calibration: &Calibration, pairs: &[StarPair]) -> Option<Vec<f64>> {
    pairs
        .iter()
        .map(|pair| {
            calibration
                .project(pair.azimuth_rad, pair.zenith_rad)
                .map(|pixel| (pixel[0] - pair.x_px).hypot(pixel[1] - pair.y_px))
        })
        .collect()
}

fn median(values: &mut [f64]) -> f64 {
    values.sort_by(f64::total_cmp);
    let middle = values.len() / 2;
    if values.len() & 1 == 0 {
        (values[middle - 1] + values[middle]) * 0.5
    } else {
        values[middle]
    }
}

fn objective(calibration: &Calibration, pairs: &[StarPair]) -> f64 {
    let Some(radii) = residual_radii(calibration, pairs) else {
        return 1e30;
    };
    if radii.is_empty() {
        return 1e30;
    }
    let mut scale_values = radii.clone();
    let scale = (1.4826 * median(&mut scale_values)).max(4.0);
    let cutoff = 1.345 * scale;
    radii
        .iter()
        .map(|radius| {
            if *radius <= cutoff {
                radius * radius
            } else {
                2.0 * cutoff * radius - cutoff * cutoff
            }
        })
        .sum()
}

pub fn fit(
    start: &Calibration,
    pairs: &[StarPair],
    max_iterations: usize,
) -> Result<FitResult, String> {
    start.validate()?;
    if max_iterations == 0 {
        return Err("max_iterations must be positive".into());
    }
    if pairs.len() * 2 < start.model.parameter_count() {
        return Err(format!(
            "need at least {} star pairs for model {}",
            start.model.parameter_count().div_ceil(2),
            u8::from(start.model)
        ));
    }
    if !pairs.iter().all(|pair| {
        [pair.azimuth_rad, pair.zenith_rad, pair.x_px, pair.y_px]
            .iter()
            .all(|value| value.is_finite())
    }) {
        return Err("star pairs contain non-finite values".into());
    }
    let steps: Vec<f64> = if start.model == OpticalModel::BrownConrady {
        vec![
            0.05, 0.05, 1.5, 1.5, 2.0, 0.006, 0.006, 0.02, 0.006, 0.003, 0.001, 0.001,
        ]
    } else {
        vec![0.05, 0.05, 1.5, 1.5, 2.0, 0.006, 0.006, 0.03]
    };
    let count = start.model.parameter_count();
    let mut simplex = Vec::with_capacity(count + 1);
    simplex.push(start.optpar.clone());
    for index in 0..count {
        let mut vertex = start.optpar.clone();
        vertex[index] += steps[index];
        clamp_parameters(&mut vertex, start.model);
        simplex.push(vertex);
    }
    let evaluate = |values: &[f64]| {
        objective(
            &Calibration {
                width: start.width,
                height: start.height,
                model: start.model,
                optpar: values.to_vec(),
            },
            pairs,
        )
    };
    let mut scores: Vec<f64> = simplex.iter().map(|vertex| evaluate(vertex)).collect();
    let mut iterations = 0;
    while iterations < max_iterations {
        let mut order: Vec<usize> = (0..simplex.len()).collect();
        order.sort_by(|left, right| scores[*left].total_cmp(&scores[*right]));
        simplex = order.iter().map(|index| simplex[*index].clone()).collect();
        scores = order.iter().map(|index| scores[*index]).collect();
        if (scores[count] - scores[0]).abs() <= 1e-10 * (1.0 + scores[0].abs()) {
            break;
        }
        let mut centroid = vec![0.0; count];
        for vertex in &simplex[..count] {
            for (sum, value) in centroid.iter_mut().zip(vertex) {
                *sum += value / count as f64;
            }
        }
        let candidate = |factor: f64| {
            let mut values: Vec<f64> = centroid
                .iter()
                .zip(&simplex[count])
                .map(|(center, worst)| center + factor * (center - worst))
                .collect();
            clamp_parameters(&mut values, start.model);
            values
        };
        let reflected = candidate(1.0);
        let reflected_score = evaluate(&reflected);
        if reflected_score < scores[0] {
            let expanded = candidate(2.0);
            let expanded_score = evaluate(&expanded);
            if expanded_score < reflected_score {
                simplex[count] = expanded;
                scores[count] = expanded_score;
            } else {
                simplex[count] = reflected;
                scores[count] = reflected_score;
            }
        } else if reflected_score < scores[count - 1] {
            simplex[count] = reflected;
            scores[count] = reflected_score;
        } else {
            // Outside contraction follows an improving reflection. Otherwise
            // contract between the centroid and the original worst vertex.
            let outside = reflected_score < scores[count];
            let contracted = candidate(if outside { 0.5 } else { -0.5 });
            let contracted_score = evaluate(&contracted);
            let contraction_limit = if outside {
                reflected_score
            } else {
                scores[count]
            };
            if contracted_score < contraction_limit {
                simplex[count] = contracted;
                scores[count] = contracted_score;
            } else {
                let best = simplex[0].clone();
                for index in 1..=count {
                    for parameter in 0..count {
                        simplex[index][parameter] =
                            best[parameter] + 0.5 * (simplex[index][parameter] - best[parameter]);
                    }
                    clamp_parameters(&mut simplex[index], start.model);
                    scores[index] = evaluate(&simplex[index]);
                }
            }
        }
        iterations += 1;
    }
    let (best, _) = scores
        .iter()
        .enumerate()
        .min_by(|left, right| left.1.total_cmp(right.1))
        .ok_or("fit did not produce a candidate")?;
    let calibration = Calibration {
        width: start.width,
        height: start.height,
        model: start.model,
        optpar: simplex[best].clone(),
    };
    let radii = residual_radii(&calibration, pairs).ok_or("projection failed")?;
    let rms_px = (radii.iter().map(|value| value * value).sum::<f64>() / radii.len() as f64).sqrt();
    Ok(FitResult {
        calibration,
        rms_px,
        iterations,
    })
}

pub fn julian_date(unix_millis: i64) -> f64 {
    2_440_587.5 + unix_millis as f64 / 86_400_000.0
}

fn wrap(value: f64, modulus: f64) -> f64 {
    value.rem_euclid(modulus)
}

pub fn precess_j2000(ra_hours: f64, dec_deg: f64, unix_millis: i64) -> [f64; 2] {
    let centuries = (julian_date(unix_millis) - 2_451_545.0) / 36_525.0;
    let arcsec = DEG / 3600.0;
    let zeta = (2306.2181 * centuries + 0.30188 * centuries.powi(2) + 0.017998 * centuries.powi(3))
        * arcsec;
    let z = (2306.2181 * centuries + 1.09468 * centuries.powi(2) + 0.018203 * centuries.powi(3))
        * arcsec;
    let theta =
        (2004.3109 * centuries - 0.42665 * centuries.powi(2) - 0.041833 * centuries.powi(3))
            * arcsec;
    let ra = ra_hours / 12.0 * PI;
    let dec = dec_deg * DEG;
    let a = dec.cos() * (ra + zeta).sin();
    let b = theta.cos() * dec.cos() * (ra + zeta).cos() - theta.sin() * dec.sin();
    let c = theta.sin() * dec.cos() * (ra + zeta).cos() + theta.cos() * dec.sin();
    [wrap(a.atan2(b) + z, 2.0 * PI), c.clamp(-1.0, 1.0).asin()]
}

pub fn radec_to_azimuth_zenith(
    ra_hours: f64,
    dec_deg: f64,
    unix_millis: i64,
    latitude_deg: f64,
    longitude_deg: f64,
) -> [f64; 2] {
    let jd = julian_date(unix_millis);
    let centuries = (jd - 2_451_545.0) / 36_525.0;
    let gmst = wrap(
        280.460_618_37
            + 360.985_647_366_29 * (jd - 2_451_545.0)
            + 0.000_387_933 * centuries.powi(2)
            - centuries.powi(3) / 38_710_000.0,
        360.0,
    );
    let sidereal = (gmst + longitude_deg) * DEG;
    let [ra, dec] = precess_j2000(ra_hours, dec_deg, unix_millis);
    let latitude = latitude_deg * DEG;
    let altitude = ((sidereal - ra).cos() * dec.cos() * latitude.cos()
        + dec.sin() * latitude.sin())
    .clamp(-1.0, 1.0)
    .asin();
    let cos_altitude = altitude.cos().max(1e-12);
    let sin_azimuth = (sidereal - ra).sin() * dec.cos() / cos_altitude;
    let cos_azimuth = ((sidereal - ra).cos() * dec.cos() * latitude.sin()
        - dec.sin() * latitude.cos())
        / cos_altitude;
    [
        wrap(sin_azimuth.atan2(cos_azimuth) + PI, 2.0 * PI),
        PI / 2.0 - altitude,
    ]
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct Detection {
    pub x: f64,
    pub y: f64,
    pub flux: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct DetectorConfig {
    pub threshold_sigma: f64,
    pub suppression_radius_px: f64,
    pub max_stars: usize,
}

impl Default for DetectorConfig {
    fn default() -> Self {
        Self {
            threshold_sigma: 5.0,
            suppression_radius_px: 8.0,
            max_stars: 500,
        }
    }
}

pub fn detect_stars(
    luminance: &[f32],
    width: u32,
    height: u32,
    config: DetectorConfig,
) -> Vec<Detection> {
    if width < 3 || height < 3 || luminance.len() != width as usize * height as usize {
        return Vec::new();
    }
    let Ok(image) = ArrayView2::from_shape((height as usize, width as usize), luminance) else {
        return Vec::new();
    };
    if config.max_stars == 0
        || !config.threshold_sigma.is_finite()
        || !config.suppression_radius_px.is_finite()
    {
        return Vec::new();
    }
    let finite: Vec<f64> = luminance
        .iter()
        .copied()
        .filter(|value| value.is_finite())
        .map(f64::from)
        .collect();
    if finite.is_empty() {
        return Vec::new();
    }
    let mean = finite.iter().sum::<f64>() / finite.len() as f64;
    let variance = finite
        .iter()
        .map(|value| (value - mean).powi(2))
        .sum::<f64>()
        / finite.len() as f64;
    let mut sorted = finite.clone();
    let background = median(&mut sorted);
    let mut deviations: Vec<f64> = finite
        .iter()
        .map(|value| (value - background).abs())
        .collect();
    let robust_sigma = (1.4826 * median(&mut deviations)).max(0.25);
    let percentile_99 = sorted[((sorted.len() - 1) * 99) / 100];
    let threshold = (background + config.threshold_sigma.max(0.0) * robust_sigma)
        .min(mean + config.threshold_sigma.max(0.0) * variance.sqrt())
        .min(percentile_99);
    let at = |x: u32, y: u32| f64::from(image[[y as usize, x as usize]]);
    let mut candidates = Vec::new();
    for y in 1..height - 1 {
        for x in 1..width - 1 {
            let center = at(x, y);
            if !center.is_finite() || center < threshold {
                continue;
            }
            let neighbour_mean = ((-1..=1)
                .flat_map(|dy| (-1..=1).map(move |dx| (dx, dy)))
                .filter(|(dx, dy)| *dx != 0 || *dy != 0)
                .map(|(dx, dy)| at((x as i32 + dx) as u32, (y as i32 + dy) as u32))
                .sum::<f64>())
                / 8.0;
            if center - neighbour_mean < robust_sigma * 0.2 {
                continue;
            }
            if (-1..=1).all(|dy| {
                (-1..=1).all(|dx| {
                    dx == 0 && dy == 0
                        || center >= at((x as i32 + dx) as u32, (y as i32 + dy) as u32)
                })
            }) {
                let mut weight = 0.0;
                let mut weighted_x = 0.0;
                let mut weighted_y = 0.0;
                for dy in -1..=1 {
                    for dx in -1..=1 {
                        let sample =
                            (at((x as i32 + dx) as u32, (y as i32 + dy) as u32) - mean).max(0.0);
                        weight += sample;
                        weighted_x += sample * (x as f64 + dx as f64);
                        weighted_y += sample * (y as f64 + dy as f64);
                    }
                }
                if weight > 0.0 {
                    candidates.push(Detection {
                        x: weighted_x / weight,
                        y: weighted_y / weight,
                        flux: weight,
                    });
                }
            }
        }
    }
    candidates.sort_by(|left, right| right.flux.total_cmp(&left.flux));
    let radius2 = config.suppression_radius_px.max(0.0).powi(2);
    let mut selected: Vec<Detection> = Vec::new();
    for candidate in candidates {
        if selected.iter().all(|other| {
            (candidate.x - other.x).powi(2) + (candidate.y - other.y).powi(2) > radius2
        }) {
            selected.push(candidate);
            if selected.len() >= config.max_stars {
                break;
            }
        }
    }
    selected
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalogue_coordinates_agree_with_independent_unrefracted_astropy() {
        // Astropy 7.0 ICRS -> AltAz, pressure=0, bundled IERS data, no network.
        // These match the legacy astrometry test's 0.02 degree accuracy gate.
        for (ra, dec, time, lat, lon, expected_az, expected_el) in [
            (
                5.9195278,
                7.4069444,
                1_770_923_040_000,
                67.8558,
                20.2253,
                179.9050818562479,
                29.55488976058772,
            ),
            (
                5.2781556,
                45.9979917,
                1_768_239_323_000,
                69.586,
                19.2247,
                113.8040886062604,
                57.95350713066306,
            ),
            (
                6.752477,
                -16.7161159,
                1_734_557_298_000,
                69.586,
                19.2247,
                149.2296298692962,
                0.7111979565211541,
            ),
            (
                13.3987333,
                54.9253611,
                1_748_736_000_000,
                0.0,
                0.0,
                332.1511602799789,
                22.462769168665066,
            ),
        ] {
            let [az, ze] = radec_to_azimuth_zenith(ra, dec, time, lat, lon);
            let daz = (az * RAD - expected_az + 180.0).rem_euclid(360.0) - 180.0;
            let del = 90.0 - ze * RAD - expected_el;
            assert!((daz * (expected_el * DEG).cos()).hypot(del) < 0.02);
        }
    }

    fn near(actual: f64, expected: f64, tolerance: f64) {
        assert!(
            (actual - expected).abs() <= tolerance,
            "{actual} != {expected}"
        );
    }

    #[test]
    fn identity_projection_matches_legacy_pixel_convention() {
        let optpar = vec![2.5, 2.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.35];
        let pixel = project(0.0, 0.0, &optpar, OpticalModel::Sine, 1024, 768).unwrap();
        near(pixel[0], 511.0, 1e-12);
        near(pixel[1], 383.0, 1e-12);
    }

    #[test]
    fn rotation_round_trip() {
        for angles in [[0.0, 0.0, 0.0], [23.0, -19.0, 71.0], [-40.0, 32.0, -120.0]] {
            let recovered = camera_angles(&camera_rotation(angles[0], angles[1], angles[2]));
            for index in 0..3 {
                near(recovered[index], angles[index], 1e-10);
            }
        }
    }

    #[test]
    fn robust_fit_recovers_synthetic_calibration() {
        let truth = Calibration {
            width: 1024,
            height: 768,
            model: OpticalModel::Sine,
            optpar: vec![1.8, 2.1, 8.0, -13.0, 27.0, 0.02, -0.01, 0.42],
        };
        let mut pairs = Vec::new();
        for azimuth_deg in (0..360).step_by(30) {
            for zenith_deg in [15.0, 35.0, 55.0] {
                let azimuth = azimuth_deg as f64 * DEG;
                let zenith = zenith_deg * DEG;
                let pixel = truth.project(azimuth, zenith).unwrap();
                pairs.push(StarPair {
                    azimuth_rad: azimuth,
                    zenith_rad: zenith,
                    x_px: pixel[0],
                    y_px: pixel[1],
                });
            }
        }
        let mut start = truth.clone();
        start.optpar[2] += 1.0;
        start.optpar[3] -= 1.0;
        start.optpar[5] += 0.005;
        let fitted = fit(&start, &pairs, 1200).unwrap();
        assert!(fitted.rms_px < 0.1, "RMS {}", fitted.rms_px);
    }

    #[test]
    fn detector_centroids_bright_peak() {
        let mut image = vec![0.0; 25];
        image[2 * 5 + 3] = 100.0;
        image[2 * 5 + 2] = 20.0;
        let stars = detect_stars(
            &image,
            5,
            5,
            DetectorConfig {
                threshold_sigma: 2.0,
                ..Default::default()
            },
        );
        assert_eq!(stars.len(), 1);
        assert!(stars[0].x > 2.5 && stars[0].x < 3.1);
    }
}
