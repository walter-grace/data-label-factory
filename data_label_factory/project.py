"""
project.py — load and validate a project YAML for the data labeling factory.

Usage:
    from project import load_project
    proj = load_project("projects/drones.yaml")
    print(proj.target_object)            # "fiber optic drone"
    print(proj.bucket_queries["positive/fiber_spool_drone"])  # list of queries
    print(proj.prompt("filter"))         # templated string with {target_object} substituted
    print(proj.r2_key("raw", "positive/fiber_spool_drone/foo.jpg"))  # raw_v2/positive/...

The project loader is the SINGLE source of truth for paths, prompts, queries, and
backends. All scripts (gather, filter, label, verify) read from this object instead
of having hardcoded values.
"""

from __future__ import annotations
import os
from dataclasses import dataclass, field
from typing import Any

try:
    import yaml
except ImportError:
    raise SystemExit("PyYAML required: pip install pyyaml")


# Default prompt templates. Override in the project YAML's `prompts:` section.
DEFAULT_PROMPTS = {
    "filter": (
        "Look at this image. Does it show a {target_object} or a related object "
        "(its components, parts, or accessories)?\n"
        "Answer with exactly one word: YES or NO.\n"
        "YES if the main subject is a {target_object} or directly relevant to it.\n"
        "NO if the main subject is unrelated."
    ),
    "verify": (
        "Look carefully at this image crop. "
        "Question: Is the main object in this crop actually a {query}? "
        "Answer first with one word: YES, NO, or UNSURE. "
        "Then briefly say what the object actually is in 5-10 words."
    ),
    "label_describe": (
        "Look at this image. If it shows a {target_object} or related object, "
        "describe what you see in 1-2 sentences. "
        "If it doesn't, say 'no {target_object}'."
    ),
}


@dataclass
class ProjectConfig:
    """Loaded project YAML, with helpers."""

    project_name: str
    target_object: str
    description: str
    data_root: str
    r2_bucket: str
    r2_raw_prefix: str
    r2_labels_prefix: str
    r2_reviews_prefix: str
    bucket_queries: dict[str, list[str]]
    falcon_queries: list[str]
    prompts_raw: dict[str, str]
    backends: dict[str, str]
    pod_config: dict[str, Any]
    raw: dict[str, Any] = field(default_factory=dict)

    # ---------- helpers ----------

    def prompt(self, name: str, **extra) -> str:
        """Get a prompt template with {target_object} (and any extras) substituted."""
        template = self.prompts_raw.get(name) or DEFAULT_PROMPTS.get(name)
        if template is None:
            raise KeyError(f"unknown prompt name: {name!r}")
        ctx = {"target_object": self.target_object, **extra}
        return template.format(**ctx)

    def r2_key(self, kind: str, *parts: str) -> str:
        """Build an R2 object key for a given stage.
        kind ∈ {raw, labels, reviews, dataset}
        """
        if kind == "raw":
            return self.r2_raw_prefix.rstrip("/") + "/" + "/".join(parts)
        if kind == "labels":
            return self.r2_labels_prefix.rstrip("/") + "/" + "/".join(parts)
        if kind == "reviews":
            return self.r2_reviews_prefix
        raise KeyError(f"unknown r2 kind: {kind}")

    def local_image_dir(self) -> str:
        """Resolved local image cache directory."""
        return os.path.expanduser(self.data_root)

    def all_buckets(self) -> list[str]:
        return list(self.bucket_queries.keys())

    def total_query_count(self) -> int:
        return sum(len(v) for v in self.bucket_queries.values())

    def backend_for(self, stage: str) -> str:
        return self.backends.get(stage, "qwen")


def load_project(path: str) -> ProjectConfig:
    """Load + validate a project YAML."""
    path = os.path.expanduser(path)
    with open(path) as f:
        data = yaml.safe_load(f)

    if not isinstance(data, dict):
        raise ValueError(f"project YAML must be a mapping, got {type(data).__name__}")

    required = ["project_name", "target_object", "buckets", "falcon_queries"]
    for k in required:
        if k not in data:
            raise ValueError(f"project YAML missing required field: {k}")

    # Buckets normalization
    bucket_queries = {}
    for bucket, spec in data["buckets"].items():
        if isinstance(spec, list):
            bucket_queries[bucket] = spec
        elif isinstance(spec, dict) and "queries" in spec:
            bucket_queries[bucket] = spec["queries"]
        else:
            raise ValueError(f"bucket {bucket!r} must be a list or dict with 'queries'")

    r2 = data.get("r2", {})
    backends = data.get("backends", {})
    backends.setdefault("filter", "qwen")
    backends.setdefault("label", "pod")
    backends.setdefault("verify", "pod")

    return ProjectConfig(
        project_name=data["project_name"],
        target_object=data["target_object"],
        description=data.get("description", ""),
        data_root=data.get("data_root", "~/data-label-factory/" + data["project_name"]),
        r2_bucket=r2.get("bucket", data["project_name"]),
        r2_raw_prefix=r2.get("raw_prefix", "raw/"),
        r2_labels_prefix=r2.get("labels_prefix", "labels/"),
        r2_reviews_prefix=r2.get("reviews_prefix", "labels/reviews.json"),
        bucket_queries=bucket_queries,
        falcon_queries=list(data["falcon_queries"]),
        prompts_raw=data.get("prompts") or {},
        backends=backends,
        pod_config=data.get("pod", {}),
        raw=data,
    )


# CLI: load + dump for inspection
if __name__ == "__main__":
    import sys
    import json
    if len(sys.argv) < 2:
        print("usage: python3 project.py <project.yaml>")
        sys.exit(1)
    proj = load_project(sys.argv[1])
    print("=" * 60)
    print(f"Project: {proj.project_name}")
    print("=" * 60)
    print(f"  target_object:    {proj.target_object!r}")
    print(f"  data_root:        {proj.local_image_dir()}")
    print(f"  r2_bucket:        {proj.r2_bucket}")
    print(f"  r2 raw prefix:    {proj.r2_raw_prefix}")
    print(f"  buckets ({len(proj.bucket_queries)}):")
    for b, qs in proj.bucket_queries.items():
        print(f"    {b:40s} {len(qs)} queries")
    print(f"  falcon_queries:   {proj.falcon_queries}")
    print(f"  backends:         {proj.backends}")
    print(f"  total_queries:    {proj.total_query_count()}")
    print(f"\n  Sample filter prompt:")
    print(f"    {proj.prompt('filter')[:250]}")
