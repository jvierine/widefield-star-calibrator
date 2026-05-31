"""Catalogue-driven synthetic dataset for star detection sets."""

from __future__ import annotations

import ast
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, TypedDict

import torch
from torch import Tensor
from torch.nn.utils.rnn import pad_sequence
from torch.utils.data import Dataset


class StarDetectionSample(TypedDict):
    detections: Tensor
    y_real: Tensor
    u_true: Tensor
    star_id: Tensor


class StarDetectionBatch(TypedDict):
    detections: Tensor
    y_real: Tensor
    u_true: Tensor
    star_id: Tensor
    valid_mask: Tensor
    padding_mask: Tensor


@dataclass(frozen=True)
class YaleStar:
    star_id: int
    ra_hours: float
    dec_deg: float
    vmag: float
    name: str
    unit: tuple[float, float, float]


@dataclass(frozen=True)
class SyntheticLensConfig:
    name: str
    width: int
    height: int
    projection: Literal["rectilinear", "fisheye"]
    fov_x_deg: float
    fov_y_deg: float
    optmod_hint: int | None = None
    source: str = "default"


@dataclass(frozen=True)
class SyntheticStarDatasetConfig:
    num_samples: int = 512
    max_vmag: float = 4.0
    catalogue_path: str = "js/star_catalog.js"
    test_cases_dir: str = "test_cases"
    drop_real_min: float = 0.10
    drop_real_max: float = 0.55
    noise_floor_min: float = 0.0008
    noise_floor_max: float = 0.004
    normalize_image_coordinates: bool = True
    photometry_mode: Literal["synthetic", "unit", "missing"] = "unit"
    output_mode: Literal["position", "shape", "all"] = "position"


def _repo_root() -> Path:
    return Path(__file__).resolve().parent


def _uniform(generator: torch.Generator, lo: float, hi: float) -> float:
    return lo + (hi - lo) * float(torch.rand((), generator=generator))


def _randint(generator: torch.Generator, lo: int, hi: int) -> int:
    return int(torch.randint(lo, hi + 1, (1,), generator=generator))


def _normalize(vector: Tensor) -> Tensor:
    return vector / (vector.norm(dim=-1, keepdim=True) + 1e-8)


def _unit_from_ra_dec(ra_hours: float, dec_deg: float) -> tuple[float, float, float]:
    ra = math.radians(15.0 * ra_hours)
    dec = math.radians(dec_deg)
    cos_dec = math.cos(dec)
    return (
        cos_dec * math.cos(ra),
        cos_dec * math.sin(ra),
        math.sin(dec),
    )


def load_yale_bright_star_catalog(
    catalogue_path: str | Path | None = None,
    max_vmag: float = 4.0,
) -> list[YaleStar]:
    """Load the embedded Yale catalogue and keep stars brighter than ``max_vmag``."""

    path = Path(catalogue_path) if catalogue_path is not None else _repo_root() / "js" / "star_catalog.js"
    if not path.is_absolute():
        path = _repo_root() / path
    source = path.read_text(encoding="utf-8")
    match = re.search(r"AIDA_STAR_CATALOG\s*=\s*(\[.*\]);", source, flags=re.S)
    if not match:
        raise ValueError(f"could not locate AIDA_STAR_CATALOG in {path}")

    rows = ast.literal_eval(match.group(1))
    stars: list[YaleStar] = []
    for star_id, row in enumerate(rows):
        ra_hours, dec_deg, vmag = float(row[0]), float(row[1]), float(row[2])
        if vmag >= max_vmag:
            continue
        name = str(row[3]) if len(row) > 3 else f"Yale {star_id}"
        stars.append(
            YaleStar(
                star_id=star_id,
                ra_hours=ra_hours,
                dec_deg=dec_deg,
                vmag=vmag,
                name=name,
                unit=_unit_from_ra_dec(ra_hours, dec_deg),
            )
        )
    return stars


