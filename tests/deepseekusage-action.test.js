import assert from 'node:assert/strict';
import { test } from 'node:test';

import { __testing } from '../plugins/com.ulanzi.lexutility.ulanziPlugin/plugin/app.js';

const {
  ACTION_CONFIGS,
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
} = __testing;

const config = ACTION_CONFIGS.deepseekusage;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 1_785_000_000_000;

// 官方 /user/balance 的响应形状，只保留本 action 读取的字段。
function balancePayload(overrides = {}) {
  return {
    is_available: true,
    balance_infos: [
      {
        currency: 'CNY',
        total_balance: '110.00',
        granted_balance: '0.00',
        topped_up_balance: '110.00',
      },
    ],
    ...overrides,
  };
}

function instance(overrides = {}) {
  const { settings, ...rest } = overrides;
  return {
    context: 'test::deepseek::1',
    settings: { ...config.defaults, ...(settings || {}) },
    displayState: 'OK',
    events: [],
    balance: null,
    lastBalance: null,
    firstSampleAt: null,
    lastSampleAt: null,
    currency: 'CNY',
    isAvailable: true,
    fetchedAt: null,
    lastErrorKind: null,
    lastManualAt: 0,
    lastOpenUrlAt: 0,
    ...rest,
  };
}

// ---------------------------------------------------------------- 取数

test('balance payload prefers CNY, falls back to the first entry, and never throws on junk', () => {
  assert.deepEqual(parseBalance(balancePayload()), {
    balance: 110,
    currency: 'CNY',
    isAvailable: true,
  });

  // 账户只挂了别的币种：退回首项，量纲跟着走，不做任何汇率换算。
  const usdOnly = balancePayload({
    balance_infos: [{ currency: 'USD', total_balance: '12.50' }],
  });
  assert.deepEqual(parseBalance(usdOnly), { balance: 12.5, currency: 'USD', isAvailable: true });

  // 两种币种并存时 CNY 优先，哪怕它不是第一项。
  const both = balancePayload({
    balance_infos: [
      { currency: 'USD', total_balance: '12.50' },
      { currency: 'CNY', total_balance: '88.00' },
    ],
  });
  assert.equal(parseBalance(both).currency, 'CNY');
  assert.equal(parseBalance(both).balance, 88);

  // is_available 是官方硬信号，false 必须原样传下去。
  assert.equal(parseBalance(balancePayload({ is_available: false })).isAvailable, false);

  for (const junk of [null, undefined, {}, { balance_infos: [] }, { balance_infos: 'x' },
    { balance_infos: [{ currency: 'CNY', total_balance: 'abc' }] }]) {
    assert.equal(parseBalance(junk), null, `should reject ${JSON.stringify(junk)}`);
  }
});

test('fetch maps transport and auth failures onto distinct kinds', async () => {
  assert.deepEqual(await fetchBalance(''), { ok: false, kind: 'NO_KEY' });
  assert.deepEqual(await fetchBalance('   '), { ok: false, kind: 'NO_KEY' });

  const withStatus = (status) => ({
    fetchImpl: async () => ({ ok: status < 400, status, json: async () => balancePayload() }),
  });
  assert.equal((await fetchBalance('k', withStatus(401))).kind, 'AUTH');
  assert.equal((await fetchBalance('k', withStatus(403))).kind, 'AUTH');
  assert.equal((await fetchBalance('k', withStatus(429))).kind, 'RATE_LIMITED');
  assert.equal((await fetchBalance('k', withStatus(500))).kind, 'NETWORK');

  assert.equal(
    (await fetchBalance('k', { fetchImpl: async () => { throw new Error('boom'); } })).kind,
    'NETWORK',
  );

  // 响应结构变了：降级成普通失败，不崩在框架边界上。
  assert.equal(
    (await fetchBalance('k', {
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ nope: 1 }) }),
    })).kind,
    'NETWORK',
  );

  const ok = await fetchBalance('k', {
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://api.deepseek.com/user/balance');
      assert.equal(init.headers.authorization, 'Bearer k');
      return { ok: true, status: 200, json: async () => balancePayload() };
    },
  });
  assert.deepEqual(ok, { ok: true, data: { balance: 110, currency: 'CNY', isAvailable: true } });
});

