# nodi backend (Stage 0)

FastAPI + Supabase. Stage 0 scope: app skeleton, config, JWT/JWKS auth, role
guards, and the first migration SQL. No chat/RAG/skills yet.

## Setup (Windows / PowerShell)

```powershell
cd backend
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

Config is read from the **repository root `.env`** (gitignored). See
`backend/.env.example` for the expected keys.

## Run

```powershell
uvicorn app.main:app --reload --port 8000
```

- `GET /health` — liveness + which integrations are configured
- `GET /auth/me` — caller's profile (requires `Authorization: Bearer <JWT>`)
- `GET /auth/me/scopes` — personal + class scopes
- `POST /chat/stream` — 501 placeholder (Stage 1)

## Migrations

SQL lives in `../supabase/migrations/`. Stage 0: `0001_init.sql`
(profiles, classes, class_members, sessions, nodes + RLS).
Applied by the leader via Supabase MCP — do not apply manually here.
