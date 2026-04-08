#!/usr/bin/env python3
"""
data_label_factory.runpod — orchestration CLI for the optional GPU path.

Provisions a RunPod GPU pod, runs the data_label_factory pipeline on it,
pulls results back, and (optionally) publishes the labeled dataset to
Hugging Face — all in one place.

Subcommands
-----------
  up         Provision a GPU pod
  push       Copy a project YAML + image manifest to the pod
  run        Execute a shell command on the pod
  pull       Download an experiment dir from the pod
  publish    Push a labeled experiment to a Hugging Face dataset repo
  down       Destroy the pod
  pipeline   One-shot: up → push → run → pull → publish → down

  build         Build the worker Docker image
  serverless    Manage RunPod serverless endpoints (create / test / destroy)

Usage
-----
    export RUNPOD_API_KEY=rpa_xxxxxxxxxx
    python3 -m data_label_factory.runpod pipeline \\
        --project projects/drones.yaml \\
        --gpu L40S \\
        --publish-to waltgrace/my-drone-dataset

See README.md in this folder for architecture, costs, and trade-offs.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

# ---------- lazy SDK imports ----------
# We deliberately do NOT import `runpod` or `huggingface_hub` at module load,
# so a user who runs `data_label_factory ...` (without ever touching the
# runpod path) doesn't pay the import cost or get an ImportError if they
# haven't installed the optional deps.

def _runpod_sdk():
    try:
        import runpod  # type: ignore
    except ImportError:
        raise SystemExit(
            "the `runpod` package is not installed. install it with:\n"
            "    pip install -e \".[runpod]\"\n"
            "or directly: pip install runpod"
        )
    api_key = os.environ.get("RUNPOD_API_KEY")
    if not api_key:
        raise SystemExit(
            "RUNPOD_API_KEY is not set in your environment. get one at\n"
            "    https://runpod.io/console/user/settings\n"
            "then: export RUNPOD_API_KEY=rpa_xxxxxxxxxx"
        )
    runpod.api_key = api_key
    return runpod


def _hf_api(token: Optional[str] = None):
    try:
        from huggingface_hub import HfApi  # type: ignore
    except ImportError:
        raise SystemExit(
            "the `huggingface_hub` package is not installed. install it with:\n"
            "    pip install -e \".[runpod]\"\n"
            "or directly: pip install huggingface_hub"
        )
    return HfApi(token=token or os.environ.get("HF_TOKEN"))


# ---------- pod state file ----------
# Tracks the currently active pod so subcommands like `push` and `run` can
# find it without the user having to copy/paste pod IDs around.
STATE_DIR = Path(os.path.expanduser("~/.data-label-factory"))
STATE_FILE = STATE_DIR / "active-pod.json"


def _save_state(pod_info: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(pod_info, indent=2))


def _load_state() -> Optional[dict]:
    if not STATE_FILE.exists():
        return None
    try:
        return json.loads(STATE_FILE.read_text())
    except Exception:
        return None


def _clear_state() -> None:
    if STATE_FILE.exists():
        STATE_FILE.unlink()


# ---------- ssh helpers ----------
# RunPod pods expose SSH via a public proxy. We shell out to `ssh` rather
# than using paramiko so users can rely on their existing ~/.ssh/config.

def _ssh_command(pod: dict) -> list[str]:
    """Build the ssh command list for a given pod's runtime info."""
    host = pod.get("ssh_host")
    user = pod.get("ssh_user", "root")
    port = pod.get("ssh_port", 22)
    if not host:
        raise SystemExit(
            "pod has no SSH host yet — wait a few seconds for it to finish booting "
            "and run `python3 -m data_label_factory.runpod up --refresh` to update."
        )
    return [
        "ssh", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
        "-p", str(port), f"{user}@{host}",
    ]


def _scp_command(pod: dict) -> list[str]:
    host = pod.get("ssh_host")
    user = pod.get("ssh_user", "root")
    port = pod.get("ssh_port", 22)
    return [
        "scp", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
        "-P", str(port),
    ]


