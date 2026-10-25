//! Damped least-squares lens fitting using nalgebra for the small dense solve.
use crate::{median, objective, residual_radii, Calibration, FitResult, OpticalModel, StarPair};
use nalgebra::{DMatrix, DVector};

/// Levenberg–Marquardt with scaled finite-difference Jacobians, Huber IRLS
/// weights and rejected-step damping. Shares bounds with Nelder–Mead.
pub fn fit_lm(
    start: &Calibration,
    pairs: &[StarPair],
    max_iterations: usize,
) -> Result<FitResult, String> {
    fit_lm_with_active(
        start,
        pairs,
        max_iterations,
        &(0..start.model.parameter_count()).collect::<Vec<_>>(),
    )
}

pub fn fit_lm_with_active(
    start: &Calibration,
    pairs: &[StarPair],
    max_iterations: usize,
    active: &[usize],
) -> Result<FitResult, String> {
    start.validate()?;
    crate::validate_active(start, active)?;
    if max_iterations == 0 {
        return Err("max_iterations must be positive".into());
    }
    let count = active.len();
    if pairs.len() < count.div_ceil(2) {
        return Err("not enough star pairs for this lens model".into());
    }
    if !pairs.iter().all(|p| {
        [p.azimuth_rad, p.zenith_rad, p.x_px, p.y_px]
            .iter()
            .all(|v| v.is_finite())
    }) {
        return Err("star pairs contain non-finite values".into());
    }
    let residual = |calibration: &Calibration| -> Result<DVector<f64>, String> {
        let mut values = Vec::with_capacity(2 * pairs.len());
        for pair in pairs {
            let pixel = calibration
                .project(pair.azimuth_rad, pair.zenith_rad)
                .ok_or("projection failed during LM fit")?;
            values.extend([pixel[0] - pair.x_px, pixel[1] - pair.y_px]);
        }
        Ok(DVector::from_vec(values))
    };
    let mut current = start.clone();
    let signs = [start.optpar[0].signum(), start.optpar[1].signum()];
    let mut damping = 1e-3;
    let mut iterations = 0;
    for iteration in 0..max_iterations {
        iterations = iteration + 1;
        let base = residual(&current)?;
        let mut radii = residual_radii(&current, pairs).ok_or("projection failed")?;
        let cutoff = 1.345 * (1.4826 * median(&mut radii)).max(4.0);
        let weights = DVector::from_iterator(
            base.len(),
            (0..base.len()).map(|i| {
                let r = base[(i / 2) * 2].hypot(base[(i / 2) * 2 + 1]);
                (cutoff / r.max(cutoff)).sqrt()
            }),
        );
        let mut jacobian = DMatrix::zeros(base.len(), count);
        let scales: Vec<_> = active
            .iter()
            .map(|&i| match i {
                0 | 1 => current.optpar[i].abs().max(0.1),
                2..=4 => 10.0,
                _ => 0.1,
            })
            .collect();
        for parameter in 0..count {
            let index = active[parameter];
            if (current.model == OpticalModel::Equisolid || current.model == OpticalModel::Pinhole)
                && index == 7
            {
                continue;
            }
            let h = scales[parameter] * 1e-5;
            let mut plus = current.clone();
            let mut minus = current.clone();
            plus.optpar[index] += h;
            minus.optpar[index] -= h;
            let derivative = match (residual(&plus), residual(&minus)) {
                (Ok(p), Ok(m)) => (p - m) / (2.0 * h),
                (Ok(p), Err(_)) => (p - &base) / h,
                (Err(_), Ok(m)) => (&base - m) / h,
                _ => return Err("cannot evaluate LM Jacobian".into()),
            };
            for row in 0..base.len() {
                jacobian[(row, parameter)] = derivative[row] * scales[parameter] * weights[row];
            }
        }
        let weighted = base.component_mul(&weights);
        let normal = jacobian.transpose() * &jacobian;
        let gradient = jacobian.transpose() * weighted;
        if gradient.amax() < 1e-10 {
            break;
        }
        let score = objective(&current, pairs);
        let mut accepted = false;
        let mut converged = false;
        for _ in 0..20 {
            let mut damped = normal.clone();
            for i in 0..count {
                damped[(i, i)] += damping * normal[(i, i)].max(1e-12);
            }
            let Some(step) = damped.cholesky().map(|factor| factor.solve(&gradient)) else {
                damping *= 10.0;
                continue;
            };
            if !step.iter().all(|v| v.is_finite()) {
                damping *= 10.0;
                continue;
            }
            let mut candidate = current.clone();
            for i in 0..count {
                candidate.optpar[active[i]] -= step[i] * scales[i];
            }
            crate::clamp_active(&mut candidate.optpar, start, active);
            if candidate.optpar[0].signum() != signs[0] || candidate.optpar[1].signum() != signs[1]
            {
                damping *= 10.0;
                continue;
            }
            let next_score = objective(&candidate, pairs);
            if next_score < score {
                converged = step.norm() < 1e-9 || score - next_score < 1e-12 * (1.0 + score);
                current = candidate;
                damping = (damping / 3.0).max(1e-12);
                accepted = true;
                break;
            }
            damping *= 10.0;
        }
        if !accepted || converged {
            break;
        }
    }
    let radii = residual_radii(&current, pairs).ok_or("projection failed")?;
    Ok(FitResult {
        calibration: current,
        rms_px: (radii.iter().map(|v| v * v).sum::<f64>() / pairs.len() as f64).sqrt(),
        iterations,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn both_solvers_preserve_fixed_spacecraft_distortion_coefficients() {
        let truth = Calibration {
            width: 640,
            height: 480,
            model: OpticalModel::BrownConrady,
            optpar: vec![
                -0.8, 1.1, -15.0, -40.0, 8.0, 0.01, -0.02, 0.01, -0.02, 0.003, 0.001, -0.001,
            ],
        };
        let rotation = nalgebra::Matrix3::from_row_slice(&crate::camera_rotation(
            truth.optpar[2],
            truth.optpar[3],
            truth.optpar[4],
        ));
        let mut pairs = Vec::new();
        for i in -2..=2 {
            for j in -2..=2 {
                let v = rotation
                    * nalgebra::Vector3::new(i as f64 * 0.1, j as f64 * 0.1, 1.0).normalize();
                let az = v.x.atan2(v.y);
                let ze = v.z.acos();
                let p = truth.project(az, ze).unwrap();
                pairs.push(StarPair {
                    azimuth_rad: az,
                    zenith_rad: ze,
                    x_px: p[0],
                    y_px: p[1],
                });
            }
        }
        let mut start = truth.clone();
        start.optpar[0] *= 1.05;
        start.optpar[1] *= 1.05;
        start.optpar[2] += 1.0;
        start.optpar[5] += 0.01;
        let active = crate::active_parameters(&start, &[8, 9, 10, 11]).unwrap();
        for solver in [crate::fit_with_active, fit_lm_with_active] {
            let result = solver(&start, &pairs, 2000, &active).unwrap();
            assert!(result.rms_px < 0.1, "{}", result.rms_px);
            assert_eq!(&result.calibration.optpar[8..], &start.optpar[8..]);
        }
        assert!(crate::active_parameters(&start, &[12]).is_err());
        assert!(crate::active_parameters(&start, &[8, 8]).is_err());
        assert!(crate::active_parameters(&start, &(0..12).collect::<Vec<_>>()).is_err());
    }
    #[test]
    fn lm_recovers_every_lens_and_preserves_negative_focal_sign() {
        for model in [
            OpticalModel::Pinhole,
            OpticalModel::Sine,
            OpticalModel::Mixed,
            OpticalModel::Power,
            OpticalModel::Tangent,
            OpticalModel::Equisolid,
            OpticalModel::Unified,
            OpticalModel::BrownConrady,
        ] {
            let mut target = Calibration {
                width: 1024,
                height: 768,
                model,
                optpar: crate::default_optpar(1024, 768, model),
            };
            target.optpar[0] = -target.optpar[0];
            let pairs: Vec<_> = (0..48)
                .filter_map(|i| {
                    let az = (i % 12) as f64 * 30.0 * crate::DEG;
                    let ze = (15.0 + (i / 12) as f64 * 12.0) * crate::DEG;
                    target.project(az, ze).map(|p| StarPair {
                        azimuth_rad: az,
                        zenith_rad: ze,
                        x_px: p[0],
                        y_px: p[1],
                    })
                })
                .collect();
            let mut seed = target.clone();
            seed.optpar[0] *= 1.02;
            seed.optpar[1] *= 0.98;
            seed.optpar[2] += 0.5;
            seed.optpar[3] -= 0.4;
            seed.optpar[4] += 0.6;
            let result = fit_lm(&seed, &pairs, 200).unwrap();
            assert!(
                result.rms_px < 1e-4,
                "model {} RMS {}",
                u8::from(model),
                result.rms_px
            );
            assert!(result.calibration.optpar[0] < 0.0);
        }
    }
    #[test]
    fn lm_improves_real_saved_case_and_validates_inputs() {
        let job = crate::workflow::parse_job(include_str!(
            "../../../test_cases/BACC_NYA_20200218_010731/case.json"
        ))
        .unwrap();
        let result = fit_lm(&job.initial, &job.pairs, 200).unwrap();
        assert!(result.rms_px < 1.4, "{}", result.rms_px);
        assert!(fit_lm(&job.initial, &[], 200).is_err());
        assert!(fit_lm(&job.initial, &job.pairs, 0).is_err());
    }
}
