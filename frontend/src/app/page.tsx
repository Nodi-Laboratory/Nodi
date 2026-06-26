import { redirect } from "next/navigation";

// Stage 0: 루트 진입 시 홈으로 보낸다. (실제 인증 게이트는 이후 단계)
export default function RootPage() {
  redirect("/home");
}
