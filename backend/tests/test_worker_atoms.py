"""TASK 6-3 (D129) — atom_batch 워커 + split 팬아웃 + 배선 테스트.

atom_batch(D129): 청크당 solar가 예상 질문 n개를 생성 → chunk_atoms insert(pending)
→ Upstage embedding-passage → Qdrant(chunk_atoms) 적재 → 행 embedded. 원자화 실패는
텍스트 인덱싱과 격리된다(files.status 불가침, D88 동형). 행 단위 멱등: 이미 원자가
있는 청크는 재생성하지 않는다. 킬스위치(atom_rag_enabled) off면 solar 없이 done.

외부 의존(solar/embedding/qdrant)은 전부 mock — 기존 워커 테스트의 패턴.
monkeypatch는 모듈 한정 호출 규약을 따른다(atoms.solar.complete·common._qdrant_upsert 등).
"""

import re

import pytest

from app.services import app_settings, embedding, qdrant_store, solar
from app.services.worker import atoms, common, jobs, runner, split


# ---------------------------------------------------------------------------
# 인메모리 FakeService — file_chunks/chunk_atoms/jobs 테이블을 흉내내
# 멱등·재큐 경로(insert/update/delete/count/select)를 실제처럼 검증한다.
# chunk_atoms insert는 id를 자동 부여(PostgREST returning=representation 모사).
# ---------------------------------------------------------------------------
def _range_bounds(cond, field):
    lo = hi = None
    for op, val in re.findall(rf"{field}\.(gte|lt)\.(\d+)", cond):
        if op == "gte":
            lo = int(val)
        if op == "lt":
            hi = int(val)
    return lo, hi


def _match(row, filters):
    for key, cond in filters.items():
        if key in ("select", "limit", "order"):
            continue
        if key == "and":
            for field in ("seq", "chunk_seq"):
                lo, hi = _range_bounds(cond, field)
                if lo is not None and row.get(field, 0) < lo:
                    return False
                if hi is not None and row.get(field, 0) >= hi:
                    return False
            continue
        if not isinstance(cond, str):
            continue
        if cond.startswith("eq."):
            if str(row.get(key)) != cond[3:]:
                return False
        elif cond.startswith("in.("):
            if str(row.get(key)) not in cond[4:-1].split(","):
                return False
    return True


class _FakeService:
    def __init__(self, file_row, chunks=None, atoms=None, jobs=None):
        self.file_row = dict(file_row)
        self.tables = {
            "file_chunks": [dict(c) for c in (chunks or [])],
            "chunk_atoms": [dict(r) for r in (atoms or [])],
            "jobs": [dict(j) for j in (jobs or [])],
        }
        self.inserts = []
        self.updates = []
        self.deletes = []
        self._atom_seq = 0

    async def select(self, table, params):
        if table == "files":
            return [dict(self.file_row)]
        rows = self.tables.get(table, [])
        return [dict(r) for r in rows if _match(r, params)]

    async def count(self, table, params):
        rows = self.tables.get(table, [])
        return sum(1 for r in rows if _match(r, params))

    async def insert(self, table, rows, returning=True):
        self.inserts.append((table, rows))
        rlist = [rows] if isinstance(rows, dict) else rows
        store = self.tables.get(table)
        out = []
        for r in rlist:
            rec = dict(r)
            if table == "chunk_atoms" and "id" not in rec:
                self._atom_seq += 1
                rec["id"] = f"atom-{self._atom_seq}"
            if store is not None:
                store.append(rec)
            out.append(dict(rec))
        return out if returning else []

    async def update(self, table, filters, patch):
        self.updates.append((table, filters, patch))
        store = self.tables.get(table)
        if store is not None:
            for r in store:
                if _match(r, filters):
                    r.update(patch)
        return [patch]

    async def delete(self, table, filters):
        self.deletes.append((table, filters))
        store = self.tables.get(table)
        if store is not None:
            self.tables[table] = [r for r in store if not _match(r, filters)]
        return []

    async def storage_download(self, bucket, path):
        return b"data"


