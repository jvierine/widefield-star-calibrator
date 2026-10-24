//! Image input shared by native and browser clients. Scientific pixels are
//! preserved separately from the 8-bit texture used for display.

use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum FitsByteOrder {
    /// Preserve the legacy smoothness heuristic for nonstandard 16-bit files.
    #[default]
    Auto,
    Big,
    Little,
}

#[derive(Debug)]
pub struct CalibrationImage {
    pub width: u32,
    pub height: u32,
    pub frames: usize,
    pub luminance: Vec<f32>,
    pub rgba: Vec<u8>,
    pub fits_header: BTreeMap<String, String>,
    pub little_endian: bool,
}

const MAX_PIXELS: usize = 64_000_000;

/// Write azimuth and elevation maps as two IEEE float FITS planes. Sampling is
/// at raw, zero-based pixel centres; invalid lens inversions remain NaN.
pub fn write_azel_fits(
    writer: &mut impl std::io::Write,
    calibration: &crate::Calibration,
    step: u32,
) -> Result<(), String> {
    calibration.validate()?;
    if step == 0 {
        return Err("map sampling step must be positive".into());
    }
    let width = calibration.width.div_ceil(step);
    let height = calibration.height.div_ceil(step);
    let mut header = Vec::new();
    let mut card = |key: &str, value: String| {
        let value = if value.starts_with('\'') {
            format!("{value:<20}")
        } else {
            format!("{value:>20}")
        };
        header.extend(format!("{:<80}", format!("{key:<8}= {value}")).as_bytes());
    };
    for (key, value) in [
        ("SIMPLE", "T".into()),
        ("BITPIX", "-32".into()),
        ("NAXIS", "3".into()),
        ("NAXIS1", width.to_string()),
        ("NAXIS2", height.to_string()),
        ("NAXIS3", "2".into()),
        ("BUNIT", "'deg'".into()),
        ("PLANE1", "'AZIMUTH'".into()),
        ("PLANE2", "'ELEVATION'".into()),
        ("CTYPE1", "'PIXEL-X'".into()),
        ("CTYPE2", "'PIXEL-Y'".into()),
        ("CRPIX1", "1".into()),
        ("CRPIX2", "1".into()),
        ("CRVAL1", "0".into()),
        ("CRVAL2", "0".into()),
        ("CDELT1", step.to_string()),
        ("CDELT2", step.to_string()),
        ("OPTMOD", u8::from(calibration.model).to_string()),
    ] {
        card(key, value);
    }
    for (index, value) in calibration.optpar.iter().enumerate() {
        card(&format!("OPTPAR{}", index + 1), value.to_string());
    }
    header.extend(format!("{:<80}", "END").as_bytes());
    header.resize(header.len().div_ceil(2880) * 2880, b' ');
    writer
        .write_all(&header)
        .map_err(|error| error.to_string())?;
    let mut row = Vec::with_capacity(width as usize * 4);
    for plane in 0..2 {
        for y in (0..calibration.height).step_by(step as usize) {
            row.clear();
            for x in (0..calibration.width).step_by(step as usize) {
                let value = crate::geometry::pixel_to_azimuth_zenith(
                    calibration,
                    [f64::from(x), f64::from(y)],
                )
                .map(|[azimuth, zenith]| {
                    if plane == 0 {
                        azimuth * crate::RAD
                    } else {
                        90.0 - zenith * crate::RAD
                    }
                })
                .unwrap_or(f64::NAN) as f32;
                row.extend(value.to_be_bytes());
            }
            writer.write_all(&row).map_err(|error| error.to_string())?;
        }
    }
    let length = u64::from(width) * u64::from(height) * 8;
    let padding = (2880 - length % 2880) % 2880;
    writer
        .write_all(&vec![0; padding as usize])
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn decode(bytes: &[u8], byte_order: FitsByteOrder) -> Result<CalibrationImage, String> {
    if bytes.starts_with(b"SIMPLE  ") {
        return decode_fits(bytes, byte_order);
    }
    let reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|error| error.to_string())?;
    let rgba = reader
        .decode()
        .map_err(|error| error.to_string())?
        .to_rgba8();
    let luminance = rgba
        .pixels()
        .map(|pixel| {
            0.2126 * f32::from(pixel[0])
                + 0.7152 * f32::from(pixel[1])
                + 0.0722 * f32::from(pixel[2])
        })
        .collect();
    Ok(CalibrationImage {
        width: rgba.width(),
        height: rgba.height(),
        frames: 1,
        luminance,
        rgba: rgba.into_raw(),
        fits_header: BTreeMap::new(),
        little_endian: false,
    })
}

