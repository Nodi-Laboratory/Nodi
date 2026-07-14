# 학급 자료 RAG 빈틈 보수 (TASK 2, D73~D76) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 선생님이 학급 워크스페이스에 올린 교과서·자료가 학생 질의에 자동으로
근거 주입되고(D73), 출처가 첫 개념 카드에 칩으로 표시되며(D74), 미지원 형식은
사전 거절(D75), 인제스트 실패는 터미널 상태로 전환되어 재시도·삭제 동선이
생긴다(D76·G3·G5).

**Architecture:** 백엔드는 `rag.build_rag_context`에 학급 자동 스코프(합집합 +
자동 스코프만 거리 게이트)를 추가하고 SSE `done`에 `rag_sources`를 싣는다.
인제스트는 업로드 화이트리스트 + 잡 예외 시 파일 터미널 전환으로 고착을 없앤다.
프론트는 첫 개념 카드에 출처 칩 푸터(라이브 done + 재수화 양쪽), 교사 자료실에
재시도·삭제·업로드 피드백을 붙인다.

**Tech Stack:** FastAPI(백엔드), Next.js App Router + CSS Modules(프론트),
Supabase(RLS)·Qdrant(벡터)·Upstage(임베딩/파싱), pytest.

**스펙:** `docs/superpowers/specs/2026-07-14-teacher-material-rag-gaps-design.md`

## Global Constraints

- **RAG는 채팅을 절대 막지 않는다** — 모든 신규 경로는 기존 try/except 안(best-effort, 실패 시 None).
- **Qdrant는 신뢰 경계가 아니다** — 본문 재조회는 기존 `search()`의 USER 스코프 RLS 경로 그대로(변경 금지).
- **거리 규약** `distance = 1 - score`. 자동 스코프 게이트 기본값 0.50, clamp 0.1~0.9.
- **튜너블(D62)**: `app_settings` 오버레이 > config 기본값. 신규 노브 2종은 `as_bool`/`as_float` + 시드 마이그레이션 `0029_app_settings_class_rag_seed.sql`(파일만 추가 — **원격 적용 금지**).
- **주석·docstring·커밋 메시지는 한국어**, 설계 결정은 D-번호(D73~D76)로 주석에 남긴다. 커밋 프리픽스 `[feat]:`.
- 프론트: 새 UI 라이브러리 도입 금지(토스트 등), CSS Modules·기존 Tailwind 유틸 컨벤션 유지.
- `git add`는 **자기 task의 파일만** (전체 스테이징 금지).
- 백엔드 테스트 실행: 워크트리에서는 메인 저장소 venv 인터프리터 절대경로 사용 —
  `/Users/dhkim/Desktop/ai-rookie/Nodi/backend/.venv/bin/python -m pytest tests/ -v`
  (시작 시 메인 저장소 `backend/.env`를 자기 워크트리 `backend/.env`로 복사).

## 파일 경계 (task 간 서로소 — 4개 전부 병렬 가능)

| task | 파일 |
|---|---|
| 1 (백엔드 RAG) | `backend/app/services/rag.py`, `backend/app/config.py`, `backend/app/routers/chat.py`, `supabase/migrations/0029_app_settings_class_rag_seed.sql`, `backend/tests/test_rag_class_scope.py`, `backend/tests/test_chat_sources.py` |
| 2 (백엔드 인제스트) | `backend/app/services/files.py`, `backend/app/services/embedding_worker.py`, `backend/tests/test_upload_whitelist.py`, `backend/tests/test_worker_terminal.py` |
| 3 (프론트 출처 칩) | `frontend/src/lib/types.ts`, `frontend/src/lib/concept/types.ts`, `frontend/src/lib/concept/useConceptStream.ts`, `frontend/src/components/canvas/ConceptCard.tsx`, `frontend/src/components/canvas/ConceptCard.module.css` |
| 4 (프론트 자료실 UX) | `frontend/src/components/teacher/MaterialsTab.tsx` |

---

### Task 1: 학급 자료 자동 RAG 스코프(D73) + done 출처 전달(D74 백엔드)

**Files:**
- Modify: `backend/app/config.py` (rag_top_k 근처, ~113행)
- Modify: `backend/app/services/rag.py` (`build_rag_context` ~199행 + 새 헬퍼)
- Modify: `backend/app/routers/chat.py` (호출부 ~156행, done 페이로드 ~249행)
- Create: `supabase/migrations/0029_app_settings_class_rag_seed.sql`
- Test: `backend/tests/test_rag_class_scope.py`, `backend/tests/test_chat_sources.py`

**Interfaces:**
- Consumes: 기존 `rag.search(client, file_ids, query)`, `app_settings.as_bool/as_float`,
  `svc.get_session`이 반환하는 세션 행의 `space_kind`/`space_ref`(SESSION_SELECT에 이미 포함).
- Produces: `rag.build_rag_context(client, chain, query, *, space_kind=None, space_ref=None)`
  (keyword-only, 기본 None → 기존 호출 무회귀). SSE `done`의 `node.rag_sources`:
  `[{file_id, chunk_id, name, seq, page, distance, snippet}]` (Task 3이 소비).

- [ ] **Step 1: 실패 테스트 작성 — `backend/tests/test_rag_class_scope.py`**

