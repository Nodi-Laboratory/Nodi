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


CREATE FUNCTION public.add_node_connection(p_node_id uuid, p_source_node_id uuid) RETURNS uuid[]
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
    v_conn uuid[];
begin
    if p_node_id = p_source_node_id then
        raise exception 'cannot connect a node to itself'
            using errcode = 'check_violation';
    end if;

    -- Target must be owned by the caller (and lock it for the edit).
    select n.connections
      into v_conn
      from public.nodes n
      join public.sessions s on s.id = n.session_id
     where n.id = p_node_id and s.owner_id = auth.uid()
     for update of n;
    if not found then
        raise exception 'target node not found or not owned'
            using errcode = 'insufficient_privilege';
    end if;

    -- Source must also be owned by the caller.
    if not exists (
        select 1
          from public.nodes n2
          join public.sessions s2 on s2.id = n2.session_id
         where n2.id = p_source_node_id and s2.owner_id = auth.uid()
    ) then
        raise exception 'source node not found or not owned'
            using errcode = 'insufficient_privilege';
    end if;

    v_conn := coalesce(v_conn, array[]::uuid[]);
    if not (p_source_node_id = any (v_conn)) then
        update public.nodes
           set connections = array_append(connections, p_source_node_id)
         where id = p_node_id
         returning connections into v_conn;
    end if;

    return v_conn;
end;
$$;

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
    connections uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    attachments jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    rag_sources jsonb DEFAULT '[]'::jsonb NOT NULL,
    reference_sources jsonb DEFAULT '[]'::jsonb NOT NULL
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
    created_at timestamp with time zone DEFAULT now() NOT NULL
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
    if v_owner <> auth.uid() then
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

CREATE FUNCTION public.remove_node_connection(p_node_id uuid, p_source_node_id uuid) RETURNS uuid[]
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
    v_conn uuid[];
begin
    update public.nodes n
       set connections = array_remove(n.connections, p_source_node_id)
      from public.sessions s
     where n.id = p_node_id
       and s.id = n.session_id
       and s.owner_id = auth.uid()
     returning n.connections into v_conn;
    if not found then
        raise exception 'target node not found or not owned'
            using errcode = 'insufficient_privilege';
    end if;
    return v_conn;
end;
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

CREATE FUNCTION public.teacher_classes() RETURNS TABLE(id uuid, name text, join_code text, created_at timestamp with time zone, student_count bigint)
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
                where m.class_id = c.id and m.role_in_class = 'student'
           )::bigint as student_count
      from public.classes c
     where public.is_class_teacher(c.id)
     order by c.created_at desc;
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
    CONSTRAINT jobs_kind_check CHECK ((kind = ANY (ARRAY['embedding_split'::text, 'embedding_batch'::text, 'figure_batch'::text]))),
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

CREATE POLICY ai_logs_select_admin ON public.ai_logs FOR SELECT USING (public.is_admin());

CREATE POLICY ai_logs_select_own ON public.ai_logs FOR SELECT USING ((owner_id = ( SELECT auth.uid() AS uid)));

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY app_settings_admin_insert ON public.app_settings FOR INSERT WITH CHECK (public.is_admin());

CREATE POLICY app_settings_admin_select ON public.app_settings FOR SELECT USING (public.is_admin());

CREATE POLICY app_settings_admin_update ON public.app_settings FOR UPDATE USING (public.is_admin()) WITH CHECK (public.is_admin());

ALTER TABLE public.class_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY class_members_delete_self ON public.class_members FOR DELETE USING ((user_id = ( SELECT auth.uid() AS uid)));

CREATE POLICY class_members_select ON public.class_members FOR SELECT USING (((user_id = ( SELECT auth.uid() AS uid)) OR public.is_class_member(class_id)));

ALTER TABLE public.classes ENABLE ROW LEVEL SECURITY;

CREATE POLICY classes_insert_teacher ON public.classes FOR INSERT WITH CHECK (((teacher_id = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = 'teacher'::text))))));

CREATE POLICY classes_select_member ON public.classes FOR SELECT USING (((teacher_id = ( SELECT auth.uid() AS uid)) OR public.is_class_member(id)));

