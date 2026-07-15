# 학생 파일 세션 컨텍스트 주입 구현 계획 (TASK 3, D83~D85)

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 학생이 세션에 올린 파일을 임베딩 없이 청킹·저장만 하고, 청크 전문을
seq 순으로 이어붙여 해당 세션의 시스템 프롬프트에 주입한다(예산 초과는 거부).

**Architecture:** `files.session_id` 재도입(0037) → 업로드가 세션 소유를 검증해
연결 → 워커가 `kind='user_upload'`에서 임베딩 팬아웃을 생략하고 오버랩 0 청크를
`stored`로 저장(예산 D84 검사) → 채팅 턴의 4번째 컨텍스트 빌더가 전문을 조립 →
`compose_system_structured`의 `session_files` 블록(system_base 직후, D85 캐시).

**Tech Stack:** FastAPI · Supabase(PostgREST/RLS) · Next.js(App Router,
CSS Modules) · TanStack Query. 스펙:
`docs/superpowers/specs/2026-07-15-student-session-context-design.md`

## Global Constraints

- 주석·docstring·커밋 메시지 **한국어**, 커밋 프리픽스 `[feat]:`. 설계 결정은
  D83/D84/D85 번호로 주석에 남긴다.
- **자기 task의 파일만 `git add`** — `git add -A`/`git add .` 금지.
- 백엔드 테스트: `<메인저장소>/backend/.venv/bin/python -m pytest tests/ -v`
  (워크트리에는 .venv/.env 없음 — 시작 시 메인 저장소 `backend/.env`를 자기
  워크트리 `backend/.env`로 복사).
- 예산 튜너블: 키 `session_context_max_chars`, config 기본 **150_000**,
  clamp **10_000~300_000** — 모든 읽기는 `app_settings.as_int(overlay, key,
  settings.session_context_max_chars, 10_000, 300_000)` 로 동일해야 한다.
- 청크 상태 신규 값은 정확히 `'stored'`, 파일 터미널 상태는 기존 `'indexed'`
  재사용(user_upload에선 "세션 컨텍스트 준비 완료" 의미 — 주석 필수).
- 불변식: 주입 빌더는 best-effort(실패 시 None, 채팅 불중단), 청크 본문 조회는
  USER 스코프(UserClient) — ServiceClient로 본문을 읽어 프롬프트에 넣지 않는다.
- class_material 경로(D73~D78) 동작 무변경 — 회귀 시 반려 대상.

## 실행 웨이브 (오케스트레이터용)

