import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

export function createChatGptUsageAction(runtime) {
  const {
    clearInstanceTimeout,
    escapeXml,
    formatCountdown,
    frameContent,
    frameFor,
    instances: INSTANCES,
    normalizeBooleanString,
    normalizeNumberString,
    normalizeUrl,
    readPersistedState,
    renderInstance,
    renderMeterRow,
    renderThemeBackdrop,
    sendParamFromPlugin,
    setInstanceTimeout,
    themeFor,
    toDataUrl,
    writePersistedState,
  } = runtime;

  const AUTH_PATH = path.join(os.homedir(), '.codex', 'auth.json');
  const MANUAL_COOLDOWN_MS = 10_000;
  const STATE_VERSION = 1;
  const CLIENT_INFO = { name: 'lex_chatgpt_usage', title: 'Lex ChatGPT Usage', version: '1.0.0' };

  // 插件进程由 Ulanzi Studio 拉起，其 PATH 未必包含 homebrew 等前缀——补一份常见兵库。
  // 刻意不做官方插件那套 npm/pnpm 全局查询：那是近百行与业务无关的探测，且每次都要
  // spawn 多个包管理器进程。可解释的 NO_CLI + 一个可填路径足以覆盖。
  const EXTRA_BIN_DIRS = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), '.bun', 'bin'),
    '/usr/bin',
    '/bin',
  ];

  // OpenAI 标记，viewBox 0 0 24 24，取自 simple-icons（收录的是官方标记）。
  // 商标属于 OpenAI，此处仅用于指代其产品。
  const OPENAI_MARK = 'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z';

  const SEVERITY_RANK = { normal: 0, warning: 1, critical: 2 };

  // 阈值必须与 claudeusage 的回退阈值一致——两个键并排时同一百分比要同色。
  // 刻意各自定义而不上移共享：阈值是产品决策（领域逻辑），规则不允许借"共享"之名
  // 把领域逻辑搬进框架层。一致性由 tests 里的跨 action 断言锁定。
  function severityFromPercent(percent) {
    if (percent == null) {
      return 'normal';
    }
    if (percent >= 90) {
      return 'critical';
    }
    if (percent >= 75) {
      return 'warning';
    }
    return 'normal';
  }

  // ---------------------------------------------------------------- CLI 发现

  function isExecutable(candidate, fsImpl = fs) {
    try {
      return fsImpl.statSync(candidate).isFile();
    } catch {
      return false;
    }
  }

  function resolveCodexCommand(command, options = {}) {
    const fsImpl = options.fsImpl ?? fs;
    const requested = String(command || 'codex').trim() || 'codex';

    // 带路径分隔符的当成绝对/相对路径，直接校验，不去 PATH 里找。
    if (requested.includes(path.sep)) {
      return isExecutable(requested, fsImpl) ? buildSpec(requested) : null;
    }

    const pathDirs = String(options.pathEnv ?? process.env.PATH ?? '')
      .split(path.delimiter)
      .filter(Boolean);
    for (const dir of [...pathDirs, ...EXTRA_BIN_DIRS]) {
      const candidate = path.join(dir, requested);
      if (isExecutable(candidate, fsImpl)) {
        return buildSpec(candidate);
      }
    }
    return null;
  }

  // npm 全局装出来的 bin 有时是裸 .js（没有可执行位或缺 shebang），必须用 node 拉起。
  function buildSpec(resolved) {
    if (resolved.endsWith('.js')) {
      return { command: process.execPath, prefixArgs: [resolved], resolved };
    }
    return { command: resolved, prefixArgs: [], resolved };
  }

  // ---------------------------------------------------------------- 登录判定

  // 先读文件再 spawn：没登录能在几毫秒内判定并给出准确原因，而不是等一个进程起来再超时。
  // 只读，不解析 token 内容、不刷新、不写回。
  function hasCodexLogin(options = {}) {
    const fsImpl = options.fsImpl ?? fs;
    const authPath = options.authPath ?? AUTH_PATH;
    try {
      const raw = fsImpl.readFileSync(authPath, 'utf8');
      const token = JSON.parse(raw)?.tokens?.access_token;
      return typeof token === 'string' && token.length > 0;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- JSON-RPC

  function readRateLimits(spec, timeoutMs, options = {}) {
    const spawnFn = options.spawnFn ?? spawn;
    return new Promise((resolve) => {
      let child;
      try {
        child = spawnFn(spec.command, [...spec.prefixArgs, 'app-server'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, TERM: process.env.TERM || 'dumb' },
        });
      } catch {
        resolve({ ok: false, kind: 'RPC_ERROR' });
        return;
      }

      let settled = false;
      const finish = (payload) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        // 无论成败都必须收口，否则留下孤儿 app-server 进程。
        try { child.stdin?.end(); } catch { /* already closed */ }
        try { child.kill(); } catch { /* already gone */ }
        resolve(payload);
      };

      const timer = setTimeout(() => finish({ ok: false, kind: 'TIMEOUT' }), timeoutMs);
      // 定时器不该拖住宿主进程退出。
      timer.unref?.();

      const send = (message) => {
        try {
          child.stdin.write(`${JSON.stringify(message)}\n`);
        } catch {
          finish({ ok: false, kind: 'RPC_ERROR' });
        }
      };

      child.on('error', () => finish({ ok: false, kind: 'RPC_ERROR' }));
      child.on('exit', () => finish({ ok: false, kind: 'RPC_ERROR' }));
      child.stderr?.on('data', () => {});

      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          // app-server 会往 stdout 混写非 JSON 行，忽略即可。
          return;
        }
        if (message.id === 0) {
          send({ method: 'initialized', params: {} });
          send({ method: 'account/rateLimits/read', id: 1 });
          return;
        }
        if (message.id === 1) {
          finish(message.error
            ? { ok: false, kind: 'RPC_ERROR' }
            : { ok: true, result: message.result || {} });
        }
      });

      send({ method: 'initialize', id: 0, params: { clientInfo: CLIENT_INFO } });
    });
  }

  // ---------------------------------------------------------------- 解析

  function normalizePercent(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      return null;
    }
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  // resetsAt 是 Unix 秒，键面统一用毫秒时间戳。
  function normalizeResetsAt(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n * 1000 : null;
  }

  // 窗口时长 → 行标签。10080 分钟 = 7 天 = W；300 = 5H。
  function windowLabel(mins) {
    const n = Number(mins);
    if (!Number.isFinite(n) || n <= 0) {
      return '?';
    }
    if (n % 10080 === 0) {
      const weeks = n / 10080;
      return weeks === 1 ? 'W' : `${weeks}W`;
    }
    if (n % 1440 === 0) {
      return `${n / 1440}D`;
    }
    if (n % 60 === 0) {
      return `${n / 60}H`;
    }
    return `${n}M`;
  }

  function readWindow(source) {
    if (!source || typeof source !== 'object') {
      return null;
    }
    const percent = normalizePercent(source.usedPercent);
    if (percent == null) {
      return null;
    }
    return {
      label: windowLabel(source.windowDurationMins),
      percent,
      severity: severityFromPercent(percent),
      resetsAt: normalizeResetsAt(source.resetsAt),
      windowMins: Number(source.windowDurationMins) || null,
    };
  }

  function parseRateLimits(result, limitId = 'codex') {
    const byId = result?.rateLimitsByLimitId;
    const group = (byId && typeof byId === 'object' && byId[limitId]) || result?.rateLimits;
    if (!group || typeof group !== 'object') {
      return null;
    }
    const primary = readWindow(group.primary);
    const secondary = readWindow(group.secondary);
    if (!primary && !secondary) {
      return null;
    }
    const credits = Number(result?.rateLimitResetCredits?.availableCount);
    return {
      primary,
      secondary,
      resetCredits: Number.isFinite(credits) ? credits : null,
      planType: typeof group.planType === 'string' ? group.planType : null,
    };
  }

  async function fetchUsage(settings, options = {}) {
    const resolve = options.resolveCommand ?? resolveCodexCommand;
    const loggedIn = options.hasLogin ?? hasCodexLogin;
    const read = options.readRateLimits ?? readRateLimits;

    const spec = resolve(settings.codexCommand);
    if (!spec) {
      return { ok: false, kind: 'NO_CLI' };
    }
    if (!loggedIn()) {
      return { ok: false, kind: 'NOT_LOGGED_IN' };
    }

    const timeoutMs = (Number.parseInt(settings.timeoutSec, 10) || 12) * 1000;
    const rpc = await read(spec, timeoutMs);
    if (!rpc.ok) {
      return rpc;
    }

    const data = parseRateLimits(rpc.result, settings.limitId);
    if (!data) {
      // 协议变了。app-server 是 experimental 接口，这是已知风险——降级成错误态，
      // 不要崩在框架边界上。
      return { ok: false, kind: 'RPC_ERROR' };
    }
    return { ok: true, data };
  }

  // ---------------------------------------------------------------- 渲染

  // 倒计时配色按临近程度递进：剩余越短越亮。
  //
  // 方向很关键——短倒计时是**好消息**（额度快恢复了），所以绝不能用 warn/crit
  // 那套告警色，否则会和百分比的红黄撞成同一种"紧急"暗示，含义正好相反。
  // 这里只在主题自己的明度层级里走：low（远）→ muted（中）→ text（近）。
  function countdownColor(text, theme) {
    if (text === 'now' || /m$/.test(text)) {
      return theme.text;
    }
    if (/h$/.test(text)) {
      return theme.muted;
    }
    return theme.low;
  }

  function severityColor(severity, theme, enabled) {
    if (!enabled) {
      return theme.accent;
    }
    if (severity === 'critical') {
      return theme.crit;
    }
    if (severity === 'warning') {
      return theme.warn;
    }
    return theme.ok;
  }

  // 标记固定白色（与 claudeusage 的宠物固定品牌色对称）；但 sand 这类浅色主题下
  // 白色等于隐形，改取 theme.text。
  function isLightCanvas(theme) {
    const hex = String(theme.canvas || '').replace('#', '');
    if (hex.length !== 6) {
      return false;
    }
    const r = Number.parseInt(hex.slice(0, 2), 16);
    const g = Number.parseInt(hex.slice(2, 4), 16);
    const b = Number.parseInt(hex.slice(4, 6), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) > 140;
  }

  function renderMark(x, y, size, color) {
    const scale = size / 24;
    return `<g transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${scale.toFixed(4)})"><path d="${OPENAI_MARK}" fill="${color}"/></g>`;
  }

  function visibleRows(instance) {
    const { settings } = instance;
    const rows = [];
    if (instance.primary) {
      rows.push(instance.primary);
    }
    if (normalizeBooleanString(settings.showSecondary, 'true') === 'true' && instance.secondary) {
      rows.push(instance.secondary);
    }
    // 短窗口在前，与 claudeusage 的 5H/W 顺序一致。接口没规定 primary 一定是
    // 长窗口，所以按 windowDurationMins 排而不是按字段名——缺时长的排最后。
    rows.sort((a, b) => (a.windowMins ?? Infinity) - (b.windowMins ?? Infinity));
    return rows;
  }

  function worstSeverity(rows) {
    return rows.reduce((worst, row) => (
      SEVERITY_RANK[row.severity] > SEVERITY_RANK[worst] ? row.severity : worst
    ), 'normal');
  }

  const ERROR_COPY = {
    NO_CLI: { glyph: 'terminal', text: 'No codex' },
    NOT_LOGGED_IN: { glyph: 'key', text: 'codex login' },
    TIMEOUT: { glyph: 'wait', text: 'Timeout' },
    RPC_ERROR: { glyph: 'bang', text: 'Error' },
    PENDING: { glyph: 'none', text: '' },
  };

  function renderErrorGlyph(glyph, cx, cy, color) {
    switch (glyph) {
      case 'terminal':
        return `<rect x="${cx - 18}" y="${cy - 14}" width="36" height="28" rx="4" fill="none" stroke="${color}" stroke-width="3.5"/>`
          + `<path d="M ${cx - 10} ${cy - 5} L ${cx - 4} ${cy + 1} L ${cx - 10} ${cy + 7}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`
          + `<line x1="${cx - 1}" y1="${cy + 7}" x2="${cx + 10}" y2="${cy + 7}" stroke="${color}" stroke-width="3" stroke-linecap="round"/>`;
      case 'key':
        return `<circle cx="${cx - 8}" cy="${cy}" r="7" fill="none" stroke="${color}" stroke-width="4"/>`
          + `<rect x="${cx - 2}" y="${cy - 2}" width="20" height="4" fill="${color}"/>`
          + `<rect x="${cx + 12}" y="${cy}" width="4" height="7" fill="${color}"/>`;
      case 'wait':
        return `<path d="M ${cx - 10} ${cy - 12} H ${cx + 10} L ${cx} ${cy} Z" fill="${color}"/>`
          + `<path d="M ${cx - 10} ${cy + 12} H ${cx + 10} L ${cx} ${cy} Z" fill="${color}"/>`;
      case 'bang':
        return `<rect x="${cx - 3}" y="${cy - 14}" width="6" height="18" rx="2" fill="${color}"/>`
          + `<circle cx="${cx}" cy="${cy + 10}" r="4" fill="${color}"/>`;
      default:
        return '';
    }
  }

  function renderChatGptUsageIcon(instance) {
    const theme = themeFor(instance.settings);
    const frame = frameFor(instance.settings);
    const background = renderThemeBackdrop(theme, theme.accent, frame);
    const rows = visibleRows(instance);
    const state = instance.displayState || 'PENDING';
    const hasData = rows.length > 0;
    const severityColors = normalizeBooleanString(instance.settings.severityColors, 'true') === 'true';
    const showBar = normalizeBooleanString(instance.settings.showBarBackground, 'true') === 'true';
    const showCredits = normalizeBooleanString(instance.settings.showResetCredits, 'true') === 'true';

    const severity = hasData ? worstSeverity(rows) : 'normal';

    // 与 claudeusage 共用同一套布局常量，两键并排时行位必须完全对齐。
    const boxX = 42;
    const boxWidth = 172;
    const headerBaseline = 88;
    const bodyTop = 98;
    const bodyBottom = 214;

    const markColor = isLightCanvas(theme) ? theme.text : '#ffffff';
    const markSize = 38;
    const mark = renderMark(boxX + 2, headerBaseline - 42, markSize, markColor);
    // 与 claudeusage 同一公式，保证两键并排时字样起点完全对齐。
    const labelX = boxX + 2 + markSize + 12;
    const divider = `<line x1="${boxX}" y1="${headerBaseline}" x2="${boxX + boxWidth}" y2="${headerBaseline}" stroke="${theme.low}" stroke-width="1.6" opacity="0.7"/>`;

    const bands = [...rows];
    if (showCredits && Number.isFinite(instance.resetCredits) && instance.resetCredits > 0) {
      bands.push({ credits: instance.resetCredits });
    }

    let body = '';
    if (hasData) {
      const gap = 6;
      const rowHeight = (bodyBottom - bodyTop - gap * (bands.length - 1)) / bands.length;
      body = bands.map((band, index) => {
        const geometry = {
          x: boxX,
          y: bodyTop + index * (rowHeight + gap),
          width: boxWidth,
          height: rowHeight,
        };
        // 重置券不是限额，percent 传 null 就不会画进度填充——画成进度条会被读成
        // "用掉了多少券"。但底槽跟着 showBar 一起保留，否则这一行会比上面两行
        // 少一层背景，在键面上显得空落落地贴着边。
        if (band.credits !== undefined) {
          return renderMeterRow(geometry, theme, {
            percent: null,
            color: theme.muted,
            label: 'RESET',
            value: String(band.credits),
            tail: '',
            showBar,
          });
        }
        return renderMeterRow(geometry, theme, {
          percent: band.percent,
          color: severityColor(band.severity, theme, severityColors),
          label: band.label,
          value: `${band.percent}%`,
          tail: formatCountdown(band.resetsAt),
          tailColor: countdownColor(formatCountdown(band.resetsAt), theme),
          showBar,
        });
      }).join('');
    } else {
      const copy = ERROR_COPY[state] || ERROR_COPY.PENDING;
      const color = state === 'PENDING' ? theme.muted : theme.warn;
      body = `
        ${renderErrorGlyph(copy.glyph, 128, 140, color)}
        <text x="128" y="188" text-anchor="middle" fill="${color}" font-size="22" font-weight="800" font-family="Arial, Helvetica, sans-serif">${escapeXml(copy.text)}</text>`;
    }

    // STALE 徽章：画对应失败原因的错误图标（缩小版），与 claudeusage 同构。
    // NO_CLI / NOT_LOGGED_IN 需要用户去处理（装 CLI / 登录），用 crit 提级；
    // TIMEOUT / RPC_ERROR 是暂时性故障，用 warn。
    const staleBadge = state === 'STALE' && hasData
      ? (() => {
        const kind = instance.lastErrorKind || 'RPC_ERROR';
        const glyph = (ERROR_COPY[kind] || ERROR_COPY.RPC_ERROR).glyph;
        const needsAction = kind === 'NO_CLI' || kind === 'NOT_LOGGED_IN';
        const color = needsAction ? theme.crit : theme.warn;
        return `<g transform="translate(${boxX + boxWidth - 10} 58) scale(0.5)">${renderErrorGlyph(glyph, 0, 0, color)}</g>`;
      })()
      : '';

    return toDataUrl(`
    <svg width="392" height="392" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
      ${background.outer}
      ${
        frameContent(frame, `
          ${mark}
          <text x="${labelX.toFixed(1)}" y="${headerBaseline - 10}" fill="${background.text}" font-size="25" font-weight="800" font-family="Arial, Helvetica, sans-serif">ChatGPT</text>
          ${divider}
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
      primary: instance.primary || null,
      secondary: instance.secondary || null,
      resetCredits: instance.resetCredits ?? null,
      planType: instance.planType || null,
      fetchedAt: instance.fetchedAt ?? null,
      lastErrorKind: instance.lastErrorKind || null,
    };
  }

  function isWindowShape(value) {
    return Boolean(value)
      && typeof value === 'object'
      && Number.isFinite(value.percent)
      && typeof value.label === 'string';
  }

  function hydrateState(raw) {
    const valid = raw && typeof raw === 'object' && raw.v === STATE_VERSION;
    const pick = (key) => (valid && isWindowShape(raw[key]) ? raw[key] : null);
    const primary = pick('primary');
    const secondary = pick('secondary');
    return {
      primary,
      secondary,
      resetCredits: valid && Number.isFinite(raw.resetCredits) ? raw.resetCredits : null,
      planType: valid && typeof raw.planType === 'string' ? raw.planType : null,
      fetchedAt: valid && Number.isFinite(raw.fetchedAt) ? raw.fetchedAt : null,
      lastErrorKind: valid && typeof raw.lastErrorKind === 'string' ? raw.lastErrorKind : null,
      // 水合来的一定是上次会话留下的，先标陈旧，等首次拉取成功再转正。
      displayState: (primary || secondary) ? 'STALE' : 'PENDING',
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
    return (Number.parseInt(instance.settings.redrawSec, 10) || 30) * 1000;
  }

  function schedulePoll(instance) {
    setInstanceTimeout(instance, 'chatgptusagePoll', () => runFetch(instance), pollIntervalMs(instance));
  }

  function scheduleRedraw(instance) {
    setInstanceTimeout(instance, 'chatgptusageRedraw', () => {
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
      instance.primary = result.data.primary;
      instance.secondary = result.data.secondary;
      instance.resetCredits = result.data.resetCredits;
      instance.planType = result.data.planType;
      instance.fetchedAt = now;
      instance.lastErrorKind = null;
      instance.displayState = 'OK';
      return true;
    }
    instance.lastErrorKind = result.kind;
    instance.displayState = (instance.primary || instance.secondary) ? 'STALE' : result.kind;
    return false;
  }

  async function runFetch(instance, options = {}) {
    if (!instance || instance.fetching) {
      return;
    }
    instance.fetching = true;
    instance.requestId += 1;
    const requestId = instance.requestId;
    if (options.immediateRender) {
      renderInstance(instance);
    }

    const result = await (options.fetchUsageImpl ?? fetchUsage)(instance.settings);

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

  // 短按冷却：每次拉取都要 spawn 一个进程，连点会堆出一串 app-server。
  function handleShortPress(instance, options = {}) {
    const now = options.now ?? Date.now();
    const run = options.run ?? runFetch;
    if (instance.lastManualAt && now - instance.lastManualAt < MANUAL_COOLDOWN_MS) {
      return undefined;
    }
    instance.lastManualAt = now;
    clearInstanceTimeout(instance, 'chatgptusagePoll');
    return run(instance, { immediateRender: true });
  }

  function openCommand(url) {
    if (process.platform === 'darwin') {
      return ['open', [url]];
    }
    if (process.platform === 'win32') {
      // 空字符串是 start 的窗口标题占位，缺了它带引号的 URL 会被当成标题吞掉。
      return ['cmd', ['/c', 'start', '', url]];
    }
    return ['xdg-open', [url]];
  }

  function handleLongPress(instance, options = {}) {
    const spawnFn = options.spawnFn ?? spawn;
    const url = instance.settings.usageUrl;
    if (!url) {
      return;
    }
    const [command, args] = openCommand(url);
    try {
      const child = spawnFn(command, args, { stdio: 'ignore' });
      child.on?.('error', () => {});
      child.unref?.();
    } catch {
      // 打不开就算了，不该让一个副作用把整个按键拖进错误态。
    }
  }

  const PROBE_PARAM = '__chatgptusageProbe';
  const DIAG_PARAM = '__chatgptusageDiag';

  function buildDiagnostics(instance, spec) {
    return {
      platform: process.platform,
      codexPath: spec ? spec.resolved : null,
      loggedIn: hasCodexLogin(),
      planType: instance.planType || null,
      displayState: instance.displayState || 'PENDING',
      fetchedAt: instance.fetchedAt ?? null,
      lastErrorKind: instance.lastErrorKind || null,
    };
  }

  async function runDiagnostics(instance, options = {}) {
    const send = options.send ?? sendParamFromPlugin;
    const resolve = options.resolveCommand ?? resolveCodexCommand;
    const run = options.run ?? runFetch;

    const spec = resolve(instance.settings.codexCommand);
    await run(instance, { immediateRender: true });
    send({ [DIAG_PARAM]: buildDiagnostics(instance, spec) }, instance.context);
  }

  function normalizeCommandString(value, fallback) {
    const text = String(value ?? '').trim();
    return text || fallback;
  }

  const config = {
    defaults: {
      codexCommand: 'codex',
      limitId: 'codex',
      pollSec: '300',
      redrawSec: '30',
      timeoutSec: '12',
      showSecondary: 'true',
      showResetCredits: 'true',
      showBarBackground: 'true',
      severityColors: 'true',
      usageUrl: 'https://chatgpt.com/#settings/Usage',
      theme: 'mono',
      frameSize: 'optimal',
      showFrame: 'true',
    },
    normalizeSettings: (settings, defaults) => ({
      codexCommand: normalizeCommandString(settings.codexCommand, defaults.codexCommand),
      limitId: normalizeCommandString(settings.limitId, defaults.limitId),
      pollSec: normalizeNumberString(settings.pollSec, defaults.pollSec, 60, 3600),
      redrawSec: normalizeNumberString(settings.redrawSec, defaults.redrawSec, 10, 300),
      timeoutSec: normalizeNumberString(settings.timeoutSec, defaults.timeoutSec, 3, 60),
      showSecondary: normalizeBooleanString(settings.showSecondary, defaults.showSecondary),
      showResetCredits: normalizeBooleanString(settings.showResetCredits, defaults.showResetCredits),
      showBarBackground: normalizeBooleanString(settings.showBarBackground, defaults.showBarBackground),
      severityColors: normalizeBooleanString(settings.severityColors, defaults.severityColors),
      usageUrl: normalizeUrl(settings.usageUrl, defaults.usageUrl),
    }),
    createState: (instance) => ({
      fetching: false,
      requestId: 0,
      lastManualAt: 0,
      ...hydrateState(readPersistedState(instance.context)),
    }),
    onRun: (instance) => handleShortPress(instance),
    onLongPress: (instance) => handleLongPress(instance),
    onReady: (instance) => {
      scheduleRedraw(instance);
      return runFetch(instance);
    },
    onParamFromPlugin: (instance, payload) => {
      if (payload?.[PROBE_PARAM] === 'true') {
        return runDiagnostics(instance);
      }
      return undefined;
    },
    onSettingsChanged: (instance, previousSettings) => {
      if (previousSettings.pollSec !== instance.settings.pollSec) {
        clearInstanceTimeout(instance, 'chatgptusagePoll');
        schedulePoll(instance);
      }
      if (previousSettings.redrawSec !== instance.settings.redrawSec) {
        clearInstanceTimeout(instance, 'chatgptusageRedraw');
        scheduleRedraw(instance);
      }
      // 换命令或换限额组等于换了数据源，立刻重拉而不是等下一个周期。
      if (
        previousSettings.codexCommand !== instance.settings.codexCommand ||
        previousSettings.limitId !== instance.settings.limitId
      ) {
        clearInstanceTimeout(instance, 'chatgptusagePoll');
        return runFetch(instance, { immediateRender: true });
      }
      return undefined;
    },
    onDispose: (instance) => {
      instance.requestId += 1;
      clearInstanceTimeout(instance, 'chatgptusagePoll');
      clearInstanceTimeout(instance, 'chatgptusageRedraw');
      flushState(instance);
    },
    render: (instance) => renderChatGptUsageIcon(instance),
  };

  return {
    key: 'chatgptusage',
    config,
    testing: {
      // ACTION_TESTING 把各 action 的 testing 合并成一个对象，同名键会静默互相覆盖。
      // 与 claudeusage 重名的一律加前缀。
      chatgptApplyResult: applyResult,
      chatgptBuildDiagnostics: buildDiagnostics,
      chatgptSeverityFromPercent: severityFromPercent,
      hasCodexLogin,
      hydrateChatGptState: hydrateState,
      openCommand,
      parseRateLimits,
      readRateLimits,
      resolveCodexCommand,
      chatgptVisibleRows: visibleRows,
      chatgptWorstSeverity: worstSeverity,
      windowLabel,
      fetchChatGptUsage: fetchUsage,
    },
  };
}
