/**
 * 손글씨 + 펜 표시 인식 (D178).
 *
 * ## 계약
 *
 *   POST {API_BASE}/ink/interpret
 *   Content-Type: multipart/form-data
 *     ink_png    (필수) 획만 그린 흰 종이 PNG — OCR로 간다
 *     scene_png  (선택) 카드까지 그린 도식 PNG — 비전 모델로 간다
 *     figure_png (선택) 도판 확대본
 *     figure_n   (선택) 그 도판이 몇 번 카드인가
 *     cards      (선택) [{"n":1,"title":"천문학"}, …] JSON
 *   200 → { text, marks_note, pointed, confidence }
 *
 * `ocr.ts`와 나란한 창구다. 저쪽은 **카드 없이 그냥 쓴 경우**의 경로이자
 * 이쪽이 죽었을 때의 폴백이라 그대로 둔다 — 오류 문구도 저쪽 것을 함께 쓴다
 * (`ocrErrorMessage`). 학생에게는 같은 기능이라 문구가 갈리면 안 된다.
 *
 * ## 표시 해석이 실패해도 이 호출은 성공한다
 *
 * `marks_note`가 빈 문자열로 올 뿐이다. 표시는 **곁들이**고 질문 자체는
 * 손글씨다 — RAG가 채팅을 막지 않는 것과 같은 성질이다.
 *
 * ## 오래 걸린다
 *
 * OCR 3~8초 + 비전 5~20초가 **동시에** 돈다(GPU가 갈라져 있다). 타임아웃을
 * 걸지 않고 기다린다 — 끊으면 학생은 다시 써야 하고, 그 사이 GPU는 이미
 * 그 그림을 읽고 있다.
 */
import { API_BASE, authHeaders, ensureOk } from "./_core";
import { OcrNotReadyError } from "./ocr";

/**
 * 학생이 그린 표시 하나 — **기하가 센 사실**이지 모델의 판단이 아니다.
 *
 * 번호는 `InkCardRef.n`과 같은 것이다. 카드마다 낱말 하나만 보내면 "화살표가
 * [카드 1]에서 [카드 3]으로 향한다"를 말할 수 없다 — 그 문장은 카드가 아니라
 * 표시에 딸린 사실이라 표시 단위로 보내야 한다.
 */
export type InkTextSource = "varco" | "vision_fallback" | "unknown";

export interface InkGestureRef {
  i: number;
  shape: string;
  encloses: number[];
  within: number[];
  points: number[];
  from: number[];
  crosses: number[];
}

/** 도식에 그려진 카드 — 번호가 곧 VLM 출력의 `[카드 N]`이다. */
export interface InkCardRef {
  n: number;
  itemId: string;
  title: string;
  /** "맨 윗줄 가운데" — 번호를 못 읽는 모델을 위한 두 번째 단서. */
  where: string;
  /** 기하로 센 표시 종류 — 프롬프트에 사실로 실어 준다. */
  mark: string;
}

/**
 * 표시 해석이 어떻게 끝났나.
 *
 * `marksNote`가 비는 갈래가 여럿이라(꺼짐·미설정·도식 없음·서버 오류) 결과만
 * 보면 구분이 안 된다. 관리자 실험실이 "왜 안 읽혔나"에 답하려면 이유가 결과와
 * 함께 와야 한다.
 */
export type InkMarksStatus =
  | "ok"
  | "off"
  | "unconfigured"
  | "no_scene"
  | "no_cards"
  | "error";

export interface InkInterpretResult {
  /** 손글씨를 읽은 글자. 못 읽었으면 빈 문자열(오류가 아니다). */
  text: string;
  /** 표시가 무엇을 가리키는지. 해석이 실패했으면 빈 문자열. */
  marksNote: string;
  /** 위가 비었을 때 **왜** 비었는지. */
  marksStatus: InkMarksStatus;
  /**
   * 글자를 어느 길로 읽었나 (2026-08-10).
   *
   * `varco` 전용 OCR · `vision_fallback` 예비(비전) · `unknown` 옛 서버.
   * **예비가 도는 것은 고장 신호다** — 학생 화면은 멀쩡해도 정확도가 내려가
   * 있다.
   */
  textSource: InkTextSource;
}

const STATUSES: ReadonlySet<string> = new Set([
  "ok",
  "off",
  "unconfigured",
  "no_scene",
  "no_cards",
  "error",
]);