| 웨이브 | task | 파일 경계 | 비고 |
|---|---|---|---|
| 1 (병렬) | Task 1 (task3-1) | 0037·config.py·services/files.py·routers/files.py·tests/test_upload_session.py | 기반 — 웨이브 2가 이 커밋을 베이스로 함 |
| 1 (병렬) | Task 2 (task3-4) | frontend/* 6파일 | 백엔드와 서로소 — 웨이브 1에서 동시 실행 |
| 2 (병렬) | Task 3 (task3-2) | services/embedding_worker.py·tests/test_worker_session_context.py | config 의존 → Task 1 회수 후 |
| 2 (병렬) | Task 4 (task3-3) | services/session_context.py(신규)·services/gemini.py·routers/chat.py·tests/test_session_context.py | config 의존 → Task 1 회수 후 |

---

### Task 1: 스키마 0037 + 예산 노브 + 업로드 세션 연결 + 세션 파일 목록 (task3-1)

**Files:**
- Create: `supabase/migrations/0037_session_context.sql`
- Modify: `backend/app/config.py` (109행 `class_material_rag_max_distance` 직후)
- Modify: `backend/app/services/files.py` (FILE_SELECT·upload_file·list 계열)
- Modify: `backend/app/routers/files.py` (upload Form·list_files Query)
- Test: `backend/tests/test_upload_session.py`

**Interfaces:**
- Consumes: 기존 `app_settings.as_int(overlay, key, default, lo, hi)`,
  `UserClient.select(table, params)`, `ServiceClient.insert`.
- Produces (후속 task가 의존):
  - `settings.session_context_max_chars: int = 150_000` (config)
  - `files.session_id uuid | null`, `files.context_chars integer | null` 컬럼
  - `file_chunks.status` CHECK에 `'stored'` 허용
  - `upload_file(..., session_id: str | None = None)` — files 행에 session_id 저장
  - `list_session_files(client, session_id) -> list[dict]` +
    `GET /files?session_id=...` (kind=user_upload, created_at asc)
  - `FILE_SELECT`에 `session_id,context_chars` 포함
  - app_settings 시드 행 `session_context_max_chars = 150000`

- [ ] **Step 1: 마이그레이션 0037 작성** (테스트 없음 — DDL 파일만, 원격 적용은 배포 시)

`supabase/migrations/0037_session_context.sql`:

```sql
-- ============================================================================
-- nodi — migration 0037 (D83·D84 — 학생 파일 세션 컨텍스트 주입, TASK 3)
-- 스펙: docs/superpowers/specs/2026-07-15-student-session-context-design.md
--
-- DRAFT — 원격 적용은 배포 시(파일만 추가). 미적용 상태에서도 런타임은
-- config.py 기본값으로 동작한다(D62 오버레이 폴백). session_id는 0011에서
-- 도입됐다가 0033(D81)에서 소비 0으로 드랍된 이력 — 이번엔 세션 전문 주입
-- (D83)의 소비 경로가 함께 생긴다.
-- ============================================================================

-- 1) 파일-세션 연결(D83). 세션 삭제 시 파일은 남기되 연결만 끊는다(set null).
alter table public.files
    add column if not exists session_id uuid
        references public.sessions (id) on delete set null;

create index if not exists idx_files_session
    on public.files (session_id) where session_id is not null;

-- 2) 세션 컨텍스트 예산 원장(D84) — user_upload 통과 시 워커가 문자 수 기록.
alter table public.files
    add column if not exists context_chars integer;

-- 3) 청크 상태 'stored' 허용(D83) — user_upload는 임베딩 없이 저장만.
--    ('pending'은 영구 대기로 오독되고 'embedded'는 거짓이므로 신규 값.)
alter table public.file_chunks
    drop constraint if exists file_chunks_status_check;
alter table public.file_chunks
    add constraint file_chunks_status_check
    check (status in ('pending', 'embedded', 'failed', 'stored'));

-- 4) 예산 튜너블 시드(D84·D62) — admin 콘솔 노출.
insert into public.app_settings (key, value) values
    ('session_context_max_chars', '150000'::jsonb)
on conflict (key) do nothing;

-- End of 0037_session_context.sql
```

- [ ] **Step 2: config에 예산 노브 추가**

`backend/app/config.py` — `class_material_rag_max_distance: float = 0.60` 줄
바로 아래에 추가:

```python
    # --- D84: 학생 세션 파일 전문 주입 예산 (TASK 3) ---
    # 한 세션에 주입 가능한 파일 전문의 합산 문자 상한. K-EXAONE 256K 토큰
    # 윈도우에 무트리밍 히스토리·RAG·답변 여유를 남기는 보수 기본값
    # (150K자 ≈ 한국어 75K~150K 토큰). 판정은 워커 저장 시점(초과 거부) +
    # 주입 시점 이중 방어. clamp 10_000~300_000 (as_int 호출부와 동기).
    session_context_max_chars: int = 150_000
```

- [ ] **Step 3: 실패 테스트 작성**

`backend/tests/test_upload_session.py`:

```python
"""D83 — 업로드 세션 연결(session_id) 검증·세션 파일 목록 테스트.

세션 소유자만 자기 세션에 user_upload를 연결할 수 있고(class_material 불가),
세션의 공간과 업로드 폼 공간이 일치해야 한다. 목록은 kind=user_upload 한정.
"""

import pytest
from fastapi import HTTPException

from app.services import files as F


class _FakeService:
    def __init__(self):
        self.storage = []
        self.inserts = []

    async def storage_upload(self, bucket, path, data, mime):
        self.storage.append(path)

    async def insert(self, table, row, returning=True):
        self.inserts.append((table, row))
        return [dict(row)] if returning and isinstance(row, dict) else None


class _FakeUserClient:
    """sessions 조회에 지정된 행을 돌려주고, 그 외 select는 멤버십 통과."""

    def __init__(self, session_row=None):
        self.session_row = session_row
        self.selects = []

    async def select(self, table, params):
        self.selects.append((table, params))
        if table == "sessions":
            return [dict(self.session_row)] if self.session_row else []
        return [{"class_id": "c1"}]

    async def rpc(self, *a, **k):
        return True


async def _overlay():
    return {}


def _sess(owner="u1", kind="personal", ref="u1"):
    return {"id": "s1", "owner_id": owner, "space_kind": kind, "space_ref": ref}


@pytest.mark.asyncio
async def test_session_id_with_class_material_422(monkeypatch):
    """① session_id는 user_upload 전용 — class_material이면 422."""
    monkeypatch.setattr(F.app_settings, "get_overlay", _overlay)
    with pytest.raises(HTTPException) as ei:
        await F.upload_file(
            _FakeService(), _FakeUserClient(_sess()), "u1", "class", "c1",
            "a.pdf", None, b"x", kind="class_material", session_id="s1",
        )
    assert ei.value.status_code == 422


@pytest.mark.asyncio
async def test_session_not_found_404(monkeypatch):
    """② 세션이 없거나 RLS로 안 보이면 404."""
    monkeypatch.setattr(F.app_settings, "get_overlay", _overlay)
    with pytest.raises(HTTPException) as ei:
        await F.upload_file(
            _FakeService(), _FakeUserClient(None), "u1", "personal", None,
            "a.pdf", None, b"x", session_id="s1",
        )
    assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_session_owner_mismatch_403(monkeypatch):
    """③ 세션 소유자 ≠ 업로더 → 403 (교사는 학생 세션을 SELECT할 수 있어
    RLS만으론 부족 — 명시 비교)."""
    monkeypatch.setattr(F.app_settings, "get_overlay", _overlay)
    with pytest.raises(HTTPException) as ei:
        await F.upload_file(
            _FakeService(), _FakeUserClient(_sess(owner="other")), "u1",
            "personal", None, "a.pdf", None, b"x", session_id="s1",
        )
    assert ei.value.status_code == 403


@pytest.mark.asyncio
async def test_session_space_mismatch_422(monkeypatch):
    """④ 세션 공간과 업로드 폼 공간 불일치 → 422."""
    monkeypatch.setattr(F.app_settings, "get_overlay", _overlay)
    with pytest.raises(HTTPException) as ei:
        await F.upload_file(
            _FakeService(),
            _FakeUserClient(_sess(kind="class", ref="c9")), "u1",
            "personal", None, "a.pdf", None, b"x", session_id="s1",
        )
    assert ei.value.status_code == 422


@pytest.mark.asyncio
async def test_upload_with_session_saves_link(monkeypatch):
    """⑤ 정상 — files 행에 session_id가 실린다."""
    monkeypatch.setattr(F.app_settings, "get_overlay", _overlay)
    svc = _FakeService()
    row = await F.upload_file(
        svc, _FakeUserClient(_sess()), "u1", "personal", None,
        "노트.pdf", None, b"x", session_id="s1",
    )
    assert row["session_id"] == "s1"
    files_rows = [r for t, r in svc.inserts if t == "files"]
    assert files_rows and files_rows[0]["session_id"] == "s1"


@pytest.mark.asyncio
async def test_upload_without_session_unchanged(monkeypatch):
    """⑥ session_id 미지정 시 기존 동작(연결 없음) — 회귀 가드."""
    monkeypatch.setattr(F.app_settings, "get_overlay", _overlay)
    svc = _FakeService()
    row = await F.upload_file(
        svc, _FakeUserClient(), "u1", "personal", None, "a.pdf", None, b"x",
    )
    assert row.get("session_id") is None


@pytest.mark.asyncio
async def test_list_session_files_filters():
    """⑦ 세션 파일 목록 — session_id·kind=user_upload 필터, 업로드 순."""
    client = _FakeUserClient()
    await F.list_session_files(client, "s1")
    table, params = client.selects[-1]
    assert table == "files"
    assert params["session_id"] == "eq.s1"
    assert params["kind"] == "eq.user_upload"
    assert params["order"] == "created_at.asc"
```

- [ ] **Step 4: RED 확인**

Run: `<메인저장소>/backend/.venv/bin/python -m pytest tests/test_upload_session.py -v`
(cwd: 자기 워크트리 `backend/`)
Expected: FAIL — `TypeError: upload_file() got an unexpected keyword argument
'session_id'` 및 `AttributeError: ... has no attribute 'list_session_files'`

- [ ] **Step 5: services/files.py 구현**

(a) `FILE_SELECT`를 다음으로 교체:

```python
FILE_SELECT = (
    "id,owner_id,space_kind,space_ref,kind,storage_path,mime,"
    "size_bytes,status,chunk_total,chunk_done,error,name,"
    "session_id,context_chars,created_at,updated_at"
)
```

(b) `upload_file` 시그니처에 키워드 인자 추가 —
`kind: str = "user_upload",` 다음 줄에:

```python
    session_id: str | None = None,
```

(c) `upload_file` 본문 — `if kind == "class_material" and space_kind != "class":`
블록 바로 뒤에 삽입:

```python
    # D83: 세션 연결은 user_upload 전용 — 학급 자료는 세션에 귀속되지 않는다.
    if session_id is not None and kind != "user_upload":
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="session_id는 user_upload에만 허용됩니다.",
        )
```

(d) `upload_file` 본문 — 학급 멤버십 검증 블록
(`if space_kind == "class":` ... `_assert_class_member` 끝) 바로 뒤에 삽입:

```python
    # D83: 세션 소유자 검증. 교사도 학생 세션을 SELECT할 수 있으므로(RLS R2)
    # 조회 성공만으론 부족 — owner_id를 명시 비교한다. 세션의 공간과 업로드
    # 폼의 공간이 어긋나면 주입 스코프가 꼬이므로 422.
    if session_id is not None:
        srows = await user_client.select(
            "sessions",
            {
                "id": f"eq.{session_id}",
                "select": "id,owner_id,space_kind,space_ref",
                "limit": "1",
            },
        )
        if not srows:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Session not found or not accessible.",
            )
        sess = srows[0]
        if sess.get("owner_id") != owner_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="자기 세션에만 파일을 연결할 수 있습니다.",
            )
        if sess.get("space_kind") != space_kind or sess.get("space_ref") != ref:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="세션의 공간과 업로드 공간이 일치해야 합니다.",
            )
```

주의: 이 블록은 `ref` 계산(`ref = space_ref or ...`) **이후**에 와야 한다 —
personal 세션의 space_ref는 owner id로 시드되므로 `ref`와 비교한다.

(e) `service.insert("files", {...})` 딕셔너리의 `"status": "uploaded",` 위에
한 줄 추가:

```python
            "session_id": session_id,
```

(f) 파일 끝(`get_file` 뒤)에 추가:

```python
async def list_session_files(
    client: UserClient, session_id: str
) -> list[dict[str, Any]]:
    """D83: 세션 컨텍스트 파일 목록 — 주입 순서(created_at asc)와 동일하게."""
    return await client.select(
        "files",
        {
            "session_id": f"eq.{session_id}",
            "kind": "eq.user_upload",
            "select": FILE_SELECT,
            "order": "created_at.asc",
        },
    )
```

- [ ] **Step 6: routers/files.py 구현**

(a) `upload` 시그니처 — `kind: str = Form("user_upload"),` 다음 줄에 추가하고
호출부 `svc.upload_file(...)`에 `session_id=session_id,`를 `kind=kind,` 다음
인자로 전달:

```python
    session_id: str | None = Form(None),
```

(b) `list_files`를 다음으로 교체 (session_id 우선, 기존 공간 조회 보존):

```python
@router.get("")
async def list_files(
    space_kind: str | None = Query(None, pattern="^(personal|class)$"),
    space_ref: str | None = Query(None),
    session_id: str | None = Query(None),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict[str, Any]]:
    client = UserClient.from_user(user)
    # D83: 세션 기준 조회 — 공간 인자 불필요(RLS가 소유자 스코프).
    if session_id:
        return await svc.list_session_files(client, session_id)
    if not space_kind:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="space_kind or session_id is required.",
        )
    ref = space_ref or (user.id if space_kind == "personal" else None)
    if not ref:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="class space requires space_ref (class id).",
        )
    return await svc.list_files(client, space_kind, ref)
```

(`Query` 임포트는 기존에 있음 — 없으면 fastapi에서 추가.)

- [ ] **Step 7: GREEN 확인 + 전체 스위트**

Run: `<메인저장소>/backend/.venv/bin/python -m pytest tests/ -v`
Expected: 신규 7개 PASS 포함 전체 GREEN (기존 47+7)

- [ ] **Step 8: 커밋**

```bash
git add supabase/migrations/0037_session_context.sql backend/app/config.py \
  backend/app/services/files.py backend/app/routers/files.py \
  backend/tests/test_upload_session.py
git commit -m "[feat]: D83 업로드 세션 연결·세션 파일 목록 + D84 예산 노브·0037(session_id 재도입, stored 상태, 시드)"
```

---

### Task 2: 프론트 — 세션 파일 바(첨부·상태 칩) + API 배선 + admin 메타 (task3-4)

**Files:**
- Modify: `frontend/src/lib/api.ts` (uploadFile opts + listSessionFiles)
- Modify: `frontend/src/lib/types.ts` (FileRow 필드 2개)
- Modify: `frontend/src/lib/queries.ts` (sessionFilesKey·useSessionFiles)
- Create: `frontend/src/components/canvas/SessionFilesBar.tsx`
- Create: `frontend/src/components/canvas/SessionFilesBar.module.css`
- Modify: `frontend/src/components/canvas/ConceptCanvasWorkspace.tsx` (배선 2줄)
- Modify: `frontend/src/components/admin/SettingsTab.tsx` (노브 메타 1개)

**Interfaces:**
- Consumes (Task 1의 백엔드 계약 — 프론트는 계약만 알면 되므로 웨이브 1 병렬):
  `POST /files` 멀티파트 Form `session_id`(옵션),
  `GET /files?session_id=<uuid>` → `FileRow[]`(kind=user_upload, created_at asc),
  실패 시 `files.error`에 한국어 사유. 기존 `DELETE /files/{id}` 재사용.
- Produces: `<SessionFilesBar sessionId target />` — ConceptCanvasWorkspace가
  BottomBar 위에 렌더.

- [ ] **Step 1: api.ts — uploadFile 확장 + listSessionFiles**

(a) `uploadFile`의 `opts` 타입과 본문에 session_id 추가:

```ts
export async function uploadFile(
  target: SpaceTarget,
  file: File,
  opts?: {
    kind?: string;
    /** D83: 세션 컨텍스트로 연결(user_upload 전용). */
    session_id?: string;
  },
): Promise<FileRow> {
  const form = new FormData();
  form.append("file", file);
  form.append("space_kind", target.space_kind);
  if (target.space_ref) form.append("space_ref", target.space_ref);
  if (opts?.kind) form.append("kind", opts.kind);
  if (opts?.session_id) form.append("session_id", opts.session_id);
  const res = await ensureOk(
    await fetch(`${API_BASE}/files`, {
      method: "POST",
      headers: await authHeaders(), // json=false → Content-Type 없음
      body: form,
    }),
  );
  return res.json();
}
```

(b) `listFiles` 바로 아래에 추가:

```ts
/** D83: 세션 컨텍스트 파일 목록(업로드 순 — 주입 순서와 동일). */
export async function listSessionFiles(sessionId: string): Promise<FileRow[]> {
  const params = new URLSearchParams({ session_id: sessionId });
  const res = await ensureOk(
    await fetch(`${API_BASE}/files?${params.toString()}`, {
      headers: await authHeaders(),
    }),
  );
  return res.json();
}
```

- [ ] **Step 2: types.ts — FileRow 확장**

`FileRow`의 `error?: string | null;` 아래에 추가:

```ts
  /** D83: 세션 컨텍스트로 연결된 세션(user_upload 전용). */
  session_id?: string | null;
  /** D84: 파일 전문 문자 수(예산 원장 — 워커 기록). */
  context_chars?: number | null;
