"use client";

/**
 * 캔버스 손글씨 폰트 관리 (D210 8-1).
 *
 * ## 왜 이 화면이 필요한가
 *
 * 손글씨 폰트는 저장소에 박혀 있어서 바꾸려면 배포를 해야 했다. 학교마다
 * 쓰고 싶은 글씨체가 다른데 그때마다 개발자를 부를 수는 없다.
 *
 * ## 적용 범위는 캔버스 손글씨뿐이다
 *
 * 앱 전체를 갈아 끼우게 하면 읽을 수 없는 폰트를 고르는 순간 **이 화면
 * 자신도 망가진다** — 되돌릴 버튼이 안 보이는 셈이다. 그래서 범위를 좁혔고,
 * 그것이 이 기능의 안전장치다.
 *
 * ## 고르기 전에 눈으로 본다
 *
 * 표본 문장에 **한글·라틴·숫자·굵게**를 섞는다. 한글만 보면 라틴이 폴백으로
 * 떨어지는 것을 못 잡는다 — 그러면 학생 화면에서 영어 단어만 다른 글씨체로
 * 나오고, 그건 올린 사람이 아니라 학생이 먼저 본다.
 *
 * 미리보기는 **통짜**(`full`)로 받는다. 학생 화면에 나가는 것은 쪼갠 것이지만,
 * 시험은 모든 글자를 볼 수 있어야 한다.
 */

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, RotateCcw, Trash2, Type, Upload } from "lucide-react";
import {
  activateHandFont,
  deleteHandFont,
  handFontUrl,
  listHandFonts,
  resetHandFont,
  tuneHandFont,
  uploadHandFont,
  type HandFontRow,
} from "@/lib/api/handFonts";
import { Panel, Empty, Loading, Failed } from "./ui";

const KEY = ["admin", "hand-fonts"];

/**
 * 표본 문장 — 한글·라틴·숫자·굵게가 **한 줄 안에** 있어야 한다.
 *
 * 셋을 따로 보여 주면 "이 폰트에 라틴이 있나"는 알 수 있어도 **한글 옆에
 * 놓였을 때 크기가 맞나**는 안 보인다. 그게 실제로 학생이 보는 모습이다.
 */
const SAMPLE = "판 구조론 Plate Tectonics 2026년 3월 15일";

/** 이보다 크면 교실 회선에서 눈에 띄게 느리다(D164에서 통짜 2.9MB를 쪼갠 이유). */
const HEAVY_BYTES = 1024 * 1024;

function kb(n: number): string {
  return n >= 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)}MB`
    : `${Math.round(n / 1024)}KB`;
}

/** 한 폰트의 미리보기. `@font-face`를 그때그때 만든다 — 이름은 slug라 겹치지 않는다. */
function Preview({ font }: { font: HandFontRow }) {
  const family = `preview-${font.slug}`;
  return (
    <>
      <style>{`@font-face{font-family:"${family}";src:url("${handFontUrl(
        font.slug,
        "full",
      )}");font-display:swap;}`}</style>
      <p
        className="mt-2 leading-snug text-white/90"
        style={{
          fontFamily: `"${family}", sans-serif`,
          // 학생 화면과 같은 계산 — 여기서만 예쁘면 소용이 없다.
          fontSize: `calc(18px * ${font.size_scale})`,
          letterSpacing: `${font.letter_spacing}em`,
        }}
      >
        {SAMPLE} <b>굵게 Bold 123</b>
      </p>
    </>
  );
}

/** 보정값 하나. 숫자를 직접 치게 둔다 — 슬라이더는 0.01 단위를 못 맞춘다. */
function Tune({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  return (
    <label className="flex items-center gap-1 text-[11px] text-white/50">
      {label}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const n = Number(draft);
          if (Number.isFinite(n) && n !== value) onCommit(n);
          else setDraft(String(value));
        }}
        className="w-14 rounded border border-white/15 bg-black/30 px-1 py-0.5 text-white/90"
      />
    </label>
  );
}

