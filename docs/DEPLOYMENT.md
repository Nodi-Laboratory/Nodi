# 배포 문서 (D116 · 2026-07-29 기준)

운영 서버가 어떻게 구성돼 있고 **왜 이렇게 됐는지**를 적는다.
서버에 접속해서 뭘 쳐야 하는지는 **[`deploy/README.md`](../deploy/README.md)**를 본다
— 명령·로그 위치·고장 대처는 그쪽이다. 이 문서는 배경과 구조다.

> 이전 판(2026-07-19)은 Supabase·EXAONE 시절 기록이었고 전부 대체됐다.

---

## 한 장 요약

```
                    인터넷
                      │  https://<도메인>   (Cloudflare가 인증서·DNS 담당)
                      ▼
              Cloudflare Edge
                      │
                      │  ← 아웃바운드 터널. 인바운드로 열린 포트가 0개다
                      ▼
  ┌──────────────── TTA GPU VM (Ubuntu 22.04, 92코어 / 885GB) ───────────────┐
  │                                                                          │
  │  supervisord (~/app/supervisord.conf) ── 우리 것. 플랫폼 것과 별개         │
  │    ├─ cloudflared                        터널                             │
  │    ├─ frontend   127.0.0.1:3000          Next.js `next start`             │
  │    │                └ /api/* → rewrite → 127.0.0.1:8000                   │
  │    ├─ backend    127.0.0.1:8000          FastAPI + 업로드/임베딩 워커      │
  │    ├─ qdrant     127.0.0.1:6333          벡터 1024d                       │
  │    ├─ postgres   127.0.0.1:5433          데이터·RLS·비즈니스 함수          │
  │    └─ gh-runner                          Actions self-hosted 러너         │
  │                                                                          │
  │  ~/data/nodi  ← NFS PVC(33T). 영속. DB·벡터·업로드·백업·비밀값            │
  │  ~/app        ← 오버레이. 휘발. 코드·런타임·로그                          │
  └──────────────────────────────────────────────────────────────────────────┘
```

**서비스 전부 127.0.0.1에만 바인딩한다.** 파드 IP로 붙어 봐도 네 포트 모두
거부되는 것을 확인했다. 외부 도달 경로는 Cloudflare Tunnel 하나뿐이다.

---

## 결정 1 — 컨테이너를 쓰지 않는다

D115에서 백엔드·프론트 이미지를 만들었다가 **되돌렸다.** 쓸 수 있는 서버가
이것 하나인데 컨테이너를 못 돌린다. 추측이 아니라 실측이다:

```
CapBnd  0x800004cb    → CAP_SYS_ADMIN(21)·CAP_NET_ADMIN(12) 없음
unshare --user        → Operation not permitted
sudo                  → 무암호로 되지만, 바운딩 셋에 없는 권한은 root도 못 얻는다
```

`unprivileged_userns_clone=1`이라 rootless(podman)에 기대를 걸었는데 실제로
`unshare`를 쳐 보니 seccomp/AppArmor 단에서 막힌다. **docker 설치를 시도하지
마라 — 커널 권한 문제라 설치로 해결되지 않는다.**

그래서 supervisor로 프로세스를 띄운다. 조작감은 compose와 거의 같다:

```bash
supervisorctl -c ~/app/supervisord.conf status
supervisorctl -c ~/app/supervisord.conf restart nodi:backend
```

로컬 개발은 여전히 Docker를 쓴다(인프라만). 노트북에서는 컨테이너가 되고,
그게 지금까지의 개발 흐름이다.

## 결정 2 — 상태는 전부 NFS 볼륨에

이 서버는 **오버레이 파일시스템이 워크로드 재생성 때 사라진다.** 추정이 아니라
실제로 겪었다 — 예전 배포본 `~/Nodi`가 통째로 없어졌고, `models/`·`llama.cpp`만
남아 있었다.

살아남는 것은 `~/data`(NFS PVC 33T)뿐이다. 그래서:

| | 위치 | 사라지면 |
|---|---|---|
| DB·벡터·업로드·백업·비밀값 | `~/data/nodi/` | **복구 불가** |
| 코드·런타임·로그 | `~/app/` | `bootstrap.sh` 한 번으로 복구 |

