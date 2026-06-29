"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ShieldAlert, X } from "lucide-react";
import { listAdminSettings, putAdminSetting } from "@/lib/api";
import type { AdminSetting } from "@/lib/types";

/**
 * D43/D61: 런타임 설정 탭 — 자유 JSON 입력 대신 통제 위젯(select/slider/number/toggle) + 설명.
 * 미등록 키는 JSON 텍스트 폴백(하위호환).
 *
 * D62: 거의 모든 키가 app_settings 오버레이로 런타임에 반영된다(wired='live'). 'deferred'는
 *      아직 배선되지 않은 항목.
 * D65: SettingSpec.risk 로 위험/적용범위를 표기 —
 *      'safe'(현행) | 'new-only'(신규 업로드부터 적용, 노랑 안내) |
 *      'danger'(임베딩 차원/모델: 빨강 경고 + 저장 전 확인 모달).
 */

type Widget = "select" | "slider" | "number" | "toggle" | "json";
type Risk = "safe" | "new-only" | "danger";

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
  /** D65: 위험/적용범위 티어. 생략 시 'safe'. */
  risk?: Risk;
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
    wired: "live",
  },
  label_model: {
    label: "라벨 모델",
    group: "모델",
    widget: "select",
    options: MODEL_OPTIONS,
    description: "노드 라벨(요약) 생성 모델.",
    effect: "라벨 품질·비용",
    wired: "live",
  },
  tag_model: {
    label: "태그 모델",
    group: "모델",
    widget: "select",
    options: MODEL_OPTIONS,
    description: "개념 태그 추출 모델.",
    effect: "태그 품질·비용",
    wired: "live",
  },
  navigator_model: {
    label: "네비게이터 모델",
    group: "모델",
    widget: "select",
    options: MODEL_OPTIONS,
    description: "추천 질문 생성 모델.",
    effect: "추천 질문 품질·비용",
    wired: "live",
  },
  ocr_model: {
    label: "OCR 모델",
    group: "모델",
    widget: "select",
    options: MODEL_OPTIONS,
    description: "이미지/스캔 자료에서 텍스트를 추출하는 모델.",
    effect: "OCR 정확도·비용",
    wired: "live",
  },

  // ── 자료 제안 ──
  file_suggestion_enabled: {
    label: "자료 제안 사용",
    group: "자료 제안",
    widget: "toggle",
    description: "전역으로 자료 제안 기능을 켜고 끕니다.",
    effect: "채팅 자료 제안 노출 여부",
    wired: "live",
  },
  file_suggestion_suggest_max_distance: {
    label: "자료 제안 엄격도(거리 컷오프)",
    group: "자료 제안",
    widget: "slider",
    min: 0.3,
    max: 0.5,
    step: 0.01,
    description: "작을수록 더 엄격 — 관련성 높은 자료만 제안. 0.38 권장.",
    effect: '채팅 "연결할까요?" 노출 빈도',
    wired: "live",
  },
  file_suggestion_suggest_margin: {
    label: "제안 마진(1·2위 거리차)",
    group: "자료 제안",
    widget: "slider",
    min: 0,
    max: 0.2,
    step: 0.01,
    description: "1위와 2위 자료의 거리차가 이보다 작으면 모호하다고 보고 제안 보류.",
    effect: "모호한 제안 억제",
    wired: "live",
  },
  file_suggestion_top_n: {
    label: "제안 자료 개수",
    group: "자료 제안",
    widget: "number",
    min: 1,
    max: 3,
    step: 1,
    description: "한 번에 제안할 자료 최대 개수.",
    effect: "제안 묶음 크기",
    wired: "live",
  },
  file_suggestion_search_k: {
    label: "제안 후보 검색 수(k)",
    group: "자료 제안",
    widget: "number",
    min: 5,
    max: 50,
    step: 1,
    description: "거리 계산을 위해 우선 가져오는 후보 청크 수.",
    effect: "제안 정확도·비용",
    wired: "live",
  },
  file_suggestion_suggest_query_chars: {
    label: "제안 질의 길이 상한",
    group: "자료 제안",
    widget: "number",
    min: 100,
    max: 1500,
    step: 50,
    unit: "자",
    description: "제안 판단에 쓰는 분기 질의 텍스트의 최대 글자 수.",
    effect: "제안 포커스·비용",
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
    wired: "live",
  },

  // ── RAG 주입 ──
  rag_top_k: {
    label: "RAG 주입 청크 수(top-k)",
    group: "RAG 주입",
    widget: "number",
    min: 1,
    max: 20,
    step: 1,
    description: "답변 생성 시 컨텍스트로 주입하는 자료 청크 최대 개수.",
    effect: "근거 풍부함 · 맥락 길이 · 비용",
    wired: "live",
  },

  // ── 네비게이터 ──
  navigator_enabled: {
    label: "네비게이터 자동생성",
    group: "네비게이터",
    widget: "toggle",
    description: "전역으로 추천 질문 자동생성을 켜고 끕니다.",
    effect: "추천 질문 노드 생성 여부",
    wired: "live",
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
    wired: "live",
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
    wired: "live",
  },
  navigator_c: {
    label: "네비게이터 공통 태그 게이트(c)",
    group: "네비게이터",
    widget: "number",
    min: 0,
    max: 5,
    step: 1,
    description: "분기들이 공통 태그를 이만큼 공유할 때만 추천 질문을 생성.",
    effect: "추천 질문 발동 엄격도",
    wired: "live",
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
    wired: "live",
  },

  // ── ReAct ──
  react_max_steps: {
    label: "ReAct 최대 스텝",
    group: "ReAct",
    widget: "slider",
    min: 1,
    max: 10,
    step: 1,
    description: "에이전트가 도구를 호출하는 최대 추론 단계 수.",
    effect: "복잡한 질문 처리력 · 응답 시간",
    wired: "live",
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
    wired: "live",
  },

  // ── 노드 ──
  max_tags_per_node: {
    label: "노드당 최대 태그",
    group: "노드",
    widget: "slider",
    min: 1,
    max: 5,
    step: 1,
    description: "한 노드에 붙는 개념 태그 최대 개수.",
    effect: "태그 밀도",
    wired: "live",
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
    wired: "live",
  },

  // ── 임베딩 ──
  file_max_bytes: {
    label: "업로드 최대 크기",
    group: "임베딩",
    widget: "number",
    min: 1048576,
    max: 104857600,
    step: 1048576,
    unit: "B",
    description: "한 파일의 최대 업로드 크기(바이트). 26214400 = 25MB.",
    effect: "업로드 허용 크기",
    wired: "live",
    risk: "safe",
  },
  // chunk_*/embedding_* 은 오버레이로 읽히지만 신규 업로드/임베딩 잡부터 적용되므로
  // live 뱃지 대신 risk 뱃지(신규만 적용/위험)로 적용시점을 표기한다.
  chunk_size_chars: {
    label: "청크 크기",
    group: "임베딩",
    widget: "number",
    min: 400,
    max: 4000,
    step: 100,
    unit: "자",
    description: "자료를 임베딩할 때 한 청크의 글자 수.",
    effect: "검색 단위 정밀도",
    wired: "deferred",
    risk: "new-only",
  },
  chunk_overlap_chars: {
    label: "청크 겹침",
    group: "임베딩",
    widget: "number",
    min: 0,
    max: 500,
    step: 10,
    unit: "자",
    description: "인접 청크 사이에 겹치는 글자 수(경계 문맥 보존).",
    effect: "경계 문맥 보존",
    wired: "deferred",
    risk: "new-only",
  },
  embedding_model: {
    label: "임베딩 모델",
    group: "임베딩",
    widget: "select",
    options: [
      { value: "gemini-embedding-001", label: "gemini-embedding-001 (기본)" },
    ],
    description:
      "자료/질의를 벡터로 변환하는 임베딩 모델. 모델이 바뀌면 임베딩 공간이 달라져 기존 청크와 비교 불가.",
    effect: "검색 품질 · 기존 인덱스 호환성",
    wired: "deferred",
    risk: "danger",
  },
  embedding_dimension: {
    label: "임베딩 차원",
    group: "임베딩",
    widget: "number",
    min: 768,
    max: 768,
    step: 1,
    description:
      "임베딩 벡터 차원. DB 컬럼은 vector(768) 고정 — 다른 값은 워커가 잡을 실패 처리(DB 미파손).",
    effect: "검색 인덱스 호환성",
    wired: "deferred",
    risk: "danger",
  },
};

