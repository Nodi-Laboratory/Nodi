; Nodi 전용 supervisord 설정 (D116)
;
; bootstrap.sh가 __PLACEHOLDER__ 를 실제 경로로 치환해 supervisord.conf를
; 만든다. **이 파일을 직접 서버에 두고 쓰지 않는다.**
;
; 왜 플랫폼의 ~/services.conf에 얹지 않았나:
;   1) 옆에 services.conf.tpl 이 있다 — 플랫폼이 재생성한다는 뜻이고, 우리가
;      추가한 program이 조용히 사라진다.
;   2) 기본 supervisorctl이 /var/run/supervisor.sock 을 찾는데 그 소켓이 없다.
;      우리 소켓을 우리 설정에 두면 -c 한 번으로 확실히 붙는다.
; 그래서 소켓·pid·로그까지 전부 우리 것으로 독립시켰다. 플랫폼 supervisor는
; sshd·jupyter를 계속 돌린다 — 서로 건드리지 않는다.

[unix_http_server]
file=__RUN_DIR__/supervisor.sock

[supervisord]
logfile=__LOG_DIR__/supervisord.log
pidfile=__RUN_DIR__/supervisord.pid
childlogdir=__LOG_DIR__
nodaemon=false

[rpcinterface:supervisor]
supervisor.rpcinterface_factory = supervisor.rpcinterface:make_main_rpcinterface

[supervisorctl]
serverurl=unix://__RUN_DIR__/supervisor.sock

; ---------------------------------------------------------------------------
; priority가 기동 순서다. 낮을수록 먼저.
;   10 postgres · qdrant  →  15 llama  →  20 backend  →  30 frontend  →  40 cloudflared
; backend는 DB가 떠야 뜨고, cloudflared는 프론트가 떠야 의미가 있다.
; supervisor는 depends_on이 없으므로 priority + autorestart로 수렴시킨다.
; (DB가 늦게 떠서 backend가 죽어도 autorestart가 다시 올린다.)
; ---------------------------------------------------------------------------

[program:postgres]
; pg_ctl이 아니라 postgres를 직접 띄운다 — supervisor가 프로세스를 직접
; 잡고 있어야 재시작·상태 확인이 정확하다. pg_ctl은 자식을 떼어 놓는다.
command=__PG_BIN__/postgres -D __PGDATA__ -p __PG_PORT__ -k /tmp -c listen_addresses=127.0.0.1
priority=10
autostart=true
autorestart=true
startsecs=5
stopsignal=INT
stopwaitsecs=30
stdout_logfile=__LOG_DIR__/postgres.log
stderr_logfile=__LOG_DIR__/postgres.err.log

[program:qdrant]
command=__BIN_DIR__/qdrant
directory=__NODI_DATA__/qdrant
environment=QDRANT__STORAGE__STORAGE_PATH="__QDRANT_STORAGE__",QDRANT__SERVICE__HTTP_PORT="__QDRANT_PORT__",QDRANT__SERVICE__HOST="127.0.0.1"
priority=10
autostart=true
autorestart=true
startsecs=5
stdout_logfile=__LOG_DIR__/qdrant.log
stderr_logfile=__LOG_DIR__/qdrant.err.log

