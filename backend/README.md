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
- `POST /chat/stream` — Gemini SSE chat; persists (Q+A)=1 node, auto-labels,
  auto-tags (inline in `done`), and may emit a `navigator` event with waiting
  navigator nodes when the branch matures
- `GET /tags?space_kind=&space_ref=` — own concept tags in a space (most-used)
- `GET /tags/cooccurrence?space_kind=&space_ref=` — co-attached tag pairs
- `DELETE /nodes/{id}` — delete a waiting navigator node (cleanup after click)

All DB access uses the caller's JWT (RLS, owner-only writes) — not service_role.

## AI layer (`app/ai/`)

- `skills/` — one capability per file, auto-discovered into a `SKILLS` registry;
  `catalog()` renders name+description for prompt injection.
- `react.py` — minimal budgeted ReAct runner with best-effort `ai_sessions` /
  `ai_steps` tracing. Skeleton; Stage 4 expands to the overseer + multi-step loop.

## Migrations

SQL lives in `../supabase/migrations/`. Applied by the leader via Supabase MCP
— do not apply manually here.
- `0001_init.sql` — profiles, classes, class_members, sessions, nodes + RLS
- `0002`..`0004` — class join RPC, RLS hardening, atomic chat-node append
- `0005_tags.sql` — tags, node_tags + RLS + upsert_node_tags / tag_cooccurrence
- `0006_ai_trace.sql` — ai_sessions, ai_steps (ReAct trace) + owner RLS
