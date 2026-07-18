import http from 'node:http';
import https from 'node:https';

export function createLatencyAction(runtime) {
  const {
    clearInstanceTimeout,
    delayInstance,
    dropPersistedState,
    escapeXml,
    frameContent,
    frameFor,
    frameHighlight,
    guardAction,
    instances: INSTANCES,
    mixHex,
    normalizeChoice,
    normalizeNumberString,
    normalizeUrl,
    readPersistedState,
    renderInstance,
    renderThemeBackdrop,
    setInstanceTimeout,
    themeFor,
    toDataUrl,
    writePersistedState,
  } = runtime;

const LATENCY_HISTORY_LIMIT = 24;
const LATENCY_GRAPH_MODES = ['bars', 'line'];
const LATENCY_MANUAL_FEEDBACK_MS = 650;
// uptime 聚合：5 分钟一桶、只保留 24h（288 桶）。逐条存样本在 3s 间隔下会到 28800 条，
// 所以桶内延迟分布用固定分箱直方图压成 17 个整数——p95 精度到箱宽，对按钮上的三位数足够。
const LATENCY_BUCKET_MS = 5 * 60 * 1000;
const LATENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
const LATENCY_BUCKET_LIMIT = LATENCY_WINDOW_MS / LATENCY_BUCKET_MS;
const LATENCY_BINS = [25, 50, 75, 100, 150, 200, 300, 400, 600, 800, 1200, 1600, 2400, 3200, 5000, 8000, Infinity];
const LATENCY_STATE_VERSION = 1;
const SPEEDTEST_STATE_VERSION = 1;
const SPEEDTEST_HISTORY_MS = 7 * 24 * 60 * 60 * 1000;
const SPEEDTEST_HISTORY_LIMIT = 672;
const SPEEDTEST_CHART_POINTS = 24;
const SPEEDTEST_RESOURCE = 'network-bandwidth';
const SPEEDTEST_RETRY_MS = 60 * 1000;
const SPEEDTEST_GEO_CACHE_MS = 30 * 24 * 60 * 60 * 1000;
const SPEEDTEST_INTERVALS = ['15', '30', '60', 'manual'];
const SPEEDTEST_TIMEOUTS = ['120', '180', '240', '300'];
const SPEEDTEST_SCOPES = ['mainland', 'overseas'];
const SPEEDTEST_SELECTION_MODES = ['fixed', 'dailyRandom'];
const SPEEDTEST_CHART_TYPES = ['line', 'bar'];
// 双击窗口：单击不等待这 400ms（刷新是幂等的，先发出去），第二次按键到达时再撤销。
const LATENCY_DOUBLE_TAP_MS = 400;
const LATENCY_SSL_WARN_DAYS = 30;

function hostFromUrl(url) {
  try {
    return new URL(normalizeUrl(url, '')).hostname.replace(/^www\./, '');
  } catch {
    return 'invalid host';
  }
}

// host 超宽时中段省略：保留开头与结尾（结尾带着 TLD），比尾部截断保住更多辨识度——
// `dashboard.internal.example.com` 截成 `dashboard.inter…` 就没人认得出它是谁了。
function clipHostMiddle(value, maxLength, tail = 7) {
  const text = String(value || '');
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - tail - 1)}…${text.slice(-tail)}`;
}

const LATENCY_MAX_REDIRECTS = 3;

// 专用 agent，禁用 TLS 会话缓存：默认 agent 会按 host 复用 TLS session，恢复的
// 会话里服务器不重发证书、getPeerCertificate() 返回空对象——一旦 certExpiresAt
// 被清（恢复默认、改 URL），之后的探测就永远补不回证书。每次完整握手还让延迟
// 口径一致：测的都是"冷访客"的真实首连成本，而不是快慢混杂的会话恢复。
const LATENCY_TLS_AGENT = new https.Agent({ maxCachedSessions: 0 });

// 单跳探测。延迟计到响应头到达为止（不含响应体），拿到头就 destroy 连接：
// 监控只关心“站点是否响应、多快响应”，把首页正文每 30 秒下载一遍纯属浪费带宽。
function requestHop(url, timeoutMs, deadlineAt) {
  return new Promise((resolve) => {
    const client = url.protocol === 'http:' ? http : https;
    const started = Date.now();
    const budget = Math.max(1, Math.min(timeoutMs, deadlineAt - started));
    let settled = false;
    const finish = (payload) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(payload);
    };

    const request = client.request(
      url,
      {
        method: 'GET',
        timeout: budget,
        agent: url.protocol === 'https:' ? LATENCY_TLS_AGENT : undefined,
        headers: {
          'user-agent': 'LexUtilityLatency/0.2.0',
          accept: '*/*',
        },
      },
      (response) => {
        const ms = Date.now() - started;
        const code = response.statusCode || 0;
        // 证书只在 https 跳有意义，且必须在 destroy 之前从 socket 上取。
        const cert = url.protocol === 'https:'
          ? peerCertExpiry(response.socket)
          : null;
        const location = response.headers?.location || '';
        // 必须先 finish 再 destroy：中止连接会同步触发 request 的 'error'，
        // 若顺序反了，那个 ECONNRESET 会抢先 settle 成 network 错误，把这次成功的探测吃掉。
        finish({ ms, code, cert, location });
        response.destroy();
        request.destroy();
      },
    );

    request.on('timeout', () => {
      request.destroy();
      finish({ ms: Date.now() - started, code: 0, error: 'timeout' });
    });

    request.on('error', () => {
      finish({ ms: Date.now() - started, code: 0, error: 'network' });
    });

    request.end();
  });
}

function peerCertExpiry(socket) {
  try {
    const cert = socket?.getPeerCertificate?.();
    if (!cert || !cert.valid_to) {
      return null;
    }
    const expiresAt = Date.parse(cert.valid_to);
    return Number.isFinite(expiresAt) ? expiresAt : null;
  } catch {
    return null;
  }
}

// 跟随重定向到最终状态码：监控的问题是“这个站还活着吗”，不是“这个 URL 返回了什么”。
// 一个 301 到抢注域名的站点不该显示为正常。延迟只记第一跳——那是用户实际感知到的
// 首字节时间，把多跳累加会让数字随重定向链长度漂移而失去可比性。
// 证书同样只取第一跳（用户配置的那个 host），重定向目标的证书不是他要监控的对象。
async function checkUrl(rawUrl, timeoutMs, options = {}) {
  const maxRedirects = options.maxRedirects ?? LATENCY_MAX_REDIRECTS;
  const hop = options.requestHop ?? requestHop;
  let url;
  try {
    url = new URL(normalizeUrl(rawUrl, ''));
  } catch {
    return { ok: false, ms: 0, code: 0, error: 'bad_url' };
  }

  const deadlineAt = Date.now() + timeoutMs;
  let firstMs = null;
  let cert = null;

  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const hopResult = await hop(url, timeoutMs, deadlineAt);
    if (firstMs === null) {
      firstMs = hopResult.ms;
      cert = hopResult.cert ?? null;
    }
    const ms = firstMs;

    if (hopResult.error) {
      return { ok: false, ms, code: 0, error: hopResult.error, cert };
    }

    const { code, location } = hopResult;
    const isRedirect = code >= 300 && code < 400 && location;
    if (!isRedirect) {
      return { ok: code >= 200 && code < 400, ms, code, cert };
    }
    if (redirects === maxRedirects) {
      return { ok: false, ms, code, error: 'too_many_redirects', cert };
    }
    try {
      url = new URL(location, url);
    } catch {
      return { ok: false, ms, code, error: 'bad_redirect', cert };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, ms, code, error: 'bad_redirect', cert };
    }
    if (Date.now() >= deadlineAt) {
      return { ok: false, ms, code: 0, error: 'timeout', cert };
    }
  }
  return { ok: false, ms: firstMs ?? 0, code: 0, error: 'too_many_redirects', cert };
}


function buildLatencySeries(instance, warnMs, accent) {
  const history = instance.recent || [];
  // 纵向刻度锚定在告警阈值附近并固定下来：单个尖峰/超时只会被钳到柱顶，
  // 不会反过来把整条基线上的正常柱子重新压扁（这正是之前“显示不正常”的根因）。
  const maxMs = Math.max(warnMs * 1.5, 150);

  // 横向布局：把柱子收敛在基线宽度（startX → endX）内，按历史上限分配槽位，
  // 这样柱宽稳定、从左往右增长，满历史时也不会越过右边缘。
  const startX = 42;
  const endX = 214;
  const chartBottom = 190;
  const chartHeight = 36;
  const slotCount = LATENCY_HISTORY_LIMIT;
  const step = (endX - startX) / slotCount;
  const gap = step * 0.22;
  const barWidth = step - gap;
  const points = [];
  let bars = '';

  const barGeometry = (entry, index) => {
    const x = startX + index * step;
    const value = entry.ok ? entry.ms : maxMs;
    // sqrt 曲线放大低延迟段，让 40ms / 120ms 这类正常值也能拉开高度差。
    const ratio = Math.sqrt(Math.min(1, value / maxMs));
    const height = Math.max(4, ratio * chartHeight);
    const y = chartBottom - height;
    // 颜色随每根柱自己的延迟连续变热（accent→琥珀），而不是只在越过阈值时
    // 二值跳变——高度差在 36px 图表里不够醒目，颜色补上这个信息。失败恒为红。
    const fill = !entry.ok
      ? '#ef4444'
      : entry.ms > warnMs
        ? '#f59e0b'
        : mixHex(accent, '#f59e0b', Math.min(1, entry.ms / warnMs));
    return { x, y, height, fill };
  };

  history.forEach((entry, index) => {
    const { x, y, height, fill } = barGeometry(entry, index);
    bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${height.toFixed(1)}" rx="2" fill="${fill}" opacity="0.98"/>`;
    points.push(`${(x + barWidth / 2).toFixed(1)},${y.toFixed(1)}`);
  });

  return {
    bars,
    line: points.length > 1
      ? `<polyline points="${points.join(' ')}" fill="none" stroke="${accent}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>`
      : '',
    dots: history.map((entry, index) => {
      const { x, y, fill } = barGeometry(entry, index);
      return `<circle cx="${(x + barWidth / 2).toFixed(1)}" cy="${y.toFixed(1)}" r="2.3" fill="${fill}"/>`;
    }).join(''),
  };
}

