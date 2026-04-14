"""Compatibility shim for older pip versions that can't read pyproject.toml."""

from setuptools import setup, find_packages

setup(
    name="data-label-factory",
    version="0.2.0",
    description="Generic auto-labeling pipeline for vision datasets.",
    packages=find_packages(),
    python_requires=">=3.9",
    install_requires=[
        "pyyaml>=6.0",
        "pillow>=9.0",
        "requests>=2.28",
    ],
    entry_points={
        "console_scripts": [
            "data_label_factory=data_label_factory.cli:main",
            "data-label-factory=data_label_factory.cli:main",
        ],
    },
)