export function HandFontsTab() {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery({ queryKey: KEY, queryFn: listHandFonts });
  const refresh = () => qc.invalidateQueries({ queryKey: KEY });

  const act = useMutation({ mutationFn: activateHandFont, onSuccess: refresh });
  const reset = useMutation({ mutationFn: resetHandFont, onSuccess: refresh });
  const drop = useMutation({ mutationFn: deleteHandFont, onSuccess: refresh });
  const tune = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, number> }) =>
      tuneHandFont(id, patch),
    onSuccess: refresh,
  });

  async function onPick(file: File | null) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await uploadHandFont(file, label.trim() || file.name.replace(/\.[^.]+$/, ""));
      setLabel("");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const fonts = data ?? [];
  const active = fonts.find((f) => f.active) ?? null;

  return (
    <Panel
      title="캔버스 손글씨 폰트"
      right={
        <button
          type="button"
          onClick={() => reset.mutate()}
          disabled={!active || reset.isPending}
          className="flex items-center gap-1 rounded border border-white/15 px-2 py-1 text-[12px] text-white/70 disabled:opacity-40"
        >
          <RotateCcw size={13} /> 기본 폰트로
        </button>
      }
    >
      <p className="mb-3 text-[12px] leading-relaxed text-white/50">
        캔버스에 손으로 쓴 글씨에만 적용됩니다. 화면의 나머지(메뉴·라벨·이 페이지)는
        바뀌지 않습니다 — 읽을 수 없는 폰트를 골라도 되돌릴 수 있어야 하기 때문입니다.
        지금은 <b className="text-white/80">{active ? active.label : "기본 폰트(KCC 한빛체)"}</b>
        를 씁니다.
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="폰트 이름(비우면 파일명)"
          className="w-56 rounded border border-white/15 bg-black/30 px-2 py-1.5 text-[13px] text-white/90"
        />
        <input
          ref={fileRef}
          type="file"
          accept=".woff2,.ttf,.otf,font/woff2,font/ttf,font/otf"
          className="hidden"
          onChange={(e) => void onPick(e.target.files?.[0] ?? null)}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="flex items-center gap-1 rounded border border-white/15 px-3 py-1.5 text-[13px] text-white/80 disabled:opacity-40"
        >
          <Upload size={14} /> {busy ? "올리는 중…" : "폰트 올리기"}
        </button>
        <span className="text-[11px] text-white/40">woff2 · ttf · otf, 12MB까지</span>
      </div>
      {error && <p className="mb-3 text-[12px] text-red-300">{error}</p>}

      {isLoading ? (
        <Loading />
      ) : isError ? (
        <Failed />
      ) : !fonts.length ? (
        <Empty>올린 폰트가 없습니다. 기본 폰트(KCC 한빛체)로 돕니다.</Empty>
      ) : (
        <ul className="space-y-3">
          {fonts.map((f) => (
            <li
              key={f.id}
              className="rounded border p-3"
              style={{
                borderColor: f.active ? "rgba(158,201,46,.5)" : "rgba(255,255,255,.1)",
                background: f.active ? "rgba(158,201,46,.06)" : undefined,
              }}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Type size={14} className="text-white/40" />
                <span className="text-[13px] text-white/90">{f.label}</span>
                <span className="text-[11px] text-white/40">
                  {f.format} · {kb(f.size_bytes)}
                  {/* 무거운지는 **바이트**로 판단한다. `subset` 플래그는 쪼개기가
                      돌았는지만 말한다 — 이미 가벼운 폰트는 다시 쪼개도 안 줄어드는데
                      거기에 경고를 붙이면 멀쩡한 폰트가 문제로 보인다.
                      조용히 두면 교실에서 느려지는 이유를 아무도 모른다. */}
                  {f.size_bytes > HEAVY_BYTES ? " · 무거움(교실 회선에서 느립니다)" : ""}
                  {f.subset ? "" : " · 쪼개기 실패"}
                </span>
                <span className="ml-auto flex items-center gap-2">
                  <Tune
                    label="자간"
                    value={f.letter_spacing}
                    onCommit={(v) => tune.mutate({ id: f.id, patch: { letter_spacing: v } })}
                  />
                  <Tune
                    label="크기"
                    value={f.size_scale}
                    onCommit={(v) => tune.mutate({ id: f.id, patch: { size_scale: v } })}
                  />
                  <Tune
                    label="한자"
                    value={f.ideograph_scale}
                    onCommit={(v) => tune.mutate({ id: f.id, patch: { ideograph_scale: v } })}
                  />
                  <button
                    type="button"
                    onClick={() => act.mutate(f.id)}
                    disabled={f.active || act.isPending}
                    className="flex items-center gap-1 rounded border border-white/15 px-2 py-1 text-[12px] text-white/80 disabled:opacity-40"
                  >
                    <Check size={13} /> {f.active ? "쓰는 중" : "적용"}
                  </button>
                  <button
                    type="button"
                    aria-label={`${f.label} 삭제`}
                    onClick={() => drop.mutate(f.id)}
                    className="rounded p-1 text-red-300/70 hover:text-red-300"
                  >
                    <Trash2 size={13} />
                  </button>
                </span>
              </div>
              <Preview font={f} />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
