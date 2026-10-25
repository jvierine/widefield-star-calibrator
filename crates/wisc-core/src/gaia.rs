//! GAIA crop/polygon exclusions. These mask star searches, never source pixels.
use serde_json::Value;

pub fn validate(settings: &Value) -> Result<(), String> {
    if !settings.is_object() {
        return Err("GAIA settings must be an object".into());
    }
    for (a, b) in [("left", "right"), ("top", "bottom")] {
        let edge = |key: &str, default: f64| -> Result<f64, String> {
            match settings.get("crop").and_then(|v| v.get(key)) {
                None => Ok(default),
                Some(v) => v
                    .as_f64()
                    .filter(|v| v.is_finite() && (0.0..=1.0).contains(v))
                    .ok_or_else(|| format!("invalid GAIA crop {key}")),
            }
        };
        if edge(a, 0.0)? >= edge(b, 1.0)? {
            return Err("empty GAIA crop".into());
        }
    }
    if settings
        .pointer("/mask/coordinate_system")
        .and_then(Value::as_str)
        == Some("normalized_image")
    {
        if let Some(polygons) = settings.pointer("/mask/polygons") {
            let polygons = polygons
                .as_array()
                .filter(|p| p.len() <= 1000)
                .ok_or("invalid GAIA polygons")?;
            for polygon in polygons {
                let points = polygon
                    .as_array()
                    .filter(|p| p.len() <= 10000)
                    .ok_or("invalid GAIA polygon")?;
                for point in points {
                    if !point.as_array().is_some_and(|p| {
                        p.len() == 2
                            && p.iter().all(|v| {
                                v.as_f64()
                                    .is_some_and(|n| n.is_finite() && (0.0..=1.0).contains(&n))
                            })
                    }) {
                        return Err("invalid GAIA polygon coordinate".into());
                    }
                }
            }
        }
    }
    Ok(())
}

pub fn excluded(settings: &Value, dimensions: [u32; 2], point: [f64; 2], pad: f64) -> bool {
    let [w, h] = dimensions.map(f64::from);
    let [x, y] = point;
    let edge = |key: &str, default| {
        settings
            .get("crop")
            .and_then(|v| v.get(key))
            .and_then(Value::as_f64)
            .unwrap_or(default)
    };
    if x - pad < edge("left", 0.0) * w
        || x + pad >= edge("right", 1.0) * w
        || y - pad < edge("top", 0.0) * h
        || y + pad >= edge("bottom", 1.0) * h
    {
        return true;
    }
    if settings.get("mask_enabled").and_then(Value::as_bool) == Some(false)
        || settings
            .pointer("/mask/coordinate_system")
            .and_then(Value::as_str)
            != Some("normalized_image")
    {
        return false;
    }
    if let Some(polygons) = settings.pointer("/mask/polygons").and_then(Value::as_array) {
        for polygon in polygons {
            let Some(points) = polygon.as_array().filter(|p| p.len() >= 3) else {
                continue;
            };
            let mut inside = false;
            for i in 0..points.len() {
                let coord = |j: usize| -> Option<[f64; 2]> {
                    Some([
                        points[j].get(0)?.as_f64()? * w,
                        points[j].get(1)?.as_f64()? * h,
                    ])
                };
                let (Some([ax, ay]), Some([bx, by])) =
                    (coord((i + points.len() - 1) % points.len()), coord(i))
                else {
                    continue;
                };
                if (ay > y) != (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax {
                    inside = !inside;
                }
                let (dx, dy) = (bx - ax, by - ay);
                let denominator = dx * dx + dy * dy;
                let t = if denominator > 0.0 {
                    ((x - ax) * dx + (y - ay) * dy) / denominator
                } else {
                    0.0
                }
                .clamp(0.0, 1.0);
                if (x - ax - t * dx).hypot(y - ay - t * dy) <= pad {
                    return true;
                }
            }
            if inside {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn crop_polygons_and_disabled_masks_keep_scientific_pixel_coordinates() {
        let mut settings = serde_json::json!({"crop":{"left":0.1,"right":0.9},"mask":{"coordinate_system":"normalized_image","polygons":[[[0.2,0.2],[0.4,0.2],[0.4,0.4],[0.2,0.4]]]}});
        validate(&settings).unwrap();
        assert!(excluded(&settings, [1000, 500], [99.0, 250.0], 0.0));
        assert!(excluded(&settings, [1000, 500], [300.0, 150.0], 0.0));
        assert!(!excluded(&settings, [1000, 500], [500.0, 250.0], 0.0));
        settings["mask_enabled"] = Value::Bool(false);
        assert!(!excluded(&settings, [1000, 500], [300.0, 150.0], 0.0));
        settings["crop"]["left"] = serde_json::json!(1.0);
        assert!(validate(&settings).is_err());
    }
}