async def _overlay_on():
    return {"atom_rag_enabled": True}


async def _overlay_off():
    return {"atom_rag_enabled": False}


def _file():
    return {
        "id": "f1", "owner_id": "u1", "storage_path": "u1/f1/doc.txt",
        "mime": "text/plain", "space_ref": "c1",
        "kind": "class_material", "session_id": None,
    }


def _chunk(cid, seq, text=None):
    return {"id": cid, "file_id": "f1", "seq": seq,
            "chunk_text": text or f"청크 본문 {seq}"}


def _atom_batch_job():
    return {"id": "aj1", "kind": "atom_batch", "target_id": "f1",
            "attempts": 1, "batch_range": {"from_seq": 0, "to_seq": 16}}


class _NoopQdrant:
    async def delete(self, collection_name, points_selector):
        return None


def _completion(text):
    return solar.Completion(message={"role": "assistant", "content": text})


@pytest.fixture(autouse=True)
def _patches(monkeypatch):
    monkeypatch.setattr(qdrant_store, "get_client", lambda: _NoopQdrant())
    monkeypatch.setattr(app_settings, "get_overlay", _overlay_on)


# ===========================================================================
# atom_batch 핸들러
# ===========================================================================
@pytest.mark.asyncio
async def test_정상_경로_생성_임베딩_적재(monkeypatch):
    """① pending 청크 2개 → solar 2회(각 3질문) → embed 1회(6질문,RETRIEVAL_DOCUMENT)
    → _qdrant_upsert(chunk_atoms, 페이로드 4키) → 행 embedded → 잡 done."""
    captured = {}

    async def fake_complete(messages, *, max_tokens=None):
        captured.setdefault("max_tokens", max_tokens)
        captured["solar_calls"] = captured.get("solar_calls", 0) + 1
        return _completion("질문 하나\n질문 둘\n질문 셋")

    async def fake_embed(texts, task_type="RETRIEVAL_DOCUMENT"):
        assert task_type == "RETRIEVAL_DOCUMENT"
        captured["embed_texts"] = list(texts)
        return [[0.1, 0.2, 0.3, 0.4] for _ in texts]

    async def fake_upsert(points, collection=qdrant_store.COL_FILE_CHUNKS):
        captured["points"] = points
        captured["collection"] = collection

    monkeypatch.setattr(atoms.solar, "complete", fake_complete)
    monkeypatch.setattr(atoms.embedding, "embed_texts", fake_embed)
    monkeypatch.setattr(common, "_qdrant_upsert", fake_upsert)

    svc = _FakeService(_file(), chunks=[_chunk("c0", 0), _chunk("c1", 1)])
    await atoms._handle_atom_batch(svc, _atom_batch_job())

    assert captured["solar_calls"] == 2
    assert captured["max_tokens"] == 256
    # 6질문(2청크 × 3) 한 번에 임베딩
    assert len(captured["embed_texts"]) == 6
    # Qdrant: chunk_atoms 컬렉션, 페이로드는 식별자 4키만(본문 금지 불변식)
    assert captured["collection"] == qdrant_store.COL_CHUNK_ATOMS
    assert len(captured["points"]) == 6
    for pt in captured["points"]:
        assert set(pt["payload"].keys()) == {"atom_id", "chunk_id", "file_id", "owner_id"}
        assert pt["id"] == pt["payload"]["atom_id"]
    # chunk_atoms 행 insert(pending) — chunk_seq 채워짐
    inserted = [row for t, rows in svc.inserts if t == "chunk_atoms" for row in rows]
    assert len(inserted) == 6
    assert all(r["status"] == "pending" for r in inserted)
    assert {r["chunk_seq"] for r in inserted} == {0, 1}
    # 행 embedded
    embedded = [patch for t, _, patch in svc.updates
                if t == "chunk_atoms" and patch.get("status") == "embedded"]
    assert len(embedded) == 6
    # files 불가침
    assert all(t != "files" for t, _, _ in svc.updates)
    # 잡 done
    assert any(t == "jobs" and patch.get("status") == "done"
               for t, _, patch in svc.updates)


