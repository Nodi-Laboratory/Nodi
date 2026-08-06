-- 02_app_settings — 튜너블 기본값 (D104)
--
-- 이건 **데이터가 아니라 스키마의 일부로 취급한다.** 비어 있으면 admin 콘솔에
-- 노브가 아예 뜨지 않아 운영자가 값을 조정할 수 없다(D62: admin 오버레이 >
-- config 기본값 — 행이 없으면 오버레이 자체가 불가능).
--
-- 값은 구 마이그레이션 0022·0029·0030·0036의 시드를 그대로 옮긴 것이다
-- (스키마 덤프는 마이그레이션의 INSERT를 포함하지 않아 별도로 챙긴다).
-- 코드의 config 기본값과 어긋나면 안 된다 — 바꿀 때 app/config.py도 함께 본다.

insert into public.app_settings (key, value) values
    -- RAG 검색
    ('rag_top_k',                       '5'),
    ('class_material_rag_enabled',      'true'),
    ('class_material_rag_max_distance', '0.60'),
    -- 청킹
    ('chunk_size_chars',                '1200'),
    ('chunk_overlap_chars',             '150'),
    -- 임베딩 팬아웃 (D195) — 잡은 굵게(300청크), 요청은 잘게(100) 동시에.
    -- 실제 동시 요청 수 = 워커 동시성(3) × embedding_request_concurrency.
    ('embedding_batch_size',            '300'),
    ('embedding_request_concurrency',   '4'),
    -- 업로드 상한 (D77: 교사 500MB / 학생 50MB)
    ('class_material_max_bytes',        '524288000'),
    ('file_max_bytes',                  '52428800'),
    -- 학생 세션 파일 전문 주입 예산 (D84)
    ('session_context_max_chars',       '150000'),
    -- 교과서 figure (D86~D88, D103)
    ('figure_pipeline_enabled',         'true'),
    ('figure_retrieve_max_distance',    '0.60'),
    ('figure_judge_concurrency',        '4'),
    -- ReAct 스킬 루프 (D109)
    ('react_enabled',                   'true'),
    ('react_max_steps',                 '3'),
    -- PIKE-RAG (TASK 6, D129~D132)
    ('atom_rag_enabled',                'false'),
    ('atom_questions_per_chunk',        '3'),
    ('atom_top_k',                      '5'),
    ('atom_rag_max_distance',           '0.45'),
    ('atom_gen_concurrency',            '4'),
    ('rag_query_rewrite_enabled',       'false'),
    -- (D134: figure_caption_generate_enabled 노브는 제거 — 캡션은 생성 단독)
    ('semantic_chunking_enabled',       'false'),
    ('semantic_chunking_max_chars',     '120000'),
    -- 강의 클립 추천 (D149)
    ('lecture_pipeline_enabled',        'true'),
    ('lecture_retrieve_max_distance',   '0.60'),
    ('lecture_atom_enabled',            'true'),
    ('lecture_atom_max_distance',       '0.45'),
    ('lecture_atoms_per_clip',          '4'),
    ('lecture_atom_concurrency',        '4'),
    -- 교차 세션 개념 연결 (D171)
    --
    -- 거리는 상한이 아니라 **띠**다. 너무 가까운 히트는 융합이 아니라 중복이다
    -- ("어제도 광합성, 오늘도 광합성"). 바닥 아래는 같은 얘기라 버린다.
    --
    -- 값은 실측이다 (2026-08-06 재측정, embedding-passage 실물 호출):
    --   중복 0.223~0.347 · 연결 0.500~0.618 · 남남 0.693~0.765
    -- 옛 천장 0.72는 **남남을 통과시켰다**("광합성↔시의 운율" 0.693).
    -- 지금 값은 각 구간 사이 빈 곳의 가운데다.
    ('crosslink_enabled',               'true'),
    ('crosslink_min_distance',          '0.42'),
    ('crosslink_max_distance',          '0.66'),
    ('crosslink_top_k',                 '8'),
    -- 관련성 판정에 쓰는 모델 (D182). 배지 하나에 대화 생성과 같은 모델을
    -- 쓸 이유가 없다. 비우면 전역 채팅 모델을 쓴다.
    -- ⚠️ `value`는 **jsonb**다. 문자열 값은 JSON 문자열이어야 한다 —
    -- 'solar-pro2'는 `invalid input syntax for type json`으로 터진다.
    -- 지금까지 노브가 전부 숫자·불리언이라 이 함정이 드러난 적이 없었다.
    ('crosslink_model',                 '"solar-pro2"'),
    -- 상시 켜기 (D172). 켜면 **거리 띠를 무시하고** 가장 가까운 후보를 무조건
    -- 잇는다. 테스트용이다 — 이걸 켜 두면 "드물게"라는 성질이 사라진다.
    ('crosslink_always_on',             'false'),
    -- 펜 표시 해석 (D178)
    --
    -- 질문 획 주변의 카드를 함께 읽어 화살표의 지시대상을 살린다. 선정은
    -- **원래 획 bbox 기준 한 번만** 하고(키운 상자로 재선정하면 조밀한
    -- 캔버스에서 전체를 삼킨다), 상자는 원본의 max_scale배로 자른다.
    ('ink_vlm_enabled',                 'true'),
    ('ink_card_max',                    '5'),
    ('ink_near_pad',                    '120'),
    ('ink_box_max_scale',               '2.5'),
    ('ink_figure_zoom_enabled',         'true'),
    ('ink_vlm_timeout_seconds',         '30'),
    ('ink_card_body_max_chars',         '1200'),
    ('ink_scene_max_side',              '1280')
on conflict (key) do nothing;

-- 질문 방향성 코치 (D194) — 예시 질문을 주지 않고 **방향만** 권한다.
-- 시드가 없으면 콘솔이 "DB 행 없음"으로 띄우고 관리자가 못 만진다.
INSERT INTO public.app_settings (key, value) VALUES
    ('question_coach_enabled', 'true'::jsonb),
    ('question_coach_min_cards', '3'::jsonb),
    ('question_coach_model', '"solar-pro2"'::jsonb)
ON CONFLICT (key) DO NOTHING;
