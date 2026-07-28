"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, FileText, Image as ImageIcon, Search } from "lucide-react";
import { getAdminDocument, getAdminDocuments } from "@/lib/api";
import type {
  AdminDocument,
  AdminDocumentDetail,
  AdminDocumentsResponse,
} from "@/lib/types";
import {
  Badge,
  Code,
  Empty,
  Failed,
  Loading,
  Panel,
  Stat,
  bytes,
  n,
  statusTone,
  when,
} from "./ui";

const LIMIT = 25;
const CHUNK_PAGE = 50;

/**
 * 문서 탭 (D113) — "이 문서가 어떻게 올라갔는가".
 *
 * 답은 결국 **청크 경계**다. 어디서 끊겼는지를 눈으로 봐야 청크 크기·겹침 값을
 * 고칠 수 있다. 그래서 목록은 인제스트 상태를, 상세는 청크 원문을 그대로 보여
 * 준다.
 *
 * files.chunk_total(워커 진행률)과 실제 청크 행 수를 **둘 다** 보여 준다. 어긋난
 * 파일은 인제스트가 중간에 끊긴 파일이고, 하나만 보면 그 사실이 숨는다.
 */
export function DocumentsTab() {
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery<AdminDocumentsResponse>({
    queryKey: ["admin", "documents", kind, status, query, offset],
    queryFn: () =>
      getAdminDocuments({
        kind: kind || null,
        status: status || null,
        search: query || null,
        limit: LIMIT,
        offset,
      }),
  });

  if (openId) {
    return <DocumentDetail fileId={openId} onBack={() => setOpenId(null)} />;
  }

  const rows = data?.documents ?? [];
  const reset = () => setOffset(0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-[#e7e3d8]">문서 인제스트</h2>
        {data && <Badge tone="gold">{n(data.total)}개</Badge>}

        <select
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            reset();
          }}
          className="rounded border border-white/15 bg-[#1b1813] px-2 py-1 text-sm text-[#e7e3d8]"
        >
          <option value="">전체 종류</option>
          <option value="class_material">수업 자료</option>
          <option value="textbook">교과서</option>
          <option value="user_upload">학생 업로드</option>
        </select>

        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            reset();
          }}
          className="rounded border border-white/15 bg-[#1b1813] px-2 py-1 text-sm text-[#e7e3d8]"
        >
          <option value="">전체 상태</option>
          {["uploaded", "splitting", "embedding", "indexed", "partial", "failed"].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(search.trim());
            reset();
          }}
        >
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="파일명·업로더 검색"
            className="w-48 rounded border border-white/15 bg-[#1b1813] px-2 py-1 text-sm text-[#e7e3d8] placeholder:text-[#6f6a62]"
          />
          <button
            type="submit"
            className="flex items-center gap-1 rounded border border-white/15 px-2 py-1 text-sm text-[#cfc9bd] hover:text-[#e7e3d8]"
          >
            <Search size={13} />
            찾기
          </button>
        </form>
      </div>

      {isLoading ? (
        <Loading />
      ) : isError ? (
        <Failed />
      ) : rows.length === 0 ? (
        <Empty>조건에 맞는 문서가 없습니다.</Empty>
      ) : (
        <div className="flex flex-col gap-1.5">
          {rows.map((d) => (
            <DocRow key={d.file_id} doc={d} onOpen={() => setOpenId(d.file_id)} />
          ))}
        </div>
      )}

      <div className="flex items-center justify-between pt-1">
        <button
          type="button"
          onClick={() => setOffset((o) => Math.max(0, o - LIMIT))}
          disabled={offset === 0}
          className="rounded border border-white/15 px-3 py-1 text-sm text-[#e7e3d8] disabled:opacity-40"
        >
          이전
        </button>
        <span className="text-xs text-[#9a948a]">
          {rows.length === 0 ? 0 : offset + 1}–{offset + rows.length} / {n(data?.total ?? 0)}
        </span>
        <button
          type="button"
          onClick={() => setOffset((o) => o + LIMIT)}
          disabled={offset + rows.length >= (data?.total ?? 0)}
          className="rounded border border-white/15 px-3 py-1 text-sm text-[#e7e3d8] disabled:opacity-40"
        >
          다음
        </button>
      </div>
    </div>
  );
}

