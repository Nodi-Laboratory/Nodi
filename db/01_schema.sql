-- 01_schema — 스키마 · RLS 정책 · 함수 (D104)
--
-- 생성 방법: Supabase 로컬 스택(마이그레이션 0001~0042 적용 상태)에서
--   pg_dump --schema-only --schema=public --no-owner --no-privileges
-- 로 덤프한 뒤 Supabase 전용 구문만 제거했다. **본문은 손으로 옮겨 적지
-- 않았다** — 검증된 스키마가 그대로 보존된다.
--
-- 마이그레이션 0001~0042를 이 한 파일로 스쿼시했다. 그 42개는 생성 후 삭제된
-- 것(art_assets·tags·ai_sessions·pgvector 등)이 절반이라 이력으로서의 가치보다
-- 죽은 코드로서의 비용이 컸다. 현재 상태만 남긴다.
--
-- 변경점은 단 하나: profiles.id의 외래키가 auth.users → public.users.
-- RLS 정책 32개와 함수 19개는 auth.uid()가 살아 있으므로 무수정이다(00_bootstrap).

-- pg_dump는 함수를 테이블보다 먼저 생성한다. 본문이 아직 없는 테이블을
-- 참조하므로 생성 시점 검증을 끈다(pg_dump가 원래 넣는 설정).
SET check_function_bodies = false;


CREATE TABLE public.profiles (
    id uuid NOT NULL,
    email text,
    role text DEFAULT 'student'::text NOT NULL,
    display_name text,
    avatar_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    onboarded boolean DEFAULT false NOT NULL,
    CONSTRAINT profiles_role_check CHECK ((role = ANY (ARRAY['student'::text, 'teacher'::text, 'admin'::text])))
);

CREATE FUNCTION public.admin_set_user_role(p_user_id uuid, p_role text) RETURNS public.profiles
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
    v_row public.profiles;
begin
    if not public.is_admin() then
        raise exception 'admin only' using errcode = 'insufficient_privilege';
    end if;
    if p_role not in ('student', 'teacher', 'admin') then
        raise exception 'invalid role' using errcode = 'check_violation';
    end if;
    -- Prevent an admin from demoting themselves (avoid lockout).
    if p_user_id = auth.uid() and p_role <> 'admin' then
        raise exception 'cannot change your own admin role'
            using errcode = 'check_violation';
    end if;

    update public.profiles
       set role = p_role, updated_at = now()
     where id = p_user_id
     returning * into v_row;
    if not found then
        raise exception 'user not found' using errcode = 'no_data_found';
    end if;
    return v_row;
end;
$$;

CREATE TABLE public.nodes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    parent_id uuid,
    question text,
    answer text,
    label text,
    attachments jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    rag_sources jsonb DEFAULT '[]'::jsonb NOT NULL
);

CREATE FUNCTION public.append_chat_node(p_session_id uuid, p_parent_id uuid, p_question text, p_answer text, p_label text DEFAULT NULL::text) RETURNS public.nodes
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
    v_owner    uuid;
    v_has_root uuid;
    v_node     public.nodes;
begin
    -- Ownership check (lock the session row for the duration of the tx).
    select owner_id, root_node_id
      into v_owner, v_has_root
      from public.sessions
     where id = p_session_id
     for update;

    if v_owner is null then
        raise exception 'session not found' using errcode = 'no_data_found';
    end if;
    if v_owner <> auth.uid() then
        raise exception 'not session owner' using errcode = 'insufficient_privilege';
    end if;

    -- If a parent is given, it must belong to the same session.
    if p_parent_id is not null then
        if not exists (
            select 1 from public.nodes n
            where n.id = p_parent_id and n.session_id = p_session_id
        ) then
            raise exception 'parent node not in session'
                using errcode = 'foreign_key_violation';
        end if;
    end if;

    insert into public.nodes (session_id, parent_id, question, answer, label)
    values (p_session_id, p_parent_id, p_question, p_answer, p_label)
    returning * into v_node;

    update public.sessions
       set current_head_id = v_node.id,
           root_node_id     = coalesce(root_node_id, v_node.id),
           updated_at       = now()
     where id = p_session_id;

    return v_node;
end;
$$;

