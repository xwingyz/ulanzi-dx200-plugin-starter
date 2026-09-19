import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
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
    t,
    themeFor,
    toDataUrl,
    writePersistedState,
  } = runtime;

const SPEEDTEST_STATE_VERSION = 2;
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
const SPEEDTEST_DIRECTORY_NEARBY_LIMIT = 30;
const SPEEDTEST_DIRECTORY_CONCURRENCY = 4;
// 选节点前的延迟探测：每个节点串行采 3 次 /hi，节点间最多 4 个并发；单次超时按 3 秒计价。
// 2026-09-19 实测：苏州 JSQY(16204) 约三成采样跳到 290 ms、下行只有 0.7 Mbps，
// 上海电信(3633) 稳定 42 ms、下行 130+ Mbps；用均值而不是最小值，就是为了让这种抖动被算进去。
const SPEEDTEST_PROBE_SAMPLES = 3;
const SPEEDTEST_PROBE_TIMEOUT_MS = 3000;
const SPEEDTEST_PROBE_CONCURRENCY = 4;
const SPEEDTEST_PROBE_PORT = 8080;
// 历史反馈剔除慢节点的窗口和比例：24 小时内的成功结果，下行不到池内最好成绩 1/10 视为慢。
const SPEEDTEST_SLOW_WINDOW_MS = 24 * 60 * 60 * 1000;
const SPEEDTEST_SLOW_RATIO = 0.1;
const SPEEDTEST_WEBSITE_URL = 'https://www.speedtest.net/';
const SPEEDTEST_INTERVALS = ['15', '30', '60', 'manual'];
const SPEEDTEST_TIMEOUTS = ['120', '180', '240', '300'];
// 各区域的筛选规则：国家/地区代码，可选经度上下限（美东/美西以西经 100° 为界）。
// property-inspector/speedtest.js 里有一份逐字相同的副本，
// 由 tests/speedtest-action.test.js 锁定两边一致；改这里必须同步改那边。
// any 不在表里：不筛选。
const SPEEDTEST_REGION_RULES = {
  china: { countries: ['CN', 'HK', 'MO', 'TW'] },
  japankorea: { countries: ['JP', 'KR'] },
  southeastasia: { countries: ['SG', 'MY', 'TH', 'VN', 'PH', 'ID'] },
  europe: { countries: ['GB', 'IE', 'DE', 'FR', 'NL', 'BE', 'LU', 'ES', 'PT', 'IT', 'CH', 'AT', 'SE', 'NO', 'DK', 'FI', 'PL', 'CZ'] },
  useast: { countries: ['US'], lonMin: -100 },
  uswest: { countries: ['US'], lonMax: -100 },
  canada: { countries: ['CA'] },
  oceania: { countries: ['AU', 'NZ'] },
};
// 目录接口不带 search 时只按出口 IP 就近返回，从大陆看海外几乎只剩台湾/香港，
// 所以每个区域都固定按国家名搜索：search 按国家全名匹配最稳（'Tokyo' 只回 5 个，'Japan' 能回 11 个），
// 而大陆节点在这个接口上几乎搜不到（'Beijing' 回 0），只能靠就近列表，就近列表因此对所有区域都保留。
// 美东/美西按城市搜：'Washington' 命中的是华盛顿州，不能用。
// label 显示在键面标题行，最长 8 个字符；缩写只用 ISO 代码，不用带政治含义的简称。
const SPEEDTEST_REGIONS = {
  any: { label: 'GLOBAL', searches: ['China', 'Hong Kong', 'Taiwan', 'Japan', 'Korea', 'Singapore',
    'United States', 'United Kingdom', 'Germany', 'Australia'] },
  china: { label: 'CHINA', searches: ['China', 'Hong Kong', 'Macau', 'Taiwan'] },
  japankorea: { label: 'JP·KR', searches: ['Japan', 'Korea'] },
  southeastasia: { label: 'SE ASIA', searches: ['Singapore', 'Malaysia', 'Thailand', 'Vietnam', 'Philippines', 'Indonesia'] },
  europe: { label: 'EUROPE', searches: ['United Kingdom', 'Germany', 'France', 'Netherlands', 'Spain', 'Italy',
    'Switzerland', 'Sweden', 'Poland'] },
  useast: { label: 'US EAST', searches: ['New York', 'Chicago', 'Dallas', 'Atlanta', 'Miami', 'Houston'] },
  uswest: { label: 'US WEST', searches: ['Los Angeles', 'Seattle', 'Denver', 'Phoenix', 'Salt Lake', 'San Jose'] },
  canada: { label: 'CANADA', searches: ['Canada', 'Toronto', 'Vancouver', 'Montreal'] },
  oceania: { label: 'OCEANIA', searches: ['Australia', 'New Zealand'] },
};
const SPEEDTEST_SCOPES = Object.keys(SPEEDTEST_REGIONS);
const SPEEDTEST_CHART_TYPES = ['line', 'bar'];
// auto：按每次测速结果自动判定；direct / proxy：用户手动声明，键面按声明显示。
const SPEEDTEST_PROXY_MODES = ['auto', 'direct', 'proxy'];

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
    // 测速流量是否从 VPN/TUN 接口出去。Clash TUN 下 CLI 报 isVpn=true、接口 utun5、
    // 内网 198.18.0.1（2026-09-19 实测）；老版本不给 isVpn 时靠接口名兜底。
    viaVpn: payload?.interface?.isVpn === true || /^(utun|tun|tap|wg|ppp)\d*/i.test(String(payload?.interface?.name || '')),
    viaProxy: null,
    exitCountryCode: '',
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
        // 只留判定结论和出口国家，出口 IP 不进历史（也不进任何持久化结构）。
        viaProxy: typeof entry.viaProxy === 'boolean' ? entry.viaProxy : null,
        exitCountryCode: String(entry.exitCountryCode || '').toUpperCase().slice(0, 3),
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
    autoPaused: instance?.autoPaused === true,
    dailyServerId: String(instance?.dailyServerId || ''),
    dailyServerDate: String(instance?.dailyServerDate || ''),
    serverCache: JSON.parse(sanitizeServerList(instance?.serverCache || [])),
    serverCacheUpdatedAt: Number(instance?.serverCacheUpdatedAt || 0),
    serverCacheScope: String(instance?.serverCacheScope || ''),
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
    autoPaused: clean.autoPaused,
    dailyServerId: clean.dailyServerId,
    dailyServerDate: clean.dailyServerDate,
    serverCache: clean.serverCache,
    serverCacheUpdatedAt: clean.serverCacheUpdatedAt,
    serverCacheScope: clean.serverCacheScope,
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

