import assert from 'node:assert/strict';
import { test } from 'node:test';

import { __testing } from '../plugins/com.ulanzi.lexutility.ulanziPlugin/plugin/app.js';

const {
  ACTION_CONFIGS,
  applyResult,
  classifyCredential,
  extractAccessToken,
  fetchUsage,
  formatCountdown,
  handleShortPress,
  hasClaudeCredential,
  hasClaudeLogin,
  hydrateState,
  keychainServices,
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
} = __testing;

const config = ACTION_CONFIGS.claudeusage;

// 接口返回的真实形状（2026-07-19 实测），只保留本 action 读取的字段。
function usagePayload(overrides = {}) {
  return {
    five_hour: { utilization: 57, resets_at: '2026-07-19T15:49:59.897757+00:00' },
    seven_day: { utilization: 66, resets_at: '2026-07-20T22:59:59.897814+00:00' },
    limits: [
      { kind: 'session', percent: 57, severity: 'normal', resets_at: '2026-07-19T15:49:59.897757+00:00' },
      { kind: 'weekly_all', percent: 66, severity: 'normal', resets_at: '2026-07-20T22:59:59.897814+00:00' },
    ],
    ...overrides,
  };
}

function instance(overrides = {}) {
  const { settings, ...rest } = overrides;
  return {
    context: 'test::1',
    settings: { ...config.defaults, ...(settings || {}) },
    displayState: 'OK',
    weekly: null,
    fiveHour: null,
    scoped: null,
    fetchedAt: null,
    lastErrorKind: null,
    ...rest,
  };
}

const limit = (label, percent, severity = 'normal') => ({ label, percent, severity, resetsAt: null });

test('keychain payload yields the oauth access token, and never throws on junk', () => {
  assert.equal(
    extractAccessToken(JSON.stringify({ claudeAiOauth: { accessToken: 'sk-tok' } })),
    'sk-tok',
  );
  // 钥匙串里同时存着 mcpOAuth，取值不能撞上它。
  assert.equal(
    extractAccessToken(JSON.stringify({ mcpOAuth: { x: 1 }, claudeAiOauth: { accessToken: 'sk-2' } })),
    'sk-2',
  );
  for (const junk of ['', '   ', 'not json', '{"claudeAiOauth":{}}', '{}', null, undefined]) {
    assert.equal(extractAccessToken(junk), null, `should reject ${JSON.stringify(junk)}`);
  }
});

test('limits[] wins over the top-level objects, which act as fallback', () => {
  const fromLimits = parseUsage(usagePayload());
  assert.equal(fromLimits.weekly.percent, 66);
  assert.equal(fromLimits.fiveHour.percent, 57);
  assert.equal(fromLimits.weekly.label, 'W');
  assert.equal(fromLimits.fiveHour.label, '5H');

  // limits 整个消失时退回顶层 five_hour / seven_day 的 utilization。
  const fallback = parseUsage(usagePayload({ limits: undefined }));
  assert.equal(fallback.weekly.percent, 66);
  assert.equal(fallback.fiveHour.percent, 57);
});

test('a response with nothing readable is a failure, not an empty key face', () => {
  assert.equal(parseUsage({}), null);
  assert.equal(parseUsage({ limits: [] }), null);
  assert.equal(parseUsage(null), null);
  // 接口改字段名就是这个形状：结构还在，值读不出来。
  assert.equal(parseUsage({ five_hour: { pct: 57 }, seven_day: { pct: 66 } }), null);
});

test('scoped weekly limit ignores is_active and keeps the tightest of several', () => {
  const payload = usagePayload({
    limits: [
      ...usagePayload().limits,
      {
        kind: 'weekly_scoped', percent: 40, severity: 'normal', is_active: true,
        resets_at: '2026-07-20T22:59:59Z', scope: { model: { display_name: 'Opus' } },
      },
      {
        kind: 'weekly_scoped', percent: 75, severity: 'warning', is_active: false,
        resets_at: '2026-07-20T22:59:59Z', scope: { model: { display_name: 'Fable' } },
      },
    ],
  });
  const scoped = readScopedLimit(payload);
  // 取 75 那条（更紧），而不是 is_active 为 true 的 40 那条。
  assert.equal(scoped.percent, 75);
  assert.equal(scoped.label, 'WF');
  assert.equal(scoped.severity, 'warning');
});

test('scoped label degrades to W* when the model name is unusable', () => {
  const mk = (scope) => readScopedLimit({
    limits: [{ kind: 'weekly_scoped', percent: 50, resets_at: null, scope }],
  });
  assert.equal(mk({ model: { display_name: 'Sonnet' } }).label, 'WS');
  assert.equal(mk({ model: { display_name: '  ' } }).label, 'W*');
  assert.equal(mk({ model: { display_name: null } }).label, 'W*');
  assert.equal(mk(null).label, 'W*');
});

test('missing scoped entry means no fourth row at all', () => {
  assert.equal(readScopedLimit(usagePayload()), null);
  assert.equal(parseUsage(usagePayload()).scoped, null);
});

