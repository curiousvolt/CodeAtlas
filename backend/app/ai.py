from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import httpx

from .scanner import SourceFile


SUMMARY_PROMPT = "Explain what this code does in 3 simple sentences."

# 12k chars is about right - enough context for most files but won't blow
# the model's context window for very large files. truncating from the top
# loses the most boilerplate (imports) and keeps the actual logic.
_MAX_FILE_CHARS = 12_000


class SummaryCache:
    def __init__(self, cache_file: Path) -> None:
        self.cache_file = cache_file
        self.cache_file.parent.mkdir(parents=True, exist_ok=True)

    def get(self, key: str) -> str | None:
        return self._read().get(key)

    def set(self, key: str, value: str) -> None:
        data = self._read()
        data[key] = value
        self.cache_file.write_text(json.dumps(data, indent=2), encoding="utf-8")

    def _read(self) -> dict[str, str]:
        if not self.cache_file.exists():
            return {}
        try:
            return json.loads(self.cache_file.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {}


async def summarize_file(source: SourceFile, cache: SummaryCache) -> dict[str, Any]:
    provider = os.getenv("AI_PROVIDER", "mock").lower()
    model = os.getenv("AI_MODEL", _default_model(provider))
    # check if we actually have a key for the requested provider
    # if not, silently fall back to the local heuristic so the UI still works
    has_remote_key = (provider == "openai" and os.getenv("OPENAI_API_KEY")) or (
        provider == "gemini" and os.getenv("GEMINI_API_KEY")
    ) or (
        provider == "nvidia" and os.getenv("NVIDIA_API_KEY")
    )
    if not has_remote_key:
        provider = "local"
        model = "heuristic"

    # cache key includes the sha256 so we re-summarize when file contents change
    # but not when only the path changes (e.g. after a git rename)
    cache_key = f"{provider}:{model}:{source.rel_path}:{source.sha256}"

    cached = cache.get(cache_key)
    if cached:
        return {"summary": cached, "cached": True, "provider": provider, "model": model}

    if provider == "openai":
        summary = await _summarize_with_openai(source, model)
    elif provider == "gemini":
        summary = await _summarize_with_gemini(source, model)
    elif provider == "nvidia":
        summary = await _summarize_with_nvidia(source, model)
    else:
        summary = _fallback_summary(source)

    cache.set(cache_key, summary)
    return {"summary": summary, "cached": False, "provider": provider, "model": model}


def _default_model(provider: str) -> str:
    if provider == "openai":
        return "gpt-4o-mini"
    if provider == "gemini":
        return "gemini-1.5-flash"
    if provider == "nvidia":
        return "meta/llama-3.1-8b-instruct"
    return "heuristic"


async def _summarize_with_openai(source: SourceFile, model: str) -> str:
    # TODO: switch to streaming once we add SSE support on the frontend
    api_key = os.environ["OPENAI_API_KEY"]
    async with httpx.AsyncClient(timeout=45) as client:
        response = await client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": model,
                "messages": [
                    {"role": "system", "content": "You explain code clearly and briefly."},
                    {"role": "user", "content": f"{SUMMARY_PROMPT}\n\nFile: {source.rel_path}\n\n```text\n{source.text[:_MAX_FILE_CHARS]}\n```"},
                ],
                "temperature": 0.2,
            },
        )
        response.raise_for_status()
        payload = response.json()
    return payload["choices"][0]["message"]["content"].strip()


async def _summarize_with_gemini(source: SourceFile, model: str) -> str:
    api_key = os.environ["GEMINI_API_KEY"]
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    async with httpx.AsyncClient(timeout=45) as client:
        response = await client.post(
            url,
            params={"key": api_key},
            json={
                "contents": [
                    {
                        "parts": [
                            {
                                "text": f"{SUMMARY_PROMPT}\n\nFile: {source.rel_path}\n\n```text\n{source.text[:_MAX_FILE_CHARS]}\n```"
                            }
                        ]
                    }
                ],
                "generationConfig": {"temperature": 0.2},
            },
        )
        response.raise_for_status()
        payload = response.json()
    return payload["candidates"][0]["content"]["parts"][0]["text"].strip()


async def _summarize_with_nvidia(source: SourceFile, model: str) -> str:
    api_key = os.environ["NVIDIA_API_KEY"]
    base_url = os.getenv("NVIDIA_API_BASE_URL", "https://integrate.api.nvidia.com/v1").rstrip("/")
    async with httpx.AsyncClient(timeout=45) as client:
        response = await client.post(
            f"{base_url}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": model,
                "messages": [
                    {"role": "system", "content": "You explain code clearly and briefly."},
                    {"role": "user", "content": f"{SUMMARY_PROMPT}\n\nFile: {source.rel_path}\n\n```text\n{source.text[:_MAX_FILE_CHARS]}\n```"},
                ],
                "temperature": 0.2,
                "max_tokens": 220,  # llama models get chatty without a cap
            },
        )
        response.raise_for_status()
        payload = response.json()
    return payload["choices"][0]["message"]["content"].strip()


def _fallback_summary(source: SourceFile) -> str:
    # this runs when no AI provider key is set
    # better than showing nothing and confusing people during dev
    lines = [line.strip() for line in source.text.splitlines() if line.strip()]
    first_line = lines[0] if lines else "The file is empty."
    return (
        f"{source.rel_path} contains {len(lines)} non-empty lines of source code. "
        f"It starts with: {first_line[:120]}. "
        "Set AI_PROVIDER with an API key to replace this local summary with an AI-generated explanation."
    )
