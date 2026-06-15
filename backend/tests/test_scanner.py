from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.ai import SummaryCache, summarize_file
from app.main import app
from app.scanner import read_source_file, scan_repository


class ScannerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def write(self, rel_path: str, text: str) -> None:
        path = self.root / rel_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def test_detects_python_typescript_and_c_dependencies(self) -> None:
        self.write("pkg/util.py", "def helper():\n    return 1\n")
        self.write("pkg/main.py", "from pkg import util\nimport pkg.util\nprint(util.helper())\n")
        self.write("web/src/helper.ts", "export const value = 1;\n")
        self.write("web/src/index.ts", "import { value } from './helper';\nconsole.log(value);\n")
        self.write("native/include/defs.h", "#define VALUE 1\n")
        self.write("native/main.c", '#include "include/defs.h"\nint main(){return VALUE;}\n')

        data = scan_repository(self.root)
        edges = {(edge["source"], edge["target"]) for edge in data["edges"]}

        self.assertIn(("pkg/main.py", "pkg/util.py"), edges)
        self.assertIn(("web/src/index.ts", "web/src/helper.ts"), edges)
        self.assertIn(("native/main.c", "native/include/defs.h"), edges)
        self.assertEqual(data["stats"]["files"], 6)
        self.assertEqual(data["stats"]["dependencies"], 3)

    def test_resolves_c_includes_relative_to_current_folder(self) -> None:
        self.write("native/src/detail/config.h", "#define ENABLED 1\n")
        self.write("native/src/main.c", '#include "detail/config.h"\nint main(){return ENABLED;}\n')

        data = scan_repository(self.root)
        edges = {(edge["source"], edge["target"]) for edge in data["edges"]}

        self.assertIn(("native/src/main.c", "native/src/detail/config.h"), edges)

    def test_read_source_file_blocks_path_traversal(self) -> None:
        self.write("safe.py", "print('ok')\n")

        with self.assertRaises(ValueError):
            read_source_file(self.root, "../outside.py")


class SummaryCacheTests(unittest.IsolatedAsyncioTestCase):
    async def test_local_summary_is_cached_by_file_hash(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_path = root / "example.py"
            source_path.write_text("print('hello')\n", encoding="utf-8")
            source = read_source_file(root, "example.py")
            cache = SummaryCache(root / "summaries.json")

            os.environ.pop("AI_PROVIDER", None)
            first = await summarize_file(source, cache)
            second = await summarize_file(source, cache)

            self.assertFalse(first["cached"])
            self.assertTrue(second["cached"])
            self.assertEqual(second["provider"], "local")
            self.assertEqual(second["model"], "heuristic")


class ApiTests(unittest.TestCase):
    def test_health_endpoint(self) -> None:
        client = TestClient(app)
        response = client.get("/api/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok"})

    def test_map_endpoint_returns_repository_graph(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "util.py").write_text("def helper():\n    return 1\n", encoding="utf-8")
            (root / "main.py").write_text("import util\nprint(util.helper())\n", encoding="utf-8")

            client = TestClient(app)
            response = client.get("/api/map", params={"root": str(root)})

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["stats"]["files"], 2)
        self.assertEqual(payload["stats"]["dependencies"], 1)
        self.assertEqual(payload["edges"][0]["source"], "main.py")
        self.assertEqual(payload["edges"][0]["target"], "util.py")

    def test_map_endpoint_rejects_bad_root(self) -> None:
        client = TestClient(app)
        response = client.get("/api/map", params={"root": "Z:/definitely/not/a/repo"})

        self.assertEqual(response.status_code, 400)

    def test_summary_endpoint_returns_local_summary(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "example.py").write_text("print('hello')\n", encoding="utf-8")
            os.environ.pop("AI_PROVIDER", None)

            client = TestClient(app)
            response = client.post(
                "/api/summary",
                json={"repoPath": str(root), "path": "example.py"},
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["provider"], "local")
        self.assertEqual(payload["model"], "heuristic")
        self.assertIn("example.py contains", payload["summary"])


if __name__ == "__main__":
    unittest.main()
