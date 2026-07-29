"""TASK 4 (D86/D88/D93) — 워커 textbook 분기 + figure_batch 핸들러 + 삭제 확장 테스트.

textbook split: 구조화 파싱(parse_document_full) → figure 추출·팬아웃(figure_batch)
과 텍스트 청킹·embedding_batch 팬아웃을 병행한다. figure 실패는 텍스트 인덱싱을
절대 막지 않는다(D88). figure_batch(D93): 판정이 캡션을 확정하는 **게이트** —
미설정이면 배치 전체 failed, 판정 실패·해당없음(-1) 행은 임베딩 없이 failed,
선택된 행만 선택 캡션 단독 텍스트로 Upstage 임베딩 → Qdrant(textbook_figures)
적재. delete_file(textbook): 크롭 Storage + 두 Qdrant 컬렉션을 함께 정리한다.

외부 의존(upstage/qdrant/storage/judge)은 전부 mock — 기존 워커 테스트의 패턴.
"""

import re

import pytest

from app.services import (
    app_settings,
    figure_caption,
    figure_extract,
    figure_judge,
    qdrant_store,
    upstage,
)
from app.services import files as F
from app.services.worker import common, figures, jobs, runner, split


# ---------------------------------------------------------------------------
# 인메모리 FakeService — file_chunks/textbook_figures/jobs 테이블을 흉내내
# 멱등·재큐 경로(insert/update/delete/count/select)를 실제처럼 검증한다.
# ---------------------------------------------------------------------------
def _match(row, filters):
    for key, cond in filters.items():
        if key in ("select", "limit", "order"):
            continue
        if key == "and":
            for op, val in re.findall(r"seq\.(gte|lt)\.(\d+)", cond):
                if op == "gte" and row.get("seq", 0) < int(val):
                    return False
                if op == "lt" and row.get("seq", 0) >= int(val):
                    return False
            continue
        if isinstance(cond, str) and cond.startswith("eq."):
            if str(row.get(key)) != cond[3:]:
                return False
    return True


class _FakeService:
    def __init__(self, file_row, figures=None, chunks=None, jobs=None):
        self.file_row = dict(file_row)
        self.tables = {
            "file_chunks": [dict(c) for c in (chunks or [])],
            "textbook_figures": [dict(r) for r in (figures or [])],
            "jobs": [dict(j) for j in (jobs or [])],
        }
        self.inserts = []
        self.updates = []
        self.deletes = []
        self.storage_uploads = []
        self.storage_downloads = []

    async def select(self, table, params):
        if table == "files":
            return [dict(self.file_row)]
        rows = self.tables.get(table, [])
        out = []
        want_status = None
        if params.get("status", "").startswith("eq."):
            want_status = params["status"][3:]
        lo = hi = None
        if "and" in params:
            for op, val in re.findall(r"seq\.(gte|lt)\.(\d+)", params["and"]):
                if op == "gte":
                    lo = int(val)
                if op == "lt":
                    hi = int(val)
        for r in rows:
            if want_status is not None and r.get("status") != want_status:
                continue
            if lo is not None and r.get("seq", 0) < lo:
                continue
            if hi is not None and r.get("seq", 0) >= hi:
                continue
            out.append(dict(r))
        return out

    async def count(self, table, params):
        rows = self.tables.get(table, [])

        def ok(r):
            for key in ("target_id", "file_id", "kind"):
                cond = params.get(key)
                if cond and cond.startswith("eq.") and str(r.get(key)) != cond[3:]:
                    return False
            s = params.get("status")
            if s and s.startswith("eq.") and r.get("status") != s[3:]:
                return False
            if s and s.startswith("in.("):
                if r.get("status") not in s[4:-1].split(","):
                    return False
            return True

        return sum(1 for r in rows if ok(r))

    async def insert(self, table, rows, returning=True):
        self.inserts.append((table, rows))
        rlist = [rows] if isinstance(rows, dict) else rows
        store = self.tables.get(table)
        if store is not None:
            for r in rlist:
                store.append(dict(r))
        return [dict(r) for r in rlist] if returning else []

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
        self.storage_downloads.append((bucket, path))
        return b"\xff\xd8crop"

    async def storage_upload(self, bucket, path, data, content_type):
        self.storage_uploads.append((bucket, path, data, content_type))

    async def storage_delete(self, bucket, path):
        self.deletes.append(("storage", (bucket, path)))


async def _overlay_default():
    return {}


def _tb_file():
    return {
        "id": "f1", "owner_id": "u1", "storage_path": "u1/f1/book.pdf",
        "mime": "application/pdf", "space_ref": "c1",
        "kind": "textbook", "session_id": None,
    }


def _split_job():
    return {"id": "j1", "kind": "embedding_split", "target_id": "f1"}


