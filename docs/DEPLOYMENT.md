# 배포 문서 — 현재 클라우드 VM 구성 (2026-07-19 기준)

이 문서는 `README.md`의 "로컬 실행"(Docker Compose 기반)과 다르다. 이 VM(TTA GPU
렌탈 클라우드)은 **샌드박스 컨테이너라 Docker-in-Docker가 근본적으로 불가능**하다
(`CAP_NET_ADMIN`·`CAP_SYS_ADMIN`이 bounding set에서 빠져 있음 — `sudo`로도 못 올림,
`docker run`이 브리지 네트워크 생성·오버레이 마운트 단계에서 `operation not
permitted`로 실패). 그래서 Qdrant·backend·frontend를 **컨테이너 없이 프로세스로
직접 실행**한다.

---

## 아키텍처 / 포트 매핑

```
외부 인터넷
   │  https:// 시도(브라우저 HSTS) → SSL 에러 (아래 "외부 접속" 참고)
   │  http://proxy.tta-gpu.gov-nhncloud.com:30099  또는  http://114.110.181.24:30099
   ▼
[클라우드 게이트웨이 114.110.181.24] ── 고정 포트포워딩 30099 → 이 VM의 8080
   │
   ▼
이 VM (내부 전용, 외부에서 8080 외에는 직접 도달 불가)
   ├─ 8080  Next.js (frontend, production `next start`)  ← 유일한 외부 진입점
   │          └─ /api/*  rewrite(next.config.ts) → 내부 8000으로 서버사이드 프록시
   ├─ 8000  FastAPI (backend, uvicorn --reload)           ← 외부 미노출, 127.0.0.1만
   ├─ 8081  llama.cpp EXAONE-4.5-33B (비전 judge, D93)    ← 내부 전용, 0.0.0.0 바인딩이지만
   │                                                          게이트웨이가 8081을 안 열어줌
   ├─ 6333  Qdrant REST + 대시보드
   └─ 6334  Qdrant gRPC
```

- **채팅 생성(EXAONE)**: 여전히 원격 Friendli 서버리스(`K-EXAONE-236B-A23B`)를 쓴다. 이 VM의
  llama.cpp는 별개로, **교과서 figure 캡션 판정(vision judge, D88/D93)** 전용이다.
- 8080은 원래 llama.cpp가 쓰던 자리였다(judge_base_url 기본값이 이 게이트웨이:30099를
  가리키고 있었음). 프론트엔드 외부 노출을 위해 llama.cpp를 8081로 옮기고 8080을
  비웠다 — 아래 "구성 변경 이력" 참고.

---

## 1. Qdrant (바이너리 직접 실행)

Docker 불가로 `docker compose up -d qdrant` 대신 **musl 정적 바이너리**를 직접 띄운다
(이 Ubuntu 22.04의 glibc 2.35가 공식 gnu 빌드가 요구하는 2.38보다 낮아 gnu 빌드는
`GLIBC_2.38 not found`로 실행 불가 — 반드시 musl 빌드 사용).

```bash
# 최초 1회: 바이너리 받기 (이미 받아져 있으면 생략)
mkdir -p /home/ubuntu/Nodi/.qdrant-bin && cd /home/ubuntu/Nodi/.qdrant-bin
curl -sL -o qdrant.tar.gz \
  https://github.com/qdrant/qdrant/releases/download/v1.18.3/qdrant-x86_64-unknown-linux-musl.tar.gz
tar xzf qdrant.tar.gz && rm qdrant.tar.gz

# 실행 (스토리지는 docker-compose.yml과 동일 경로 재사용)
mkdir -p /home/ubuntu/Nodi/qdrant_storage
cd /home/ubuntu/Nodi/.qdrant-bin
QDRANT__STORAGE__STORAGE_PATH=/home/ubuntu/Nodi/qdrant_storage \
QDRANT__SERVICE__HTTP_PORT=6333 \
QDRANT__SERVICE__GRPC_PORT=6334 \
nohup ./qdrant > qdrant.log 2>&1 &
disown
```

확인: `curl http://localhost:6333/collections`

`.qdrant-bin/`은 `.gitignore` 처리됨 — 커밋 대상 아님.

