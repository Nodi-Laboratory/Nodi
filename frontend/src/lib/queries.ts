"use client";

import {
  type QueryClient,
  useQuery,
} from "@tanstack/react-query";
import {
  getConceptMap,
  getHomeSummary,
  fetchTeacherOverview,
  getSession,
  listClassLecturePackages,
  listClassMaterials,
  listClassStudents,
  listFiles,
  listLecturePackages,
  listLectureVideos,
  listSessionFiles,
  listSessions,
  listStudentClassSessions,
  listTeacherClasses,
  type ClassLecturePackage,
  type ConceptMapData,
  type LecturePackage,
  type LectureVideo,
  type SpaceTarget,
} from "@/lib/api";
import type {
  FileRow,
  HomeSummary,
  SessionDetail,
  SessionRow,
  TeacherClass,
  TeacherClassOverview,
  TeacherStudent,
} from "@/lib/types";

const FILE_IN_PROGRESS = new Set(["uploaded", "splitting", "embedding"]);

/**
 * 08 G(D67): staleTime 차등 정책. 전역 기본 60s(providers.tsx) 위에 데이터 변화
 * 빈도에 맞춰 차등화한다 — 자주 안 바뀌는 목록(파일·태그)은 길게, 세션·노드는 중간.
 * 쓰기 작업은 명시 invalidate로 즉시 갱신하므로 길게 잡아도 정합성은 유지된다.
 */
export const STALE = {
  /** 세션 목록: 생성/이름변경/삭제는 invalidate로 즉시 반영. */
  sessions: 30 * 1000,
  /** 세션 상세(노드): 채팅 done 후 invalidate. 재진입 캐시 적중용 중간값. */
  sessionDetail: 30 * 1000,
  /** 파일 목록: 거의 안 바뀜(진행 중이면 폴링이 별도로 갱신). */
  files: 5 * 60 * 1000,
} as const;

export function sessionsKey(target: SpaceTarget) {
  return ["sessions", target.space_kind, target.space_ref ?? null] as const;
}

// ── 교사 컨트롤 패널 (Stage 4b) ──────────────────────────────────────

export function classMaterialsKey(classId: string | null) {
  return ["teacher", "materials", classId] as const;
}

export function useTeacherClasses() {
  return useQuery<TeacherClass[]>({
    queryKey: ["teacher", "classes"],
    queryFn: listTeacherClasses,
  });
}

/** D67: 교사 콘솔 홈 — 학급 개요(학생수·자료수·최근활동). */
export function useTeacherOverview() {
  return useQuery<TeacherClassOverview[]>({
    queryKey: ["teacher", "overview"],
    queryFn: fetchTeacherOverview,
  });
}

export function useClassStudents(classId: string | null) {
  return useQuery<TeacherStudent[]>({
    queryKey: ["teacher", "students", classId],
    queryFn: () => listClassStudents(classId as string),
    enabled: !!classId,
  });
}

export function useStudentClassSessions(
  classId: string | null,
  userId: string | null,
) {
  return useQuery<SessionRow[]>({
    queryKey: ["teacher", "student-sessions", classId, userId],
    queryFn: () => listStudentClassSessions(classId as string, userId as string),
    enabled: !!classId && !!userId,
  });
}

/** 학급 자료 목록. 임베딩 진행 중이면 2.5초 폴링. */
export function useClassMaterials(classId: string | null) {
  return useQuery<FileRow[]>({
    queryKey: classMaterialsKey(classId),
    queryFn: () => listClassMaterials(classId as string),
    enabled: !!classId,
    refetchInterval: (query) => {
      const data = query.state.data;
      const active = data?.some((f) => FILE_IN_PROGRESS.has(f.status));
      return active ? 2500 : false;
    },
  });
}

// ── 강의 패키지 (admin, D149) ────────────────────────────────────────

export function lecturePackagesKey() {
  return ["lecture-packages"] as const;
}
export function lectureVideosKey(pkgId: string) {
  return ["lecture-videos", pkgId] as const;
}

/** 강의 패키지 목록. */
export function useLecturePackages() {
  return useQuery<LecturePackage[]>({
    queryKey: lecturePackagesKey(),
    queryFn: listLecturePackages,
  });
}

