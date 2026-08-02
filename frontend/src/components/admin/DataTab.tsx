"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  Download,
  RotateCcw,
  ShieldAlert,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  createAdminBackup,
  deleteAdminBackup,
  downloadAdminBackup,
  getAdminBackups,
  purgeAdminData,
  restoreAdminBackup,
} from "@/lib/api";
import type {
  AdminBackup,
  AdminBackupsResponse,
  AdminPurgeResult,
  AdminRestoreResult,
} from "@/lib/types";
import { Badge, Empty, Failed, Loading, Panel, bytes, n, when } from "./ui";

/**
 * 데이터 탭 (D114) — 백업 · 복원 · 초기화.
 *
 * 셋을 한 화면에 두는 이유: **백업 없는 초기화는 기능이 아니라 사고다.** 지우는
 * 버튼 옆에 되돌리는 수단이 보여야 한다.
 *
 * 초기화는 문구를 그대로 입력해야 실행된다(서버도 같은 문구를 요구한다). 실수로
 * 누를 수 있는 자리에 되돌릴 수 없는 동작을 두지 않는다.
 */

const PURGE_PHRASE = "초기화합니다";

const SCOPE_LABEL: Record<string, string> = {
  // D152: 캔버스가 곧 대화 내용이다(D122). 라벨에서 빠뜨리면 지우려는 사람이
  // "글은 남겠지"라고 오해한다.
  conversations: "대화 (세션·노드·캔버스 글/그림·턴 로그)",
  documents: "문서 (파일·청크·도판·벡터)",
  people: "계정·학급",
  settings: "런타임 설정",
};