// 阈值与 chatgptusage 共用：那边没有 severity 字段，两键并排时同一百分比必须同色。
test('severity falls back to percent thresholds when the field is gone', () => {
  assert.equal(severityFromPercent(0), 'normal');
  assert.equal(severityFromPercent(74), 'normal');
  assert.equal(severityFromPercent(75), 'warning');
  assert.equal(severityFromPercent(89), 'warning');
  assert.equal(severityFromPercent(90), 'critical');
  assert.equal(severityFromPercent(null), 'normal');

  const stripped = parseUsage(usagePayload({
    limits: [{ kind: 'weekly_all', percent: 97, resets_at: null }],
  }));
  assert.equal(stripped.weekly.severity, 'critical');
});

test('countdown keeps only the largest unit', () => {
  const now = Date.parse('2026-07-19T00:00:00Z');
  const at = (ms) => formatCountdown(now + ms, now);
  assert.equal(at(45 * 60_000), '45m');
  assert.equal(at(59 * 60_000), '59m');
  // 跨到小时后就不再提分钟——这一栏是最次要的信息，粗粒度足够。
  assert.equal(at(60 * 60_000), '1h');
  assert.equal(at(2 * 3600_000 + 14 * 60_000), '2h');
  assert.equal(at(23 * 3600_000 + 59 * 60_000), '23h');
  assert.equal(at(24 * 3600_000), '1d');
  assert.equal(at(47 * 3600_000), '1d');
  assert.equal(at(6 * 24 * 3600_000), '6d');
  assert.equal(at(0), 'now');
  assert.equal(at(-5000), 'now');
  assert.equal(formatCountdown(null, now), '');
  assert.equal(formatCountdown(Number.NaN, now), '');
});

test('a failure keeps the last known numbers instead of blanking the key', () => {
  const withHistory = instance({ weekly: limit('W', 66), fiveHour: limit('5H', 57) });
  assert.equal(applyResult(withHistory, { ok: false, kind: 'AUTH' }), false);
  assert.equal(withHistory.displayState, 'STALE');
  assert.equal(withHistory.lastErrorKind, 'AUTH');
  // 数值必须原样留着——额度不用就不会涨，陈旧值仍然有参考价值。
  assert.equal(withHistory.weekly.percent, 66);
});

test('the same failure without history surfaces the specific reason', () => {
  for (const kind of ['NO_TOKEN', 'AUTH', 'NETWORK', 'RATE_LIMITED']) {
    const fresh = instance();
    applyResult(fresh, { ok: false, kind });
    assert.equal(fresh.displayState, kind, `${kind} should reach the key face verbatim`);
  }
});

test('a success clears the error and stamps the fetch time', () => {
  const inst = instance({ displayState: 'AUTH', lastErrorKind: 'AUTH' });
  const data = parseUsage(usagePayload());
  assert.equal(applyResult(inst, { ok: true, data }, { now: 1234 }), true);
  assert.equal(inst.displayState, 'OK');
  assert.equal(inst.lastErrorKind, null);
  assert.equal(inst.fetchedAt, 1234);
});

test('hydrated data is stale until the first live fetch confirms it', () => {
  const persisted = {
    v: 1,
    weekly: { label: 'W', percent: 66, severity: 'normal', resetsAt: 1 },
    fiveHour: null,
    scoped: null,
    fetchedAt: 99,
  };
  assert.equal(hydrateState(persisted).displayState, 'STALE');
  assert.equal(hydrateState(persisted).weekly.percent, 66);

  // 版本不符、损坏、缺失都降级为空，绝不阻止 action 启动。
  for (const bad of [{ v: 99, weekly: persisted.weekly }, null, undefined, 'nope', { v: 1 }]) {
    const state = hydrateState(bad);
    assert.equal(state.displayState, 'PENDING');
    assert.equal(state.weekly, null);
  }
  // 形状不对的条目要被丢掉，而不是原样带进渲染。
  assert.equal(hydrateState({ v: 1, weekly: { percent: 'lots' } }).weekly, null);
});

test('rows put the 5-hour window first, and the worst severity drives the mark', () => {
  const full = instance({
    weekly: limit('W', 66), fiveHour: limit('5H', 57), scoped: limit('WF', 75, 'warning'),
  });
  // 5H 最先撞墙也最常看，排第一行；W 次之；模型周限收尾。
  assert.deepEqual(visibleRows(full).map((r) => r.label), ['5H', 'W', 'WF']);
  assert.equal(worstSeverity(visibleRows(full)), 'warning');

  const noScoped = instance({ ...full, settings: { showScoped: 'false' } });
  assert.deepEqual(visibleRows(noScoped).map((r) => r.label), ['5H', 'W']);
  // 关掉那一行之后，它的 warning 就不该再驱动配色。
  assert.equal(worstSeverity(visibleRows(noScoped)), 'normal');

  const critical = instance({ weekly: limit('W', 97, 'critical'), fiveHour: limit('5H', 57) });
  assert.equal(worstSeverity(visibleRows(critical)), 'critical');
  assert.deepEqual(visibleRows(instance({ settings: { showWeekly: 'false', showFiveHour: 'false' } })), []);
});

