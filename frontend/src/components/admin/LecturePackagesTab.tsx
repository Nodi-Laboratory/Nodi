"use client";

import { useState, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, RotateCw, Trash2 } from "lucide-react";
import {
  createLecturePackage,
  deleteLecturePackage,
  addLectureVideo,
  reparseLectureVideo,
  deleteLectureVideo,
  listLectureClips,
  type LecturePackage,
  type LectureVideo,
  type LectureClipRow,
} from "@/lib/api";
import {
  lecturePackagesKey,
  lectureVideosKey,
  useLecturePackages,
  useLectureVideos,
} from "@/lib/queries";
import { Panel, Badge, Empty, Loading, Failed } from "./ui";

const INPUT =
  "rounded border border-white/15 bg-[#1b1813] px-2 py-1.5 text-sm text-[#e7e3d8] placeholder:text-[#6f6a62] disabled:opacity-50";

/** 영상 파싱 상태 → 뱃지 톤. pending/parsing은 진행(warn), parsed=ok, failed=bad. */
function statusBadge(status: string) {
  const tone =
    status === "parsed"
      ? "ok"
      : status === "failed"
        ? "bad"
        : status === "pending" || status === "parsing"
          ? "warn"
          : "default";
  return <Badge tone={tone as "ok" | "bad" | "warn" | "default"}>{status}</Badge>;
}

/**
 * 강의 패키지 관리 탭 (D149, Task 17).
 *
 * admin이 강의 패키지를 만들고 EBS 영상(+자막 파일)을 붙여 인제스트를 돌린다.
 * 파싱 상태는 useLectureVideos 폴링으로 갱신되고, 영상별로 클립을 펼쳐 본다.
 */
