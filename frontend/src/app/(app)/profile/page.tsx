"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, joinClass, updateDisplayName } from "@/lib/api";
import { clearToken } from "@/lib/session";
import { useMyClasses, useProfile } from "@/lib/hooks";

/**
 * 프로필 설정.
 * - 본인 profile 로드(display_name/email/role)
 * - 이름 변경
 * - 학급 추가(학급 코드) + 내 학급 목록
 * - 로그아웃
 *
 * D104: Supabase 클라이언트로 DB를 직접 조작하던 것을 백엔드 API로 옮겼다.
 */
export default function ProfilePage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: profile, isLoading: profileLoading } = useProfile();
  const { data: myClasses = [] } = useMyClasses();

  // 이름 입력: react-query의 profile.display_name을 기본값으로 두고,
  // 사용자가 편집을 시작하면 nameDraft가 우선한다(effect 동기화 없이 파생값).
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const name = nameDraft ?? profile?.display_name ?? "";
  const [savingName, setSavingName] = useState(false);
  const [nameMsg, setNameMsg] = useState<string | null>(null);

  const [code, setCode] = useState("");
  const [joining, setJoining] = useState(false);
  const [classMsg, setClassMsg] = useState<string | null>(null);

  const handleSaveName = async () => {
    const trimmed = name.trim();
    if (!trimmed || !profile) return;

    setNameMsg(null);
    setSavingName(true);
    try {
      await updateDisplayName(trimmed);
      setNameMsg("저장되었습니다.");
      await queryClient.invalidateQueries({ queryKey: ["profile"] });
    } catch {
      setNameMsg("이름을 저장하지 못했습니다.");
    }
    setSavingName(false);
  };

  const handleJoinClass = async () => {
    const trimmed = code.trim();
    if (!trimmed) return;

    setClassMsg(null);
    setJoining(true);
    try {
      await joinClass(trimmed);
    } catch (err) {
      // 서버가 잘못된 코드를 404로 준다(join_class_by_code의 P0002 변환).
      setClassMsg(
        err instanceof ApiError && err.status === 404
          ? "유효하지 않은 학급 코드입니다."
          : "학급 연결에 실패했습니다.",
      );
      setJoining(false);
      return;
    }

    setCode("");
    setClassMsg("학급에 연결되었습니다.");
    await queryClient.invalidateQueries({ queryKey: ["my-classes"] });
    setJoining(false);
  };

  const handleLogout = () => {
    clearToken();
    queryClient.clear();
    router.push("/login");
    router.refresh();
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8 p-8">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-fg">프로필 설정</h1>
          <p className="mt-1 text-sm text-fg-muted">
            {profileLoading
              ? "불러오는 중…"
              : profile?.email
                ? `${profile.email}${profile.role ? ` · ${profile.role}` : ""}`
                : "이름과 가입 학급을 관리합니다."}
          </p>
        </div>
        <button
          type="button"
          onClick={handleLogout}
          className="rounded-lg border border-danger/50 px-3 py-1.5 text-sm font-medium text-danger transition-colors hover:bg-danger/10"
        >
          로그아웃
        </button>
      </header>

      {/* 이름 변경 */}
      <section className="rounded-xl border border-accent-border/30 bg-bg-elevated p-5">
        <h2 className="text-sm font-semibold text-fg">이름 변경</h2>
        <p className="mt-1 text-xs text-fg-muted">
          표시 이름(display_name)을 수정합니다.
        </p>
        <div className="mt-3 flex gap-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setNameDraft(e.target.value)}
            placeholder="표시 이름"
            className="flex-1 rounded-lg border border-accent-border/50 bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-muted"
          />
          <button
            type="button"
            onClick={handleSaveName}
            disabled={savingName || !name.trim()}
            className="rounded-lg bg-accent-deep px-4 py-2 text-sm font-medium text-white transition-colors hover:brightness-95 disabled:opacity-60"
          >
            저장
          </button>
        </div>
        {nameMsg && <p className="mt-2 text-xs text-fg-muted">{nameMsg}</p>}
      </section>

      {/* 학급 추가 */}
      <section className="rounded-xl border border-accent-border/30 bg-bg-elevated p-5">
        <h2 className="text-sm font-semibold text-fg">학급 추가</h2>
        <p className="mt-1 text-xs text-fg-muted">
          학급 코드를 입력해 새 학급에 연결합니다. (온보딩과 동일 메커니즘)
        </p>
        <div className="mt-3 flex gap-2">
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleJoinClass();
            }}
            placeholder="학급 코드"
            className="flex-1 rounded-lg border border-accent-border/50 bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-muted"
          />
          <button
            type="button"
            onClick={handleJoinClass}
            disabled={joining || !code.trim()}
            className="rounded-lg bg-accent-deep px-4 py-2 text-sm font-medium text-white transition-colors hover:brightness-110 disabled:opacity-60"
          >
            연결
          </button>
        </div>
        {classMsg && <p className="mt-2 text-xs text-fg-muted">{classMsg}</p>}

        {/* 내 학급 목록 */}
        <div className="mt-4">
          <div className="text-xs font-medium text-fg-muted">내 학급</div>
          {myClasses.length === 0 ? (
            <p className="mt-2 text-sm text-fg-muted">
              연결된 학급이 없습니다.
            </p>
          ) : (
            <ul className="mt-2 flex flex-col gap-1.5">
              {myClasses.map((m) => (
                <li
                  key={m.class_id}
                  className="flex items-center justify-between rounded-lg border border-accent-border/30 bg-bg px-3 py-2 text-sm text-fg"
                >
                  <span>{m.classes?.name ?? "학급"}</span>
                  {m.role_in_class && (
                    <span className="text-xs text-fg-muted">
                      {m.role_in_class}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
