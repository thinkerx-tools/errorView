import {
  REQUEST_INTERVAL_MS,
  buildRecordQuery,
  createProgressController,
  recordApiUrl,
  requestErrorRecords,
  sleep,
  toDateTimeLocalValue,
  toast as showToast,
} from "./shared.js";

const state = {
  activePresetHours: 24,
  rows: [],
  selected: null,
  loading: false,
  lastNetworkAt: 0,
  lastAnalysis: null,
  lastPrompt: "",
};

const els = {
  envSelect: document.getElementById("envSelect"),
  start_time: document.getElementById("start_time"),
  end_time: document.getElementById("end_time"),
  uid: document.getElementById("uid"),
  version: document.getElementById("version"),
  dumpFile: document.getElementById("dumpFile"),
  dumpUpload: document.getElementById("dumpUpload"),
  analyzeBtn: document.getElementById("analyzeBtn"),
  analyzeBtnSecondary: document.getElementById("analyzeBtnSecondary"),
  loadListBtn: document.getElementById("loadListBtn"),
  crashList: document.getElementById("crashList"),
  listStatus: document.getElementById("listStatus"),
  diagnosisTitle: document.getElementById("diagnosisTitle"),
  diagnosisSummary: document.getElementById("diagnosisSummary"),
  confidenceWrap: document.getElementById("confidenceWrap"),
  confidenceValue: document.getElementById("confidenceValue"),
  causeList: document.getElementById("causeList"),
  suggestList: document.getElementById("suggestList"),
  dumpPanel: document.getElementById("dumpPanel"),
  symbolPanel: document.getElementById("symbolPanel"),
  findingPanel: document.getElementById("findingPanel"),
  timelinePanel: document.getElementById("timelinePanel"),
  aiDiveBtn: document.getElementById("aiDiveBtn"),
  copyPromptBtn: document.getElementById("copyPromptBtn"),
  aiMeta: document.getElementById("aiMeta"),
  aiSnippetPanel: document.getElementById("aiSnippetPanel"),
  aiResultPanel: document.getElementById("aiResultPanel"),
  toast: document.getElementById("toast"),
  progressPanel: document.getElementById("progressPanel"),
  progressLabel: document.getElementById("progressLabel"),
  progressPercent: document.getElementById("progressPercent"),
  progressFill: document.getElementById("progressFill"),
  progressBar: document.getElementById("progressBar"),
};

const progress = createProgressController({
  panel: els.progressPanel,
  label: els.progressLabel,
  percent: els.progressPercent,
  fill: els.progressFill,
  bar: els.progressBar,
});

function toast(message) {
  showToast(els.toast, message);
}

function setTimeRangeHours(hours) {
  const end = new Date();
  end.setSeconds(0, 0);
  const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
  els.start_time.value = toDateTimeLocalValue(start);
  els.end_time.value = toDateTimeLocalValue(end);
  state.activePresetHours = hours;
  document.querySelectorAll(".range-presets .chip").forEach((chip) => {
    chip.classList.toggle("is-active", Number(chip.dataset.hours) === hours);
  });
}

