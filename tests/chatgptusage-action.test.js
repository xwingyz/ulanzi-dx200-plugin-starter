import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { __testing } from '../plugins/com.ulanzi.lexutility.ulanziPlugin/plugin/app.js';

const {
  ACTION_CONFIGS,
  chatgptApplyResult,
  chatgptSeverityFromPercent,
  chatgptVisibleRows,
  chatgptWorstSeverity,
  fetchChatGptUsage,
  hasCodexLogin,
  hydrateChatGptState,
  openCommand,
  parseRateLimits,
  readRateLimits,
  resolveCodexCommand,
  severityFromPercent,
  windowLabel,
} = __testing;

const config = ACTION_CONFIGS.chatgptusage;

// codex app-server 的真实响应形状（2026-07-19 实测）。
function rpcResult(overrides = {}) {
  return {
    rateLimits: {
      limitId: 'codex',
      primary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: 1784949936 },
      secondary: null,
      planType: 'plus',
      ...overrides.rateLimits,
    },
    rateLimitsByLimitId: overrides.rateLimitsByLimitId,
    rateLimitResetCredits: { availableCount: 3, credits: [] },
    ...overrides.root,
  };
}

function instance(overrides = {}) {
  const { settings, ...rest } = overrides;
  return {
    context: 'test::gpt',
    settings: { ...config.defaults, ...(settings || {}) },
    displayState: 'OK',
    primary: null,
    secondary: null,
    resetCredits: null,
    planType: null,
    fetchedAt: null,
    lastErrorKind: null,
    ...rest,
  };
}

const win = (label, percent, severity = 'normal') => ({
  label, percent, severity, resetsAt: null, windowMins: null,
});

// 假 fs：只回答我们关心的两个问题（文件在不在、内容是什么）。
function fakeFs(files) {
  return {
    statSync(p) {
      if (!(p in files)) {
        throw new Error('ENOENT');
      }
      return { isFile: () => true };
    },
    readFileSync(p) {
      if (!(p in files)) {
        throw new Error('ENOENT');
      }
      return files[p];
    },
  };
}

test('window duration maps to a row label', () => {
  assert.equal(windowLabel(10080), 'W');
  assert.equal(windowLabel(20160), '2W');
  assert.equal(windowLabel(300), '5H');
  assert.equal(windowLabel(60), '1H');
  assert.equal(windowLabel(1440), '1D');
  assert.equal(windowLabel(45), '45M');
  for (const bad of [0, -1, null, undefined, 'week', Number.NaN]) {
    assert.equal(windowLabel(bad), '?', `should not crash on ${JSON.stringify(bad)}`);
  }
});

test('thresholds match claudeusage exactly, so both keys colour the same number alike', () => {
  // 两个 action 各自定义阈值（阈值是领域决策，不该上移共享层），
  // 但并排摆放时同一个百分比必须同色——这条断言就是那个契约。
  for (let percent = 0; percent <= 100; percent += 1) {
    assert.equal(
      chatgptSeverityFromPercent(percent),
      severityFromPercent(percent),
      `severity diverged at ${percent}%`,
    );
  }
  assert.equal(chatgptSeverityFromPercent(74), 'normal');
  assert.equal(chatgptSeverityFromPercent(75), 'warning');
  assert.equal(chatgptSeverityFromPercent(89), 'warning');
  assert.equal(chatgptSeverityFromPercent(90), 'critical');
});

test('rateLimitsByLimitId wins, rateLimits is the fallback', () => {
  const scoped = parseRateLimits(rpcResult({
    rateLimitsByLimitId: {
      codex: { primary: { usedPercent: 77, windowDurationMins: 10080, resetsAt: 1784949936 }, planType: 'pro' },
      other: { primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 1784949936 } },
    },
  }), 'codex');
  assert.equal(scoped.primary.percent, 77);
  assert.equal(scoped.planType, 'pro');

  // 换 limitId 就该读另一组。
  const other = parseRateLimits(rpcResult({
    rateLimitsByLimitId: {
      codex: { primary: { usedPercent: 77, windowDurationMins: 10080, resetsAt: 1 } },
      other: { primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 1 } },
    },
  }), 'other');
  assert.equal(other.primary.percent, 5);
  assert.equal(other.primary.label, '5H');

  // 没有 byLimitId 时回退顶层 rateLimits。
  assert.equal(parseRateLimits(rpcResult(), 'codex').primary.percent, 30);
});

test('resetsAt is unix seconds and must be widened to milliseconds', () => {
  const parsed = parseRateLimits(rpcResult());
  // 1784949936 秒 —— 若忘记 ×1000，会被当成 1970 年而永远显示 now。
  assert.equal(parsed.primary.resetsAt, 1784949936 * 1000);
  assert.ok(parsed.primary.resetsAt > Date.parse('2020-01-01'));
});