```python
"""D73 — 학급 자료(class_material) 자동 RAG 스코프 주입 테스트.

build_rag_context가 학급 세션에서 링크 없이도 class_material을 검색 후보에
넣고, 자동 스코프(비링크) 청크에만 거리 게이트를 적용하는지 검증한다.
외부 의존(임베딩·Qdrant·app_settings 오버레이)은 전부 monkeypatch.
"""

import pytest

from app.services import rag as R


class _FakeClient:
    """테이블별 응답 핸들러를 주입하는 UserClient 대역."""

    def __init__(self, responses):
        self.responses = responses  # {table: callable(params) -> rows}
        self.calls = []  # (table, params) 기록 — 쿼리 발생 여부 검증용

    async def select(self, table, params):
        self.calls.append((table, params))
        handler = self.responses.get(table)
        return handler(params) if handler else []


def _files_handler(material_rows):
    """files 테이블 대역 — class_material 조회와 _file_names 조회를 구분."""

    def handle(params):
        if params.get("select") == "id,storage_path":  # _file_names
            return [
                {"id": r["id"], "storage_path": f"o/{r['id']}/{r['id']}.pdf"}
                for r in material_rows
            ]
        if params.get("kind") == "eq.class_material":  # 자동 스코프 조회
            return material_rows
        return []

    return handle


def _patch_infra(monkeypatch, hits, overlay=None):
    """임베딩·Qdrant·오버레이를 고정 응답으로 대체.

    hits: [{"id": 청크uuid, "score": 유사도, "_file": 파일id}] — _file은
    파일 스코프 필터 모사용 테스트 전용 키(반환 시 제거).
    """

    async def fake_embed(texts, task_type):
        assert task_type == "RETRIEVAL_QUERY"  # 비대칭 임베딩 불변식
        return [[0.1] * 4]

    async def fake_qdrant_search(collection, vector, k, file_ids=None):
        allowed = set(file_ids or [])
        return [
            {"id": h["id"], "score": h["score"]}
            for h in hits
            if h["_file"] in allowed
        ]

    async def fake_overlay():
        return overlay or {}

    monkeypatch.setattr(R.embedding, "embed_texts", fake_embed)
    monkeypatch.setattr(R.qdrant_store, "search", fake_qdrant_search)
    monkeypatch.setattr(R.app_settings, "get_overlay", fake_overlay)


def _chunk_rows(hits):
    return [
        {
            "id": h["id"],
            "file_id": h["_file"],
            "seq": i,
            "chunk_text": f"본문 {h['id']}",
            "meta": {},
        }
        for i, h in enumerate(hits)
    ]


CHAIN = [{"id": "n1"}]


@pytest.mark.asyncio
async def test_class_scope_included_without_links(monkeypatch):
    """① 링크 0개여도 학급 세션이면 class_material이 검색·주입된다."""
    hits = [{"id": "ck1", "score": 0.8, "_file": "fm"}]  # distance 0.2 ≤ 0.5
    _patch_infra(monkeypatch, hits)
    client = _FakeClient(
        {
            "file_node_links": lambda p: [],
            "files": _files_handler([{"id": "fm"}]),
            "file_chunks": lambda p: _chunk_rows(hits),
        }
    )
    out = await R.build_rag_context(
        client, CHAIN, "질문", space_kind="class", space_ref="c1"
    )
    assert out is not None
    assert [s["file_id"] for s in out["sources"]] == ["fm"]
    assert "본문 ck1" in out["block"]


@pytest.mark.asyncio
async def test_distance_gate_applies_to_auto_scope_only(monkeypatch):
    """② 자동 스코프 청크만 거리 게이트 — 링크 청크는 무게이트."""
    hits = [
        {"id": "ck-linked", "score": 0.3, "_file": "fl"},  # 링크, dist 0.7 → 유지
        {"id": "ck-auto-far", "score": 0.3, "_file": "fm"},  # 자동, dist 0.7 → 탈락
        {"id": "ck-auto-near", "score": 0.8, "_file": "fm"},  # 자동, dist 0.2 → 유지
    ]
    _patch_infra(monkeypatch, hits)

    def files_handle(params):
        if params.get("select") == "id,storage_path":
            return [
                {"id": "fl", "storage_path": "o/fl/linked.pdf"},
                {"id": "fm", "storage_path": "o/fm/material.pdf"},
            ]
        if params.get("kind") == "eq.class_material":
            return [{"id": "fm"}]
        return []

    client = _FakeClient(
        {
            "file_node_links": lambda p: [{"file_id": "fl"}],
            "files": files_handle,
            "file_chunks": lambda p: _chunk_rows(hits),
        }
    )
    out = await R.build_rag_context(
        client, CHAIN, "질문", space_kind="class", space_ref="c1"
    )
    assert out is not None
    ids = {s["chunk_id"] for s in out["sources"]}
    assert ids == {"ck-linked", "ck-auto-near"}


@pytest.mark.asyncio
async def test_kill_switch_off_restores_linked_only(monkeypatch):
    """③ 킬 스위치 off → class_material 조회 자체가 없고 링크 없으면 None."""
    _patch_infra(
        monkeypatch, hits=[], overlay={"class_material_rag_enabled": False}
    )
    client = _FakeClient(
        {"file_node_links": lambda p: [], "files": _files_handler([{"id": "fm"}])}
    )
    out = await R.build_rag_context(
        client, CHAIN, "질문", space_kind="class", space_ref="c1"
    )
    assert out is None
    assert all(t != "files" for t, _ in client.calls)  # 자동 스코프 조회 없음


@pytest.mark.asyncio
async def test_personal_space_unchanged(monkeypatch):
    """④ personal 공간 → 기존 동작 불변(자동 스코프 미조회, 링크 없으면 None)."""
    _patch_infra(monkeypatch, hits=[])
    client = _FakeClient({"file_node_links": lambda p: []})
    out = await R.build_rag_context(
        client, CHAIN, "질문", space_kind="personal", space_ref="u1"
    )
    assert out is None
    assert all(t != "files" for t, _ in client.calls)


@pytest.mark.asyncio
async def test_signature_backward_compatible(monkeypatch):
    """kwargs 없이 호출해도 기존 링크-온리 동작(무회귀)."""
    _patch_infra(monkeypatch, hits=[])
    client = _FakeClient({"file_node_links": lambda p: []})
    out = await R.build_rag_context(client, CHAIN, "질문")
    assert out is None
```

- [ ] **Step 2: 실패 테스트 작성 — `backend/tests/test_chat_sources.py`**

