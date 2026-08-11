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

/**
 * 시안 색 (디자이너 이미지 2026-08-11).
 *
 * ⚠️ 앱 토큰(`--accent-deep` 등)을 그대로 쓰면 **버튼이 진초록에 흰 글자**가
 * 된다. 시안의 버튼은 **밝은 라임에 어두운 글자**이고, 이 화면은 처음 만나는
 * 인상을 정하는 자리라 시안을 따른다. 대비는 확인했다 —
 * #2A2A1E on #C6DC50 은 8.6:1로 본문 기준(4.5)을 넉넉히 넘는다.
 */
const 색 = {
  /** 채운 면 — 버튼·현재 단계 동그라미·활성 점 */
  라임: "#C6DC50",
  /** 라임 위에 얹는 글자 */
  라임글자: "#2A2A1E",
  /** 입력칸 테두리 — 라임보다 옅다 */
  테두리: "#D8E983",
  /** 안 지난 단계의 선·동그라미 테두리·꺼진 점 */
  회색: "#E3E3DE",
  /** 말풍선 바탕 */
  말풍선: "#EEF4DC",
  /** 안 지난 단계의 글자 */
  흐린글자: "#9A9A90",
} as const;

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
  initial,
  onAdvance,
  onDone,
  busy = false,
}: {
  /**
   * 이미 저장돼 있던 답. **마운트 때 한 번만** 읽는다 — 그 뒤로는 이 화면이
   * 답의 주인이라, 늦게 도착한 서버 값이 학생이 방금 친 글자를 덮으면 안 된다.
   */
  initial: SurveyAnswers;
  /**
   * 한 단계를 넘겼다. 호출부가 **그때그때 저장**해서, 새로고침하거나 도중에
   * 나갔다 와도 적은 것이 남게 한다(실측 2026-08-11: 안 하면 1단계부터 다시).
   */
  onAdvance: (answers: SurveyAnswers) => void;
  /** 마지막 단계에서 눌렀다. 저장·다음 화면은 호출부의 일이다. */
  onDone: (answers: SurveyAnswers) => void;
  busy?: boolean;
}) {
  const [answers, setAnswers] = useState<SurveyAnswers>(initial);
  /**
   * 이미 적어 둔 답이 있으면 **처음 빈 칸**에서 시작한다. 다 적고 돌아온
   * 사람에게 1단계부터 다시 묻는 것은 한 일을 안 한 것으로 치는 셈이다.
   */
  const [at, setAt] = useState(() => {
    const i = STEPS.findIndex((s) => !initial[s.field]);
    return i < 0 ? STEPS.length - 1 : i;
  });
  const step = STEPS[at];
  const last = at === STEPS.length - 1;
  const value = answers[step.field];

  const 다음 = () => {
    if (last) onDone(answers);
    else {
      onAdvance(answers);
      setAt((i) => i + 1);
    }
  };

  const 적기 = (v: string) => setAnswers((cur) => ({ ...cur, [step.field]: v }));

  return (
    <div className="flex w-full max-w-[600px] flex-col items-center gap-12">
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
                  style={{ background: i <= at ? 색.라임 : 색.회색 }}
                />
                <span
                  aria-current={i === at ? "step" : undefined}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold transition-colors"
                  style={
                    done
                      ? { background: 색.라임, color: "#FFFFFF" }
                      : {
                          background: "#FFFFFF",
                          color: 색.흐린글자,
                          boxShadow: `inset 0 0 0 1.5px ${색.회색}`,
                        }
                  }
                >
                  {i + 1}
                </span>
                <span
                  className={`h-[2px] flex-1 ${i === STEPS.length - 1 ? "opacity-0" : ""}`}
                  style={{ background: i < at ? 색.라임 : 색.회색 }}
                />
              </div>
              <span
                className="mt-2 text-[13px]"
                style={{ color: i === at ? "#A6C22B" : 색.흐린글자 }}
              >
                {s.label}
              </span>
            </li>
          );
        })}
      </ol>

      {/* ── 애벌레와 말풍선 ──────────────────────────────────────────── */}
      <div className="flex items-center gap-4">
        {/**
         * 디자이너가 준 캐릭터 그림 그대로다 (2026-08-11).
         *
         * 흰 배경은 **바깥에서 물을 채워** 지웠다 — 색만 보고 흰 픽셀을
         * 지우면 눈알과 안경 알이 뚫린다(둘 다 흰색이다). 검은 테로 막혀
         * 바깥과 안 이어지는 흰 영역은 그대로 남는다.
         *
         * 원본 147×139을 그대로 두 배 해상도로 쓴다(`width`의 두 배가 원본).
         */}
        {/* eslint-disable-next-line @next/next/no-img-element -- public의 정적 PNG라 next/image가 줄 이득이 없다 */}
        <img
          src="/onboarding/nodi-caterpillar.png"
          alt=""
          aria-hidden
          width={124}
          height={117}
          className="shrink-0 select-none"
          draggable={false}
        />
        <div
          className="relative rounded-2xl px-6 py-4 text-[17px] leading-relaxed"
          style={{ background: 색.말풍선, color: "#2A2A1E" }}
        >
          {/* 말풍선 꼬리. 배경과 같은 색의 네모를 돌려 끼운다 — 삼각형
              path보다 모서리 반경과 어울린다. */}
          <span
            aria-hidden
            className="absolute left-[-6px] top-1/2 h-3.5 w-3.5 -translate-y-1/2 rotate-45 rounded-[3px]"
            style={{ background: 색.말풍선 }}
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
                      ? { background: 색.라임, color: 색.라임글자 }
                      : {
                          background: "#FFFFFF",
                          color: "#2A2A1E",
                          boxShadow: `inset 0 0 0 1.5px ${색.테두리}`,
                        }
                  }
                >
                  {c}
                </button>
              );
            })}
          </div>
        ) : (
          <label
            className="flex items-center gap-3 rounded-xl px-6 py-5"
            style={{ background: "#FFFFFF", boxShadow: `inset 0 0 0 1.5px ${색.테두리}` }}
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
            <span className="text-[14px] tabular-nums" style={{ color: 색.흐린글자 }}>
              {value.length} / {step.maxLength}
            </span>
          </label>
        )}

        <button
          type="button"
          onClick={다음}
          disabled={busy}
          data-survey-next
          className="flex items-center justify-center gap-3 rounded-xl py-5 text-[18px] font-bold transition-opacity disabled:opacity-50"
          style={{ background: 색.라임, color: 색.라임글자 }}
        >
          {last ? "시작하기" : "다음"}
          <ArrowRight size={18} />
        </button>

        {/**
         * **건너뛸 수 있다는 것을 보여 준다.** 안 적어도 [다음]이 눌리지만,
         * 그 사실을 화면이 말하지 않으면 학생은 뭔가 적어야 하는 줄 안다.
         */}
        {!value && (
          <p className="text-center text-[13px]" style={{ color: 색.흐린글자 }}>
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
            style={{ background: i === at ? 색.라임 : 색.회색 }}
          />
        ))}
      </div>
    </div>
  );
}
