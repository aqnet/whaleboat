# Whaleboat — Deployment Plan (GCP, free tier)

**Status:** Draft v0.1 · 2026-09-29
**Owner:** Anderson
**Goal:** Run all of Whaleboat in **one GCP/Firebase project** at **$0/month**, using free-tier allowances only.

> Items marked **⚠ VERIFY** are free-tier limits or product behaviors recalled from memory. Confirm them against current Google Cloud and Firebase documentation before relying on them. Free tiers change.

**Relationship to the tech spec:** this plan replaces the hosting choices in [whaleboat.md](whaleboat.md) §6 and §11 (Fly.io worker, Supabase, Vercel, R2). It assumes the **twice-daily batch publishing** model agreed after v0.4: there is no live push, now-cast or Realtime. The spec should be updated to v0.5 to match.

---

## 1. Architecture

```
One GCP project (region us-west1)
│
├─ Compute Engine e2-micro  "whaleboat-vm"  (Always Free)
│    ├─ recorder   systemd service, always on
│    │    AISStream WebSocket → SQLite (fixes) + hourly .jsonl.gz files
│    ├─ batch      systemd timer, 13:00 and 22:00 America/Los_Angeles
│    │    ├─ fetch Acartia sightings, iNaturalist, NOAA CO-OPS tides
│    │    ├─ fixes → trips → loiters → encounters → hotspots  (SQLite/DuckDB)
│    │    ├─ upload finished hourly raw files → Cloud Storage
│    │    └─ write data JSON → deploy the "data" Hosting site
│    └─ watchdog   systemd timer, every 15 min
│         stale feed in daylight → error log entry → alert email
│
├─ Cloud Storage  gs://<project>-raw     raw AIS archive (private)
├─ Firebase Hosting
│    ├─ site "<project>"        the app (static Next.js export)
│    └─ site "<project>-data"   published JSON, CORS-enabled for the app
├─ Secret Manager               AISStream + Acartia keys
└─ Cloud Logging / Monitoring   watchdog alert policy → email
```

**Data flow:** AISStream → recorder → SQLite on the VM disk → batch → JSON → Firebase Hosting CDN → browser. Raw fixes are also archived to Cloud Storage, so the working database can always be rebuilt.

### 1.1 Key decisions

| Decision | Choice | Why |
|---|---|---|
| Always-on ingest | **e2-micro VM** | AISStream is a push-only WebSocket with no history. The e2-micro is the only always-on compute in GCP's Always Free tier. The serverless alternative (a Cloud Run Job running all day) likely exceeds free compute. |
| Working database | **SQLite (+ DuckDB for heavy queries) on the VM disk** | Free, and fast at this scale (≈ 1 GB/yr of fixes). A hosted database would mean another vendor, or free-tier write limits we'd exceed (Firestore). |
| Raw archive | **Cloud Storage, us-west1** | Durable backup of every fix. Everything derived can be rebuilt from it. |
| Front end | **Firebase Hosting, static export** | Free CDN in the same project. Firebase's server-rendering option (App Hosting) needs a paid plan, and the app doesn't need a server. |
| Data delivery | **A second Hosting site** for JSON | The app and the data deploy independently: app releases come from the developer, data releases from the VM. A Hosting deploy replaces the whole site, so they can't share one. |
| Publishing cadence | **Twice daily** | Matches the casual-app decision. Boats run in daylight, so 13:00 catches morning trips and 22:00 closes the day. |

---

## 2. Free-tier budget

