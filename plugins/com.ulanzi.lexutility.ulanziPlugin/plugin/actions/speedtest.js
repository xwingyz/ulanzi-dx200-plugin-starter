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
    frameFor,
    frameHighlight,
    normalizeBooleanString,
    normalizeChoice,
    normalizeServerId,
    normalizeTime,
    persistSettings,
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
const SPEEDTEST_CHART_POINTS = 24;
const SPEEDTEST_RESOURCE = 'network-bandwidth';
const SPEEDTEST_RETRY_MS = 60 * 1000;
const SPEEDTEST_GEO_CACHE_MS = 30 * 24 * 60 * 60 * 1000;
const SPEEDTEST_SERVER_CACHE_MS = 24 * 60 * 60 * 1000;
const SPEEDTEST_DISCOVERY_RETRY_MS = 10 * 60 * 1000;
const SPEEDTEST_DIRECTORY_URL = 'https://www.speedtest.net/api/js/servers';
const SPEEDTEST_INTERVALS = ['15', '30', '60', 'manual'];
const SPEEDTEST_TIMEOUTS = ['120', '180', '240', '300'];
const SPEEDTEST_SCOPES = ['mainland', 'overseas'];
const SPEEDTEST_SELECTION_MODES = ['fixed', 'dailyRandom'];
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
  const mainland = settings?.scope !== 'overseas';
  return source.filter((server) => {
    const countryCode = String(server.countryCode || '').toUpperCase();
    const country = String(server.country || '').toLowerCase();
    const isMainland = countryCode === 'CN' || /^(china|中国|中国大陆|people'?s republic of china)$/i.test(country);
    return mainland ? isMainland : !isMainland;
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

function chooseSpeedtestServer(settings, state, servers, now = Date.now(), random = Math.random) {
  const pool = Array.isArray(servers) ? servers : [];
  if (settings?.selectionMode === 'fixed') {
    const id = normalizeServerId(settings?.fixedServerId);
    return pool.find((server) => String(server.id) === id) || (id ? { id } : null);
  }
  if (!pool.length) {
    return null;
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
    instance.settings,
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
        if (instance.settings.selectionMode === 'dailyRandom') {
          instance.dailyServerId = '';
          instance.dailyServerDate = '';
        }
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
  if (param.refreshServers === 'true') return ensureSpeedtestDiscovery(instance, { force: true });
  if (param.testSelected === 'true') return requestSpeedtest(instance, { source: 'inspector' });
  if (param.clearSpeedtestHistory === 'true') {
    instance.history = [];
    instance.lastResult = null;
    instance.errorCode = '';
    flushSpeedtestState(instance);
    sendSpeedtestRuntime(instance);
    return;
  }
  if (param.verifyServerId) {
    const id = normalizeServerId(param.verifyServerId);
    if (id) {
      return requestSpeedtest(instance, { source: 'verify', server: { id } }).then(async (result) => {
        if (!result?.ok) return result;
        const verified = await enrichSpeedtestServer(instance, result.server);
        instance.serverCache = [
          ...(instance.serverCache || []).filter((server) => String(server.id) !== id),
          verified,
        ];
        let candidates = [];
        try { candidates = JSON.parse(instance.settings.candidateServers || '[]'); } catch {}
        instance.settings.candidateServers = sanitizeServerList([
          ...candidates.filter((server) => String(server.id) !== id),
          verified,
        ]);
        if (instance.settings.selectionMode === 'fixed') instance.settings.fixedServerId = id;
        persistSettings(instance);
        flushSpeedtestState(instance);
        sendSpeedtestRuntime(instance);
        return result;
      });
    }
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

function speedChart(series, field, top, height, color, type) {
  const points = series.slice(-SPEEDTEST_CHART_POINTS);
  const max = Math.max(1, ...points.filter((entry) => entry.ok).map((entry) => Number(entry[field] || 0)));
  const left = 44;
  const width = 170;
  const step = width / Math.max(1, SPEEDTEST_CHART_POINTS - 1);
  if (type === 'bar') {
    const barWidth = Math.max(2, width / SPEEDTEST_CHART_POINTS - 1.5);
    return points.map((entry, index) => entry.ok
      ? `<rect x="${(left + index * (width / SPEEDTEST_CHART_POINTS)).toFixed(1)}" y="${(top + height - Number(entry[field] || 0) / max * height).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(1, Number(entry[field] || 0) / max * height).toFixed(1)}" rx="1" fill="${color}" opacity="0.82"/>`
      : '').join('');
  }
  const coords = points.flatMap((entry, index) => entry.ok
    ? [`${(left + index * step).toFixed(1)},${(top + height - Number(entry[field] || 0) / max * height).toFixed(1)}`]
    : []);
  return coords.length > 1 ? `<polyline points="${coords.join(' ')}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>` : '';
}

function renderSpeedtestIcon(instance) {
  const theme = themeFor(instance.settings);
  const frame = frameFor(instance.settings);
  const background = renderThemeBackdrop(theme, theme.accent, frame);
  const last = instance.lastResult;
  const phaseLabel = instance.phase === 'queued' ? `QUEUE ${Math.max(1, instance.queuePosition || 1)}`
    : instance.phase === 'running' ? 'TESTING'
      : instance.phase === 'discovering' ? 'NODES'
        : instance.phase === 'error' ? (instance.errorCode || 'ERROR') : '';
  const scope = instance.settings.scope === 'overseas' ? 'OVERSEAS' : 'MAINLAND';
  const history = instance.history || [];
  const dim = instance.phase === 'error' ? 0.48 : 1;
  return toDataUrl(`
    <svg width="256" height="256" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
      ${background.outer}
      ${['queued', 'running', 'discovering'].includes(instance.phase) ? frameHighlight(frame, theme.accent, 0.9) : ''}
      ${frameContent(frame, `
        <text x="128" y="55" text-anchor="middle" fill="${theme.muted}" font-size="13" font-weight="800" letter-spacing="2" font-family="Arial, sans-serif">${scope}</text>
        <g opacity="${dim}">
          <text x="54" y="91" fill="${theme.muted}" font-size="16" font-weight="700" font-family="Arial, sans-serif">↓</text>
          <text x="72" y="91" fill="${theme.text}" font-size="29" font-weight="800" font-family="Arial, sans-serif">${last ? escapeXml(Math.round(last.downloadMbps)) : '—'}</text>
          <text x="202" y="89" text-anchor="end" fill="${theme.low}" font-size="12" font-family="Arial, sans-serif">Mbps</text>
          <text x="54" y="125" fill="${theme.muted}" font-size="16" font-weight="700" font-family="Arial, sans-serif">↑</text>
          <text x="72" y="125" fill="${theme.text}" font-size="29" font-weight="800" font-family="Arial, sans-serif">${last ? escapeXml(Math.round(last.uploadMbps)) : '—'}</text>
          <text x="202" y="123" text-anchor="end" fill="${theme.low}" font-size="12" font-family="Arial, sans-serif">Mbps</text>
          <line x1="44" y1="154" x2="214" y2="154" stroke="${theme.low}" opacity="0.35"/>
          ${speedChart(history, 'downloadMbps', 142, 25, theme.accent, instance.settings.chartType)}
          ${speedChart(history, 'uploadMbps', 177, 25, theme.muted, instance.settings.chartType)}
          <text x="44" y="176" fill="${theme.accent}" font-size="10" font-family="Arial, sans-serif">DL</text>
          <text x="44" y="211" fill="${theme.muted}" font-size="10" font-family="Arial, sans-serif">UL</text>
        </g>
        ${phaseLabel ? `<rect x="62" y="104" width="132" height="48" rx="15" fill="${theme.shell}" stroke="${theme.accent}" stroke-width="3"/><text x="128" y="135" text-anchor="middle" fill="${theme.text}" font-size="18" font-weight="800" font-family="Arial, sans-serif">${escapeXml(phaseLabel)}</text>` : ''}
        ${!phaseLabel && last?.pingMs && history.length < 24 ? `<text x="202" y="211" text-anchor="end" fill="${theme.low}" font-size="10" font-family="Arial, sans-serif">${Math.round(last.pingMs)}ms</text>` : ''}
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
      intervalMin: '15',
      activeAllDay: 'false',
      activeStart: '08:00',
      activeEnd: '23:00',
      timeoutSec: '180',
      selectionMode: 'dailyRandom',
      fixedServerId: '',
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
      selectionMode: normalizeChoice(settings.selectionMode, defaults.selectionMode, SPEEDTEST_SELECTION_MODES),
      fixedServerId: normalizeServerId(settings.fixedServerId),
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
        previousSettings.selectionMode !== instance.settings.selectionMode ||
        previousSettings.fixedServerId !== instance.settings.fixedServerId ||
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
      serializeSpeedtestState,
    },
  };
}