fn header_value(card: &str) -> String {
    let text = card[10..].trim();
    if let Some(quoted) = text.strip_prefix('\'') {
        let mut output = String::new();
        let mut characters = quoted.chars().peekable();
        while let Some(character) = characters.next() {
            if character == '\'' {
                if characters.peek() == Some(&'\'') {
                    characters.next();
                } else {
                    break;
                }
            }
            output.push(character);
        }
        output.trim().to_owned()
    } else {
        text.split('/').next().unwrap_or("").trim().to_owned()
    }
}

fn number(
    header: &BTreeMap<String, String>,
    key: &str,
    fallback: Option<f64>,
) -> Result<f64, String> {
    match header.get(key) {
        Some(value) => value
            .replace(['d', 'D'], "E")
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite())
            .ok_or_else(|| format!("invalid FITS {key}")),
        None => fallback.ok_or_else(|| format!("missing FITS {key}")),
    }
}

fn dimension(header: &BTreeMap<String, String>, key: &str) -> Result<usize, String> {
    let value = number(header, key, None)?;
    if value < 1.0 || value.fract() != 0.0 || value > MAX_PIXELS as f64 {
        return Err(format!("invalid FITS {key}"));
    }
    Ok(value as usize)
}

fn endian_score(
    data: &[u8],
    width: usize,
    height: usize,
    frames: usize,
    little: bool,
) -> (f64, usize) {
    let read = |index: usize| {
        let bytes = [data[index * 2], data[index * 2 + 1]];
        f64::from(if little {
            i16::from_le_bytes(bytes)
        } else {
            i16::from_be_bytes(bytes)
        })
    };
    let stride = ((width * height * frames) as f64 / 50_000.0)
        .sqrt()
        .ceil()
        .max(1.0) as usize;
    let (mut score, mut count) = (0.0, 0);
    for frame in 0..frames {
        for y in (0..height).step_by(stride) {
            for x in (0..width).step_by(stride) {
                let index = frame * width * height + y * width + x;
                if x + 1 < width {
                    score += (read(index) - read(index + 1)).abs();
                    count += 1;
                }
                if y + 1 < height {
                    score += (read(index) - read(index + width)).abs();
                    count += 1;
                }
            }
        }
    }
    (score, count)
}

