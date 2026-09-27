# RLS 정책 목록

권한 검사는 **Postgres RLS**가 한다(D104). 공개판 정리(2026-09-27)에서 이 정책들을
백엔드 코드로 옮기지 않고 그대로 두기로 했다 — Supabase 전용 요소는 이미 없고
(`auth.uid()`는 `db/00_bootstrap.sql`의 자체 함수로, `SET LOCAL app.user_id`를 읽는다),
권한 모델을 앱 코드로 다시 쓰면 그 과정에서 구멍이 생길 수 있어서다.

- 사용자 요청은 `nodi_app` 역할(RLS 적용)로, 워커·인증은 `nodi_worker`(BYPASSRLS)로 돈다.
- `public.users`(비밀번호 해시)는 `nodi_app`에 GRANT 자체가 없다 — 정책보다 앞선 방어.
- 정본은 DB다. 다시 뽑으려면:
  `select tablename, policyname, cmd, qual, with_check from pg_policies where schemaname='public';`

정책 71개 · 표 24개 (2026-09-27, 데모 스택에서 추출)

## `ai_logs`

| 정책 | 명령 | USING | WITH CHECK |
|---|---|---|---|
| `ai_logs_insert_own` | INSERT | `—` | `(owner_id = ( SELECT auth.uid() AS uid))` |
| `ai_logs_select_admin` | SELECT | `( SELECT is_admin() AS is_admin)` | `—` |
| `ai_logs_select_own` | SELECT | `(owner_id = ( SELECT auth.uid() AS uid))` | `—` |

## `app_settings`

| 정책 | 명령 | USING | WITH CHECK |
|---|---|---|---|
| `app_settings_admin_insert` | INSERT | `—` | `( SELECT is_admin() AS is_admin)` |
| `app_settings_admin_select` | SELECT | `( SELECT is_admin() AS is_admin)` | `—` |
| `app_settings_admin_update` | UPDATE | `( SELECT is_admin() AS is_admin)` | `( SELECT is_admin() AS is_admin)` |

## `canvas_drawings`

| 정책 | 명령 | USING | WITH CHECK |
|---|---|---|---|
| `canvas_drawings_select` | SELECT | `(session_id IN ( SELECT accessible_session_ids() AS accessible_session_ids))` | `—` |
| `canvas_drawings_select_admin` | SELECT | `( SELECT is_admin() AS is_admin)` | `—` |
| `canvas_drawings_write_owner` | ALL | `(EXISTS ( SELECT 1 FROM sessions s WHERE ((s.id = canvas_drawings.session_id) AND (s.owner_id = ( SELECT auth.uid() AS uid)))))` | `(EXISTS ( SELECT 1 FROM sessions s WHERE ((s.id = canvas_drawings.session_id) AND (s.owner_id = ( SELECT auth.uid() AS uid)))))` |

## `canvas_items`

| 정책 | 명령 | USING | WITH CHECK |
|---|---|---|---|
| `canvas_items_delete_owner` | DELETE | `(EXISTS ( SELECT 1 FROM sessions s WHERE ((s.id = canvas_items.session_id) AND (s.owner_id = ( SELECT auth.uid() AS uid)))))` | `—` |
| `canvas_items_insert_owner` | INSERT | `—` | `(EXISTS ( SELECT 1 FROM sessions s WHERE ((s.id = canvas_items.session_id) AND (s.owner_id = ( SELECT auth.uid() AS uid)))))` |
| `canvas_items_select` | SELECT | `(session_id IN ( SELECT accessible_session_ids() AS accessible_session_ids))` | `—` |
| `canvas_items_select_admin` | SELECT | `( SELECT is_admin() AS is_admin)` | `—` |
| `canvas_items_update_owner` | UPDATE | `(EXISTS ( SELECT 1 FROM sessions s WHERE ((s.id = canvas_items.session_id) AND (s.owner_id = ( SELECT auth.uid() AS uid)))))` | `—` |

