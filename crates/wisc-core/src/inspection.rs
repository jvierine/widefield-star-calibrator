//! Scientific image inspection shared by native and WebAssembly clients.
//! Display transforms never change the pixels used for centroiding or fitting.

#[derive(Clone, Copy, Debug)]
pub struct Viewport {
    pub zoom: f64,
    /// Centre in normalized image-boundary coordinates, not pixel centres.
    pub center: [f64; 2],
}

impl Default for Viewport {
    fn default() -> Self {
        Self {
            zoom: 1.0,
            center: [0.5; 2],
        }
    }
}

impl Viewport {
    pub fn image_coordinate(&self, screen: [f64; 2], dimensions: [u32; 2]) -> [f64; 2] {
        std::array::from_fn(|i| {
            (self.center[i] + (screen[i] - 0.5) / self.zoom) * f64::from(dimensions[i]) - 0.5
        })
    }

    pub fn zoom_at(&mut self, screen: [f64; 2], factor: f64) {
        if !factor.is_finite() || factor <= 0.0 {
            return;
        }
        let old = self.zoom;
        self.zoom = (old * factor).clamp(1.0, 16.0);
        for (i, anchor) in screen.iter().enumerate() {
            self.center[i] += (anchor - 0.5) * (1.0 / old - 1.0 / self.zoom);
        }
        self.clamp();
    }

    pub fn pan(&mut self, delta: [f64; 2]) {
        for (i, movement) in delta.iter().enumerate() {
            if movement.is_finite() {
                self.center[i] -= movement / self.zoom;
            }
        }
        self.clamp();
    }

    fn clamp(&mut self) {
        let margin = 0.5 / self.zoom;
        for value in &mut self.center {
            *value = value.clamp(margin, 1.0 - margin);
        }
    }
}

/// Four separable box passes, matching the legacy Gaussian approximation.
pub fn gaussian_blur(
    source: &[f32],
    width: usize,
    height: usize,
    sigma: f64,
) -> Result<Vec<f32>, String> {
    if width == 0 || height == 0 || width.checked_mul(height) != Some(source.len()) {
        return Err("invalid image dimensions".into());
    }
    if !sigma.is_finite() || !(0.0..=4096.0).contains(&sigma) {
        return Err("invalid Gaussian width".into());
    }
    let mut result = source.to_vec();
    let ideal = (3.0 * sigma * sigma + 1.0).sqrt();
    let mut lower = ideal.floor() as usize;
    if lower.is_multiple_of(2) {
        lower = lower.saturating_sub(1);
    }
    lower = lower.max(1);
    let l = lower as f64;
    let m = ((12.0 * sigma * sigma - 4.0 * l * l - 16.0 * l - 12.0) / (-4.0 * l - 4.0)).round();
    for pass in 0..4 {
        let size = if (pass as f64) < m { lower } else { lower + 2 };
        let radius = size / 2;
        if radius == 0 {
            continue;
        }
        let mut horizontal = vec![0.0; result.len()];
        for y in 0..height {
            let row = y * width;
            let mut sum = f64::from(result[row]) * (radius + 1) as f64;
            for i in 1..=radius {
                sum += f64::from(result[row + i.min(width - 1)]);
            }
            for x in 0..width {
                horizontal[row + x] = (sum / size as f64) as f32;
                sum += f64::from(result[row + (x + radius + 1).min(width - 1)])
                    - f64::from(result[row + x.saturating_sub(radius)]);
            }
        }
        for x in 0..width {
            let mut sum = f64::from(horizontal[x]) * (radius + 1) as f64;
            for i in 1..=radius {
                sum += f64::from(horizontal[i.min(height - 1) * width + x]);
            }
            for y in 0..height {
                result[y * width + x] = (sum / size as f64) as f32;
                sum += f64::from(horizontal[(y + radius + 1).min(height - 1) * width + x])
                    - f64::from(horizontal[y.saturating_sub(radius) * width + x]);
            }
        }
    }
    Ok(result)
}

/// Bilinear sampling with edge replication, with missing FITS pixels treated
/// as background rather than propagating NaNs through a complete KDE patch.
fn sample(pixels: &[f32], width: usize, height: usize, point: [f64; 2]) -> f32 {
    let x = point[0].clamp(0.0, (width - 1) as f64);
    let y = point[1].clamp(0.0, (height - 1) as f64);
    let (ix, iy) = (x.floor() as usize, y.floor() as usize);
    let (dx, dy) = ((x - ix as f64) as f32, (y - iy as f64) as f32);
    let at = |a: usize, b: usize| {
        let value = pixels[b * width + a];
        if value.is_finite() {
            value
        } else {
            0.0
        }
    };
    (at(ix, iy) * (1.0 - dx) + at((ix + 1).min(width - 1), iy) * dx) * (1.0 - dy)
        + (at(ix, (iy + 1).min(height - 1)) * (1.0 - dx)
            + at((ix + 1).min(width - 1), (iy + 1).min(height - 1)) * dx)
            * dy
}

pub struct Centroid {
    pub position: [f64; 2],
    pub density: Vec<f32>,
    pub size: usize,
    pub origin: [f64; 2],
    pub background: f32,
}