def _run_remote(pod: dict, command: str, *, capture: bool = False) -> subprocess.CompletedProcess:
    full = _ssh_command(pod) + [command]
    print(f"$ {shlex.join(full)}", file=sys.stderr)
    return subprocess.run(full, capture_output=capture, text=capture)


# ============================================================
# SUBCOMMANDS
# ============================================================

def cmd_up(args):
    """Provision a GPU pod."""
    runpod = _runpod_sdk()

    print(f"provisioning {args.gpu} pod ({args.gpu_count}x) using image {args.image}…")
    pod = runpod.create_pod(
        name=args.name,
        image_name=args.image,
        gpu_type_id=args.gpu,
        gpu_count=args.gpu_count,
        cloud_type=args.cloud,
        volume_in_gb=args.disk_gb,
        container_disk_in_gb=20,
        ports="22/tcp,8000/http",
        env={
            "HF_TOKEN":   os.environ.get("HF_TOKEN", ""),
            "QWEN_URL":   os.environ.get("QWEN_URL", ""),
            "GEMMA_URL":  os.environ.get("GEMMA_URL", ""),
        },
        volume_mount_path="/workspace",
        network_volume_id=args.network_volume,
    )
    pod_id = pod["id"]
    print(f"  pod id: {pod_id}")
    print(f"  waiting for pod to become ready (may take 1-5 minutes)…")

    # Poll until SSH is reachable
    info = {}
    for attempt in range(60):
        try:
            full = runpod.get_pod(pod_id)
        except Exception as e:
            print(f"  poll {attempt}: {e}")
            time.sleep(5)
            continue
        runtime = full.get("runtime") or {}
        ports = runtime.get("ports") or []
        ssh_port_info = next((p for p in ports if p.get("privatePort") == 22), None)
        if ssh_port_info and ssh_port_info.get("publicPort"):
            info = {
                "pod_id":   pod_id,
                "ssh_host": ssh_port_info["ip"],
                "ssh_port": ssh_port_info["publicPort"],
                "ssh_user": "root",
                "gpu":      args.gpu,
                "image":    args.image,
                "started":  time.time(),
            }
            break
        time.sleep(5)
    else:
        raise SystemExit("timed out waiting for pod to expose SSH")

    _save_state(info)
    print(f"  ready: ssh -p {info['ssh_port']} root@{info['ssh_host']}")
    print(f"  state cached at {STATE_FILE}")


def cmd_push(args):
    """Copy a project YAML (and optionally a local image dir) to the pod."""
    pod = _load_state()
    if not pod:
        raise SystemExit("no active pod. run `up` first.")

    project_path = Path(args.project)
    if not project_path.exists():
        raise SystemExit(f"project not found: {project_path}")

    # 1. Make sure the remote workspace exists
    _run_remote(pod, "mkdir -p /workspace/projects /workspace/data /workspace/experiments")

    # 2. SCP the project YAML
    scp = _scp_command(pod)
    dest = f"root@{pod['ssh_host']}:/workspace/projects/{project_path.name}"
    print(f"$ scp {project_path} → {dest}")
    subprocess.run(scp + [str(project_path), dest], check=True)

    # 3. Optionally rsync local image dir
    if args.images:
        images_dir = Path(args.images).expanduser()
        if not images_dir.exists():
            raise SystemExit(f"images dir not found: {images_dir}")
        print(f"$ rsync -avz {images_dir}/ → root@{pod['ssh_host']}:/workspace/data/")
        rsync_cmd = [
            "rsync", "-avz",
            "-e", f"ssh -p {pod['ssh_port']} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null",
            f"{images_dir}/",
            f"root@{pod['ssh_host']}:/workspace/data/",
        ]
        subprocess.run(rsync_cmd, check=True)

    print(f"  pushed {project_path.name} to /workspace/projects/")


