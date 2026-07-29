# 이 서버를 관리하려면 (D116)

읽는 사람이 사람이든 AI든, **이 문서 하나로 조작할 수 있어야 한다.** 서버에
접속했는데 뭘 해야 할지 모르겠으면 여기부터 본다.

## 한 줄 요약

Nodi는 이 서버에서 **컨테이너 없이 supervisor가 관리하는 프로세스 5개**로 돈다.
데이터는 `~/data/nodi`(영속), 코드·런타임은 `~/app`(휘발).

## 왜 Docker가 아닌가

쓸 수 있는 서버가 이것 하나인데 컨테이너를 못 돌린다. 추측이 아니라 실측이다:

```
CapBnd 0x800004cb        → CAP_SYS_ADMIN(21)·CAP_NET_ADMIN(12) 없음
unshare --user           → Operation not permitted
```

바운딩 셋에 없는 권한은 `sudo`로도 못 얻는다. docker도, rootless podman도
불가능하다. **설치를 시도하지 마라 — 시간만 버린다.**

## 서비스

```
supervisorctl -c ~/app/supervisord.conf status
```

| 프로그램 | 무엇 | 포트 |
|---|---|---|
| `nodi:postgres` | 데이터·RLS·비즈니스 함수 | 127.0.0.1:5433 |
| `nodi:qdrant` | 벡터 검색 (1024d) | 127.0.0.1:6333 |
| `nodi:backend` | FastAPI + **업로드/임베딩 워커도 이 안에서 돈다** | 127.0.0.1:8000 |
| `nodi:frontend` | Next.js `next start` | 127.0.0.1:3000 |
| `nodi:cloudflared` | 외부 공개(HTTPS). 아웃바운드로만 붙는다 | 없음 |

**전부 127.0.0.1에만 바인딩한다.** 인바운드로 열린 포트가 하나도 없고, 외부
접속은 Cloudflare Tunnel만 통한다.

자주 쓰는 명령 (별칭을 깔아 두면 편하다: `alias nodictl='supervisorctl -c ~/app/supervisord.conf'`):

```bash
nodictl status                 # 전체 상태
nodictl restart nodi:backend   # 하나만 재시작
nodictl restart nodi:          # 전부 재시작
nodictl tail -f nodi:backend   # 로그 따라가기
```

## 배포

```bash
~/app/Nodi/deploy/deploy.sh
```

`git fetch → reset --hard origin/main → uv sync → 마이그레이션 → npm build →
재시작 → /health 확인`. 몇 번을 돌려도 안전하다(멱등). GitHub Actions가
main push마다 같은 스크립트를 부른다.

> **서버에서 코드를 직접 고치지 마라.** `deploy.sh`가 `reset --hard`로
> 지워 버린다. 고칠 것은 저장소에서 고치고 main에 올린다.

## 완전 복구 (인스턴스가 재생성됐을 때)

`~/app`이 통째로 사라져도 `~/data`만 살아 있으면 데이터는 그대로다.

```bash
git clone git@github.com:Nodi-Laboratory/Nodi.git ~/app/Nodi
~/app/Nodi/deploy/bootstrap.sh
```

`bootstrap.sh`가 런타임 설치(Postgres·Node·uv·Qdrant·cloudflared)부터 DB 연결,
supervisor 기동, 배포까지 전부 한다. **기존 DB가 있으면 손대지 않는다** —
`initdb`도 스키마 적용도 "없을 때만" 한다.

## 파일이 어디 있나

```
~/data/nodi/            ← 영속 (NFS PVC). 이것만 지키면 데이터는 안 잃는다
├─ pg/                  Postgres 데이터 디렉터리
├─ qdrant/storage/      벡터
├─ storage/             업로드 원본 (STORAGE_ROOT)
├─ backups/             D114 백업 JSON
└─ env/
   ├─ backend.env       ★ 비밀값 정본. repo의 backend/.env가 여기를 가리킨다
   └─ cloudflared.env   터널 토큰

~/app/                  ← 휘발. 날아가도 bootstrap.sh로 복구
├─ Nodi/                git clone (배포 정본, 항상 origin/main과 같음)
├─ bin/                 node-v22/ · qdrant · cloudflared
├─ log/                 ★ 로그 전부 여기
├─ run/                 supervisor 소켓·pid
└─ supervisord.conf     bootstrap이 템플릿에서 생성 (직접 고치지 말 것)
```

**`~/data`를 지우면 복구 수단이 없다.** 오버레이(`~/app`, `~`의 나머지)는
워크로드 재생성 때 사라진다 — 실제로 예전 배포본이 그렇게 사라졌다.

## 뭔가 안 될 때

```bash
nodictl status                      # 어느 서비스가 죽었나
tail -50 ~/app/log/backend.err.log  # 그 서비스의 로그
curl -s localhost:8000/health/config | python3 -m json.tool   # 설정 자가진단
```

| 증상 | 원인과 대처 |
|---|---|
| backend가 `BACKOFF` 반복 | 대개 DB. `nodictl status nodi:postgres` → `tail ~/app/log/postgres.err.log` |
| 채팅만 안 됨 (`ready:false`) | `UPSTAGE_API_KEY` 비었다. `~/data/nodi/env/backend.env` 채우고 `nodictl restart nodi:backend` |
| 교과서 업로드가 503 | `JUDGE_*` 미설정. 의도된 동작이다(도판 비전 판정 비활성). 일반 자료 업로드는 된다 |
| 프론트에 옛날 화면 | `NEXT_PUBLIC_*`·`BACKEND_ORIGIN`은 **빌드 시점에 박힌다.** 재시작이 아니라 `deploy.sh`를 다시 돌려야 한다 |
| `supervisorctl`이 소켓을 못 찾음 | `-c ~/app/supervisord.conf`를 빠뜨렸다. 이 설정을 안 주면 플랫폼 기본 경로를 본다 |
| 포트 충돌 | 이 서버엔 플랫폼 supervisor(sshd·jupyter)가 따로 돈다. **그쪽 `~/services.conf`를 건드리지 마라** — 플랫폼이 재생성한다 |

## 손대면 안 되는 것

- `~/services.conf` — 플랫폼 소유. `.tpl`에서 재생성되므로 추가해도 사라진다.
- `~/app/supervisord.conf` — `deploy/supervisord.conf.tpl`에서 생성된다.
  고칠 일이 있으면 **템플릿을 고치고 `bootstrap.sh`를 다시 돌린다.**
- `~/data/nodi/env/*` — 비밀값. git에 넣지 마라. 백업은 별도로.

## 관련 문서

- [`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md) — 배포 전체 구조와 배경
- [`README.md`](../README.md) — 로컬 개발 (이쪽은 Docker를 쓴다)
- [`CLAUDE.md`](../CLAUDE.md) — 제품 모델·불변식·컨벤션
