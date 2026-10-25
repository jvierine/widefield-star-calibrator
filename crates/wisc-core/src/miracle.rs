//! MIRACLE equidistant/equisolid compatibility fits. The native WISC model
//! remains authoritative; these lower-dimensional models are approximations.
use crate::{workflow::FitJob, StarPair, DEG, RAD};
use nalgebra::{DMatrix, DVector};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Projection {
    Equidistant,
    Equisolid,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fit {
    pub projection: Projection,
    pub glat_deg: f64,
    pub glon_deg: f64,
    pub xc_px: f64,
    pub yc_px: f64,
    pub scale_px: f64,
    pub rotation_rad: f64,
    pub center_offset_row_px: f64,
    pub center_offset_col_px: f64,
    pub sample_count: usize,
    pub fit_source: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub count: usize,
    pub rms_pixel: Option<f64>,
    pub std_pixel: Option<f64>,
    pub rms_angle_deg: Option<f64>,
    pub std_angle_deg: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Product {
    pub equidistant: Fit,
    pub equisolid: Fit,
    pub equidistant_residuals: Vec<[f64; 4]>,
    pub equisolid_residuals: Vec<[f64; 4]>,
    pub equidistant_summary: Summary,
    pub equisolid_summary: Summary,
    pub reference_rms_angle_deg: f64,
    pub reference_max_angle_deg: f64,
}

fn radial(ze: f64, projection: Projection) -> f64 {
    match projection {
        Projection::Equidistant => ze,
        Projection::Equisolid => (0.5 * ze).sin(),
    }
}

fn fit(
    job: &FitJob,
    pairs: &[StarPair],
    projection: Projection,
    source: &str,
) -> Result<Fit, String> {
    let pairs: Vec<_> = pairs
        .iter()
        .filter(|p| {
            p.zenith_rad > 1e-9 * DEG
                && [p.x_px, p.y_px, p.azimuth_rad, p.zenith_rad]
                    .iter()
                    .all(|v| v.is_finite())
        })
        .collect();
    if pairs.len() < 2 {
        return Err("MIRACLE fit needs at least two valid stars".into());
    }
    let mut design = DMatrix::zeros(2 * pairs.len(), 4);
    let mut measured = DVector::zeros(2 * pairs.len());
    for (i, p) in pairs.iter().enumerate() {
        let r = radial(p.zenith_rad, projection);
        let (s, c) = p.azimuth_rad.sin_cos();
        design[(2 * i, 0)] = 1.0;
        design[(2 * i, 2)] = -r * c;
        design[(2 * i, 3)] = r * s;
        measured[2 * i] = p.y_px + 1.0;
        design[(2 * i + 1, 1)] = 1.0;
        design[(2 * i + 1, 2)] = -r * s;
        design[(2 * i + 1, 3)] = -r * c;
        measured[2 * i + 1] = p.x_px + 1.0;
    }
    let svd = design.svd(true, true);
    let tolerance = svd.singular_values.amax() * 1e-12;
    if svd
        .singular_values
        .iter()
        .filter(|v| **v > tolerance)
        .count()
        < 4
    {
        return Err("selected stars do not constrain a MIRACLE calibration".into());
    }
    let solution = svd.solve(&measured, tolerance).map_err(str::to_owned)?;
    let scale = solution[2].hypot(solution[3]);
    if !scale.is_finite() || scale <= 0.0 {
        return Err("invalid MIRACLE scale".into());
    }
    Ok(Fit {
        projection,
        glat_deg: job
            .observation
            .as_ref()
            .map(|o| o.latitude_deg)
            .unwrap_or(0.0),
        glon_deg: job
            .observation
            .as_ref()
            .map(|o| o.longitude_deg)
            .unwrap_or(0.0),
        xc_px: solution[0],
        yc_px: solution[1],
        scale_px: scale,
        rotation_rad: solution[3].atan2(solution[2]),
        center_offset_row_px: solution[0] - (job.initial.height as f64 + 1.0) / 2.0,
        center_offset_col_px: solution[1] - (job.initial.width as f64 + 1.0) / 2.0,
        sample_count: pairs.len(),
        fit_source: source.into(),
    })
}

impl Fit {
    pub fn project(&self, az: f64, ze: f64) -> [f64; 2] {
        let r = self.scale_px * radial(ze, self.projection);
        [
            self.xc_px - r * (az + self.rotation_rad).cos(),
            self.yc_px - r * (az + self.rotation_rad).sin(),
        ]
    }
    pub fn sky(&self, row: f64, col: f64) -> Option<[f64; 2]> {
        let (v, h) = (row - self.xc_px, col - self.yc_px);
        let distance = v.hypot(h);
        let ze = match self.projection {
            Projection::Equidistant => distance / self.scale_px,
            Projection::Equisolid => {
                let r = distance / self.scale_px;
                if r > 1.0 {
                    return None;
                }
                2.0 * r.asin()
            }
        };
        let az = if distance <= 1e-12 {
            0.0
        } else {
            (-h * self.rotation_rad.cos() + v * self.rotation_rad.sin())
                .atan2(-v * self.rotation_rad.cos() - h * self.rotation_rad.sin())
        };
        (az.is_finite() && ze.is_finite()).then_some([az, ze])
    }
    pub fn residuals(&self, pairs: &[StarPair]) -> Vec<[f64; 4]> {
        pairs
            .iter()
            .filter_map(|p| {
                let [row, col] = self.project(p.azimuth_rad, p.zenith_rad);
                let dy = row - p.y_px - 1.0;
                let dx = col - p.x_px - 1.0;
                let [az, ze] = self.sky(p.y_px + 1.0, p.x_px + 1.0)?;
                let angle = (p.zenith_rad.cos() * ze.cos()
                    + p.zenith_rad.sin() * ze.sin() * (p.azimuth_rad - az).cos())
                .clamp(-1.0, 1.0)
                .acos()
                    * RAD;
                Some([dy, dx, dy.hypot(dx), angle])
            })
            .collect()
    }
}

pub fn summary(residuals: &[[f64; 4]]) -> Summary {
    let rows: Vec<_> = residuals
        .iter()
        .filter(|r| r.iter().all(|v| v.is_finite()))
        .collect();
    let stats = |column: usize| {
        if rows.is_empty() {
            return (None, None);
        }
        let n = rows.len() as f64;
        let mean = rows.iter().map(|r| r[column]).sum::<f64>() / n;
        (
            Some((rows.iter().map(|r| r[column] * r[column]).sum::<f64>() / n).sqrt()),
            Some((rows.iter().map(|r| (r[column] - mean).powi(2)).sum::<f64>() / n).sqrt()),
        )
    };
    let (rms_pixel, std_pixel) = stats(2);
    let (rms_angle_deg, std_angle_deg) = stats(3);
    Summary {
        count: rows.len(),
        rms_pixel,
        std_pixel,
        rms_angle_deg,
        std_angle_deg,
    }
}

pub fn product(job: &FitJob) -> Result<Product, String> {
    job.initial.validate()?;
    let mut reference = Vec::new();
    for ze in (5..=90).step_by(5) {
        for az in (0..360).step_by(5) {
            if let Some(pixel) = job
                .initial
                .project(az as f64 * DEG, ze as f64 * DEG)
                .filter(|p| {
                    p[0] >= 0.0
                        && p[1] >= 0.0
                        && p[0] <= job.initial.width as f64 - 1.0
                        && p[1] <= job.initial.height as f64 - 1.0
                })
            {
                reference.push(StarPair {
                    azimuth_rad: az as f64 * DEG,
                    zenith_rad: ze as f64 * DEG,
                    x_px: pixel[0],
                    y_px: pixel[1],
                });
            }
        }
    }
    let selected = if job.pairs.len() >= 3 {
        fit(
            job,
            &job.pairs,
            Projection::Equidistant,
            "selected WISC stars",
        )
        .ok()
    } else {
        None
    };
    let (pairs, source, equidistant) = if let Some(fit) = selected {
        (&job.pairs, "selected WISC stars", fit)
    } else {
        (
            &reference,
            "native WISC lens model fallback",
            fit(
                job,
                &reference,
                Projection::Equidistant,
                "native WISC lens model fallback",
            )?,
        )
    };
    let equisolid = fit(job, pairs, Projection::Equisolid, source)?;
    let samples = if job.pairs.is_empty() {
        pairs
    } else {
        &job.pairs
    };
    let equidistant_residuals = equidistant.residuals(samples);
    let equisolid_residuals = equisolid.residuals(samples);
    let angular: Vec<_> = equidistant
        .residuals(&reference)
        .into_iter()
        .map(|r| r[3])
        .collect();
    let reference_rms_angle_deg = if angular.is_empty() {
        f64::NAN
    } else {
        (angular.iter().map(|r| r * r).sum::<f64>() / angular.len() as f64).sqrt()
    };
    let reference_max_angle_deg =
        angular
            .iter()
            .copied()
            .fold(f64::NAN, |a, b| if a.is_nan() { b } else { a.max(b) });
    Ok(Product {
        equidistant_summary: summary(&equidistant_residuals),
        equisolid_summary: summary(&equisolid_residuals),
        equidistant,
        equisolid,
        equidistant_residuals,
        equisolid_residuals,
        reference_rms_angle_deg,
        reference_max_angle_deg,
    })
}

pub fn ascii(product: &Product) -> String {
    let a = &product.equidistant;
    let b = &product.equisolid;
    format!("% MIRACLE_equidistant Glat[deg] Glon[deg] Xc[row,1-based] Yc[col,1-based] k[pixel/degree] rotAngle[radian]\n{} {} {} {} {} {}\n% MIRACLE_equisolid Glat Glon Xc Yc k[pixel] a[fixed] p[fixed] rotAngle[radian] RMS[pixel]\n{} {} {} {} {} 0.5 0 {} {}\n% Lower-accuracy compatibility approximations; the full native WISC model is authoritative.\n",a.glat_deg,a.glon_deg,a.xc_px,a.yc_px,a.scale_px/RAD,a.rotation_rad,b.glat_deg,b.glon_deg,b.xc_px,b.yc_px,b.scale_px,b.rotation_rad,product.equisolid_summary.rms_pixel.unwrap_or(f64::NAN))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_models_fit_without_coordinate_or_angle_sign_bias() {
        let mut job = crate::workflow::parse_job(include_str!(
            "../../../test_cases/BACC_NYA_20200218_010731/case.json"
        ))
        .unwrap();
        for projection in [Projection::Equidistant, Projection::Equisolid] {
            let truth = Fit {
                projection,
                glat_deg: 0.0,
                glon_deg: 0.0,
                xc_px: 301.5,
                yc_px: 310.25,
                scale_px: 220.0,
                rotation_rad: 0.34,
                center_offset_row_px: 0.0,
                center_offset_col_px: 0.0,
                sample_count: 0,
                fit_source: String::new(),
            };
            job.pairs = (0..30)
                .map(|i| {
                    let (az, ze) = (i as f64 * 0.21, 0.3 + (i % 5) as f64 * 0.15);
                    let [row, col] = truth.project(az, ze);
                    StarPair {
                        azimuth_rad: az,
                        zenith_rad: ze,
                        x_px: col - 1.0,
                        y_px: row - 1.0,
                    }
                })
                .collect();
            let actual = fit(&job, &job.pairs, projection, "test").unwrap();
            assert!((actual.xc_px - truth.xc_px).abs() < 1e-9);
            assert!((actual.yc_px - truth.yc_px).abs() < 1e-9);
            assert!((actual.scale_px - truth.scale_px).abs() < 1e-9);
            assert!((actual.rotation_rad - truth.rotation_rad).abs() < 1e-10);
            assert!(summary(&actual.residuals(&job.pairs)).rms_pixel.unwrap() < 1e-9);
        }
    }
    #[test]
    fn fallback_is_explicit_and_real_case_statistics_are_finite() {
        let mut job = crate::workflow::parse_job(include_str!(
            "../../../test_cases/BACC_NYA_20200218_010731/case.json"
        ))
        .unwrap();
        let product = product(&job).unwrap();
        assert_eq!(product.equidistant_summary.count, 50);
        assert!(product.reference_rms_angle_deg.is_finite());
        job.pairs.clear();
        let product = super::product(&job).unwrap();
        assert!(product.equidistant.fit_source.contains("fallback"));
        assert!(product.equidistant.sample_count > 10);
    }
}
