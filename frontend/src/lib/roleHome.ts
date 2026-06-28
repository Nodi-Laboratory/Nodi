/** role별 기본 진입 경로(D19). */
export function roleHome(role?: string | null): string {
  if (role === "admin") return "/admin";
  if (role === "teacher") return "/teacher";
  return "/home";
}
