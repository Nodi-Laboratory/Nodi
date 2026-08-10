"""튜너블 카탈로그 (D113) — 관리자 콘솔이 그리는 노브의 목록·범위·설명.

`admin_console`에서 떼어 냈다(2026-08-07). 이유는 둘이다:

  · **기능마다 여기가 늘어난다.** 노브를 하나 붙일 때마다 이 표에 줄이 생기는데,
    그 표가 서비스 로직과 한 파일에 있으면 1,300줄짜리 파일이 매번 충돌한다
    (오늘 병렬 세션과 실제로 충돌했다).
  · **여기는 데이터고 저기는 동작이다.** 섞여 있으면 "이 함수가 무엇을 하나"를
    읽으려는 사람이 800줄짜리 표를 먼저 넘겨야 한다.

프론트가 아니라 서버가 이 표를 갖는 이유는 그대로다 — 기본값은 `config.py`에,
클램프 범위는 호출부에 있다. 스펙이 프론트에 있으면 노브 하나를 추가할 때
서버·DB·프론트 셋이 어긋날 수 있고, 실제로 그렇게 어긋난 적이 있다(D62).
"""

from __future__ import annotations

from typing import Any

from . import question_coach

# ---------------------------------------------------------------------------
# 1) 튜너블 스펙
# ---------------------------------------------------------------------------
# scope 는 "언제부터 듣는가"다 — 이걸 잘못 알면 관리자가 값을 바꾸고 왜 안
# 바뀌는지 헤맨다.
#   live      다음 요청부터 (오버레이 TTL 20초 안)
#   new-only  이미 처리된 것에는 소급되지 않는다 (신규 업로드·신규 잡부터)
#   danger    기존 인덱스와 불일치하면 검색이 깨진다 (재임베딩 필요)
_SPECS: list[dict[str, Any]] = [
    {
        "key": "react_enabled",
        "label": "ReAct 스킬 루프",
        "group": "AI 흐름",
        "widget": "toggle",
        "scope": "live",
        "description": (
            "켜면 채팅 턴이 '도구 판단 → 스킬 실행 → 생성' 2단계로 돈다. "
            "끄면 컨텍스트를 미리 다 주입하는 기존 단발 경로로 돌아간다(롤백용)."
        ),
        "effect": "인사 턴의 불필요한 검색 제거 ↔ 자료 턴의 LLM 왕복 1회 추가",
    },
    {
        "key": "react_max_steps",
        "label": "ReAct 도구 라운드 상한",
        "group": "AI 흐름",
        "widget": "number",
        "min": 1,
        "max": 8,
        "step": 1,
        "scope": "live",
        "description": "도구 호출 라운드 최대 횟수. 넘으면 가진 것으로 생성 단계로 넘어간다.",
        "effect": "조사 깊이 ↔ 응답 지연·토큰",
    },
    {
        "key": "rag_top_k",
        "label": "RAG 주입 청크 수(top-k)",
        "group": "RAG 검색",
        "widget": "number",
        "min": 1,
        "max": 20,
        "step": 1,
        "scope": "live",
        "description": "질의당 벡터 검색에서 가져올 자료 청크의 최대 개수.",
        "effect": "근거 풍부함 ↔ 프롬프트 길이·비용",
    },
    {
        "key": "class_material_rag_enabled",
        "label": "학급 자료 검색 사용",
        "group": "RAG 검색",
        "widget": "toggle",
        "scope": "live",
        "description": "끄면 학급 자료 벡터 검색 자체를 하지 않는다(킬 스위치).",
        "effect": "학급 자료 근거 사용 여부",
    },
    {
        "key": "class_material_rag_max_distance",
        "label": "학급 자료 거리 게이트",
        "group": "RAG 검색",
        "widget": "slider",
        "min": 0.1,
        "max": 0.9,
        "step": 0.05,
        "scope": "live",
        "description": (
            "거리(= 1 − 코사인 유사도) 컷오프. 낮을수록 엄격하다. "
            "실측상 온토픽 질의는 0.50~0.56, 인사말은 0.87 부근이다."
        ),
        "effect": "무관한 자료의 프롬프트 오염 차단 ↔ 온토픽 자료 누락",
    },
    {
        "key": "figure_retrieve_max_distance",
        "label": "교과서 도판 거리 게이트",
        "group": "RAG 검색",
        "widget": "slider",
        "min": 0.1,
        "max": 0.9,
        "step": 0.05,
        "scope": "live",
        "description": "도판 검색에 적용하는 거리 컷오프(자료 게이트와 같은 스케일).",
        "effect": "도판 표시 엄격도",
    },
    {
        "key": "figure_pipeline_enabled",
        "label": "교과서 도판 파이프라인",
        "group": "교과서 도판",
        "widget": "toggle",
        "scope": "live",
        "description": "교과서 업로드 시 도판 추출·임베딩을 수행할지(킬 스위치).",
        "effect": "도판 인제스트 수행 여부",
    },
    {
        "key": "figure_judge_concurrency",
        "label": "도판 비전 판정 동시성",
        "group": "교과서 도판",
        "widget": "number",
        "min": 1,
        "max": 16,
        "step": 1,
        "scope": "new-only",
        "description": "도판 캡션 판정을 몇 개씩 병렬로 돌릴지. 신규 잡부터 적용된다.",
        "effect": "인제스트 속도 ↔ 판정 서버 부하",
    },
    {
        "key": "session_context_max_chars",
        "label": "세션 파일 전문 주입 예산",
        "group": "세션 파일",
        "widget": "number",
        "min": 10000,
        "max": 180000,
        "step": 10000,
        "unit": "자",
        "scope": "new-only",
        "description": (
            "학생이 세션에 올린 파일 전문을 주입할 때 세션당 합산 문자 상한. "
            "업로드 시점에 초과 파일이 거부되므로 이미 저장된 파일에는 소급되지 않는다. "
            "한국어 교과서 문어체는 2.31자/토큰(실측)이라 150000자 ≈ 65K 토큰 — "
            "solar-pro3 컨텍스트(131072토큰)의 절반이다."
        ),
        "effect": "세션 파일 근거량 ↔ 컨텍스트 길이",
    },
    {
        "key": "file_max_bytes",
        "label": "학생 업로드 최대 크기",
        "group": "업로드",
        "widget": "number",
        "min": 1048576,
        "max": 104857600,
        "step": 1048576,
        "unit": "B",
        "scope": "live",
        "description": "학생·개인 업로드 한 파일의 최대 바이트. 52428800 = 50MB.",
        "effect": "업로드 허용 크기",
    },
    {
        "key": "class_material_max_bytes",
        "label": "교사 자료 최대 크기",
        "group": "업로드",
        "widget": "number",
        "min": 1048576,
        "max": 536870912,
        "step": 10485760,
        "unit": "B",
        "scope": "live",
        "description": "교사 학급 자료 한 파일의 최대 바이트. 524288000 = 500MB.",
        "effect": "교사 자료 업로드 크기",
    },
    {
        "key": "embedding_batch_size",
        "label": "임베딩 잡 크기",
        "group": "청킹·임베딩",
        "widget": "number",
        "min": 50,
        "max": 2000,
        "step": 50,
        "unit": "청크",
        "scope": "new-only",
        "description": (
            "embedding_batch 잡 하나가 맡는 청크 수. 잡 안에서 100개 단위 요청으로 "
            "쪼개 동시에 보내므로(D195), 이 값은 '요청 몇 건을 한 잡에 묶는가'다. "
            "신규 잡부터 적용된다."
        ),
        "effect": "큐 대기 감소 ↔ 잡 하나의 실패 반경",
    },
    {
        "key": "embedding_request_concurrency",
        "label": "임베딩 요청 동시성",
        "group": "청킹·임베딩",
        "widget": "number",
        "min": 1,
        "max": 16,
        "step": 1,
        "scope": "new-only",
        "description": (
            "잡 하나가 동시에 띄우는 임베딩 요청 수(D195). 실제 동시 요청은 "
            "워커 동시성(3) × 이 값이다 — Upstage 429가 잦으면 낮춘다."
        ),
        "effect": "인제스트 속도 ↔ 레이트리밋·부하",
    },
    {
        "key": "chunk_size_chars",
        "label": "청크 크기",
        "group": "청킹·임베딩",
        "widget": "number",
        "min": 400,
        "max": 4000,
        "step": 100,
        "unit": "자",
        "scope": "new-only",
        "description": "문서를 임베딩할 때 한 청크의 글자 수. 기존 문서는 재업로드해야 반영된다.",
        "effect": "검색 단위의 정밀도 ↔ 문맥 보존",
    },
    {
        "key": "chunk_overlap_chars",
        "label": "청크 겹침",
        "group": "청킹·임베딩",
        "widget": "number",
        "min": 0,
        "max": 500,
        "step": 10,
        "unit": "자",
        "scope": "new-only",
        "description": "인접 청크가 겹치는 글자 수(경계에서 문맥이 끊기는 것을 막는다).",
        "effect": "경계 문맥 보존 ↔ 저장·임베딩 비용",
    },
    # --- PIKE-RAG (TASK 6, D129~D132) — 클램프는 각 호출부와 일치시킨다 ---
    {
        "key": "atom_rag_enabled",
        "label": "지식 원자화 + 이중 검색",
        "group": "PIKE-RAG",
        "widget": "toggle",
        "scope": "new-only",
        "description": (
            "켜면 자료 인제스트 때 청크마다 '이 청크로 답할 수 있는 예상 질문'을 "
            "solar로 생성해 별도 컬렉션에 임베딩하고, 학생 질의 때 청크·질문 두 "
            "컬렉션을 동시에 검색한다(질문↔질문 매칭으로 재현율 보강). 켜기 전에 "
            "올린 자료에는 원자가 없다 — 재업로드해야 적용된다."
        ),
        "effect": "표현이 다른 질문의 검색 재현율 ↑ ↔ 인제스트 LLM·임베딩 비용 추가",
    },
    {
        "key": "atom_questions_per_chunk",
        "label": "청크당 예상 질문 수",
        "group": "PIKE-RAG",
        "widget": "number",
        "min": 1,
        "max": 8,
        "step": 1,
        "unit": "개",
        "scope": "new-only",
        "description": "원자화 때 청크 하나에서 생성할 예상 질문 개수.",
        "effect": "질문 표현 커버리지 ↑ ↔ 인제스트 비용 정비례",
    },
    {
        "key": "atom_top_k",
        "label": "원자 검색 top-k",
        "group": "PIKE-RAG",
        "widget": "number",
        "min": 1,
        "max": 20,
        "step": 1,
        "scope": "live",
        "description": "이중 검색에서 예상 질문 컬렉션을 몇 개까지 조회할지.",
        "effect": "원자 경유 후보 폭 ↔ 검색 지연",
    },
    {
        "key": "atom_rag_max_distance",
        "label": "원자 거리 게이트",
        "group": "PIKE-RAG",
        "widget": "number",
        "min": 0.1,
        "max": 0.9,
        "step": 0.05,
        "scope": "live",
        "description": (
            "원자(예상 질문) 히트를 채택할 최대 거리(distance = 1 − cosine). "
            "질문↔질문 매칭이라 청크 게이트(0.60)보다 엄격한 0.45가 기본 — "
            "원자로 잡힌 청크에는 청크 게이트를 다시 적용하지 않는다."
        ),
        "effect": "낮출수록 정밀 ↑ 재현율 ↓ (실측 후 조정 권장)",
    },
    {
        "key": "atom_gen_concurrency",
        "label": "원자 생성 동시 호출",
        "group": "PIKE-RAG",
        "widget": "number",
        "min": 1,
        "max": 16,
        "step": 1,
        "scope": "new-only",
        "description": "원자 질문 생성 시 solar 동시 호출 수.",
        "effect": "인제스트 속도 ↔ API 부하",
    },
    {
        "key": "rag_query_rewrite_enabled",
        "label": "검색어 정제",
        "group": "PIKE-RAG",
        "widget": "toggle",
        "scope": "live",
        "description": (
            "자료 검색 전에 solar 1콜로 학생 질문을 검색에 적합한 자연어 의문문으로 "
            "정제한다(키워드 나열로 바꾸지 않는다 — 실측상 거리 악화). 실패하면 "
            "원문 그대로 검색한다."
        ),
        "effect": "구어체·오타 질문의 검색 품질 ↑ ↔ 자료 턴당 약 +0.8초",
    },
    {
        "key": "semantic_chunking_enabled",
        "label": "LLM 의미 청킹",
        "group": "PIKE-RAG",
        "widget": "toggle",
        "scope": "new-only",
        "description": (
            "켜면 상한 이하 크기의 문서에 한해 solar가 청크 경계를 의미 단위로 "
            "재조정한다(문단 중간 절단 방지). 어떤 실패든 기존 정규식 청킹으로 "
            "폴백하므로 인덱싱이 막히지는 않는다. 학생 세션 업로드에는 적용 안 됨."
        ),
        "effect": "청크 경계 품질 ↑ ↔ 인제스트 지연·LLM 비용",
    },
    {
        "key": "semantic_chunking_max_chars",
        "label": "의미 청킹 문서 상한",
        "group": "PIKE-RAG",
        "widget": "number",
        "min": 10000,
        "max": 500000,
        "step": 10000,
        "unit": "자",
        "scope": "new-only",
        "description": (
            "이 글자 수를 넘는 문서는 의미 청킹 없이 정규식 청킹만 쓴다(비용 폭주 가드)."
        ),
        "effect": "적용 범위 ↔ 대형 문서 인제스트 비용",
    },
    # 질문 방향성 코치 (D194)
    {
        "key": "question_coach_enabled",
        "label": "질문 방향성 코치",
        "group": "질문 코치",
        "widget": "toggle",
        "scope": "live",
        "description": (
            "한 브랜치를 이어 물어 온 학생에게 **안 물어본 방향**을 말풍선으로 "
            "권한다. 질문 문장은 주지 않는다 — 베낀 질문은 자기 질문이 아니라서 "
            "'스스로 질문하기'를 하나도 안 푼다."
        ),
        "effect": "권유 노출 ↔ 방해",
    },
    {
        "key": "question_coach_min_cards",
        "label": "코치 발동 카드 수 (n)",
        "group": "질문 코치",
        "widget": "number",
        "min": 1,
        "max": 20,
        "step": 1,
        "unit": "장",
        "scope": "live",
        "description": (
            "한 줄기(브랜치)에 n장이 쌓인 뒤 **하나 더 이어지면**(n+1번째 카드) "
            "말을 건다. 브랜치마다 한 번이고, 그 뒤로 n+3장이 더 이어지면 다시 "
            "걸 수 있다."
        ),
        "effect": "권유 시점 ↔ 잔소리",
        # 재발동 시점(n+3)을 화면이 함께 보여 준다 (사용자 지시 2026-08-06) —
        # 이 값 하나만 놓으면 관리자가 암산해야 한다. 노브를 둘로 쪼개지 않는
        # 이유는 question_coach.read_knobs 주석에 있다.
        "derived": {
            "label": "재발동까지",
            "add": question_coach.REARM_GAP,
            "unit": "장",
        },
    },
    {
        "key": "question_coach_model",
        "label": "코치 판정 모델",
        "group": "질문 코치",
        "widget": "text",
        "scope": "live",
        "description": (
            "카드들을 읽고 물은 방향·안 물은 방향을 고르는 모델. 낱말 몇 개를 "
            "고르는 일이라 가벼운 것으로 충분하다. 비우면 전역 채팅 모델을 쓴다."
        ),
        "effect": "판정 품질 ↔ 비용·지연",
    },
    # 강의 클립 추천 (D149)
    {
        "key": "lecture_pipeline_enabled",
        "label": "강의 클립 파이프라인",
        "group": "강의 클립",
        "widget": "toggle",
        "scope": "new-only",
        "description": "EBS 링크 추가 시 챕터 파싱·임베딩을 수행할지(킬 스위치).",
        "effect": "강의 클립 인제스트 수행 여부",
    },
    {
        "key": "lecture_retrieve_max_distance",
        "label": "강의 클립 거리 게이트(직접)",
        "group": "RAG 검색",
        "widget": "slider",
        "min": 0.1, "max": 0.9, "step": 0.05,
        "scope": "live",
        "description": "클립 본문 직접 검색의 거리 컷오프.",
        "effect": "클립 추천 엄격도",
    },
    {
        "key": "lecture_atom_enabled",
        "label": "강의 원자화 + 이중 검색",
        "group": "강의 클립",
        "widget": "toggle",
        "scope": "new-only",
        "description": "클립 본문에서 solar-pro3로 예상 질문을 생성해 이중 검색할지.",
        "effect": "구어체 질의 매칭 향상",
    },
    {
        "key": "lecture_atom_max_distance",
        "label": "강의 원자 거리 게이트",
        "group": "RAG 검색",
        "widget": "slider",
        "min": 0.1, "max": 0.9, "step": 0.05,
        "scope": "live",
        "description": "원자(생성 질문) 검색의 거리 컷오프. 직접보다 엄격하게.",
        "effect": "원자 경유 추천 엄격도",
    },
    {
        "key": "lecture_atoms_per_clip",
        "label": "클립당 예상 질문 수",
        "group": "강의 클립",
        "widget": "number",
        "min": 1, "max": 8, "step": 1, "unit": "개",
        "scope": "new-only",
        "description": "클립 하나당 solar가 생성할 예상 질문 개수.",
        "effect": "원자 커버리지 ↔ 생성 비용",
    },
    {
        "key": "lecture_atom_concurrency",
        "label": "강의 원자 생성 동시성",
        "group": "강의 클립",
        "widget": "number",
        "min": 1, "max": 16, "step": 1,
        "scope": "new-only",
        "description": "원자 생성 solar 호출을 몇 개씩 병렬로 돌릴지.",
        "effect": "인제스트 속도 ↔ 모델 부하",
    },
    # ── 개념 연결 (D171·D172) ────────────────────────────────────────
    {
        "key": "crosslink_enabled",
        "label": "개념 연결",
        "group": "개념 연결",
        "widget": "toggle",
        "scope": "live",
        "description": (
            "다른 과목·다른 세션에서 한 이야기와 이어지면 카드에 알림을 띄운다."
        ),
        "effect": "융합 학습 지원 on/off",
    },
    {
        "key": "crosslink_always_on",
        "label": "개념 연결 상시 켜기 (테스트용)",
        "group": "개념 연결",
        "widget": "toggle",
        "scope": "live",
        "description": (
            "거리 띠를 무시하고 후보가 있으면 무조건 잇는다. **테스트가 끝나면 "
            "반드시 끈다** — 켜 두면 '드물게 떠서 반가운 것'이라는 성질이 사라진다."
        ),
        "effect": "무조건 연결(엄격도 무시)",
    },
    {
        "key": "crosslink_min_distance",
        "label": "개념 연결 거리 바닥",
        "group": "개념 연결",
        "widget": "slider",
        "min": 0.0, "max": 0.9, "step": 0.01,
        "scope": "live",
        "description": (
            "이보다 가까우면 **같은 얘기**라 버린다(융합이 아니라 중복). "
            "실측: 중복 0.347 · 융합 0.567~0.686."
        ),
        "effect": "중복 히트 차단 강도",
    },
    {
        "key": "crosslink_max_distance",
        "label": "개념 연결 거리 천장",
        "group": "개념 연결",
        "widget": "slider",
        "min": 0.0, "max": 0.9, "step": 0.01,
        "scope": "live",
        "description": (
            "이보다 멀면 남남이라 버린다. 실측(2026-08-06): "
            "중복 0.223~0.347 · 연결 0.500~0.618 · 남남 0.693~0.765. "
            "0.72로 두면 남남이 통과한다."
        ),
        "effect": "연결 빈도 ↔ 관련성",
    },
    {
        "key": "crosslink_model",
        "label": "개념 연결 판정 모델",
        "group": "개념 연결",
        "widget": "text",
        "scope": "live",
        "description": (
            "두 카드가 실제로 이어지는지 판정하고 설명을 쓰는 모델. 배지 하나에 "
            "대화 생성과 같은 모델을 쓸 이유가 없다 — 가벼운 것으로 충분하다. "
            "비우면 전역 채팅 모델을 쓴다."
        ),
        "effect": "판정 품질 ↔ 비용·지연",
    },
    {
        "key": "crosslink_top_k",
        "label": "개념 연결 검색 폭",
        "group": "개념 연결",
        "widget": "number",
        "min": 1, "max": 50, "step": 1, "unit": "개",
        "scope": "live",
        "description": "후보를 몇 개까지 받아 볼지. 링크는 통과한 첫 1개만 만든다.",
        "effect": "후보 폭 ↔ 검색 비용",
    },
    # ── 답변 생성 (D174) ─────────────────────────────────────────────
    #
    # 지금까지 config에만 있어 관리자가 못 만졌다. 학생이 체감하는 값 중
    # 가장 큰 둘이다 — 답이 얼마나 길게 나오는가, 얼마나 딱딱한가.
    {
        "key": "chat_max_tokens",
        "label": "답변 최대 분량",
        "group": "답변 생성",
        "widget": "number",
        "min": 256, "max": 8192, "step": 128, "unit": "토큰",
        "scope": "live",
        "description": (
            "한 번의 답이 쓸 수 있는 상한. 한국어는 대략 1토큰≈1자다 — "
            "2048이면 2천 자 안팎에서 끊긴다. 올리면 길어지지만 읽는 부담과 "
            "생성 시간도 함께 는다."
        ),
        "effect": "답변 길이 ↔ 대기 시간",
    },
    {
        "key": "chat_temperature",
        "label": "답변 다양성",
        "group": "답변 생성",
        "widget": "slider",
        "min": 0.0, "max": 1.5, "step": 0.05,
        "scope": "live",
        "description": (
            "낮으면 매번 비슷하고 안전하게, 높으면 표현이 다양해지는 대신 "
            "사실이 흔들릴 수 있다. 교실용이라면 낮은 쪽이 안전하다."
        ),
        "effect": "일관성 ↔ 표현 다양성",
    },
    {
        "key": "figure_retrieve_top_k",
        "label": "교과서 도판 표시 개수",
        "group": "교과서 도판",
        "widget": "number",
        "min": 1, "max": 10, "step": 1, "unit": "개",
        "scope": "live",
        "description": "한 답에 곁들일 도판 수 상한(거리 게이트를 통과한 것 중).",
        "effect": "도판 노출량",
    },
    {
        "key": "lecture_retrieve_top_k",
        "label": "카드당 강의 클립 수",
        "group": "강의 클립",
        "widget": "number",
        "min": 1, "max": 10, "step": 1, "unit": "개",
        "scope": "live",
        "description": "개념 카드 하나에 곁들일 강의 클립 수 상한 (D190: 기본 1).",
        "effect": "클립 노출량",
    },
    # ── 캔버스 화면 (D174) ───────────────────────────────────────────
    #
    # 프론트에 상수로 박혀 있던 값들이다. 서버가 갖고 `/settings/client`로
    # 내려보내므로 여기서 바꾸면 학생 화면이 바뀐다.
    {
        "key": "canvas_cards_per_turn",
        "label": "한 턴에 만들 카드 수",
        "group": "캔버스 화면",
        "widget": "number",
        "min": 1, "max": 5, "step": 1, "unit": "개",
        "scope": "live",
        "description": (
            "질문 하나에 개념 카드를 몇 장까지 만들지. 1이면 한 번에 하나씩만 "
            "생긴다(D162) — 여러 장이 쏟아지면 학생이 어디를 읽어야 할지 잃는다."
        ),
        "effect": "한 번에 나오는 카드 수",
    },
    {
        "key": "canvas_type_chars_per_frame",
        "label": "글자 나오는 속도",
        "group": "캔버스 화면",
        "widget": "number",
        "min": 1, "max": 12, "step": 1, "unit": "자/프레임",
        "scope": "live",
        "description": (
            "손으로 쓰는 것처럼 한 글자씩 나오는 속도. 60fps 기준이라 2면 "
            "초당 120자쯤이다. 올리면 빨리 읽히지만 '쓰는 중'이라는 느낌이 준다."
        ),
        "effect": "체감 속도 ↔ 손글씨 느낌",
    },
    {
        "key": "canvas_focus_zoom",
        "label": "새 카드 확대 배율",
        "group": "캔버스 화면",
        "widget": "slider",
        "min": 1.0, "max": 4.0, "step": 0.05, "unit": "배",
        "scope": "live",
        "description": (
            "답이 나오면 그 카드로 얼마나 당길지의 **상한**이다. 카드가 화면에 "
            "다 안 들어가면 이보다 작게 잡는다 — 잘린 큰 글씨보다 온전한 작은 "
            "글씨가 읽힌다(D166)."
        ),
        "effect": "새 답의 크기",
    },
    {
        "key": "canvas_map_node_zoom",
        "label": "지도에 그래프가 보이는 배율",
        "group": "캔버스 화면",
        "widget": "slider",
        "min": 1.0, "max": 4.0, "step": 0.1, "unit": "배",
        "scope": "live",
        "description": (
            "지도를 이 배율 이상으로 확대하면 태그 점 대신 **노드와 연결선**이 "
            "보인다. 낮추면 일찍 그래프가 뜨지만 노드가 많을 때 지도가 회색 "
            "판이 된다."
        ),
        "effect": "지도 상세도",
    },
    {
        "key": "canvas_connectors_default_on",
        "label": "캔버스 연결선 기본 표시",
        "group": "캔버스 화면",
        "widget": "toggle",
        "scope": "live",
        "description": (
            "학생이 따로 끄지 않았을 때 캔버스에 연결선을 그릴지(D151). "
            "학생은 지도에서 언제든 켜고 끌 수 있다."
        ),
        "effect": "연결선 기본값",
    },
    {
        "key": "canvas_col_gap",
        "label": "분류(열) 사이 간격",
        "group": "캔버스 화면",
        "widget": "number",
        "min": 300, "max": 2000, "step": 20, "unit": "px",
        "scope": "live",
        "description": "서로 다른 분류의 트리를 좌우로 얼마나 떼어 놓을지.",
        "effect": "트리 사이 여백",
    },
    {
        "key": "canvas_row_gap",
        "label": "부모–자식 세로 간격",
        "group": "캔버스 화면",
        "widget": "number",
        "min": 80, "max": 800, "step": 20, "unit": "px",
        "scope": "live",
        "description": "한 트리 안에서 부모 카드와 자식 카드의 세로 거리.",
        "effect": "트리 세로 밀도",
    },
    {
        "key": "canvas_sib_gap",
        "label": "형제 가지 좌우 간격",
        "group": "캔버스 화면",
        "widget": "number",
        "min": 60, "max": 800, "step": 20, "unit": "px",
        "scope": "live",
        "description": "같은 부모에서 갈라진 가지들을 좌우로 얼마나 벌릴지.",
        "effect": "분기 가독성",
    },
    # ── 카드 밀어내기 (D207) ─────────────────────────────────────────
    #
    # 학생이 카드를 끌면 **배경의 카드들이 비켜 준다.** 그 손맛을 정하는 셋이다.
    # 값이 화면 동작이라 전부 브라우저로 내려간다(D174).
    {
        "key": "card_min_gap",
        "label": "카드 사이 최소 거리",
        "group": "캔버스 화면",
        "widget": "number",
        "min": 0, "max": 240, "step": 4, "unit": "px",
        "scope": "live",
        "description": "두 카드가 이보다 가까워지지 않는다. 0이면 맞닿는 것까지 허용한다.",
        "effect": "캔버스 밀도",
    },
    {
        "key": "card_push_strength",
        "label": "밀려남의 강도",
        "group": "캔버스 화면",
        "widget": "number",
        "min": 0, "max": 150, "step": 5, "unit": "%",
        "scope": "live",
        "description": (
            "100%면 딱 안 겹칠 만큼만 비킨다. 더 크면 여유를 두고 물러나고, "
            "0%면 밀어내기를 끈 것과 같다(겹칠 수 있다)."
        ),
        "effect": "비키는 정도",
    },
    {
        "key": "card_push_speed_ms",
        "label": "밀려남의 속도",
        "group": "캔버스 화면",
        "widget": "number",
        "min": 0, "max": 600, "step": 10, "unit": "ms",
        "scope": "live",
        "description": (
            "비켜나고 되돌아오는 데 걸리는 시간. 0이면 즉시 튀어 부자연스럽고, "
            "너무 길면 손보다 한참 늦게 따라온다."
        ),
        "effect": "움직임의 자연스러움",
    },
    # ── 손글씨 인식 (D176·D177) ──────────────────────────────────────
    #
    # 모델 서버는 **GPU 락으로 요청을 직렬 처리한다**. 그래서 동시성·대기
    # 상한이 실제로 학생 체감을 정한다.
    {
        "key": "ocr_enabled",
        "label": "손글씨 인식",
        "group": "손글씨 인식",
        "widget": "toggle",
        "scope": "live",
        "description": "질문하는 펜의 글자 인식 킬 스위치(모델 서버 점검 등).",
        "effect": "손글씨 인식 on/off",
    },
    {
        "key": "ocr_max_new_tokens",
        "label": "인식 최대 길이",
        "group": "손글씨 인식",
        "widget": "number",
        "min": 128, "max": 4096, "step": 128, "unit": "토큰",
        "scope": "live",
        "description": (
            "**부족하면 인식 결과가 중간에 잘린다.** 여러 줄로 길게 쓰면 그만큼 "
            "필요하다. 올리면 오작동 시 GPU를 더 오래 문다."
        ),
        "effect": "긴 필기 인식 ↔ GPU 점유",
    },
    {
        "key": "ocr_max_concurrent",
        "label": "동시 인식 요청 수",
        "group": "손글씨 인식",
        "widget": "number",
        "min": 1, "max": 8, "step": 1, "unit": "건",
        "scope": "live",
        "description": (
            "모델 서버가 GPU 락으로 직렬 처리하므로 **많이 넣어도 처리량은 안 "
            "는다** — 모두의 대기만 길어진다. 넘치는 요청은 붐빈다고 안내한다."
        ),
        "effect": "대기 길이 ↔ 거절 빈도",
    },
    {
        "key": "ocr_queue_timeout_seconds",
        "label": "인식 대기 상한",
        "group": "손글씨 인식",
        "widget": "number",
        "min": 3, "max": 120, "step": 1, "unit": "초",
        "scope": "live",
        "description": (
            "자리를 기다리는 시간. 넘으면 '지금 붐빈다'고 알린다 — 학생을 오래 "
            "세워 두고 결국 실패시키는 것보다 낫다."
        ),
        "effect": "포기 시점",
    },
    {
        "key": "ocr_timeout_seconds",
        "label": "인식 응답 상한",
        "group": "손글씨 인식",
        "widget": "number",
        "min": 10, "max": 300, "step": 5, "unit": "초",
        "scope": "live",
        "description": "자리를 잡은 뒤 한 건의 상한(문서 실측 6~8초).",
        "effect": "느린 인식 허용 범위",
    },
    # ── 펜 표시 해석 (D178) ──────────────────────────────────────────
    #
    # 손글씨만 읽던 것을 **표시까지** 읽게 한다 — 동그라미·화살표가 어느 카드를
    # 가리키는지. 비전 모델(judge_* 계열)이 도판 캡션과 같은 창구를 쓴다.
    {
        "key": "ink_vlm_enabled",
        "label": "펜 표시 해석",
        "group": "손글씨 인식",
        "widget": "toggle",
        "scope": "live",
        "description": "동그라미·화살표가 어느 카드를 가리키는지 비전 모델로 읽는다.",
        "effect": "표시 해석 on/off",
    },
    {
        "key": "ink_card_max",
        "label": "함께 읽을 카드 수",
        "group": "손글씨 인식",
        "widget": "number",
        "min": 1, "max": 8, "step": 1, "unit": "개",
        "scope": "live",
        "description": "표시 주변에서 끌어올 카드 상한. 많으면 화살표의 의미가 묻힌다.",
        "effect": "질문에 딸려 가는 카드 수",
    },
    {
        "key": "ink_near_pad",
        "label": "근접 판정 반경",
        "group": "손글씨 인식",
        "widget": "number",
        "min": 0, "max": 600, "step": 20, "unit": "px",
        "scope": "live",
        "description": (
            "획에 닿지 않아도 이 거리 안의 카드는 함께 읽는다. 화살표 없이 "
            "카드 옆에 질문만 쓰는 것이 가장 흔한 사용법이다."
        ),
        "effect": "옆에 쓴 질문이 카드를 잡는 범위",
    },
    {
        "key": "ink_box_max_scale",
        "label": "상자 확대 상한",
        "group": "손글씨 인식",
        "widget": "number",
        "min": 1.0, "max": 6.0, "step": 0.5, "unit": "배",
        "scope": "live",
        "description": (
            "카드를 끌어오며 상자가 커질 수 있는 한계(획 bbox 대비). 크게 두면 "
            "그림 안에서 획이 작아져 표시를 못 알아본다."
        ),
        "effect": "도식에서 획이 뭉개지는 정도",
    },
    {
        "key": "ink_figure_zoom_enabled",
        "label": "도판 확대본 전송",
        "group": "손글씨 인식",
        "widget": "toggle",
        "scope": "live",
        "description": (
            "표시가 교과서 도판에 닿으면 그 도판을 원본 해상도로 한 장 더 "
            "보낸다. 도판 위에 그린 표시를 정확히 읽는 대신 느려진다."
        ),
        "effect": "도판 위 표시의 정확도 / 응답 시간",
    },
    {
        "key": "ink_vlm_timeout_seconds",
        "label": "표시 해석 상한",
        "group": "손글씨 인식",
        "widget": "number",
        "min": 5, "max": 120, "step": 5, "unit": "초",
        "scope": "live",
        "description": "넘으면 표시 해석 없이 질문을 보낸다(질문 자체는 막지 않는다).",
        "effect": "느릴 때 기다리는 시간",
    },
    {
        "key": "ink_card_body_max_chars",
        "label": "카드 본문 길이",
        "group": "손글씨 인식",
        "widget": "number",
        "min": 200, "max": 4000, "step": 100, "unit": "자",
        "scope": "live",
        "description": "표시 주변 카드에서 프롬프트에 넣을 본문 길이(카드당).",
        "effect": "질문 프롬프트 크기",
    },
    {
        "key": "ink_scene_max_side",
        "label": "도식 그림 한 변",
        "group": "손글씨 인식",
        "widget": "number",
        "min": 512, "max": 2048, "step": 128, "unit": "px",
        "scope": "live",
        "description": "비전 모델에 보내는 도식 PNG의 긴 변 상한.",
        "effect": "업로드 크기 / 표시 식별력",
    },
]

_SPEC_BY_KEY = {s["key"]: s for s in _SPECS}
_GROUP_ORDER = [
    "답변 생성",
    "손글씨 인식",
    "캔버스 화면",
    "질문 코치",
    "AI 흐름",
    "RAG 검색",
    "청킹·임베딩",
    "세션 파일",
    "업로드",
    "교과서 도판",
    "강의 클립",
    "개념 연결",
    "PIKE-RAG",
    "기타",
]