def cmd_run(args):
    """Run an arbitrary command on the pod."""
    pod = _load_state()
    if not pod:
        raise SystemExit("no active pod. run `up` first.")
    cmd = args.command or "data_label_factory --help"
    result = _run_remote(pod, f"cd /workspace && {cmd}")
    sys.exit(result.returncode)


def cmd_pull(args):
    """Download an experiment directory from the pod back to your machine."""
    pod = _load_state()
    if not pod:
        raise SystemExit("no active pod. run `up` first.")
    name = args.experiment
    local_target = Path(args.out).expanduser()
    local_target.mkdir(parents=True, exist_ok=True)

    rsync_cmd = [
        "rsync", "-avz",
        "-e", f"ssh -p {pod['ssh_port']} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null",
        f"root@{pod['ssh_host']}:/workspace/experiments/{name}/",
        str(local_target / name) + "/",
    ]
    print(f"$ {shlex.join(rsync_cmd)}")
    subprocess.run(rsync_cmd, check=True)
    print(f"  pulled {name} → {local_target / name}")


def cmd_publish(args):
    """Push a labeled experiment to a Hugging Face dataset repo.
    Reuses the same Parquet builder as the local path so the schema matches
    the reference dataset at waltgrace/fiber-optic-drones.
    """
    api = _hf_api(token=args.hf_token)
    exp_dir = Path(args.experiment).expanduser()
    if not exp_dir.exists():
        raise SystemExit(f"experiment dir not found: {exp_dir}")

    # Find the COCO + verified files in the experiment dir
    coco = _find_one(exp_dir, "*.coco.json", "label_falcon")
    verified = _find_one(exp_dir, "*verified*.json", "verify_qwen")
    if not coco:
        raise SystemExit(
            f"no COCO JSON found in {exp_dir}. did the label stage finish?"
        )

    print(f"  COCO:     {coco}")
    print(f"  verified: {verified or '(none — using raw Falcon labels)'}")

    # Lazy import — pyarrow / datasets is heavy
    from .builder import build_parquet_from_experiment
    parquet_path = build_parquet_from_experiment(coco, verified, exp_dir / "data.parquet")
    print(f"  built parquet: {parquet_path} ({parquet_path.stat().st_size / 1024 / 1024:.1f} MB)")

    repo_id = args.to
    print(f"  creating HF dataset repo: {repo_id}")
    from huggingface_hub import create_repo
    create_repo(repo_id, repo_type="dataset", private=args.private, exist_ok=True,
                token=os.environ.get("HF_TOKEN"))

    print(f"  uploading parquet…")
    api.upload_file(
        repo_id=repo_id,
        repo_type="dataset",
        path_or_fileobj=str(parquet_path),
        path_in_repo="data.parquet",
        commit_message=f"add data.parquet from {exp_dir.name}",
    )

    # Auto-generate a minimal dataset card if one doesn't exist yet
    if args.card:
        print(f"  uploading dataset card…")
        api.upload_file(
            repo_id=repo_id, repo_type="dataset",
            path_or_fileobj=args.card, path_in_repo="README.md",
            commit_message="add dataset card",
        )

    print(f"  ✓ published → https://huggingface.co/datasets/{repo_id}")


def cmd_down(args):
    """Destroy the active pod."""
    runpod = _runpod_sdk()
    pod = _load_state()
    if not pod:
        raise SystemExit("no active pod to destroy.")
    pod_id = pod["pod_id"]
    print(f"terminating pod {pod_id}…")
    runpod.terminate_pod(pod_id)
    _clear_state()
    print(f"  done. uptime: {(time.time() - pod.get('started', time.time())) / 60:.1f} minutes")