const GROUP_ORDER = [
  "모델",
  "자료 제안",
  "RAG 주입",
  "임베딩",
  "네비게이터",
  "ReAct",
  "노드",
  "기타",
];

export function SettingsTab() {
  const { data: settings, isLoading, isError } = useQuery<AdminSetting[]>({
    queryKey: ["admin", "settings"],
    queryFn: listAdminSettings,
  });

  if (isLoading)
    return <p className="text-sm text-[#9a948a]">설정 불러오는 중…</p>;
  if (isError)
    return <p className="text-sm text-[#e0796a]">설정을 불러오지 못했습니다.</p>;

  // D63: 죽은 키는 SETTINGS에 없으므로, 알 수 없는 서버 키 중 명시 폐기 키는 숨긴다.
  const HIDDEN_KEYS = new Set(["file_suggestion_max_distance"]);
  const list = (settings ?? []).filter((s) => !HIDDEN_KEYS.has(s.key));

  // 그룹별 정렬(등록된 키는 그룹, 미등록은 "기타").
  const groups = new Map<string, AdminSetting[]>();
  for (const s of list) {
    const g = SETTINGS[s.key]?.group ?? "기타";
    const arr = groups.get(g) ?? [];
    arr.push(s);
    groups.set(g, arr);
  }
  const orderedGroups = Array.from(groups.keys()).sort(
    (a, b) => GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b),
  );

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-sm font-semibold text-[#e7e3d8]">런타임 설정</h2>
      <div className="flex items-start gap-2 rounded border border-[#e0a32e]/40 bg-[#e0a32e]/10 px-3 py-2 text-xs text-[#e7d9b0]">
        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[#e0a32e]" />
        <span>
          &quot;즉시 반영&quot; 뱃지가 붙은 설정은 저장 후 최대 20초 안에
          런타임에 적용됩니다. &quot;후속 반영&quot; 항목은 다음 배포/업로드부터
          적용됩니다. 미등록 키는 JSON으로 직접 편집합니다.
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
              .sort((a, b) => specOrder(a.key) - specOrder(b.key))
              .map((s) => <SettingRow key={s.key} setting={s} />)}
          </div>
        ))
      )}
    </div>
  );
}

