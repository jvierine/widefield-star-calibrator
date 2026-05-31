"""Smoke-test training loop for the star detection Transformer prototype."""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict
from dataclasses import dataclass
from functools import partial
from pathlib import Path
from typing import Literal

import torch
from torch import Tensor, nn
from torch.utils.data import DataLoader, random_split

from dataset import (
    SyntheticStarDetectionDataset,
    SyntheticStarDatasetConfig,
    collate_star_detections,
)
from model import ImageGeometry, StarDetectionTransformer, predict_stars


@dataclass(frozen=True)
class TrainConfig:
    epochs: int = 5
    batch_size: int = 8
    learning_rate: float = 3e-4
    lambda_dir: float = 5.0
    num_samples: int = 256
    seed: int = 1234
    device: str = "cuda" if torch.cuda.is_available() else "cpu"
    feature_mode: Literal["position", "shape", "all"] = "position"
    photometry_mode: Literal["unit", "synthetic", "missing"] = "unit"
    report_out: str = "test-report/star-transformer-position/report.json"
    model_out: str = "test-report/star-transformer-position/model.pt"


def star_loss(
    real_logit: Tensor,
    u_pred: Tensor,
    y_real: Tensor,
    u_true: Tensor,
    valid_mask: Tensor,
    lambda_dir: float = 5.0,
) -> tuple[Tensor, Tensor, Tensor]:
    """Compute masked BCE plus direction loss for real stars."""

    valid = valid_mask.bool()
    valid_logit = real_logit[valid]
    valid_target = y_real[valid]
    positives = valid_target.sum()
    negatives = valid_target.numel() - positives
    pos_weight = torch.clamp(negatives / torch.clamp(positives, min=1.0), min=1.0, max=20.0)
    bce_items = nn.functional.binary_cross_entropy_with_logits(
        valid_logit,
        valid_target,
        reduction="none",
    )
    bce_weights = torch.where(valid_target > 0.5, pos_weight, torch.ones_like(valid_target))
    bce = (bce_items * bce_weights).sum() / torch.clamp(bce_weights.sum(), min=1.0)

    real = valid & (y_real > 0.5)
    if real.any():
        dot = (u_pred[real] * u_true[real]).sum(dim=-1).clamp(-1.0, 1.0)
        dir_loss = (1.0 - dot).mean()
    else:
        dir_loss = real_logit.new_tensor(0.0)

    total = bce + lambda_dir * dir_loss
    return total, bce.detach(), dir_loss.detach()


def move_batch(batch: dict[str, Tensor], device: str) -> dict[str, Tensor]:
    return {key: value.to(device) for key, value in batch.items()}


def train_one_epoch(
    model: StarDetectionTransformer,
    loader: DataLoader,
    optimizer: torch.optim.Optimizer,
    config: TrainConfig,
) -> tuple[float, float, float]:
    model.train()
    totals = {"loss": 0.0, "bce": 0.0, "dir": 0.0, "items": 0}
    for batch in loader:
        batch = move_batch(batch, config.device)
        optimizer.zero_grad(set_to_none=True)
        real_logit, u_pred = model(batch["detections"], padding_mask=batch["padding_mask"])
        loss, bce, dir_loss = star_loss(
            real_logit=real_logit,
            u_pred=u_pred,
            y_real=batch["y_real"],
            u_true=batch["u_true"],
            valid_mask=batch["valid_mask"],
            lambda_dir=config.lambda_dir,
        )
        loss.backward()
        optimizer.step()

        count = int(batch["valid_mask"].sum().item())
        totals["loss"] += float(loss.detach()) * count
        totals["bce"] += float(bce) * count
        totals["dir"] += float(dir_loss) * count
        totals["items"] += count

    denom = max(1, totals["items"])
    return totals["loss"] / denom, totals["bce"] / denom, totals["dir"] / denom


def classification_metrics(real_logit: Tensor, y_real: Tensor, valid_mask: Tensor) -> dict[str, float]:
    valid = valid_mask.bool()
    predicted_real = torch.sigmoid(real_logit) > 0.5
    target_real = y_real > 0.5
    true_positive = (predicted_real & target_real & valid).sum().item()
    false_positive = (predicted_real & ~target_real & valid).sum().item()
    false_negative = (~predicted_real & target_real & valid).sum().item()
    true_negative = (~predicted_real & ~target_real & valid).sum().item()
    precision = true_positive / max(1, true_positive + false_positive)
    recall = true_positive / max(1, true_positive + false_negative)
    f1 = 2 * precision * recall / max(1e-8, precision + recall)
    accuracy = (true_positive + true_negative) / max(1, true_positive + true_negative + false_positive + false_negative)
    return {
        "accuracy": accuracy,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "true_positive": float(true_positive),
        "false_positive": float(false_positive),
        "false_negative": float(false_negative),
        "true_negative": float(true_negative),
    }


