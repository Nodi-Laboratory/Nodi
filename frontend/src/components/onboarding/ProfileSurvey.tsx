"use client";

/**
 * 온보딩 설문 — 이름 · 학년 · 학습 단계 · 목표 (D222, 사용자 지시 2026-08-11).
 *
 * **형식상 받아 두는 값이다.** 지금 이 답을 읽는 기능은 하나도 없다(사용자
 * 확인). 그래서 두 가지를 일부러 그렇게 뒀다:
 *
 *   · **아무것도 안 적어도 넘어갈 수 있다.** 쓰지도 않을 값 때문에 학생이
 *     제품에 못 들어가는 것은 값이 안 맞는다.
 *   · **저장 실패도 막지 않는다.** 창구가 죽어도 온보딩은 계속된다 —
 *     "RAG는 채팅을 절대 막지 않는다"와 같은 성질이다.
 *
 * 화면은 디자이너 시안을 따랐다: 위에 4단계 진행 막대, 가운데 애벌레와
 * 말풍선, 아래에 답 칸과 [다음]. 마지막 단계에서만 글자가 [시작하기]로 바뀐다.
 */

import { useState } from "react";
import { ArrowRight } from "lucide-react";

export interface SurveyAnswers {
  display_name: string;
  grade: string;
  stage: string;
  goal: string;
}

/** 빈 답. 호출부가 초기값으로 쓴다. */
export const EMPTY_ANSWERS: SurveyAnswers = {
  display_name: "",
  grade: "",
  stage: "",
  goal: "",
};

type Field = keyof SurveyAnswers;

interface Step {
  /** 진행 막대에 적히는 이름. */
  label: string;
  /** 애벌레가 하는 말. 줄바꿈은 배열로 — `\n`은 말풍선에서 안 먹는다. */
  lines: readonly string[];
  field: Field;
  /** 자유 입력이면 `placeholder`, 고르는 것이면 `choices`. */
  placeholder?: string;
  choices?: readonly string[];
  maxLength: number;
}

/**
 * 네 단계.
 *
 * 1번만 자유 입력이고 나머지는 **고르는 것**이다 — 학년·단계·목표를 자유
 * 서술로 받으면 같은 뜻이 열 가지 표기로 들어와 나중에 쓸 수가 없다(지금은
 * 안 쓰지만, 쓰게 되는 날 되돌릴 방법이 없다).
 */
export const STEPS: readonly Step[] = [
  {
    label: "이름 입력",
    lines: ["안녕! 만나서 반가워!", "먼저, 네 이름을 알려줄래?"],
    field: "display_name",
    placeholder: "이름을 입력해주세요",
    maxLength: 10,
  },
  {
    label: "학년 선택",
    lines: ["반가워!", "지금 몇 학년이야?"],
    field: "grade",
    choices: [
      "중학교 1학년",
      "중학교 2학년",
      "중학교 3학년",
      "고등학교 1학년",
      "고등학교 2학년",
      "고등학교 3학년",
    ],
    maxLength: 40,
  },
  {
    label: "학습 단계",
    lines: ["공부는 어디쯤 왔어?", "편한 걸로 골라 줘."],
    field: "stage",
    choices: ["처음 배우는 중", "복습하는 중", "시험 준비 중", "더 깊게 파는 중"],
    maxLength: 40,
  },
  {
    label: "목표 설정",
    lines: ["마지막이야!", "무엇을 이루고 싶어?"],
    field: "goal",
    choices: [
      "기초를 탄탄히",
      "시험 점수 올리기",
      "궁금한 걸 바로 풀기",
      "스스로 공부하는 습관",
    ],
    maxLength: 200,
  },
];

