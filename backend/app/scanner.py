from __future__ import annotations

import ast
import hashlib
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


SUPPORTED_EXTENSIONS = {
    ".py",
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".mjs",
    ".c",
    ".cc",
    ".cpp",
    ".h",
    ".hpp",
}

IGNORED_DIRS = {
    ".git",
    ".hg",
    ".svn",
    ".venv",
    "venv",
    "env",
    "node_modules",
    "dist",
    "build",
    "__pycache__",
    ".next",
    ".turbo",
    ".cache",
    "coverage",
}

PY_COMPLEXITY_NODES = (
    ast.If,
    ast.For,
    ast.While,
    ast.Try,
    ast.ExceptHandler,
    ast.BoolOp,
    ast.IfExp,
    ast.comprehension,
    ast.Match,
)

# NOTE: this regex handles most real-world JS imports but will miss dynamic imports
# like import(`./foo/${bar}`). Good enough for now.
# TODO: maybe switch to a proper JS AST parser (acorn/babel) if we get complaints
JS_IMPORT_RE = re.compile(
    r"""(?:import\s+(?:[^'"]+\s+from\s+)?|export\s+[^'"]+\s+from\s+|require\()\s*['"]([^'"]+)['"]""",
    re.MULTILINE,
)
C_INCLUDE_RE = re.compile(r"""^\s*#\s*include\s*[<"]([^>"]+)[>"]""", re.MULTILINE)
# FIXME: this catches boolean operators (&&, ||) which inflates complexity a bit
# but it's still a useful rough signal. real cyclomatic complexity needs a full parse
SIMPLE_COMPLEXITY_RE = re.compile(
    r"\b(if|for|while|case|catch|switch|&&|\|\||\?|elif|except)\b"
)


@dataclass(frozen=True)
class SourceFile:
    path: Path
    rel_path: str
    text: str
    sha256: str


def scan_repository(root: str | Path) -> dict:
    # expanduser handles ~ paths which students tend to pass in
    root_path = Path(root).expanduser().resolve()
    if not root_path.exists() or not root_path.is_dir():
        raise ValueError(f"Repository path does not exist or is not a directory: {root_path}")

    files = list(_iter_source_files(root_path))
    rel_to_file = {source.rel_path: source for source in files}
    module_index = _build_python_module_index(files)
    basename_index = _build_basename_index(files)

    nodes = [_build_node(source) for source in files]
    edges = []
    seen_edges: set[tuple[str, str, str]] = set()

    for source in files:
        for dependency in _extract_dependencies(source, root_path, module_index, basename_index):
            if dependency not in rel_to_file or dependency == source.rel_path:
                continue
            edge_key = (source.rel_path, dependency, "imports")
            if edge_key in seen_edges:
                continue
            seen_edges.add(edge_key)
            edges.append(
                {
                    "id": f"{source.rel_path}->{dependency}",
                    "source": source.rel_path,
                    "target": dependency,
                    "label": "imports",
                }
            )

    return {
        "root": str(root_path),
        "nodes": nodes,
        "edges": edges,
        "stats": {
            "files": len(nodes),
            "dependencies": len(edges),
            "totalLoc": sum(node["data"]["loc"] for node in nodes),
            "maxComplexity": max((node["data"]["complexity"] for node in nodes), default=0),
        },
    }


def read_source_file(root: str | Path, rel_path: str) -> SourceFile:
    root_path = Path(root).expanduser().resolve()
    candidate = (root_path / rel_path).resolve()
    if root_path != candidate and root_path not in candidate.parents:
        raise ValueError("Requested file is outside the repository root.")
    if not candidate.exists() or not candidate.is_file():
        raise ValueError(f"File does not exist: {rel_path}")
    return _read_source(root_path, candidate)


def _iter_source_files(root: Path) -> Iterable[SourceFile]:
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if any(part in IGNORED_DIRS for part in path.relative_to(root).parts[:-1]):
            continue
        if path.suffix.lower() not in SUPPORTED_EXTENSIONS:
            continue
        yield _read_source(root, path)


def _read_source(root: Path, path: Path) -> SourceFile:
    text = path.read_text(encoding="utf-8", errors="replace")
    rel_path = path.relative_to(root).as_posix()
    return SourceFile(
        path=path,
        rel_path=rel_path,
        text=text,
        sha256=hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest(),
    )


def _build_node(source: SourceFile) -> dict:
    loc = _count_loc(source)
    complexity = _estimate_complexity(source)
    folder = str(Path(source.rel_path).parent).replace("\\", "/")
    if folder == ".":
        folder = "root"
    return {
        "id": source.rel_path,
        "type": "fileNode",
        "data": {
            "label": Path(source.rel_path).name,
            "path": source.rel_path,
            "folder": folder,
            "extension": Path(source.rel_path).suffix.lower(),
            "loc": loc,
            "complexity": complexity,
            "sha256": source.sha256,
        },
    }


def _count_loc(source: SourceFile) -> int:
    # counts non-empty, non-comment lines. not perfect but consistent.
    # we don't strip Python docstrings as strings - that would need an AST walk
    count = 0
    in_block_comment = False
    for raw_line in source.text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if source.path.suffix == ".py" and line.startswith("#"):
            continue
        if source.path.suffix in {".js", ".jsx", ".ts", ".tsx", ".mjs", ".c", ".cc", ".cpp", ".h", ".hpp"}:
            if in_block_comment:
                if "*/" in line:
                    in_block_comment = False
                continue
            if line.startswith("/*"):
                in_block_comment = "*/" not in line
                continue
            if line.startswith("//"):
                continue
        count += 1
    return count


