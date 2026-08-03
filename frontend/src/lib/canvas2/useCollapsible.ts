"use client";

/**
 * 접었다 펼 수 있는 화면 고정 패널의 상태 (D140).
 *
 * 지도와 도구 레일이 같은 규칙을 쓴다 — 둘 다 캔버스를 가리는 물건이고,
 * 학생이 치웠으면 **치운 채로 있어야 한다.**
 *
 * ## 왜 기억하나
 *
 * 기억하지 않으면 접기가 사실상 쓸모없다. 새로고침이나 페이지 이동마다 다시
 * 펼쳐지면, 치우려고 누른 학생은 매번 다시 눌러야 한다.
 *
 * ## 왜 localStorage인가
 *
 * 서버에 둘 값이 아니다 — 계정 설정이 아니라 이 기기에서 보기 편한 방식이고,
 * 저장 실패가 학습을 막아서도 안 된다. 사생활 모드나 저장 거부 환경에서
 * 던지므로 읽기·쓰기 모두 감싼다.
 *
 * ## 왜 useSyncExternalStore인가
 *
 * localStorage는 React 밖의 저장소다. 이펙트에서 읽어 setState하는 방식은
 * (a) 렌더 한 번을 더 태우고 (b) React Compiler가 막는다
 * (`react-hooks/set-state-in-effect`). 이 훅은 **서버 스냅샷을 따로 받는**
 * 구조라 하이드레이션 불일치도 설계상 없다 — 서버는 기본값, 클라이언트는
 * 저장값을 본다.
 */

import { useCallback, useSyncExternalStore } from "react";

const PREFIX = "nodi.canvas.panel.";

/** 같은 키를 보는 패널이 여럿일 수 있으므로 구독은 전역으로 둔다. */
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  // 다른 탭에서 바꾼 것도 따라간다.
  window.addEventListener("storage", cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}

/**
 * 저장값. 없거나 못 읽으면 null.
 *
 * **원시값을 돌려줘야 한다.** 객체를 새로 만들어 돌려주면 매 렌더 참조가 달라져
 * `useSyncExternalStore`가 무한 루프로 본다.
 */
function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(PREFIX + key, value);
  } catch {
    // 저장 못 하는 환경이면 기억되지 않을 뿐, 화면은 정상이다.
  }
  emit();
}

function read(key: string): boolean | null {
  const v = readRaw(key);
  return v === null ? null : v === "1";
}

export function useCollapsible(
  key: string,
  defaultOpen: boolean,
): { open: boolean; setOpen: (v: boolean) => void; toggle: () => void } {
  const stored = useSyncExternalStore(
    subscribe,
    () => read(key),
    // 서버에는 저장값이 없다 — 호출부 기본값으로 그린다.
    () => null,
  );

  const open = stored ?? defaultOpen;

  const setOpen = useCallback((v: boolean) => write(key, v ? "1" : "0"), [key]);

  const toggle = useCallback(() => setOpen(!open), [open, setOpen]);

  return { open, setOpen, toggle };
}

/**
 * 목록에서 고른 값 하나를 기억한다 (D150 — 펜 색·형광펜 색).
 *
 * 접기와 같은 이유로 기억한다: 파란 펜으로 필기하던 학생이 새로고침마다
 * 검정으로 돌아가면 매번 다시 골라야 한다.
 *
 * 저장값이 `allowed`에 없으면 기본값으로 돌아간다 — 색 구성을 바꾼 뒤에도
 * 존재하지 않는 색이 켜져 있는 상태가 생기지 않는다.
 */
export function useStickyChoice(
  key: string,
  allowed: readonly string[],
  fallback: string,
): { value: string; set: (v: string) => void } {
  const stored = useSyncExternalStore(
    subscribe,
    () => readRaw(key),
    () => null,
  );
  return {
    value: stored && allowed.includes(stored) ? stored : fallback,
    set: useCallback((v: string) => write(key, v), [key]),
  };
}
