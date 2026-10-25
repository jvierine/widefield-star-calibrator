//! Triangle-based attitude recovery from approximate lens intrinsics.
//! All hypotheses are verified with independent projected stars before fitting.

use crate::{
    camera_angles,
    geometry::camera_ray,
    workflow::{associate, automatic_fit_preserving, SkyStar},
    Calibration, Detection, FitResult, StarPair, DEG,
};
use nalgebra::{Matrix3, Vector3};
use std::collections::BTreeMap;

#[derive(Clone)]
struct Triangle {
    indices: [usize; 3],
    sides: [f64; 3],
}

fn triangles(rays: &[Vector3<f64>]) -> Vec<Triangle> {
    let mut result = BTreeMap::new();
    for (index, ray) in rays.iter().enumerate() {
        let mut neighbours: Vec<_> = rays
            .iter()
            .enumerate()
            .filter(|(other, _)| *other != index)
            .map(|(other, vector)| (other, ray.dot(vector).clamp(-1.0, 1.0).acos()))
            .filter(|(_, angle)| *angle > 1.5 * DEG && *angle < 40.0 * DEG)
            .collect();
        neighbours.sort_by(|a, b| a.1.total_cmp(&b.1));
        neighbours.truncate(10);
        for a in 0..neighbours.len() {
            for b in a + 1..neighbours.len() {
                let mut indices = [index, neighbours[a].0, neighbours[b].0];
                indices.sort_unstable();
                let [i, j, k] = indices;
                let mut opposite = [
                    (rays[j].dot(&rays[k]).clamp(-1.0, 1.0).acos(), i),
                    (rays[i].dot(&rays[k]).clamp(-1.0, 1.0).acos(), j),
                    (rays[i].dot(&rays[j]).clamp(-1.0, 1.0).acos(), k),
                ];
                opposite.sort_by(|a, b| a.0.total_cmp(&b.0));
                if opposite[0].0 < 1.5 * DEG
                    || opposite[2].0 > 40.0 * DEG
                    || (rays[j] - rays[i]).cross(&(rays[k] - rays[i])).norm() < 1e-4
                {
                    continue;
                }
                result.entry(indices).or_insert(Triangle {
                    indices: opposite.map(|(_, index)| index),
                    sides: opposite.map(|(side, _)| side),
                });
            }
        }
    }
    result.into_values().collect()
}

fn direction(star: &SkyStar) -> Vector3<f64> {
    Vector3::new(
        star.zenith_rad.sin() * star.azimuth_rad.sin(),
        star.zenith_rad.sin() * star.azimuth_rad.cos(),
        star.zenith_rad.cos(),
    )
}

