"use client";

/**
 * 세션 선택 페이지 (사용자 지시 2026-08-09).
 *
 * 사이드바의 [세션]이 여기로 온다. 화면 자체는 `SpacePicker`가 갖는다 —
 * 페이지는 라우트 껍데기만 맡는다.
 */

import { SpacePicker } from "@/components/spaces/SpacePicker";

export default function SessionsPage() {
  return <SpacePicker />;
}