// ---------------------------------------------------------------- 记账

test('first sample opens the ledger without inventing a spend event', () => {
  const inst = instance();
  recordSample(inst, 100, NOW);
  assert.deepEqual(inst.events, []);
  assert.equal(inst.firstSampleAt, NOW);
  assert.equal(inst.lastSampleAt, NOW);
  assert.equal(inst.lastBalance, 100);
});

test('a balance drop records the interval that produced it', () => {
  const inst = instance();
  recordSample(inst, 100, NOW);
  recordSample(inst, 97.5, NOW + HOUR);
  assert.equal(inst.events.length, 1);
  // 区间而不是时刻：窗口边界可能落在内部，只有跨度已知才能按比例切。
  assert.deepEqual(inst.events[0], { a: NOW, b: NOW + HOUR, d: 2.5 });
});

test('top-ups and flat balances never become spend', () => {
  const inst = instance();
  recordSample(inst, 10, NOW);
  recordSample(inst, 60, NOW + HOUR);      // 充值 +50
  recordSample(inst, 60, NOW + 2 * HOUR);  // 没动静
  assert.deepEqual(inst.events, []);
  assert.equal(inst.lastBalance, 60);

  // 充值之后的消费照常入账，基准已经跟着上移。
  recordSample(inst, 58, NOW + 3 * HOUR);
  assert.deepEqual(inst.events, [{ a: NOW + 2 * HOUR, b: NOW + 3 * HOUR, d: 2 }]);
});

test('a net rise hides the spend inside the same interval — the known, unfixable hole', () => {
  // 关机期间既充值又消费：净变化是 +45，插件只能判为充值，那 5 块永远丢了。
  // 这条测试锁住的是「我们知道自己丢了什么」，不是「我们修好了它」。
  const inst = instance();
  recordSample(inst, 10, NOW);
  recordSample(inst, 55, NOW + 10 * HOUR);
  assert.deepEqual(inst.events, []);
});

test('prune drops intervals fully outside the 7d window and keeps straddling ones', () => {
  const inst = instance({
    events: [
      { a: NOW - 9 * DAY, b: NOW - 8 * DAY, d: 1 },   // 完全过期
      { a: NOW - 8 * DAY, b: NOW - 6 * DAY, d: 2 },   // 跨 7d 边界，留着交给 sumWindow 切
      { a: NOW - HOUR, b: NOW, d: 3 },
    ],
  });
  const kept = pruneEvents(inst, NOW);
  assert.deepEqual(kept.map((event) => event.d), [2, 3]);
});

test('prune caps the ledger so a 60s poll cannot grow the state file without bound', () => {
  const events = Array.from({ length: 2500 }, (_, index) => ({
    a: NOW - 1000 * (2500 - index),
    b: NOW - 1000 * (2500 - index) + 500,
    d: 0.01,
  }));
  const inst = instance({ events });
  const kept = pruneEvents(inst, NOW);
  assert.equal(kept.length, 2000);
  // 丢的是最老的一批，最近的记录必须保住。
  assert.equal(kept.at(-1).b, events.at(-1).b);
});

// ---------------------------------------------------------------- 窗口

test('window sums clip straddling intervals by their overlap', () => {
  const events = [{ a: NOW - 2 * HOUR, b: NOW, d: 4 }];
  // 完全包含
  assert.equal(sumWindow(events, NOW - 3 * HOUR, NOW), 4);
  // 只覆盖后一半 → 按重叠比例切
  assert.equal(sumWindow(events, NOW - HOUR, NOW), 2);
  // 完全在窗外
  assert.equal(sumWindow(events, NOW + HOUR, NOW + 2 * HOUR), 0);
});

test('a zero-span interval is not divided by zero', () => {
  const events = [{ a: NOW, b: NOW, d: 1.5 }];
  assert.equal(sumWindow(events, NOW - HOUR, NOW + HOUR), 0);
  // 边界退化时至少不能产出 NaN/Infinity
  assert.equal(Number.isFinite(sumWindow(events, NOW, NOW + HOUR)), true);
});