@pytest.mark.asyncio
async def test_킬스위치_off면_생성_없이_done(monkeypatch):
    """② atom_rag_enabled=false 오버레이 → solar 미호출, 잡 done."""
    monkeypatch.setattr(app_settings, "get_overlay", _overlay_off)

    async def boom_complete(messages, *, max_tokens=None):
        raise AssertionError("킬스위치 off인데 solar 호출됨")

    monkeypatch.setattr(atoms.solar, "complete", boom_complete)

    svc = _FakeService(_file(), chunks=[_chunk("c0", 0)])
    await atoms._handle_atom_batch(svc, _atom_batch_job())

    assert all(t != "chunk_atoms" for t, _ in svc.inserts)
    assert any(t == "jobs" and patch.get("status") == "done"
               for t, _, patch in svc.updates)


@pytest.mark.asyncio
async def test_이미_원자가_있는_청크는_스킵(monkeypatch):
    """③ chunk_atoms에 기존 행 → 그 청크는 solar 미호출(행 단위 멱등)."""
    solar_seen = []

    async def fake_complete(messages, *, max_tokens=None):
        # 어떤 청크 본문이 왔는지 기록
        solar_seen.append(messages[-1]["content"])
        return _completion("질문 A")

    async def fake_embed(texts, task_type="RETRIEVAL_DOCUMENT"):
        return [[0.1, 0.2, 0.3, 0.4] for _ in texts]

    async def fake_upsert(points, collection=qdrant_store.COL_FILE_CHUNKS):
        return None

    monkeypatch.setattr(atoms.solar, "complete", fake_complete)
    monkeypatch.setattr(atoms.embedding, "embed_texts", fake_embed)
    monkeypatch.setattr(common, "_qdrant_upsert", fake_upsert)

    svc = _FakeService(
        _file(),
        chunks=[_chunk("c0", 0, "이미 처리된 청크"), _chunk("c1", 1, "새 청크")],
        # c0은 이미 원자 보유
        atoms=[{"id": "a0", "chunk_id": "c0", "file_id": "f1",
                "chunk_seq": 0, "question": "기존 질문", "status": "embedded"}],
    )
    await atoms._handle_atom_batch(svc, _atom_batch_job())

    # solar는 c1(새 청크)만 대상
    assert len(solar_seen) == 1
    assert "새 청크" in solar_seen[0]
    assert "이미 처리된 청크" not in solar_seen[0]


@pytest.mark.asyncio
async def test_failed_잔여_행_있는_청크는_삭제후_재생성_embedded(monkeypatch):
    """(task6-fix2) failed 원자 행이 있는 청크는 스킵이 아니라 삭제 후 재생성돼
    embedded로 끝난다. 존재 기반 멱등(status 무관)이던 구버전은 이 청크를 영구
    스킵해 재큐·재시도를 무효화했다."""
    solar_seen = []

    async def fake_complete(messages, *, max_tokens=None):
        solar_seen.append(messages[-1]["content"])
        return _completion("재생성 질문")

    async def fake_embed(texts, task_type="RETRIEVAL_DOCUMENT"):
        return [[0.1, 0.2, 0.3, 0.4] for _ in texts]

    async def fake_upsert(points, collection=qdrant_store.COL_FILE_CHUNKS):
        return None

    monkeypatch.setattr(atoms.solar, "complete", fake_complete)
    monkeypatch.setattr(atoms.embedding, "embed_texts", fake_embed)
    monkeypatch.setattr(common, "_qdrant_upsert", fake_upsert)

    svc = _FakeService(
        _file(),
        chunks=[_chunk("c0", 0, "재큐된 청크")],
        atoms=[{"id": "a0", "chunk_id": "c0", "file_id": "f1",
                "chunk_seq": 0, "question": "옛 질문", "status": "failed"}],
    )
    await atoms._handle_atom_batch(svc, _atom_batch_job())

    # 재생성됨 — solar가 c0에 대해 호출(스킵 아님)
    assert len(solar_seen) == 1 and "재큐된 청크" in solar_seen[0]
    # 잔여 failed 행(a0) 삭제
    assert any(t == "chunk_atoms" and "a0" in str(filt.get("id"))
               for t, filt in svc.deletes)
    # 새 행 embedded로 마감 + 잡 done
    embedded = [patch for t, _, patch in svc.updates
                if t == "chunk_atoms" and patch.get("status") == "embedded"]
    assert embedded
    assert any(t == "jobs" and patch.get("status") == "done"
               for t, _, patch in svc.updates)