def _estimate_complexity(source: SourceFile) -> int:
    # baseline of 1 so every file has at least complexity=1
    # python gets proper AST-based McCabe, everything else gets a keyword count
    # TODO: could add JS AST complexity via a subprocess call to node, but overkill for now
    if source.path.suffix == ".py":
        try:
            tree = ast.parse(source.text)
        except SyntaxError:
            return 1
        return 1 + sum(isinstance(node, PY_COMPLEXITY_NODES) for node in ast.walk(tree))
    return 1 + len(SIMPLE_COMPLEXITY_RE.findall(source.text))


def _build_python_module_index(files: list[SourceFile]) -> dict[str, str]:
    index: dict[str, str] = {}
    for source in files:
        if source.path.suffix != ".py":
            continue
        parts = Path(source.rel_path).with_suffix("").parts
        module = ".".join(parts)
        index[module] = source.rel_path
        if parts[-1] == "__init__":
            index[".".join(parts[:-1])] = source.rel_path
    return index


def _build_basename_index(files: list[SourceFile]) -> dict[str, list[str]]:
    index: dict[str, list[str]] = {}
    for source in files:
        index.setdefault(Path(source.rel_path).name, []).append(source.rel_path)
    return index


def _extract_dependencies(
    source: SourceFile,
    root: Path,
    module_index: dict[str, str],
    basename_index: dict[str, list[str]],
) -> Iterable[str]:
    suffix = source.path.suffix.lower()
    if suffix == ".py":
        yield from _extract_python_dependencies(source, module_index)
    elif suffix in {".js", ".jsx", ".ts", ".tsx", ".mjs"}:
        yield from _extract_js_dependencies(source, root)
    elif suffix in {".c", ".cc", ".cpp", ".h", ".hpp"}:
        yield from _extract_c_dependencies(source, root, basename_index)


def _extract_python_dependencies(source: SourceFile, module_index: dict[str, str]) -> Iterable[str]:
    try:
        tree = ast.parse(source.text)
    except SyntaxError:
        return

    current_module = ".".join(Path(source.rel_path).with_suffix("").parts)
    if current_module.endswith(".__init__"):
        current_package = current_module.removesuffix(".__init__")
    else:
        current_package = ".".join(current_module.split(".")[:-1])

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                resolved = _resolve_python_module(alias.name, module_index)
                if resolved:
                    yield resolved
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            if node.level:
                base_parts = current_package.split(".") if current_package else []
                base = ".".join(base_parts[: max(len(base_parts) - node.level + 1, 0)])
                module = ".".join(part for part in [base, module] if part)
            resolved = _resolve_python_module(module, module_index)
            if resolved:
                yield resolved
            for alias in node.names:
                candidate = ".".join(part for part in [module, alias.name] if part)
                resolved = _resolve_python_module(candidate, module_index)
                if resolved:
                    yield resolved


def _resolve_python_module(module: str, module_index: dict[str, str]) -> str | None:
    parts = module.split(".")
    for end in range(len(parts), 0, -1):
        candidate = ".".join(parts[:end])
        if candidate in module_index:
            return module_index[candidate]
    return None


def _extract_js_dependencies(source: SourceFile, root: Path) -> Iterable[str]:
    # only track relative imports (starts with . or ..) — package imports like
    # 'react' or 'lodash' aren't in the repo so they'd just show as dead edges
    for specifier in JS_IMPORT_RE.findall(source.text):
        if not specifier.startswith("."):
            continue
        resolved = _resolve_relative_source(root, source.path.parent, specifier)
        if resolved:
            yield resolved


def _extract_c_dependencies(source: SourceFile, root: Path, basename_index: dict[str, list[str]]) -> Iterable[str]:
    for include in C_INCLUDE_RE.findall(source.text):
        resolved = _resolve_c_include(source, root, include, basename_index)
        if resolved:
            yield resolved


def _resolve_relative_source(root: Path, base: Path, specifier: str) -> str | None:
    candidates = []
    raw = (base / specifier).resolve()
    if raw.suffix:
        candidates.append(raw)
    else:
        for extension in [".ts", ".tsx", ".js", ".jsx", ".mjs"]:
            candidates.append(raw.with_suffix(extension))
        for extension in [".ts", ".tsx", ".js", ".jsx"]:
            candidates.append(raw / f"index{extension}")

    for candidate in candidates:
        if candidate.exists() and candidate.is_file():
            return candidate.relative_to(root).as_posix()
    return None


def _resolve_c_include(
    source: SourceFile,
    root: Path,
    include: str,
    basename_index: dict[str, list[str]],
) -> str | None:
    normalized = include.replace("\\", "/")
    candidates = [
        (source.path.parent / normalized).resolve(),
        (root / normalized).resolve(),
    ]

    for candidate in candidates:
        if not candidate.exists() or not candidate.is_file():
            continue
        if root == candidate or root in candidate.parents:
            return candidate.relative_to(root).as_posix()

    matches = basename_index.get(Path(normalized).name, [])
    return matches[0] if matches else None