export interface InkInterpretInput {
  ink: Blob;
  scene?: Blob | null;
  figure?: Blob | null;
  figureN?: number | null;
  cards?: readonly InkCardRef[];
  gestures?: readonly InkGestureRef[];
  signal?: AbortSignal;
}

export async function interpretInk({
  ink,
  scene,
  figure,
  figureN,
  cards,
  gestures,
  signal,
}: InkInterpretInput): Promise<InkInterpretResult> {
  const form = new FormData();
  // 파일명은 서버가 확장자로 형식을 볼 수 있게 준다(Blob은 이름이 없다).
  form.append("ink_png", ink, "handwriting.png");
  if (scene) form.append("scene_png", scene, "scene.png");
  if (figure) form.append("figure_png", figure, "figure.png");
  if (figureN) form.append("figure_n", String(figureN));
  if (cards?.length) {
    // itemId는 보내지 않는다 — 서버는 번호와 제목만 있으면 프롬프트를 만들고,
    // 카드 본문은 채팅 턴에서 id로 다시 읽는다(D104 신뢰 경계).
    form.append(
      "cards",
      JSON.stringify(
        cards.map((c) => ({
          n: c.n,
          title: c.title,
          where: c.where,
          mark: c.mark,
        })),
      ),
    );
  }
  if (gestures?.length) form.append("gestures", JSON.stringify(gestures));

  const res = await fetch(`${API_BASE}/ink/interpret`, {
    method: "POST",
    // multipart의 boundary는 브라우저가 정한다 — Content-Type을 직접 넣으면 깨진다.
    headers: await authHeaders(),
    body: form,
    signal,
  });

  // 창구가 없거나(404) 모델 서버가 미설정(501)이면 ocr.ts와 같은 갈래다.
  if (res.status === 404 || res.status === 501) throw new OcrNotReadyError();

  const body = (await ensureOk(res).then((r) => r.json())) as {
    text?: unknown;
    marks_note?: unknown;
    marks_status?: unknown;
    text_source?: unknown;
  };
  return {
    text: typeof body.text === "string" ? body.text : "",
    marksNote: typeof body.marks_note === "string" ? body.marks_note : "",
    // 옛 서버(이 필드가 없던 시절)와 붙어도 화면이 깨지지 않게.
    textSource:
      body.text_source === "varco" || body.text_source === "vision_fallback"
        ? body.text_source
        : "unknown",
    marksStatus:
      typeof body.marks_status === "string" && STATUSES.has(body.marks_status)
        ? (body.marks_status as InkMarksStatus)
        : "ok",
  };
}

/**
 * 도판 받기 시한(ms).
 *
 * **이 값이 없으면 질문이 영영 안 나간다.** 도판 바이트는 학생이 [글자 인식]을
 * 누른 **뒤, OCR을 부르기 전에** 받는다 — 스토리지가 멎으면 그 자리에서 멈추고
 * 화면은 "인식 중"인 채로 남는다. 도판은 **곁들이**이므로 늦으면 버리고 간다
 * (라벨 상자로 그려진다).
 */
const FIGURE_TIMEOUT_MS = 6000;

/**
 * 도판 원본 바이트 → 비트맵.
 *
 * **`<img>`로 받지 않는다.** 다른 출처의 이미지를 그린 캔버스는 오염돼
 * `toBlob`이 `SecurityError`를 던진다 — 도식 내보내기가 통째로 실패한다.
 * `fetch`는 `<img>`와 달리 Authorization을 실을 수 있어서, 우리가 바이트를
 * 직접 들고 그리면 오염이 성립하지 않는다.
 *
 * 실패는 null이다 — 도판 하나 때문에 질문이 막히면 안 된다(라벨 상자로 그린다).
 */
export async function fetchFigureBitmap(
  figureId: string,
  signal?: AbortSignal,
): Promise<ImageBitmap | null> {
  // 호출부의 취소와 우리 시한을 함께 건다. 어느 쪽이든 먼저 끊으면 끝난다.
  const bell = AbortSignal.timeout(FIGURE_TIMEOUT_MS);
  const stop = signal ? AbortSignal.any([signal, bell]) : bell;
  try {
    const res = await fetch(`${API_BASE}/files/figures/${figureId}/raw`, {
      headers: await authHeaders(),
      signal: stop,
    });
    if (!res.ok) return null;
    return await createImageBitmap(await res.blob());
  } catch {
    return null;
  }
}
