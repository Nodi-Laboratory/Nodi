-- 자동 파싱·Whisper로 만들어진 강의 데이터를 지운다 (2026-08-10).
--
-- 대회 규정상 **제품 안에서 해외 모델을 쓸 수 없다.** 그래서 서버의 EBS 자동
-- 파싱과 Whisper 전사를 통째로 걷어냈다. 지금 남아 있는 클립은 전부 그 경로가
-- 만든 것이라 흔적을 남기지 않는다 — 파싱은 저장소 밖 오프라인 스크립트가
-- 하고, 관리자가 그 결과 파일을 올리면 다시 채워진다.
--
-- 멱등이다. 두 번 돌려도 두 번째는 0행을 지운다.
--
-- ⚠️ Qdrant의 `lecture_clips`·`lecture_clip_atoms` 컬렉션은 SQL이 못 지운다 —
-- `deploy/deploy.sh`가 같은 배포에서 지운다. 한쪽만 지우면 벡터는 남고 행은
-- 없어서, 검색이 히트를 내고 본문 재조회가 빈손이 된다(그 조합은 조용히 틀린다).

-- 자식부터. FK가 CASCADE라도 순서를 적어 두는 편이 읽는 사람에게 분명하다.
delete from public.lecture_clip_atoms
 where clip_id in (select id from public.lecture_clips);

delete from public.lecture_clips;

delete from public.lecture_videos;

-- 큐에 남아 있을 수 있는 옛 잡. 처리기가 사라졌으므로 영영 running이 된다.
delete from public.jobs
 where kind in ('lecture_parse', 'lecture_embed', 'lecture_atom');

-- 자막 업로드 경로도 함께 없앴다(사용자 결정 2026-08-10) — 그 컬럼은 이제
-- 아무도 안 쓴다. 컬럼을 지우는 대신 비워만 둔다: 백업 파일에 이 이름이
-- 들어 있어서, 컬럼이 사라지면 옛 백업을 되돌릴 때 그 단계가 통째로 실패한다.
update public.lecture_videos set subtitle_path = null where subtitle_path is not null;