function normalizeInfo(info) {
  if (!info) return {};
  if (typeof info === "object") return info;
  if (typeof info === "string") {
    try {
      return JSON.parse(info);
    } catch {
      return { raw: info };
    }
  }
  return {};
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function waitSlot() {
  const wait = REQUEST_INTERVAL_MS - (Date.now() - state.lastNetworkAt);
  if (wait > 0) await sleep(wait);
}

async function loadCrashList() {
  if (state.loading) return;
  state.loading = true;
  progress.show();
  progress.set(10, "拉取崩溃列表…");
  els.loadListBtn.disabled = true;
  els.listStatus.textContent = "加载中…";

  try {
    await waitSlot();
    const query = buildRecordQuery({
      page: 1,
      limit: 50,
      uid: els.uid.value,
      type: "crash",
      level: "",
      version: els.version.value,
      startTime: els.start_time.value,
      endTime: els.end_time.value,
    });
    const url = recordApiUrl(els.envSelect.value, query);
    const { list, total, latency } = await requestErrorRecords(url);
    state.lastNetworkAt = Date.now();
    state.rows = list;
    renderList();
    els.listStatus.textContent = `共 ${total} 条，本页 ${list.length} 条 · ${latency} ms`;
    progress.set(100, "列表加载完成");
    if (list[0]) selectRecord(list[0], false);
    toast("崩溃列表已更新");
  } catch (err) {
    els.listStatus.textContent = `加载失败：${err.message}`;
    toast("拉取失败");
  } finally {
    state.loading = false;
    els.loadListBtn.disabled = false;
    setTimeout(() => progress.hide(), 500);
  }
}

function renderList() {
  if (!state.rows.length) {
    els.crashList.innerHTML = `<div class="empty-hint">没有崩溃记录</div>`;
    return;
  }
  els.crashList.innerHTML = state.rows
    .map((row) => {
      const info = normalizeInfo(row.info);
      const dump = info.dumpFile || "无 dump";
      const active = state.selected?.id === row.id ? "is-active" : "";
      return `
        <button type="button" class="crash-item ${active}" data-id="${row.id}">
          <strong>#${escapeHtml(row.id)} · uid ${escapeHtml(row.uid ?? "—")}</strong>
          <span>${escapeHtml(row.create_time ?? "")} · ${escapeHtml(row.version ?? "")}</span>
          <span class="mono dump-path">${escapeHtml(dump)}</span>
        </button>`;
    })
    .join("");
}

function selectRecord(row, autoAnalyze = true) {
  state.selected = row;
  const info = normalizeInfo(row.info);
  if (info.dumpFile) els.dumpFile.value = info.dumpFile;
  renderList();
  if (autoAnalyze) analyzeCurrent();
}

async function analyzeCurrent() {
  if (state.loading) return;
  const file = els.dumpUpload.files?.[0];
  const dumpFile = els.dumpFile.value.trim();
  const record = state.selected;

  if (!file && !dumpFile && !record) {
    toast("请先选择崩溃记录、填写 dump 路径或上传文件");
    return;
  }

  state.loading = true;
  els.analyzeBtn.disabled = true;
  els.analyzeBtnSecondary.disabled = true;
  progress.show();
  progress.indeterminate("正在分析 dump 与日志…");

  try {
    let resp;
    if (file) {
      const form = new FormData();
      form.append("dump", file, file.name);
      if (record) form.append("record", JSON.stringify(record));
      if (dumpFile) form.append("dumpFile", dumpFile);
      resp = await fetch("/api/crash/analyze", { method: "POST", body: form });
    } else {
      resp = await fetch("/api/crash/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          record,
          dumpFile: dumpFile || undefined,
        }),
      });
    }

    const payload = await resp.json().catch(() => null);
    if (!resp.ok || payload?.status === 0) {
      throw new Error(payload?.msg || `HTTP ${resp.status}`);
    }
    renderAnalysis(payload.data);
    progress.set(100, "分析完成");
    toast("崩溃分析完成");
  } catch (err) {
    els.diagnosisTitle.textContent = "分析失败";
    els.diagnosisSummary.textContent = err.message;
    els.aiDiveBtn.disabled = true;
    els.copyPromptBtn.disabled = true;
    toast(err.message.includes("Failed to fetch") ? "请先启动 python server.py" : "分析失败");
  } finally {
    state.loading = false;
    els.analyzeBtn.disabled = false;
    els.analyzeBtnSecondary.disabled = false;
    setTimeout(() => progress.hide(), 600);
  }
}

async function runAiDive() {
  if (!state.lastAnalysis) {
    toast("请先完成机器分析");
    return;
  }
  if (state.loading) return;

  state.loading = true;
  els.aiDiveBtn.disabled = true;
  progress.show();
  progress.indeterminate("AI 深挖中：检索代码并推理…");
  els.aiMeta.textContent = "正在检索 assets/simple 相关代码并请求 AI…";
  els.aiResultPanel.textContent = "分析中…";

  try {
    const resp = await fetch("/api/crash/ai-analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ analysis: state.lastAnalysis }),
    });
    const payload = await resp.json().catch(() => null);
    if (!resp.ok || payload?.status === 0) {
      throw new Error(payload?.msg || `HTTP ${resp.status}`);
    }
    renderAiResult(payload);
    progress.set(100, "AI 深挖完成");
    toast(payload.msg || "AI 深挖完成");
  } catch (err) {
    els.aiMeta.textContent = "AI 深挖失败";
    els.aiResultPanel.textContent = err.message;
    toast("AI 深挖失败");
  } finally {
    state.loading = false;
    els.aiDiveBtn.disabled = !state.lastAnalysis;
    setTimeout(() => progress.hide(), 600);
  }
}

