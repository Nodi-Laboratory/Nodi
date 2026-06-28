"use client";

import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Upload,
  FileText,
  AlertTriangle,
  CheckCircle2,
  Link2,
  X,
} from "lucide-react";
import { ApiError, uploadFile, type SpaceTarget } from "@/lib/api";
import { filesKey, useFiles } from "@/lib/queries";
import type { FileLink, FileRow, FileStatus } from "@/lib/types";

/**
 * 워크스페이스 좌측 "자료" 패널.
 * 업로드 + 목록 + 임베딩 진행률(3b-1) + 파일→분기 연결 시작/표시(3b-2, 시각적 RAG).
 * service_role 미설정 시 업로드 503 안내.
 */
function formatBytes(n: number | null): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fileName(f: FileRow): string {
  return (
    f.name ||
    f.filename ||
    (f.storage_path ? f.storage_path.split("/").pop() || f.storage_path : "") ||
    f.id
  );
}

const STATUS_META: Record<
  FileStatus,
  { label: string; cls: string; progress: boolean }
> = {
  uploaded: { label: "대기", cls: "bg-accent/40 text-accent-fg", progress: true },
  splitting: { label: "분할 중", cls: "bg-accent/40 text-accent-fg", progress: true },
  embedding: { label: "임베딩 중", cls: "bg-accent/40 text-accent-fg", progress: true },
  indexed: { label: "완료", cls: "bg-positive/20 text-positive", progress: false },
  partial: { label: "부분 실패", cls: "bg-warning/20 text-warning", progress: false },
  failed: { label: "실패", cls: "bg-danger/20 text-danger", progress: false },
};

export function FilesPanel({
  target,
  fileLinks,
  linkFileId,
  onStartLink,
  onCancelLink,
}: {
  target: SpaceTarget;
  fileLinks: FileLink[];
  linkFileId: string | null;
  onStartLink: (fileId: string) => void;
  onCancelLink: () => void;
}) {
  const queryClient = useQueryClient();
  const { data: files, isLoading } = useFiles(target);
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePick = () => inputRef.current?.click();

  const handleFiles = async (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;
    setError(null);
    setUploading(true);
    try {
      await uploadFile(target, file);
      await queryClient.invalidateQueries({ queryKey: filesKey(target) });
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) {
        setError("파일 임베딩이 아직 활성화되지 않았습니다(관리자 설정 필요).");
      } else {
        setError(`업로드 실패: ${(e as Error).message}`);
      }
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <section className="flex max-h-[40%] shrink-0 flex-col border-t border-accent-border/30">
      <div className="flex items-center justify-between px-4 py-2.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
          자료
        </span>
        <button
          type="button"
          onClick={handlePick}
          disabled={uploading}
          title="파일 업로드 (PDF·txt 등)"
          className="flex items-center gap-1 rounded-lg border border-accent-border bg-accent px-2 py-1 text-xs font-medium text-accent-fg transition-colors hover:bg-accent-deep hover:text-white disabled:opacity-60"
        >
          <Upload size={13} />
          {uploading ? "업로드 중…" : "업로드"}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.txt,.md,application/pdf,text/plain"
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>

      {error && (
        <div className="mx-3 mb-2 flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-xs text-warning">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto px-2 pb-3">
        {isLoading ? (
          <p className="px-2 py-2 text-xs text-fg-muted">불러오는 중…</p>
        ) : !files || files.length === 0 ? (
          <p className="px-2 py-2 text-xs text-fg-muted">
            업로드한 자료가 없습니다.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {files.map((f) => (
              <FileItem
                key={f.id}
                file={f}
                linkCount={fileLinks.filter((l) => l.file_id === f.id).length}
                linking={linkFileId === f.id}
                onStartLink={() => onStartLink(f.id)}
                onCancelLink={onCancelLink}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function FileItem({
  file,
  linkCount,
  linking,
  onStartLink,
  onCancelLink,
}: {
  file: FileRow;
  linkCount: number;
  linking: boolean;
  onStartLink: () => void;
  onCancelLink: () => void;
}) {
  const meta = STATUS_META[file.status];
  const total = file.chunk_total ?? 0;
  const done = file.chunk_done ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const canLink = file.status === "indexed";

  return (
    <li
      className={`rounded-lg border bg-bg-elevated px-2.5 py-2 ${
        linking ? "border-[#2a7d7a]" : "border-accent-border/30"
      }`}
    >
      <div className="flex items-center gap-2">
        {file.status === "indexed" ? (
          <CheckCircle2 size={14} className="shrink-0 text-positive" />
        ) : (
          <FileText size={14} className="shrink-0 text-fg-muted" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm text-fg" title={fileName(file)}>
          {fileName(file)}
        </span>
        <span
          className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${meta.cls}`}
        >
          {meta.label}
        </span>
      </div>

      <div className="mt-1 flex items-center gap-2 pl-6 text-[11px] text-fg-muted">
        <span>{formatBytes(file.size_bytes)}</span>
        {file.mime && <span className="truncate">{file.mime}</span>}
        {meta.progress && total > 0 && (
          <span className="ml-auto tabular-nums">
            {done}/{total}
          </span>
        )}
      </div>

      {meta.progress && (
        <div className="mt-1 ml-6 h-1.5 overflow-hidden rounded-full bg-accent/20">
          <div
            className="h-full rounded-full bg-accent-deep transition-all"
            style={{ width: `${total > 0 ? pct : 8}%` }}
          />
        </div>
      )}

      {(file.status === "failed" || file.status === "partial") && file.error && (
        <p className="mt-1 ml-6 text-[11px] text-danger">{file.error}</p>
      )}

      {/* 분기에 연결 (시각적 RAG) */}
      <div className="mt-1.5 ml-6 flex items-center gap-2">
        {linking ? (
          <button
            type="button"
            onClick={onCancelLink}
            className="flex items-center gap-1 rounded-md border border-[#2a7d7a] bg-[#2a7d7a]/10 px-2 py-0.5 text-[11px] font-medium text-[#2a7d7a]"
          >
            <X size={11} />
            그래프에서 노드 선택 중… (취소)
          </button>
        ) : (
          <button
            type="button"
            onClick={onStartLink}
            disabled={!canLink}
            title={
              canLink
                ? "분기에 연결: 그래프에서 노드를 클릭"
                : "임베딩 완료(완료 상태) 후 연결할 수 있어요"
            }
            className="flex items-center gap-1 rounded-md border border-accent-border/50 px-2 py-0.5 text-[11px] font-medium text-fg-muted transition-colors hover:text-fg disabled:opacity-50"
          >
            <Link2 size={11} />
            분기에 연결
          </button>
        )}
        {linkCount > 0 && (
          <span className="text-[11px] text-[#2a7d7a]">📎 {linkCount}곳</span>
        )}
      </div>
    </li>
  );
}
