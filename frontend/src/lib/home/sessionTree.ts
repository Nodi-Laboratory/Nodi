/**
 * 지도에 무엇을 띄울지 고르는 목록 (D191) — 공간 폴더 × 대화 × 체크 상태.
 *
 * 지도는 "내가 무엇을 아는가"를 한 장에 펼치지만(D189), 한 장이라서 **골라 볼
 * 수가 없었다.** 지구과학만 보고 싶어도 개인 세션의 삼각함수가 같이 떠 있다.
 *
 * 집합 계산을 컴포넌트가 아니라 여기 두는 이유는 D189와 같다 — 3상태 체크박스가
 * 틀리는 방식은 **그럴싸하게** 틀린다(폴더는 켜졌는데 안의 대화 하나가 안 켜진
 * 것을 눈으로 잡을 수 없다). `lib/canvas2`가 지키는 규칙과 같은 규칙이다.
 */

import type { ConceptMapSession, ConceptNode } from "@/lib/api/conceptMap";
import type { HomeSpace, SpaceKind } from "@/lib/types";

/** 제목이 아직 없는 대화 — 목록의 다른 곳과 같은 말을 쓴다(SessionList.UNTITLED). */
export const UNTITLED_SESSION = "제목 없는 대화";

/** 공간 이름을 아직 못 받았을 때 쓰는 이름. */
const PERSONAL_FALLBACK = "개인 공간";
const CLASS_FALLBACK = "학급";

export interface TreeSession {
  id: string;
  title: string;
  /** 이 대화가 지도에 올린 개념 수. 0인 대화는 목록에 없다. */
  count: number;
  updatedAt: string;
}

export interface SessionFolder {
  /**
   * 폴더 키. 접힘 상태를 저장하는 것이 이 값이라 **공간마다 안정적**이어야 한다
   * — 이름으로 저장하면 선생님이 학급 이름을 바꾸는 순간 접어 둔 것이 펼쳐진다.
   */
  key: string;
  name: string;
  spaceKind: SpaceKind;
  /** 라우팅용 — 개인은 null이다. */
  spaceRef: string | null;
  sessions: TreeSession[];
  /** 폴더 안 개념 총합. */
  count: number;
}

/**
 * 공간 → 폴더 키.
 *
 * 개인 공간은 **ref를 안 본다.** 세션의 `space_ref`가 소유자 id일 때도 있고
 * null일 때도 있어서(홈 라우팅이 이미 그렇게 다룬다) ref를 섞으면 같은 개인
 * 공간이 폴더 둘로 갈린다.
 */
export function folderKey(kind: SpaceKind, ref: string | null): string {
  return kind === "class" && ref ? `class:${ref}` : "personal";
}

/** 공간 목록에서 이름을 찾는 표. 아직 안 왔으면 비어 있고, 그래도 지도는 뜬다. */
function nameTable(spaces: readonly HomeSpace[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of spaces) {
    const key = folderKey(s.space_kind, s.space_ref);
    const name = (s.name || "").trim();
    if (name) out.set(key, name);
  }
  return out;
}

/**
 * 개념·대화·공간을 폴더 트리로.
 *
 * **개념이 하나도 없는 대화는 안 낸다** (사용자 결정 2026-08-06). 끄고 켜도
 * 화면이 안 변하는 체크박스는 고장으로 읽힌다 — 학생은 자기가 뭘 잘못 눌렀다고
 * 생각하지, 그 대화에 개념이 없다고 생각하지 않는다. 같은 이유로 빈 폴더도
 * 안 낸다.
 */