test('the brand mark renders as a vector path in the fixed brand colour', () => {
  const decode = (i) => Buffer.from(config.render(i).split(',')[1], 'base64').toString('utf8');
  const svg = decode(instance({ weekly: limit('W', 66), fiveHour: limit('5H', 57) }));

  // 早先用的是像素网格，在 196px 键面上腿和眼睛会糊成一团；矢量在任何尺寸都锐利。
  assert.ok(svg.includes('<path d='), 'mark must be a vector path');
  assert.ok(svg.includes('fill="#d97757"'), 'mark keeps the fixed brand colour');
  assert.ok(!svg.includes('#141413'), 'the old pixel eyes should be gone');

  // 品牌色是身份标识，不跟随主题——换主题不该改变它。
  for (const theme of ['mono', 'sand', 'forest']) {
    const themed = decode(instance({ settings: { theme }, weekly: limit('W', 66) }));
    assert.ok(themed.includes('fill="#d97757"'), `mark must stay branded on ${theme}`);
  }
});

test('render survives every display state without data', () => {
  for (const state of ['PENDING', 'NO_TOKEN', 'AUTH', 'NETWORK', 'RATE_LIMITED', 'UNSUPPORTED']) {
    const dataUrl = config.render(instance({ displayState: state }));
    assert.match(dataUrl, /^data:image\/svg\+xml;base64,/);
  }
});

test('render draws one row band per visible limit', () => {
  const decode = (inst) => Buffer.from(config.render(inst).split(',')[1], 'base64').toString('utf8');
  const two = decode(instance({ weekly: limit('W', 66), fiveHour: limit('5H', 57) }));
  const three = decode(instance({
    weekly: limit('W', 66), fiveHour: limit('5H', 57), scoped: limit('WF', 75, 'warning'),
  }));
  // 每个数据行固定产出 3 个 text（标签 / 百分比 / 倒计时），另加标题的 "Claude"。
  // 不能拿字符串长度当代理指标——行数变多时行高和字号一起缩小，长度并不单调。
  const texts = (svg) => (svg.match(/<text/g) || []).length;
  assert.equal(texts(two), 1 + 2 * 3);
  assert.equal(texts(three), 1 + 3 * 3);
  assert.ok(three.includes('>WF<'), 'scoped label should reach the SVG');
  assert.ok(!two.includes('>WF<'));

  // clipPath 在宿主渲染器上支持不可靠，进度填充必须用矩形宽度实现。
  assert.ok(!three.includes('clipPath'), 'must not rely on clipPath');
});

test('manual refresh is rate limited so the key cannot be poked into a 429', () => {
  let runs = 0;
  const run = () => { runs += 1; };
  const inst = instance({ lastManualAt: 0 });
  const t0 = 1_000_000;

  handleShortPress(inst, { now: t0, run });
  assert.equal(runs, 1);
  handleShortPress(inst, { now: t0 + 1_000, run });
  assert.equal(runs, 1, 'a second press inside the cooldown must be swallowed');
  handleShortPress(inst, { now: t0 + 11_000, run });
  assert.equal(runs, 2, 'the press should go through once the cooldown expires');
});

test('resolveClaudeCommand searches PATH then the fallback bin dirs, and wraps bare .js in node', () => {
  // 命中 EXTRA_BIN_DIRS：PATH 里没有，但兵库里的 homebrew 路径存在。
  const only = (hit) => ({ statSync: (p) => { if (p === hit) return { isFile: () => true }; throw new Error('nope'); } });
  const spec = resolveClaudeCommand('claude', { fsImpl: only('/opt/homebrew/bin/claude'), pathEnv: '/usr/bin:/bin' });
  assert.equal(spec.resolved, '/opt/homebrew/bin/claude');
  assert.equal(spec.command, '/opt/homebrew/bin/claude');
  assert.deepEqual(spec.prefixArgs, []);

  // 带路径分隔符的当路径直接校验；裸 .js 必须用 node 拉起。
  const js = resolveClaudeCommand('/x/cli.js', { fsImpl: { statSync: () => ({ isFile: () => true }) } });
  assert.equal(js.command, process.execPath);
  assert.deepEqual(js.prefixArgs, ['/x/cli.js']);

  // 哪都找不到就是 null——上游据此判定 NO_CLI，而不是 spawn 一个不存在的命令。
  assert.equal(resolveClaudeCommand('claude', { fsImpl: { statSync: () => { throw new Error('x'); } }, pathEnv: '' }), null);
});

test('hasClaudeCredential treats an empty token pair as logged out', () => {
  const wrap = (cred) => JSON.stringify({ claudeAiOauth: cred });
  // 登录中：accessToken 在（即便过期其串仍在）。
  assert.equal(hasClaudeCredential(wrap({ accessToken: 'sk-live' })), true);
  // 过期但可恢复：只剩 refreshToken 也算有凭据，值得尝试刷新。
  assert.equal(hasClaudeCredential(wrap({ accessToken: '', refreshToken: 'rt' })), true);
  // 登出：两者皆空，只剩残留元数据。
  assert.equal(hasClaudeCredential(wrap({ accessToken: '', refreshToken: '', subscriptionType: 'pro' })), false);
  assert.equal(hasClaudeCredential(wrap({})), false);
  for (const junk of ['', '   ', 'not json', '{}', null, undefined]) {
    assert.equal(hasClaudeCredential(junk), false, `should reject ${JSON.stringify(junk)}`);
  }
});

