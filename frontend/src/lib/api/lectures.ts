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

export async function addLectureVideo(
  packageId: string,
  page_url: string,
  title: string,
  subtitle: File | null,
): Promise<LectureVideo> {
  const fd = new FormData();
  fd.append("page_url", page_url);
  fd.append("title", title);
  if (subtitle) fd.append("subtitle", subtitle);
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

export async function reparseLectureVideo(videoId: string): Promise<void> {
  await ensureOk(
    await fetch(`${API_BASE}/admin/lecture-videos/${videoId}/reparse`, {
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
