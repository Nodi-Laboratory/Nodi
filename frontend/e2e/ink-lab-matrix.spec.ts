import { expect, test, type Page, type Request } from "@playwright/test";

/**
 * D178 E2E — **실물 경로로 여러 번 시험한다.**
 *
 * `inkScene.fuzz.test.ts`는 기하를 순수 함수로 대량 검증한다. 그런데 실제로
 * 학생이 겪는 것은 그 앞뒤가 다 붙은 길이다: Excalidraw가 포인터를 받아 획을
 * 만들고, 배치 훅이 잰 카드 자리가 들어오고, 화면 좌표가 월드 좌표로 바뀐다.
 * **그 변환 어디서든 어긋나면 순수 함수 검증은 통과한 채로 화면만 틀린다.**
 *
 * 그래서 관리자 실험실을 실제로 그려 가며 시나리오를 줄줄이 태운다. 창구
 * 응답만 가로챈다 — 재는 것은 **무엇을 보냈나**(기하의 답)이지 모델이 뭐라
 * 했나가 아니다. 모델 쪽은 `live_marks`로 따로 잰다.
 *
 * 로컬 스택(docker + 백엔드 8000 + 프론트 3000)과 관리자 계정이 필요하다.
 */
test.describe.configure({ mode: "serial" });
// 실험실 아래쪽의 [읽기] 막대까지 화면에 들어와야 한다 — 기본 720 높이에서는
// 막대가 잘려 클릭이 안 된다(실측).
test.use({ viewport: { width: 1600, height: 1100 } });

const ADMIN_EMAIL = "admin@nodi.local";
const ADMIN_PASSWORD = "nodi1234";

/**
 * 실험실 카드의 **화면 좌표**(스테이지 기준). `initialCamera`가 고정이라
 * 값이 안정적이다 — 흔들리면 아래 `probeCards`가 먼저 깨진다.
 */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(ADMIN_EMAIL);
  await page.locator('input[name="password"]').fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "로그인" }).click();
  await page.waitForURL(/\/(onboarding|home|admin|space)/);
  await page.goto("/admin");
  await page.getByRole("button", { name: "펜 표시" }).click();
  await expect(page.locator('[data-canvas-item="lab-card-1"]')).toBeVisible({
    timeout: 20_000,
  });
  await page.waitForTimeout(900);
}

/** 카드 다섯의 실제 자리를 화면에서 잰다 — 좌표를 손으로 적으면 곧 썩는다. */
async function probeCards(page: Page): Promise<Record<string, Box>> {
  const stage = (await page.getByTestId("ink-lab-stage").boundingBox())!;
  const out: Record<string, Box> = {};
  for (const id of [
    "lab-card-1",
    "lab-card-2",
    "lab-card-3",
    "lab-figure-1",
    "lab-clip-1",
  ]) {
    const el = page.locator(`[data-canvas-item="${id}"]`);
    if (!(await el.count())) continue;
    const b = await el.boundingBox();
    if (!b) continue;
    out[id] = { x: b.x - stage.x, y: b.y - stage.y, w: b.width, h: b.height };
  }
  return out;
}

/** 스테이지 기준 좌표로 획 하나. */
async function draw(page: Page, pts: readonly [number, number][]): Promise<void> {
  const stage = (await page.getByTestId("ink-lab-stage").boundingBox())!;
  await page.mouse.move(stage.x + pts[0][0], stage.y + pts[0][1]);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) {
    await page.mouse.move(stage.x + x, stage.y + y, { steps: 6 });
  }
  await page.mouse.up();
  await page.waitForTimeout(40);
}

/** 한 획 화살표 — 몸통을 긋고 손을 안 뗀 채 촉을 그린다(사람이 그러듯). */
function arrow(
  ax: number, ay: number, bx: number, by: number,
): [number, number][] {
  const d = Math.hypot(bx - ax, by - ay) || 1;
  const ux = (bx - ax) / d;
  const uy = (by - ay) / d;
  const back = Math.min(16, d * 0.2);
  const w = back * 0.55;
  return [
    [ax, ay],
    [bx, by],
    [bx - ux * back - uy * w, by - uy * back + ux * w],
    [bx, by],
    [bx - ux * back + uy * w, by - uy * back - ux * w],
  ];
}

/** 타원 한 바퀴. */
function ring(cx: number, cy: number, rx: number, ry: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= 26; i++) {
    const t = (i / 26) * Math.PI * 2;
    out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
  }
  return out;
}

