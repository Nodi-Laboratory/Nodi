"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { listAdminSettings, putAdminSetting } from "@/lib/api";
import type { AdminSetting } from "@/lib/types";

/** 런타임 설정 탭: app_settings 인라인 편집(JSON value). */
export function SettingsTab() {
  const { data: settings, isLoading, isError } = useQuery<AdminSetting[]>({
    queryKey: ["admin", "settings"],
    queryFn: listAdminSettings,
  });

  if (isLoading)
    return <p className="text-sm text-[#9a948a]">설정 불러오는 중…</p>;
  if (isError)
    return <p className="text-sm text-[#e0796a]">설정을 불러오지 못했습니다.</p>;

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-[#e7e3d8]">런타임 설정</h2>
      <div className="flex items-start gap-2 rounded border border-[#e0a32e]/40 bg-[#e0a32e]/10 px-3 py-2 text-xs text-[#e7d9b0]">
        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[#e0a32e]" />
        <span>
          값은 저장되며, 일부 설정은 런타임 즉시 반영이 아니라 다음 배포/후속
          작업 후 적용됩니다. value는 JSON으로 저장됩니다(문자열은 따옴표, 숫자는
          숫자).
        </span>
      </div>
      <div className="flex flex-col gap-2">
        {(settings ?? []).length === 0 ? (
          <p className="text-sm text-[#9a948a]">설정 항목이 없습니다.</p>
        ) : (
          (settings ?? []).map((s) => <SettingRow key={s.key} setting={s} />)
        )}
      </div>
    </div>
  );
}

function SettingRow({ setting }: { setting: AdminSetting }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(() => JSON.stringify(setting.value));
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const original = JSON.stringify(setting.value);
  const dirty = draft !== original;

  const handleSave = async () => {
    setMsg(null);
    setErr(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch {
      setErr("JSON 형식이 올바르지 않습니다. (문자열은 \"따옴표\", 숫자는 숫자)");
      return;
    }
    setSaving(true);
    try {
      await putAdminSetting(setting.key, parsed);
      await queryClient.invalidateQueries({ queryKey: ["admin", "settings"] });
      setMsg("저장되었습니다.");
    } catch (e) {
      setErr(`저장 실패: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-white/10 bg-[#25211a] p-3">
      <div className="flex items-center justify-between">
        <code className="text-sm font-semibold text-[#fcf58b]">
          {setting.key}
        </code>
        <span className="text-xs text-[#9a948a]">
          {setting.updated_at
            ? new Date(setting.updated_at).toLocaleString("ko-KR")
            : "—"}
        </span>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          className="flex-1 rounded border border-white/15 bg-[#1b1813] px-2 py-1.5 font-mono text-sm text-[#e7e3d8]"
        />
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !dirty}
          className="rounded bg-[#e0a32e] px-3 py-1.5 text-sm font-medium text-[#2a2a24] hover:brightness-110 disabled:opacity-50"
        >
          저장
        </button>
      </div>
      {err && <p className="mt-1 text-xs text-[#e0796a]">{err}</p>}
      {msg && <p className="mt-1 text-xs text-[#9bbf6a]">{msg}</p>}
    </div>
  );
}
