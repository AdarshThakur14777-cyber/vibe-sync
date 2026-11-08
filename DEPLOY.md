# VibeSync deployment guide

Two services, one repo:

- **Frontend** (Next.js, repo root) → **Vercel**
- **Backend** (Express + Socket.IO, `backend/`) → **Render**

## 1. Backend on Render

1. Push this repo to GitHub (see below).
2. Dashboard → **New → Blueprint** → pick the repo → Apply.
   (Or **New → Web Service**, root directory `backend`, build `npm install`, start `npm start`.)
3. Render gives you something like `https://vibesync-backend.onrender.com`.

`render.yaml` already sets:
- runtime node, rootDir `backend`
- health check at `/health`
- `PORT` is read from the environment automatically (`process.env.PORT || 3001`)

⚠️ **Free plan: the service sleeps after ~15 min of no traffic.** Rooms held in RAM +
`rooms-state.json` are wiped when it wakes cold. Keep it awake with a free uptime
monitor pinging `https://<your-backend>.onrender.com/health` every 5–10 min
(e.g. UptimeRobot, cron-job.org).

## 2. Frontend on Vercel

1. Import the GitHub repo at vercel.com/new (or use `npx vercel --prod`).
2. **Set the environment variable BEFORE the first build** (it's baked into the bundle):
   - Key: `NEXT_PUBLIC_SOCKET_URL`
   - Value: your Render backend URL, e.g. `https://vibesync-backend.onrender.com`
3. Deploy. Done.

## 3. Push to GitHub

```bash
git init
git add -A
git commit -m "VibeSync"
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

## Local dev (unchanged)

```bash
npm run dev        # frontend :3000 + backend :3001
```
