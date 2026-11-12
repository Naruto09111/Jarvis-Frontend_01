# OpenJarvis Frontend (Vite + React)

Web UI for an OpenJarvis backend. Deployed to Vercel; the backend (`jarvis serve`) runs elsewhere
(for example on a Windows PC behind a Cloudflare Tunnel).

## Environment variables

| Variable | Where | Required | Meaning |
|---|---|---|---|
| `VITE_API_BASE_URL` | Vercel (Production, Preview, Development) | recommended | Public backend URL, e.g. `https://xxxx.trycloudflare.com`. No trailing slash, no `/v1` (both are stripped automatically). |
| `VITE_API_URL` | legacy alias | no | Still read if `VITE_API_BASE_URL` is unset. |

Never put the backend API key in a `VITE_*` variable: Vite embeds those in the public bundle.
If your backend has `OPENJARVIS_API_KEY` set, type the key in **Settings → Connection → API key**
(stored only in your browser). Leave it empty when the backend has no key.

`VITE_*` values are baked in at build time: after changing one, **redeploy**.

## Vercel settings (project `frontend-1`)

* Root Directory: the folder containing this `package.json` (`frontend` if you uploaded the whole repo).
* Framework Preset: Vite. Build command: `npm run build`. Output directory: `dist` (also set in `vercel.json`).
* Node.js 22.x. `package.json` requires npm >= 11.19.0 (`engine-strict`); if the build fails on the engine
  check, set the install command to `npm install -g npm@11.19.0 && npm ci`.
* `vercel.json` rewrites unknown paths to `index.html` so deep links and refreshes work.

## Which backend URL is used (precedence)

1. A URL saved in **Settings → Connection**, but only while it is still current. It records the build URL that
   existed when saved; if `VITE_API_BASE_URL` later changes, the saved URL is treated as **stale**, the new build
   URL is used, and Settings shows a warning with **Use saved URL** / **Forget saved URL** (nothing is deleted silently).
2. `VITE_API_BASE_URL` (or legacy `VITE_API_URL`).
3. Desktop app default / same origin.

Settings shows the URL actually in use and where it came from. **Save** validates the URL; **Test** runs a real
check and reports which step failed: invalid URL, unreachable/tunnel changed, Cloudflare tunnel with nothing behind
it, CORS blocked, not an OpenJarvis backend, API key rejected, `/v1/models` error, or **empty model list**.
Green means health + auth + at least one model all work.

### When the Cloudflare quick-tunnel URL changes
Open Settings → Connection, paste the new `https://….trycloudflare.com` URL, press **Save** (no redeploy needed).
Update `VITE_API_BASE_URL` in Vercel only if you want it as the new default.

## Backend configuration (Windows CMD)

```
cd /d D:\Jarvis-Backend_2\OpenJarvis-main
set OPENJARVIS_CORS_ORIGINS=https://frontend-1-rose-sigma.vercel.app,http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174
jarvis serve
```
(second window) `"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:8000`

* `OPENJARVIS_CORS_ORIGINS` **replaces** the backend's built-in origin list, so list every origin you need
  (the Vercel domain plus your local dev origins). No `*`. Add preview-deployment domains if you use them.
* Apply `OpenJarvis-Backend-Model-Fix-Patch.zip` (separate file) so `/v1/models` lists gateway models such as
  `01-ai/yi-large`. Restart `jarvis serve` afterwards.
* Keep both windows open. Quick-tunnel URLs change on every restart.

## Local development
```
npm ci
npm run dev        # proxies /v1 and /api to http://localhost:8000
npm test
npm run build      # outputs dist/
```

## Desktop inference settings
The LM Studio / vLLM / SGLang / llama.cpp / MLX options (Tauri `set_inference_source`) are desktop-only and
unchanged. They are separate from the browser's backend connection above.

## Testing report
See `TESTING.md`.
