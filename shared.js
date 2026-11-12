export const ENVIRONMENTS = {
  prod: "https://ggtools.thinkerx.com",
  online: "https://api-online.eggrj.com",
  test: "https://api-test.eggrj.com",
};

const CACHE_DB = "errorView";
const CACHE_STORE = "records";
export const CACHE_TTL_MS = 10 * 60 * 1000;
/** 连续网络请求的最小间隔，降低接口压力 */
export const REQUEST_INTERVAL_MS = 1200;
const CACHE_MAX_ENTRIES = 40;

const OPTION_STORE_KEY = "errorView:filterOptions:v1";
const DEFAULT_TYPES = ["crash", "notFoundTexture", "uploadFile"];
const DEFAULT_LEVELS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "all"];

function readStoredOptions() {
  try {
    const raw = localStorage.getItem(OPTION_STORE_KEY);
    if (!raw) return { types: [...DEFAULT_TYPES], levels: [...DEFAULT_LEVELS] };
    const parsed = JSON.parse(raw);
    return {
      types: uniqueStrings([...(parsed.types || []), ...DEFAULT_TYPES]),
      levels: uniqueStrings([...(parsed.levels || []), ...DEFAULT_LEVELS]),
    };
  } catch {
    return { types: [...DEFAULT_TYPES], levels: [...DEFAULT_LEVELS] };
  }
}

function writeStoredOptions(options) {
  try {
    localStorage.setItem(OPTION_STORE_KEY, JSON.stringify(options));
  } catch {
    // ignore
  }
}

export function uniqueStrings(values) {
  return [...new Set(values.map((v) => String(v ?? "").trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "zh-CN", { numeric: true }),
  );
}

export function fillFilterSelect(selectEl, values, emptyLabel) {
  if (!selectEl) return;
  const current = selectEl.value;
  const options = uniqueStrings(values);
  selectEl.innerHTML = `<option value="">${emptyLabel}</option>${options
    .map((value) => `<option value="${value.replaceAll('"', "&quot;")}">${value}</option>`)
    .join("")}`;
  if (current && options.includes(current)) {
    selectEl.value = current;
  } else {
    selectEl.value = "";
  }
}

export function initTypeLevelSelects(typeSelect, levelSelect) {
  const stored = readStoredOptions();
  fillFilterSelect(typeSelect, stored.types, "全部类型");
  fillFilterSelect(levelSelect, stored.levels, "全部等级");
  return stored;
}

export function learnTypeLevelOptions(typeSelect, levelSelect, rows = []) {
  const stored = readStoredOptions();
  const next = {
    types: uniqueStrings([
      ...stored.types,
      ...rows.map((row) => row?.type),
    ]),
    levels: uniqueStrings([
      ...stored.levels,
      ...rows.map((row) => row?.level),
    ]),
  };
  writeStoredOptions(next);
  fillFilterSelect(typeSelect, next.types, "全部类型");
  fillFilterSelect(levelSelect, next.levels, "全部等级");
  return next;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createProgressController({
  panel,
  label,
  percent,
  fill,
  bar,
}) {
  let visible = false;

  function show() {
    visible = true;
    if (panel) panel.hidden = false;
  }

  function hide() {
    visible = false;
    if (panel) panel.hidden = true;
    if (fill) {
      fill.style.width = "0%";
      fill.classList.remove("is-indeterminate");
    }
    if (percent) percent.textContent = "0%";
    if (bar) bar.setAttribute("aria-valuenow", "0");
  }

  function set(value, text) {
    if (!visible) show();
    const clamped = Math.max(0, Math.min(100, Math.round(value)));
    if (fill) {
      fill.classList.remove("is-indeterminate");
      fill.style.width = `${clamped}%`;
    }
    if (percent) percent.textContent = `${clamped}%`;
    if (label && text) label.textContent = text;
    if (bar) bar.setAttribute("aria-valuenow", String(clamped));
  }

  function indeterminate(text) {
    if (!visible) show();
    if (fill) {
      fill.classList.add("is-indeterminate");
      fill.style.width = "35%";
    }
    if (percent) percent.textContent = "…";
    if (label && text) label.textContent = text;
    if (bar) bar.setAttribute("aria-valuenow", "0");
  }

  return { show, hide, set, indeterminate };
}

export function pad(n) {
  return String(n).padStart(2, "0");
}

export function toDateTimeLocalValue(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:00`;
}