/** SETTINGS 선언 순서를 그룹 내 정렬 기준으로 사용(미등록 키는 뒤로). */
const SPEC_KEYS = Object.keys(SETTINGS);
function specOrder(key: string): number {
  const i = SPEC_KEYS.indexOf(key);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
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
  // D65: danger 키 저장 전 확인 모달. 대기 중 저장값을 보관.
  const [confirmValue, setConfirmValue] = useState<{ value: unknown } | null>(
    null,
  );

  const widget: Widget = spec?.widget ?? "json";
  const risk: Risk = spec?.risk ?? "safe";
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

  /** danger 키는 확인 모달을 거치고, 그 외는 즉시 저장. */
  const requestSave = (value: unknown) => {
    if (risk === "danger") {
      setConfirmValue({ value });
      return;
    }
    void save(value);
  };

  const handleSaveJson = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonDraft);
    } catch {
      setErr('JSON 형식이 올바르지 않습니다. (문자열은 "따옴표", 숫자는 숫자)');
      return;
    }
    requestSave(parsed);
  };

  return (
    <div
      className={`rounded-lg border bg-[#25211a] p-3 ${
        risk === "danger" ? "border-[#b54a3a]/50" : "border-white/10"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-[#fcf58b]">
            {spec?.label ?? setting.key}
          </span>
          {spec ? (
            <code className="text-[10px] text-[#9a948a]">{setting.key}</code>
          ) : null}
          {/* live/deferred 뱃지는 'safe' 키에만. new-only/danger는 risk 뱃지가 적용시점을 설명. */}
          {spec && risk === "safe" && spec.wired === "live" ? (
            <span className="rounded bg-[#6e8a3c]/30 px-1.5 py-0.5 text-[10px] font-medium text-[#9bbf6a]">
              즉시 반영
            </span>
          ) : spec && risk === "safe" ? (
            <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-[#9a948a]">
              후속 반영
            </span>
          ) : null}
          {risk === "danger" ? (
            <span className="rounded bg-[#b54a3a]/25 px-1.5 py-0.5 text-[10px] font-medium text-[#e0796a]">
              위험
            </span>
          ) : risk === "new-only" ? (
            <span className="rounded bg-[#c2702a]/25 px-1.5 py-0.5 text-[10px] font-medium text-[#e0a86a]">
              신규만 적용
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

      {/* D65: 위험/적용범위 안내 박스 */}
      {risk === "danger" ? (
        <div className="mt-2 flex items-start gap-2 rounded border border-[#b54a3a]/40 bg-[#b54a3a]/10 px-2.5 py-1.5 text-[11px] text-[#e6a99e]">
          <ShieldAlert size={13} className="mt-0.5 shrink-0 text-[#b54a3a]" />
          <span>
            기존 임베딩/인덱스와 불일치 시 검색이 깨집니다. 변경 시 전체
            재임베딩이 필요하며 자동 재인덱싱은 수행되지 않습니다.
          </span>
        </div>
      ) : risk === "new-only" ? (
        <div className="mt-2 flex items-start gap-2 rounded border border-[#c2702a]/40 bg-[#c2702a]/10 px-2.5 py-1.5 text-[11px] text-[#e0c08e]">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-[#c2702a]" />
          <span>신규 업로드부터 적용됩니다. 기존 자료는 재업로드해야 반영됩니다.</span>
        </div>
      ) : null}

      <div className="mt-2 flex items-center gap-2">
        {widget === "toggle" ? (
          <ToggleWidget
            checked={!!draft}
            onChange={(v) => {
              setDraft(v);
              requestSave(v);
            }}
          />
        ) : widget === "select" ? (
          <SelectWidget
            value={String(draft ?? "")}
            options={spec!.options ?? []}
            onChange={(v) => {
              setDraft(v);
              requestSave(v);
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
            onCommit={(v) => requestSave(v)}
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
              widget === "json" ? handleSaveJson() : requestSave(draft)
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

      {confirmValue && (
        <ConfirmDialog
          label={spec?.label ?? setting.key}
          settingKey={setting.key}
          value={confirmValue.value}
          onCancel={() => {
            setConfirmValue(null);
            // 위젯 draft를 서버값으로 되돌림(취소 시 미저장 상태 유지)
            setDraft(setting.value);
          }}
          onConfirm={() => {
            const v = confirmValue.value;
            setConfirmValue(null);
            void save(v);
          }}
        />
      )}
    </div>
  );
}

/**
 * D65: danger 키 저장 전 확인 모달. "재인덱싱 필요" 안내 + 명시 확인 버튼.
 * 실수 방지를 위해 위험값 변경임을 분명히 고지한다.
 */
function ConfirmDialog({
  label,
  settingKey,
  value,
  onCancel,
  onConfirm,
}: {
  label: string;
  settingKey: string;
  value: unknown;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${label} 변경 확인`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-[#b54a3a]/50 bg-[#25211a] p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldAlert size={18} className="text-[#b54a3a]" />
            <h2 className="text-sm font-bold text-[#e7e3d8]">위험값 변경 확인</h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded p-1 text-[#9a948a] transition-colors hover:text-[#e7e3d8]"
            aria-label="닫기"
          >
            <X size={16} />
          </button>
        </div>
        <p className="text-sm text-[#cfc5a6]">
          <span className="font-semibold text-[#fcf58b]">{label}</span>{" "}
          (<code className="text-[11px] text-[#9a948a]">{settingKey}</code>) 값을{" "}
          <code className="rounded bg-[#1b1813] px-1.5 py-0.5 text-[12px] text-[#e7e3d8]">
            {JSON.stringify(value)}
          </code>{" "}
          (으)로 변경합니다.
        </p>
        <div className="mt-3 rounded border border-[#b54a3a]/40 bg-[#b54a3a]/10 px-3 py-2 text-[12px] text-[#e6a99e]">
          기존 임베딩/인덱스와 불일치 시 검색이 깨집니다. 변경 후에는 전체
          재임베딩이 필요하며, 자동 재인덱싱은 수행되지 않습니다.
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-white/15 px-3 py-1.5 text-sm text-[#cfc5a6] transition-colors hover:text-[#e7e3d8]"
          >
            취소
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-lg bg-[#b54a3a] px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:brightness-110"
          >
            변경 적용
          </button>
        </div>
      </div>
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
