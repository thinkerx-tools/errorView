"""Crash dump + runtime log analyzer."""

from __future__ import annotations

import json
import os
import re
import tempfile
import urllib.request
from pathlib import Path
from typing import Any

OSS_HOST = "https://eggrj.oss-cn-hangzhou.aliyuncs.com"
DUMP_CACHE = Path(tempfile.gettempdir()) / "errorView-dumps"
DUMP_CACHE.mkdir(parents=True, exist_ok=True)

EXCEPTION_HINTS = {
    "EXCEPTION_ACCESS_VIOLATION": {
        "title": "访问冲突（Access Violation）",
        "summary": "进程访问了非法内存地址，常见于空指针、野指针、已释放对象或损坏的数据结构。",
    },
    "EXCEPTION_STACK_OVERFLOW": {
        "title": "栈溢出",
        "summary": "调用栈过深或局部大数组导致栈耗尽，常见于递归、循环回调或异常的脚本调用链。",
    },
    "EXCEPTION_INT_DIVIDE_BY_ZERO": {
        "title": "整数除零",
        "summary": "发生整数除以 0，通常是业务计算或尺寸推导逻辑未做保护。",
    },
    "EXCEPTION_FLT_DIVIDE_BY_ZERO": {
        "title": "浮点除零",
        "summary": "浮点运算除以 0，常见于几何/渲染计算。",
    },
    "EXCEPTION_ILLEGAL_INSTRUCTION": {
        "title": "非法指令",
        "summary": "执行了非法 CPU 指令，可能是内存破坏或二进制不兼容。",
    },
    "EXCEPTION_IN_PAGE_ERROR": {
        "title": "页错误",
        "summary": "映射文件/内存页不可用，可能与磁盘、内存映射资源有关。",
    },
}

MODULE_HINTS = [
    (re.compile(r"Qt5QmlModels|Qt5Qml|qmlmodels", re.I), "QML 模型/绑定层异常，常见于列表模型、方案数据绑定或动态对象树更新。"),
    (re.compile(r"Qt5Quick|qtquick", re.I), "Qt Quick 渲染/场景图异常，常见于界面刷新、动画或组件销毁时机问题。"),
    (re.compile(r"Qt5Gui|Qt5Widgets", re.I), "GUI 层异常，常见于图像、字体、窗口资源处理。"),
    (re.compile(r"qsvg|qjpeg|qwebp|qtiff|qgif|imageformats", re.I), "图片解码/色卡资源异常，优先排查贴图、缩略图、SVG 资源。"),
    (re.compile(r"SketchUpAPI|SketchUp", re.I), "SketchUp API 相关，可能与外部模型导入/导出有关。"),
    (re.compile(r"Qt5WebEngine|liteav|txffmpeg", re.I), "WebEngine/音视频组件异常，可能与内嵌网页或媒体播放有关。"),
    (re.compile(r"guigui\.exe", re.I), "主程序模块异常，问题更可能出在业务逻辑而非第三方插件。"),
    (re.compile(r"ntdll|kernelbase|msvcp|vcruntime", re.I), "系统/运行库异常，往往是上层逻辑破坏内存后的结果，需结合崩溃前业务动作判断。"),
]

TASK_HINTS = [
    (re.compile(r"designer", re.I), "崩溃前处于设计器场景，优先排查柜体编辑、保存、渲染 JSON 相关逻辑。"),
    (re.compile(r"projectList|mainPage|loadPage", re.I), "崩溃前在项目列表/主页加载流程，优先排查项目打开与初始化。"),
    (re.compile(r"补件|清单|输出", re.I), "崩溃前在清单/输出流程，优先排查导出与清单生成。"),
    (re.compile(r"switchTask", re.I), "崩溃前刚切换任务页签，可能与页面切换时的资源释放有关。"),
]