CREATE FUNCTION public.can_access_session(p_session_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    select exists (
        select 1
        from public.sessions s
        where s.id = p_session_id
          and (
                s.owner_id = auth.uid()
             or (s.space_kind = 'class' and public.is_class_teacher(s.space_ref))
          )
    );
$$;

CREATE FUNCTION public.class_students(p_class_id uuid) RETURNS TABLE(user_id uuid, email text, display_name text, avatar_url text, role_in_class text, joined_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    select cm.user_id,
           p.email,
           p.display_name,
           p.avatar_url,
           cm.role_in_class,
           cm.created_at
      from public.class_members cm
      join public.profiles p on p.id = cm.user_id
     where cm.class_id = p_class_id
       and cm.role_in_class = 'student'
       and public.is_class_teacher(p_class_id)
     order by p.display_name nulls last, cm.created_at;
$$;

CREATE TABLE public.classes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    join_code text NOT NULL,
    teacher_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    -- 학급 프로필 사진의 Storage 경로 (사용자 지시 2026-08-09).
    -- 서명 URL은 저장하지 않는다 — 만료되면 깨진 주소가 남는다(D87).
    avatar_path text
);

CREATE FUNCTION public.create_class(p_name text) RETURNS public.classes
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
    v_uid   uuid := auth.uid();
    v_role  text;
    v_name  text := nullif(btrim(p_name), '');
    v_code  text;
    v_row   public.classes;
    v_tries int := 0;
begin
    if v_uid is null then
        raise exception 'not_authenticated' using errcode = '28000';
    end if;
    -- App-role gate: only a 'teacher' may create classes.
    select role into v_role from public.profiles where id = v_uid;
    if v_role <> 'teacher' then
        raise exception 'teacher role required' using errcode = 'insufficient_privilege';
    end if;
    if v_name is null then
        raise exception 'class name required' using errcode = 'check_violation';
    end if;

    -- Insert with a unique join_code (retry a few times on the rare collision).
    loop
        v_tries := v_tries + 1;
        v_code := public.nodi_gen_join_code();
        begin
            insert into public.classes (name, join_code, teacher_id)
            values (v_name, v_code, v_uid)
            returning * into v_row;
            exit;  -- success
        exception when unique_violation then
            if v_tries >= 8 then
                raise exception 'could not allocate a unique join code'
                    using errcode = 'unique_violation';
            end if;
        end;
    end loop;

    -- Enroll the creating teacher as a class member (role_in_class = 'teacher').
    insert into public.class_members (class_id, user_id, role_in_class)
    values (v_row.id, v_uid, 'teacher')
    on conflict (class_id, user_id) do nothing;

    return v_row;
end;
$$;

CREATE FUNCTION public.delete_file_cascade(p_file_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
    v_owner uuid;
begin
    select owner_id into v_owner from public.files where id = p_file_id;
    if v_owner is null then
        raise exception 'file not found' using errcode = 'no_data_found';
    end if;
    -- D114: 운영 콘솔의 문서 초기화가 이 함수를 재사용한다. 별도 삭제 경로를
    -- 만들면 그쪽만 Qdrant 오펀 벡터를 남긴다.
    if v_owner <> auth.uid() and not public.is_admin() then
        raise exception 'not file owner' using errcode = 'insufficient_privilege';
    end if;

    -- 파일 삭제 → file_chunks / file_node_links 를 FK cascade 로 제거.
    delete from public.files where id = p_file_id;
end;
$$;

CREATE FUNCTION public.get_chunk_context(p_chunk_id uuid, p_neighbors integer DEFAULT 1) RETURNS TABLE(file_id uuid, name text, seq integer, chunk_text text, prev_text text, next_text text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    with target as (
        select fc.id, fc.file_id, fc.seq, fc.chunk_text
          from public.file_chunks fc
          join public.files f on f.id = fc.file_id
         where fc.id = p_chunk_id
           and (
                f.owner_id = auth.uid()
             or (f.kind in ('class_material', 'textbook')
                 and public.is_class_member(f.space_ref))
           )
    )
    select t.file_id,
           split_part(
               f.storage_path, '/',
               array_length(string_to_array(f.storage_path, '/'), 1)
           ) as name,
           t.seq,
           t.chunk_text,
           (select c.chunk_text from public.file_chunks c
              where c.file_id = t.file_id and c.seq = t.seq - p_neighbors) as prev_text,
           (select c.chunk_text from public.file_chunks c
              where c.file_id = t.file_id and c.seq = t.seq + p_neighbors) as next_text
      from target t
      join public.files f on f.id = t.file_id;
$$;

CREATE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
    requested text := new.raw_user_meta_data ->> 'role';
begin
    insert into public.profiles (id, email, display_name, avatar_url, role)
    values (
        new.id,
        new.email,
        coalesce(
            new.raw_user_meta_data ->> 'full_name',
            new.raw_user_meta_data ->> 'name',
            split_part(new.email, '@', 1)
        ),
        new.raw_user_meta_data ->> 'avatar_url',
        -- 화이트리스트: 자체 가입으로 얻을 수 있는 역할은 이 둘뿐이다.
        case when requested in ('student', 'teacher') then requested
             else 'student' end
    )
    on conflict (id) do nothing;
    return new;
end;
$$;

CREATE FUNCTION public.is_admin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    select exists (
        select 1 from public.profiles
        where id = auth.uid() and role = 'admin'
    );
$$;

CREATE FUNCTION public.is_class_member(p_class_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    select exists (
        select 1
        from public.class_members cm
        where cm.class_id = p_class_id
          and cm.user_id  = auth.uid()
    );
$$;

CREATE FUNCTION public.is_class_teacher(p_class_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    select exists (
        select 1 from public.class_members cm
        where cm.class_id = p_class_id
          and cm.user_id  = auth.uid()
          and cm.role_in_class = 'teacher'
    )
    or exists (
        select 1 from public.classes c
        where c.id = p_class_id
          and c.teacher_id = auth.uid()
    );
$$;

CREATE TABLE public.class_members (
    class_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role_in_class text DEFAULT 'student'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT class_members_role_in_class_check CHECK ((role_in_class = ANY (ARRAY['student'::text, 'teacher'::text])))
);

-- D144: 정책이 **행마다** 부르지 않도록, 같은 판정을 집합으로 돌려주는 형태.
-- 정책에서 `x IN (SELECT ...)`로 쓰면 우변이 상관되지 않아 플래너가 한 번만
-- 실행하고 해시로 만든다. 조건은 위 is_* 함수들의 본문과 **글자 그대로 같다**
-- (실측: 캔버스 읽기 42.7ms → 2.2ms, 대량 수정 382ms → 38.6ms).

CREATE FUNCTION public.accessible_session_ids() RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
    AS $$
    SELECT s.id
    FROM public.sessions s
    WHERE s.owner_id = auth.uid()
       OR (s.space_kind = 'class' AND public.is_class_teacher(s.space_ref));
$$;

CREATE FUNCTION public.my_class_ids() RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
    AS $$
    SELECT cm.class_id FROM public.class_members cm WHERE cm.user_id = auth.uid();
$$;

CREATE FUNCTION public.my_taught_class_ids() RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
    AS $$
    SELECT cm.class_id
    FROM public.class_members cm
    WHERE cm.user_id = auth.uid() AND cm.role_in_class = 'teacher'
    UNION
    SELECT c.id FROM public.classes c WHERE c.teacher_id = auth.uid();
$$;

CREATE FUNCTION public.join_class_by_code(p_code text) RETURNS public.class_members
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
    v_class_id uuid;
    v_row      public.class_members;
begin
    if auth.uid() is null then
        raise exception 'not_authenticated' using errcode = '28000';
    end if;

    select id into v_class_id
    from public.classes
    where join_code = p_code;

    if v_class_id is null then
        raise exception 'invalid_join_code' using errcode = 'P0002';
    end if;

    insert into public.class_members (class_id, user_id, role_in_class)
    values (v_class_id, auth.uid(), 'student')
    on conflict (class_id, user_id) do nothing;

    select * into v_row
    from public.class_members
    where class_id = v_class_id and user_id = auth.uid();

    return v_row;
end;
$$;

CREATE FUNCTION public.mark_onboarded() RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
    update public.profiles
       set onboarded = true, updated_at = now()
     where id = auth.uid();
    return found;
end;
$$;

CREATE FUNCTION public.nodi_gen_join_code() RETURNS text
    LANGUAGE sql
    SET search_path TO 'public'
    AS $$
    select string_agg(
        substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789',
               1 + floor(random() * 31)::int, 1),
        ''
    )
    from generate_series(1, 6);
$$;

-- 학급 사진 경로 적기 (2026-08-10).
--
-- `classes`의 UPDATE 정책은 **만든 사람만**인데, 나머지 전부는 "이 학급의
-- 선생님"을 `is_class_teacher()`(만든 사람 또는 교사 구성원)로 판정한다.
-- 정책을 통째로 넓히면 부담임이 학급 이름·참여 코드까지 바꾸게 되므로,
-- **사진 경로 하나만** 여는 함수를 둔다. 돌려주는 값은 "바꿨나"다 —
-- 조용한 0행 갱신을 성공으로 보고하지 않기 위해서다.
CREATE OR REPLACE FUNCTION public.set_class_avatar(p_class_id uuid, p_path text)
    RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_updated int;
BEGIN
    IF NOT public.is_class_teacher(p_class_id) THEN
        RETURN false;
    END IF;
    UPDATE public.classes SET avatar_path = p_path WHERE id = p_class_id;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    RETURN v_updated > 0;
END;
$$;

CREATE FUNCTION public.teacher_class_overview() RETURNS TABLE(id uuid, name text, join_code text, created_at timestamp with time zone, student_count bigint, material_count bigint, last_activity_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    select c.id,
           c.name,
           c.join_code,
           c.created_at,
           (
               select count(*)
                 from public.class_members m
                where m.class_id = c.id
                  and m.role_in_class = 'student'
           )::bigint as student_count,
           (
               select count(*)
                 from public.files f
                where f.kind = 'class_material'
                  and f.space_kind = 'class'
                  and f.space_ref = c.id
           )::bigint as material_count,
           greatest(
               (
                   select max(s.updated_at)
                     from public.sessions s
                    where s.space_kind = 'class'
                      and s.space_ref = c.id
               ),
               (
                   select max(f.created_at)
                     from public.files f
                    where f.kind = 'class_material'
                      and f.space_kind = 'class'
                      and f.space_ref = c.id
               )
           ) as last_activity_at
      from public.classes c
     where public.is_class_teacher(c.id)
     order by last_activity_at desc nulls last, c.created_at desc;
$$;

CREATE TABLE public.ai_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_id uuid NOT NULL,
    session_id uuid,
    node_id uuid,
    kind text DEFAULT 'chat'::text NOT NULL,
    system_prompt text,
    question text,
    answer text,
    contexts jsonb DEFAULT '{}'::jsonb NOT NULL,
    skill_calls jsonb DEFAULT '[]'::jsonb NOT NULL,
    errors jsonb DEFAULT '[]'::jsonb NOT NULL,
    token_estimate integer,
    -- D113 관측성. token_estimate는 글자수/4 어림이라 과금·한도 판단에 쓸 수
    -- 없었다. tokens는 **공급자가 준 실측 usage**다:
    --   {"prompt":n,"completion":n,"total":n,
    --    "calls":[{"stage":"decide|answer","model":..,"prompt":n,"completion":n,
    --              "estimated":bool}]}
    -- estimated=true는 스트리밍 응답이 usage를 안 줘서 어림한 경우 —
    -- 실측과 어림을 섞어 놓고 실측인 척하지 않는다.
    tokens jsonb DEFAULT '{}'::jsonb NOT NULL,
    -- 'react' | 'legacy'. 어느 경로로 돈 턴인지 로그만 보고 알 수 있어야 한다.
    route text,
    model text,
    duration_ms integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.ai_logs REPLICA IDENTITY FULL;

CREATE TABLE public.app_settings (
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

CREATE TABLE public.file_chunks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    file_id uuid NOT NULL,
    seq integer NOT NULL,
    chunk_text text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT file_chunks_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'embedded'::text, 'failed'::text, 'stored'::text])))
);

-- 원자 질문 테이블(TASK 6, D129) — 청크당 solar 생성 예상 질문. 벡터는 Qdrant
-- chunk_atoms, 본문·상태는 여기. file_chunks/files delete의 FK CASCADE로 제거된다.
CREATE TABLE public.chunk_atoms (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    chunk_id uuid NOT NULL,
    file_id uuid NOT NULL,
    chunk_seq integer NOT NULL,
    question text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chunk_atoms_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'embedded'::text, 'failed'::text])))
);

CREATE TABLE public.files (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_id uuid NOT NULL,
    space_kind text DEFAULT 'personal'::text NOT NULL,
    space_ref uuid,
    kind text DEFAULT 'user_upload'::text NOT NULL,
    storage_path text NOT NULL,
    mime text,
    size_bytes bigint,
    status text DEFAULT 'uploaded'::text NOT NULL,
    chunk_total integer DEFAULT 0 NOT NULL,
    chunk_done integer DEFAULT 0 NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    name text,
    session_id uuid,
    context_chars integer,
    CONSTRAINT files_kind_check CHECK ((kind = ANY (ARRAY['user_upload'::text, 'class_material'::text, 'textbook'::text]))),
    CONSTRAINT files_space_kind_check CHECK ((space_kind = ANY (ARRAY['personal'::text, 'class'::text]))),
    CONSTRAINT files_status_check CHECK ((status = ANY (ARRAY['uploaded'::text, 'splitting'::text, 'embedding'::text, 'indexed'::text, 'partial'::text, 'failed'::text])))
);

CREATE TABLE public.jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_id uuid,
    kind text NOT NULL,
    target_id uuid,
    parent_job_id uuid,
    batch_range jsonb,
    status text DEFAULT 'queued'::text NOT NULL,
    error text,
    progress integer DEFAULT 0 NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    space_ref uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT jobs_kind_check CHECK ((kind = ANY (ARRAY['embedding_split'::text, 'embedding_batch'::text, 'figure_batch'::text, 'atom_batch'::text, 'lecture_parse'::text, 'lecture_embed'::text, 'lecture_atom'::text, 'crosslink'::text]))),
    CONSTRAINT jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'done'::text, 'failed'::text])))
);

