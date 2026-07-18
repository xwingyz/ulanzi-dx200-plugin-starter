import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';

export function createSpeedtestAction(runtime) {
  const {
    clearInstanceTimeout,
    escapeXml,
    exclusiveTasks,
    frameContent,
    frameFor,
    normalizeBooleanString,
    normalizeChoice,
    normalizeTime,
    readPersistedState,
    renderInstance,
    renderThemeBackdrop,
    sanitizeServerList,
    sendParamFromPlugin,
    setInstanceTimeout,
    themeFor,
    toDataUrl,
    writePersistedState,
  } = runtime;

const SPEEDTEST_STATE_VERSION = 1;
const SPEEDTEST_HISTORY_MS = 7 * 24 * 60 * 60 * 1000;
const SPEEDTEST_HISTORY_LIMIT = 672;
// 图表窗口：只画最近 12 次。24 次在 170 宽里每根柱子不到 7 宽，
// 挤成一片噪点；12 次既能看出趋势，单点也还分得清。
const SPEEDTEST_CHART_POINTS = 12;
const SPEEDTEST_RESOURCE = 'network-bandwidth';
const SPEEDTEST_RETRY_MS = 60 * 1000;
const SPEEDTEST_GEO_CACHE_MS = 30 * 24 * 60 * 60 * 1000;
const SPEEDTEST_SERVER_CACHE_MS = 24 * 60 * 60 * 1000;
const SPEEDTEST_DISCOVERY_RETRY_MS = 10 * 60 * 1000;
// 相对时间标签的刷新节拍：一分钟一次，正好是标签的最小刻度。
const SPEEDTEST_CLOCK_MS = 60 * 1000;
const SPEEDTEST_DIRECTORY_URL = 'https://www.speedtest.net/api/js/servers';
const SPEEDTEST_INTERVALS = ['15', '30', '60', 'manual'];
const SPEEDTEST_TIMEOUTS = ['120', '180', '240', '300'];
// any 表示不筛选：候选池直接用全部节点，适合跨境网络或不确定该测哪边时。
const SPEEDTEST_SCOPES = ['any', 'mainland', 'overseas'];
const SPEEDTEST_CHART_TYPES = ['line', 'bar'];

function parseSpeedtestResult(payload, now = Date.now()) {
  const server = payload?.server || {};
  const bandwidthToMbps = (value) => Math.round((Number(value) * 8 / 1_000_000) * 100) / 100;
  return {
    at: Number.isFinite(Date.parse(payload?.timestamp)) ? Date.parse(payload.timestamp) : now,
    ok: true,
    downloadMbps: bandwidthToMbps(payload?.download?.bandwidth || 0),
    uploadMbps: bandwidthToMbps(payload?.upload?.bandwidth || 0),
    pingMs: Number(payload?.ping?.latency || 0),
    jitterMs: Number(payload?.ping?.jitter || 0),
    packetLoss: Number.isFinite(Number(payload?.packetLoss)) ? Number(payload.packetLoss) : null,
    dataBytes: Number(payload?.download?.bytes || 0) + Number(payload?.upload?.bytes || 0),
    server: {
      id: String(server.id || ''),
      host: String(server.host || ''),
      name: String(server.name || ''),
      city: String(server.location || server.city || ''),
      country: String(server.country || ''),
      ip: String(server.ip || ''),
    },
  };
}

function pruneSpeedtestHistory(history, now = Date.now()) {
  const cutoff = now - SPEEDTEST_HISTORY_MS;
  return (Array.isArray(history) ? history : [])
    .filter((entry) => entry && Number.isFinite(Number(entry.at)) && Number(entry.at) >= cutoff)
    .slice(-SPEEDTEST_HISTORY_LIMIT)
    .map((entry) => ({
      at: Number(entry.at),
      ok: entry.ok === true,
      ...(entry.ok === true ? {
        downloadMbps: Number(entry.downloadMbps || 0),
        uploadMbps: Number(entry.uploadMbps || 0),
        pingMs: Number(entry.pingMs || 0),
        jitterMs: Number(entry.jitterMs || 0),
        packetLoss: entry.packetLoss === null ? null : Number(entry.packetLoss || 0),
        dataBytes: Number(entry.dataBytes || 0),
        server: entry.server && typeof entry.server === 'object' ? {
          id: String(entry.server.id || ''), host: String(entry.server.host || ''),
          name: String(entry.server.name || ''), city: String(entry.server.city || ''),
          country: String(entry.server.country || ''), ip: String(entry.server.ip || ''),
        } : undefined,
      } : { errorCode: String(entry.errorCode || 'NET') }),
    }));
}

function serializeSpeedtestState(instance, now = Date.now()) {
  const history = pruneSpeedtestHistory(instance?.history, now);
  const latest = [...history].reverse().find((entry) => entry.ok) || null;
  return {
    version: SPEEDTEST_STATE_VERSION,
    history,
    lastResult: latest,
    lastCompletedAt: Number(instance?.lastCompletedAt || 0),
    nextDueAt: Number(instance?.nextDueAt || 0),
    dailyServerId: String(instance?.dailyServerId || ''),
    dailyServerDate: String(instance?.dailyServerDate || ''),
    serverCache: JSON.parse(sanitizeServerList(instance?.serverCache || [])),
    serverCacheUpdatedAt: Number(instance?.serverCacheUpdatedAt || 0),
    geoCache: instance?.geoCache && typeof instance.geoCache === 'object'
      ? Object.fromEntries(Object.entries(instance.geoCache).filter(([, value]) => now - Number(value?.at || 0) <= SPEEDTEST_GEO_CACHE_MS))
      : {},
  };
}

function hydrateSpeedtestState(payload = {}, now = Date.now()) {
  const clean = serializeSpeedtestState(payload, now);
  return {
    history: clean.history,
    lastResult: clean.lastResult,
    lastCompletedAt: clean.lastCompletedAt,
    nextDueAt: clean.nextDueAt,
    dailyServerId: clean.dailyServerId,
    dailyServerDate: clean.dailyServerDate,
    serverCache: clean.serverCache,
    serverCacheUpdatedAt: clean.serverCacheUpdatedAt,
    geoCache: clean.geoCache,
  };
}

function flushSpeedtestState(instance, now = Date.now()) {
  instance.history = pruneSpeedtestHistory(instance.history, now);
  return writePersistedState(instance.context, serializeSpeedtestState(instance, now));
}

function localDateKey(now = Date.now()) {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseClockMinutes(value, fallback) {
  const normalized = normalizeTime(value, fallback);
  const [hours, minutes] = normalized.split(':').map(Number);
  return hours * 60 + minutes;
}

function isWithinActiveWindow(settings, now = Date.now()) {
  if (String(settings?.activeAllDay) === 'true') {
    return true;
  }
  const start = parseClockMinutes(settings?.activeStart, '08:00');
  const end = parseClockMinutes(settings?.activeEnd, '23:00');
  if (start === end) {
    return true;
  }
  const date = new Date(now);
  const minute = date.getHours() * 60 + date.getMinutes();
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

function nextActiveWindowStart(settings, now = Date.now()) {
  if (isWithinActiveWindow(settings, now)) {
    return now;
  }
  const start = parseClockMinutes(settings?.activeStart, '08:00');
  const date = new Date(now);
  const candidate = new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(start / 60), start % 60).getTime();
  return candidate > now ? candidate : candidate + 24 * 60 * 60 * 1000;
}

function speedtestCandidates(settings, state) {
  let configured = [];
  try {
    configured = JSON.parse(sanitizeServerList(settings?.candidateServers || '[]'));
  } catch {}
  const source = configured.length ? configured : (Array.isArray(state?.serverCache) ? state.serverCache : []);
  const scope = settings?.scope || 'mainland';
  if (scope === 'any') {
    return source.slice();
  }
  return source.filter((server) => {
    const countryCode = String(server.countryCode || '').toUpperCase();
    const country = String(server.country || '').toLowerCase();
    const isMainland = countryCode === 'CN' || /^(china|中国|中国大陆|people'?s republic of china)$/i.test(country);
    return scope === 'mainland' ? isMainland : !isMainland;
  });
}

function mapSpeedtestDirectoryServers(items) {
  return JSON.parse(sanitizeServerList((Array.isArray(items) ? items : []).map((server) => ({
    id: server?.id,
    host: server?.host,
    name: server?.sponsor || server?.name,
    city: server?.name || server?.location,
    country: server?.country,
    countryCode: server?.cc || server?.countryCode,
    ip: server?.ip,
    locationSource: 'official',
  }))));
}

function needsSpeedtestDiscovery(settings, state, now = Date.now()) {
  if (!Array.isArray(state?.serverCache) || !state.serverCache.length) return true;
  const hasLegacyGeo = state.serverCache.some((server) =>
    server?.locationSource === 'geoip' && server?.ip && !server?.ipCountryCode);
  if (hasLegacyGeo) return true;
  if (now - Number(state.serverCacheUpdatedAt || 0) > SPEEDTEST_SERVER_CACHE_MS) return true;
  return speedtestCandidates(settings, { serverCache: state.serverCache }).length === 0;
}

function mergeSpeedtestGeo(server, ip, geo = {}) {
  return {
    ...server,
    ip: String(ip || server.ip || ''),
    ipCity: String(geo.city || ''),
    ipCountry: String(geo.country || ''),
    ipCountryCode: String(geo.countryCode || '').toUpperCase(),
    locationSource: 'geoip',
  };
}

// 选择模式由勾选数量决定，没有单独的开关：
// 勾 1 个 = 固定该节点；勾 2 个及以上 = 在勾选的节点里每日随机；
// 一个都不勾 = 在当前区域的全部节点里每日随机（pool 由 speedtestCandidates 兜底）。
function chooseSpeedtestServer(state, servers, now = Date.now(), random = Math.random) {
  const pool = Array.isArray(servers) ? servers : [];
  if (!pool.length) {
    return null;
  }
  // 只有一个候选时就是固定节点，不写 sticky 状态，换勾选后立刻生效。
  if (pool.length === 1) {
    return pool[0];
  }
  const dateKey = localDateKey(now);
  const sticky = state?.dailyServerDate === dateKey &&
    pool.find((server) => String(server.id) === String(state.dailyServerId));
  if (sticky) {
    return sticky;
  }
  const index = Math.min(pool.length - 1, Math.max(0, Math.floor(Number(random()) * pool.length)));
  const selected = pool[index];
  state.dailyServerId = String(selected.id);
  state.dailyServerDate = dateKey;
  return selected;
}

function resolveSpeedtestCli(settings = {}) {
  const candidates = [settings.cliPath, '/opt/homebrew/bin/speedtest', '/usr/local/bin/speedtest'];
  for (const directory of String(process.env.PATH || '').split(path.delimiter)) {
    if (directory) candidates.push(path.join(directory, 'speedtest'));
  }
  return candidates.find((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }) || '';
}

function classifySpeedtestError(error) {
  const message = String(error?.stderr || error?.message || error || '');
  if (error?.code === 'ENOENT' || /not found|no such file/i.test(message)) return 'CLI';
  if (/license|gdpr|accept/i.test(message)) return 'LICENSE';
  if (/server|node|invalid.*id/i.test(message)) return 'NODE';
  if (error?.speedtestTimedOut || /timeout|timed out/i.test(message)) return 'TIMEOUT';
  return 'NET';
}

function runSpeedtestCli(instance, args, signal) {
  const executable = resolveSpeedtestCli(instance.settings);
  if (!executable) {
    return Promise.reject(Object.assign(new Error('Official Ookla Speedtest CLI is not installed'), { code: 'ENOENT' }));
  }
  const localController = new AbortController();
  let timedOut = false;
  const abort = () => localController.abort();
  signal?.addEventListener('abort', abort, { once: true });
  return new Promise((resolve, reject) => {
    const timeoutMs = Number(instance.settings.timeoutSec || 180) * 1000;
    setInstanceTimeout(instance, 'speedtestHardTimeout', () => {
      timedOut = true;
      abort();
    }, timeoutMs);
    execFile(executable, args, {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
      signal: localController.signal,
      env: { ...process.env, LANG: 'en_US.UTF-8' },
    }, (error, stdout, stderr) => {
      clearInstanceTimeout(instance, 'speedtestHardTimeout');
      signal?.removeEventListener('abort', abort);
      if (error) {
        error.stderr = stderr;
        error.speedtestTimedOut = timedOut;
        reject(error);
        return;
      }
      resolve(String(stdout || '').trim());
    });
  });
}

function fetchJson(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { Accept: 'application/json', 'User-Agent': 'LexUtility/0.1' } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if ((response.statusCode || 500) >= 400) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('HTTP timeout')));
    request.on('error', reject);
  });
}