test('runClaudeRefresh skips the spawn entirely when the CLI is logged out', async () => {
  let spawned = false;
  const result = await runClaudeRefresh({
    hasLogin: async () => false,
    // 若真去 spawn 就让测试炸——未登录时绝不该起进程。
    resolveCommand: () => { spawned = true; return { command: 'claude', prefixArgs: [] }; },
    spawnFn: () => { spawned = true; return {}; },
  });
  assert.deepEqual(result, { ok: false, reason: 'NOT_LOGGED_IN' });
  assert.equal(spawned, false, '登出时必须跳过 CLI 发现与 spawn，不浪费进程与额度');

  // hasClaudeLogin 走注入的 readRaw：整串凭据空 → 未登录。
  assert.equal(await hasClaudeLogin({ readRaw: async () => JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '' } }) }), false);
  assert.equal(await hasClaudeLogin({ readRaw: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'sk' } }) }), true);
});

test('runClaudeRefresh maps the child lifecycle to a best-effort result and never throws', async () => {
  // 缓冲式假子进程：runClaudeRefresh 现在先 await hasLogin 才注册 child.on，
  // 因此 emit 可能先于 on 发生——事件先记下，on 注册时若已 emit 过就立即补发，
  // 让断言不依赖 spawn 的微任务时序。
  const fakeChild = () => {
    const h = {}; const fired = {};
    return {
      on(ev, cb) { h[ev] = cb; if (ev in fired) cb(...fired[ev]); return this; },
      emit(ev, ...a) { fired[ev] = a; h[ev]?.(...a); },
      kill() { this.killed = true; },
    };
  };
  const spec = { command: 'claude', prefixArgs: [], resolved: '/bin/claude' };
  // 已登录时才进入进程生命周期分支；这里统一注入 hasLogin=true 只测 spawn 后半段。
  const refresh = (opts) => runClaudeRefresh({ hasLogin: async () => true, ...opts });

  // 解析不到 CLI：直接 NO_CLI，连 spawn 都不发生。
  assert.deepEqual(await refresh({ resolveCommand: () => null }), { ok: false, reason: 'NO_CLI' });

  // 退出码 0 → ok；非 0 → EXIT。
  let child = fakeChild();
  let p = refresh({ resolveCommand: () => spec, spawnFn: () => child });
  child.emit('close', 0);
  assert.deepEqual(await p, { ok: true });

  child = fakeChild();
  p = refresh({ resolveCommand: () => spec, spawnFn: () => child });
  child.emit('close', 1);
  assert.deepEqual(await p, { ok: false, reason: 'EXIT' });

  // spawn 抛异常 / 子进程 error 事件都归为 SPAWN_FAILED。
  assert.deepEqual(
    await refresh({ resolveCommand: () => spec, spawnFn: () => { throw new Error('boom'); } }),
    { ok: false, reason: 'SPAWN_FAILED' },
  );
  child = fakeChild();
  p = refresh({ resolveCommand: () => spec, spawnFn: () => child });
  child.emit('error', new Error('spawn'));
  assert.deepEqual(await p, { ok: false, reason: 'SPAWN_FAILED' });

  // 挂住不退出：超时杀掉进程，绝不让按键永远卡在刷新态。
  child = fakeChild();
  const timedOut = await refresh({ resolveCommand: () => spec, spawnFn: () => child, timeoutMs: 5 });
  assert.deepEqual(timedOut, { ok: false, reason: 'TIMEOUT' });
  assert.equal(child.killed, true);
});

test('manual refresh raises the refreshing flag around the claude call, then hands off to fetch', async () => {
  const seq = [];
  // active:false 让框架层 renderInstance 短路，避免真的往宿主发帧。
  const inst = instance({ active: false });
  const refresh = async () => { seq.push(`refresh:${inst.refreshing}`); };
  const run = async () => { seq.push(`run:${inst.refreshing}`); return 'ran'; };

  const result = await runManualRefresh(inst, { refresh, run });
  // 刷新期间角标亮（refreshing=true）；交给拉取时已落下（false）。
  assert.deepEqual(seq, ['refresh:true', 'run:false']);
  assert.equal(inst.refreshing, false);
  assert.equal(result, 'ran');
});

test('refresh failure still hands off to the fetch instead of blocking the key', async () => {
  const inst = instance({ active: false });
  let ran = false;
  await runManualRefresh(inst, {
    refresh: async () => { throw new Error('claude missing'); },
    run: async () => { ran = true; },
  });
  assert.equal(ran, true, 'a thrown refresh must not swallow the fetch');
  assert.equal(inst.refreshing, false);
});

test('while refreshing, the key shows the refresh badge and suppresses the stale badge', () => {
  const decode = (i) => Buffer.from(config.render(i).split(',')[1], 'base64').toString('utf8');
  const rows = { weekly: limit('W', 66), fiveHour: limit('5H', 57) };
  const REFRESH_PATH = 'M17.65 6.35A7.958';

  // 刷新中：即便底层是需要动手的 AUTH 陈旧态，也换成循环箭头，盖掉错误角标——
  // 不能同时给"出错"和"正在修"两个矛盾信号。
  const refreshing = decode(instance({ ...rows, displayState: 'STALE', lastErrorKind: 'AUTH', refreshing: true }));
  assert.ok(refreshing.includes(REFRESH_PATH), 'refresh badge must be drawn while refreshing');
  assert.ok(!refreshing.includes('scale(0.5)'), 'the stale badge must be suppressed while refreshing');

  // 非刷新态不该出现循环箭头。
  assert.ok(!decode(instance({ ...rows, displayState: 'OK' })).includes(REFRESH_PATH));
  assert.ok(!decode(instance({ ...rows, displayState: 'STALE', lastErrorKind: 'AUTH' })).includes(REFRESH_PATH));
});