def _fig_record(page, eid, ext="png", candidates=None):
    """figure_extract.extract_figures 레코드 shape 모사(image_bytes/ext 포함)."""
    return {
        "page": page, "element_id": eid, "bbox": [0.1, 0.2, 0.5, 0.6],
        "caption": f"caption {eid}", "alt": f"alt {eid}", "description": "",
        "figure_type": "", "heading": f"heading {page}",
        "candidates": candidates if candidates is not None else [f"cand {eid}"],
        "embed_text": f"caption {eid} alt {eid}", "match_kind": "caption",
        "image_bytes": b"\xff\xd8jpeg" if ext == "jpg" else b"\x89PNGdata",
        "ext": ext,
    }


class _NoopQdrant:
    """split 정리 경로가 실제 Qdrant에 접속하지 않게 하는 무해한 대역."""

    async def delete(self, collection_name, points_selector):
        return None


@pytest.fixture(autouse=True)
def _patches(monkeypatch):
    # _qdrant_delete_file_points(실함수)가 네트워크 없이 돌게 get_client만 대역.
    # delete_file 테스트는 자체 recording fake로 이 setattr을 덮어써 호출을 검증한다.
    monkeypatch.setattr(qdrant_store, "get_client", lambda: _NoopQdrant())
    monkeypatch.setattr(app_settings, "get_overlay", _overlay_default)


# ===========================================================================
# split — textbook 분기(figure 팬아웃 + 텍스트 병행)
# ===========================================================================
@pytest.mark.asyncio
async def test_textbook_split_fans_out_figures_and_text(monkeypatch):
    """① textbook split: figure 행 N개 + figure_batch 잡 + 텍스트 청크·embedding_batch 병행."""
    async def fake_parse(data, filename):
        return ("전체 마크다운", [{"page": 1}])

    monkeypatch.setattr(upstage, "parse_document_full", fake_parse)
    monkeypatch.setattr(
        figure_extract, "text_from_elements",
        lambda els: "문단 하나입니다.\n\n문단 둘입니다.",
    )
    monkeypatch.setattr(
        figure_extract, "extract_figures",
        lambda els: [_fig_record(1, 10), _fig_record(2, 20, ext="jpg")],
    )

    svc = _FakeService(_tb_file())
    await split._handle_split(svc, _split_job())

    # figure 행 2개 — status=pending, seq 0-base, image_bytes/ext는 행에 없음.
    fig_inserts = [r for t, r in svc.inserts if t == "textbook_figures"]
    assert fig_inserts, "textbook_figures 행이 삽입되어야 한다"
    rows = fig_inserts[0]
    assert len(rows) == 2
    assert [r["seq"] for r in rows] == [0, 1]
    assert all(r["status"] == "pending" for r in rows)
    assert all("image_bytes" not in r and "ext" not in r for r in rows)
    assert rows[0]["image_path"] == "u1/f1/figures/p1_e10.png"
    assert rows[1]["image_path"] == "u1/f1/figures/p2_e20.jpg"

    # 크롭 업로드(경로·content-type)
    assert any(p == "u1/f1/figures/p1_e10.png" and c == "image/png"
               for _, p, _, c in svc.storage_uploads)
    assert any(p == "u1/f1/figures/p2_e20.jpg" and c == "image/jpeg"
               for _, p, _, c in svc.storage_uploads)

    # figure_batch 잡 + embedding_batch 잡 병행 생성
    job_inserts = [r for t, r in svc.inserts if t == "jobs"]
    kinds = [row["kind"] for rows in job_inserts for row in
             ([rows] if isinstance(rows, dict) else rows)]
    assert "figure_batch" in kinds
    assert "embedding_batch" in kinds

    # 텍스트 청크(pending) 병행
    chunk_rows = [row for t, rows in svc.inserts if t == "file_chunks"
                  for row in rows]
    assert chunk_rows and all(r["status"] == "pending" for r in chunk_rows)


@pytest.mark.asyncio
async def test_extract_exception_isolates_text_pipeline(monkeypatch):
    """② extract 예외 → 텍스트 파이프라인 정상 계속 + figure 행 0(격리 D88)."""
    async def fake_parse(data, filename):
        return ("md", [{"page": 1}])

    def boom(els):
        raise RuntimeError("extract 폭발")

    monkeypatch.setattr(upstage, "parse_document_full", fake_parse)
    monkeypatch.setattr(figure_extract, "text_from_elements",
                        lambda els: "본문 텍스트입니다.")
    monkeypatch.setattr(figure_extract, "extract_figures", boom)

    svc = _FakeService(_tb_file())
    await split._handle_split(svc, _split_job())

    assert all(t != "textbook_figures" for t, _ in svc.inserts)
    chunk_rows = [row for t, rows in svc.inserts if t == "file_chunks"
                  for row in rows]
    assert chunk_rows, "텍스트 청크는 정상 생성되어야 한다(figure 실패 무영향)"
    job_kinds = [row["kind"] for t, rows in svc.inserts if t == "jobs"
                 for row in ([rows] if isinstance(rows, dict) else rows)]
    assert "embedding_batch" in job_kinds


