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

[program:backup]
; 매일 정해진 시각에 데이터 스냅샷 (D119). 대부분의 시간을 sleep으로 보낸다.
; TZ를 못 박는 이유: 지금은 이 VM이 KST지만 그건 우리가 정한 게 아니다.
; 워크로드가 UTC로 재생성되면 "새벽 3시"가 한국 낮 12시가 되고, 그 어긋남은
; 아무 로그에도 안 남는다(백업은 계속 성공한다).
command=__REPO_DIR__/deploy/backup-loop.sh
directory=__REPO_DIR__/deploy
environment=TZ="Asia/Seoul"
priority=50
autostart=true
autorestart=true
startsecs=5
stdout_logfile=__LOG_DIR__/backup.log
stderr_logfile=__LOG_DIR__/backup.err.log

[program:ocr]
; 손글씨 인식 모델 서버 (D176·D177). VARCO-VISION-2.0-1.7B-OCR.
;
; llama와 **같은 이유로** supervisor 아래 넣는다: 손으로 띄운 프로세스는
; 상태에 안 잡히고, 죽어도 아무도 모르고, 워크로드가 재생성되면 되살릴 방법이
; 어디에도 안 적혀 있다. 이 서버는 그 위에 실패가 더 조용하다 — 죽으면 화면이
; "준비하고 있어요"(501)라고만 해서 **기능이 아직 안 만들어진 것처럼 보인다.**
;
; CUDA_VISIBLE_DEVICES=__OCR_GPU__ — GPU 0은 llama.cpp가 쓴다.
; PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION=python — 컨테이너의 오래된 onnx
;   *_pb2 모듈과 protobuf가 충돌한다. 없으면 import 단계에서 죽는다.
;
; 바인딩은 **127.0.0.1**이다 (2026-08-05, 사용자 결정). llama와 같은 규약이다.
;
; 왜 좁혔나 — 이 서버는 **인증이 전혀 없었다** (실측, 외부에서):
;     GET http://proxy.tta-gpu…:30020/           → 200 (드래그&드롭 데모 페이지)
;     GET http://proxy.tta-gpu…:30020/openapi.json → 200 (창구 목록 노출)
;   대조군인 llama(judge)는 --api-key-file이 걸려 키 없는 완성 요청이 401이다.
;   이쪽만 무방비여서, 주소를 아는 사람은 누구나 GPU를 쓸 수 있었다.
;   실사용을 재 보니(5시간) loopback 2건 · 공개 경로 16건이었고 그 16건은
;   그날 우리 로컬 개발 호출로 설명됐다 — 남용 흔적은 없었지만 열어 둘 이유도
;   없었다. `GET /`의 데모 페이지는 필요 없다는 결정이 나서 함께 닫혔다.
;
; ⚠️ **로컬 개발은 이제 터널을 쓴다.** 안 열면 펜 입력이 "준비 중"(501)이다:
;     ssh -N -L 18083:127.0.0.1:8083 <호스트>
;     OCR_BASE_URL=http://127.0.0.1:18083
;   프로덕션은 backend.env에 `OCR_BASE_URL=http://127.0.0.1:8083`을 못 박아
;   뒀다(비우면 JUDGE_BASE_URL 호스트에서 유도하는데, 그 값이 외부 주소로
;   바뀌면 OCR이 따라 나가 통째로 죽는다 — D177이 그 사고였다).
;
; autostart=false — 서버 코드가 저장소 밖이라 없는 인스턴스에서 크래시 루프를
; 돌면 안 된다. bootstrap이 server.py를 확인한 뒤 켠다(llama와 같은 방식).
; startsecs=60 — 가중치 4GB 적재에 시간이 걸린다.
;
; ⚠️ **손으로 띄운 프로세스가 남아 있으면 여기로 못 넘어온다.** 이 서버는
; 가중치를 다 적재한 **뒤에** 포트를 잡아서, 충돌하면 매 시도가 1분씩 걸리다
; `address already in use`로 죽고 startretries가 금방 소진돼 FATAL이 된다.
; 넘겨받기 전에 옛 프로세스를 반드시 내린다 — 그런데
; `pkill -f "varco_ocr_server/server.py"`는 **안 먹는다**: start.sh가 cd 후
; `python3 server.py`로 띄워서 커맨드라인에 경로가 없다. `pkill -f
; "server.py --host"` 또는 PID로 잡아야 한다(실측 2026-08-05).
command=python3 __OCR_DIR__/server.py --host 127.0.0.1 --port __OCR_PORT__
directory=__OCR_DIR__
environment=CUDA_VISIBLE_DEVICES="__OCR_GPU__",PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION="python"
priority=15
autostart=false
autorestart=true
startsecs=60
startretries=2
stopwaitsecs=30
stdout_logfile=__LOG_DIR__/ocr.log
stderr_logfile=__LOG_DIR__/ocr.err.log

[group:nodi]
programs=postgres,qdrant,llama,backend,frontend,cloudflared,backup

; ---------------------------------------------------------------------------
; 손글씨 OCR — **nodi 그룹 밖**에 둔다 (gh-runner와 같은 이유).
;
; supervisor의 `update`는 **그룹 단위**다(4.2.1 확인): 그룹 안의 프로그램 하나만
; 고쳐도 그 그룹 전체가 멈췄다 다시 뜬다. ocr이 nodi 안에 있으면 이 항목을
; 한 줄 고치는 데도 **cloudflared까지 내려가 공개 사이트가 멎는다**(실제로 그
; 사고가 한 번 있었다). 그룹이 따로면 `supervisorctl update ocr`로 이것만 간다.
;
; 같은 이유로 llama도 분리 후보다 — 모델 적재가 1~2분이라 남의 재시작에 딸려
; 죽으면 그동안 도판 캡션·펜 표시 해석이 통째로 멎는다.
; ---------------------------------------------------------------------------
; ⚠️ 상태에 `nodi:ocr STOPPED`가 보이면 **띄우지 마라** (2026-08-06 실측).
;
; 예전에는 ocr이 nodi 그룹 안에 있었다. 위 이유로 밖으로 뺐지만, **돌고 있는
; supervisord는 옛 정의를 메모리에 그대로 들고 있다** — 설정 파일은 바뀌었는데
; `reread`/`update`를 안 돌렸기 때문이다. 그래서 `ocr RUNNING`과
; `nodi:ocr STOPPED`가 나란히 보인다. 진짜로 도는 것은 앞쪽 하나뿐이다.
;
; 여기서 `supervisorctl start nodi:ocr`을 누르면 **8083 포트에 두 번째 서버가
; 붙어** 포트 충돌 + GPU 메모리 경합이 난다.
;
; 없애려면 `reread` 뒤 `update`인데, nodi 그룹의 구성원이 바뀐 것이라
; **그룹 전체가 재시작된다**(cloudflared 포함 = 공개 사이트가 잠깐 멎는다).
; 유령 항목은 해롭지 않으므로 **다음 계획된 재시작·재부팅 때 저절로 사라지게
; 둔다** — 화면에 거슬리는 것을 고치자고 사이트를 내릴 이유가 없다.
[group:ocr]
programs=ocr

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
