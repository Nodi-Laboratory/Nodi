"use client";

/**
 * 학급 프로필 사진 설정 (사용자 지시 2026-08-09).
 *
 * 학생의 세션 선택 화면에서 학급을 **그림으로** 알아보게 하는 그 사진이다.
 * 정하는 사람은 그 학급의 선생님뿐이고(서버가 판정), 여기가 그 창구다.
 *
 * 미리 보기를 **올린 뒤 서버 주소로** 바꾼다. 고른 파일을 그대로 보여 주면
 * 저장이 실패해도 성공한 것처럼 보인다 — 학생 화면에는 안 뜨는데 선생님
 * 화면에만 뜨는 상태가 가장 나쁘다.
 */

import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ImagePlus } from "lucide-react";
import { classAvatarUrl, putClassAvatar } from "@/lib/api/spaces";
import { useAuthedImage } from "@/lib/ui/useAuthedImage";

export function ClassAvatarSetting({ classId }: { classId: string }) {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  /** 캐시를 깨는 값. 같은 주소로 다시 받으면 옛 그림이 그대로 온다. */
  const [stamp, setStamp] = useState(0);
  /**
   * 바꾼 직후에도 새 사진이 보여야 한다 — `stamp`를 주소에 달아 훅이 다시
   * 받게 한다(브라우저 캐시도 이 값으로 갈린다).
   */
  const preview = useAuthedImage(
    `${classAvatarUrl(classId)}${stamp ? `?v=${stamp}` : ""}`,
  );

  const pick = async (file: File) => {
    setBusy(true);
    setMsg(null);
    try {
      await putClassAvatar(classId, file);
      setStamp((n) => n + 1);
      setMsg("사진을 바꿨어요.");
      await qc.invalidateQueries({ queryKey: ["spaces", "overview"] });
    } catch (e) {
      const status = (e as { status?: number })?.status;
      setMsg(
        status === 413
          ? "사진이 너무 커요. 4MB까지 올릴 수 있어요."
          : status === 422
            ? "PNG·JPEG·WebP 그림만 올릴 수 있어요."
            : status === 403
              ? "이 학급의 선생님만 바꿀 수 있어요."
              : "지금은 바꿀 수 없어요. 잠시 뒤 다시 해 주세요.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex items-center gap-4 rounded-xl border border-accent-border/60 bg-bg-elevated p-4">
      <div className="h-16 w-16 overflow-hidden rounded-xl bg-accent-soft/50">
        {/* ⚠️ 주소를 그대로 넣으면 401이다 — `<img>`는 토큰을 못 싣는다
            (`lib/ui/useAuthedImage.ts`). 사진이 아직 없으면 빈 칸이 기본 상태다. */}
        {preview && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="" className="h-full w-full object-cover" />
        )}
      </div>
      <div className="flex flex-col gap-1">
        <div className="text-sm font-medium text-fg">학급 사진</div>
        <p className="text-[13px] text-fg-muted">
          학생이 세션을 고를 때 이 사진으로 학급을 알아봅니다.
        </p>
        {msg && <p className="text-[13px] text-fg-muted">{msg}</p>}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          // 같은 파일을 다시 고를 수 있게 값을 비운다.
          e.target.value = "";
          if (f) void pick(f);
        }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        className="ml-auto flex items-center gap-2 rounded-lg border border-accent-border px-3 py-2 text-sm text-fg transition-colors hover:bg-accent-soft/60 disabled:opacity-50"
      >
        <ImagePlus size={15} />
        {busy ? "올리는 중…" : "사진 바꾸기"}
      </button>
    </section>
  );
}
