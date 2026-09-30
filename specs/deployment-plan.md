# Whaleboat — Deployment Plan (Cloud Run + Supabase)

**Status:** v0.2 · 2026-09-30 · **deployed** (web: https://whaleboat-web-594872122770.us-west1.run.app)
**Owner:** Anderson
**Goal:** Host Whaleboat on **Google Cloud Run** (web) and a **free-tier VM** (recorder), with **Supabase** as the database: a live map with a rolling 48 h window, at about $0/month.

> Items marked **⚠ VERIFY** are prices, limits or product behaviors that were not confirmed against current Google Cloud or Supabase documentation. Confirm them before relying on them.

### Changelog
- **v0.2 (2026-09-30):** Replaced the v0.1 design (free-tier VM + SQLite + static Firebase Hosting, published twice a day) with **Cloud Run + Supabase**. Reasons: the map stays live, there is no VM to maintain, and Supabase is already set up. The cost is no longer $0 (§2). v0.1 is in git history (`7743cb8`).

**Relationship to the tech spec:** this replaces the hosting choices in [whaleboat.md](whaleboat.md) §6 and §11 (Fly.io worker, Vercel, R2) and keeps Supabase. Storage differs from the spec (§11: registry vessels only, 90 days) and is defined in `db/migrations/`: most vessel types are stored, not only registry vessels; background traffic is kept **48 h**, and passenger vessels and named whale-watch boats **30 days** (§3.3).

---

## 1. Architecture

```
GCP project (region us-west1)                        Supabase project
│                                                    │
├─ Cloud Run service   "whaleboat-web"               ├─ positions   (48 h / 30 d, pg_cron hourly)
│    Next.js app + API routes, scales to zero   ───► ├─ vessels
│      /api/tracks     → tracks_window()  (48 h)     ├─ sighting_logs
│      /api/sightings  → operator sighting log       └─ functions: ingest_ais(), tracks_window()
│                                                    ▲
├─ Compute Engine e2-micro "whaleboat-vm"  (free tier) │
│    Docker: recorder container, always on           │
│    AISStream WebSocket → batches every 5 s   ──────┘
│
├─ Cloud Run Jobs + Cloud Scheduler   (later: trips, encounters, hotspots)
├─ Artifact Registry                  container images
├─ Secret Manager                     AISStream key, Supabase URL + secret key
└─ Cloud Logging / Monitoring         recorder heartbeat → alert email
```

**Data flow:** AISStream → recorder → `ingest_ais()` → Supabase → `tracks_window()` → web API → browser. The browser never talks to Supabase or AISStream directly, and no key reaches it.

### 1.1 Key decisions

| Decision | Choice | Why |
|---|---|---|
| Web app | **Cloud Run service**, request-based billing, min instances 0 | Keeps the API routes (no static export). Scales to zero, so casual traffic should fit the free tier. |
| Always-on ingest | **Free-tier e2-micro VM** running the recorder container | AISStream is a push-only WebSocket with no history, so something must hold the connection all day. On Cloud Run that costs ≈ $45–50/mo (it ran there on 2026-09-30 for two hours); the e2-micro is free. Same image either way: the recorder still works as a Cloud Run service or worker pool if the VM ever becomes the problem. |
| Database | **Supabase Postgres** | Cloud Run containers have no durable disk, so state has to live elsewhere. Already provisioned, with PostGIS and pg_cron. |
| Writes | One RPC per batch (`ingest_ais`) | Merges vessel details and ignores duplicate positions in a single round trip. |
| Reads | One RPC per view (`tracks_window`) | Returns the whole window as one JSON value, so PostgREST's row limit doesn't truncate it. |
| Retention and filtering | **In the database**: `ingest_ais()` and an hourly pg_cron job | One place for every writer (§3.3). No scheduler or job needed on the GCP side. |
| Sightings | Fetched on demand by the web app, cached 6 h, last good copy in `sighting_logs` | Small and slow-changing. Becomes a scheduled job only if more sources are added. |
| Secrets | **Secret Manager**, mounted as environment variables | Nothing in images or the repo. |

---

## 2. Cost

| Item | Expected | Notes |
|---|---|---|
| Web service | ≈ $0 | Free tier ⚠ VERIFY (recalled: 2M requests, 180k vCPU-s, 360k GiB-s per month). |
| Recorder VM (e2-micro, 30 GB standard disk) | **≈ $0** | Free tier: one e2-micro in us-west1, 30 GB-months of standard disk. The external IP is free for the first 720 h/month, then $0.005/h (≈ $0.12 in a 31-day month). Egress to Supabase is roughly 1 GB/month, around the 1 GB free allowance. Running the recorder on Cloud Run instead would be ≈ $45–50/mo (1 vCPU minimum when CPU is always allocated; $0.000018/vCPU-s) or ≈ $31/mo as a worker pool. |
| Artifact Registry | ≈ $0 | Two images, ~110 MB (web) and ~80 MB (recorder). 0.5 GB free ⚠ VERIFY. |
| Secret Manager, Logging, Scheduler | ≈ $0 | Three secrets; heartbeat logs only. |
| Supabase | $0, then **$25/mo (Pro)** | Free tier is 500 MB. See risk 1: all vessels for 30 days may exceed it. |

**Guardrails:** a billing budget of **$20/mo** with alerts at 50% and 100%; `--max-instances 2` on the web service; exactly 1 recorder instance.

---

## 3. Components

### 3.1 Web (`web/`, service `whaleboat-web`)
- Image: `web/Dockerfile` (Next.js `output: "standalone"`, listens on `PORT`, runs as non-root).
- Reads the 48 h window from Supabase when `SUPABASE_URL` and `SUPABASE_SECRET_KEY` are set. The local-sample fallback only applies in development.
- The depth basemap's data (`web/public/depth/`) is gitignored. Run `npm run depth:fetch` before building so it is in the image; `web/.gcloudignore` makes sure `gcloud` uploads it.

### 3.2 Recorder (`services/recorder/`, on VM `whaleboat-vm`)
- Runs in Docker on the free-tier VM, started by `deploy/vm/recorder-startup.sh` (the VM's startup script, re-run on every boot). It pulls `whaleboat-recorder:latest`, reads the three secrets from Secret Manager into `/run` (tmpfs), and passes them to the container as files (`*_FILE` variables), so no key is written to disk. Logs reach Cloud Logging via Docker's `gcplogs` driver (log `gcplogs-docker-driver`, message in `jsonPayload.message`).
- A reboot restores it without intervention (tested: reconnected 48 s after a reset).
- One dependency-free TypeScript file run directly by Node 22.
- Subscribes to one box covering Port Angeles east to Everett and Tacoma north to the San Juans (`AIS_BBOX` overrides it).
- Flushes to `ingest_ais()` every 5 s. A failed write is retried with the next batch; at most 50,000 positions are held in memory.
- Reconnects with exponential backoff and jitter (1 s → 60 s), and forces a reconnect after 3 min of silence.
- Logs JSON lines, with a `heartbeat` entry every 5 min carrying message, stored, dropped and error counts.
- On SIGTERM it flushes and exits within Cloud Run's 10 s window.

### 3.3 What gets stored (`db/migrations/20260930170000_storage_diet.sql`)
Measured on the first morning: ~11k positions/hour, ~80% from boats that weren't moving, which projects to ~1.3 GB over 30 days. The rules, all enforced in the database:
- **Types never stored:** tugs/towing, cargo, tankers, military, pilot/SAR/law enforcement and similar service craft (`ais_type_excluded()`). Kept: passenger, fishing, sailing, pleasure craft, and vessels whose type isn't known yet.
- **Stationary thinning:** a boat under 0.5 kn is stored at most once every 15 minutes.
- **Retention:** 48 h for everything; 30 days for passenger types (60–69) and the named whale-watch boats (`keeps_30_days()`; keep its name list in step with `web/lib/whaleWatch.ts`).
- The `geom` column was dropped until PostGIS queries need it.

### 3.4 Alerting
- A **log-based metric** counting the recorder's `heartbeat` entries, and an **alert policy** that emails when none arrive for 15 min.
- A second policy on `severity>=ERROR` from the recorder (failed Supabase writes, AISStream errors).

### 3.5 Jobs (not built yet)
Trips, loiters, encounters and hotspots (spec §7) will run as **Cloud Run Jobs** on **Cloud Scheduler**, reading and writing Supabase.

---

## 4. Security
- The web service is public (`--allow-unauthenticated`). The recorder has no inbound endpoint.
- Two service accounts: `whaleboat-web@` (Supabase secrets only) and `whaleboat-recorder@` (all three secrets). Each gets `roles/secretmanager.secretAccessor` on just its secrets.
- Supabase tables have row-level security on with no policies, and the functions are executable by the service role only. The publishable key can read nothing.
- The SRKW disclosure policy (spec §10) has to be enforced in the API routes before any sighting locations are served. The current sighting log has no locations.

---

## 5. Setup runbook

> Replace `<project>` and `<billing>`. Needs the `gcloud` CLI, which is not yet installed on the dev VM.

### Phase 0: Project and guardrails
```bash
gcloud projects create <project> --name="Whaleboat"
gcloud billing projects link <project> --billing-account=<billing>
gcloud config set project <project>
gcloud config set run/region us-west1
gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com \
  secretmanager.googleapis.com cloudscheduler.googleapis.com logging.googleapis.com monitoring.googleapis.com

gcloud billing budgets create --billing-account=<billing> --display-name="whaleboat-guardrail" \
  --budget-amount=20USD --threshold-rule=percent=0.5 --threshold-rule=percent=1.0
```

### Phase 1: Secrets and service accounts
```bash
# Paste each value on stdin, then Ctrl-D. Never put secrets on the command line.
for s in aisstream-api-key supabase-url supabase-secret-key; do
  gcloud secrets create $s --replication-policy=user-managed --locations=us-west1
  gcloud secrets versions add $s --data-file=-
done

gcloud iam service-accounts create whaleboat-web
gcloud iam service-accounts create whaleboat-recorder
WEB=whaleboat-web@<project>.iam.gserviceaccount.com
REC=whaleboat-recorder@<project>.iam.gserviceaccount.com

for s in supabase-url supabase-secret-key; do
  gcloud secrets add-iam-policy-binding $s --member=serviceAccount:$WEB --role=roles/secretmanager.secretAccessor
done
for s in aisstream-api-key supabase-url supabase-secret-key; do
  gcloud secrets add-iam-policy-binding $s --member=serviceAccount:$REC --role=roles/secretmanager.secretAccessor
done
```

### Phase 2: Database
Apply everything in `db/migrations/` to the Supabase project. Both current migrations were applied on 2026-09-30.

### Phase 3: Recorder (free-tier VM)
```bash
gcloud services enable compute.googleapis.com
REC=whaleboat-recorder@<project>.iam.gserviceaccount.com

# Build the image on Cloud Build (amd64; the dev VM is arm64).
gcloud builds submit services/recorder --region=us-west1 \
  --tag us-west1-docker.pkg.dev/<project>/cloud-run-source-deploy/whaleboat-recorder:latest

# The VM's account pulls the image and writes logs.
gcloud artifacts repositories add-iam-policy-binding cloud-run-source-deploy --location=us-west1 \
  --member=serviceAccount:$REC --role=roles/artifactregistry.reader
gcloud projects add-iam-policy-binding <project> --member=serviceAccount:$REC --role=roles/logging.logWriter

# No inbound access except SSH through IAP.
gcloud compute firewall-rules delete default-allow-ssh default-allow-rdp --quiet
gcloud compute firewall-rules create allow-ssh-from-iap --network=default --direction=INGRESS \
  --action=allow --rules=tcp:22 --source-ranges=35.235.240.0/20

# us-west1-b had no e2-micro capacity on 2026-09-30; us-west1-a worked.
gcloud compute instances create whaleboat-vm --zone=us-west1-a --machine-type=e2-micro \
  --image-family=debian-12 --image-project=debian-cloud --boot-disk-size=30GB --boot-disk-type=pd-standard \
  --service-account=$REC --scopes=cloud-platform \
  --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
  --metadata-from-file=startup-script=deploy/vm/recorder-startup.sh --metadata=enable-oslogin=TRUE
```
Check: a "Connected to AISStream" entry in log `gcplogs-docker-driver` within ~3 min, and rows arriving in `positions`.

### Phase 4: Web
```bash
npm run depth:fetch            # repo root; puts depth data in web/public/depth/
gcloud run deploy whaleboat-web --source web \
  --service-account=$WEB --allow-unauthenticated --min-instances=0 --max-instances=2 \
  --cpu=1 --memory=512Mi \
  --set-secrets=SUPABASE_URL=supabase-url:latest,SUPABASE_SECRET_KEY=supabase-secret-key:latest
```
Check: the service URL loads the map, and the panel's summary line starts with "Supabase ·".

### Phase 5: Alerts
Create the log-based metric and the two alert policies in §3.4 (console: Logging → Log-based metrics, then Monitoring → Alerting).

### Phase 6 (optional): Custom domain
`gcloud beta run domain-mappings create --service whaleboat-web --domain <domain>` ⚠ VERIFY availability in us-west1; otherwise put a load balancer or Firebase Hosting rewrite in front.

---

## 6. Operations

| Task | How |
|---|---|
| Deploy new web code | Re-run the Phase 4 `gcloud run deploy` |
| Deploy new recorder code | Re-run the Phase 3 `gcloud builds submit`, then `gcloud compute instances reset whaleboat-vm --zone=us-west1-a` (≈ 1 min gap in the feed) |
| Shell on the VM | `gcloud compute ssh whaleboat-vm --zone=us-west1-a --tunnel-through-iap` |
| Roll back | `gcloud run services update-traffic whaleboat-web --to-revisions=<rev>=100` |
| Schema change | Add a file under `db/migrations/`, apply it to Supabase, then deploy code that uses it |
| Rotate a key | `gcloud secrets versions add …`, then redeploy the service that uses it |
| Check the feed | Logs Explorer: `logName:"gcplogs-docker-driver" jsonPayload.message:"heartbeat"` |

**Backups:** Supabase's own backups (daily on Pro ⚠ VERIFY for the free tier). There is no raw archive in this design: a recorder outage loses that period's positions for good. If that matters, add an hourly raw dump to Cloud Storage.

---

## 7. Code status

| Item | Status |
|---|---|
| `db/migrations/*_ais_positions.sql`, `*_sighting_logs.sql` | Done, applied 2026-09-30 |
| `services/recorder/` (service + Dockerfile) | Done. Container tested against stand-in AIS and database servers: reconnect, retry and storage all worked. **Not yet run against the real AISStream and Supabase.** |
| `web/Dockerfile`, standalone output | Done. Image builds (arm64 locally; Cloud Build produces amd64) and serves the page, static files and API routes. **Not yet run with real Supabase credentials.** |
| Web reads the 48 h window from Supabase | Done, with a local-file fallback for development |
| Sightings snapshot in Supabase | Done |
| Hide the per-sample picker in production | To do |
| Backfill of the 2026-09-29 local samples | To do (optional) |
| Alert policies | To do (Phase 5) |
| Jobs for trips, encounters, hotspots | To do (spec Phase 1) |

---

## 8. Risks and open questions

1. **Supabase storage.** The rules in §3.3 are meant to keep `positions` well under the free tier's 500 MB, but the steady-state size is a projection. **Measure after two full days** (`select pg_total_relation_size('positions')`), once the 48 h window has filled. Further levers: a longer thinning interval, excluding more types, or a smaller region.
2. **Recorder VM.** Free-tier limits (one e2-micro per billing account, 30 GB standard disk, 720 free external-IP hours) are Google's to change; the $20 budget alert is the early warning. The VM needs occasional care: Debian security updates (enable `unattended-upgrades`) and a reboot now and then.
3. **Shared Supabase project.** The project also holds another app's (empty) tables. Move Whaleboat to its own project before a public launch.
4. **AISStream reliability and coverage.** No SLA, and the 2026-09-29 sample showed little reception in Saratoga Passage and Port Susan. Hosting doesn't fix that; the Camano receiver (spec Phase 3) does.
5. **One recorder instance, one region.** A crash or redeploy leaves a short gap. Acceptable for now; Cloud Run restarts it.
6. **Terms of use.** Confirm AISStream allows public redistribution (spec §13.6), and credit NOAA for the depth data with a "not for navigation" note.
7. **Spec drift.** `whaleboat.md` still describes Fly.io, Vercel and registry-only storage. It should be updated to v0.5 to match this plan.