test('coverage ramps from cold start, holds at full, and decays when fetching stalls', () => {
  // 刚装上：窗口里只有一小段被采样夹住。
  const fresh = instance({ firstSampleAt: NOW - 6 * HOUR, lastSampleAt: NOW });
  assert.equal(Math.round(coverageRatio(fresh, DAY, NOW) * 100), 25);

  // 跑满一天之后：关机时段也算已覆盖——前后两次采样把它夹住了，金额是已知的。
  const warm = instance({ firstSampleAt: NOW - 30 * DAY, lastSampleAt: NOW });
  assert.equal(coverageRatio(warm, DAY, NOW), 1);
  assert.equal(coverageRatio(warm, 7 * DAY, NOW), 1);

  // 拉取连续失败 6 小时：窗口尾部没有新采样，覆盖率该掉下来，tail 才会亮。
  const stalled = instance({ firstSampleAt: NOW - 30 * DAY, lastSampleAt: NOW - 6 * HOUR });
  assert.equal(Math.round(coverageRatio(stalled, DAY, NOW) * 100), 75);

  // 一个采样点都没有。
  assert.equal(coverageRatio(instance(), DAY, NOW), 0);
});

// ---------------------------------------------------------------- 排版

test('amounts put the number first so renderMeterRow can split number from unit', () => {
  // renderMeterRow 的 numeric() 用 /^(-?[\d.]+)(.*)$/ 分栏；前缀货币符号会让整串
  // 掉进「无数字」分支被排成小字号。这条测试锁住的就是这个契约。
  const numberFirst = /^[\d.]+/;
  for (const value of [0.03, 3.456, 42.31, 128.4, 480]) {
    assert.match(formatAmount(value, 'CNY'), numberFirst, `${value} must start with a digit`);
  }
});

test('amount precision adapts so the value column never overflows', () => {
  assert.equal(formatAmount(0.03, 'CNY'), '0.03元');
  assert.equal(formatAmount(3.456, 'CNY'), '3.46元');
  assert.equal(formatAmount(12.34, 'CNY'), '12.3元');
  assert.equal(formatAmount(128.4, 'CNY'), '128元');
  // 位宽恒定在 3–4 个数字字符
  for (const value of [0.03, 9.99, 10, 99.9, 100, 9999]) {
    const digits = formatAmount(value, 'CNY').replace(/[^\d]/g, '');
    assert.ok(digits.length >= 1 && digits.length <= 4, `${value} -> ${digits}`);
  }
  assert.equal(formatAmount(12.5, 'USD'), '12.5$');
  // 未知币种不猜符号，原样带上代码。
  assert.equal(formatAmount(5, 'EUR'), '5.00EUR');
});

test('is_available outranks every local threshold on the balance row', () => {
  // 官方说余额已不够发起调用：不管本地阈值填了什么，都必须是 critical。
  assert.equal(balanceSeverity(500, false, 20, 5), 'critical');
  assert.equal(balanceSeverity(3, true, 20, 5), 'critical');
  assert.equal(balanceSeverity(12, true, 20, 5), 'warning');
  assert.equal(balanceSeverity(50, true, 20, 5), 'normal');
  // 阈值留空 = 关闭该级告警，不该悄悄回落到某个默认值。
  assert.equal(balanceSeverity(0.5, true, null, null), 'normal');
});

test('overspending a budget is critical, not merely warning', () => {
  assert.equal(spendSeverity(null), 'normal');
  assert.equal(spendSeverity(40), 'normal');
  assert.equal(spendSeverity(75), 'warning');
  assert.equal(spendSeverity(100), 'critical');
  assert.equal(spendSeverity(240), 'critical');
});

// ---------------------------------------------------------------- 行

test('spend rows show `--` until a second sample closes the first interval', () => {
  // 只有一个采样点时消费额无从谈起，显示 0 就是在说谎。
  const single = instance({ balance: 100, firstSampleAt: NOW, lastSampleAt: NOW });
  const rows = visibleRows(single, NOW);
  assert.deepEqual(rows.map((row) => row.label), ['BAL', '24h', '7d']);
  assert.equal(rows[0].value, '100元');
  assert.equal(rows[1].value, '--');
  assert.equal(rows[2].value, '--');
  assert.equal(rows[1].showBar, false);
});