function renderAiResult(payload) {
  const data = payload.data || {};
  const ai = data.ai || {};
  state.lastPrompt = data.prompt || "";
  els.copyPromptBtn.disabled = !state.lastPrompt;

  const cfg = data.config || {};
  els.aiMeta.textContent = [
    payload.msg || "完成",
    ai.provider ? `provider=${ai.provider}` : "",
    ai.model ? `model=${ai.model}` : "",
    cfg.agentBin ? `cli=${cfg.agentBin}` : "",
    cfg.mode ? `mode=${cfg.mode}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const snippets = data.snippets || [];
  if (snippets.length) {
    els.aiSnippetPanel.hidden = false;
    els.aiSnippetPanel.innerHTML = snippets
      .map((item) => {
        const line = item.matches?.[0]?.line ?? "?";
        return `<div class="finding-item level-info"><strong>${escapeHtml(item.file)}:${escapeHtml(line)}</strong><p>${escapeHtml(
          (item.matches || []).map((m) => m.content).slice(0, 2).join(" | "),
        )}</p></div>`;
      })
      .join("");
  } else {
    els.aiSnippetPanel.hidden = true;
    els.aiSnippetPanel.innerHTML = "";
  }

  els.aiResultPanel.textContent = ai.content || "无结果";
}

function renderAnalysis(data) {
  state.lastAnalysis = data;
  state.lastPrompt = "";
  els.aiDiveBtn.disabled = false;
  els.copyPromptBtn.disabled = true;
  els.aiMeta.textContent = "机器分析完成，可点击「交给 AI 深挖」";
  els.aiResultPanel.textContent = "等待 AI 分析…";
  els.aiSnippetPanel.hidden = true;

  const diag = data.diagnosis || {};
  els.diagnosisTitle.textContent = diag.headline || "分析完成";
  els.diagnosisSummary.textContent = data.dumpError
    ? `Dump 解析警告：${data.dumpError}`
    : data.dumpUrl
      ? `Dump：${data.dumpUrl}`
      : "已完成日志与上下文分析";
  els.confidenceWrap.hidden = false;
  els.confidenceValue.textContent = `${diag.confidence ?? "—"}%`;

  els.causeList.innerHTML = (diag.likelyCauses || [])
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");
  els.suggestList.innerHTML = (diag.suggestions || [])
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");

  const exc = data.dump?.exception;
  if (exc) {
    els.dumpPanel.innerHTML = `
      <div><b>异常</b> ${escapeHtml(exc.code)} (${escapeHtml(exc.codeHex)})</div>
      <div><b>地址</b> ${escapeHtml(exc.addressHex)}${exc.accessType ? ` · ${escapeHtml(exc.accessType)}访问` : ""}</div>
      <div><b>故障地址</b> ${escapeHtml(exc.faultAddressHex || "—")}</div>
      <div><b>模块</b> ${escapeHtml(exc.module?.baseName || "未匹配")}</div>
      <div><b>偏移</b> ${escapeHtml(exc.offsetHex || "—")}</div>
      <div><b>线程</b> ${escapeHtml(exc.threadId)}</div>
      <div class="path-line">${escapeHtml(exc.module?.name || "")}</div>
    `;
  } else {
    els.dumpPanel.textContent = data.dumpError || "未能解析 dump 异常流（可仍查看日志结论）";
  }

  const symbols = data.symbols?.symbols || {};
  const cdb = data.symbols?.cdb || {};
  els.symbolPanel.innerHTML = `
    <div><b>版本</b> ${escapeHtml(symbols.version || data.record?.version || "—")}</div>
    <div><b>分支</b> ${escapeHtml(symbols.branch || "—")}</div>
    <div><b>PDB</b> ${symbols.ok ? "已找到并缓存" : escapeHtml(symbols.message || "不可用")}</div>
    <div><b>符号函数</b> ${
      cdb.function
        ? escapeHtml(`${cdb.module}!${cdb.function}+${cdb.offset}`)
        : escapeHtml(cdb.message || "未解析到函数名")
    }</div>
    <div class="path-line">${escapeHtml(symbols.cacheDir || symbols.ref || "")}</div>
  `;

  els.findingPanel.innerHTML = (diag.findings || [])
    .map(
      (item) => `
      <div class="finding-item level-${escapeHtml(item.level)}">
        <strong>${escapeHtml(item.title)}</strong>
        <p>${escapeHtml(item.detail)}</p>
      </div>`,
    )
    .join("") || "暂无";

  const timeline = data.logs?.timeline || [];
  els.timelinePanel.innerHTML = timeline.length
    ? timeline
        .map(
          (item) => `
        <div class="timeline-item">
          <span class="mono">${escapeHtml(item.time || "—")}</span>
          <span class="tag">${escapeHtml(item.tag)}</span>
          <span>${escapeHtml(item.body)}</span>
        </div>`,
        )
        .join("")
    : "暂无日志";
}

els.crashList.addEventListener("click", (event) => {
  const btn = event.target.closest(".crash-item");
  if (!btn) return;
  const row = state.rows.find((item) => String(item.id) === btn.dataset.id);
  if (row) selectRecord(row, true);
});

els.loadListBtn.addEventListener("click", () => loadCrashList());
els.analyzeBtn.addEventListener("click", () => analyzeCurrent());
els.analyzeBtnSecondary.addEventListener("click", () => analyzeCurrent());
els.aiDiveBtn.addEventListener("click", () => runAiDive());
els.copyPromptBtn.addEventListener("click", async () => {
  if (!state.lastPrompt) {
    toast("暂无提示词，请先执行 AI 深挖");
    return;
  }
  try {
    await navigator.clipboard.writeText(state.lastPrompt);
    toast("提示词已复制");
  } catch {
    toast("复制失败");
  }
});

document.querySelectorAll(".range-presets .chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    setTimeRangeHours(Number(chip.dataset.hours));
    loadCrashList();
  });
});

const params = new URLSearchParams(location.search);
setTimeRangeHours(24);

if (params.get("dumpFile")) {
  els.dumpFile.value = params.get("dumpFile");
}
if (params.get("record")) {
  try {
    state.selected = JSON.parse(params.get("record"));
    if (state.selected?.info) {
      const info = normalizeInfo(state.selected.info);
      if (info.dumpFile) els.dumpFile.value = info.dumpFile;
    }
  } catch {
    // ignore
  }
}

if (params.get("auto") === "1" || params.get("dumpFile") || params.get("record")) {
  analyzeCurrent();
} else {
  loadCrashList();
}
