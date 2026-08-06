"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, RotateCcw, ShieldAlert, X } from "lucide-react";
import { listAdminSettings, putAdminSetting, resetAdminSetting } from "@/lib/api";
import type { AdminSettingItem, AdminSettingsView } from "@/lib/types";
import { Badge, Failed, Loading, Panel } from "./ui";

/**
 * 설정 탭 (D43/D61/D65 → D113).
 *
 * D113에서 **스펙의 소유자가 서버로 옮겨졌다**. 라벨·범위·설명이 여기 있으면
 * 노브를 하나 추가할 때 서버·DB·프론트 세 곳이 어긋날 수 있고 실제로 그랬다.
 * 이제 이 파일은 서버가 준 스펙대로 위젯을 그리기만 한다.
 *
 * 반영 시점(scope)을 화면에 분명히 쓴다 — 이걸 모르면 값을 바꾸고 왜 안
 * 바뀌는지 헤맨다. 과거에 이미 처리된 작업은 되돌리지 않는다(신규분부터).
 */
export function SettingsTab() {
  const { data, isLoading, isError } = useQuery<AdminSettingsView>({
    queryKey: ["admin", "settings"],
    queryFn: listAdminSettings,
  });

  if (isLoading) return <Loading />;
  if (isError || !data) return <Failed />;

  const groups = new Map<string, AdminSettingItem[]>();
  for (const item of data.items) {
    const g = item.spec.group || "기타";
    groups.set(g, [...(groups.get(g) ?? []), item]);
  }
  const ordered = [...groups.keys()].sort(
    (a, b) =>
      (data.groups.indexOf(a) + 1 || 999) - (data.groups.indexOf(b) + 1 || 999),
  );
  const missing = data.items.filter((i) => i.missing_row);

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-sm font-semibold text-[#e7e3d8]">런타임 설정</h2>

      <div className="flex items-start gap-2 rounded border border-[#e0a32e]/40 bg-[#e0a32e]/10 px-3 py-2 text-xs leading-relaxed text-[#e7d9b0]">
        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[#e0a32e]" />
        <span>
          <b>즉시 반영</b> 항목은 저장 후 최대 {Math.round(data.ttl_seconds)}초 안에
          모든 프로세스에 적용됩니다(같은 프로세스는 즉시). 이미 끝난 작업을 되돌리지는
          않습니다 — 바뀐 값은 <b>그 뒤의 요청부터</b> 적용됩니다. <b>신규만 적용</b>
          항목은 이미 처리된 문서에 소급되지 않으며, 반영하려면 재업로드가 필요합니다.
        </span>
      </div>

      {missing.length > 0 && (
        <div className="flex items-start gap-2 rounded border border-[#e0796a]/40 bg-[#e0796a]/10 px-3 py-2 text-xs leading-relaxed text-[#e6a99e]">
          <ShieldAlert size={14} className="mt-0.5 shrink-0" />
          <span>
            DB에 행이 없는 설정 {missing.length}개(
            {missing.map((m) => m.key).join(", ")}) — 지금은 코드 기본값으로 돌고
            있습니다. 값을 한 번 저장하면 행이 생기고 이후 조정할 수 있습니다.
          </span>
        </div>
      )}

      {ordered.map((g) => (
        <div key={g} className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-[#9a948a]">
            {g}
          </h3>
          {groups.get(g)!.map((item) => (
            <SettingRow key={item.key} item={item} />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * 설명의 `**굵게**`만 실제 굵기로 그린다.
 *
 * 스펙 설명은 서버가 소유하고(D113) 이미 여러 노브가 `**`로 강조를 쓰고 있었다 —
 * 그런데 화면이 그걸 안 그려서 관리자에게는 **별표 두 개가 그대로** 보였다
 * (실측 2026-08-07, 콘솔 화면). 마크다운 라이브러리를 들이지 않는 이유는 이
 * 자리가 한 줄짜리 설명이기 때문이다. 문자열을 쪼개 넣으므로 HTML 주입 경로가
 * 없다 — `dangerouslySetInnerHTML`을 쓰면 서버 문자열이 곧 마크업이 된다.
 */
function bold(text: string) {
  return text.split(/\*\*(.+?)\*\*/g).map((part, i) =>
    // 정규식 캡처가 낀 자리(홀수 색인)만 강조다.
    i % 2 === 1 ? (
      <b key={i} className="font-semibold text-[#e7e3d8]">
        {part}
      </b>
    ) : (
      part
    ),
  );
}

function SettingRow({ item }: { item: AdminSettingItem }) {
  const qc = useQueryClient();
  const spec = item.spec;
  const [draft, setDraft] = useState<unknown>(item.value);
  const [jsonDraft, setJsonDraft] = useState(() => JSON.stringify(item.value));
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirmValue, setConfirmValue] = useState<{ value: unknown } | null>(null);

  // 서버 값이 바뀌면(저장·기본값 복귀 후 재조회) 드래프트를 맞춘다.
  //
  // effect가 아니라 **렌더 중 조정**이다. effect로 하면 낡은 값으로 한 번 그리고
  // 다시 그리는 연쇄 렌더가 되고, key로 리마운트하면 "저장했습니다" 문구가 즉시
  // 사라진다. React가 이 경우를 위해 권하는 패턴이다.
  const serverJson = JSON.stringify(item.value);
  const [seenJson, setSeenJson] = useState(serverJson);
  if (seenJson !== serverJson) {
    setSeenJson(serverJson);
    setDraft(item.value);
    setJsonDraft(serverJson);
  }

  const widget = spec.widget;
  const dirty =
    widget === "json"
      ? jsonDraft !== JSON.stringify(item.value)
      : JSON.stringify(draft) !== JSON.stringify(item.value);

  const save = async (value: unknown) => {
    setMsg(null);
    setErr(null);
    setSaving(true);
    try {
      await putAdminSetting(item.key, value);
      await qc.invalidateQueries({ queryKey: ["admin", "settings"] });
      setMsg("저장했습니다.");
    } catch (e) {
      setErr(`저장 실패: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setMsg(null);
    setErr(null);
    setSaving(true);
    try {
      await resetAdminSetting(item.key);
      await qc.invalidateQueries({ queryKey: ["admin", "settings"] });
      setMsg("기본값으로 되돌렸습니다.");
    } catch (e) {
      setErr(`복귀 실패: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const request = (value: unknown) => {
    if (spec.scope === "danger") {
      setConfirmValue({ value });
      return;
    }
    void save(value);
  };

  const saveJson = () => {
    try {
      request(JSON.parse(jsonDraft));
    } catch {
      setErr('JSON 형식이 올바르지 않습니다. (문자열은 "따옴표", 숫자는 숫자)');
    }
  };

  return (
    <Panel
      className={spec.scope === "danger" ? "!border-[#b54a3a]/50" : ""}
      title={
        <span className="flex flex-wrap items-center gap-2 normal-case tracking-normal">
          <span className="text-[13px] font-semibold text-[#fcf58b]">{spec.label}</span>
          <code className="text-[10px] text-[#9a948a]">{item.key}</code>
          <ScopeBadge scope={spec.scope} />
          {item.modified && <Badge tone="info">기본값에서 변경됨</Badge>}
          {item.missing_row && <Badge tone="bad">DB 행 없음</Badge>}
        </span>
      }
      right={
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-[#9a948a]">
            기본값 {JSON.stringify(item.default)}
          </span>
          {item.modified && (
            <button
              type="button"
              onClick={reset}
              disabled={saving}
              className="flex items-center gap-1 rounded border border-white/15 px-1.5 py-0.5 text-[10px] text-[#9a948a] hover:text-[#e7e3d8] disabled:opacity-40"
            >
              <RotateCcw size={10} />
              기본값
            </button>
          )}
        </div>
      }
    >
      <p className="text-xs leading-relaxed text-[#cfc5a6]">
        {bold(spec.description)}
        {spec.effect && <span className="text-[#9a948a]"> → {spec.effect}</span>}
      </p>

      {spec.scope === "danger" && (
        <div className="mt-2 flex items-start gap-2 rounded border border-[#b54a3a]/40 bg-[#b54a3a]/10 px-2.5 py-1.5 text-[11px] text-[#e6a99e]">
          <ShieldAlert size={13} className="mt-0.5 shrink-0 text-[#b54a3a]" />
          기존 임베딩·인덱스와 불일치하면 검색이 깨집니다. 전체 재임베딩이 필요하며
          자동 재인덱싱은 하지 않습니다.
        </div>
      )}
      {spec.scope === "new-only" && (
        <div className="mt-2 flex items-start gap-2 rounded border border-[#c2702a]/40 bg-[#c2702a]/10 px-2.5 py-1.5 text-[11px] text-[#e0c08e]">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-[#c2702a]" />
          이미 처리된 문서에는 소급되지 않습니다 — 신규 업로드부터 적용됩니다.
        </div>
      )}

      {/*
        토글·슬라이더·셀렉트는 조작 즉시 저장되고, 숫자·JSON만 명시 저장이다
        (타이핑 중간값이 저장되면 안 되기 때문). 그래서 저장 버튼은 **그 둘에만**
        붙고, 저장할 것이 없으면 눌리지 않는다.
      */}
      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
        {widget === "toggle" ? (
          <Toggle
            checked={!!draft}
            disabled={saving}
            onChange={(v) => {
              setDraft(v);
              request(v);
            }}
          />
        ) : widget === "select" ? (
          <select
            value={String(draft ?? "")}
            disabled={saving}
            onChange={(e) => {
              setDraft(e.target.value);
              request(e.target.value);
            }}
            className="min-w-40 flex-1 rounded border border-white/15 bg-[#1b1813] px-2 py-1.5 text-sm text-[#e7e3d8] disabled:opacity-50"
          >
            {(spec.options ?? []).map((o) => (
              <option key={String(o.value)} value={String(o.value)}>
                {o.label}
              </option>
            ))}
          </select>
        ) : widget === "slider" ? (
          <Slider
            value={Number(draft ?? spec.min ?? 0)}
            min={spec.min ?? 0}
            max={spec.max ?? 1}
            step={spec.step ?? 1}
            unit={spec.unit}
            disabled={saving}
            onChange={setDraft}
            onCommit={request}
          />
        ) : widget === "number" ? (
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              value={Number(draft ?? spec.min ?? 0)}
              min={spec.min}
              max={spec.max}
              step={spec.step}
              disabled={saving}
              onChange={(e) => setDraft(Number(e.target.value))}
              className="w-28 rounded border border-white/15 bg-[#1b1813] px-2 py-1.5 text-right font-mono text-sm text-[#e7e3d8] disabled:opacity-50"
            />
            {spec.unit && <span className="text-xs text-[#9a948a]">{spec.unit}</span>}
            {spec.min != null && spec.max != null && (
              <span className="text-[10px] text-[#6f6a62]">
                허용 {spec.min}–{spec.max}
              </span>
            )}
            {/*
              파생값은 **초안**을 따라간다 (D194). 저장된 값을 따라가면 숫자를
              고치는 동안 옆의 "재발동까지"가 옛 수를 가리켜, 지금 무엇을 정하고
              있는지가 오히려 헷갈린다.
            */}
            {spec.derived && (
              <span className="text-[10px] text-[#9a948a]">
                {spec.derived.label}{" "}
                <span className="font-mono text-[#cfc5a6]">
                  {Number(draft ?? spec.min ?? 0) + spec.derived.add}
                </span>
                {spec.derived.unit ?? spec.unit}
              </span>
            )}
          </div>
        ) : (
          <input
            type="text"
            value={jsonDraft}
            disabled={saving}
            onChange={(e) => setJsonDraft(e.target.value)}
            spellCheck={false}
            className="min-w-40 flex-1 rounded border border-white/15 bg-[#1b1813] px-2 py-1.5 font-mono text-sm text-[#e7e3d8] disabled:opacity-50"
          />
        )}

        {(widget === "json" || widget === "number") && (
          <SaveButton
            dirty={dirty}
            saving={saving}
            onClick={() => (widget === "json" ? saveJson() : request(draft))}
          />
        )}
      </div>

      {err && <p className="mt-1.5 text-xs text-[#e0796a]">{err}</p>}
      {msg && <p className="mt-1.5 text-xs text-[#9bbf6a]">{msg}</p>}

      {confirmValue && (
        <ConfirmDialog
          label={spec.label}
          settingKey={item.key}
          value={confirmValue.value}
          onCancel={() => {
            setConfirmValue(null);
            setDraft(item.value);
          }}
          onConfirm={() => {
            const v = confirmValue.value;
            setConfirmValue(null);
            void save(v);
          }}
        />
      )}
    </Panel>
  );
}

function ScopeBadge({ scope }: { scope: string }) {
  if (scope === "danger") return <Badge tone="bad">위험 · 재인덱싱 필요</Badge>;
  if (scope === "new-only") return <Badge tone="warn">신규만 적용</Badge>;
  return <Badge tone="ok">즉시 반영</Badge>;
}

function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`group flex items-center gap-2 disabled:opacity-50 ${
        disabled ? "" : "cursor-pointer"
      }`}
    >
      <span
        className={`relative block h-5 w-9 shrink-0 rounded-full transition-colors ${
          checked ? "bg-[#6e8a3c]" : "bg-white/20"
        }`}
      >
        {/*
          `left-0`이 **반드시 있어야 한다.** 없으면 절대 위치의 기준이 정적 위치가
          되는데, button의 기본 `text-align: center` 때문에 그 값이 트랙 중앙
          (18px)이 되고 거기에 translate가 더해져 손잡이가 트랙 밖으로 14px
          삐져나온다(실측). 값도 트랙(36) − 손잡이(16) − 여백(2) = 18px로 못박아
          양쪽 여백을 같게 한다.
        */}
        <span
          className={`absolute top-0.5 left-0 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
            checked ? "translate-x-[18px]" : "translate-x-[2px]"
          }`}
        />
      </span>
      <span
        className={`text-xs font-medium ${checked ? "text-[#9bbf6a]" : "text-[#9a948a]"}`}
      >
        {checked ? "켜짐" : "꺼짐"}
      </span>
    </button>
  );
}

/**
 * 저장 버튼.
 *
 * 예전에는 비활성일 때도 금색 배경에 `opacity-50`만 걸어서, 눌리지 않는데도
 * 주 동작처럼 보이는 탁한 금색 덩어리가 됐다(스크린샷으로 확인). 저장할 것이
 * 있을 때만 금색이고, 없으면 테두리만 남는 중립 상태로 둔다.
 */
function SaveButton({
  dirty,
  saving,
  onClick,
}: {
  dirty: boolean;
  saving: boolean;
  onClick: () => void;
}) {
  const disabled = saving || !dirty;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={dirty ? "변경값을 저장합니다" : "변경한 값이 없습니다"}
      className={`rounded px-3 py-1.5 text-sm font-medium transition-colors ${
        disabled
          ? "cursor-not-allowed border border-white/10 bg-transparent text-[#6f6a62]"
          : "cursor-pointer bg-[#e0a32e] text-[#2a2a24] hover:brightness-110"
      }`}
    >
      {saving ? "저장 중…" : "저장"}
    </button>
  );
}

function Slider({
  value,
  min,
  max,
  step,
  unit,
  disabled,
  onChange,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  disabled?: boolean;
  onChange: (v: number) => void;
  onCommit: (v: number) => void;
}) {
  // 드래그 중에는 onChange가 연속 발화한다 — 저장 폭주를 막고 놓을 때 1회만
  // 커밋한다. 키보드 조작은 드래그가 아니므로 즉시 커밋(접근성).
  const dragging = useRef(false);
  return (
    <div className="flex min-w-64 flex-1 items-center gap-2.5">
      {/* 눈금이 없으면 지금 값이 범위의 어디쯤인지 알 수 없다. */}
      <span className="w-8 shrink-0 text-right font-mono text-[10px] text-[#6f6a62]">
        {min}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onPointerDown={() => {
          dragging.current = true;
        }}
        onChange={(e) => {
          const v = Number(e.target.value);
          onChange(v);
          if (!dragging.current) onCommit(v);
        }}
        onPointerUp={(e) => {
          dragging.current = false;
          onCommit(Number((e.target as HTMLInputElement).value));
        }}
        className="h-1.5 flex-1 cursor-pointer accent-[#e0a32e] disabled:cursor-not-allowed disabled:opacity-50"
      />
      <span className="w-8 shrink-0 font-mono text-[10px] text-[#6f6a62]">{max}</span>
      <span className="w-20 shrink-0 rounded bg-[#1b1813] px-2 py-0.5 text-right font-mono text-sm font-semibold text-[#fcf58b]">
        {value}
        {unit ? ` ${unit}` : ""}
      </span>
    </div>
  );
}

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
            aria-label="닫기"
            className="rounded p-1 text-[#9a948a] transition-colors hover:text-[#e7e3d8]"
          >
            <X size={16} />
          </button>
        </div>
        <p className="text-sm text-[#cfc5a6]">
          <span className="font-semibold text-[#fcf58b]">{label}</span> (
          <code className="text-[11px] text-[#9a948a]">{settingKey}</code>) 값을{" "}
          <code className="rounded bg-[#1b1813] px-1.5 py-0.5 text-[12px] text-[#e7e3d8]">
            {JSON.stringify(value)}
          </code>{" "}
          (으)로 변경합니다.
        </p>
        <div className="mt-3 rounded border border-[#b54a3a]/40 bg-[#b54a3a]/10 px-3 py-2 text-[12px] text-[#e6a99e]">
          기존 임베딩·인덱스와 불일치하면 검색이 깨집니다. 변경 후 전체 재임베딩이
          필요하며 자동 재인덱싱은 하지 않습니다.
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
