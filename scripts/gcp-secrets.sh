#!/usr/bin/env bash
# Copy the keys in .env.local into Google Secret Manager (specs/deployment-plan.md, Phase 1).
#
#   bash scripts/gcp-secrets.sh
#
# Values go straight from the file to gcloud on stdin: nothing is printed or
# put on a command line. Safe to re-run: an existing secret gets a new version.
set -euo pipefail
cd "$(dirname "$0")/.."

for pair in aisstream-api-key:AISSTREAM_API_KEY supabase-url:SUPABASE_URL supabase-secret-key:SUPABASE_SECRET_KEY; do
  name=${pair%%:*}
  var=${pair##*:}
  value=$(grep "^${var}=" .env.local | head -1 | cut -d= -f2- | tr -d '"\r\n' || true)
  if [ -z "$value" ]; then
    echo "SKIPPED $name: $var is not set in .env.local" >&2
    continue
  fi
  if gcloud secrets describe "$name" >/dev/null 2>&1; then
    printf %s "$value" | gcloud secrets versions add "$name" --data-file=- >/dev/null
    echo "Updated $name (new version)"
  else
    printf %s "$value" | gcloud secrets create "$name" --replication-policy=user-managed --locations=us-west1 --data-file=- >/dev/null
    echo "Created $name"
  fi
done