async function fetchSpeedtestDirectoryServers() {
  const query = (search = '') => {
    const url = new URL(SPEEDTEST_DIRECTORY_URL);
    url.searchParams.set('engine', 'js');
    url.searchParams.set('https_functional', 'true');
    url.searchParams.set('limit', '30');
    if (search) url.searchParams.set('search', search);
    return fetchJson(url, 12_000);
  };
  const results = await Promise.allSettled([query('China'), query()]);
  const merged = results.flatMap((result) => result.status === 'fulfilled'
    ? mapSpeedtestDirectoryServers(result.value)
    : []);
  const byId = new Map(merged.map((server) => [server.id, server]));
  if (!byId.size) {
    throw results.find((result) => result.status === 'rejected')?.reason ||
      new Error('Speedtest directory returned no nodes');
  }
  return [...byId.values()];
}

async function enrichSpeedtestServer(instance, server, now = Date.now()) {
  if (String(instance.settings.geoIpEnabled) !== 'true') return server;
  try {
    const host = String(server.host || '').replace(/^\[|\](:\d+)?$/g, '').split(':')[0];
    const ip = server.ip || (host ? (await lookup(host)).address : '');
    if (!ip) return server;
    instance.geoCache ||= {};
    let geo = instance.geoCache[ip];
    if (!geo || now - Number(geo.at || 0) > SPEEDTEST_GEO_CACHE_MS) {
      const payload = await fetchJson(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,country,country_code,region,city`);
      if (!payload?.success) return { ...server, ip };
      geo = {
        at: now,
        country: String(payload.country || ''),
        countryCode: String(payload.country_code || '').toUpperCase(),
        city: String(payload.city || payload.region || ''),
      };
      instance.geoCache[ip] = geo;
    }
    return mergeSpeedtestGeo(server, ip, geo);
  } catch {
    return server;
  }
}

async function executeSpeedtest(instance, server, signal) {
  const args = ['--format=json', '--progress=no'];
  if (server?.id) args.push(`--server-id=${server.id}`);
  const stdout = await runSpeedtestCli(instance, args, signal);
  return parseSpeedtestResult(JSON.parse(stdout));
}

function parseSpeedtestServerList(stdout) {
  try {
    const payload = JSON.parse(stdout);
    const items = Array.isArray(payload) ? payload : payload?.servers || payload?.server || [];
    return JSON.parse(sanitizeServerList(Array.isArray(items) ? items : [items]));
  } catch {
    const rows = String(stdout || '').split('\n').flatMap((line) => {
      const match = /^\s*(\d+)\)\s+(.+?)\s+\(([^,]+),\s*([^\)]+)\)/.exec(line);
      return match ? [{ id: match[1], name: match[2], city: match[3], country: match[4] }] : [];
    });
    return JSON.parse(sanitizeServerList(rows));
  }
}

async function refreshSpeedtestServers(instance) {
  return exclusiveTasks.run(instance, SPEEDTEST_RESOURCE, async (signal) => {
    try {
      instance.discoveryAttemptedAt = Date.now();
      let discovered;
      try {
        discovered = await fetchSpeedtestDirectoryServers();
      } catch {
        const stdout = await runSpeedtestCli(instance, ['--servers', '--format=json'], signal);
        discovered = parseSpeedtestServerList(stdout);
      }
      if (signal.aborted) return { cancelled: true };
      const activeIds = new Set(speedtestCandidates(instance.settings, { serverCache: discovered })
        .slice(0, 12)
        .map((server) => server.id));
      instance.serverCache = await Promise.all(discovered.map((server) => activeIds.has(server.id)
        ? enrichSpeedtestServer(instance, server)
        : server));
      instance.serverCacheUpdatedAt = Date.now();
      instance.phase = 'idle';
      instance.errorCode = '';
      flushSpeedtestState(instance);
      sendSpeedtestRuntime(instance);
      renderInstance(instance);
      return instance.serverCache;
    } catch (error) {
      if (signal.aborted) return { cancelled: true };
      instance.phase = 'error';
      instance.errorCode = classifySpeedtestError(error);
      sendSpeedtestRuntime(instance);
      renderInstance(instance);
      return { errorCode: instance.errorCode };
    }
  }, {
    onQueued: (position) => {
      instance.phase = 'queued';
      instance.queuePosition = position;
      renderInstance(instance);
    },
    onStart: () => {
      instance.phase = 'discovering';
      instance.queuePosition = 0;
      instance.errorCode = '';
      renderInstance(instance);
    },
    onCancel: () => {
      instance.phase = 'idle';
      instance.queuePosition = -1;
      renderInstance(instance);
    },
    onFinish: () => {
      if (['queued', 'discovering'].includes(instance.phase)) instance.phase = 'idle';
      instance.queuePosition = -1;
      renderInstance(instance);
    },
  });
}

function ensureSpeedtestDiscovery(instance, options = {}) {
  const now = Date.now();
  const recentlyAttempted = now - Number(instance.discoveryAttemptedAt || 0) < SPEEDTEST_DISCOVERY_RETRY_MS;
  if (!options.force && (!needsSpeedtestDiscovery(instance.settings, instance, now) || recentlyAttempted)) {
    return undefined;
  }
  return refreshSpeedtestServers(instance);
}

function speedtestIntervalMs(settings) {
  return settings.intervalMin === 'manual' ? 0 : Number(settings.intervalMin || 15) * 60 * 1000;
}

function scheduleNextSpeedtest(instance, options = {}) {
  clearInstanceTimeout(instance, 'speedtestSchedule');
  const intervalMs = speedtestIntervalMs(instance.settings);
  if (!intervalMs) {
    instance.nextDueAt = 0;
    if (options.settingsChanged) flushSpeedtestState(instance);
    return;
  }
  const now = Date.now();
  if (options.settingsChanged || !Number(instance.nextDueAt)) {
    instance.nextDueAt = now + intervalMs;
  }
  const dueAt = Math.max(now, Number(instance.nextDueAt));
  setInstanceTimeout(instance, 'speedtestSchedule', () => {
    const firedAt = Date.now();
    if (firedAt - dueAt > 5000) {
      instance.nextDueAt = firedAt + 30_000 + Math.floor(Math.random() * 60_001);
      flushSpeedtestState(instance);
      scheduleNextSpeedtest(instance);
      return;
    }
    if (!isWithinActiveWindow(instance.settings)) {
      instance.nextDueAt = nextActiveWindowStart(instance.settings);
      flushSpeedtestState(instance);
      scheduleNextSpeedtest(instance);
      return;
    }
    requestSpeedtest(instance, { source: 'schedule' });
  }, Math.max(0, dueAt - now));
  flushSpeedtestState(instance);
}

// 「12m ago」只有在会自己走的时候才是真的。两次测速之间默认隔 30 分钟，
// 期间没有任何事件触发重绘，标签会一直停在测完那一刻的值。
// 这里每分钟重绘一次；实例销毁时框架会统一清掉它的所有定时器。
function scheduleSpeedtestClock(instance) {
  setInstanceTimeout(instance, 'speedtestClock', () => {
    renderInstance(instance);
    scheduleSpeedtestClock(instance);
  }, SPEEDTEST_CLOCK_MS);
}

function initializeSpeedtestInstance(instance) {
  if (instance.speedtestInitialized) {
    sendSpeedtestRuntime(instance);
    return ensureSpeedtestDiscovery(instance);
  }
  instance.speedtestInitialized = true;
  const intervalMs = speedtestIntervalMs(instance.settings);
  const now = Date.now();
  if (intervalMs && (!instance.nextDueAt || instance.nextDueAt <= now)) {
    instance.nextDueAt = now + 30_000 + Math.floor(Math.random() * 60_001);
  }
  if (intervalMs) scheduleNextSpeedtest(instance);
  scheduleSpeedtestClock(instance);
  sendSpeedtestRuntime(instance);
  return ensureSpeedtestDiscovery(instance);
}

function recordSpeedtestFailure(instance, errorCode) {
  const at = Date.now();
  instance.history = pruneSpeedtestHistory([...(instance.history || []), { at, ok: false, errorCode }], at);
  instance.lastCompletedAt = at;
  instance.phase = 'error';
  instance.errorCode = errorCode;
}

function requestSpeedtest(instance, options = {}) {
  if (options.source !== 'retry') clearInstanceTimeout(instance, 'speedtestRetry');
  const selected = options.server || chooseSpeedtestServer(
    instance,
    speedtestCandidates(instance.settings, instance),
  );
  const promise = exclusiveTasks.run(instance, SPEEDTEST_RESOURCE, async (signal) => {
    try {
      const result = await executeSpeedtest(instance, selected, signal);
      if (signal.aborted) return { cancelled: true };
      instance.history = pruneSpeedtestHistory([...(instance.history || []), result], result.at);
      instance.lastResult = result;
      instance.lastCompletedAt = result.at;
      instance.phase = 'idle';
      instance.errorCode = '';
      instance.retryCount = 0;
      instance.nextDueAt = speedtestIntervalMs(instance.settings) ? Date.now() + speedtestIntervalMs(instance.settings) : 0;
      flushSpeedtestState(instance);
      scheduleNextSpeedtest(instance);
      sendSpeedtestRuntime(instance);
      renderInstance(instance);
      return result;
    } catch (error) {
      if (signal.aborted) return { cancelled: true };
      const errorCode = classifySpeedtestError(error);
      recordSpeedtestFailure(instance, errorCode);
      flushSpeedtestState(instance);
      sendSpeedtestRuntime(instance);
      renderInstance(instance);
      if (!['CLI', 'LICENSE'].includes(errorCode) && instance.retryCount < 1) {
        instance.retryCount += 1;
        // 重试前丢掉当天的粘性节点，换一个再试；只勾了一个节点时
        // 候选池本来就只有它，清空 sticky 不会改变选择。
        instance.dailyServerId = '';
        instance.dailyServerDate = '';
        setInstanceTimeout(instance, 'speedtestRetry', () => requestSpeedtest(instance, { source: 'retry' }), SPEEDTEST_RETRY_MS);
      } else {
        instance.retryCount = 0;
        instance.nextDueAt = speedtestIntervalMs(instance.settings) ? Date.now() + speedtestIntervalMs(instance.settings) : 0;
        scheduleNextSpeedtest(instance);
      }
      return { errorCode };
    }
  }, {
    onQueued: (position) => {
      instance.phase = 'queued';
      instance.queuePosition = position;
      renderInstance(instance);
    },
    onStart: () => {
      instance.phase = 'running';
      instance.queuePosition = 0;
      instance.errorCode = '';
      renderInstance(instance);
    },
    onCancel: () => {
      instance.phase = 'idle';
      instance.queuePosition = -1;
      clearInstanceTimeout(instance, 'speedtestHardTimeout');
      renderInstance(instance);
    },
    onFinish: () => {
      if (['queued', 'running'].includes(instance.phase)) instance.phase = 'idle';
      instance.queuePosition = -1;
      renderInstance(instance);
    },
  });
  return promise;
}

function handleSpeedtestParam(instance, param = {}) {
  // 重新获取走 force：用户点了按钮就绕过退避，立刻重新拉一次。
  if (param.refreshServers === 'true') return ensureSpeedtestDiscovery(instance, { force: true });
  // 面板发现节点清单为空时会发这个控制键。不 force，交给
  // needsSpeedtestDiscovery + 退避判断，避免面板反复开合时打爆目录服务。
  if (param.ensureServers === 'true') return ensureSpeedtestDiscovery(instance);
  if (param.testSelected === 'true') return requestSpeedtest(instance, { source: 'inspector' });
  if (param.clearSpeedtestHistory === 'true') {
    instance.history = [];
    instance.lastResult = null;
    instance.errorCode = '';
    flushSpeedtestState(instance);
    sendSpeedtestRuntime(instance);
    return;
  }
}

function sendSpeedtestRuntime(instance) {
  if (!instance?.context) return;
  const payload = {
    phase: instance.phase,
    errorCode: instance.errorCode,
    queuePosition: instance.queuePosition,
    lastResult: instance.lastResult,
    history: (instance.history || []).slice(-SPEEDTEST_CHART_POINTS),
    servers: instance.serverCache || [],
    serverCacheUpdatedAt: instance.serverCacheUpdatedAt || 0,
    cliFound: Boolean(resolveSpeedtestCli(instance.settings)),
    nextDueAt: instance.nextDueAt || 0,
  };
  sendParamFromPlugin({ ...instance.settings, speedtestRuntime: JSON.stringify(payload) }, instance.context);
}

const SPEEDTEST_CHART_LEFT = 44;
const SPEEDTEST_CHART_WIDTH = 170;
// 数值右对齐的基线，右边留给 Mbps 单位列（16 号 Arial 粗体约 39 宽，
// 右对齐到 214 即占 175..214），中间空出一个字距免得数字和单位黏在一起。
const SPEEDTEST_VALUE_RIGHT = 162;

// 图表始终铺满整幅宽度：x 轴按实际样本数动态分配，采集 3 次和采集 12 次
// 都占满 SPEEDTEST_CHART_WIDTH，只是疏密不同——固定 24 格会让早期只画左边一小截。
// 数值叠在图表之上，所以这里画的是低透明度的背景层，不是前景读数。
function speedChart(series, field, top, height, color, type) {
  const points = series.slice(-SPEEDTEST_CHART_POINTS).filter((entry) => entry.ok);
  if (!points.length) {
    return '';
  }
  const max = Math.max(1, ...points.map((entry) => Number(entry[field] || 0)));
  const left = SPEEDTEST_CHART_LEFT;
  const width = SPEEDTEST_CHART_WIDTH;
  const yFor = (entry) => top + height - Number(entry[field] || 0) / max * height;

  if (type === 'bar') {
    const slot = width / points.length;
    const barWidth = Math.max(1.5, slot - Math.min(2, slot * 0.22));
    // 样本少的时候柱子很宽，同样的透明度会糊掉压在上面的数字，按宽度回调。
    const opacity = slot > 30 ? 0.2 : slot > 14 ? 0.26 : 0.34;
    return points.map((entry, index) => {
      const y = yFor(entry);
      return `<rect x="${(left + index * slot).toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(1, top + height - y).toFixed(1)}" rx="1" fill="${color}" opacity="${opacity}"/>`;
    }).join('');
  }

  // 只有一个样本时没有线段可画，落一个居中的点表示当前水位。
  if (points.length === 1) {
    return `<circle cx="${(left + width / 2).toFixed(1)}" cy="${yFor(points[0]).toFixed(1)}" r="3.5" fill="${color}" opacity="0.5"/>`;
  }
  const step = width / (points.length - 1);
  const coords = points.map((entry, index) => `${(left + index * step).toFixed(1)},${yFor(entry).toFixed(1)}`);
  // 折线下方补一层面积，背景感更强，也更容易看出变化趋势。
  const area = `${left},${(top + height).toFixed(1)} ${coords.join(' ')} ${(left + width).toFixed(1)},${(top + height).toFixed(1)}`;
  return `<polygon points="${area}" fill="${color}" opacity="0.16"/>`
    + `<polyline points="${coords.join(' ')}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.55"/>`;
}

// 方向箭头画成描边路径而不是 ↓↑ 文字：这两个字形通常来自 Arial 之外的
// 回退字体，font-weight 对它们不一定生效（不同渲染器行为还不一样），
// 想"加粗一点"就只能靠合成粗体碰运气。路径的 stroke-width 是确定的。
function directionArrow(direction, baseline, theme) {
  const cx = 51;
  const bottom = baseline + 1;
  const top = bottom - 19;
  const head = direction === 'down'
    ? `M ${cx - 6} ${bottom - 7} L ${cx} ${bottom} L ${cx + 6} ${bottom - 7}`
    : `M ${cx - 6} ${top + 7} L ${cx} ${top} L ${cx + 6} ${top + 7}`;
  return `<path d="M ${cx} ${top} V ${bottom} ${head}" fill="none" stroke="${theme.muted}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>`;
}

// 一条速度带：图表垫底，方向箭头和数值压在上面。数值占满整条带的高度，
// 所以字号能比原来的上下分栏大不少（29 → 46）。
// 数值右对齐到 SPEEDTEST_VALUE_RIGHT，单位固定占右边一列：两行的个位数
// 对齐在同一条竖线上，扫一眼就能比大小，位数变化也不会让数字左右跳。
// 千兆宽带会出现四位数，字号按位数收窄，避免顶到单位列。
function speedBand(value, arrow, top, theme, chart) {
  const baseline = top + 50;
  const text = value === null ? '—' : String(value);
  const fontSize = text.length >= 5 ? 32 : text.length === 4 ? 38 : 46;
  return `
    ${chart}
    ${directionArrow(arrow, baseline, theme)}
    <text x="${SPEEDTEST_VALUE_RIGHT}" y="${baseline}" text-anchor="end" fill="${theme.text}" font-size="${fontSize}" font-weight="800" font-family="Arial, sans-serif">${escapeXml(text)}</text>
    <text x="214" y="${baseline}" text-anchor="end" fill="${theme.muted}" font-size="16" font-weight="700" font-family="Arial, sans-serif">Mbps</text>
  `;
}

// 上次测速距今多久。这个键大部分时间显示的是「历史数据」，
// 没有时间戳就无法判断屏幕上的数字是刚测的还是昨天的。
// 用 `>` 前缀而不是 ` ago` 后缀：短 3 个字符，标题行才放得下 MAINLAND
// 这样的全称；而且刻度是向下取整的，`>15m` 字面意思正好就是它的真实含义。
// 天数封顶 99，免得长期没测出现 5 位数字把标题挤掉。
function relativeAge(at, now) {
  const minutes = Math.floor(Math.max(0, now - Number(at || 0)) / 60000);
  if (minutes < 1) {
    return 'now';
  }
  if (minutes < 60) {
    return `>${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `>${hours}h` : `>${Math.min(99, Math.floor(hours / 24))}d`;
}

// 状态标签带底色块。SVG 里量不到文字宽度，按 Arial 粗体大写的经验值
// （约 0.66em）加字距估算，两侧留 11 的内边距；估宽只用于画底块，
// 文字仍按实际宽度渲染，估偏一点也只是底块松紧，不会截断。
function statusPill(label, theme, isError) {
  const fontSize = 20;
  const spacing = 2;
  const width = label.length * (fontSize * 0.66 + spacing) + 22;
  // 错误用 latency action 同一支红（#ef4444）：theme.low 在多数主题里
  // 和 accent 是同色系，错误块和"正在测速"块看起来会是同一个东西。
  return `
    <rect x="44" y="38" width="${width.toFixed(1)}" height="30" rx="9" fill="${isError ? '#ef4444' : theme.accent}"/>
    <text x="55" y="60" fill="${isError ? '#ffffff' : theme.canvas}" font-size="${fontSize}" font-weight="800" letter-spacing="${spacing}" font-family="Arial, sans-serif">${escapeXml(label)}</text>
  `;
}

function renderSpeedtestIcon(instance, now = Date.now()) {
  const theme = themeFor(instance.settings);
  const frame = frameFor(instance.settings);
  const background = renderThemeBackdrop(theme, theme.accent, frame);
  const last = instance.lastResult;
  const phaseLabel = instance.phase === 'queued' ? `QUEUE ${Math.max(1, instance.queuePosition || 1)}`
    : instance.phase === 'running' ? 'TESTING'
      : instance.phase === 'discovering' ? 'NODES'
        : instance.phase === 'error' ? (instance.errorCode || 'ERROR') : '';
  const scope = { any: 'GLOBAL', overseas: 'OVERSEAS' }[instance.settings.scope] || 'MAINLAND';
  const history = instance.history || [];
  // 标题行两个槽位：左边是区域或当前状态，右边是上次测速距今多久。
  // 状态直接顶掉区域而不是挤在右边——TESTING / QUEUE 1 这种长度会和
  // MAINLAND 撞在一起，而正在测速时状态本来就比区域更该被看到；
  // 出状态时右边的时间也一起让位，否则色块会盖住它。
  // 也不用居中浮层：浮层正好压住下行速度，那是这个键存在的意义。
  const dim = phaseLabel ? 0.5 : 1;
  const age = last && !phaseLabel ? relativeAge(instance.lastCompletedAt || last.at, now) : '';
  const headline = phaseLabel ? statusPill(phaseLabel, theme, instance.phase === 'error') : `
    <text x="44" y="60" fill="${theme.muted}" font-size="18" font-weight="800" letter-spacing="1.5" font-family="Arial, sans-serif">${scope}</text>
    ${age ? `<text x="214" y="60" text-anchor="end" fill="${theme.muted}" font-size="16" font-weight="700" font-family="Arial, sans-serif">${escapeXml(age)}</text>` : ''}
  `;
  return toDataUrl(`
    <svg width="392" height="392" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
      ${background.outer}
      ${frameContent(frame, `
        ${headline}
        <g opacity="${dim}">
          ${speedBand(last ? Math.round(last.downloadMbps) : null, 'down', 70, theme, speedChart(history, 'downloadMbps', 70, 68, theme.accent, instance.settings.chartType))}
          ${speedBand(last ? Math.round(last.uploadMbps) : null, 'up', 146, theme, speedChart(history, 'uploadMbps', 146, 68, theme.muted, instance.settings.chartType))}
        </g>
      `)}
    </svg>
  `);
}


const config = {
    defaults: {
      title: 'Network Speed',
      subtitle: 'Mainland',
      theme: 'signal',
      frameSize: 'optimal',
      showFrame: 'true',
      scope: 'mainland',
      intervalMin: '30',
      activeAllDay: 'false',
      activeStart: '08:00',
      activeEnd: '23:00',
      timeoutSec: '180',
      candidateServers: '[]',
      chartType: 'line',
      geoIpEnabled: 'true',
      cliPath: '',
    },
    normalizeSettings: (settings, defaults) => ({
      scope: normalizeChoice(settings.scope, defaults.scope, SPEEDTEST_SCOPES),
      intervalMin: normalizeChoice(String(settings.intervalMin ?? defaults.intervalMin), defaults.intervalMin, SPEEDTEST_INTERVALS),
      activeAllDay: normalizeBooleanString(settings.activeAllDay, defaults.activeAllDay),
      activeStart: normalizeTime(settings.activeStart, defaults.activeStart),
      activeEnd: normalizeTime(settings.activeEnd, defaults.activeEnd),
      timeoutSec: normalizeChoice(String(settings.timeoutSec ?? defaults.timeoutSec), defaults.timeoutSec, SPEEDTEST_TIMEOUTS),
      candidateServers: sanitizeServerList(settings.candidateServers ?? defaults.candidateServers),
      chartType: normalizeChoice(settings.chartType, defaults.chartType, SPEEDTEST_CHART_TYPES),
      geoIpEnabled: normalizeBooleanString(settings.geoIpEnabled, defaults.geoIpEnabled),
      cliPath: String(settings.cliPath || '').trim().slice(0, 300),
    }),
    createState: (instance) => ({
      phase: 'idle',
      queuePosition: -1,
      errorCode: '',
      retryCount: 0,
      ...hydrateSpeedtestState(readPersistedState(instance.context)),
    }),
    onRun: (instance) => {
      if (['queued', 'running', 'discovering'].includes(instance.phase)) {
        exclusiveTasks.cancel(instance, SPEEDTEST_RESOURCE);
        return Promise.resolve();
      }
      return requestSpeedtest(instance, { source: 'manual' });
    },
    onReady: (instance) => initializeSpeedtestInstance(instance),
    onSettingsChanged: (instance, previousSettings) => {
      const targetChanged = previousSettings.scope !== instance.settings.scope ||
        previousSettings.candidateServers !== instance.settings.candidateServers;
      if (targetChanged) {
        instance.dailyServerId = '';
        instance.dailyServerDate = '';
        ensureSpeedtestDiscovery(instance);
      }
      const scheduleChanged = ['intervalMin', 'activeAllDay', 'activeStart', 'activeEnd']
        .some((key) => previousSettings[key] !== instance.settings[key]);
      if (scheduleChanged) scheduleNextSpeedtest(instance, { settingsChanged: true });
      sendSpeedtestRuntime(instance);
    },
    onParamFromPlugin: (instance, param) => handleSpeedtestParam(instance, param),
    onDispose: (instance) => flushSpeedtestState(instance),
    render: (instance) => renderSpeedtestIcon(instance),
  };

  return {
    key: 'speedtest',
    config,
    testing: {
      chooseSpeedtestServer,
      hydrateSpeedtestState,
      isWithinActiveWindow,
      mapSpeedtestDirectoryServers,
      mergeSpeedtestGeo,
      needsSpeedtestDiscovery,
      parseSpeedtestResult,
      renderSpeedtestIcon,
      serializeSpeedtestState,
      speedChart,
      speedtestCandidates,
    },
  };
}
