//! Camera rays and inverse lens mapping shared by native and WebAssembly.
use crate::{camera_rotation, Calibration, OpticalModel};
use nalgebra::{Matrix2, Matrix3, Vector2, Vector3};
use std::f64::consts::PI;

/// Repoint a camera so a grabbed sky ray follows a cursor drag. Camera-space
/// rotation keeps the radial law, focal lengths and measured pixels unchanged.
pub fn drag_camera(
    calibration: &crate::Calibration,
    from: [f64; 2],
    to: [f64; 2],
) -> Result<crate::Calibration, String> {
    let from = camera_ray(calibration, from).ok_or("drag begins outside the lens branch")?;
    let to = camera_ray(calibration, to).ok_or("drag ends outside the lens branch")?;
    let rotation =
        nalgebra::UnitQuaternion::rotation_between(&to, &from).ok_or("ambiguous antipodal drag")?;
    rotate_camera(calibration, rotation.to_rotation_matrix().matrix())
}

pub fn roll_camera(
    calibration: &crate::Calibration,
    radians: f64,
) -> Result<crate::Calibration, String> {
    if !radians.is_finite() {
        return Err("invalid roll angle".into());
    }
    let rotation = nalgebra::Rotation3::from_axis_angle(&Vector3::z_axis(), radians);
    rotate_camera(calibration, rotation.matrix())
}

fn rotate_camera(
    calibration: &crate::Calibration,
    delta: &Matrix3<f64>,
) -> Result<crate::Calibration, String> {
    calibration.validate()?;
    let old = crate::camera_rotation(
        calibration.optpar[2],
        calibration.optpar[3],
        calibration.optpar[4],
    );
    let rotation = Matrix3::from_row_slice(&old) * delta;
    let angles = crate::camera_angles(&std::array::from_fn(|i| rotation[(i / 3, i % 3)]));
    let mut next = calibration.clone();
    next.optpar[2..5].copy_from_slice(&angles);
    next.validate()?;
    Ok(next)
}

/// Invert a zero-based pixel centre into a unit direction in camera space.
/// Radial models use their monotonic principal branch. Pixels outside that
/// branch return `None`, rather than silently choosing another direction.
pub fn camera_ray(calibration: &Calibration, pixel: [f64; 2]) -> Option<Vector3<f64>> {
    calibration.validate().ok()?;
    if !pixel.iter().all(|value| value.is_finite()) {
        return None;
    }
    let p = &calibration.optpar;
    let x = ((pixel[0] + 1.0) / f64::from(calibration.width) - 0.5 - p[5]) / p[0];
    let y = ((pixel[1] + 1.0) / f64::from(calibration.height) - 0.5 - p[6]) / p[1];
    if calibration.model == OpticalModel::BrownConrady {
        let target = Vector2::new(x, y);
        let distort = |xy: Vector2<f64>| {
            let (x, y) = (xy[0], xy[1]);
            let r2 = x * x + y * y;
            let d = 1.0 + p[7] * r2 + p[8] * r2 * r2 + p[9] * r2 * r2 * r2;
            Vector2::new(
                x * d + 2.0 * p[10] * x * y + p[11] * (r2 + 2.0 * x * x),
                y * d + p[10] * (r2 + 2.0 * y * y) + 2.0 * p[11] * x * y,
            )
        };
        let mut guess = target;
        for _ in 0..40 {
            let residual = distort(guess) - target;
            if residual.norm() < 1e-11 {
                return Some(Vector3::new(guess[0], guess[1], 1.0).normalize());
            }
            let h = 1e-6;
            let dx = (distort(guess + Vector2::new(h, 0.0))
                - distort(guess - Vector2::new(h, 0.0)))
                / (2.0 * h);
            let dy = (distort(guess + Vector2::new(0.0, h))
                - distort(guess - Vector2::new(0.0, h)))
                / (2.0 * h);
            let step = Matrix2::from_columns(&[dx, dy]).try_inverse()? * residual;
            let mut scale = 1.0;
            while scale > 1.0 / 1024.0
                && (distort(guess - step * scale) - target).norm() >= residual.norm()
            {
                scale *= 0.5;
            }
            guess -= step * scale;
            if !guess.iter().all(|value| value.is_finite()) {
                return None;
            }
        }
        return None;
    }
    let radius = x.hypot(y);
    if radius <= 1e-12 {
        return Some(Vector3::z());
    }
    let alpha = p[7];
    let asin = |value: f64| (value.abs() <= 1.0).then(|| value.asin());
    let theta = match calibration.model {
        OpticalModel::Pinhole => radius.atan(),
        OpticalModel::Sine => {
            if alpha <= 0.0 {
                return None;
            }
            asin(radius)? / alpha
        }
        OpticalModel::Mixed => {
            if !(0.0..=1.0).contains(&alpha) {
                return None;
            }
            let (mut low, mut high) = (0.0, PI / 2.0 - 1e-10);
            for _ in 0..70 {
                let mid = (low + high) * 0.5;
                if (1.0 - alpha) * mid.tan() + alpha * mid < radius {
                    low = mid;
                } else {
                    high = mid;
                }
            }
            (low + high) * 0.5
        }
        OpticalModel::Power => {
            if alpha <= 0.0 {
                return None;
            }
            radius.powf(1.0 / alpha)
        }
        OpticalModel::Tangent => {
            if alpha <= 0.0 {
                return None;
            }
            radius.atan() / alpha
        }
        OpticalModel::Equisolid => 2.0 * asin(radius)?,
        OpticalModel::Unified => {
            if alpha > 0.0 {
                (alpha * radius).atan() / alpha
            } else if alpha < 0.0 {
                asin(alpha * radius)? / alpha
            } else {
                radius
            }
        }
        OpticalModel::BrownConrady => unreachable!(),
    };
    if !theta.is_finite() || !(0.0..=PI).contains(&theta) {
        return None;
    }
    Some(Vector3::new(
        x / radius * theta.sin(),
        y / radius * theta.sin(),
        theta.cos(),
    ))
}