CREATE TABLE public.sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_id uuid NOT NULL,
    space_kind text DEFAULT 'personal'::text NOT NULL,
    space_ref uuid,
    title text,
    emoji text,
    root_node_id uuid,
    current_head_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sessions_space_kind_check CHECK ((space_kind = ANY (ARRAY['personal'::text, 'class'::text])))
);

CREATE TABLE public.textbook_figures (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    file_id uuid NOT NULL,
    seq integer NOT NULL,
    page integer,
    element_id integer,
    bbox jsonb,
    caption text DEFAULT ''::text NOT NULL,
    alt text DEFAULT ''::text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    figure_type text DEFAULT ''::text NOT NULL,
    heading text DEFAULT ''::text NOT NULL,
    candidates jsonb DEFAULT '[]'::jsonb NOT NULL,
    selected_index integer,
    judge_reason text,
    match_kind text DEFAULT ''::text NOT NULL,
    embed_text text DEFAULT ''::text NOT NULL,
    image_path text NOT NULL,
    -- D131: 비전 캡션 생성 프롬프트에 넣는 페이지 본문 컨텍스트(figure 제외 요소 이어붙임).
    page_text text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT textbook_figures_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'embedded'::text, 'failed'::text])))
);

ALTER TABLE ONLY public.ai_logs
    ADD CONSTRAINT ai_logs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT app_settings_pkey PRIMARY KEY (key);

ALTER TABLE ONLY public.class_members
    ADD CONSTRAINT class_members_pkey PRIMARY KEY (class_id, user_id);

ALTER TABLE ONLY public.classes
    ADD CONSTRAINT classes_join_code_key UNIQUE (join_code);

ALTER TABLE ONLY public.classes
    ADD CONSTRAINT classes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.file_chunks
    ADD CONSTRAINT file_chunks_file_id_seq_key UNIQUE (file_id, seq);

ALTER TABLE ONLY public.file_chunks
    ADD CONSTRAINT file_chunks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.chunk_atoms
    ADD CONSTRAINT chunk_atoms_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.nodes
    ADD CONSTRAINT nodes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.textbook_figures
    ADD CONSTRAINT textbook_figures_file_id_seq_key UNIQUE (file_id, seq);

ALTER TABLE ONLY public.textbook_figures
    ADD CONSTRAINT textbook_figures_pkey PRIMARY KEY (id);

CREATE INDEX idx_ai_logs_created ON public.ai_logs USING btree (created_at DESC);

CREATE INDEX idx_ai_logs_node ON public.ai_logs USING btree (node_id);

CREATE INDEX idx_ai_logs_owner_created ON public.ai_logs USING btree (owner_id, created_at DESC);

CREATE INDEX idx_ai_logs_session_created ON public.ai_logs USING btree (session_id, created_at DESC);

CREATE INDEX idx_class_members_user_id ON public.class_members USING btree (user_id);

CREATE INDEX idx_classes_teacher ON public.classes USING btree (teacher_id);

CREATE INDEX idx_file_chunks_status ON public.file_chunks USING btree (status);

CREATE INDEX idx_chunk_atoms_file ON public.chunk_atoms USING btree (file_id, status);

CREATE INDEX idx_chunk_atoms_chunk ON public.chunk_atoms USING btree (chunk_id);

CREATE INDEX idx_files_owner ON public.files USING btree (owner_id);

CREATE INDEX idx_files_session ON public.files USING btree (session_id) WHERE (session_id IS NOT NULL);

CREATE INDEX idx_files_space_created ON public.files USING btree (space_kind, space_ref, created_at DESC);

CREATE INDEX idx_jobs_owner ON public.jobs USING btree (owner_id);

-- D105: parent_job_id는 ON DELETE CASCADE인데 인덱스가 없었다. 부모 잡을 지울
-- 때마다 RI 트리거가 자식을 찾느라 jobs를 통째로 훑는다.
-- 실측(부모 200 + 자식 6,000행, 부모 50개 삭제): 트리거 279ms → 13.7ms (20배).
-- split 잡은 parent가 NULL이므로 부분 인덱스로 크기를 줄인다.
CREATE INDEX idx_jobs_parent ON public.jobs USING btree (parent_job_id) WHERE (parent_job_id IS NOT NULL);
CREATE INDEX idx_jobs_status ON public.jobs USING btree (status, created_at);

CREATE INDEX idx_jobs_target ON public.jobs USING btree (target_id);

CREATE INDEX idx_nodes_parent_id ON public.nodes USING btree (parent_id);

CREATE INDEX idx_nodes_session_created ON public.nodes USING btree (session_id, created_at);

CREATE INDEX idx_sessions_current_head ON public.sessions USING btree (current_head_id);

CREATE INDEX idx_sessions_owner_updated ON public.sessions USING btree (owner_id, updated_at DESC);

CREATE INDEX idx_sessions_root_node ON public.sessions USING btree (root_node_id);

CREATE INDEX idx_sessions_space_updated ON public.sessions USING btree (space_kind, space_ref, updated_at DESC);

ALTER TABLE ONLY public.ai_logs
    ADD CONSTRAINT ai_logs_node_id_fkey FOREIGN KEY (node_id) REFERENCES public.nodes(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.ai_logs
    ADD CONSTRAINT ai_logs_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.ai_logs
    ADD CONSTRAINT ai_logs_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT app_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.class_members
    ADD CONSTRAINT class_members_class_id_fkey FOREIGN KEY (class_id) REFERENCES public.classes(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.class_members
    ADD CONSTRAINT class_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.classes
    ADD CONSTRAINT classes_teacher_id_fkey FOREIGN KEY (teacher_id) REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.file_chunks
    ADD CONSTRAINT file_chunks_file_id_fkey FOREIGN KEY (file_id) REFERENCES public.files(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.chunk_atoms
    ADD CONSTRAINT chunk_atoms_chunk_id_fkey FOREIGN KEY (chunk_id) REFERENCES public.file_chunks(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.chunk_atoms
    ADD CONSTRAINT chunk_atoms_file_id_fkey FOREIGN KEY (file_id) REFERENCES public.files(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_parent_job_id_fkey FOREIGN KEY (parent_job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.nodes
    ADD CONSTRAINT nodes_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.nodes(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.nodes
    ADD CONSTRAINT nodes_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_current_head_id_fkey FOREIGN KEY (current_head_id) REFERENCES public.nodes(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_root_node_id_fkey FOREIGN KEY (root_node_id) REFERENCES public.nodes(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.textbook_figures
    ADD CONSTRAINT textbook_figures_file_id_fkey FOREIGN KEY (file_id) REFERENCES public.files(id) ON DELETE CASCADE;

ALTER TABLE public.ai_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY ai_logs_insert_own ON public.ai_logs FOR INSERT WITH CHECK ((owner_id = ( SELECT auth.uid() AS uid)));

CREATE POLICY ai_logs_select_admin ON public.ai_logs FOR SELECT USING ((SELECT public.is_admin()));

CREATE POLICY ai_logs_select_own ON public.ai_logs FOR SELECT USING ((owner_id = ( SELECT auth.uid() AS uid)));

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY app_settings_admin_insert ON public.app_settings FOR INSERT WITH CHECK ((SELECT public.is_admin()));

CREATE POLICY app_settings_admin_select ON public.app_settings FOR SELECT USING ((SELECT public.is_admin()));

CREATE POLICY app_settings_admin_update ON public.app_settings FOR UPDATE USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

ALTER TABLE public.class_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY class_members_delete_self ON public.class_members FOR DELETE USING ((user_id = ( SELECT auth.uid() AS uid)));

CREATE POLICY class_members_select ON public.class_members FOR SELECT USING (((user_id = ( SELECT auth.uid() AS uid)) OR class_id IN (SELECT public.my_class_ids())));

-- D113: 관리자 전역 읽기 — "이 대화가 어느 학급의 누구인가"를 콘솔이 잇는다.
CREATE POLICY class_members_select_admin ON public.class_members FOR SELECT USING ((SELECT public.is_admin()));

ALTER TABLE public.classes ENABLE ROW LEVEL SECURITY;

CREATE POLICY classes_insert_teacher ON public.classes FOR INSERT WITH CHECK (((teacher_id = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = 'teacher'::text))))));

CREATE POLICY classes_select_member ON public.classes FOR SELECT USING (((teacher_id = ( SELECT auth.uid() AS uid)) OR id IN (SELECT public.my_class_ids())));

-- D113: 관리자 전역 읽기. 없으면 관리자에게 학급 목록이 **통째로 비어**
-- (실측 0건) RAG 테스트의 검색 범위를 고를 수조차 없다.
CREATE POLICY classes_select_admin ON public.classes FOR SELECT USING ((SELECT public.is_admin()));

CREATE POLICY classes_update_teacher ON public.classes FOR UPDATE USING ((teacher_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((teacher_id = ( SELECT auth.uid() AS uid)));

ALTER TABLE public.file_chunks ENABLE ROW LEVEL SECURITY;

CREATE POLICY file_chunks_select_class ON public.file_chunks FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.files f
  WHERE ((f.id = file_chunks.file_id) AND (f.kind = ANY (ARRAY['class_material'::text, 'textbook'::text])) AND f.space_ref IN (SELECT public.my_class_ids())))));

CREATE POLICY file_chunks_select_own ON public.file_chunks FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.files f
  WHERE ((f.id = file_chunks.file_id) AND (f.owner_id = ( SELECT auth.uid() AS uid))))));

-- D113: 관리자 전역 읽기. 운영 콘솔이 "문서가 어떻게 올라갔는지"(청크 경계·
-- 임베딩 상태)와 RAG 테스트 결과를 보여주려면 소유자·학급과 무관하게 읽어야
-- 한다. **읽기 전용**이며 sessions_select_admin·ai_logs_select_admin과 같은
-- 형태다 — 권한은 계속 DB가 강제한다(D104).
CREATE POLICY file_chunks_select_admin ON public.file_chunks FOR SELECT USING ((SELECT public.is_admin()));

-- D129: chunk_atoms SELECT는 file_chunks 정책과 동형 — 부모 파일 접근 가능 시 열람
-- (매칭된 원자 질문 관측용). 쓰기는 워커(BYPASSRLS) 전용 — nodi_app은 RLS write
-- 정책 부재로 차단된다(file_chunks와 동일 기전. 00_bootstrap의 default privileges가
-- 풀 DML을 부여하므로 GRANT 자체는 있지만, write 정책이 없어 INSERT/UPDATE/DELETE는 막힌다).
ALTER TABLE public.chunk_atoms ENABLE ROW LEVEL SECURITY;

CREATE POLICY chunk_atoms_select_class ON public.chunk_atoms FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.files f
  WHERE ((f.id = chunk_atoms.file_id) AND (f.kind = ANY (ARRAY['class_material'::text, 'textbook'::text])) AND f.space_ref IN (SELECT public.my_class_ids())))));