@pytest.mark.asyncio
async def test_kill_switch_off_skips_figures(monkeypatch):
    """③ 킬 스위치 off → figure 행 0 + 텍스트 정상."""
    async def overlay_off():
        return {"figure_pipeline_enabled": False}

    async def fake_parse(data, filename):
        return ("md", [{"page": 1}])

    monkeypatch.setattr(app_settings, "get_overlay", overlay_off)
    monkeypatch.setattr(upstage, "parse_document_full", fake_parse)
    monkeypatch.setattr(figure_extract, "text_from_elements",
                        lambda els: "본문입니다.")
    monkeypatch.setattr(
        figure_extract, "extract_figures",
        lambda els: (_ for _ in ()).throw(AssertionError("킬스위치 off인데 호출됨")),
    )

    svc = _FakeService(_tb_file())
    await split._handle_split(svc, _split_job())

    assert all(t != "textbook_figures" for t, _ in svc.inserts)
    assert not svc.storage_uploads
    job_kinds = [row["kind"] for t, rows in svc.inserts if t == "jobs"
                 for row in ([rows] if isinstance(rows, dict) else rows)]
    assert "figure_batch" not in job_kinds
    assert "embedding_batch" in job_kinds


@pytest.mark.asyncio
async def test_split_idempotent_no_duplicate_figures(monkeypatch):
    """⑥ split 2회 실행 → figure 행 수 불변 + figure_batch 잡 중복 없음."""
    async def fake_parse(data, filename):
        return ("md", [{"page": 1}])

    monkeypatch.setattr(upstage, "parse_document_full", fake_parse)
    monkeypatch.setattr(figure_extract, "text_from_elements",
                        lambda els: "본문입니다.")
    monkeypatch.setattr(
        figure_extract, "extract_figures",
        lambda els: [_fig_record(1, 10), _fig_record(1, 11)],
    )

    svc = _FakeService(_tb_file())
    await split._handle_split(svc, _split_job())
    figs_after_1 = len(svc.tables["textbook_figures"])
    figbatch_after_1 = await svc.count(
        "jobs", {"target_id": "eq.f1", "kind": "eq.figure_batch"}
    )

    await split._handle_split(svc, _split_job())
    assert len(svc.tables["textbook_figures"]) == figs_after_1
    figbatch_after_2 = await svc.count(
        "jobs", {"target_id": "eq.f1", "kind": "eq.figure_batch"}
    )
    assert figbatch_after_2 == figbatch_after_1, "figure_batch 잡이 중복 생성되면 안 된다"


@pytest.mark.asyncio
async def test_fanout_figures_rows_include_page_text(monkeypatch):
    """② D118: _fanout_figures는 page_texts 결과를 rows에 page_text로 싣는다.

    페이지 텍스트가 없는 페이지(그림만 있는 페이지)는 ''로 폴백한다.
    """
    async def fake_parse(data, filename):
        return ("md", [{"page": 1}, {"page": 2}])

    monkeypatch.setattr(upstage, "parse_document_full", fake_parse)
    monkeypatch.setattr(figure_extract, "text_from_elements", lambda els: "본문")
    monkeypatch.setattr(
        figure_extract, "extract_figures",
        lambda els: [_fig_record(1, 10), _fig_record(2, 20), _fig_record(3, 30)],
    )
    monkeypatch.setattr(
        figure_extract, "page_texts",
        lambda els, mx: {1: "1페이지 본문", 2: "2페이지 본문"},
    )

    svc = _FakeService(_tb_file())
    await split._handle_split(svc, _split_job())

    rows = [r for t, r in svc.inserts if t == "textbook_figures"][0]
    assert rows[0]["page_text"] == "1페이지 본문"
    assert rows[1]["page_text"] == "2페이지 본문"
    # page_texts에 없는 페이지(figure만 있는 3페이지)는 '' 폴백.
    assert rows[2]["page_text"] == ""


# ===========================================================================
# figure_batch 핸들러
# ===========================================================================
def _fig_row(rid, seq, ext="png", candidates=None, status="pending"):
    return {
        "id": rid, "seq": seq, "file_id": "f1",
        "caption": f"위치캡션 {seq}", "alt": f"alt {seq}", "description": "",
        "heading": f"heading {seq}",
        "candidates": candidates if candidates is not None else [f"후보 {seq}"],
        "embed_text": f"위치캡션 {seq}", "match_kind": "caption",
        "image_path": f"u1/f1/figures/p1_e{seq}.{ext}", "status": status,
    }


def _fig_batch_job():
    return {"id": "fj1", "kind": "figure_batch", "target_id": "f1",
            "attempts": 1, "batch_range": {"from_seq": 0, "to_seq": 8}}