def normalize_info(info: Any) -> dict:
    if info is None:
        return {}
    if isinstance(info, dict):
        return info
    if isinstance(info, str):
        text = info.strip()
        if not text:
            return {}
        try:
            parsed = json.loads(text)
            return parsed if isinstance(parsed, dict) else {"raw": parsed}
        except json.JSONDecodeError:
            return {"raw": text}
    return {"raw": info}


def dump_url(dump_file: str) -> str:
    path = dump_file.replace("\\", "/").lstrip("/")
    return f"{OSS_HOST}/{path}"


def parse_dump_meta(dump_file: str) -> dict:
    path = dump_file.replace("\\", "/")
    name = Path(path).name
    parts = name.replace(".dmp", "").split("_")
    meta = {
        "dumpFile": path,
        "fileName": name,
        "platform": "windows" if "/windows/" in path.lower() else "unknown",
    }
    # crashes/windows/<version>/<hash>_<uid>_<version>.dmp
    segs = path.split("/")
    if len(segs) >= 3:
        meta["versionFromPath"] = segs[-2]
    if len(parts) >= 3:
        meta["hash"] = parts[0]
        meta["uidFromName"] = parts[1]
        meta["versionFromName"] = "_".join(parts[2:])
    elif len(parts) == 2:
        meta["hash"] = parts[0]
        meta["uidFromName"] = parts[1]
    return meta


def download_dump(dump_file: str) -> Path:
    meta = parse_dump_meta(dump_file)
    target = DUMP_CACHE / meta["fileName"]
    if target.exists() and target.stat().st_size > 64:
        return target
    url = dump_url(dump_file)
    urllib.request.urlretrieve(url, target)
    return target


def _module_basename(name: str) -> str:
    return Path(str(name).replace("\\", "/")).name


def find_module(modules: list[dict], address: int) -> dict | None:
    for mod in modules:
        base = mod["base"]
        size = mod["size"]
        if base <= address < base + size:
            return mod
    return None


def _exception_code_raw(rec) -> int:
    raw = getattr(rec, "ExceptionCode_raw", None)
    if raw is not None:
        return int(raw)
    code = rec.ExceptionCode
    if hasattr(code, "value"):
        return int(code.value)
    try:
        return int(code)
    except (TypeError, ValueError):
        return 0


def analyze_minidump(path: str | Path) -> dict:
    import logging

    from minidump.minidumpfile import MinidumpFile

    # PEB 解析失败不影响异常流，降低噪音
    logging.getLogger().setLevel(logging.CRITICAL)
    mf = MinidumpFile.parse(str(path))
    modules = []
    if mf.modules and mf.modules.modules:
        for m in mf.modules.modules:
            modules.append(
                {
                    "name": m.name,
                    "baseName": _module_basename(m.name or ""),
                    "base": int(m.baseaddress),
                    "size": int(m.size),
                    "baseHex": hex(int(m.baseaddress)),
                }
            )

    exception = None
    if mf.exception and getattr(mf.exception, "exception_records", None):
        stream = mf.exception.exception_records[0]
        rec = stream.ExceptionRecord
        code_name = str(rec.ExceptionCode).replace("ExceptionCode.", "")
        code_raw = _exception_code_raw(rec)
        addr = int(rec.ExceptionAddress)
        info = [int(x) for x in (rec.ExceptionInformation or [])]
        hit = find_module(modules, addr)
        access = None
        if code_name == "EXCEPTION_ACCESS_VIOLATION" and info:
            access = "读" if info[0] == 0 else "写" if info[0] == 1 else f"类型{info[0]}"
        exception = {
            "threadId": int(stream.ThreadId),
            "code": code_name,
            "codeRaw": code_raw,
            "codeHex": hex(code_raw),
            "address": addr,
            "addressHex": hex(addr),
            "flags": int(rec.ExceptionFlags),
            "information": info,
            "faultAddressHex": hex(info[1]) if len(info) > 1 else None,
            "accessType": access,
            "module": hit,
            "offsetHex": hex(addr - hit["base"]) if hit else None,
        }

    app_modules = [
        m
        for m in modules
        if re.search(r"guigui|qt5|qml|sketch|egg|algo|imageformats", m["baseName"], re.I)
    ][:40]

    return {
        "ok": True,
        "path": str(path),
        "size": Path(path).stat().st_size,
        "exception": exception,
        "moduleCount": len(modules),
        "appModules": app_modules,
    }


