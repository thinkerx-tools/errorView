import {
  CACHE_TTL_MS,
  REQUEST_INTERVAL_MS,
  buildRecordQuery,
  cacheClear,
  cacheGet,
  cacheSet,
  createProgressController,
  formatCacheAge,
  formatDateTimeLocal,
  initTypeLevelSelects,
  learnTypeLevelOptions,
  parsePayload,
  recordApiUrl,
  requestErrorRecords,
  sleep,
  toDateTimeLocalValue,
  toast as showToast,
} from "./shared.js";

const state = {
  page: 1,
  total: 0,
  rows: [],
  filtered: [],
  loading: false,
  activeRecord: null,
  activePresetHours: 24,
};

const els = {
  envSelect: document.getElementById("envSelect"),
  keyword: document.getElementById("keyword"),
  uid: document.getElementById("uid"),
  type: document.getElementById("type"),
  level: document.getElementById("level"),
  version: document.getElementById("version"),
  start_time: document.getElementById("start_time"),
  end_time: document.getElementById("end_time"),
  limit: document.getElementById("limit"),
  queryBtn: document.getElementById("queryBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  clearCacheBtn: document.getElementById("clearCacheBtn"),
  resetBtn: document.getElementById("resetBtn"),
  prevPage: document.getElementById("prevPage"),
  nextPage: document.getElementById("nextPage"),
  pageInfo: document.getElementById("pageInfo"),
  tbody: document.getElementById("tbody"),
  statusText: document.getElementById("statusText"),
  statTotal: document.getElementById("statTotal"),
  statShown: document.getElementById("statShown"),
  statFiltered: document.getElementById("statFiltered"),
  statLatency: document.getElementById("statLatency"),
  detailDialog: document.getElementById("detailDialog"),
  detailTitle: document.getElementById("detailTitle"),
  detailMeta: document.getElementById("detailMeta"),
  detailJson: document.getElementById("detailJson"),
  copyBtn: document.getElementById("copyBtn"),
  analyzeCrashBtn: document.getElementById("analyzeCrashBtn"),
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

let lastNetworkAt = 0;
let fetchTimer = null;

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

function cacheKey() {
  const parts = [
    `env=${els.envSelect.value}`,
    `page=${state.page}`,
    `limit=${els.limit.value}`,
    `uid=${els.uid.value.trim()}`,
    `type=${els.type.value.trim()}`,
    `level=${els.level.value.trim()}`,
    `version=${els.version.value.trim()}`,
  ];

  if (state.activePresetHours != null) {
    parts.push(`preset=${state.activePresetHours}h`);
  } else {
    parts.push(`start=${formatDateTimeLocal(els.start_time.value)}`);
    parts.push(`end=${formatDateTimeLocal(els.end_time.value)}`);
  }

  return parts.join("|");
}

function apiUrl() {
  const query = buildRecordQuery({
    page: state.page,
    limit: els.limit.value,
    uid: els.uid.value,
    type: els.type.value,
    level: els.level.value,
    version: els.version.value,
    startTime: els.start_time.value,
    endTime: els.end_time.value,
  });
  return recordApiUrl(els.envSelect.value, query);
}

function setStatus(text, kind = "") {
  els.statusText.textContent = text;
  els.statusText.classList.remove("is-error", "is-loading");
  if (kind) els.statusText.classList.add(kind);
}

function previewInfo(info) {
  try {
    const text = typeof info === "string" ? info : JSON.stringify(info);
    return text.length > 120 ? `${text.slice(0, 120)}…` : text;
  } catch {
    return String(info ?? "");
  }
}

function levelClass(level) {
  const key = String(level || "").toLowerCase();
  return `badge level-${key || "all"}`;
}

function applyLocalFilter() {
  const q = els.keyword.value.trim().toLowerCase();
  if (!q) {
    state.filtered = [...state.rows];
  } else {
    state.filtered = state.rows.filter((row) => {
      const hay = [
        row.id,
        row.uid,
        row.phone,
        row.type,
        row.level,
        row.version,
        row.create_time,
        previewInfo(row.info),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }
  renderTable();
  updateStats();
}

function updateStats(latencyMs) {
  els.statTotal.textContent = state.total || 0;
  els.statShown.textContent = state.rows.length;
  els.statFiltered.textContent = state.filtered.length;
  if (typeof latencyMs === "number") {
    els.statLatency.textContent = `${latencyMs} ms`;
  }
  const limit = Number(els.limit.value) || 20;
  const maxPage = Math.max(1, Math.ceil((state.total || 0) / limit) || 1);
  els.pageInfo.textContent = `第 ${state.page} / ${maxPage} 页`;
  els.prevPage.disabled = state.page <= 1 || state.loading;
  els.nextPage.disabled = state.page >= maxPage || state.loading;
}

function renderTable() {
  const rows = state.filtered;
  if (!rows.length) {
    els.tbody.innerHTML = `<tr class="empty-row"><td colspan="9">${
      state.loading ? "加载中…" : "没有匹配的异常记录"
    }</td></tr>`;
    return;
  }

  els.tbody.innerHTML = rows
    .map((row, index) => {
      const safeIndex = Number(index);
      return `
      <tr data-index="${safeIndex}">
        <td class="mono">${escapeHtml(row.id ?? "—")}</td>
        <td class="mono">${escapeHtml(row.uid ?? "—")}</td>
        <td class="mono">${escapeHtml(row.phone ?? "—")}</td>
        <td>${escapeHtml(row.type ?? "—")}</td>
        <td><span class="${levelClass(row.level)}">${escapeHtml(row.level ?? "—")}</span></td>
        <td class="mono">${escapeHtml(row.version ?? "—")}</td>
        <td class="mono">${escapeHtml(row.create_time ?? "—")}</td>
        <td><p class="info-preview" title="${escapeAttr(previewInfo(row.info))}">${escapeHtml(previewInfo(row.info))}</p></td>
        <td><button type="button" class="btn btn-ghost btn-sm js-detail" data-index="${safeIndex}">详情</button></td>
      </tr>`;
    })
    .join("");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("\n", " ");
}

function openDetail(row) {
  state.activeRecord = row;
  els.detailTitle.textContent = `#${row.id ?? "—"} · ${row.type ?? "异常"}`;
  els.detailMeta.innerHTML = [
    `UID ${row.uid ?? "—"}`,
    `手机 ${row.phone ?? "—"}`,
    `等级 ${row.level ?? "—"}`,
    `版本 ${row.version ?? "—"}`,
    row.create_time ?? "—",
  ]
    .map((text) => `<span>${escapeHtml(text)}</span>`)
    .join("");
  els.detailJson.textContent = JSON.stringify(row, null, 2);
  const isCrash = String(row.type || "").toLowerCase() === "crash";
  els.analyzeCrashBtn.hidden = !isCrash;
  if (typeof els.detailDialog.showModal === "function") {
    els.detailDialog.showModal();
  }
}

function applyPayload(list, total, latencyMs, statusText, statusKind = "") {
  state.rows = list;
  state.total = total;
  learnTypeLevelOptions(els.type, els.level, list);
  applyLocalFilter();
  updateStats(latencyMs);
  setStatus(statusText, statusKind);
}

async function waitForRequestSlot(onWait) {
  const wait = REQUEST_INTERVAL_MS - (Date.now() - lastNetworkAt);
  if (wait > 0) {
    onWait?.(wait);
    await sleep(wait);
  }
}

async function fetchRecords({ force = false } = {}) {
  if (state.loading) return;

  const hasTimeRange = Boolean(els.start_time.value || els.end_time.value);
  if (!hasTimeRange) {
    const ok = window.confirm(
      "未设置时间范围时，接口可能扫描全量约 270 万条数据，通常需要 40–60 秒。\n\n建议先选「近 24 小时」。是否仍继续全量查询？",
    );
    if (!ok) return;
  }

  const key = cacheKey();
  const url = apiUrl();

  if (!force) {
    const cached = await cacheGet(key);
    if (cached?.payload && Date.now() - cached.savedAt <= CACHE_TTL_MS) {
      const { list, total } = parsePayload(cached.payload);
      progress.set(100, "已命中本地缓存");
      applyPayload(
        list,
        total,
        0,
        `来自本地缓存（${formatCacheAge(cached.savedAt)}）· 共 ${total} 条（本页 ${list.length} 条）`,
      );
      toast("已命中本地缓存");
      setTimeout(() => progress.hide(), 400);
      return;
    }

    if (cached?.payload) {
      const { list, total } = parsePayload(cached.payload);
      applyPayload(
        list,
        total,
        0,
        `缓存已过期，正在后台更新… · 共 ${total} 条（本页 ${list.length} 条）`,
        "is-loading",
      );
    }
  }

  state.loading = true;
  progress.show();
  progress.set(8, "准备请求…");
  if (!state.rows.length) {
    setStatus(
      hasTimeRange ? "正在请求异常记录…" : "全量查询中，可能较慢，请稍候…",
      "is-loading",
    );
    els.tbody.innerHTML = `<tr class="loading-row"><td colspan="9">加载中…</td></tr>`;
  } else if (force) {
    setStatus("强制刷新中…", "is-loading");
  }

  els.queryBtn.disabled = true;
  els.refreshBtn.disabled = true;
  updateStats();

  try {
    await waitForRequestSlot((wait) => {
      progress.set(12, `请求节流中，${Math.ceil(wait / 1000)} 秒后继续…`);
    });
    progress.indeterminate(force ? "强制刷新中…" : "正在请求接口…");
    const { payload, list, total, latency } = await requestErrorRecords(url);
    lastNetworkAt = Date.now();
    progress.set(85, "写入本地缓存…");
    await cacheSet(key, payload);
    progress.set(100, "加载完成");
    applyPayload(
      list,
      total,
      latency,
      `${force ? "已强制刷新" : "加载成功"} · 共 ${total} 条（本页 ${list.length} 条）· 已写入缓存`,
    );
  } catch (err) {
    if (!state.rows.length) {
      state.rows = [];
      state.filtered = [];
      state.total = 0;
      renderTable();
      updateStats();
    }
    setStatus(`加载失败：${err.message}`, "is-error");
    toast(state.rows.length ? "网络更新失败，仍显示缓存" : "请求失败，请检查网络或环境");
  } finally {
    state.loading = false;
    els.queryBtn.disabled = false;
    els.refreshBtn.disabled = false;
    updateStats();
    setTimeout(() => progress.hide(), 500);
  }
}

function scheduleFetch(force = false, resetPage = false) {
  clearTimeout(fetchTimer);
  fetchTimer = setTimeout(() => {
    if (resetPage) state.page = 1;
    fetchRecords({ force });
  }, 350);
}

function resetFilters() {
  els.keyword.value = "";
  els.uid.value = "";
  els.type.value = "";
  els.level.value = "";
  els.version.value = "";
  els.limit.value = "20";
  setTimeRangeHours(24);
  state.page = 1;
  applyLocalFilter();
  toast("已重置为近 24 小时");
}

els.queryBtn.addEventListener("click", () => scheduleFetch(false, true));

els.refreshBtn.addEventListener("click", () => scheduleFetch(true, false));

els.clearCacheBtn.addEventListener("click", async () => {
  await cacheClear();
  toast("本地缓存已清除");
  setStatus("缓存已清除，可重新查询");
});

els.resetBtn.addEventListener("click", resetFilters);

els.keyword.addEventListener("input", () => {
  applyLocalFilter();
});

els.prevPage.addEventListener("click", () => {
  if (state.page <= 1) return;
  state.page -= 1;
  scheduleFetch(false, false);
});

els.nextPage.addEventListener("click", () => {
  state.page += 1;
  scheduleFetch(false, false);
});

els.tbody.addEventListener("click", (event) => {
  const btn = event.target.closest(".js-detail");
  if (!btn) return;
  const index = Number(btn.dataset.index);
  const row = state.filtered[index];
  if (row) openDetail(row);
});

els.copyBtn.addEventListener("click", async () => {
  if (!state.activeRecord) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(state.activeRecord, null, 2));
    toast("已复制到剪贴板");
  } catch {
    toast("复制失败");
  }
});

els.analyzeCrashBtn.addEventListener("click", () => {
  if (!state.activeRecord) return;
  const info =
    typeof state.activeRecord.info === "string"
      ? (() => {
          try {
            return JSON.parse(state.activeRecord.info);
          } catch {
            return {};
          }
        })()
      : state.activeRecord.info || {};
  const params = new URLSearchParams();
  params.set("auto", "1");
  if (info.dumpFile) params.set("dumpFile", info.dumpFile);
  params.set("record", JSON.stringify(state.activeRecord));
  window.open(`./crash.html?${params.toString()}`, "_blank");
});

["uid", "type", "level", "version", "start_time", "end_time", "limit", "envSelect"].forEach(
  (id) => {
    els[id].addEventListener("keydown", (event) => {
      if (event.key === "Enter") scheduleFetch(false, true);
    });
  },
);

document.querySelectorAll(".range-presets .chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    setTimeRangeHours(Number(chip.dataset.hours));
    scheduleFetch(false, true);
  });
});

["start_time", "end_time"].forEach((id) => {
  els[id].addEventListener("change", () => {
    state.activePresetHours = null;
    document.querySelectorAll(".range-presets .chip").forEach((chip) => {
      chip.classList.remove("is-active");
    });
  });
});

initTypeLevelSelects(els.type, els.level);
setTimeRangeHours(24);
scheduleFetch(false, true);