```python
"""D74(백엔드) — SSE done 이벤트의 node.rag_sources 전달 + D73 호출부 배선 테스트."""

import json

import pytest

from app.routers import chat as C
from app.routers.chat import ChatStreamBody


class _FakeUser:
    id = "u1"
    email = "u@test"


class _FakeClient:
    async def update(self, *a, **k):
        return None

    async def select(self, *a, **k):
        return []


async def _fake_stream_answer(history, question, system_prompt):
    yield "@concept: 개념\n"
    yield "- 본문\n"
    yield "@end\n"


SOURCES = [
    {
        "file_id": "f1",
        "chunk_id": "ck1",
        "name": "교과서.pdf",
        "seq": 3,
        "page": 12,
        "distance": 0.21,
        "snippet": "지구과학 본문…",
    }
]


async def _consume(monkeypatch):
    """chat_stream을 최소 목으로 구동 — done 이벤트와 rag 호출 kwargs를 반환."""
    monkeypatch.setattr(
        C.UserClient, "from_user", classmethod(lambda cls, u: _FakeClient())
    )

    async def fake_get_session(client, sid):
        return {
            "owner_id": "u1",
            "current_head_id": None,
            "root_node_id": None,
            "space_kind": "class",
            "space_ref": "class-1",
        }

    async def fake_get_nodes(client, sid):
        return []

    monkeypatch.setattr(C.svc, "get_session", fake_get_session)
    monkeypatch.setattr(C.svc, "get_session_nodes", fake_get_nodes)
    monkeypatch.setattr(C.svc, "ancestor_chain_nodes", lambda nodes, pid: [])

    async def fake_reference(*a, **k):
        return (None, [])

    rag_kwargs = {}

    async def fake_rag(client, chain, query, **kwargs):
        rag_kwargs.update(kwargs)
        return {"block": "[연결된 자료에서 참고]\n- x", "sources": SOURCES}

    async def fake_comparison(*a, **k):
        return (None, [], [])

    monkeypatch.setattr(C.memory, "build_reference_context", fake_reference)
    monkeypatch.setattr(C.rag, "build_rag_context", fake_rag)
    monkeypatch.setattr(C.memory, "build_comparison_context", fake_comparison)
    monkeypatch.setattr(
        C.gemini, "compose_system_structured", lambda *a, **k: ("sys", [])
    )
    monkeypatch.setattr(C.exaone, "CONCEPT_CARD_SYSTEM_PROMPT", "base", raising=False)
    monkeypatch.setattr(C.exaone, "stream_answer", _fake_stream_answer)

    async def fake_append_node(client, sid, pid, q, a, label):
        return {"id": "node-1", "parent_id": None}

    monkeypatch.setattr(C.svc, "append_node", fake_append_node)

    class _FakeTurnLog:
        def __init__(self, *a, **k):
            pass

        def set_system(self, *a, **k):
            pass

        def set_contexts_structured(self, *a, **k):
            pass

        def set_final(self, *a, **k):
            pass

        def add_error(self, *a, **k):
            pass

        async def save(self, *a, **k):
            pass

    monkeypatch.setattr(C, "TurnLog", _FakeTurnLog)

    body = ChatStreamBody(session_id="s1", question="질문")
    resp = await C.chat_stream(body, user=_FakeUser())
    events = []
    async for chunk in resp.body_iterator:
        events.append(chunk)
    return events, rag_kwargs


def _done_payload(events):
    for e in events:
        if e.startswith("event: done"):
            return json.loads(e.split("data: ", 1)[1])
    return None


@pytest.mark.asyncio
async def test_done_includes_rag_sources(monkeypatch):
    """⑤ done 이벤트 node에 rag_sources가 실린다(실시간 출처 칩 표시용)."""
    events, _ = await _consume(monkeypatch)
    done = _done_payload(events)
    assert done is not None
    assert done["node"]["rag_sources"] == SOURCES


@pytest.mark.asyncio
async def test_rag_called_with_session_space(monkeypatch):
    """D73 배선 — build_rag_context에 세션의 space_kind/space_ref가 전달된다."""
    _, rag_kwargs = await _consume(monkeypatch)
    assert rag_kwargs == {"space_kind": "class", "space_ref": "class-1"}
```

- [ ] **Step 3: RED 확인**

Run: `cd backend && /Users/dhkim/Desktop/ai-rookie/Nodi/backend/.venv/bin/python -m pytest tests/test_rag_class_scope.py tests/test_chat_sources.py -v`
Expected: FAIL — `build_rag_context() got an unexpected keyword argument 'space_kind'` 및 done에 `rag_sources` 부재(KeyError).

- [ ] **Step 4: `backend/app/config.py` — 튜너블 2종 추가**

`rag_top_k: int = 5` 라인(~113행) 바로 위 `# --- File RAG search + tagging (Stage 3b-2) ---` 섹션 안, `rag_top_k` 다음 줄에 삽입:

```python
    # --- D73: 학급 자료 자동 RAG 스코프 (TASK 2) ---
    # 학급 세션이면 그 학급의 class_material(indexed/partial)을 링크 없이도
    # 검색 후보에 넣는다. enabled는 신규 자동 주입 경로의 킬 스위치(D62 오버레이).
    class_material_rag_enabled: bool = True
    # 자동 스코프(비링크) 청크에만 적용하는 거리 게이트 — 링크 청크는 무게이트.
    # 기존 공유 컷오프 0.50 의미 계승, distance = 1 - score (Qdrant cosine).
    class_material_rag_max_distance: float = 0.50
```

- [ ] **Step 5: `backend/app/services/rag.py` — 자동 스코프 헬퍼 + build_rag_context 확장**

`_file_names` 함수 뒤, `build_rag_context` 앞에 헬퍼 추가:

```python
async def class_material_file_ids(
    client: UserClient, space_ref: str
) -> list[str]:
    """학급 자료(class_material) 중 검색 가능한(indexed/partial) 파일 id들 (D73).

    partial도 임베딩된 청크는 검색 가능. USER 스코프 조회 — RLS(0012)가 학급
    구성원 여부를 재검증한다.
    """
    rows = await client.select(
        "files",
        {
            "space_kind": "eq.class",
            "space_ref": f"eq.{space_ref}",
            "kind": "eq.class_material",
            "status": "in.(indexed,partial)",
            "select": "id",
        },
    )
    return [r["id"] for r in rows if r.get("id")]
```

`build_rag_context` 전체를 다음으로 교체:

```python
async def build_rag_context(
    client: UserClient,
    chain: list[dict[str, Any]],
    query: str,
    *,
    space_kind: str | None = None,
    space_ref: str | None = None,
) -> dict[str, Any] | None:
    """Best-effort: assemble the linked-file reference block + source metadata.

    D73: 학급 세션(space_kind='class')이면 그 학급의 class_material 파일을
    링크 파일과 **합집합**으로 검색한다. 자동 스코프(비링크) 청크에만 거리
    게이트(class_material_rag_max_distance)를 적용해 인사말·무관 질의 턴의
    프롬프트 오염을 막고, 링크 청크는 기존대로 무게이트(사용자가 명시한 신뢰).

    Returns ``{"block": str, "sources": [ {file_id, name, seq, page, distance,
    snippet} ]}`` or ``None`` when there is nothing to inject. Callers use
    ``block`` for the system prompt and ``sources`` for node/log provenance (D32).
    """
    try:
        linked = await linked_file_ids(client, chain)
        auto_ids: list[str] = []
        max_dist: float | None = None
        if space_kind == "class" and space_ref:
            overlay = await app_settings.get_overlay()
            if app_settings.as_bool(
                overlay,
                "class_material_rag_enabled",
                settings.class_material_rag_enabled,
            ):
                linked_set = set(linked)
                auto_ids = [
                    f
                    for f in await class_material_file_ids(client, space_ref)
                    if f not in linked_set
                ]
                max_dist = app_settings.as_float(
                    overlay,
                    "class_material_rag_max_distance",
                    settings.class_material_rag_max_distance,
                    0.1,
                    0.9,
                )
        file_ids = linked + auto_ids
        if not file_ids:
            return None
        chunks = await search(client, file_ids, query)
        if auto_ids and max_dist is not None:
            # D73: 자동 스코프 청크만 거리 게이트(링크 청크는 무게이트).
            linked_set = set(linked)
            chunks = [
                c
                for c in chunks
                if c.get("file_id") in linked_set
                or (c.get("distance") is not None and c["distance"] <= max_dist)
            ]
        if not chunks:
            return None
        hit_ids = list({c.get("file_id") for c in chunks if c.get("file_id")})
        names = await _file_names(client, hit_ids)
        block = build_block(chunks, names)
        if not block:
            return None
        # D76 부수: 주입 관측성 — 마무리 E2E의 주입 증거(기존 RAG 관측성 0).
        logger.info(
            "RAG 주입: files=%d(링크 %d·자동 %d) chunks=%d",
            len(hit_ids),
            len(linked),
            len(auto_ids),
            len(chunks),
        )
        return {"block": block, "sources": build_sources(chunks, names)}
    except Exception:  # noqa: BLE001 - RAG must never break chat
        logger.exception("RAG retrieval failed")
        return None
```

