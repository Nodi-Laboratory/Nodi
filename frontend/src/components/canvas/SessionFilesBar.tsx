"use client";

// D83: 세션 컨텍스트 파일 상태 칩 바 — BottomBar 위에 부착. 첨부 진입점은
// BottomBar(프롬프트 창)로 이동했고, 이 바는 칩 렌더·삭제·업로드 오류 표시 전용.
// 상태 3종: 처리 중(스피너) / indexed("세션 컨텍스트로 사용 중") /
// failed(서버 한국어 사유 + 삭제). 업로드 실패(413/422)의 detail은 uploadError로 표시.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, FileText, Loader2, Trash2, XCircle } from "lucide-react";
import { deleteFile } from "@/lib/api";
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
  uploadError,
}: {
  sessionId: string | null;
  // 업로드 오류는 소유자(ConceptCanvasWorkspace)가 넘긴다(내부 상태 없음).
  uploadError?: string | null;
}) {
  const queryClient = useQueryClient();
  const { data: files } = useSessionFiles(sessionId);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: sessionFilesKey(sessionId) });

  const remove = useMutation({
    mutationFn: (fileId: string) => deleteFile(fileId),
    onSuccess: invalidate,
  });

  // 세션 없음 = 칩 없음(정상) — 첨부 진입점은 이제 BottomBar가 담당한다.
  if (!sessionId) return null;

  return (
    <div className={styles.bar}>
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