def infer_lens_configs_from_test_cases(test_cases_dir: str | Path | None = None) -> list[SyntheticLensConfig]:
    """Infer broad camera families from saved ``test_cases`` metadata.

    The metadata stores image sizes and fitted optical-model vectors, but not
    explicit FOV. The inferred FOVs are intentionally coarse defaults:
    AllSky7-like 1920x1080 radial cases use about 85 x 40 degrees; square
    2832-pixel KRN cases are treated as hemispheric fisheye; phone/Brown-Conrady
    3-4k cases are treated as moderate/wide fields.
    """

    root = Path(test_cases_dir) if test_cases_dir is not None else _repo_root() / "test_cases"
    if not root.is_absolute():
        root = _repo_root() / root
    if not root.exists():
        return []

    configs: list[SyntheticLensConfig] = []
    seen: set[tuple[int, int, str]] = set()
    for metadata_path in sorted(root.glob("*/metadata.json")):
        try:
            metadata = ast.literal_eval(metadata_path.read_text(encoding="utf-8").replace("true", "True").replace("false", "False").replace("null", "None"))
        except Exception:
            import json

            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        width = int(metadata.get("width") or 0)
        height = int(metadata.get("height") or 0)
        optpar = metadata.get("optpar") or []
        optmod_hint = int(optpar[0]) if optpar else None
        if width <= 0 or height <= 0:
            continue

        if width == 1920 and height == 1080:
            config = SyntheticLensConfig(
                name="test-case-allsky7-radial-1920x1080",
                width=width,
                height=height,
                projection="rectilinear",
                fov_x_deg=85.0,
                fov_y_deg=40.0,
                optmod_hint=optmod_hint,
                source="test_cases",
            )
        elif abs(width - height) <= 4 and width >= 1800:
            config = SyntheticLensConfig(
                name=f"test-case-fisheye-{width}x{height}",
                width=width,
                height=height,
                projection="fisheye",
                fov_x_deg=180.0,
                fov_y_deg=180.0,
                optmod_hint=optmod_hint,
                source="test_cases",
            )
        elif max(width, height) >= 3000:
            long_fov = 70.0
            short_fov = 52.0
            config = SyntheticLensConfig(
                name=f"test-case-phone-wide-{width}x{height}",
                width=width,
                height=height,
                projection="rectilinear",
                fov_x_deg=long_fov if width >= height else short_fov,
                fov_y_deg=short_fov if width >= height else long_fov,
                optmod_hint=optmod_hint,
                source="test_cases",
            )
        else:
            continue

        key = (config.width, config.height, config.name)
        if key not in seen:
            seen.add(key)
            configs.append(config)
    return configs


def default_lens_configs(test_cases_dir: str | Path | None = None) -> list[SyntheticLensConfig]:
    inferred = infer_lens_configs_from_test_cases(test_cases_dir)
    defaults = [
        SyntheticLensConfig(
            name="allsky7-like-rectangular-wide-field",
            width=1920,
            height=1080,
            projection="rectilinear",
            fov_x_deg=85.0,
            fov_y_deg=40.0,
            optmod_hint=2,
            source="default",
        ),
        SyntheticLensConfig(
            name="fisheye-hemispheric",
            width=1920,
            height=1920,
            projection="fisheye",
            fov_x_deg=180.0,
            fov_y_deg=180.0,
            optmod_hint=2,
            source="default",
        ),
        SyntheticLensConfig(
            name="moderate-wide-field",
            width=1920,
            height=1080,
            projection="rectilinear",
            fov_x_deg=60.0,
            fov_y_deg=35.0,
            optmod_hint=1,
            source="default",
        ),
    ]
    return inferred or defaults


def _random_camera_basis(generator: torch.Generator) -> tuple[Tensor, Tensor, Tensor]:
    """Return right, up, forward unit vectors in celestial coordinates."""

    ra = _uniform(generator, 0.0, 2.0 * math.pi)
    dec = math.asin(_uniform(generator, -0.8, 0.8))
    forward = torch.tensor(
        [math.cos(dec) * math.cos(ra), math.cos(dec) * math.sin(ra), math.sin(dec)],
        dtype=torch.float32,
    )
    world_up = torch.tensor([0.0, 0.0, 1.0], dtype=torch.float32)
    right = torch.cross(world_up, forward, dim=0)
    if right.norm() < 1e-4:
        right = torch.tensor([1.0, 0.0, 0.0], dtype=torch.float32)
    right = _normalize(right)
    up = _normalize(torch.cross(forward, right, dim=0))

    roll = _uniform(generator, 0.0, 2.0 * math.pi)
    rolled_right = math.cos(roll) * right + math.sin(roll) * up
    rolled_up = -math.sin(roll) * right + math.cos(roll) * up
    return _normalize(rolled_right), _normalize(rolled_up), _normalize(forward)


