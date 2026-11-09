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

const PAGE_LIMIT = 200;

const state = {
  loading: false,
  activePresetHours: 24,
  rows: [],
  apiTotal: 0,
  fromCache: false,
  charts: {
    trend: null,
    type: null,
    level: null,
    version: null,
  },
};

const els = {
  envSelect: document.getElementById("envSelect"),
  start_time: document.getElementById("start_time"),
  end_time: document.getElementById("end_time"),
  uid: document.getElementById("uid"),
  type: document.getElementById("type"),
  level: document.getElementById("level"),
  version: document.getElementById("version"),
  bucket: document.getElementById("bucket"),
  maxRecords: document.getElementById("maxRecords"),
  queryBtn: document.getElementById("queryBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  clearCacheBtn: document.getElementById("clearCacheBtn"),
  resetBtn: document.getElementById("resetBtn"),
  statusText: document.getElementById("statusText"),
  statSamples: document.getElementById("statSamples"),
  statTotal: document.getElementById("statTotal"),
  statPeak: document.getElementById("statPeak"),
  statTopType: document.getElementById("statTopType"),
  bucketBody: document.getElementById("bucketBody"),
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
let analyzeTimer = null;

function toast(message) {
  showToast(els.toast, message);
}

function setStatus(text, kind = "") {
  els.statusText.textContent = text;
  els.statusText.classList.remove("is-error", "is-loading");
  if (kind) els.statusText.classList.add(kind);
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

function filtersSnapshot() {
  return {
    env: els.envSelect.value,
    uid: els.uid.value.trim(),
    type: els.type.value.trim(),
    level: els.level.value.trim(),
    version: els.version.value.trim(),
    start: formatDateTimeLocal(els.start_time.value),
    end: formatDateTimeLocal(els.end_time.value),
    preset: state.activePresetHours,
    maxRecords: Number(els.maxRecords.value) || 2000,
  };
}

function trendCacheKey(snapshot) {
  return [
    "trend",
    `env=${snapshot.env}`,
    `uid=${snapshot.uid}`,
    `type=${snapshot.type}`,
    `level=${snapshot.level}`,
    `version=${snapshot.version}`,
    snapshot.preset != null ? `preset=${snapshot.preset}h` : `start=${snapshot.start}|end=${snapshot.end}`,
    `max=${snapshot.maxRecords}`,
  ].join("|");
}

function pageCacheKey(snapshot, page) {
  return [
    `env=${snapshot.env}`,
    `page=${page}`,
    `limit=${PAGE_LIMIT}`,
    `uid=${snapshot.uid}`,
    `type=${snapshot.type}`,
    `level=${snapshot.level}`,
    `version=${snapshot.version}`,
    snapshot.preset != null
      ? `preset=${snapshot.preset}h`
      : `start=${snapshot.start}|end=${snapshot.end}`,
  ].join("|");
}

function resolveBucketMode(rows) {
  const mode = els.bucket.value;
  if (mode !== "auto") return mode;
  if (!rows.length) return "hour";
  const times = rows
    .map((row) => new Date(String(row.create_time).replace(/-/g, "/")).getTime())
    .filter((t) => !Number.isNaN(t));
  if (!times.length) return "hour";
  const span = Math.max(...times) - Math.min(...times);
  return span > 48 * 60 * 60 * 1000 ? "day" : "hour";
}

function bucketKey(date, mode) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  if (mode === "day") return `${y}-${m}-${d}`;
  const h = String(date.getHours()).padStart(2, "0");
  return `${y}-${m}-${d} ${h}:00`;
}

function countBy(rows, getter, topN = 8) {
  const map = new Map();
  rows.forEach((row) => {
    const key = String(getter(row) || "未知");
    map.set(key, (map.get(key) || 0) + 1);
  });
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([label, value]) => ({ label, value }));
}

function aggregate(rows) {
  const mode = resolveBucketMode(rows);
  const buckets = new Map();

  rows.forEach((row) => {
    const t = new Date(String(row.create_time || "").replace(/-/g, "/"));
    if (Number.isNaN(t.getTime())) return;
    const key = bucketKey(t, mode);
    if (!buckets.has(key)) {
      buckets.set(key, { key, count: 0, types: new Map() });
    }
    const item = buckets.get(key);
    item.count += 1;
    const type = String(row.type || "未知");
    item.types.set(type, (item.types.get(type) || 0) + 1);
  });

  const timeline = [...buckets.values()]
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .map((item) => {
      const topType = [...item.types.entries()].sort((a, b) => b[1] - a[1])[0];
      return {
        key: item.key,
        count: item.count,
        topType: topType ? `${topType[0]} (${topType[1]})` : "—",
      };
    });

  return {
    mode,
    timeline,
    types: countBy(rows, (row) => row.type),
    levels: countBy(rows, (row) => row.level),
    versions: countBy(rows, (row) => row.version),
  };
}

function destroyChart(name) {
  if (state.charts[name]) {
    state.charts[name].destroy();
    state.charts[name] = null;
  }
}

function palette(n) {
  const base = ["#0f7a6c", "#1d4e89", "#b45309", "#7c3aed", "#0e7490", "#be123c", "#365314", "#334155"];
  return Array.from({ length: n }, (_, i) => base[i % base.length]);
}

function renderCharts(agg) {
  destroyChart("trend");
  destroyChart("type");
  destroyChart("level");
  destroyChart("version");

  const trendCtx = document.getElementById("trendChart");
  state.charts.trend = new Chart(trendCtx, {
    type: "line",
    data: {
      labels: agg.timeline.map((item) => item.key),
      datasets: [
        {
          label: "记录数",
          data: agg.timeline.map((item) => item.count),
          borderColor: "#0f7a6c",
          backgroundColor: "rgba(15, 122, 108, 0.16)",
          fill: true,
          tension: 0.28,
          pointRadius: 3,
          pointHoverRadius: 5,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
        y: { beginAtZero: true, ticks: { precision: 0 } },
      },
    },
  });

  const makeBar = (canvasId, chartKey, items, label) => {
    state.charts[chartKey] = new Chart(document.getElementById(canvasId), {
      type: "bar",
      data: {
        labels: items.map((item) => item.label),
        datasets: [
          {
            label,
            data: items.map((item) => item.value),
            backgroundColor: palette(items.length),
            borderRadius: 8,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { autoSkip: false, maxRotation: 45, minRotation: 0 } },
          y: { beginAtZero: true, ticks: { precision: 0 } },
        },
      },
    });
  };

  makeBar("typeChart", "type", agg.types, "类型");
  makeBar("levelChart", "level", agg.levels, "等级");
  makeBar("versionChart", "version", agg.versions, "版本");
}

function renderStats(rows, apiTotal, agg) {
  els.statSamples.textContent = String(rows.length);
  els.statTotal.textContent = String(apiTotal);

  const peak = [...agg.timeline].sort((a, b) => b.count - a.count)[0];
  els.statPeak.textContent = peak ? `${peak.key} · ${peak.count}` : "—";
  els.statTopType.textContent = agg.types[0]
    ? `${agg.types[0].label} · ${agg.types[0].value}`
    : "—";

  const sampleTotal = rows.length || 1;
  els.bucketBody.innerHTML = agg.timeline.length
    ? agg.timeline
        .map(
          (item) => `
        <tr>
          <td class="mono">${item.key}</td>
          <td class="mono">${item.count}</td>
          <td class="mono">${((item.count / sampleTotal) * 100).toFixed(1)}%</td>
          <td>${item.topType}</td>
        </tr>`,
        )
        .join("")
    : `<tr class="empty-row"><td colspan="4">暂无数据</td></tr>`;
}

async function waitForRequestSlot() {
  const wait = REQUEST_INTERVAL_MS - (Date.now() - lastNetworkAt);
  if (wait > 0) {
    progress.set(
      Math.min(99, Number(els.progressBar?.getAttribute("aria-valuenow") || 0)),
      `请求节流中，${Math.ceil(wait / 1000)} 秒后继续…`,
    );
    await sleep(wait);
  }
}

async function fetchPage(snapshot, page, force) {
  const key = pageCacheKey(snapshot, page);
  if (!force) {
    const cached = await cacheGet(key);
    if (cached?.payload && Date.now() - cached.savedAt <= CACHE_TTL_MS) {
      const parsed = parsePayload(cached.payload);
      return { ...parsed, fromCache: true, savedAt: cached.savedAt };
    }
  }

  await waitForRequestSlot();

  const query = buildRecordQuery({
    page,
    limit: PAGE_LIMIT,
    uid: snapshot.uid,
    type: snapshot.type,
    level: snapshot.level,
    version: snapshot.version,
    startTime: els.start_time.value,
    endTime: els.end_time.value,
  });
  const url = recordApiUrl(snapshot.env, query);
  const result = await requestErrorRecords(url);
  lastNetworkAt = Date.now();
  await cacheSet(key, result.payload);
  return { list: result.list, total: result.total, fromCache: false };
}

async function loadTrendData({ force = false } = {}) {
  if (state.loading) return;

  if (!els.start_time.value || !els.end_time.value) {
    toast("请先设置开始和结束时间");
    return;
  }

  const snapshot = filtersSnapshot();
  const trendKey = trendCacheKey(snapshot);

  state.loading = true;
  els.queryBtn.disabled = true;
  els.refreshBtn.disabled = true;
  progress.show();
  progress.set(2, "准备分析…");

  try {
    if (!force) {
      const cachedTrend = await cacheGet(trendKey);
      if (cachedTrend?.payload?.rows && Date.now() - cachedTrend.savedAt <= CACHE_TTL_MS) {
        state.rows = cachedTrend.payload.rows;
        state.apiTotal = cachedTrend.payload.apiTotal || state.rows.length;
        state.fromCache = true;
        learnTypeLevelOptions(els.type, els.level, state.rows);
        const agg = aggregate(state.rows);
        renderCharts(agg);
        renderStats(state.rows, state.apiTotal, agg);
        progress.set(100, "已命中趋势缓存");
        setStatus(
          `来自本地缓存（${formatCacheAge(cachedTrend.savedAt)}）· 样本 ${state.rows.length} 条 · 粒度 ${agg.mode === "day" ? "按天" : "按小时"}`,
        );
        toast("已命中趋势缓存");
        return;
      }
    }

    const maxRecords = snapshot.maxRecords;
    const plannedPages = Math.max(1, Math.ceil(maxRecords / PAGE_LIMIT));
    const all = [];
    let page = 1;
    let apiTotal = 0;
    let usedCache = false;
    let expectedPages = plannedPages;

    while (all.length < maxRecords) {
      const ratio = Math.min(0.95, (page - 1) / expectedPages);
      progress.set(
        Math.round(ratio * 100),
        `正在拉取第 ${page}/${expectedPages} 页 · 已收集 ${all.length} 条`,
      );
      setStatus(`正在拉取第 ${page} 页…已收集 ${all.length} 条（间隔 ${REQUEST_INTERVAL_MS}ms）`, "is-loading");

      const result = await fetchPage(snapshot, page, force);
      usedCache = usedCache || result.fromCache;
      apiTotal = result.total;

      const byTotal = apiTotal > 0 ? Math.ceil(Math.min(apiTotal, maxRecords) / PAGE_LIMIT) : plannedPages;
      expectedPages = Math.max(1, Math.min(plannedPages, byTotal));

      if (!result.list.length) break;
      all.push(...result.list);

      progress.set(
        Math.min(98, Math.round((Math.min(all.length, maxRecords) / maxRecords) * 100)),
        `${result.fromCache ? "缓存" : "网络"}第 ${page} 页完成 · ${all.length}/${maxRecords}`,
      );

      if (all.length >= result.total || result.list.length < PAGE_LIMIT) break;
      page += 1;
      if (page > expectedPages + 1) break;
    }

    const rows = all.slice(0, maxRecords);
    state.rows = rows;
    state.apiTotal = apiTotal;
    state.fromCache = usedCache && !force;

    progress.set(92, "正在聚合趋势…");
    await cacheSet(trendKey, { rows, apiTotal });

    learnTypeLevelOptions(els.type, els.level, rows);
    const agg = aggregate(rows);
    renderCharts(agg);
    renderStats(rows, apiTotal, agg);
    progress.set(100, "分析完成");

    const truncated = apiTotal > rows.length;
    setStatus(
      `分析完成 · 样本 ${rows.length}${truncated ? ` / 接口总数 ${apiTotal}` : ""} · 粒度 ${
        agg.mode === "day" ? "按天" : "按小时"
      }${state.fromCache ? " · 部分来自缓存" : " · 已写入缓存"}`,
    );
    toast("趋势分析完成");
  } catch (err) {
    setStatus(`分析失败：${err.message}`, "is-error");
    toast("拉取失败");
  } finally {
    state.loading = false;
    els.queryBtn.disabled = false;
    els.refreshBtn.disabled = false;
    setTimeout(() => progress.hide(), 600);
  }
}

function scheduleAnalyze(force = false) {
  clearTimeout(analyzeTimer);
  analyzeTimer = setTimeout(() => {
    loadTrendData({ force });
  }, 350);
}

function resetFilters() {
  els.uid.value = "";
  els.type.value = "";
  els.level.value = "";
  els.version.value = "";
  els.bucket.value = "auto";
  els.maxRecords.value = "2000";
  setTimeRangeHours(24);
  toast("已重置筛选");
}

els.queryBtn.addEventListener("click", () => scheduleAnalyze(false));
els.refreshBtn.addEventListener("click", () => scheduleAnalyze(true));
els.resetBtn.addEventListener("click", resetFilters);
els.clearCacheBtn.addEventListener("click", async () => {
  await cacheClear();
  toast("本地缓存已清除");
  setStatus("缓存已清除，可重新分析");
});

document.querySelectorAll(".range-presets .chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    setTimeRangeHours(Number(chip.dataset.hours));
    scheduleAnalyze(false);
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

["uid", "type", "level", "version", "bucket", "maxRecords", "envSelect"].forEach((id) => {
  els[id].addEventListener("keydown", (event) => {
    if (event.key === "Enter") scheduleAnalyze(false);
  });
});

initTypeLevelSelects(els.type, els.level);
setTimeRangeHours(24);
scheduleAnalyze(false);