## `chunk_atoms`

| 정책 | 명령 | USING | WITH CHECK |
|---|---|---|---|
| `chunk_atoms_select_admin` | SELECT | `( SELECT is_admin() AS is_admin)` | `—` |
| `chunk_atoms_select_class` | SELECT | `(EXISTS ( SELECT 1 FROM files f WHERE ((f.id = chunk_atoms.file_id) AND (f.kind = ANY (ARRAY['class_material'::text, 'textbook'::text])) AND (f.space_ref IN ( SELECT my_class_ids() AS my_class_ids)))))` | `—` |
| `chunk_atoms_select_own` | SELECT | `(EXISTS ( SELECT 1 FROM files f WHERE ((f.id = chunk_atoms.file_id) AND (f.owner_id = ( SELECT auth.uid() AS uid)))))` | `—` |

## `class_lecture_packages`

| 정책 | 명령 | USING | WITH CHECK |
|---|---|---|---|
| `clp_select_member` | SELECT | `((class_id IN ( SELECT my_class_ids() AS my_class_ids)) OR ( SELECT is_admin() AS is_admin))` | `—` |
| `clp_write_teacher` | ALL | `(class_id IN ( SELECT my_taught_class_ids() AS my_taught_class_ids))` | `(class_id IN ( SELECT my_taught_class_ids() AS my_taught_class_ids))` |

## `class_members`

| 정책 | 명령 | USING | WITH CHECK |
|---|---|---|---|
| `class_members_delete_self` | DELETE | `(user_id = ( SELECT auth.uid() AS uid))` | `—` |
| `class_members_select` | SELECT | `((user_id = ( SELECT auth.uid() AS uid)) OR (class_id IN ( SELECT my_class_ids() AS my_class_ids)))` | `—` |
| `class_members_select_admin` | SELECT | `( SELECT is_admin() AS is_admin)` | `—` |

## `classes`

| 정책 | 명령 | USING | WITH CHECK |
|---|---|---|---|
| `classes_insert_teacher` | INSERT | `—` | `((teacher_id = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1 FROM profiles p WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = 'teacher'::text)))))` |
| `classes_select_admin` | SELECT | `( SELECT is_admin() AS is_admin)` | `—` |
| `classes_select_member` | SELECT | `((teacher_id = ( SELECT auth.uid() AS uid)) OR (id IN ( SELECT my_class_ids() AS my_class_ids)))` | `—` |
| `classes_update_teacher` | UPDATE | `(teacher_id = ( SELECT auth.uid() AS uid))` | `(teacher_id = ( SELECT auth.uid() AS uid))` |

## `clip_thumbnails`

| 정책 | 명령 | USING | WITH CHECK |
|---|---|---|---|
| `clip_thumbnails_select` | SELECT | `(( SELECT auth.uid() AS uid) IS NOT NULL)` | `—` |
| `clip_thumbnails_write_admin` | ALL | `( SELECT is_admin() AS is_admin)` | `( SELECT is_admin() AS is_admin)` |

## `crosslink_runs`

| 정책 | 명령 | USING | WITH CHECK |
|---|---|---|---|
| `crosslink_runs_select_admin` | SELECT | `( SELECT is_admin() AS is_admin)` | `—` |

## `file_chunks`

| 정책 | 명령 | USING | WITH CHECK |
|---|---|---|---|
| `file_chunks_select_admin` | SELECT | `( SELECT is_admin() AS is_admin)` | `—` |
| `file_chunks_select_class` | SELECT | `(EXISTS ( SELECT 1 FROM files f WHERE ((f.id = file_chunks.file_id) AND (f.kind = ANY (ARRAY['class_material'::text, 'textbook'::text])) AND (f.space_ref IN ( SELECT my_class_ids() AS my_class_ids)))))` | `—` |
| `file_chunks_select_own` | SELECT | `(EXISTS ( SELECT 1 FROM files f WHERE ((f.id = file_chunks.file_id) AND (f.owner_id = ( SELECT auth.uid() AS uid)))))` | `—` |

