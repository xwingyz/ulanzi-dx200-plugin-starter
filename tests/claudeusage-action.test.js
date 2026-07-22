import assert from 'node:assert/strict';
import { test } from 'node:test';

import { __testing } from '../plugins/com.ulanzi.lexutility.ulanziPlugin/plugin/app.js';

const {
  ACTION_CONFIGS,
  applyResult,
  extractAccessToken,
  fetchUsage,
  formatCountdown,
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

test('runClaudeRefresh maps the child lifecycle to a best-effort result and never throws', async () => {
  const fakeChild = () => {
    const h = {};
    return { on(ev, cb) { h[ev] = cb; return this; }, emit(ev, ...a) { h[ev]?.(...a); }, kill() { this.killed = true; } };
  };
  const spec = { command: 'claude', prefixArgs: [], resolved: '/bin/claude' };

  // 解析不到 CLI：直接 NO_CLI，连 spawn 都不发生。
  assert.deepEqual(await runClaudeRefresh({ resolveCommand: () => null }), { ok: false, reason: 'NO_CLI' });

  // 退出码 0 → ok；非 0 → EXIT。
  let child = fakeChild();
  let p = runClaudeRefresh({ resolveCommand: () => spec, spawnFn: () => child });
  child.emit('close', 0);
  assert.deepEqual(await p, { ok: true });

  child = fakeChild();
  p = runClaudeRefresh({ resolveCommand: () => spec, spawnFn: () => child });
  child.emit('close', 1);
  assert.deepEqual(await p, { ok: false, reason: 'EXIT' });

  // spawn 抛异常 / 子进程 error 事件都归为 SPAWN_FAILED。
  assert.deepEqual(
    await runClaudeRefresh({ resolveCommand: () => spec, spawnFn: () => { throw new Error('boom'); } }),
    { ok: false, reason: 'SPAWN_FAILED' },
  );
  child = fakeChild();
  p = runClaudeRefresh({ resolveCommand: () => spec, spawnFn: () => child });
  child.emit('error', new Error('spawn'));
  assert.deepEqual(await p, { ok: false, reason: 'SPAWN_FAILED' });

  // 挂住不退出：超时杀掉进程，绝不让按键永远卡在刷新态。
  child = fakeChild();
  const timedOut = await runClaudeRefresh({ resolveCommand: () => spec, spawnFn: () => child, timeoutMs: 5 });
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
  const readToken = async () => 'sk-test';
  const respond = (status, body) => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  });

  assert.equal((await fetchUsage({ readToken: async () => null })).kind, 'NO_TOKEN');
  assert.equal((await fetchUsage({ readToken, fetchImpl: async () => respond(401) })).kind, 'AUTH');
  assert.equal((await fetchUsage({ readToken, fetchImpl: async () => respond(403) })).kind, 'AUTH');
  assert.equal((await fetchUsage({ readToken, fetchImpl: async () => respond(429) })).kind, 'RATE_LIMITED');
  assert.equal((await fetchUsage({ readToken, fetchImpl: async () => respond(500) })).kind, 'NETWORK');
  assert.equal(
    (await fetchUsage({ readToken, fetchImpl: async () => { throw new Error('offline'); } })).kind,
    'NETWORK',
  );
  // 200 但结构不认识：降级为失败，不能让 render 拿到半个对象。
  assert.equal((await fetchUsage({ readToken, fetchImpl: async () => respond(200, { hi: 1 }) })).kind, 'NETWORK');

  const good = await fetchUsage({ readToken, fetchImpl: async () => respond(200, usagePayload()) });
  assert.equal(good.ok, true);
  assert.equal(good.data.weekly.percent, 66);
});

test('the request carries oauth headers and never a request body', async () => {
  let seen = null;
  await fetchUsage({
    readToken: async () => 'sk-header-test',
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

  // 需要用户动手的失败（AUTH / NO_TOKEN）用 crit 提级——这正是当初那次 token
  // 过期 44 小时、键面却看不出该去重登的场景。徽章存在性在这里断言。
  for (const kind of ['AUTH', 'NO_TOKEN']) {
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

  // 对称地收紧 crit 那两个：也只看徽章本身。
  for (const kind of ['AUTH', 'NO_TOKEN']) {
    const badge = badgeGroup(decode(instance({ ...rows, displayState: 'STALE', lastErrorKind: kind })));
    assert.ok(badge.includes(theme.crit), `${kind} badge should be crit-coloured`);
  }
});