- [ ] **Step 6: `backend/app/routers/chat.py` — 호출부 배선 + done 페이로드**

(a) ~156행 gather 안의 `rag.build_rag_context(client, chain, body.question),`을 교체:

```python
        rag.build_rag_context(
            client,
            chain,
            body.question,
            # D73: 학급 세션이면 class_material 자동 스코프 — 세션 행에 이미
            # space_kind/space_ref가 있어 추가 조회 없음(SESSION_SELECT).
            space_kind=session.get("space_kind"),
            space_ref=session.get("space_ref"),
        ),
```

(b) ~249행 done 이벤트의 `node` 객체에 `rag_sources` 추가:

```python
                yield _sse(
                    "done",
                    {
                        "node": {
                            "id": node["id"],
                            "parent_id": node.get("parent_id"),
                            "label": None,
                            "tags": [],
                            "reference_sources": comparison_sources or [],
                            # D74: 실시간 출처 칩 표시용(영속은 위 PATCH가 담당).
                            "rag_sources": rag_sources or [],
                        },
                        "current_head_id": node["id"],
                        "root_node_id": existing_root or node["id"],
                    },
                )
```

- [ ] **Step 7: `supabase/migrations/0029_app_settings_class_rag_seed.sql` 생성**

```sql
-- ============================================================================
-- nodi — migration 0029 (TASK 2 / D73 — 학급 자료 자동 RAG 스코프 튜너블 시드)
-- 스펙: docs/superpowers/specs/2026-07-14-teacher-material-rag-gaps-design.md
--
-- DRAFT — 여기서 원격 적용하지 않는다(파일만 추가, 배포 시 적용). 미적용
-- 상태에서도 런타임은 config.py 기본값으로 동작한다(D62 오버레이 폴백).
-- 완전 비파괴: 시드 INSERT만, DDL·UPDATE 없음.
--
-- Why: admin 콘솔(SettingsTab)은 app_settings에 행이 있는 키만 위젯으로
-- 노출한다. D73 신규 노브 2종을 config 기본값으로 시드해 admin에서 라이브
-- 튜닝 가능하게 한다. on conflict do nothing — 이미 설정된 값 보존(멱등).
-- ============================================================================

insert into public.app_settings (key, value) values
    -- 학급 자료 자동 주입 경로 킬 스위치.
    ('class_material_rag_enabled',      'true'::jsonb),
    -- 자동 스코프(비링크) 청크 거리 게이트 (distance = 1 - score, clamp 0.1~0.9).
    ('class_material_rag_max_distance', '0.50'::jsonb)
on conflict (key) do nothing;

-- End of 0029_app_settings_class_rag_seed.sql
```

- [ ] **Step 8: GREEN 확인 (신규 2파일 + 전체 스위트)**

Run: `cd backend && /Users/dhkim/Desktop/ai-rookie/Nodi/backend/.venv/bin/python -m pytest tests/ -v`
Expected: 전체 PASS (기존 test_chat_place의 `fake_rag(*a, **k)`는 kwargs를 흡수하므로 무회귀).

- [ ] **Step 9: 커밋**

```bash
git add backend/app/config.py backend/app/services/rag.py backend/app/routers/chat.py supabase/migrations/0029_app_settings_class_rag_seed.sql backend/tests/test_rag_class_scope.py backend/tests/test_chat_sources.py
git commit -m "[feat]: 학급 자료 자동 RAG 스코프(D73) + done 출처 전달(D74 백엔드) — 링크 합집합·자동 게이트·튜너블 2종"
```

---

### Task 2: 업로드 형식 화이트리스트(D75 서버) + 잡 예외 파일 터미널 전환(D76)

**Files:**
- Modify: `backend/app/services/files.py` (`upload_file` ~60행)
- Modify: `backend/app/services/embedding_worker.py` (`_fail_file_for_job` ~191행, `_process` ~557행)
- Test: `backend/tests/test_upload_whitelist.py`, `backend/tests/test_worker_terminal.py`

**Interfaces:**
- Consumes: 기존 `_fail_job`, `_fail_file_for_job`, `_finalize_file`, `settings.embedding_max_attempts`(=3), `_claim_jobs`가 claim 시 attempts를 +1 해두는 규약.
- Produces: `files.ALLOWED_UPLOAD_EXTENSIONS`(frozenset), `files.UNSUPPORTED_TYPE_DETAIL`(한국어 422 사유 — Task 4가 같은 문구를 클라에 복제),
  `_fail_file_for_job(svc, job, error="split failed")` (error 파라미터 추가).

- [ ] **Step 1: 실패 테스트 작성 — `backend/tests/test_upload_whitelist.py`**

```python
"""D75 — 업로드 형식 화이트리스트 테스트.

_extract_text가 실제로 처리 가능한 형식(pdf/이미지/텍스트)만 수락하고,
그 외(zip/docx/확장자 없음)는 스토리지 업로드 전에 422로 거절한다.
"""

import pytest
from fastapi import HTTPException

from app.services import files as F


class _FakeService:
    def __init__(self):
        self.storage = []
        self.inserted = []

    async def storage_upload(self, bucket, path, data, mime):
        self.storage.append(path)

    async def insert(self, table, row, returning=True):
        self.inserted.append((table, row))
        return [dict(row)] if returning and isinstance(row, dict) else None


class _FakeUserClient:
    async def select(self, *a, **k):
        return [{"class_id": "c1"}]

    async def rpc(self, *a, **k):
        return True


async def _fake_overlay():
    return {}


async def _upload(svc, name, mime=None):
    return await F.upload_file(
        svc, _FakeUserClient(), "u1", "personal", None, name, mime, b"data"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["archive.zip", "report.docx", "한글.hwp", "noext"])
async def test_unsupported_format_rejected_422(monkeypatch, name):
    """⑥ 미지원 형식은 422 + 한국어 사유, 스토리지 업로드 전에 거절."""
    monkeypatch.setattr(F.app_settings, "get_overlay", _fake_overlay)
    svc = _FakeService()
    with pytest.raises(HTTPException) as ei:
        await _upload(svc, name)
    assert ei.value.status_code == 422
    assert "지원 형식" in ei.value.detail
    assert svc.storage == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "name",
    ["doc.pdf", "scan.PNG", "photo.jpg", "img.jpeg", "pic.webp", "ani.gif",
     "메모.txt", "note.md"],
)
async def test_supported_format_accepted(monkeypatch, name):
    """화이트리스트 형식(대소문자 무관)은 기존 흐름대로 업로드된다."""
    monkeypatch.setattr(F.app_settings, "get_overlay", _fake_overlay)
    svc = _FakeService()
    row = await _upload(svc, name)
    assert row["status"] == "uploaded"
    assert len(svc.storage) == 1
    assert any(t == "jobs" for t, _ in svc.inserted)  # split 잡 큐잉 유지
```