| Resource | Free allowance | Expected use | Status |
|---|---|---|---|
| e2-micro VM | 1 instance/month in us-west1, us-central1 or us-east1 | 1 instance, 24/7 | ✅ ⚠ VERIFY |
| Standard persistent disk | 30 GB-months | 30 GB boot disk | ✅ at limit ⚠ VERIFY |
| VM outbound transfer | 1 GB/month (North America) | Firebase deploys (~5 MB/day) + API calls, well under 1 GB | ✅ ⚠ VERIFY whether traffic to Google APIs counts |
| **External IPv4 on the VM** | **Possibly not free**: Google charges for in-use external IPv4 addresses | 1 address | ⚠ **VERIFY. Biggest cost risk (≈ $3–4/mo if charged).** See §9. |
| Cloud Storage (Standard, us-west1) | 5 GB-months + operation quotas | ≈ 1 GB/yr of raw; ~24 uploads/day | ✅ for several years ⚠ VERIFY |
| Firebase Hosting | ~10 GB storage, ~360 MB/day transfer | App (~2 MB) + data (~40 MB/yr of day files); ~150 KB per page load | ✅ up to ~2,000 loads/day ⚠ VERIFY |
| Secret Manager | A few active secret versions + access operations | 2 secrets, read at service start | ✅ ⚠ VERIFY |
| Cloud Logging | 50 GiB/project/month | Watchdog entries only | ✅ |
| Cloud Monitoring alerting | Free for log-based alerts at this volume | 1 policy | ✅ ⚠ VERIFY |

**Guardrails (set these up in Phase 0):**
- A **billing budget of $1** with alerts at 50% and 100%. A billing account is required even for free-tier use; with billing linked, Firebase calls the project "Blaze", and the no-cost Hosting quotas still apply.
- Create everything in **us-west1**, using **standard** (not balanced or SSD) persistent disk.
- **Firebase Hosting release retention: keep ~5 releases per site.** Twice-daily data deploys otherwise pile up old versions against storage. ⚠ VERIFY where this setting lives (Hosting console → release storage).
- No Cloud NAT, load balancer, Cloud SQL, or snapshot schedules. None of them are free.

---

## 3. Components

### 3.1 Recorder (`whaleboat-recorder.service`)
Grows out of `scripts/ais-sample.ts`:
- Subscribes to AISStream for the region box, filtering by the registry MMSI list once the registry exists.
- Applies the spec's ingest validation (§7.1) and 30-second downsampling. Keeps every fix under 3 kn, and every fix where speed changes by more than 2 kn.
- Writes fixes to SQLite (`/var/lib/whaleboat/whaleboat.db`) and appends raw messages to `/var/lib/whaleboat/raw/YYYY/MM/DD/HH.jsonl`, then gzips each file when its hour ends.
- Reconnects with exponential backoff and jitter. Exits non-zero after repeated failures so systemd restarts it (`Restart=always`, `RestartSec=30`).
- Writes a heartbeat timestamp (`/var/lib/whaleboat/heartbeat`) on every message.
- Memory cap: `MemoryMax=300M` in the unit, which leaves room for the batch on a 1 GB VM.

### 3.2 Batch (`whaleboat-batch.timer` → `.service`)
Runs at **13:00 and 22:00 America/Los_Angeles** (`OnCalendar=*-*-* 13,22:00:00 America/Los_Angeles`, `Persistent=true`):
1. Fetches sources: Acartia (full ~7-day window, updated in place by id), iNaturalist (daily), NOAA tide predictions (monthly, cached).
2. Runs the shared track package (trip segmentation, loiter detection, time-aware simplification), then encounters. Recomputes hotspots on the 22:00 run only.
3. Uploads completed raw hourly files to `gs://<project>-raw/ais/YYYY/MM/DD/HH.jsonl.gz` and marks them uploaded.
4. Writes the data site (§4) to `/var/lib/whaleboat/publish/` and deploys it with `firebase deploy --only hosting:data`.
5. Logs a summary line (counts, duration). Any failure exits non-zero, which the watchdog reports.

The 22:00 run also purges non-registry `candidate_positions` older than 14 days and fixes older than the retention window (spec §6.2).

