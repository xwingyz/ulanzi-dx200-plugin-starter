import { spawn } from 'node:child_process';

export function createDeepSeekUsageAction(runtime) {
  const {
    clearInstanceTimeout,
    escapeXml,
    frameContent,
    frameFor,
    instances: INSTANCES,
    normalizeNumberString,
    normalizeUrl,
    readPersistedState,
    renderInstance,
    renderMeterRow,
    renderThemeBackdrop,
    sendParamFromPlugin,
    setInstanceTimeout,
    t,
    themeFor,
    toDataUrl,
    writePersistedState,
  } = runtime;

  const BALANCE_ENDPOINT = 'https://api.deepseek.com/user/balance';
  const REQUEST_TIMEOUT_MS = 12_000;
  const MANUAL_COOLDOWN_MS = 10_000;
  const OPEN_URL_COOLDOWN_MS = 2_000;
  const STATE_VERSION = 1;

  const WINDOW_24H_MS = 24 * 60 * 60 * 1000;
  const WINDOW_7D_MS = 7 * WINDOW_24H_MS;

  // 环形事件表的硬上限。正常节奏（300s 轮询、只在余额变化时记一条）一周远低于此值，
  // 这道闸只防御「轮询被调到 60s + 每次都有消费」的极端配置把持久化文件撑大。
  const MAX_EVENTS = 2000;

  // 品牌色：DeepSeek 标记的身份标识，固定不随主题。主题走 ice（青），让蓝色标记
  // 在键盘上与已占用 signal 的三个网络类 action 拉开距离。
  const BRAND_DEEPSEEK = '#4D6BFE';

  // DeepSeek 官方标记（鲸鱼），viewBox 0 0 24 24，取自 simple-icons。
  // 商标属于 DeepSeek，此处仅用于指代其产品。
  const DEEPSEEK_MARK = 'M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358a1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45';

  // 货币后缀。必须放在数字之后：renderMeterRow 的 numeric() 用 /^(-?[\d.]+)(.*)$/
  // 分栏，前缀符号会让整串掉进「无数字」分支被排成小字号。
  const CURRENCY_UNITS = { CNY: '元', USD: '$' };

  // ---------------------------------------------------------------- 设置归一化

  function cleanString(value) {
    return String(value ?? '').trim();
  }

  // 金额设置允许小数与留空。留空 = 关闭该项（预算不画条 / 阈值不告警），
  // 所以不能像 normalizeNumberString 那样在非法输入时回落到默认值——
  // 用户主动清空是一个有意义的指令，不该被默认值悄悄覆盖。
  function normalizeAmountString(value, fallback, max = 1_000_000) {
    const raw = cleanString(value);
    if (raw === '') {
      return '';
    }
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return String(fallback);
    }
    return String(Math.min(max, Math.round(parsed * 100) / 100));
  }

  function amountOf(value) {
    const parsed = Number.parseFloat(cleanString(value));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  // ---------------------------------------------------------------- 取数

  function parseBalance(payload, preferred = 'CNY') {
    const infos = Array.isArray(payload?.balance_infos) ? payload.balance_infos : [];
    // 只认 CNY；账户若只挂了别的币种就退回数组首项，量纲跟着走，不做任何汇率换算。
    const hit = infos.find((item) => item?.currency === preferred) || infos[0];
    if (!hit || typeof hit !== 'object') {
      return null;
    }
    const total = Number.parseFloat(hit.total_balance);
    if (!Number.isFinite(total)) {
      return null;
    }
    return {
      balance: total,
      currency: typeof hit.currency === 'string' && hit.currency ? hit.currency : preferred,
      // 官方的硬信号：余额是否还够发起调用。它先于任何本地阈值决定 crit。
      isAvailable: payload?.is_available !== false,
    };
  }

  async function fetchBalance(apiKey, options = {}) {
    const doFetch = options.fetchImpl ?? fetch;
    const key = cleanString(apiKey);
    if (!key) {
      return { ok: false, kind: 'NO_KEY' };
    }

    let response;
    try {
      response = await doFetch(BALANCE_ENDPOINT, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${key}`,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, kind: 'NETWORK' };
    }

    if (response.status === 401 || response.status === 403) {
      return { ok: false, kind: 'AUTH' };
    }
    if (response.status === 429) {
      return { ok: false, kind: 'RATE_LIMITED' };
    }
    if (!response.ok) {
      return { ok: false, kind: 'NETWORK' };
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      return { ok: false, kind: 'NETWORK' };
    }

    const data = parseBalance(payload, options.currency);
    if (!data) {
      // 响应结构变了。降级成普通失败，不崩在框架边界上。
      return { ok: false, kind: 'NETWORK' };
    }
    return { ok: true, data };
  }

  // ---------------------------------------------------------------- 记账

  // 一条事件代表一个「被两次采样夹住的区间」及其净消费额：{ a: 区间起, b: 区间止, d: 消费 }。
  // 记区间而不是时刻，是因为窗口边界可能落在区间内部——只有知道区间跨度才能按重叠比例切。
  // 采样间隔内的钱花在哪一秒是不可知的（API 只给瞬时余额，不给流水），按比例切是这份
  // 无知下唯一不偏袒任何一端的处理。
  function recordSample(instance, balance, nowMs) {
    const previous = instance.lastBalance;
    if (Number.isFinite(previous) && Number.isFinite(instance.lastSampleAt)) {
      const delta = previous - balance;
      // 上涨 = 充值，从消费中剔除。已知漏洞：同一区间内若既充值又消费，净上涨会
      // 掩盖那段消费——API 拿不到流水就补不上，只能靠 PI 的「清空历史」兜底。
      if (delta > 0) {
        instance.events.push({ a: instance.lastSampleAt, b: nowMs, d: delta });
      }
    } else {
      instance.firstSampleAt = nowMs;
    }
    instance.lastBalance = balance;
    instance.lastSampleAt = nowMs;
    pruneEvents(instance, nowMs);
  }

  // 完全落在 7d 窗口之外的事件才丢；跨边界的留着，交给 sumWindow 去切。
  function pruneEvents(instance, nowMs) {
    const cutoff = nowMs - WINDOW_7D_MS;
    let events = instance.events.filter((event) => event.b > cutoff);
    if (events.length > MAX_EVENTS) {
      events = events.slice(events.length - MAX_EVENTS);
    }
    instance.events = events;
    return events;
  }

  function sumWindow(events, fromMs, toMs) {
    let sum = 0;
    for (const event of events) {
      const low = Math.max(event.a, fromMs);
      const high = Math.min(event.b, toMs);
      if (high <= low) {
        continue;
      }
      const span = event.b - event.a;
      // span 为 0 是同一毫秒内的两次采样：没有比例可分，整笔计入。
      sum += span > 0 ? (event.d * (high - low)) / span : event.d;
    }
    return sum;
  }

  // 覆盖率 = 窗口内「已被采样区间夹住」的时长占比。注意关机时段算作已覆盖：
  // 前后两次采样把它夹住了，金额是已知的，未知的只是钱在其中的分布。
  // 真正未覆盖的只有两段：第一次采样之前，以及最后一次采样之后（拉取持续失败时会
  // 逐渐扩大——这正是我们希望 tail 亮起来的时候）。
  function coverageRatio(instance, windowMs, nowMs) {
    if (!Number.isFinite(instance.firstSampleAt) || !Number.isFinite(instance.lastSampleAt)) {
      return 0;
    }
    const from = nowMs - windowMs;
    const start = Math.max(instance.firstSampleAt, from);
    const end = Math.min(instance.lastSampleAt, nowMs);
    const covered = Math.max(0, end - start);
    return windowMs > 0 ? Math.max(0, Math.min(1, covered / windowMs)) : 0;
  }

  // 还没有任何被夹住的区间 → 消费额无从谈起，显示 `--` 而不是 `0`（`0` 是在说谎）。
  function hasSpendData(instance) {
    return Number.isFinite(instance.firstSampleAt)
      && Number.isFinite(instance.lastSampleAt)
      && instance.lastSampleAt > instance.firstSampleAt;
  }

  function clearHistory(instance) {
    instance.events = [];
    instance.firstSampleAt = null;
    instance.lastSampleAt = null;
    instance.lastBalance = null;
    return instance;
  }

  // ---------------------------------------------------------------- 排版

  // 自适应有效数字：三个数字跨度极大（24h 可能是 0.03，余额可能是 480），固定小数位
  // 没法同时伺候两头。位宽恒定在 3–4 个数字字符，value 栏（约 96px 与 label 共享）不会溢出。
  function formatAmount(value, currency) {
    const unit = CURRENCY_UNITS[currency] || currency || '';
    const abs = Math.abs(value);
    let text;
    if (abs >= 100) {
      text = String(Math.round(value));
    } else if (abs >= 10) {
      text = value.toFixed(1);
    } else {
      text = value.toFixed(2);
    }
    return `${text}${unit}`;
  }

  function balanceSeverity(balance, isAvailable, warnAt, critAt) {
    if (!isAvailable) {
      return 'critical';
    }
    if (critAt != null && balance < critAt) {
      return 'critical';
    }
    if (warnAt != null && balance < warnAt) {
      return 'warning';
    }
    return 'normal';
  }

  // 预算行：超支即 crit（条已经 clamp 在满格，颜色是「超了」的唯一信号），
  // 75% 起 warn，与 claudeusage / chatgptusage 的 75 档对齐。
  function spendSeverity(percent) {
    if (percent == null) {
      return 'normal';
    }
    if (percent >= 100) {
      return 'critical';
    }
    if (percent >= 75) {
      return 'warning';
    }
    return 'normal';
  }

  function severityColor(severity, theme) {
    if (severity === 'critical') {
      return theme.crit;
    }
    if (severity === 'warning') {
      return theme.warn;
    }
    return theme.ok;
  }

  function renderMark(x, y, size, color) {
    const scale = size / 24;
    return `<g transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${scale.toFixed(4)})"><path d="${DEEPSEEK_MARK}" fill="${color}"/></g>`;
  }

  const ERROR_COPY = {
    NO_KEY: { glyph: 'key', text: 'Set API key' },
    AUTH: { glyph: 'bang', text: 'Bad key' },
    NETWORK: { glyph: 'offline', text: 'Offline' },
    RATE_LIMITED: { glyph: 'wait', text: 'Slow down' },
    PENDING: { glyph: 'none', text: '' },
  };

  // 每种错误一个独立字形：键面上不区分原因的话，「要不要动手」这个判断就得跑去开 PI。
  // 与 claudeusage 同构但各自持有——按进程内隔离规范，action 之间不借用彼此的私有渲染件。
  function renderErrorGlyph(glyph, cx, cy, color) {
    switch (glyph) {
      case 'key':
        return `<circle cx="${cx - 8}" cy="${cy}" r="7" fill="none" stroke="${color}" stroke-width="4"/>`
          + `<rect x="${cx - 2}" y="${cy - 2}" width="20" height="4" fill="${color}"/>`
          + `<rect x="${cx + 12}" y="${cy}" width="4" height="7" fill="${color}"/>`;
      case 'bang':
        return `<rect x="${cx - 3}" y="${cy - 14}" width="6" height="18" rx="2" fill="${color}"/>`
          + `<circle cx="${cx}" cy="${cy + 10}" r="4" fill="${color}"/>`;
      case 'offline':
        return `<path d="M ${cx - 16} ${cy + 4} A 22 22 0 0 1 ${cx + 16} ${cy + 4}" fill="none" stroke="${color}" stroke-width="4" opacity="0.5"/>`
          + `<path d="M ${cx - 8} ${cy + 12} A 11 11 0 0 1 ${cx + 8} ${cy + 12}" fill="none" stroke="${color}" stroke-width="4"/>`
          + `<line x1="${cx - 16}" y1="${cy - 10}" x2="${cx + 16}" y2="${cy + 16}" stroke="${color}" stroke-width="4"/>`;
      case 'wait':
        return `<path d="M ${cx - 10} ${cy - 12} H ${cx + 10} L ${cx} ${cy} Z" fill="${color}"/>`
          + `<path d="M ${cx - 10} ${cy + 12} H ${cx + 10} L ${cx} ${cy} Z" fill="${color}"/>`;
      default:
        return '';
    }
  }

  // 三行的领域语义在这里定死：BAL 是绝对量（无条，靠配色告警）、24h/7d 是窗口累计
  // （有预算才有条）。label 只能是 2–3 个 ASCII 字符——label 与 value 共享约 96px，
  // 中文字面放进去就把数字挤出去了。
  function visibleRows(instance, nowMs) {
    const settings = instance.settings;
    const currency = instance.currency || 'CNY';
    const warnAt = amountOf(settings.balanceWarn);
    const critAt = amountOf(settings.balanceCrit);
    const budget24h = amountOf(settings.budget24h);
    const budget7d = amountOf(settings.budget7d);
    const spendKnown = hasSpendData(instance);

    const spendRow = (label, windowMs, budget) => {
      if (!spendKnown) {
        return { label, value: '--', percent: null, showBar: false, severity: 'normal', tail: '' };
      }
      const spent = sumWindow(instance.events, nowMs - windowMs, nowMs);
      const percent = budget ? Math.round((spent / budget) * 100) : null;
      const coverage = coverageRatio(instance, windowMs, nowMs);
      return {
        label,
        value: formatAmount(spent, currency),
        percent,
        showBar: Boolean(budget),
        severity: spendSeverity(percent),
        // tail 是警示位，不是常驻信息位：满覆盖时留空，一旦出现就自带「这个数字是下界」的重量。
        tail: coverage >= 0.999 ? '' : `${Math.floor(coverage * 100)}%`,
      };
    };

    return [
      {
        label: 'BAL',
        value: Number.isFinite(instance.balance) ? formatAmount(instance.balance, currency) : '--',
        percent: null,
        showBar: false,
        severity: Number.isFinite(instance.balance)
          ? balanceSeverity(instance.balance, instance.isAvailable !== false, warnAt, critAt)
          : 'normal',
        tail: '',
      },
      spendRow('24h', WINDOW_24H_MS, budget24h),
      spendRow('7d', WINDOW_7D_MS, budget7d),
    ];
  }

  function renderDeepSeekUsageIcon(instance, nowOverride) {
    const theme = themeFor(instance.settings);
    const frame = frameFor(instance.settings);
    const background = renderThemeBackdrop(theme, theme.accent, frame);
    const language = instance.settings.uiLanguage;
    const nowMs = Number.isFinite(nowOverride) ? nowOverride : Date.now();
    const state = instance.displayState || 'PENDING';
    const hasBalance = Number.isFinite(instance.balance);

    // 设计箱 40..216，与 claudeusage / chatgptusage 同构：行1 是标记 + 字样，
    // 地平线兼作分隔线，剩余高度按行数等分。
    const boxX = 42;
    const boxWidth = 172;
    const headerBaseline = 88;
    const bodyTop = 98;
    const bodyBottom = 214;

    // value 栏右移量。renderMeterRow 默认把数值右对齐在 width*0.56 处，那是按
    // claudeusage 的 `57%`（两位数字）配平的；金额宽得多（`42.3元` 是四位数字加量纲），
    // 按默认位置会把左边的 label 压掉尾字母。往右挪到 tail 之前的空档里：挪 20px 后
    // 数值右边界约 162，左边界约 95——距 label 末端（约 84）与 tail 起点（`99%` 约 175）
    // 各留约 11px，两侧间隙对称。实测值，改动前先按 196px 真实键面重渲一次。
    const VALUE_X_OFFSET = 20;

    const markSize = 38;
    const mark = renderMark(boxX + 2, headerBaseline - 42, markSize, BRAND_DEEPSEEK);
    const labelX = boxX + 2 + markSize + 12;
    const groundLine = `<line x1="${boxX}" y1="${headerBaseline}" x2="${boxX + boxWidth}" y2="${headerBaseline}" stroke="${theme.low}" stroke-width="1.6" opacity="0.7"/>`;

    let body = '';
    if (hasBalance) {
      const rows = visibleRows(instance, nowMs);
      const gap = 6;
      const rowHeight = (bodyBottom - bodyTop - gap * (rows.length - 1)) / rows.length;
      body = rows.map((row, index) => renderMeterRow(
        { x: boxX, y: bodyTop + index * (rowHeight + gap), width: boxWidth, height: rowHeight },
        theme,
        {
          percent: row.percent,
          color: severityColor(row.severity, theme),
          label: row.label,
          value: row.value,
          tail: row.tail,
          tailColor: theme.muted,
          showBar: row.showBar,
          centerTextXOffset: VALUE_X_OFFSET,
        },
      )).join('');
    } else {
      const copy = ERROR_COPY[state] || ERROR_COPY.PENDING;
      const color = state === 'PENDING' ? theme.muted : theme.warn;
      body = `
        ${renderErrorGlyph(copy.glyph, 128, 140, color)}
        <text x="128" y="188" text-anchor="middle" fill="${color}" font-size="22" font-weight="800" font-family="Arial, Helvetica, sans-serif">${escapeXml(t(copy.text, language))}</text>`;
    }

    // STALE 角标：有余额可显示但最近一次拉取失败时，在 header 右上角画对应失败原因的
    // 缩小字形。凭据类失败（要动手）用 crit，网络/限流（等等就好）用 warn。
    const staleBadge = hasBalance && instance.displayState === 'STALE'
      ? (() => {
        const kind = instance.lastErrorKind || 'NETWORK';
        const glyph = (ERROR_COPY[kind] || ERROR_COPY.NETWORK).glyph;
        const needsAction = kind === 'AUTH' || kind === 'NO_KEY';
        return `<g transform="translate(${boxX + boxWidth - 10} 58) scale(0.5)">${renderErrorGlyph(glyph, 0, 0, needsAction ? theme.crit : theme.warn)}</g>`;
      })()
      : '';

    return toDataUrl(`
    <svg width="392" height="392" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
      ${background.outer}
      ${
        frameContent(frame, `
          ${mark}
          <text x="${labelX.toFixed(1)}" y="${headerBaseline - 10}" fill="${background.text}" font-size="25" font-weight="800" font-family="Arial, Helvetica, sans-serif">DeepSeek</text>
          ${groundLine}
          ${staleBadge}
          ${body}
        `)
      }
    </svg>
  `);
  }

  // ---------------------------------------------------------------- 运行态

  function serializeState(instance) {
    return {
      v: STATE_VERSION,
      events: instance.events,
      firstSampleAt: instance.firstSampleAt ?? null,
      lastSampleAt: instance.lastSampleAt ?? null,
      lastBalance: Number.isFinite(instance.lastBalance) ? instance.lastBalance : null,
      balance: Number.isFinite(instance.balance) ? instance.balance : null,
      currency: instance.currency || null,
      isAvailable: instance.isAvailable !== false,
      fetchedAt: instance.fetchedAt ?? null,
      lastErrorKind: instance.lastErrorKind || null,
    };
  }

  function isEventShape(value) {
    return Boolean(value)
      && typeof value === 'object'
      && Number.isFinite(value.a)
      && Number.isFinite(value.b)
      && Number.isFinite(value.d)
      && value.d > 0
      && value.b >= value.a;
  }

  // 读不到就当没有：历史是增益，不是启动前置条件。
  function hydrateState(raw) {
    const valid = raw && typeof raw === 'object' && raw.v === STATE_VERSION;
    const num = (key) => (valid && Number.isFinite(raw[key]) ? raw[key] : null);
    const events = valid && Array.isArray(raw.events) ? raw.events.filter(isEventShape) : [];
    const balance = num('balance');
    return {
      events,
      firstSampleAt: num('firstSampleAt'),
      lastSampleAt: num('lastSampleAt'),
      lastBalance: num('lastBalance'),
      balance,
      currency: valid && typeof raw.currency === 'string' ? raw.currency : 'CNY',
      isAvailable: valid ? raw.isAvailable !== false : true,
      fetchedAt: num('fetchedAt'),
      lastErrorKind: valid && typeof raw.lastErrorKind === 'string' ? raw.lastErrorKind : null,
      // 水合出来的余额一定是上次会话留下的，直接标陈旧，等首次拉取成功再转正。
      displayState: balance == null ? 'PENDING' : 'STALE',
    };
  }

  function flushState(instance, options = {}) {
    const write = options.write ?? writePersistedState;
    return write(instance.context, serializeState(instance));
  }

  function pollIntervalMs(instance) {
    return (Number.parseInt(instance.settings.pollSec, 10) || 300) * 1000;
  }

  function redrawIntervalMs(instance) {
    return (Number.parseInt(instance.settings.redrawSec, 10) || 60) * 1000;
  }

  function schedulePoll(instance) {
    setInstanceTimeout(instance, 'deepseekusagePoll', () => runFetch(instance), pollIntervalMs(instance));
  }

  // 滑动窗口的数字不靠网络也会变——旧消费滑出窗口，累计值就该往下走。所以重绘必须
  // 独立于拉取，否则键面会僵在最后一次拉取时的数字上。
  function scheduleRedraw(instance) {
    setInstanceTimeout(instance, 'deepseekusageRedraw', () => {
      renderInstance(instance);
      scheduleRedraw(instance);
    }, redrawIntervalMs(instance));
  }

  function isInstanceCurrent(instance, requestId, instances = INSTANCES) {
    return instances.get(instance.context) === instance && requestId === instance.requestId;
  }

  function applyResult(instance, result, options = {}) {
    const now = options.now ?? Date.now();
    if (result.ok) {
      recordSample(instance, result.data.balance, now);
      instance.balance = result.data.balance;
      instance.currency = result.data.currency;
      instance.isAvailable = result.data.isAvailable;
      instance.fetchedAt = now;
      instance.lastErrorKind = null;
      instance.displayState = 'OK';
      return true;
    }
    instance.lastErrorKind = result.kind;
    // 有余额就降级为陈旧：余额是绝对量，旧值仍然有参考价值（只会因消费而变小）。
    // 唯独 NO_KEY 例外——没 key 就永远拉不到新值，继续显示旧余额只会误导。
    instance.displayState = (Number.isFinite(instance.balance) && result.kind !== 'NO_KEY')
      ? 'STALE'
      : result.kind;
    if (result.kind === 'NO_KEY') {
      instance.balance = null;
    }
    return false;
  }

  async function runFetch(instance, options = {}) {
    if (!instance) {
      return;
    }
    if (instance.fetching) {
      return;
    }

    instance.fetching = true;
    instance.requestId += 1;
    const requestId = instance.requestId;
    if (options.immediateRender) {
      renderInstance(instance);
    }

    const fetchImpl = options.fetchBalanceImpl ?? fetchBalance;
    const result = await fetchImpl(instance.settings.apiKey);

    if (!isInstanceCurrent(instance, requestId)) {
      instance.fetching = false;
      return;
    }

    instance.fetching = false;
    if (applyResult(instance, result)) {
      flushState(instance);
    }
    renderInstance(instance);
    schedulePoll(instance);
  }

  // 短按：手动刷新，带冷却。连点对一个 300s 节奏的余额接口毫无意义，还可能撞限流。
  function handleShortPress(instance, options = {}) {
    const now = options.now ?? Date.now();
    const run = options.run ?? runFetch;
    if (instance.lastManualAt && now - instance.lastManualAt < MANUAL_COOLDOWN_MS) {
      return undefined;
    }
    instance.lastManualAt = now;
    clearInstanceTimeout(instance, 'deepseekusagePoll');
    return run(instance, { immediateRender: true });
  }

  // 长按打开用量页：这个 action 的两条消费行是本地推算出来的，官方用量页是唯一的对账工具。
  // SDK 桥接层没有插件主动打开 URL 的通道（openurl 是宿主→插件方向），所以走系统命令。
  function handleLongPress(instance, options = {}) {
    const now = options.now ?? Date.now();
    const spawnFn = options.spawnFn ?? spawn;
    const platform = options.platform ?? process.platform;
    const url = instance.settings.usageUrl;
    if (!url) {
      return undefined;
    }
    if (instance.lastOpenUrlAt && now - instance.lastOpenUrlAt < OPEN_URL_COOLDOWN_MS) {
      return undefined;
    }
    instance.lastOpenUrlAt = now;
    const spec = platform === 'darwin'
      ? { command: 'open', args: [url] }
      : platform === 'win32'
        ? { command: 'cmd', args: ['/c', 'start', '', url] }
        : null;
    if (!spec) {
      return undefined;
    }
    try {
      const child = spawnFn(spec.command, spec.args, { stdio: 'ignore' });
      child.on?.('error', () => {});
      child.unref?.();
    } catch {
      // 打不开就算了，不该让一个副作用把整个按键拖进错误态。
    }
    return undefined;
  }

  const PROBE_PARAM = '__deepseekusageProbe';
  const CLEAR_PARAM = '__deepseekusageClearHistory';
  const DIAG_PARAM = '__deepseekusageDiag';

  function buildDiagnostics(instance, nowMs) {
    return {
      hasKey: Boolean(cleanString(instance.settings.apiKey)),
      displayState: instance.displayState || 'PENDING',
      fetchedAt: instance.fetchedAt ?? null,
      lastErrorKind: instance.lastErrorKind || null,
      events: instance.events.length,
      firstSampleAt: instance.firstSampleAt ?? null,
      coverage24h: Math.floor(coverageRatio(instance, WINDOW_24H_MS, nowMs) * 100),
      coverage7d: Math.floor(coverageRatio(instance, WINDOW_7D_MS, nowMs) * 100),
    };
  }

  // 键面只有三行的空间，说不清「这个数字为什么是这样」。诊断把真相留给 PI：
  // key 是否可读、上次采样、上次失败原因、事件条数、两个窗口各自的覆盖率。
  async function runDiagnostics(instance, options = {}) {
    const send = options.send ?? sendParamFromPlugin;
    const run = options.run ?? runFetch;
    await run(instance, { immediateRender: true });
    send({ [DIAG_PARAM]: buildDiagnostics(instance, options.now ?? Date.now()) }, instance.context);
  }

  // 清空记账历史：余额差分算的是相对量，一旦被污染（换 key、换账户、或关机期间既充值
  // 又消费）就没有自愈路径，只能从此刻重新开始记。放在 PI 而不是双击，是为了避免
  // 「想连按两下刷新，结果清了历史」这种误触。
  function handleClearHistory(instance, options = {}) {
    clearHistory(instance);
    flushState(instance, options);
    renderInstance(instance);
    return (options.run ?? runFetch)(instance);
  }

  const config = {
    defaults: {
      apiKey: '',
      pollSec: '300',
      redrawSec: '60',
      // 用户给的日上限；7d 独立设为周上限而不是 5×7——不规律用量下活跃日烧满、闲置日归零，
      // 按 35 设会让 7d 那条常年停在半满，退化成一条永不报警的装饰条。
      budget24h: '5',
      budget7d: '20',
      balanceWarn: '20',
      balanceCrit: '5',
      usageUrl: 'https://platform.deepseek.com/usage',
      theme: 'ice',
      frameSize: 'optimal',
      showFrame: 'true',
    },
    normalizeSettings: (settings, defaults) => ({
      apiKey: cleanString(settings.apiKey).slice(0, 128),
      pollSec: normalizeNumberString(settings.pollSec, defaults.pollSec, 60, 3600),
      redrawSec: normalizeNumberString(settings.redrawSec, defaults.redrawSec, 10, 600),
      budget24h: normalizeAmountString(settings.budget24h, defaults.budget24h),
      budget7d: normalizeAmountString(settings.budget7d, defaults.budget7d),
      balanceWarn: normalizeAmountString(settings.balanceWarn, defaults.balanceWarn),
      balanceCrit: normalizeAmountString(settings.balanceCrit, defaults.balanceCrit),
      usageUrl: normalizeUrl(settings.usageUrl, defaults.usageUrl),
    }),
    createState: (instance) => ({
      fetching: false,
      requestId: 0,
      lastManualAt: 0,
      lastOpenUrlAt: 0,
      ...hydrateState(readPersistedState(instance.context)),
    }),
    onRun: (instance) => handleShortPress(instance),
    onLongPress: (instance) => handleLongPress(instance),
    onReady: (instance) => {
      scheduleRedraw(instance);
      return runFetch(instance);
    },
    onSettingsChanged: (instance, previousSettings) => {
      if (previousSettings.pollSec !== instance.settings.pollSec) {
        clearInstanceTimeout(instance, 'deepseekusagePoll');
        schedulePoll(instance);
      }
      if (previousSettings.redrawSec !== instance.settings.redrawSec) {
        clearInstanceTimeout(instance, 'deepseekusageRedraw');
        scheduleRedraw(instance);
      }
      // 换了 key 就立刻重拉一次：否则用户填完 key 还要干等一个轮询周期才知道对不对。
      if (previousSettings.apiKey !== instance.settings.apiKey) {
        clearInstanceTimeout(instance, 'deepseekusagePoll');
        return runFetch(instance, { immediateRender: true });
      }
      return undefined;
    },
    onParamFromPlugin: (instance, payload) => {
      if (payload?.[CLEAR_PARAM] === 'true') {
        return handleClearHistory(instance);
      }
      if (payload?.[PROBE_PARAM] === 'true') {
        return runDiagnostics(instance);
      }
      return undefined;
    },
    onDispose: (instance) => {
      instance.requestId += 1;
      clearInstanceTimeout(instance, 'deepseekusagePoll');
      clearInstanceTimeout(instance, 'deepseekusageRedraw');
      flushState(instance);
    },
    // 第二参 { now } 仅供测试注入固定时钟；框架调用只传 instance，走 Date.now()。
    render: (instance, options) => renderDeepSeekUsageIcon(instance, options && options.now),
  };

  return {
    key: 'deepseekusage',
    config,
    testing: {
      deepseekApplyResult: applyResult,
      deepseekBalanceSeverity: balanceSeverity,
      deepseekClearHistory: clearHistory,
      deepseekCoverageRatio: coverageRatio,
      deepseekFetchBalance: fetchBalance,
      deepseekFormatAmount: formatAmount,
      deepseekHandleLongPress: handleLongPress,
      deepseekHandleShortPress: handleShortPress,
      deepseekHydrateState: hydrateState,
      deepseekNormalizeAmountString: normalizeAmountString,
      deepseekParseBalance: parseBalance,
      deepseekPruneEvents: pruneEvents,
      deepseekRecordSample: recordSample,
      deepseekSpendSeverity: spendSeverity,
      deepseekSumWindow: sumWindow,
      deepseekVisibleRows: visibleRows,
    },
  };
}
