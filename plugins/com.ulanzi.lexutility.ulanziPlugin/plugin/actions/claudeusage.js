import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function createClaudeUsageAction(runtime) {
  const {
    appendDiagnosticLog,
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
    t,
    themeFor,
    toDataUrl,
    writePersistedState,
  } = runtime;

  const KEYCHAIN_SERVICE = 'Claude Code-credentials';
  const DIAGNOSTIC_LOG = 'claudeusage-fetch';
  // 陈旧时长上键面的门槛：连续 3 拍都没拉回来才算「一直在失败」，单次偶发失败不喊。
  const STALE_NOTICE_POLLS = 3;
  const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
  const OAUTH_BETA = 'oauth-2025-04-20';
  const REQUEST_TIMEOUT_MS = 12_000;
  const MANUAL_COOLDOWN_MS = 10_000;
  const OPEN_CLI_COOLDOWN_MS = 2_000;
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

  // Claude Code 按 config dir 分账存凭据：默认 `~/.claude` 用裸服务名，其它 profile 用
  // `Claude Code-credentials-<sha256(configDir) 前 8 位>`。用户切了 CLAUDE_CONFIG_DIR 又只读
  // 裸名的话，读到的是另一个 profile 的旧凭据——看着「有 token」，实际早就作废了。
  // 两个候选都试：哈希名优先，裸名兜底（用户的 CLI 版本可能还在用旧命名）。
  function keychainServices(options = {}) {
    const homeDir = options.homeDir ?? os.homedir();
    const raw = options.configDir ?? process.env.CLAUDE_CONFIG_DIR;
    const configDir = String(raw || '').trim();
    if (!configDir || configDir === path.join(homeDir, '.claude')) {
      return [KEYCHAIN_SERVICE];
    }
    const suffix = createHash('sha256').update(configDir).digest('hex').slice(0, 8);
    return [`${KEYCHAIN_SERVICE}-${suffix}`, KEYCHAIN_SERVICE];
  }

  function readKeychainItem(service, spawnFn = spawn) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawnFn('security', [
          'find-generic-password',
          '-s', service,
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

  async function runSecurity(spawnFn = spawn, options = {}) {
    for (const service of (options.services ?? keychainServices())) {
      const raw = await readKeychainItem(service, spawnFn);
      if (classifyCredential(raw) !== 'NONE') {
        return raw;
      }
    }
    return null;
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

  function parseCredential(raw) {
    if (typeof raw !== 'string' || !raw.trim()) {
      return null;
    }
    try {
      const cred = JSON.parse(raw.trim())?.claudeAiOauth;
      return cred && typeof cred === 'object' && !Array.isArray(cred) ? cred : null;
    } catch {
      return null;
    }
  }

  // 凭据三态。登出时 accessToken / refreshToken 双双清空（只剩 scopes、subscriptionType
  // 等残留元数据）→ NONE。
  //
  // REAUTH 是 2026-09-13 那次实机故障逼出来的第三态：accessToken 串还在、但 expiresAt
  // 已过，且 refreshToken 是**空串**。这种凭据 CLI 自己也换不回新 token（没有 refreshToken
  // 可用），只有重新登录能修。旧代码只看「串在不在」，把它判成已登录，于是每次短按都白跑
  // 一次 45s 的 claude spawn，拉取又必然 401，最后因为有历史数据降级成 STALE——键面挂着
  // 9 天前的数字，只有一个 15px 角标，谁也看不出该去重登。
  //
  // 过期但**有** refreshToken 仍算 USABLE：那是 CLI 能自愈的正常过期，走既有刷新路径。
  // expiresAt 缺失或不是有效数字时一律按 USABLE——这是非公开接口写的凭据，字段随时可能
  // 变，宁可发一次请求让服务端判，也不要凭一个缺失字段把用户推进重登提示。
  function classifyCredential(raw, now = Date.now()) {
    const cred = parseCredential(raw);
    if (!cred) {
      return 'NONE';
    }
    const hasAccess = typeof cred.accessToken === 'string' && cred.accessToken.length > 0;
    const hasRefresh = typeof cred.refreshToken === 'string' && cred.refreshToken.length > 0;
    if (!hasAccess && !hasRefresh) {
      return 'NONE';
    }
    const expiresAt = Number(cred.expiresAt);
    const expired = Number.isFinite(expiresAt) && expiresAt <= now;
    if (expired && !hasRefresh) {
      return 'REAUTH';
    }
    return 'USABLE';
  }

  // 「值得为它跑一次 claude 刷新吗」。REAUTH 与 NONE 都不值得：前者续不回来，后者没得续。
  function hasClaudeCredential(raw, now = Date.now()) {
    return classifyCredential(raw, now) === 'USABLE';
  }

  async function hasClaudeLogin(options = {}) {
    const readRaw = options.readRaw ?? runSecurity;
    return hasClaudeCredential(await readRaw(), options.now ?? Date.now());
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
  // 不是拉取的前置条件。先判登录：CLI 未登录时 `claude -p` 只会打印 "Not logged in"
  // 却仍以 0 退出（无法据退出码识别），跑它纯属浪费一次 spawn；直接跳过并回 NOT_LOGGED_IN，
  // 随后的 fetch 会照常给出 NO_TOKEN / "Sign in"。
  async function runClaudeRefresh(options = {}) {
    const hasLogin = options.hasLogin ?? hasClaudeLogin;
    if (!(await hasLogin())) {
      return { ok: false, reason: 'NOT_LOGGED_IN' };
    }
    return spawnClaudeRefresh(options);
  }

  // stdio 全丢弃，只关心退出码；超时就杀掉，绝不让它挂住按键。
  function spawnClaudeRefresh(options = {}) {
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

  // 凭据 seam 只有一个：readCredential 返回钥匙串原文，分类与取 token 都由这里做，
  // 免得「判定用一份、请求用另一份」两条路走岔。
  async function fetchUsage(options = {}) {
    const doFetch = options.fetchImpl ?? fetch;
    const readRaw = options.readCredential ?? runSecurity;
    const now = options.now ?? Date.now();

    const raw = await readRaw();
    const credentialState = classifyCredential(raw, now);
    if (credentialState === 'NONE') {
      return { ok: false, kind: 'NO_TOKEN' };
    }
    // 已知续不回来：不再发一次注定 401 的请求，直接给出「重新登录」。
    if (credentialState === 'REAUTH') {
      return { ok: false, kind: 'REAUTH' };
    }
    const token = extractAccessToken(raw);
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

  // 陈旧时长。只留最大单位（9d / 5h / 40m）——键面这点空间容不下两级，而"有多旧"这个
  // 判断本来也只需要量级。门槛是连续 STALE_NOTICE_POLLS 拍都没拉回来：单次偶发失败
  // （下一拍就可能恢复）不该在键面上留字。
  function staleAgeLabel(instance, nowMs) {
    if (!Number.isFinite(instance.fetchedAt)) {
      return '';
    }
    const ageMs = nowMs - instance.fetchedAt;
    const pollMs = (Number.parseInt(instance.settings.pollSec, 10) || 300) * 1000;
    if (ageMs < pollMs * STALE_NOTICE_POLLS) {
      return '';
    }
    const minutes = Math.floor(ageMs / 60_000);
    if (minutes < 60) {
      return `${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
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
    // 刷新中把百分比替换成 `…`，等拉取回来再显示新值——给用户「正在取新数」的明确信号，
    // 而不是让旧数字杵在那里让人以为没反应。倒计时是本地推算的，仍照常显示。
    return renderMeterRow(geometry, theme, {
      percent: row.percent,
      color: severityColor(row.severity, theme, options.severityColors),
      label: row.label,
      // 用 ASCII `...` 而非 `…`：renderMeterRow 的数字/单位分栏正则把 `[\d.]+` 当数字，
      // 三个点会走大字号分支，和百分比同等视觉重量；单个 `…` 会掉进小字号量纲分支。
      value: options.refreshing ? '...' : `${row.percent}%`,
      tail,
      tailColor: countdownColor(tail, theme),
      showBar: options.showBar,
    });
  }

  const ERROR_COPY = {
    NO_TOKEN: { glyph: 'key', text: 'Sign in' },
    REAUTH: { glyph: 'key', text: 'Re-login' },
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

  // 需要重新登录：读不到 token（NO_TOKEN，登出），或凭据过期且无 refreshToken（REAUTH，
  // CLI 续不回来）。两者即便还留着上次的陈旧数据也照样进登录提示——拉不到新值时继续显示
  // 旧百分比只会误导。单击此态直接打开 CLI 让用户登录，不浪费一次注定失败的刷新。
  const LOGIN_KINDS = new Set(['NO_TOKEN', 'REAUTH']);

  function needsLogin(instance) {
    return LOGIN_KINDS.has(instance.displayState) || LOGIN_KINDS.has(instance.lastErrorKind);
  }

  function renderClaudeUsageIcon(instance, nowOverride) {
    const theme = themeFor(instance.settings);
    const frame = frameFor(instance.settings);
    const background = renderThemeBackdrop(theme, theme.accent, frame);
    const rows = visibleRows(instance);
    const state = instance.displayState || 'PENDING';
    const language = instance.settings.uiLanguage;
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

    // 登录提示优先于陈旧数据：登出时不显示旧百分比，整块换成 Sign in 提示（单击打开 CLI）。
    const loginNeeded = needsLogin(instance);

    let body = '';
    if (!loginNeeded && hasData) {
      const gap = 6;
      const rowHeight = (bodyBottom - bodyTop - gap * (rows.length - 1)) / rows.length;
      body = rows.map((row, index) => renderDataRow(
        row,
        { x: boxX, y: bodyTop + index * (rowHeight + gap), width: boxWidth, height: rowHeight },
        theme,
        { showBar, severityColors, nowMs, refreshing: instance.refreshing },
      )).join('');
    } else {
      // 登录提示要报出具体哪一种：NO_TOKEN 是登出（Sign in），REAUTH 是凭据续不回来
      // （Re-login）。两者的下一步动作不同，键面上不能混成同一句话。
      const loginKind = LOGIN_KINDS.has(instance.displayState)
        ? instance.displayState
        : instance.lastErrorKind;
      const errState = loginNeeded ? loginKind : state;
      const copy = ERROR_COPY[errState] || ERROR_COPY.PENDING;
      const color = errState === 'PENDING' ? theme.muted : theme.warn;
      body = `
        ${renderErrorGlyph(copy.glyph, 128, 140, color)}
        <text x="128" y="188" text-anchor="middle" fill="${color}" font-size="22" font-weight="800" font-family="Arial, Helvetica, sans-serif">${escapeXml(t(copy.text, language))}</text>`;
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
    const staleBadge = !instance.refreshing && !loginNeeded && instance.displayState === 'STALE' && hasData
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

    // 陈旧时长写在角标正下方（角标 y≈58，分隔线 y=88，中间这条带子是空的），右对齐到
    // 内容箱右沿。"Claude" 字样止于 x≈184，不会撞上。只在 STALE 且够旧时出现——
    // 上次那次故障就是因为「旧了多久」只存在于 PI 诊断面板里，键面上完全看不出来。
    const staleAge = instance.displayState === 'STALE' && !instance.refreshing && !loginNeeded
      ? staleAgeLabel(instance, nowMs)
      : '';
    const staleAgeText = staleAge
      ? `<text x="${boxX + boxWidth}" y="82" text-anchor="end" fill="${theme.muted}" font-size="13" font-weight="700" font-family="Arial, Helvetica, sans-serif">${escapeXml(staleAge)}</text>`
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
          ${staleAgeText}
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

  // 失败留痕。上一次排障（凭据过期 9 天没人发现）最贵的一环，是插件在失败路径上一行日志
  // 都不打——宿主调试模式开着也只有一句 "connected"，只能靠反推。这里只记「原因发生变化」
  // 的那一拍：同一个原因连续失败不刷屏，恢复也记一条，否则日志里只有坏消息、看不出何时好的。
  function logFetchOutcome(instance, kind, options = {}) {
    const append = options.appendLog ?? appendDiagnosticLog;
    if (typeof append !== 'function' || instance.lastLoggedKind === kind) {
      return;
    }
    instance.lastLoggedKind = kind;
    const now = options.now ?? Date.now();
    append(DIAGNOSTIC_LOG, {
      at: now,
      kind,
      displayState: instance.displayState || 'PENDING',
      staleMs: Number.isFinite(instance.fetchedAt) ? now - instance.fetchedAt : null,
    });
  }

  function applyResult(instance, result, options = {}) {
    const now = options.now ?? Date.now();
    if (result.ok) {
      instance.weekly = result.data.weekly;
      instance.fiveHour = result.data.fiveHour;
      instance.scoped = result.data.scoped;
      instance.lastErrorKind = null;
      instance.displayState = 'OK';
      // 先记账再改 fetchedAt：恢复那一条要带着「之前旧了多久」，否则恢复日志永远是 0。
      logFetchOutcome(instance, 'OK', { ...options, now });
      instance.fetchedAt = now;
      return true;
    }
    instance.lastErrorKind = result.kind;
    // 有历史就降级为陈旧：额度不使用就不会上涨，旧值仍然有参考价值。
    instance.displayState = (instance.weekly || instance.fiveHour || instance.scoped)
      ? 'STALE'
      : result.kind;
    logFetchOutcome(instance, result.kind, { ...options, now });
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

  // 打开交互式 claude 终端：写一个临时 .command 用系统 open 拉起（走 LaunchServices，
  // 不需要 Automation 授权，比 osascript 控制 Terminal 更稳）。未登录时交互式 claude 会
  // 自行引导登录，因此「登录」与「打开 CLI」共用同一入口。冷却去重，避免双击在登出态
  // （单击已开一次）又被 onDoublePress 开出第二个窗口。
  function openClaudeCli(instance, options = {}) {
    const now = options.now ?? Date.now();
    const spawnFn = options.spawnFn ?? spawn;
    const writeFile = options.writeFile ?? ((p, c) => fs.writeFileSync(p, c, { mode: 0o755 }));
    const resolveCommand = options.resolveCommand ?? resolveClaudeCommand;
    const platform = options.platform ?? process.platform;
    if (platform !== 'darwin') {
      return undefined;
    }
    if (instance.lastOpenCliAt && now - instance.lastOpenCliAt < OPEN_CLI_COOLDOWN_MS) {
      return undefined;
    }
    instance.lastOpenCliAt = now;
    try {
      const spec = resolveCommand(REFRESH_COMMAND);
      const bin = spec ? spec.resolved : REFRESH_COMMAND;
      const scriptPath = options.scriptPath ?? path.join(os.tmpdir(), 'lex-claude-cli.command');
      // exec 让 claude 顶替这个 shell 占住 TTY，成为可交互会话；quote 兜住带空格的路径。
      writeFile(scriptPath, `#!/bin/zsh\nexec "${bin}"\n`);
      const child = spawnFn('open', [scriptPath], { stdio: 'ignore' });
      child.on?.('error', () => {});
      child.unref?.();
    } catch {
      // 打不开就算了，不该让一个副作用把按键拖进错误态。
    }
    return undefined;
  }

  // 短按：需要登录时直接打开 CLI 让用户登录；否则跑手动刷新。刷新有冷却——claude 刷新
  // 会 spawn 进程、真实消耗一点额度，连点毫无意义还会堆进程；冷却窗口内直接忽略。
  function handleShortPress(instance, options = {}) {
    const now = options.now ?? Date.now();
    if (needsLogin(instance)) {
      return (options.openCli ?? openClaudeCli)(instance, { now });
    }
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

  function buildDiagnostics(instance, credentialState) {
    return {
      platform: process.platform,
      // hasToken 保留给旧版 PI；credentialState 才说得清「有串但续不回来」这一态。
      hasToken: credentialState === 'USABLE',
      credentialState,
      displayState: instance.displayState || 'PENDING',
      fetchedAt: instance.fetchedAt ?? null,
      lastErrorKind: instance.lastErrorKind || null,
    };
  }

  // 键面只有一个字形的空间，说不清"为什么没数据"。诊断把真相留给 PI：
  // 平台、凭据是否存在、上次拉取时间、上次失败原因。
  async function runDiagnostics(instance, options = {}) {
    const send = options.send ?? sendParamFromPlugin;
    const readRaw = options.readCredential ?? runSecurity;
    const run = options.run ?? runFetch;

    const credentialState = process.platform === 'darwin'
      ? classifyCredential(await readRaw())
      : 'NONE';
    await run(instance, { immediateRender: true });
    send({ [DIAG_PARAM]: buildDiagnostics(instance, credentialState) }, instance.context);
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
      lastOpenCliAt: 0,
      ...hydrateState(readPersistedState(instance.context)),
    }),
    onRun: (instance) => handleShortPress(instance),
    onDoublePress: (instance) => openClaudeCli(instance),
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
      classifyCredential,
      extractAccessToken,
      fetchUsage,
      hasClaudeCredential,
      keychainServices,
      staleAgeLabel,
      hasClaudeLogin,
      handleLongPress,
      handleShortPress,
      hydrateState,
      needsLogin,
      openClaudeCli,
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