def cmd_pipeline(args):
    """One-shot: up → push → run → pull → publish → down."""
    print("=" * 60)
    print("ONE-SHOT RUNPOD PIPELINE")
    print("=" * 60)

    cmd_up(args)
    cmd_push(args)

    # Run the data_label_factory pipeline on the pod
    project_name = Path(args.project).name
    args.command = (
        f"data_label_factory pipeline --project /workspace/projects/{project_name} "
        f"--max-per-query {args.max_per_query} --backend qwen"
    )
    cmd_run(args)

    # Pull the latest experiment
    args.experiment = "latest"
    args.out = str(Path.cwd() / "experiments")
    cmd_pull(args)

    if args.publish_to:
        args.experiment = str(Path(args.out) / "latest")
        args.to = args.publish_to
        args.card = None
        args.private = False
        args.hf_token = os.environ.get("HF_TOKEN")
        cmd_publish(args)

    if not args.keep_pod:
        cmd_down(args)
    else:
        print("--keep-pod set; pod left running. terminate with `down` when done.")


def cmd_build(args):
    """Build the worker Docker image (and optionally push to a registry)."""
    here = Path(__file__).parent
    dockerfile = here / "Dockerfile"
    if not dockerfile.exists():
        raise SystemExit(f"Dockerfile not found at {dockerfile}")
    print(f"building image {args.tag} from {dockerfile}…")
    subprocess.run(
        ["docker", "build", "-t", args.tag, "-f", str(dockerfile), str(here)],
        check=True,
    )
    if args.push:
        print(f"pushing {args.tag}…")
        subprocess.run(["docker", "push", args.tag], check=True)
    print("done.")


def cmd_serverless(args):
    """Manage RunPod serverless endpoints."""
    runpod = _runpod_sdk()
    if args.serverless_action == "create":
        print(f"creating serverless endpoint for image {args.image}…")
        endpoint = runpod.create_endpoint(
            name=args.name,
            template_id=None,
            gpu_ids=args.gpu,
            workers_min=args.workers_min,
            workers_max=args.workers_max,
            idle_timeout=args.idle_timeout,
            execution_timeout_ms=300_000,
        )
        print(f"  ✓ endpoint id: {endpoint.get('id')}")
        print(f"  url: https://api.runpod.ai/v2/{endpoint.get('id')}/runsync")
    elif args.serverless_action == "test":
        endpoint_id = args.endpoint
        if not endpoint_id:
            raise SystemExit("--endpoint <id> required")
        import base64, urllib.request, json as _json
        with open(args.image_path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode()
        payload = {"input": {"image_base64": b64, "query": args.query, "task": "segmentation"}}
        url = f"https://api.runpod.ai/v2/{endpoint_id}/runsync"
        req = urllib.request.Request(
            url,
            data=_json.dumps(payload).encode(),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {os.environ['RUNPOD_API_KEY']}",
            },
        )
        with urllib.request.urlopen(req, timeout=300) as r:
            print(_json.dumps(_json.loads(r.read()), indent=2))
    elif args.serverless_action == "destroy":
        endpoint_id = args.endpoint
        runpod.delete_endpoint(endpoint_id)
        print(f"  destroyed {endpoint_id}")
    else:
        raise SystemExit(f"unknown serverless action: {args.serverless_action}")


# ---------- helpers ----------

def _find_one(root: Path, pattern: str, hint_subdir: str = "") -> Optional[Path]:
    """Find one matching file under root. Prefer files inside hint_subdir."""
    if hint_subdir:
        hint = root / hint_subdir
        if hint.exists():
            for p in hint.rglob(pattern):
                return p
    for p in root.rglob(pattern):
        return p
    return None


# ============================================================
# MAIN
# ============================================================