@pytest.mark.asyncio
async def test_figure_batch_judge_none_fails_rows_without_embedding(monkeypatch):
    """④ 판정 None(개별 실패·회로차단) → 행 failed(judge-error), 임베딩 미호출(D93)."""
    async def fake_judge_all(items, *, concurrency):
        return [None for _ in items]  # 전부 판정 실패

    async def boom_embed(texts):
        raise AssertionError("판정 실패 행은 임베딩하지 않는다(D93)")

    monkeypatch.setattr(figure_judge, "is_configured", lambda: True)
    monkeypatch.setattr(figure_judge, "judge_all", fake_judge_all)
    monkeypatch.setattr(upstage, "embed_passages", boom_embed)

    svc = _FakeService(_tb_file(), figures=[_fig_row("r0", 0), _fig_row("r1", 1)])
    await figures._handle_figure_batch(svc, _fig_batch_job())

    failed = [patch for t, _, patch in svc.updates
              if t == "textbook_figures" and patch.get("status") == "failed"]
    assert len(failed) == 2
    assert all(p["match_kind"] == "judge-error" for p in failed)
    assert all(p["selected_index"] is None for p in failed)
    # 판정은 정상 수행됐으므로 잡은 done으로 마감(임베딩할 캡션이 없을 뿐).
    job_done = [patch for t, _, patch in svc.updates
                if t == "jobs" and patch.get("status") == "done"]
    assert job_done


@pytest.mark.asyncio
async def test_figure_batch_unconfigured_skips_only_unlabeled(monkeypatch):
    """⑤ D103: 판정 미설정 → 라벨 없는 행만 no-caption failed. 잡은 done.

    D93에서는 판정이 유일한 캡션 출처라 배치 전체를 failed로 마감했다. D103에서
    파서 라벨 경로가 생기면서, 판정 미설정은 "그 경로를 못 쓴다"일 뿐 배치 실패가
    아니다 — 임베딩할 게 없으면 잡은 정상 마감(done)한다.
    """
    called = {"judge": False}

    async def fake_judge_all(items, *, concurrency):
        called["judge"] = True
        return [None for _ in items]

    async def boom_embed(texts):
        raise AssertionError("캡션이 없으면 임베딩까지 가지 않는다")

    monkeypatch.setattr(figure_judge, "is_configured", lambda: False)
    monkeypatch.setattr(figure_judge, "judge_all", fake_judge_all)
    monkeypatch.setattr(upstage, "embed_passages", boom_embed)

    svc = _FakeService(_tb_file(), figures=[_fig_row("r0", 0)])
    await figures._handle_figure_batch(svc, _fig_batch_job())

    assert called["judge"] is False, "미설정이면 판정을 호출하지 않는다"
    failed = [patch for t, _, patch in svc.updates
              if t == "textbook_figures" and patch.get("status") == "failed"]
    assert len(failed) == 1
    assert failed[0]["match_kind"] == "no-caption"
    job_done = [patch for t, _, patch in svc.updates
                if t == "jobs" and patch.get("status") == "done"]
    assert job_done, "임베딩할 캡션이 없을 뿐 배치는 실패가 아니다"
    assert all(t != "files" for t, _, _ in svc.updates)


@pytest.mark.asyncio
async def test_figure_batch_parsed_caption_skips_judge(monkeypatch):
    """D103 핵심: 파서 라벨로 확정된 행은 판정 없이 그대로 임베딩된다."""
    captured = {}
    called = {"judge": False}

    async def fake_judge_all(items, *, concurrency):
        called["judge"] = True
        return [None for _ in items]

    async def fake_embed(texts):
        captured["texts"] = list(texts)
        return [[0.1, 0.2, 0.3] for _ in texts]

    async def fake_upsert(points, collection=qdrant_store.COL_FILE_CHUNKS):
        captured["points"] = points

    # 판정은 아예 미설정 — 그래도 파싱 캡션 행은 처리돼야 한다.
    monkeypatch.setattr(figure_judge, "is_configured", lambda: False)
    monkeypatch.setattr(figure_judge, "judge_all", fake_judge_all)
    monkeypatch.setattr(upstage, "embed_passages", fake_embed)
    monkeypatch.setattr(common, "_qdrant_upsert", fake_upsert)

    row = _fig_row("r0", 0)
    row["match_kind"] = "parsed"
    row["embed_text"] = "그림 3 첨성대"
    svc = _FakeService(_tb_file(), figures=[row])
    await figures._handle_figure_batch(svc, _fig_batch_job())

    assert called["judge"] is False, "파싱 캡션이면 판정을 호출하지 않는다"
    assert captured["texts"] == ["그림 3 첨성대"], "캡션 단독 임베딩(D93 규약 유지)"
    embedded = [patch for t, _, patch in svc.updates
                if t == "textbook_figures" and patch.get("status") == "embedded"]
    assert embedded and embedded[0]["match_kind"] == "parsed"
    # 판정을 안 거쳤으므로 판정 메타는 비어 있다.
    assert embedded[0]["selected_index"] is None
    assert embedded[0]["judge_reason"] is None


