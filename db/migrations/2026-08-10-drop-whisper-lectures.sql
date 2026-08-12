-- 자동 파싱·Whisper로 만들어진 강의 데이터를 지운다 (2026-08-10).
--
-- 대회 규정상 **제품 안에서 해외 모델을 쓸 수 없다.** 그래서 서버의 EBS 자동
-- 파싱과 Whisper 전사를 통째로 걷어냈다. 그 경로가 만든 클립은 흔적을 남기지
-- 않는다 — 파싱은 저장소 밖 오프라인 스크립트가 하고, 관리자가 그 결과 파일을
-- 올리면 다시 채워진다.
--
-- ⚠️⚠️ **2026-08-12 개정 — 이 파일은 관리자가 올린 강의를 전부 지우고 있었다.**
--
-- 원래는 `delete from public.lecture_videos;`였다. "멱등이다. 두 번 돌려도
-- 두 번째는 0행을 지운다"고 적어 뒀는데, **멱등은 그런 뜻이 아니다** — 두 번째
-- 실행에서 0행인 것은 그 사이에 아무도 행을 안 넣었을 때뿐이다. `deploy.sh`는
-- 마이그레이션 폴더 전체를 **매 배포마다** 다시 돌리므로, 관리자가 JSON을 올려
-- 강의를 넣어도 **다음 배포가 통째로 지웠다.**
--
-- 사용자 보고 2026-08-12: "영상을 분명 .json 파일들을 등록했는데 관리자
-- 페이지에서 다시 보니 업로드한 영상들이 모두 사라진다" · "영상 추천이 안 뜬다"
-- (그림 추천은 정상 — 도판은 이 파일이 안 건드린다). 오늘만 배포가 네 번
-- 나갔으니 올린 것이 네 번 지워졌다.
--
-- 그래서 **지우는 범위를 걷어낸 날짜로 묶는다.** 그 전에 있던 행은 전부 자동
-- 파싱이 만든 것이고, 그 뒤에 생긴 행은 사람이 올린 것이다. 이제 이 파일은
-- 몇 번을 돌려도 **새로 올린 강의를 건드리지 않는다.**
--
-- 일회성 청소를 되풀이해도 되는지는 파일마다 다르다 — 스키마를 맞추는 문장
-- (CREATE IF NOT EXISTS)은 몇 번을 돌려도 같지만, **행을 지우는 문장은
-- 그렇지 않다.** `backend/tests/test_migrations_safety.py`가 이제 조건 없는
-- delete/truncate/drop을 막는다.
--
-- ⚠️ Qdrant의 `lecture_clips`·`lecture_clip_atoms` 컬렉션은 SQL이 못 지운다.
-- `deploy/deploy.sh`가 같은 배포에서 지웠는데, 그쪽도 **매번** 지워서 같은
-- 사고를 냈다(행이 살아남아도 벡터가 없어 검색이 빈손). 그래서 그 블록도
-- 함께 걷어냈다 — 옛 벡터는 2026-08-10 이후 배포에서 이미 다 지워졌다.

-- 걷어낸 날. 이 시각 전에 만들어진 행만 자동 파싱이 만든 것이다.
-- 자식부터. FK가 CASCADE라도 순서를 적어 두는 편이 읽는 사람에게 분명하다.
delete from public.lecture_clip_atoms
 where clip_id in (
     select id from public.lecture_clips where created_at < timestamptz '2026-08-10'
 );

delete from public.lecture_clips
 where created_at < timestamptz '2026-08-10';

delete from public.lecture_videos
 where created_at < timestamptz '2026-08-10';

-- 큐에 남아 있을 수 있는 옛 잡. `lecture_parse`는 처리기가 사라졌으므로 언제
-- 만들어졌든 영영 running이 된다 — 날짜를 안 본다. 나머지 둘은 **지금도 쓰는
-- 잡**이라 날짜로 묶는다: 안 그러면 방금 올린 강의의 임베딩 잡을 배포가
-- 큐에서 지워, 행은 있는데 벡터가 영영 안 생긴다.
delete from public.jobs
 where kind = 'lecture_parse';

delete from public.jobs
 where kind in ('lecture_embed', 'lecture_atom')
   and created_at < timestamptz '2026-08-10';

-- 자막 업로드 경로도 함께 없앴다(사용자 결정 2026-08-10) — 그 컬럼은 이제
-- 아무도 안 쓴다. 컬럼을 지우는 대신 비워만 둔다: 백업 파일에 이 이름이
-- 들어 있어서, 컬럼이 사라지면 옛 백업을 되돌릴 때 그 단계가 통째로 실패한다.
update public.lecture_videos set subtitle_path = null where subtitle_path is not null;
