"""마이그레이션이 **매 배포마다 다시 돈다**는 사실을 지키는 검사 (2026-08-12).

`deploy/deploy.sh`에는 마이그레이션 대장(ledger)이 없다 — `db/migrations/*.sql`을
이름순으로 **전부** 다시 돌린다. 그 규약 자체는 나쁘지 않다. 스키마를 맞추는
문장(`CREATE ... IF NOT EXISTS`, `CREATE OR REPLACE`)은 몇 번을 돌려도 결과가
같기 때문이다.

**행을 지우는 문장은 다르다.** `2026-08-10-drop-whisper-lectures.sql`이
`delete from public.lecture_videos;`를 조건 없이 갖고 있었고, 주석에는
"멱등이다. 두 번 돌려도 두 번째는 0행을 지운다"고 적혀 있었다. 그 말이 성립하는
것은 **그 사이에 아무도 행을 안 넣었을 때뿐**이다. 실제로는 관리자가 강의 JSON을
올릴 때마다 다음 배포가 그것을 지웠다(사용자 보고 2026-08-12: "업로드한 영상들이
모두 사라진다"). 오늘 배포가 네 번 나갔으니 네 번 지워졌다.

그래서 못 박는다 — **조건 없는 delete/update, truncate, drop table 금지.**
한 번만 돌려야 하는 청소라면 조건을 걸어 범위를 묶어라(그 파일은 걷어낸
날짜로 묶었다). 조건을 걸 수 없다면 그것은 마이그레이션이 아니라 손으로 한 번
돌릴 스크립트다.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

MIGRATIONS = sorted((Path(__file__).resolve().parents[2] / "db" / "migrations").glob("*.sql"))


def _statements(sql: str) -> list[str]:
    """`--` 주석을 걷어내고 `;`로 끊어 문장 목록으로.

    함수 본문(`$$ ... $$`) 안의 문장도 그대로 쪼개진다 — 그래도 맞다. 그 안의
    delete에도 조건이 있어야 하는 것은 마찬가지다.
    """
    no_comment = re.sub(r"--[^\n]*", " ", sql)
    return [s.strip() for s in no_comment.split(";") if s.strip()]


def test_마이그레이션이_하나는_있다() -> None:
    # 경로가 어긋나면 아래 검사가 조용히 0개를 통과시킨다 — 빈손을 성공으로
    # 읽는 것이 이 부류 검사의 가장 흔한 고장이다.
    assert MIGRATIONS, "db/migrations/*.sql을 못 찾았다 — 경로가 바뀌었나?"


@pytest.mark.parametrize("path", MIGRATIONS, ids=lambda p: p.name)
def test_조건_없이_지우지_않는다(path: Path) -> None:
    for stmt in _statements(path.read_text(encoding="utf-8")):
        head = stmt.lower()
        if re.match(r"^\s*(delete\s+from|update)\b", head):
            assert re.search(r"\bwhere\b", head), (
                f"{path.name}: 조건 없는 문장이 있다 — 매 배포마다 다시 도는 파일이라\n"
                f"  다음 배포가 그 사이에 들어온 데이터를 지운다.\n  → {stmt[:120]}"
            )
        assert not re.match(r"^\s*truncate\b", head), (
            f"{path.name}: truncate는 조건을 걸 수 없다 — 매 배포마다 표를 비운다."
        )
        assert not re.match(r"^\s*drop\s+table\b", head), (
            f"{path.name}: drop table 금지 — 배포가 반복되는 자리다."
        )
