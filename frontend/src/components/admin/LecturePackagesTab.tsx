"use client";

import { useState, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw, Trash2, UploadCloud } from "lucide-react";
import {
  createLecturePackage,
  deleteLecturePackage,
  deleteLectureVideo,
  reembedLectureVideo,
  uploadLectureDocs,
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

  const [adding, setAdding] = useState(false);
  /** 끌어온 것이 이 영역 위에 있나 — 놓을 자리를 눈으로 알려 준다. */
  const [over, setOver] = useState(false);
  /** 읽지 못한 파일과 그 사유. 조용히 삼키면 관리자가 빈 패키지를 켠다. */
  const [skipped, setSkipped] = useState<{ file: string; reason: string }[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const invalidateVideos = () =>
    queryClient.invalidateQueries({ queryKey: lectureVideosKey(packageId) });

  /**
   * 파싱 파일을 올린다 (2026-08-10).
   *
   * 예전에는 url·제목을 쳐 넣으면 서버가 EBS를 긁고 Whisper로 전사했다.
   * 대회 규정상 제품 안에서 해외 모델을 못 써서 그 경로를 걷어냈다 — 파싱은
   * 저장소 밖 오프라인 스크립트가 끝내고 여기서는 결과 파일만 받는다.
   */
  const upload = async (list: FileList | File[]) => {
    // `.json`만 걸러 낸다. 폴더째 끌어다 놓으면 잡다한 파일이 섞여 온다.
    const files = Array.from(list).filter((f) => f.name.toLowerCase().endsWith(".json"));
    if (!files.length) {
      onError("파싱 파일(.json)을 끌어다 놓으세요.");
      return;
    }
    onError(null);
    setSkipped([]);
    setAdding(true);
    try {
      const r = await uploadLectureDocs(packageId, files);
      await invalidateVideos();
      // 건너뛴 것은 **화면에 남긴다** — 폴더째 올리는 흐름이라 어느 파일이
      // 왜 빠졌는지 말해 주지 않으면 처음부터 다시 하게 된다.
      setSkipped(r.skipped);
      if (fileRef.current) fileRef.current.value = "";
    } catch (e) {
      onError(`업로드 실패: ${(e as Error).message}`);
    } finally {
      setAdding(false);
      setOver(false);
    }
  };

  /**
   * 다시 임베딩 (2026-08-12).
   *
   * 행은 있는데 Qdrant에 벡터가 없으면 검색이 **오류 없이 0건**이라 화면에는
   * "추천이 안 뜬다"로만 보인다. 진단 표("그림·영상이 뜰 수 있는 상태인가")의
   * **행 / 벡터**가 어긋났을 때 누르는 자리다.
   */
  const handleReembed = async (videoId: string) => {
    onError(null);
    try {
      const r = await reembedLectureVideo(videoId);
      onError(`클립 ${r.clips}개를 다시 임베딩합니다 — 잠시 뒤 새로고침하세요.`);
      await invalidateVideos();
    } catch (e) {
      onError(`재임베딩 실패: ${(e as Error).message}`);
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
      {/**
        * **끌어다 놓는 자리** (사용자 지시 2026-08-10).
        *
        * 스크립트가 만든 폴더를 통째로 끌어 오는 것을 전제한다 — 영상 하나씩
        * url을 붙여 넣던 자리를 대신한다.
        */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!adding) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          if (!adding) void upload(e.dataTransfer.files);
        }}
        className={`flex flex-col items-center gap-1 rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors ${
          over ? "border-[#e0a32e] bg-[#e0a32e]/10" : "border-white/15 bg-white/[0.02]"
        } ${adding ? "opacity-60" : ""}`}
      >
        <UploadCloud size={22} className="text-[#9a948a]" />
        <span className="text-sm text-[#e7e3d8]">
          {adding ? "올리는 중…" : "파싱 파일(.json)을 여기에 끌어다 놓으세요"}
        </span>
        {/* 만드는 스크립트 경로는 안 적는다(사용자 지시 2026-08-11). 저장소
            밖 오프라인 도구라(D221) 이 화면을 보는 사람에게는 없는 파일이고,
            내부 경로가 콘솔에 그대로 드러날 이유도 없다. */}
        <span className="text-[11px] leading-relaxed text-[#6f6a62]">
          여러 개를 한 번에 놓을 수 있습니다.
        </span>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={adding}
          className="mt-1 inline-flex items-center gap-1 rounded bg-[#332d23] px-2.5 py-1 text-xs text-[#e7e3d8] transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          <Plus size={13} />
          파일 고르기
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          multiple
          hidden
          disabled={adding}
          onChange={(e) => {
            if (e.target.files?.length) void upload(e.target.files);
          }}
        />
      </div>

      {skipped.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1 rounded border border-[#a8452e]/40 bg-[#a8452e]/10 px-3 py-2">
          {skipped.map((s2) => (
            <li key={s2.file} className="text-[11px] leading-relaxed text-[#e0b0a4]">
              {/* 사유에 이미 파일 이름이 들어 있다 — 두 번 쓰지 않는다. */}
              <span className="font-medium">{s2.file}</span> —{" "}
              {s2.reason.startsWith(`${s2.file}: `)
                ? s2.reason.slice(s2.file.length + 2)
                : s2.reason}
            </li>
          ))}
        </ul>
      )}

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
                onReembed={() => handleReembed(v.id)}
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
  onReembed,
  onDelete,
}: {
  video: LectureVideo;
  onReembed: () => void;
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
          onClick={onReembed}
          title="다시 임베딩 — 행은 있는데 검색에 안 뜰 때"
          className="rounded p-1 text-[#9a948a] transition-colors hover:text-[#e7e3d8]"
        >
          <RefreshCw size={14} />
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