CREATE POLICY chunk_atoms_select_own ON public.chunk_atoms FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.files f
  WHERE ((f.id = chunk_atoms.file_id) AND (f.owner_id = ( SELECT auth.uid() AS uid))))));

CREATE POLICY chunk_atoms_select_admin ON public.chunk_atoms FOR SELECT USING ((SELECT public.is_admin()));

ALTER TABLE public.files ENABLE ROW LEVEL SECURITY;

CREATE POLICY files_delete_own ON public.files FOR DELETE USING ((owner_id = ( SELECT auth.uid() AS uid)));

CREATE POLICY files_insert_own ON public.files FOR INSERT WITH CHECK (((owner_id = ( SELECT auth.uid() AS uid)) AND ((kind <> ALL (ARRAY['class_material'::text, 'textbook'::text])) OR space_ref IN (SELECT public.my_taught_class_ids()))));

CREATE POLICY files_select_class ON public.files FOR SELECT USING (((kind = ANY (ARRAY['class_material'::text, 'textbook'::text])) AND space_ref IN (SELECT public.my_class_ids())));

CREATE POLICY files_select_own ON public.files FOR SELECT USING ((owner_id = ( SELECT auth.uid() AS uid)));

-- D113: 관리자 전역 읽기(읽기 전용 — insert/update/delete 정책은 그대로).
CREATE POLICY files_select_admin ON public.files FOR SELECT USING ((SELECT public.is_admin()));

CREATE POLICY files_update_own ON public.files FOR UPDATE USING ((owner_id = ( SELECT auth.uid() AS uid))) WITH CHECK (((owner_id = ( SELECT auth.uid() AS uid)) AND ((kind <> ALL (ARRAY['class_material'::text, 'textbook'::text])) OR space_ref IN (SELECT public.my_taught_class_ids()))));

ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY jobs_select_own ON public.jobs FOR SELECT USING (((owner_id = ( SELECT auth.uid() AS uid)) OR (SELECT public.is_admin())));

ALTER TABLE public.nodes ENABLE ROW LEVEL SECURITY;

CREATE POLICY nodes_delete_owner ON public.nodes FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.sessions s
  WHERE ((s.id = nodes.session_id) AND (s.owner_id = ( SELECT auth.uid() AS uid))))));

CREATE POLICY nodes_insert_owner ON public.nodes FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.sessions s
  WHERE ((s.id = nodes.session_id) AND (s.owner_id = ( SELECT auth.uid() AS uid))))));

CREATE POLICY nodes_select ON public.nodes FOR SELECT USING (session_id IN (SELECT public.accessible_session_ids()));

-- D113: 관리자 전역 읽기. can_access_session()을 고치지 않고 별도 정책으로 둔다 —
-- 그 함수의 뜻은 "세션 소유자 또는 담임"이고, 거기에 admin을 섞으면 함수를 쓰는
-- 다른 곳까지 조용히 넓어진다. sessions_select_admin과 같은 패턴.
CREATE POLICY nodes_select_admin ON public.nodes FOR SELECT USING ((SELECT public.is_admin()));

CREATE POLICY nodes_update_owner ON public.nodes FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.sessions s
  WHERE ((s.id = nodes.session_id) AND (s.owner_id = ( SELECT auth.uid() AS uid))))));

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY profiles_select_admin ON public.profiles FOR SELECT USING ((SELECT public.is_admin()));

CREATE POLICY profiles_select_own ON public.profiles FOR SELECT USING ((id = ( SELECT auth.uid() AS uid)));

CREATE POLICY profiles_update_own ON public.profiles FOR UPDATE USING ((id = ( SELECT auth.uid() AS uid))) WITH CHECK ((id = ( SELECT auth.uid() AS uid)));

ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY sessions_delete_owner ON public.sessions FOR DELETE USING ((owner_id = ( SELECT auth.uid() AS uid)));

CREATE POLICY sessions_insert_owner ON public.sessions FOR INSERT WITH CHECK (((owner_id = ( SELECT auth.uid() AS uid)) AND ((space_kind = 'personal'::text) OR space_ref IN (SELECT public.my_class_ids()))));

CREATE POLICY sessions_select ON public.sessions FOR SELECT USING (((owner_id = ( SELECT auth.uid() AS uid)) OR ((space_kind = 'class'::text) AND space_ref IN (SELECT public.my_taught_class_ids()))));

CREATE POLICY sessions_select_admin ON public.sessions FOR SELECT USING ((SELECT public.is_admin()));

CREATE POLICY sessions_update_owner ON public.sessions FOR UPDATE USING ((owner_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((owner_id = ( SELECT auth.uid() AS uid)));

ALTER TABLE public.textbook_figures ENABLE ROW LEVEL SECURITY;

CREATE POLICY textbook_figures_select ON public.textbook_figures FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.files f
  WHERE ((f.id = textbook_figures.file_id) AND ((f.owner_id = ( SELECT auth.uid() AS uid)) OR ((f.kind = 'textbook'::text) AND f.space_ref IN (SELECT public.my_class_ids())))))));

-- D113: 관리자 전역 읽기(도판 인제스트 상태 확인용, 읽기 전용).
CREATE POLICY textbook_figures_select_admin ON public.textbook_figures FOR SELECT USING ((SELECT public.is_admin()));


-- ===========================================================================
-- D113 — 운영 콘솔 집계 RPC (2026-07-28)
--
-- 콘솔이 필요한 것은 집계와 조인이다(역할별 사용자 수, 파일별 청크 상태, 세션별
-- 토큰 합). db/query.py의 PostgREST 문법 번역기는 이를 표현하지 못하고, 앱에서
-- 행을 다 끌어와 파이썬으로 세면 수천 행이 오간다. 권한 검사는 함수 안
-- is_admin()이 하고 호출은 여전히 사용자 JWT로 나간다(D104 불변식 유지).
-- ===========================================================================
-- ── 1) 전체 개요 ──────────────────────────────────────────────────────
CREATE FUNCTION public.admin_overview() returns jsonb
    language plpgsql stable security definer
    set search_path to 'public'
    as $$
declare
    v jsonb;