export function DataTab() {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useQuery<AdminBackupsResponse>({
    queryKey: ["admin", "backups"],
    queryFn: getAdminBackups,
  });

  const [note, setNote] = useState("");
  const [backupScopes, setBackupScopes] = useState<string[]>([]);
  const [confirmPurge, setConfirmPurge] = useState<string[] | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ["admin", "backups"] });

  const make = useMutation<AdminBackup, Error>({
    mutationFn: () => createAdminBackup({ scopes: backupScopes, note }),
    onSuccess: (b) => {
      setResult(`백업 생성: ${b.name} (${bytes(b.size_bytes)})`);
      setNote("");
      refresh();
    },
  });

  if (isLoading) return <Loading />;
  if (isError || !data) return <Failed />;

  const all = data.scopes.all;
  const toggle = (s: string) =>
    setBackupScopes((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s],
    );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Archive size={16} className="text-[#e0a32e]" />
        <h2 className="text-sm font-semibold text-[#e7e3d8]">데이터 백업 · 초기화</h2>
      </div>

      <div className="flex items-start gap-2 rounded border border-[#e0a32e]/40 bg-[#e0a32e]/10 px-3 py-2 text-xs leading-relaxed text-[#e7d9b0]">
        <ShieldAlert size={14} className="mt-0.5 shrink-0 text-[#e0a32e]" />
        <span>
          스냅샷에는 <b>학생 대화 원문</b>이 그대로 들어 있습니다. 서버 안에만
          두고, 내려받은 파일을 외부로 옮길 때는 그 내용도 함께 나간다는 점을
          염두에 두세요.
        </span>
      </div>

      {result && (
        <div className="flex items-center gap-2 rounded border border-[#6e8a3c]/40 bg-[#6e8a3c]/10 px-3 py-2 text-xs text-[#9bbf6a]">
          {result}
          <button
            type="button"
            onClick={() => setResult(null)}
            className="ml-auto cursor-pointer text-[#9a948a] hover:text-[#e7e3d8]"
            aria-label="닫기"
          >
            <X size={13} />
          </button>
        </div>
      )}

      {/* ── 백업 만들기 ─────────────────────────────────────── */}
      <Panel title="백업 만들기">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            {all.map((s) => {
              const on = backupScopes.length === 0 || backupScopes.includes(s);
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => toggle(s)}
                  className={`cursor-pointer rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                    on
                      ? "border-[#e0a32e]/60 bg-[#e0a32e]/15 text-[#fcf58b]"
                      : "border-white/15 text-[#9a948a] hover:text-[#e7e3d8]"
                  }`}
                >
                  {SCOPE_LABEL[s] ?? s}
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-[#9a948a]">
            아무것도 고르지 않으면 <b className="text-[#cfc9bd]">전부</b> 담습니다.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="메모 (무엇을 위한 백업인지)"
              className="min-w-48 flex-1 rounded border border-white/15 bg-[#1b1813] px-2 py-1.5 text-sm text-[#e7e3d8] placeholder:text-[#6f6a62]"
            />
            <button
              type="button"
              onClick={() => make.mutate()}
              disabled={make.isPending}
              className="cursor-pointer rounded bg-[#e0a32e] px-3 py-1.5 text-sm font-medium text-[#2a2a24] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {make.isPending ? "만드는 중…" : "백업 만들기"}
            </button>
          </div>
          {make.isError && (
            <p className="text-xs text-[#e0796a]">실패: {make.error.message}</p>
          )}
        </div>
      </Panel>

      {/* ── 스냅샷 목록 ─────────────────────────────────────── */}
      <Panel title={`저장된 백업 (${data.backups.length})`}>
        {data.backups.length === 0 ? (
          <Empty>백업이 없습니다. 초기화 전에 하나 만들어 두세요.</Empty>
        ) : (
          <div className="flex flex-col gap-2">
            {data.backups.map((b) => (
              <BackupRow
                key={b.name}
                backup={b}
                restorable={data.scopes.restorable}
                onDone={(msg) => {
                  setResult(msg);
                  refresh();
                }}
              />
            ))}
          </div>
        )}
      </Panel>

      {/* ── 초기화 ──────────────────────────────────────────── */}
      <section className="rounded-lg border border-[#b54a3a]/50 bg-[#25211a]">
        <header className="flex items-center gap-2 border-b border-[#b54a3a]/30 px-3 py-2">
          <TriangleAlert size={14} className="text-[#b54a3a]" />
          <h3 className="text-xs font-semibold uppercase tracking-wide text-[#e6a99e]">
            데이터 초기화 — 되돌릴 수 없음
          </h3>
        </header>
        <div className="flex flex-col gap-3 p-3">
          <p className="text-xs leading-relaxed text-[#cfc5a6]">
            선택한 데이터를 <b className="text-[#e6a99e]">영구히</b> 지웁니다.
            기본적으로 지우기 직전에 전체 백업을 자동으로 뜨며,{" "}
            <b className="text-[#cfc9bd]">백업에 실패하면 삭제하지 않습니다</b>.
            계정·학급은 초기화 대상이 아닙니다 — 계정을 지우면 그 사람의 모든 것이
            함께 사라지므로 권한 탭에서 하나씩 다룹니다.
          </p>
          <div className="flex flex-wrap gap-2">
            {data.scopes.purgeable.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setConfirmPurge([s])}
                className="cursor-pointer rounded border border-[#b54a3a]/50 px-2.5 py-1.5 text-xs text-[#e6a99e] transition-colors hover:bg-[#b54a3a]/15"
              >
                <Trash2 size={12} className="mr-1 inline" />
                {SCOPE_LABEL[s] ?? s} 초기화
              </button>
            ))}
            <button
              type="button"
              onClick={() => setConfirmPurge([...data.scopes.purgeable])}
              className="cursor-pointer rounded bg-[#b54a3a] px-2.5 py-1.5 text-xs font-semibold text-white transition-colors hover:brightness-110"
            >
              <Trash2 size={12} className="mr-1 inline" />
              전부 초기화
            </button>
          </div>
        </div>
      </section>

      {confirmPurge && (
        <PurgeDialog
          scopes={confirmPurge}
          onCancel={() => setConfirmPurge(null)}
          onDone={(msg) => {
            setConfirmPurge(null);
            setResult(msg);
            refresh();
            // 지운 데이터를 읽던 화면들이 옛 값을 들고 있지 않게 통째로 무효화.
            qc.invalidateQueries({ queryKey: ["admin"] });
          }}
        />
      )}
    </div>
  );
}