export function LecturePackagesTab() {
  const queryClient = useQueryClient();
  const {
    data: packages,
    isLoading,
    isError,
  } = useLecturePackages();
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 패키지 생성 폼
  const [grade, setGrade] = useState("");
  const [subject, setSubject] = useState("");
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);

  const invalidatePackages = () =>
    queryClient.invalidateQueries({ queryKey: lecturePackagesKey() });

  const handleCreate = async () => {
    if (!grade.trim() || !subject.trim() || !title.trim()) {
      setError("학년·과목·제목을 모두 입력하세요.");
      return;
    }
    setError(null);
    setCreating(true);
    try {
      const pkg = await createLecturePackage({
        grade: grade.trim(),
        subject: subject.trim(),
        title: title.trim(),
      });
      await invalidatePackages();
      setGrade("");
      setSubject("");
      setTitle("");
      setSelected(pkg.id);
    } catch (e) {
      setError(`패키지 생성 실패: ${(e as Error).message}`);
    } finally {
      setCreating(false);
    }
  };

  const handleDeletePackage = async (id: string) => {
    if (!window.confirm("패키지를 삭제할까요? 영상·클립도 함께 사라집니다.")) return;
    setError(null);
    try {
      await deleteLecturePackage(id);
      if (selected === id) setSelected(null);
      await invalidatePackages();
    } catch (e) {
      setError(`패키지 삭제 실패: ${(e as Error).message}`);
    }
  };

  if (isLoading) return <Loading what="강의 패키지 불러오는" />;
  if (isError) return <Failed what="강의 패키지를 불러오지" />;

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-sm font-semibold text-[#e7e3d8]">강의 패키지</h2>
      {error && (
        <div className="rounded border border-[#e0796a]/40 bg-[#e0796a]/10 px-3 py-2 text-sm text-[#e0796a]">
          {error}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* 왼쪽: 패키지 생성 + 목록 */}
        <div className="flex flex-col gap-4">
          <Panel title="새 패키지">
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                <input
                  className={`${INPUT} w-24`}
                  placeholder="학년"
                  value={grade}
                  disabled={creating}
                  onChange={(e) => setGrade(e.target.value)}
                />
                <input
                  className={`${INPUT} flex-1`}
                  placeholder="과목"
                  value={subject}
                  disabled={creating}
                  onChange={(e) => setSubject(e.target.value)}
                />
              </div>
              <input
                className={INPUT}
                placeholder="제목"
                value={title}
                disabled={creating}
                onChange={(e) => setTitle(e.target.value)}
              />
              <button
                type="button"
                onClick={handleCreate}
                disabled={creating}
                className="inline-flex items-center justify-center gap-1 rounded bg-[#e0a32e] px-3 py-1.5 text-sm font-medium text-[#1b1813] transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                <Plus size={14} />
                {creating ? "생성 중…" : "패키지 생성"}
              </button>
            </div>
          </Panel>

          <Panel title={`패키지 목록 (${packages?.length ?? 0})`}>
            {(packages ?? []).length === 0 ? (
              <Empty>패키지가 없습니다.</Empty>
            ) : (
              <ul className="flex flex-col gap-1">
                {(packages ?? []).map((p) => (
                  <PackageRow
                    key={p.id}
                    pkg={p}
                    active={selected === p.id}
                    onSelect={() => setSelected(selected === p.id ? null : p.id)}
                    onDelete={() => handleDeletePackage(p.id)}
                  />
                ))}
              </ul>
            )}
          </Panel>
        </div>

        {/* 오른쪽: 선택 패키지의 영상 */}
        <div>
          {selected ? (
            <VideosPanel
              packageId={selected}
              onError={setError}
            />
          ) : (
            <Panel title="영상">
              <Empty>패키지를 선택하세요.</Empty>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}

function PackageRow({
  pkg,
  active,
  onSelect,
  onDelete,
}: {
  pkg: LecturePackage;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  return (
    <li
      className={`flex items-center gap-2 rounded border px-2.5 py-2 transition-colors ${
        active
          ? "border-[#e0a32e]/60 bg-[#e0a32e]/10"
          : "border-white/10 hover:border-white/20"
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 flex-col items-start text-left"
      >
        <span className="truncate text-sm text-[#e7e3d8]">{pkg.title}</span>
        <span className="text-[11px] text-[#9a948a]">
          {pkg.grade} · {pkg.subject}
        </span>
      </button>
      <button
        type="button"
        onClick={onDelete}
        title="패키지 삭제"
        className="rounded p-1 text-[#9a948a] transition-colors hover:text-[#e0796a]"
      >
        <Trash2 size={14} />
      </button>
    </li>
  );
}

function VideosPanel({
  packageId,
  onError,
}: {
  packageId: string;
  onError: (msg: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const { data: videos, isLoading, isError } = useLectureVideos(packageId);

  const [pageUrl, setPageUrl] = useState("");
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState<File | null>(null);
  const [adding, setAdding] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const invalidateVideos = () =>
    queryClient.invalidateQueries({ queryKey: lectureVideosKey(packageId) });

  const handleAdd = async () => {
    if (!pageUrl.trim() || !title.trim()) {
      onError("영상 링크와 제목을 입력하세요.");
      return;
    }
    onError(null);
    setAdding(true);
    try {
      await addLectureVideo(packageId, pageUrl.trim(), title.trim(), subtitle);
      await invalidateVideos();
      setPageUrl("");
      setTitle("");
      setSubtitle(null);
      if (fileRef.current) fileRef.current.value = "";
    } catch (e) {
      onError(`영상 추가 실패: ${(e as Error).message}`);
    } finally {
      setAdding(false);
    }
  };

  const handleReparse = async (videoId: string) => {
    onError(null);
    try {
      await reparseLectureVideo(videoId);
      await invalidateVideos();
    } catch (e) {
      onError(`재파싱 실패: ${(e as Error).message}`);
    }
  };

  const handleDelete = async (videoId: string) => {
    if (!window.confirm("영상을 삭제할까요?")) return;
    onError(null);
    try {
      await deleteLectureVideo(videoId);
      await invalidateVideos();
    } catch (e) {
      onError(`영상 삭제 실패: ${(e as Error).message}`);
    }
  };

  return (
    <Panel title="영상">
      <div className="flex flex-col gap-2 border-b border-white/10 pb-3">
        <input
          className={INPUT}
          placeholder="EBS 영상 페이지 URL"
          value={pageUrl}
          disabled={adding}
          onChange={(e) => setPageUrl(e.target.value)}
        />
        <input
          className={INPUT}
          placeholder="영상 제목"
          value={title}
          disabled={adding}
          onChange={(e) => setTitle(e.target.value)}
        />
        <input
          ref={fileRef}
          type="file"
          accept=".srt,.vtt,.smi"
          disabled={adding}
          onChange={(e) => setSubtitle(e.target.files?.[0] ?? null)}
          className="text-xs text-[#9a948a] file:mr-2 file:rounded file:border-0 file:bg-[#332d23] file:px-2 file:py-1 file:text-xs file:text-[#e7e3d8]"
        />
        <span className="text-[11px] text-[#6f6a62]">
          자막 파일(.srt/.vtt/.smi)은 선택 — 없으면 페이지에서 추출을 시도합니다.
        </span>
        <button
          type="button"
          onClick={handleAdd}
          disabled={adding}
          className="inline-flex items-center justify-center gap-1 rounded bg-[#e0a32e] px-3 py-1.5 text-sm font-medium text-[#1b1813] transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          <Plus size={14} />
          {adding ? "추가 중…" : "영상 추가"}
        </button>
      </div>

      <div className="mt-3">
        {isLoading ? (
          <Loading what="영상 불러오는" />
        ) : isError ? (
          <Failed what="영상을 불러오지" />
        ) : (videos ?? []).length === 0 ? (
          <Empty>등록된 영상이 없습니다.</Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {(videos ?? []).map((v) => (
              <VideoRow
                key={v.id}
                video={v}
                onReparse={() => handleReparse(v.id)}
                onDelete={() => handleDelete(v.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

function VideoRow({
  video,
  onReparse,
  onDelete,
}: {
  video: LectureVideo;
  onReparse: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const {
    data: clips,
    isLoading,
    isError,
  } = useQuery<LectureClipRow[]>({
    queryKey: ["lecture-clips", video.id],
    queryFn: () => listLectureClips(video.id),
    enabled: open,
  });

  return (
    <li className="rounded border border-white/10">
      <div className="flex items-center gap-2 px-2.5 py-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 flex-col items-start text-left"
        >
          <span className="truncate text-sm text-[#e7e3d8]">{video.title}</span>
          <span className="truncate text-[11px] text-[#9a948a]">
            {video.page_url}
          </span>
        </button>
        {statusBadge(video.status)}
        <button
          type="button"
          onClick={onReparse}
          title="재파싱"
          className="rounded p-1 text-[#9a948a] transition-colors hover:text-[#e7e3d8]"
        >
          <RotateCw size={14} />
        </button>
        <button
          type="button"
          onClick={onDelete}
          title="영상 삭제"
          className="rounded p-1 text-[#9a948a] transition-colors hover:text-[#e0796a]"
        >
          <Trash2 size={14} />
        </button>
      </div>

      {video.error && (
        <p className="border-t border-white/5 px-2.5 py-1.5 text-[11px] text-[#e0796a]">
          {video.error}
        </p>
      )}

      {open && (
        <div className="border-t border-white/5 px-2.5 py-2">
          {isLoading ? (
            <Loading what="클립 불러오는" />
          ) : isError ? (
            <Failed what="클립을 불러오지" />
          ) : (clips ?? []).length === 0 ? (
            <Empty>클립이 없습니다.</Empty>
          ) : (
            <ul className="flex flex-col gap-1">
              {(clips ?? []).map((c) => (
                <li
                  key={c.id}
                  className="flex items-center gap-2 text-[12px] text-[#cfc9bd]"
                >
                  <span className="w-8 shrink-0 text-right text-[#6f6a62]">
                    #{c.seq}
                  </span>
                  <span className="w-16 shrink-0 font-mono text-[#9a948a]">
                    {fmtSec(c.start_sec)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{c.title}</span>
                  {statusBadge(c.status)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

/** 초 → m:ss 타임라인 표기. */
function fmtSec(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