@pytest.mark.asyncio
async def test_requeue_리셋_후_재실행으로_원자_복구(monkeypatch):
    """(task6-fix2) _requeue_atoms가 failed→pending 리셋·재큐한 뒤, 재큐된
    atom_batch 재실행이 그 청크를 실제로 재생성한다(구버전은 pending 잔여 행을
    스킵해 pending이 영구 정체됐다)."""
    async def fake_complete(messages, *, max_tokens=None):
        return _completion("복구 질문")

    async def fake_embed(texts, task_type="RETRIEVAL_DOCUMENT"):
        return [[0.1, 0.2, 0.3, 0.4] for _ in texts]

    async def fake_upsert(points, collection=qdrant_store.COL_FILE_CHUNKS):
        return None

    monkeypatch.setattr(atoms.solar, "complete", fake_complete)
    monkeypatch.setattr(atoms.embedding, "embed_texts", fake_embed)
    monkeypatch.setattr(common, "_qdrant_upsert", fake_upsert)

    svc = _FakeService(
        _file(),
        chunks=[{"id": "c0", "file_id": "f1", "seq": 0,
                 "chunk_text": "본문", "status": "embedded"}],
        atoms=[{"id": "a0", "chunk_id": "c0", "file_id": "f1",
                "chunk_seq": 0, "question": "q", "status": "failed"}],
    )
    # 1) requeue — failed→pending 리셋 + atom_batch 재팬아웃
    action = await atoms._requeue_atoms(svc, _file(), "f1")
    assert action == "atoms_requeued"
    assert svc.tables["chunk_atoms"][0]["status"] == "pending"
    # 2) 재큐된 atom_batch 재실행 — pending 잔여 행 삭제 후 재생성(스킵 아님)
    await atoms._handle_atom_batch(svc, _atom_batch_job())
    assert any(t == "chunk_atoms" for t, _ in svc.deletes)
    embedded = [patch for t, _, patch in svc.updates
                if t == "chunk_atoms" and patch.get("status") == "embedded"]
    assert embedded


@pytest.mark.asyncio
async def test_solar_개별_실패는_그_청크만_스킵(monkeypatch):
    """④ 청크 2개 중 1개 solar 실패 → 나머지는 정상 적재, files 무변경(불가침)."""
    async def fake_complete(messages, *, max_tokens=None):
        if "폭탄" in messages[-1]["content"]:
            raise RuntimeError("solar 500")
        return _completion("정상 질문 1\n정상 질문 2")

    async def fake_embed(texts, task_type="RETRIEVAL_DOCUMENT"):
        return [[0.1, 0.2, 0.3, 0.4] for _ in texts]

    captured = {}

    async def fake_upsert(points, collection=qdrant_store.COL_FILE_CHUNKS):
        captured["points"] = points

    monkeypatch.setattr(atoms.solar, "complete", fake_complete)
    monkeypatch.setattr(atoms.embedding, "embed_texts", fake_embed)
    monkeypatch.setattr(common, "_qdrant_upsert", fake_upsert)

    svc = _FakeService(
        _file(),
        chunks=[_chunk("c0", 0, "폭탄 청크"), _chunk("c1", 1, "정상 청크")],
    )
    await atoms._handle_atom_batch(svc, _atom_batch_job())

    # 정상 청크(c1)의 질문 2개만 적재
    inserted = [row for t, rows in svc.inserts if t == "chunk_atoms" for row in rows]
    assert len(inserted) == 2
    assert all(r["chunk_id"] == "c1" for r in inserted)
    assert len(captured["points"]) == 2
    # files 불가침
    assert all(t != "files" for t, _, _ in svc.updates)
    # 잡 done(개별 실패는 배치를 죽이지 않는다)
    assert any(t == "jobs" and patch.get("status") == "done"
               for t, _, patch in svc.updates)