function speedtestNextActiveWindowStart(settings, now = Date.now()) {
  if (isWithinActiveWindow(settings, now)) {
    return now;
  }
  const start = parseClockMinutes(settings?.activeStart, '08:00');
  const date = new Date(now);
  const candidate = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    Math.floor(start / 60),
    start % 60,
  );
  if (candidate.getTime() <= now) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate.getTime();
}

function speedtestNextDueAt(settings, now, delayMs) {
  const candidate = Number(now) + Math.max(0, Number(delayMs) || 0);
  return isWithinActiveWindow(settings, candidate)
    ? candidate
    : speedtestNextActiveWindowStart(settings, candidate);
}

function speedtestCandidates(settings, state) {
  let configured = [];
  try {
    configured = JSON.parse(sanitizeServerList(settings?.candidateServers || '[]'));
  } catch {}
  const source = configured.length ? configured : (Array.isArray(state?.serverCache) ? state.serverCache : []);
  const scope = settings?.scope || 'china';
  if (scope === 'any') {
    return source.slice();
  }
  return source.filter((server) => speedtestServerInScope(scope, server));
}

// CLI 回退列表可能没有 countryCode，只有国家名，所以大陆判定额外认几种写法。
function speedtestServerCountryCode(server) {
  const countryCode = String(server?.countryCode || '').toUpperCase();
  if (countryCode) return countryCode;
  return /^(china|中国|中国大陆|people'?s republic of china)$/i.test(String(server?.country || '')) ? 'CN' : '';
}

// 带经度界限的区域（美东/美西）要求节点有坐标；CLI 回退列表没有坐标，这类节点只进 any。
function speedtestServerInScope(scope, server) {
  if (scope === 'any') return true;
  const rule = SPEEDTEST_REGION_RULES[scope];
  if (!rule || !rule.countries.includes(speedtestServerCountryCode(server))) return false;
  const lon = Number(server?.lon);
  if (rule.lonMin !== undefined && !(Number.isFinite(lon) && lon > rule.lonMin)) return false;
  if (rule.lonMax !== undefined && !(Number.isFinite(lon) && lon <= rule.lonMax)) return false;
  return true;
}

function mapSpeedtestDirectoryServers(items) {
  return JSON.parse(sanitizeServerList((Array.isArray(items) ? items : []).map((server) => ({
    id: server?.id,
    host: server?.host,
    name: server?.sponsor || server?.name,
    city: server?.name || server?.location,
    country: server?.country,
    countryCode: server?.cc || server?.countryCode,
    lat: server?.lat,
    lon: server?.lon,
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
  // 目录按区域拉取；旧状态没记 scope 时退回“当前区域有没有候选”的判定。
  if (state.serverCacheScope && state.serverCacheScope !== settings?.scope) return true;
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

// 每日随机选点：现在只是 selectSpeedtestServer 在延迟探测全部失败时的退路。
// 勾 1 个 = 固定该节点；多个候选 = 当天粘住一个随机节点（pool 由 speedtestCandidates 兜底）。
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
  // 先抽国家再抽节点：目录里台湾节点远多于其他海外地区，
  // 直接在全池里均匀抽会让“海外”几乎天天落在同一个区域。
  const pick = (list) => list[Math.min(list.length - 1, Math.max(0, Math.floor(Number(random()) * list.length)))];
  const byCountry = new Map();
  for (const server of pool) {
    const key = String(server.countryCode || server.country || '').toUpperCase();
    if (!byCountry.has(key)) byCountry.set(key, []);
    byCountry.get(key).push(server);
  }
  const selected = pick(pick([...byCountry.values()]));
  state.dailyServerId = String(selected.id);
  state.dailyServerDate = dateKey;
  return selected;
}

// Ookla 节点在 8080 端口提供 /hi（回 "hello 2.x"），speedtest.net 网页也是拿它选最低延迟的节点。
function speedtestProbeUrl(server) {
  const host = String(server?.host || '').trim();
  if (!host) return '';
  const hasPort = /^\[.*\]:\d+$/.test(host) || (!host.startsWith('[') && /:\d+$/.test(host));
  return `http://${hasPort ? host : `${host}:${SPEEDTEST_PROBE_PORT}`}/hi`;
}

function measureHttpLatency(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const startedAt = process.hrtime.bigint();
    const request = http.get(url, { headers: { 'User-Agent': 'LexUtility/0.1' } }, (response) => {
      response.resume();
      response.on('end', () => {
        if ((response.statusCode || 500) >= 400) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }
        resolve(Number(process.hrtime.bigint() - startedAt) / 1e6);
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('probe timeout')));
    request.on('error', reject);
  });
}

// 对候选池逐个测 /hi 延迟：同一节点串行采样，失败的采样按超时计价（抖动和丢包都会拉高均值），
// 全部失败记为 null 表示不可达。结果顺序与输入一致。
async function probeSpeedtestServers(servers, options = {}) {
  const samples = Math.max(1, Number(options.samples) || SPEEDTEST_PROBE_SAMPLES);
  const timeoutMs = Number(options.timeoutMs) || SPEEDTEST_PROBE_TIMEOUT_MS;
  const probe = options.probe || ((url) => measureHttpLatency(url, timeoutMs));
  const pool = Array.isArray(servers) ? servers : [];
  const results = await runSettledLimited(pool.map((server) => async () => {
    const url = speedtestProbeUrl(server);
    if (!url) return null;
    let total = 0;
    let reachable = 0;
    for (let index = 0; index < samples; index += 1) {
      try {
        total += Math.min(timeoutMs, Number(await probe(url)) || 0);
        reachable += 1;
      } catch {
        // 一次失败就不再采样：剩余采样按超时计价，坏节点最多拖一个超时的时间。
        total += timeoutMs * (samples - index);
        break;
      }
    }
    return reachable ? Math.round(total / samples) : null;
  }), options.concurrency || SPEEDTEST_PROBE_CONCURRENCY);
  return pool.map((server, index) => ({
    server,
    latencyMs: results[index].status === 'fulfilled' ? results[index].value : null,
  }));
}

// 延迟探测分不出吞吐问题：JSQY(16204) 有三成时间 /hi 延迟和上海电信一样低，下行却只有 0.7 Mbps，
// 光靠探测会周期性再选中它。所以用插件自己的历史做反馈：候选里 24 小时内有过成功结果、
// 下行不到池内最好成绩 1/10 的节点先剔除。只比同一池内的节点，不设绝对阈值。
function speedtestSlowServerIds(history, pool, now = Date.now()) {
  const latest = new Map();
  for (const entry of Array.isArray(history) ? history : []) {
    const id = String(entry?.server?.id || '');
    if (entry?.ok === true && id && now - Number(entry.at) <= SPEEDTEST_SLOW_WINDOW_MS) {
      latest.set(id, Number(entry.downloadMbps) || 0);
    }
  }
  const measured = pool.map((server) => String(server.id)).filter((id) => latest.has(id));
  const best = Math.max(0, ...measured.map((id) => latest.get(id)));
  if (!(best > 0)) return new Set();
  return new Set(measured.filter((id) => latest.get(id) < best * SPEEDTEST_SLOW_RATIO));
}

// 每次测速前在候选池里选延迟最低的可达节点，和 speedtest.net 网页的选法一致。
// 只有一个候选不探测；探测全部失败（比如 /hi 被拦）退回每日随机，不比以前差。
async function selectSpeedtestServer(state, servers, options = {}) {
  const candidates = Array.isArray(servers) ? servers : [];
  const slow = speedtestSlowServerIds(state?.history, candidates, options.now ?? Date.now());
  const eligible = candidates.filter((server) => !slow.has(String(server.id)));
  const pool = eligible.length ? eligible : candidates;
  if (pool.length <= 1) return pool[0] || null;
  const probe = options.probe || probeSpeedtestServers;
  const scored = (await probe(pool)).filter((entry) => Number.isFinite(entry?.latencyMs));
  if (!scored.length) {
    return chooseSpeedtestServer(state, pool, options.now ?? Date.now(), options.random ?? Math.random);
  }
  return scored.reduce((best, entry) => (entry.latencyMs < best.latencyMs ? entry : best)).server;
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

// 同 Promise.allSettled，但最多同时跑 concurrency 个任务，结果顺序与输入一致。
async function runSettledLimited(tasks, concurrency) {
  const results = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      try {
        results[index] = { status: 'fulfilled', value: await tasks[index]() };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
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

async function fetchSpeedtestDirectoryServers(fetcher = (url) => fetchJson(url, 12_000), scope = 'china') {
  const query = (search = '', limit = SPEEDTEST_DIRECTORY_NEARBY_LIMIT) => {
    const url = new URL(SPEEDTEST_DIRECTORY_URL);
    url.searchParams.set('engine', 'js');
    url.searchParams.set('https_functional', 'true');
    url.searchParams.set('limit', String(limit));
    if (search) url.searchParams.set('search', search);
    return fetcher(url);
  };
  const searches = (SPEEDTEST_REGIONS[scope] || SPEEDTEST_REGIONS.china).searches;
  // 缓存最多 100 条：就近列表占 30，剩下的按搜索词数量均分，词少的区域每个国家就能多拿一些。
  const limit = Math.min(30, Math.max(5, Math.floor(70 / searches.length)));
  // 十来个请求一起发时目录接口偶发单个失败，整个国家就从清单里消失了：
  // 限制并发并各重试一次，实测能把这种缺国家的情况压掉。
  const retryOnce = (run) => run().catch(() => run());
  const results = await runSettledLimited([
    () => retryOnce(() => query()),
    ...searches.map((search) => () => retryOnce(() => query(search, limit))),
  ], SPEEDTEST_DIRECTORY_CONCURRENCY);
  const lists = results.map((result) => result.status === 'fulfilled'
    ? mapSpeedtestDirectoryServers(result.value)
    : []);
  // 各列表轮流取一条再去重：sanitizeServerList 只保留前 100 条，
  // 顺序拼接会让排在后面的地区整个被截掉。
  const byId = new Map();
  for (let index = 0; lists.some((list) => index < list.length); index += 1) {
    for (const list of lists) {
      const server = list[index];
      if (server && !byId.has(server.id)) byId.set(server.id, server);
    }
  }
  if (!byId.size) {
    throw results.find((result) => result.status === 'rejected')?.reason ||
      new Error('Speedtest directory returned no nodes');
  }
  const collator = new Intl.Collator('en');
  return [...byId.values()].sort((a, b) => collator.compare(a.countryCode, b.countryCode) ||
    collator.compare(a.city, b.city) || collator.compare(a.name, b.name));
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
  const payload = JSON.parse(stdout);
  const result = parseSpeedtestResult(payload);
  // 出口 IP 只在这里用一次，查完国家就丢，不进 result、不进持久化。
  const exitCountryCode = await lookupSpeedtestExitCountry(instance, payload?.interface?.externalIp);
  return { ...result, exitCountryCode, viaProxy: resolveSpeedtestProxy(result, exitCountryCode) };
}

// 判定“这次测速走没走代理”。宿主 Clash 以 TUN 接管全部路由，走 DIRECT 规则的国内流量同样从 utun 出去，
// 单看 isVpn 会把国内直连判成代理；所以再看出口 IP 的国家：走了 VPN/TUN 且出口不在 CN 才算代理。
// 走了 TUN 但出口国家不明（GeoIP 关闭或失败）→ null，键面不显示标志，Inspector 显示“无法判定”。
function resolveSpeedtestProxy(result, exitCountryCode) {
  if (!result?.viaVpn) return false;
  if (!exitCountryCode) return null;
  return String(exitCountryCode).toUpperCase() !== 'CN';
}

// 键面/Inspector 用的最终状态：手动声明优先，auto 时看最近一次成功结果的判定。
function speedtestProxyState(instance) {
  const mode = instance?.settings?.proxyMode || 'auto';
  if (mode === 'proxy' || mode === 'direct') return mode;
  const verdict = instance?.lastResult?.viaProxy;
  return verdict === true ? 'proxy' : verdict === false ? 'direct' : '';
}

// 出口 IP 的 GeoIP 只放内存缓存（进程生命周期内出口通常不变），不进 geoCache 这类会落盘的结构。
async function lookupSpeedtestExitCountry(instance, ip) {
  const address = String(ip || '').trim();
  if (!address || String(instance?.settings?.geoIpEnabled) !== 'true') return '';
  instance.exitGeoCache ||= new Map();
  if (instance.exitGeoCache.has(address)) return instance.exitGeoCache.get(address);
  try {
    const payload = await fetchJson(`https://ipwho.is/${encodeURIComponent(address)}?fields=success,country_code`);
    const code = payload?.success ? String(payload.country_code || '').toUpperCase() : '';
    if (code) instance.exitGeoCache.set(address, code);
    return code;
  } catch {
    return '';
  }
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
      const scope = instance.settings.scope;
      try {
        discovered = await fetchSpeedtestDirectoryServers(undefined, scope);
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
      instance.serverCacheScope = scope;
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
  if (instance.autoPaused) {
    const hadNextDue = Number(instance.nextDueAt || 0) !== 0;
    instance.nextDueAt = 0;
    if (options.settingsChanged || hadNextDue) flushSpeedtestState(instance);
    return;
  }
  const intervalMs = speedtestIntervalMs(instance.settings);
  if (!intervalMs) {
    instance.nextDueAt = 0;
    if (options.settingsChanged) flushSpeedtestState(instance);
    return;
  }
  const now = Date.now();
  if (options.settingsChanged || !Number(instance.nextDueAt)) {
    instance.nextDueAt = speedtestNextDueAt(instance.settings, now, intervalMs);
  } else {
    const candidate = Math.max(now, Number(instance.nextDueAt));
    instance.nextDueAt = isWithinActiveWindow(instance.settings, candidate)
      ? candidate
      : speedtestNextActiveWindowStart(instance.settings, candidate);
  }
  const dueAt = instance.nextDueAt;
  setInstanceTimeout(instance, 'speedtestSchedule', () => {
    const firedAt = Date.now();
    if (firedAt - dueAt > 5000) {
      instance.nextDueAt = speedtestNextDueAt(
        instance.settings,
        firedAt,
        30_000 + Math.floor(Math.random() * 60_001),
      );
      flushSpeedtestState(instance);
      scheduleNextSpeedtest(instance);
      return;
    }
    if (!isWithinActiveWindow(instance.settings)) {
      instance.nextDueAt = speedtestNextActiveWindowStart(instance.settings);
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
  if (intervalMs && !instance.autoPaused && (!instance.nextDueAt || instance.nextDueAt <= now)) {
    instance.nextDueAt = speedtestNextDueAt(
      instance.settings,
      now,
      30_000 + Math.floor(Math.random() * 60_001),
    );
  }
  if (intervalMs && !instance.autoPaused) scheduleNextSpeedtest(instance);
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
  const promise = exclusiveTasks.run(instance, SPEEDTEST_RESOURCE, async (signal) => {
    try {
      // 选点放在任务里：探测本身要发请求，不能在排队阶段就跑。
      const selected = options.server || await selectSpeedtestServer(
        instance,
        speedtestCandidates(instance.settings, instance),
      );
      if (signal.aborted) return { cancelled: true };
      const result = await executeSpeedtest(instance, selected, signal);
      if (signal.aborted) return { cancelled: true };
      instance.history = pruneSpeedtestHistory([...(instance.history || []), result], result.at);
      instance.lastResult = result;
      instance.lastCompletedAt = result.at;
      instance.phase = 'idle';
      instance.errorCode = '';
      instance.retryCount = 0;
      instance.nextDueAt = speedtestIntervalMs(instance.settings)
        ? speedtestNextDueAt(instance.settings, Date.now(), speedtestIntervalMs(instance.settings))
        : 0;
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
        // 重试前丢掉当天的粘性节点：探测退路走每日随机时才用得上，
        // 正常路径每次重新探测，清空与否不影响。
        instance.dailyServerId = '';
        instance.dailyServerDate = '';
        setInstanceTimeout(instance, 'speedtestRetry', () => requestSpeedtest(instance, { source: 'retry' }), SPEEDTEST_RETRY_MS);
      } else {
        instance.retryCount = 0;
        instance.nextDueAt = speedtestIntervalMs(instance.settings)
          ? speedtestNextDueAt(instance.settings, Date.now(), speedtestIntervalMs(instance.settings))
          : 0;
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

function handleSpeedtestDoublePress(instance, options = {}) {
  const cancelTask = options.cancelTask ?? ((target) => exclusiveTasks.cancel(target, SPEEDTEST_RESOURCE));
  const clearTimer = options.clearTimer ?? clearInstanceTimeout;
  const flush = options.flush ?? flushSpeedtestState;
  const render = options.render ?? renderInstance;
  const sendRuntime = options.sendRuntime ?? sendSpeedtestRuntime;
  const schedule = options.schedule ?? scheduleNextSpeedtest;

  instance.autoPaused = !instance.autoPaused;
  if (instance.autoPaused) {
    clearTimer(instance, 'speedtestSchedule');
    clearTimer(instance, 'speedtestRetry');
    instance.nextDueAt = 0;
    if (['queued', 'running', 'discovering'].includes(instance.phase)) {
      cancelTask(instance);
    }
    flush(instance);
  } else {
    schedule(instance, { settingsChanged: true });
  }
  sendRuntime(instance);
  render(instance);
}

function handleSpeedtestRun(instance, options = {}) {
  const cancelTask = options.cancelTask ?? ((target) => exclusiveTasks.cancel(target, SPEEDTEST_RESOURCE));
  const request = options.request ?? requestSpeedtest;
  if (['queued', 'running', 'discovering'].includes(instance.phase)) {
    cancelTask(instance);
    return Promise.resolve();
  }
  // 活动窗口只约束自动调度。实体按键和 Inspector 的立即测速都属于
  // 用户明确发起的手动任务，任何时段都直接执行一次。
  return request(instance, { source: 'manual' });
}

function openSpeedtestWebsite(options = {}) {
  const run = options.execFile ?? execFile;
  const platform = options.platform ?? process.platform;
  const command = platform === 'darwin' ? '/usr/bin/open'
    : platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = platform === 'win32'
    ? ['url.dll,FileProtocolHandler', SPEEDTEST_WEBSITE_URL]
    : [SPEEDTEST_WEBSITE_URL];
  return new Promise((resolve, reject) => {
    run(command, args, { windowsHide: true }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(SPEEDTEST_WEBSITE_URL);
    });
  });
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
    autoPaused: instance.autoPaused === true,
    proxyState: speedtestProxyState(instance),
    exitCountryCode: instance.lastResult?.exitCountryCode || '',
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
// 用 `>` 前缀而不是 ` ago` 后缀：短 3 个字符，标题行才放得下 SE ASIA、OCEANIA
// 这样 8 字符以内的区域代号；而且刻度是向下取整的，`>15m` 字面意思正好就是它的真实含义。
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
  const glyphs = [...label];
  const glyphWidth = glyphs.reduce(
    (sum, character) => sum + (/^[\x00-\x7F]$/.test(character) ? 0.66 : 1),
    0,
  );
  const width = glyphWidth * fontSize + Math.max(0, glyphs.length - 1) * spacing + 22;
  // 错误用 latency action 同一支红（#ef4444）：theme.low 在多数主题里
  // 和 accent 是同色系，错误块和"正在测速"块看起来会是同一个东西。
  return `
    <rect x="44" y="38" width="${width.toFixed(1)}" height="30" rx="9" fill="${isError ? '#ef4444' : theme.accent}"/>
    <text x="55" y="60" fill="${isError ? '#ffffff' : theme.canvas}" font-size="${fontSize}" font-weight="800" letter-spacing="${spacing}" font-family="Arial, sans-serif">${escapeXml(label)}</text>
  `;
}

// 线路标志：压在下载带顶部的图表区（y 70–84）右侧。那一带只有图表背景——数值基线在 120、
// 字高 46，顶到 86 左右；标题行在 60 以上——所以是键面上唯一放得下一个小标签的位置。
// PROXY 用强调色实底，DIRECT 只描边，一眼能分出两个实例谁走了代理。
function routeTag(state, theme, language) {
  if (state !== 'proxy' && state !== 'direct') return '';
  const label = t(state === 'proxy' ? 'PROXY' : 'DIRECT', language);
  const fontSize = 11;
  const glyphs = [...label];
  const width = glyphs.reduce((sum, ch) => sum + (/^[\x00-\x7F]$/.test(ch) ? 0.66 : 1), 0) * fontSize + 10;
  const x = 214 - width;
  const proxy = state === 'proxy';
  return `
    <rect x="${x.toFixed(1)}" y="72" width="${width.toFixed(1)}" height="14" rx="4" fill="${proxy ? theme.accent : 'none'}" stroke="${proxy ? 'none' : theme.muted}" stroke-width="1.5"/>
    <text x="${(x + width / 2).toFixed(1)}" y="82.5" text-anchor="middle" fill="${proxy ? theme.canvas : theme.muted}" font-size="${fontSize}" font-weight="800" letter-spacing="0.5" font-family="Arial, sans-serif">${escapeXml(label)}</text>
  `;
}

function renderSpeedtestIcon(instance, now = Date.now()) {
  const theme = themeFor(instance.settings);
  const frame = frameFor(instance.settings);
  const background = renderThemeBackdrop(theme, theme.accent, frame);
  const last = instance.lastResult;
  const language = instance.settings.uiLanguage;
  const phaseLabel = instance.phase === 'queued' ? `${t('QUEUE', language)} ${Math.max(1, instance.queuePosition || 1)}`
    : instance.phase === 'running' ? t('TESTING', language)
      : instance.phase === 'discovering' ? t('NODES', language)
        : instance.phase === 'error' ? t(instance.errorCode || 'ERROR', language)
          : instance.autoPaused ? t('PAUSED', language) : '';
  const scopeKey = (SPEEDTEST_REGIONS[instance.settings.scope] || SPEEDTEST_REGIONS.china).label;
  const scope = t(scopeKey, language);
  const history = instance.history || [];
  // 标题行两个槽位：左边是区域或当前状态，右边是上次测速距今多久。
  // 状态直接顶掉区域而不是挤在右边——TESTING / QUEUE 1 这种长度会和
  // OCEANIA 撞在一起，而正在测速时状态本来就比区域更该被看到；
  // 出状态时右边的时间也一起让位，否则色块会盖住它。
  // 也不用居中浮层：浮层正好压住下行速度，那是这个键存在的意义。
  const dim = phaseLabel ? 0.5 : 1;
  const rawAge = last && !phaseLabel ? relativeAge(instance.lastCompletedAt || last.at, now) : '';
  const age = rawAge === 'now' ? t('now', language) : rawAge;
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
          ${routeTag(speedtestProxyState(instance), theme, language)}
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
      scope: 'china',
      intervalMin: '30',
      activeAllDay: 'false',
      activeStart: '08:00',
      activeEnd: '01:00',
      timeoutSec: '180',
      candidateServers: '[]',
      chartType: 'line',
      geoIpEnabled: 'true',
      proxyMode: 'auto',
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
      proxyMode: normalizeChoice(settings.proxyMode, defaults.proxyMode, SPEEDTEST_PROXY_MODES),
      cliPath: String(settings.cliPath || '').trim().slice(0, 300),
    }),
    createState: (instance) => ({
      phase: 'idle',
      queuePosition: -1,
      errorCode: '',
      retryCount: 0,
      ...hydrateSpeedtestState(readPersistedState(instance.context)),
    }),
    onRun: (instance) => handleSpeedtestRun(instance),
    onDoublePress: (instance) => handleSpeedtestDoublePress(instance),
    onLongPress: () => openSpeedtestWebsite(),
    onReady: (instance) => initializeSpeedtestInstance(instance),
    onSettingsChanged: (instance, previousSettings) => {
      const scopeChanged = previousSettings.scope !== instance.settings.scope;
      const targetChanged = scopeChanged ||
        previousSettings.candidateServers !== instance.settings.candidateServers;
      if (targetChanged) {
        instance.dailyServerId = '';
        instance.dailyServerDate = '';
        // 换区域等于用户要看那个区域的节点，绕过 10 分钟退避直接重拉；改勾选不用。
        ensureSpeedtestDiscovery(instance, { force: scopeChanged });
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
      fetchSpeedtestDirectoryServers,
      handleSpeedtestDoublePress,
      handleSpeedtestRun,
      hydrateSpeedtestState,
      isWithinActiveWindow,
      mapSpeedtestDirectoryServers,
      mergeSpeedtestGeo,
      needsSpeedtestDiscovery,
      parseSpeedtestResult,
      openSpeedtestWebsite,
      probeSpeedtestServers,
      renderSpeedtestIcon,
      resolveSpeedtestProxy,
      selectSpeedtestServer,
      speedtestProbeUrl,
      serializeSpeedtestState,
      speedtestProxyState,
      speedChart,
      speedtestCandidates,
      speedtestNextActiveWindowStart,
      speedtestNextDueAt,
      SPEEDTEST_REGIONS,
    },
  };
}
