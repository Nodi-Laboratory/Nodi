-- 개념 카드 집계용 부분 인덱스 (2026-08-10 전면 점검).
--
-- ## 어떤 질의가 이걸 쓰나
--
-- 세 곳이 **같은 모양**으로 묻는다:
--   · `/spaces/rooms`  방마다의 개념 칩
--   · `/spaces/overview`  공간마다의 대표 개념
--   · 홈 개념 지도
--
--     where session_id in (…) and kind='concept' and source='ai'
--     order by created_at desc
--
-- 지금까지는 `idx_canvas_items_session`으로 그 방의 **모든** 카드를 집어 온 뒤
-- kind·source로 걸러 냈다(계획에 `Rows Removed by Filter`가 찍힌다). 개념이
-- 아닌 카드(메모·도판·클립)가 늘수록 헛읽는 양이 는다.
--
-- 실측(카드 3,279장, 방 60개): buffers 306 → 216, 1.03ms → 0.68ms. 지금 크기에서는
-- 밀리초 싸움이지만, 이 표는 **학기 내내 자라기만 한다** — 카드 10만 장에서는
-- 걸러 내는 비용이 그대로 비례해 는다.
--
-- ## 왜 부분(partial) 인덱스인가
--
-- 조건을 인덱스에 넣어 두면 그 조건을 **다시 검사하지 않는다.** 지금은 카드의
-- 90%가 개념 카드라 크기 이득은 작지만, 학생이 메모·그림을 많이 쓸수록 이 비율은
-- 내려간다. 조건이 인덱스의 정의에 있으므로 그때 자동으로 좁아진다.
--
-- 멱등이다.

CREATE INDEX IF NOT EXISTS idx_canvas_items_concept
    ON public.canvas_items (session_id, created_at DESC)
    WHERE kind = 'concept' AND source = 'ai';

-- ⚠️ **`idx_canvas_items_parent`·`idx_canvas_items_node`는 지우지 않는다.**
--
-- 통계에는 "한 번도 안 쓰인 인덱스"로 뜬다(SELECT가 그 열로 안 거른다 —
-- 트리는 프론트가 세운다). 그래도 필요하다: 둘 다 **외래키**이고
--   node_id        → nodes(id)        ON DELETE CASCADE
--   parent_item_id → canvas_items(id) ON DELETE SET NULL
-- 라, 부모를 지울 때 자식을 찾는 일이 인덱스 없이는 표 전체 훑기가 된다.
-- 대화방 하나를 지우면 그 안의 카드 수백 장이 이 경로를 탄다.
