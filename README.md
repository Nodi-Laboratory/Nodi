# 🌱 Nodi

**A classroom learning canvas where AI answers arrive as concept cards, grounded in the teacher's own materials.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![Next.js](https://img.shields.io/badge/Next.js-000000?logo=nextdotjs&logoColor=white)](https://nextjs.org/) [![React](https://img.shields.io/badge/React-20232A?logo=react&logoColor=61DAFB)](https://react.dev/) [![Python](https://img.shields.io/badge/Python-3776AB?logo=python&logoColor=white)](https://www.python.org/) [![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/) [![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/) [![Qdrant](https://img.shields.io/badge/Qdrant-DC244C?logo=qdrant&logoColor=white)](https://qdrant.tech/) [![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)

**English** | [한국어](README.ko.md)

[![Powered by Upstage](https://img.shields.io/badge/Powered%20by-Upstage%20Solar-7B61FF?style=for-the-badge)](https://www.upstage.ai)

---

## 💭 Developer's Note

> <!-- TODO: 인용구 한 줄 -->

<!-- TODO: 개발 동기 -->

---

## ✨ Features

### 🗂️ Concept Cards on an Infinite Canvas
- Answers stream over SSE from Upstage `solar-pro3` in a fixed card format (`@concept: title | tag`), parsed into cards on the canvas
- Cards are laid out in one column per tag; each tag is a conversation tree linked by `parent_item_id`
- The viewport, pen and shapes come from Excalidraw; cards are an overlay that students can drag, edit and re-ask from
- Before answering, a tool-calling step picks from 11 skills (class material search, figure search, lecture clips, notes, session files, …)

### 🏫 Class Workspaces and RAG
- Teachers create a class with a join code and upload materials and textbooks (PDF, images, TXT/MD)
- Uploads go through Upstage Document Parse → 1,200-char chunks (150 overlap) → `embedding-passage` (1024-d) → Qdrant
- Queries use `embedding-query`; chunks within cosine distance 0.60 are added to the prompt
- Qdrant holds only ids; chunk text is re-read from Postgres under the caller's permissions

### 🖼️ Textbook Figures and Lecture Clips
- Figures are cropped from textbook pages and captioned by a vision model, using the page text as context
- A figure or lecture clip related to the answer is attached next to the concept card
- Admins register lecture packages as JSON; teachers turn packages on per class

### ✍️ Handwritten Questions
- Students can write a question with the pen; the strokes are rendered to an image and read by Gemini
- Arrows, circles and underlines around cards are classified geometrically on the client, so the answer knows which card “this” refers to

### 🔗 Connections Across Sessions
- The home screen shows a concept map built from the student's cards
- A card that falls in a set distance band (0.42–0.66) from a card in another session gets a link badge with a short explanation
- When a branch grows past three cards, a question coach suggests a direction to explore without writing the question for the student

### 🛠️ Teacher and Admin Consoles
- Teachers see each student's class conversations (read-only) and manage materials and lecture packages
- Admins get usage overview, turn logs with prompts and skill traces, a RAG test bench, tunable settings, backups and role management

### 🔐 Accounts and Permissions
- Username or email + password (bcrypt); the session is a JWT in an httpOnly cookie
- Authorization is enforced by Postgres row-level security (71 policies, listed in [`db/RLS_POLICIES.md`](db/RLS_POLICIES.md))

---

## 🚀 Getting Started

### Prerequisites
- [Docker](https://docs.docker.com/get-docker/) with Docker Compose
- (Optional) [Upstage API key](https://console.upstage.ai/api-keys) — AI answers, search, file uploads
- (Optional) [Gemini API key](https://aistudio.google.com/apikey) — handwriting recognition, figure captions

### Run
```bash
git clone https://github.com/Nodi-Laboratory/Nodi.git
cd Nodi
cp .env.example .env
docker compose up
```

Open [http://localhost:3000](http://localhost:3000). The first run builds the images and takes a few minutes. The demo data (class, textbook, figures, conversations) is loaded on first start.

### Demo Accounts
| Username | Password | Role |
|----------|----------|------|
| `demo` | `demo1234` | Student |
| `teacher` | `demo1234` | Teacher |
| `admin` | `demo1234` | Admin |

### API Keys
Without keys, you can log in and browse every screen with the demo data. Features that need a key are disabled with a notice.

- **In `.env`** — set `UPSTAGE_API_KEY` / `GEMINI_API_KEY` (and optionally `GEMINI_VISION_MODEL`) and restart. The server uses these keys for everyone and the key input is hidden.
- **In the app** — leave them empty and enter keys in the dialog shown on first visit, or later under **Settings → AI API keys**. Keys are stored only in your browser's localStorage and sent with each request as a header; the server does not store or log them.
- File uploads run in a background worker, so they only work with `UPSTAGE_API_KEY` in `.env`.
- Gemini models you can choose: `gemini-3.5-flash-lite` (default), `gemini-3.1-flash-lite`, `gemini-3.5-flash`, `gemini-3.6-flash`.

---

## 🛠️ Tech Stack

| Category | Technology |
|----------|-----------|
| **Frontend** | Next.js 16 (App Router), React 19, TypeScript |
| **Canvas** | Excalidraw 0.18, D3.js 7 |
| **Styling** | Tailwind CSS 4 |
| **State** | TanStack Query 5, Zustand 5 |
| **Markdown / Math** | react-markdown, KaTeX |
| **Backend** | Python 3.12, FastAPI, asyncpg, APScheduler |
| **Database** | PostgreSQL 16 (row-level security) |
| **Vector Search** | Qdrant (1024-d, cosine) |
| **AI** | Upstage `solar-pro3` (chat, tool calling), `embedding-query` / `embedding-passage`, Document Parse · Google Gemini (vision) |
| **Auth** | bcrypt, PyJWT (httpOnly cookie) |
| **Testing** | pytest, Vitest, Playwright |
| **Infra** | Docker Compose |

---

## 📁 Project Structure

```
Nodi/
├── 📂 frontend/
│   ├── 📂 src/
│   │   ├── 📂 app/                # Routes: (auth) login/signup, (app) home·sessions·canvas, teacher, admin
│   │   ├── 📂 components/
│   │   │   ├── 📂 canvas2/        # Canvas, cards, figures, clips, pen input, map
│   │   │   ├── 📂 teacher/        # Teacher console
│   │   │   ├── 📂 admin/          # Admin console tabs
│   │   │   └── 📂 settings/       # Settings and API key dialog
│   │   ├── 📂 lib/
│   │   │   ├── 📂 api/            # Backend API client
│   │   │   ├── 📂 canvas2/        # Layout engine, stream parser, ink geometry
│   │   │   └── apiKeys.ts         # Browser-side key storage (localStorage)
│   │   └── proxy.ts               # Route guard (session cookie)
│   └── Dockerfile
├── 📂 backend/
│   ├── 📂 app/
│   │   ├── 📂 routers/            # REST + SSE endpoints under /api
│   │   ├── 📂 services/           # Chat, RAG, Upstage, Gemini, Qdrant, files
│   │   │   └── 📂 worker/         # Background ingest jobs (parse, embed, figures, lectures)
│   │   ├── 📂 ai/                 # Tool-calling orchestrator and skills
│   │   ├── 📂 auth/               # JWT cookie auth, role guards
│   │   ├── 📂 db/                 # Connection pools, RLS-scoped queries, file storage
│   │   ├── 📂 seed_demo/          # Demo data + pre-computed embeddings
│   │   └── main.py                # FastAPI app
│   ├── 📂 tests/
│   └── Dockerfile
├── 📂 db/
│   ├── 📂 migrations/             # Idempotent migrations, applied on every start
│   ├── 00_bootstrap.sql           # auth.uid(), users table, DB roles
│   ├── 01_schema.sql              # Tables, RLS policies, functions
│   └── RLS_POLICIES.md            # Policy list
├── 📂 scripts/
│   └── 📂 capture-screenshots/    # Playwright screenshot script
├── 📂 image/                      # README screenshots
├── 📂 deploy/                     # Scripts for the non-container production server
├── 📂 docs/                       # Development guide, design notes
├── docker-compose.yml
└── .env.example
```

---

## 💡 How to Use

1. **Sign in** with `demo` / `demo1234` (or create an account as a student or teacher)
2. **Pick a space** from Sessions — your personal space or a class you joined with a code
3. **Ask a question**; the answer is written onto the canvas as concept cards
4. **Continue a branch** by selecting a card and asking again, or use **Ask again** on a card
5. **Write with the pen** and draw arrows or circles on cards to ask about a specific card
6. **Open the map** to see the tag trees of the current conversation
7. **As a teacher**, upload materials and textbooks, turn on lecture packages, and read students' class conversations

---

## 👥 Team

| Name | Role |
|------|------|
| <!-- TODO: 팀원 --> | <!-- TODO: 역할 --> |

---

## 🎨 Screenshots

![Class conversation canvas with concept cards, a textbook figure and lecture clips](image/canvas-concept-cards.png)

| | |
|---|---|
| ![Sign in](image/login.png)<br>*Sign in* | ![Home concept map](image/home-concept-map.png)<br>*Home — concept map* |
| ![Session picker](image/session-picker.png)<br>*Personal space and class spaces* | ![Lecture clip](image/canvas-lecture-clip.png)<br>*Concept card with a lecture clip* |
| ![Cross-session link](image/canvas-crosslink.png)<br>*Link badge to another session* | ![Teacher — student conversations](image/teacher-students.png)<br>*Teacher — student conversations (read-only)* |
| ![Teacher — materials](image/teacher-materials.png)<br>*Teacher — materials and lecture packages* | ![Admin overview](image/admin-overview.png)<br>*Admin console* |
| ![API key settings](image/api-key-settings.png)<br>*API key settings* | ![Without a key](image/no-key-notice.png)<br>*Without a key, only AI input is disabled* |

---

## 📝 License

MIT License. See [LICENSE](LICENSE) for details.

| 👤 Developer | ✉️ Email |
|------|-------|
| Zanviq | [zanviq.dev@gmail.com](mailto:zanviq.dev@gmail.com) |
