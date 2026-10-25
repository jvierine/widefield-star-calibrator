//! Bundled named catalogues, parsed as data without a JavaScript runtime.
use crate::workflow::CatalogStar;
use serde_json::Value;
use std::io::Read;

#[derive(Clone, Debug)]
pub struct Entry {
    pub star: CatalogStar,
    pub name: String,
    pub id: String,
}

pub fn load(kind: &str) -> Result<Vec<Entry>, String> {
    match kind {
        "tycho2" => {
            let names = yale()?;
            let mut identifier_bytes = Vec::new();
            flate2::read::GzDecoder::new(
                &include_bytes!("../../../data/tycho2_mag8.ids.json.gz")[..],
            )
            .take(4_000_001)
            .read_to_end(&mut identifier_bytes)
            .map_err(|e| e.to_string())?;
            if identifier_bytes.len() > 4_000_000 {
                return Err("oversized Tycho identifier table".into());
            }
            let identifiers: Vec<String> =
                serde_json::from_slice(&identifier_bytes).map_err(|e| e.to_string())?;
            let stars = crate::workflow::tycho_catalog()?;
            if identifiers.len() != stars.len() {
                return Err("Tycho identifiers do not match catalogue rows".into());
            }
            let directions: Vec<_> = names.iter().map(|e| direction(&e.star)).collect();
            Ok(stars
                .into_iter()
                .zip(identifiers)
                .map(|(star, id)| {
                    let nearby = if star.magnitude <= 7.0 {
                        let point = direction(&star);
                        names
                            .iter()
                            .zip(&directions)
                            .filter_map(|(entry, vector)| {
                                let distance =
                                    (0..3).map(|i| (point[i] - vector[i]).powi(2)).sum::<f64>();
                                (distance < (crate::DEG / 60.0).powi(2))
                                    .then_some((distance, entry))
                            })
                            .min_by(|a, b| a.0.total_cmp(&b.0))
                            .map(|(_, entry)| entry.name.clone())
                    } else {
                        None
                    };
                    Entry {
                        name: nearby.unwrap_or_else(|| id.clone()),
                        id,
                        star,
                    }
                })
                .collect())
        }
        "yale" => yale(),
        "td1" => {
            let root: Value = serde_json::from_str(include_str!("../../../data/td1_uv.json"))
                .map_err(|e| e.to_string())?;
            rows(root.get("rows").ok_or("missing TD1 rows")?, "TD1")
        }
        _ => Err("unknown star catalogue".into()),
    }
}

fn direction(star: &CatalogStar) -> [f64; 3] {
    let (ra, dec) = (star.ra_hours * 15.0 * crate::DEG, star.dec_deg * crate::DEG);
    [dec.cos() * ra.cos(), dec.cos() * ra.sin(), dec.sin()]
}

fn yale() -> Result<Vec<Entry>, String> {
    let source = include_str!("../../../js/star_catalog.js");
    // This file contains a literal JSON array after a fixed assignment. We
    // parse that array only; no script is evaluated or shipped as executable JS.
    let data = source
        .split_once("window.AIDA_STAR_CATALOG = ")
        .ok_or("missing Yale data")?
        .1
        .trim()
        .strip_suffix(';')
        .ok_or("invalid Yale data terminator")?;
    let root: Value = serde_json::from_str(data).map_err(|e| e.to_string())?;
    rows(&root, "Yale")
}

fn rows(root: &Value, prefix: &str) -> Result<Vec<Entry>, String> {
    root.as_array()
        .ok_or("invalid catalogue rows")?
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let number = |i| {
                row.get(i)
                    .and_then(Value::as_f64)
                    .filter(|v| v.is_finite())
                    .ok_or("invalid catalogue coordinate")
            };
            let star = CatalogStar {
                index,
                ra_hours: number(0)?,
                dec_deg: number(1)?,
                magnitude: number(2)?,
            };
            if !(0.0..=24.0).contains(&star.ra_hours) || !(-90.0..=90.0).contains(&star.dec_deg) {
                return Err("catalogue coordinate out of range".into());
            }
            let id = row
                .get(4)
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| format!("{prefix} row {index}"));
            let name = row.get(3).and_then(Value::as_str).unwrap_or(&id).to_owned();
            Ok(Entry { star, name, id })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bundled_catalogues_have_valid_unique_indices_names_and_frames() {
        for kind in ["tycho2", "yale", "td1"] {
            let rows = load(kind).unwrap();
            assert!(rows.len() > 1000);
            for (index, row) in rows.iter().enumerate() {
                assert_eq!(row.star.index, index);
                assert!(!row.name.is_empty());
            }
            if kind == "td1" {
                assert_eq!(rows.len(), 17762);
                assert_eq!(rows[0].id, "TD1-17207");
            }
            if kind == "yale" {
                assert!(rows.iter().any(|e| e.name == "Sirius"));
            }
            if kind == "tycho2" {
                assert_eq!(rows.len(), 42047);
                assert!(rows.iter().all(|r| r.id.starts_with("TYC ")));
                assert!(rows.iter().any(|e| e.name == "Sirius"));
            }
        }
    }
}