def _project_stars(
    stars: list[YaleStar],
    lens: SyntheticLensConfig,
    generator: torch.Generator,
) -> list[tuple[float, float, YaleStar]]:
    right, up, forward = _random_camera_basis(generator)
    units = torch.tensor([star.unit for star in stars], dtype=torch.float32)
    x_cam = units @ right
    y_cam = units @ up
    z_cam = units @ forward
    width = float(lens.width)
    height = float(lens.height)
    projected: list[tuple[float, float, YaleStar]] = []

    if lens.projection == "fisheye":
        max_theta = math.radians(min(lens.fov_x_deg, lens.fov_y_deg) / 2.0)
        theta = torch.acos(torch.clamp(z_cam, -1.0, 1.0))
        phi = torch.atan2(y_cam, x_cam)
        radius = theta / max_theta * (0.5 * min(width, height))
        px = width / 2.0 + radius * torch.cos(phi)
        py = height / 2.0 - radius * torch.sin(phi)
        inside = (z_cam > 0.0) & (theta <= max_theta) & (px >= 0.0) & (px < width) & (py >= 0.0) & (py < height)
    else:
        half_x = math.radians(lens.fov_x_deg / 2.0)
        half_y = math.radians(lens.fov_y_deg / 2.0)
        ax = torch.atan2(x_cam, z_cam)
        ay = torch.atan2(y_cam, z_cam)
        px = width * (0.5 + 0.5 * ax / half_x)
        py = height * (0.5 - 0.5 * ay / half_y)
        inside = (z_cam > 0.0) & (ax.abs() <= half_x) & (ay.abs() <= half_y)

    for i in torch.nonzero(inside, as_tuple=False).flatten().tolist():
        projected.append((float(px[i]), float(py[i]), stars[i]))
    return projected


def _real_detection_for_star(
    x_pix: float,
    y_pix: float,
    star: YaleStar,
    lens: SyntheticLensConfig,
    generator: torch.Generator,
    noise_floor: float,
) -> tuple[list[float], list[float], int]:
    base_flux = 10.0 ** (-0.4 * star.vmag)
    gain = _uniform(generator, 1800.0, 7000.0)
    flux = base_flux * gain * _uniform(generator, 0.7, 1.4)
    snr = max(0.5, flux / max(noise_floor * gain, 1e-6) * _uniform(generator, 0.55, 1.35))
    sigma = _uniform(generator, 0.85, 2.4)
    if lens.projection == "fisheye":
        dx = (x_pix - lens.width / 2.0) / max(1.0, lens.width / 2.0)
        dy = (y_pix - lens.height / 2.0) / max(1.0, lens.height / 2.0)
        sigma += 0.8 * min(1.0, math.hypot(dx, dy))
    ellipticity = _uniform(generator, 1.0, 1.55)
    jitter = sigma * 0.25
    detection = [
        min(max(0.0, x_pix + _uniform(generator, -jitter, jitter)), lens.width - 1.0),
        min(max(0.0, y_pix + _uniform(generator, -jitter, jitter)), lens.height - 1.0),
        snr,
        flux,
        sigma,
        ellipticity,
    ]
    return detection, list(star.unit), star.star_id


def _false_detection(x_pix: float, y_pix: float, generator: torch.Generator, kind: str) -> list[float]:
    if kind == "hot":
        snr = _uniform(generator, 15.0, 90.0)
        flux = _uniform(generator, 50.0, 2500.0)
        sigma = _uniform(generator, 0.35, 0.9)
        ellipticity = _uniform(generator, 1.0, 1.3)
    elif kind == "trail":
        snr = _uniform(generator, 2.0, 25.0)
        flux = _uniform(generator, 20.0, 1200.0)
        sigma = _uniform(generator, 1.2, 4.5)
        ellipticity = _uniform(generator, 2.0, 8.0)
    elif kind == "edge":
        snr = _uniform(generator, 1.0, 18.0)
        flux = _uniform(generator, 10.0, 900.0)
        sigma = _uniform(generator, 0.7, 3.5)
        ellipticity = _uniform(generator, 1.0, 5.5)
    else:
        snr = _uniform(generator, 0.5, 20.0)
        flux = _uniform(generator, 3.0, 800.0)
        sigma = _uniform(generator, 0.7, 3.8)
        ellipticity = _uniform(generator, 1.0, 4.0)
    return [x_pix, y_pix, snr, flux, sigma, ellipticity]


