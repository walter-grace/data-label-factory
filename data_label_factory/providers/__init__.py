"""
providers — pluggable backend registry for data_label_factory.

Inspired by ParseBench's provider abstraction: each backend registers itself
via a decorator and implements a common interface for filter / label / verify.

Usage:
    from data_label_factory.providers import create_provider

    provider = create_provider("qwen", config={"url": "http://localhost:8291"})
    verdict, elapsed = provider.filter_image("/path/to/img.jpg", "Does this show a drone?")
    coco_anns, elapsed = provider.label_image("/path/to/img.jpg", ["drone", "cable spool"])
    ok, detail, elapsed = provider.verify_bbox("/path/to/img.jpg", [x, y, w, h], "drone")
"""

from __future__ import annotations

import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

# --------------- registry ---------------

_PROVIDER_REGISTRY: dict[str, type[Provider]] = {}


def register_provider(name: str):
    """Decorator to register a Provider subclass under *name*."""
    def decorator(cls: type[Provider]) -> type[Provider]:
        _PROVIDER_REGISTRY[name] = cls
        return cls
    return decorator


def create_provider(name: str, config: dict[str, Any] | None = None) -> Provider:
    """Instantiate a registered provider by name."""
    if name not in _PROVIDER_REGISTRY:
        available = ", ".join(sorted(_PROVIDER_REGISTRY))
        raise ValueError(f"unknown provider {name!r}; registered: {available}")
    return _PROVIDER_REGISTRY[name](config=config or {})


def list_providers() -> list[str]:
    return sorted(_PROVIDER_REGISTRY)


# --------------- result types ---------------

@dataclass
class FilterResult:
    verdict: str          # YES / NO / UNKNOWN / ERROR
    raw_answer: str       # full model response
    elapsed: float        # seconds
    confidence: float = 0.0  # 0-1 if available


@dataclass
class LabelResult:
    """One labeling pass on a single image."""
    annotations: list[dict]   # COCO-style: {bbox: [x,y,w,h], category, score, ...}
    elapsed: float
    metadata: dict = field(default_factory=dict)


@dataclass
class VerifyResult:
    verdict: str          # YES / NO / UNSURE / ERROR
    raw_answer: str
    elapsed: float
    confidence: float = 0.0


# --------------- base class ---------------

class Provider(ABC):
    """Base class all backends implement."""

    def __init__(self, config: dict[str, Any]):
        self.config = config

    @property
    @abstractmethod
    def name(self) -> str:
        """Short identifier (e.g. 'qwen', 'chandra')."""

    @property
    def capabilities(self) -> set[str]:
        """Which stages this provider supports: {'filter', 'label', 'verify'}."""
        caps = set()
        if type(self).filter_image is not Provider.filter_image:
            caps.add("filter")
        if type(self).label_image is not Provider.label_image:
            caps.add("label")
        if type(self).verify_bbox is not Provider.verify_bbox:
            caps.add("verify")
        return caps

    def status(self) -> dict[str, Any]:
        """Check if the backend is alive. Returns {'alive': bool, 'info': ...}."""
        return {"alive": False, "info": "status() not implemented"}

    def filter_image(self, image_path: str, prompt: str) -> FilterResult:
        """Image-level YES/NO classification."""
        raise NotImplementedError(f"{self.name} does not support filter")

    def label_image(self, image_path: str, queries: list[str],
                    image_wh: tuple[int, int] | None = None) -> LabelResult:
        """Bbox grounding — returns COCO-style annotations."""
        raise NotImplementedError(f"{self.name} does not support label")

    def verify_bbox(self, image_path: str, bbox: list[float],
                    query: str, prompt: str = "") -> VerifyResult:
        """Per-bbox YES/NO verification."""
        raise NotImplementedError(f"{self.name} does not support verify")


# --------------- auto-import providers on package load ---------------

from . import qwen as _qwen             # noqa: E402, F401
from . import gemma as _gemma           # noqa: E402, F401
from . import falcon as _falcon         # noqa: E402, F401
from . import chandra as _chandra       # noqa: E402, F401
from . import wilddet3d as _wd3d        # noqa: E402, F401
from . import flywheel as _flywheel     # noqa: E402, F401
from . import openrouter as _openrouter # noqa: E402, F401