---

## 2. Backend (FastAPI / uvicorn)

로컬 실행(README)과 동일하되, `backend/.env`에 EXAONE judge 관련 오버라이드가 추가돼 있다.

```bash
cd /home/ubuntu/Nodi/backend
# venv 없이 시스템 uvicorn 사용 중(이 VM 한정) — venv가 있으면 source .venv/bin/activate 먼저
nohup uvicorn app.main:app --reload --port 8000 > backend.log 2>&1 &
disown
```

확인: `curl http://localhost:8000/health`

`backend/.env` 추가 키(judge 전용, D88/D93):

```
JUDGE_BASE_URL=http://localhost:8081/v1   # 로컬 llama.cpp — 8080은 프론트엔드가 씀
JUDGE_MODEL=EXAONE-4.5-33B
JUDGE_API_KEY=<llama-server --api-key와 동일한 값>
```

> **D97 — 이제 세 값 모두 필수다.** `judge_base_url`의 config 기본값이 제거됐고
> (과거 기본값은 게이트웨이 30099를 가리켰는데 그 포트는 프론트엔드로 넘어갔다),
> 셋 중 하나라도 비면 교과서 업로드가 503으로 거부된다. 설정 상태는
> `curl http://localhost:8000/health/config` 의 `judge` 블록으로 확인한다.

> ⚠️ **키를 이 문서에 적지 말 것.** 실제 값은 VM의 `backend/.env`와
> `/home/ubuntu/exaone4.5/run_server.sh`에만 둔다. (과거 이 문서에 평문으로
> 적혀 있었고 git 히스토리에 남아 있다 — 협업자를 늘리기 전에 회전 권장.)

> `.env` 수정은 `uvicorn --reload`의 파일 감시 대상이 아닐 수 있다(기본은 `.py` 위주).
> 값이 실제로 반영됐는지 불확실하면 프로세스를 재기동해서 확실히 한다.

---

## 3. EXAONE 비전 judge (llama.cpp, figure 캡션 판정 전용)

`/home/ubuntu/exaone4.5/run_server.sh`로 기동. **채팅 생성이 아니라 교과서 figure
캡션 판정(D88/D93)에만 쓰인다** — 헷갈리지 말 것.

```bash
cd /home/ubuntu/exaone4.5
nohup ./run_server.sh > server.log 2>&1 &
disown
```

`run_server.sh` 핵심 플래그: `--host 0.0.0.0 --port 8081 -a EXAONE-4.5-33B --api-key
rkd0520 --mmproj models/mmproj-EXAONE-4.5-33B-BF16.gguf`(멀티모달 vision).

33B 모델 로딩에 GPU 기준 약 5~10초 소요. 확인:
`curl http://localhost:8081/v1/models -H "Authorization: Bearer $JUDGE_API_KEY"`

> **포트는 반드시 8081.** 8080은 프론트엔드 몫이다. 원래 기본은 8080이었고
> `judge_base_url` config 기본값(`http://proxy.tta-gpu.gov-nhncloud.com:30099/v1`)도
> 8080 기준이었는데, 프론트를 8080에 앉히면서 8081로 옮기고 `JUDGE_BASE_URL`을
> 로컬 직결(`http://localhost:8081/v1`)로 오버라이드했다(원격 프록시 왕복 대신
> 로컬 직결이라 지연시간도 더 좋아짐).
>
> **D97에서 그 config 기본값 자체를 제거했다** — 기본값이 프론트엔드로 용도가
> 바뀐 포트를 계속 가리키고 있어서, `JUDGE_API_KEY`만 채운 신규 환경이 비전
> 요청을 엉뚱한 서비스로 보내는 사고가 가능했다. 이제 `JUDGE_BASE_URL`을
> 명시하지 않으면 교과서 업로드가 아예 거부된다(조용히 실패하지 않는다).

---

## 4. Frontend (Next.js, 프로덕션 빌드)

**dev 모드가 아니라 프로덕션 빌드로 띄운다** — 외부 프록시가 WebSocket Upgrade를
통과시키지 못해 HMR(`/_next/webpack-hmr`)이 항상 실패하고 콘솔에 에러가 쌓이기
때문(사용자 결정: dev 유지보다 프로덕션 전환 선택). 프로덕션은 HMR 자체가 없어
이 문제가 사라진다.

