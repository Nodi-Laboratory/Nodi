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
    ('lecture_retrieve_max_distance',   '0.55'),
    ('lecture_atom_enabled',            'true'),
    ('lecture_atom_max_distance',       '0.45'),
    ('lecture_atoms_per_clip',          '4'),
    ('lecture_atom_concurrency',        '4')
on conflict (key) do nothing;
