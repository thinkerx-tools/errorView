#!/usr/bin/env python3
"""Serve ErrorView pages, API proxy, and crash analysis."""

from __future__ import annotations

import json
import os
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from ai_crash import ai_deep_dive
from analyze_crash import analyze_record

ROOT = Path(__file__).resolve().parent
PORT = int(os.environ.get("PORT") or os.environ.get("ERRORVIEW_PORT") or "5173")
HOST = os.environ.get("HOST") or os.environ.get("ERRORVIEW_HOST") or "0.0.0.0"

ENVIRONMENTS = {
    "prod": "https://ggtools.thinkerx.com",
    "online": "https://api-online.eggrj.com",
    "test": "https://api-test.eggrj.com",
}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/crash/analyze":
            self._analyze_crash()
            return
        if parsed.path == "/api/crash/ai-analyze":
            self._ai_analyze_crash()
            return
        self.send_error(404, "Not Found")

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/proxy/error/record":
            self._proxy_error_record(parsed.query)
            return
        if parsed.path == "/api/envs":
            self._json(200, {"status": 1, "data": ENVIRONMENTS})
            return
        if parsed.path == "/api/health":
            self._json(200, {"status": 1, "msg": "ok"})
            return
        if parsed.path == "/api/crash/analyze":
            qs = parse_qs(parsed.query)
            dump_file = (qs.get("dumpFile") or [""])[0]
            if not dump_file:
                self._json(400, {"status": 0, "msg": "缺少 dumpFile"})
                return
            try:
                result = analyze_record(dump_file=dump_file)
                self._json(200, result)
            except Exception as err:  # noqa: BLE001
                self._json(500, {"status": 0, "msg": str(err)})
            return
        super().do_GET()

    def _proxy_error_record(self, query: str):
        params = parse_qs(query)
        env = (params.pop("env", ["prod"]) or ["prod"])[0]
        base = ENVIRONMENTS.get(env)
        if not base:
            self._json(400, {"status": 0, "msg": f"未知环境: {env}"})
            return

        forward = {k: v[0] for k, v in params.items() if v and v[0] != ""}
        target = f"{base}/error/record"
        if forward:
            target = f"{target}?{urllib.parse.urlencode(forward)}"

        req = urllib.request.Request(
            target,
            headers={
                "Accept": "application/json, text/plain, */*",
                "User-Agent": "errorView-online/1.0",
            },
            method="GET",
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                body = resp.read()
                content_type = resp.headers.get("Content-Type", "application/json; charset=utf-8")
                self.send_response(resp.status)
                self.send_header("Content-Type", content_type)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("X-Proxy-Target", target)
                self.end_headers()
                self.wfile.write(body)
        except urllib.error.HTTPError as err:
            body = err.read()
            self.send_response(err.code)
            self.send_header(
                "Content-Type",
                err.headers.get("Content-Type", "application/json; charset=utf-8"),
            )
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("X-Proxy-Target", target)
            self.end_headers()
            self.wfile.write(body or json.dumps({"status": 0, "msg": str(err)}).encode())
        except Exception as err:  # noqa: BLE001
            self._json(502, {"status": 0, "msg": f"代理请求失败: {err}", "target": target})

    def _read_json_body(self, length: int) -> dict:
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw.decode("utf-8") or "{}")

    def _analyze_crash(self):
        length = int(self.headers.get("Content-Length") or 0)
        content_type = self.headers.get("Content-Type", "")
        try:
            if content_type.startswith("multipart/form-data"):
                result = self._analyze_multipart(length)
            else:
                payload = self._read_json_body(length)
                result = analyze_record(
                    record=payload.get("record"),
                    dump_file=payload.get("dumpFile"),
                )
            self._json(200, result)
        except Exception as err:  # noqa: BLE001
            self._json(500, {"status": 0, "msg": f"分析失败: {err}"})

    def _ai_analyze_crash(self):
        length = int(self.headers.get("Content-Length") or 0)
        try:
            payload = self._read_json_body(length)
            analysis = payload.get("analysis")
            if not analysis:
                analysis = analyze_record(
                    record=payload.get("record"),
                    dump_file=payload.get("dumpFile"),
                ).get("data")
            result = ai_deep_dive(analysis=analysis, prefer=payload.get("provider"))
            self._json(200, result)
        except Exception as err:  # noqa: BLE001
            self._json(500, {"status": 0, "msg": f"AI 深挖失败: {err}"})

    def _analyze_multipart(self, length: int):
        body = self.rfile.read(length)
        content_type = self.headers.get("Content-Type", "")
        boundary = None
        for part in content_type.split(";"):
            part = part.strip()
            if part.startswith("boundary="):
                boundary = part.split("=", 1)[1].strip()
        if not boundary:
            raise ValueError("multipart 缺少 boundary")

        marker = ("--" + boundary).encode()
        chunks = body.split(marker)
        fields: dict[str, str] = {}
        dump_path = None

        for chunk in chunks:
            if not chunk or chunk in (b"--\r\n", b"--"):
                continue
            if chunk.startswith(b"\r\n"):
                chunk = chunk[2:]
            if chunk.endswith(b"\r\n"):
                chunk = chunk[:-2]
            if b"\r\n\r\n" not in chunk:
                continue
            header_blob, data = chunk.split(b"\r\n\r\n", 1)
            headers = header_blob.decode("utf-8", errors="ignore")
            name = None
            filename = None
            for line in headers.split("\r\n"):
                if line.lower().startswith("content-disposition:"):
                    for token in line.split(";"):
                        token = token.strip()
                        if token.startswith("name="):
                            name = token.split("=", 1)[1].strip().strip('"')
                        if token.startswith("filename="):
                            filename = token.split("=", 1)[1].strip().strip('"')
            if not name:
                continue
            if filename:
                tmp = Path(tempfile.gettempdir()) / f"errorView-upload-{filename}"
                tmp.write_bytes(data)
                dump_path = str(tmp)
            else:
                fields[name] = data.decode("utf-8", errors="ignore")

        record = None
        if fields.get("record"):
            record = json.loads(fields["record"])
        return analyze_record(
            record=record,
            dump_file=fields.get("dumpFile") or None,
            local_dump=dump_path,
        )

    def _json(self, code: int, payload: dict):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, fmt, *args):
        print(f"[{self.log_date_time_string()}] {args[0]}", flush=True)


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"ErrorView 已启动: http://{HOST}:{PORT}", flush=True)
    print("健康检查: GET /api/health", flush=True)
    print("记录代理: GET /api/proxy/error/record", flush=True)
    print("崩溃分析: POST /api/crash/analyze", flush=True)
    print("AI 深挖: POST /api/crash/ai-analyze", flush=True)
    print("按 Ctrl+C 停止", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止", flush=True)
        server.server_close()


if __name__ == "__main__":
    main()