/** 질문 글씨 흉내 — 짧은 획이 다닥다닥. 이게 표시로 세어지면 안 된다. */
function scribbleText(x: number, y: number, glyphs = 5): [number, number][][] {
  const out: [number, number][][] = [];
  for (let g = 0; g < glyphs; g++) {
    const gx = x + g * 22;
    out.push([[gx, y], [gx + 15, y + 1]]);
    out.push([[gx + 3, y], [gx + 3, y + 17]]);
    out.push([[gx + 12, y + 2], [gx + 12, y + 17]]);
    out.push([[gx, y + 17], [gx + 15, y + 17]]);
  }
  return out;
}

interface Sent {
  cards: Array<{ n: number; title: string; mark: string }>;
  gestures: Array<{ shape: string; points: number[]; encloses: number[]; within: number[] }>;
}

function parse(req: Request): Sent {
  const raw = req.postDataBuffer()!.toString("utf8");
  const grab = (name: string) => {
    const m = raw.match(
      new RegExp(`name="${name}"\\r?\\n\\r?\\n([\\s\\S]*?)\\r?\\n--`),
    );
    return m ? JSON.parse(m[1]) : [];
  };
  return { cards: grab("cards"), gestures: grab("gestures") };
}

/** 카드 아래 변 한가운데 — 화살표가 겨눌 자리. */
function under(b: Box): [number, number] {
  return [b.x + b.w / 2, b.y + b.h + 6];
}

/** 질문 글씨를 쓸 자리 — 카드 줄 아래 빈 곳. */
function ask(b: Record<string, Box>): { x: number; y: number } {
  const rows = Object.values(b);
  const bottom = Math.max(...rows.map((r) => r.y + r.h));
  return { x: b["lab-card-2"].x + 20, y: bottom + 70 };
}

/**
 * 기하가 짚었다고 본 카드들 — **제목으로** 본다.
 *
 * 번호로 재면 안 된다. `[카드 N]`의 N은 **뽑힌 카드 안에서의 순서**라, 멀리
 * 있는 카드가 후보에서 빠지면 같은 카드의 번호가 달라진다(실측: 카드 3만
 * 동그라미 치면 그 카드가 2번이 된다 — 1번 카드가 후보에 안 들었기 때문이다).
 * 그건 정상 동작이고, 시험이 봐야 할 것은 **어느 카드를 짚었나**다.
 */
const POINTING = new Set(["circled", "within", "pointed"]);
function pointed(sent: Sent): string[] {
  return sent.cards.filter((c) => POINTING.has(c.mark)).map((c) => c.title);
}

