"""AI-assisted deep dive for crash reports."""

from __future__ import annotations

import json
import os
import re
import subprocess
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
SIMPLE_REPO = ROOT / "assets" / "simple"
CONFIG_PATH = ROOT / "ai_config.json"
PROMPT_DIR = ROOT / ".symbol-cache"

DEFAULT_KEYWORDS = [
    "DelegateModel",
    "ListView",
    "Repeater",
    "model:",
    "remove(",
    "destroy",
    "Component.onDestruction",
]

DEFAULT_AGENT_CANDIDATES = [
    Path(os.environ["LOCALAPPDATA"]) / "cursor-agent" / "agent.cmd" if os.environ.get("LOCALAPPDATA") else None,
    Path(os.environ["LOCALAPPDATA"]) / "cursor-agent" / "cursor-agent.cmd" if os.environ.get("LOCALAPPDATA") else None,
    Path("agent.cmd"),
    Path("agent"),
]


def find_cursor_agent() -> Path | None:
    configured = os.environ.get("ERRORVIEW_CURSOR_AGENT") or os.environ.get("CURSOR_AGENT_BIN")
    if configured:
        p = Path(configured)
        if p.exists():
            return p
    for item in DEFAULT_AGENT_CANDIDATES:
        if not item:
            continue
        if item.exists():
            return item
        # bare command name on PATH
        if item.name == str(item):
            from shutil import which

            hit = which(item.name)
            if hit:
                return Path(hit)
    return None


def load_ai_config() -> dict:
    cfg = {
        "provider": os.environ.get("ERRORVIEW_AI_PROVIDER", "cursor-cli"),
        "baseUrl": os.environ.get("ERRORVIEW_AI_BASE_URL")
        or os.environ.get("OPENAI_BASE_URL")
        or "https://api.openai.com/v1",
        "apiKey": os.environ.get("ERRORVIEW_AI_API_KEY")
        or os.environ.get("OPENAI_API_KEY")
        or os.environ.get("CURSOR_API_KEY")
        or "",
        "model": os.environ.get("ERRORVIEW_AI_MODEL")
        or os.environ.get("OPENAI_MODEL")
        or "",
        "cursorApiKey": os.environ.get("CURSOR_API_KEY") or "",
        "agentBin": os.environ.get("ERRORVIEW_CURSOR_AGENT") or "",
        "workspace": os.environ.get("ERRORVIEW_AI_WORKSPACE")
        or str(SIMPLE_REPO if SIMPLE_REPO.exists() else ROOT),
        "mode": os.environ.get("ERRORVIEW_AI_MODE") or "ask",
        "timeoutSec": int(os.environ.get("ERRORVIEW_AI_TIMEOUT") or "300"),
    }
    if CONFIG_PATH.exists():
        try:
            file_cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            if isinstance(file_cfg, dict):
                cfg.update({k: v for k, v in file_cfg.items() if v not in (None, "")})
        except Exception:  # noqa: BLE001
            pass
    cfg["baseUrl"] = str(cfg.get("baseUrl") or "").rstrip("/")
    workspace = Path(str(cfg.get("workspace") or ROOT))
    if not workspace.is_absolute():
        workspace = (ROOT / workspace).resolve()
    cfg["workspace"] = str(workspace)
    return cfg


def _extract_keywords(analysis: dict) -> list[str]:
    keywords = []
    symbols = ((analysis.get("symbols") or {}).get("cdb") or {})
    if symbols.get("function"):
        keywords.append(str(symbols["function"]).split("::")[0])
        keywords.append(str(symbols["function"]))
    if symbols.get("module"):
        keywords.append(str(symbols["module"]))

    diagnosis = analysis.get("diagnosis") or {}
    for cause in diagnosis.get("likelyCauses") or []:
        for token in re.findall(r"[A-Za-z][A-Za-z0-9_:]{3,}", cause):
            keywords.append(token)

    logs = ((analysis.get("logs") or {}).get("lastTask") or {}).get("body") or ""
    for token in re.findall(r"[A-Za-z][A-Za-z0-9_]{3,}", logs):
        keywords.append(token)

    dump = ((analysis.get("dump") or {}).get("exception") or {}).get("module") or {}
    if dump.get("baseName"):
        keywords.append(Path(dump["baseName"]).stem)

    merged = []
    for item in keywords + DEFAULT_KEYWORDS:
        text = str(item).strip()
        if not text:
            continue
        if text.lower() in {"remove", "model", "error", "crash"}:
            continue
        if text not in merged:
            merged.append(text)
    return merged[:12]


