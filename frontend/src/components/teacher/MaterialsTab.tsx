"use client";

import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Upload,
  BookOpen,
  FileText,
  CheckCircle2,
  AlertTriangle,
  Info,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { ApiError, deleteFile, retryFile, uploadFile } from "@/lib/api";
import { classMaterialsKey, useClassMaterials } from "@/lib/queries";
import type { FileRow, FileStatus } from "@/lib/types";

/**
 * 자료 탭: 학급 자료실(class_material) 목록 + 업로드 + 임베딩 진행률.
 * 업로드한 자료는 학생들이 자기 학급 공간에서 RAG로 참고한다.
 * G3/G5(D75): 실패 파일 재시도·삭제 동선 + 업로드 성공 피드백 + 형식 사전 검증.
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

// D75: 서버 화이트리스트(services/files.py ALLOWED_UPLOAD_EXTENSIONS)와 동일
// 목록 — 선택 직후 사전 검증해 서버 왕복 없이 같은 사유를 보여준다.
const ALLOWED_EXTENSIONS = new Set([
  "pdf", "png", "jpg", "jpeg", "webp", "gif", "txt", "md",
]);
const UNSUPPORTED_TYPE_MSG =
  "지원 형식: PDF, 이미지(PNG/JPG/WEBP/GIF), 텍스트(TXT/MD)";

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

export function MaterialsTab({ classId }: { classId: string }) {
  const queryClient = useQueryClient();
  const { data: materials, isLoading } = useClassMaterials(classId);
  const inputRef = useRef<HTMLInputElement>(null);
  // 클릭한 버튼의 kind 기억 — hidden input 1개를 두 업로드 버튼이 공유한다.
  const pendingKindRef = useRef<"class_material" | "textbook">("class_material");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // G5: 업로드 성공 인라인 안내 1줄(토스트 라이브러리 신규 도입 금지).
  const [notice, setNotice] = useState<string | null>(null);

  // 버튼 kind에 맞춰 accept를 전환한 뒤 공유 파일 선택기를 연다.
  // 교과서는 PDF 전용(백엔드 kind="textbook"), 자료는 기존 화이트리스트 유지.
  const openPicker = (kind: "class_material" | "textbook") => {
    pendingKindRef.current = kind;
    const input = inputRef.current;
    if (!input) return;
    input.accept =
      kind === "textbook" ? ".pdf" : ".pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,.md";
    input.click();
  };

  const handleFiles = async (list: FileList | null) => {
    const file = list?.[0];
    if (!file) return;
    const kind = pendingKindRef.current;
    setError(null);
    setNotice(null);
    // 형식 사전 검증 — 서버와 같은 사유(왕복 없이 즉시 안내).
    const ext = file.name.includes(".")
      ? file.name.split(".").pop()!.toLowerCase()
      : "";
    if (kind === "textbook") {
      // 교과서는 PDF 전용(백엔드 계약).
      if (ext !== "pdf") {
        setError("교과서는 PDF 파일만 업로드할 수 있습니다.");
        if (inputRef.current) inputRef.current.value = "";
        return;
      }
    } else if (!ALLOWED_EXTENSIONS.has(ext)) {
      // D75: 자료는 서버 화이트리스트(ALLOWED_UPLOAD_EXTENSIONS)와 같은 목록.
      setError(UNSUPPORTED_TYPE_MSG);
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    setUploading(true);
    try {
      await uploadFile(
        { space_kind: "class", space_ref: classId },
        file,
        { kind },
      );
      await queryClient.invalidateQueries({
        queryKey: classMaterialsKey(classId),
      });
      setNotice(
        kind === "textbook"
          ? `"${file.name}" 교과서 업로드 완료 — 인덱싱이 시작됩니다.`
          : `"${file.name}" 업로드 완료 — 인덱싱이 시작됩니다.`,
      );
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
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-fg">학급 자료실</h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => openPicker("textbook")}
            disabled={uploading}
            className="flex items-center gap-1 rounded-lg border border-accent-border bg-bg-elevated px-3 py-1.5 text-sm font-medium text-accent-fg transition-colors hover:bg-accent disabled:opacity-60"
          >
            <BookOpen size={14} />
            교과서 업로드
          </button>
          <button
            type="button"
            onClick={() => openPicker("class_material")}
            disabled={uploading}
            className="flex items-center gap-1 rounded-lg border border-accent-border bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-deep hover:text-white disabled:opacity-60"
          >
            <Upload size={14} />
            {uploading ? "업로드 중…" : "자료 업로드"}
          </button>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,.md"
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-accent-border/30 bg-bg-elevated px-3 py-2 text-xs text-fg-muted">
        <Info size={14} className="mt-0.5 shrink-0" />
        <span>
          업로드한 자료는 임베딩된 뒤 학생들이 자기 학급 공간의 대화에서 RAG로
          참고할 수 있습니다. ({UNSUPPORTED_TYPE_MSG})
        </span>
      </div>

      {error && (
        <div className="flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {notice && (
        <div className="flex items-start gap-1.5 rounded-lg border border-positive/40 bg-positive/10 px-3 py-2 text-sm text-positive">
          <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      {isLoading ? (
        <p className="text-sm text-fg-muted">자료 불러오는 중…</p>
      ) : !materials || materials.length === 0 ? (
        <p className="rounded-lg border border-dashed border-accent-border/50 p-6 text-center text-sm text-fg-muted">
          업로드한 자료가 없습니다.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {materials.map((f) => (
            <MaterialItem key={f.id} file={f} classId={classId} />
          ))}
        </ul>
      )}
    </div>
  );
}

function MaterialItem({ file, classId }: { file: FileRow; classId: string }) {
  const queryClient = useQueryClient();
  const meta = STATUS_META[file.status];
  const total = file.chunk_total ?? 0;
  const done = file.chunk_done ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  // G3: 재시도/삭제 요청 중 표시(둘 다 disabled) + 행 단위 오류 안내.
  const [pendingAction, setPendingAction] = useState<"retry" | "delete" | null>(
    null,
  );
  const [actionError, setActionError] = useState<string | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: classMaterialsKey(classId) });

  const handleRetry = async () => {
    setActionError(null);
    setPendingAction("retry");
    try {
      await retryFile(file.id);
      await invalidate(); // 폴링(useClassMaterials)이 진행 상태를 이어받는다
    } catch (e) {
      setActionError(`재시도 실패: ${(e as Error).message}`);
    } finally {
      setPendingAction(null);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(`"${fileName(file)}" 자료를 삭제할까요?`)) return;
    setActionError(null);
    setPendingAction("delete");
    try {
      await deleteFile(file.id);
      await invalidate();
    } catch (e) {
      setActionError(`삭제 실패: ${(e as Error).message}`);
      setPendingAction(null);
    }
  };

  const retriable = file.status === "failed" || file.status === "partial";

  return (
    <li className="rounded-lg border border-accent-border/30 bg-bg-elevated p-3">
      <div className="flex items-center gap-2">
        {file.status === "indexed" ? (
          <CheckCircle2 size={15} className="shrink-0 text-positive" />
        ) : (
          <FileText size={15} className="shrink-0 text-fg-muted" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm text-fg" title={fileName(file)}>
          {fileName(file)}
        </span>
        <span className="shrink-0 text-xs text-fg-muted">
          {formatBytes(file.size_bytes)}
        </span>
        {file.kind === "textbook" && (
          <span className="shrink-0 rounded-full bg-accent/40 px-2 py-0.5 text-[11px] font-medium text-accent-fg">
            교과서
          </span>
        )}
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.cls}`}
        >
          {meta.label}
        </span>
        {retriable && (
          <button
            type="button"
            onClick={handleRetry}
            disabled={pendingAction != null}
            title="재시도"
            className="flex shrink-0 items-center gap-1 rounded-md border border-accent-border/50 px-2 py-1 text-[11px] text-fg-muted transition-colors hover:bg-accent/20 hover:text-fg disabled:opacity-50"
          >
            <RotateCcw size={12} />
            {pendingAction === "retry" ? "재시도 중…" : "재시도"}
          </button>
        )}
        <button
          type="button"
          onClick={handleDelete}
          disabled={pendingAction != null}
          title="삭제"
          className="flex shrink-0 items-center gap-1 rounded-md border border-danger/30 px-2 py-1 text-[11px] text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
        >
          <Trash2 size={12} />
          {pendingAction === "delete" ? "삭제 중…" : "삭제"}
        </button>
      </div>

      {meta.progress && (
        <div className="mt-2 flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-accent/20">
            <div
              className="h-full rounded-full bg-accent-deep transition-all"
              style={{ width: `${total > 0 ? pct : 8}%` }}
            />
          </div>
          {total > 0 && (
            <span className="shrink-0 text-[11px] tabular-nums text-fg-muted">
              {done}/{total}
            </span>
          )}
        </div>
      )}

      {(file.status === "failed" || file.status === "partial") && file.error && (
        <p className="mt-1 text-[11px] text-danger">{file.error}</p>
      )}
      {actionError && (
        <p className="mt-1 text-[11px] text-danger">{actionError}</p>
      )}
    </li>
  );
}