test('http failures map to their own error kinds', async () => {
  const readCredential = async () => JSON.stringify({ claudeAiOauth: { accessToken: 'sk-test' } });
  const respond = (status, body) => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  });

  assert.equal((await fetchUsage({ readCredential: async () => null })).kind, 'NO_TOKEN');
  assert.equal((await fetchUsage({ readCredential, fetchImpl: async () => respond(401) })).kind, 'AUTH');
  assert.equal((await fetchUsage({ readCredential, fetchImpl: async () => respond(403) })).kind, 'AUTH');
  assert.equal((await fetchUsage({ readCredential, fetchImpl: async () => respond(429) })).kind, 'RATE_LIMITED');
  assert.equal((await fetchUsage({ readCredential, fetchImpl: async () => respond(500) })).kind, 'NETWORK');
  assert.equal(
    (await fetchUsage({ readCredential, fetchImpl: async () => { throw new Error('offline'); } })).kind,
    'NETWORK',
  );
  // 200 但结构不认识：降级为失败，不能让 render 拿到半个对象。
  assert.equal((await fetchUsage({ readCredential, fetchImpl: async () => respond(200, { hi: 1 }) })).kind, 'NETWORK');

  const good = await fetchUsage({ readCredential, fetchImpl: async () => respond(200, usagePayload()) });
  assert.equal(good.ok, true);
  assert.equal(good.data.weekly.percent, 66);
});

test('the request carries oauth headers and never a request body', async () => {
  let seen = null;
  await fetchUsage({
    readCredential: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'sk-header-test' } }),
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return { status: 200, ok: true, json: async () => usagePayload() };
    },
  });
  assert.equal(seen.url, 'https://api.anthropic.com/api/oauth/usage');
  assert.equal(seen.options.method, 'GET');
  assert.equal(seen.options.headers.authorization, 'Bearer sk-header-test');
  assert.equal(seen.options.headers['anthropic-beta'], 'oauth-2025-04-20');
  // 只读取额度，绝不发送任何推理请求——零额度消耗正是这个 action 的立身之本。
  assert.equal(seen.options.body, undefined);
});

test('countdown colour brightens as the reset gets closer, and never borrows alert colours', () => {
  // 注入固定时钟：resetsAt 与 render 的参照钟共用同一个 now，取整漂移彻底消失，
  // 余量可以收回到干净的整数边界（见 development-rules §4「测试必须确定性」）。
  const now = 1_700_000_000_000;
  const decode = (i) => Buffer.from(config.render(i, { now }).split(',')[1], 'base64').toString('utf8');
  const at = (label, percent, severity, hours) => ({
    label, percent, severity, resetsAt: now + hours * 3600_000,
  });
  const svg = decode(instance({
    fiveHour: at('5H', 92, 'critical', 0.6),   // 36m
    weekly: at('W', 56, 'normal', 5),          // 5h
    scoped: at('WF', 40, 'normal', 141),       // 5d
  }));

  const tails = [...svg.matchAll(
    /<text x="[\d.]+" y="[\d.]+" text-anchor="end" fill="(#[0-9a-f]{6})" font-weight="700"[^>]*>(.*?)<\/text>/g,
  )].map((m) => [m[2].replace(/<[^>]+>/g, ''), m[1]]);

  const ember = { text: '#fff7ed', muted: '#fdba74', low: '#9a3412' };
  assert.deepEqual(tails, [
    ['36m', ember.text],   // 最近 → 最亮
    ['5h', ember.muted],
    ['5d', ember.low],     // 最远 → 最暗
  ]);

  // 方向陷阱：短倒计时是好消息（额度快恢复），绝不能套用 warn/crit 那套告警色，
  // 否则会和同一行的百分比红黄撞成同一种"紧急"暗示，含义正好相反。
  const theme = __testing.THEMES.ember;
  for (const [, fill] of tails) {
    assert.ok(fill !== theme.crit && fill !== theme.warn,
      `countdown must not reuse alert colours, got ${fill}`);
  }
});