NFS 위의 Postgres가 느리거나 불안정할까 걱정해 재 봤는데 문제없었다:

```
쓰기  2,650 tps (지연 3.0ms)      읽기  96,521 tps (지연 0.083ms)
```

교실용 부하로는 과하다. 마운트는 `vers=3 hard local_lock=none`이다.

## 결정 3 — 인그레스는 Cloudflare Tunnel

이 VM은 클라우드 게이트웨이가 포워딩해 주는 포트로만 외부에 노출됐었고, 그
포트가 워크로드마다 바뀐다. 터널은 **아웃바운드로 붙으므로** 그 문제에서
자유롭고, HTTPS 인증서와 DNS도 Cloudflare가 맡는다. 인바운드로 열 포트가
하나도 없다는 점에서 보안 면도 낫다.

`cloudflared`는 supervisor의 `autostart=false`다 — 토큰(`~/data/nodi/env/cloudflared.env`)을
넣기 전에는 뜨지 않는다.

## 결정 4 — 배포는 self-hosted 러너가 스스로

GitHub-hosted 러너에서 SSH로 밀어넣는 방식을 버렸다. 이유가 셋이다:

1. **deploy key를 못 만든다.** 조직 정책으로 막혀 있다 —
   `POST /repos/.../keys` → `422 Deploy keys are disabled for this repository`.
   VM이 스스로 `git fetch`할 수단이 없다.
2. SSH 진입점(게이트웨이 호스트·포트)이 바뀔 수 있다.
3. SSH 개인키를 저장소 시크릿에 넣지 않아도 된다.

러너가 자기 토큰으로 체크아웃하고 `rsync`로 `~/app/Nodi`에 배달한 뒤
`deploy.sh --skip-pull`을 부른다. **VM에 git 자격증명이 하나도 없다.**

`.github/workflows/deploy.yml`은 `push: branches: [main]`이다 — dev는 배포하지
않는다. 저장소가 private이라 포크 PR이 self-hosted 러너를 잡는 위험은 없다.

러너는 supervisor에 얹되 **`nodi` 그룹 밖**에 둔다. 그룹째 재시작하면 배포를
실행 중인 자기 자신을 죽인다.

---

## 처음 세울 때

```bash
git clone <repo> ~/app/Nodi        # 또는 러너/rsync로 코드 배달
~/app/Nodi/deploy/bootstrap.sh
```

`bootstrap.sh`가 하는 일 — 전부 **"없을 때만"** 한다(멱등):

1. 런타임 — Postgres 17(PGDG), Node 22(tarball), uv, Qdrant(musl), cloudflared
2. 디렉터리 — 영속/휘발 분리
3. DB — `initdb` → `db/0*.sql` 적용. **기존 DB는 절대 건드리지 않는다**
4. 비밀값 — `~/data/nodi/env/backend.env` 생성, `JWT_SECRET`·DB 비밀번호를
   난수로. repo의 `backend/.env`는 여기를 가리키는 심볼릭 링크
5. supervisor — 템플릿에서 설정 생성 후 기동
6. `deploy.sh` 호출

`UPSTAGE_API_KEY`만 손으로 채운다. 안 채우면 `/health/config`가
`ready:false, blocking:["chat","upstage"]`로 알려 준다.

### 버전 고정

| | 버전 | 왜 |
|---|---|---|
| Postgres | 17 (PGDG) | Ubuntu 22.04 기본은 14까지다 |
| Node | 22.20.0 (tarball) | apt에 22가 없다. root도 필요 없다 |
| Qdrant | 1.18.3 **musl** | glibc 2.35 < gnu 빌드 요구치 2.38 — gnu는 실행 자체가 안 된다 |

`deploy/config.sh` 한 곳에서 바꾼다.

---

## 알아 둘 함정

**프론트의 두 값은 빌드 시점에 박힌다.** `NEXT_PUBLIC_API_BASE_URL`은 번들에,
`BACKEND_ORIGIN`은 `rewrites()`가 빌드 때 평가돼 `routes-manifest.json`에
들어간다. 런타임 환경변수로는 안 바뀐다(실측 — 런타임에만 넣었더니
`ECONNREFUSED 127.0.0.1:8000`이 났다). 재시작이 아니라 `deploy.sh`를 다시
돌려야 반영된다.

