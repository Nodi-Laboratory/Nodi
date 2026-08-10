# 02 · 프런트엔드

## 무엇을 쓰나

| 이름 | 버전 | 하는 일 |
| --- | --- | --- |
| Next.js | 16.2.9 (App Router · Turbopack) | 라우팅 · `/api` 프록시 · SSR |
| React | 19.2.4 | — |
| TypeScript | 5.x | `strict` |
| Tailwind CSS | 4.x (`@theme inline`) | 토큰 기반 스타일 |
| @excalidraw/excalidraw | 0.18.1 | 캔버스 뷰포트 · 그리기 |
| @tanstack/react-query | 5.x | 서버 데이터 · 캐시 |
| zustand | 5.x | 작업공간 상태(활성 세션 등) |
| d3 | 7.x | 개념 지도 힘 배치 |
| katex | 0.16.x | 수식 (⚠️ `trust: false` 유지) |
| react-markdown | 10.x | 카드 본문 |
| lucide-react | 1.x | 아이콘 |
| Vitest | 4.x | 단위 테스트(순수 함수) |
| Playwright | 1.62.x | e2e |

## 폴더

```
src/
  app/                  라우트 (App Router)
    (auth)/             로그인 · 가입
    (app)/              학생 셸 — home · space/[id] · sessions
    (admin)/admin/      운영 콘솔 (탭 15개)
    teacher/            교사 콘솔
  components/
    canvas2/            캔버스 v2 — 무대 · 아이템 · 도구 레일 · 지도
    home/               개념 지도
    help/ settings/     팝업(페이지 아님)
    spaces/ workspace/  세션 고르기 · 지난 대화 서랍
    admin/ teacher/     콘솔 화면
    ui/                 Dialog 등 공용
  lib/
    api/                창구 호출 — snake_case 경계를 여기서만 넘는다
    canvas2/            **순수 함수** — 배치 · 연결선 · 표시 해석 · 카메라
    ui/                 토큰 · 파스텔 · 모달 레이어
  store/                zustand
```

**규칙 하나**: 기하·판정은 `lib/canvas2/`의 순수 함수에 둔다. 컴포넌트에 섞으면
눈으로만 확인하게 되고, 이런 결함은 화면이 멀쩡해 보여서 안 잡힌다.

## 캔버스가 도는 방식

뷰포트는 **Excalidraw가 소유한다**(D120). 우리는 DOM 오버레이를 얹는다:

```
screen = (world + scroll) * zoom
```

- 오버레이 컨테이너는 `pointer-events:none`, 아이템만 `auto`.
- 그리기 도구일 때는 아이템도 놓아 준다 — 글 위에도 선을 그을 수 있어야 한다.
- 오버레이 `z-index:3`이 **반드시** 필요하다. Excalidraw 캔버스가 2라서, 없으면
  글이 보이는데 눌리지 않는다.

⚠️ **팬 중에는 React를 돌리지 않는다**(D124). 카메라 rAF 폴링이 매 프레임
setState하면 지도·연결선·아이템이 통째로 다시 돈다. 오버레이 변환과 격자는
`bridge.subscribeFrame`으로 DOM을 직접 고치고, React state는 멈춘 뒤 한 번만
올린다.

### 배치

태그마다 열 하나, 열 안에서는 seq 순(D123). **무겹침이 알고리즘의 성질이지
수렴의 결과가 아니다** — d3-force로는 보장이 안 돼서 버렸다. 무작위 200케이스
테스트가 이 불변식을 지킨다.

### 손글씨

폰트는 KCC 한빛체, **캔버스 위의 글에만** 쓴다. 자체 호스팅이라 쪼개는 것이
우리 일이다 — `scripts/build-hand-font.py`가 woff2 세 조각(라틴 27KB · KS X 1001
한글 497KB · 나머지 2.3MB)을 만든다. 교실 한국어는 KS 안에서 끝나 보통 524KB만
받는다(단일 파일은 2.9MB).

⚠️ 그 CSS는 **CanvasStage가 임포트한다.** `globals.css`에 넣으면 unicode-range
목록이 로그인·홈·관리자 화면까지 따라간다.

## 성능에서 배운 것

홈 개념 지도(개념 1,200개)를 **66.6ms → 16.7ms**(15fps → 60fps)로 줄인 과정이
이 코드베이스의 성능 교과서다:

| 무엇이 | 왜 비쌌나 | 어떻게 |
| --- | --- | --- |
| `shadowBlur` | 캔버스 그림자는 **도형마다** 블러 패스가 돈다 | 색×반지름별 스프라이트를 미리 굽고 `drawImage`로 복사 |
| 간선 stroke | 간선마다 `strokeStyle` 문자열 생성 + 개별 `stroke()` | 농도 5단으로 묶어 단마다 한 번 |
| 매 프레임 해시 | 태그→색, 연결수→반지름을 1,200번씩 다시 계산 | 노드에 붙여 둔다(안 변하는 값) |
| 다 끝난 배치 | `forceManyBody`가 매 틱 사분트리를 새로 쌓아 프레임의 30% | 예열 뒤 자리를 **못 박고**(`ax`/`ay`) 전하력·링크를 내려놓는다 |

⚠️ 그 과정에서 한 번 틀렸다: 전하력만 싸게 바꿨더니 무리가 30초에 430 → 312로
**조용히 오그라들었다.** 힘의 균형으로 자리를 되찾으려 하면 반드시 흘러간다 —
균형이 아니라 **기억**이어야 한다.

## 지켜야 할 것

- **eslint에 React Compiler 규칙이 켜져 있다.** 렌더 중 ref 쓰기와 이펙트 내
  동기 setState가 **에러**다. 억제하지 말고 구조로 푼다.
- **dev 서버를 띄운 채 `npm run build`를 돌리지 않는다** — `.next`를 덮어써
  dev가 옛 CSS를 내보낸다.
- **`globals.css`를 고쳤으면 `rm -rf .next` 후 dev 재시작.** 이 파일만 유독
  다시 컴파일되지 않는다(Next 16.2.9 + Turbopack 실측). 화면에는 "안 고쳐진
  것"으로 보여서 코드를 의심하며 시간을 버리게 된다.
- **`--c-*` 토큰은 `.canvas2` 안에서만 산다.** 밖에서 쓰면 색이 조용히 안 잡히는데
  테두리는 `currentColor`로 떨어져 **그럴싸하게 보인다**.

## 검사

```bash
npx tsc --noEmit          # 타입
npx eslint src e2e        # 린트 (경고 0 기준)
npm test -- --run         # 단위 525
npx playwright test       # e2e (dev 서버가 떠 있어야 한다)
```