test('the balance row never draws a bar; spend rows draw one only when a budget is set', () => {
  const inst = instance({
    balance: 42.3,
    firstSampleAt: NOW - 7 * DAY,
    lastSampleAt: NOW,
    events: [{ a: NOW - HOUR, b: NOW, d: 2.5 }],
    settings: { budget24h: '5', budget7d: '' },
  });
  const [bal, day, week] = visibleRows(inst, NOW);
  assert.equal(bal.showBar, false);
  assert.equal(bal.percent, null);
  assert.equal(day.showBar, true);
  assert.equal(day.percent, 50);
  // 预算留空 → 不画条、不算百分比，只剩数字。
  assert.equal(week.showBar, false);
  assert.equal(week.percent, null);
  assert.equal(week.value, '2.50元');
});

test('the tail is a warning slot: empty at full coverage, coverage percent below it', () => {
  const full = instance({
    balance: 42.3,
    firstSampleAt: NOW - 30 * DAY,
    lastSampleAt: NOW,
    events: [{ a: NOW - HOUR, b: NOW, d: 1 }],
  });
  assert.deepEqual(visibleRows(full, NOW).map((row) => row.tail), ['', '', '']);

  const cold = instance({
    balance: 42.3,
    firstSampleAt: NOW - 3 * DAY,
    lastSampleAt: NOW,
    events: [{ a: NOW - HOUR, b: NOW, d: 1 }],
  });
  const [, day, week] = visibleRows(cold, NOW);
  assert.equal(day.tail, '');          // 24h 窗口已经攒满
  assert.equal(week.tail, '42%');      // 7d 只攒了 3 天
});

// ---------------------------------------------------------------- 状态机

test('a missing key clears the stale balance instead of showing a number that can never refresh', () => {
  const inst = instance({ balance: 42.3, displayState: 'OK' });
  applyResult(inst, { ok: false, kind: 'NO_KEY' }, { now: NOW });
  assert.equal(inst.displayState, 'NO_KEY');
  assert.equal(inst.balance, null);
});

test('transient failures keep the last balance and only mark it stale', () => {
  for (const kind of ['NETWORK', 'RATE_LIMITED', 'AUTH']) {
    const inst = instance({ balance: 42.3, displayState: 'OK' });
    applyResult(inst, { ok: false, kind }, { now: NOW });
    assert.equal(inst.displayState, 'STALE', kind);
    assert.equal(inst.balance, 42.3, kind);
    assert.equal(inst.lastErrorKind, kind);
  }

  // 从来没拿到过余额时，失败就是失败，没有可降级的对象。
  const cold = instance({ balance: null, displayState: 'PENDING' });
  applyResult(cold, { ok: false, kind: 'NETWORK' }, { now: NOW });
  assert.equal(cold.displayState, 'NETWORK');
});

test('a successful result samples the ledger in the same step it updates the balance', () => {
  const inst = instance({ balance: 100, lastBalance: 100, firstSampleAt: NOW - HOUR, lastSampleAt: NOW - HOUR });
  applyResult(inst, { ok: true, data: { balance: 96.5, currency: 'CNY', isAvailable: true } }, { now: NOW });
  assert.equal(inst.displayState, 'OK');
  assert.equal(inst.balance, 96.5);
  assert.equal(inst.lastErrorKind, null);
  assert.deepEqual(inst.events, [{ a: NOW - HOUR, b: NOW, d: 3.5 }]);
});

test('hydrate tolerates junk, drops malformed intervals, and starts stale', () => {
  assert.deepEqual(hydrateState(null).events, []);
  assert.equal(hydrateState(null).displayState, 'PENDING');
  assert.deepEqual(hydrateState({ v: 99, events: [{ a: 1, b: 2, d: 3 }] }).events, []);

  const hydrated = hydrateState({
    v: 1,
    events: [
      { a: 1, b: 2, d: 3 },
      { a: 5, b: 4, d: 1 },      // b < a
      { a: 1, b: 2, d: 0 },      // 非正消费
      { a: 'x', b: 2, d: 1 },    // 类型不对
      null,
    ],
    firstSampleAt: 1,
    lastSampleAt: 2,
    lastBalance: 50,
    balance: 50,
    currency: 'CNY',
    isAvailable: true,
    fetchedAt: 2,
  });
  assert.deepEqual(hydrated.events, [{ a: 1, b: 2, d: 3 }]);
  // 水合出来的余额一定是上次会话留下的，先标陈旧，等首次拉取成功再转正。
  assert.equal(hydrated.displayState, 'STALE');
});

