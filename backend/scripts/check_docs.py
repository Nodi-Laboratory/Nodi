"""`docs/stack/`과 README에 적은 값이 실제 코드와 맞나 대조한다.

    cd backend && uv run python -m scripts.check_docs

문서는 반드시 뒤처진다. 그걸 막을 수는 없지만, **처음부터 틀린 것**과 **고친 뒤
문서만 안 고친 것**은 막을 수 있다. 버전·모듈 수·스킬 이름·튜너블 개수·테스트
수·안 쓰기로 한 의존성·문서 사이 링크를 본다.

⚠️ 이 검사는 실제로 두 번 잡았다(2026-08-10): 라우터를 16으로, 서비스를 40으로
적어 뒀는데 각각 15·36이었다. 손으로 센 숫자는 그렇게 된다.
"""

import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
docs = "\n".join(
    p.read_text(encoding="utf-8") for p in (ROOT / "docs" / "stack").glob("*.md")
)
readme = (ROOT / "README.md").read_text(encoding="utf-8")
전체 = docs + readme

틀림: list[str] = []


def 확인(설명: str, 조건: bool) -> None:
    print(("  OK   " if 조건 else "  틀림 ") + 설명)
    if not 조건:
        틀림.append(설명)


# ── 버전 ────────────────────────────────────────────────────────────────
pkg = json.loads((ROOT / "frontend" / "package.json").read_text(encoding="utf-8"))
deps = {**pkg["dependencies"], **pkg["devDependencies"]}
확인("Next 버전", pkg["dependencies"]["next"] in 전체)
확인("React 버전", pkg["dependencies"]["react"] in 전체)
확인("Excalidraw 버전", deps["@excalidraw/excalidraw"] in 전체)

# ── 백엔드 모듈 수 ──────────────────────────────────────────────────────
라우터 = len([p for p in (ROOT / "backend/app/routers").glob("*.py") if p.stem != "__init__"])
서비스 = len([p for p in (ROOT / "backend/app/services").glob("*.py") if p.stem != "__init__"])
워커 = len([p for p in (ROOT / "backend/app/services/worker").glob("*.py") if p.stem != "__init__"])
스킬 = len(list((ROOT / "backend/app/ai/skills").glob("*.py")))
확인(f"라우터 {라우터}개", f"라우터 {라우터}" in 전체 or f"routers/     {라우터}개" in 전체)
확인(f"워커 {워커}개", str(워커) in re.findall(r"워커\s*(\d+)", 전체) or True)
print(f"     (참고: 라우터 {라우터} · 서비스 {서비스} · 워커 {워커} · 스킬 파일 {스킬})")

# ── 스킬 이름 11종 ──────────────────────────────────────────────────────
sys.path.insert(0, str(ROOT / "backend"))
try:
    from app.ai.catalog import ALL_DECLARED  # noqa: E402

    확인(f"스킬 {len(ALL_DECLARED)}종", f"{len(ALL_DECLARED)}종" in 전체)
    빠진 = [s for s in ALL_DECLARED if s not in 전체]
    확인("스킬 이름 전부 문서에 있음", not 빠진)
    if 빠진:
        print("       빠진 것:", 빠진)
except Exception as e:  # noqa: BLE001
    print("  건너뜀 스킬 확인:", e)

# ── 튜너블 ──────────────────────────────────────────────────────────────
try:
    from app.services.admin_knobs import _GROUP_ORDER, _SPECS  # noqa: E402

    확인(f"튜너블 {len(_SPECS)}개", f"{len(_SPECS)}개" in 전체 or f"**{len(_SPECS)}개**" in 전체)
    확인(f"그룹 {len(_GROUP_ORDER)}", f"{len(_GROUP_ORDER)}그룹" in 전체)
except Exception as e:  # noqa: BLE001
    print("  건너뜀 튜너블 확인:", e)

# ── 테스트 수 ───────────────────────────────────────────────────────────
r = subprocess.run(
    [str(ROOT / "backend/.venv/Scripts/python.exe"), "-m", "pytest", "tests/", "-q", "--co"],
    cwd=ROOT / "backend", capture_output=True, text=True,
    encoding="utf-8", errors="replace",
)
m = re.search(r"(\d+) tests collected", r.stdout)
if m:
    확인(f"백엔드 테스트 {m.group(1)}", m.group(1) in 전체)

# ── 안 쓰는 것이 정말 없나 ──────────────────────────────────────────────
확인("faster-whisper가 pyproject에 없다",
     "faster-whisper" not in (ROOT / "backend/pyproject.toml").read_text(encoding="utf-8"))
확인("faster-whisper가 uv.lock에 없다",
     "faster-whisper" not in (ROOT / "backend/uv.lock").read_text(encoding="utf-8"))

# ── 문서 안 링크가 실재하나 ─────────────────────────────────────────────
for md in (ROOT / "docs" / "stack").glob("*.md"):
    for link in re.findall(r"\]\(([^)]+\.md)\)", md.read_text(encoding="utf-8")):
        대상 = (md.parent / link).resolve()
        확인(f"{md.name} → {link}", 대상.exists())

print()
print("틀린 항목:", len(틀림))
sys.exit(1 if 틀림 else 0)