const KIND_LABEL: Record<string, string> = {
  class_material: "수업 자료",
  textbook: "교과서",
  user_upload: "학생 업로드",
};

function DocRow({ doc, onOpen }: { doc: AdminDocument; onOpen: () => void }) {
  // 워커 진행률과 실제 행 수가 어긋나면 인제스트가 중간에 끊긴 것이다.
  const mismatch = doc.chunk_total !== doc.chunks_rows;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-[#25211a] px-3 py-2 text-left transition-colors hover:border-white/25"
    >
      <FileText size={14} className="shrink-0 text-[#e0a32e]" />
      <span className="min-w-0 flex-1 truncate text-sm text-[#e7e3d8]">
        {doc.name || "(이름 없음)"}
      </span>
      <Badge>{KIND_LABEL[doc.kind] ?? doc.kind}</Badge>
      <Badge tone={statusTone(doc.status)}>{doc.status}</Badge>
      <span className="shrink-0 text-xs text-[#9a948a]">
        {doc.space_kind === "class" ? doc.class_name || "학급" : "개인"}
      </span>
      <Badge tone={doc.chunks_embedded === doc.chunks_rows && doc.chunks_rows > 0 ? "ok" : "warn"}>
        청크 {n(doc.chunks_embedded)}/{n(doc.chunks_rows)}
      </Badge>
      {mismatch && (
        <Badge tone="warn" title={`워커 진행률 ${doc.chunk_total} vs 실제 행 ${doc.chunks_rows}`}>
          진행률 불일치
        </Badge>
      )}
      {doc.figures_total > 0 && (
        <Badge tone="info">
          <ImageIcon size={10} />
          도판 {n(doc.figures_ok)}/{n(doc.figures_total)}
        </Badge>
      )}
      <span className="shrink-0 text-xs text-[#9a948a]">{bytes(doc.size_bytes)}</span>
      <span className="shrink-0 text-xs text-[#9a948a]">{when(doc.created_at)}</span>
    </button>
  );
}