test('a missing secondary window simply yields no second row', () => {
  const parsed = parseRateLimits(rpcResult());
  assert.equal(parsed.secondary, null);
  assert.equal(parsed.primary.label, 'W');
  assert.equal(parsed.resetCredits, 3);

  const both = parseRateLimits(rpcResult({
    rateLimits: {
      primary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: 1784949936 },
      secondary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1784949936 },
    },
  }));
  assert.equal(both.secondary.percent, 12);
  assert.equal(both.secondary.label, '5H');
});

test('an unreadable payload is a failure, not an empty key face', () => {
  assert.equal(parseRateLimits(null), null);
  assert.equal(parseRateLimits({}), null);
  assert.equal(parseRateLimits({ rateLimits: {} }), null);
  assert.equal(parseRateLimits({ rateLimits: { primary: { usedPercent: 'lots' } } }), null);
});

test('codex is looked up on PATH and on the extra prefixes the host PATH may lack', () => {
  const fsImpl = fakeFs({ '/opt/homebrew/bin/codex': '#!/bin/sh' });
  // 宿主 PATH 里没有 homebrew —— 正是插件被 Ulanzi Studio 拉起时的真实处境。
  const spec = resolveCodexCommand('codex', { fsImpl, pathEnv: '/usr/bin:/bin' });
  assert.equal(spec.resolved, '/opt/homebrew/bin/codex');
  assert.equal(spec.command, '/opt/homebrew/bin/codex');
  assert.deepEqual(spec.prefixArgs, []);

  assert.equal(resolveCodexCommand('codex', { fsImpl: fakeFs({}), pathEnv: '/usr/bin' }), null);
});

test('an absolute path is trusted as given, and a bare .js is launched through node', () => {
  const jsPath = '/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js';
  const spec = resolveCodexCommand(jsPath, { fsImpl: fakeFs({ [jsPath]: '' }) });
  assert.equal(spec.command, process.execPath);
  assert.deepEqual(spec.prefixArgs, [jsPath]);

  assert.equal(resolveCodexCommand('/nope/codex', { fsImpl: fakeFs({}) }), null);
});

test('login is judged from auth.json without touching the token itself', () => {
  const authPath = '/home/u/.codex/auth.json';
  const ok = fakeFs({ [authPath]: JSON.stringify({ tokens: { access_token: 'sk-x' } }) });
  assert.equal(hasCodexLogin({ fsImpl: ok, authPath }), true);

  for (const body of ['', '{}', 'not json', JSON.stringify({ tokens: {} }), JSON.stringify({ tokens: { access_token: '' } })]) {
    assert.equal(hasCodexLogin({ fsImpl: fakeFs({ [authPath]: body }), authPath }), false, `should reject ${body}`);
  }
  // 文件根本不存在。
  assert.equal(hasCodexLogin({ fsImpl: fakeFs({}), authPath }), false);
});

test('fetch short-circuits before spawning when the CLI or login is missing', () => {
  let spawned = false;
  const read = async () => { spawned = true; return { ok: true, result: rpcResult() }; };

  return Promise.all([
    fetchChatGptUsage(config.defaults, {
      resolveCommand: () => null,
      hasLogin: () => true,
      readRateLimits: read,
    }).then((r) => assert.equal(r.kind, 'NO_CLI')),
    fetchChatGptUsage(config.defaults, {
      resolveCommand: () => ({ command: 'codex', prefixArgs: [], resolved: '/bin/codex' }),
      hasLogin: () => false,
      readRateLimits: read,
    }).then((r) => assert.equal(r.kind, 'NOT_LOGGED_IN')),
  ]).then(() => {
    // 关键：这两种情况都不该起进程——先读文件判定比等一个进程超时快几个数量级。
    assert.equal(spawned, false, 'must not spawn app-server when it cannot possibly work');
  });
});

test('rpc failures and unparseable results surface as their own kinds', async () => {
  const spec = { command: 'codex', prefixArgs: [], resolved: '/bin/codex' };
  const run = (rpc) => fetchChatGptUsage(config.defaults, {
    resolveCommand: () => spec,
    hasLogin: () => true,
    readRateLimits: async () => rpc,
  });

  assert.equal((await run({ ok: false, kind: 'TIMEOUT' })).kind, 'TIMEOUT');
  assert.equal((await run({ ok: false, kind: 'RPC_ERROR' })).kind, 'RPC_ERROR');
  // 200 但结构不认识：app-server 是 experimental 接口，协议变了就是这个形状。
  assert.equal((await run({ ok: true, result: { hi: 1 } })).kind, 'RPC_ERROR');

  const good = await run({ ok: true, result: rpcResult() });
  assert.equal(good.ok, true);
  assert.equal(good.data.primary.percent, 30);
});