@pytest.mark.asyncio
async def test_임베딩_실패는_행_failed_잡_failed_files_불가침(monkeypatch):
    """⑤ 임베딩 실패 → 행 failed + 잡 failed, files.status 무변경(D88 동형)."""
    async def fake_complete(messages, *, max_tokens=None):
        return _completion("질문 하나\n질문 둘")

    async def boom_embed(texts, task_type="RETRIEVAL_DOCUMENT"):
        raise RuntimeError("upstage 500")

    monkeypatch.setattr(atoms.solar, "complete", fake_complete)
    monkeypatch.setattr(atoms.embedding, "embed_texts", boom_embed)

    svc = _FakeService(_file(), chunks=[_chunk("c0", 0)])
    await atoms._handle_atom_batch(svc, _atom_batch_job())

    atom_failed = [patch for t, _, patch in svc.updates
                   if t == "chunk_atoms" and patch.get("status") == "failed"]
    assert atom_failed, "임베딩 실패 시 원자 행이 failed로 전환되어야 한다"
    job_failed = [patch for t, _, patch in svc.updates
                  if t == "jobs" and patch.get("status") == "failed"]
    assert job_failed
    assert all(t != "files" for t, _, _ in svc.updates)


@pytest.mark.asyncio
async def test_qdrant_실패는_행_failed_잡_failed(monkeypatch):
    """⑥ Qdrant 업서트 실패도 임베딩 실패와 동일 처리(행 failed + 잡 failed)."""
    async def fake_complete(messages, *, max_tokens=None):
        return _completion("질문 하나")

    async def fake_embed(texts, task_type="RETRIEVAL_DOCUMENT"):
        return [[0.1, 0.2, 0.3, 0.4] for _ in texts]

    async def boom_upsert(points, collection=qdrant_store.COL_FILE_CHUNKS):
        raise RuntimeError("qdrant down")

    monkeypatch.setattr(atoms.solar, "complete", fake_complete)
    monkeypatch.setattr(atoms.embedding, "embed_texts", fake_embed)
    monkeypatch.setattr(common, "_qdrant_upsert", boom_upsert)

    svc = _FakeService(_file(), chunks=[_chunk("c0", 0)])
    await atoms._handle_atom_batch(svc, _atom_batch_job())

    atom_failed = [patch for t, _, patch in svc.updates
                   if t == "chunk_atoms" and patch.get("status") == "failed"]
    assert atom_failed
    job_failed = [patch for t, _, patch in svc.updates
                  if t == "jobs" and patch.get("status") == "failed"]
    assert job_failed
    assert all(t != "files" for t, _, _ in svc.updates)


@pytest.mark.asyncio
async def test_no_pending_청크면_잡만_done(monkeypatch):
    """범위에 청크가 없으면 solar 없이 잡만 마감."""
    async def boom_complete(messages, *, max_tokens=None):
        raise AssertionError("청크 없는데 solar 호출됨")

    monkeypatch.setattr(atoms.solar, "complete", boom_complete)

    svc = _FakeService(_file(), chunks=[])
    await atoms._handle_atom_batch(svc, _atom_batch_job())

    assert any(t == "jobs" and patch.get("status") == "done"
               for t, _, patch in svc.updates)
    assert all(t != "chunk_atoms" for t, _ in svc.inserts)


