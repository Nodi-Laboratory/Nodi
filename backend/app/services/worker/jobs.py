"""잡 수명주기 — 클레임 · 스테일 복구 · 실패 처리 · 파일 마감.

잡 상태 머신(queued → running → done/failed)과 파일 상태(processing →
indexed/partial/failed)를 다루는 곳. 잡을 소비하는 핸들러(split·batch·figures)는
여기를 한정 호출한다.
"""

from __future__ import annotations

import logging
from typing import Any

from ...config import get_settings
from ...db.client import ServiceClient
from . import common

logger = logging.getLogger("nodi.worker.jobs")
settings = get_settings()

# ---------------------------------------------------------------------------
# Job claiming
# ---------------------------------------------------------------------------
_JOB_SELECT = "id,kind,target_id,batch_range,owner_id,attempts,space_ref"

URGENT_KINDS = ("embedding_split", "embedding_batch")
"""**자료를 쓸 수 있게 만드는** 잡. 곁들이보다 먼저 뽑는다 (D188).

## 왜 순서를 정해야 하나

교과서 하나를 올리면 `embedding_split`이 텍스트 잡 5개와 도판 잡 86개를 **같은
순간에** 만든다. 예전에는 `created_at` 오름차순으로만 뽑았는데, 그 순간이
동점이라 순서가 사실상 임의였고 86대5라 도판이 계속 이겼다 — 도판 캡션이 전부
끝날 때까지 **본문이 한 글자도 검색되지 않았다**(실측 2026-08-06: 20분).

교사에게는 "올렸는데 한참 못 쓴다"이고, 학생에게는 "선생님이 올린 자료를
물어봤는데 모른다고 한다"이다. 도판은 곁들이다 — 실패해도 텍스트 인덱싱과
무관하다는 것이 이미 규약이고(D88), 순서에서도 같은 태도를 지킨다.

## 왜 정렬이 아니라 두 번 뽑나

한 번에 넉넉히 읽어 파이썬에서 정렬하는 방법은 **창 밖을 못 본다** — 도판 잡이
수백 개면 텍스트 잡이 창에 아예 안 들어온다. 종류로 좁혀 한 번 더 묻는 편이
큐가 얼마나 길든 성립한다.
"""


async def _claim_jobs(svc: ServiceClient, limit: int) -> list[dict[str, Any]]:
    claimed: list[dict[str, Any]] = []
    # 1차: 급한 종류만. 2차: 남은 자리를 나머지로 채운다(급한 것이 남아 있으면
    # 2차에도 다시 걸리는데, 그건 여전히 먼저 뽑혀야 할 것이라 문제가 없다).
    for kinds in (URGENT_KINDS, None):
        if len(claimed) >= limit:
            break
        params: dict[str, Any] = {
            "status": "eq.queued",
            "select": _JOB_SELECT,
            "order": "created_at.asc",
            "limit": str(limit - len(claimed)),
        }
        if kinds:
            params["kind"] = f"in.({','.join(kinds)})"
        for job in await svc.select("jobs", params):
            rows = await svc.update(
                "jobs",
                {"id": f"eq.{job['id']}", "status": "eq.queued"},
                {
                    "status": "running",
                    "attempts": (job.get("attempts") or 0) + 1,
                    "updated_at": common._now_iso(),
                },
            )
            if rows:  # we won the claim
                claimed.append(rows[0])
    return claimed


async def _recover_stale_jobs(svc: ServiceClient) -> int:
    """Reclaim jobs stuck in 'running' from a crashed worker.

    A running job whose updated_at is older than `embedding_stale_seconds` is
    orphaned. If attempts remain, requeue it; otherwise mark it failed and set
    the file to a terminal status (split -> failed; batch -> partial via
    finalize). updated_at is stamped at claim, so a live in-flight job (the poll
    awaits its jobs before returning) is never seen as stale.
    """
    # D104: 컷오프를 파이썬이 아니라 **DB에서** 계산한다(`before.<초>`).
    # asyncpg가 timestamptz 파라미터에 문자열을 받지 않기도 하고, 앱 시계와 DB
    # 시계가 어긋나면 스테일 판정 자체가 틀리기 때문이다.
    stale = await svc.select(
        "jobs",
        {
            "status": "eq.running",
            "updated_at": f"before.{settings.embedding_stale_seconds}",
            "select": "id,kind,target_id,attempts,batch_range",
            "limit": "50",
        },
    )
    for job in stale:
        if (job.get("attempts") or 0) < settings.embedding_max_attempts:
            await svc.update(
                "jobs",
                {"id": f"eq.{job['id']}", "status": "eq.running"},
                {"status": "queued", "updated_at": common._now_iso()},
            )
            logger.warning("Requeued stale job %s (%s)", job["id"], job["kind"])
        else:
            await _fail_job(svc, job["id"], "max attempts exceeded (stale)")
            await _fail_file_for_job(svc, job)
            logger.error("Failed stale job %s after max attempts", job["id"])
    return len(stale)


async def _fail_job(svc: ServiceClient, job_id: str, error: str) -> None:
    await svc.update(
        "jobs",
        {"id": f"eq.{job_id}"},
        {"status": "failed", "error": error[:1000], "updated_at": common._now_iso()},
    )


