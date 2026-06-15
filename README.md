# CodeAtlas

Jumping into an unfamiliar codebase is painful. You open the folder, see a wall of files, and have no idea where anything connects. CodeAtlas fixes that — it scans a local repo, maps out every import relationship, and renders the whole thing as an interactive graph you can actually drag around.

We built this for our GDSC project submission. The backend does the heavy lifting (Python, FastAPI), the frontend renders the graph (React, React Flow with Dagre layout), and clicking any node hits an AI API to summarise what that file actually does.

## What it does

- **Scans locally** — give it any folder path, it walks the whole tree and extracts import dependencies without running any code
- **Multi-language** — handles Python `import`/`from`, JS/TS `import`/`require`, and C/C++ `#include`
- **Interactive graph** — nodes are draggable, zoomable, the layout is computed by Dagre so imports flow left-to-right like they should
- **Metrics on every node** — Lines of Code, cyclomatic complexity estimate, colour coded (green = fine, yellow = watch it, red = needs attention)
- **AI summaries** — click a file, get a 3-sentence plain English explanation. Results are cached by file hash so you don't burn API credits when nothing changed
- **Search** — type anything in the search bar, non-matching nodes dim instantly. Press Escape to clear
- **Dark mode** — toggle with the button in the top right, saves to localStorage

## Stack

| Layer | Tech |
|---|---|
| Backend | Python 3.11, FastAPI, uvicorn |
| Scanner | `ast` (Python), regex (JS/C) |
| AI | OpenAI / Gemini / NVIDIA NIM (any one, or none — falls back to local summary) |
| Frontend | React 18, Vite, React Flow v11 |
| Layout | Dagre |
| Tests | `unittest` (backend), Node.js `--test` (frontend) |

## Running it

**Backend:**

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

**Frontend:**

```powershell
cd frontend
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. By default it scans this repo itself — paste any other path into the input and hit Scan.

You can also hit the API directly:

```
GET http://127.0.0.1:8000/api/map?root=C:\path\to\any\repo
```

## AI setup (optional)

The app works without any AI key — you'll just get a basic local summary. To get proper AI explanations, set one of these before starting the backend:

```powershell
# Gemini (what we used)
$env:AI_PROVIDER = "gemini"
$env:GEMINI_API_KEY = "your-key"
$env:AI_MODEL = "gemini-1.5-flash"

# OpenAI
$env:AI_PROVIDER = "openai"
$env:OPENAI_API_KEY = "your-key"
$env:AI_MODEL = "gpt-4o-mini"

# NVIDIA NIM
$env:AI_PROVIDER = "nvidia"
$env:NVIDIA_API_KEY = "your-key"
$env:AI_MODEL = "meta/llama-3.1-8b-instruct"
```

Summaries are cached in `backend/.cache/summaries.json` — keyed by provider + model + file path + SHA-256 hash of the file content. Change a file and the cache auto-invalidates. Don't change it and you never pay for the same call twice.

## Project structure

```
backend/
  app/
    main.py      — FastAPI routes, CORS, startup
    scanner.py   — walks directories, parses imports, calculates metrics
    ai.py        — talks to AI APIs, manages the summary cache
  tests/
    test_scanner.py

frontend/
  src/
    main.jsx        — main React app, state, UI
    graphUtils.js   — Dagre layout, graph transformations
    styles.css      — all styling, light + dark mode tokens
    graphUtils.test.mjs
```

## Running tests

```powershell
# Backend (from project root)
backend\.venv\Scripts\python.exe -m unittest discover -s backend\tests

# Frontend
cd frontend
npm test
```

## Language support

| Language | How imports are detected |
|---|---|
| Python | `ast.parse` — full syntax tree, handles relative imports correctly |
| JS / TS / JSX / TSX / MJS | Regex on `import`, `export from`, `require()` — only relative paths |
| C / C++ / H | Regex on `#include` — tries relative path, then repo root, then basename match |

Ignored automatically: `.git`, `node_modules`, `dist`, `build`, `__pycache__`, `.venv`, `.cache`, `.next`, `coverage`

## Known limitations

- JS complexity is estimated via keyword counting, not a real AST — so it's approximate
- Dynamic JS imports (`import(\`./foo/${bar}\`)`) are not tracked
- Python docstrings count toward LoC (stripping them would need an extra AST pass)
- No authentication on the API — designed for local use only
