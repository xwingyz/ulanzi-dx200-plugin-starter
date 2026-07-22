import { spawn } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';

const STATE_VERSION = 1;
const SESSION_NAME = 'LexNasStatus';
const REQUEST_TIMEOUT_MS = 10_000;
const MANUAL_COOLDOWN_MS = 5_000;
// 失败退避：与共识一致，60s 起步、120s 封顶；成功后回到 pollSec。
const BACKOFF_DELAYS_MS = [60_000, 120_000];
const PROBE_PARAM = '__nasstatusProbe';
const PROBE_RESULT_PARAM = '__nasstatusProbeResult';

// 会话失效错误码：清 sid 重登一次；105 是权限不足，重登也救不了，单独归类。
const SESSION_EXPIRED_CODES = new Set([106, 107, 119]);
const PERMISSION_CODES = new Set([105]);
// 登录错误码里属于「权限/策略」而非「密码错」的：402=无登录权限（DSM 未授权该账号）、
// 401=账号被禁用、403/404/406=需要/未配置 2FA、407=被 IP/地理封锁。这些归「权限不足」，
// 提示用户去 NAS 授权，而不是误导去查密码（400 才是账号不存在或密码错→AUTH）。
const LOGIN_PERMISSION_CODES = new Set([401, 402, 403, 404, 406, 407]);
const API_NOT_FOUND_CODE = 102;
// 温度历史长度与 systemstatus 的 HISTORY_LIMIT 对齐（24 个采样点），仅存内存不落盘。
const TEMP_HISTORY_LIMIT = 24;
// DSM 7.3 把存储接口从下划线名改成了点号名（实测 7.3.2：点号可用、下划线返回 102），
// 且未登录的 SYNO.API.Info 不再暴露它。因此存储不走预发现，登录后按序盲调，
// 命中的名字缓存进会话。
const STORAGE_API_CANDIDATES = ['SYNO.Storage.CGI.Storage', 'SYNO.Storage.CGI_Storage'];