LOG_LINE_RE = re.compile(
    r"^\[(?P<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}:\d{3})\]\s*\[(?P<tag>[^\]]+)\]\s*(?P<body>.*)$"
)


def analyze_logs(logs: list[str] | None) -> dict:
    rows = []
    for raw in logs or []:
        line = str(raw).replace("\r", "").strip()
        if not line:
            continue
        m = LOG_LINE_RE.match(line)
        if m:
            rows.append(
                {
                    "time": m.group("ts"),
                    "tag": m.group("tag"),
                    "body": m.group("body").strip(),
                    "raw": line,
                }
            )
        else:
            rows.append({"time": "", "tag": "RAW", "body": line, "raw": line})

    # 原始日志通常是新→旧
    chronological = list(reversed(rows))
    tasks = [r for r in chronological if r["tag"].upper() == "TASK"]
    last_task = tasks[-1] if tasks else None
    recent_tasks = tasks[-8:]

    keywords = []
    for r in chronological:
        body_l = r["body"].lower()
        if any(k in body_l for k in ["error", "fail", "exception", "crash", "超时", "失败", "异常"]):
            if "success" not in body_l:
                keywords.append(r)

    return {
        "count": len(rows),
        "tags": sorted({r["tag"] for r in rows}),
        "lastTask": last_task,
        "recentTasks": recent_tasks,
        "warningLines": keywords[-10:],
        "timeline": chronological[-20:],
    }


