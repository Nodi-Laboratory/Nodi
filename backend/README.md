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
- `POST /sessions` — create a conversation session
- `GET /sessions?space_kind=&space_ref=` — sessions in a space (recent first)
- `GET /sessions/{id}` — session + all nodes (tree restore)
- `POST /chat/stream` — Gemini SSE chat; persists (Q+A)=1 node, auto-labels

All DB access uses the caller's JWT (RLS, owner-only writes) — not service_role.

## Migrations

SQL lives in `../supabase/migrations/`. Stage 0: `0001_init.sql`
(profiles, classes, class_members, sessions, nodes + RLS).
Applied by the leader via Supabase MCP — do not apply manually here.