// 假 app-server：按真实协议应答 initialize，再按脚本回 rateLimits。
function fakeSpawn(script) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    child.stdin = {
      written: [],
      write(line) {
        this.written.push(line);
        const message = JSON.parse(line);
        queueMicrotask(() => script(child, message));
        return true;
      },
      end() {},
    };
    return child;
  };
}

test('the json-rpc handshake follows initialize -> initialized -> rateLimits/read', async () => {
  const seen = [];
  const spawnFn = fakeSpawn((child, message) => {
    seen.push(message.method);
    if (message.method === 'initialize') {
      child.stdout.write(`${JSON.stringify({ id: 0, result: {} })}\n`);
    }
    if (message.method === 'account/rateLimits/read') {
      child.stdout.write(`${JSON.stringify({ id: 1, result: rpcResult() })}\n`);
    }
  });

  const out = await readRateLimits({ command: 'codex', prefixArgs: [] }, 5000, { spawnFn });
  assert.equal(out.ok, true);
  assert.equal(out.result.rateLimits.primary.usedPercent, 30);
  assert.deepEqual(seen, ['initialize', 'initialized', 'account/rateLimits/read']);
});

test('non-json chatter on stdout is ignored rather than fatal', async () => {
  const spawnFn = fakeSpawn((child, message) => {
    if (message.method === 'initialize') {
      child.stdout.write('warning: something human-readable\n');
      child.stdout.write(`${JSON.stringify({ id: 0, result: {} })}\n`);
    }
    if (message.method === 'account/rateLimits/read') {
      child.stdout.write('another stray line\n');
      child.stdout.write(`${JSON.stringify({ id: 1, result: rpcResult() })}\n`);
    }
  });
  const out = await readRateLimits({ command: 'codex', prefixArgs: [] }, 5000, { spawnFn });
  assert.equal(out.ok, true);
});

test('an rpc error reply, a timeout, and a spawn failure each terminate cleanly', async () => {
  const errored = await readRateLimits({ command: 'codex', prefixArgs: [] }, 5000, {
    spawnFn: fakeSpawn((child, message) => {
      if (message.method === 'initialize') {
        child.stdout.write(`${JSON.stringify({ id: 0, result: {} })}\n`);
      }
      if (message.method === 'account/rateLimits/read') {
        child.stdout.write(`${JSON.stringify({ id: 1, error: { message: 'nope' } })}\n`);
      }
    }),
  });
  assert.equal(errored.kind, 'RPC_ERROR');

  // 永不应答 —— 必须靠超时收口，且要杀掉子进程，否则留下孤儿 app-server。
  let timedOutChild = null;
  const timedOut = await readRateLimits({ command: 'codex', prefixArgs: [] }, 60, {
    spawnFn: (...args) => {
      timedOutChild = fakeSpawn(() => {})(...args);
      return timedOutChild;
    },
  });
  assert.equal(timedOut.kind, 'TIMEOUT');
  assert.equal(timedOutChild.killed, true, 'timed-out app-server must be killed');

  const failed = await readRateLimits({ command: 'codex', prefixArgs: [] }, 5000, {
    spawnFn: () => { throw new Error('ENOENT'); },
  });
  assert.equal(failed.kind, 'RPC_ERROR');
});

test('a failure keeps the last known numbers instead of blanking the key', () => {
  const withHistory = instance({ primary: win('W', 30), resetCredits: 3 });
  assert.equal(chatgptApplyResult(withHistory, { ok: false, kind: 'TIMEOUT' }), false);
  assert.equal(withHistory.displayState, 'STALE');
  assert.equal(withHistory.lastErrorKind, 'TIMEOUT');
  assert.equal(withHistory.primary.percent, 30);

  for (const kind of ['NO_CLI', 'NOT_LOGGED_IN', 'TIMEOUT', 'RPC_ERROR']) {
    const fresh = instance();
    chatgptApplyResult(fresh, { ok: false, kind });
    assert.equal(fresh.displayState, kind);
  }
});

test('hydrated data is stale until a live fetch confirms it', () => {
  const persisted = {
    v: 1,
    primary: { label: 'W', percent: 30, severity: 'normal', resetsAt: 1, windowMins: 10080 },
    secondary: null,
    resetCredits: 3,
    planType: 'plus',
    fetchedAt: 99,
  };
  assert.equal(hydrateChatGptState(persisted).displayState, 'STALE');
  assert.equal(hydrateChatGptState(persisted).resetCredits, 3);

  for (const bad of [{ v: 99, primary: persisted.primary }, null, 'nope', { v: 1 }]) {
    const state = hydrateChatGptState(bad);
    assert.equal(state.displayState, 'PENDING');
    assert.equal(state.primary, null);
  }
});

