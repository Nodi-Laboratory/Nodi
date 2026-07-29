-- D122: 캔버스 아이템 · 그림 저장 (캔버스 v2)
--
-- D105는 "카드 좌표를 저장하지 않는다"였다. 자동 배치만 있던 시절의 결정이고,
-- 학생이 아이템을 드래그해 옮길 수 있게 되는 순간 성립하지 않는다 — 옮긴 자리가
-- 저장되지 않으면 새로고침마다 학생의 작업이 사라진다.
--
-- D105의 좋은 성질(결정론적 배치)은 pinned=false인 아이템에서 그대로 유지된다:
--   pinned=false → 배치 엔진이 자리를 정한다. 같은 입력이면 항상 같은 결과
--   pinned=true  → 학생이 정한 자리. 엔진은 장애물로만 읽고 절대 옮기지 않는다
--
-- nodes는 그대로 둔다. nodes = 대화 기록(관리자 콘솔·백업·ReAct 스킬이 읽는다),
-- canvas_items = 캔버스 투영. 역할이 다르다. 학생이 캔버스에서 본문을 고쳐도
-- nodes.answer의 원문은 보존된다 — 교사·관리자는 AI가 실제로 뭐라고 했는지
-- 볼 수 있어야 한다.
--
-- 멱등: 몇 번을 돌려도 안전하다.

BEGIN;

CREATE TABLE IF NOT EXISTS public.canvas_items (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id     uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
    -- 어느 턴에서 나왔나. 사용자 메모(kind='note')는 NULL이다.
    node_id        uuid REFERENCES public.nodes(id) ON DELETE CASCADE,
    -- AI 응답이 어느 메모에 대한 답인가 (D126 연결선).
    -- 부모가 지워져도 답변 자체는 남긴다 → SET NULL.
    parent_item_id uuid REFERENCES public.canvas_items(id) ON DELETE SET NULL,

    kind   text NOT NULL CHECK (kind IN ('concept', 'note', 'figure')),
    source text NOT NULL CHECK (source IN ('ai', 'user')),

    title  text,
    -- 원문(마크업 포함). 파싱은 프론트가 한다 — 스트리밍 증분 파서가 이미
    -- 프론트에 있고, 파이썬으로 옮기면 두 벌이 되어 반드시 어긋난다.
    body   text NOT NULL DEFAULT '',
    tag    text,

    x      double precision NOT NULL DEFAULT 0,
    y      double precision NOT NULL DEFAULT 0,
    pinned boolean NOT NULL DEFAULT false,

    -- 같은 태그 열 안에서의 순서. 생성 순서를 보존한다.
    seq    integer NOT NULL DEFAULT 0,
    -- figure 메타 · askHidden · reflowDismissed 등 렌더 부가 정보
    data   jsonb NOT NULL DEFAULT '{}'::jsonb,

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.canvas_drawings (
    -- 세션당 1행. Excalidraw 요소는 개수가 많고 자주 바뀌어서 요소당 1행은
    -- 너무 잦다. 씬 전체를 담고 프론트가 디바운스 저장한다.
    session_id uuid PRIMARY KEY REFERENCES public.sessions(id) ON DELETE CASCADE,
    elements   jsonb NOT NULL DEFAULT '[]'::jsonb,
    files      jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_canvas_items_session
    ON public.canvas_items (session_id, seq, created_at);
CREATE INDEX IF NOT EXISTS idx_canvas_items_parent
    ON public.canvas_items (parent_item_id);
CREATE INDEX IF NOT EXISTS idx_canvas_items_node
    ON public.canvas_items (node_id);

-- ---------------------------------------------------------------------------
-- RLS — nodes 정책과 같은 형태다. 권한은 DB가 강제한다(CLAUDE.md 불변식).
-- 읽기는 can_access_session(학급 자료 접근 포함), 쓰기는 세션 소유자만.
-- ---------------------------------------------------------------------------
ALTER TABLE public.canvas_items    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.canvas_drawings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS canvas_items_select        ON public.canvas_items;
DROP POLICY IF EXISTS canvas_items_select_admin  ON public.canvas_items;
DROP POLICY IF EXISTS canvas_items_insert_owner  ON public.canvas_items;
DROP POLICY IF EXISTS canvas_items_update_owner  ON public.canvas_items;
DROP POLICY IF EXISTS canvas_items_delete_owner  ON public.canvas_items;

CREATE POLICY canvas_items_select ON public.canvas_items
    FOR SELECT USING (public.can_access_session(session_id));

-- D113과 같은 이유로 별도 정책: can_access_session()을 고치지 않고 관리자
-- 전역 읽기를 더한다.
CREATE POLICY canvas_items_select_admin ON public.canvas_items
    FOR SELECT USING (public.is_admin());

CREATE POLICY canvas_items_insert_owner ON public.canvas_items
    FOR INSERT WITH CHECK (EXISTS (
        SELECT 1 FROM public.sessions s
        WHERE s.id = canvas_items.session_id AND s.owner_id = auth.uid()));

CREATE POLICY canvas_items_update_owner ON public.canvas_items
    FOR UPDATE USING (EXISTS (
        SELECT 1 FROM public.sessions s
        WHERE s.id = canvas_items.session_id AND s.owner_id = auth.uid()));

CREATE POLICY canvas_items_delete_owner ON public.canvas_items
    FOR DELETE USING (EXISTS (
        SELECT 1 FROM public.sessions s
        WHERE s.id = canvas_items.session_id AND s.owner_id = auth.uid()));

DROP POLICY IF EXISTS canvas_drawings_select       ON public.canvas_drawings;
DROP POLICY IF EXISTS canvas_drawings_select_admin ON public.canvas_drawings;
DROP POLICY IF EXISTS canvas_drawings_write_owner  ON public.canvas_drawings;

CREATE POLICY canvas_drawings_select ON public.canvas_drawings
    FOR SELECT USING (public.can_access_session(session_id));

CREATE POLICY canvas_drawings_select_admin ON public.canvas_drawings
    FOR SELECT USING (public.is_admin());

-- 그림은 부분 수정이 없다(씬 전체 교체) — insert/update/delete를 한 정책으로.
CREATE POLICY canvas_drawings_write_owner ON public.canvas_drawings
    FOR ALL USING (EXISTS (
        SELECT 1 FROM public.sessions s
        WHERE s.id = canvas_drawings.session_id AND s.owner_id = auth.uid()))
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.sessions s
        WHERE s.id = canvas_drawings.session_id AND s.owner_id = auth.uid()));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.canvas_items    TO nodi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.canvas_drawings TO nodi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.canvas_items    TO nodi_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.canvas_drawings TO nodi_worker;

-- updated_at 자동 갱신. 프론트가 매번 실어 보내게 하면 빠뜨린다.
CREATE OR REPLACE FUNCTION public.touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_canvas_items_touch ON public.canvas_items;
CREATE TRIGGER trg_canvas_items_touch BEFORE UPDATE ON public.canvas_items
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_canvas_drawings_touch ON public.canvas_drawings;
CREATE TRIGGER trg_canvas_drawings_touch BEFORE UPDATE ON public.canvas_drawings
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

COMMIT;