pub fn decode_fits(bytes: &[u8], byte_order: FitsByteOrder) -> Result<CalibrationImage, String> {
    let mut header = BTreeMap::new();
    let mut end = None;
    for (index, card) in bytes.as_chunks::<80>().0.iter().take(131_072).enumerate() {
        if !card.is_ascii() {
            return Err("non-ASCII FITS header".into());
        }
        let card = std::str::from_utf8(card).map_err(|error| error.to_string())?;
        let key = card[..8].trim();
        if key == "END" {
            end = Some((index + 1) * 80);
            break;
        }
        if &card[8..10] == "= " {
            header.insert(key.to_owned(), header_value(card));
        }
    }
    let offset = end.ok_or("FITS header has no END card")?.div_ceil(2880) * 2880;
    if header.get("SIMPLE").map(String::as_str) != Some("T") {
        return Err("not a primary FITS image".into());
    }
    let axes = dimension(&header, "NAXIS")?;
    if !(2..=9).contains(&axes) {
        return Err("FITS NAXIS must be between 2 and 9".into());
    }
    let width = dimension(&header, "NAXIS1")?;
    let height = dimension(&header, "NAXIS2")?;
    let plane = width
        .checked_mul(height)
        .filter(|value| *value <= MAX_PIXELS)
        .ok_or("FITS image is too large")?;
    let mut frames = 1usize;
    for axis in 3..=axes {
        frames = frames
            .checked_mul(dimension(&header, &format!("NAXIS{axis}"))?)
            .ok_or("FITS dimensions overflow")?;
    }
    let bitpix = number(&header, "BITPIX", None)?;
    let stride = match bitpix {
        8.0 => 1,
        16.0 => 2,
        32.0 | -32.0 => 4,
        64.0 | -64.0 => 8,
        _ => return Err(format!("unsupported FITS BITPIX {bitpix}")),
    };
    let length = plane
        .checked_mul(frames)
        .and_then(|value| value.checked_mul(stride))
        .ok_or("FITS data size overflow")?;
    let data = bytes
        .get(offset..offset.checked_add(length).ok_or("FITS offset overflow")?)
        .ok_or("FITS data section is shorter than expected")?;
    let little = bitpix == 16.0
        && match byte_order {
            FitsByteOrder::Big => false,
            FitsByteOrder::Little => true,
            FitsByteOrder::Auto => {
                let (big_score, count) = endian_score(data, width, height, frames, false);
                count >= 16 && endian_score(data, width, height, frames, true).0 < big_score
            }
        };
    let scale = number(&header, "BSCALE", Some(1.0))?;
    let zero = number(&header, "BZERO", Some(0.0))?;
    let blank = header
        .get("BLANK")
        .and_then(|value| value.parse::<i64>().ok());
    let mut sums = vec![0.0f64; plane];
    let mut counts = vec![0usize; plane];
    for (index, sample) in data.chunks_exact(stride).enumerate() {
        let integer = match bitpix {
            8.0 => Some(i64::from(sample[0])),
            16.0 => Some(i64::from(if little {
                i16::from_le_bytes(sample.try_into().unwrap())
            } else {
                i16::from_be_bytes(sample.try_into().unwrap())
            })),
            32.0 => Some(i64::from(i32::from_be_bytes(sample.try_into().unwrap()))),
            64.0 => Some(i64::from_be_bytes(sample.try_into().unwrap())),
            _ => None,
        };
        if integer.is_some() && integer == blank {
            continue;
        }
        let value = match bitpix {
            -32.0 => f64::from(f32::from_be_bytes(sample.try_into().unwrap())),
            -64.0 => f64::from_be_bytes(sample.try_into().unwrap()),
            _ => integer.unwrap() as f64,
        } * scale
            + zero;
        if value.is_finite() {
            sums[index % plane] += value;
            counts[index % plane] += 1;
        }
    }
    let luminance: Vec<f32> = sums
        .into_iter()
        .zip(counts)
        .map(|(sum, count)| if count > 0 { sum as f32 } else { f32::NAN })
        .collect();
    let low = luminance
        .iter()
        .copied()
        .filter(|value| value.is_finite())
        .fold(f32::INFINITY, f32::min);
    let high = luminance
        .iter()
        .copied()
        .filter(|value| value.is_finite())
        .fold(f32::NEG_INFINITY, f32::max);
    let range = if high > low { high - low } else { 1.0 };
    let rgba = luminance
        .iter()
        .flat_map(|value| {
            let gray = ((value - low) / range * 255.0).round().clamp(0.0, 255.0) as u8;
            [gray, gray, gray, 255]
        })
        .collect();
    Ok(CalibrationImage {
        width: width as u32,
        height: height as u32,
        frames,
        luminance,
        rgba,
        fits_header: header,
        little_endian: little,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn azel_map_has_two_separate_degree_planes_and_pixel_sampling_metadata() {
        let calibration = crate::Calibration {
            width: 9,
            height: 9,
            model: crate::OpticalModel::Sine,
            optpar: crate::default_optpar(9, 9, crate::OpticalModel::Sine),
        };
        let mut bytes = Vec::new();
        write_azel_fits(&mut bytes, &calibration, 2).unwrap();
        assert_eq!(&bytes[..30], b"SIMPLE  =                    T");
        let image = decode(&bytes, FitsByteOrder::Big).unwrap();
        assert_eq!(image.fits_header["PLANE2"], "ELEVATION");
        assert_eq!(image.fits_header["CDELT1"], "2");
        let expected = crate::geometry::pixel_to_azimuth_zenith(&calibration, [4.0, 4.0]).unwrap();
        let at = |offset| f32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap());
        assert!((f64::from(at(2880 + 12 * 4)) - expected[0] * crate::RAD).abs() < 1e-5);
        assert!(
            (f64::from(at(2880 + (25 + 12) * 4)) - (90.0 - expected[1] * crate::RAD)).abs() < 1e-5
        );
        assert_eq!(bytes.len() % 2880, 0);
    }

    #[test]
    fn alis_and_alis4d_match_legacy_decoder_pixels() {
        let alis = decode(
            include_bytes!("../../../tests/fixtures/fits/alis_2015-02-16T16.58.20T_crop.fits"),
            FitsByteOrder::Auto,
        )
        .unwrap();
        assert_eq!((alis.width, alis.height, alis.frames), (64, 64, 1));
        assert_eq!(
            &alis.luminance[..8],
            &[-24938.0, -24019.0, -24283.0, -23363.0, -23188.0, -23282.0, -22859.0, -23246.0]
        );
        assert_eq!(
            &alis.luminance[4092..],
            &[-30543.0, -30524.0, -30541.0, -30475.0]
        );
        let alis4d = decode(
            include_bytes!("../../../tests/fixtures/fits/alis4d_2022-10-24T20.50.10O_crop3.fits"),
            FitsByteOrder::Auto,
        )
        .unwrap();
        assert_eq!((alis4d.width, alis4d.height, alis4d.frames), (64, 64, 3));
        assert_eq!(
            &alis4d.luminance[..8],
            &[2346.0, 2434.0, 2747.0, 2856.0, 2678.0, 2959.0, 3058.0, 2936.0]
        );
        assert_eq!(&alis4d.luminance[4092..], &[1991.0, 1773.0, 1854.0, 1873.0]);
        assert_eq!(alis4d.fits_header["LATITUDE"], "68.35555");
    }

    fn fixture(
        bitpix: i32,
        width: usize,
        height: usize,
        frames: usize,
        extras: &[(&str, &str)],
        data: &[u8],
    ) -> Vec<u8> {
        let mut cards = vec![
            ("SIMPLE", "T".to_owned()),
            ("BITPIX", bitpix.to_string()),
            ("NAXIS", "3".into()),
            ("NAXIS1", width.to_string()),
            ("NAXIS2", height.to_string()),
            ("NAXIS3", frames.to_string()),
        ];
        cards.extend(extras.iter().map(|(key, value)| (*key, (*value).into())));
        let mut bytes = Vec::new();
        for (key, value) in cards {
            bytes.extend(format!("{:<80}", format!("{key:<8}= {value}")).as_bytes());
        }
        bytes.extend(format!("{:<80}", "END").as_bytes());
        bytes.resize(bytes.len().div_ceil(2880) * 2880, b' ');
        bytes.extend(data);
        bytes
    }

    #[test]
    fn integrates_frames_and_preserves_unsigned_range_and_metadata() {
        let raw: Vec<u8> = [i16::MIN, 0, i16::MAX, 1, i16::MIN, 0, i16::MAX, 1]
            .iter()
            .flat_map(|value| value.to_be_bytes())
            .collect();
        let decoded = decode_fits(
            &fixture(
                16,
                2,
                2,
                2,
                &[("BZERO", "32768"), ("DATE-OBS", "'2015-02-16T16:58:20'")],
                &raw,
            ),
            FitsByteOrder::Big,
        )
        .unwrap();
        assert_eq!(decoded.frames, 2);
        assert_eq!(decoded.luminance, [0.0, 65536.0, 131070.0, 65538.0]);
        assert_eq!(decoded.fits_header["DATE-OBS"], "2015-02-16T16:58:20");
        assert_eq!(decoded.rgba[8], 255);
    }

    #[test]
    fn detects_nonstandard_little_endian_and_allows_explicit_override() {
        let raw: Vec<u8> = (0..64i16)
            .flat_map(|index| (1000 + index % 8 * 3 + index / 8 * 29).to_le_bytes())
            .collect();
        let bytes = fixture(16, 8, 8, 1, &[], &raw);
        let decoded = decode_fits(&bytes, FitsByteOrder::Auto).unwrap();
        assert!(decoded.little_endian);
        assert_eq!(decoded.luminance[0], 1000.0);
        assert!(
            !decode_fits(&bytes, FitsByteOrder::Big)
                .unwrap()
                .little_endian
        );
    }

    #[test]
    fn floating_missing_samples_and_integer_blank_do_not_become_stars() {
        let raw: Vec<u8> = [f32::NAN, 10.0, 20.0, 30.0, f32::NAN, 1.0, 2.0, 3.0]
            .iter()
            .flat_map(|value| value.to_be_bytes())
            .collect();
        let decoded = decode_fits(&fixture(-32, 2, 2, 2, &[], &raw), FitsByteOrder::Big).unwrap();
        assert!(decoded.luminance[0].is_nan());
        assert_eq!(&decoded.luminance[1..], &[11.0, 22.0, 33.0]);
        let raw: Vec<u8> = [-99i16, 10, 20, 30]
            .iter()
            .flat_map(|value| value.to_be_bytes())
            .collect();
        assert!(decode_fits(
            &fixture(16, 2, 2, 1, &[("BLANK", "-99")], &raw),
            FitsByteOrder::Big
        )
        .unwrap()
        .luminance[0]
            .is_nan());
    }

    #[test]
    fn rejects_truncated_data_and_missing_end_header() {
        let bytes = fixture(16, 2, 2, 1, &[], &[0]);
        assert!(decode_fits(&bytes, FitsByteOrder::Big).is_err());
        assert!(decode_fits(&bytes[..160], FitsByteOrder::Big)
            .unwrap_err()
            .contains("END"));
    }
}