def search_code_snippets(keywords: list[str], limit_files: int = 8) -> list[dict]:
    if not SIMPLE_REPO.exists():
        return []

    rg = os.environ.get("CURSOR_RIPGREP_PATH") or "rg"
    patterns = [kw for kw in keywords if len(kw) >= 4][:6]
    if not patterns:
        patterns = ["DelegateModel", "ListView"]

    hits: list[dict] = []
    seen = set()

    for pattern in patterns:
        if len(hits) >= limit_files:
            break
        try:
            proc = subprocess.run(
                [
                    rg,
                    "-n",
                    "--no-heading",
                    "-S",
                    "-g",
                    "*.qml",
                    "-g",
                    "*.js",
                    "-g",
                    "*.ts",
                    "-g",
                    "*.cpp",
                    "-g",
                    "*.h",
                    "-m",
                    "20",
                    pattern,
                    str(SIMPLE_REPO),
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=30,
                check=False,
            )
        except Exception:  # noqa: BLE001
            continue

        for line in (proc.stdout or "").splitlines():
            # Windows 路径含盘符冒号，不能简单 split(':')
            m = re.search(r":(\d+):", line)
            if not m:
                continue
            path = line[: m.start()]
            lineno = m.group(1)
            content = line[m.end() :]
            try:
                rel = str(Path(path).resolve().relative_to(SIMPLE_REPO.resolve())).replace("\\", "/")
            except Exception:  # noqa: BLE001
                rel = path.replace("\\", "/")
                # 尽量裁成仓库相对路径
                marker = "assets/simple/"
                idx = rel.lower().replace("\\", "/").find(marker)
                if idx >= 0:
                    rel = rel.replace("\\", "/")[idx + len(marker) :]
            key = f"{rel}:{lineno}"
            if key in seen:
                continue
            seen.add(key)
            hits.append(
                {
                    "file": rel,
                    "line": int(lineno) if lineno.isdigit() else lineno,
                    "content": content.strip()[:240],
                    "keyword": pattern,
                }
            )
            if len(hits) >= limit_files * 3:
                break

    # keep top N unique files with a few lines each
    by_file: dict[str, list[dict]] = {}
    for hit in hits:
        by_file.setdefault(hit["file"], []).append(hit)

    snippets = []
    for file, rows in list(by_file.items())[:limit_files]:
        abs_path = SIMPLE_REPO / file
        excerpt = ""
        try:
            lines = abs_path.read_text(encoding="utf-8", errors="replace").splitlines()
            center = int(rows[0]["line"]) - 1
            start = max(0, center - 8)
            end = min(len(lines), center + 12)
            excerpt = "\n".join(f"{i+1:>5}| {lines[i]}" for i in range(start, end))
        except Exception:  # noqa: BLE001
            excerpt = "\n".join(f"{r['line']}| {r['content']}" for r in rows[:5])
        snippets.append(
            {
                "file": file,
                "matches": rows[:5],
                "excerpt": excerpt[:2500],
            }
        )
    return snippets


def build_prompt(analysis: dict, snippets: list[dict]) -> str:
    diagnosis = analysis.get("diagnosis") or {}
    record = analysis.get("record") or {}
    cdb = ((analysis.get("symbols") or {}).get("cdb") or {})
    symbols = ((analysis.get("symbols") or {}).get("symbols") or {})
    logs = analysis.get("logs") or {}
    dump_exc = ((analysis.get("dump") or {}).get("exception") or {})

    snippet_text = "\n\n".join(
        f"### {s['file']}\n```\n{s['excerpt']}\n```" for s in snippets[:6]
    ) or "（未检索到相关代码片段）"

    return f"""你是柜柜/guigui Qt/QML 客户端崩溃分析专家。请基于「已有机器分析结果 + 相关代码片段」给出尽量具体的根因判断。

## 任务
1. 给出 1-3 个最可能根因（按概率排序），每个说明依据
2. 指出最可疑的代码文件/逻辑（结合片段）
3. 给出可执行的复现步骤与验证方法
4. 如果信息不足，明确缺什么，不要编造

## 崩溃记录
- id: {record.get('id')}
- uid: {record.get('uid')}
- phone: {record.get('phone')}
- version: {record.get('version')}
- time: {record.get('create_time')}
- type/level: {record.get('type')}/{record.get('level')}

## 机器分析结论
- headline: {diagnosis.get('headline')}
- confidence: {diagnosis.get('confidence')}
- likelyCauses: {json.dumps(diagnosis.get('likelyCauses') or [], ensure_ascii=False)}
- findings: {json.dumps(diagnosis.get('findings') or [], ensure_ascii=False)}
- suggestions: {json.dumps(diagnosis.get('suggestions') or [], ensure_ascii=False)}

## Dump / 符号
- exception: {json.dumps(dump_exc, ensure_ascii=False)}
- symbolBranch: {symbols.get('branch')} ({symbols.get('message')})
- cdbSymbol: {cdb.get('module')}!{cdb.get('function')}+{cdb.get('offset')}
- exceptionLine: {cdb.get('exceptionLine')}

## 崩溃前日志
- lastTask: {json.dumps(logs.get('lastTask'), ensure_ascii=False)}
- recentTasks: {json.dumps(logs.get('recentTasks') or [], ensure_ascii=False)}
- warningLines: {json.dumps(logs.get('warningLines') or [], ensure_ascii=False)}

## 相关代码片段（来自 assets/simple）
{snippet_text}

请用简体中文输出，结构如下：
### 最可能根因
### 可疑代码位置
### 复现与验证
### 修复建议
"""


def call_cursor_cli(prompt: str, cfg: dict) -> dict:
    agent_bin = None
    if cfg.get("agentBin"):
        candidate = Path(str(cfg["agentBin"]))
        if candidate.exists():
            agent_bin = candidate
    if agent_bin is None:
        agent_bin = find_cursor_agent()
    if agent_bin is None:
        raise RuntimeError(
            "未找到 Cursor CLI（agent）。请确认已安装：%LOCALAPPDATA%\\cursor-agent\\agent.cmd"
        )

    workspace = cfg.get("workspace") or str(SIMPLE_REPO if SIMPLE_REPO.exists() else ROOT)
    mode = str(cfg.get("mode") or "ask").lower()
    if mode not in {"ask", "plan"}:
        mode = "ask"

    PROMPT_DIR.mkdir(parents=True, exist_ok=True)
    prompt_file = PROMPT_DIR / "ai_prompt.txt"
    prompt_file.write_text(prompt, encoding="utf-8")

    # 使用临时说明文件，避免 Windows 命令行长度限制
    launcher_prompt = (
        "请阅读并严格依据以下崩溃分析提示词文件完成分析，不要修改任何代码文件："
        f"{prompt_file}\n"
        "直接输出中文分析结论。"
    )

    cmd = [
        str(agent_bin),
        "-p",
        "--mode",
        mode,
        "--trust",
        "--workspace",
        workspace,
        "--output-format",
        "text",
        launcher_prompt,
    ]
    if cfg.get("model"):
        cmd.extend(["--model", str(cfg["model"])])

    env = os.environ.copy()
    api_key = cfg.get("cursorApiKey") or cfg.get("apiKey") or ""
    if api_key:
        env["CURSOR_API_KEY"] = api_key

    timeout = int(cfg.get("timeoutSec") or 300)
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        check=False,
        env=env,
        cwd=workspace,
    )
    stdout = (proc.stdout or "").strip()
    stderr = (proc.stderr or "").strip()
    combined = stdout or stderr
    lower = (stdout + "\n" + stderr).lower()

    if proc.returncode != 0:
        if "authentication required" in lower or "not logged in" in lower:
            raise RuntimeError(
                "Cursor CLI 未登录。请在终端执行：agent login（或配置 CURSOR_API_KEY）后重试"
            )
        raise RuntimeError(
            f"Cursor CLI 执行失败 (code={proc.returncode}): {(stderr or stdout)[:800]}"
        )
    if not stdout:
        raise RuntimeError(f"Cursor CLI 无输出：{(stderr or 'empty')[:500]}")

    return {
        "provider": "cursor-cli",
        "model": cfg.get("model") or "cursor-agent-default",
        "content": stdout,
        "agentBin": str(agent_bin),
        "workspace": workspace,
        "mode": mode,
        "promptFile": str(prompt_file),
    }