test('a lingering STALE state shows the failure reason as a badge, colour-graded by whether it needs action', () => {
  const decode = (i) => Buffer.from(config.render(i).split(',')[1], 'base64').toString('utf8');
  const rows = { weekly: limit('W', 94, 'critical'), fiveHour: limit('5H', 25, 'normal') };
  const theme = __testing.THEMES.ember;

  // OK 时没有徽章——徽章是"拉取正在失败"的信号，成功态不该出现。
  assert.ok(!decode(instance({ ...rows, displayState: 'OK' })).includes('scale(0.5)'));

  // 需要用户动手的失败（AUTH）用 crit 提级——这正是当初那次 token 过期 44 小时、键面
  // 却看不出该去重登的场景。徽章存在性在这里断言。（NO_TOKEN 不在此列：登出走登录提示，
  // 不再显示陈旧数字+徽章，见下一条测试。）
  for (const kind of ['AUTH']) {
    assert.ok(decode(instance({ ...rows, displayState: 'STALE', lastErrorKind: kind })).includes('scale(0.5)'),
      `${kind} should draw a badge`);
  }

  // 暂时性失败（NETWORK / RATE_LIMITED）用 warn，不喧宾夺主。只看徽章那个 <g>——
  // 94% 数据行本身就是 crit 色，对整个 SVG 判断"不含 crit"会误伤。
  const badgeGroup = (svg) => {
    const m = /<g transform="translate\([^)]*\) scale\(0\.5\)">(.*?)<\/g>/s.exec(svg);
    return m ? m[1] : '';
  };
  for (const kind of ['NETWORK', 'RATE_LIMITED']) {
    const badge = badgeGroup(decode(instance({ ...rows, displayState: 'STALE', lastErrorKind: kind })));
    assert.ok(badge.length > 0, `${kind} should draw a badge`);
    assert.ok(badge.includes(theme.warn) && !badge.includes(theme.crit),
      `${kind} badge should be warn-coloured, not crit`);
  }

  // 对称地收紧 crit：也只看徽章本身。
  for (const kind of ['AUTH']) {
    const badge = badgeGroup(decode(instance({ ...rows, displayState: 'STALE', lastErrorKind: kind })));
    assert.ok(badge.includes(theme.crit), `${kind} badge should be crit-coloured`);
  }
});

test('logged out shows a login prompt in place of percentages, even with stale data', () => {
  const decode = (i) => Buffer.from(config.render(i).split(',')[1], 'base64').toString('utf8');
  const rows = { weekly: limit('W', 66), fiveHour: limit('5H', 57) };

  // NO_TOKEN（登出）即便还留着上次数据，也不显示旧百分比，而是整块换成 Sign in 提示，
  // 且不叠 STALE 角标。displayState 直报 NO_TOKEN 与「有陈旧数据 + lastErrorKind NO_TOKEN」
  // 两条路径都要进登录提示。
  for (const inst of [
    instance({ ...rows, displayState: 'NO_TOKEN' }),
    instance({ ...rows, displayState: 'STALE', lastErrorKind: 'NO_TOKEN' }),
  ]) {
    const svg = decode(inst);
    assert.ok(svg.includes('>Sign in<'), 'must show the login prompt');
    assert.ok(!svg.includes('>66<') && !svg.includes('>57<'), 'stale percentages must be hidden behind the login prompt');
    assert.ok(!svg.includes('scale(0.5)'), 'no stale badge under the login prompt');
    assert.equal(needsLogin(inst), true);
  }

  // AUTH 仍走陈旧数字+徽章（token 可能只是过期、可刷新），不算「需要登录」。
  assert.equal(needsLogin(instance({ ...rows, displayState: 'STALE', lastErrorKind: 'AUTH' })), false);
});

test('while refreshing, percentages read as ... until the fetch returns', () => {
  const decode = (i) => Buffer.from(config.render(i).split(',')[1], 'base64').toString('utf8');
  const rows = { weekly: limit('W', 66), fiveHour: limit('5H', 57) };

  const idle = decode(instance({ ...rows, displayState: 'OK' }));
  assert.ok(idle.includes('>66<') && idle.includes('>57<'), 'idle shows real numbers');
  assert.ok(!idle.includes('>...<'), 'idle has no placeholder');

  const busy = decode(instance({ ...rows, displayState: 'OK', refreshing: true }));
  // 百分比换成 ...，旧数字不再出现；倒计时不受影响仍在。
  assert.ok(!busy.includes('>66<') && !busy.includes('>57<'), 'refreshing hides the stale numbers');
  assert.equal((busy.match(/>\.\.\.</g) || []).length, 2, 'both rows show the ... placeholder');
});

test('double press opens the Claude CLI, deduped so a logged-out double-open cannot spawn twice', () => {
  const writes = []; const opens = [];
  const deps = {
    writeFile: (p, c) => writes.push([p, c]),
    spawnFn: (cmd, args) => { opens.push([cmd, args]); return { on() {}, unref() {} }; },
    resolveCommand: () => ({ resolved: '/opt/homebrew/bin/claude' }),
    platform: 'darwin',
  };
  const inst = instance({ lastOpenCliAt: 0 });

  openClaudeCli(inst, { ...deps, now: 1000 });
  assert.equal(opens.length, 1, 'first open goes through');
  assert.equal(opens[0][0], 'open');
  assert.match(writes[0][0], /\.command$/, 'writes a .command script');
  assert.ok(writes[0][1].includes('exec "/opt/homebrew/bin/claude"'), 'script execs the resolved claude');

  // 冷却窗口内的第二次（双击第二拍 / onDoublePress）被吞掉，不开第二个窗口。
  openClaudeCli(inst, { ...deps, now: 1500 });
  assert.equal(opens.length, 1, 'a second open inside the cooldown is swallowed');

  // 冷却过后可再次打开。
  openClaudeCli(inst, { ...deps, now: 1000 + 2_000 });
  assert.equal(opens.length, 2, 'reopens once the cooldown expires');
});