pub fn pixel_to_azimuth_zenith(calibration: &Calibration, pixel: [f64; 2]) -> Option<[f64; 2]> {
    let camera = camera_ray(calibration, pixel)?;
    let p = &calibration.optpar;
    let rotation = Matrix3::from_row_slice(&camera_rotation(p[2], p[3], p[4]));
    let sky = rotation * camera;
    Some([
        sky[0].atan2(sky[1]).rem_euclid(2.0 * PI),
        sky[2].clamp(-1.0, 1.0).acos(),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn camera_drag_moves_grabbed_world_ray_to_the_cursor_for_radial_and_brown_lenses() {
        for model in [OpticalModel::Sine, OpticalModel::BrownConrady] {
            let calibration = Calibration {
                width: 1024,
                height: 768,
                model,
                optpar: crate::default_optpar(1024, 768, model),
            };
            let from = [330.0, 280.0];
            let to = [420.0, 325.0];
            let sky = pixel_to_azimuth_zenith(&calibration, from).unwrap();
            let changed = drag_camera(&calibration, from, to).unwrap();
            let pixel = changed.project(sky[0], sky[1]).unwrap();
            assert!(
                (pixel[0] - to[0]).hypot(pixel[1] - to[1]) < 1e-8,
                "{pixel:?}"
            );
            for i in [0, 1, 5, 6, 7] {
                assert_eq!(calibration.optpar[i], changed.optpar[i]);
            }
        }
    }
    #[test]
    fn inverse_roundtrips_all_lens_models_with_rotation_and_mirrored_axis() {
        for model in [1, 2, 3, 4, 5, 6, 12, 20] {
            let model = OpticalModel::try_from(model).unwrap();
            let mut parameters = crate::default_optpar(1024, 768, model);
            parameters[..7].copy_from_slice(&[0.8, -1.1, 11.0, -7.0, 38.0, 0.02, -0.01]);
            if model == OpticalModel::BrownConrady {
                parameters[7..].copy_from_slice(&[0.1, -0.02, 0.001, 0.002, -0.003]);
            }
            let calibration = Calibration {
                width: 1024,
                height: 768,
                model,
                optpar: parameters,
            };
            for azimuth in [0.2, 1.4, 3.1, 5.8] {
                for zenith in [0.2, 0.4, 0.6] {
                    let pixel = calibration.project(azimuth, zenith).unwrap();
                    let sky = pixel_to_azimuth_zenith(&calibration, pixel).unwrap();
                    let delta = (sky[0] - azimuth)
                        .sin()
                        .atan2((sky[0] - azimuth).cos())
                        .abs();
                    assert!(
                        delta < 1e-8 && (sky[1] - zenith).abs() < 1e-8,
                        "{model:?}: {sky:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn inverse_rejects_nonfinite_and_out_of_branch_pixels() {
        let calibration = Calibration {
            width: 100,
            height: 100,
            model: OpticalModel::Equisolid,
            optpar: crate::default_optpar(100, 100, OpticalModel::Equisolid),
        };
        assert!(camera_ray(&calibration, [f64::NAN, 0.0]).is_none());
        assert!(camera_ray(&calibration, [10000.0, 10000.0]).is_none());
    }
}
