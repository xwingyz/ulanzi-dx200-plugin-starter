import { spawn } from 'node:child_process';
import os from 'node:os';

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
  const MANUAL_FEEDBACK_MS = 500;
  const STATE_VERSION = 1;

  // 品牌色：Claude 标记的身份标识，固定不随主题。
  const BRAND_CLAUDE = '#d97757';

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

  // 行几何与排版走共享的 renderMeterRow，保证与 chatgptusage 并排时观感必然一致；
  // 这里只决定领域语义部分：颜色由 severity 映射而来。
  function renderDataRow(row, geometry, theme, options) {
    const base = renderMeterRow(geometry, theme, {
      percent: row.percent,
      color: severityColor(row.severity, theme, options.severityColors),
      label: row.label,
      value: `${row.percent}%`,
      tail: formatCountdown(row.resetsAt),
      tailColor: countdownColor(formatCountdown(row.resetsAt), theme),
      showBar: options.showBar,
    });
    // 流光叠在填充之上：id 用行的 y 派生，保证多行之间不撞名。
    const gloss = options.animate && options.showBar
      ? renderBarGloss(geometry, row.percent, `${options.scope}-${Math.round(geometry.y)}`, options.nowMs)
      : '';
    return base + gloss;
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

  // ---------------------------------------------------------------- 键面动效
  //
  // 宿主把 SVG 当静态位图渲染：SMIL / CSS 自动画不生效，且开发规则明令「不得依赖
  // 宿主可能忽略的 filter」。因此这里的动效恪守两条边界：
  //   1) 只用实心图形 + 线性/径向渐变 + 透明度作画。软光晕靠径向渐变的透明停止点
  //      伪造，绝不使用 feGaussianBlur；软边由渐变自身产生，不越界不硬切。
  //   2) 相位由 Date.now() 驱动，画面靠 scheduleAnim 逐帧重推图动起来（见运行态）。
  // 所有渐变 id 都带实例上下文后缀：宿主可能把多个键内联进同一 DOM，同名 id 会串色。

  const ANIM_INTERVAL_MS = 120; // ≈8fps。慢光晕/波纹/流光在此帧率已顺滑，功耗可控。
  const TAU = Math.PI * 2;

  function animEnabled(instance) {
    return normalizeBooleanString(instance.settings.animate, 'true') === 'true';
  }

  // 上下文可能含 :: / 空格等非法 id 字符，压成 [a-z0-9]。
  function animScope(instance) {
    return String(instance.context || 'x').replace(/[^a-z0-9]/gi, '') || 'x';
  }

  // 归一化相位 0..1；phase 用来错开多条同源动画。
  function wave(nowMs, periodMs, phase = 0) {
    return ((((nowMs / periodMs) + phase) % 1) + 1) % 1;
  }

  // 相对亮度：用来判断主题深浅，决定鎏光高光该偏白还是偏彩。
  function hexLum(hex) {
    const n = Number.parseInt(String(hex).slice(1), 16);
    if (!Number.isFinite(n)) return 0.5;
    const r = ((n >> 16) & 0xff) / 255;
    const g = ((n >> 8) & 0xff) / 255;
    const b = (n & 0xff) / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  // 朝白色插值，把主题色提亮成流光高光。
  function mixWhite(hex, amt) {
    const n = Number.parseInt(String(hex).slice(1), 16);
    if (!Number.isFinite(n)) return hex;
    const ch = (sh) => {
      const v = (n >> sh) & 0xff;
      return Math.round(v + (255 - v) * amt);
    };
    return `#${(((ch(16) << 16) | (ch(8) << 8) | ch(0)) >>> 0).toString(16).padStart(6, '0')}`;
  }

  // 背景光晕 + 品牌脉冲波纹：整层画在内容坐标系（0..256），随安全框一起缩放。
  // 光斑沿慢正弦缓缓漂移、明灭呼吸；波纹从标记处一圈圈扩散、扩散时变淡变细。
  function renderAmbiance(theme, scope, nowMs) {
    const blobs = [
      { color: BRAND_CLAUDE, bx: 78, by: 150, ax: 26, ay: 18, r: 116, period: 17_000, phase: 0.0, op: 0.20 },
      { color: theme.accent, bx: 188, by: 96, ax: 22, ay: 24, r: 104, period: 21_000, phase: 0.37, op: 0.16 },
      { color: theme.ok, bx: 150, by: 208, ax: 20, ay: 14, r: 92, period: 27_000, phase: 0.61, op: 0.10 },
    ];
    let defs = '';
    let shapes = '';
    blobs.forEach((b, i) => {
      const id = `au${i}-${scope}`;
      const a = wave(nowMs, b.period, b.phase) * TAU;
      const a2 = wave(nowMs, b.period * 1.3, b.phase) * TAU;
      const cx = b.bx + Math.cos(a) * b.ax;
      const cy = b.by + Math.sin(a * 0.9) * b.ay;
      const breathe = b.op * (0.78 + 0.22 * Math.sin(a2)); // 整体透明度呼吸
      defs += `<radialGradient id="${id}" cx="50%" cy="50%" r="50%">`
        + `<stop offset="0%" stop-color="${b.color}" stop-opacity="${breathe.toFixed(3)}"/>`
        + `<stop offset="60%" stop-color="${b.color}" stop-opacity="${(breathe * 0.35).toFixed(3)}"/>`
        + `<stop offset="100%" stop-color="${b.color}" stop-opacity="0"/>`
        + '</radialGradient>';
      shapes += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${b.r}" fill="url(#${id})"/>`;
    });
    // 品牌脉冲：从标记中心缓缓扩散的两道细环，低透明度、走在内容之后。
    const originX = 63;
    const originY = 60;
    const ringCount = 2;
    let ripple = '';
    for (let k = 0; k < ringCount; k += 1) {
      const p = wave(nowMs, 5200, k / ringCount);
      const r = 10 + p * 62;
      const op = (1 - p) * 0.20;
      const sw = (1 - p) * 2.0 + 0.4;
      ripple += `<circle cx="${originX}" cy="${originY}" r="${r.toFixed(1)}" fill="none" `
        + `stroke="${BRAND_CLAUDE}" stroke-width="${sw.toFixed(2)}" opacity="${op.toFixed(3)}"/>`;
    }
    return `<defs>${defs}</defs>${shapes}${ripple}`;
  }

  // 鎏光：给标题文字换成一条横向扫过的高光渐变填充。不新增 text 元素（键面 text
  // 数量被测试锁定），仅改 fill。亮带中心从 -0.2 扫到 1.2，让亮带完整进出字面；
  // 各停止点 clamp 到 [0,1] 后天然单调递增，符合 SVG 渐变要求。
  function shimmerFill(scope, baseColor, highlight, nowMs) {
    const id = `shine-${scope}`;
    const c = -0.2 + wave(nowMs, 3600) * 1.4;
    const clamp = (v) => Math.max(0, Math.min(1, v));
    const left = clamp(c - 0.16);
    const mid = clamp(c);
    const right = clamp(c + 0.16);
    const def = `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0">`
      + `<stop offset="0" stop-color="${baseColor}"/>`
      + `<stop offset="${left.toFixed(3)}" stop-color="${baseColor}"/>`
      + `<stop offset="${mid.toFixed(3)}" stop-color="${highlight}"/>`
      + `<stop offset="${right.toFixed(3)}" stop-color="${baseColor}"/>`
      + '<stop offset="1" stop-color="' + baseColor + '"/>'
      + '</linearGradient>';
    return { id, def };
  }

  // 进度条不再平淡：填充段上叠一条流光（objectBoundingBox 映射到填充矩形内，不外溢），
  // 再在进度到达处点一束呼吸亮缘。用中性亮色，读感不依赖条本身的语义色。
  function renderBarGloss(geometry, percent, scope, nowMs) {
    if (percent == null) return '';
    const { x, y, width, height } = geometry;
    const pct = Math.max(0, Math.min(100, percent));
    const filled = width * pct / 100;
    if (filled < 3) return '';
    const glossId = `gloss-${scope}`;
    const edgeId = `edge-${scope}`;
    const clamp = (v) => Math.max(0, Math.min(1, v));
    const c = -0.15 + wave(nowMs, 2800) * 1.3; // 亮带在填充宽度内的相对位置
    const gloss = `<linearGradient id="${glossId}" x1="0" y1="0" x2="1" y2="0">`
      + '<stop offset="0" stop-color="#ffffff" stop-opacity="0"/>'
      + `<stop offset="${clamp(c - 0.12).toFixed(3)}" stop-color="#ffffff" stop-opacity="0"/>`
      + `<stop offset="${clamp(c).toFixed(3)}" stop-color="#ffffff" stop-opacity="0.32"/>`
      + `<stop offset="${clamp(c + 0.12).toFixed(3)}" stop-color="#ffffff" stop-opacity="0"/>`
      + '<stop offset="1" stop-color="#ffffff" stop-opacity="0"/>'
      + '</linearGradient>';
    // 竖向亮缘：中间亮、上下淡出，呼吸明灭。
    const edge = `<linearGradient id="${edgeId}" x1="0" y1="0" x2="0" y2="1">`
      + '<stop offset="0" stop-color="#ffffff" stop-opacity="0"/>'
      + '<stop offset="0.5" stop-color="#ffffff" stop-opacity="0.85"/>'
      + '<stop offset="1" stop-color="#ffffff" stop-opacity="0"/>'
      + '</linearGradient>';
    const pulse = 0.18 + 0.24 * (0.5 + 0.5 * Math.sin(wave(nowMs, 1600) * TAU));
    const ex = x + filled;
    return `<defs>${gloss}${edge}</defs>`
      + `<rect x="${x}" y="${y}" width="${filled.toFixed(1)}" height="${height}" rx="3" fill="url(#${glossId})"/>`
      + `<rect x="${(ex - 1.5).toFixed(1)}" y="${y}" width="3" height="${height}" fill="url(#${edgeId})" opacity="${pulse.toFixed(3)}"/>`;
  }

  function renderClaudeUsageIcon(instance) {
    const theme = themeFor(instance.settings);
    const frame = frameFor(instance.settings);
    const background = renderThemeBackdrop(theme, theme.accent, frame);
    const rows = visibleRows(instance);
    const state = instance.displayState || 'PENDING';
    const hasData = rows.length > 0;
    const severityColors = normalizeBooleanString(instance.settings.severityColors, 'true') === 'true';
    const showBar = normalizeBooleanString(instance.settings.showBarBackground, 'true') === 'true';

    const severity = hasData ? worstSeverity(rows) : 'normal';

    const animate = animEnabled(instance);
    const nowMs = Date.now();
    const scope = animScope(instance);
    const ambiance = animate ? renderAmbiance(theme, scope, nowMs) : '';
    // 深底用近白暖金作高光；浅底（sand）用主题彩色，避免白光扫过深字反而糊掉。
    const shine = animate
      ? shimmerFill(
        scope,
        background.text,
        hexLum(theme.canvas) < 0.5 ? mixWhite(theme.accent, 0.55) : theme.accent,
        nowMs,
      )
      : null;
    const headerFill = shine ? `url(#${shine.id})` : background.text;
    const shineDef = shine ? `<defs>${shine.def}</defs>` : '';

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
        { showBar, severityColors, animate, scope, nowMs },
      )).join('');
    } else {
      const copy = ERROR_COPY[state] || ERROR_COPY.PENDING;
      const color = state === 'PENDING' ? theme.muted : theme.warn;
      body = `
        ${renderErrorGlyph(copy.glyph, 128, 140, color)}
        <text x="128" y="188" text-anchor="middle" fill="${color}" font-size="22" font-weight="800" font-family="Arial, Helvetica, sans-serif">${escapeXml(copy.text)}</text>`;
    }

    // STALE 徽章：在 header 右上角画对应失败原因的错误图标（缩小版），而不只是一个
    // 说不清原因的琥珀点。图标本身回答"要不要动手"——bang=重新登录、offline=网络、
    // wait=被限流。AUTH / NO_TOKEN 需要用户去刷新凭据，用 crit 提级；其余是暂时性
    // 故障，用 warn。
    const staleBadge = instance.displayState === 'STALE' && hasData
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
          ${shineDef}
          ${ambiance}
          ${mark}
          <text x="${labelX.toFixed(1)}" y="${headerBaseline - 10}" fill="${headerFill}" font-size="25" font-weight="800" font-family="Arial, Helvetica, sans-serif">Claude</text>
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

  // 动效帧循环：≈8fps 重推图让光晕/波纹/流光动起来，顺带覆盖倒计时刷新。
  function scheduleAnim(instance) {
    setInstanceTimeout(instance, 'claudeusageAnim', () => {
      renderInstance(instance);
      scheduleAnim(instance);
    }, ANIM_INTERVAL_MS);
  }

  // 开了动效走高频动画帧；关了退回低频重绘（省功耗）。两个时钟互斥，切换时先清干净。
  function startClock(instance) {
    clearInstanceTimeout(instance, 'claudeusageAnim');
    clearInstanceTimeout(instance, 'claudeusageRedraw');
    if (animEnabled(instance)) {
      scheduleAnim(instance);
    } else {
      scheduleRedraw(instance);
    }
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

  // 短按冷却：接口对频率敏感，连点会把自己戳到 429——而 429 恰恰是这个 action
  // 最没用的状态（它本来就是来告诉你还剩多少的）。
  function handleShortPress(instance, options = {}) {
    const now = options.now ?? Date.now();
    const run = options.run ?? runFetch;
    if (instance.lastManualAt && now - instance.lastManualAt < MANUAL_COOLDOWN_MS) {
      return undefined;
    }
    instance.lastManualAt = now;
    clearInstanceTimeout(instance, 'claudeusagePoll');
    return run(instance, { immediateRender: true });
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
      animate: 'true',
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
      animate: normalizeBooleanString(settings.animate, defaults.animate),
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
      if (process.platform !== 'darwin') {
        instance.displayState = 'UNSUPPORTED';
        return undefined;
      }
      startClock(instance);
      return runFetch(instance);
    },
    onSettingsChanged: (instance, previousSettings) => {
      if (previousSettings.pollSec !== instance.settings.pollSec) {
        clearInstanceTimeout(instance, 'claudeusagePoll');
        schedulePoll(instance);
      }
      // 动效开关或重绘间隔变了都重起时钟：startClock 内部会按最新设置选对分支。
      if (previousSettings.animate !== instance.settings.animate
        || previousSettings.redrawSec !== instance.settings.redrawSec) {
        startClock(instance);
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
      clearInstanceTimeout(instance, 'claudeusageAnim');
      flushState(instance);
    },
    render: (instance) => renderClaudeUsageIcon(instance),
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
      severityFromPercent,
      visibleRows,
      worstSeverity,
    },
  };
}
