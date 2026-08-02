/**
 * 임시 id 패치 버퍼 (D147 후속 수정).
 *
 * 채팅 턴이 끝나면 아이템은 `_pending=false`가 되지만, 비동기 저장
 * (`createItems`→`replaceTemp`)이 진짜 id로 바꿔 주기 전까지 id가 `tmp-N`으로
 * 남는다. 그 창에서 학생이 카드를 끌면 `patch(tmp-N, …)`이 DB 경계 가드에
 * 막혀 "저장되지 않은 항목은 수정할 수 없습니다"로 실패했다.
 *
 * 그래서 임시 id 패치를 여기 버퍼에 모아 두었다가, `replaceTemp`가 진짜 id를
 * 알게 될 때 흘려보낸다 — 오류를 없앨 뿐 아니라 **드래그 위치도 보존한다**
 * (그냥 무시하면 저장이 끝나며 카드가 배치 자리로 튄다).
 */
import { isRealId } from "@/lib/ids";
import type { ItemPatch } from "@/lib/api/canvas";

/**
 * 버퍼에 쌓인 임시 id 패치를, 대응하는 진짜 id로 보낼 목록으로 바꾼다.
 *
 * `tempIds[i]`가 `savedIds[i]`로 바뀌었다는 정렬 대응을 전제한다(replaceTemp의
 * 계약과 같다). 흘린(또는 저장 실패로 진짜 id가 없는) 임시 id는 버퍼에서
 * 지운다 — 무한히 쌓이지 않게.
 */
export function drainPending(
  tempIds: readonly string[],
  savedIds: readonly (string | null | undefined)[],
  buffer: Map<string, ItemPatch>,
): { id: string; patch: ItemPatch }[] {
  const sends: { id: string; patch: ItemPatch }[] = [];
  tempIds.forEach((t, i) => {
    const patch = buffer.get(t);
    if (!patch) return;
    buffer.delete(t);
    const realId = savedIds[i];
    if (isRealId(realId)) sends.push({ id: realId, patch });
  });
  return sends;
}
