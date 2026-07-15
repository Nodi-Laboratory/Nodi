"use client";

// D83: 세션 컨텍스트 파일 바 — 첨부 버튼 + 파일 상태 칩. BottomBar 위에 부착.
// 상태 3종: 처리 중(스피너) / indexed("세션 컨텍스트로 사용 중") /
// failed(서버 한국어 사유 + 삭제). 업로드 실패(413/422)의 detail도 그대로 표시.

import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  FileText,
  Loader2,
  Paperclip,
  Trash2,
  XCircle,
} from "lucide-react";
import { deleteFile, uploadFile, type SpaceTarget } from "@/lib/api";
import { sessionFilesKey, useSessionFiles } from "@/lib/queries";
import type { FileRow } from "@/lib/types";
import styles from "./SessionFilesBar.module.css";

const IN_PROGRESS = new Set(["uploaded", "splitting", "embedding"]);

function chipStatus(f: FileRow): "progress" | "ready" | "failed" {
  if (f.status === "indexed") return "ready";
  if (IN_PROGRESS.has(f.status)) return "progress";
  return "failed"; // failed | partial(발생 안 함 — 방어)
}

export default function SessionFilesBar({
  sessionId,
  target,
}: {
  sessionId: string | null;
  target: SpaceTarget;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { data: files } = useSessionFiles(sessionId);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: sessionFilesKey(sessionId) });

  const upload = useMutation({
    mutationFn: (file: File) =>
      uploadFile(target, file, { session_id: sessionId as string }),
    onSuccess: () => {
      setUploadError(null);
      invalidate();
    },
    onError: (e: Error) => setUploadError(e.message),
  });

  const remove = useMutation({
    mutationFn: (fileId: string) => deleteFile(fileId),
    onSuccess: invalidate,
  });

  if (!sessionId) return null;

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // 같은 파일 재선택 허용
    if (file) upload.mutate(file);
  };

  return (
    <div className={styles.bar}>
      <button
        type="button"
        className={styles.attach}
        onClick={() => inputRef.current?.click()}
        disabled={upload.isPending}
        title="이 세션의 컨텍스트로 파일 첨부"
      >
        {upload.isPending ? (
          <Loader2 size={14} className={styles.spin} />
        ) : (
          <Paperclip size={14} />
        )}
        <span>파일 첨부</span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,.md"
        className={styles.hiddenInput}
        onChange={onPick}
      />

      {(files ?? []).map((f) => {
        const st = chipStatus(f);
        return (
          <span key={f.id} className={`${styles.chip} ${styles[st]}`}>
            {st === "progress" && <Loader2 size={12} className={styles.spin} />}
            {st === "ready" && <CheckCircle2 size={12} />}
            {st === "failed" && <XCircle size={12} />}
            <FileText size={12} />
            <span className={styles.name}>{f.name ?? "파일"}</span>
            {st === "ready" && (
              <span className={styles.badge}>세션 컨텍스트로 사용 중</span>
            )}
            {st === "failed" && f.error && (
              <span className={styles.reason} title={f.error}>
                {f.error}
              </span>
            )}
            <button
              type="button"
              className={styles.remove}
              onClick={() => remove.mutate(f.id)}
              disabled={remove.isPending}
              title="파일 삭제"
            >
              <Trash2 size={12} />
            </button>
          </span>
        );
      })}

      {uploadError && <span className={styles.uploadError}>{uploadError}</span>}
    </div>
  );
}