test('short press opens the CLI when login is needed, otherwise refreshes', () => {
  let opened = 0; let refreshed = 0;
  const openCli = () => { opened += 1; };
  const run = () => { refreshed += 1; };

  // 登出：单击直接开 CLI 让用户登录，不进刷新。
  handleShortPress(instance({ displayState: 'NO_TOKEN', lastManualAt: 0 }), { openCli, run, now: 1000 });
  assert.deepEqual([opened, refreshed], [1, 0]);

  // 正常态：单击走刷新，不开 CLI。
  handleShortPress(instance({ displayState: 'OK', lastManualAt: 0 }), { openCli, run, now: 1000 });
  assert.deepEqual([opened, refreshed], [1, 1]);
});

// ---------------------------------------------------------------- 凭据失效可见化
// 2026-09-13 实机故障的回归：钥匙串里的 accessToken 在 09-04 过期，且 refreshToken 是
// 空串——那是一份 CLI 自己也续不回来的残缺凭据，只有重新登录能补上。当时插件把它当
// 「已登录」，每次短按白跑一次 45s 的 claude spawn，接口回 401 后又因为有历史数据降级
// 成 STALE，于是键面挂着 9 天前的 26%/0% 和一个 15px 角标，没人看得出该去重新登录。

test('an expired access token with no refresh token is a re-login, not a refreshable auth error', () => {
  const wrap = (cred) => JSON.stringify({ claudeAiOauth: cred });
  const now = 2_000_000;
  const past = now - 1;
  const future = now + 60_000;

  // 登出：整串凭据皆空，只剩残留元数据。
  assert.equal(classifyCredential(wrap({ accessToken: '', refreshToken: '' }), now), 'NONE');
  assert.equal(classifyCredential(wrap({}), now), 'NONE');
  for (const junk of ['', '  ', 'not json', '{}', null, undefined]) {
    assert.equal(classifyCredential(junk, now), 'NONE', `should reject ${JSON.stringify(junk)}`);
  }

  // 本次故障的原形：token 串还在但已过期，refreshToken 空 → CLI 无法续期，必须重登。
  assert.equal(classifyCredential(wrap({ accessToken: 'sk', refreshToken: '', expiresAt: past }), now), 'REAUTH');
  // 过期但留着 refreshToken：CLI 能自己换新，仍算可用凭据，走既有的刷新/STALE 路径。
  assert.equal(classifyCredential(wrap({ accessToken: 'sk', refreshToken: 'rt', expiresAt: past }), now), 'USABLE');
  // 未过期照常可用。
  assert.equal(classifyCredential(wrap({ accessToken: 'sk', expiresAt: future }), now), 'USABLE');
  // 没有 expiresAt 字段时不能凭空断定过期——这是非公开接口写的凭据，字段随时可能变，
  // 宁可发一次请求让服务端判，也不要凭一个缺失字段把用户推进重登提示。
  assert.equal(classifyCredential(wrap({ accessToken: 'sk' }), now), 'USABLE');
  assert.equal(classifyCredential(wrap({ accessToken: 'sk', expiresAt: 'junk' }), now), 'USABLE');
});

test('hasClaudeCredential refuses to burn a spawn on a credential the CLI cannot refresh', async () => {
  const wrap = (cred) => JSON.stringify({ claudeAiOauth: cred });
  const now = 2_000_000;
  // 不可续期 → 不值得 spawn，交给「重新登录」提示。
  assert.equal(hasClaudeCredential(wrap({ accessToken: 'sk', refreshToken: '', expiresAt: now - 1 }), now), false);
  // 可续期 → 照旧值得跑一次 claude 让 CLI 自己刷新。
  assert.equal(hasClaudeCredential(wrap({ accessToken: 'sk', refreshToken: 'rt', expiresAt: now - 1 }), now), true);

  let spawned = false;
  const result = await runClaudeRefresh({
    hasLogin: async () => false,
    resolveCommand: () => { spawned = true; return { command: 'claude', prefixArgs: [] }; },
    spawnFn: () => { spawned = true; return {}; },
  });
  assert.deepEqual(result, { ok: false, reason: 'NOT_LOGGED_IN' });
  assert.equal(spawned, false);
});

test('fetchUsage reports REAUTH without spending a request on a credential it knows is dead', async () => {
  let requested = false;
  const result = await fetchUsage({
    readCredential: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'sk', refreshToken: '', expiresAt: 1 } }),
    fetchImpl: async () => { requested = true; return { status: 200, ok: true, json: async () => usagePayload() }; },
    now: 2,
  });
  assert.deepEqual(result, { ok: false, kind: 'REAUTH' });
  assert.equal(requested, false, '已知续不回来的凭据不该再发一次注定 401 的请求');

  // 可用凭据照常发请求。
  const good = await fetchUsage({
    readCredential: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'sk-live', expiresAt: 10 } }),
    fetchImpl: async (url, options) => {
      assert.equal(options.headers.authorization, 'Bearer sk-live');
      return { status: 200, ok: true, json: async () => usagePayload() };
    },
    now: 2,
  });
  assert.equal(good.ok, true);
});

