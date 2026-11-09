"""Resolve crash symbols from assets/simple release branches."""

from __future__ import annotations

import os
import re
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SIMPLE_REPO = ROOT / "assets" / "simple"
SYMBOL_CACHE = ROOT / ".symbol-cache"

CDB_CANDIDATES = [
    Path(r"C:\Program Files (x86)\Windows Kits\10\Debuggers\x64\cdb.exe"),
    Path(r"C:\Program Files\Windows Kits\10\Debuggers\x64\cdb.exe"),
]

SYMBOL_PATHS = [
    "pdb/guigui.pdb",
    "pdb/guigui.exe",
    "base/guigui.pdb",
    "base/guigui.exe",
]


def find_cdb() -> Path | None:
    for path in CDB_CANDIDATES:
        if path.exists():
            return path
    return None


def version_to_branch(version: str | None) -> str | None:
    if not version:
        return None
    # 5.0.0.5-8 / 5.0.0.5 → master5005
    main = str(version).strip().split("-")[0]
    parts = [p for p in main.split(".") if p != ""]
    if len(parts) < 4:
        return None
    digits = "".join(parts[:4])
    if not digits.isdigit():
        return None
    return f"master{digits}"


def _run_git(args: list[str], timeout: int = 120) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(SIMPLE_REPO), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        check=False,
    )


def branch_exists(branch: str) -> bool:
    local = _run_git(["show-ref", "--verify", "--quiet", f"refs/heads/{branch}"])
    if local.returncode == 0:
        return True
    remote = _run_git(["show-ref", "--verify", "--quiet", f"refs/remotes/origin/{branch}"])
    return remote.returncode == 0


def resolve_ref(branch: str) -> str | None:
    for ref in (f"origin/{branch}", branch):
        probe = _run_git(["rev-parse", "--verify", ref])
        if probe.returncode == 0:
            return ref.strip() and probe.stdout.strip() and ref
    # try fetch once
    _run_git(["fetch", "origin", branch, "--depth", "1"], timeout=180)
    probe = _run_git(["rev-parse", "--verify", f"origin/{branch}"])
    if probe.returncode == 0:
        return f"origin/{branch}"
    return None


def list_tree_paths(ref: str) -> set[str]:
    result = _run_git(["ls-tree", "-r", "--name-only", ref], timeout=180)
    if result.returncode != 0:
        return set()
    return {line.strip().replace("\\", "/") for line in result.stdout.splitlines() if line.strip()}


def extract_blob(ref: str, rel_path: str, target: Path) -> dict:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and target.stat().st_size > 64:
        return {"path": str(target), "cached": True, "size": target.stat().st_size}

    started = time.time()
    proc = subprocess.run(
        ["git", "-C", str(SIMPLE_REPO), "show", f"{ref}:{rel_path}"],
        capture_output=True,
        timeout=300,
        check=False,
    )
    if proc.returncode != 0:
        err = (proc.stderr or b"").decode("utf-8", errors="replace")
        raise RuntimeError(f"提取失败 {rel_path}: {err or proc.returncode}")
    target.write_bytes(proc.stdout)
    return {
        "path": str(target),
        "cached": False,
        "size": len(proc.stdout),
        "elapsedMs": int((time.time() - started) * 1000),
    }


def ensure_symbols_for_version(version: str | None) -> dict:
    if not SIMPLE_REPO.exists():
        return {
            "ok": False,
            "reason": "missing_repo",
            "message": f"未找到代码仓库：{SIMPLE_REPO}",
        }

    branch = version_to_branch(version)
    if not branch:
        return {
            "ok": False,
            "reason": "bad_version",
            "message": f"无法从版本号解析分支：{version}",
            "version": version,
        }

    ref = resolve_ref(branch)
    if not ref:
        return {
            "ok": False,
            "reason": "branch_not_found",
            "message": f"远程不存在分支 {branch}（版本 {version}）",
            "version": version,
            "branch": branch,
        }

    tree = list_tree_paths(ref)
    wanted = [p for p in SYMBOL_PATHS if p in tree]
    has_pdb = any(p.endswith(".pdb") and "guigui.pdb" in p for p in wanted)
    has_exe = any(p.endswith(".exe") and "guigui.exe" in p for p in wanted)

    if not has_pdb:
        return {
            "ok": False,
            "reason": "pdb_missing",
            "message": f"分支 {branch} 上没有 guigui.pdb，无法做精确符号排查",
            "version": version,
            "branch": branch,
            "ref": ref,
            "available": sorted(p for p in tree if p.endswith((".pdb", ".exe")) and "guigui" in p.lower()),
        }

    cache_dir = SYMBOL_CACHE / branch
    extracted = {}
    for rel in wanted:
        # Prefer pdb/ over base/ when both exist: extract into same flat cache names
        name = Path(rel).name
        target = cache_dir / name
        # If both base and pdb provide same name, prefer first hit already decided by wanted order
        if name in extracted:
            continue
        extracted[name] = extract_blob(ref, rel, target)

    return {
        "ok": True,
        "reason": "ready",
        "message": f"已准备分支 {branch} 的符号文件",
        "version": version,
        "branch": branch,
        "ref": ref,
        "cacheDir": str(cache_dir),
        "files": extracted,
        "hasPdb": has_pdb,
        "hasExe": has_exe,
    }