begin
    if not public.is_admin() then
        raise exception 'admin only' using errcode = 'insufficient_privilege';
    end if;

    select jsonb_build_object(
        'users', jsonb_build_object(
            'total', (select count(*) from public.profiles),
            'by_role', coalesce((
                select jsonb_object_agg(role, n)
                  from (select role, count(*) n from public.profiles group by role) t
            ), '{}'::jsonb)
        ),
        'classes', (select count(*) from public.classes),
        'sessions', jsonb_build_object(
            'total', (select count(*) from public.sessions),
            'by_space', coalesce((
                select jsonb_object_agg(space_kind, n)
                  from (select space_kind, count(*) n from public.sessions group by space_kind) t
            ), '{}'::jsonb)
        ),
        'nodes', (select count(*) from public.nodes),
        'files', jsonb_build_object(
            'total', (select count(*) from public.files),
            'bytes', (select coalesce(sum(size_bytes), 0) from public.files),
            'by_status', coalesce((
                select jsonb_object_agg(status, n)
                  from (select status, count(*) n from public.files group by status) t
            ), '{}'::jsonb),
            'by_kind', coalesce((
                select jsonb_object_agg(kind, n)
                  from (select kind, count(*) n from public.files group by kind) t
            ), '{}'::jsonb)
        ),
        'chunks', jsonb_build_object(
            'total', (select count(*) from public.file_chunks),
            'by_status', coalesce((
                select jsonb_object_agg(status, n)
                  from (select status, count(*) n from public.file_chunks group by status) t
            ), '{}'::jsonb)
        ),
        'figures', jsonb_build_object(
            'total', (select count(*) from public.textbook_figures),
            'by_status', coalesce((
                select jsonb_object_agg(status, n)
                  from (select status, count(*) n from public.textbook_figures group by status) t
            ), '{}'::jsonb)
        ),
        'jobs', jsonb_build_object(
            'by_status', coalesce((
                select jsonb_object_agg(status, n)
                  from (select status, count(*) n from public.jobs group by status) t
            ), '{}'::jsonb)
        ),
        'turns', jsonb_build_object(
            'total', (select count(*) from public.ai_logs),
            'last_7d', (select count(*) from public.ai_logs
                         where created_at >= now() - interval '7 days'),
            'with_errors', (select count(*) from public.ai_logs
                             where jsonb_array_length(errors) > 0),
            'by_route', coalesce((
                select jsonb_object_agg(coalesce(route, 'unknown'), n)
                  from (select route, count(*) n from public.ai_logs group by route) t
            ), '{}'::jsonb)
        ),
        -- 실측 토큰과 어림(token_estimate)을 **나란히** 돌려준다. 하나로 합치면
        -- 콘솔이 어림을 실측으로 표시하게 된다(실측 2026-07-28: 어림이 실측의
        -- 1/4.5였다 — 한국어에서 글자수/4 상수가 안 맞는다).
        'tokens', (
            select jsonb_build_object(
                'measured_turns', count(*) filter (where tokens ? 'total'),
                'prompt',     coalesce(sum((tokens->>'prompt')::bigint), 0),
                'completion', coalesce(sum((tokens->>'completion')::bigint), 0),
                'total',      coalesce(sum((tokens->>'total')::bigint), 0),
                'cached',     coalesce(sum((tokens->>'cached')::bigint), 0),
                'estimate_total', coalesce(sum(token_estimate), 0)
            ) from public.ai_logs
        ),
        'latency', (
            select jsonb_build_object(
                'p50', coalesce(percentile_disc(0.5) within group (order by duration_ms), 0),
                'p95', coalesce(percentile_disc(0.95) within group (order by duration_ms), 0)
            ) from public.ai_logs where duration_ms is not null
        )
    ) into v;

    return v;
end;
$$;

-- ── 2) 대화(세션) 목록 ────────────────────────────────────────────────
-- Plant-Counselor의 로그 화면은 대화를 파일 단위로 흩어 놓아 읽기 어려웠다.
-- 여기서는 **세션이 단위**다 — 누가·어디서·몇 턴·토큰 얼마를 한 줄로 본다.
CREATE FUNCTION public.admin_conversations(
    p_owner  uuid default null,
    p_space  text default null,
    p_search text default null,
    p_limit  int  default 30,
    p_offset int  default 0
) returns table (
    session_id    uuid,
    title         text,
    space_kind    text,
    space_ref     uuid,
    class_name    text,
    owner_id      uuid,
    owner_email   text,
    owner_role    text,
    node_count    bigint,
    turn_count    bigint,
    token_total   bigint,
    error_turns   bigint,
    created_at    timestamptz,
    updated_at    timestamptz,
    last_activity timestamptz,
    total_count   bigint
)
    language plpgsql stable security definer
    set search_path to 'public'
    as $$
begin
    if not public.is_admin() then
        raise exception 'admin only' using errcode = 'insufficient_privilege';
    end if;

    return query
    with filtered as (
        select s.*
          from public.sessions s
          join public.profiles p on p.id = s.owner_id
         where (p_owner is null or s.owner_id = p_owner)
           and (p_space is null or s.space_kind = p_space)
           and (
                p_search is null
             or s.title ilike '%' || p_search || '%'
             or p.email ilike '%' || p_search || '%'
             or exists (
                    select 1 from public.nodes n
                     where n.session_id = s.id
                       and (n.question ilike '%' || p_search || '%'
                         or n.answer   ilike '%' || p_search || '%')
                )
           )
    ),
    total as (select count(*) c from filtered)
    select
        f.id,
        f.title,
        f.space_kind,
        f.space_ref,
        c.name,
        f.owner_id,
        p.email,
        p.role,
        (select count(*) from public.nodes n where n.session_id = f.id),
        (select count(*) from public.ai_logs l where l.session_id = f.id),
        -- sum()은 numeric을 돌려주므로 **밖에서** bigint로 맞춘다. 안쪽만
        -- 캐스팅하면 반환 타입과 어긋나 함수 자체가 실패한다.
        (select coalesce(sum((l.tokens->>'total')::bigint), 0)::bigint
           from public.ai_logs l where l.session_id = f.id),
        (select count(*) from public.ai_logs l
          where l.session_id = f.id and jsonb_array_length(l.errors) > 0),
        f.created_at,
        f.updated_at,
        greatest(
            f.updated_at,
            coalesce((select max(n.created_at) from public.nodes n
                       where n.session_id = f.id), f.updated_at)
        ),
        (select c from total)
      from filtered f
      join public.profiles p on p.id = f.owner_id
      left join public.classes c on c.id = f.space_ref
     order by 15 desc
     limit greatest(p_limit, 1) offset greatest(p_offset, 0);
end;
$$;

-- ── 3) 문서(파일) 인제스트 현황 ───────────────────────────────────────
-- "문서가 어떻게 올라갔는가" = 청킹이 몇 조각으로 끊겼고 그중 몇 개가 임베딩에
-- 성공했는가. files.chunk_total/chunk_done은 워커가 쓰는 진행률이라 실제 행
-- 개수와 어긋날 수 있어 **양쪽을 다 돌려준다**.
CREATE FUNCTION public.admin_documents(
    p_kind   text default null,
    p_status text default null,
    p_search text default null,
    p_limit  int  default 30,
    p_offset int  default 0
) returns table (
    file_id         uuid,
    name            text,
    kind            text,
    space_kind      text,
    space_ref       uuid,
    class_name      text,
    owner_id        uuid,
    owner_email     text,
    status          text,
    mime            text,
    size_bytes      bigint,
    chunk_total     int,
    chunk_done      int,
    context_chars   int,
    error           text,
    session_id      uuid,
    chunks_rows     bigint,
    chunks_embedded bigint,
    chunks_stored   bigint,
    chunks_failed   bigint,
    chunk_chars     bigint,
    figures_total   bigint,
    figures_ok      bigint,
    created_at      timestamptz,
    updated_at      timestamptz,
    total_count     bigint
)
    language plpgsql stable security definer
    set search_path to 'public'
    as $$
begin
    if not public.is_admin() then
        raise exception 'admin only' using errcode = 'insufficient_privilege';
    end if;

    return query
    with filtered as (
        select f.*
          from public.files f
          left join public.profiles p on p.id = f.owner_id
         where (p_kind   is null or f.kind = p_kind)
           and (p_status is null or f.status = p_status)
           and (p_search is null
                or f.name ilike '%' || p_search || '%'
                or p.email ilike '%' || p_search || '%')
    ),
    total as (select count(*) c from filtered)
    select
        f.id, f.name, f.kind, f.space_kind, f.space_ref, c.name,
        f.owner_id, p.email, f.status, f.mime, f.size_bytes,
        f.chunk_total, f.chunk_done, f.context_chars, f.error, f.session_id,
        (select count(*) from public.file_chunks k where k.file_id = f.id),
        (select count(*) from public.file_chunks k
          where k.file_id = f.id and k.status = 'embedded'),
        (select count(*) from public.file_chunks k
          where k.file_id = f.id and k.status = 'stored'),
        (select count(*) from public.file_chunks k
          where k.file_id = f.id and k.status = 'failed'),
        (select coalesce(sum(length(k.chunk_text)), 0) from public.file_chunks k
          where k.file_id = f.id),
        (select count(*) from public.textbook_figures g where g.file_id = f.id),
        (select count(*) from public.textbook_figures g
          where g.file_id = f.id and g.status = 'embedded'),
        f.created_at, f.updated_at,
        (select c from total)
      from filtered f
      left join public.profiles p on p.id = f.owner_id
      left join public.classes  c on c.id = f.space_ref
     order by f.created_at desc
     limit greatest(p_limit, 1) offset greatest(p_offset, 0);
end;
$$;

-- ── 4) 스킬 사용 통계 ─────────────────────────────────────────────────
-- ai_logs.skill_calls(D113 트레이스)를 펼쳐 스킬별로 센다. 어떤 스킬이 실제로
-- 쓰이는지, 얼마나 걸리는지, 얼마나 실패하는지 — 카탈로그를 좁힐 근거가 된다.
CREATE FUNCTION public.admin_skill_usage(p_days int default 30)
returns table (
    skill      text,
    calls      bigint,
    failures   bigint,
    skipped    bigint,
    turns      bigint,
    avg_ms     numeric,
    max_ms     bigint,
    last_used  timestamptz
)
    language plpgsql stable security definer
    set search_path to 'public'
    as $$
begin
    if not public.is_admin() then
        raise exception 'admin only' using errcode = 'insufficient_privilege';
    end if;

    return query
    select
        s.value->>'skill',
        count(*),
        count(*) filter (where (s.value->>'ok')::boolean is not true),
        count(*) filter (where (s.value->>'skipped')::boolean is true),
        count(distinct l.id),
        round(avg(nullif((s.value->>'duration_ms')::numeric, null)), 1),
        max((s.value->>'duration_ms')::bigint),
        max(l.created_at)
      from public.ai_logs l
      cross join lateral jsonb_array_elements(l.skill_calls) s(value)
     where l.created_at >= now() - make_interval(days => greatest(p_days, 1))
       and s.value->>'skill' is not null
     group by 1
     order by 2 desc;
