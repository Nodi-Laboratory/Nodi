"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { FlaskConical, Play } from "lucide-react";
import { listAdminClasses, listAdminSettings, runRagTest } from "@/lib/api";
import type { AdminClass, AdminSettingsView, RagTestResult } from "@/lib/types";
import { Badge, Code, Empty, Failed, Panel, Stat, ms, n } from "./ui";
import { MediaReadiness } from "./MediaReadiness";

/**
 * RAG 테스트 탭 (D113).
 *
 * 채팅과 **같은 검색 함수**를 태운다 — 테스트 전용 사본을 만들면 사본만 맞고
 * 실제 경로는 다른 상황이 된다. 다른 점은 하나: 게이트를 필터가 아니라 표시로
 * 쓴다. 잘린 청크를 거리와 함께 봐야 게이트 값을 어디로 옮길지 판단할 수 있다.
 */
export function RagLabTab() {
  const [query, setQuery] = useState("");
  const [classId, setClassId] = useState("");
  const [topK, setTopK] = useState<number | "">("");
  const [gate, setGate] = useState<number | "">("");
  const [figures, setFigures] = useState(true);

  const { data: classes } = useQuery<AdminClass[]>({
    queryKey: ["admin", "classes"],
    queryFn: listAdminClasses,
  });
  const { data: settings } = useQuery<AdminSettingsView>({
    queryKey: ["admin", "settings"],
    queryFn: listAdminSettings,
  });

  const liveGate = settings?.items.find(
    (i) => i.key === "class_material_rag_max_distance",
  )?.value;
  const liveTopK = settings?.items.find((i) => i.key === "rag_top_k")?.value;

  const run = useMutation<RagTestResult, Error>({
    mutationFn: () =>
      runRagTest({
        query: query.trim(),
        class_id: classId || null,
        top_k: topK === "" ? null : Number(topK),
        max_distance: gate === "" ? null : Number(gate),
        include_figures: figures,
      }),
  });

  const result = run.data;

  return (
    <div className="flex flex-col gap-4">
      <MediaReadiness />
      <div className="flex items-center gap-2">
        <FlaskConical size={16} className="text-[#e0a32e]" />
        <h2 className="text-sm font-semibold text-[#e7e3d8]">RAG 테스트</h2>
      </div>

      <Panel title="질의">
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (query.trim()) run.mutate();
          }}
        >
          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            rows={2}
            placeholder="학생이 물어볼 법한 문장을 그대로 넣어 보세요 — 키워드 나열보다 자연스러운 질문이 거리가 가깝게 나옵니다."
            className="w-full resize-y rounded border border-white/15 bg-[#1b1813] px-2.5 py-2 text-sm text-[#e7e3d8] placeholder:text-[#6f6a62]"
          />

          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-[11px] text-[#9a948a]">
              검색 범위(학급)
              <select
                value={classId}
                onChange={(e) => setClassId(e.target.value)}
                className="rounded border border-white/15 bg-[#1b1813] px-2 py-1 text-sm text-[#e7e3d8]"
              >
                <option value="">학급 선택…</option>
                {(classes ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name || c.id}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-[11px] text-[#9a948a]">
              top-k {liveTopK != null && `(현재 ${String(liveTopK)})`}
              <input
                type="number"
                min={1}
                max={50}
                value={topK}
                onChange={(e) => setTopK(e.target.value === "" ? "" : Number(e.target.value))}
                placeholder="기본값"
                className="w-24 rounded border border-white/15 bg-[#1b1813] px-2 py-1 text-sm text-[#e7e3d8]"
              />
            </label>

            <label className="flex flex-col gap-1 text-[11px] text-[#9a948a]">
              거리 게이트 {liveGate != null && `(현재 ${String(liveGate)})`}
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={gate}
                onChange={(e) => setGate(e.target.value === "" ? "" : Number(e.target.value))}
                placeholder="기본값"
                className="w-24 rounded border border-white/15 bg-[#1b1813] px-2 py-1 text-sm text-[#e7e3d8]"
              />
            </label>

            <label className="flex items-center gap-1.5 text-[11px] text-[#9a948a]">
              <input
                type="checkbox"
                checked={figures}
                onChange={(e) => setFigures(e.target.checked)}
                className="accent-[#e0a32e]"
              />
              교과서 도판도 검색
            </label>

            <button
              type="submit"
              disabled={!query.trim() || run.isPending}
              className="ml-auto flex items-center gap-1.5 rounded bg-[#e0a32e] px-3 py-1.5 text-sm font-medium text-[#2a2a24] hover:brightness-110 disabled:opacity-50"
            >
              <Play size={14} />
              {run.isPending ? "검색 중…" : "검색"}
            </button>
          </div>

          <p className="text-[11px] leading-relaxed text-[#9a948a]">
            여기서 쓰는 값은 <b className="text-[#cfc9bd]">저장되지 않습니다</b> — 이
            질의에만 적용되는 임시 덮어쓰기입니다. 실제 서비스에 반영하려면 설정
            탭에서 같은 값을 저장하세요.
          </p>
        </form>
      </Panel>

      {run.isError && <Failed what="검색하지" />}

      {result && (
        <>
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-5">
            <Stat
              label="통과"
              value={n(result.passed)}
              tone={result.passed > 0 ? "ok" : "warn"}
              sub={`게이트 ${result.max_distance}`}
            />
            <Stat
              label="차단"
              value={n(result.blocked)}
              tone={result.blocked > 0 ? "warn" : "default"}
              sub="게이트에 걸림"
            />
            <Stat label="검색 범위" value={`${n(result.scope.file_count)}개 파일`} sub={`top-k ${result.top_k}`} />
            <Stat label="질의 임베딩" value={ms(result.embedding.ms)} sub={result.embedding.model} />
            <Stat label="벡터 검색" value={ms(result.search_ms)} sub={result.embedding.collection} />
          </div>

          {result.notes.length > 0 && (
            <div className="rounded border border-[#e0a86a]/40 bg-[#e0a86a]/10 px-3 py-2 text-[11px] text-[#e0c08e]">
              {result.notes.map((note, i) => (
                <div key={i}>{note}</div>
              ))}
            </div>
          )}

          <Panel title={`검색 결과 (${result.hits.length})`}>
            {result.hits.length === 0 ? (
              <Empty>히트가 없습니다. 검색 범위에 인덱싱된 문서가 있는지 확인하세요.</Empty>
            ) : (
              <div className="flex flex-col gap-2">
                {result.hits.map((h, i) => (
                  <div
                    key={`${h.chunk_id}-${i}`}
                    className="overflow-hidden rounded border"
                    style={{
                      borderColor: h.passed
                        ? "rgba(155,191,106,0.45)"
                        : "rgba(255,255,255,0.10)",
                      opacity: h.passed ? 1 : 0.65,
                    }}
                  >
                    <div className="flex flex-wrap items-center gap-2 bg-[#221e17] px-2.5 py-1.5">
                      <Badge tone={h.passed ? "ok" : "warn"}>
                        {h.passed ? "주입됨" : "게이트에서 차단"}
                      </Badge>
                      <span className="text-xs text-[#cfc9bd]">{h.name || "자료"}</span>
                      {h.seq != null && <span className="text-[11px] text-[#9a948a]">#{h.seq}</span>}
                      <span className="ml-auto font-mono text-[11px] text-[#9a948a]">
                        거리 {h.distance?.toFixed(3) ?? "—"} · 유사도 {h.score?.toFixed(3) ?? "—"}
                      </span>
                    </div>
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words bg-[#25211a] px-2.5 py-2 font-mono text-[11px] leading-relaxed text-[#cfc9bd]">
                      {h.text}
                    </pre>
                  </div>
                ))}
              </div>
            )}
            <p className="mt-2 text-[11px] leading-relaxed text-[#9a948a]">
              차단된 청크도 <b className="text-[#cfc9bd]">지우지 않고 보여 줍니다</b> —
              거리 분포를 봐야 게이트를 어디로 옮길지 판단할 수 있습니다. 실측상
              온토픽 질의는 0.48~0.56, 무관한 질의는 0.85 부근입니다.
            </p>
          </Panel>

          {result.block && (
            <Panel title="실제로 프롬프트에 들어갈 블록">
              <Code max="max-h-64">{result.block}</Code>
            </Panel>
          )}

          {result.figures.length > 0 && (
            <Panel title={`교과서 도판 (${result.figures.length})`}>
              <div className="flex flex-col gap-1.5">
                {result.figures.map((f) => (
                  <div key={f.figure_id} className="flex items-center gap-2 text-xs">
                    <Badge tone="info">{f.score?.toFixed(3)}</Badge>
                    <span className="text-[#cfc9bd]">{f.caption || "(캡션 없음)"}</span>
                  </div>
                ))}
              </div>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
