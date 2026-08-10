-- 다 색인됐는데 진행도가 뒤처진 파일을 맞춘다 (2026-08-10).
--
-- 배치 둘이 거의 동시에 끝나면 `_finalize_file`이 각자 다른 시점의 개수를 들고
-- 왔는데, "정확히 한 번" 가드(`status != indexed`)가 **나중에 온 더 정확한
-- 숫자까지** 막았다. 그래서 조각이 전부 embedded인 파일이 화면에는 248/250으로
-- 남았다 — 교사 눈에는 다 되지 않은 자료다.
--
-- 코드는 고쳤다(`_bump_progress`: 진행도는 올리기만 한다). 이미 굳은 행은
-- 여기서 되돌린다. 멱등이다 — 어긋난 행이 없으면 0행을 고친다.

update public.files f
   set chunk_done = c.n,
       updated_at = now()
  from (
        select file_id, count(*) as n
          from public.file_chunks
         where status = 'embedded'
         group by file_id
       ) c
 where c.file_id = f.id
   and f.status = 'indexed'
   and f.chunk_done < c.n;