CREATE POLICY classes_update_teacher ON public.classes FOR UPDATE USING ((teacher_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((teacher_id = ( SELECT auth.uid() AS uid)));

ALTER TABLE public.file_chunks ENABLE ROW LEVEL SECURITY;

CREATE POLICY file_chunks_select_class ON public.file_chunks FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.files f
  WHERE ((f.id = file_chunks.file_id) AND (f.kind = ANY (ARRAY['class_material'::text, 'textbook'::text])) AND public.is_class_member(f.space_ref)))));

CREATE POLICY file_chunks_select_own ON public.file_chunks FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.files f
  WHERE ((f.id = file_chunks.file_id) AND (f.owner_id = ( SELECT auth.uid() AS uid))))));

ALTER TABLE public.files ENABLE ROW LEVEL SECURITY;

CREATE POLICY files_delete_own ON public.files FOR DELETE USING ((owner_id = ( SELECT auth.uid() AS uid)));

CREATE POLICY files_insert_own ON public.files FOR INSERT WITH CHECK (((owner_id = ( SELECT auth.uid() AS uid)) AND ((kind <> ALL (ARRAY['class_material'::text, 'textbook'::text])) OR public.is_class_teacher(space_ref))));

CREATE POLICY files_select_class ON public.files FOR SELECT USING (((kind = ANY (ARRAY['class_material'::text, 'textbook'::text])) AND public.is_class_member(space_ref)));

CREATE POLICY files_select_own ON public.files FOR SELECT USING ((owner_id = ( SELECT auth.uid() AS uid)));

CREATE POLICY files_update_own ON public.files FOR UPDATE USING ((owner_id = ( SELECT auth.uid() AS uid))) WITH CHECK (((owner_id = ( SELECT auth.uid() AS uid)) AND ((kind <> ALL (ARRAY['class_material'::text, 'textbook'::text])) OR public.is_class_teacher(space_ref))));

ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY jobs_select_own ON public.jobs FOR SELECT USING (((owner_id = ( SELECT auth.uid() AS uid)) OR public.is_admin()));

ALTER TABLE public.nodes ENABLE ROW LEVEL SECURITY;

CREATE POLICY nodes_delete_owner ON public.nodes FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.sessions s
  WHERE ((s.id = nodes.session_id) AND (s.owner_id = ( SELECT auth.uid() AS uid))))));

CREATE POLICY nodes_insert_owner ON public.nodes FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.sessions s
  WHERE ((s.id = nodes.session_id) AND (s.owner_id = ( SELECT auth.uid() AS uid))))));

CREATE POLICY nodes_select ON public.nodes FOR SELECT USING (public.can_access_session(session_id));

CREATE POLICY nodes_update_owner ON public.nodes FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.sessions s
  WHERE ((s.id = nodes.session_id) AND (s.owner_id = ( SELECT auth.uid() AS uid))))));

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY profiles_select_admin ON public.profiles FOR SELECT USING (public.is_admin());

CREATE POLICY profiles_select_own ON public.profiles FOR SELECT USING ((id = ( SELECT auth.uid() AS uid)));

CREATE POLICY profiles_update_own ON public.profiles FOR UPDATE USING ((id = ( SELECT auth.uid() AS uid))) WITH CHECK ((id = ( SELECT auth.uid() AS uid)));

ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY sessions_delete_owner ON public.sessions FOR DELETE USING ((owner_id = ( SELECT auth.uid() AS uid)));

CREATE POLICY sessions_insert_owner ON public.sessions FOR INSERT WITH CHECK (((owner_id = ( SELECT auth.uid() AS uid)) AND ((space_kind = 'personal'::text) OR public.is_class_member(space_ref))));

CREATE POLICY sessions_select ON public.sessions FOR SELECT USING (((owner_id = ( SELECT auth.uid() AS uid)) OR ((space_kind = 'class'::text) AND public.is_class_teacher(space_ref))));

CREATE POLICY sessions_select_admin ON public.sessions FOR SELECT USING (public.is_admin());

CREATE POLICY sessions_update_owner ON public.sessions FOR UPDATE USING ((owner_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((owner_id = ( SELECT auth.uid() AS uid)));

ALTER TABLE public.textbook_figures ENABLE ROW LEVEL SECURITY;

CREATE POLICY textbook_figures_select ON public.textbook_figures FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.files f
  WHERE ((f.id = textbook_figures.file_id) AND ((f.owner_id = ( SELECT auth.uid() AS uid)) OR ((f.kind = 'textbook'::text) AND public.is_class_member(f.space_ref)))))));