- [ ] **Step 2: 실패 테스트 작성 — `backend/tests/test_worker_terminal.py`**

```python
"""D76 — 잡 즉시 예외 경로의 재시도·파일 터미널 전환 테스트.

split 잡이 예외로 죽을 때: attempts가 남으면 재큐, 소진 시 잡 failed +
files.status='failed'(고착 방지). batch 잡 소진 시 _finalize_file(partial 경로).
"""

import pytest

from app.services import embedding_worker as W


class _FakeService:
    """update 호출을 (table, filters, values)로 기록하는 대역."""

    def __init__(self):
        self.updates = []

    async def update(self, table, filters, values):
        self.updates.append((table, filters, values))
        return [values]


def _boom(monkeypatch, handler_name):
    async def boom(svc, job):
        raise RuntimeError("upstage 400")

    monkeypatch.setattr(W, handler_name, boom)


@pytest.mark.asyncio
async def test_split_exception_attempts_left_requeues(monkeypatch):
    """attempts가 남으면 잡을 재큐하고 파일은 건드리지 않는다."""
    _boom(monkeypatch, "_handle_split")
    svc = _FakeService()
    job = {"id": "j1", "kind": "embedding_split", "target_id": "f1", "attempts": 1}
    await W._process(svc, job)
    assert all(t != "files" for t, _, _ in svc.updates)
    assert any(
        t == "jobs" and v.get("status") == "queued" for t, _, v in svc.updates
    )


@pytest.mark.asyncio
async def test_split_exception_attempts_exhausted_fails_file(monkeypatch):
    """⑦ attempts 소진 시 잡 failed + files.status='failed' + error 기록."""
    _boom(monkeypatch, "_handle_split")
    svc = _FakeService()
    job = {
        "id": "j1",
        "kind": "embedding_split",
        "target_id": "f1",
        "attempts": W.settings.embedding_max_attempts,
    }
    await W._process(svc, job)
    file_updates = [v for t, _, v in svc.updates if t == "files"]
    assert any(v.get("status") == "failed" and v.get("error") for v in file_updates)
    assert any(
        t == "jobs" and v.get("status") == "failed" for t, _, v in svc.updates
    )


@pytest.mark.asyncio
async def test_batch_exception_attempts_exhausted_finalizes(monkeypatch):
    """batch 잡 소진 시 기존 _finalize_file 경로(partial)로 마감한다."""
    _boom(monkeypatch, "_handle_batch")
    finalized = []

    async def fake_finalize(svc, file_id):
        finalized.append(file_id)

    monkeypatch.setattr(W, "_finalize_file", fake_finalize)
    svc = _FakeService()
    job = {
        "id": "j2",
        "kind": "embedding_batch",
        "target_id": "f2",
        "attempts": W.settings.embedding_max_attempts,
        "batch_range": {},
    }
    await W._process(svc, job)
    assert finalized == ["f2"]
```

- [ ] **Step 3: RED 확인**

Run: `cd backend && /Users/dhkim/Desktop/ai-rookie/Nodi/backend/.venv/bin/python -m pytest tests/test_upload_whitelist.py tests/test_worker_terminal.py -v`
Expected: FAIL — 422 미발생(zip이 통과), 재큐 대신 즉시 `_fail_job`(files 미전환).

- [ ] **Step 4: `backend/app/services/files.py` — 화이트리스트**

`FILE_SELECT` 정의 아래에 상수 추가:

```python
# D75: 업로드 형식 화이트리스트 — _extract_text(embedding_worker)의 실제 처리
# 능력과 일치시킨다(Upstage Document Parse: pdf/이미지, UTF-8 디코드: txt/md).
# 목록 밖은 스토리지 업로드 전에 422로 거절(깨진 청킹·splitting 고착 예방).
ALLOWED_UPLOAD_EXTENSIONS = frozenset(
    {"pdf", "png", "jpg", "jpeg", "webp", "gif", "txt", "md"}
)
UNSUPPORTED_TYPE_DETAIL = (
    "지원 형식: PDF, 이미지(PNG/JPG/WEBP/GIF), 텍스트(TXT/MD)"
)
```

`upload_file` 안, class 권한 검증 블록(`if space_kind == "class": ...`) 바로 다음·`if not data:` 앞에 삽입:

```python
    # D75: 형식 화이트리스트 — 확장자 기준(대소문자 무관), 저장 전에 거절.
    name_lower = (filename or "").lower()
    ext = name_lower.rsplit(".", 1)[-1] if "." in name_lower else ""
    if ext not in ALLOWED_UPLOAD_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=UNSUPPORTED_TYPE_DETAIL,
        )
```

- [ ] **Step 5: `backend/app/services/embedding_worker.py` — 터미널 전환**

(a) `_fail_file_for_job` 전체를 다음으로 교체(error 파라미터 추가 — else 분기는 기존과 동일):

```python
async def _fail_file_for_job(
    svc: ServiceClient, job: dict[str, Any], error: str = "split failed"
) -> None:
    """Drive the file to a terminal status when a job permanently fails."""
    file_id = job.get("target_id")
    if not file_id:
        return
    if job.get("kind") == "embedding_split":
        # D76: 실패 사유를 파일 행에 남긴다(교사 자료실 실패 배지의 안내 문구).
        await svc.update(
            "files",
            {"id": f"eq.{file_id}"},
            {"status": "failed", "error": error[:500]},
        )
    else:  # embedding_batch: fail this batch's still-pending chunks, then finalize
        rng = job.get("batch_range") or {}
        if "from_seq" in rng and "to_seq" in rng:
            await svc.update(
                "file_chunks",
                {
                    "file_id": f"eq.{file_id}",
                    "and": f"(seq.gte.{int(rng['from_seq'])},seq.lt.{int(rng['to_seq'])})",
                    "status": "eq.pending",
                },
                {"status": "failed"},
            )
        await _finalize_file(svc, file_id)
```