## `files`

| 정책 | 명령 | USING | WITH CHECK |
|---|---|---|---|
| `files_delete_own` | DELETE | `(owner_id = ( SELECT auth.uid() AS uid))` | `—` |
| `files_insert_own` | INSERT | `—` | `((owner_id = ( SELECT auth.uid() AS uid)) AND ((kind <> ALL (ARRAY['class_material'::text, 'textbook'::text])) OR (space_ref IN ( SELECT my_taught_class_ids() AS my_taught_class_ids))))` |
| `files_select_admin` | SELECT | `( SELECT is_admin() AS is_admin)` | `—` |
| `files_select_class` | SELECT | `((kind = ANY (ARRAY['class_material'::text, 'textbook'::text])) AND (space_ref IN ( SELECT my_class_ids() AS my_class_ids)))` | `—` |
| `files_select_own` | SELECT | `(owner_id = ( SELECT auth.uid() AS uid))` | `—` |
| `files_update_own` | UPDATE | `(owner_id = ( SELECT auth.uid() AS uid))` | `((owner_id = ( SELECT auth.uid() AS uid)) AND ((kind <> ALL (ARRAY['class_material'::text, 'textbook'::text])) OR (space_ref IN ( SELECT my_taught_class_ids() AS my_taught_class_ids))))` |

## `hand_fonts`

| 정책 | 명령 | USING | WITH CHECK |
|---|---|---|---|
| `hand_fonts_select_all` | SELECT | `true` | `—` |
| `hand_fonts_write_admin` | ALL | `( SELECT is_admin() AS is_admin)` | `( SELECT is_admin() AS is_admin)` |

## `item_links`

| 정책 | 명령 | USING | WITH CHECK |
|---|---|---|---|
| `item_links_delete_owner` | DELETE | `(owner_id = ( SELECT auth.uid() AS uid))` | `—` |
| `item_links_select` | SELECT | `(owner_id = ( SELECT auth.uid() AS uid))` | `—` |
| `item_links_select_admin` | SELECT | `( SELECT is_admin() AS is_admin)` | `—` |
| `item_links_update_owner` | UPDATE | `(owner_id = ( SELECT auth.uid() AS uid))` | `—` |

## `jobs`

| 정책 | 명령 | USING | WITH CHECK |
|---|---|---|---|
| `jobs_select_own` | SELECT | `((owner_id = ( SELECT auth.uid() AS uid)) OR ( SELECT is_admin() AS is_admin))` | `—` |

## `lecture_clip_atoms`

| 정책 | 명령 | USING | WITH CHECK |
|---|---|---|---|
| `lecture_clip_atoms_admin` | ALL | `( SELECT is_admin() AS is_admin)` | `( SELECT is_admin() AS is_admin)` |
| `lecture_clip_atoms_select` | SELECT | `(auth.uid() IS NOT NULL)` | `—` |

## `lecture_clips`

| 정책 | 명령 | USING | WITH CHECK |
|---|---|---|---|
| `lecture_clips_admin` | ALL | `( SELECT is_admin() AS is_admin)` | `( SELECT is_admin() AS is_admin)` |
| `lecture_clips_select` | SELECT | `(auth.uid() IS NOT NULL)` | `—` |

## `lecture_packages`

| 정책 | 명령 | USING | WITH CHECK |
|---|---|---|---|
| `lecture_packages_admin` | ALL | `( SELECT is_admin() AS is_admin)` | `( SELECT is_admin() AS is_admin)` |
| `lecture_packages_select` | SELECT | `(auth.uid() IS NOT NULL)` | `—` |

## `lecture_videos`