// 观测时长自报家门：标签写的是实际观测到多久，而不是名义上的 24h 窗口。
// 宿主常关意味着窗口大概率只被填满一部分，硬写「24h」就是在撒谎。
function formatObservedSpan(observedMs) {
  if (!observedMs) {
    return '';
  }
  const minutes = Math.round(observedMs / 60_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  return `${Math.round(observedMs / 3_600_000)}h`;
}

function formatUptimeLabel(stats) {
  if (stats.uptime == null) {
    return '--';
  }
  const span = formatObservedSpan(stats.observedMs);
  // 99.95 不应该显示成 100%——那会把一次真实的宕机抹掉。只有真正无失败才是 100。
  const value = stats.uptime === 100
    ? '100'
    : Math.min(99.9, Math.floor(stats.uptime * 10) / 10).toFixed(1);
  return span ? `${span} ${value}%` : `${value}%`;
}

function sslDaysLeft(certExpiresAt, now = Date.now()) {
  if (!Number.isFinite(certExpiresAt)) {
    return null;
  }
  return Math.floor((certExpiresAt - now) / 86_400_000);
}

// SSL 徽标：正常时 `SSL` + 绿点（光秃秃一个绿点说不清自己是什么），进入提醒
// 阈值（settings.sslWarnDays，默认 30 天）换成 `SSL xxd` 并变黄/红；非 https 不出现。
function renderSslBadge(certExpiresAt, theme, warnDays = LATENCY_SSL_WARN_DAYS, now = Date.now()) {
  const days = sslDaysLeft(certExpiresAt, now);
  if (days == null) {
    return '';
  }
  // 字号与圆点尺寸对齐左侧「延迟」标题（20px / r7），两端视觉重量一致。
  if (days > warnDays) {
    return `
      <text x="196" y="69" text-anchor="end" fill="#22c55e" font-size="20" font-weight="800" font-family="Arial, Helvetica, sans-serif">SSL</text>
      <circle cx="207" cy="62" r="7" fill="#22c55e"/>`;
  }
  const color = days <= 7 ? '#ef4444' : '#f59e0b';
  const label = days <= 0 ? 'SSL !' : `SSL ${days}d`;
  return `<text x="214" y="69" text-anchor="end" fill="${color}" font-size="20" font-weight="800" font-family="Arial, Helvetica, sans-serif">${escapeXml(label)}</text>`;
}

function renderLatencyIcon(instance) {
  const theme = themeFor(instance.settings);
  const frame = frameFor(instance.settings);
  const background = renderThemeBackdrop(theme, theme.accent, frame);
  const host = hostFromUrl(instance.settings.url);
  const warnMs = Number.parseInt(instance.settings.warnMs, 10) || 400;
  const status = instance.paused ? 'paused' : instance.status || 'checking';
  const accent =
    status === 'down' ? '#ef4444'
    : status === 'slow' ? '#f59e0b'
    : status === 'up' ? theme.accent
    : theme.muted;
  const bigText =
    status === 'paused' ? 'Pause'
    : status === 'down' ? 'DOWN'
    : status === 'checking' ? '...'
    : instance.lastMs == null ? '...'
    : String(instance.lastMs);
  const headerText =
    status === 'paused' ? '暂停'
    : status === 'down' ? '离线'
    : status === 'slow' ? '偏高'
    : status === 'up' ? '延迟'
    : '检查';
  const stats = latencyStats(instance);
  const hostLabel = clipHostMiddle(host, 19);
  // 图表基色固定用主题 accent：历史柱描述的是各自当时的延迟，不随「当前状态」整体染色
  // ——否则一次 down 会把整段正常历史都涂成红的。
  const chart = buildLatencySeries(instance, warnMs, theme.accent);
  const graphSvg = instance.settings.graphMode === 'line'
    ? `${chart.line}${chart.dots}`
    : chart.bars;
  const uptimeLabel = formatUptimeLabel(stats);
  const p95Label = stats.p95 == null ? '' : `p95 ${stats.p95}`;
  // Pause / DOWN 是词不是数值，跟 ms 单位并排没有意义，居中独占主区。
  const numeric = status !== 'paused' && status !== 'down';
  const valueFontSize = bigText.length >= 4 ? 42 : 50;

  return toDataUrl(`
    <svg width="392" height="392" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
      ${background.outer}
      ${status === 'down' ? frameHighlight(frame, '#ef4444') : ''}
      ${
        frameContent(frame, `
          <circle cx="58" cy="62" r="7" fill="${accent}"/>
          <text x="72" y="69" fill="${accent}" font-size="20" font-weight="800" font-family="Arial, Helvetica, sans-serif">${escapeXml(headerText)}</text>
          ${renderSslBadge(instance.certExpiresAt, theme, Number.parseInt(instance.settings.sslWarnDays, 10) || LATENCY_SSL_WARN_DAYS)}
          <text x="128" y="90" text-anchor="middle" fill="${background.muted}" font-size="16" font-family="Arial, Helvetica, sans-serif">${escapeXml(hostLabel)}</text>
          ${
            numeric
              ? `<text x="122" y="136" text-anchor="middle" fill="${background.text}" font-size="${valueFontSize}" font-weight="800" font-family="Arial, Helvetica, sans-serif">${escapeXml(bigText)}</text>
                 <text x="${bigText.length >= 4 ? 183 : 176}" y="136" fill="${background.muted}" font-size="25" font-weight="800" font-family="Arial, Helvetica, sans-serif">ms</text>`
              : `<text x="128" y="136" text-anchor="middle" fill="${status === 'down' ? '#ef4444' : background.muted}" font-size="38" font-weight="800" font-family="Arial, Helvetica, sans-serif">${escapeXml(bigText)}</text>`
          }
          <line x1="42" y1="190" x2="214" y2="190" stroke="${background.low}" stroke-width="1.5" opacity="0.55"/>
          ${graphSvg}
          <text x="44" y="212" fill="${accent}" font-size="17" font-weight="800" font-family="Arial, Helvetica, sans-serif">${escapeXml(uptimeLabel)}</text>
          <text x="214" y="212" text-anchor="end" fill="${background.low}" font-size="17" font-weight="800" font-family="Arial, Helvetica, sans-serif">${escapeXml(p95Label)}</text>
        `)
      }
    </svg>
  `);
}

function latencyBinIndex(ms) {
  for (let i = 0; i < LATENCY_BINS.length; i += 1) {
    if (ms <= LATENCY_BINS[i]) {
      return i;
    }
  }
  return LATENCY_BINS.length - 1;
}

function bucketStartAt(timestamp) {
  return Math.floor(timestamp / LATENCY_BUCKET_MS) * LATENCY_BUCKET_MS;
}

function emptyBucket(t) {
  return { t, ok: 0, fail: 0, bins: new Array(LATENCY_BINS.length).fill(0) };
}

// 只保留窗口内的桶。桶按 t 升序，且仅在有探测时才存在——这正是「实际观测时长」的来源。
function pruneLatencyBuckets(buckets, now) {
  const cutoff = bucketStartAt(now) - LATENCY_WINDOW_MS + LATENCY_BUCKET_MS;
  return buckets.filter((bucket) => bucket.t >= cutoff).slice(-LATENCY_BUCKET_LIMIT);
}

function pruneLatencyRecent(recent, now) {
  const cutoff = now - LATENCY_WINDOW_MS;
  return recent.filter((entry) => entry.t >= cutoff).slice(-LATENCY_HISTORY_LIMIT);
}

// 返回是否发生了桶滚动——滚动是运行态落盘的语义边界，避免逐次探测就写盘。
function recordLatencySample(instance, result, now = Date.now()) {
  const t = bucketStartAt(now);
  const buckets = pruneLatencyBuckets(instance.buckets || [], now);
  const last = buckets[buckets.length - 1];
  const rolled = !last || last.t !== t;
  const bucket = rolled ? emptyBucket(t) : last;
  if (rolled) {
    buckets.push(bucket);
  }

  if (result.ok) {
    bucket.ok += 1;
    bucket.bins[latencyBinIndex(result.ms)] += 1;
  } else {
    bucket.fail += 1;
  }

  instance.buckets = pruneLatencyBuckets(buckets, now);
  instance.recent = pruneLatencyRecent(
    [...(instance.recent || []), { t: now, ok: Boolean(result.ok), ms: result.ms }],
    now,
  );
  return rolled;
}

// uptime 的分母只有实际观测到的探测数：宿主关着的时段既不算正常也不算宕机，
// 而是根本没被观测到。observedMs 让按钮把这个事实说出来，而不是用「24h」撒谎。
function latencyStats(instance, now = Date.now()) {
  const buckets = pruneLatencyBuckets(instance.buckets || [], now);
  let ok = 0;
  let fail = 0;
  const bins = new Array(LATENCY_BINS.length).fill(0);
  for (const bucket of buckets) {
    ok += bucket.ok || 0;
    fail += bucket.fail || 0;
    for (let i = 0; i < bins.length; i += 1) {
      bins[i] += bucket.bins?.[i] || 0;
    }
  }
  const checks = ok + fail;
  return {
    checks,
    uptime: checks ? (ok / checks) * 100 : null,
    observedMs: buckets.length * LATENCY_BUCKET_MS,
    p95: percentileFromBins(bins, 0.95),
  };
}

// 取分箱上沿作为 p95：宁可略微高报延迟，也不要让一个监控指标显得比实际乐观。
function percentileFromBins(bins, percentile) {
  const total = bins.reduce((sum, count) => sum + count, 0);
  if (!total) {
    return null;
  }
  const target = Math.ceil(percentile * total);
  let seen = 0;
  for (let i = 0; i < bins.length; i += 1) {
    seen += bins[i];
    if (seen >= target) {
      const edge = LATENCY_BINS[i];
      return Number.isFinite(edge) ? edge : LATENCY_BINS[i - 1];
    }
  }
  return null;
}

function serializeLatencyState(instance) {
  return {
    v: LATENCY_STATE_VERSION,
    paused: Boolean(instance.paused),
    buckets: instance.buckets || [],
    recent: instance.recent || [],
    certExpiresAt: instance.certExpiresAt ?? null,
  };
}

// 历史读不到就当没有——它是增益不是前置条件，绝不能因为存储损坏让按钮报错。
function hydrateLatencyState(raw, now = Date.now()) {
  const valid = raw && typeof raw === 'object' && raw.v === LATENCY_STATE_VERSION;
  const buckets = valid && Array.isArray(raw.buckets)
    ? raw.buckets.filter((bucket) => bucket && Number.isFinite(bucket.t) && Array.isArray(bucket.bins))
    : [];
  const recent = valid && Array.isArray(raw.recent)
    ? raw.recent.filter((entry) => entry && Number.isFinite(entry.t) && Number.isFinite(entry.ms))
    : [];
  return {
    paused: valid ? Boolean(raw.paused) : false,
    buckets: pruneLatencyBuckets(buckets, now),
    recent: pruneLatencyRecent(recent, now),
    certExpiresAt: valid && Number.isFinite(raw.certExpiresAt) ? raw.certExpiresAt : null,
  };
}

function flushLatencyState(instance, options = {}) {
  const write = options.write ?? writePersistedState;
  return write(instance.context, serializeLatencyState(instance));
}

function clearLatencyTimer(instance) {
  clearInstanceTimeout(instance, 'latency');
}

function scheduleLatencyCheck(instance) {
  const intervalSec = Number.parseInt(instance.settings.intervalSec, 10) || 15;
  setInstanceTimeout(instance, 'latency', () => runLatencyCheck(instance), intervalSec * 1000);
}

function isInstanceCurrent(instance, requestId, instances = INSTANCES) {
  return instances.get(instance.context) === instance && requestId === instance.requestId;
}

function commitLatencyResult(instance, result, options = {}) {
  const {
    requestId,
    feedbackCompleted = true,
    instances = INSTANCES,
    warnMs = Number.parseInt(instance.settings.warnMs, 10) || 400,
    render = renderInstance,
    schedule = scheduleLatencyCheck,
  } = options;
  if (!feedbackCompleted || !isInstanceCurrent(instance, requestId, instances)) {
    return false;
  }
  const now = options.now ?? Date.now();
  const flush = options.flush ?? flushLatencyState;
  instance.checking = false;
  instance.lastMs = result.ok ? result.ms : null;
  if (Number.isFinite(result.cert)) {
    instance.certExpiresAt = result.cert;
  }
  instance.status = !result.ok ? 'down' : result.ms > warnMs ? 'slow' : 'up';
  // 桶滚动才落盘：每 5 分钟一次，而不是每次探测一次。进行中的桶靠 onDispose 补 flush。
  const rolled = recordLatencySample(instance, result, now);
  if (rolled) {
    flush(instance);
  }
  render(instance);
  schedule(instance);
  return true;
}

// 宿主协议只有单一 `run` 事件，没有按下/抬起分离，因此长按无法实现（见 constants.js）。
// 双击代之：单击不等待窗口关闭就立刻刷新——刷新是幂等且无副作用的，先发出去；
// 若 400ms 内第二次按键到达，再把它作废并转成 Pause。这样单击零延迟，代价只是
// 进入 Pause 时浪费一次探测请求。
function handleLatencyTap(instance, options = {}) {
  const now = options.now ?? Date.now();
  const run = options.run ?? runLatencyCheck;
  const render = options.render ?? renderInstance;
  const flush = options.flush ?? flushLatencyState;
  const doubleTapMs = options.doubleTapMs ?? LATENCY_DOUBLE_TAP_MS;

  const previousTapAt = instance.lastTapAt ?? 0;
  instance.lastTapAt = now;

  if (now - previousTapAt < doubleTapMs) {
    // 第二击：作废刚发出的那次刷新（提升 requestId 让它的结果被 isInstanceCurrent 丢弃）。
    instance.lastTapAt = 0;
    instance.requestId += 1;
    instance.checking = false;
    clearLatencyTimer(instance);
    clearInstanceTimeout(instance, 'latencyFeedback');
    instance.paused = !instance.paused;
    if (instance.paused) {
      instance.status = 'paused';
      instance.lastMs = null;
      flush(instance);
      render(instance);
      return undefined;
    }
    // 从 Pause 退出走的是与单击相同的路径：立即刷新并恢复轮询。
    flush(instance);
    return run(instance, { immediateRender: true, minDisplayMs: LATENCY_MANUAL_FEEDBACK_MS, forceFeedback: true });
  }

  if (instance.paused) {
    instance.paused = false;
    flush(instance);
  }
  return run(instance, { immediateRender: true, minDisplayMs: LATENCY_MANUAL_FEEDBACK_MS, forceFeedback: true });
}

async function runLatencyCheck(instance, options = {}) {
  const {
    immediateRender = false,
    minDisplayMs = 0,
    forceFeedback = false,
  } = options;

  if (!instance) {
    return;
  }
  if (instance.checking) {
    if (forceFeedback) {
      instance.status = 'checking';
      instance.lastMs = null;
      renderInstance(instance);
    }
    return;
  }

  instance.checking = true;
  instance.status = 'checking';
  instance.lastMs = null;
  instance.requestId += 1;
  const requestId = instance.requestId;
  const startedAt = Date.now();
  if (immediateRender) {
    renderInstance(instance);
  }

  const timeoutMs = Number.parseInt(instance.settings.timeoutMs, 10) || 4000;
  const warnMs = Number.parseInt(instance.settings.warnMs, 10) || 400;
  const result = await checkUrl(instance.settings.url, timeoutMs);

  if (!isInstanceCurrent(instance, requestId)) {
    return;
  }

  const remainingFeedbackMs = minDisplayMs - (Date.now() - startedAt);
  let feedbackCompleted = true;
  if (remainingFeedbackMs > 0) {
    feedbackCompleted = await delayInstance(instance, 'latencyFeedback', remainingFeedbackMs);
  }

  commitLatencyResult(instance, result, { requestId, feedbackCompleted, warnMs });
}


const config = {
    defaults: {
      url: 'https://example.com',
      intervalSec: '30',
      warnMs: '800',
      timeoutMs: '8000',
      sslWarnDays: '30',
      theme: 'signal',
      frameSize: 'optimal',
      showFrame: 'true',
      graphMode: 'bars',
    },
    normalizeSettings: (settings, defaults) => ({
      url: normalizeUrl(settings.url, defaults.url),
      intervalSec: normalizeNumberString(settings.intervalSec, defaults.intervalSec, 3, 3600),
      warnMs: normalizeNumberString(settings.warnMs, defaults.warnMs, 50, 10000),
      timeoutMs: normalizeNumberString(settings.timeoutMs, defaults.timeoutMs, 500, 30000),
      sslWarnDays: normalizeNumberString(settings.sslWarnDays, defaults.sslWarnDays, 1, 365),
      graphMode: normalizeChoice(settings.graphMode, defaults.graphMode, LATENCY_GRAPH_MODES),
    }),
    createState: (instance) => ({
      lastMs: null,
      status: 'checking',
      checking: false,
      requestId: 0,
      // 历史跨重启水合：24h uptime 的全部意义就在于此，重建实例不能把它清零。
      ...hydrateLatencyState(readPersistedState(instance.context)),
    }),
    onRun: (instance) => handleLatencyTap(instance),
    onReady: (instance) => {
      if (instance.paused) {
        return undefined;
      }
      scheduleLatencyCheck(instance);
      if (!instance.recent.length && !instance.checking) {
        return runLatencyCheck(instance, { immediateRender: true });
      }
      return undefined;
    },
    onSettingsChanged: (instance, previousSettings) => {
      // 换 URL 意味着监控对象变了，历史与证书都不再属于它，必须连同落盘的记录一起丢弃；
      // 只改间隔/阈值/超时则是同一个对象的观测方式变化，历史继续有效。
      const targetChanged = previousSettings.url !== instance.settings.url;
      const probeChanged =
        targetChanged ||
        previousSettings.intervalSec !== instance.settings.intervalSec ||
        previousSettings.timeoutMs !== instance.settings.timeoutMs;
      if (targetChanged) {
        instance.buckets = [];
        instance.recent = [];
        instance.certExpiresAt = null;
        dropPersistedState(instance.context);
      }
      // 仅 warnMs / 主题这类纯展示项变化时无需重探——框架会在钩子返回后统一渲染。
      if (!probeChanged) {
        return;
      }
      instance.lastMs = null;
      instance.status = 'checking';
      clearLatencyTimer(instance);
      instance.checking = false;
      guardAction(instance, 'ready', () => config.onReady?.(instance));
    },
    onDispose: (instance) => {
      flushLatencyState(instance);
    },
    render: (instance) => renderLatencyIcon(instance),
  };

  return {
    key: 'latency',
    config,
    testing: {
      checkUrl,
      commitLatencyResult,
      formatUptimeLabel,
      handleLatencyTap,
      hydrateLatencyState,
      latencyStats,
      recordLatencySample,
      sslDaysLeft,
    },
  };
}
