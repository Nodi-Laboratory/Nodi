"use client";

/**
 * 설정 — **팝업이다** (사용자 지시 2026-08-10).
 *
 * `/profile` 페이지를 걷어내고 여기로 옮겼다. 설정에서 하는 일(이름 바꾸기 ·
 * 학급 넣기 · 로그아웃)은 전부 **한 번 하고 돌아가는 일**이라, 화면을 통째로
 * 바꿀 값이 없다. 캔버스에서 열면 하던 대화가 그대로 뒤에 남는다.
 *
 * 내용은 옛 페이지 그대로다 — 옮기면서 규칙을 바꾸지 않는다(학급 코드는
 * 언제나 대문자, 잘못된 코드는 404 안내, D169/D170).
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { LogOut } from "lucide-react";
import { ApiError, joinClass, updateDisplayName } from "@/lib/api";
import { clearToken } from "@/lib/session";
import { useMyClasses, useProfile } from "@/lib/hooks";
import { Dialog } from "@/components/ui/Dialog";

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: profile, isLoading: profileLoading } = useProfile();
  const { data: myClasses = [] } = useMyClasses();

  // 이름 입력: react-query의 값이 기본값이고, 편집을 시작하면 초안이 우선한다
  // (이펙트로 동기화하지 않는 파생값 — React Compiler 규칙과도 맞는다).
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
      // 서버가 잘못된 코드를 404로 준다(join_class_by_code의 P0002 변환, D169).
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
    await queryClient.invalidateQueries({ queryKey: ["spaces", "overview"] });
    setJoining(false);
  };

  const handleLogout = () => {
    clearToken();
    queryClient.clear();
    router.push("/login");
    router.refresh();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      label="설정"
      width="max-w-lg"
      header={
        <>
          <h2 className="text-[19px] font-bold text-fg">설정</h2>
          <p className="mt-0.5 truncate text-[13px] text-fg-muted">
            {profileLoading
              ? "불러오는 중…"
              : profile?.email
                ? `${profile.email}${profile.role ? ` · ${profile.role}` : ""}`
                : "이름과 가입 학급을 관리합니다."}
          </p>
        </>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-5">
        {/* 이름 변경 */}
        <section>
          <h3 className="text-sm font-semibold text-fg">이름 변경</h3>
          <p className="mt-0.5 text-xs text-fg-muted">
            대화·학급에서 이 이름으로 보입니다.
          </p>
          <div className="mt-2.5 flex gap-2">
            <input
              type="text"
              value={name}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSaveName();
              }}
              placeholder="표시 이름"
              className="flex-1 rounded-xl bg-[var(--surface)] px-3.5 py-2.5 text-sm text-fg placeholder:text-fg-muted"
            />
            <button
              type="button"
              onClick={handleSaveName}
              disabled={savingName || !name.trim()}
              className="rounded-lg bg-accent-deep px-4 py-2 text-sm font-medium text-accent-fg transition-opacity hover:brightness-95 disabled:opacity-60"
            >
              저장
            </button>
          </div>
          {nameMsg && <p className="mt-2 text-xs text-fg-muted">{nameMsg}</p>}
        </section>

        <div className="h-px bg-accent-border/40" />

        {/* 학급 추가 */}
        <section>
          <h3 className="text-sm font-semibold text-fg">학급 추가</h3>
          <p className="mt-0.5 text-xs text-fg-muted">
            선생님께 받은 학급 코드를 입력하세요.
          </p>
          <div className="mt-2.5 flex gap-2">
            <input
              type="text"
              value={code}
              /* 코드는 언제나 대문자다(D170) — 친 그대로 보여 주면 소문자로
                 쳤을 때 "맞게 쳤는데 안 된다"가 된다. 서버도 정규화하지만
                 화면이 먼저 알려 주는 편이 낫다. */
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleJoinClass();
              }}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              placeholder="학급 코드"
              className="flex-1 rounded-xl bg-[var(--surface)] px-3.5 py-2.5 text-sm text-fg placeholder:text-fg-muted"
            />
            <button
              type="button"
              onClick={handleJoinClass}
              disabled={joining || !code.trim()}
              className="rounded-lg bg-accent-deep px-4 py-2 text-sm font-medium text-accent-fg transition-opacity hover:brightness-110 disabled:opacity-60"
            >
              연결
            </button>
          </div>
          {classMsg && <p className="mt-2 text-xs text-fg-muted">{classMsg}</p>}

          <div className="mt-4">
            <div className="text-xs font-medium text-fg-muted">내 학급</div>
            {myClasses.length === 0 ? (
              <p className="mt-2 text-sm text-fg-muted">연결된 학급이 없습니다.</p>
            ) : (
              <ul className="mt-2 flex flex-col gap-1.5">
                {myClasses.map((m) => (
                  <li
                    key={m.class_id}
                    className="flex items-center justify-between rounded-xl bg-[var(--surface)] px-3.5 py-2.5 text-sm text-fg"
                  >
                    <span>{m.classes?.name ?? "학급"}</span>
                    {m.role_in_class && (
                      <span className="text-xs text-fg-muted">{m.role_in_class}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>

      {/* 구분선은 양 끝이 변에 안 닿는다(사용자 지시 2026-08-11). */}
      <footer className="relative flex shrink-0 justify-end px-7 py-4 before:absolute before:inset-x-7 before:top-0 before:h-px before:bg-[var(--line)] before:content-['']">
        <button
          type="button"
          onClick={handleLogout}
          className="flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-sm font-medium text-danger transition-colors hover:bg-danger/10"
        >
          <LogOut size={14} />
          로그아웃
        </button>
      </footer>
    </Dialog>
  );
}