export function formatDateTimeLocal(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value.replace("T", " ");
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatCacheAge(savedAt) {
  const sec = Math.max(0, Math.round((Date.now() - savedAt) / 1000));
  if (sec < 60) return `${sec} 秒前`;
  return `${Math.round(sec / 60)} 分钟前`;
}

export function toast(el, message) {
  if (!el) return;
  el.hidden = false;
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    el.classList.remove("show");
  }, 1800);
}

function openCacheDb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(CACHE_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CACHE_STORE)) {
        const store = db.createObjectStore(CACHE_STORE, { keyPath: "key" });
        store.createIndex("savedAt", "savedAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("open IndexedDB failed"));
  });
}

export async function cacheGet(key) {
  try {
    const db = await openCacheDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE, "readonly");
      const req = tx.objectStore(CACHE_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    try {
      const raw = localStorage.getItem(`errorView:${key}`);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
}

async function trimCache(db) {
  const all = await new Promise((resolve, reject) => {
    const tx = db.transaction(CACHE_STORE, "readonly");
    const req = tx.objectStore(CACHE_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });

  const now = Date.now();
  const expired = all.filter((item) => now - item.savedAt > CACHE_TTL_MS * 3);
  const sorted = [...all].sort((a, b) => a.savedAt - b.savedAt);
  const overflow = sorted.slice(0, Math.max(0, sorted.length - CACHE_MAX_ENTRIES));
  const removeKeys = new Set([...expired, ...overflow].map((item) => item.key));
  if (!removeKeys.size) return;

  await new Promise((resolve, reject) => {
    const tx = db.transaction(CACHE_STORE, "readwrite");
    const store = tx.objectStore(CACHE_STORE);
    removeKeys.forEach((key) => store.delete(key));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function cacheSet(key, payload) {
  const entry = { key, savedAt: Date.now(), payload };
  try {
    const db = await openCacheDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE, "readwrite");
      tx.objectStore(CACHE_STORE).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    await trimCache(db);
  } catch {
    try {
      localStorage.setItem(`errorView:${key}`, JSON.stringify(entry));
    } catch {
      // ignore quota
    }
  }
}

export async function cacheClear() {
  try {
    const db = await openCacheDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE, "readwrite");
      tx.objectStore(CACHE_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // ignore
  }
  Object.keys(localStorage)
    .filter((key) => key.startsWith("errorView:"))
    .forEach((key) => localStorage.removeItem(key));
}

export function parsePayload(payload) {
  const dataNode = payload?.data ?? {};
  const list = Array.isArray(dataNode)
    ? dataNode
    : Array.isArray(dataNode.data)
      ? dataNode.data
      : [];
  const total = Number(dataNode.total ?? list.length) || 0;
  return { list, total };
}

export async function requestErrorRecords(url) {
  const started = performance.now();
  const resp = await fetch(url, { headers: { Accept: "application/json" } });
  const latency = Math.round(performance.now() - started);
  const payload = await resp.json().catch(() => null);

  if (!resp.ok) throw new Error(payload?.msg || `HTTP ${resp.status}`);
  if (payload?.status === 0) throw new Error(payload.msg || "接口返回失败");

  const { list, total } = parsePayload(payload);
  return { payload, list, total, latency };
}

export function buildRecordQuery({
  page,
  limit,
  uid,
  type,
  level,
  version,
  startTime,
  endTime,
}) {
  const params = new URLSearchParams();
  params.set("page", String(page));
  params.set("limit", String(limit));

  const map = {
    uid: String(uid || "").trim(),
    type: String(type || "").trim(),
    level: String(level || "").trim(),
    version: String(version || "").trim(),
    start_time: formatDateTimeLocal(startTime),
    end_time: formatDateTimeLocal(endTime),
  };

  Object.entries(map).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });

  return params;
}

/** 本地 server.py 用同源代理；GitHub Pages 等静态托管直连接口（CORS 已放行 thinkerx-tools.github.io） */
function shouldUseApiProxy() {
  const host = location.hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0";
}

export function isStaticHosting() {
  return !shouldUseApiProxy();
}

export function recordApiUrl(env, query) {
  if (shouldUseApiProxy()) {
    const params = new URLSearchParams(query.toString());
    params.set("env", env || "prod");
    return `/api/proxy/error/record?${params.toString()}`;
  }
  const base = ENVIRONMENTS[env] || ENVIRONMENTS.prod;
  return `${base}/error/record?${query.toString()}`;
}