def angular_error_degrees(u_pred: Tensor, u_true: Tensor, y_real: Tensor, valid_mask: Tensor) -> tuple[float, float]:
    real = valid_mask.bool() & (y_real > 0.5)
    if not real.any():
        return float("nan"), float("nan")
    dot = (u_pred[real] * u_true[real]).sum(dim=-1).clamp(-1.0, 1.0)
    errors = torch.rad2deg(torch.acos(dot))
    return float(errors.mean()), float(errors.median())


@torch.no_grad()
def evaluate(
    model: StarDetectionTransformer,
    loader: DataLoader,
    config: TrainConfig,
) -> dict[str, float]:
    model.eval()
    totals = {
        "loss": 0.0,
        "bce": 0.0,
        "dir": 0.0,
        "items": 0,
        "true_positive": 0.0,
        "false_positive": 0.0,
        "false_negative": 0.0,
        "true_negative": 0.0,
        "angular_error_sum": 0.0,
        "angular_error_count": 0.0,
    }
    angular_medians = []
    for batch in loader:
        batch = move_batch(batch, config.device)
        real_logit, u_pred = model(batch["detections"], padding_mask=batch["padding_mask"])
        loss, bce, dir_loss = star_loss(
            real_logit=real_logit,
            u_pred=u_pred,
            y_real=batch["y_real"],
            u_true=batch["u_true"],
            valid_mask=batch["valid_mask"],
            lambda_dir=config.lambda_dir,
        )
        valid = batch["valid_mask"].bool()
        cls = classification_metrics(real_logit, batch["y_real"], valid)
        mean_ang, median_ang = angular_error_degrees(u_pred, batch["u_true"], batch["y_real"], valid)

        count = int(valid.sum().item())
        totals["loss"] += float(loss) * count
        totals["bce"] += float(bce) * count
        totals["dir"] += float(dir_loss) * count
        totals["items"] += count
        for key in ["true_positive", "false_positive", "false_negative", "true_negative"]:
            totals[key] += cls[key]
        real_count = int((valid & (batch["y_real"] > 0.5)).sum().item())
        if real_count and not torch.isnan(torch.tensor(mean_ang)):
            totals["angular_error_sum"] += mean_ang * real_count
            totals["angular_error_count"] += real_count
            angular_medians.append(median_ang)

    tp = totals["true_positive"]
    fp = totals["false_positive"]
    fn = totals["false_negative"]
    tn = totals["true_negative"]
    denom = max(1, totals["items"])
    precision = tp / max(1.0, tp + fp)
    recall = tp / max(1.0, tp + fn)
    f1 = 2 * precision * recall / max(1e-8, precision + recall)
    return {
        "loss": totals["loss"] / denom,
        "bce": totals["bce"] / denom,
        "dir": totals["dir"] / denom,
        "accuracy": (tp + tn) / max(1.0, tp + tn + fp + fn),
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "true_positive": tp,
        "false_positive": fp,
        "false_negative": fn,
        "true_negative": tn,
        "mean_angular_error_deg": totals["angular_error_sum"] / max(1.0, totals["angular_error_count"]),
        "median_angular_error_deg": float(torch.tensor(angular_medians).median()) if angular_medians else float("nan"),
    }


def build_loaders(config: TrainConfig) -> tuple[DataLoader, DataLoader]:
    dataset = SyntheticStarDetectionDataset(
        SyntheticStarDatasetConfig(
            num_samples=config.num_samples,
            photometry_mode=config.photometry_mode,
            output_mode=config.feature_mode,
        ),
        seed=config.seed,
    )
    train_len = int(0.8 * len(dataset))
    valid_len = len(dataset) - train_len
    generator = torch.Generator().manual_seed(config.seed)
    train_dataset, valid_dataset = random_split(dataset, [train_len, valid_len], generator=generator)
    train_loader = DataLoader(
        train_dataset,
        batch_size=config.batch_size,
        shuffle=True,
        collate_fn=partial(collate_star_detections, shuffle_order=True),
    )
    valid_loader = DataLoader(
        valid_dataset,
        batch_size=config.batch_size,
        shuffle=False,
        collate_fn=collate_star_detections,
    )
    return train_loader, valid_loader