@pytest.mark.asyncio
async def test_figure_batch_mixed_parsed_and_judge(monkeypatch):
    """파싱 캡션 행과 판정 필요 행이 섞여도 각자 경로로 처리된다."""
    captured = {}

    async def fake_judge_all(items, *, concurrency):
        # 판정 대상은 라벨 없는 1건뿐이어야 한다.
        captured["judged"] = len(items)
        return [{"selected_index": 0, "reason": "r"} for _ in items]

    async def fake_embed(texts):
        captured["texts"] = list(texts)
        return [[0.1, 0.2, 0.3] for _ in texts]

    async def fake_upsert(points, collection=qdrant_store.COL_FILE_CHUNKS):
        captured["points"] = points

    monkeypatch.setattr(figure_judge, "is_configured", lambda: True)
    monkeypatch.setattr(figure_judge, "judge_all", fake_judge_all)
    monkeypatch.setattr(upstage, "embed_passages", fake_embed)
    monkeypatch.setattr(common, "_qdrant_upsert", fake_upsert)

    parsed = _fig_row("r0", 0)
    parsed["match_kind"] = "parsed"
    parsed["embed_text"] = "파싱 캡션"
    unlabeled = _fig_row("r1", 1, candidates=["판정 후보"])

    svc = _FakeService(_tb_file(), figures=[parsed, unlabeled])
    await figures._handle_figure_batch(svc, _fig_batch_job())

    assert captured["judged"] == 1, "라벨 있는 행은 판정에 넘기지 않는다"
    assert set(captured["texts"]) == {"파싱 캡션", "판정 후보"}
    kinds = {patch["match_kind"] for t, _, patch in svc.updates
             if t == "textbook_figures" and patch.get("status") == "embedded"}
    assert kinds == {"parsed", "judge"}


@pytest.mark.asyncio
async def test_figure_batch_judge_selects_candidate(monkeypatch):
    """판정 성공(index>=0) → match_kind='judge' + 선택 후보 **단독** 임베딩(D93)."""
    captured = {}

    async def fake_judge_all(items, *, concurrency):
        return [{"selected_index": 0, "reason": "가장 잘 설명"} for _ in items]

    async def fake_embed(texts):
        captured["texts"] = list(texts)
        return [[0.1, 0.2, 0.3] for _ in texts]

    async def fake_upsert(points, collection=qdrant_store.COL_FILE_CHUNKS):
        captured["points"] = points
        captured["collection"] = collection

    monkeypatch.setattr(figure_judge, "is_configured", lambda: True)
    monkeypatch.setattr(figure_judge, "judge_all", fake_judge_all)
    monkeypatch.setattr(upstage, "embed_passages", fake_embed)
    monkeypatch.setattr(common, "_qdrant_upsert", fake_upsert)

    svc = _FakeService(
        _tb_file(),
        figures=[_fig_row("r0", 0, candidates=["정답 후보", "오답"])],
    )
    await figures._handle_figure_batch(svc, _fig_batch_job())

    # D93: 선택 캡션만 — heading·alt·위치캡션 미포함.
    assert captured["texts"] == ["정답 후보"]
    embedded = [patch for t, _, patch in svc.updates
                if t == "textbook_figures" and patch.get("status") == "embedded"]
    assert embedded[0]["match_kind"] == "judge"
    assert embedded[0]["selected_index"] == 0
    assert embedded[0]["judge_reason"] == "가장 잘 설명"
    assert embedded[0]["embed_text"] == "정답 후보"

    # 불변식: Qdrant 컬렉션은 textbook_figures, 페이로드에 캡션/경로/본문 없음.
    assert captured["collection"] == qdrant_store.COL_TEXTBOOK_FIGURES
    for pt in captured["points"]:
        assert set(pt["payload"].keys()) == {"figure_id", "file_id", "owner_id"}


@pytest.mark.asyncio
async def test_figure_batch_minus_one_fails_row_others_embed(monkeypatch):
    """판정 -1(해당 없음) 행은 failed(judge-none), 선택된 행만 임베딩된다(D93)."""
    captured = {}

    async def fake_judge_all(items, *, concurrency):
        return [
            {"selected_index": -1, "reason": "설명하는 후보 없음"},
            {"selected_index": 1, "reason": "둘째가 정답"},
        ]

    async def fake_embed(texts):
        captured["texts"] = list(texts)
        return [[0.1, 0.2, 0.3] for _ in texts]

    async def fake_upsert(points, collection=qdrant_store.COL_FILE_CHUNKS):
        captured["points"] = points

    monkeypatch.setattr(figure_judge, "is_configured", lambda: True)
    monkeypatch.setattr(figure_judge, "judge_all", fake_judge_all)
    monkeypatch.setattr(upstage, "embed_passages", fake_embed)
    monkeypatch.setattr(common, "_qdrant_upsert", fake_upsert)

    svc = _FakeService(
        _tb_file(),
        figures=[
            _fig_row("r0", 0, candidates=["무관 텍스트"]),
            _fig_row("r1", 1, candidates=["오답", "정답 후보"]),
        ],
    )
    await figures._handle_figure_batch(svc, _fig_batch_job())

    assert captured["texts"] == ["정답 후보"]
    assert [pt["id"] for pt in captured["points"]] == ["r1"]
    failed = [patch for t, _, patch in svc.updates
              if t == "textbook_figures" and patch.get("status") == "failed"]
    assert len(failed) == 1
    assert failed[0]["match_kind"] == "judge-none"
    assert failed[0]["selected_index"] == -1
    assert failed[0]["judge_reason"] == "설명하는 후보 없음"
    embedded = [patch for t, _, patch in svc.updates
                if t == "textbook_figures" and patch.get("status") == "embedded"]
    assert len(embedded) == 1
    assert embedded[0]["embed_text"] == "정답 후보"


