# 교과서 임베딩 폴더

admin 개발자가 교과서 원문을 넣고 인제스트 파이프라인을 돌리는 폴더입니다.
서비스 런타임은 결과물(Qdrant `textbook` 컬렉션)만 읽습니다.

## 사용법

1. 이 폴더에 교과서 파일(`.pdf` / `.txt` / `.md`)을 넣는다.
2. (선택) `manifest.json`에 파일별 메타를 적는다 — `manifest.example.json`
   참고. 항목이 없는 파일은 `source_name = 파일명(확장자 제외)`,
   과목/학년 빈 값으로 인제스트된다.
3. `backend/`에서 실행한다 (root `.env`에 `UPSTAGE_API_KEY`, `QDRANT_URL` 필요):

       python scripts/ingest_textbook.py             # 이 폴더 스캔 → 업서트
       python scripts/ingest_textbook.py --dry-run   # 파싱·청킹 미리보기만

같은 `source_name`으로 재실행하면 기존 포인트를 지우고 새로 넣는다(중복 없음).
PDF는 dry-run에서도 Upstage Document Parse를 호출하므로 API 키가 필요하다.

교과서 원문은 저작권·용량 문제로 git에 커밋하지 않는다(.gitignore 처리 —
이 README와 manifest.example.json만 커밋).
