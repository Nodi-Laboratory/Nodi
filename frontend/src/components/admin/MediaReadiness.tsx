"use client";

/**
 * **그림·영상이 왜 안 뜨나** (사용자 질문 2026-08-12).
 *
 * 거리 게이트를 0.8까지 열어도 안 뜬다는 보고가 있었다. 그럴 수 있다 —
 * 게이트는 **찾은 것을 거르는 자리**이고, 그 앞에 "찾을 것이 있나"라는 하드
 * 전제가 둘 있다. 전제가 안 갖춰지면 게이트를 0.9로 열어도 0건이다.
 *
 * 그 전제를 숫자로 보여 준다 — 슬라이더를 옮기기 전에 볼 자리다.
 */

import { useQuery } from "@tanstack/react-query";
import { getMediaReadiness, type MediaReadiness as Data } from "@/lib/api/admin";

const 칸 = "px-3 py-2 text-left align-top";

export function MediaReadiness() {
  const { data, isLoading, isError } = useQuery<Data>({
    queryKey: ["admin", "media-readiness"],
    queryFn: getMediaReadiness,
  });

  if (isLoading) return <p className="text-sm text-[#9a948a]">세는 중…</p>;
  if (isError || !data)
    return <p className="text-sm text-[#e0a32e]">상태를 읽지 못했습니다.</p>;

  return (
    <section className="rounded-lg border border-white/10 bg-white/[0.02] p-4">
      <h3 className="text-sm font-semibold text-[#e7e3d8]">
        그림·영상이 뜰 수 있는 상태인가
      </h3>
      <p className="mt-1 text-[12px] leading-relaxed text-[#9a948a]">
        거리 게이트는 <b>찾은 것을 거르는</b> 자리다. 아래 수가 0이면 게이트를
        아무리 열어도 0건이다 — 먼저 이쪽을 채워야 한다.
      </p>

      {!data.vision_configured && (
        <p className="mt-2 rounded border border-[#e0a32e]/40 bg-[#e0a32e]/10 px-3 py-2 text-[12px] text-[#e0a32e]">
          ⚠️ 비전 모델(<code>judge_*</code>)이 설정되지 않았다. 교과서를 올려도{" "}
          <b>도판 캡션 생성이 전부 실패</b>해서 검색에 뜨지 않는다(폴백 없음).
          텍스트 RAG는 정상이다.
        </p>
      )}

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[560px] text-[12px]">
          <thead className="text-[#9a948a]">
            <tr className="border-b border-white/10">
              <th className={칸}>학급</th>
              <th className={칸}>교과서</th>
              <th className={칸}>도판(검색 가능 / 전체)</th>
              <th className={칸}>켜 둔 강의 패키지</th>
              <th className={칸}>클립(검색 가능)</th>
            </tr>
          </thead>
          <tbody className="text-[#e7e3d8]">
            {data.classes.map((c) => {
              const 전체 = Object.values(c.figures).reduce((a, b) => a + b, 0);
              const 실패 = 전체 - c.figures_ready;
              return (
                <tr key={c.class_id} className="border-b border-white/5">
                  <td className={칸}>{c.name || c.class_id.slice(0, 8)}</td>
                  <td className={칸} style={{ color: c.textbooks ? undefined : "#e0a32e" }}>
                    {c.textbooks}
                  </td>
                  <td className={칸} style={{ color: c.figures_ready ? undefined : "#e0a32e" }}>
                    {c.figures_ready} / {전체}
                    {실패 > 0 && (
                      <span className="ml-1 text-[#9a948a]">
                        (
                        {Object.entries(c.figures)
                          .filter(([k]) => k !== "embedded")
                          .map(([k, v]) => `${k} ${v}`)
                          .join(" · ")}
                        )
                      </span>
                    )}
                  </td>
                  <td className={칸} style={{ color: c.packages ? undefined : "#e0a32e" }}>
                    {c.packages}
                  </td>
                  <td className={칸} style={{ color: c.clips_ready ? undefined : "#e0a32e" }}>
                    {c.clips_ready}
                  </td>
                </tr>
              );
            })}
            {data.classes.length === 0 && (
              <tr>
                <td className={칸} colSpan={5}>
                  학급이 없습니다.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-[12px] leading-relaxed text-[#9a948a]">
        · <b>교과서 0</b> → 선생님이 그 학급에 교과서(PDF)를 올려야 도판이 생긴다.
        <br />· <b>도판 0 / n</b> → 인제스트가 실패했다. 비전 설정을 확인하고 재시도한다.
        <br />· <b>패키지 0</b> → 관리자가 넣은 강의를 <b>학급에 켜야</b> 클립이 뜬다.
        <br />· 개인 대화방에는 둘 다 없다 — 학급 대화방에서 확인할 것.
      </p>
    </section>
  );
}