@pytest.mark.asyncio
async def test_figure_batch_embed_failure_fails_rows_and_job(monkeypatch):
    """임베딩 실패 → 해당 행 failed + 잡 failed(파일 status 무변경 — D88)."""
    async def fake_judge_all(items, *, concurrency):
        return [{"selected_index": 0, "reason": "ok"} for _ in items]

    async def boom_embed(texts):
        raise RuntimeError("upstage 500")

    monkeypatch.setattr(figure_judge, "is_configured", lambda: True)
    monkeypatch.setattr(figure_judge, "judge_all", fake_judge_all)
    monkeypatch.setattr(upstage, "embed_passages", boom_embed)

    svc = _FakeService(_tb_file(), figures=[_fig_row("r0", 0)])
    await figures._handle_figure_batch(svc, _fig_batch_job())

    fig_failed = [patch for t, _, patch in svc.updates
                  if t == "textbook_figures" and patch.get("status") == "failed"]
    assert fig_failed, "임베딩 실패 시 행이 failed로 전환되어야 한다"
    job_failed = [patch for t, _, patch in svc.updates
                  if t == "jobs" and patch.get("status") == "failed"]
    assert job_failed
    # 파일 status는 건드리지 않는다(figure는 files.status와 무관).
    assert all(t != "files" for t, _, _ in svc.updates)


@pytest.mark.asyncio
async def test_figure_batch_no_pending_marks_done(monkeypatch):
    """재시도 시 이미 embedded면 스킵 — 잡만 done(행 단위 멱등)."""
    svc = _FakeService(
        _tb_file(),
        figures=[_fig_row("r0", 0, status="embedded")],
    )
    await figures._handle_figure_batch(svc, _fig_batch_job())
    job_done = [patch for t, _, patch in svc.updates
                if t == "jobs" and patch.get("status") == "done"]
    assert job_done
    assert all(t != "textbook_figures" for t, _, _ in svc.updates)


# ===========================================================================
# figure_batch 핸들러 — D118 캡션 비전 생성 경로(figure_caption_generate_enabled on)
# ===========================================================================
async def _overlay_generate_on():
    return {"figure_caption_generate_enabled": True}


@pytest.mark.asyncio
async def test_figure_batch_generate_embeds_generated_caption(monkeypatch):
    """③ 노브 on: 전 행 생성 → match_kind='generated', embed_text=생성 캡션, 하트비트 호출.

    items에 page_text·parsed_caption(row.caption)·alt가 실리고, 판정 메타는 None.
    """
    captured = {}
    touches = []

    async def fake_caption_all(items, *, concurrency, heartbeat=None):
        captured["items"] = items
        captured["concurrency"] = concurrency
        if heartbeat is not None:
            await heartbeat()  # 하트비트 배선(job id로 touch_job) 검증용
        return [f"생성 캡션 {i}" for i in range(len(items))]

    async def fake_touch(svc, job_id):
        touches.append(job_id)

    async def fake_embed(texts):
        captured["texts"] = list(texts)
        return [[0.1, 0.2, 0.3] for _ in texts]

    async def fake_upsert(points, collection=qdrant_store.COL_FILE_CHUNKS):
        captured["points"] = points
        captured["collection"] = collection

    monkeypatch.setattr(app_settings, "get_overlay", _overlay_generate_on)
    monkeypatch.setattr(figure_judge, "is_configured", lambda: True)
    monkeypatch.setattr(figure_caption, "caption_all", fake_caption_all)
    monkeypatch.setattr(common, "touch_job", fake_touch)
    monkeypatch.setattr(upstage, "embed_passages", fake_embed)
    monkeypatch.setattr(common, "_qdrant_upsert", fake_upsert)

    row0 = _fig_row("r0", 0)
    row0["page_text"] = "페이지 본문 0"
    row0["caption"] = "파싱0"
    row1 = _fig_row("r1", 1)
    row1["page_text"] = "페이지 본문 1"
    row1["caption"] = ""
    svc = _FakeService(_tb_file(), figures=[row0, row1])
    await figures._handle_figure_batch(svc, _fig_batch_job())

    # items 계약: page_text·parsed_caption(=row.caption)·alt 실림.
    assert captured["items"][0]["page_text"] == "페이지 본문 0"
    assert captured["items"][0]["parsed_caption"] == "파싱0"
    assert captured["items"][0]["alt"] == "alt 0"
    # 생성 캡션이 곧 embed_text.
    assert captured["texts"] == ["생성 캡션 0", "생성 캡션 1"]
    embedded = [patch for t, _, patch in svc.updates
                if t == "textbook_figures" and patch.get("status") == "embedded"]
    assert len(embedded) == 2
    assert all(p["match_kind"] == "generated" for p in embedded)
    assert embedded[0]["embed_text"] == "생성 캡션 0"
    # 판정을 안 거쳤으므로 판정 메타는 None.
    assert all(p["selected_index"] is None and p["judge_reason"] is None
               for p in embedded)
    # 하트비트가 이 잡 id로 배선됐다.
    assert touches == ["fj1"]
    # 불변식: Qdrant 컬렉션은 textbook_figures.
    assert captured["collection"] == qdrant_store.COL_TEXTBOOK_FIGURES


