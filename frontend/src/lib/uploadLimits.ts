/**
 * 업로드 사전 검사 (D196) — **서버 계약을 화면에서 먼저 적용한다.**
 *
 * 첨부 버튼에는 검사가 없었다. 학생이 300MB짜리를 고르면 그걸 **다 올린 뒤에야**
 * 413이 돌아온다 — 교실 와이파이에서는 몇 분을 기다린 끝에 오류만 본다.
 * 파일 크기는 고르는 순간 알 수 있으므로, 보내기 전에 같은 사유로 끊는다.
 *
 * ⚠️ **여기 값과 문구는 서버와 같아야 한다.** 서버가 진짜 게이트이고(백엔드
 * `config.file_max_bytes` · `services/files.py`의 `too_large_detail`), 이건
 * 왕복을 아끼는 앞단이다. 어긋나면 두 방향 다 나쁘다 — 화면이 더 엄격하면
 * 서버가 받아 줄 파일을 막고, 화면이 더 헐거우면 사전 검사가 하는 일이 없다.
 * 학생이 같은 파일로 두 사유("너무 큽니다" / "File exceeds…")를 보게 되는 것도
 * 막는다: 문구를 서버의 `too_large_detail`과 같은 모양으로 적는다(D188).
 *
 * admin이 노브(`file_max_bytes`)를 **내리면** 화면은 그대로라 서버가 413으로
 * 끊는다 — 그때 뜨는 것은 서버 detail이므로 안내는 여전히 한국어로 맞는다.
 */

/** 학생 세션 첨부·개인 업로드 상한 (백엔드 `file_max_bytes` 기본값). */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** 교사 학급 자료·교과서 상한 (백엔드 `class_material_max_bytes` 기본값). */
export const MAX_CLASS_MATERIAL_BYTES = 500 * 1024 * 1024;

/** D75: 서버 화이트리스트(`services/files.py` ALLOWED_UPLOAD_EXTENSIONS)와 같은 목록. */
export const ALLOWED_UPLOAD_EXTENSIONS = [
  "pdf", "png", "jpg", "jpeg", "webp", "gif", "txt", "md",
] as const;

/** `<input type="file" accept>` 값 — 고르는 창에서부터 목록 밖을 안 보여 준다. */
export const UPLOAD_ACCEPT = ALLOWED_UPLOAD_EXTENSIONS.map((e) => `.${e}`).join(",");

export const UNSUPPORTED_TYPE_MSG =
  "지원 형식: PDF, 이미지(PNG/JPG/WEBP/GIF), 텍스트(TXT/MD)";

/** 상한 안내용 MB 표기 — 서버 `too_large_detail`과 같은 반올림(정수 MB). */
export function megabytes(n: number): string {
  return `${Math.round(n / 1024 / 1024)}MB`;
}

export function fileExtension(name: string): string {
  return name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "";
}

/**
 * 고른 파일이 서버 계약에 맞는지. **문제가 있으면 한국어 사유, 없으면 null.**
 *
 * 빈 파일도 여기서 끊는다 — 서버도 422로 끊지만, 그 왕복을 아낀다.
 */
export function checkUploadFile(
  file: File,
  opts: { maxBytes?: number; pdfOnly?: boolean } = {},
): string | null {
  const maxBytes = opts.maxBytes ?? MAX_UPLOAD_BYTES;
  const ext = fileExtension(file.name);

  if (opts.pdfOnly) {
    if (ext !== "pdf") return "교과서는 PDF 파일만 업로드할 수 있습니다.";
  } else if (!(ALLOWED_UPLOAD_EXTENSIONS as readonly string[]).includes(ext)) {
    return UNSUPPORTED_TYPE_MSG;
  }
  if (file.size === 0) return "빈 파일은 업로드할 수 없습니다.";
  if (file.size > maxBytes) {
    // 서버 `too_large_detail(size, max)`과 같은 문장 — 어느 쪽이 먼저 걸리든
    // 학생·교사가 보는 말이 같다.
    return `파일이 너무 큽니다(${megabytes(file.size)}). ${megabytes(
      maxBytes,
    )}까지 올릴 수 있습니다.`;
  }
  return null;
}