(b) `_process`의 except 블록을 교체:

```python
async def _process(svc: ServiceClient, job: dict[str, Any]) -> None:
    try:
        if job["kind"] == "embedding_split":
            await _handle_split(svc, job)
        elif job["kind"] == "embedding_batch":
            await _handle_batch(svc, job)
        else:
            await _fail_job(svc, job["id"], f"unknown kind {job['kind']}")
    except Exception as exc:  # noqa: BLE001
        logger.exception("Job %s failed", job.get("id"))
        try:
            # D76: 즉시 예외도 스테일 복구와 동일 정책 — attempts가 남으면
            # 재큐(다음 폴에서 재시도), 소진 시 잡 failed + 파일 터미널 전환.
            # 기존에는 잡만 failed 처리해 files.status가 'splitting'에 영구
            # 고착됐다(G6 — 실패 배지가 안 떠 재시도 동선의 전제가 붕괴).
            if (job.get("attempts") or 0) < settings.embedding_max_attempts:
                await svc.update(
                    "jobs",
                    {"id": f"eq.{job['id']}"},
                    {"status": "queued", "updated_at": _now_iso()},
                )
            else:
                await _fail_job(svc, job["id"], str(exc))
                await _fail_file_for_job(svc, job, str(exc) or "split failed")
        except Exception:  # noqa: BLE001
            logger.exception("Could not mark job failed")
```

- [ ] **Step 6: GREEN 확인 (전체 스위트)**

Run: `cd backend && /Users/dhkim/Desktop/ai-rookie/Nodi/backend/.venv/bin/python -m pytest tests/ -v`
Expected: 전체 PASS.

- [ ] **Step 7: 커밋**

```bash
git add backend/app/services/files.py backend/app/services/embedding_worker.py backend/tests/test_upload_whitelist.py backend/tests/test_worker_terminal.py
git commit -m "[feat]: 업로드 형식 화이트리스트(D75 서버) + 잡 예외 파일 터미널 전환(D76) — splitting 고착 방지"
```

---

### Task 3: 첫 개념 카드 출처 칩 (D74 프론트)

**Files:**
- Modify: `frontend/src/lib/types.ts` (`ChatDoneEvent.node`, ~192행)
- Modify: `frontend/src/lib/concept/types.ts` (`Concept`)
- Modify: `frontend/src/lib/concept/useConceptStream.ts` (`replayNodes` + `send`)
- Modify: `frontend/src/components/canvas/ConceptCard.tsx`
- Modify: `frontend/src/components/canvas/ConceptCard.module.css`

**Interfaces:**
- Consumes: SSE `done`의 `node.rag_sources`(Task 1 산출 — `[{file_id, chunk_id,
  name, seq, page, distance, snippet}]`), `NodeRow.rag_sources`(types.ts에 기존
  존재), `RagSource` 타입(types.ts 132행), `firstIdxByNode` 패턴.
- Produces: `Concept.sources?: RagSource[] | null` (턴의 첫 개념에만 부착).

- [ ] **Step 1: `frontend/src/lib/types.ts` — ChatDoneEvent에 rag_sources 추가**

`ChatDoneEvent`의 `node` 객체에 `navigator_meta` 다음 필드 추가:

```ts
    /** D74: 이번 턴 RAG 출처(있으면). 리페치 전에도 첫 개념 카드 출처 칩 즉시 표시. */
    rag_sources?: RagSource[] | null;
```

- [ ] **Step 2: `frontend/src/lib/concept/types.ts` — Concept.sources**

파일 상단에 임포트 추가:

```ts
import type { RagSource } from "@/lib/types";
```

`Concept` 인터페이스의 `pending?: boolean;` 앞에 필드 추가:

```ts
  /** D74: 이 턴(노드)의 RAG 출처 — 턴의 첫 개념에만 부착(출처 칩 푸터). */
  sources?: RagSource[] | null;
```

- [ ] **Step 3: `frontend/src/lib/concept/useConceptStream.ts` — 라이브 + 재수화 부착**

(a) `replayNodes`의 `if (built.length > before) firstIdxByNode.set(n.id, before);`를 교체:

```ts
    if (built.length > before) {
      firstIdxByNode.set(n.id, before);
      // D74: 노드(턴) 단위 출처는 그 답변의 첫 개념에만 부착(칩 푸터).
      if (n.rag_sources?.length) {
        built[before] = { ...built[before], sources: n.rag_sources };
      }
    }
```

(b) `send` 안 — `(d) cstart 없이 끝났으면 … 플레이스홀더 회수` 블록 바로 뒤에 삽입:

```ts
      // (d-2) D74: 이번 턴 RAG 출처를 승격된 첫 개념에 부착 — 승격이 id를
      // 보존하므로 placeholderId로 찾는다(개념이 안 만들어졌으면 no-op).
      const ragSources = doneBox.current?.node?.rag_sources;
      if (ragSources?.length && placeholderId) {
        commitConcepts(
          conceptsRef.current.map((c) =>
            c.id === placeholderId ? { ...c, sources: ragSources } : c,
          ),
        );
      }
```

- [ ] **Step 4: `frontend/src/components/canvas/ConceptCard.tsx` — 출처 칩 푸터**

(a) 임포트 추가:

```ts
import type { RagSource } from "@/lib/types";
```

(b) `cardHeight` 함수 아래에 헬퍼·상수 추가:

```ts
// D74: 출처 칩 푸터 높이 보정(px) — 카드가 인라인 height + overflow:hidden이라
// 푸터만큼 높이를 늘려야 칩이 잘리지 않는다(CSS max-height 560 클램프는 유지).
const SOURCES_EXTRA_H = 36;

// D74: 파일 단위 중복 제거 칩(최대 3개 + 초과 개수). 노드(턴) 단위 provenance라
// 턴의 첫 개념에만 sources가 부착된다(useConceptStream).
function sourceChips(sources: RagSource[]): { chips: string[]; more: number } {
  const byFile = new Map<string, string>();
  for (const s of sources) {
    if (byFile.has(s.file_id)) continue;
    const page = s.page != null ? ` · p.${s.page}` : "";
    byFile.set(s.file_id, `${s.name || "자료"}${page}`);
  }
  const all = [...byFile.values()];
  return { chips: all.slice(0, 3), more: Math.max(0, all.length - 3) };
}
```

(c) 실카드 분기의 구조 분해에 `sources` 추가:

```ts
  const { id, title, cluster, blocks = [], x = 0, y = 0, pending, sources } = concept;
```

