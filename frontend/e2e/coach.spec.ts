import { expect, test } from "@playwright/test";
import { loginAndOpenCanvas, openFreshSession } from "./helpers";

/**
 * 질문 방향성 코치 (D194) — 실물 경로.
 *
 * ## 왜 단위 테스트로는 부족한가
 *
 * 발동 규칙(`lib/canvas2/questionCoach.ts`)과 문구(`services/question_coach.py`)는
 * 각자 단위 테스트가 있다. 그런데 이 기능이 학생에게 닿으려면 그 사이에 있는
 * 것들이 다 맞아야 한다 — 부모를 잇는 곳에서 코치가 불리고, 판정 결과가
 * `data.coach`로 저장되고, 말풍선이 그 카드 옆 좌표에 뜨고, ×로 닫힌다.
 * **그 어느 하나가 빠져도 화면은 멀쩡하다**(그냥 아무 말도 안 걸 뿐이다).
 *
 * ## 카드 사슬은 심어서 만든다
 *
 * n+1장을 진짜 턴으로 쌓으면 실행마다 LLM 왕복이 넷이다. 앞의 셋은 **조건**이지
 * 검증 대상이 아니므로 API로 심고, 마지막 한 장만 진짜로 묻는다 — 코치는 그
 * 마지막 카드에서 발동한다.
 */

test("한 방향으로만 물어 온 브랜치에 방향 말풍선이 뜨고, ×로 닫힌다", async ({
  page,
}) => {
  test.setTimeout(180_000); // 진짜 턴 하나가 든다

  page.on("console", (m) => {
    const t = m.text();
    if (t.includes("코치진단")) console.log(t);
  });
  await loginAndOpenCanvas(page);
  await openFreshSession(page);

  const sessionId = await page.locator(".canvas2").getAttribute("data-session");
  expect(sessionId).toBeTruthy();

  // --- 사슬 심기 -------------------------------------------------------------
  // 토큰은 쿠키에 있다(lib/session.ts). 화면과 같은 창구·같은 권한으로 넣는다 —
  // DB에 직접 꽂으면 RLS를 우회해 "테스트만 되는" 상태가 만들어진다.
  const created = await page.evaluate(async (sid) => {
    const token = document.cookie
      .split("; ")
      .find((c) => c.startsWith("nodi_token="))
      ?.slice("nodi_token=".length);
    const chain = [
      ["화강암", "마그마가 지하 깊은 곳에서 천천히 식어 굳은 심성암입니다.", "화강암이 뭐야?"],
      ["화강암의 생성", "지하에서 마그마가 서서히 식으면 큰 결정이 자랍니다.", "화강암은 왜 생겨?"],
      ["결정이 자라는 과정", "천천히 식을수록 결정이 크게 자랍니다.", "결정은 어떤 과정으로 자라?"],
    ];
    const ids: string[] = [];
    let parent: string | null = null;
    for (let i = 0; i < chain.length; i++) {
      const [title, body, asked] = chain[i];
      const res: Response = await fetch(`/api/sessions/${sid}/canvas/items`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${decodeURIComponent(token ?? "")}`,
        },
        body: JSON.stringify({
          items: [
            {
              kind: "concept",
              source: "ai",
              parent_item_id: parent,
              title,
              body,
              tag: "지구과학",
              seq: i,
              data: { askedQuestion: asked },
            },
          ],
        }),
      });
      if (!res.ok) throw new Error(`심기 실패 ${res.status}`);
      const rows: { id: string }[] = await res.json();
      parent = rows[0].id;
      ids.push(rows[0].id);
    }
    return ids;
  }, sessionId);
  expect(created).toHaveLength(3);

  // 심은 것을 화면이 읽게 다시 연다(수화는 세션당 한 번이다 — D147).
  await page.reload();
  await expect(page.getByLabel("질문 입력")).toBeEnabled({ timeout: 30_000 });
  await expect(page.locator("[data-canvas-item]")).toHaveCount(3, {
    timeout: 30_000,
  });

  // --- 마지막 카드에 이어 묻는다 ---------------------------------------------
  // 초점을 사슬 끝에 둬야 새 카드가 그 밑에 붙는다(D151).
  await page.locator(`[data-canvas-item="${created[2]}"]`).click();
  await page.getByLabel("질문 입력").fill("결정 크기가 왜 그렇게 달라져?");
  await page.getByLabel("질문 입력").press("Enter");

  // 카드 넷 = 사슬 깊이 4 = n+1(기본 n=3). 여기서 코치가 발동한다.
  await expect(page.locator("[data-canvas-item]")).toHaveCount(4, {
    timeout: 120_000,
  });

  const bubble = page.locator("[data-coach-bubble]");
  await expect(bubble).toBeVisible({ timeout: 60_000 });

  /**
   * **베껴 쓸 질문을 주면 안 된다**(사용자 지시 2026-08-06).
   *
   * 물음표 자체를 금지하면 틀린다 — 말풍선의 마지막 줄이 "어떨까요?"다.
   * 막아야 하는 것은 **학생이 그대로 입력창에 옮길 수 있는 질문**이고, 그런
   * 문장에는 의문사가 들어간다. 방향 낱말만 대는 문구에는 안 들어간다.
   */
  const text = (await bubble.innerText()).trim();
  expect(text).not.toMatch(/무엇|어떻게|왜 /);
  expect(text).toContain("질문의 방향성을");

  // --- 닫으면 사라진다 -------------------------------------------------------
  // 권유 기능이지 강요 기능이 아니다.
  await bubble.getByRole("button", { name: "질문 방향 안내 닫기" }).click();
  await expect(bubble).toBeHidden();
});