test("실물 경로에서 시나리오 열둘을 줄줄이 태운다", async ({ page }) => {
  test.setTimeout(240_000);
  await login(page);
  const mid = (b: Box) => [b.x + b.w / 2, b.y + b.h / 2] as const;

  let seen: Request | null = null;
  await page.route("**/ink/interpret", async (route) => {
    seen = route.request();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ text: "이거 설명해줘", marks_note: "", marks_status: "ok" }),
    });
  });

  type Where = Record<string, Box>;

  /**
   * 시나리오는 **좌표를 받아** 획을 만든다.
   *
   * 자리를 미리 굳혀 두면 새로고침 뒤 스테이지가 조금만 달라져도 획이 엉뚱한
   * 데 그려지고, 그러면 알고리즘이 아니라 좌표를 시험하게 된다.
   */
  const cases: Array<{
    name: string;
    build: (b: Where) => [number, number][][];
    want: string[];
  }> = [
    {
      name: "카드 1을 동그라미",
      build: (b) => [ring(...mid(b["lab-card-1"]), b["lab-card-1"].w * 0.55, b["lab-card-1"].h * 0.9)],
      want: ["지질학"],
    },
    {
      name: "카드 2를 동그라미",
      build: (b) => [ring(...mid(b["lab-card-2"]), b["lab-card-2"].w * 0.55, b["lab-card-2"].h * 0.9)],
      want: ["천문학"],
    },
    {
      name: "카드 3을 동그라미",
      build: (b) => [ring(...mid(b["lab-card-3"]), b["lab-card-3"].w * 0.55, b["lab-card-3"].h * 0.9)],
      want: ["생명공학"],
    },
    {
      name: "질문 + 화살표 → 카드 1",
      build: (b) => {
        const q = ask(b);
        return [...scribbleText(q.x, q.y), arrow(q.x + 10, q.y - 12, ...under(b["lab-card-1"]))];
      },
      want: ["지질학"],
    },
    {
      name: "질문 + 화살표 → 카드 3",
      build: (b) => {
        const q = ask(b);
        return [...scribbleText(q.x, q.y), arrow(q.x + 10, q.y - 12, ...under(b["lab-card-3"]))];
      },
      want: ["생명공학"],
    },
    {
      name: "질문 + 화살표 둘 → 카드 2·3 (꼬리 붙임)",
      build: (b) => {
        const q = ask(b);
        return [
          ...scribbleText(q.x, q.y),
          arrow(q.x + 10, q.y - 12, ...under(b["lab-card-2"])),
          arrow(q.x + 14, q.y - 12, ...under(b["lab-card-3"])),
        ];
      },
      want: ["천문학", "생명공학"],
    },
    {
      name: "질문 + 화살표 둘 → 카드 1·3 (꼬리 벌림)",
      build: (b) => {
        const q = ask(b);
        return [
          ...scribbleText(q.x, q.y),
          arrow(q.x - 40, q.y - 12, ...under(b["lab-card-1"])),
          arrow(q.x + 70, q.y - 12, ...under(b["lab-card-3"])),
        ];
      },
      want: ["지질학", "생명공학"],
    },
    {
      name: "카드 2에서 질문으로 그은 화살표",
      build: (b) => {
        const q = ask(b);
        return [
          ...scribbleText(q.x, q.y),
          arrow(...under(b["lab-card-2"]), q.x + 10, q.y - 12),
        ];
      },
      want: ["천문학"],
    },
    {
      name: "카드 3 앞에서 멈춘 화살표",
      build: (b) => {
        const q = ask(b);
        const [tx, ty] = under(b["lab-card-3"]);
        return [
          ...scribbleText(q.x, q.y),
          arrow(
            q.x + 10,
            q.y - 12,
            q.x + 10 + (tx - q.x - 10) * 0.5,
            q.y - 12 + (ty - q.y + 12) * 0.5,
          ),
        ];
      },
      want: ["생명공학"],
    },
    {
      name: "카드 1 본문에 밑줄",
      build: (b) => {
        const one = b["lab-card-1"];
        return [
          [
            [one.x + one.w * 0.12, one.y + one.h * 0.62],
            [one.x + one.w * 0.72, one.y + one.h * 0.62],
          ],
        ];
      },
      want: ["지질학"],
    },
    {
      name: "질문만 쓰고 아무것도 안 가리킴",
      build: (b) => {
        const q = ask(b);
        return scribbleText(q.x, q.y, 7);
      },
      want: [],
    },
    {
      name: "교과서 도판을 동그라미",
      build: (b) => {
        const f = b["lab-figure-1"];
        return f ? [ring(...mid(f), f.w * 0.5, f.h * 0.45)] : [];
      },
      want: ["교과서 도판 — 판 경계에서 일어나는 지각 변동"],
    },
  ];

  const report: string[] = [];
  for (const cs of cases) {
    /**
     * **시나리오마다 화면을 새로 연다.**
     *
     * 획을 지우고 이어 쓰는 길도 있는데, 도구 상태·획 수 신호가 그 사이에
     * 어긋나 다음 획이 통째로 안 잡혔다(실측). 느리더라도 매번 같은 출발점에서
     * 시작하는 편이 **재는 값이 흔들리지 않는다** — 여기서 재려는 것은 실험실의
     * 상태 관리가 아니라 표시 판정이다.
     */
    await page.goto("/admin");
    await page.getByRole("button", { name: "펜 표시" }).click();
    await expect(page.locator('[data-canvas-item="lab-card-1"]')).toBeVisible({
      timeout: 20_000,
    });
    await page.waitForTimeout(800);
    // 좌표를 **매번 다시 잰다** — 새로고침 뒤 스테이지가 같은 자리라는 보장이 없다.
    const at = await probeCards(page);
    const st1 = cs.build(at);

    for (const st of st1) await draw(page, st);
    seen = null;
    const read = page.getByRole("button", { name: "읽기" });
    await expect(read).toBeEnabled({ timeout: 10_000 });
    await read.click();
    await expect.poll(() => seen !== null, { timeout: 25_000 }).toBe(true);

    const sent = parse(seen!);
    const got = pointed(sent);
    const ok =
      got.length === cs.want.length && cs.want.every((n) => got.includes(n));
    report.push(
      `${ok ? "OK  " : "실패"} ${cs.name}\n      정답 [${cs.want}] → [${got}]` +
        `  표시 ${sent.gestures.map((g) => g.shape).join(",") || "없음"}`,
    );
  }

  console.log("\n" + report.join("\n"));
  expect(report.filter((r) => r.startsWith("실패"))).toEqual([]);
});
