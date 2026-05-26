from setuptools import setup


setup(
    name="wisc-lens",
    version="0.2.7",
    description="Reusable Python WISC wide-field star calibrator lens-model mapper",
    py_modules=["wisc_lens"],
    install_requires=["numpy"],
    python_requires=">=3.8",
    license="CC-BY-4.0",
    author="Juha Vierinen",
)
