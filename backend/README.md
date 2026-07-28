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
- `GET /auth/me` — caller's profile incl. `onboarded` (Bearer JWT)
- `GET /auth/me/scopes` — personal + class scopes
- `POST /auth/complete-onboarding` — mark onboarding done (D18, via RPC)
- `POST /sessions` — create a conversation session
- `GET /sessions?space_kind=&space_ref=` — sessions in a space (recent first)
- `GET /sessions/{id}` — session + all nodes (tree restore)
- `PATCH /sessions/{id}` {title} — rename · `DELETE /sessions/{id}` — delete (D17)
- `PUT /sessions/{id}/node-positions` {positions:[{node_id,x,y}]} — persist coords (D20)
- `POST /chat/stream` — Gemini SSE chat; persists (Q+A)=1 node, auto-labels,
  auto-tags (inline in `done`), and may emit a `navigator` event. Optional
  `reference_node_ids` injects a one-time "[브랜치 참조]" comparison block (D15,
  not persisted)
- `GET /tags?space_kind=&space_ref=` — own concept tags in a space (most-used)
- `GET /tags/cooccurrence?space_kind=&space_ref=` — co-attached tag pairs
- `DELETE /nodes/{id}` — delete a waiting navigator node (cleanup after click)
- `PATCH /nodes/{id}/position` {position_x,position_y} — persist node coords (D20)
- `POST /nodes/{id}/connections` — memory-link another owned branch node in
- `DELETE /nodes/{id}/connections/{src}` — remove a memory link
- `GET /home/summary` — spaces + recent sessions + top personal concepts
- `GET /home/suggestions` — 3 starter questions (click -> new personal session)
- `POST /overseer/stream` — overseer (home) SSE; `done` carries action buttons

> **주의: 이 README는 Stage 0 시절 문서라 상당 부분이 낡았다.** Supabase·Gemini·
> node-positions 등 이미 제거된 것들이 남아 있다. 현재 사실은 `CLAUDE.md`와
> 코드가 기준이다. 아래 Admin 절만 D113 기준으로 갱신했다.

Admin — 운영 콘솔 (전부 app role `admin` 필요. 관리자 **본인 JWT**로 admin RLS
정책과 SECURITY DEFINER RPC를 탄다 — service_role을 쓰지 않는다):
- `GET /admin/users` · `POST /admin/users/{id}/role` (RPC로 역할 변경)
- `GET /admin/settings` — 튜너블 전체(현재값·기본값·변경여부·위젯 스펙).
  스펙의 소유자는 서버(`services/admin_console.py`)다 — 기본값이 `config.py`에
  있으니 라벨·범위도 옆에 둔다.
- `PUT /admin/settings/{key}` · `POST /admin/settings/{key}/reset`
  (reset은 행을 **지우지 않고** 기본값을 써 넣는다 — 지우면 노브가 사라진다)
- `GET /admin/overview` — 전체 카운터 + 실측 토큰 합계 + 지연 p50/p95 (RPC 1회)
- `GET /admin/flow` — 채팅 한 턴의 파이프라인 그래프(레지스트리·설정에서 생성)
- `GET /admin/skills?days=` — 등록 스킬 + 노출 조합 + 사용 통계
- `GET /admin/conversations?owner_id=&space_kind=&search=&limit=&offset=`
- `GET /admin/conversations/{session_id}` — 노드(학생이 본 것) + 턴 로그(과정)
- `GET /admin/documents?kind=&status=&search=` · `GET /admin/documents/{file_id}`
  (청크 원문·잡 이력·도판까지 — "문서가 어떻게 올라갔는가")
- `POST /admin/rag/test` — 실제 검색 경로를 태우되 게이트에 **차단된 청크도**
  거리와 함께 돌려준다(게이트 조정의 근거)
- `GET /admin/classes` — RAG 테스트 범위 선택용
- `GET /admin/logs?user_id=&since=&until=&limit=&offset=` · `GET /admin/logs/{id}`
  — 턴 로그(`ai_logs`). D113부터 실측 토큰(`tokens`)·경로(`route`)·모델·
  소요시간과 스킬 트레이스(인자·결과·소요시간)가 함께 들어 있다.

Files / RAG (Stage 3b-1; needs `SUPABASE_SERVICE_ROLE_KEY` for upload+worker):
- `POST /files` (multipart: file, space_kind, space_ref?, session_id?,
  position_x?, position_y?, kind?) — Storage + files row + queued
  `embedding_split` job. 503 if no service-role key. `kind='class_material'`
  (teacher only, space_kind='class') shares the file with all class members.
  Images (image/*) are OCR'd via the multimodal model in the worker (Stage 3b-3).
- `GET /files?space_kind=&space_ref=` — list (status, chunk_done/chunk_total)
- `GET /files/{id}` — file status + progress · `GET /files/{id}/tags` — tag names
- `DELETE /files/{id}` — delete (owner; Storage + row cascade)
- `POST /files/{id}/retry` — re-process a failed/partial/stuck file (owner)
- `PATCH /files/{id}/position` {position_x,position_y} — file-node coords (D13)
- `POST /files/{id}/links` {target_node_id} — link a file to a branch (visual RAG)
- `DELETE /files/{id}/links/{node_id}` — unlink
- `GET /sessions/{id}/file-links` — files linked in a session (graph file-nodes)
- `GET /sessions/{id}/file-suggestions?node_id=` — when the branch has no linked
  files, propose space files to link (embedding match); empty otherwise

Teacher (Stage 4b; app role `teacher`; RPCs/RLS in migration 0012):
- `GET /teacher/classes` — classes I teach + student counts
- `GET /teacher/classes/{id}/students` — students of a class I teach
- `GET /teacher/classes/{id}/students/{user_id}/sessions` — a student's
  class-scope sessions (open nodes via `GET /sessions/{id}`)
- `GET /teacher/classes/{id}/materials` — class materials + embedding status
- Materials are uploaded via `POST /files` (kind=class_material). Teachers have
  no chat workspace — there is no teacher chat endpoint.

All request-time DB access uses the caller's JWT (RLS). The background embedding
worker (`services/embedding_worker.py`, apscheduler) uses the SERVICE-ROLE client
(`services/service_client.py`, RLS bypass) and is disabled when the key is unset.

Memory linking (Stage 3a): a node's `connections uuid[]` is injected into chat
context, LCA-trimmed (same session: shared ancestors excluded; other session:
full chain), as a source-labelled reference block — see `services/memory.py`.

Embedding pipeline (Stage 3b-1): upload -> `embedding_split` (extract PDF/txt ->
chunk -> file_chunks(pending) -> fan out `embedding_batch` jobs) -> parallel
batches embed with gemini-embedding-001 (768-dim, L2-normalized) -> file status
`indexed`/`partial`.

Visual RAG + file tagging (Stage 3b-2, `services/rag.py`): a file linked to a
node applies to that node's descendant branch. At chat time, files linked on the
current head's ancestor chain are cosine-searched (RETRIEVAL_QUERY embedding ->
`search_file_chunks` RPC, owner-scoped) and the top-K chunks are injected as a
"[연결된 자료에서 참고]" block. On `indexed`, the worker extracts up to 50 concept
tags and links them via `upsert_file_tags`. OCR, class-material cross-visibility,
and the full no-link search-suggestion flow are Stage 3b-3.

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