test('REAUTH replaces stale percentages with a re-login prompt', () => {
  const decode = (i) => Buffer.from(config.render(i).split(',')[1], 'base64').toString('utf8');
  const rows = { weekly: limit('W', 66), fiveHour: limit('5H', 57) };

  // 与 NO_TOKEN 同级：凭据续不回来就拉不到新值，继续显示旧百分比只会误导。
  for (const inst of [
    instance({ ...rows, displayState: 'REAUTH' }),
    instance({ ...rows, displayState: 'STALE', lastErrorKind: 'REAUTH' }),
  ]) {
    const svg = decode(inst);
    assert.ok(svg.includes('>Re-login<'), 'must tell the user to log in again');
    assert.ok(!svg.includes('>66<') && !svg.includes('>57<'), 'stale percentages must be hidden');
    assert.ok(!svg.includes('scale(0.5)'), 'no stale badge under the re-login prompt');
    assert.equal(needsLogin(inst), true);
  }

  // 短按直接开 CLI 让用户登录，而不是又跑一次注定失败的刷新。
  let opened = 0;
  let ran = 0;
  handleShortPress(instance({ ...rows, displayState: 'REAUTH', lastManualAt: 0 }), {
    openCli: () => { opened += 1; },
    run: () => { ran += 1; },
    now: 1000,
  });
  assert.equal(opened, 1);
  assert.equal(ran, 0);
});

test('a stale key face shows how old the numbers are once several polls have failed', () => {
  const decode = (i) => Buffer.from(config.render(i).split(',')[1], 'base64').toString('utf8');
  const now = 1_800_000_000_000;
  const rows = { weekly: limit('W', 26), fiveHour: limit('5H', 0) };
  const stale = (ageMs) => decode({
    ...instance({ ...rows, displayState: 'STALE', lastErrorKind: 'AUTH' }),
    fetchedAt: now - ageMs,
  });
  const render = (inst) => Buffer.from(config.render(inst, { now }).split(',')[1], 'base64').toString('utf8');
  const at = (ageMs) => render({
    ...instance({ ...rows, displayState: 'STALE', lastErrorKind: 'AUTH' }),
    fetchedAt: now - ageMs,
  });

  // 一次偶发失败不喊——才过 2 分钟，下一拍就可能恢复。
  assert.ok(!/>\d+[mhd]</.test(at(2 * 60_000)), 'a single missed poll must stay quiet');
  // 连续失败到数小时、数天，必须在键面上写明白已经多旧了。这正是这次故障藏 9 天的缺口。
  assert.ok(at(9 * 24 * 3600_000).includes('>9d<'), 'nine days stale must read 9d');
  assert.ok(at(5 * 3600_000).includes('>5h<'), 'five hours stale must read 5h');
  // OK 态永远不画陈旧时长。
  assert.ok(!/>\d+[mhd]</.test(render({ ...instance({ ...rows, displayState: 'OK' }), fetchedAt: now - 9 * 24 * 3600_000 })));
  assert.ok(stale(9 * 24 * 3600_000).length > 0);
});

test('the keychain service name follows CLAUDE_CONFIG_DIR', async () => {
  const { createHash } = await import('node:crypto');
  const homeDir = '/Users/x';
  // 默认 profile 仍用裸名——上游只给非默认 config dir 加哈希后缀。
  assert.deepEqual(
    keychainServices({ configDir: '/Users/x/.claude', homeDir }),
    ['Claude Code-credentials'],
  );
  assert.deepEqual(keychainServices({ configDir: undefined, homeDir }), ['Claude Code-credentials']);
  // 非默认 profile：`Claude Code-credentials-<sha256(configDir) 前 8 位>`，裸名兜底，
  // 以防用户的 CLI 版本还在用旧命名。
  const dir = '/Users/x/.claude-work';
  const hash = createHash('sha256').update(dir).digest('hex').slice(0, 8);
  assert.deepEqual(
    keychainServices({ configDir: dir, homeDir }),
    [`Claude Code-credentials-${hash}`, 'Claude Code-credentials'],
  );
});

test('failed fetches and recoveries land in the diagnostic log', () => {
  const entries = [];
  const logImpl = (name, entry) => { entries.push([name, entry]); return true; };
  const now = 1_800_000_000_000;
  const inst = instance({ weekly: limit('W', 26), fiveHour: limit('5H', 0), displayState: 'STALE' });
  inst.fetchedAt = now - 9 * 24 * 3600_000;

  applyResult(inst, { ok: false, kind: 'REAUTH' }, { now, appendLog: logImpl });
  assert.equal(entries.length, 1, '失败必须留痕——调试模式开着也一行日志都没有，是这次排障最贵的部分');
  assert.equal(entries[0][0], 'claudeusage-fetch');
  assert.equal(entries[0][1].kind, 'REAUTH');
  assert.equal(entries[0][1].displayState, 'STALE');
  assert.equal(entries[0][1].staleMs, 9 * 24 * 3600_000);

  // 同一个原因连续失败不刷屏；原因变了才再记一条。
  applyResult(inst, { ok: false, kind: 'REAUTH' }, { now, appendLog: logImpl });
  assert.equal(entries.length, 1);
  applyResult(inst, { ok: false, kind: 'NETWORK' }, { now, appendLog: logImpl });
  assert.equal(entries.length, 2);

  // 恢复也记一条，否则日志里只有坏消息，看不出什么时候好的。
  applyResult(inst, { ok: true, data: { weekly: limit('W', 25), fiveHour: limit('5H', 43), scoped: null } }, { now, appendLog: logImpl });
  assert.equal(entries.length, 3);
  assert.equal(entries[2][1].kind, 'OK');
});