def _add_false_detections(
    detections: list[list[float]],
    y_real: list[float],
    u_true: list[list[float]],
    star_ids: list[int],
    lens: SyntheticLensConfig,
    n_false: int,
    generator: torch.Generator,
) -> None:
    width = float(lens.width)
    height = float(lens.height)
    remaining = n_false

    n_trail_clusters = min(_randint(generator, 0, 3), remaining)
    for _ in range(n_trail_clusters):
        count = min(remaining, _randint(generator, 4, 24))
        x0 = _uniform(generator, 0.0, width)
        y0 = _uniform(generator, 0.0, height)
        angle = _uniform(generator, 0.0, 2.0 * math.pi)
        length = _uniform(generator, 0.05, 0.45) * math.hypot(width, height)
        for i in range(count):
            t = -0.5 + i / max(1, count - 1)
            x = min(max(0.0, x0 + t * length * math.cos(angle) + _uniform(generator, -3.0, 3.0)), width - 1.0)
            y = min(max(0.0, y0 + t * length * math.sin(angle) + _uniform(generator, -3.0, 3.0)), height - 1.0)
            detections.append(_false_detection(x, y, generator, "trail"))
            y_real.append(0.0)
            u_true.append([0.0, 0.0, 0.0])
            star_ids.append(-1)
        remaining -= count

    n_point_clusters = min(_randint(generator, 0, 5), remaining)
    for _ in range(n_point_clusters):
        count = min(remaining, _randint(generator, 3, 20))
        cx = _uniform(generator, 0.0, width)
        cy = _uniform(generator, 0.0, height)
        spread = _uniform(generator, 2.0, 28.0)
        for _ in range(count):
            x = min(max(0.0, cx + float(torch.randn((), generator=generator)) * spread), width - 1.0)
            y = min(max(0.0, cy + float(torch.randn((), generator=generator)) * spread), height - 1.0)
            detections.append(_false_detection(x, y, generator, "cluster"))
            y_real.append(0.0)
            u_true.append([0.0, 0.0, 0.0])
            star_ids.append(-1)
        remaining -= count

    for _ in range(remaining):
        roll = float(torch.rand((), generator=generator))
        if roll < 0.12:
            side = _randint(generator, 0, 3)
            if side == 0:
                x, y = _uniform(generator, 0.0, width), _uniform(generator, 0.0, 18.0)
            elif side == 1:
                x, y = _uniform(generator, 0.0, width), height - 1.0 - _uniform(generator, 0.0, 18.0)
            elif side == 2:
                x, y = _uniform(generator, 0.0, 18.0), _uniform(generator, 0.0, height)
            else:
                x, y = width - 1.0 - _uniform(generator, 0.0, 18.0), _uniform(generator, 0.0, height)
            kind = "edge"
        elif roll < 0.20:
            x, y = _uniform(generator, 0.0, width), _uniform(generator, 0.0, height)
            kind = "hot"
        else:
            x, y = _uniform(generator, 0.0, width), _uniform(generator, 0.0, height)
            kind = "uniform"
        detections.append(_false_detection(x, y, generator, kind))
        y_real.append(0.0)
        u_true.append([0.0, 0.0, 0.0])
        star_ids.append(-1)


