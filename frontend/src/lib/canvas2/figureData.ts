/**
 * 도판 data를 서버에 저장 가능한 형태로 (D147).
 *
 * signed URL은 6시간 뒤 만료된다 — 영속하면 화석이 된다(D87). 리사이즈처럼
 * data를 통째로 PATCH할 때 살아 있는 url이 실려 나가지 않게, 저장 직전
 * figure.url을 비운다. 화면 표시는 메모리의 값이 계속 쓰므로 영향이 없다.
 *
 * 원본을 변형하지 않는다 — 낙관적 갱신이 쥔 로컬 data는 살아 있는 url을
 * 그대로 두어 이미지가 사라지지 않아야 한다.
 */
import type { ItemData } from "./types";

export function figureDataForSave(data: ItemData): ItemData {
  if (!data.figure) return data;
  return { ...data, figure: { ...data.figure, url: "" } };
}