def call_openai_compatible(prompt: str, cfg: dict) -> dict:
    api_key = cfg.get("apiKey") or ""
    if not api_key:
        raise RuntimeError("未配置 API Key（ai_config.json 或 ERRORVIEW_AI_API_KEY / OPENAI_API_KEY）")

    url = f"{cfg['baseUrl']}/chat/completions"
    body = {
        "model": cfg.get("model") or "gpt-4o-mini",
        "temperature": 0.2,
        "messages": [
            {
                "role": "system",
                "content": "你是资深 Qt/QML 崩溃分析工程师，回答要具体、可验证，避免空泛。",
            },
            {"role": "user", "content": prompt},
        ],
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"AI 接口失败 HTTP {err.code}: {detail[:500]}") from err

    choices = payload.get("choices") or []
    if not choices:
        raise RuntimeError(f"AI 返回空结果: {json.dumps(payload, ensure_ascii=False)[:500]}")
    content = choices[0].get("message", {}).get("content") or ""
    return {
        "provider": "openai-compatible",
        "model": cfg.get("model"),
        "content": content,
        "usage": payload.get("usage"),
    }


def local_fallback_report(analysis: dict, snippets: list[dict], keywords: list[str]) -> str:
    diagnosis = analysis.get("diagnosis") or {}
    cdb = ((analysis.get("symbols") or {}).get("cdb") or {})
    lines = [
        "### 最可能根因",
        f"1. {diagnosis.get('headline') or '尚待确认'}",
    ]
    for idx, cause in enumerate((diagnosis.get("likelyCauses") or [])[:3], start=1):
        lines.append(f"{idx}. {cause}")

    lines.extend(
        [
            "",
            "### 可疑代码位置",
        ]
    )
    if snippets:
        for s in snippets[:5]:
            first = (s.get("matches") or [{}])[0]
            lines.append(
                f"- `{s['file']}:{first.get('line', '?')}`（关键词 {first.get('keyword', '')}）"
            )
    else:
        lines.append("- 未在 assets/simple 中检索到高相关片段，建议扩大关键词或切换到对应版本分支代码。")

    lines.extend(
        [
            "",
            "### 复现与验证",
            f"- 关注符号：`{cdb.get('module')}!{cdb.get('function')}+{cdb.get('offset')}`",
            f"- 检索关键词：{', '.join(keywords[:8])}",
            "- 用同版本客户端，按崩溃前 TASK 链路复现（见时间线）",
            "",
            "### 修复建议",
            "- 先确认模型/列表在 remove/销毁时是否仍有绑定访问",
            "- 对 DelegateModel/ListView 做生命周期保护（延迟删除、断开绑定、判空）",
            "",
            "> 当前为本地规则+代码检索结果。请先 `agent login` 后使用 Cursor CLI 深挖。",
        ]
    )
    return "\n".join(lines)


