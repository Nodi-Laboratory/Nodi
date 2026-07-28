"use client";

import { useQuery } from "@tanstack/react-query";
import { Wrench } from "lucide-react";
import { getAdminSkills } from "@/lib/api";
import type { AdminSkill, AdminSkillsResponse } from "@/lib/types";
import { Badge, Code, Collapse, Empty, Failed, Loading, Panel, ms, n, when } from "./ui";

/**
 * 스킬 탭 (D113) — 등록된 스킬 · 노출 조건 · 실제 사용량.
 *
 * 목록은 **레지스트리에서** 온다. 스킬을 추가·삭제하면 이 화면이 저절로 맞는다.
 * `exposed_in`도 서버가 `catalog.skills_for`를 실제로 호출해 계산한 것이라,
 * "이 스킬은 어디서 보이나"라는 설명이 코드와 갈라지지 않는다.
 */
export function SkillsTab() {
  const { data, isLoading, isError } = useQuery<AdminSkillsResponse>({
    queryKey: ["admin", "skills"],
    queryFn: () => getAdminSkills(30),
  });

  if (isLoading) return <Loading />;
  if (isError || !data) return <Failed />;
  if (data.skills.length === 0) return <Empty>등록된 스킬이 없습니다.</Empty>;

  const used = data.skills.filter((s) => (s.usage?.calls ?? 0) > 0).length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-[#e7e3d8]">스킬 카탈로그</h2>
        <Badge tone="gold">{data.skills.length}종 등록</Badge>
        <Badge tone={used > 0 ? "ok" : "warn"}>
          최근 {data.days}일 사용 {used}종
        </Badge>
      </div>
      <p className="text-[11px] leading-relaxed text-[#9a948a]">
        모델에게는 <b className="text-[#cfc9bd]">좁혀진 목록만</b> 보인다. 개인
        세션에 학급 도구를 노출하면 모델이 그걸 부르고 빈 결과를 받아 엉뚱한 답을
        하기 때문이다. 아래 &quot;노출 조합&quot;은 서버가 실제 카탈로그 함수를 호출해
        계산한 결과다.
      </p>

      <div className="flex flex-col gap-2">
        {data.skills.map((s) => (
          <SkillRow key={s.name} skill={s} />
        ))}
      </div>
    </div>
  );
}

function SkillRow({ skill }: { skill: AdminSkill }) {
  const u = skill.usage;
  const failing = (u?.failures ?? 0) > 0;
  return (
    <Panel
      title={
        <span className="flex items-center gap-1.5 normal-case tracking-normal">
          <Wrench size={13} className="text-[#9bbf6a]" />
          <code className="text-[12px] font-semibold text-[#fcf58b]">{skill.name}</code>
        </span>
      }
      right={
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {u ? (
            <>
              <Badge tone="info">{n(u.calls)}회 호출</Badge>
              <Badge>{n(u.turns)}턴</Badge>
              <Badge tone={(u.avg_ms ?? 0) > 1500 ? "warn" : "default"}>
                평균 {ms(u.avg_ms)}
              </Badge>
              {failing && <Badge tone="bad">실패 {n(u.failures)}</Badge>}
              {(u.skipped ?? 0) > 0 && <Badge tone="warn">중복생략 {n(u.skipped)}</Badge>}
            </>
          ) : (
            <Badge tone="warn">사용 기록 없음</Badge>
          )}
        </div>
      }
    >
      <p className="text-xs leading-relaxed text-[#cfc9bd]">{skill.description}</p>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-wide text-[#9a948a]">노출 조합</span>
        {skill.exposed_in.length === 0 ? (
          <Badge tone="bad">어디에도 노출되지 않음</Badge>
        ) : (
          skill.exposed_in.map((e) => (
            <Badge key={e} tone="default">
              {e}
            </Badge>
          ))
        )}
      </div>

      {u?.last_used && (
        <p className="mt-1.5 text-[10px] text-[#9a948a]">
          마지막 사용 {when(u.last_used)} · 최장 {ms(u.max_ms)}
        </p>
      )}

      <div className="mt-2">
        <Collapse label="모델에게 보내는 인자 스키마">
          <Code max="max-h-56">{JSON.stringify(skill.parameters, null, 2)}</Code>
        </Collapse>
      </div>
    </Panel>
  );
}