@pytest.mark.asyncio
async def test_figure_batch_generate_falls_back_to_parsed(monkeypatch):
    """④ 생성 실패 + parsed(row.caption) 존재 → parsed 폴백(match_kind='parsed')."""
    captured = {}

    async def fake_caption_all(items, *, concurrency, heartbeat=None):
        return [None for _ in items]  # 전부 생성 실패

    async def fake_embed(texts):
        captured["texts"] = list(texts)
        return [[0.1, 0.2, 0.3] for _ in texts]

    async def fake_upsert(points, collection=qdrant_store.COL_FILE_CHUNKS):
        captured["points"] = points

    monkeypatch.setattr(app_settings, "get_overlay", _overlay_generate_on)
    monkeypatch.setattr(figure_judge, "is_configured", lambda: True)
    monkeypatch.setattr(figure_caption, "caption_all", fake_caption_all)
    monkeypatch.setattr(upstage, "embed_passages", fake_embed)
    monkeypatch.setattr(common, "_qdrant_upsert", fake_upsert)

    row0 = _fig_row("r0", 0)
    row0["page_text"] = "본문"
    row0["caption"] = "파싱 캡션"
    svc = _FakeService(_tb_file(), figures=[row0])
    await figures._handle_figure_batch(svc, _fig_batch_job())

    assert captured["texts"] == ["파싱 캡션"]  # parsed 폴백을 임베딩.
    embedded = [patch for t, _, patch in svc.updates
                if t == "textbook_figures" and patch.get("status") == "embedded"]
    assert len(embedded) == 1
    assert embedded[0]["match_kind"] == "parsed"
    assert embedded[0]["embed_text"] == "파싱 캡션"
    assert embedded[0]["selected_index"] is None


@pytest.mark.asyncio
async def test_figure_batch_generate_caption_error_when_no_parsed(monkeypatch):
    """⑤ 생성 실패 + parsed 없음 → 행 failed(match_kind='caption-error'), 임베딩 미호출."""
    async def fake_caption_all(items, *, concurrency, heartbeat=None):
        return [None for _ in items]

    async def boom_embed(texts):
        raise AssertionError("임베딩할 캡션이 없으면 임베딩까지 가지 않는다")

    monkeypatch.setattr(app_settings, "get_overlay", _overlay_generate_on)
    monkeypatch.setattr(figure_judge, "is_configured", lambda: True)
    monkeypatch.setattr(figure_caption, "caption_all", fake_caption_all)
    monkeypatch.setattr(upstage, "embed_passages", boom_embed)

    row0 = _fig_row("r0", 0)
    row0["page_text"] = "본문"
    row0["caption"] = ""  # parsed 폴백 없음
    svc = _FakeService(_tb_file(), figures=[row0])
    await figures._handle_figure_batch(svc, _fig_batch_job())

    failed = [patch for t, _, patch in svc.updates
              if t == "textbook_figures" and patch.get("status") == "failed"]
    assert len(failed) == 1
    assert failed[0]["match_kind"] == "caption-error"
    # 임베딩할 게 없을 뿐 배치는 실패가 아니다 — 잡은 done.
    job_done = [patch for t, _, patch in svc.updates
                if t == "jobs" and patch.get("status") == "done"]
    assert job_done
    assert all(t != "files" for t, _, _ in svc.updates)