def ai_deep_dive(analysis: dict | None = None, prefer: str | None = None) -> dict:
    analysis = analysis or {}
    cfg = load_ai_config()
    keywords = _extract_keywords(analysis)
    snippets = search_code_snippets(keywords)
    prompt = build_prompt(analysis, snippets)

    provider = (prefer or cfg.get("provider") or "cursor-cli").lower()
    ai_result = None
    error = None

    try:
        if provider in {"cursor-cli", "cursor", "agent"}:
            ai_result = call_cursor_cli(prompt, cfg)
        elif provider in {"openai", "openai-compatible"}:
            ai_result = call_openai_compatible(prompt, cfg)
        else:
            # 默认仍走本地 Cursor CLI
            ai_result = call_cursor_cli(prompt, cfg)
            provider = "cursor-cli"
    except Exception as err:  # noqa: BLE001
        error = str(err)
        ai_result = {
            "provider": "local-fallback",
            "model": "rules+rg",
            "content": local_fallback_report(analysis, snippets, keywords),
        }

    agent_bin = find_cursor_agent()
    return {
        "status": 1,
        "msg": "AI 深挖完成" if not error else f"AI 调用失败，已回退本地深挖：{error}",
        "data": {
            "keywords": keywords,
            "snippets": snippets,
            "prompt": prompt,
            "ai": ai_result,
            "config": {
                "provider": provider,
                "model": cfg.get("model") or "cursor-default",
                "workspace": cfg.get("workspace"),
                "mode": cfg.get("mode") or "ask",
                "agentBin": str(agent_bin) if agent_bin else None,
                "hasApiKey": bool(cfg.get("apiKey") or cfg.get("cursorApiKey")),
            },
            "warning": error,
        },
    }
