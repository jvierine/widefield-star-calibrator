//! Optional EXIF and filename metadata. Never prevents scientific image loading.
use chrono::{NaiveDateTime, TimeZone, Utc};
use exif::{In, Tag, Value};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct ImageMetadata {
    pub unix_millis: Option<i64>,
    pub latitude_deg: Option<f64>,
    pub longitude_deg: Option<f64>,
    pub altitude_m: Option<f64>,
    pub camera_make: Option<String>,
    pub camera_model: Option<String>,
    pub assumed_utc: bool,
    pub station: Option<String>,
}

fn ascii(exif: &exif::Exif, tag: Tag) -> Option<String> {
    match &exif.get_field(tag, In::PRIMARY)?.value {
        Value::Ascii(values) => Some(
            std::str::from_utf8(values.first()?)
                .ok()?
                .trim_matches('\0')
                .trim()
                .to_owned(),
        ),
        _ => None,
    }
}

fn coordinate(
    exif: &exif::Exif,
    tag: Tag,
    reference: Tag,
    positive: &str,
    negative: &str,
    limit: f64,
) -> Option<f64> {
    let Value::Rational(values) = &exif.get_field(tag, In::PRIMARY)?.value else {
        return None;
    };
    if values.len() != 3 || values.iter().any(|v| v.denom == 0) {
        return None;
    }
    let dms: Vec<_> = values.iter().map(|v| v.to_f64()).collect();
    if dms[1] >= 60.0 || dms[2] >= 60.0 {
        return None;
    }
    let sign = match ascii(exif, reference)?.as_str() {
        value if value == positive => 1.0,
        value if value == negative => -1.0,
        _ => return None,
    };
    let result = sign * (dms[0] + dms[1] / 60.0 + dms[2] / 3600.0);
    (result.abs() <= limit).then_some(result)
}

pub fn read(bytes: &[u8], filename: &str) -> ImageMetadata {
    let mut metadata = filename_metadata(filename);
    if let Ok(exif) = exif::Reader::new().read_from_container(&mut std::io::Cursor::new(bytes)) {
        metadata.camera_make = ascii(&exif, Tag::Make);
        metadata.camera_model = ascii(&exif, Tag::Model);
        let date = [Tag::DateTimeOriginal, Tag::DateTimeDigitized, Tag::DateTime]
            .iter()
            .find_map(|tag| ascii(&exif, *tag));
        let offset = [
            Tag::OffsetTimeOriginal,
            Tag::OffsetTimeDigitized,
            Tag::OffsetTime,
        ]
        .iter()
        .find_map(|tag| ascii(&exif, *tag));
        if let Some(date) =
            date.and_then(|date| NaiveDateTime::parse_from_str(&date, "%Y:%m:%d %H:%M:%S").ok())
        {
            let timestamp = if let Some(offset) = offset {
                chrono::DateTime::parse_from_str(
                    &format!("{} {}", date.format("%Y-%m-%d %H:%M:%S"), offset),
                    "%Y-%m-%d %H:%M:%S %:z",
                )
                .ok()
                .map(|date| date.timestamp_millis())
            } else {
                metadata.assumed_utc = true;
                Some(Utc.from_utc_datetime(&date).timestamp_millis())
            };
            if let Some(timestamp) = timestamp {
                let subsecond = ascii(&exif, Tag::SubSecTimeOriginal)
                    .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
                    .map(|s| format!("{s:0<3}")[..3].parse::<i64>().unwrap_or(0))
                    .unwrap_or(0);
                metadata.unix_millis = Some(timestamp + subsecond);
            }
        }
        if let (Some(latitude), Some(longitude)) = (
            coordinate(&exif, Tag::GPSLatitude, Tag::GPSLatitudeRef, "N", "S", 90.0),
            coordinate(
                &exif,
                Tag::GPSLongitude,
                Tag::GPSLongitudeRef,
                "E",
                "W",
                180.0,
            ),
        ) {
            metadata.latitude_deg = Some(latitude);
            metadata.longitude_deg = Some(longitude);
            metadata.station = None;
        }
        if let Some(field) = exif.get_field(Tag::GPSAltitude, In::PRIMARY) {
            if let Value::Rational(values) = &field.value {
                if let Some(value) = values.first().filter(|v| v.denom != 0) {
                    let sign = if exif
                        .get_field(Tag::GPSAltitudeRef, In::PRIMARY)
                        .and_then(|f| f.value.get_uint(0))
                        == Some(1)
                    {
                        -1.0
                    } else {
                        1.0
                    };
                    metadata.altitude_m = Some(sign * value.to_f64());
                }
            }
        }
    }
    metadata
}

