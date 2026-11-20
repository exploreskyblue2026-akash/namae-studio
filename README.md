# Namae Studio

Internal brand-name exploration tool: brief, directions, names, research and shortlist, with a backend for users, projects, activity log and admin settings.

## Run locally

```bash
cd server
npm install
ADMIN_PASSWORD=choose-a-password npm start
```

Open http://localhost:3000. The first start creates the admin user from `ADMIN_ID` (default `admin@skyblue.local`). If `ADMIN_PASSWORD` is not set, the password is `change-me-now`.

## Layout

- `public/index.html`: the frontend (single file).
- `server/server.js`: API, auth, projects, names, admin.
- `server/catalog.js`: directions, name pools, fixed options.
- `server/research.js`: research adapters. The RDAP domain check is live; the others are placeholders.
- `server/llm.js`: AI adapter (Google Gemini), not yet verified against the live service.
- `prototype/namae-studio.html`: earlier standalone prototype, kept for reference.

## Notes

- `server/data.json` holds users, projects, and API keys when no database is connected. It is git-ignored. Do not commit it.
- Storage: set `DATABASE_URL` (see below) to persist to Postgres. Without it, everything lives in `data.json`, which Render's free tier wipes on every restart/redeploy.

## Environment variables (set these in Render → Environment)

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string. When set, all app data (users, projects, names, API keys) persists there instead of the local file, surviving restarts and redeploys. Falls back to `data.json` if unset or unreachable. |
| `ADMIN_ID` | Admin login email (default `admin@skyblue.local`) |
| `ADMIN_PASSWORD` | Admin login password (default `change-me-now`; set this) |
| `GEMINI_API_KEY` | AI: restates the brief, suggests classes/segments, checks sound, origin, similar brands |
| `GEMINI_MODEL` | AI model name to use (optional; defaults to `gemini-3.8-flash`). Overrides the model saved in Admin, and persists across restarts. |
| `GEMINI_IMAGE_MODEL` | Image model for the name-detail Visual box (optional; defaults to `gemini-2.5-flash-image`, Google's "Nano Banana" model — Imagen is retired). |
| `EUIPO_CLIENT_ID`, `EUIPO_CLIENT_SECRET` | EU trademark check (adapter still placeholder) |
| `USPTO_API_KEY` | US trademark check (adapter still placeholder) |
| `WHOISXML_API_KEY` | Domain and social checks (adapter still placeholder) |

A key set here switches its source on automatically and takes priority over the key typed in Admin. Keys typed in Admin are saved to `data.json`, which the free tier wipes on restart, so prefer env vars for anything you need to keep.
