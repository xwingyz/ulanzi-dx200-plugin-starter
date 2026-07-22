import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function createClaudeUsageAction(runtime) {
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

  const KEYCHAIN_SERVICE = 'Claude Code-credentials';
  const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
  const OAUTH_BETA = 'oauth-2025-04-20';
  const REQUEST_TIMEOUT_MS = 12_000;
  const MANUAL_COOLDOWN_MS = 10_000;
  const STATE_VERSION = 1;

  // 手动刷新：短按时主动 spawn `claude` 让 CLI 用 refreshToken 自行刷新钥匙串凭据
  // （凭据生命周期归 CLI 管，插件从不写钥匙串）。用 `-p` 打一条极短消息真实消耗一点
  // 额度来「激活」——这是用户明确选择的方式（见 sessions 记录）。锁死 haiku 把消耗压到
  // 最小；--max-turns 1 杜绝任何工具循环；cwd 用临时目录避开本仓 CLAUDE.md / hooks。
  const REFRESH_COMMAND = 'claude';
  const REFRESH_ARGS = ['-p', 'ping', '--model', 'haiku', '--max-turns', '1'];
  const REFRESH_TIMEOUT_MS = 45_000;

  // 插件进程由 Ulanzi Studio 拉起，其 PATH 未必包含 homebrew 等前缀——补一份常见兵库。
  // 与 chatgptusage 的探测同构，但按隔离规范各自持有，不跨 action 借用。
  const EXTRA_BIN_DIRS = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), '.bun', 'bin'),
    '/usr/bin',
    '/bin',
  ];

  // 品牌色：Claude 标记的身份标识，固定不随主题。
  const BRAND_CLAUDE = '#d97757';

  // 刷新中角标：Material 的 refresh 字形（viewBox 0 0 24 24）。键面是静态渲染
  // （见 8f7d2ba：claudeusage 已移除键面动效），所以用一个静态的循环箭头表示
  // 「正在刷新」，而不是转圈动画。
  const REFRESH_MARK = 'M17.65 6.35A7.958 7.958 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z';

  // Claude 官方标记，viewBox 0 0 24 24，取自 simple-icons（收录的是官方标记）。
  // 改用矢量而非早先的像素宠物：196px 的键面上像素网格的腿和眼睛会糊成一团，
  // 矢量在任何尺寸都锐利，也与 chatgptusage 的 OpenAI 标记形成对称。
  // 商标属于 Anthropic，此处仅用于指代其产品。
  const CLAUDE_MARK = 'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z';

  const SEVERITY_RANK = { normal: 0, warning: 1, critical: 2 };

  // ---------------------------------------------------------------- 凭据

  function runSecurity(spawnFn = spawn) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawnFn('security', [
          'find-generic-password',
          '-s', KEYCHAIN_SERVICE,
          '-a', os.userInfo().username,
          '-w',
        ]);
      } catch {
        resolve(null);
        return;
      }
      let out = '';
      child.stdout?.on('data', (chunk) => { out += chunk.toString(); });
      child.stderr?.on('data', () => {});
      child.on('close', (code) => resolve(code === 0 ? out : null));
      child.on('error', () => resolve(null));
    });
  }

  function extractAccessToken(raw) {
    if (typeof raw !== 'string' || !raw.trim()) {
      return null;
    }
    try {
      const token = JSON.parse(raw.trim())?.claudeAiOauth?.accessToken;
      return typeof token === 'string' && token ? token : null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- CLI 发现与刷新

  function isExecutable(candidate, fsImpl = fs) {
    try {
      return fsImpl.statSync(candidate).isFile();
    } catch {
      return false;
    }
  }

  function buildSpec(resolved) {
    // npm 全局装出来的 bin 有时是裸 .js（缺可执行位或 shebang），必须用 node 拉起。
    if (resolved.endsWith('.js')) {
      return { command: process.execPath, prefixArgs: [resolved], resolved };
    }
    return { command: resolved, prefixArgs: [], resolved };
  }

  function resolveClaudeCommand(command, options = {}) {
    const fsImpl = options.fsImpl ?? fs;
    const requested = String(command || REFRESH_COMMAND).trim() || REFRESH_COMMAND;
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

  // 尽力而为：失败也不抛，让调用方照常走一次拉取——刷新只是「更可能拿到新鲜数据」，
  // 不是拉取的前置条件。stdio 全丢弃，只关心退出码；超时就杀掉，绝不让它挂住按键。
  function runClaudeRefresh(options = {}) {
    return new Promise((resolve) => {
      const spawnFn = options.spawnFn ?? spawn;
      const resolveCommand = options.resolveCommand ?? resolveClaudeCommand;
      const timeoutMs = options.timeoutMs ?? REFRESH_TIMEOUT_MS;
      const spec = resolveCommand(options.command ?? REFRESH_COMMAND);
      if (!spec) {
        resolve({ ok: false, reason: 'NO_CLI' });
        return;
      }
      let child;
      try {
        child = spawnFn(spec.command, [...spec.prefixArgs, ...REFRESH_ARGS], {
          cwd: os.tmpdir(),
          stdio: 'ignore',
          env: process.env,
        });
      } catch {
        resolve({ ok: false, reason: 'SPAWN_FAILED' });
        return;
      }
      let settled = false;
      const finish = (result) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        finish({ ok: false, reason: 'TIMEOUT' });
      }, timeoutMs);
      child.on('error', () => finish({ ok: false, reason: 'SPAWN_FAILED' }));
      child.on('close', (code) => finish(code === 0 ? { ok: true } : { ok: false, reason: 'EXIT' }));
    });
  }

  // ---------------------------------------------------------------- 取数

  function normalizePercent(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      return null;
    }
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  function normalizeResetsAt(value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function normalizeSeverity(value) {
    return SEVERITY_RANK[value] === undefined ? null : value;
  }

  // 百分比回退阈值。接口非公开，severity 字段随时可能消失；缺了它总比整行不显示好。
  // 75/90 与 chatgptusage 保持一致——那边没有 severity 字段，只能靠阈值判定，
  // 两个键并排时同一个百分比必须是同一个颜色。
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

  function readLimit(payload, kind, fallbackKey, label) {
    const limits = Array.isArray(payload?.limits) ? payload.limits : [];
    const hit = limits.find((item) => item?.kind === kind);
    const source = hit || payload?.[fallbackKey];
    if (!source || typeof source !== 'object') {
      return null;
    }
    const percent = normalizePercent(hit ? source.percent : source.utilization);
    if (percent == null) {
      return null;
    }
    return {
      label,
      percent,
      severity: normalizeSeverity(source.severity) || severityFromPercent(percent),
      resetsAt: normalizeResetsAt(source.resets_at),
    };
  }

  // 按模型划分的周限额：存在即显示，不看 is_active——is_active 会随会话状态翻转，
  // 跟着它走会让键面在 3 行和 4 行之间反复跳。多条并存时取最紧的那条。
  function readScopedLimit(payload) {
    const limits = Array.isArray(payload?.limits) ? payload.limits : [];
    const scoped = limits
      .filter((item) => item?.kind === 'weekly_scoped' && normalizePercent(item.percent) != null)
      .sort((a, b) => normalizePercent(b.percent) - normalizePercent(a.percent));
    const hit = scoped[0];
    if (!hit) {
      return null;
    }
    const percent = normalizePercent(hit.percent);
    const model = hit.scope?.model?.display_name;
    const initial = typeof model === 'string' && model.trim() ? model.trim()[0].toUpperCase() : '*';
    return {
      label: `W${initial}`,
      percent,
      severity: normalizeSeverity(hit.severity) || severityFromPercent(percent),
      resetsAt: normalizeResetsAt(hit.resets_at),
    };
  }

  function parseUsage(payload) {
    const weekly = readLimit(payload, 'weekly_all', 'seven_day', 'W');
    const fiveHour = readLimit(payload, 'session', 'five_hour', '5H');
    const scoped = readScopedLimit(payload);
    if (!weekly && !fiveHour && !scoped) {
      return null;
    }
    return { weekly, fiveHour, scoped };
  }

  async function fetchUsage(options = {}) {
    const doFetch = options.fetchImpl ?? fetch;
    const readToken = options.readToken ?? (async () => extractAccessToken(await runSecurity()));

    const token = await readToken();
    if (!token) {
      return { ok: false, kind: 'NO_TOKEN' };
    }

    let response;
    try {
      response = await doFetch(USAGE_ENDPOINT, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          'anthropic-beta': OAUTH_BETA,
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

    const data = parseUsage(payload);
    if (!data) {
      // 接口结构变了。这是已知风险，降级成普通失败而不是崩在框架边界上。
      return { ok: false, kind: 'NETWORK' };
    }
    return { ok: true, data };
  }

  // ---------------------------------------------------------------- 格式化

  function visibleRows(instance) {
    const { settings } = instance;
    const rows = [];
    // 短窗口在前：5 小时限额是最先撞墙、也最常看的一条，放第一行。
    if (normalizeBooleanString(settings.showFiveHour, 'true') === 'true' && instance.fiveHour) {
      rows.push(instance.fiveHour);
    }
    if (normalizeBooleanString(settings.showWeekly, 'true') === 'true' && instance.weekly) {
      rows.push(instance.weekly);
    }
    if (normalizeBooleanString(settings.showScoped, 'true') === 'true' && instance.scoped) {
      rows.push(instance.scoped);
    }
    return rows;
  }

  function worstSeverity(rows) {
    return rows.reduce((worst, row) => (
      SEVERITY_RANK[row.severity] > SEVERITY_RANK[worst] ? row.severity : worst
    ), 'normal');
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

  function renderMark(x, y, size, color) {
    const scale = size / 24;
    return `<g transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${scale.toFixed(4)})"><path d="${CLAUDE_MARK}" fill="${color}"/></g>`;
  }

  function renderRefreshBadge(x, y, size, color) {
    const scale = size / 24;
    return `<g transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${scale.toFixed(4)})"><path d="${REFRESH_MARK}" fill="${color}"/></g>`;
  }

  // 行几何与排版走共享的 renderMeterRow，保证与 chatgptusage 并排时观感必然一致；
  // 这里只决定领域语义部分：颜色由 severity 映射而来。
  function renderDataRow(row, geometry, theme, options) {
    // 倒计时以 options.nowMs 为参照钟，而不是各自现调 Date.now()——同一次 render 的各行
    // 共用同一时刻，测试也能注入固定 now 消除取整漂移（见 development-rules §4「测试必须确定性」）。
    const tail = formatCountdown(row.resetsAt, options.nowMs);
    return renderMeterRow(geometry, theme, {
      percent: row.percent,
      color: severityColor(row.severity, theme, options.severityColors),
      label: row.label,
      value: `${row.percent}%`,
      tail,
      tailColor: countdownColor(tail, theme),
      showBar: options.showBar,
    });
  }

  const ERROR_COPY = {
    NO_TOKEN: { glyph: 'key', text: 'Sign in' },
    AUTH: { glyph: 'bang', text: 'Re-auth' },
    NETWORK: { glyph: 'offline', text: 'Offline' },
    RATE_LIMITED: { glyph: 'wait', text: 'Slow down' },
    UNSUPPORTED: { glyph: 'block', text: 'macOS only' },
    PENDING: { glyph: 'none', text: '' },
  };

  // 每种错误一个独立字形：键面上不区分原因的话，"要不要动手"这个判断就得跑去开 PI。
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
      case 'block':
        return `<circle cx="${cx}" cy="${cy}" r="13" fill="none" stroke="${color}" stroke-width="4"/>`
          + `<line x1="${cx - 9}" y1="${cy + 9}" x2="${cx + 9}" y2="${cy - 9}" stroke="${color}" stroke-width="4"/>`;
      default:
        return '';
    }
  }

  function renderClaudeUsageIcon(instance, nowOverride) {
    const theme = themeFor(instance.settings);
    const frame = frameFor(instance.settings);
    const background = renderThemeBackdrop(theme, theme.accent, frame);
    const rows = visibleRows(instance);
    const state = instance.displayState || 'PENDING';
    const hasData = rows.length > 0;
    const severityColors = normalizeBooleanString(instance.settings.severityColors, 'true') === 'true';
    const showBar = normalizeBooleanString(instance.settings.showBarBackground, 'true') === 'true';

    const severity = hasData ? worstSeverity(rows) : 'normal';

    // 倒计时以此刻为参照钟；测试可通过 nowOverride 注入固定时间消除取整漂移。
    const nowMs = Number.isFinite(nowOverride) ? nowOverride : Date.now();

    // 设计箱 40..216。行1 是宠物 + 字样，地平线兼作分隔线；剩余高度按行数等分。
    // 宠物按 normal 帧的 8 行占满整个行1 高度——它是身份标识，缩得太小就只剩
    // 一团色块，认不出是谁。趴伏帧只有 7 行，因此天然比站立矮一截。
    const boxX = 42;
    const boxWidth = 172;
    const headerBaseline = 88;
    const bodyTop = 98;
    const bodyBottom = 214;

    const markSize = 38;
    const mark = renderMark(boxX + 2, headerBaseline - 42, markSize, BRAND_CLAUDE);
    const labelX = boxX + 2 + markSize + 12;
    const groundLine = `<line x1="${boxX}" y1="${headerBaseline}" x2="${boxX + boxWidth}" y2="${headerBaseline}" stroke="${theme.low}" stroke-width="1.6" opacity="0.7"/>`;

    let body = '';
    if (hasData) {
      const gap = 6;
      const rowHeight = (bodyBottom - bodyTop - gap * (rows.length - 1)) / rows.length;
      body = rows.map((row, index) => renderDataRow(
        row,
        { x: boxX, y: bodyTop + index * (rowHeight + gap), width: boxWidth, height: rowHeight },
        theme,
        { showBar, severityColors, nowMs },
      )).join('');
    } else {
      const copy = ERROR_COPY[state] || ERROR_COPY.PENDING;
      const color = state === 'PENDING' ? theme.muted : theme.warn;
      body = `
        ${renderErrorGlyph(copy.glyph, 128, 140, color)}
        <text x="128" y="188" text-anchor="middle" fill="${color}" font-size="22" font-weight="800" font-family="Arial, Helvetica, sans-serif">${escapeXml(copy.text)}</text>`;
    }

    // 刷新中角标优先于 STALE：一旦用户按下、正在跑 claude 刷新，就换成循环箭头，
    // 盖掉旧的错误角标——否则会同时出现"出错"和"正在修"两个互相矛盾的信号。
    const refreshBadge = instance.refreshing
      ? renderRefreshBadge(boxX + boxWidth - 22, headerBaseline - 44, 20, theme.accent)
      : '';

    // STALE 徽章：在 header 右上角画对应失败原因的错误图标（缩小版），而不只是一个
    // 说不清原因的琥珀点。图标本身回答"要不要动手"——bang=重新登录、offline=网络、
    // wait=被限流。AUTH / NO_TOKEN 需要用户去刷新凭据，用 crit 提级；其余是暂时性
    // 故障，用 warn。
    const staleBadge = !instance.refreshing && instance.displayState === 'STALE' && hasData
      ? (() => {
        const kind = instance.lastErrorKind || 'AUTH';
        const glyph = (ERROR_COPY[kind] || ERROR_COPY.AUTH).glyph;
        const needsAction = kind === 'AUTH' || kind === 'NO_TOKEN';
        const color = needsAction ? theme.crit : theme.warn;
        // renderErrorGlyph 以传入点为中心按原生尺寸（约 28px）作图；缩到 0.55 ≈ 15px
        // 作为角标，再平移到 header 右侧空白处。
        return `<g transform="translate(${boxX + boxWidth - 10} 58) scale(0.5)">${renderErrorGlyph(glyph, 0, 0, color)}</g>`;
      })()
      : '';

    return toDataUrl(`
    <svg width="392" height="392" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
      ${background.outer}
      ${
        frameContent(frame, `
          ${mark}
          <text x="${labelX.toFixed(1)}" y="${headerBaseline - 10}" fill="${background.text}" font-size="25" font-weight="800" font-family="Arial, Helvetica, sans-serif">Claude</text>
          ${groundLine}
          ${staleBadge}
          ${refreshBadge}
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
      weekly: instance.weekly || null,
      fiveHour: instance.fiveHour || null,
      scoped: instance.scoped || null,
      fetchedAt: instance.fetchedAt ?? null,
      lastErrorKind: instance.lastErrorKind || null,
    };
  }

  function isLimitShape(value) {
    return Boolean(value)
      && typeof value === 'object'
      && Number.isFinite(value.percent)
      && typeof value.label === 'string';
  }

  // 读不到就当没有：历史是增益，不是启动前置条件。
  function hydrateState(raw) {
    const valid = raw && typeof raw === 'object' && raw.v === STATE_VERSION;
    const pick = (key) => (valid && isLimitShape(raw[key]) ? raw[key] : null);
    const weekly = pick('weekly');
    const fiveHour = pick('fiveHour');
    const scoped = pick('scoped');
    const hasAny = Boolean(weekly || fiveHour || scoped);
    return {
      weekly,
      fiveHour,
      scoped,
      fetchedAt: valid && Number.isFinite(raw.fetchedAt) ? raw.fetchedAt : null,
      lastErrorKind: valid && typeof raw.lastErrorKind === 'string' ? raw.lastErrorKind : null,
      // 水合出来的数据一定是上次会话留下的，直接标陈旧，等首次拉取成功再转正。
      displayState: hasAny ? 'STALE' : 'PENDING',
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
    setInstanceTimeout(instance, 'claudeusagePoll', () => runFetch(instance), pollIntervalMs(instance));
  }

  // 倒计时靠 resets_at 与本地时间推算，重绘不需要任何网络往返——所以它可以比
  // 拉取密集得多，而键面上的数字不会一动不动地僵在那里。
  function scheduleRedraw(instance) {
    setInstanceTimeout(instance, 'claudeusageRedraw', () => {
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
      instance.weekly = result.data.weekly;
      instance.fiveHour = result.data.fiveHour;
      instance.scoped = result.data.scoped;
      instance.fetchedAt = now;
      instance.lastErrorKind = null;
      instance.displayState = 'OK';
      return true;
    }
    instance.lastErrorKind = result.kind;
    // 有历史就降级为陈旧：额度不使用就不会上涨，旧值仍然有参考价值。
    instance.displayState = (instance.weekly || instance.fiveHour || instance.scoped)
      ? 'STALE'
      : result.kind;
    return false;
  }

  async function runFetch(instance, options = {}) {
    if (!instance) {
      return;
    }
    if (process.platform !== 'darwin') {
      instance.displayState = 'UNSUPPORTED';
      renderInstance(instance);
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

    const result = await (options.fetchUsageImpl ?? fetchUsage)();

    if (!isInstanceCurrent(instance, requestId)) {
      instance.fetching = false;
      return;
    }

    instance.fetching = false;
    const succeeded = applyResult(instance, result);
    if (succeeded) {
      flushState(instance);
    }
    renderInstance(instance);
    schedulePoll(instance);
  }

  // 手动刷新序列：立刻亮起刷新角标 → 跑一次 claude 让 CLI 刷新凭据（尽力而为，失败
  // 也继续）→ 清角标并照常拉取。角标在 claude 那 ~5s 窗口里可见，给用户"按下有反应"
  // 的即时反馈；随后的 GET 很快，最终由 runFetch 渲染结果。
  async function runManualRefresh(instance, options = {}) {
    const refresh = options.refresh ?? runClaudeRefresh;
    const run = options.run ?? runFetch;
    instance.refreshing = true;
    renderInstance(instance);
    try {
      await refresh();
    } catch {
      // 刷新失败不阻断拉取：旧 token 也许仍能用，不行就照常降级 STALE。
    }
    instance.refreshing = false;
    return run(instance, { immediateRender: true });
  }

  // 短按冷却：claude 刷新会 spawn 进程、真实消耗一点额度，连点毫无意义还会堆进程；
  // 冷却窗口内直接忽略。
  function handleShortPress(instance, options = {}) {
    const now = options.now ?? Date.now();
    const run = options.run ?? runManualRefresh;
    if (instance.lastManualAt && now - instance.lastManualAt < MANUAL_COOLDOWN_MS) {
      return undefined;
    }
    instance.lastManualAt = now;
    clearInstanceTimeout(instance, 'claudeusagePoll');
    return run(instance);
  }

  const PROBE_PARAM = '__claudeusageProbe';
  const DIAG_PARAM = '__claudeusageDiag';

  function buildDiagnostics(instance, hasToken) {
    return {
      platform: process.platform,
      hasToken,
      displayState: instance.displayState || 'PENDING',
      fetchedAt: instance.fetchedAt ?? null,
      lastErrorKind: instance.lastErrorKind || null,
    };
  }

  // 键面只有一个字形的空间，说不清"为什么没数据"。诊断把真相留给 PI：
  // 平台、凭据是否存在、上次拉取时间、上次失败原因。
  async function runDiagnostics(instance, options = {}) {
    const send = options.send ?? sendParamFromPlugin;
    const readToken = options.readToken ?? (async () => extractAccessToken(await runSecurity()));
    const run = options.run ?? runFetch;

    const hasToken = process.platform === 'darwin' ? Boolean(await readToken()) : false;
    await run(instance, { immediateRender: true });
    send({ [DIAG_PARAM]: buildDiagnostics(instance, hasToken) }, instance.context);
  }

  function handleLongPress(instance, options = {}) {
    const spawnFn = options.spawnFn ?? spawn;
    const url = instance.settings.usageUrl;
    if (process.platform !== 'darwin' || !url) {
      return;
    }
    try {
      // SDK 桥接层没有插件主动打开 URL 的通道（openurl 是宿主→插件方向的命令），
      // 所以走系统 open。该 action 本就仅支持 macOS。
      const child = spawnFn('open', [url], { stdio: 'ignore' });
      child.on?.('error', () => {});
      child.unref?.();
    } catch {
      // 打不开就算了，不该让一个副作用把整个按键拖进错误态。
    }
  }

  const config = {
    defaults: {
      pollSec: '300',
      redrawSec: '30',
      showWeekly: 'true',
      showFiveHour: 'true',
      showScoped: 'true',
      showBarBackground: 'true',
      severityColors: 'true',
      usageUrl: 'https://claude.ai/settings/usage',
      theme: 'ember',
      frameSize: 'optimal',
      showFrame: 'true',
    },
    normalizeSettings: (settings, defaults) => ({
      pollSec: normalizeNumberString(settings.pollSec, defaults.pollSec, 60, 3600),
      redrawSec: normalizeNumberString(settings.redrawSec, defaults.redrawSec, 10, 300),
      showWeekly: normalizeBooleanString(settings.showWeekly, defaults.showWeekly),
      showFiveHour: normalizeBooleanString(settings.showFiveHour, defaults.showFiveHour),
      showScoped: normalizeBooleanString(settings.showScoped, defaults.showScoped),
      showBarBackground: normalizeBooleanString(settings.showBarBackground, defaults.showBarBackground),
      severityColors: normalizeBooleanString(settings.severityColors, defaults.severityColors),
      usageUrl: normalizeUrl(settings.usageUrl, defaults.usageUrl),
    }),
    createState: (instance) => ({
      fetching: false,
      refreshing: false,
      requestId: 0,
      lastManualAt: 0,
      ...hydrateState(readPersistedState(instance.context)),
    }),
    onRun: (instance) => handleShortPress(instance),
    onLongPress: (instance) => handleLongPress(instance),
    onReady: (instance) => {
      if (process.platform !== 'darwin') {
        instance.displayState = 'UNSUPPORTED';
        return undefined;
      }
      scheduleRedraw(instance);
      return runFetch(instance);
    },
    onSettingsChanged: (instance, previousSettings) => {
      if (previousSettings.pollSec !== instance.settings.pollSec) {
        clearInstanceTimeout(instance, 'claudeusagePoll');
        schedulePoll(instance);
      }
      if (previousSettings.redrawSec !== instance.settings.redrawSec) {
        clearInstanceTimeout(instance, 'claudeusageRedraw');
        scheduleRedraw(instance);
      }
    },
    onParamFromPlugin: (instance, payload) => {
      if (payload?.[PROBE_PARAM] === 'true') {
        return runDiagnostics(instance);
      }
      return undefined;
    },
    onDispose: (instance) => {
      instance.requestId += 1;
      clearInstanceTimeout(instance, 'claudeusagePoll');
      clearInstanceTimeout(instance, 'claudeusageRedraw');
      flushState(instance);
    },
    // 第二参 { now } 仅供测试注入固定时钟；框架调用只传 instance，走 Date.now()。
    render: (instance, options) => renderClaudeUsageIcon(instance, options && options.now),
  };

  return {
    key: 'claudeusage',
    config,
    testing: {
      applyResult,
      extractAccessToken,
      fetchUsage,
      handleLongPress,
      handleShortPress,
      hydrateState,
      parseUsage,
      readScopedLimit,
      resolveClaudeCommand,
      runClaudeRefresh,
      runManualRefresh,
      severityFromPercent,
      visibleRows,
      worstSeverity,
    },
  };
}