def _parse_symbol_token(text: str) -> tuple[str | None, str | None, str | None]:
    m = re.search(
        r"(?P<mod>[A-Za-z0-9_+\-\.]+)\!(?P<func>[A-Za-z0-9_:<>,\s~\*\&]+)\+(?P<off>0x[0-9a-fA-F]+)",
        text,
    )
    if not m:
        return None, None, None
    return m.group("mod"), m.group("func").strip(), m.group("off")


def _parse_cdb_output(text: str) -> dict:
    exception_line = None
    faulting_ip = None
    symbol_name = None
    frames = []
    bare_symbol_line = None

    for line in text.splitlines():
        s = line.strip()
        if "ExceptionAddress:" in s:
            exception_line = s
        if s.startswith("FAULTING_IP:"):
            faulting_ip = s
        if s.startswith("SYMBOL_NAME:") and "WRONG_SYMBOLS" not in s:
            symbol_name = s.split(":", 1)[-1].strip()
        if re.match(r"^[0-9a-fA-F]{2}\s+[0-9a-fA-F`]+", s) and ("!" in s or "+" in s):
            frames.append(s)
        if "!" in s and "+" in s and "WRONG_SYMBOLS" not in s:
            if "ExceptionAddress" in s or s.endswith(":") or "QQml" in s or "guigui" in s.lower():
                bare_symbol_line = bare_symbol_line or s

    function = None
    module = None
    offset = None
    for candidate in (exception_line, bare_symbol_line, symbol_name, faulting_ip):
        if not candidate:
            continue
        module, function, offset = _parse_symbol_token(candidate)
        if function:
            if not exception_line:
                exception_line = candidate
            break

    return {
        "exceptionLine": exception_line,
        "faultingIp": faulting_ip,
        "symbolName": symbol_name,
        "module": module,
        "function": function,
        "offset": offset,
        "frames": frames[:30],
        "rawTail": "\n".join(text.splitlines()[-120:]),
    }


def run_cdb_analyze(dump_path: str | Path, symbol_dir: str | Path | None = None) -> dict:
    cdb = find_cdb()
    if not cdb:
        return {
            "ok": False,
            "reason": "cdb_missing",
            "message": "未找到 cdb.exe（Windows Debugging Tools）",
        }

    dump_path = Path(dump_path)
    if not dump_path.exists():
        return {"ok": False, "reason": "dump_missing", "message": f"dump 不存在：{dump_path}"}

    parts = []
    if symbol_dir:
        parts.append(str(Path(symbol_dir)))
    parts.append(str(SIMPLE_REPO / "pdb"))
    parts.append(str(SIMPLE_REPO / "base"))
    sympath = ";".join(dict.fromkeys(parts))

    env = os.environ.copy()
    env["_NT_SYMBOL_PATH"] = sympath
    env.pop("_NT_ALT_SYMBOL_PATH", None)

    script = SYMBOL_CACHE / "_cdb_cmd.txt"
    script.parent.mkdir(parents=True, exist_ok=True)
    # 使用脚本文件，避免 -c 里反斜杠/分号转义问题
    script.write_text(
        "\n".join(
            [
                f'.sympath "{sympath}"',
                "!analyze -v",
                "q",
            ]
        ),
        encoding="ascii",
        errors="ignore",
    )

    cmd = [
        str(cdb),
        "-z",
        str(dump_path),
        "-y",
        sympath,
        "-cf",
        str(script),
    ]
    started = time.time()
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
        check=False,
        env=env,
    )
    text = (proc.stdout or "") + "\n" + (proc.stderr or "")
    parsed = _parse_cdb_output(text)
    return {
        "ok": True,
        "reason": "done",
        "message": "cdb 分析完成",
        "elapsedMs": int((time.time() - started) * 1000),
        "cdb": str(cdb),
        "sympath": sympath,
        "parsedFromOutput": bool(parsed.get("exceptionLine") or parsed.get("function")),
        **parsed,
    }


def enrich_with_symbols(version: str | None, dump_path: str | Path | None) -> dict:
    symbols = ensure_symbols_for_version(version)
    result = {
        "symbols": symbols,
        "cdb": None,
    }
    if not dump_path:
        return result
    symbol_dir = symbols.get("cacheDir") if symbols.get("ok") else (SIMPLE_REPO / "pdb")
    try:
        result["cdb"] = run_cdb_analyze(dump_path, symbol_dir)
    except Exception as err:  # noqa: BLE001
        result["cdb"] = {
            "ok": False,
            "reason": "cdb_error",
            "message": str(err),
        }
    return result