(단, 구조 분해는 함수 첫 줄 한 곳이므로 pending 분기보다 위 — 기존 라인에 `sources`만 추가.)

(d) 실카드 높이 계산을 교체:

```ts
  const hasSources = !!sources && sources.length > 0;
  const h =
    cardHeight(concept, paras.length) + (hasSources ? SOURCES_EXTRA_H : 0);
```

(e) `</article>` 직전, 본문 `{paras.length > 0 && (...)}` 블록 뒤에 푸터 렌더 추가:

```tsx
      {hasSources && (() => {
        const { chips, more } = sourceChips(sources ?? []);
        return (
          <footer className={styles.sources} data-testid="concept-card-sources">
            {chips.map((label) => (
              <span key={label} className={styles.sourceChip} title={label}>
                📄 {label}
              </span>
            ))}
            {more > 0 && <span className={styles.sourceMore}>+{more}</span>}
          </footer>
        );
      })()}
```

- [ ] **Step 5: `frontend/src/components/canvas/ConceptCard.module.css` — 칩 스타일**

파일 끝에 추가:

```css
/* ── D74: 출처 칩 푸터 — 턴의 첫 개념 카드 하단, 파일 단위 중복 제거 ── */
.sources {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
}
.sourceChip {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-body);
  font-size: 13px;
  line-height: 1.7;
  padding: 0 10px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 7%, transparent);
  color: var(--text);
}
.sourceMore {
  font-family: var(--font-body);
  font-size: 13px;
  color: var(--text);
  opacity: 0.6;
}
```

- [ ] **Step 6: 실동작 확인 (playwright-cli)**

학생 세션에서 자료 근거 질의 → 첫 개념 카드 하단에 "📄 파일명 · p.N" 칩 렌더
확인 + 새로고침 후(재수화 경로) 칩 유지 확인, 스크린샷 첨부. 워크트리 dev 서버
준비·계정·포트 폴백은 브리프의 검증 환경 절을 따른다. 실동작이 불가능하면
보고서에 명시하고 타입·임포트 self-review로 폴백(게이트에서 tsc/build 확인).

- [ ] **Step 7: 커밋**

```bash
git add frontend/src/lib/types.ts frontend/src/lib/concept/types.ts frontend/src/lib/concept/useConceptStream.ts frontend/src/components/canvas/ConceptCard.tsx frontend/src/components/canvas/ConceptCard.module.css
git commit -m "[feat]: 첫 개념 카드 출처 칩(D74 프론트) — done 라이브 부착·재수화 복원·파일 단위 중복 제거"
```

---

### Task 4: 학급 자료실 재시도·삭제·업로드 피드백 (G3·G5·D75 클라)

**Files:**
- Modify: `frontend/src/components/teacher/MaterialsTab.tsx` (단일 파일)

**Interfaces:**
- Consumes: `retryFile(id)`/`deleteFile(id)`(`@/lib/api` 372·382행 — 기존 존재,
  소비처 0), `classMaterialsKey(classId)`(`@/lib/queries`), 서버 422 사유
  문구(Task 2의 `UNSUPPORTED_TYPE_DETAIL`과 동일 목록).
- Produces: 없음(말단 UI).

- [ ] **Step 1: 전체 구현 — `MaterialsTab.tsx`를 다음으로 교체**

