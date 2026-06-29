"use client";

import { useEffect, useRef, useState } from "react";
import { Settings, X } from "lucide-react";
import { useWorkspacePrefs } from "@/store/useWorkspacePrefs";
import { useNavigatorDefaults } from "@/lib/queries";

/**
 * D47: 워크스페이스 우상단 톱니 → 개인 설정 팝오버.
 * 자료 제안 on/off, 네비게이터 자동생성 on/off·개수·생성 시점. prefs store(localStorage) 연동.
 */
export function WorkspaceSettings() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const fileSuggestionEnabled = useWorkspacePrefs((s) => s.fileSuggestionEnabled);
  const setFileSuggestionEnabled = useWorkspacePrefs(
    (s) => s.setFileSuggestionEnabled,
  );
  const navigatorEnabled = useWorkspacePrefs((s) => s.navigatorEnabled);
  const setNavigatorEnabled = useWorkspacePrefs((s) => s.setNavigatorEnabled);
  const navigatorCount = useWorkspacePrefs((s) => s.navigatorCount);
  const navigatorCountCustomized = useWorkspacePrefs(
    (s) => s.navigatorCountCustomized,
  );
  const setNavigatorCount = useWorkspacePrefs((s) => s.setNavigatorCount);
  const resetNavigatorCount = useWorkspacePrefs((s) => s.resetNavigatorCount);
  const navigatorGateK = useWorkspacePrefs((s) => s.navigatorGateK);
  const setNavigatorGateK = useWorkspacePrefs((s) => s.setNavigatorGateK);

  // D55b: 서버 유효 기본값(관리자 기본). 미커스터마이즈면 이 숫자를 그대로 표시한다.
  const { data: defaults } = useNavigatorDefaults();
  // 표시 숫자: 커스터마이즈됨 → 사용자 값, 아니면 서버 기본(로딩 전엔 클라 fallback).
  const shownCount = navigatorCountCustomized
    ? navigatorCount
    : defaults?.question_count ?? navigatorCount;
  const shownGateK = navigatorGateK ?? defaults?.gate_k;

  // 바깥 클릭으로 닫기
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="워크스페이스 설정"
        className={`flex items-center justify-center rounded-lg border p-1.5 transition-colors ${
          open
            ? "border-accent-deep bg-accent text-accent-fg"
            : "border-accent-border/50 text-fg-muted hover:text-fg"
        }`}
      >
        <Settings size={16} />
      </button>

      {open && (
        <div className="absolute right-0 top-10 z-50 w-72 rounded-xl border border-accent-border/50 bg-bg-elevated p-3 shadow-xl">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold text-fg">개인 설정</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-fg-muted hover:text-fg"
              aria-label="닫기"
            >
              <X size={14} />
            </button>
          </div>

          <div className="flex flex-col gap-3">
            <Toggle
              label="자료 제안 받기"
              hint="질문과 관련된 자료를 자동으로 제안합니다."
              checked={fileSuggestionEnabled}
              onChange={setFileSuggestionEnabled}
            />

            <div className="border-t border-accent-border/20 pt-3">
              <Toggle
                label="네비게이터 자동생성"
                hint="대화 흐름에 맞춰 추천 질문을 자동으로 띄웁니다."
                checked={navigatorEnabled}
                onChange={setNavigatorEnabled}
              />
              <div
                className={`mt-3 flex flex-col gap-3 ${
                  navigatorEnabled ? "" : "pointer-events-none opacity-50"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <label className="text-xs text-fg">
                    추천 질문 개수
                    {!navigatorCountCustomized ? (
                      <span className="block text-[10px] text-fg-muted">
                        관리자 기본값 사용 중
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={resetNavigatorCount}
                        className="block text-left text-[10px] text-accent-deep hover:underline"
                      >
                        기본값으로
                      </button>
                    )}
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min={1}
                      max={5}
                      step={1}
                      value={shownCount}
                      onChange={(e) => setNavigatorCount(Number(e.target.value))}
                      className="w-28 accent-[#e0a32e]"
                    />
                    <span className="w-8 text-right text-xs font-medium text-fg">
                      {shownCount}
                    </span>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-2">
                  <label className="text-xs text-fg">
                    생성 시점
                    <span className="block text-[10px] text-fg-muted">
                      분기 노드 수가 이만큼부터
                    </span>
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={shownGateK ?? ""}
                    onChange={(e) => {
                      const v = e.target.value.trim();
                      setNavigatorGateK(v === "" ? undefined : Number(v));
                    }}
                    className="w-16 rounded-md border border-accent-border/50 bg-bg px-2 py-1 text-right text-xs text-fg"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-2">
      <div>
        <p className="text-xs font-medium text-fg">{label}</p>
        {hint ? <p className="text-[10px] text-fg-muted">{hint}</p> : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-5 w-10 shrink-0 rounded-full transition-colors ${
          checked ? "bg-accent-deep" : "bg-fg-muted/40"
        }`}
      >
        {/* D55a: thumb를 명시 좌표(left)로 이동 — translate 누적/클리핑 제거. */}
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-[left] ${
            checked ? "left-[calc(100%-1.125rem)]" : "left-0.5"
          }`}
        />
      </button>
    </div>
  );
}
