# Codex Handoff

## Current Branch

- Branch: `transformers`
- Latest prototype commit before this file: `b195c50 Add star detection transformer prototype`
- Goal: train an offline PyTorch Transformer prototype that identifies real/fake detections and predicts catalog RA/Dec as a celestial unit vector.

## User Intent

- Start with positions only.
- Input detections should be normalized position features:
  - `x_norm = x_pix / W`
  - `y_norm = y_pix / H`
  - `rho = sqrt(((x_pix - W / 2) / W) ** 2 + ((y_pix - H / 2) / H) ** 2)`
- Do not feed time, location, sidereal time, camera attitude, or lens metadata to the model.
- The model output should remain:
  - per-detection real/fake logit
  - per-detection RA/Dec celestial unit vector `[ux, uy, uz]`
- Photometry/intensity scale is unknown, so do not rely on SNR, flux, or sigma for the first experiment.

## Files Added

- `model.py`
  - `StarDetectionTransformer`
  - Default `feature_mode="position"` consumes `[x_norm, y_norm, rho]`.
  - Uses `TransformerEncoderLayer(..., batch_first=True)`.
  - Uses `src_key_padding_mask`; mask is `True` for padded detections.
  - No sequence-index positional encoding, because detections are an unordered set.

- `dataset.py`
  - Loads embedded Yale catalogue from `js/star_catalog.js`.
  - Keeps stars with visual magnitude `< 4.0` by default.
  - Converts RA/Dec to unit vectors:
    - `ux = cos(dec) * cos(ra)`
    - `uy = cos(dec) * sin(ra)`
    - `uz = sin(dec)`
  - Infers broad lens/camera families from `test_cases/metadata.json`.
  - Defaults include AllSky7-like 1920x1080 85 x 40 deg, hemispheric fisheye, and moderate wide field.
  - Synthetic samples return:
    - `detections: [N, 3]` by default
    - `y_real: [N]`
    - `u_true: [N, 3]`
    - `star_id: [N]`, `-1` for false detections

- `train.py`
  - Balanced BCE for real/fake classification.
  - Direction loss on true stars only:
    - `dir_loss = 1 - dot(u_pred, u_true)`
  - Total loss:
    - `bce + lambda_dir * dir_loss`
  - Default `lambda_dir=5.0`.
  - Writes JSON report and PyTorch checkpoint.

## Local Environment

Created on this machine:

```bash
conda create -y -n aida-transformers python=3.11 pytorch -c pytorch -c conda-forge
conda install -y -n aida-transformers numpy
```

Use:

```bash
conda activate aida-transformers
```

On Apple Silicon M3/M4, install an appropriate PyTorch build for that platform instead of assuming this Intel macOS env is portable.

## Commands

Syntax check:

```bash
python -m py_compile model.py dataset.py train.py
```

Small smoke run:

```bash
python train.py \
  --epochs 1 \
  --num-samples 16 \
  --batch-size 2 \
  --feature-mode position \
  --photometry-mode missing \
  --device cpu
```

First useful positions-only run:

```bash
python train.py \
  --epochs 12 \
  --num-samples 64 \
  --batch-size 4 \
  --feature-mode position \
  --photometry-mode missing \
  --report-out test-report/star-transformer-position/report-balanced.json \
  --model-out test-report/star-transformer-position/model-balanced.pt
```

For M3/M4, increase `--num-samples`, `--epochs`, and possibly `--batch-size`.

## Most Recent CPU Training Result

Run:

```bash
python -u train.py --epochs 12 --num-samples 64 --batch-size 4 \
  --feature-mode position --photometry-mode missing --device cpu \
  --report-out test-report/star-transformer-position/report-balanced.json \
  --model-out test-report/star-transformer-position/model-balanced.pt
```

Final epoch:

```text
epoch 012 train loss=5.0803 bce=0.6868 dir=0.8787
valid loss=5.9740 bce=0.6631 dir=1.0622
acc=0.735 precision=0.308 recall=0.389 f1=0.344 mean_ang=95.4deg
```

Interpretation:

- Balanced BCE fixed the trivial "predict no real stars" failure from the first run.
- Classification is weak but nonzero on the tiny CPU run.
- Direction accuracy is still poor; this is expected for a small synthetic run and positions-only input.
- Reports/checkpoints are in ignored `test-report/`, so they are not committed.

## Important Notes

- The prototype predicts fixed catalog celestial vectors, not camera attitude or observer location.
- Camera attitude is a hidden simulator variable only.
- If continuing training, prefer saving reports with distinct names so runs can be compared.
- `test-report/` is ignored by git.