```tsx
"use client";

import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Upload,
  FileText,
  CheckCircle2,
  AlertTriangle,
  Info,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { ApiError, deleteFile, retryFile, uploadFile } from "@/lib/api";
import { classMaterialsKey, useClassMaterials } from "@/lib/queries";
import type { FileRow, FileStatus } from "@/lib/types";

/**
 * 자료 탭: 학급 자료실(class_material) 목록 + 업로드 + 임베딩 진행률.
 * 업로드한 자료는 학생들이 자기 학급 공간에서 RAG로 참고한다.
 * G3/G5(D75): 실패 파일 재시도·삭제 동선 + 업로드 성공 피드백 + 형식 사전 검증.
 */
function formatBytes(n: number | null): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fileName(f: FileRow): string {
  return (
    f.name ||
    f.filename ||
    (f.storage_path ? f.storage_path.split("/").pop() || f.storage_path : "") ||
    f.id
  );
}

// D75: 서버 화이트리스트(services/files.py ALLOWED_UPLOAD_EXTENSIONS)와 동일
// 목록 — 선택 직후 사전 검증해 서버 왕복 없이 같은 사유를 보여준다.
const ALLOWED_EXTENSIONS = new Set([
  "pdf", "png", "jpg", "jpeg", "webp", "gif", "txt", "md",
]);
const UNSUPPORTED_TYPE_MSG =
  "지원 형식: PDF, 이미지(PNG/JPG/WEBP/GIF), 텍스트(TXT/MD)";

const STATUS_META: Record<
  FileStatus,
  { label: string; cls: string; progress: boolean }
> = {
  uploaded: { label: "대기", cls: "bg-accent/40 text-accent-fg", progress: true },
  splitting: { label: "분할 중", cls: "bg-accent/40 text-accent-fg", progress: true },
  embedding: { label: "임베딩 중", cls: "bg-accent/40 text-accent-fg", progress: true },
  indexed: { label: "완료", cls: "bg-positive/20 text-positive", progress: false },
  partial: { label: "부분 실패", cls: "bg-warning/20 text-warning", progress: false },
  failed: { label: "실패", cls: "bg-danger/20 text-danger", progress: false },
};

export function MaterialsTab({ classId }: { classId: string }) {
  const queryClient = useQueryClient();
  const { data: materials, isLoading } = useClassMaterials(classId);
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // G5: 업로드 성공 인라인 안내 1줄(토스트 라이브러리 신규 도입 금지).
  const [notice, setNotice] = useState<string | null>(null);

  const handleFiles = async (list: FileList | null) => {
    const file = list?.[0];
    if (!file) return;
    setError(null);
    setNotice(null);
    // D75: 형식 사전 검증 — 서버와 같은 목록·같은 사유(왕복 없이 즉시 안내).
    const ext = file.name.includes(".")
      ? file.name.split(".").pop()!.toLowerCase()
      : "";
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      setError(UNSUPPORTED_TYPE_MSG);
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    setUploading(true);
    try {
      await uploadFile(
        { space_kind: "class", space_ref: classId },
        file,
        { kind: "class_material" },
      );
      await queryClient.invalidateQueries({
        queryKey: classMaterialsKey(classId),
      });
      setNotice(`"${file.name}" 업로드 완료 — 인덱싱이 시작됩니다.`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) {
        setError("파일 임베딩이 아직 활성화되지 않았습니다(관리자 설정 필요).");
      } else {
        setError(`업로드 실패: ${(e as Error).message}`);
      }
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-fg">학급 자료실</h2>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="flex items-center gap-1 rounded-lg border border-accent-border bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-deep hover:text-white disabled:opacity-60"
        >
          <Upload size={14} />
          {uploading ? "업로드 중…" : "자료 업로드"}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,.md"
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-accent-border/30 bg-bg-elevated px-3 py-2 text-xs text-fg-muted">
        <Info size={14} className="mt-0.5 shrink-0" />
        <span>
          업로드한 자료는 임베딩된 뒤 학생들이 자기 학급 공간의 대화에서 RAG로
          참고할 수 있습니다. ({UNSUPPORTED_TYPE_MSG})
        </span>
      </div>

      {error && (
        <div className="flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {notice && (
        <div className="flex items-start gap-1.5 rounded-lg border border-positive/40 bg-positive/10 px-3 py-2 text-sm text-positive">
          <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      {isLoading ? (
        <p className="text-sm text-fg-muted">자료 불러오는 중…</p>
      ) : !materials || materials.length === 0 ? (
        <p className="rounded-lg border border-dashed border-accent-border/50 p-6 text-center text-sm text-fg-muted">
          업로드한 자료가 없습니다.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {materials.map((f) => (
            <MaterialItem key={f.id} file={f} classId={classId} />
          ))}
        </ul>
      )}
    </div>
  );
}

function MaterialItem({ file, classId }: { file: FileRow; classId: string }) {
  const queryClient = useQueryClient();
  const meta = STATUS_META[file.status];
  const total = file.chunk_total ?? 0;
  const done = file.chunk_done ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  // G3: 재시도/삭제 요청 중 표시(둘 다 disabled) + 행 단위 오류 안내.
  const [pendingAction, setPendingAction] = useState<"retry" | "delete" | null>(
    null,
  );
  const [actionError, setActionError] = useState<string | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: classMaterialsKey(classId) });

  const handleRetry = async () => {
    setActionError(null);
    setPendingAction("retry");
    try {
      await retryFile(file.id);
      await invalidate(); // 폴링(useClassMaterials)이 진행 상태를 이어받는다
    } catch (e) {
      setActionError(`재시도 실패: ${(e as Error).message}`);
    } finally {
      setPendingAction(null);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(`"${fileName(file)}" 자료를 삭제할까요?`)) return;
    setActionError(null);
    setPendingAction("delete");
    try {
      await deleteFile(file.id);
      await invalidate();
    } catch (e) {
      setActionError(`삭제 실패: ${(e as Error).message}`);
      setPendingAction(null);
    }
  };

  const retriable = file.status === "failed" || file.status === "partial";

  return (
    <li className="rounded-lg border border-accent-border/30 bg-bg-elevated p-3">
      <div className="flex items-center gap-2">
        {file.status === "indexed" ? (
          <CheckCircle2 size={15} className="shrink-0 text-positive" />
        ) : (
          <FileText size={15} className="shrink-0 text-fg-muted" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm text-fg" title={fileName(file)}>
          {fileName(file)}
        </span>
        <span className="shrink-0 text-xs text-fg-muted">
          {formatBytes(file.size_bytes)}
        </span>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.cls}`}
        >
          {meta.label}
        </span>
        {retriable && (
          <button
            type="button"
            onClick={handleRetry}
            disabled={pendingAction != null}
            title="재시도"
            className="flex shrink-0 items-center gap-1 rounded-md border border-accent-border/50 px-2 py-1 text-[11px] text-fg-muted transition-colors hover:bg-accent/20 hover:text-fg disabled:opacity-50"
          >
            <RotateCcw size={12} />
            {pendingAction === "retry" ? "재시도 중…" : "재시도"}
          </button>
        )}
        <button
          type="button"
          onClick={handleDelete}
          disabled={pendingAction != null}
          title="삭제"
          className="flex shrink-0 items-center gap-1 rounded-md border border-danger/30 px-2 py-1 text-[11px] text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
        >
          <Trash2 size={12} />
          {pendingAction === "delete" ? "삭제 중…" : "삭제"}
        </button>
      </div>

      {meta.progress && (
        <div className="mt-2 flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-accent/20">
            <div
              className="h-full rounded-full bg-accent-deep transition-all"
              style={{ width: `${total > 0 ? pct : 8}%` }}
            />
          </div>
          {total > 0 && (
            <span className="shrink-0 text-[11px] tabular-nums text-fg-muted">
              {done}/{total}
            </span>
          )}
        </div>
      )}

      {(file.status === "failed" || file.status === "partial") && file.error && (
        <p className="mt-1 text-[11px] text-danger">{file.error}</p>
      )}
      {actionError && (
        <p className="mt-1 text-[11px] text-danger">{actionError}</p>
      )}
    </li>
  );
}
```

- [ ] **Step 2: 실동작 확인 (playwright-cli)**

교사 계정으로 자료 탭 진입 → ① 미지원 형식(zip) 선택 시 사전 검증 오류 배너,
② 정상 PDF 업로드 시 성공 안내 1줄, ③ 실패/부분 실패 파일에 재시도 버튼,
④ 삭제 버튼 confirm → 목록에서 제거 — 스크린샷 첨부. 기존 테스트 잔존물
학급("노디늄 과학 실험반", 코드 EPRFPY)의 고착 파일은 **삭제하지 말 것**(마무리
E2E가 D76 재시도 검증에 사용). 실동작이 불가능하면 보고서에 명시하고 폴백.

- [ ] **Step 3: 커밋**

```bash
git add frontend/src/components/teacher/MaterialsTab.tsx
git commit -m "[feat]: 학급 자료실 재시도·삭제·업로드 피드백(G3·G5) + 형식 사전 검증(D75 클라)"
```

---

## 게이트·마무리 (Manager 수행 — PROCESS.md)

1. 4개 task 병렬 워크트리 완료 → dev로 cherry-pick 회수 → task별 리뷰어 게이트
   (Task 3·4는 프론트엔드 리뷰어 추가 게이트 + 메인 저장소 `frontend/`에서
   `npx tsc --noEmit && npm run build` 스모크).
2. 마무리 E2E(프론트엔드 리뷰어): 스펙 검증 기준 3 — 교사 PDF 업로드 → indexed →
   학생 질의 → 자료 근거 답변 + 첫 개념 카드 출처 칩 실측. 겸사겸사 고착
   파일(zip)의 재시도→실패 배지→삭제 동선 실측, 테스트 잔존물 정리.
3. 문서 동기화: TASKS.md 체크박스, 원장 마감. (CLAUDE.md의 TASK 2 관련 서술은
   이미 현실과 일치 — 학생 파일 "미구현" 경고는 TASK 3 몫이므로 유지.)