### 3.3 Watchdog (`whaleboat-watchdog.timer`, every 15 min)
- Reads the heartbeat. During daylight (sunrise−1 h to sunset+1 h), if it's older than 15 min, **or** the last batch run failed, it writes an error entry: `gcloud logging write whaleboat-watchdog "<reason>" --severity=ERROR`.
- A **log-based alert policy** on `logName=".../whaleboat-watchdog" AND severity>=ERROR` emails the owner.
- This needs no Ops Agent, keeping the 1 GB VM's memory for the recorder.

### 3.4 App (Firebase Hosting site `<project>`)
- The Next.js app with `output: "export"`. The API route handlers are removed, and the app fetches JSON from the data site (`NEXT_PUBLIC_DATA_BASE_URL`).
- Built and deployed from the developer machine (or CI later) with `firebase deploy --only hosting:app`.

---

## 4. Published data (Firebase Hosting site `<project>-data`)

| Path | Contents | Written by |
|---|---|---|
| `/v1/status.json` | `generated_at`, last fix time, source health, coverage window | every batch |
| `/v1/tracks-48h.json` | Registry vessel trips intersecting the last 48 h (`path_simple`, deck.gl format) | every batch |
| `/v1/sightings-48h.json` | Normalized, policy-filtered sightings (spec §10) | every batch |
| `/v1/days/YYYY-MM-DD.json` | One day's trips (`path_overview`) + sightings + encounters, for history views | every batch (today); past days are immutable |
| `/v1/hotspots.json` | Hotspot cells by month × species and month × tide (spec §7.4) | 22:00 batch |
| `/v1/coverage.json` | Date ranges with data per source, for the coverage strip (spec §8.5) | every batch |

**`firebase.json` headers for the data site:**
- `Access-Control-Allow-Origin: https://<project>.web.app` (plus the custom domain, if added).
- `Cache-Control`: `public, max-age=300, must-revalidate` for `status`, `*-48h`, `hotspots` and `coverage`; `public, max-age=31536000, immutable` for past `days/*`.

---

## 5. Security

- **No public SSH.** The VM firewall allows port 22 only from IAP's range (`35.235.240.0/20`). Connect with `gcloud compute ssh --tunnel-through-iap`, which is free.
- **Dedicated service account** `whaleboat-vm@` with least privilege:
  - `roles/storage.objectCreator` on the raw bucket only (plus `objectViewer` for restores),
  - `roles/secretmanager.secretAccessor` on the two secrets only,
  - `roles/firebasehosting.admin` (for data-site deploys),
  - `roles/logging.logWriter`.
- **Secrets** are read from Secret Manager at service start into memory. They never go on disk or into the repo.
- **Unattended upgrades** on the VM (Debian `unattended-upgrades`, security updates only).
- **Raw bucket:** uniform bucket-level access, public access prevention enforced.
- The SRKW disclosure policy (spec §10) is applied **in the batch**, before JSON is published. Nothing unfiltered is ever served.

---

## 6. Setup runbook

> Replace `<project>` with a globally unique id (e.g. `whaleboat-aq`) and `<billing>` with your billing account id. Run from the dev machine with `gcloud` and `firebase-tools` installed.

### Phase 0: Project and guardrails
```bash
gcloud projects create <project> --name="Whaleboat"
gcloud billing projects link <project> --billing-account=<billing>
gcloud config set project <project>
gcloud services enable compute.googleapis.com storage.googleapis.com \
  secretmanager.googleapis.com logging.googleapis.com monitoring.googleapis.com \
  firebasehosting.googleapis.com iap.googleapis.com

# $1 budget with alerts at 50% and 100%
gcloud billing budgets create --billing-account=<billing> --display-name="whaleboat-guardrail" \
  --budget-amount=1USD --threshold-rule=percent=0.5 --threshold-rule=percent=1.0

firebase projects:addfirebase <project>
firebase hosting:sites:create <project>-data
```