// Synology 官方 wordmark，viewBox 0 0 24 24，取自 simple-icons（收录的是官方标记）。
// 字形带占满宽度、纵向居中于 y≈8.9..13.4。商标属于 Synology，此处仅用于指代其设备；
// 个人自用，公开发布前需换成通用 NAS 图标（见规格 §6）。
const SYNO_MARK = 'M13.44 8.927l-.889.37.056.117a.623.623 0 0 1 .212-.054c.05 0 .093.017.126.046.033.028.058.081.072.16.015.08.022.29.022.634v2.736c0 .189-.013.316-.042.381a.295.295 0 0 1-.118.142c-.053.031-.147.045-.286.045v.12h1.481v-.12c-.154 0-.261-.017-.32-.048a.29.29 0 0 1-.126-.142c-.026-.06-.04-.187-.04-.378V8.927zm-11.722.34c-.33 0-.608.05-.84.147-.233.1-.411.246-.534.436a1.083 1.083 0 0 0-.185.612c0 .338.131.627.393.864.184.167.507.309.968.422.358.091.587.153.688.191a.7.7 0 0 1 .31.183c.058.07.088.158.088.259 0 .155-.07.291-.21.41-.142.116-.35.176-.628.176-.262 0-.47-.066-.625-.197-.154-.132-.255-.339-.307-.619L0 12.23c.056.48.228.845.517 1.096.289.252.704.378 1.244.378.371 0 .68-.054.93-.156a1.263 1.263 0 0 0 .781-1.169 1.29 1.29 0 0 0-.171-.684 1.203 1.203 0 0 0-.472-.437c-.2-.107-.508-.21-.927-.31-.418-.098-.683-.193-.79-.286a.326.326 0 0 1 .009-.524c.14-.105.336-.156.586-.156.24 0 .422.049.542.145.122.097.199.256.237.471l.864-.028c-.013-.395-.154-.71-.425-.949-.271-.235-.674-.353-1.208-.353zm21.808.33a.475.475 0 1 0-.002.95.475.475 0 0 0 .002-.95zm0 .072a.4.4 0 0 1 .401.403c0 .116-.05.22-.128.294l-.086-.135a.396.396 0 0 0-.065-.078.212.212 0 0 0-.048-.03.2.2 0 0 0 .127-.057.144.144 0 0 0 .043-.109.178.178 0 0 0-.025-.091.125.125 0 0 0-.067-.055.309.309 0 0 0-.123-.02h-.266v.606h.08v-.268h.091c.02 0 .036.001.045.003.013.004.025.007.036.014.013.01.024.023.04.043.015.019.035.049.059.083l.08.125h.043a.396.396 0 0 1-.237.08.405.405 0 0 1-.404-.405c0-.224.18-.403.404-.403zm-.157.191h.191c.044 0 .077.01.097.027a.089.089 0 0 1 .03.07.09.09 0 0 1-.016.055.076.076 0 0 1-.047.035.196.196 0 0 1-.085.013h-.17zm-15.037.6c-.41 0-.752.17-1.023.514v-.455h-.754v3.105h.814v-1.401c0-.348.022-.583.063-.713a.583.583 0 0 1 .234-.306.666.666 0 0 1 .385-.118c.11 0 .208.028.287.082.08.054.135.13.17.229.037.099.054.314.054.646v1.581h.816V11.7a2.54 2.54 0 0 0-.046-.55.925.925 0 0 0-.16-.343.83.83 0 0 0-.341-.25 1.285 1.285 0 0 0-.499-.097zm2.65 0a1.7 1.7 0 0 0-.826.2 1.39 1.39 0 0 0-.571.586 1.684 1.684 0 0 0-.202.793c0 .356.068.657.202.904.134.25.33.438.588.566.259.129.53.194.814.194.46 0 .841-.156 1.144-.463.303-.31.455-.698.455-1.167 0-.465-.15-.85-.451-1.156-.3-.305-.683-.457-1.154-.457zm7.315.05c-.351 0-.64.108-.865.323a1.02 1.02 0 0 0-.336.77c0 .194.05.371.147.534.1.162.24.285.423.379-.223.187-.366.335-.429.44a.55.55 0 0 0-.092.271c0 .068.024.13.071.184.046.056.127.116.24.187a9.626 9.626 0 0 0-.329.355c-.113.145-.19.253-.226.336a.41.41 0 0 0-.034.157c0 .12.081.232.246.343.291.19.649.284 1.071.284.55 0 .996-.16 1.337-.477.232-.216.35-.45.35-.694a.613.613 0 0 0-.183-.45.838.838 0 0 0-.49-.227 8.478 8.478 0 0 0-.878-.053 4.257 4.257 0 0 1-.46-.027c-.105-.015-.177-.04-.212-.075-.038-.037-.056-.072-.056-.112a.37.37 0 0 1 .05-.159.868.868 0 0 1 .186-.221c.156.049.309.07.459.07.36 0 .648-.1.864-.301a.956.956 0 0 0 .323-.722c0-.247-.062-.45-.187-.61h.394c.097 0 .15-.002.167-.01a.056.056 0 0 0 .035-.025.289.289 0 0 0 .018-.12.214.214 0 0 0-.02-.105.083.083 0 0 0-.033-.028.83.83 0 0 0-.166-.008h-.639a1.307 1.307 0 0 0-.746-.21zm-2.752 0c-.252 0-.49.065-.714.194a1.437 1.437 0 0 0-.546.61 1.816 1.816 0 0 0-.205.825c0 .381.114.724.34 1.03a1.29 1.29 0 0 0 1.09.543c.28 0 .532-.07.76-.211.23-.14.409-.35.54-.627.13-.276.194-.55.194-.821 0-.385-.118-.725-.354-1.022a1.344 1.344 0 0 0-1.105-.522zm-12.182.009l1.174 3.113a1.193 1.193 0 0 1-.21.431c-.09.112-.23.167-.419.167-.102 0-.218-.013-.344-.04l.067.645c.152.033.307.052.464.052.155 0 .294-.019.418-.052a1.04 1.04 0 0 0 .31-.138.862.862 0 0 0 .224-.234 2.2 2.2 0 0 0 .205-.414l.199-.545 1.085-2.985h-.844l-.722 2.204-.74-2.204zm16.631.078v.122a.84.84 0 0 1 .245.091c.035.029.08.08.136.157.072.102.125.186.158.255l1.088 2.275-.213.526c-.079.194-.158.326-.236.393-.08.068-.15.104-.217.104a.878.878 0 0 1-.167-.05.924.924 0 0 0-.3-.07c-.105 0-.19.025-.25.084a.286.286 0 0 0-.092.22c0 .098.042.183.126.257a.457.457 0 0 0 .322.112c.18 0 .366-.072.56-.223.193-.15.35-.37.469-.664l1.226-3.014a1.6 1.6 0 0 1 .113-.254.55.55 0 0 1 .145-.146.473.473 0 0 1 .188-.053v-.122h-.978v.122c.093 0 .16.008.197.023a.172.172 0 0 1 .083.057.146.146 0 0 1 .023.087c0 .091-.019.18-.056.271l-.675 1.671-.737-1.53c-.074-.15-.11-.268-.11-.356a.21.21 0 0 1 .074-.16.346.346 0 0 1 .224-.063h.068v-.122zm-1.753.08c.175 0 .316.074.43.217.15.196.224.466.224.815 0 .265-.053.46-.16.584a.516.516 0 0 1-.41.188.528.528 0 0 1-.43-.216c-.149-.19-.223-.458-.223-.802 0-.268.054-.461.163-.59a.515.515 0 0 1 .406-.197zm-2.798.054c.242 0 .44.102.598.312.23.308.346.727.346 1.263 0 .429-.07.73-.209.905a.646.646 0 0 1-.528.264c-.286 0-.516-.161-.691-.477-.174-.32-.263-.695-.263-1.135 0-.272.037-.493.11-.669a.731.731 0 0 1 .285-.361.667.667 0 0 1 .352-.102zm-4.463.395c.216 0 .396.084.543.247.144.162.216.397.216.703 0 .311-.072.55-.216.712a.695.695 0 0 1-.543.248.695.695 0 0 1-.542-.248c-.147-.161-.22-.398-.22-.708 0-.308.073-.545.22-.707a.704.704 0 0 1 .542-.247zm6.66 2.498c.265.036.647.065 1.142.08.34.007.566.034.68.083.113.048.17.13.17.241 0 .157-.094.304-.282.442-.19.138-.48.208-.874.208-.414 0-.732-.07-.951-.204-.128-.078-.19-.168-.19-.277 0-.078.024-.169.076-.26a1.51 1.51 0 0 1 .228-.313z';