**플랫폼 supervisor를 건드리지 마라.** `~/services.conf`는 sshd·jupyter를
돌리는 플랫폼 소유 파일이고, 옆에 `services.conf.tpl`이 있다 — 재생성되므로
거기 추가한 program은 조용히 사라진다. 기본 `supervisorctl`이
`/var/run/supervisor.sock`을 찾는데 그 소켓도 없다. 그래서 우리는 소켓·pid·로그를
전부 분리한 별도 supervisord를 띄운다. **항상 `-c ~/app/supervisord.conf`를 준다.**

**`supervisorctl status`는 정상일 때도 exit 3을 준다.** RUNNING이 아닌 프로그램이
하나라도 있으면 그렇고, cloudflared는 토큰 전까지 일부러 STOPPED다. 스크립트에서
쓸 때 `|| true`가 없으면 `set -e`가 끊는다 — 배포가 전부 성공했는데 실패로
보고된 적이 있다(Actions run 30433823688).

**서버에서 코드를 직접 고치지 마라.** 배포의 `rsync --delete`가 지운다. 수정은
저장소에서 하고 main에 올린다.

**`/health/config`를 rewrite로 열지 마라.** 콘솔의 "환경" 카드가 404 나길래
한 번 열었다가 되돌렸다. 비밀값은 안 담기지만 `secret_is_default`·
`jwt_algorithm`·내부 경로·모델명이 **인증 없이** 나가 정찰 정보가 된다.
로컬 자가진단용으로 만든 창구를 인터넷에 두면 성격이 달라진다. 공개하는 것은
`/health`(상태·서비스명·환경)뿐이고, 콘솔은 `/api/admin/env`로 같은 내용을
관리자 인증을 거쳐 받는다. 서버에서 볼 때는 `curl localhost:8000/health/config`.

**SSE는 `rewrites()`로 넘기면 버퍼링된다.** 채팅 스트림만
`src/app/api/chat/stream/route.ts`가 직접 처리한다. 스트리밍 엔드포인트를
새로 만들면 같은 처리가 필요하다 — rewrites에 맡기면 토큰이 다 끝난 뒤
한꺼번에 떨어진다.

---

## 지금 상태

**공개 주소: <https://app.edunodi.com>**

| | |
|---|---|
| 실행 | postgres · qdrant · backend · frontend · cloudflared · gh-runner (RUNNING) |
| 인그레스 | Cloudflare Tunnel → `http://localhost:3000` · 인바운드 포트 0개 |
| 검증 | 공개 도메인에서 로그인 → 세션 생성 → SSE 실시간 스트리밍(확산 0.51s) 확인 |
| 데이터 | 계정 6개(로컬에서 이관). 학급·문서·대화는 비어 있음 |
| 하드닝 | `JWT_SECRET` 난수 · DB 비밀번호 난수 · 전 서비스 루프백 전용 · env 파일 0600 |
| 자동 배포 | main push → 러너 → 배포 → `/health` 확인까지 성공 |

### 아직 안 한 것

- **관리자 계정 비밀번호를 모른다.** 이관한 `admin@nodi.local`은 로컬에서 쓰던
  해시 그대로라 같은 비밀번호로 들어간다. 새로 만들려면(가입 폼으로는 못 얻는다):
  ```bash
  cd ~/app/Nodi/backend && ./.venv/bin/python -m app.cli create-user <이메일> <비밀번호> --role admin
  ```
- `probe-*` 계정 3개는 관측 점검용으로 만들었던 것이다. 필요 없으면 지운다.
- 교과서 도판 비전 판정(`JUDGE_*`)은 비활성. 이 VM에 GPU와 `llama.cpp`가
  그대로 있어서 되살릴 수 있다(보고서 §5 참조).
- 백업 자동화 — D114 백업 API는 있지만 주기 실행은 걸지 않았다.

## 관련 문서

- [`deploy/README.md`](../deploy/README.md) — **서버 조작은 이쪽**
- [`README.md`](../README.md) — 로컬 개발
- [`docs/CHANGELOG-D104-D114.md`](CHANGELOG-D104-D114.md) — Supabase 제거 이후 변경 보고서
