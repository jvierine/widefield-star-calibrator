//! Damped least-squares lens fitting using nalgebra for the small dense solve.
use crate::{
    clamp_parameters, median, objective, residual_radii, Calibration, FitResult, OpticalModel,
    StarPair,
};
use nalgebra::{DMatrix, DVector};

/// Levenberg–Marquardt with scaled finite-difference Jacobians, Huber IRLS
/// weights and rejected-step damping. Shares bounds with Nelder–Mead.
pub fn fit_lm(
    start: &Calibration,
    pairs: &[StarPair],
    max_iterations: usize,
) -> Result<FitResult, String> {
    start.validate()?;
    if max_iterations == 0 {
        return Err("max_iterations must be positive".into());
    }
    let count = start.model.parameter_count();
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
        let scales: Vec<_> = (0..count)
            .map(|i| match i {
                0 | 1 => current.optpar[i].abs().max(0.1),
                2..=4 => 10.0,
                _ => 0.1,
            })
            .collect();
        for parameter in 0..count {
            if (current.model == OpticalModel::Equisolid || current.model == OpticalModel::Pinhole)
                && parameter == 7
            {
                continue;
            }
            let h = scales[parameter] * 1e-5;
            let mut plus = current.clone();
            let mut minus = current.clone();
            plus.optpar[parameter] += h;
            minus.optpar[parameter] -= h;
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
                candidate.optpar[i] -= step[i] * scales[i];
            }
            clamp_parameters(&mut candidate.optpar, candidate.model);
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