```

- [ ] **Step 3: queries.ts — 세션 파일 훅**

`filesKey`/`useFiles` 아래에 추가 (`listSessionFiles` 임포트 추가):

```ts
export function sessionFilesKey(sessionId: string | null) {
  return ["files", "session", sessionId] as const;
}

/** D83: 세션 컨텍스트 파일 목록. 처리 중이면 2.5초 폴링(기존 패턴 재사용). */
export function useSessionFiles(sessionId: string | null) {
  return useQuery<FileRow[]>({
    queryKey: sessionFilesKey(sessionId),
    queryFn: () => listSessionFiles(sessionId as string),
    enabled: !!sessionId,
    staleTime: STALE.files,
    refetchInterval: (query) => {
      const data = query.state.data;
      const active = data?.some((f) => FILE_IN_PROGRESS.has(f.status));
      return active ? 2500 : false;
    },
  });
}
```

- [ ] **Step 4: SessionFilesBar 컴포넌트**

`frontend/src/components/canvas/SessionFilesBar.tsx`:

```tsx
"use client";

// D83: 세션 컨텍스트 파일 바 — 첨부 버튼 + 파일 상태 칩. BottomBar 위에 부착.
// 상태 3종: 처리 중(스피너) / indexed("세션 컨텍스트로 사용 중") /
// failed(서버 한국어 사유 + 삭제). 업로드 실패(413/422)의 detail도 그대로 표시.

