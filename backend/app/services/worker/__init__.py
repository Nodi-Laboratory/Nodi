"""백그라운드 임베딩 워커 (Stage 3b-1).

apscheduler가 `jobs(status='queued')`를 폴링해 서비스 롤 클라이언트(RLS 우회)로
처리한다. 워커 DSN이 없으면 비활성.

잡 흐름 (architecture §5, D11 — split 후 배치 병렬):
  embedding_split : 파일 다운로드 → 텍스트 추출(PDF·이미지는 Upstage Document
                    Parse, 평문은 디코드) → 청킹 → file_chunks(pending) 적재 +
                    chunk_total·status='embedding' → embedding_batch 자식 잡 생성
  embedding_batch : 배치 청크 임베딩(Upstage passage, 1024d) → 벡터는 Qdrant
                    file_chunks에 업서트 → status='embedded', 진행률 재계산.
                    전 청크가 해소되면 파일 'indexed'(일부 실패 시 'partial')
  figure_batch    : 교과서 도판 크롭 · 캡션 확정 · 임베딩 (D86)

D105: 1,133줄 단일 모듈이던 것을 책임별로 쪼갰다. 한 파일에 잡 스케줄링 ·
스토리지 · 청킹 · 임베딩 · Qdrant · figure 파이프라인이 모두 들어 있어,
두 사람이 서로 다른 기능을 만져도 같은 파일에서 충돌했다.

바깥에서 필요한 것은 start/stop/poll_once/requeue_file뿐이다.
"""

from .runner import poll_once, requeue_file, start, stop

__all__ = ["poll_once", "requeue_file", "start", "stop"]
