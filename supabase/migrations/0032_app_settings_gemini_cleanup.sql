-- ============================================================================
-- nodi — migration 0032 (D80 — 인제스트 Gemini 잔재 설정 키 정리)
--
-- DRAFT — 원격 적용은 배포 시(파일만 추가). 파일 태깅/OCR/라벨 등 Gemini API
-- 경로는 배포 환경에 GOOGLE_GEMINI_API_KEY가 없어 한 번도 동작한 적 없고,
-- D80에서 생산자 코드를 제거하며 config.py의 대응 키(embedding_model·ocr_model·
-- embedding_dimension·tag_model)도 삭제했다. 이 시드 4행은 라이브 app_settings에
-- 실존하므로(admin 콘솔 노출) 대응해서 정리한다. 비파괴: 삭제만 하며 런타임
-- 경로가 이미 사라져 오버레이 폴백도 필요 없다.
-- ============================================================================

delete from public.app_settings
 where key in ('embedding_model', 'ocr_model', 'embedding_dimension', 'tag_model');

-- End of 0032_app_settings_gemini_cleanup.sql