export function buildSessionTree(
  nodes: readonly ConceptNode[],
  sessions: readonly ConceptMapSession[],
  spaces: readonly HomeSpace[] = [],
): SessionFolder[] {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    if (!n.session_id) continue;
    counts.set(n.session_id, (counts.get(n.session_id) ?? 0) + 1);
  }

  const names = nameTable(spaces);
  const folders = new Map<string, SessionFolder>();

  for (const s of sessions) {
    const count = counts.get(s.id) ?? 0;
    if (count === 0) continue;
    const key = folderKey(s.space_kind, s.space_ref);
    let folder = folders.get(key);
    if (!folder) {
      folder = {
        key,
        name:
          names.get(key) ??
          (key === "personal" ? PERSONAL_FALLBACK : CLASS_FALLBACK),
        spaceKind: key === "personal" ? "personal" : "class",
        spaceRef: key === "personal" ? null : key.slice("class:".length),
        sessions: [],
        count: 0,
      };
      folders.set(key, folder);
    }
    folder.sessions.push({
      id: s.id,
      title: (s.title || "").trim() || UNTITLED_SESSION,
      count,
      updatedAt: s.updated_at,
    });
    folder.count += count;
  }

  for (const f of folders.values()) {
    // 최근 대화가 위로. 같은 시각이면 제목순 — 순서가 새로고침마다 흔들리면
    // 어제 끈 체크박스를 다시 찾을 수 없다.
    f.sessions.sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title, "ko"),
    );
  }

  return [...folders.values()].sort((a, b) => {
    // 개인 공간이 언제나 먼저 — 학급은 늘었다 줄었다 하지만 개인은 늘 있다.
    if (a.spaceKind !== b.spaceKind) return a.spaceKind === "personal" ? -1 : 1;
    return a.name.localeCompare(b.name, "ko");
  });
}

export type CheckState = "all" | "some" | "none";

/**
 * 폴더의 3상태.
 *
 * 빈 폴더는 `buildSessionTree`가 안 내지만, 방어적으로 "all"을 준다 — "none"을
 * 주면 아무것도 없는 폴더가 꺼진 것처럼 보인다.
 */
export function folderCheckState(
  folder: SessionFolder,
  hidden: ReadonlySet<string>,
): CheckState {
  if (folder.sessions.length === 0) return "all";
  let shown = 0;
  for (const s of folder.sessions) if (!hidden.has(s.id)) shown += 1;
  if (shown === 0) return "none";
  if (shown === folder.sessions.length) return "all";
  return "some";
}

/** 대화 하나를 뒤집은 **새** 숨김 집합. 입력은 안 건드린다(React 상태다). */
export function toggleSession(
  hidden: ReadonlySet<string>,
  id: string,
): Set<string> {
  const next = new Set(hidden);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * 폴더를 통째로 켜거나 끈다.
 *
 * **일부만 켜져 있으면 전부 켠다.** 3상태 체크박스의 관례이고, 무엇보다
 * "일부 → 전부 끄기"로 두면 하나만 남기고 껐던 학생이 폴더를 눌렀을 때 그
 * 하나까지 사라진다 — 되돌리려면 전부 다시 켜야 한다.
 */
export function toggleFolder(
  hidden: ReadonlySet<string>,
  folder: SessionFolder,
): Set<string> {
  const next = new Set(hidden);
  const turnOn = folderCheckState(folder, hidden) !== "all";
  for (const s of folder.sessions) {
    if (turnOn) next.delete(s.id);
    else next.add(s.id);
  }
  return next;
}

/**
 * 저장해 둔 숨김 목록에서 **유령을 걷어낸다.**
 *
 * 지운 대화의 id가 계속 쌓이면 저장값이 무한히 자라고, 더 나쁘게는 새 대화가
 * 우연히 같은 id를 갖는 날 숨겨진 채로 시작한다. 지금 목록에 있는 것만 남긴다.
 */
export function pruneHidden(
  hidden: Iterable<string>,
  folders: readonly SessionFolder[],
): Set<string> {
  const known = new Set<string>();
  for (const f of folders) for (const s of f.sessions) known.add(s.id);
  const out = new Set<string>();
  for (const id of hidden) if (known.has(id)) out.add(id);
  return out;
}