end;
$$;

-- ===========================================================================
-- D114 — 데이터 백업 · 복원 · 초기화 RPC (2026-07-28)
--
-- 삭제는 소유자 정책이 막는다(sessions_delete_owner). 관리자에게는 SELECT 정책만
-- 있어 콘솔이 남의 세션을 지울 수 없다. 앱 코드로 우회하면(워커 BYPASSRLS)
-- "권한은 DB가 강제한다"(D104)가 깨지므로, 함수 안에서 is_admin()을 확인하는
-- SECURITY DEFINER를 둔다.
-- ===========================================================================
-- ── 대화 초기화 ───────────────────────────────────────────────────────
-- ai_logs를 **먼저** 지운다. sessions FK가 ON DELETE SET NULL이라 세션만 지우면
-- 로그는 owner만 남은 고아 행으로 살아남는다 — "대화 기록 초기화"라는 말과 어긋난다.
CREATE FUNCTION public.admin_purge_conversations(
    p_owner uuid default null
) returns jsonb
    language plpgsql security definer
    set search_path to 'public'
    as $$
declare
    v_logs     bigint := 0;
    v_nodes    bigint := 0;
    v_sessions bigint := 0;
begin
    if not public.is_admin() then
        raise exception 'admin only' using errcode = 'insufficient_privilege';
    end if;

    -- 노드는 sessions FK의 ON DELETE CASCADE로 함께 사라진다. 지워질 개수를
    -- 미리 세어 두지 않으면 보고할 수가 없다(삭제 후에는 셀 대상이 없다).
    select count(*) into v_nodes
      from public.nodes n
      join public.sessions s on s.id = n.session_id
     where p_owner is null or s.owner_id = p_owner;

    with d as (
        delete from public.ai_logs l
         where p_owner is null or l.owner_id = p_owner
        returning 1
    ) select count(*) into v_logs from d;

    with d as (
        delete from public.sessions s
         where p_owner is null or s.owner_id = p_owner
        returning 1
    ) select count(*) into v_sessions from d;

    return jsonb_build_object(
        'ai_logs', v_logs, 'nodes', v_nodes, 'sessions', v_sessions
    );
end;
$$;

-- ── 복원 ──────────────────────────────────────────────────────────────
-- **덮어쓰지 않는다.** 같은 id가 이미 있으면 건너뛴다(on conflict do nothing).
-- 복원이 현재 데이터를 조용히 갈아엎으면 "복원했더니 최근 것이 사라졌다"가 된다.
--
-- sessions ↔ nodes는 서로를 참조한다(nodes.session_id / sessions.root_node_id).
-- 그래서 세션을 **머리 없이** 먼저 넣고, 노드를 넣은 뒤, 머리를 이어 붙인다.
CREATE FUNCTION public.admin_restore_conversations(p_data jsonb)
returns jsonb
    language plpgsql security definer
    set search_path to 'public'
    as $$
declare
    v_sessions bigint := 0;
    v_nodes    bigint := 0;
    v_logs     bigint := 0;
    v_heads    bigint := 0;
    v_items    bigint := 0;
    v_links    bigint := 0;
    v_draw     bigint := 0;
begin
    if not public.is_admin() then
        raise exception 'admin only' using errcode = 'insufficient_privilege';
    end if;

    -- 1) 세션 (root/head는 아직 비운다)
    with src as (
        select * from jsonb_populate_recordset(null::public.sessions,
                                               coalesce(p_data->'sessions', '[]'::jsonb))
    ), ins as (
        insert into public.sessions
            (id, owner_id, space_kind, space_ref, title, emoji, created_at, updated_at)
        select s.id, s.owner_id, s.space_kind, s.space_ref, s.title, s.emoji,
               s.created_at, s.updated_at
          from src s
          -- 소유자가 사라진 세션은 FK가 막는다. 조용히 실패하지 말고 걸러 낸다.
         where exists (select 1 from public.profiles p where p.id = s.owner_id)
        on conflict (id) do nothing
        returning 1
    ) select count(*) into v_sessions from ins;

    -- 2) 노드 (부모는 자기 참조라 순서 무관 — FK가 deferrable이 아니므로
    --    parent_id를 일단 비우고 넣은 뒤 3)에서 잇는다)
    with src as (
        select * from jsonb_populate_recordset(null::public.nodes,
                                               coalesce(p_data->'nodes', '[]'::jsonb))
    ), ins as (
        insert into public.nodes
            (id, session_id, question, answer, label, attachments, rag_sources, created_at)
        select n.id, n.session_id, n.question, n.answer, n.label,
               n.attachments, n.rag_sources, n.created_at
          from src n
         where exists (select 1 from public.sessions s where s.id = n.session_id)
        on conflict (id) do nothing
        returning 1
    ) select count(*) into v_nodes from ins;

    -- 3) 부모 연결 + 세션 머리 복원
    update public.nodes n
       set parent_id = src.parent_id
      from jsonb_populate_recordset(null::public.nodes,
                                    coalesce(p_data->'nodes', '[]'::jsonb)) src
     where n.id = src.id
       and n.parent_id is null
       and src.parent_id is not null
       and exists (select 1 from public.nodes p where p.id = src.parent_id);

    with src as (
        select * from jsonb_populate_recordset(null::public.sessions,
                                               coalesce(p_data->'sessions', '[]'::jsonb))
    ), upd as (
        update public.sessions s
           set root_node_id = src.root_node_id,
               current_head_id = src.current_head_id
          from src
         where s.id = src.id
           and s.root_node_id is null
           and (src.root_node_id is not null or src.current_head_id is not null)
        returning 1
    ) select count(*) into v_heads from upd;

    -- 4) 턴 로그
    with src as (
        select * from jsonb_populate_recordset(null::public.ai_logs,
                                               coalesce(p_data->'ai_logs', '[]'::jsonb))
    ), ins as (
        insert into public.ai_logs
            (id, owner_id, session_id, node_id, kind, system_prompt, question, answer,
             contexts, skill_calls, errors, token_estimate, tokens, route, model,
             duration_ms, created_at)
        select l.id, l.owner_id,
               -- 세션·노드가 복원되지 않았으면 참조를 비운다(로그 자체는 살린다).
               (select s.id from public.sessions s where s.id = l.session_id),
               (select n.id from public.nodes n where n.id = l.node_id),
               l.kind, l.system_prompt, l.question, l.answer, l.contexts,
               l.skill_calls, l.errors, l.token_estimate, l.tokens, l.route,
               l.model, l.duration_ms, l.created_at
          from src l
         where exists (select 1 from public.profiles p where p.id = l.owner_id)
        on conflict (id) do nothing
        returning 1
    ) select count(*) into v_logs from ins;

    -- 5) 캔버스 글 (D152) — **부모는 비운 채** 넣는다(자기 참조 FK).
    with src as (
        select * from jsonb_populate_recordset(null::public.canvas_items,
                                               coalesce(p_data->'canvas_items', '[]'::jsonb))
    ), ins as (
        insert into public.canvas_items
            (id, session_id, node_id, kind, source, title, body, tag,
             x, y, pinned, seq, data, created_at, updated_at)
        select i.id, i.session_id,
               -- 노드를 못 살렸으면 참조만 비운다. 글은 살린다.
               (select n.id from public.nodes n where n.id = i.node_id),
               i.kind, i.source, i.title, i.body, i.tag,
               i.x, i.y, i.pinned, i.seq, i.data, i.created_at, i.updated_at
          from src i
         where exists (select 1 from public.sessions s where s.id = i.session_id)
        on conflict (id) do nothing
        returning 1
    ) select count(*) into v_items from ins;

    -- 6) 트리 간선 잇기 (D151) — 부모가 실제로 복원됐을 때만.
    with src as (
        select * from jsonb_populate_recordset(null::public.canvas_items,
                                               coalesce(p_data->'canvas_items', '[]'::jsonb))
    ), upd as (
        update public.canvas_items c
           set parent_item_id = src.parent_item_id
          from src
         where c.id = src.id
           and c.parent_item_id is null
           and src.parent_item_id is not null
           and exists (select 1 from public.canvas_items p where p.id = src.parent_item_id)
        returning 1
    ) select count(*) into v_links from upd;

    -- 7) 그림 (세션당 한 행)
    with src as (
        select * from jsonb_populate_recordset(null::public.canvas_drawings,
                                               coalesce(p_data->'canvas_drawings', '[]'::jsonb))
    ), ins as (
        insert into public.canvas_drawings (session_id, elements, files, updated_at)
        select d.session_id, d.elements, d.files, d.updated_at
          from src d
         where exists (select 1 from public.sessions s where s.id = d.session_id)
        on conflict (session_id) do nothing
        returning 1
    ) select count(*) into v_draw from ins;

    return jsonb_build_object(
        'sessions', v_sessions, 'nodes', v_nodes,
        'ai_logs', v_logs, 'heads_relinked', v_heads,
        'canvas_items', v_items, 'canvas_links', v_links,
        'canvas_drawings', v_draw
    );
end;
$$;

-- 설정 복원 — 이쪽은 **덮어쓴다.** 설정은 "현재 유효한 값"이 하나뿐이라
-- 건너뛰면 복원이 아무 일도 하지 않는 것과 같다.
CREATE FUNCTION public.admin_restore_settings(p_data jsonb)
returns jsonb
    language plpgsql security definer
    set search_path to 'public'
    as $$