/// Recover camera pointing without an aligned attitude. Focal lengths and lens
/// distortion must be approximately known; this does not promise a blind solve
/// over arbitrary unknown optics. Existing measured pairs remain fixed.
pub fn triangle_fit(
    start: &Calibration,
    detections: &[Detection],
    sky: &[SkyStar],
    manual: &[StarPair],
    radius_px: f64,
    max_iterations: usize,
) -> Result<(FitResult, Vec<StarPair>), String> {
    start.validate()?;
    if !radius_px.is_finite() || radius_px <= 0.0 {
        return Err("invalid matching radius".into());
    }
    let mut ranked: Vec<_> = detections
        .iter()
        .copied()
        .filter(|detection| {
            [detection.x, detection.y, detection.flux]
                .iter()
                .all(|value| value.is_finite())
        })
        .collect();
    ranked.sort_by(|a, b| b.flux.total_cmp(&a.flux));
    ranked.truncate(45);
    let camera_rays: Vec<_> = ranked
        .iter()
        .filter_map(|detection| camera_ray(start, [detection.x, detection.y]))
        .collect();
    let mut sky: Vec<_> = sky.to_vec();
    sky.sort_by(|a, b| a.magnitude.total_cmp(&b.magnitude));
    sky.truncate(350);
    let sky_rays: Vec<_> = sky.iter().map(direction).collect();
    if camera_rays.len() < 6 || sky_rays.len() < 6 {
        return Err("not enough detected/catalogue stars for triangle matching".into());
    }
    let bin = 0.006;
    let key = |sides: [f64; 3]| sides.map(|side| (side / bin).floor() as i32);
    let mut sky_index: BTreeMap<[i32; 3], Vec<Triangle>> = BTreeMap::new();
    for triangle in triangles(&sky_rays) {
        sky_index
            .entry(key(triangle.sides))
            .or_default()
            .push(triangle);
    }
    let mut candidates = Vec::new();
    for camera in triangles(&camera_rays) {
        let [a, b, c] = key(camera.sides);
        for da in -1..=1 {
            for db in -1..=1 {
                for dc in -1..=1 {
                    if let Some(matches) = sky_index.get(&[a + da, b + db, c + dc]) {
                        for matched in matches {
                            let error = camera
                                .sides
                                .iter()
                                .zip(matched.sides)
                                .map(|(a, b)| (a - b).powi(2))
                                .sum::<f64>();
                            if error < 3.0 * bin * bin {
                                candidates.push((error, camera.clone(), matched.clone()));
                            }
                        }
                    }
                }
            }
        }
    }
    candidates.sort_by(|a, b| a.0.total_cmp(&b.0));
    candidates.truncate(512);
    let minimum = (start.model.parameter_count() + 2).max(10);
    let mut best: Option<(Calibration, usize, f64)> = None;
    for (_, camera, sky_triangle) in candidates {
        let covariance = camera.indices.iter().zip(sky_triangle.indices).fold(
            Matrix3::zeros(),
            |sum, (camera_index, sky_index)| {
                sum + sky_rays[sky_index] * camera_rays[*camera_index].transpose()
            },
        );
        let decomposition = covariance.svd(true, true);
        let (Some(u), Some(vt)) = (decomposition.u, decomposition.v_t) else {
            continue;
        };
        let correction =
            Matrix3::from_diagonal(&Vector3::new(1.0, 1.0, (u * vt).determinant().signum()));
        let rotation = u * correction * vt;
        let angles = camera_angles(&std::array::from_fn(|index| {
            rotation[(index / 3, index % 3)]
        }));
        let mut candidate = start.clone();
        candidate.optpar[2..5].copy_from_slice(&angles);
        let pairs = associate(&candidate, detections, &sky, radius_px.min(3.0))?;
        if pairs.len() < minimum {
            continue;
        }
        let error = pairs
            .iter()
            .map(|pair| {
                let projected = candidate
                    .project(pair.azimuth_rad, pair.zenith_rad)
                    .unwrap();
                (projected[0] - pair.x_px).powi(2) + (projected[1] - pair.y_px).powi(2)
            })
            .sum::<f64>()
            / pairs.len() as f64;
        if best.as_ref().is_none_or(|(_, count, score)| {
            pairs.len() > *count || pairs.len() == *count && error < *score
        }) {
            best = Some((candidate, pairs.len(), error));
        }
    }
    let (calibration, _, _) = best
        .ok_or("no independently supported triangle match; check time, site and lens intrinsics")?;
    automatic_fit_preserving(
        &calibration,
        detections,
        &sky,
        manual,
        radius_px,
        max_iterations,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        workflow::{tycho_catalog, visible_catalog, Observation},
        OpticalModel,
    };
    #[test]
    fn recovers_unknown_pointing_with_false_detections() {
        let observation = Observation {
            unix_millis: 1_581_988_051_000,
            latitude_deg: 69.0,
            longitude_deg: 18.0,
        };
        let sky = visible_catalog(&tycho_catalog().unwrap(), &observation, 4.5).unwrap();
        let truth = Calibration {
            width: 1024,
            height: 1024,
            model: OpticalModel::Sine,
            optpar: vec![0.9, 0.9, 22.0, -13.0, 73.0, 0.01, -0.02, 0.35],
        };
        let mut detections: Vec<_> = sky
            .iter()
            .filter_map(|star| {
                let pixel = truth.project(star.azimuth_rad, star.zenith_rad)?;
                (pixel.iter().all(|value| *value > 5.0 && *value < 1019.0)).then_some(Detection {
                    x: pixel[0],
                    y: pixel[1],
                    flux: 100.0 - star.magnitude * 10.0,
                })
            })
            .collect();
        detections.extend([
            Detection {
                x: 17.0,
                y: 71.0,
                flux: 200.0,
            },
            Detection {
                x: 380.0,
                y: 901.0,
                flux: 150.0,
            },
        ]);
        let mut initial = truth.clone();
        initial.optpar[2..5].copy_from_slice(&[0.0, 0.0, -40.0]);
        let (fit, pairs) = triangle_fit(&initial, &detections, &sky, &[], 4.0, 1000).unwrap();
        assert!(pairs.len() > 30);
        assert!(fit.rms_px < 1e-5, "{}", fit.rms_px);
        for pair in pairs {
            let predicted = truth.project(pair.azimuth_rad, pair.zenith_rad).unwrap();
            assert!((predicted[0] - pair.x_px).hypot(predicted[1] - pair.y_px) < 1e-6);
        }
    }
}
