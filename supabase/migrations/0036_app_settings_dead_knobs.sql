-- ============================================================================
-- nodi — migration 0036 (D82 부속 — admin 죽은 노브 잔여 정리)
--
-- DRAFT — 원격 적용은 배포 시(파일만 추가). 아래 5개 시드 키는 백엔드 리더가
-- 0건이라 admin 콘솔에 떠도 저장해봐야 아무 동작에도 반영되지 않는다(실측):
--   • chat_model            — gemini 채팅이 EXAONE으로 대체되며 소비 코드 소멸,
--                             config 키도 D80에서 제거.
--   • react_max_steps       — ReAct 엔진 소멸(레거시 삭제, D81 0033).
--   • react_max_tokens      — 동상.
--   • max_tags_per_node     — D80에서 config 키 제거(태그 생산자 소멸).
--   • node_label_max_chars  — D80에서 config 키 제거(라벨 생산자 소멸).
-- 프론트 SETTINGS 맵에서도 같은 5종을 제거했다. 비파괴: 삭제만 하며 런타임
-- 경로가 이미 사라져 오버레이 폴백도 필요 없다.
-- ============================================================================

delete from public.app_settings
 where key in (
   'chat_model',
   'react_max_steps',
   'react_max_tokens',
   'max_tags_per_node',
   'node_label_max_chars'
 );

-- End of 0036_app_settings_dead_knobs.sql