declare
    v_count bigint := 0;
begin
    if not public.is_admin() then
        raise exception 'admin only' using errcode = 'insufficient_privilege';
    end if;

    with src as (
        select key, value
          from jsonb_to_recordset(coalesce(p_data->'app_settings', '[]'::jsonb))
               as t(key text, value jsonb)
    ), ups as (
        insert into public.app_settings (key, value, updated_by, updated_at)
        select s.key, s.value, auth.uid(), now() from src s
        on conflict (key) do update
            set value = excluded.value,
                updated_by = excluded.updated_by,
                updated_at = excluded.updated_at
        returning 1
    ) select count(*) into v_count from ups;

    return jsonb_build_object('app_settings', v_count);
end;
$$;

-- ===========================================================================
-- D122: 캔버스 아이템 · 그림 (캔버스 v2)
--
-- 마이그레이션 db/migrations/2026-07-30-d122-canvas-items.sql와 **같은 내용**이다.
-- 여기에도 두는 이유: 빈 볼륨 초기화는 db/0*.sql만 훑는다. 마이그레이션에만
-- 두면 새 인스턴스에 테이블이 안 생기고, 그 고장은 배포 로그에 안 남는다.
-- 한쪽을 고치면 **반드시 다른 쪽도 고친다.**
-- ===========================================================================


-- 드래그 한 번이 UPDATE 한 번이다 — 같은 페이지에 새 버전을 쓸 자리를
-- 남겨야 HOT 갱신이 되고 인덱스를 안 건드린다 (D146, 실측: HOT 1.7% → 56.7%).
CREATE TABLE IF NOT EXISTS public.canvas_items (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id     uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
    -- 어느 턴에서 나왔나. 사용자 메모(kind='note')는 NULL이다.
    node_id        uuid REFERENCES public.nodes(id) ON DELETE CASCADE,
    -- AI 응답이 어느 메모에 대한 답인가 (D126 연결선).
    -- 부모가 지워져도 답변 자체는 남긴다 → SET NULL.
    parent_item_id uuid REFERENCES public.canvas_items(id) ON DELETE SET NULL,

    kind   text NOT NULL CHECK (kind IN ('concept', 'note', 'figure', 'clip')),
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
)
WITH (fillfactor = 80);

-- 획 하나마다 장면 전체를 다시 쓴다 (D146).
CREATE TABLE IF NOT EXISTS public.canvas_drawings (
    -- 세션당 1행. Excalidraw 요소는 개수가 많고 자주 바뀌어서 요소당 1행은
    -- 너무 잦다. 씬 전체를 담고 프론트가 디바운스 저장한다.
    session_id uuid PRIMARY KEY REFERENCES public.sessions(id) ON DELETE CASCADE,
    elements   jsonb NOT NULL DEFAULT '[]'::jsonb,
    files      jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now()
)
WITH (fillfactor = 85);

CREATE INDEX IF NOT EXISTS idx_canvas_items_session
    ON public.canvas_items (session_id, seq, created_at);

-- 개념 카드 집계 전용(2026-08-10) — `/spaces/rooms`·`/spaces/overview`·홈 지도가
-- 같은 모양으로 묻는다. 조건을 인덱스에 담아 두면 kind·source를 다시 검사하지
-- 않는다(실측: buffers 306 → 216, 1.03ms → 0.68ms).
CREATE INDEX IF NOT EXISTS idx_canvas_items_concept
    ON public.canvas_items (session_id, created_at DESC)
    WHERE kind = 'concept' AND source = 'ai';
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
    FOR SELECT USING (session_id IN (SELECT public.accessible_session_ids()));

-- D113과 같은 이유로 별도 정책: can_access_session()을 고치지 않고 관리자
-- 전역 읽기를 더한다.
CREATE POLICY canvas_items_select_admin ON public.canvas_items
    FOR SELECT USING ((SELECT public.is_admin()));

CREATE POLICY canvas_items_insert_owner ON public.canvas_items
    FOR INSERT WITH CHECK (EXISTS (
        SELECT 1 FROM public.sessions s
        WHERE s.id = canvas_items.session_id AND s.owner_id = (SELECT auth.uid())));

CREATE POLICY canvas_items_update_owner ON public.canvas_items
    FOR UPDATE USING (EXISTS (
        SELECT 1 FROM public.sessions s
        WHERE s.id = canvas_items.session_id AND s.owner_id = (SELECT auth.uid())));

CREATE POLICY canvas_items_delete_owner ON public.canvas_items
    FOR DELETE USING (EXISTS (
        SELECT 1 FROM public.sessions s
        WHERE s.id = canvas_items.session_id AND s.owner_id = (SELECT auth.uid())));

DROP POLICY IF EXISTS canvas_drawings_select       ON public.canvas_drawings;
DROP POLICY IF EXISTS canvas_drawings_select_admin ON public.canvas_drawings;
DROP POLICY IF EXISTS canvas_drawings_write_owner  ON public.canvas_drawings;

CREATE POLICY canvas_drawings_select ON public.canvas_drawings
    FOR SELECT USING (session_id IN (SELECT public.accessible_session_ids()));

CREATE POLICY canvas_drawings_select_admin ON public.canvas_drawings
    FOR SELECT USING ((SELECT public.is_admin()));

-- 그림은 부분 수정이 없다(씬 전체 교체) — insert/update/delete를 한 정책으로.
CREATE POLICY canvas_drawings_write_owner ON public.canvas_drawings
    FOR ALL USING (EXISTS (
        SELECT 1 FROM public.sessions s
        WHERE s.id = canvas_drawings.session_id AND s.owner_id = (SELECT auth.uid())))
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.sessions s
        WHERE s.id = canvas_drawings.session_id AND s.owner_id = (SELECT auth.uid())));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.canvas_items    TO nodi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.canvas_drawings TO nodi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.canvas_items    TO nodi_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.canvas_drawings TO nodi_worker;

-- ---------------------------------------------------------------------------
-- 교차 세션 개념 연결 (D171). 어제 생명과학에서 한 이야기와 오늘 지구과학에서
-- 하는 이야기가 이어져 있을 때 그 연결을 보여 준다.
-- 스펙: docs/superpowers/specs/2026-08-04-crosslink-design.md
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.item_links (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id     uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,

    -- 지금 보고 있는 카드(새로 만들어진 쪽).
    from_item_id uuid NOT NULL REFERENCES public.canvas_items(id) ON DELETE CASCADE,
    -- 과거의 카드. 이쪽으로 "돌아가기"가 이동한다.
    to_item_id   uuid NOT NULL REFERENCES public.canvas_items(id) ON DELETE CASCADE,

    explanation  text NOT NULL DEFAULT '',
    -- 거리 규약: distance = 1 - score.
    distance     double precision NOT NULL,

    -- 한 번 열면 깜빡임을 멈춘다. 본 알림이 계속 깜빡이면 그냥 소음이다.
    opened_at    timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),

    -- 같은 쌍의 반복 추천을 **구조로** 막는다(앱 코드 검사는 동시 실행에서 샌다).
    CONSTRAINT item_links_pair_unique UNIQUE (from_item_id, to_item_id),
    CONSTRAINT item_links_not_self CHECK (from_item_id <> to_item_id)
);

CREATE INDEX IF NOT EXISTS idx_item_links_from  ON public.item_links (from_item_id);
CREATE INDEX IF NOT EXISTS idx_item_links_to    ON public.item_links (to_item_id);
CREATE INDEX IF NOT EXISTS idx_item_links_owner ON public.item_links (owner_id);

ALTER TABLE public.item_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS item_links_select       ON public.item_links;
DROP POLICY IF EXISTS item_links_select_admin ON public.item_links;
DROP POLICY IF EXISTS item_links_update_owner ON public.item_links;
DROP POLICY IF EXISTS item_links_delete_owner ON public.item_links;

CREATE POLICY item_links_select ON public.item_links
    FOR SELECT USING (owner_id = (SELECT auth.uid()));

CREATE POLICY item_links_select_admin ON public.item_links
    FOR SELECT USING ((SELECT public.is_admin()));

CREATE POLICY item_links_update_owner ON public.item_links
    FOR UPDATE USING (owner_id = (SELECT auth.uid()));

CREATE POLICY item_links_delete_owner ON public.item_links
    FOR DELETE USING (owner_id = (SELECT auth.uid()));

-- **INSERT 정책은 없다.** 링크는 워커(BYPASSRLS)만 만든다 — 학생이 임의의 두
-- 카드를 이어 붙일 수 있으면 이 기능의 의미가 사라진다.
GRANT SELECT, UPDATE, DELETE ON public.item_links TO nodi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.item_links TO nodi_worker;

