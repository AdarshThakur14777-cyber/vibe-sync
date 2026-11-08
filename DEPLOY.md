# VibeSync deployment guide

Two services, one repo — **both are deployed already**:

- **Frontend** (Next.js, repo root) → **Vercel** → project `vibesync` (account shivay14777-3130)
- **Backend** (Express + Socket.IO, `backend/`) → **Render** → https://vibesync-backend-ewho.onrender.com

To redeploy:
- **Backend**: every `git push` to `main` auto-deploys it on Render (`autoDeployTrigger: commit` in `render.yaml`).
- **Frontend**: re-run the upload deploy (or connect the repo in the Vercel dashboard for auto-deploys).

## Backend (Render)

`render.yaml` sets everything: runtime node, rootDir `backend`, health check `/health`,
plan free, region oregon. `PORT` is read from the environment automatically.

⚠️ **Free plan: the service sleeps after ~15 min of no traffic.** Rooms held in RAM +
`rooms-state.json` are wiped when it wakes cold. Keep it awake with a free uptime
monitor pinging `https://vibesync-backend-ewho.onrender.com/health` every 5–10 min
(e.g. UptimeRobot, cron-job.org) or a local scheduled task while you listen.

## Frontend (Vercel)

The env var must be baked in **before** the build (it's compiled into the bundle):

- Key: `NEXT_PUBLIC_SOCKET_URL`
- Value: `https://vibesync-backend-ewho.onrender.com`
- Targets: production + preview

## Push to GitHub

```bash
git add -A
git commit -m "changes"
git push origin main    # auto-deploys the backend on Render
```

## Local dev (unchanged)

```bash
npm run dev        # frontend :3000 + backend :3001
```
