import json
from pathlib import Path

from setuptools import setup


ROOT = Path(__file__).resolve().parent
PROJECT_METADATA = json.loads((ROOT / "project_metadata.json").read_text(encoding="utf8"))


setup(
    name="wisc-lens",
    version="0.2.7",
    description="Reusable Python WISC wide-field star calibrator lens-model mapper",
    py_modules=["wisc_lens"],
    install_requires=["numpy"],
    python_requires=">=3.8",
    license="CC-BY-4.0",
    author=" and ".join(PROJECT_METADATA["authors"]),
)