@pytest.mark.asyncio
async def test_solar_연속_실패_회로차단_배치_실패(monkeypatch):
    """연속 CIRCUIT_BREAK회 실패 → 회로차단 + 배치 실패(잡 failed), files 불가침."""
    async def boom_complete(messages, *, max_tokens=None):
        raise RuntimeError("solar 계속 죽음")

    async def boom_embed(texts, task_type="RETRIEVAL_DOCUMENT"):
        raise AssertionError("회로차단이면 임베딩까지 가지 않는다")

    monkeypatch.setattr(atoms.solar, "complete", boom_complete)
    monkeypatch.setattr(atoms.embedding, "embed_texts", boom_embed)

    chunks = [_chunk(f"c{i}", i) for i in range(atoms.CIRCUIT_BREAK_THRESHOLD)]
    svc = _FakeService(_file(), chunks=chunks)
    await atoms._handle_atom_batch(svc, _atom_batch_job())

    job_failed = [patch for t, _, patch in svc.updates
                  if t == "jobs" and patch.get("status") == "failed"]
    assert job_failed
    assert all(t != "files" for t, _, _ in svc.updates)


# ===========================================================================
# split — atom_batch 팬아웃 (킬스위치 · batch_range)
# ===========================================================================
def _split_job():
    return {"id": "j1", "kind": "embedding_split", "target_id": "f1"}


async def _run_split(monkeypatch, svc, n_chunks, atom_size=None):
    async def fake_extract(data, mime, path):
        return "전체 텍스트"

    monkeypatch.setattr(common, "_extract_text", fake_extract)
    monkeypatch.setattr(
        embedding, "chunk_text",
        lambda text, size, overlap: [f"chunk {i}" for i in range(n_chunks)],
    )
    if atom_size is not None:
        monkeypatch.setattr(split.settings, "atom_batch_size", atom_size)
    await split._handle_split(svc, _split_job())


@pytest.mark.asyncio
async def test_split_팬아웃_킬스위치_off면_atom_잡_0(monkeypatch):
    monkeypatch.setattr(app_settings, "get_overlay", _overlay_off)
    svc = _FakeService(_file())
    await _run_split(monkeypatch, svc, n_chunks=3)

    atom_jobs = [row for t, rows in svc.inserts if t == "jobs"
                 for row in ([rows] if isinstance(rows, dict) else rows)
                 if row["kind"] == "atom_batch"]
    assert atom_jobs == []
    # 텍스트 인덱싱은 정상(embedding_batch는 나간다)
    eb = [row for t, rows in svc.inserts if t == "jobs"
          for row in ([rows] if isinstance(rows, dict) else rows)
          if row["kind"] == "embedding_batch"]
    assert eb


@pytest.mark.asyncio
async def test_split_팬아웃_on이면_범위별_atom_잡(monkeypatch):
    # atom_batch_size=2, 청크 5개 → ceil(5/2)=3배치: [0,2),[2,4),[4,5)
    svc = _FakeService(_file())
    await _run_split(monkeypatch, svc, n_chunks=5, atom_size=2)

    atom_jobs = [row for t, rows in svc.inserts if t == "jobs"
                 for row in ([rows] if isinstance(rows, dict) else rows)
                 if row["kind"] == "atom_batch"]
    assert len(atom_jobs) == 3
    ranges = sorted((j["batch_range"]["from_seq"], j["batch_range"]["to_seq"])
                    for j in atom_jobs)
    assert ranges == [(0, 2), (2, 4), (4, 5)]
    # 잡 shape 확인
    j = atom_jobs[0]
    assert j["target_id"] == "f1"
    assert j["parent_job_id"] == "j1"
    assert j["status"] == "queued"
    assert j["space_ref"] == "c1"


@pytest.mark.asyncio
async def test_split_조기반환_atom_팬아웃_갭_보정(monkeypatch):
    """(task6-fix2) embedding_batch는 있으나 atom_batch가 0인 재큐 split →
    조기 done 전에 atom_batch를 보정 팬아웃한다(figure skip_figure_fanout 동형).
    embedding_batch 삽입 후 atom_batch 삽입 전 크래시 윈도우를 메운다."""
    svc = _FakeService(
        _file(),
        chunks=[
            {"id": "c0", "file_id": "f1", "seq": 0, "chunk_text": "x",
             "status": "embedded"},
            {"id": "c1", "file_id": "f1", "seq": 1, "chunk_text": "y",
             "status": "embedded"},
        ],
        jobs=[{"id": "eb1", "kind": "embedding_batch", "target_id": "f1",
               "status": "queued"}],
    )
    monkeypatch.setattr(split.settings, "atom_batch_size", 5)
    await split._handle_split(svc, _split_job())

    atom_jobs = [row for t, rows in svc.inserts if t == "jobs"
                 for row in ([rows] if isinstance(rows, dict) else rows)
                 if row["kind"] == "atom_batch"]
    assert len(atom_jobs) == 1  # 청크 2개, size 5 → 1배치
    assert atom_jobs[0]["batch_range"] == {"from_seq": 0, "to_seq": 2}
    assert atom_jobs[0]["parent_job_id"] == "j1"
    # split 잡은 done으로 마감
    assert any(t == "jobs" and patch.get("status") == "done"
               for t, _, patch in svc.updates)


