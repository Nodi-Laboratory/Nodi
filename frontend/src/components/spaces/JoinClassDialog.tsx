"use client";

/**
 * 학급 추가 팝업 (UI 개편 2026-08-11, 요구사항 3-4).
 *
 * 6칸 PIN 상자가 세션 화면 **맨 위에 늘 펼쳐져** 있었다. 학급을 넣는 일은
 * 어쩌다 한 번인데 목록을 보러 온 사람에게 매번 자리를 차지했다 — 이제
 * `+ 학급 추가하기` 카드를 눌렀을 때만 뜬다(누르기 전에는 입력칸이 안 보인다).
 *
 * ⚠️ **오류 문구는 옮겨 온 것이다.** 원래 화면이 "그런 학급 코드가 없어요…"를
 * 이미 갖고 있었다 — 같은 뜻을 새로 지으면 두 문구가 서서히 갈린다.
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { joinClass } from "@/lib/api";
import { Dialog } from "@/components/ui/Dialog";

/** 학급 코드는 여섯 자리다. */
const CODE_LEN = 6;

export function JoinClassDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [code, setCode] = useState<string[]>(() => Array(CODE_LEN).fill(""));
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const joined = code.join("").trim();

  const 칸에집중 = (i: number) =>
    document
      .querySelector<HTMLInputElement>(`[data-join-cell="${Math.min(i, CODE_LEN - 1)}"]`)
      ?.focus();

  /**
   * **여러 글자를 한 번에 받는다** (사용자 보고 2026-08-11: "붙여넣기가 안 돼서
   * 하나하나 입력하는 게 불편하다").
   *
   * 한 칸이 한 글자만 받는다고 해서 **입력이 한 글자씩 온다는 뜻은 아니다** —
   * 붙여넣기·자동완성·문자 인증 채우기는 통째로 들어온다. 예전에는
   * `slice(0, 1)`이 나머지를 버려서, 여섯 자리를 복사해 붙여도 첫 글자만
   * 남았다. 이제 받은 만큼 **이어지는 칸에 흘려 담는다.**
   *
   * 대문자·영숫자 정규화는 여기 한 곳에서만 한다(D170). 붙여넣기 경로와
   * 타이핑 경로가 각자 정규화하면 반드시 갈린다.
   */
  const 채우기 = (from: number, raw: string) => {
    const 글자 = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!글자) {
      // 지우는 것도 이 길로 온다 — 빈 값이면 그 칸만 비운다.
      setCode((cur) => {
        const next = [...cur];
        next[from] = "";
        return next;
      });
      return;
    }
    const 쓸것 = 글자.slice(0, CODE_LEN - from);
    setCode((cur) => {
      const next = [...cur];
      for (let k = 0; k < 쓸것.length; k++) next[from + k] = 쓸것[k];
      return next;
    });
    칸에집중(from + 쓸것.length);
  };

  const setAt = (i: number, v: string) => 채우기(i, v);

  const 닫기 = () => {
    setCode(Array(CODE_LEN).fill(""));
    setMsg(null);
    setOk(false);
    onClose();
  };

  const join = useMutation({
    mutationFn: (c: string) => joinClass(c),
    /**
     * **새로고침 없이 목록에 뜬다**(요구사항 3-4). 그 목록을 그리는 쿼리를
     * 무르면 카드가 바로 늘어난다 — 학생이 "들어갔다"는 말만 보고 아무 변화가
     * 없으면 정말 들어갔는지 알 수 없다.
     */
    onSuccess: async () => {
      setOk(true);
      setMsg("학급에 들어갔어요.");
      await qc.invalidateQueries({ queryKey: ["spaces", "overview"] });
      await qc.invalidateQueries({ queryKey: ["my-classes"] });
      window.setTimeout(닫기, 700);
    },
    /**
     * 상황마다 다른 말을 한다(요구사항 3-4). 코드가 틀린 것과 서버가 안 되는
     * 것은 학생이 할 일이 다르다 — 앞은 선생님께 묻고, 뒤는 기다린다.
     */
    onError: (e: unknown) => {
      const st = (e as { status?: number })?.status;
      setMsg(
        st === 404
          ? "그런 학급 코드가 없어요. 선생님께 다시 확인해 주세요."
          : st === 409
            ? "이미 들어가 있는 학급이에요."
            : st === 410
              ? "만료된 코드예요. 선생님께 새 코드를 받아 주세요."
              : "지금은 들어갈 수 없어요. 잠시 뒤 다시 해 주세요.",
      );
    },
  });

  return (
    <Dialog
      open={open}
      onClose={닫기}
      label="학급 추가하기"
      header={<span className="text-[17px] font-bold text-fg">학급 추가하기</span>}
      width="max-w-md"
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (joined.length < CODE_LEN || join.isPending) return;
          setMsg(null);
          join.mutate(joined);
        }}
      >
        <p className="text-[14px] text-fg-muted">
          선생님께 받은 PIN 번호를 입력해주세요.
        </p>

        {/* ⚠️ 좁은 화면에서 여섯 칸이 한 줄에 들어가야 "코드 여섯 자리"라는
            모양이 유지된다(실측 2026-08-10: 390px에서 뒤 두 칸이 잘렸다). */}
        <div className="flex flex-wrap items-center justify-center gap-2">
          {Array.from({ length: CODE_LEN }, (_, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                data-join-cell={i}
                value={code[i]}
                onChange={(e) => setAt(i, e.target.value)}
                /**
                 * ⚠️ **`maxLength={1}`이 붙여넣기를 먼저 자른다.** 그래서
                 * `onChange`만으로는 여섯 자리를 못 받는다 — 브라우저가 값을
                 * 한 글자로 줄인 뒤에 부르기 때문이다. 클립보드에서 직접
                 * 읽어 우리가 흘려 담는다.
                 */
                onPaste={(e) => {
                  const t = e.clipboardData.getData("text");
                  if (!t) return;
                  e.preventDefault();
                  채우기(i, t);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Backspace" && !code[i] && i > 0) {
                    document
                      .querySelector<HTMLInputElement>(`[data-join-cell="${i - 1}"]`)
                      ?.focus();
                  }
                }}
                inputMode="text"
                maxLength={1}
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                aria-label={`학급 코드 ${i + 1}번째 자리`}
                className="h-12 w-11 rounded-xl py-3 text-center text-xl font-semibold text-fg outline-none max-[420px]:h-11 max-[420px]:w-9 max-[420px]:text-base"
                style={{ background: "var(--surface)" }}
              />
              {i === 2 && <span className="px-0.5 text-fg-muted">–</span>}
            </div>
          ))}
        </div>

        {msg && (
          <p
            className="text-center text-[13px]"
            style={{ color: ok ? "var(--accent-deep)" : "var(--danger)" }}
            role="status"
          >
            {msg}
          </p>
        )}

        <button
          type="submit"
          disabled={joined.length < CODE_LEN || join.isPending}
          className="rounded-full py-3.5 text-[15px] font-semibold transition-opacity disabled:opacity-40"
          style={{ background: "var(--accent-mid)", color: "var(--accent-fg)" }}
        >
          {join.isPending ? "넣는 중…" : "추가하기"}
        </button>
      </form>
    </Dialog>
  );
}