@pytest.mark.asyncio
async def test_figure_batch_generate_unconfigured_fails_all_no_caption(monkeypatch):
    """노브 on이어도 judge/caption 계열 미설정이면 전 행 no-caption failed(생성 불가)."""
    called = {"caption": False}

    async def fake_caption_all(items, *, concurrency, heartbeat=None):
        called["caption"] = True
        return [None for _ in items]

    async def boom_embed(texts):
        raise AssertionError("미설정이면 임베딩까지 가지 않는다")

    monkeypatch.setattr(app_settings, "get_overlay", _overlay_generate_on)
    monkeypatch.setattr(figure_judge, "is_configured", lambda: False)
    monkeypatch.setattr(figure_caption, "caption_all", fake_caption_all)
    monkeypatch.setattr(upstage, "embed_passages", boom_embed)

    svc = _FakeService(_tb_file(), figures=[_fig_row("r0", 0), _fig_row("r1", 1)])
    await figures._handle_figure_batch(svc, _fig_batch_job())

    assert called["caption"] is False, "미설정이면 생성을 호출하지 않는다"
    failed = [patch for t, _, patch in svc.updates
              if t == "textbook_figures" and patch.get("status") == "failed"]
    assert len(failed) == 2
    assert all(p["match_kind"] == "no-caption" for p in failed)
    job_done = [patch for t, _, patch in svc.updates
                if t == "jobs" and patch.get("status") == "done"]
    assert job_done


# ===========================================================================
# 배선 — _fail_file_for_job(figure_batch), requeue_file(textbook)
# ===========================================================================
@pytest.mark.asyncio
async def test_fail_file_for_figure_batch_no_file_status(monkeypatch):
    """figure_batch 소진 → 범위 내 pending 행만 failed, 파일 status 무변경."""
    svc = _FakeService(_tb_file(), figures=[_fig_row("r0", 0)])
    job = {"id": "fj1", "kind": "figure_batch", "target_id": "f1",
           "batch_range": {"from_seq": 0, "to_seq": 8}}
    await jobs._fail_file_for_job(svc, job, "boom")

    fig_failed = [patch for t, _, patch in svc.updates
                  if t == "textbook_figures" and patch.get("status") == "failed"]
    assert fig_failed
    assert all(t != "files" for t, _, _ in svc.updates)


@pytest.mark.asyncio
async def test_requeue_textbook_resets_failed_figures(monkeypatch):
    """⑦ requeue: failed figure 행 → pending 리셋 + figure_batch 재팬아웃."""
    svc = _FakeService(
        _tb_file(),
        figures=[_fig_row("r0", 0, status="failed")],
        chunks=[{"file_id": "f1", "seq": 0, "status": "embedded"}],
    )
    action = await runner.requeue_file(svc, "f1")

    assert "figures_requeued" in action
    # failed 행이 pending으로
    assert svc.tables["textbook_figures"][0]["status"] == "pending"
    # figure_batch 잡 재팬아웃
    fig_jobs = [row for t, rows in svc.inserts if t == "jobs"
                for row in ([rows] if isinstance(rows, dict) else rows)
                if row["kind"] == "figure_batch"]
    assert fig_jobs


# ===========================================================================
# delete_file(textbook) — 두 컬렉션 purge + 크롭 storage_delete
# ===========================================================================
class _FakeUserClientTB:
    def __init__(self, file_row):
        self._file_row = file_row
        self.rpc_calls = []

    async def select(self, table, params):
        return [self._file_row]

    async def rpc(self, name, params):
        self.rpc_calls.append((name, params))
        return None


class _FakeServiceTB:
    def __init__(self, image_paths):
        self._image_paths = image_paths
        self.storage_deletes = []

    async def select(self, table, params):
        if table == "textbook_figures":
            return [{"image_path": p} for p in self._image_paths]
        return []

    async def storage_delete(self, bucket, path):
        self.storage_deletes.append((bucket, path))


class _FakeQdrantTB:
    def __init__(self):
        self.deletes = []

    async def delete(self, collection_name, points_selector):
        self.deletes.append(collection_name)


@pytest.mark.asyncio
async def test_delete_textbook_purges_both_collections(monkeypatch):
    """⑧ delete_file(textbook): 크롭 storage_delete + 두 컬렉션 Qdrant purge."""
    fake_q = _FakeQdrantTB()
    monkeypatch.setattr(qdrant_store, "get_client", lambda: fake_q)
    file_row = {
        "owner_id": "u1", "kind": "textbook",
        "storage_path": "u1/f1/book.pdf",
    }
    client = _FakeUserClientTB(file_row)
    service = _FakeServiceTB(["u1/f1/figures/p1_e10.png", "u1/f1/figures/p2_e20.jpg"])

    await F.delete_file(service, client, "u1", "f1")

    # 크롭 2개 + 원본 1개 삭제
    deleted_paths = [p for _, p in service.storage_deletes]
    assert "u1/f1/figures/p1_e10.png" in deleted_paths
    assert "u1/f1/figures/p2_e20.jpg" in deleted_paths
    assert "u1/f1/book.pdf" in deleted_paths
    # 두 Qdrant 컬렉션 purge
    assert qdrant_store.COL_FILE_CHUNKS in fake_q.deletes
    assert qdrant_store.COL_TEXTBOOK_FIGURES in fake_q.deletes
    assert ("delete_file_cascade", {"p_file_id": "f1"}) in client.rpc_calls