function BackupRow({
  backup,
  restorable,
  onDone,
}: {
  backup: AdminBackup;
  restorable: string[];
  onDone: (msg: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const restorableInThis = restorable.filter((s) => backup.scopes.includes(s));

  const act = async (label: string, fn: () => Promise<string>) => {
    setBusy(label);
    setErr(null);
    try {
      onDone(await fn());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-lg border border-white/10 bg-[#221e17] p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <code className="text-[12px] font-semibold text-[#fcf58b]">{backup.name}</code>
        <span className="text-[11px] text-[#9a948a]">{when(backup.created_at)}</span>
        <Badge>{bytes(backup.size_bytes)}</Badge>
        {backup.scopes.map((s) => (
          <Badge key={s} tone="info">
            {SCOPE_LABEL[s] ?? s}
          </Badge>
        ))}
      </div>

      {backup.note && (
        <p className="mt-1 text-[11px] text-[#cfc9bd]">{backup.note}</p>
      )}

      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-[#9a948a]">
        {Object.entries(backup.counts).map(([t, c]) => (
          <span key={t}>
            {t} {n(c)}
          </span>
        ))}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!!busy}
          onClick={() =>
            act("download", async () => {
              await downloadAdminBackup(backup.name);
              return `내려받기: ${backup.name}`;
            })
          }
          className="flex cursor-pointer items-center gap-1 rounded border border-white/15 px-2 py-1 text-[11px] text-[#cfc9bd] hover:text-[#e7e3d8] disabled:opacity-50"
        >
          <Download size={11} />
          내려받기
        </button>

        {restorableInThis.length > 0 ? (
          <button
            type="button"
            disabled={!!busy}
            onClick={() =>
              act("restore", async () => {
                const r: AdminRestoreResult = await restoreAdminBackup(
                  backup.name,
                  restorableInThis,
                );
                const c = r.restored.conversations;
                const s = r.restored.settings;
                const parts: string[] = [];
                if (c)
                  parts.push(
                    `세션 ${n(c.sessions)} · 노드 ${n(c.nodes)} · 로그 ${n(c.ai_logs)}` +
                      ` · 캔버스 글 ${n(c.canvas_items)} · 그림 ${n(c.canvas_drawings)}`,
                  );
                if (s) parts.push(`설정 ${n(s.app_settings)}`);
                return `복원 완료 — ${parts.join(" / ")} (이미 있는 행은 건너뜀)`;
              })
            }
            className="flex cursor-pointer items-center gap-1 rounded border border-[#6e8a3c]/50 px-2 py-1 text-[11px] text-[#9bbf6a] hover:bg-[#6e8a3c]/15 disabled:opacity-50"
          >
            <RotateCcw size={11} />
            {busy === "restore" ? "복원 중…" : `복원 (${restorableInThis.length}종)`}
          </button>
        ) : (
          <span className="text-[10px] text-[#6f6a62]">복원 가능한 스코프 없음</span>
        )}

        <button
          type="button"
          disabled={!!busy}
          onClick={() =>
            act("delete", async () => {
              await deleteAdminBackup(backup.name);
              return `백업 삭제: ${backup.name}`;
            })
          }
          className="ml-auto flex cursor-pointer items-center gap-1 rounded border border-white/15 px-2 py-1 text-[11px] text-[#9a948a] hover:text-[#e0796a] disabled:opacity-50"
        >
          <Trash2 size={11} />
          삭제
        </button>
      </div>

      {backup.scopes.includes("documents") && (
        <p className="mt-1.5 text-[10px] leading-relaxed text-[#9a948a]">
          문서는 <b className="text-[#e0a86a]">복원되지 않습니다</b> — 스냅샷에는
          목록·청크 본문만 있고 원본 파일과 검색 벡터는 없습니다. 행만 되살리면
          껍데기가 남습니다.
        </p>
      )}

      {err && <p className="mt-1 text-[11px] text-[#e0796a]">실패: {err}</p>}
    </div>
  );
}

function PurgeDialog({
  scopes,
  onCancel,
  onDone,
}: {
  scopes: string[];
  onCancel: () => void;
  onDone: (msg: string) => void;
}) {
  const [phrase, setPhrase] = useState("");
  const [backupFirst, setBackupFirst] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r: AdminPurgeResult = await purgeAdminData({
        scopes,
        confirm: phrase,
        backup_first: backupFirst,
      });
      const parts: string[] = [];
      const c = r.deleted.conversations;
      if (c)
        parts.push(
          `세션 ${n(c.sessions)} · 노드 ${n(c.nodes)} · 턴 로그 ${n(c.ai_logs)}`,
        );
      const d = r.deleted.documents;
      if (d) {
        parts.push(`문서 ${n(d.files)}`);
        if (d.failed.length > 0) parts.push(`삭제 실패 ${d.failed.length}건`);
      }
      const b = r.backup ? ` (사전 백업 ${r.backup.name})` : "";
      onDone(`초기화 완료 — ${parts.join(" / ")}${b}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="데이터 초기화 확인"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-lg rounded-2xl border border-[#b54a3a]/60 bg-[#25211a] p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center gap-2">
          <TriangleAlert size={18} className="text-[#b54a3a]" />
          <h2 className="text-sm font-bold text-[#e7e3d8]">데이터 초기화</h2>
        </div>

        <p className="text-sm text-[#cfc5a6]">아래 데이터를 영구히 지웁니다:</p>
        <ul className="mt-2 flex flex-col gap-1">
          {scopes.map((s) => (
            <li key={s} className="text-sm text-[#e6a99e]">
              · {SCOPE_LABEL[s] ?? s}
            </li>
          ))}
        </ul>

        <label className="mt-3 flex items-start gap-2 rounded border border-white/10 bg-[#1b1813] px-2.5 py-2 text-[11px] leading-relaxed text-[#cfc9bd]">
          <input
            type="checkbox"
            checked={backupFirst}
            onChange={(e) => setBackupFirst(e.target.checked)}
            className="mt-0.5 accent-[#e0a32e]"
          />
          <span>
            지우기 전에 전체 백업을 자동으로 만듭니다(권장).{" "}
            {!backupFirst && (
              <b className="text-[#e0796a]">
                끄면 되돌릴 방법이 없습니다.
              </b>
            )}
          </span>
        </label>

        <div className="mt-3">
          <label className="text-[11px] text-[#9a948a]">
            계속하려면 <b className="text-[#fcf58b]">{PURGE_PHRASE}</b> 를 입력하세요
          </label>
          <input
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            autoFocus
            className="mt-1 w-full rounded border border-white/15 bg-[#1b1813] px-2 py-1.5 text-sm text-[#e7e3d8]"
          />
        </div>

        {err && <p className="mt-2 text-xs text-[#e0796a]">실패: {err}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="cursor-pointer rounded-lg border border-white/15 px-3 py-1.5 text-sm text-[#cfc5a6] transition-colors hover:text-[#e7e3d8] disabled:opacity-50"
          >
            취소
          </button>
          <button
            type="button"
            onClick={run}
            disabled={busy || phrase !== PURGE_PHRASE}
            className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors ${
              busy || phrase !== PURGE_PHRASE
                ? "cursor-not-allowed border border-white/10 text-[#6f6a62]"
                : "cursor-pointer bg-[#b54a3a] text-white hover:brightness-110"
            }`}
          >
            {busy ? "지우는 중…" : "영구 삭제"}
          </button>
        </div>
      </div>
    </div>
  );
}