[program:llama]
; 교과서 도판 캡션 판정용 비전 모델 (D118). llama.cpp + EXAONE-4.5-33B.
;
; 예전에는 사람이 손으로 띄운 프로세스였다 — supervisor 밖에 있어서 상태에도
; 안 잡히고, 죽으면 아무도 모르고, 워크로드가 재생성되면 되살릴 방법이
; 어디에도 안 적혀 있었다(그 상태로 도판 판정이 몇 달간 꺼져 있었다).
;
; 손으로 띄우던 것과 두 가지가 다르다:
;   --host 127.0.0.1   원래 0.0.0.0이었다. 이 서버의 다른 서비스와 규약을 맞춘다.
;   --api-key-file     원래 인증이 없었다. 키 없이 호출하면 이제 401이다.
; 나머지 파라미터(-ngl 99 -c 32768 -fa on)는 실제로 돌던 값 그대로다.
;
; autostart=false — 가중치(22GB)가 없는 인스턴스에서 크래시 루프를 돌지 않게.
; bootstrap이 파일을 확인한 뒤 켠다.
; **restart 비용이 크다**(모델 재적재 1~2분). deploy.sh는 이 프로그램을
; 건드리지 않는다 — 코드 배포와 무관하다.
command=__LLAMA_BIN__/llama-server -m __MODEL_DIR__/__JUDGE_WEIGHTS__ --mmproj __MODEL_DIR__/__JUDGE_MMPROJ__ --host 127.0.0.1 --port __JUDGE_PORT__ --api-key-file __JUDGE_KEY_FILE__ --alias __JUDGE_MODEL_ALIAS__ --no-webui -ngl 99 -c 32768 -fa on
directory=__MODEL_DIR__
priority=15
autostart=false
autorestart=true
startsecs=90
startretries=2
stopwaitsecs=30
stdout_logfile=__LOG_DIR__/llama.log
stderr_logfile=__LOG_DIR__/llama.err.log

[program:backend]
; 업로드·임베딩 워커는 별도 프로세스가 아니다 — 이 앱 프로세스 안에서 돈다.
; --reload 없음(운영), 127.0.0.1 바인딩(외부는 터널만 통한다).
command=__REPO_DIR__/backend/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port __BACKEND_PORT__
directory=__REPO_DIR__/backend
priority=20
autostart=true
autorestart=true
startsecs=10
stopwaitsecs=30
stdout_logfile=__LOG_DIR__/backend.log
stderr_logfile=__LOG_DIR__/backend.err.log

[program:frontend]
command=__NODE_BIN__/node __REPO_DIR__/frontend/node_modules/next/dist/bin/next start -H 127.0.0.1 -p __FRONTEND_PORT__
directory=__REPO_DIR__/frontend
environment=NODE_ENV="production",PATH="__NODE_BIN__:%(ENV_PATH)s"
priority=30
autostart=true
autorestart=true
startsecs=10
stdout_logfile=__LOG_DIR__/frontend.log
stderr_logfile=__LOG_DIR__/frontend.err.log

[program:cloudflared]
; 아웃바운드로만 붙는다 — 인바운드 포트를 하나도 열지 않는다. 이 서버는
; 게이트웨이가 포워딩해 주는 포트가 바뀔 수 있어서 오히려 이 방식이 안정적이다.
; 토큰은 __CLOUDFLARED_ENV__ 에 CF_TUNNEL_TOKEN=... 으로 둔다(git 밖).
; autostart=false — 토큰을 넣기 전에는 뜨지 않는다. 넣은 뒤 bootstrap이 켠다.
command=/bin/bash -c "set -a; . __CLOUDFLARED_ENV__; set +a; exec __BIN_DIR__/cloudflared tunnel --no-autoupdate run --token \"$CF_TUNNEL_TOKEN\""
priority=40
autostart=false
autorestart=true
startsecs=10
stdout_logfile=__LOG_DIR__/cloudflared.log
stderr_logfile=__LOG_DIR__/cloudflared.err.log

[group:nodi]
programs=postgres,qdrant,llama,backend,frontend,cloudflared

; ---------------------------------------------------------------------------
; GitHub Actions self-hosted 러너
;
; **일부러 nodi 그룹 밖에 둔다.** 이 러너가 배포를 실행하는데, `restart nodi:`로
; 그룹 전체를 재시작하면 자기가 돌리고 있는 배포를 스스로 죽인다.
; deploy.sh도 backend·frontend만 건드린다.
;
; 이 서버는 조직 정책으로 deploy key를 못 만든다. 러너는 아웃바운드로만 붙고
; 체크아웃을 자기 토큰으로 하므로, VM에 git 자격증명을 두지 않아도 된다.
; ---------------------------------------------------------------------------
[program:gh-runner]
command=__NODI_APP__/runner/run.sh
directory=__NODI_APP__/runner
autostart=true
autorestart=true
startsecs=10
stopwaitsecs=60
stdout_logfile=__LOG_DIR__/gh-runner.log
stderr_logfile=__LOG_DIR__/gh-runner.err.log