def parse_args() -> TrainConfig:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--epochs", type=int, default=TrainConfig.epochs)
    parser.add_argument("--batch-size", type=int, default=TrainConfig.batch_size)
    parser.add_argument("--learning-rate", type=float, default=TrainConfig.learning_rate)
    parser.add_argument("--lambda-dir", type=float, default=TrainConfig.lambda_dir)
    parser.add_argument("--num-samples", type=int, default=TrainConfig.num_samples)
    parser.add_argument("--seed", type=int, default=TrainConfig.seed)
    parser.add_argument("--device", default=TrainConfig.device)
    parser.add_argument(
        "--feature-mode",
        choices=["position", "shape", "all"],
        default=TrainConfig.feature_mode,
        help="Input features used by the model: position=[x/W,y/H,rho], shape adds ellipticity, all adds snr/flux/sigma.",
    )
    parser.add_argument(
        "--photometry-mode",
        choices=["unit", "synthetic", "missing"],
        default=TrainConfig.photometry_mode,
        help="Synthetic SNR/flux scale: unit normalizes per sample, synthetic keeps arbitrary simulated scale, missing zeros them.",
    )
    parser.add_argument("--report-out", default=TrainConfig.report_out)
    parser.add_argument("--model-out", default=TrainConfig.model_out)
    args = parser.parse_args()
    return TrainConfig(
        epochs=args.epochs,
        batch_size=args.batch_size,
        learning_rate=args.learning_rate,
        lambda_dir=args.lambda_dir,
        num_samples=args.num_samples,
        seed=args.seed,
        device=args.device,
        feature_mode=args.feature_mode,
        photometry_mode=args.photometry_mode,
        report_out=args.report_out,
        model_out=args.model_out,
    )


def main() -> None:
    config = parse_args()
    torch.manual_seed(config.seed)
    train_loader, valid_loader = build_loaders(config)

    model = StarDetectionTransformer(
        ImageGeometry(cx=0.5, cy=0.5, radius=0.5),
        feature_mode=config.feature_mode,
    ).to(config.device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=config.learning_rate, weight_decay=1e-4)

    report: dict[str, object] = {
        "config": asdict(config),
        "epochs": [],
    }
    for epoch in range(1, config.epochs + 1):
        train_loss, train_bce, train_dir = train_one_epoch(model, train_loader, optimizer, config)
        valid = evaluate(model, valid_loader, config)
        row = {
            "epoch": epoch,
            "train_loss": train_loss,
            "train_bce": train_bce,
            "train_dir": train_dir,
            **{f"valid_{key}": value for key, value in valid.items()},
        }
        report["epochs"].append(row)
        print(
            f"epoch {epoch:03d} "
            f"train loss={train_loss:.4f} bce={train_bce:.4f} dir={train_dir:.4f} "
            f"valid loss={valid['loss']:.4f} bce={valid['bce']:.4f} dir={valid['dir']:.4f} "
            f"acc={valid['accuracy']:.3f} precision={valid['precision']:.3f} "
            f"recall={valid['recall']:.3f} f1={valid['f1']:.3f} "
            f"mean_ang={valid['mean_angular_error_deg']:.1f}deg",
            flush=True,
        )

    batch = next(iter(valid_loader))
    batch = move_batch(batch, config.device)
    probability_real, u_pred, keep = predict_stars(
        model,
        batch["detections"],
        padding_mask=batch["padding_mask"],
        threshold=0.5,
    )
    print(
        "inference:",
        f"probability_real shape={tuple(probability_real.shape)}",
        f"u_pred shape={tuple(u_pred.shape)}",
        f"kept={int(keep.sum().item())}",
    )
    report["inference_smoke"] = {
        "probability_real_shape": tuple(probability_real.shape),
        "u_pred_shape": tuple(u_pred.shape),
        "kept": int(keep.sum().item()),
    }
    report_path = Path(config.report_out)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    model_path = Path(config.model_out)
    model_path.parent.mkdir(parents=True, exist_ok=True)
    torch.save({
        "model_state_dict": model.state_dict(),
        "config": asdict(config),
    }, model_path)
    print(f"report written: {report_path}")
    print(f"model written: {model_path}")


if __name__ == "__main__":
    main()
