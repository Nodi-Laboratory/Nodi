/**
 * 필기 인식(OCR) — 펜으로 쓴 질문을 글자로 (D171).
 *
 * ## 계약
 *
 *   POST {API_BASE}/ocr/handwriting
 *   Content-Type: multipart/form-data
 *     image  (필수) 흰 배경에 검은 획, PNG. 사방 여백 포함(`renderInkPng`)
 *     lang   (선택) BCP-47. 기본 "ko"
 *   200 → { "text": "빛의 굴절이 뭐야?", "confidence": null }
 *
 * 백엔드(`routers/ocr.py`)가 자체 GPU의 VARCO-VISION-2.0-1.7B-OCR 서버로
 * 넘긴다. **모델 서버를 브라우저에서 직접 부르지 않는다** — 그쪽은 인증이
 * 없고 CORS가 모두 열려 있어, 주소가 곧 공개 GPU 창구가 된다.
 *
 * `confidence`는 자리만 있고 늘 null이다(VARCO는 점수를 주지 않는다). 있어도
 * **낮은 값으로 입력을 막지 않는다** — 인식 결과는 학생이 고칠 초안이고,
 * 막으면 다시 쓰는 수밖에 없다.
 *
 * ## 창구가 없거나 꺼져 있으면
 *
 * 라우터가 없으면 404, 모델 서버 주소가 설정되지 않았으면 501이다. 둘 다
 * "학생 잘못이 아니고 지금은 자판으로 쓰면 된다"는 뜻이라 한 문구로 모은다
 * (`OcrNotReadyError`). 502(모델 서버가 안 받음)는 **다른 갈래다** — 그건
 * 잠시 뒤에 다시 하면 되는 상태다.
 *
 * ## 오래 걸린다
 *
 * 실측 3~8초. 모델 서버가 요청을 GPU 락으로 **직렬 처리**하므로 한 반이
 * 동시에 누르면 그만큼 줄을 선다. 타임아웃을 걸지 않고 기다린다 — 끊으면
 * 학생은 다시 써야 하고, 그 사이 GPU는 이미 그 그림을 읽고 있다.
 */
import { API_BASE, ApiError, authHeaders, ensureOk } from "./_core";

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

/**
 * 손글씨 그림 → 글자.
 *
 * `signal`로 취소할 수 있다 — 인식이 도는 동안 학생이 입력판을 닫거나 화면을
 * 떠날 수 있고, 그때 온 응답을 입력창에 꽂으면 안 된다.
 */
export async function recognizeHandwriting(
  image: Blob,
  opts: { lang?: string; signal?: AbortSignal } = {},
): Promise<HandwritingOcrResult> {
  const form = new FormData();
  // 파일명은 서버가 확장자로 형식을 볼 수 있게 준다(Blob은 이름이 없다).
  form.append("image", image, "handwriting.png");
  form.append("lang", opts.lang ?? "ko");

  // 네트워크 끊김·취소는 fetch가 그대로 던진다(취소는 호출부가 AbortError로 가려낸다).
  const res = await fetch(`${API_BASE}/ocr/handwriting`, {
    method: "POST",
    // multipart의 boundary는 브라우저가 정한다 — Content-Type을 직접 넣으면 깨진다.
    headers: await authHeaders(),
    body: form,
    signal: opts.signal,
  });

  if (res.status === 404 || res.status === 501) throw new OcrNotReadyError();

  const body = (await ensureOk(res).then((r) => r.json())) as {
    text?: unknown;
    confidence?: unknown;
  };
  return {
    text: typeof body.text === "string" ? body.text : "",
    confidence:
      typeof body.confidence === "number" ? body.confidence : undefined,
  };
}

/** 인식 실패를 학생이 읽을 문구로. 취소는 호출부가 먼저 걸러 여기 오지 않는다. */
export function ocrErrorMessage(err: unknown): string {
  if (err instanceof OcrNotReadyError) return err.message;
  if (err instanceof ApiError) {
    if (err.status === 413) return "글씨가 너무 커요. 조금 나눠서 써 주세요.";
    if (err.status === 429) return "잠시 뒤에 다시 시도해 주세요.";
    if (err.status >= 500) return "인식이 잠시 안 돼요. 다시 시도해 주세요.";
    if (err.message && !err.message.startsWith("HTTP ")) return err.message;
  }
  return "인식하지 못했어요. 다시 시도하거나 자판으로 입력해 주세요.";
}