function DocumentDetail({ fileId, onBack }: { fileId: string; onBack: () => void }) {
  const [chunkOffset, setChunkOffset] = useState(0);
  const { data, isLoading, isError } = useQuery<AdminDocumentDetail>({
    queryKey: ["admin", "document", fileId, chunkOffset],
    queryFn: () => getAdminDocument(fileId, chunkOffset),
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 rounded border border-white/15 px-2 py-1 text-sm text-[#cfc9bd] hover:text-[#e7e3d8]"
        >
          <ArrowLeft size={14} />
          목록
        </button>
        <h2 className="text-sm font-semibold text-[#e7e3d8]">
          {data?.file.name || "문서"}
        </h2>
        {data && <Badge tone={statusTone(data.file.status)}>{data.file.status}</Badge>}
        {data?.owner && <Badge tone="info">{data.owner.email}</Badge>}
      </div>

      {isLoading ? (
        <Loading />
      ) : isError || !data ? (
        <Failed />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
            <Stat label="크기" value={bytes(data.file.size_bytes)} sub={data.file.mime ?? ""} />
            <Stat
              label="청크(워커 진행률)"
              value={`${n(data.file.chunk_done)}/${n(data.file.chunk_total)}`}
            />
            <Stat label="실제 청크 행" value={n(data.chunks.length + chunkOffset)} sub="이 페이지까지" />
            <Stat label="올린 시각" value={when(data.file.created_at)} />
          </div>

          {data.file.error && (
            <Panel title="인제스트 오류">
              <Code max="max-h-32">{String(data.file.error)}</Code>
            </Panel>
          )}

          <Panel title={`인제스트 잡 (${data.jobs.length})`}>
            {data.jobs.length === 0 ? (
              <Empty>이 파일에 대한 잡 기록이 없습니다.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-[11px]">
                  <thead>
                    <tr className="text-[#9a948a]">
                      <th className="py-1 pr-3 font-medium">종류</th>
                      <th className="py-1 pr-3 font-medium">상태</th>
                      <th className="py-1 pr-3 font-medium">진행</th>
                      <th className="py-1 pr-3 font-medium">시도</th>
                      <th className="py-1 pr-3 font-medium">범위</th>
                      <th className="py-1 font-medium">갱신</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.jobs.map((j) => (
                      <tr key={j.id}>
                        <td className="py-1 pr-3 text-[#cfc9bd]">{j.kind}</td>
                        <td className="py-1 pr-3">
                          <Badge tone={statusTone(j.status)}>{j.status}</Badge>
                        </td>
                        <td className="py-1 pr-3 text-[#9a948a]">{j.progress}</td>
                        <td className="py-1 pr-3 text-[#9a948a]">{j.attempts}</td>
                        <td className="py-1 pr-3 font-mono text-[10px] text-[#9a948a]">
                          {j.batch_range ? JSON.stringify(j.batch_range) : "—"}
                        </td>
                        <td className="py-1 text-[#9a948a]">{when(j.updated_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel
            title={`청크 (RAG 검색 단위) — ${chunkOffset + 1}번째부터`}
            right={
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => setChunkOffset((o) => Math.max(0, o - CHUNK_PAGE))}
                  disabled={chunkOffset === 0}
                  className="rounded border border-white/15 px-2 py-0.5 text-[11px] text-[#cfc9bd] disabled:opacity-40"
                >
                  이전
                </button>
                <button
                  type="button"
                  onClick={() => setChunkOffset((o) => o + CHUNK_PAGE)}
                  disabled={data.chunks.length < CHUNK_PAGE}
                  className="rounded border border-white/15 px-2 py-0.5 text-[11px] text-[#cfc9bd] disabled:opacity-40"
                >
                  다음
                </button>
              </div>
            }
          >
            {data.chunks.length === 0 ? (
              <Empty>청크가 없습니다 — 아직 분할되지 않았거나 인제스트가 실패했습니다.</Empty>
            ) : (
              <div className="flex flex-col gap-2">
                {data.chunks.map((c) => (
                  <div key={c.id} className="rounded border border-white/10 bg-[#221e17]">
                    <div className="flex items-center gap-2 border-b border-white/10 px-2.5 py-1">
                      <Badge tone="gold">#{c.seq}</Badge>
                      <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                      <span className="ml-auto text-[10px] text-[#9a948a]">
                        {n(c.chunk_text.length)}자
                      </span>
                    </div>
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words px-2.5 py-2 font-mono text-[11px] leading-relaxed text-[#cfc9bd]">
                      {c.chunk_text}
                    </pre>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          {data.figures.length > 0 && (
            <Panel title={`교과서 도판 (${data.figures.length})`}>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-[11px]">
                  <thead>
                    <tr className="text-[#9a948a]">
                      <th className="py-1 pr-3 font-medium">#</th>
                      <th className="py-1 pr-3 font-medium">페이지</th>
                      <th className="py-1 pr-3 font-medium">상태</th>
                      <th className="py-1 font-medium">캡션</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.figures.map((f) => (
                      <tr key={f.id} className="align-top">
                        <td className="py-1 pr-3 text-[#9a948a]">{f.seq}</td>
                        <td className="py-1 pr-3 text-[#9a948a]">{f.page ?? "—"}</td>
                        <td className="py-1 pr-3">
                          <Badge tone={statusTone(f.status)}>{f.status}</Badge>
                        </td>
                        <td className="py-1 text-[#cfc9bd]">{f.caption || "(캡션 없음)"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
