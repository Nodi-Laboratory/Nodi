/**
 * 필기 인식의 **오류 어휘** (D176 → D178).
 *
 * ## 여기 있던 클라이언트는 사라졌다
 *
 * `recognizeHandwriting`이 `POST /ocr/handwriting`을 부르던 곳이다. D178에서
 * 손글씨와 펜 표시를 **한 번에** 읽는 창구(`ink.ts` → `/ink/interpret`)로
 * 옮기면서 화면은 더 이상 이 함수를 부르지 않아, 죽은 코드를 남기지 않고
 * 지웠다. **백엔드 `/api/ocr/handwriting`은 그대로 살아 있다** — 계약과
 * 테스트가 붙어 있고, 손으로 확인할 때 쓸 수 있는 창구다.
 *
 * 남은 것은 두 갈래를 **학생이 읽을 한국어로 옮기는 규칙**이고, 새 창구가
 * 그대로 쓴다. 문구가 갈리면 같은 기능이 다르게 말하게 된다.
 *
 * ## 창구가 없거나 꺼져 있으면
 *
 * 라우터가 없으면 404, 모델 서버 주소가 설정되지 않았으면 501이다. 둘 다
 * "학생 잘못이 아니고 지금은 자판으로 쓰면 된다"는 뜻이라 한 문구로 모은다
 * (`OcrNotReadyError`). 502(모델 서버가 안 받음)는 **다른 갈래다** — 그건
 * 잠시 뒤에 다시 하면 되는 상태다.
 *
 * 인식 점수(`confidence`)로 입력을 막지 않는다 — 결과는 학생이 고칠 초안이고,
 * 막으면 다시 쓰는 수밖에 없다.
 */
import { ApiError } from "./_core";

export interface HandwritingOcrResult {
  text: string;
  /** 0~1. 모델이 줄 때만. */
  confidence?: number;
}

/** 서버에 아직 인식 창구가 없다(404/501). 고장이 아니라 미완성이다. */
export class OcrNotReadyError extends Error {
  constructor() {
    super("필기 인식 기능을 준비하고 있어요. 지금은 자판으로 입력해 주세요.");
    this.name = "OcrNotReadyError";
  }
}

/**
 * 펜 버튼을 아예 감출 수 있는 스위치.
 *
 * 기본은 **켬**이다 — 미리 만들어 두는 UI라 개발 중에도 보여야 한다.
 * 배포에서 아직 감추고 싶으면 `NEXT_PUBLIC_HANDWRITING_OCR=off`.
 *
 * `process.env`의 `NEXT_PUBLIC_*`는 빌드 시점에 문자열로 박히므로 이 상수를
 * 모듈 최상단에서 읽어도 안전하다(런타임에 바뀌지 않는다).
 */
export const HANDWRITING_ENABLED =
  process.env.NEXT_PUBLIC_HANDWRITING_OCR !== "off";

/** 인식 실패를 학생이 읽을 문구로. 취소는 호출부가 먼저 걸러 여기 오지 않는다. */
export function ocrErrorMessage(err: unknown): string {
  if (err instanceof OcrNotReadyError) return err.message;
  if (err instanceof ApiError) {
    if (err.status === 413) return "글씨가 너무 커요. 조금 나눠서 써 주세요.";
    if (err.status === 429) return "잠시 뒤에 다시 시도해 주세요.";
    /**
     * 503은 **고장이 아니라 붐비는 것**이다 (D177). 인식 서버는 GPU 락으로
     * 요청을 한 건씩 처리해서, 한 반이 동시에 누르면 뒤쪽이 밀린다. 학생이
     * 할 일도 다르다 — 잠깐 뒤 다시 누르면 된다. "안 돼요"로 뭉개면 기능이
     * 망가진 줄 알고 자판으로 돌아간다.
     */
    if (err.status === 503) {
      return "지금 친구들이 많이 쓰고 있어요. 잠시 후 다시 눌러 주세요.";
    }
    if (err.status >= 500) return "인식이 잠시 안 돼요. 다시 시도해 주세요.";
    if (err.message && !err.message.startsWith("HTTP ")) return err.message;
  }
  return "인식하지 못했어요. 다시 시도하거나 자판으로 입력해 주세요.";
}