/** 선택 패키지의 영상 목록. 파싱 대기·진행 중이면 3초 폴링(materials 패턴). */
export function useLectureVideos(pkgId: string | null) {
  return useQuery<LectureVideo[]>({
    queryKey: lectureVideosKey(pkgId ?? ""),
    queryFn: () => listLectureVideos(pkgId as string),
    enabled: !!pkgId,
    refetchInterval: (query) => {
      const data = query.state.data;
      const active = data?.some(
        (v) => v.status === "pending" || v.status === "parsing",
      );
      return active ? 3000 : false;
    },
  });
}

// ── 학급 강의 패키지 선택 (teacher, D149) ────────────────────────────

export const classLecturePackagesKey = (classId: string) =>
  ["class-lecture-packages", classId] as const;

/** 이 학급에서 켜고 끌 수 있는 admin 강의 패키지 목록. */
export function useClassLecturePackages(classId: string) {
  return useQuery<ClassLecturePackage[]>({
    queryKey: classLecturePackagesKey(classId),
    queryFn: () => listClassLecturePackages(classId),
  });
}

export function sessionKey(sessionId: string | null) {
  return ["session", sessionId] as const;
}

export function filesKey(target: SpaceTarget) {
  return ["files", target.space_kind, target.space_ref ?? null] as const;
}

/** 현재 공간의 세션 목록 (updated_at desc, 백엔드 정렬). */
export function useSessions(target: SpaceTarget) {
  return useQuery<SessionRow[]>({
    queryKey: sessionsKey(target),
    queryFn: () => listSessions(target),
    staleTime: STALE.sessions,
  });
}

/** 선택 세션 상세 ({session, nodes[]}). */
export function useSessionDetail(sessionId: string | null) {
  return useQuery<SessionDetail>({
    queryKey: sessionKey(sessionId),
    queryFn: () => getSession(sessionId as string),
    enabled: !!sessionId,
    staleTime: STALE.sessionDetail,
  });
}

/** 현재 공간의 파일 목록. 임베딩 진행 중이면 2.5초 폴링, 완료되면 중지. */
export function useFiles(target: SpaceTarget) {
  return useQuery<FileRow[]>({
    queryKey: filesKey(target),
    queryFn: () => listFiles(target),
    staleTime: STALE.files,
    refetchInterval: (query) => {
      const data = query.state.data;
      const active = data?.some((f) => FILE_IN_PROGRESS.has(f.status));
      return active ? 2500 : false;
    },
  });
}

export function sessionFilesKey(sessionId: string | null) {
  return ["files", "session", sessionId] as const;
}

/** D83: 세션 컨텍스트 파일 목록. 처리 중이면 2.5초 폴링(기존 패턴 재사용). */
export function useSessionFiles(sessionId: string | null) {
  return useQuery<FileRow[]>({
    queryKey: sessionFilesKey(sessionId),
    queryFn: () => listSessionFiles(sessionId as string),
    enabled: !!sessionId,
    staleTime: STALE.files,
    refetchInterval: (query) => {
      const data = query.state.data;
      const active = data?.some((f) => FILE_IN_PROGRESS.has(f.status));
      return active ? 2500 : false;
    },
  });
}

/**
 * 08 G(D67): 세션 진입 직전 선반입. 세션 hover/클릭 시 그 세션의 상세(노드)를
 * 미리 받아 화면 도착 시 이미 채워지게 한다(cold 워터폴 제거).
 * 임시(낙관) id는 호출하지 않는다(호출부에서 isRealId 가드).
 */
export function prefetchSessionData(qc: QueryClient, sessionId: string) {
  void qc.prefetchQuery({
    queryKey: sessionKey(sessionId),
    queryFn: () => getSession(sessionId),
    staleTime: STALE.sessionDetail,
  });
}

/** 홈 요약(공간/최근 세션). */
/**
 * 개념 지도 (D189).
 *
 * 계산이 가벼운 조회가 아니다(Qdrant 왕복 + 카드 수백 장). 홈을 드나들 때마다
 * 다시 받으면 지도가 매번 처음부터 뭉치는 것이 보인다 — 캐시를 넉넉히 둬서
 * **돌아왔을 때 같은 지도**가 그대로 있게 한다.
 */
export function useConceptMap() {
  return useQuery<ConceptMapData>({
    queryKey: ["home", "concept-map"],
    queryFn: () => getConceptMap(),
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
  });
}

export function useHomeSummary() {
  return useQuery<HomeSummary>({
    queryKey: ["home", "summary"],
    queryFn: () => getHomeSummary(),
  });
}