export function ProfileSurvey({
  answers,
  onChange,
  onDone,
  busy = false,
}: {
  answers: SurveyAnswers;
  onChange: (next: SurveyAnswers) => void;
  /** 마지막 단계에서 눌렀다. 저장·다음 화면은 호출부의 일이다. */
  onDone: () => void;
  busy?: boolean;
}) {
  const [at, setAt] = useState(0);
  const step = STEPS[at];
  const last = at === STEPS.length - 1;
  const value = answers[step.field];

  const 다음 = () => {
    if (last) onDone();
    else setAt((i) => i + 1);
  };

  const 적기 = (v: string) => onChange({ ...answers, [step.field]: v });

  return (
    <div className="flex w-full max-w-2xl flex-col items-center gap-10">
      {/* ── 진행 막대 ────────────────────────────────────────────────── */}
      <ol className="flex w-full items-start justify-center" data-survey-steps>
        {STEPS.map((s, i) => {
          const done = i <= at;
          return (
            <li key={s.label} className="flex flex-1 flex-col items-center">
              <div className="flex w-full items-center">
                {/* 줄은 동그라미 **사이**에만 있어야 한다 — 양 끝에도 그리면
                    막대가 화면 밖으로 흘러나간 것처럼 보인다. */}
                <span
                  className={`h-[2px] flex-1 ${i === 0 ? "opacity-0" : ""}`}
                  style={{ background: i <= at ? "var(--accent-deep)" : "var(--accent-border)" }}
                />
                <span
                  aria-current={i === at ? "step" : undefined}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold transition-colors"
                  style={
                    done
                      ? { background: "var(--accent-deep)", color: "var(--accent-fg)" }
                      : {
                          background: "var(--bg-elevated)",
                          color: "var(--fg-muted)",
                          boxShadow: "inset 0 0 0 1.5px var(--accent-border)",
                        }
                  }
                >
                  {i + 1}
                </span>
                <span
                  className={`h-[2px] flex-1 ${i === STEPS.length - 1 ? "opacity-0" : ""}`}
                  style={{ background: i < at ? "var(--accent-deep)" : "var(--accent-border)" }}
                />
              </div>
              <span
                className="mt-2 text-[13px]"
                style={{ color: i === at ? "var(--accent-deep)" : "var(--fg-muted)" }}
              >
                {s.label}
              </span>
            </li>
          );
        })}
      </ol>

      {/* ── 애벌레와 말풍선 ──────────────────────────────────────────── */}
      <div className="flex items-center gap-4">
        {/* eslint-disable-next-line @next/next/no-img-element -- public의 정적 SVG라 next/image가 줄 이득이 없다 */}
        <img
          src="/onboarding/nodi-caterpillar.svg"
          alt=""
          aria-hidden
          width={132}
          height={102}
          className="shrink-0 select-none"
          draggable={false}
        />
        <div
          className="relative rounded-2xl px-6 py-4 text-[17px] leading-relaxed"
          style={{ background: "var(--accent-wash, #f2f8dd)", color: "var(--fg)" }}
        >
          {/* 말풍선 꼬리. 배경과 같은 색의 네모를 돌려 끼운다 — 삼각형
              path보다 모서리 반경과 어울린다. */}
          <span
            aria-hidden
            className="absolute left-[-6px] top-1/2 h-3.5 w-3.5 -translate-y-1/2 rotate-45 rounded-[3px]"
            style={{ background: "var(--accent-wash, #f2f8dd)" }}
          />
          {step.lines.map((ln) => (
            <p key={ln}>{ln}</p>
          ))}
        </div>
      </div>

      {/* ── 답 ───────────────────────────────────────────────────────── */}
      <div className="flex w-full flex-col gap-4">
        {step.choices ? (
          <div className="grid grid-cols-2 gap-3" data-survey-choices>
            {step.choices.map((c) => {
              const on = value === c;
              return (
                <button
                  key={c}
                  type="button"
                  aria-pressed={on}
                  onClick={() => 적기(on ? "" : c)}
                  className="rounded-2xl px-5 py-4 text-[15px] font-medium transition-colors"
                  style={
                    on
                      ? { background: "var(--accent-deep)", color: "var(--accent-fg)" }
                      : {
                          background: "var(--bg-elevated)",
                          color: "var(--fg)",
                          boxShadow: "inset 0 0 0 1.5px var(--accent-border)",
                        }
                  }
                >
                  {c}
                </button>
              );
            })}
          </div>
        ) : (
          <label className="flex items-center gap-3 rounded-2xl px-6 py-4"
            style={{ background: "var(--bg-elevated)", boxShadow: "inset 0 0 0 1.5px var(--accent-border)" }}
          >
            <span className="sr-only">{step.label}</span>
            <input
              autoFocus
              value={value}
              maxLength={step.maxLength}
              placeholder={step.placeholder}
              onChange={(e) => 적기(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") 다음();
              }}
              className="flex-1 bg-transparent text-[16px] outline-none"
            />
            {/* 몇 자까지 쓸 수 있는지 — 시안에 있는 그 표시다. */}
            <span className="text-[13px] tabular-nums" style={{ color: "var(--fg-muted)" }}>
              {value.length} / {step.maxLength}
            </span>
          </label>
        )}

        <button
          type="button"
          onClick={다음}
          disabled={busy}
          data-survey-next
          className="flex items-center justify-center gap-2 rounded-2xl py-4 text-[17px] font-semibold transition-opacity disabled:opacity-50"
          style={{ background: "var(--accent-deep)", color: "var(--accent-fg)" }}
        >
          {last ? "시작하기" : "다음"}
          <ArrowRight size={18} />
        </button>

        {/**
         * **건너뛸 수 있다는 것을 보여 준다.** 안 적어도 [다음]이 눌리지만,
         * 그 사실을 화면이 말하지 않으면 학생은 뭔가 적어야 하는 줄 안다.
         */}
        {!value && (
          <p className="text-center text-[13px]" style={{ color: "var(--fg-muted)" }}>
            나중에 정해도 괜찮아요 — 그냥 넘어가도 돼요.
          </p>
        )}
      </div>

      {/* ── 아래 점 ──────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2" aria-hidden>
        {STEPS.map((s, i) => (
          <span
            key={s.label}
            className="h-2 w-2 rounded-full transition-colors"
            style={{ background: i === at ? "var(--accent-deep)" : "var(--accent-border)" }}
          />
        ))}
      </div>
    </div>
  );
}
