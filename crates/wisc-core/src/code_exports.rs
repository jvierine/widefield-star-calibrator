//! Standalone compatibility mappers, emitted by Rust on native and WASM.
use crate::Calibration;

pub fn parameters(calibration: &Calibration, language: &str) -> Result<String, String> {
    calibration.validate()?;
    let values = std::iter::once(u8::from(calibration.model).to_string())
        .chain(calibration.optpar.iter().map(|v| format!("{v:?}")))
        .collect::<Vec<_>>()
        .join(", ");
    match language {
        "python" | "julia" => Ok(format!("optpar = [{values}]")),
        "matlab" => Ok(format!("optpar = [{values}];")),
        "c" => Ok(format!(
            "static const double optpar[{}] = {{{values}}};",
            calibration.optpar.len() + 1
        )),
        _ => Err("supported export languages: python, julia, matlab, c".into()),
    }
}

pub fn mapper(calibration: &Calibration, language: &str) -> Result<String, String> {
    let template = match language {
        "python" => include_str!("../assets/mapper.py.in"),
        "julia" => include_str!("../assets/mapper.jl.in"),
        "matlab" => include_str!("../assets/mapper.m.in"),
        "c" => include_str!("../assets/mapper.c.in"),
        _ => return Err("supported export languages: python, julia, matlab, c".into()),
    };
    Ok(template
        .replace(
            "{{OPT_PAR_DECLARATION}}",
            &parameters(calibration, language)?,
        )
        .replace("{{MODEL}}", &u8::from(calibration.model).to_string())
        .replace("{{WIDTH}}", &calibration.width.to_string())
        .replace("{{HEIGHT}}", &calibration.height.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_languages_and_lenses_export_full_precision_without_template_tokens() {
        for model in [1, 2, 3, 4, 5, 6, 12, 20] {
            let model = crate::OpticalModel::try_from(model).unwrap();
            let mut calibration = Calibration {
                width: 1920,
                height: 1080,
                model,
                optpar: crate::default_optpar(1920, 1080, model),
            };
            calibration.optpar[5] = 0.12345678901234567;
            for language in ["python", "julia", "matlab", "c"] {
                let text = mapper(&calibration, language).unwrap();
                assert!(!text.contains("{{"));
                assert!(!text.contains("998877"));
                assert!(text.contains("0.12345678901234566"));
                assert!(text.len() > 1500);
            }
        }
    }
}