pub fn filename_metadata(filename: &str) -> ImageMetadata {
    let filename = filename
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(filename)
        .to_ascii_lowercase();
    let mut metadata = ImageMetadata::default();
    // Strict date parsing rejects invalid dates instead of normalizing them.
    for (length, format) in [
        (19, "%Y-%m-%dT%H.%M.%S"),
        (19, "%Y_%m_%d_%H_%M_%S"),
        (19, "%Y-%m-%d-%H-%M-%S"),
        (16, "%d.%m.%Y_%H.%M"),
        (15, "%Y%m%dT%H%M%S"),
        (15, "%Y%m%d_%H%M%S"),
        (14, "%Y%m%d%H%M%S"),
    ] {
        if format == "%d.%m.%Y_%H.%M" && !filename.contains("alomar_") {
            continue;
        }
        for (index, part) in filename.as_bytes().windows(length).enumerate() {
            let Ok(part) = std::str::from_utf8(part) else {
                continue;
            };
            if let Ok(date) = NaiveDateTime::parse_from_str(&part.replace('t', "T"), format) {
                let mut timestamp = date.and_utc().timestamp_millis();
                if length == 19 {
                    let suffix = &filename.as_bytes()[index + length..];
                    if suffix.first().is_some_and(|b| b"._-".contains(b)) {
                        let digits: Vec<_> = suffix[1..]
                            .iter()
                            .take_while(|b| b.is_ascii_digit())
                            .take(3)
                            .copied()
                            .collect();
                        if !digits.is_empty() {
                            let text = std::str::from_utf8(&digits).unwrap();
                            timestamp += format!("{text:0<3}").parse::<i64>().unwrap();
                        }
                    }
                }
                metadata.unix_millis = Some(timestamp);
                break;
            }
        }
        if metadata.unix_millis.is_some() {
            break;
        }
    }
    let stem = filename
        .rsplit_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(&filename);
    // Legacy compact station names sometimes omit the leading '2' of the
    // calendar year. They are NOT Unix millisecond timestamps.
    if let Some((timestamp, "ram")) = stem.split_once('_') {
        if timestamp.len() == 13
            && timestamp.starts_with('0')
            && timestamp.bytes().all(|b| b.is_ascii_digit())
        {
            if let Ok(date) =
                NaiveDateTime::parse_from_str(&format!("2{timestamp}"), "%Y%m%d%H%M%S")
            {
                metadata.unix_millis = Some(date.and_utc().timestamp_millis());
            }
        }
    }
    let alis = [
        (
            "krn",
            67.0 + 50.0 / 60.0 + 26.588 / 3600.0,
            20.0 + 24.0 / 60.0 + 40.045 / 3600.0,
            425.0,
        ),
        (
            "mer",
            67.0 + 32.0 / 60.0 + 50.7 / 3600.0,
            21.0 + 55.0 / 60.0 + 12.3 / 3600.0,
            300.0,
        ),
        (
            "sil",
            68.0 + 1.0 / 60.0 + 47.0 / 3600.0,
            21.0 + 41.0 / 60.0 + 13.4 / 3600.0,
            385.0,
        ),
        (
            "tja",
            67.0 + 19.0 / 60.0 + 57.8 / 3600.0,
            20.0 + 45.0 / 60.0 + 2.9 / 3600.0,
            474.0,
        ),
        (
            "abk",
            68.0 + 21.0 / 60.0 + 20.0 / 3600.0,
            18.0 + 49.0 / 60.0 + 10.5 / 3600.0,
            360.0,
        ),
        (
            "nil",
            67.0 + 51.0 / 60.0 + 6.7 / 3600.0,
            19.0 + 12.4 / 3600.0,
            495.0,
        ),
        ("ram", 69.5860, 19.2247, 0.0),
    ];
    for (code, lat, lon, alt) in alis {
        if code == "ram"
            && !stem.split_once('_').is_some_and(|(stamp, suffix)| {
                suffix == "ram"
                    && [13, 14].contains(&stamp.len())
                    && stamp.bytes().all(|b| b.is_ascii_digit())
            })
        {
            continue;
        }
        if stem.ends_with(code) || stem.contains(&format!("{code}20")) {
            metadata.latitude_deg = Some(lat);
            metadata.longitude_deg = Some(lon);
            metadata.altitude_m = Some(alt);
            metadata.station = Some(code.to_uppercase());
            return metadata;
        }
    }
    if filename.contains("alomar") {
        metadata.latitude_deg = Some(69.2736);
        metadata.longitude_deg = Some(16.0352);
        metadata.altitude_m = Some(150.0);
        metadata.station = Some("ALOMAR".into());
        return metadata;
    }
    for (tokens, lat, lon) in [
        (&["010760"][..], 51.0, 7.2),
        (&["012165"][..], 51.5, 7.2),
        (&["010095", "010096"][..], 52.5, 12.6),
        (&["010125"][..], 52.1, 8.7),
        (&["010314", "cam5"][..], 50.4, 11.2),
        (&["010880", "010881", "ams0881", "ams0882"][..], 51.4, 14.3),
        (&["010028", "010031", "ams0228", "ams0221"][..], 52.2, 14.1),
    ] {
        if tokens.iter().any(|token| filename.contains(token)) {
            metadata.latitude_deg = Some(lat);
            metadata.longitude_deg = Some(lon);
            metadata.station = Some("allsky7 (coarsened coordinates)".into());
            break;
        }
    }
    metadata
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn known_station_and_filename_fallbacks_match_legacy() {
        let m = filename_metadata("2025_03_03_22_00_02_000_010031-stacked.jpg");
        assert_eq!(m.latitude_deg, Some(52.2));
        assert_eq!(m.longitude_deg, Some(14.1));
        assert_eq!(m.unix_millis, Some(1741039202000));
        let m = filename_metadata("20260102235912_RAM.jpg");
        assert_eq!(m.latitude_deg, Some(69.586));
        assert_eq!(m.unix_millis, Some(1767398352000));
        let m = filename_metadata("2026-01-02T23.59.12KRN.jpg");
        assert!((m.latitude_deg.unwrap() - 67.8407188889).abs() < 1e-9);
        assert_eq!(m.unix_millis, Some(1767398352000));
        assert_eq!(read(b"bad image", "unknown.jpg").unix_millis, None);
        assert_eq!(filename_metadata("program.jpg").latitude_deg, None);
    }
    #[test]
    fn heic_exif_is_read_without_javascript() {
        let m = read(
            include_bytes!("../../../calibration_images/IMG_9953.HEIC"),
            "IMG_9953.HEIC",
        );
        assert_eq!(m.camera_make.as_deref(), Some("Apple"));
        assert!(m.unix_millis.is_some());
        assert!(m.latitude_deg.is_some());
        assert!(m.longitude_deg.is_some());
    }
    #[test]
    fn filename_time_regressions_cover_legacy_fractional_and_compact_forms() {
        for (filename, iso) in [
            ("2025-02-19-03-44-00-7.png", "2025-02-19T03:44:00.700Z"),
            (
                "2026-01-23T20.05.00.123KRN.jpeg",
                "2026-01-23T20:05:00.123Z",
            ),
            ("xMER20260123T200500E01000Q.JPG", "2026-01-23T20:05:00.000Z"),
            ("0260112173523_RAM.jpg", "2026-01-12T17:35:23.000Z"),
            (
                "Sunniva_Alomar_23.03.2023_21.30UT.jpg",
                "2023-03-23T21:30:00.000Z",
            ),
        ] {
            let expected = chrono::DateTime::parse_from_rfc3339(iso)
                .unwrap()
                .timestamp_millis();
            assert_eq!(
                filename_metadata(filename).unix_millis,
                Some(expected),
                "{filename}"
            );
        }
    }
}