@pytest.mark.asyncio
async def test_split_조기반환_atom_이미_있으면_보정_없음(monkeypatch):
    """(task6-fix2) atom_batch가 이미 있으면 조기반환 보정은 중복 팬아웃하지 않는다."""
    svc = _FakeService(
        _file(),
        chunks=[{"id": "c0", "file_id": "f1", "seq": 0, "chunk_text": "x",
                 "status": "embedded"}],
        jobs=[
            {"id": "eb1", "kind": "embedding_batch", "target_id": "f1",
             "status": "queued"},
            {"id": "ab1", "kind": "atom_batch", "target_id": "f1",
             "status": "queued"},
        ],
    )
    await split._handle_split(svc, _split_job())

    new_atom_jobs = [row for t, rows in svc.inserts if t == "jobs"
                     for row in ([rows] if isinstance(rows, dict) else rows)
                     if row["kind"] == "atom_batch"]
    assert new_atom_jobs == []


# ===========================================================================
# 배선 — _fail_file_for_job(atom_batch), requeue_file, runner._process
# ===========================================================================
@pytest.mark.asyncio
async def test_fail_file_for_atom_batch_no_file_status():
    """atom_batch 소진 → 범위 내 pending 원자만 failed, files.status 무변경."""
    svc = _FakeService(
        _file(),
        atoms=[{"id": "a0", "chunk_id": "c0", "file_id": "f1",
                "chunk_seq": 0, "question": "q", "status": "pending"}],
    )
    job = {"id": "aj1", "kind": "atom_batch", "target_id": "f1",
           "batch_range": {"from_seq": 0, "to_seq": 8}}
    await jobs._fail_file_for_job(svc, job, "boom")

    atom_failed = [patch for t, _, patch in svc.updates
                   if t == "chunk_atoms" and patch.get("status") == "failed"]
    assert atom_failed
    assert all(t != "files" for t, _, _ in svc.updates)


@pytest.mark.asyncio
async def test_requeue_resets_failed_atoms(monkeypatch):
    """requeue: failed 원자 행 → pending 리셋 + atom_batch 재팬아웃(관측 문자열)."""
    svc = _FakeService(
        _file(),
        chunks=[{"id": "c0", "file_id": "f1", "seq": 0, "status": "embedded"}],
        atoms=[{"id": "a0", "chunk_id": "c0", "file_id": "f1",
                "chunk_seq": 0, "question": "q", "status": "failed"}],
    )
    action = await runner.requeue_file(svc, "f1")

    assert "atoms_requeued" in action
    assert svc.tables["chunk_atoms"][0]["status"] == "pending"
    atom_jobs = [row for t, rows in svc.inserts if t == "jobs"
                 for row in ([rows] if isinstance(rows, dict) else rows)
                 if row["kind"] == "atom_batch"]
    assert atom_jobs


@pytest.mark.asyncio
async def test_runner_process_dispatches_atom_batch(monkeypatch):
    """runner._process가 atom_batch를 atoms 핸들러로 디스패치한다."""
    called = {}

    async def fake_handle(svc, job):
        called["job"] = job

    monkeypatch.setattr(atoms, "_handle_atom_batch", fake_handle)
    svc = _FakeService(_file())
    await runner._process(svc, _atom_batch_job())
    assert called.get("job", {}).get("kind") == "atom_batch"