class SyntheticStarDetectionDataset(Dataset[StarDetectionSample]):
    """Synthetic detections made from Yale stars with Vmag < 4.0 by default.

    By default, x and y are normalized to [0, 1] by image width/height, sigma is
    normalized by image width, and photometry is unit-scale rank information
    rather than camera-intensity scale. This keeps the model from learning
    camera-resolution or exposure artifacts when mixing saved 1920, 2832, and 4k
    case families.
    """

    def __init__(
        self,
        config: SyntheticStarDatasetConfig | None = None,
        seed: int = 1234,
        lens_configs: list[SyntheticLensConfig] | None = None,
    ) -> None:
        self.config = config or SyntheticStarDatasetConfig()
        self.seed = seed
        self.stars = load_yale_bright_star_catalog(self.config.catalogue_path, self.config.max_vmag)
        self.lens_configs = lens_configs or default_lens_configs(self.config.test_cases_dir)
        if not self.stars:
            raise ValueError("synthetic dataset needs at least one Yale star")
        if not self.lens_configs:
            raise ValueError("synthetic dataset needs at least one lens config")

    def __len__(self) -> int:
        return self.config.num_samples

    def __getitem__(self, index: int) -> StarDetectionSample:
        generator = torch.Generator().manual_seed(self.seed + index)
        lens = self.lens_configs[_randint(generator, 0, len(self.lens_configs) - 1)]
        projected: list[tuple[float, float, YaleStar]] = []
        for _ in range(30):
            projected = _project_stars(self.stars, lens, generator)
            if lens.projection == "fisheye" and len(projected) >= 25:
                break
            if lens.projection == "rectilinear" and len(projected) >= 8:
                break

        drop_rate = _uniform(generator, self.config.drop_real_min, self.config.drop_real_max)
        real_candidates = [item for item in projected if float(torch.rand((), generator=generator)) > drop_rate]
        if len(real_candidates) > 80:
            order = torch.randperm(len(real_candidates), generator=generator)[:80].tolist()
            real_candidates = [real_candidates[i] for i in order]

        noise_floor = _uniform(generator, self.config.noise_floor_min, self.config.noise_floor_max)
        detections: list[list[float]] = []
        y_real: list[float] = []
        u_true: list[list[float]] = []
        star_ids: list[int] = []
        for x_pix, y_pix, star in real_candidates:
            detection, unit, star_id = _real_detection_for_star(x_pix, y_pix, star, lens, generator, noise_floor)
            detections.append(detection)
            y_real.append(1.0)
            u_true.append(unit)
            star_ids.append(star_id)

        n_real = len(real_candidates)
        n_false_max = max(200, 5 * n_real + 200)
        n_false = _randint(generator, 0, n_false_max)
        _add_false_detections(detections, y_real, u_true, star_ids, lens, n_false, generator)

        if not detections:
            detections.append(_false_detection(lens.width / 2.0, lens.height / 2.0, generator, "hot"))
            y_real.append(0.0)
            u_true.append([0.0, 0.0, 0.0])
            star_ids.append(-1)

        if self.config.photometry_mode == "unit":
            max_flux = max((detection[3] for detection in detections), default=1.0)
            max_snr = max((detection[2] for detection in detections), default=1.0)
            for detection in detections:
                detection[2] = detection[2] / max(1e-6, max_snr)
                detection[3] = detection[3] / max(1e-6, max_flux)
        elif self.config.photometry_mode == "missing":
            for detection in detections:
                detection[2] = 0.0
                detection[3] = 0.0

        model_detections: list[list[float]] = []
        for detection in detections:
            if self.config.normalize_image_coordinates:
                x_norm = detection[0] / max(1.0, float(lens.width))
                y_norm = detection[1] / max(1.0, float(lens.height))
                sigma_norm = detection[4] / max(1.0, float(lens.width))
            else:
                x_norm = detection[0]
                y_norm = detection[1]
                sigma_norm = detection[4]
            rho = math.sqrt((x_norm - 0.5) ** 2 + (y_norm - 0.5) ** 2)
            if self.config.output_mode == "position":
                model_detections.append([x_norm, y_norm, rho])
            elif self.config.output_mode == "shape":
                model_detections.append([x_norm, y_norm, rho, detection[5]])
            else:
                model_detections.append([x_norm, y_norm, rho, detection[2], detection[3], sigma_norm, detection[5]])

        order = torch.randperm(len(detections), generator=generator)
        return {
            "detections": torch.tensor(model_detections, dtype=torch.float32)[order],
            "y_real": torch.tensor(y_real, dtype=torch.float32)[order],
            "u_true": torch.tensor(u_true, dtype=torch.float32)[order],
            "star_id": torch.tensor(star_ids, dtype=torch.long)[order],
        }


def collate_star_detections(
    samples: list[StarDetectionSample],
    shuffle_order: bool = False,
) -> StarDetectionBatch:
    """Pad variable-length detection sets for a TransformerEncoder batch."""

    ordered_samples: list[StarDetectionSample] = []
    for sample in samples:
        if not shuffle_order:
            ordered_samples.append(sample)
            continue
        order = torch.randperm(sample["detections"].shape[0])
        ordered_samples.append({
            "detections": sample["detections"][order],
            "y_real": sample["y_real"][order],
            "u_true": sample["u_true"][order],
            "star_id": sample["star_id"][order],
        })

    detections = pad_sequence([sample["detections"] for sample in ordered_samples], batch_first=True)
    y_real = pad_sequence([sample["y_real"] for sample in ordered_samples], batch_first=True)
    u_true = pad_sequence([sample["u_true"] for sample in ordered_samples], batch_first=True)
    star_id = pad_sequence(
        [sample["star_id"] for sample in ordered_samples],
        batch_first=True,
        padding_value=-1,
    )

    lengths = torch.tensor([sample["detections"].shape[0] for sample in ordered_samples], dtype=torch.long)
    max_len = detections.shape[1]
    arange = torch.arange(max_len)
    valid_mask = arange[None, :] < lengths[:, None]
    padding_mask = ~valid_mask

    return {
        "detections": detections,
        "y_real": y_real,
        "u_true": u_true,
        "star_id": star_id,
        "valid_mask": valid_mask,
        "padding_mask": padding_mask,
    }
