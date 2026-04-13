"""data_label_factory — generic auto-labeling pipeline for vision datasets.

Public API:
    load_project(path)         → ProjectConfig
    ProjectConfig              → loaded project YAML with helpers

CLI entry point: `data_label_factory` (defined in pyproject.toml).
"""

from .project import load_project, ProjectConfig

__version__ = "0.2.0"
__all__ = ["load_project", "ProjectConfig", "__version__"]