test('the shorter window sorts first regardless of which field it arrived in', () => {
  const w = (label, percent, windowMins) => ({
    label, percent, severity: 'normal', resetsAt: null, windowMins,
  });
  // 接口没规定 primary 一定是长窗口，所以按时长排而不是按字段名。
  const weeklyPrimary = instance({ primary: w('W', 30, 10080), secondary: w('5H', 12, 300) });
  assert.deepEqual(chatgptVisibleRows(weeklyPrimary).map((r) => r.label), ['5H', 'W']);

  const swapped = instance({ primary: w('5H', 12, 300), secondary: w('W', 30, 10080) });
  assert.deepEqual(chatgptVisibleRows(swapped).map((r) => r.label), ['5H', 'W']);

  // 缺时长的排最后，而不是插到中间。
  const unknown = instance({ primary: w('?', 5, null), secondary: w('5H', 12, 300) });
  assert.deepEqual(chatgptVisibleRows(unknown).map((r) => r.label), ['5H', '?']);
});

test('the secondary row can be switched off, and severity follows what is visible', () => {
  const both = instance({ primary: win('W', 30), secondary: win('5H', 92, 'critical') });
  assert.equal(chatgptVisibleRows(both).length, 2);
  assert.equal(chatgptWorstSeverity(chatgptVisibleRows(both)), 'critical');

  const hidden = instance({ ...both, settings: { showSecondary: 'false' } });
  assert.deepEqual(chatgptVisibleRows(hidden).map((r) => r.label), ['W']);
  assert.equal(chatgptWorstSeverity(chatgptVisibleRows(hidden)), 'normal');
});

test('the usage url keeps its hash route through normalization', () => {
  // 用量页是 hash 路由（#settings/Usage）。normalizeUrl 若丢掉 fragment，
  // 长按就会打开 chatgpt.com 首页而不是用量面板——这条断言钉住那个前提。
  const normalized = config.normalizeSettings(
    { usageUrl: 'https://chatgpt.com/#settings/Usage' },
    config.defaults,
  );
  assert.equal(normalized.usageUrl, 'https://chatgpt.com/#settings/Usage');
  assert.ok(config.defaults.usageUrl.includes('#settings/Usage'), 'default must be the usage panel');

  // 缺 scheme 时补 https 且不吃掉 fragment。
  assert.equal(
    config.normalizeSettings({ usageUrl: 'chatgpt.com/#settings/Usage' }, config.defaults).usageUrl,
    'https://chatgpt.com/#settings/Usage',
  );
});

test('opening a url picks the right launcher per platform', () => {
  const [cmd, args] = openCommand('https://example.com');
  if (process.platform === 'darwin') {
    assert.equal(cmd, 'open');
  } else if (process.platform === 'win32') {
    // 空标题占位不能省，否则带引号的 URL 会被 start 当成窗口标题吞掉。
    assert.deepEqual(args.slice(0, 3), ['/c', 'start', '']);
  } else {
    assert.equal(cmd, 'xdg-open');
  }
  assert.ok(args.includes('https://example.com'));
});

test('render survives every display state and draws one band per visible row', () => {
  const decode = (i) => Buffer.from(config.render(i).split(',')[1], 'base64').toString('utf8');

  for (const state of ['PENDING', 'NO_CLI', 'NOT_LOGGED_IN', 'TIMEOUT', 'RPC_ERROR']) {
    assert.match(config.render(instance({ displayState: state })), /^data:image\/svg\+xml;base64,/);
  }

  // 每个 band 固定 3 个 text（标签 / 数值 / 附注），外加标题的 "ChatGPT"。
  const texts = (svg) => (svg.match(/<text/g) || []).length;
  const one = decode(instance({ primary: win('W', 30) }));
  const withCredits = decode(instance({ primary: win('W', 30), resetCredits: 3 }));
  const two = decode(instance({ primary: win('W', 30), secondary: win('5H', 12) }));

  assert.equal(texts(one), 1 + 1 * 3);
  assert.equal(texts(withCredits), 1 + 2 * 3);
  assert.equal(texts(two), 1 + 2 * 3);
  assert.ok(withCredits.includes('>RESET<'));
  assert.ok(!one.includes('>RESET<'), 'zero credits should not take a row');
  assert.ok(!two.includes('clipPath'), 'must not rely on clipPath');
});

test('the brand mark stays visible on light themes', () => {
  const decode = (i) => Buffer.from(config.render(i).split(',')[1], 'base64').toString('utf8');
  const dark = decode(instance({ primary: win('W', 30) }));
  const light = decode(instance({ settings: { theme: 'sand' }, primary: win('W', 30) }));
  // 固定白色是与 claudeusage 宠物对称的处理，但 sand 的画布是米白 —— 白标记等于隐形。
  assert.ok(dark.includes('fill="#ffffff"'), 'dark themes keep the white mark');
  assert.ok(!light.includes('fill="#ffffff"'), 'light themes must not draw a white mark');
});
