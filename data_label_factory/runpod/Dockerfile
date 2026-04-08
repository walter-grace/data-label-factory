# Worker image for the data-label-factory RunPod path.
#
# Build:
#   docker build -t walter-grace/data-label-factory-worker:latest \
#                -f data_label_factory/runpod/Dockerfile .
#
# Push to a registry:
#   docker push walter-grace/data-label-factory-worker:latest
#
# Image is ~12 GB. First-time pull on a community pod takes 5-8 minutes.

FROM runpod/pytorch:1.0.3-cu1281-torch271-ubuntu2204

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