async def _fail_file_for_job(
    svc: ServiceClient, job: dict[str, Any], error: str = "split failed"
) -> None:
    """Drive the file to a terminal status when a job permanently fails."""
    file_id = job.get("target_id")
    if not file_id:
        return
    kind = job.get("kind")
    if kind == "embedding_split":
        # D76: 실패 사유를 파일 행에 남긴다(교사 자료실 실패 배지의 안내 문구).
        await svc.update(
            "files",
            {"id": f"eq.{file_id}"},
            {"status": "failed", "error": error[:500]},
        )
    elif kind == "figure_batch":
        # D88: figure_batch 영구 실패는 파일 status를 바꾸지 않는다(figure는
        # files.status와 무관). 범위 내 pending figure 행만 failed로 두고,
        # _finalize_file은 호출하지 않는다(텍스트 인덱싱 진행과 독립).
        rng = job.get("batch_range") or {}
        if "from_seq" in rng and "to_seq" in rng:
            await svc.update(
                "textbook_figures",
                {
                    "file_id": f"eq.{file_id}",
                    "and": f"(seq.gte.{int(rng['from_seq'])},seq.lt.{int(rng['to_seq'])})",
                    "status": "eq.pending",
                },
                {"status": "failed"},
            )
    elif kind == "atom_batch":
        # D129: atom_batch 영구 실패도 파일 status와 무관(원자화는 텍스트
        # 인덱싱과 격리, D88 동형). 범위 내 pending 원자 행만 chunk_seq 기준으로
        # failed로 두고, _finalize_file은 호출하지 않는다.
        rng = job.get("batch_range") or {}
        if "from_seq" in rng and "to_seq" in rng:
            lo, hi = int(rng["from_seq"]), int(rng["to_seq"])
            await svc.update(
                "chunk_atoms",
                {
                    "file_id": f"eq.{file_id}",
                    "and": f"(chunk_seq.gte.{lo},chunk_seq.lt.{hi})",
                    "status": "eq.pending",
                },
                {"status": "failed"},
            )
    elif kind == "lecture_parse":
        # D149: 파싱 영구 실패 — 영상만 failed(파일·다른 인제스트 불가침).
        await svc.update(
            "lecture_videos",
            {"id": f"eq.{file_id}"},
            {"status": "failed", "error": (error or "")[:500]},
        )
    elif kind == "lecture_embed":
        # D149·D88 격리: 임베딩 잡 영구 실패는 파일·영상 status와 무관.
        # 범위 내 pending 클립 행만 seq 기준으로 failed로 둔다.
        rng = job.get("batch_range") or {}
        if "from_seq" in rng and "to_seq" in rng:
            await svc.update(
                "lecture_clips",
                {
                    "video_id": f"eq.{file_id}",
                    "and": f"(seq.gte.{int(rng['from_seq'])},seq.lt.{int(rng['to_seq'])})",
                    "status": "eq.pending",
                },
                {"status": "failed"},
            )
    elif kind == "lecture_atom":
        # D88 격리: 원자 잡 영구 실패는 클립·영상·파일 전부 불가침
        # (핸들러가 원자 행 status를 직접 처리한다).
        pass
    elif kind == "crosslink":
        # D171: 링크가 안 생기는 것으로 끝이다. 카드에는 상태 컬럼이 없고,
        # 있어야 할 이유도 없다 — 연결은 있으면 좋은 것이지 학습의 전제가 아니다.
        pass
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


async def _finalize_file(svc: ServiceClient, file_id: str) -> None:
    """Recompute progress; mark indexed/partial when no pending chunks remain."""
    embedded = await svc.count(
        "file_chunks", {"file_id": f"eq.{file_id}", "status": "eq.embedded"}
    )
    failed = await svc.count(
        "file_chunks", {"file_id": f"eq.{file_id}", "status": "eq.failed"}
    )
    pending = await svc.count(
        "file_chunks", {"file_id": f"eq.{file_id}", "status": "eq.pending"}
    )

    if pending != 0:
        await _bump_progress(svc, file_id, embedded)
        return
    if failed > 0:
        await svc.update(
            "files", {"id": f"eq.{file_id}"},
            {"chunk_done": embedded, "status": "partial"},
        )
        return
    # 모든 청크 임베딩 완료 -> indexed. 조건부 업데이트(status != 'indexed')로
    # 동시 배치가 파일을 정확히 1회 종결하게 한다(D80: 파일 태깅 훅 제거).
    await svc.update(
        "files",
        {"id": f"eq.{file_id}", "status": "neq.indexed"},
        {"chunk_done": embedded, "status": "indexed"},
    )
    # ⚠️ 위 가드는 **종결을 한 번만** 하려는 것이지, 진행도를 낡은 채로 두라는
    # 뜻이 아니었다. 배치 둘이 동시에 끝나면 이런 일이 벌어진다:
    #
    #   A가 센다(248) → B가 센다(250) → B가 쓴다(indexed, 250)
    #                                  → A가 쓴다: 가드에 걸려 **통째로 건너뜀**
    #
    # 순서가 반대면 248이 박힌 채 굳는다. 실측 2026-08-10: 조각 250개가 전부
    # embedded인데 화면은 **248/250**이었다. 교사 눈에는 다 되지 않은 자료다 —
    # 다시 올리거나, 안 쓰거나, 둘 중 하나를 하게 된다.
    await _bump_progress(svc, file_id, embedded)


async def _bump_progress(svc: ServiceClient, file_id: str, embedded: int) -> None:
    """진행도를 **올리기만** 한다.

    조건(`chunk_done < embedded`)을 걸어 뒤늦게 도착한 작은 숫자가 큰 숫자를
    덮지 못하게 한다 — 동시에 끝난 배치들이 각자 다른 시점의 개수를 들고
    오므로, 무조건 쓰면 어느 쪽이 이길지가 순서에 달린다.
    """
    await svc.update(
        "files",
        {"id": f"eq.{file_id}", "chunk_done": f"lt.{embedded}"},
        {"chunk_done": embedded},
    )
