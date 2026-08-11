"use client";

import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ImagePlus, Trash2 } from "lucide-react";
import {
  clipThumbnailUrl,
  deleteClipThumbnail,
  listClipThumbnailsAdmin,
  uploadClipThumbnail,
  type ClipThumbnail,
} from "@/lib/api";
import { authHeaders } from "@/lib/api/_core";
import { Panel, Empty, Loading, Failed, nf } from "./ui";

const KEY = ["admin", "clip-thumbnails"];

/**
 * 썸네일 미리보기.
 *
 * 인증이 Bearer 전용이라 `<img src>`로는 401이다(학생 화면과 같은 사정, D190) —
 * 바이트를 받아 object URL로 쓴다. 질의로 두면 같은 그림을 두 번 안 받는다.
 */
function Thumb({ id }: { id: string }) {
  const { data: url } = useQuery({
    queryKey: ["admin", "clip-thumbnail-blob", id],
    queryFn: async () => {
      const res = await fetch(clipThumbnailUrl(id), { headers: await authHeaders() });
      if (!res.ok) return null;
      return URL.createObjectURL(await res.blob());
    },
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return (
    <div className="aspect-square w-full overflow-hidden rounded bg-black/30">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element -- object URL이라 next/image가 못 다룬다
        <img src={url} alt="" className="h-full w-full object-cover" />
      ) : null}
    </div>
  );
}

/**
 * 강의 클립 썸네일 관리 (D190).
 *
 * ## 왜 이 화면이 필요한가
 *
 * 클립 카드에 그림이 없으면 "영상"으로 안 읽힌다. 그런데 **EBS 썸네일을 가져올
 * 방법이 없다** — 남의 사이트 이미지를 긁는 것은 저작권·차단 양쪽에서 문제고,
 * 링크로 걸면 저쪽이 바꾸는 순간 깨진 그림이 남는다.
 *
 * 그래서 쓸 만한 그림 몇 장을 여기 올려 두면, 클립마다 그중 하나가 붙는다
 * (사용자 결정 2026-08-06). 어느 그림이 갈지는 clip id가 정해서 **같은 클립은
 * 언제나 같은 그림**이다 — 볼 때마다 바뀌면 학생이 어제 본 카드를 못 알아본다.
 *
 * 한 장도 없으면 카드의 그림 자리가 빈다(깨진 이미지 아이콘 대신).
 */
export function ClipThumbnailsTab() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError } = useQuery<ClipThumbnail[]>({
    queryKey: KEY,
    queryFn: listClipThumbnailsAdmin,
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: KEY });

  const handleFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    setBusy(true);
    try {
      // 여러 장을 한 번에 고를 수 있게 — 한 장씩 올리면 관리자가 지겹다.
      for (const f of Array.from(files)) {
        await uploadClipThumbnail(f);
      }
      await invalidate();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const handleDelete = async (id: string) => {
    setError(null);
    try {
      await deleteClipThumbnail(id);
      await invalidate();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Panel
      title="강의 클립 썸네일"
      right={
        <label className="flex cursor-pointer items-center gap-1.5 rounded border border-white/15 px-2 py-1 text-sm text-[#e7e3d8] hover:bg-white/5">
          <ImagePlus size={14} />
          {busy ? "올리는 중…" : "그림 추가"}
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            disabled={busy}
            className="hidden"
            onChange={(e) => void handleFiles(e.target.files)}
          />
        </label>
      }
    >
      <p className="mb-3 text-xs text-[#8b857a]">
        EBS 썸네일은 가져올 수 없어서, 여기 올린 그림 중 하나가 강의 클립 카드에
        붙습니다. 어느 그림이 갈지는 클립마다 고정이라 같은 카드는 늘 같은 그림을
        보여 줍니다. 한 장도 없으면 카드의 그림 자리가 빕니다.
      </p>

      {error && (
        <p className="mb-3 rounded border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-xs text-red-300">
          {error}
        </p>
      )}

      {isLoading ? (
        <Loading />
      ) : isError ? (
        <Failed />
      ) : !data?.length ? (
        <Empty>아직 올린 그림이 없습니다. 몇 장 올려 두면 클립 카드에 붙습니다.</Empty>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3">
          {data.map((t) => (
            <li key={t.id} className="group relative">
              <Thumb id={t.id} />
              <div className="mt-1 truncate text-[11px] text-[#8b857a]" title={t.name ?? ""}>
                {t.name || "이름 없음"}
              </div>
              <div className="text-[11px] text-[#6f6a62]">
                {nf.format(Math.round(t.size_bytes / 1024))}KB
              </div>
              <button
                type="button"
                aria-label="썸네일 삭제"
                onClick={() => void handleDelete(t.id)}
                data-hover-only
                className="absolute right-1 top-1 rounded bg-black/60 p-1 text-[#e7e3d8] opacity-0 transition-opacity hover:bg-red-600/70 group-hover:opacity-100"
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