이 VM의 시스템 Node(v18.20.4)는 Next.js 16 요구사항(`>=20.9.0`)에 못 미친다 —
`nvm`으로 v22.23.1 사용.

```bash
source /usr/local/nvm/nvm.sh && nvm use v22.23.1
cd /home/ubuntu/Nodi/frontend

npm install         # @tailwindcss/oxide-linux-x64-gnu 네이티브 바이너리 포함 확인
                     # (npm optional-deps 버그로 누락되면 next dev/build가 500/빌드실패남 —
                     #  node_modules/@tailwindcss/oxide-linux-x64-gnu/*.node 존재 여부로 확인)
npm run build

setsid nohup npx next start -p 8080 -H 0.0.0.0 > frontend.log 2>&1 < /dev/null &
disown -a
```

> `next dev`/`next start`를 백그라운드 job으로 띄우고 바로 `sleep && ps/tail`을
> 이어붙이면 셸 job-control 메시지 때문에 tool 호출이 이상한 exit code를 내며
> 로그가 꼬여 보일 수 있었다(`setsid` + 별도 호출로 분리해서 해결). 재기동할 땐
> 실행과 상태확인을 **별도 명령으로 분리**할 것.

코드를 고치면 자동 반영되지 않는다 — 재배포 시:
```bash
pkill -f "next start"
cd /home/ubuntu/Nodi/frontend && npm run build
setsid nohup npx next start -p 8080 -H 0.0.0.0 > frontend.log 2>&1 < /dev/null &
disown -a
```

### `frontend/.env.local` (신규 생성, gitignore 대상)

```
NEXT_PUBLIC_SUPABASE_URL=https://yqxoxszshrtljcgspidr.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
NEXT_PUBLIC_API_BASE_URL=/api
```

`NEXT_PUBLIC_API_BASE_URL`이 절대 URL(`http://localhost:8000`)이 아니라 **상대 경로
`/api`**인 이유: 외부에서 브라우저가 직접 붙는 origin은 오직 8080(→30099) 하나뿐이라,
브라우저 fetch가 같은 origin의 `/api/...`로 나가야 `next.config.ts`의 rewrite가
받아서 내부 8000으로 넘겨줄 수 있다. 클라이언트 코드에 `localhost:8000`을 박아두면
외부 접속자의 브라우저는 자기 자신의 localhost를 찌르게 되어 무조건 실패한다.

### `next.config.ts` — `/api/*` 프록시 rewrite

```ts
async rewrites() {
  return [{ source: "/api/:path*", destination: "http://localhost:8000/:path*" }];
}
```

백엔드 라우터 prefix(`/home`, `/admin`, `/teacher`)가 프론트 페이지 경로와 그대로
겹치기 때문에, 공통 접두사 없이 직접 리라이트할 수 없다 — `/api` 네임스페이스로
분리해서 충돌을 피했다.

---

## 5. 외부 접속

### 정상 경로가 막히는 이유와 우회

`http://proxy.tta-gpu.gov-nhncloud.com:30099`로 접속하면:

1. Chromium/Arc가 **HSTS preload**로 인해 `http://`를 무시하고 자동으로
   `https://...:30099`를 시도한다 — 상위 도메인(`nhncloud.com` 계열)이 preload
   목록에 `includeSubDomains`로 올라가 있는 것으로 추정(`chrome://net-internals/#hsts`
   조회 결과 `static_sts_domain`으로 확인됨. 브라우저 UI로 삭제 불가능한 종류).
2. 이 서버는 8080에 순수 HTTP만 서빙하므로 TLS 핸드셰이크가 실패 → SSL 인증서 오류.
3. 우리가 소유하지 않은 도메인이라 정식 인증서 발급(Let's Encrypt HTTP-01/DNS-01
   모두 도메인 제어권 필요)도 불가능.

**우회**: 게이트웨이 **IP를 직접** 사용한다. HSTS는 호스트네임 기준이라 IP 접속엔
적용되지 않는다.

