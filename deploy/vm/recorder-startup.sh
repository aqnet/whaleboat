#!/bin/bash
# Startup script for the free-tier e2-micro VM that runs the AIS recorder
# (specs/deployment-plan.md). Compute Engine runs it as root on every boot, so
# a reboot rebuilds everything: swap, Docker, secrets, and the container.
#
# Secrets are read from Secret Manager into /run (memory only) and handed to
# the container as files (*_FILE variables), so they never touch the disk.
# Logs go to Cloud Logging through Docker's gcplogs driver.
set -euo pipefail

IMAGE=us-west1-docker.pkg.dev/whaleboat/cloud-run-source-deploy/whaleboat-recorder:latest
REGISTRY=https://us-west1-docker.pkg.dev
SECRETS=/run/whaleboat-secrets

# 1 GB of RAM is tight for Docker plus Node; swap covers spikes.
if ! swapon --show | grep -q /swapfile; then
  [ -f /swapfile ] || { fallocate -l 1G /swapfile; chmod 600 /swapfile; mkswap /swapfile; }
  swapon /swapfile
fi

if ! command -v docker >/dev/null; then
  apt-get update -q
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q docker.io
  systemctl enable --now docker
fi

# Docker restarts the previous container at boot, before the secrets below
# exist. Remove it first so it isn't reading them while they are written.
docker rm -f recorder >/dev/null 2>&1 || true

# Secrets -> memory-backed files readable only by the container's user (node, uid 1000).
install -d -m 700 -o 1000 -g 1000 "$SECRETS"
for pair in aisstream-api-key:AISSTREAM_API_KEY supabase-url:SUPABASE_URL supabase-secret-key:SUPABASE_SECRET_KEY; do
  (umask 077; gcloud secrets versions access latest --secret="${pair%%:*}" > "$SECRETS/${pair##*:}")
  chown 1000:1000 "$SECRETS/${pair##*:}"
done

# Pull the image with the VM's service account.
gcloud auth print-access-token | docker login -u oauth2accesstoken --password-stdin "$REGISTRY"
docker pull -q "$IMAGE"

docker run -d --name recorder --restart=always \
  --memory=400m \
  -v "$SECRETS:/secrets:ro" \
  -e AISSTREAM_API_KEY_FILE=/secrets/AISSTREAM_API_KEY \
  -e SUPABASE_URL_FILE=/secrets/SUPABASE_URL \
  -e SUPABASE_SECRET_KEY_FILE=/secrets/SUPABASE_SECRET_KEY \
  --log-driver=gcplogs --log-opt gcp-log-cmd=false \
  "$IMAGE"

docker image prune -f >/dev/null
