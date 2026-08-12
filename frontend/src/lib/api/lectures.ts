/**
 * 강의 클립 추천 API 클라이언트 (D149).
 *
 * admin — 강의 패키지·영상·클립 관리(인제스트 경로, Task 12).
 * teacher — 학급별 패키지 노출 토글(Task 13).
 *
 * 백엔드 응답은 snake_case 그대로 둔다(레거시 도메인 모듈과 동일 규약) — 프론트
 * 소비부에서 필요한 곳만 camelCase로 매핑한다.
 */
import { API_BASE, authHeaders, ensureOk } from "./_core";

export interface LecturePackage {
  id: string;
  grade: string;
  subject: string;
  title: string;
}
export interface LectureVideo {
  id: string;
  page_url: string;
  title: string;
  status: string;
  error?: string | null;
}
export interface LectureClipRow {
  id: string;
  seq: number;
  start_sec: number;
  title: string;
  status: string;
}

async function j<T>(res: Response): Promise<T> {
  return (await ensureOk(res)).json();
}

// ── admin ────────────────────────────────────────────────────────────

export async function listLecturePackages(): Promise<LecturePackage[]> {
  return j(
    await fetch(`${API_BASE}/admin/lecture-packages`, {
      headers: await authHeaders(),
    }),
  );
}

export async function createLecturePackage(b: {
  grade: string;
  subject: string;
  title: string;
}): Promise<LecturePackage> {
  return j(
    await fetch(`${API_BASE}/admin/lecture-packages`, {
      method: "POST",
      headers: await authHeaders(true),
      body: JSON.stringify(b),
    }),
  );
}

export async function deleteLecturePackage(id: string): Promise<void> {
  await ensureOk(
    await fetch(`${API_BASE}/admin/lecture-packages/${id}`, {
      method: "DELETE",
      headers: await authHeaders(),
    }),
  );
}

export async function listLectureVideos(
  packageId: string,
): Promise<LectureVideo[]> {
  return j(
    await fetch(`${API_BASE}/admin/lecture-packages/${packageId}/videos`, {
      headers: await authHeaders(),
    }),
  );
}

/** 업로드 결과 — 들어간 것과 **건너뛴 것**을 함께 준다. */
export interface LectureUploadResult {
  added: (LectureVideo & { clips: number; embedding: boolean })[];
  skipped: { file: string; reason: string }[];
}

/**
 * 파싱 파일 여러 개를 한 번에 올린다 (2026-08-10).
 *
 * 예전에는 url·제목을 보내면 서버가 EBS를 긁고 Whisper로 전사했다. 대회 규정상
 * 제품 안에서 해외 모델을 못 써서 그 경로를 걷어냈다 — 파싱은 저장소 밖
 * 오프라인 스크립트가 끝내고, 여기서는 그 결과 JSON을 보낸다.
 */
export async function uploadLectureDocs(
  packageId: string,
  files: File[],
): Promise<LectureUploadResult> {
  const fd = new FormData();
  for (const f of files) fd.append("files", f);
  // multipart — authHeaders()(json=false): Content-Type 미지정으로 FormData가
  // boundary를 잡는다.
  return j(
    await fetch(`${API_BASE}/admin/lecture-packages/${packageId}/videos`, {
      method: "POST",
      headers: await authHeaders(),
      body: fd,
    }),
  );
}

/**
 * 이 영상의 클립을 **다시 임베딩**한다 (2026-08-12).
 *
 * 행은 `embedded`인데 Qdrant에 벡터가 없는 상태를 되돌린다 — 그 상태에서는
 * 검색이 오류 없이 0건이라 화면에는 "추천이 안 뜬다"로만 보인다.
 */
export async function reembedLectureVideo(
  videoId: string,
): Promise<{ ok: boolean; clips: number }> {
  return j(
    await fetch(`${API_BASE}/admin/lecture-videos/${videoId}/reembed`, {
      method: "POST",
      headers: await authHeaders(),
    }),
  );
}

export async function deleteLectureVideo(videoId: string): Promise<void> {
  await ensureOk(
    await fetch(`${API_BASE}/admin/lecture-videos/${videoId}`, {
      method: "DELETE",
      headers: await authHeaders(),
    }),
  );
}

export async function listLectureClips(
  videoId: string,
): Promise<LectureClipRow[]> {
  return j(
    await fetch(`${API_BASE}/admin/lecture-videos/${videoId}/clips`, {
      headers: await authHeaders(),
    }),
  );
}

// ── teacher ──────────────────────────────────────────────────────────

export interface ClassLecturePackage extends LecturePackage {
  enabled: boolean;
}

export async function listClassLecturePackages(
  classId: string,
): Promise<ClassLecturePackage[]> {
  return j(
    await fetch(`${API_BASE}/teacher/classes/${classId}/lecture-packages`, {
      headers: await authHeaders(),
    }),
  );
}

export async function toggleClassLecturePackage(
  classId: string,
  packageId: string,
  enabled: boolean,
): Promise<void> {
  await ensureOk(
    await fetch(
      `${API_BASE}/teacher/classes/${classId}/lecture-packages/${packageId}`,
      {
        method: "PUT",
        headers: await authHeaders(true),
        body: JSON.stringify({ enabled }),
      },
    ),
  );
}

// --- 강의 클립 썸네일 (D190) -------------------------------------------------
//
// EBS 썸네일을 가져올 방법이 없어(저작권·차단) 관리자가 올려 둔 그림 중에서
// 클립마다 하나를 골라 쓴다. 어느 것을 쓸지는 `lib/canvas2/clipThumb.ts`가
// clip id로 정한다 — 서버가 매번 무작위로 주면 볼 때마다 그림이 달라진다.

export interface ClipThumbnail {
  id: string;
  name: string | null;
  mime: string;
  size_bytes: number;
  created_at: string;
}

/** 학생 화면이 고를 수 있는 썸네일 목록. */
export async function listClipThumbnails(): Promise<ClipThumbnail[]> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/clip-thumbnails`, { headers: await authHeaders() }),
  );
  return (await res.json()) as ClipThumbnail[];
}

/** 썸네일 바이트 주소. `<img src>`는 인증 헤더를 못 실으니 fetch로 받아 쓴다. */
export function clipThumbnailUrl(id: string): string {
  return `${API_BASE}/clip-thumbnails/${id}/raw`;
}

// --- 관리자: 썸네일 넣고 빼기 ------------------------------------------------

export async function listClipThumbnailsAdmin(): Promise<ClipThumbnail[]> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/admin/clip-thumbnails`, { headers: await authHeaders() }),
  );
  return (await res.json()) as ClipThumbnail[];
}

export async function uploadClipThumbnail(file: File): Promise<ClipThumbnail> {
  const form = new FormData();
  form.append("file", file);
  const res = await ensureOk(
    await fetch(`${API_BASE}/admin/clip-thumbnails`, {
      method: "POST",
      headers: await authHeaders(),
      body: form,
    }),
  );
  return (await res.json()) as ClipThumbnail;
}

export async function deleteClipThumbnail(id: string): Promise<void> {
  await ensureOk(
    await fetch(`${API_BASE}/admin/clip-thumbnails/${id}`, {
      method: "DELETE",
      headers: await authHeaders(),
    }),
  );
}