const ERROR_LABELS = {
  AUTH: '认证失败',
  PERMISSION: '权限不足',
  API: '接口异常',
};

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clipText(value, maxLength) {
  const text = cleanString(value);
  return text.length > maxLength ? `${text.slice(0, Math.max(1, maxLength - 1))}…` : text;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function createNasStatusAction(runtime) {
  const {
    clearInstanceTimeout,
    escapeXml,
    frameContent,
    frameFor,
    frameHighlight,
    normalizeBooleanString,
    normalizeChoice,
    normalizeNumberString,
    readPersistedState,
    renderInstance,
    renderThemeBackdrop,
    sendParamFromPlugin,
    setInstanceTimeout,
    themeFor,
    toDataUrl,
    writePersistedState,
  } = runtime;

  // ---------------------------------------------------------------- 设置

  function isCompleteSettings(settings = {}) {
    return Boolean(cleanString(settings.nasHost)
      && cleanString(settings.username)
      && cleanString(settings.password));
  }

  function buildBaseUrl(settings = {}) {
    const scheme = normalizeBooleanString(settings.useHttps, 'true') === 'true' ? 'https' : 'http';
    const host = cleanString(settings.nasHost);
    const port = normalizeNumberString(settings.nasPort, '5001', 1, 65535);
    return `${scheme}://${host}:${port}`;
  }

  // ---------------------------------------------------------------- HTTP

  // 用 node:http(s) 而不是 fetch：需要对自签证书放行（rejectUnauthorized: false），
  // 这是共识里明确接受的取舍——局域网下「加密但不验证书」仍强于明文 HTTP。
  function httpGetJson(url, options = {}) {
    return new Promise((resolve) => {
      const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        resolve({ ok: false, kind: 'NETWORK' });
        return;
      }
      const lib = parsed.protocol === 'https:' ? https : http;
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      let request;
      try {
        request = lib.get(parsed, { rejectUnauthorized: false, timeout: timeoutMs }, (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => {
            if (response.statusCode == null || response.statusCode < 200 || response.statusCode >= 300) {
              finish({ ok: false, kind: 'HTTP', status: response.statusCode });
              return;
            }
            try {
              finish({ ok: true, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
            } catch {
              finish({ ok: false, kind: 'BAD_RESPONSE' });
            }
          });
          response.on('error', () => finish({ ok: false, kind: 'NETWORK' }));
        });
      } catch {
        finish({ ok: false, kind: 'NETWORK' });
        return;
      }
      request.on('timeout', () => {
        request.destroy();
        finish({ ok: false, kind: 'NETWORK' });
      });
      request.on('error', () => finish({ ok: false, kind: 'NETWORK' }));
    });
  }

  // ---------------------------------------------------------------- DSM API

  function apiError(kind, code) {
    return { state: 'ERROR', kind, code: code ?? null };
  }

  function classifyApiCode(code) {
    if (PERMISSION_CODES.has(code)) return 'PERMISSION';
    return 'API';
  }

  function parseApiInfo(json) {
    const data = json?.data;
    if (!data || typeof data !== 'object') return null;
    const pick = (name, preferred) => {
      const entry = data[name];
      if (!entry || typeof entry !== 'object' || !cleanString(entry.path)) return null;
      const max = finiteNumber(entry.maxVersion) ?? preferred;
      const min = finiteNumber(entry.minVersion) ?? 1;
      return { path: cleanString(entry.path), version: Math.max(min, Math.min(preferred, max)) };
    };
    const auth = pick('SYNO.API.Auth', 6);
    const dsm = pick('SYNO.DSM.Info', 2);
    return auth && dsm ? { auth, dsm } : null;
  }

  function parseDsmInfo(json) {
    const data = json?.data;
    if (!data || typeof data !== 'object') return null;
    return {
      hostname: cleanString(data.hostname),
      model: cleanString(data.model),
      temperature: finiteNumber(data.temperature),
      temperatureWarn: Boolean(data.temperature_warn),
    };
  }

  function parseVolumes(json) {
    const list = Array.isArray(json?.data?.volumes) ? json.data.volumes : [];
    return list.flatMap((volume) => {
      const id = cleanString(volume?.id);
      const total = finiteNumber(volume?.size?.total);
      const used = finiteNumber(volume?.size?.used);
      if (!id || total == null || total <= 0 || used == null) return [];
      return [{
        id,
        totalBytes: total,
        usedBytes: Math.max(0, Math.min(used, total)),
        status: cleanString(volume?.status),
        description: cleanString(volume?.vol_desc || volume?.desc),
      }];
      // DSM 返回顺序不稳定（实测 volume_2 会排在 volume_1 前面），
      // 按 id 数值序排定，让"默认第一个卷"语义稳定。
    }).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  }

  function pickVolume(volumes = [], volumeId = '') {
    const wanted = cleanString(volumeId);
    return volumes.find((volume) => volume.id === wanted) || volumes[0] || null;
  }

  // 键面最多显示两个卷：卷 1 空值退第一个卷；卷 2 空值表示不显示，且不与卷 1 重复。
  function selectedVolumes(volumes = [], settings = {}) {
    const first = pickVolume(volumes, settings.volumeId);
    const secondId = cleanString(settings.volumeId2);
    const second = secondId ? volumes.find((volume) => volume.id === secondId) || null : null;
    if (!first) return [];
    return second && second.id !== first.id ? [first, second] : [first];
  }

  // 一轮完整取数：API 发现 → 登录（sid 复用）→ 系统信息 → 卷列表。
  // 会话由调用方持有（{ apiInfo, sid }），跨轮复用，失效时清空重来。
  async function fetchNasStatus(settings, session = {}, options = {}) {
    const getJson = options.getJson ?? httpGetJson;
    const base = buildBaseUrl(settings);
    const account = cleanString(settings.username);
    const password = cleanString(settings.password);

    if (!session.apiInfo) {
      const query = 'SYNO.API.Auth,SYNO.DSM.Info';
      const info = await getJson(`${base}/webapi/query.cgi?api=SYNO.API.Info&version=1&method=query&query=${encodeURIComponent(query)}`);
      if (!info.ok) return info.kind === 'NETWORK' ? { state: 'OFFLINE' } : apiError('API');
      if (info.json?.success !== true) return apiError('API', info.json?.error?.code);
      const parsed = parseApiInfo(info.json);
      if (!parsed) return apiError('API');
      session.apiInfo = parsed;
    }
    const { auth, dsm } = session.apiInfo;

    if (!session.sid) {
      const login = await getJson(`${base}/webapi/${auth.path}?api=SYNO.API.Auth&version=${auth.version}`
        + `&method=login&account=${encodeURIComponent(account)}&passwd=${encodeURIComponent(password)}`
        + `&session=${SESSION_NAME}&format=sid`);
      if (!login.ok) return login.kind === 'NETWORK' ? { state: 'OFFLINE' } : apiError('AUTH');
      const sid = cleanString(login.json?.data?.sid);
      if (login.json?.success !== true || !sid) {
        const code = login.json?.error?.code;
        // 402/401/403… 属权限或策略问题（账号存在但无 DSM 登录权限、被禁用、需 2FA），
        // 归「权限不足」引导用户去 NAS 授权；400 才是账号/密码错→「认证失败」。
        return apiError(LOGIN_PERMISSION_CODES.has(code) ? 'PERMISSION' : 'AUTH', code);
      }
      session.sid = sid;
    }

    const callApi = (spec, apiName, method) => getJson(`${base}/webapi/${spec.path}?api=${apiName}`
      + `&version=${spec.version}&method=${method}&_sid=${encodeURIComponent(session.sid)}`);

    const system = await callApi(dsm, 'SYNO.DSM.Info', 'getinfo');
    if (!system.ok) return system.kind === 'NETWORK' ? { state: 'OFFLINE' } : apiError('API');
    if (system.json?.success !== true) {
      const code = system.json?.error?.code;
      // 会话过期：清 sid 重登一次；本轮由调用方重试，避免在此处递归。
      if (SESSION_EXPIRED_CODES.has(code)) {
        session.sid = null;
        return { state: 'RETRY' };
      }
      return apiError(classifyApiCode(code), code);
    }
    const systemInfo = parseDsmInfo(system.json);
    if (!systemInfo) return apiError('API');

    // DSM 7.3 的 SYNO.DSM.Info 不再返回 hostname；尽力从 FileStation.Info 兜底，
    // 失败无所谓——render 侧还有型号可退。
    if (!systemInfo.hostname) {
      const fsInfo = await getJson(`${base}/webapi/entry.cgi?api=SYNO.FileStation.Info&version=2&method=get&_sid=${encodeURIComponent(session.sid)}`);
      if (fsInfo.ok && fsInfo.json?.success === true) {
        systemInfo.hostname = cleanString(fsInfo.json.data?.hostname);
      }
    }

    let volumes = [];
    let storageError = null;
    let storageResolved = false;
    const candidates = session.storageApi ? [session.storageApi] : STORAGE_API_CANDIDATES;
    for (const apiName of candidates) {
      const loaded = await getJson(`${base}/webapi/entry.cgi?api=${apiName}&version=1&method=load_info&_sid=${encodeURIComponent(session.sid)}`);
      if (!loaded.ok) {
        if (loaded.kind === 'NETWORK') return { state: 'OFFLINE' };
        storageError = 'API';
        break;
      }
      if (loaded.json?.success !== true) {
        const code = loaded.json?.error?.code;
        if (code === API_NOT_FOUND_CODE) continue;
        if (SESSION_EXPIRED_CODES.has(code)) {
          session.sid = null;
          return { state: 'RETRY' };
        }
        storageError = classifyApiCode(code);
        break;
      }
      session.storageApi = apiName;
      volumes = parseVolumes(loaded.json);
      storageResolved = true;
      break;
    }
    // 系统信息成功但存储被拒（典型是低权限账号无存储管理器权限，或两个接口名都不存在）：
    // 判为异常而不是带残缺数据的在线，让用户在配置期就发现权限问题。
    if (!storageResolved) return apiError(storageError || 'API');

    return { state: 'ONLINE', system: systemInfo, volumes };
  }

  async function fetchWithRetry(settings, session, options = {}) {
    const first = await fetchNasStatus(settings, session, options);
    if (first.state !== 'RETRY') return first;
    const second = await fetchNasStatus(settings, session, options);
    return second.state === 'RETRY' ? apiError('AUTH') : second;
  }

  // ---------------------------------------------------------------- 格式化

  function formatBytes(bytes) {
    const value = finiteNumber(bytes);
    if (value == null || value < 0) return '--';
    const tib = value / 2 ** 40;
    if (tib >= 1) return `${tib.toFixed(1)}T`;
    const gib = value / 2 ** 30;
    if (gib >= 1) return `${gib.toFixed(1)}G`;
    return `${Math.round(value / 2 ** 20)}M`;
  }

  function usagePercent(volume) {
    if (!volume || !volume.totalBytes) return null;
    return Math.max(0, Math.min(100, Math.round((volume.usedBytes / volume.totalBytes) * 100)));
  }

  function usageSeverity(percent) {
    if (percent == null) return 'normal';
    if (percent >= 90) return 'critical';
    if (percent >= 80) return 'warning';
    return 'normal';
  }

  // 温度分级：>75°C 告警、≥90°C 危险；DSM 自带的 temperature_warn 兜底强制至少告警。
  function temperatureSeverity(temperature, warnFlag = false) {
    if (temperature != null) {
      if (temperature >= 90) return 'critical';
      if (temperature > 75) return 'warning';
    }
    return warnFlag ? 'warning' : 'normal';
  }

  function usageColor(severity, theme) {
    if (severity === 'critical') return theme.crit;
    if (severity === 'warning') return theme.warn;
    return theme.accent;
  }

  function formatAge(timestamp, now = Date.now()) {
    if (!Number.isFinite(timestamp)) return '尚无数据';
    const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
    if (seconds < 60) return `${seconds}s 前`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m 前`;
    return `${Math.floor(seconds / 3600)}h 前`;
  }

  function displayName(instance) {
    return clipText(cleanString(instance.settings.displayName) || instance.hostname || instance.model, 12);
  }

  function backoffDelay(attempt) {
    const index = Math.min(Math.max(attempt, 1) - 1, BACKOFF_DELAYS_MS.length - 1);
    return BACKOFF_DELAYS_MS[index];
  }

  // ---------------------------------------------------------------- 运行态

  function serializeState(instance) {
    return {
      v: STATE_VERSION,
      hostname: instance.hostname || null,
      model: instance.model || null,
      lastSeenAt: instance.lastSeenAt ?? null,
    };
  }

  function hydrateState(raw) {
    const valid = raw && typeof raw === 'object' && raw.v === STATE_VERSION;
    return {
      hostname: valid ? cleanString(raw.hostname) : '',
      model: valid ? cleanString(raw.model) : '',
      lastSeenAt: valid && Number.isFinite(raw.lastSeenAt) ? raw.lastSeenAt : null,
    };
  }

  function flushState(instance, options = {}) {
    const write = options.write ?? writePersistedState;
    return write(instance.context, serializeState(instance));
  }

  function applyResult(instance, result, now = Date.now()) {
    if (result.state === 'ONLINE') {
      const identityChanged = instance.hostname !== result.system.hostname
        || instance.model !== result.system.model;
      instance.hostname = result.system.hostname;
      instance.model = result.system.model;
      instance.temperature = result.system.temperature;
      instance.temperatureWarn = result.system.temperatureWarn;
      if (result.system.temperature != null) {
        instance.tempHistory = [...(instance.tempHistory || []), result.system.temperature].slice(-TEMP_HISTORY_LIMIT);
      }
      instance.volumes = result.volumes;
      instance.lastSeenAt = now;
      instance.connectionState = 'ONLINE';
      instance.errorKind = null;
      instance.failureCount = 0;
      return identityChanged;
    }
    instance.failureCount += 1;
    if (result.state === 'OFFLINE') {
      instance.connectionState = 'OFFLINE';
      instance.errorKind = null;
    } else {
      instance.connectionState = 'ERROR';
      instance.errorKind = result.kind || 'API';
    }
    return false;
  }

  function pollIntervalMs(instance) {
    return (Number.parseInt(instance.settings.pollSec, 10) || 60) * 1000;
  }

  function scheduleNextPoll(instance) {
    const delay = instance.connectionState === 'ONLINE'
      ? pollIntervalMs(instance)
      : backoffDelay(instance.failureCount);
    setInstanceTimeout(instance, 'nasstatusPoll', () => runFetch(instance), delay);
  }

  function isInstanceCurrent(instance, requestId) {
    return requestId === instance.requestId;
  }

  async function runFetch(instance, options = {}) {
    if (!instance || instance.fetching) return;
    if (!isCompleteSettings(instance.settings)) {
      instance.connectionState = 'CONFIG_REQUIRED';
      renderInstance(instance);
      return;
    }
    instance.fetching = true;
    instance.pollStarted = true;
    instance.requestId += 1;
    const requestId = instance.requestId;
    if (options.immediateRender) renderInstance(instance);

    const result = await (options.fetchImpl ?? fetchWithRetry)(instance.settings, instance.session, options);

    if (!isInstanceCurrent(instance, requestId)) {
      instance.fetching = false;
      return;
    }
    instance.fetching = false;
    instance.refreshing = false;
    const identityChanged = applyResult(instance, result);
    if (identityChanged) flushState(instance);
    renderInstance(instance);
    scheduleNextPoll(instance);
  }

  function resetSession(instance) {
    instance.session = { apiInfo: null, sid: null, storageApi: null };
    instance.failureCount = 0;
  }

  // ---------------------------------------------------------------- 交互

  function handleShortPress(instance, options = {}) {
    const now = options.now ?? Date.now();
    const run = options.run ?? runFetch;
    if (instance.lastManualAt && now - instance.lastManualAt < MANUAL_COOLDOWN_MS) {
      return undefined;
    }
    instance.lastManualAt = now;
    instance.refreshing = true;
    clearInstanceTimeout(instance, 'nasstatusPoll');
    return run(instance, { immediateRender: true });
  }

  function handleLongPress(instance, options = {}) {
    const spawnFn = options.spawnFn ?? spawn;
    const platform = options.platform ?? process.platform;
    if (platform !== 'darwin' || !cleanString(instance.settings.nasHost)) {
      return;
    }
    try {
      // SDK 桥接层没有插件主动打开 URL 的通道（openurl 是宿主→插件方向），走系统 open。
      const child = spawnFn('open', [`${buildBaseUrl(instance.settings)}/`], { stdio: 'ignore' });
      child.on?.('error', () => {});
      child.unref?.();
    } catch {
      // 打不开就算了，不让一个副作用把按键拖进错误态。
    }
  }

  // Inspector「测试连接」：用表单当前值（未必已保存）建临时会话探测，
  // 回推状态与卷列表；不落任何设置，保存仍走共享提交协议。
  async function runProbe(instance, probeSettings = {}, options = {}) {
    const send = options.send ?? sendParamFromPlugin;
    const doFetch = options.fetchImpl ?? fetchWithRetry;
    const merged = { ...instance.settings, ...probeSettings };
    let payload;
    if (!isCompleteSettings(merged)) {
      payload = { status: 'incomplete', message: '请先填写地址、用户名和密码。' };
    } else {
      const result = await doFetch(merged, { apiInfo: null, sid: null, storageApi: null }, options);
      if (result.state === 'ONLINE') {
        payload = {
          status: 'ok',
          hostname: result.system.hostname,
          model: result.system.model,
          message: `已连接 ${result.system.hostname || 'NAS'}${result.system.model ? `（${result.system.model}）` : ''}。`,
          volumes: result.volumes.map((volume) => ({
            id: volume.id,
            label: `${volume.id.replace(/^volume_/, '卷 ')} · ${formatBytes(volume.usedBytes)}/${formatBytes(volume.totalBytes)}`,
          })),
        };
      } else if (result.state === 'OFFLINE') {
        payload = { status: 'offline', message: '连不上 NAS：请确认地址、端口与网络。' };
      } else {
        payload = { status: 'error', kind: result.kind, message: `${ERROR_LABELS[result.kind] || '接口异常'}：请检查账号权限与 DSM 设置。` };
      }
    }
    send({ [PROBE_RESULT_PARAM]: payload }, instance.context);
    return payload;
  }

  // ---------------------------------------------------------------- 渲染

  function renderSynoMark(x, y, width, color) {
    // wordmark 在 24 盒内占满宽度、字形带位于 y≈8.9..13.4；
    // 以字形带底边对齐传入的 y（基线语义）。
    const scale = width / 24;
    return `<g transform="translate(${x.toFixed(2)} ${(y - 13.4 * scale).toFixed(2)}) scale(${scale.toFixed(4)})"><path d="${SYNO_MARK}" fill="${color}"/></g>`;
  }

  // 温度计字形：与 systemstatus 的温度行同款轮廓风格（20px 设计箱，描边 2）。
  function renderThermoIcon(centerY, color) {
    const common = `fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;
    return `<g data-row-icon="temperature" transform="translate(54 ${(centerY - 10).toFixed(1)})" ${common}><path d="M8 4a3 3 0 0 1 6 0v8.2a5 5 0 1 1-6 0z"/><path d="M11 7v8"/><circle cx="11" cy="16" r="2" fill="${color}" stroke="none"/></g>`;
  }

  // 硬盘/存储字形：机架轮廓 + 两道盘位线 + 指示灯，同一 20px 设计箱。
  function renderDiskIcon(centerY, color) {
    const common = `fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;
    return `<g data-row-icon="storage" transform="translate(54 ${(centerY - 10).toFixed(1)})" ${common}><rect x="1" y="3" width="18" height="14" rx="2.5"/><path d="M4 8h8M4 12h8"/><circle cx="15.5" cy="10" r="1.5" fill="${color}" stroke="none"/></g>`;
  }

  // 与 systemstatus 同构的行面板：x=44 宽 170、rx=7、panel 填充 + low 描边。
  function rowPanel(y, height, theme) {
    return `<rect x="44" y="${y.toFixed(1)}" width="170" height="${height.toFixed(1)}" rx="7" fill="${theme.panel}" opacity="0.64" stroke="${theme.low}" stroke-width="1"/>`;
  }

  // 温度历史图表：折线（默认）/柱状，画在温度行面板内。几何模式与 systemstatus 的
  // renderMetricHistory 同构，按隔离规范各自持有；纵轴刻度取 max(90, 实测峰值)。
  function renderTempChart(rawHistory, geometry, color, chartType) {
    const values = (Array.isArray(rawHistory) ? rawHistory : [])
      .map((value) => finiteNumber(value))
      .filter((value) => value != null && value >= 0)
      .slice(-TEMP_HISTORY_LIMIT);
    if (!values.length) return '';
    const { x, y, width, height } = geometry;
    const insetY = 4;
    const chartTop = y + insetY;
    const chartBottom = y + height - insetY;
    const chartHeight = Math.max(1, chartBottom - chartTop);
    const scale = Math.max(90, ...values);
    const startIndex = TEMP_HISTORY_LIMIT - values.length;
    const slotWidth = width / TEMP_HISTORY_LIMIT;

    if (chartType === 'bars') {
      const barWidth = Math.max(2, slotWidth - 2);
      const bars = values.map((value, index) => {
        const ratio = Math.max(0, Math.min(1, value / scale));
        const barHeight = Math.max(1.5, ratio * chartHeight);
        const barX = x + (startIndex + index) * slotWidth + (slotWidth - barWidth) / 2;
        return `<rect x="${barX.toFixed(1)}" y="${(chartBottom - barHeight).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="1.2" fill="${color}" opacity="0.28"/>`;
      }).join('');
      return `<g data-chart-type="bars" data-history-count="${values.length}">${bars}</g>`;
    }

    const points = values.map((value, index) => {
      const ratio = Math.max(0, Math.min(1, value / scale));
      return [x + (startIndex + index + 0.5) * slotWidth, chartBottom - ratio * chartHeight];
    });
    if (points.length === 1) {
      const [[pointX, pointY]] = points;
      return `<g data-chart-type="line" data-history-count="1"><circle cx="${pointX.toFixed(1)}" cy="${pointY.toFixed(1)}" r="2.3" fill="${color}" opacity="0.66"/></g>`;
    }
    const line = points.map(([pointX, pointY]) => `${pointX.toFixed(1)},${pointY.toFixed(1)}`).join(' ');
    const area = `${points[0][0].toFixed(1)},${chartBottom.toFixed(1)} ${line} ${points.at(-1)[0].toFixed(1)},${chartBottom.toFixed(1)}`;
    return `<g data-chart-type="line" data-history-count="${values.length}"><polygon points="${area}" fill="${color}" opacity="0.15"/><polyline points="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.64"/></g>`;
  }

  // 已用/未用与机器名共用的正文字号。18px 经排布实测：行宽 170 里
  // 图标(54..74) + 「6.5T/15.7T」(≈95px, 右锚 182) + 百分比(右锚 212) 互不重叠。
  const ROW_TEXT_SIZE = 18;

  function renderTemperatureRow(y, height, instance, theme) {
    const severity = temperatureSeverity(instance.temperature, instance.temperatureWarn);
    const color = usageColor(severity, theme);
    const valueColor = severity === 'normal' ? theme.text : color;
    const centerY = y + height / 2;
    const value = instance.temperature == null ? '--' : String(Math.round(instance.temperature));
    const chartType = normalizeChoice(instance.settings.tempChart, 'line', ['line', 'bars']);
    const chart = renderTempChart(instance.tempHistory, { x: 44, y, width: 170, height }, color, chartType);
    // 型号与温度同行：型号靠左紧跟图标，温度居右但不贴边（右锚 200，留出面板内边距）。
    const model = clipText(instance.model, 8);
    const modelText = model
      ? `<text x="78" y="${(centerY + 4.5).toFixed(1)}" text-anchor="start" fill="${theme.muted}" font-size="15" font-weight="800">${escapeXml(model)}</text>`
      : '';
    return `
      <g data-row="temperature">
        ${rowPanel(y, height, theme)}
        ${chart}
        ${renderThermoIcon(centerY, color)}
        ${modelText}
        <text x="200" y="${(centerY + 22 * 0.34).toFixed(1)}" text-anchor="end" fill="${valueColor}" font-weight="800"><tspan font-size="22">${escapeXml(value)}</tspan><tspan font-size="12" fill="${theme.muted}"> °C</tspan></text>
      </g>`;
  }

  function renderStorageRow(y, height, volume, theme) {
    const centerY = y + height / 2;
    if (!volume) {
      return `
        <g data-row="storage">
          ${rowPanel(y, height, theme)}
          <text x="128" y="${(centerY + 6).toFixed(1)}" text-anchor="middle" fill="${theme.muted}" font-size="17">无可用卷</text>
        </g>`;
    }
    const percent = usagePercent(volume);
    const severity = usageSeverity(percent);
    const color = usageColor(severity, theme);
    const valueColor = severity === 'normal' ? theme.text : color;
    const fillWidth = (168 * Math.max(0, Math.min(100, percent)) / 100).toFixed(1);
    return `
      <g data-row="storage">
        ${rowPanel(y, height, theme)}
        <rect x="45" y="${(y + 1).toFixed(1)}" width="${fillWidth}" height="${(height - 2).toFixed(1)}" rx="6" fill="${color}" opacity="0.26"/>
        ${renderDiskIcon(centerY, color)}
        <text x="78" y="${(centerY + 4.5).toFixed(1)}" text-anchor="start" fill="${theme.muted}" font-weight="700"><tspan font-size="13">${percent}</tspan><tspan font-size="11">%</tspan></text>
        <text x="212" y="${(centerY + ROW_TEXT_SIZE * 0.34).toFixed(1)}" text-anchor="end" fill="${valueColor}" font-size="${ROW_TEXT_SIZE}" font-weight="800">${escapeXml(`${formatBytes(volume.usedBytes)}/${formatBytes(volume.totalBytes)}`)}</text>
      </g>`;
  }

  function renderNasStatus(instance) {
    const settings = instance.settings;
    const theme = themeFor(settings);
    const frame = frameFor(settings);
    const background = renderThemeBackdrop(theme, theme.accent, frame);
    const state = instance.connectionState;

    // 头部与行布局对齐 systemstatus：标识基线 59，行区间 80..214。
    // 头部右上角显示机器名（亮色，右锚 214，wordmark 收在 x≈122 前，互不重叠）；
    // 型号随温度同行显示（见 renderTemperatureRow）。
    const mark = renderSynoMark(44, 59, 78, theme.text);
    const name = clipText(displayName(instance), 9);
    const nameText = name
      ? `<text x="214" y="59" text-anchor="end" fill="${theme.text}" font-size="16" font-weight="800">${escapeXml(name)}</text>`
      : '';
    const refreshFeedback = instance.refreshing
      ? `<circle data-manual-refresh-feedback="active" cx="58" cy="52" r="18" fill="${theme.accent}" opacity="0.22"/><circle cx="58" cy="52" r="16" fill="none" stroke="${theme.text}" stroke-width="1.5" opacity="0.42"/>`
      : '';

    let body = '';
    let highlight = '';
    if (state === 'CONFIG_REQUIRED') {
      body = `<text x="128" y="150" text-anchor="middle" fill="${theme.text}" font-size="34" font-weight="750">待配置</text>`
        + `<text x="128" y="184" text-anchor="middle" fill="${theme.muted}" font-size="17">打开属性面板填写连接信息</text>`;
    } else if (state === 'PENDING') {
      body = `<text x="128" y="150" text-anchor="middle" fill="${theme.text}" font-size="34" font-weight="750">连接中</text>`
        + `<text x="128" y="184" text-anchor="middle" fill="${theme.muted}" font-size="17">正在读取 NAS 状态</text>`;
    } else if (state === 'OFFLINE') {
      body = `<text x="128" y="152" text-anchor="middle" fill="${theme.muted}" font-size="38" font-weight="800">离线</text>`
        + `<text x="128" y="190" text-anchor="middle" fill="${theme.low}" font-size="17">上次在线 ${escapeXml(formatAge(instance.lastSeenAt))}</text>`;
    } else if (state === 'ERROR') {
      body = `<text x="128" y="150" text-anchor="middle" fill="${theme.crit}" font-size="36" font-weight="800">异常</text>`
        + `<text x="128" y="186" text-anchor="middle" fill="${theme.muted}" font-size="18" font-weight="600">${escapeXml(ERROR_LABELS[instance.errorKind] || '接口异常')}</text>`;
      highlight = frameHighlight(frameFor({ ...settings, frameSize: 'optimal' }), theme.crit, 0.75);
    } else {
      // 温度行 + 最多两个存储行；行高按行数均分（2 行≈64、3 行≈40.7）。
      const volumes = selectedVolumes(instance.volumes, settings);
      const storageRows = volumes.length ? volumes : [null];
      const rowCount = 1 + storageRows.length;
      const gap = 6;
      const top = 80;
      const bottom = 214;
      const rowHeight = (bottom - top - gap * (rowCount - 1)) / rowCount;
      const rows = [
        renderTemperatureRow(top, rowHeight, instance, theme),
        ...storageRows.map((volume, index) => renderStorageRow(top + (index + 1) * (rowHeight + gap), rowHeight, volume, theme)),
      ];
      body = rows.join('');
    }

    return toDataUrl(`
      <svg width="392" height="392" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg" font-family="Arial, Helvetica, sans-serif">
        ${background.outer}
        ${frameContent(frame, `
          ${highlight}
          ${refreshFeedback}
          ${mark}
          ${nameText}
          ${body}
        `)}
      </svg>`);
  }

  // ---------------------------------------------------------------- 装配

  const config = {
    defaults: {
      displayName: '',
      nasHost: '',
      nasPort: '5001',
      useHttps: 'true',
      username: '',
      password: '',
      volumeId: '',
      volumeId2: '',
      tempChart: 'line',
      pollSec: '60',
      theme: 'mint',
      frameSize: 'optimal',
      showFrame: 'true',
    },
    normalizeSettings: (settings, defaults) => ({
      displayName: cleanString(settings.displayName).slice(0, 40),
      nasHost: cleanString(settings.nasHost).slice(0, 253),
      nasPort: normalizeNumberString(settings.nasPort, defaults.nasPort, 1, 65535),
      useHttps: normalizeBooleanString(settings.useHttps, defaults.useHttps),
      username: cleanString(settings.username).slice(0, 64),
      password: cleanString(settings.password).slice(0, 128),
      volumeId: cleanString(settings.volumeId).slice(0, 32),
      volumeId2: cleanString(settings.volumeId2).slice(0, 32),
      tempChart: normalizeChoice(settings.tempChart, defaults.tempChart, ['line', 'bars']),
      pollSec: normalizeNumberString(settings.pollSec, defaults.pollSec, 15, 3600),
    }),
    createState: (instance) => ({
      connectionState: isCompleteSettings(instance.settings) ? 'PENDING' : 'CONFIG_REQUIRED',
      errorKind: null,
      temperature: null,
      temperatureWarn: false,
      tempHistory: [],
      volumes: [],
      session: { apiInfo: null, sid: null, storageApi: null },
      fetching: false,
      refreshing: false,
      pollStarted: false,
      requestId: 0,
      failureCount: 0,
      lastManualAt: 0,
      ...hydrateState(readPersistedState(instance.context)),
    }),
    onRun: (instance) => handleShortPress(instance),
    onLongPress: (instance) => handleLongPress(instance),
    onReady: (instance) => {
      if (!isCompleteSettings(instance.settings)) {
        instance.connectionState = 'CONFIG_REQUIRED';
        renderInstance(instance);
        return undefined;
      }
      // 恢复既有实例（宿主重放 add/paramFromApp）时不重复取数，轮询已在跑。
      if (instance.pollStarted) return undefined;
      instance.pollStarted = true;
      return runFetch(instance);
    },
    onSettingsChanged: (instance, previousSettings) => {
      const connectionChanged = ['nasHost', 'nasPort', 'useHttps', 'username', 'password']
        .some((key) => previousSettings[key] !== instance.settings[key]);
      if (connectionChanged) {
        resetSession(instance);
        instance.connectionState = isCompleteSettings(instance.settings) ? 'PENDING' : 'CONFIG_REQUIRED';
        clearInstanceTimeout(instance, 'nasstatusPoll');
        return runFetch(instance, { immediateRender: true });
      }
      if (previousSettings.pollSec !== instance.settings.pollSec) {
        clearInstanceTimeout(instance, 'nasstatusPoll');
        scheduleNextPoll(instance);
      }
      return undefined;
    },
    onParamFromPlugin: (instance, payload) => {
      if (payload?.[PROBE_PARAM]) {
        return runProbe(instance, payload[PROBE_PARAM]);
      }
      return undefined;
    },
    onDispose: (instance) => {
      instance.requestId += 1;
      clearInstanceTimeout(instance, 'nasstatusPoll');
      logoutBestEffort(instance);
      flushState(instance);
    },
    render: renderNasStatus,
  };

  // onDispose 只允许同步操作；logout 请求发出即弃，不等待结果。
  function logoutBestEffort(instance, options = {}) {
    const session = instance.session;
    const auth = session?.apiInfo?.auth;
    if (!session?.sid || !auth) return;
    const getJson = options.getJson ?? httpGetJson;
    try {
      getJson(`${buildBaseUrl(instance.settings)}/webapi/${auth.path}?api=SYNO.API.Auth`
        + `&version=${auth.version}&method=logout&session=${SESSION_NAME}&_sid=${encodeURIComponent(session.sid)}`,
      { timeoutMs: 2_000 }).catch(() => {});
    } catch {}
    session.sid = null;
  }

  return {
    key: 'nasstatus',
    config,
    testing: {
      nasApplyResult: applyResult,
      nasBackoffDelay: backoffDelay,
      nasBuildBaseUrl: buildBaseUrl,
      nasFetchNasStatus: fetchNasStatus,
      nasFetchWithRetry: fetchWithRetry,
      nasFormatAge: formatAge,
      nasFormatBytes: formatBytes,
      nasHandleLongPress: handleLongPress,
      nasHandleShortPress: handleShortPress,
      nasHydrateState: hydrateState,
      nasIsCompleteSettings: isCompleteSettings,
      nasParseApiInfo: parseApiInfo,
      nasParseDsmInfo: parseDsmInfo,
      nasParseVolumes: parseVolumes,
      nasPickVolume: pickVolume,
      nasRunProbe: runProbe,
      nasSelectedVolumes: selectedVolumes,
      nasTemperatureSeverity: temperatureSeverity,
      nasUsagePercent: usagePercent,
      nasUsageSeverity: usageSeverity,
    },
  };
}