### Phase 1: Storage, secrets, service account
```bash
gcloud storage buckets create gs://<project>-raw --location=us-west1 \
  --default-storage-class=STANDARD --uniform-bucket-level-access --public-access-prevention

gcloud iam service-accounts create whaleboat-vm --display-name="Whaleboat VM"
SA=whaleboat-vm@<project>.iam.gserviceaccount.com

# Secrets (paste values via stdin; never on the command line)
gcloud secrets create aisstream-api-key --replication-policy=user-managed --locations=us-west1
gcloud secrets versions add aisstream-api-key --data-file=-
gcloud secrets create acartia-token --replication-policy=user-managed --locations=us-west1
gcloud secrets versions add acartia-token --data-file=-

gcloud secrets add-iam-policy-binding aisstream-api-key --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor
gcloud secrets add-iam-policy-binding acartia-token    --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor
gcloud storage buckets add-iam-policy-binding gs://<project>-raw --member=serviceAccount:$SA --role=roles/storage.objectCreator
gcloud storage buckets add-iam-policy-binding gs://<project>-raw --member=serviceAccount:$SA --role=roles/storage.objectViewer
gcloud projects add-iam-policy-binding <project> --member=serviceAccount:$SA --role=roles/firebasehosting.admin
gcloud projects add-iam-policy-binding <project> --member=serviceAccount:$SA --role=roles/logging.logWriter
```

### Phase 2: VM
```bash
gcloud compute instances create whaleboat-vm --zone=us-west1-b --machine-type=e2-micro \
  --image-family=debian-12 --image-project=debian-cloud \
  --boot-disk-size=30GB --boot-disk-type=pd-standard \
  --service-account=$SA --scopes=cloud-platform

gcloud compute firewall-rules create allow-iap-ssh --network=default \
  --direction=INGRESS --action=allow --rules=tcp:22 --source-ranges=35.235.240.0/20
# Remove the default rule that allows SSH from anywhere, if present:
gcloud compute firewall-rules delete default-allow-ssh --quiet || true

gcloud compute ssh whaleboat-vm --zone=us-west1-b --tunnel-through-iap
```
On the VM:
- Add a 2 GB swapfile. The 1 GB of RAM is tight for `npm ci` and the batch.
- Install Node 22 LTS, `sqlite3`, `firebase-tools` and `unattended-upgrades`, and set the timezone to `America/Los_Angeles`.
- Create a `whaleboat` system user, and `/var/lib/whaleboat/{raw,publish}` owned by it.
- Deploy the code: `git clone` into `/opt/whaleboat` and run `npm ci --omit=dev`.
- Install the systemd units (`whaleboat-recorder.service`, `whaleboat-batch.{service,timer}`, `whaleboat-watchdog.{service,timer}`) from `deploy/systemd/` in the repo, then `systemctl enable --now` them.
- ⚠ VERIFY that `firebase deploy` authenticates on the VM using the attached service account (Application Default Credentials) with no interactive login. If not, use the Firebase Hosting REST API from the batch instead.

### Phase 3: Hosting
- `firebase.json` with two targets: `app` → site `<project>`, `data` → site `<project>-data`, with the headers from §4.
- App: `cd web && npm run build` (static export to `out/`), then `firebase deploy --only hosting:app`.
- Data: the first deploy comes from the batch. Check `https://<project>-data.web.app/v1/status.json`.
- Set release retention to ~5 on both sites.

### Phase 4: Alerting
- Create the log-based alert policy (§3.3) with an email notification channel.
- Test it: run `gcloud logging write whaleboat-watchdog "test" --severity=ERROR` on the VM and confirm the email arrives.

---

## 7. Operations

