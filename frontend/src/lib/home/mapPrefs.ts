/**
 * 지도 목록의 기억 (D191) — 어떤 대화를 껐고 어떤 폴더를 접었나.
 *
 * ## 저장하는 것은 **부정 목록**이다
 *
 * 숨긴 것과 접은 것만 적는다. 반대로 "보이는 것"을 저장하면 **내일 한 대화가
 * 지도에 안 뜬다** — 저장 목록에 없으니까. 학생 눈에는 고장이고, 원인은 어제
 * 누른 체크박스라 아무도 못 잇는다. 기본값이 언제나 "보임"·"펼침"이어야 하고,
 * 그 성질은 끈 것만 기억할 때 공짜로 성립한다.
 *
 * 순수 계산(`sessionTree.ts`)과 분리해 둔다 — 이쪽은 브라우저를 만지므로
 * 테스트가 못 도는 코드다. 섞으면 순수 모듈이 오염된다.
 */

const HIDDEN_KEY = "nodi.home.hiddenSessions";
const COLLAPSED_KEY = "nodi.home.collapsedFolders";

/**
 * 저장값 읽기.
 *
 * 실패를 삼킨다 — 사파리 프라이빗 모드는 `localStorage` 접근 자체가 던지고,
 * 남이 넣은 쓰레기 값도 있을 수 있다. 어느 쪽이든 **전부 보임**으로 시작하는
 * 것이 맞다: 기억을 못 하는 것이 지도를 못 보는 것보다 낫다.
 */
function readSet(key: string): string[] {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

function writeSet(key: string, value: ReadonlySet<string>): void {
  try {
    if (value.size === 0) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify([...value]));
  } catch {
    // 저장이 안 돼도 이번 세션 동안은 화면이 정상이다.
  }
}

export const loadHiddenSessions = (): string[] => readSet(HIDDEN_KEY);
export const saveHiddenSessions = (v: ReadonlySet<string>): void =>
  writeSet(HIDDEN_KEY, v);

export const loadCollapsedFolders = (): string[] => readSet(COLLAPSED_KEY);
export const saveCollapsedFolders = (v: ReadonlySet<string>): void =>
  writeSet(COLLAPSED_KEY, v);
