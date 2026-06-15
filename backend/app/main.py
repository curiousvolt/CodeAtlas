from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

from .ai import SummaryCache, summarize_file
from .scanner import read_source_file, scan_repository


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPO_ROOT = Path(os.getenv("REPO_ROOT", PROJECT_ROOT)).resolve()
CACHE_FILE = Path(os.getenv("SUMMARY_CACHE_FILE", Path(__file__).resolve().parents[1] / ".cache" / "summaries.json"))

app = FastAPI(title="CodeAtlas API", description="Dependency map, metrics, and AI summaries for local codebases.", version="1.0.0")
cache = SummaryCache(CACHE_FILE)

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class SummaryRequest(BaseModel):
    path: str
    repoPath: str | None = None


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/api/map")
def repository_map(root: str | None = None) -> dict:
    try:
        return scan_repository(root or DEFAULT_REPO_ROOT)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/summary")
async def file_summary(request: SummaryRequest) -> dict:
    try:
        source = read_source_file(request.repoPath or DEFAULT_REPO_ROOT, request.path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        return await summarize_file(source, cache)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"AI summary failed: {exc}") from exc