def main():
    p = argparse.ArgumentParser(
        prog="python3 -m data_label_factory.runpod",
        description=(
            "Optional GPU path for data-label-factory via RunPod. "
            "Provision a pod, run the pipeline, pull results, optionally "
            "publish to Hugging Face. See README.md in this folder for the "
            "full architecture and cost notes."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = p.add_subparsers(dest="command", required=True)

    def add_up_args(parser):
        parser.add_argument("--gpu", default="L40S", help="GPU type (e.g. L40S, RTX_A4000, RTX_4090)")
        parser.add_argument("--gpu-count", type=int, default=1)
        parser.add_argument("--cloud", choices=["SECURE", "COMMUNITY"], default="COMMUNITY",
                            help="COMMUNITY is cheaper but slower to start")
        parser.add_argument("--name", default="dlf-pod")
        parser.add_argument("--image", default="walter-grace/data-label-factory-worker:latest",
                            help="Docker image to run on the pod")
        parser.add_argument("--disk-gb", type=int, default=50)
        parser.add_argument("--network-volume", default=None,
                            help="Optional persistent volume id (use for repeated runs)")

    sup = sub.add_parser("up", help="Provision a GPU pod")
    add_up_args(sup)

    spu = sub.add_parser("push", help="Copy project YAML + images to pod")
    spu.add_argument("--project", required=True, help="Path to a project YAML")
    spu.add_argument("--images", default=None, help="Optional local image dir to rsync")

    sr = sub.add_parser("run", help="Run a shell command on the pod")
    sr.add_argument("--command", default=None, help="Shell command (defaults to `data_label_factory --help`)")

    spl = sub.add_parser("pull", help="Download an experiment from the pod")
    spl.add_argument("--experiment", default="latest", help="Experiment dir name (or 'latest')")
    spl.add_argument("--out", default="./experiments", help="Local destination")

    spb = sub.add_parser("publish", help="Publish an experiment to a HF dataset repo")
    spb.add_argument("--experiment", required=True, help="Local experiment dir to publish")
    spb.add_argument("--to", required=True, help="HF repo id, e.g. waltgrace/my-dataset")
    spb.add_argument("--private", action="store_true")
    spb.add_argument("--hf-token", default=None)
    spb.add_argument("--card", default=None, help="Path to a README.md to use as the dataset card")

    sd = sub.add_parser("down", help="Destroy the active pod")

    spi = sub.add_parser("pipeline", help="One-shot: up → push → run → pull → publish → down")
    add_up_args(spi)
    spi.add_argument("--project", required=True)
    spi.add_argument("--images", default=None)
    spi.add_argument("--max-per-query", type=int, default=30)
    spi.add_argument("--publish-to", default=None, help="HF repo id to publish results to")
    spi.add_argument("--keep-pod", action="store_true",
                     help="Don't destroy the pod when done (you'll be billed for idle time)")

    sb = sub.add_parser("build", help="Build the worker Docker image")
    sb.add_argument("--tag", default="walter-grace/data-label-factory-worker:latest")
    sb.add_argument("--push", action="store_true", help="Push to registry after building")

    ss = sub.add_parser("serverless", help="Manage RunPod serverless endpoints")
    ss_sub = ss.add_subparsers(dest="serverless_action", required=True)
    ss_create = ss_sub.add_parser("create")
    ss_create.add_argument("--image", required=True)
    ss_create.add_argument("--name", default="dlf-serverless")
    ss_create.add_argument("--gpu", default="NVIDIA RTX A4000")
    ss_create.add_argument("--workers-min", type=int, default=0)
    ss_create.add_argument("--workers-max", type=int, default=3)
    ss_create.add_argument("--idle-timeout", type=int, default=5)
    ss_test = ss_sub.add_parser("test")
    ss_test.add_argument("--endpoint", required=True)
    ss_test.add_argument("--image-path", required=True)
    ss_test.add_argument("--query", required=True)
    ss_destroy = ss_sub.add_parser("destroy")
    ss_destroy.add_argument("--endpoint", required=True)

    args = p.parse_args()
    handlers = {
        "up":         cmd_up,
        "push":       cmd_push,
        "run":        cmd_run,
        "pull":       cmd_pull,
        "publish":    cmd_publish,
        "down":       cmd_down,
        "pipeline":   cmd_pipeline,
        "build":      cmd_build,
        "serverless": cmd_serverless,
    }
    handler = handlers.get(args.command)
    if handler is None:
        p.print_help()
        sys.exit(1)
    handler(args)


if __name__ == "__main__":
    main()
