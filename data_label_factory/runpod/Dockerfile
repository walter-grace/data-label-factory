# Worker image for the data-label-factory RunPod path.
#
# IMPORTANT: build context MUST be the repo root, not this folder.
#   cd /path/to/data-label-factory
#   docker build -t walter-grace/data-label-factory-worker:latest \
#                -f data_label_factory/runpod/Dockerfile .
#
# Push to a registry:
#   docker push walter-grace/data-label-factory-worker:latest
#
# Image is ~12 GB. First-time pull on a community pod takes 5-8 minutes.
# The runpod/pytorch base image ships torch 2.7.1+cu128 which we deliberately
# preserve — falcon-perception is installed --no-deps to avoid forcing a
# 2-3 GB torch upgrade.

# Use the cu12.9.0 + torch 2.9.1 base — falcon-perception's runtime is
# proven to work against this combo (per the original drone-labeling run on
# RunPod L40S in the auto-research workspace).
FROM runpod/pytorch:1.0.3-cu1290-torch291-ubuntu2204

LABEL org.opencontainers.image.source="https://github.com/walter-grace/data-label-factory"
LABEL org.opencontainers.image.description="GPU worker for data-label-factory"
LABEL org.opencontainers.image.licenses="Apache-2.0"

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/workspace/.hf \
    TRANSFORMERS_CACHE=/workspace/.hf

# System deps
RUN apt-get update && apt-get install -y --no-install-recommends \
        git \
        rsync \
        openssh-server \
        ffmpeg \
        libgl1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# Pin python deps for the pod side. We don't reuse the local pyproject.toml
# `[runpod]` extra because the pod doesn't need the orchestration deps —
# it needs the heavy ML deps that we DON'T install locally on the Mac.
COPY data_label_factory/runpod/requirements-pod.txt /tmp/requirements-pod.txt
RUN pip install --upgrade pip && \
    pip install -r /tmp/requirements-pod.txt

# Falcon Perception goes in separately with --no-deps so its torch>=2.11
# pin doesn't force a 2-3 GB upgrade of the base image's torch 2.7.1+cu128.
# Its actual runtime deps are already pinned in requirements-pod.txt above.
RUN pip install --no-deps falcon-perception

# Install the data_label_factory package itself
COPY pyproject.toml setup.py README.md /tmp/dlf/
COPY data_label_factory/ /tmp/dlf/data_label_factory/
RUN pip install /tmp/dlf

# Sanity check the install
RUN data_label_factory --help

# Pre-create the workspace layout the orchestration CLI expects
RUN mkdir -p /workspace/projects /workspace/data /workspace/experiments

# Default command — most invocations will exec into this container with their
# own command via SSH or `docker exec`. The serverless variant overrides this
# with `python3 -m data_label_factory.runpod.handler`.
CMD ["bash", "-c", "echo 'data-label-factory worker ready'; sleep infinity"]
