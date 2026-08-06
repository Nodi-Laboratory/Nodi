/**
 * 업로드 사전 검사 (D196).
 *
 * 여기서 지키는 것은 **서버 계약과의 일치**다 — 상한 50MB/500MB, 확장자
 * 화이트리스트, 교과서 PDF 전용, 그리고 크기 초과 문구가 서버
 * `too_large_detail`과 같은 모양인지(D188). 값이 갈리면 화면이 서버가 받아 줄
 * 파일을 막거나(더 엄격) 사전 검사가 하는 일이 없어진다(더 헐거움).
 */
import { describe, expect, it } from "vitest";
import {
  checkUploadFile,
  megabytes,
  MAX_CLASS_MATERIAL_BYTES,
  MAX_UPLOAD_BYTES,
  UPLOAD_ACCEPT,
} from "./uploadLimits";

/** size를 원하는 값으로 둔 File — 실제로 그만큼의 바이트를 만들지 않는다. */
function fakeFile(name: string, size: number): File {
  const f = new File(["x"], name);
  Object.defineProperty(f, "size", { value: size });
  return f;
}

describe("checkUploadFile", () => {
  it("상한 이하 허용 형식은 통과한다", () => {
    expect(checkUploadFile(fakeFile("수업자료.pdf", 10 * 1024 * 1024))).toBeNull();
    expect(checkUploadFile(fakeFile("메모.MD", 100))).toBeNull(); // 대소문자 무관
  });

  it("50MB를 넘으면 서버와 같은 문장으로 끊는다", () => {
    const reason = checkUploadFile(fakeFile("교과서.pdf", 300 * 1024 * 1024));
    // 백엔드 too_large_detail: "파일이 너무 큽니다(300MB). 50MB까지 올릴 수 있습니다."
    expect(reason).toBe("파일이 너무 큽니다(300MB). 50MB까지 올릴 수 있습니다.");
  });

  it("경계값 50MB는 통과하고 1바이트만 넘어도 막힌다", () => {
    expect(checkUploadFile(fakeFile("a.pdf", MAX_UPLOAD_BYTES))).toBeNull();
    expect(checkUploadFile(fakeFile("a.pdf", MAX_UPLOAD_BYTES + 1))).not.toBeNull();
  });

  it("화이트리스트 밖 형식은 크기와 무관하게 막힌다", () => {
    expect(checkUploadFile(fakeFile("발표.pptx", 10))).toContain("지원 형식");
    expect(checkUploadFile(fakeFile("확장자없음", 10))).toContain("지원 형식");
  });

  it("빈 파일은 서버 왕복 없이 한국어로 끊는다", () => {
    expect(checkUploadFile(fakeFile("빈.txt", 0))).toContain("빈 파일");
  });

  it("교사 자료는 500MB까지 열린다", () => {
    const big = fakeFile("교과서.pdf", 400 * 1024 * 1024);
    expect(checkUploadFile(big)).not.toBeNull(); // 학생 상한으로는 막힌다
    expect(
      checkUploadFile(big, { maxBytes: MAX_CLASS_MATERIAL_BYTES }),
    ).toBeNull();
  });

  it("교과서는 PDF 전용이다", () => {
    expect(
      checkUploadFile(fakeFile("교과서.png", 10), {
        maxBytes: MAX_CLASS_MATERIAL_BYTES,
        pdfOnly: true,
      }),
    ).toContain("PDF");
  });
});

describe("표시", () => {
  it("MB 표기는 서버와 같은 반올림이다", () => {
    expect(megabytes(MAX_UPLOAD_BYTES)).toBe("50MB");
    expect(megabytes(MAX_CLASS_MATERIAL_BYTES)).toBe("500MB");
  });

  it("accept는 서버 화이트리스트와 같은 목록이다", () => {
    expect(UPLOAD_ACCEPT).toBe(".pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,.md");
  });
});
