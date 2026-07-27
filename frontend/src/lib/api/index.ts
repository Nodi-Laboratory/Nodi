/**
 * 백엔드 API 클라이언트 (D102).
 *
 * 과거에는 `lib/api.ts` 한 파일에 806줄·35개 export가 몰려 있었다. 두 사람이
 * 서로 다른 기능을 만져도 같은 파일에서 충돌했고, "어디를 고쳐야 하는지" 찾는
 * 비용도 컸다. 백엔드 라우터 구조와 1:1로 맞춰 도메인별로 쪼갰다.
 *
 * **호출부는 바뀌지 않는다** — 계속 `@/lib/api`에서 임포트하면 되고, 이 배럴이
 * 같은 표면을 그대로 다시 내보낸다.
 *
 * 새 엔드포인트를 추가할 때는 해당 도메인 모듈에 넣고 여기에 한 줄 더한다.
 * 공용 인프라(토큰 캐시·헤더·오류)는 `_core.ts`에 있으며 앱 코드는 직접 쓰지 않는다.
 */

export { ApiError, clearTokenCache } from "./_core";

export type { AuthResult } from "./auth";
export { signup, login, authErrorMessage } from "./auth";

export { getProfile, listMyClasses, joinClass, updateDisplayName } from "./profile";

export type { SpaceTarget } from "./sessions";
export {
  spaceTargetFromId,
  listSessions,
  createSession,
  patchSession,
  deleteSession,
  completeOnboarding,
  getSession,
} from "./sessions";

export {
  uploadFile,
  listFiles,
  listSessionFiles,
  listClassMaterials,
  getFile,
  deleteFile,
  retryFile,
  getChunkContext,
} from "./files";

export {
  listTeacherClasses,
  fetchTeacherOverview,
  createClass,
  listClassStudents,
  listStudentClassSessions,
} from "./teacher";

export { addConnection, removeConnection } from "./nodes";

export type { ChatStreamBody, ChatStreamHandlers } from "./chat";
export { streamChat } from "./chat";

export type {
  RetrieveFigureHit,
  RetrieveResult,
  NodeCanvasAttachment,
} from "./retrieve";
export { retrieve, getFigure } from "./retrieve";

export { getHomeSummary } from "./home";

export {
  listAdminUsers,
  setUserRole,
  listAdminSettings,
  putAdminSetting,
  getAdminLogs,
  getAdminLogDetail,
} from "./admin";