-- ---------------------------------------------------------------------------
-- 교차 연결 판정 로그 (D172).
--
-- item_links는 **성공한 링크만** 남긴다. 탈락한 후보는 흔적 없이 사라져
-- "왜 안 뜨지"를 볼 방법이 없었다. 이 표는 한 번의 판정 전체를 남긴다 —
-- 어떤 세션들을 뒤졌고, 각 후보의 유사도가 얼마였고, 무엇이 왜 떨어졌는지.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.crosslink_runs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id        uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,

    -- 카드가 지워져도 조사 기록은 남긴다(SET NULL) — 지워졌다고 기록까지
    -- 사라지면 사후 분석이 불가능하다.
    from_item_id    uuid REFERENCES public.canvas_items(id) ON DELETE SET NULL,
    from_session_id uuid REFERENCES public.sessions(id) ON DELETE SET NULL,
    from_title      text,
    from_tag        text,
    from_space_kind text,

    knobs           jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- 원소 하나가 후보 하나: {item_id, session_id, session_title, tag,
    -- space_kind, distance, verdict, reason}
    candidates      jsonb NOT NULL DEFAULT '[]'::jsonb,

    outcome         text NOT NULL,   -- linked|no_candidate|all_rejected|disabled|skipped
    link_id         uuid REFERENCES public.item_links(id) ON DELETE SET NULL,
    explanation     text NOT NULL DEFAULT '',
    searched_sessions integer NOT NULL DEFAULT 0,
    duration_ms     integer,

    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crosslink_runs_created
    ON public.crosslink_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crosslink_runs_owner
    ON public.crosslink_runs (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crosslink_runs_outcome
    ON public.crosslink_runs (outcome);

ALTER TABLE public.crosslink_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crosslink_runs_select_admin ON public.crosslink_runs;

-- **관리자만** 읽는다. 진단 기록이지 학습 자료가 아니다.
CREATE POLICY crosslink_runs_select_admin ON public.crosslink_runs
    FOR SELECT USING ((SELECT public.is_admin()));

GRANT SELECT ON public.crosslink_runs TO nodi_app;
GRANT SELECT, INSERT, DELETE ON public.crosslink_runs TO nodi_worker;

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

-- ===========================================================================
-- D149: 강의 클립(숏폼) 추천 — admin 전역 카탈로그.
-- 신규 볼륨 기동 커버. 기 기동 DB는 db/migrations/2026-08-03-d149-lecture-clips.sql.
-- (학년·과목) 패키지 → EBS 영상 → 챕터=클립 → 원자 질문(D129 미러). 선생님이
-- 워크스페이스에 켜는 매핑은 class_lecture_packages. 카탈로그는 전역 콘텐츠 —
-- 인증 사용자 읽기, admin 쓰기, 워커(BYPASSRLS) 인제스트.
-- ===========================================================================

-- (학년·과목) 강의 추천 패키지 = "클립셋"
CREATE TABLE IF NOT EXISTS public.lecture_packages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    grade text NOT NULL,
    subject text NOT NULL,
    title text NOT NULL,
    created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at timestamptz DEFAULT now() NOT NULL
);

-- 패키지에 속한 EBS 영상(admin이 링크·제목 입력)
CREATE TABLE IF NOT EXISTS public.lecture_videos (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    package_id uuid NOT NULL REFERENCES public.lecture_packages(id) ON DELETE CASCADE,
    source text DEFAULT 'ebs'::text NOT NULL,
    page_url text NOT NULL,
    subtitle_path text,                 -- 업로드한 자막 Storage 경로(개정 R1)
    title text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    error text,
    created_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT lecture_videos_status_check CHECK
      ((status = ANY (ARRAY['pending'::text,'parsing'::text,'parsed'::text,'failed'::text])))
);
CREATE INDEX IF NOT EXISTS idx_lecture_videos_package ON public.lecture_videos (package_id);

-- 챕터 = 클립. 임베딩 텍스트는 제목+본문(transcript). 타임라인 라벨은 start_sec 파생.
CREATE TABLE IF NOT EXISTS public.lecture_clips (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id uuid NOT NULL REFERENCES public.lecture_videos(id) ON DELETE CASCADE,
    seq integer NOT NULL,
    start_sec integer NOT NULL,
    end_sec integer,                    -- 다음 챕터 시작 = 구간 끝(마지막은 NULL, 개정 R1)
    title text NOT NULL,
    transcript text DEFAULT ''::text NOT NULL,   -- 챕터 구간 자막 본문(개정 R1)
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT lecture_clips_status_check CHECK
      ((status = ANY (ARRAY['pending'::text,'embedded'::text,'failed'::text]))),
    CONSTRAINT lecture_clips_video_seq_key UNIQUE (video_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_lecture_clips_video ON public.lecture_clips (video_id, status);

-- 원자 질문(PIKE-RAG D129 미러) — solar-pro3가 클립 본문에서 생성한 예상 질문.
CREATE TABLE IF NOT EXISTS public.lecture_clip_atoms (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    clip_id uuid NOT NULL REFERENCES public.lecture_clips(id) ON DELETE CASCADE,
    package_id uuid NOT NULL REFERENCES public.lecture_packages(id) ON DELETE CASCADE,
    question text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT lecture_clip_atoms_status_check CHECK
      ((status = ANY (ARRAY['pending'::text,'embedded'::text,'failed'::text])))
);
CREATE INDEX IF NOT EXISTS idx_lecture_clip_atoms_clip ON public.lecture_clip_atoms (clip_id, status);

-- 선생님이 워크스페이스에 켠 패키지
CREATE TABLE IF NOT EXISTS public.class_lecture_packages (
    class_id uuid NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
    package_id uuid NOT NULL REFERENCES public.lecture_packages(id) ON DELETE CASCADE,
    created_at timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (class_id, package_id)
);

ALTER TABLE public.lecture_packages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lecture_packages_select ON public.lecture_packages;
CREATE POLICY lecture_packages_select ON public.lecture_packages FOR SELECT USING ((auth.uid() IS NOT NULL));
DROP POLICY IF EXISTS lecture_packages_admin ON public.lecture_packages;
CREATE POLICY lecture_packages_admin ON public.lecture_packages FOR ALL USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

ALTER TABLE public.lecture_videos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lecture_videos_select ON public.lecture_videos;
CREATE POLICY lecture_videos_select ON public.lecture_videos FOR SELECT USING ((auth.uid() IS NOT NULL));
DROP POLICY IF EXISTS lecture_videos_admin ON public.lecture_videos;
CREATE POLICY lecture_videos_admin ON public.lecture_videos FOR ALL USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

ALTER TABLE public.lecture_clips ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lecture_clips_select ON public.lecture_clips;
CREATE POLICY lecture_clips_select ON public.lecture_clips FOR SELECT USING ((auth.uid() IS NOT NULL));
DROP POLICY IF EXISTS lecture_clips_admin ON public.lecture_clips;
CREATE POLICY lecture_clips_admin ON public.lecture_clips FOR ALL USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

ALTER TABLE public.lecture_clip_atoms ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lecture_clip_atoms_select ON public.lecture_clip_atoms;
CREATE POLICY lecture_clip_atoms_select ON public.lecture_clip_atoms FOR SELECT USING ((auth.uid() IS NOT NULL));
DROP POLICY IF EXISTS lecture_clip_atoms_admin ON public.lecture_clip_atoms;
CREATE POLICY lecture_clip_atoms_admin ON public.lecture_clip_atoms FOR ALL USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

ALTER TABLE public.class_lecture_packages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS clp_select_member ON public.class_lecture_packages;
CREATE POLICY clp_select_member ON public.class_lecture_packages FOR SELECT
  USING ((class_id IN (SELECT public.my_class_ids())) OR (SELECT public.is_admin()));
DROP POLICY IF EXISTS clp_write_teacher ON public.class_lecture_packages;
CREATE POLICY clp_write_teacher ON public.class_lecture_packages FOR ALL
  USING (class_id IN (SELECT public.my_taught_class_ids()))
  WITH CHECK (class_id IN (SELECT public.my_taught_class_ids()));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.lecture_packages, public.lecture_videos, public.lecture_clips, public.lecture_clip_atoms TO nodi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.class_lecture_packages TO nodi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lecture_packages, public.lecture_videos, public.lecture_clips, public.lecture_clip_atoms TO nodi_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.class_lecture_packages TO nodi_worker;


-- ---------------------------------------------------------------------------
-- 강의 클립 썸네일 (D190)
--
-- EBS 썸네일을 가져올 방법이 없어(저작권·차단) 관리자가 올린 그림 중 하나를
-- 클립마다 보여 준다. 학생 데이터가 아니라 장식용이라 로그인한 사람은 다
-- 읽고, 넣고 빼는 것은 관리자만 한다.
--
-- ⚠️ 이 표는 마이그레이션(2026-08-06-d190)에도 있다. **둘 다 있어야 한다** —
-- 마이그레이션만 있으면 빈 볼륨으로 새로 세운 개발자에게 표가 없고, 여기만
-- 있으면 이미 돌고 있는 서버가 못 받는다.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.clip_thumbnails (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    storage_path  text NOT NULL,
    mime          text NOT NULL,
    size_bytes    integer NOT NULL DEFAULT 0,
    name          text,
    created_by    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_clip_thumbnails_created
    ON public.clip_thumbnails (created_at DESC);

ALTER TABLE public.clip_thumbnails ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS clip_thumbnails_select ON public.clip_thumbnails;
CREATE POLICY clip_thumbnails_select ON public.clip_thumbnails
    FOR SELECT USING ((SELECT auth.uid()) IS NOT NULL);
DROP POLICY IF EXISTS clip_thumbnails_write_admin ON public.clip_thumbnails;
CREATE POLICY clip_thumbnails_write_admin ON public.clip_thumbnails
    FOR ALL USING ((SELECT public.is_admin()))
    WITH CHECK ((SELECT public.is_admin()));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.clip_thumbnails TO nodi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.clip_thumbnails TO nodi_worker;