import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  FileText,
  Loader2,
  Paperclip,
  Trash2,
  XCircle,
} from "lucide-react";
import { deleteFile, uploadFile, type SpaceTarget } from "@/lib/api";
import { sessionFilesKey, useSessionFiles } from "@/lib/queries";
import type { FileRow } from "@/lib/types";
import styles from "./SessionFilesBar.module.css";

const IN_PROGRESS = new Set(["uploaded", "splitting", "embedding"]);

function chipStatus(f: FileRow): "progress" | "ready" | "failed" {
  if (f.status === "indexed") return "ready";
  if (IN_PROGRESS.has(f.status)) return "progress";
  return "failed"; // failed | partial(발생 안 함 — 방어)
}

export default function SessionFilesBar({
  sessionId,
  target,
}: {
  sessionId: string | null;
  target: SpaceTarget;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { data: files } = useSessionFiles(sessionId);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: sessionFilesKey(sessionId) });

  const upload = useMutation({
    mutationFn: (file: File) =>
      uploadFile(target, file, { session_id: sessionId as string }),
    onSuccess: () => {
      setUploadError(null);
      invalidate();
    },
    onError: (e: Error) => setUploadError(e.message),
  });

  const remove = useMutation({
    mutationFn: (fileId: string) => deleteFile(fileId),
    onSuccess: invalidate,
  });

  if (!sessionId) return null;

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // 같은 파일 재선택 허용
    if (file) upload.mutate(file);
  };

  return (
    <div className={styles.bar}>
      <button
        type="button"
        className={styles.attach}
        onClick={() => inputRef.current?.click()}
        disabled={upload.isPending}
        title="이 세션의 컨텍스트로 파일 첨부"
      >
        {upload.isPending ? (
          <Loader2 size={14} className={styles.spin} />
        ) : (
          <Paperclip size={14} />
        )}
        <span>파일 첨부</span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,.md"
        className={styles.hiddenInput}
        onChange={onPick}
      />

      {(files ?? []).map((f) => {
        const st = chipStatus(f);
        return (
          <span key={f.id} className={`${styles.chip} ${styles[st]}`}>
            {st === "progress" && <Loader2 size={12} className={styles.spin} />}
            {st === "ready" && <CheckCircle2 size={12} />}
            {st === "failed" && <XCircle size={12} />}
            <FileText size={12} />
            <span className={styles.name}>{f.name ?? "파일"}</span>
            {st === "ready" && (
              <span className={styles.badge}>세션 컨텍스트로 사용 중</span>
            )}
            {st === "failed" && f.error && (
              <span className={styles.reason} title={f.error}>
                {f.error}
              </span>
            )}
            <button
              type="button"
              className={styles.remove}
              onClick={() => remove.mutate(f.id)}
              disabled={remove.isPending}
              title="파일 삭제"
            >
              <Trash2 size={12} />
            </button>
          </span>
        );
      })}

      {uploadError && <span className={styles.uploadError}>{uploadError}</span>}
    </div>
  );
}
```

주의: `deleteFile`·`ensureOk`의 실제 export 이름·오류 메시지 형식은 api.ts
현물을 확인해 맞춘다(ensureOk가 detail을 Error.message로 던지는지 — 아니라면
detail 추출 로직을 api.ts 기존 패턴대로).

- [ ] **Step 5: SessionFilesBar.module.css**

기존 `BottomBar.module.css`의 색·간격 토큰을 참조해 일관되게 작성한다. 골자:

```css
/* D83 세션 파일 바 — BottomBar 위 부착, 가로 스크롤 칩 스트립 */
.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px;
  overflow-x: auto;
  pointer-events: auto;
}
.attach {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  background: #fff;
  cursor: pointer;
}
.attach:disabled { opacity: 0.6; cursor: default; }
.hiddenInput { display: none; }
.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  max-width: 340px;
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 999px;
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.1);
}
.name {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.badge { color: #16a34a; font-weight: 600; }
.failed { border-color: #fca5a5; }
.reason {
  color: #dc2626;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.remove {
  display: inline-flex;
  border: none;
  background: none;
  cursor: pointer;
  color: inherit;
  padding: 0;
}
.uploadError { color: #dc2626; font-size: 12px; flex-shrink: 0; }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
```

(실제 값은 BottomBar.module.css의 기존 팔레트·z-index 컨벤션에 맞춰 조정 —
새 디자인 토큰·라이브러리 도입 금지.)

- [ ] **Step 6: ConceptCanvasWorkspace 배선**

(a) 임포트 추가: `import SessionFilesBar from "./SessionFilesBar";`

(b) `<BottomBar onSend={send} busy={busy} reply={reply} />` 바로 위에:

```tsx
      <SessionFilesBar sessionId={activeSessionId} target={target} />
```

(BottomBar가 절대배치 하단 고정이면 같은 래퍼 안에서 위쪽에 오도록 배치 —
기존 레이아웃 구조를 따른다.)

- [ ] **Step 7: SettingsTab 노브 메타**

`class_material_rag_max_distance` 엔트리 뒤에 추가:

```ts
  session_context_max_chars: {
    label: "세션 파일 컨텍스트 예산",
    group: "RAG 주입",
    widget: "number",
    min: 10000,
    max: 300000,
    step: 10000,
    unit: "자",
    description:
      "학생이 세션에 올린 파일 전문을 프롬프트에 주입할 때 세션당 합산 문자 상한(D84). 초과 파일은 업로드 처리 시 거부됩니다. 이미 저장된 파일에는 소급 거부 없이 주입 시 초과분 파일만 제외됩니다.",
    effect: "세션 파일 주입 한도",
    wired: "deferred",
    risk: "new-only",
  },
```

- [ ] **Step 8: 실동작 확인(playwright-cli) + 커밋**

- 워크트리 준비: `ln -s <메인저장소>/frontend/node_modules frontend/node_modules`,
  메인 저장소 `frontend/.env.local` 복사, 포트 충돌 시 `--port 3001`.
- 학생 프로필(`playwright-cli -s=student --profile ~/.nodi-e2e/student`)로
  세션 진입 → 파일 첨부 버튼 렌더·txt 업로드 → 칩 상태 전이 스크린샷.
  (백엔드 워커 분기(Task 3)가 아직 없으면 임베딩 경로로 처리되어 칩이
  "사용 중"까지 가는 데 시간이 걸릴 수 있음 — 렌더·업로드 201·폴링 동작까지
  확인하고 한계를 보고서에 명시.)
- tsc/build 스모크는 회수 후 메인 저장소에서 게이트가 실행.

```bash
git add frontend/src/lib/api.ts frontend/src/lib/types.ts \
  frontend/src/lib/queries.ts \
  frontend/src/components/canvas/SessionFilesBar.tsx \
  frontend/src/components/canvas/SessionFilesBar.module.css \
  frontend/src/components/canvas/ConceptCanvasWorkspace.tsx \
  frontend/src/components/admin/SettingsTab.tsx
git commit -m "[feat]: D83 세션 파일 바(첨부·상태 칩·오류 사유) + 세션 파일 API 배선 + D84 admin 노브 메타"
```

---

### Task 3: 워커 분기 — user_upload 청킹 저장·임베딩 생략·예산 게이트 (task3-2)

**Files:**
- Modify: `backend/app/services/embedding_worker.py` (`_handle_split` + 신규 헬퍼)
- Test: `backend/tests/test_worker_session_context.py`

**Interfaces:**
- Consumes (Task 1 산출): `settings.session_context_max_chars`,
  `files.session_id`·`files.context_chars` 컬럼, `'stored'` 청크 상태.
- Produces (Task 4가 의존): user_upload 파일이 터미널에서
  `files.status='indexed'` + `context_chars=<전문 문자수>` +
  `file_chunks(status='stored', 오버랩 0, seq 연속)` 상태가 된다.
  임베딩 배치 잡·Qdrant 포인트는 생성되지 않는다.

- [ ] **Step 1: 실패 테스트 작성**

`backend/tests/test_worker_session_context.py`:

```python
"""D83·D84 — 워커 user_upload 분기 테스트.

user_upload: 오버랩 0 청킹 → 'stored' 저장 → 임베딩 팬아웃 생략 → 즉시
indexed(+context_chars). session_id가 있으면 세션 합산 예산(D84) 초과 시
청크 저장 없이 failed + 한국어 사유. class_material은 기존 팬아웃 유지.
"""

import pytest

from app.services import embedding_worker as W


class _FakeService:
    def __init__(self, file_row, session_files=None):
        self.file_row = file_row
        self.session_files = session_files or []
        self.inserts = []
        self.updates = []
        self.deletes = []

    async def select(self, table, params):
        if table == "files" and "id" in params:
            return [dict(self.file_row)]
        if table == "files" and "session_id" in params:
            return [dict(r) for r in self.session_files]
        return []

    async def count(self, table, params):
        return 0  # 기존 배치 잡 없음(멱등 조기 반환 안 탐)

    async def insert(self, table, rows, returning=True):
        self.inserts.append((table, rows))
        return None

    async def update(self, table, filters, values):
        self.updates.append((table, filters, values))
        return [values]

    async def delete(self, table, params):
        self.deletes.append((table, params))

    async def storage_download(self, bucket, path):
        return b"raw"


async def _overlay():
    return {}


def _file(kind="user_upload", session_id=None):
    return {
        "id": "f1", "owner_id": "u1", "storage_path": "u1/f1/a.txt",
        "mime": "text/plain", "space_ref": None,
        "kind": kind, "session_id": session_id,
    }


def _job():
    return {"id": "j1", "kind": "embedding_split", "target_id": "f1"}


@pytest.fixture(autouse=True)
def _patches(monkeypatch):
    async def fake_extract(data, mime, path):
        return "가" * 3000

    async def fake_qdrant_delete(file_id):
        return None

    monkeypatch.setattr(W, "_extract_text", fake_extract)
    monkeypatch.setattr(W, "_qdrant_delete_file_points", fake_qdrant_delete)
    monkeypatch.setattr(W.app_settings, "get_overlay", _overlay)


@pytest.mark.asyncio
async def test_user_upload_stores_chunks_without_embedding():
    """① 청크 'stored' 저장 + 임베딩 잡 0 + indexed/context_chars 기록."""
    svc = _FakeService(_file())
    await W._handle_split(svc, _job())

    chunk_inserts = [r for t, r in svc.inserts if t == "file_chunks"]
    assert chunk_inserts, "청크가 저장되어야 한다"
    assert all(row["status"] == "stored" for rows in chunk_inserts for row in rows)
    assert all(t != "jobs" for t, _ in svc.inserts), "임베딩 팬아웃 없어야 한다"

    files_updates = [v for t, _, v in svc.updates if t == "files"]
    final = files_updates[-1]
    assert final["status"] == "indexed"
    assert final["context_chars"] == 3000
    assert final["chunk_total"] == final["chunk_done"]


@pytest.mark.asyncio
async def test_user_upload_chunks_have_no_overlap(monkeypatch):
    """② user_upload는 오버랩 0으로 청킹한다(이어붙이면 원문 복원)."""
    calls = []
    original = W.embedding.chunk_text

    def spy(text, size, overlap):
        calls.append((size, overlap))
        return original(text, size, overlap)

    monkeypatch.setattr(W.embedding, "chunk_text", spy)
    svc = _FakeService(_file())
    await W._handle_split(svc, _job())
    assert calls and calls[0][1] == 0

    joined = "".join(
        row["chunk_text"]
        for t, rows in svc.inserts if t == "file_chunks"
        for row in rows
    )
    assert joined == "가" * 3000


@pytest.mark.asyncio
async def test_budget_exceeded_fails_with_korean_reason():
    """③ 세션 합산 예산 초과 → 청크 저장 없이 failed + 한국어 사유(D84)."""
    svc = _FakeService(
        _file(session_id="s1"),
        session_files=[{"id": "f0", "context_chars": 149_000}],
    )
    await W._handle_split(svc, _job())

    assert all(t != "file_chunks" for t, _ in svc.inserts)
    files_updates = [v for t, _, v in svc.updates if t == "files"]
    final = files_updates[-1]
    assert final["status"] == "failed"
    assert "예산" in final["error"]


@pytest.mark.asyncio
async def test_sessionless_user_upload_skips_budget():
    """④ session_id 없는 user_upload는 예산 무관 저장(주입 대상 아님)."""
    svc = _FakeService(_file(session_id=None))
    await W._handle_split(svc, _job())
    assert any(t == "file_chunks" for t, _ in svc.inserts)


@pytest.mark.asyncio
async def test_class_material_still_fans_out():
    """⑤ class_material 회귀 가드 — pending 청크 + embedding_batch 팬아웃."""
    svc = _FakeService(_file(kind="class_material"))
    await W._handle_split(svc, _job())

    chunk_rows = [row for t, rows in svc.inserts if t == "file_chunks"
                  for row in rows]
    assert chunk_rows and all(r["status"] == "pending" for r in chunk_rows)
    job_inserts = [r for t, r in svc.inserts if t == "jobs"]
    assert job_inserts, "embedding_batch 팬아웃이 살아 있어야 한다"
```

- [ ] **Step 2: RED 확인**

Run: `<메인저장소>/backend/.venv/bin/python -m pytest tests/test_worker_session_context.py -v`
Expected: FAIL — ①②③④는 'stored'/'jobs 팬아웃 없음'/failed 단언 실패
(현재는 user_upload도 pending + 팬아웃), ⑤만 PASS 가능.

- [ ] **Step 3: 구현 — `_handle_split` 분기 + `_store_session_chunks`**

(a) `_handle_split`의 파일 select 컬럼에 kind·session_id 추가:

```python
    files = await svc.select(
        "files",
        {"id": f"eq.{file_id}",
         "select": "id,owner_id,storage_path,mime,space_ref,kind,session_id",
         "limit": "1"},
    )
```

(b) 청킹 파라미터 — 기존 `chunk_overlap = app_settings.as_int(...)` 를 다음으로
교체:

```python
    # D83: user_upload는 전문 이어붙이기용 — 오버랩은 중복 텍스트만 만들므로 0.
    is_session_upload = f.get("kind") == "user_upload"
    chunk_overlap = 0 if is_session_upload else app_settings.as_int(
        overlay, "chunk_overlap_chars", settings.chunk_overlap_chars, 0, 500
    )
```

(c) `if not chunks:` 블록 **다음**, "Insert chunk rows" 주석 **앞**에 삽입:

```python
    # D83: user_upload는 임베딩·Qdrant 없이 저장만 — 세션 전문 주입이 소비한다.
    if is_session_upload:
        await _store_session_chunks(svc, job, f, chunks)
        return
```

(d) `_handle_split` 함수 정의 **앞**에 신규 헬퍼 추가:

```python
async def _store_session_chunks(
    svc: ServiceClient, job: dict[str, Any], f: dict[str, Any],
    chunks: list[str],
) -> None:
    """D83: user_upload 청크를 'stored'로 저장만 한다(임베딩 팬아웃 생략).

    D84: session_id가 있으면 세션 합산 예산(문자)을 검사해 초과 시 청크 저장
    없이 failed + 한국어 사유(프론트 칩이 그대로 노출). 터미널 상태는
    'indexed'를 재사용한다 — user_upload에선 "세션 컨텍스트 준비 완료" 의미
    (프론트 FileStatus·폴링·재시도 판별 재사용을 위해 상태값을 늘리지 않음).
    """
    file_id = f["id"]
    total_chars = sum(len(c) for c in chunks)
    session_id = f.get("session_id")
    if session_id:
        overlay = await app_settings.get_overlay()
        budget = app_settings.as_int(
            overlay, "session_context_max_chars",
            settings.session_context_max_chars, 10_000, 300_000,
        )
        siblings = await svc.select(
            "files",
            {"session_id": f"eq.{session_id}", "kind": "eq.user_upload",
             "status": "eq.indexed", "id": f"neq.{file_id}",
             "select": "id,context_chars"},
        )
        used = sum(r.get("context_chars") or 0 for r in siblings)
        if used + total_chars > budget:
            remaining = max(0, budget - used)
            await svc.update(
                "files", {"id": f"eq.{file_id}"},
                {"status": "failed",
                 "error": (
                     f"세션 컨텍스트 예산 초과: 이 파일 약 {total_chars:,}자, "
                     f"세션 잔여 {remaining:,}자. 파일을 삭제하거나 더 작은 "
                     "파일로 다시 업로드하세요."
                 )},
            )
            await svc.update(
                "jobs", {"id": f"eq.{job['id']}"},
                {"status": "done", "updated_at": _now_iso()},
            )
            return

    rows = [
        {"file_id": file_id, "seq": i, "chunk_text": c, "status": "stored"}
        for i, c in enumerate(chunks)
    ]
    for i in range(0, len(rows), 500):
        await svc.insert("file_chunks", rows[i : i + 500], returning=False)
    await svc.update(
        "files", {"id": f"eq.{file_id}"},
        {"status": "indexed", "chunk_total": len(chunks),
         "chunk_done": len(chunks), "context_chars": total_chars},
    )
    await svc.update(
        "jobs", {"id": f"eq.{job['id']}"},
        {"status": "done", "updated_at": _now_iso()},
    )
    logger.info(
        "세션 파일 저장: file=%s chunks=%d chars=%d (임베딩 생략)",
        file_id, len(chunks), total_chars,
    )
```

주의: `_handle_split`이 이미 `overlay`를 만들었지만 헬퍼는 자체로 다시 읽는다
(시그니처 단순화 — get_overlay는 캐시됨). `ServiceClient` 타입 임포트는 기존
파일에 있는 것을 그대로 사용.

- [ ] **Step 4: GREEN + 전체 스위트**

Run: `<메인저장소>/backend/.venv/bin/python -m pytest tests/ -v`
Expected: 신규 5개 포함 전체 GREEN. 특히 `test_worker_terminal.py`·
`test_pdf_split.py` 회귀 없음.

- [ ] **Step 5: 커밋**

```bash
git add backend/app/services/embedding_worker.py \
  backend/tests/test_worker_session_context.py
git commit -m "[feat]: D83 워커 user_upload 분기 — 오버랩0 'stored' 저장·임베딩 생략 + D84 세션 예산 게이트(한국어 사유)"
```

---

### Task 4: 주입 빌더 + 프롬프트 블록 + 채팅 배선 (task3-3)

**Files:**
- Create: `backend/app/services/session_context.py`
- Modify: `backend/app/services/gemini.py` (`_WRAP_SESSION_FILES` +
  compose 파라미터·블록)
- Modify: `backend/app/routers/chat.py` (gather 4번째 leg + compose 인자)
- Test: `backend/tests/test_session_context.py`

**Interfaces:**
- Consumes (Task 1·3 산출): `files.session_id/context_chars/status='indexed'`,
  `file_chunks(seq, chunk_text)` 오버랩 0, `settings.session_context_max_chars`.
- Produces:
  - `session_context.build_session_file_context(client, session_id)
    -> {"block": str, "files": [{file_id, name, chars}]} | None`
  - `compose_system_structured(..., session_file_context: str | None = None,
    session_file_sources: list[dict] | None = None)` — `session_files` 블록을
    system_base 직후에 배치(D85).

- [ ] **Step 1: 실패 테스트 작성**

`backend/tests/test_session_context.py`:

```python
"""D83·D84·D85 — 세션 파일 전문 주입 빌더·프롬프트 블록 테스트."""

import pytest

from app.services import session_context as SC
from app.services.gemini import compose_system_structured


class _FakeClient:
    def __init__(self, files=None, chunks=None, raise_on=None):
        self.files = files or []
        self.chunks = chunks or {}
        self.raise_on = raise_on

    async def select(self, table, params):
        if self.raise_on == table:
            raise RuntimeError("boom")
        if table == "files":
            return [dict(f) for f in self.files]
        if table == "file_chunks":
            fid = params["file_id"].removeprefix("eq.")
            return [dict(c) for c in self.chunks.get(fid, [])]
        return []


async def _overlay():
    return {}


@pytest.fixture(autouse=True)
def _patch_overlay(monkeypatch):
    monkeypatch.setattr(SC.app_settings, "get_overlay", _overlay)


@pytest.mark.asyncio
async def test_builds_fulltext_in_seq_order():
    """① 청크를 seq 순으로 이어붙여 파일명 헤더와 함께 블록을 만든다."""
    client = _FakeClient(
        files=[{"id": "f1", "name": "노트.pdf", "context_chars": 9,
                "created_at": "t1"}],
        chunks={"f1": [{"seq": 0, "chunk_text": "안녕"},
                       {"seq": 1, "chunk_text": "하세요"}]},
    )
    result = await SC.build_session_file_context(client, "s1")
    assert result is not None
    assert "[세션 파일: 노트.pdf]\n안녕하세요" in result["block"]
    assert result["files"] == [
        {"file_id": "f1", "name": "노트.pdf", "chars": 5}
    ]


@pytest.mark.asyncio
async def test_no_files_returns_none():
    """② 세션 파일 없음 → None (블록 미주입)."""
    assert await SC.build_session_file_context(_FakeClient(), "s1") is None


@pytest.mark.asyncio
async def test_failure_returns_none():
    """③ 조회 실패 → None (채팅 불중단 불변식)."""
    client = _FakeClient(raise_on="files")
    assert await SC.build_session_file_context(client, "s1") is None


@pytest.mark.asyncio
async def test_budget_double_guard_excludes_whole_file(monkeypatch):
    """④ D84 이중 방어 — 합산 초과 파일은 부분 절단 없이 통째 제외."""
    monkeypatch.setattr(SC.settings, "session_context_max_chars", 10_000)
    client = _FakeClient(
        files=[
            {"id": "f1", "name": "a.txt", "context_chars": 9_000,
             "created_at": "t1"},
            {"id": "f2", "name": "b.txt", "context_chars": 5_000,
             "created_at": "t2"},
        ],
        chunks={
            "f1": [{"seq": 0, "chunk_text": "가" * 9_000}],
            "f2": [{"seq": 0, "chunk_text": "나" * 5_000}],
        },
    )
    result = await SC.build_session_file_context(client, "s1")
    assert result is not None
    names = [f["name"] for f in result["files"]]
    assert names == ["a.txt"]  # f2는 예산 초과로 제외
    assert "나" not in result["block"]


def test_compose_session_block_after_system_base():
    """⑤ D85 — session_files 블록이 system_base 직후, span 정합."""
    prompt, blocks = compose_system_structured(
        "다른 분기 내용",
        None,
        None,
        session_file_context="파일 전문",
        session_file_sources=[{"file_id": "f1", "name": "노트.pdf", "chars": 5}],
        base_instruction="BASE",
    )
    kinds = [b["kind"] for b in blocks]
    assert kinds == ["system_base", "session_files", "memory_link"]
    s, e = blocks[1]["prompt_span"]
    assert prompt[s:e].endswith("파일 전문")
    assert blocks[1]["sources"][0]["file_id"] == "f1"


def test_compose_without_session_block_unchanged():
    """⑥ 파라미터 미지정 시 기존 블록 구성 그대로 (하위 호환)."""
    prompt, blocks = compose_system_structured("참조", "rag", "비교")
    assert [b["kind"] for b in blocks] == [
        "system_base", "memory_link", "rag", "comparison",
    ]
```

- [ ] **Step 2: RED 확인**

Run: `<메인저장소>/backend/.venv/bin/python -m pytest tests/test_session_context.py -v`
Expected: FAIL — `ModuleNotFoundError: app.services.session_context` 및
compose `unexpected keyword argument 'session_file_context'`

- [ ] **Step 3: `services/session_context.py` 신규 작성**

```python
"""세션 파일 전문 주입(D83·D84·D85) — 학생 user_upload를 임베딩 없이 컨텍스트로.

빌더는 best-effort: 어떤 실패도 채팅을 막지 않는다(None 반환). 청크 본문은
USER 스코프 클라이언트로 조회해 RLS가 재검증한다(Qdrant 무접촉 — 신뢰 경계
무관). 파일 순서는 created_at asc 고정 — 턴 간 프롬프트 프리픽스를 보존해
Friendli 프리픽스 캐시를 살린다(D85).
"""

from __future__ import annotations

import logging
from typing import Any

from ..config import get_settings
from . import app_settings
from .supabase_client import UserClient

settings = get_settings()
logger = logging.getLogger("nodi.session_context")


async def build_session_file_context(
    client: UserClient, session_id: str
) -> dict[str, Any] | None:
    """세션에 연결된 user_upload(indexed) 파일 전문을 업로드 순으로 이어붙인다.

    Returns ``{"block": str, "files": [{file_id, name, chars}]}`` or ``None``.
    D84 이중 방어: 워커 게이트가 정상 경로를 막으므로 여기 초과 도달은 admin이
    예산을 낮춘 뒤 등 예외 상황 — 부분 절단(환각 유발) 대신 파일 단위 제외.
    """
    try:
        files = await client.select(
            "files",
            {
                "session_id": f"eq.{session_id}",
                "kind": "eq.user_upload",
                "status": "eq.indexed",
                "select": "id,name,context_chars,created_at",
                "order": "created_at.asc",
            },
        )
        if not files:
            return None
        overlay = await app_settings.get_overlay()
        budget = app_settings.as_int(
            overlay,
            "session_context_max_chars",
            settings.session_context_max_chars,
            10_000,
            300_000,
        )
        parts: list[str] = []
        metas: list[dict[str, Any]] = []
        used = 0
        for f in files:
            declared = f.get("context_chars") or 0
            if used + declared > budget:
                logger.warning(
                    "세션 컨텍스트 예산 초과로 파일 제외: session=%s file=%s",
                    session_id, f.get("id"),
                )
                continue
            # 예산 상한 300K자 ≈ 청크 250행 — PostgREST 기본 max-rows(1000) 이내.
            chunks = await client.select(
                "file_chunks",
                {
                    "file_id": f"eq.{f['id']}",
                    "select": "seq,chunk_text",
                    "order": "seq.asc",
                },
            )
            if not chunks:
                continue
            # 오버랩 0으로 저장(D83)되어 그대로 이어붙이면 원문이 복원된다.
            text = "".join(c.get("chunk_text") or "" for c in chunks)
            name = f.get("name") or "업로드 파일"
            parts.append(f"[세션 파일: {name}]\n{text}")
            metas.append(
                {"file_id": f.get("id"), "name": name, "chars": len(text)}
            )
            used += declared
        if not parts:
            return None
        return {"block": "\n\n".join(parts), "files": metas}
    except Exception:  # noqa: BLE001 - 주입 실패가 채팅을 막으면 안 된다
        logger.exception("세션 파일 컨텍스트 구축 실패")
        return None
```

- [ ] **Step 4: gemini.py — 래퍼 상수 + compose 확장**

(a) `_WRAP_COMPARISON` 아래에 추가:

```python
_WRAP_SESSION_FILES = (
    "아래는 사용자가 이 세션에 올린 파일의 전문입니다. 질문과 관련된 근거로 "
    "우선 활용하고, 파일에 없는 내용은 일반 지식으로 보완하되 출처를 "
    "구분하세요.\n\n"
)
```

(b) `compose_system_structured` 시그니처의 키워드 전용 구간에 추가
(`rag_sources` 앞):

```python
    session_file_context: str | None = None,
    session_file_sources: list[dict] | None = None,
```

(c) `parts` 초기화 직후(= system_base append 뒤, `if reference_context:` 앞)에
삽입:

```python
    # D85: 세션 파일 전문은 턴 간 불변(파일 추가/삭제 전까지) — system_base
    # 직후 고정 배치로 Friendli 프리픽스 캐시(입력 단가·TTFT)를 살린다.
    # 턴마다 변하는 memory/rag/comparison은 뒤에 둔다.
    if session_file_context:
        parts.append(
            (
                "session_files",
                _WRAP_SESSION_FILES + session_file_context,
                "세션에 올린 파일",
                session_file_context,
                None,
                session_file_sources or [],
            )
        )
```

(d) docstring의 블록 목록에 한 줄 추가:
`- session_file_context: 세션에 올린 학생 파일 전문(D83, TASK 3).`

- [ ] **Step 5: chat.py 배선**

(a) 임포트: 기존 `from ..services import ...` 라인에 `session_context` 추가
(파일 상단의 실제 임포트 형태에 맞춤).

(b) gather를 다음으로 교체:

```python
    (
        (reference_context, reference_node_ids),
        rag_result,
        (comparison_context, comparison_node_ids, comparison_sources),
        session_file_result,
    ) = await asyncio.gather(
        memory.build_reference_context(client, body.session_id, chain, by_id),
        rag.build_rag_context(
            client,
            body.question,
            # D73/D82: 학급 세션이면 class_material 자동 스코프 — 세션 행에 이미
            # space_kind/space_ref가 있어 추가 조회 없음(SESSION_SELECT).
            space_kind=session.get("space_kind"),
            space_ref=session.get("space_ref"),
        ),
        memory.build_comparison_context(
            client, body.reference_node_ids or [], chain, by_id
        ),
        # D83: 세션에 올린 학생 파일 전문(임베딩 없음) — best-effort.
        session_context.build_session_file_context(client, body.session_id),
    )
    rag_context = rag_result["block"] if rag_result else None
    rag_sources = rag_result["sources"] if rag_result else []
    session_file_block = (
        session_file_result["block"] if session_file_result else None
    )
    session_file_sources = (
        session_file_result["files"] if session_file_result else []
    )
```

(c) `compose_system_structured` 호출에 인자 추가 (`rag_sources=` 앞):

```python
        session_file_context=session_file_block,
        session_file_sources=session_file_sources,
```

- [ ] **Step 6: GREEN + 전체 스위트**

Run: `<메인저장소>/backend/.venv/bin/python -m pytest tests/ -v`
Expected: 신규 6개 포함 전체 GREEN — 특히 `test_chat_place.py`·
`test_chat_sources.py`(compose 하위 호환) 회귀 없음.

- [ ] **Step 7: 커밋**

```bash
git add backend/app/services/session_context.py \
  backend/app/services/gemini.py backend/app/routers/chat.py \
  backend/tests/test_session_context.py
git commit -m "[feat]: D83 세션 전문 주입 빌더 + D85 session_files 블록(system_base 직후 캐시 배치) + 채팅 4번째 컨텍스트 leg"
```

---

## 검증·게이트 (오케스트레이터 체크리스트)

- 각 task 리뷰 게이트: 스펙 준수 + 품질 이중 판정(회수 커밋 `first^..last`).
- Task 2(프론트) 추가 게이트: 프론트엔드 리뷰어 + 회수 후 메인 저장소
  `cd frontend && npx tsc --noEmit && npm run build`.
- 마무리 E2E(프론트엔드 리뷰어): 학생 프로필로 ① txt/작은 pdf 첨부 →
  "세션 컨텍스트로 사용 중" 칩 → 질의 응답이 파일 내용을 근거로 함(턴로그의
  session_files 블록 확인) ② 예산 초과 파일(예: 200K자 txt) → 실패 칩 +
  한국어 사유 ③ 학급 세션에서 class_material RAG 출처 칩 회귀 없음 ④ 업로드
  후 jobs에 embedding_batch가 생기지 않음(잡 테이블 또는 로그 확인).
- 원격 0037 적용은 배포 시(파일만 커밋) — 단 로컬/원격 dev DB에 즉시 적용해야
  E2E가 성립하므로, E2E 前 Manager가 0037을 dev 프로젝트에 적용한다
  (D81 원장 불변식과 동일하게 **코드 회수 후** 적용).

## Self-review 결과

- 스펙 커버리지: D83(0037·업로드 검증·워커 분기·빌더·터미널 상태) → Task 1/3/4,
  D84(노브·시드·워커 게이트·이중 방어·admin 메타) → Task 1/2/3/4,
  D85(래퍼·배치·span) → Task 4, 프론트 UX(첨부·칩·목록 API·사유 노출) → Task 1/2. 공백 없음.
- 플레이스홀더: 없음 (프론트 CSS는 기존 토큰 준수 지시가 유일한 재량 —
  frontend-design 스킬 범위).
- 타입 일관성: `build_session_file_context` 반환 키 `block/files`,
  compose 파라미터 `session_file_context/session_file_sources`, 청크 상태
  `'stored'`, 노브 키 `session_context_max_chars`(clamp 10_000~300_000) —
  전 task 동일 확인.
