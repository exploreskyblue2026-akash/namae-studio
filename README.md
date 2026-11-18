# Namae Studio

Internal brand-name exploration tool: brief, directions, names, research and shortlist, with a backend for users, projects, activity log and admin settings.

## Run locally

```bash
cd server
npm install
ADMIN_PASSWORD=choose-a-password npm start
```

Open http://localhost:3000. The first start creates the admin user `admin@skyblue.local`. If `ADMIN_PASSWORD` is not set, the password is `change-me-now`.

## Layout

- `public/index.html`: the frontend (single file).
- `server/server.js`: API, auth, projects, names, admin.
- `server/catalog.js`: directions, name pools, fixed options.
- `server/research.js`: research adapters. The RDAP domain check is live; the others are placeholders.
- `server/llm.js`: AI adapter (Google Gemini), not yet verified against the live service.
- `prototype/namae-studio.html`: earlier standalone prototype, kept for reference.

## Notes

- `server/data.json` holds users and API keys. It is git-ignored. Do not commit it.
- Storage is a JSON file for now. Move to a hosted database before deploying to a free host that does not keep files.