```
http://114.110.181.24:30099/
```

Host 헤더 유무와 무관하게 동일하게 라우팅됨을 확인함(순수 포트포워딩, 가상호스팅
아님). 이 IP가 게이트웨이 쪽에서 바뀔 수 있으므로 접속이 안 되면 먼저
`getent hosts proxy.tta-gpu.gov-nhncloud.com`로 최신 IP를 재확인할 것.

---

## 6. Supabase Auth 설정 (외부 접속 origin마다 필수)

Google OAuth 로그인은 origin이 바뀔 때마다 Supabase 프로젝트 설정을 갱신해야 한다.
프로젝트: `yqxoxszshrtljcgspidr` →
https://supabase.com/dashboard/project/yqxoxszshrtljcgspidr/auth/url-configuration

- **Redirect URLs**에 사용하는 모든 origin의 콜백을 등록:
  - `http://114.110.181.24:30099/**` (IP 접속용, 현재 주 경로)
  - `http://proxy.tta-gpu.gov-nhncloud.com:30099/**` (도메인 접속 — HSTS 때문에
    브라우저에서 도달 자체가 안 되지만, 등록은 해둬도 무방)
  - `http://localhost:3000/**` (로컬 개발용, 유지)
- **Site URL**은 반드시 **실제로 도달 가능한** 주소로 맞춰둘 것(현재
  `http://114.110.181.24:30099`). GoTrue는 인증 에러(`flow_state_already_used` 등)
  발생 시 요청받은 redirect_to가 아니라 **Site URL로 폴백**한다 — 옛날 값
  (`http://localhost:3000`)으로 방치하면, 에러 시 사용자 자신의 PC의 localhost로
  리다이렉트되어 브라우저가 응답 없는 요청을 무한 대기하게 된다(실제로 겪은 증상).
- `flow_state_already_used`가 재현되면 대개 여러 번 재시도하며 쌓인 오래된 PKCE
  쿠키 충돌이다 — 시크릿창(새 프로필)에서 한 번만 깨끗하게 재시도해서 확인.

---

## 재기동 체크리스트 (VM 재부팅/세션 종료 후)

이 VM에는 systemd가 없고, 모든 프로세스는 `nohup`/`setsid`로 백그라운드 실행한
것이라 **VM/세션이 끊기면 전부 죽는다**. 영구 서비스화(systemd user unit, `pm2`,
`supervisord` 등)는 아직 안 돼 있음 — 필요하면 별도 작업으로 추가할 것. 재기동 순서:

1. Qdrant (§1) — 다른 서비스가 의존하므로 가장 먼저
2. EXAONE judge llama.cpp (§3, 포트 8081) — 모델 로딩 5~10초 대기
3. Backend uvicorn (§2, 포트 8000) — judge가 떠 있어야 `JUDGE_BASE_URL` 헬스 정상
4. Frontend (§4, 포트 8080, 프로덕션) — 코드 변경 있었으면 `npm run build`부터

각 단계 후 `curl`로 개별 확인(§1~§4의 확인 명령) 후 다음 단계로 넘어갈 것 — 한 번에
다 띄우고 마지막에 몰아서 디버깅하면 원인 특정이 어렵다.

---

## 구성 변경 이력 (이 세션에서 바뀐 것)

| 파일 | 변경 | 이유 |
|---|---|---|
| `/home/ubuntu/exaone4.5/run_server.sh` | `--port 8080` → `8081` | 8080을 프론트엔드에 양보 |
| `backend/.env` | `JUDGE_BASE_URL=http://localhost:8081/v1` 추가 | judge를 로컬 직결로 전환 |
| `frontend/next.config.ts` | `/api/*` rewrite 추가 | 외부 포트 하나(8080)로 프론트+백엔드 동시 서빙 |
| `frontend/.env.local` | 신규 생성, `NEXT_PUBLIC_API_BASE_URL=/api` | 위와 동일 목적 |
| `.gitignore` | `.qdrant-bin/` 추가 | Qdrant 바이너리 커밋 방지 |
| Supabase 대시보드 (코드 아님) | Site URL, Redirect URLs 갱신 | 외부 origin 변경 반영 |
