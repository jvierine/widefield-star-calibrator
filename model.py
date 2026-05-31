"""Transformer model for identifying stars from unordered detection lists."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Optional

import torch
from torch import Tensor, nn


@dataclass(frozen=True)
class ImageGeometry:
    """Pixel coordinate normalization parameters."""

    cx: float
    cy: float
    radius: float


class StarDetectionTransformer(nn.Module):
    """Set-style TransformerEncoder for per-detection star classification and direction.

    The default input is shaped ``[B, N, 3]`` with columns:
    ``[x_norm, y_norm, rho]`` where ``x_norm = x_pix / width``,
    ``y_norm = y_pix / height``, and
    ``rho = sqrt((x_norm - 0.5)^2 + (y_norm - 0.5)^2)``.

    Extended detections can still be used with ``feature_mode="all"``:
    ``[x_norm, y_norm, rho, snr, flux, sigma_norm, ellipticity]``.

    The model deliberately does not add sequence-index positional encodings because
    detections are an unordered set.
    """

    def __init__(
        self,
        geometry: ImageGeometry,
        feature_mode: Literal["position", "shape", "all"] = "position",
        d_model: int = 128,
        nhead: int = 8,
        num_layers: int = 4,
        dim_feedforward: int = 256,
        dropout: float = 0.1,
    ) -> None:
        super().__init__()
        if geometry.radius <= 0:
            raise ValueError("geometry.radius must be positive")

        self.register_buffer("cx", torch.tensor(float(geometry.cx)), persistent=False)
        self.register_buffer("cy", torch.tensor(float(geometry.cy)), persistent=False)
        self.register_buffer("radius", torch.tensor(float(geometry.radius)), persistent=False)
        self.feature_mode = feature_mode
        if feature_mode == "position":
            input_features = 3
        elif feature_mode == "shape":
            input_features = 4
        elif feature_mode == "all":
            input_features = 7
        else:
            raise ValueError(f"unknown feature_mode: {feature_mode}")

        self.embed = nn.Sequential(
            nn.Linear(input_features, d_model),
            nn.GELU(),
            nn.LayerNorm(d_model),
            nn.Linear(d_model, d_model),
            nn.GELU(),
        )
        encoder_layer = nn.TransformerEncoderLayer(
            d_model=d_model,
            nhead=nhead,
            dim_feedforward=dim_feedforward,
            dropout=dropout,
            batch_first=True,
            activation="gelu",
        )
        self.encoder = nn.TransformerEncoder(encoder_layer, num_layers=num_layers)
        self.real_head = nn.Linear(d_model, 1)
        self.direction_head = nn.Linear(d_model, 3)

    def normalize_features(self, detections: Tensor) -> Tensor:
        """Convert raw detection columns to normalized token features.

        ``feature_mode="position"`` uses provided normalized
        ``[x_norm, y_norm, rho]`` and is the safest first experiment.
        ``feature_mode="shape"`` adds ellipticity. ``feature_mode="all"`` adds
        log-SNR, log-flux, sigma_norm, and ellipticity.
        """

        x_norm = detections[..., 0]
        y_norm = detections[..., 1]
        x = (x_norm - self.cx) / self.radius
        y = (y_norm - self.cy) / self.radius
        supplied_rho = detections[..., 2]
        if self.feature_mode == "position":
            return torch.stack([x, y, supplied_rho], dim=-1)

        rho = supplied_rho
        ellipticity = torch.nan_to_num(detections[..., 3], nan=1.0, posinf=1.0, neginf=1.0)
        if self.feature_mode == "shape":
            return torch.stack([x, y, rho, ellipticity], dim=-1)

        snr = torch.nan_to_num(detections[..., 3], nan=0.0, posinf=0.0, neginf=0.0)
        flux = torch.nan_to_num(detections[..., 4], nan=0.0, posinf=0.0, neginf=0.0)
        sigma = torch.nan_to_num(detections[..., 5], nan=0.0, posinf=0.0, neginf=0.0)
        ellipticity = torch.nan_to_num(detections[..., 6], nan=1.0, posinf=1.0, neginf=1.0)
        log_snr = torch.log1p(torch.clamp(snr, min=0.0))
        log_flux = torch.log1p(torch.clamp(flux, min=0.0))
        sigma_norm = sigma / self.radius
        return torch.stack([x, y, rho, log_snr, log_flux, sigma_norm, ellipticity], dim=-1)

    def forward(
        self,
        detections: Tensor,
        padding_mask: Optional[Tensor] = None,
    ) -> tuple[Tensor, Tensor]:
        """Run inference.

        Args:
            detections: ``[B, N, 3]`` normalized position features by default.
            padding_mask: optional bool tensor ``[B, N]`` where True marks padding.

        Returns:
            ``real_logit`` shaped ``[B, N]`` and normalized ``unit_vector`` shaped
            ``[B, N, 3]``.
        """

        token_features = self.normalize_features(detections)
        embedded = self.embed(token_features)
        encoded = self.encoder(embedded, src_key_padding_mask=padding_mask)
        real_logit = self.real_head(encoded).squeeze(-1)
        unit_vector_raw = self.direction_head(encoded)
        unit_vector = unit_vector_raw / (unit_vector_raw.norm(dim=-1, keepdim=True) + 1e-8)
        return real_logit, unit_vector


@torch.no_grad()
def predict_stars(
    model: StarDetectionTransformer,
    detections: Tensor,
    padding_mask: Optional[Tensor] = None,
    threshold: float = 0.5,
) -> tuple[Tensor, Tensor, Tensor]:
    """Return probability, predicted unit vectors, and keep mask for inference."""

    model.eval()
    real_logit, u_pred = model(detections, padding_mask=padding_mask)
    probability_real = torch.sigmoid(real_logit)
    keep = probability_real > threshold
    if padding_mask is not None:
        keep = keep & ~padding_mask
    return probability_real, u_pred, keep