| Task | How |
|---|---|
| Check health | `https://<project>-data.web.app/v1/status.json`; `journalctl -u whaleboat-recorder -f` over IAP SSH |
| Deploy new VM code | SSH → `cd /opt/whaleboat && git pull && npm ci --omit=dev && sudo systemctl restart whaleboat-recorder` |
| Deploy new app | `cd web && npm run build && firebase deploy --only hosting:app` |
| Roll back the app | Firebase console → Hosting → release history → Rollback |
| Rebuild the working DB | Stop the recorder; replay `gs://<project>-raw/ais/**` through the track package into a fresh SQLite file; start the recorder |
| Backfill history (MarineCadastre) | Run on the **dev machine**, not the e2-micro (DuckDB needs more RAM). Upload results as `days/*.json` via a data deploy |
| Rotate a key | `gcloud secrets versions add …`, then restart the recorder |

**Backups:** the raw archive in Cloud Storage is the backup. The SQLite database and all published JSON are derived from it. Disk snapshots aren't used, because they aren't free.

---

## 8. Code changes required

1. **`web/`: static export.** `output: "export"` in `next.config.ts`. Delete `app/api/*` route handlers. Fetch from `NEXT_PUBLIC_DATA_BASE_URL`. Replace the sample picker with the time window control (spec §8.5).
2. **Shared track package.** Move parsing and track logic out of `web/lib/ais.ts` into a package that both the VM services and the app types use (spec §6.1).
3. **Recorder.** Harden `scripts/ais-sample.ts` into the service in §3.1: SQLite, hourly rotation, reconnect, heartbeat, secrets from Secret Manager.
4. **Batch.** New: sources → tracks → encounters → hotspots → JSON → raw upload → Hosting deploy.
5. **`deploy/`.** systemd units, `firebase.json`, `.firebaserc`, and a VM bootstrap script covering Phase 2's on-VM steps.
6. **Sightings code.** `web/lib/sightings.ts` and `web/app/api/sightings/route.ts` move into the batch. The panel reads `sightings-48h.json`.

---

## 9. Risks and open questions

1. **External IPv4 charge (⚠ VERIFY first).** If the free-tier VM's external IP is billed (≈ $3–4/mo), the options are:
   - accept it (the whole stack is still ≈ $4/mo);
   - go **IPv6-only**, if AISStream, Acartia and NOAA all support IPv6 (⚠ VERIFY each);
   - or move ingest to the serverless option (Cloud Run Job), with its own compute cost.
   Cloud NAT is not an option: it isn't free.
2. **1 GB RAM.** The recorder and batch must stay lean: stream-process files, and use no in-memory whole-day arrays. Swap covers spikes. Heavy work (backfill, hotspot rebuilds over years) runs on the dev machine.
3. **AISStream coverage.** The 2026-09-29 sample showed almost no reception in Saratoga Passage and Port Susan. Hosting doesn't fix that; the Camano receiver (spec Phase 3) does. When it exists, AIS-catcher can POST batches straight to the VM, or to a small Cloud Run endpoint.
4. **Single VM, single zone.** A zone outage or VM failure loses live data until it's restored. That's acceptable for a casual app: the raw archive preserves everything up to the last hourly upload.
5. **Free-tier drift.** Google has changed these allowances before. The $1 budget alert is the early warning.
6. **Firebase deploy from the VM (⚠ VERIFY).** If authenticating with the service account doesn't work unattended, fall back to the Hosting REST API.

---

## 10. Alternatives considered

| Option | Why not (for now) |
|---|---|
| Vercel front end + GCP data | Works well, but two vendors. Rejected for "all in one place". |
| Fly.io worker + Supabase + Vercel (spec v0.4) | ~$30/mo, three vendors. |
| Cloud Run Job ingest (serverless) | Holding the stream ~17 h/day likely exceeds Cloud Run's free compute. Revisit if the VM's external IP turns out to be billed. |
| AWS Lambda relay + S3/DynamoDB + CloudFront | Fully serverless at $0 using a chain of 15-minute Lambdas. More moving parts, and it's not the chosen single platform. |
| Cloudflare Durable Objects + R2 + Pages | Elegant single platform, but uncertain free-plan limits for an always-connected object and for batch CPU time. |