| 정책 | 명령 | USING | WITH CHECK |
|---|---|---|---|
| `lecture_videos_admin` | ALL | `( SELECT is_admin() AS is_admin)` | `( SELECT is_admin() AS is_admin)` |
| `lecture_videos_select` | SELECT | `(auth.uid() IS NOT NULL)` | `—` |

## `nodes`

| 정책 | 명령 | USING | WITH CHECK |
|---|---|---|---|
| `nodes_delete_owner` | DELETE | `(EXISTS ( SELECT 1 FROM sessions s WHERE ((s.id = nodes.session_id) AND (s.owner_id = ( SELECT auth.uid() AS uid)))))` | `—` |
| `nodes_insert_owner` | INSERT | `—` | `(EXISTS ( SELECT 1 FROM sessions s WHERE ((s.id = nodes.session_id) AND (s.owner_id = ( SELECT auth.uid() AS uid)))))` |
| `nodes_select` | SELECT | `(session_id IN ( SELECT accessible_session_ids() AS accessible_session_ids))` | `—` |
| `nodes_select_admin` | SELECT | `( SELECT is_admin() AS is_admin)` | `—` |
| `nodes_update_owner` | UPDATE | `(EXISTS ( SELECT 1 FROM sessions s WHERE ((s.id = nodes.session_id) AND (s.owner_id = ( SELECT auth.uid() AS uid)))))` | `—` |

## `onboarding_answers`

| 정책 | 명령 | USING | WITH CHECK |
|---|---|---|---|
| `onboarding_answers_insert_own` | INSERT | `—` | `(user_id = ( SELECT auth.uid() AS uid))` |
| `onboarding_answers_select_own` | SELECT | `(user_id = ( SELECT auth.uid() AS uid))` | `—` |
| `onboarding_answers_update_own` | UPDATE | `(user_id = ( SELECT auth.uid() AS uid))` | `—` |

## `profiles`

| 정책 | 명령 | USING | WITH CHECK |
|---|---|---|---|
| `profiles_select_admin` | SELECT | `( SELECT is_admin() AS is_admin)` | `—` |
| `profiles_select_own` | SELECT | `(id = ( SELECT auth.uid() AS uid))` | `—` |
| `profiles_update_own` | UPDATE | `(id = ( SELECT auth.uid() AS uid))` | `(id = ( SELECT auth.uid() AS uid))` |

## `sessions`

| 정책 | 명령 | USING | WITH CHECK |
|---|---|---|---|
| `sessions_delete_owner` | DELETE | `(owner_id = ( SELECT auth.uid() AS uid))` | `—` |
| `sessions_insert_owner` | INSERT | `—` | `((owner_id = ( SELECT auth.uid() AS uid)) AND ((space_kind = 'personal'::text) OR (space_ref IN ( SELECT my_class_ids() AS my_class_ids))))` |
| `sessions_select` | SELECT | `((owner_id = ( SELECT auth.uid() AS uid)) OR ((space_kind = 'class'::text) AND (space_ref IN ( SELECT my_taught_class_ids() AS my_taught_class_ids))))` | `—` |
| `sessions_select_admin` | SELECT | `( SELECT is_admin() AS is_admin)` | `—` |
| `sessions_update_owner` | UPDATE | `(owner_id = ( SELECT auth.uid() AS uid))` | `(owner_id = ( SELECT auth.uid() AS uid))` |

## `textbook_figures`

| 정책 | 명령 | USING | WITH CHECK |
|---|---|---|---|
| `textbook_figures_select` | SELECT | `(EXISTS ( SELECT 1 FROM files f WHERE ((f.id = textbook_figures.file_id) AND ((f.owner_id = ( SELECT auth.uid() AS uid)) OR ((f.kind = 'textbook'::text) AND (f.space_ref IN ( SELECT my_class_ids() AS my_class_ids)))))))` | `—` |
| `textbook_figures_select_admin` | SELECT | `( SELECT is_admin() AS is_admin)` | `—` |