def build_diagnosis(
    meta: dict,
    dump_result: dict | None,
    log_result: dict,
    record: dict | None = None,
    symbol_result: dict | None = None,
) -> dict:
    findings = []
    likely_cause = []
    suggestions = []
    confidence = 35

    symbols = (symbol_result or {}).get("symbols") or {}
    cdb = (symbol_result or {}).get("cdb") or {}

    if symbols:
        if symbols.get("ok"):
            findings.append(
                {
                    "level": "info",
                    "title": f"已匹配符号分支 {symbols.get('branch')}",
                    "detail": symbols.get("message") or "",
                }
            )
            confidence += 5
        elif symbols.get("reason") == "pdb_missing":
            findings.append(
                {
                    "level": "medium",
                    "title": "对应分支没有 PDB",
                    "detail": symbols.get("message")
                    or "已切换到版本对应分支，但仓库中不存在 guigui.pdb，无法继续精确符号定位。",
                }
            )
            suggestions.append("该版本分支未归档 PDB，只能依赖 dump 异常模块与崩溃前日志做有限排查。")
        elif symbols.get("reason") == "branch_not_found":
            findings.append(
                {
                    "level": "medium",
                    "title": "未找到版本对应分支",
                    "detail": symbols.get("message") or "",
                }
            )

    if cdb and cdb.get("ok") and cdb.get("function"):
        findings.append(
            {
                "level": "critical",
                "title": f"符号解析：{cdb.get('module')}!{cdb.get('function')}",
                "detail": f"偏移 {cdb.get('offset')}；{cdb.get('exceptionLine') or ''}",
            }
        )
        confidence += 20
        func = str(cdb.get("function") or "")
        if "QQmlDelegateModelGroup::remove" in func:
            likely_cause.append(
                "崩溃点位于 QML DelegateModel 删除逻辑（QQmlDelegateModelGroup::remove），"
                "常见于列表/模型在刷新或销毁时仍被访问，优先排查 DelegateModel/ListView 数据源生命周期。"
            )
        elif "QQml" in func or "QQuick" in func:
            likely_cause.append(f"崩溃点位于 Qt QML/Quick 函数 {func}，优先排查对应 QML 组件与模型绑定。")
        else:
            likely_cause.append(f"崩溃点符号为 {cdb.get('module')}!{func}。")

    exc = (dump_result or {}).get("exception")
    if exc:
        hint = EXCEPTION_HINTS.get(
            exc["code"],
            {"title": exc["code"], "summary": "捕获到原生异常，需结合模块与崩溃前操作进一步判断。"},
        )
        findings.append(
            {
                "level": "critical",
                "title": hint["title"],
                "detail": (
                    f"异常码 {exc['codeHex']}，地址 {exc['addressHex']}"
                    + (f"，{exc['accessType']}访问" if exc.get("accessType") else "")
                    + (f"，故障地址 {exc.get('faultAddressHex')}" if exc.get("faultAddressHex") else "")
                ),
            }
        )
        likely_cause.append(hint["summary"])
        confidence += 25

        mod = exc.get("module")
        if mod:
            base_name = mod.get("baseName") or _module_basename(mod.get("name") or "")
            findings.append(
                {
                    "level": "high",
                    "title": f"崩溃落点模块：{base_name}",
                    "detail": f"模块基址 {mod.get('baseHex')}，偏移 {exc.get('offsetHex')}，完整路径 {mod.get('name')}",
                }
            )
            confidence += 15
            for pattern, text in MODULE_HINTS:
                if pattern.search(base_name) or pattern.search(mod.get("name") or ""):
                    likely_cause.append(text)
                    break
        else:
            findings.append(
                {
                    "level": "medium",
                    "title": "未匹配到模块",
                    "detail": "异常地址不在已知模块映射内，可能是动态生成代码或 dump 模块列表不完整。",
                }
            )

    last_task = log_result.get("lastTask")
    if last_task:
        findings.append(
            {
                "level": "high",
                "title": "崩溃前最后任务",
                "detail": f"[{last_task.get('time')}] {last_task.get('body')}",
            }
        )
        confidence += 10
        for pattern, text in TASK_HINTS:
            if pattern.search(last_task.get("body") or "") or pattern.search(last_task.get("raw") or ""):
                likely_cause.append(text)
                break

    if log_result.get("recentTasks"):
        chain = " → ".join(t.get("body", "")[:40] for t in log_result["recentTasks"][-5:])
        findings.append(
            {
                "level": "info",
                "title": "近期任务链",
                "detail": chain or "无",
            }
        )

    if log_result.get("warningLines"):
        findings.append(
            {
                "level": "medium",
                "title": f"发现 {len(log_result['warningLines'])} 条可疑日志",
                "detail": log_result["warningLines"][-1].get("raw", "")[:180],
            }
        )
        confidence += 5

    if record:
        findings.append(
            {
                "level": "info",
                "title": "用户上下文",
                "detail": f"uid={record.get('uid')} phone={record.get('phone')} version={record.get('version')} time={record.get('create_time')}",
            }
        )

    if meta.get("versionFromPath") and record and record.get("version"):
        if meta["versionFromPath"] != record.get("version"):
            findings.append(
                {
                    "level": "medium",
                    "title": "版本信息不一致",
                    "detail": f"dump 路径版本 {meta['versionFromPath']}，记录版本 {record.get('version')}",
                }
            )

    # suggestions
    if exc and exc.get("module"):
        base_name = (exc["module"].get("baseName") or "").lower()
        if "qml" in base_name:
            suggestions.extend(
                [
                    "复现时关注方案打开、柜体列表刷新、模型属性绑定是否触发空对象。",
                    "检查崩溃前是否有快速切换项目/页签导致模型对象提前销毁。",
                ]
            )
        if any(x in base_name for x in ["qsvg", "qjpeg", "qwebp", "image"]):
            suggestions.append("核对崩溃前加载的贴图/色卡文件是否损坏或路径失效。")
    if last_task and re.search(r"designer|保存|render|json", last_task.get("body", ""), re.I):
        suggestions.append("优先在同版本客户端复现：打开同一项目并执行崩溃前相同操作。")
    if not suggestions:
        suggestions.append("使用 WinDbg/VS 打开 dump，结合本页模块偏移继续符号分析。")
        suggestions.append("收集同版本、同操作路径的多次崩溃，确认是否稳定复现。")

    if not likely_cause:
        likely_cause.append("目前仅能确认发生了原生崩溃，请结合 dump 模块与崩溃前任务继续定位。")

    # de-dup
    likely_cause = list(dict.fromkeys(likely_cause))
    suggestions = list(dict.fromkeys(suggestions))
    confidence = max(20, min(95, confidence))

    headline = likely_cause[0]
    if cdb and cdb.get("function"):
        headline = f"{cdb.get('module')}!{cdb.get('function')}+{cdb.get('offset')}"
        if last_task and last_task.get("body"):
            headline += f" · 崩溃前：{last_task['body'][:48]}"
    elif exc and exc.get("module"):
        mod_name = exc["module"].get("baseName") or "未知模块"
        headline = f"{exc.get('code')} @ {mod_name}（{exc.get('offsetHex') or '无偏移'}）"
        if last_task and last_task.get("body"):
            headline += f" · 崩溃前：{last_task['body'][:48]}"

    return {
        "confidence": confidence,
        "headline": headline,
        "likelyCauses": likely_cause,
        "findings": findings,
        "suggestions": suggestions,
    }