/// Port of the legacy 40× upsampled KDE picker (17px patch, sigma 53.2 fine
/// pixels, boundary-median subtraction and quadratic peak interpolation).
pub fn kde_centroid(
    pixels: &[f32],
    width: usize,
    height: usize,
    click: [f64; 2],
) -> Result<Centroid, String> {
    if width == 0
        || height == 0
        || width.checked_mul(height) != Some(pixels.len())
        || !click.iter().all(|v| v.is_finite())
        || click[0] < -0.5
        || click[1] < -0.5
        || click[0] >= width as f64 - 0.5
        || click[1] >= height as f64 - 0.5
    {
        return Err("pick a position inside the image".into());
    }
    let size = 17 * 40;
    let origin = [click[0] - 8.0, click[1] - 8.0];
    let mut raw = Vec::with_capacity(size * size);
    let mut border = Vec::new();
    for y in 0..size {
        for x in 0..size {
            let value = sample(
                pixels,
                width,
                height,
                [origin[0] + x as f64 / 40.0, origin[1] + y as f64 / 40.0],
            );
            raw.push(value);
            if x < 40 || x >= size - 40 || y < 40 || y >= size - 40 {
                border.push(value);
            }
        }
    }
    border.sort_unstable_by(f32::total_cmp);
    let background = (border[border.len() / 2] + border[(border.len() - 1) / 2]) / 2.0;
    for value in &mut raw {
        *value = (*value - background).max(0.0);
    }
    let density = gaussian_blur(&raw, size, size, 53.2)?;
    let (index, maximum) = density
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.total_cmp(b.1).then_with(|| b.0.cmp(&a.0)))
        .unwrap();
    if *maximum <= 0.0 {
        return Err("no star signal above the patch background".into());
    }
    let (x, y) = (index % size, index / size);
    let mut position = [origin[0] + x as f64 / 40.0, origin[1] + y as f64 / 40.0];
    if x > 0 && y > 0 && x < size - 1 && y < size - 1 {
        for (axis, step) in [1, size].iter().enumerate() {
            let (l, c, r) = (
                density[index - step] as f64,
                density[index] as f64,
                density[index + step] as f64,
            );
            let denominator = l - 2.0 * c + r;
            if denominator.abs() > 1e-9 {
                position[axis] += (0.5 * (l - r) / denominator).clamp(-0.5, 0.5) / 40.0;
            }
        }
    }
    if position[0] < -0.5
        || position[1] < -0.5
        || position[0] >= width as f64 - 0.5
        || position[1] >= height as f64 - 0.5
    {
        return Err("KDE peak is outside the image".into());
    }
    Ok(Centroid {
        position,
        density,
        size,
        origin,
        background,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn zoom_keeps_cursor_anchor_and_pan_uses_zoom_scale() {
        let mut view = Viewport::default();
        let anchor = [0.7, 0.3];
        let before = view.image_coordinate(anchor, [1024, 768]);
        view.zoom_at(anchor, 4.0);
        let after = view.image_coordinate(anchor, [1024, 768]);
        for i in 0..2 {
            assert!((before[i] - after[i]).abs() < 1e-10);
        }
        let center = view.center;
        view.pan([0.1, -0.1]);
        assert!((view.center[0] - center[0] + 0.025).abs() < 1e-10);
        view.zoom_at([0.5; 2], 0.001);
        assert_eq!(view.zoom, 1.0);
        assert_eq!(view.center, [0.5; 2]);
    }
    #[test]
    fn default_view_maps_raw_pixel_centers_without_half_pixel_bias() {
        let point = Viewport::default().image_coordinate([0.005, 0.01], [100, 50]);
        assert!(point.iter().all(|value| value.abs() < 1e-12));
    }
    #[test]
    fn blur_preserves_constant_images_even_when_kernel_exceeds_image() {
        assert_eq!(gaussian_blur(&[7.0; 6], 2, 3, 53.2).unwrap(), [7.0; 6]);
        assert!(gaussian_blur(&[], 0, 0, 1.0).is_err());
    }
    #[test]
    fn kde_recovers_subpixel_star_and_rejects_blank_patch() {
        let position = [15.28, 16.73];
        let image: Vec<_> = (0..32 * 32)
            .map(|i| {
                let d = ((i % 32) as f64 - position[0]).powi(2)
                    + ((i / 32) as f64 - position[1]).powi(2);
                (100.0 + 800.0 * (-d / 4.5).exp()) as f32
            })
            .collect();
        let found = kde_centroid(&image, 32, 32, [15.0, 17.0]).unwrap();
        // Independent js/centroid.js output using the identical sampled image.
        // Much tighter than a fine-grid pixel (0.025px), without requiring
        // bit-identical JS-double versus Rust-f32 interpolation arithmetic.
        assert!((found.position[0] - 15.2798810703667).abs() < 0.0002);
        assert!((found.position[1] - 16.73011645193261).abs() < 0.0002);
        assert!(
            (found.position[0] - position[0]).abs() < 0.03,
            "{:?}",
            found.position
        );
        assert!(
            (found.position[1] - position[1]).abs() < 0.03,
            "{:?}",
            found.position
        );
        assert!(kde_centroid(&[10.0; 1024], 32, 32, [15.0, 17.0]).is_err());
    }
}
