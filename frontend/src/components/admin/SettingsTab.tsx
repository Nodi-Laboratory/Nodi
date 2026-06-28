"use client";

import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { listAdminSettings, putAdminSetting } from "@/lib/api";
import type { AdminSetting } from "@/lib/types";

/**
 * D43: 런타임 설정 탭 — 자유 JSON 입력 대신 통제 위젯(select/slider/number/toggle) + 설명.
 * 미등록 키는 JSON 텍스트 폴백(하위호환). wired='live'는 즉시반영, 'deferred'는 후속반영 뱃지.
 */

type Widget = "select" | "slider" | "number" | "toggle" | "json";

interface SettingSpec {
  label: string;
  group: string;
  widget: Widget;
  options?: { value: string | number; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  description: string;
  effect: string;
  wired: "live" | "deferred";
}

const MODEL_OPTIONS = [
  { value: "gemini-2.5-flash", label: "2.5 Flash (정확·약간 느림)" },
  { value: "gemini-2.5-flash-lite", label: "2.5 Flash Lite (빠름·저렴)" },
];

const SETTINGS: Record<string, SettingSpec> = {
  // ── 모델 ──
  chat_model: {
    label: "대화 모델",
    group: "모델",
    widget: "select",
    options: MODEL_OPTIONS,
    description: "답변 생성에 쓰는 모델. Lite는 빠르고 저렴, Flash는 더 정확.",
    effect: "답변 품질·속도·비용",
    wired: "deferred",
  },
  label_model: {
    label: "라벨 모델",
    group: "모델",
    widget: "select",
    options: MODEL_OPTIONS,
    description: "노드 라벨(요약) 생성 모델.",
    effect: "라벨 품질·비용",
    wired: "deferred",
  },
  tag_model: {
    label: "태그 모델",
    group: "모델",
    widget: "select",
    options: MODEL_OPTIONS,
    description: "개념 태그 추출 모델.",
    effect: "태그 품질·비용",
    wired: "deferred",
  },
  navigator_model: {
    label: "네비게이터 모델",
    group: "모델",
    widget: "select",
    options: MODEL_OPTIONS,
    description: "추천 질문 생성 모델.",
    effect: "추천 질문 품질·비용",
    wired: "deferred",
  },

  // ── 자료 제안 ──
  file_suggestion_enabled: {
    label: "자료 제안 사용",
    group: "자료 제안",
    widget: "toggle",
    description: "전역으로 자료 제안 기능을 켜고 끕니다.",
    effect: "채팅 자료 제안 노출 여부",
    wired: "deferred",
  },
  file_suggestion_max_distance: {
    label: "자료 제안 엄격도(거리 컷오프)",
    group: "자료 제안",
    widget: "slider",
    min: 0.4,
    max: 0.6,
    step: 0.01,
    description: "작을수록 더 엄격 — 관련성 높은 자료만 제안. 0.50 권장.",
    effect: '채팅 "연결할까요?" 노출 빈도',
    wired: "live",
  },
  file_suggestion_min_query_chars: {
    label: "제안 최소 질문 길이",
    group: "자료 제안",
    widget: "number",
    min: 0,
    max: 200,
    step: 5,
    unit: "자",
    description: "분기 질문 텍스트가 이보다 짧으면 제안하지 않음(인사·잡담 차단).",
    effect: "잡담 방의 오탐 제안 차단",
    wired: "deferred",
  },

  // ── 네비게이터 ──
  navigator_enabled: {
    label: "네비게이터 자동생성",
    group: "네비게이터",
    widget: "toggle",
    description: "전역으로 추천 질문 자동생성을 켜고 끕니다.",
    effect: "추천 질문 노드 생성 여부",
    wired: "deferred",
  },
  navigator_question_count: {
    label: "네비게이터 추천 개수",
    group: "네비게이터",
    widget: "slider",
    min: 1,
    max: 5,
    step: 1,
    description: "한 번에 띄우는 추천 질문 수.",
    effect: "네비게이터 묶음 크기",
    wired: "deferred",
  },
  navigator_k: {
    label: "네비게이터 게이트 K",
    group: "네비게이터",
    widget: "number",
    min: 1,
    max: 10,
    step: 1,
    description: "분기 노드 수가 이만큼부터 추천 질문을 생성.",
    effect: "추천 질문 생성 시점",
    wired: "deferred",
  },
  navigator_period: {
    label: "네비게이터 주기",
    group: "네비게이터",
    widget: "number",
    min: 1,
    max: 20,
    step: 1,
    description: "이 주기마다 추천 질문을 재생성.",
    effect: "추천 질문 재생성 빈도",
    wired: "deferred",
  },

  // ── ReAct / 노드 ──
  react_max_steps: {
    label: "ReAct 최대 스텝",
    group: "ReAct",
    widget: "slider",
    min: 1,
    max: 10,
    step: 1,
    description: "에이전트가 도구를 호출하는 최대 추론 단계 수.",
    effect: "복잡한 질문 처리력 · 응답 시간",
    wired: "deferred",
  },
  react_max_tokens: {
    label: "ReAct 최대 토큰",
    group: "ReAct",
    widget: "number",
    min: 10000,
    max: 200000,
    step: 10000,
    unit: "토큰",
    description: "한 턴에서 쓰는 최대 토큰 예산.",
    effect: "맥락 길이 · 비용",
    wired: "deferred",
  },
  max_tags_per_node: {
    label: "노드당 최대 태그",
    group: "노드",
    widget: "slider",
    min: 1,
    max: 5,
    step: 1,
    description: "한 노드에 붙는 개념 태그 최대 개수.",
    effect: "태그 밀도",
    wired: "deferred",
  },
  node_label_max_chars: {
    label: "노드 라벨 최대 길이",
    group: "노드",
    widget: "slider",
    min: 4,
    max: 16,
    step: 1,
    unit: "자",
    description: "그래프 노드 아래 라벨의 최대 글자 수.",
    effect: "그래프 가독성",
    wired: "deferred",
  },
};

export function SettingsTab() {
  const { data: settings, isLoading, isError } = useQuery<AdminSetting[]>({
    queryKey: ["admin", "settings"],
    queryFn: listAdminSettings,
  });

  if (isLoading)
    return <p className="text-sm text-[#9a948a]">설정 불러오는 중…</p>;
  if (isError)
    return <p className="text-sm text-[#e0796a]">설정을 불러오지 못했습니다.</p>;

  const list = settings ?? [];
  // 그룹별 정렬(등록된 키는 그룹, 미등록은 "기타").
  const groups = new Map<string, AdminSetting[]>();
  for (const s of list) {
    const g = SETTINGS[s.key]?.group ?? "기타";
    const arr = groups.get(g) ?? [];
    arr.push(s);
    groups.set(g, arr);
  }
  const groupOrder = [
    "모델",
    "자료 제안",
    "네비게이터",
    "ReAct",
    "노드",
    "기타",
  ];
  const orderedGroups = Array.from(groups.keys()).sort(
    (a, b) => groupOrder.indexOf(a) - groupOrder.indexOf(b),
  );

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-sm font-semibold text-[#e7e3d8]">런타임 설정</h2>
      <div className="flex items-start gap-2 rounded border border-[#e0a32e]/40 bg-[#e0a32e]/10 px-3 py-2 text-xs text-[#e7d9b0]">
        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[#e0a32e]" />
        <span>
          &quot;즉시 반영&quot; 뱃지가 없는 설정은 저장되더라도 다음 배포/후속
          작업 후 적용됩니다. 미등록 키는 JSON으로 직접 편집합니다.
        </span>
      </div>

      {list.length === 0 ? (
        <p className="text-sm text-[#9a948a]">설정 항목이 없습니다.</p>
      ) : (
        orderedGroups.map((g) => (
          <div key={g} className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[#9a948a]">
              {g}
            </h3>
            {groups
              .get(g)!
              .map((s) => <SettingRow key={s.key} setting={s} />)}
          </div>
        ))
      )}
    </div>
  );
}

function SettingRow({ setting }: { setting: AdminSetting }) {
  const queryClient = useQueryClient();
  const spec = SETTINGS[setting.key];
  const [draft, setDraft] = useState<unknown>(setting.value);
  const [jsonDraft, setJsonDraft] = useState(() =>
    JSON.stringify(setting.value),
  );
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const widget: Widget = spec?.widget ?? "json";
  const dirty =
    widget === "json"
      ? jsonDraft !== JSON.stringify(setting.value)
      : JSON.stringify(draft) !== JSON.stringify(setting.value);

  const save = async (value: unknown) => {
    setMsg(null);
    setErr(null);
    setSaving(true);
    try {
      await putAdminSetting(setting.key, value);
      await queryClient.invalidateQueries({ queryKey: ["admin", "settings"] });
      setMsg("저장되었습니다.");
    } catch (e) {
      setErr(`저장 실패: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveJson = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonDraft);
    } catch {
      setErr('JSON 형식이 올바르지 않습니다. (문자열은 "따옴표", 숫자는 숫자)');
      return;
    }
    void save(parsed);
  };

  return (
    <div className="rounded-lg border border-white/10 bg-[#25211a] p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-[#fcf58b]">
            {spec?.label ?? setting.key}
          </span>
          {spec ? (
            <code className="text-[10px] text-[#9a948a]">{setting.key}</code>
          ) : null}
          {spec?.wired === "live" ? (
            <span className="rounded bg-[#6e8a3c]/30 px-1.5 py-0.5 text-[10px] font-medium text-[#9bbf6a]">
              즉시 반영
            </span>
          ) : spec ? (
            <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-[#9a948a]">
              후속 반영
            </span>
          ) : null}
        </div>
        <span className="shrink-0 text-xs text-[#9a948a]">
          {setting.updated_at
            ? new Date(setting.updated_at).toLocaleString("ko-KR")
            : "—"}
        </span>
      </div>

      {spec ? (
        <p className="mt-1 text-xs text-[#cfc5a6]">
          {spec.description}{" "}
          <span className="text-[#9a948a]">→ {spec.effect}</span>
        </p>
      ) : null}

      <div className="mt-2 flex items-center gap-2">
        {widget === "toggle" ? (
          <ToggleWidget
            checked={!!draft}
            onChange={(v) => {
              setDraft(v);
              void save(v);
            }}
          />
        ) : widget === "select" ? (
          <SelectWidget
            value={String(draft ?? "")}
            options={spec!.options ?? []}
            onChange={(v) => {
              setDraft(v);
              void save(v);
            }}
          />
        ) : widget === "slider" ? (
          <SliderWidget
            value={Number(draft ?? spec!.min ?? 0)}
            min={spec!.min ?? 0}
            max={spec!.max ?? 1}
            step={spec!.step ?? 1}
            unit={spec!.unit}
            onChange={(v) => setDraft(v)}
            onCommit={(v) => void save(v)}
          />
        ) : widget === "number" ? (
          <NumberWidget
            value={Number(draft ?? spec!.min ?? 0)}
            min={spec!.min}
            max={spec!.max}
            step={spec!.step}
            unit={spec!.unit}
            onChange={(v) => setDraft(v)}
          />
        ) : (
          <input
            type="text"
            value={jsonDraft}
            onChange={(e) => setJsonDraft(e.target.value)}
            spellCheck={false}
            className="flex-1 rounded border border-white/15 bg-[#1b1813] px-2 py-1.5 font-mono text-sm text-[#e7e3d8]"
          />
        )}

        {(widget === "json" || widget === "number") && (
          <button
            type="button"
            onClick={() =>
              widget === "json" ? handleSaveJson() : void save(draft)
            }
            disabled={saving || !dirty}
            className="rounded bg-[#e0a32e] px-3 py-1.5 text-sm font-medium text-[#2a2a24] hover:brightness-110 disabled:opacity-50"
          >
            저장
          </button>
        )}
      </div>

      {err && <p className="mt-1 text-xs text-[#e0796a]">{err}</p>}
      {msg && <p className="mt-1 text-xs text-[#9bbf6a]">{msg}</p>}
    </div>
  );
}

function ToggleWidget({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
        checked ? "bg-[#6e8a3c]" : "bg-white/20"
      }`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
          checked ? "translate-x-4" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

function SelectWidget({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string | number; label: string }[];
  onChange: (v: string) => void;
}) {
  const has = options.some((o) => String(o.value) === value);
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="flex-1 rounded border border-white/15 bg-[#1b1813] px-2 py-1.5 text-sm text-[#e7e3d8]"
    >
      {!has && value ? <option value={value}>{value} (현재)</option> : null}
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function SliderWidget({
  value,
  min,
  max,
  step,
  unit,
  onChange,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (v: number) => void;
  onCommit: (v: number) => void;
}) {
  // 포인터 드래그 중에는 onChange가 연속 발화 → 저장 폭주를 막고 종료 시 1회 commit.
  // 키보드 화살표 등 비포인터 조작은 onChange에서 즉시 반영·commit(접근성).
  const draggingRef = useRef(false);
  return (
    <div className="flex flex-1 items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onPointerDown={() => {
          draggingRef.current = true;
        }}
        onChange={(e) => {
          const v = Number(e.target.value);
          onChange(v);
          if (!draggingRef.current) onCommit(v); // 키보드/프로그램 조작 → 즉시 저장
        }}
        onPointerUp={(e) => {
          draggingRef.current = false;
          onCommit(Number((e.target as HTMLInputElement).value));
        }}
        className="flex-1 accent-[#e0a32e]"
      />
      <span className="w-16 text-right text-sm font-medium text-[#e7e3d8]">
        {value}
        {unit ? ` ${unit}` : ""}
      </span>
    </div>
  );
}

function NumberWidget({
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-32 rounded border border-white/15 bg-[#1b1813] px-2 py-1.5 text-sm text-[#e7e3d8]"
      />
      {unit ? <span className="text-xs text-[#9a948a]">{unit}</span> : null}
    </div>
  );
}