def analyze_record(record: dict | None = None, dump_file: str | None = None, local_dump: str | None = None) -> dict:
    from symbols import enrich_with_symbols

    record = record or {}
    info = normalize_info(record.get("info"))
    dump_file = dump_file or info.get("dumpFile")
    logs = info.get("log") if isinstance(info.get("log"), list) else []

    meta = parse_dump_meta(dump_file) if dump_file else {}
    log_result = analyze_logs(logs)
    dump_result = None
    dump_error = None
    local_path = None

    try:
        if local_dump and Path(local_dump).exists():
            local_path = Path(local_dump)
            dump_result = analyze_minidump(local_path)
        elif dump_file:
            local_path = download_dump(dump_file)
            dump_result = analyze_minidump(local_path)
    except Exception as err:  # noqa: BLE001
        dump_error = str(err)

    version = record.get("version") or meta.get("versionFromPath") or meta.get("versionFromName")
    symbol_result = enrich_with_symbols(version, local_path)
    diagnosis = build_diagnosis(meta, dump_result, log_result, record or None, symbol_result)

    return {
        "status": 1,
        "msg": "分析完成",
        "data": {
            "meta": meta,
            "dumpUrl": dump_url(dump_file) if dump_file else None,
            "dump": dump_result,
            "dumpError": dump_error,
            "logs": log_result,
            "symbols": symbol_result,
            "diagnosis": diagnosis,
            "record": {
                "id": record.get("id"),
                "uid": record.get("uid"),
                "phone": record.get("phone"),
                "type": record.get("type"),
                "level": record.get("level"),
                "version": record.get("version"),
                "create_time": record.get("create_time"),
            }
            if record
            else None,
        },
    }


if __name__ == "__main__":
    sample = {
        "id": 1,
        "uid": 6197,
        "phone": "19969288601",
        "type": "crash",
        "level": "10",
        "version": "5.0.0.5-8",
        "create_time": "2026-11-05 16:41:33",
        "info": {
            "dumpFile": "crashes/windows/5.0.0.5-8/7a72167537a07b3b215b96c9e2132be0_6197_5.0.0.5-8.dmp",
            "log": [
                "[2026-11-05 16:41:30:720] [TASK] addTask 261009-1007\r\n",
                "[2026-11-05 16:38:01:897] [TASK] switchTask index: 1 name: 订单列表\r\n",
            ],
        },
    }
    print(json.dumps(analyze_record(sample), ensure_ascii=False, indent=2))
