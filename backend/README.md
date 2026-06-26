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
- `POST /nodes/{id}/connections` — memory-link another owned branch node in
- `DELETE /nodes/{id}/connections/{src}` — remove a memory link
- `GET /home/summary` — spaces + recent sessions + top personal concepts
- `GET /home/suggestions` — 3 starter questions (click -> new personal session)
- `POST /overseer/stream` — overseer (home) SSE; `done` carries action buttons

Admin (all require app role `admin`; admin RLS / RPCs in migration 0008):
- `GET /admin/users` · `POST /admin/users/{id}/role` (role change via RPC)
- `GET /admin/settings` · `PUT /admin/settings/{key}` (runtime app_settings)
- `GET /admin/usage` (per-user token totals — PARTIAL: skill-step tokens only)
- `GET /admin/logs?user_id=&limit=&offset=` (ai_sessions + embedded ai_steps)

All DB access uses the caller's JWT (RLS, owner-only writes) — not service_role.

Memory linking (Stage 3a): a node's `connections uuid[]` is injected into chat
context, LCA-trimmed (same session: shared ancestors excluded; other session:
full chain), as a source-labelled reference block — see `services/memory.py`.

## AI layer (`app/ai/`)

- `skills/` — one capability per file, auto-discovered into a `SKILLS` registry;
  `catalog()` renders name+description for prompt injection. Skills receive a
  `SkillContext` (ctx=) with the caller's RLS client + identity.
  Read-skills: `read_my_spaces`, `read_recent_sessions`, `read_top_concepts`,
  `find_sessions_by_topic`; plus `generate_navigator_questions`.
- `react.py` — minimal budgeted ReAct runner with best-effort `ai_sessions` /
  `ai_steps` tracing. The overseer (`services/overseer.py`) runs the read-skills
  to build a workspace snapshot, then streams a navigational reply + action
  buttons.

## Migrations

SQL lives in `../supabase/migrations/`. Applied by the leader via Supabase MCP
— do not apply manually here.
- `0001_init.sql` — profiles, classes, class_members, sessions, nodes + RLS
- `0002`..`0004` — class join RPC, RLS hardening, atomic chat-node append
- `0005_tags.sql` — tags, node_tags + RLS + upsert_node_tags / tag_cooccurrence
- `0006_ai_trace.sql` — ai_sessions, ai_steps (ReAct trace) + owner RLS