test('clearing history wipes the ledger and its baseline, so recording restarts from now', () => {
  const inst = instance({
    events: [{ a: NOW - HOUR, b: NOW, d: 2 }],
    firstSampleAt: NOW - DAY,
    lastSampleAt: NOW,
    lastBalance: 42,
  });
  clearHistory(inst);
  assert.deepEqual(inst.events, []);
  assert.equal(inst.firstSampleAt, null);
  assert.equal(inst.lastSampleAt, null);
  // 基准也必须清掉：留着它会把「清空后第一次采样」算成一笔巨额消费。
  assert.equal(inst.lastBalance, null);

  recordSample(inst, 42, NOW + HOUR);
  assert.deepEqual(inst.events, []);
});

// ---------------------------------------------------------------- 设置与交互

test('empty amounts stay empty because clearing a budget is a deliberate instruction', () => {
  assert.equal(normalizeAmountString('', '5'), '');
  assert.equal(normalizeAmountString('   ', '5'), '');
  assert.equal(normalizeAmountString('7.5', '5'), '7.5');
  assert.equal(normalizeAmountString('7.456', '5'), '7.46');
  // 非法或负数才回落到默认值
  assert.equal(normalizeAmountString('abc', '5'), '5');
  assert.equal(normalizeAmountString('-3', '5'), '5');
  assert.equal(normalizeAmountString('9999999', '5'), '1000000');
});

test('defaults carry the agreed budgets and the ice theme', () => {
  assert.equal(config.defaults.budget24h, '5');
  assert.equal(config.defaults.budget7d, '20');
  assert.equal(config.defaults.balanceWarn, '20');
  assert.equal(config.defaults.balanceCrit, '5');
  assert.equal(config.defaults.theme, 'ice');
  assert.equal(config.defaults.apiKey, '');
});

test('the manual refresh cooldown swallows repeat presses', () => {
  const inst = instance();
  const calls = [];
  const run = (target) => { calls.push(target.lastManualAt); };

  handleShortPress(inst, { now: NOW, run });
  assert.equal(calls.length, 1);

  handleShortPress(inst, { now: NOW + 3000, run });
  assert.equal(calls.length, 1, 'within cooldown');

  handleShortPress(inst, { now: NOW + 11_000, run });
  assert.equal(calls.length, 2, 'after cooldown');
});

test('long press opens the usage page per platform and never twice in a row', () => {
  const spawned = [];
  const spawnFn = (command, args) => {
    spawned.push([command, args]);
    return { on() {}, unref() {} };
  };

  const mac = instance();
  handleLongPress(mac, { now: NOW, spawnFn, platform: 'darwin' });
  assert.deepEqual(spawned[0], ['open', ['https://platform.deepseek.com/usage']]);

  // 冷却窗口内的第二次长按不再开一个窗口。
  handleLongPress(mac, { now: NOW + 500, spawnFn, platform: 'darwin' });
  assert.equal(spawned.length, 1);

  const win = instance();
  handleLongPress(win, { now: NOW, spawnFn, platform: 'win32' });
  assert.deepEqual(spawned[1], ['cmd', ['/c', 'start', '', 'https://platform.deepseek.com/usage']]);

  // 其它平台没有可靠的打开方式：什么都不做，而不是乱 spawn。
  const linux = instance();
  handleLongPress(linux, { now: NOW, spawnFn, platform: 'linux' });
  assert.equal(spawned.length, 2);

  // spawn 抛错不能把按键拖进错误态。
  const boom = instance();
  assert.doesNotThrow(() => handleLongPress(boom, {
    now: NOW,
    platform: 'darwin',
    spawnFn: () => { throw new Error('nope'); },
  }));
});
