import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { __testing as lexTesting } from '../plugins/com.ulanzi.lexutility.ulanziPlugin/plugin/app.js';
import { Events as lexSdkEvents } from '../plugins/com.ulanzi.lexutility.ulanziPlugin/libs/node/constants.js';
import LexUlanzideckApi from '../plugins/com.ulanzi.lexutility.ulanziPlugin/libs/node/ulanzideckApi.js';
import { __testing as templateTesting } from '../template/com.example.hello.ulanziPlugin/plugin/app.js';

const lexActionConfigs = lexTesting.ACTION_CONFIGS;
const templateActionConfigs = templateTesting.ACTION_CONFIGS;
const clearLexTimeout = lexTesting.clearInstanceTimeout;
const delayLexInstance = lexTesting.delayInstance;
const frameworkLatencyCommit = lexTesting.commitLatencyResult;

const frameworks = [
  {
    name: 'lex utility',
    actionConfigs: lexActionConfigs,
    beginPress: lexTesting.beginPress,
    clearTimeout: lexTesting.clearInstanceTimeout,
    createExclusiveTaskQueue: lexTesting.createExclusiveTaskQueue,
    createSettingsEventProcessor: lexTesting.createSettingsEventProcessor,
    delayInstance: lexTesting.delayInstance,
    dispatchActionParam: lexTesting.dispatchActionParam,
    disposeInstance: lexTesting.disposeInstance,
    dispatchRunFallback: lexTesting.dispatchRunFallback,
    endPress: lexTesting.endPress,
    frameFor: lexTesting.frameFor,
    handleRunEvent: lexTesting.handleRunEvent,
    longPressFeedbackIcon: lexTesting.longPressFeedbackIcon,
    initializeInstanceState: lexTesting.initializeInstanceState,
    resolveSettings: lexTesting.resolveSettingsForEvent,
    storageFactory: lexTesting.createSettingsStorage,
    writePersistedSettings: lexTesting.writePersistedSettings,
    configKey: 'latency',
    context: 'com.ulanzi.ulanzistudio.lexutility.latency___key-1___action-1',
    renderInstance: (overrides = {}) => ({
      settings: { ...lexActionConfigs.latency.defaults, ...overrides },
      lastMs: null,
      status: 'checking',
      checking: false,
      requestId: 0,
      buckets: [],
      recent: [],
      paused: false,
      certExpiresAt: null,
    }),
  },
  {
    name: 'template',
    actionConfigs: templateActionConfigs,
    beginPress: templateTesting.beginPress,
    clearTimeout: templateTesting.clearInstanceTimeout,
    createExclusiveTaskQueue: templateTesting.createExclusiveTaskQueue,
    createSettingsEventProcessor: templateTesting.createSettingsEventProcessor,
    delayInstance: templateTesting.delayInstance,
    dispatchActionParam: templateTesting.dispatchActionParam,
    disposeInstance: templateTesting.disposeInstance,
    dispatchRunFallback: templateTesting.dispatchRunFallback,
    endPress: templateTesting.endPress,
    frameFor: templateTesting.frameFor,
    handleRunEvent: templateTesting.handleRunEvent,
    longPressFeedbackIcon: templateTesting.longPressFeedbackIcon,
    initializeInstanceState: templateTesting.initializeInstanceState,
    resolveSettings: templateTesting.resolveSettingsForEvent,
    storageFactory: templateTesting.createSettingsStorage,
    writePersistedSettings: templateTesting.writePersistedSettings,
    configKey: 'counter',
    context: '__PLUGIN_UUID__.counter___key-1___action-1',
    renderInstance: (overrides = {}) => ({
      settings: { ...templateActionConfigs.counter.defaults, ...overrides },
      count: 0,
    }),
  },
];

test('shared bridge exposes the latest SDK keydown and keyup events', () => {
  assert.equal(lexSdkEvents.KEYDOWN, 'keydown');
  assert.equal(lexSdkEvents.KEYUP, 'keyup');
  assert.equal(typeof LexUlanzideckApi.prototype.onKeyDown, 'function');
  assert.equal(typeof LexUlanzideckApi.prototype.onKeyUp, 'function');
});

test('Lex Utility only exposes production actions', () => {
  const manifestPath = path.resolve(
    import.meta.dirname,
    '../plugins/com.ulanzi.lexutility.ulanziPlugin/manifest.json',
  );
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  assert.deepEqual(Object.keys(lexActionConfigs).sort(), ['bambustatus', 'chatgptusage', 'claudeusage', 'healthbreak', 'latency', 'nasstatus', 'pomowave', 'speedtest', 'systemstatus']);
  assert.deepEqual(
    manifest.Actions.map((action) => action.UUID.split('.').at(-1)).sort(),
    ['bambustatus', 'chatgptusage', 'claudeusage', 'healthbreak', 'latency', 'nasstatus', 'pomowave', 'speedtest', 'systemstatus'],
  );
});

for (const framework of frameworks) {
  test(`${framework.name}: host restore keeps persisted settings authoritative`, () => {
    const settings = framework.resolveSettings('hostRestore', {
      current: { title: 'current', theme: 'mint' },
      incoming: { title: 'stale host', color: '#111111' },
      persisted: { title: 'persisted', color: '#222222' },
    });

    assert.deepEqual(settings, { title: 'persisted', theme: 'mint', color: '#222222' });
  });

  test(`${framework.name}: PI submit keeps incoming settings authoritative`, () => {
    const settings = framework.resolveSettings('pluginSubmit', {
      current: { title: 'current', theme: 'mint' },
      incoming: { title: 'new PI', color: '#333333' },
      persisted: { title: 'persisted', color: '#222222' },
    });

    assert.deepEqual(settings, { title: 'new PI', theme: 'mint', color: '#333333' });
  });

  test(`${framework.name}: generic PI message hook is optional and receives the param`, () => {
    const calls = [];
    const instance = { context: 'ctx' };

    assert.doesNotThrow(() => framework.dispatchActionParam({}, instance, { ignored: true }));
    framework.dispatchActionParam(
      { onParamFromPlugin: (receivedInstance, param) => calls.push([receivedInstance, param]) },
      instance,
      { resetTimer: 'true' },
    );

    assert.deepEqual(calls, [[instance, { resetTimer: 'true' }]]);
  });

  test(`${framework.name}: a cancelled instance delay settles instead of hanging`, async () => {
    const instance = {};
    const delayed = framework.delayInstance(instance, 'feedback', 10_000);
    framework.clearTimeout(instance, 'feedback');

    assert.equal(await delayed, false);
    assert.equal(instance.timers.size, 0);
  });

  test(`${framework.name}: disposing an instance settles every registered delay`, async () => {
    const instance = {};
    const first = framework.delayInstance(instance, 'first', 10_000);
    const second = framework.delayInstance(instance, 'second', 10_000);
    framework.disposeInstance(instance);

    assert.deepEqual(await Promise.all([first, second]), [false, false]);
    assert.equal(instance.timers.size, 0);
  });

  test(`${framework.name}: keydown leaves visual feedback to the host and keyup renders the result`, () => {
    const renders = [];
    let shortPresses = 0;
    let scheduled;
    let cancelled = false;
    const instance = { context: 'press', active: true };
    const config = { onRun: () => { shortPresses += 1; } };
    const runtime = {
      render: (current) => { renders.push(current.pressed === true); },
      setTimeout: (_instance, _slot, fn, ms) => { scheduled = { fn, ms }; },
      clearTimeout: () => { cancelled = true; },
    };

    framework.beginPress(instance, config, runtime);
    assert.equal(instance.usesKeyEvents, true);
    assert.deepEqual(renders, [], 'keydown must not submit a plugin-generated press frame');
    assert.equal(scheduled, undefined, 'actions without onLongPress do not allocate a timer');

    framework.endPress(instance, config, runtime);
    assert.equal(cancelled, true);
    assert.equal(shortPresses, 1, 'short action fires on release, not keydown');
    assert.deepEqual(renders, [false]);
  });

  test(`${framework.name}: long-press feedback inverts color without changing geometry`, () => {
    const sourceSvg = '<svg width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" fill="#123456"/></svg>';
    const source = `data:image/svg+xml;base64,${Buffer.from(sourceSvg).toString('base64')}`;
    assert.equal(framework.longPressFeedbackIcon(source, false), source);

    const feedback = Buffer.from(
      framework.longPressFeedbackIcon(source, true).slice('data:image/svg+xml;base64,'.length),
      'base64',
    ).toString('utf8');
    assert.ok(feedback.includes('viewBox="0 0 256 256"'));
    assert.ok(feedback.includes('fill="#edcba9"'), 'RGB literals are inverted directly for host compatibility');
    assert.equal(feedback.includes('<filter'), false, 'feedback cannot depend on unsupported SVG filters');
    assert.equal(feedback.includes('transform="'), false, 'feedback must not introduce geometric scaling');
  });

  test(`${framework.name}: a 600ms hold qualifies at the threshold and fires long press on keyup`, () => {
    let shortPresses = 0;
    let longPresses = 0;
    let renders = 0;
    let scheduled;
    const instance = { context: 'hold', active: true };
    const config = {
      onRun: () => { shortPresses += 1; },
      onLongPress: () => { longPresses += 1; },
    };
    const runtime = {
      render: () => { renders += 1; },
      setTimeout: (_instance, slot, fn, ms) => { scheduled = { slot, fn, ms }; },
      clearTimeout: () => {},
    };

    framework.beginPress(instance, config, runtime);
    assert.equal(scheduled.ms, 600);
    assert.equal(renders, 0, 'keydown delegates the pressed frame to the host');
    scheduled.fn();
    assert.equal(longPresses, 0, 'the threshold only qualifies the hold');
    assert.equal(renders, 1, 'long-press activation submits one color-only feedback frame');
    assert.equal(instance.longPressQualified, true);
    assert.equal(instance.longPressFeedback, true);
    framework.endPress(instance, config, runtime);
    assert.equal(longPresses, 1);
    assert.equal(shortPresses, 0);
    assert.equal(renders, 2, 'keyup submits the latest normal-color business state once');
    assert.equal(instance.longPressFeedback, false);

    framework.dispatchRunFallback(instance, config, runtime.render, instance.lastKeyEventAt);
    assert.equal(shortPresses, 0, 'legacy run is ignored right after real key events');
  });

  test(`${framework.name}: run following keydown is ignored before runtime can render again`, () => {
    const context = 'keydown-then-run';
    const now = Date.now();
    const instance = { context, usesKeyEvents: true, pressed: true, lastKeyEventAt: now };
    let runtimeCalls = 0;
    const result = framework.handleRunEvent(context, {
      instances: new Map([[context, instance]]),
      now: now + 50,
      eventProcessor: {
        runtime: () => {
          runtimeCalls += 1;
          throw new Error('runtime must not run for a duplicate host event');
        },
      },
    });

    assert.equal(result, instance);
    assert.equal(runtimeCalls, 0, 'duplicate run cannot submit a second pressed frame');
    assert.equal(instance.pressed, true);
  });

  // 拖拽移动按键 = keyDown 之后那次 keyUp 被拖拽消费掉，实例永久停在 pressed=true。
  // 曾经 usesKeyEvents 是永久锁存，此后宿主补发的 run 被无条件吞掉，这个键就再也按不动了。
  // 抑制必须是时间窗：超窗即认为按键事件通路已断，回落到 run，让按键自愈。
  test(`${framework.name}: run recovers the key after a keyup was lost to a drag`, () => {
    const context = 'drag-lost-keyup';
    const now = Date.now();
    const instance = { context, usesKeyEvents: true, pressed: true, lastKeyEventAt: now };
    let shortPresses = 0;
    const config = { onRun: () => { shortPresses += 1; } };

    framework.dispatchRunFallback(instance, config, () => {}, now + 100);
    assert.equal(shortPresses, 0, 'the run right after a key event is still a duplicate');

    framework.dispatchRunFallback(instance, config, () => {}, now + 5000);
    assert.equal(shortPresses, 1, 'a later run must not stay swallowed forever');
  });

  // 拖拽期间长按判定已达标却没等到 keyUp；下一次全新按压必须重新计时，
  // 否则第一次短按会被误判成长按。
  test(`${framework.name}: a fresh keydown clears the stale long-press qualification`, () => {
    const instance = { context: 'stale-long-press', pressed: true, longPressQualified: true };
    let shortPresses = 0;
    let longPresses = 0;
    const config = {
      onRun: () => { shortPresses += 1; },
      onLongPress: () => { longPresses += 1; },
    };
    const runtime = { render: () => {}, setTimeout: () => {}, clearTimeout: () => {} };

    framework.beginPress(instance, config, runtime);
    assert.equal(instance.longPressQualified, false, 'a new press starts a clean hold');

    framework.endPress(instance, config, runtime);
    assert.equal(shortPresses, 1, 'the press dispatches as a short press');
    assert.equal(longPresses, 0);
  });

  test(`${framework.name}: exclusive tasks sharing a resource run serially`, async () => {
    const queue = framework.createExclusiveTaskQueue();
    const first = { context: 'first' };
    const second = { context: 'second' };
    const events = [];
    let releaseFirst;

    const firstRun = queue.run(first, 'network-bandwidth', async () => {
      events.push('first:start');
      await new Promise((resolve) => { releaseFirst = resolve; });
      events.push('first:end');
      return 'first-result';
    });
    const secondRun = queue.run(second, 'network-bandwidth', async () => {
      events.push('second:start');
      return 'second-result';
    });

    await Promise.resolve();
    assert.deepEqual(events, ['first:start']);
    assert.equal(queue.position(second, 'network-bandwidth'), 1);

    releaseFirst();
    assert.equal(await firstRun, 'first-result');
    assert.equal(await secondRun, 'second-result');
    assert.deepEqual(events, ['first:start', 'first:end', 'second:start']);
  });

  test(`${framework.name}: exclusive queue deduplicates and can cancel a waiting instance`, async () => {
    const queue = framework.createExclusiveTaskQueue();
    const active = { context: 'active' };
    const waiting = { context: 'waiting' };
    let releaseActive;
    let waitingStarts = 0;

    const activeRun = queue.run(active, 'network-bandwidth', () =>
      new Promise((resolve) => { releaseActive = resolve; }));
    const waitingRun = queue.run(waiting, 'network-bandwidth', async () => {
      waitingStarts += 1;
    });
    const duplicate = queue.run(waiting, 'network-bandwidth', async () => {
      waitingStarts += 1;
    });

    assert.equal(waitingRun, duplicate);
    assert.equal(queue.cancel(waiting, 'network-bandwidth'), true);
    assert.deepEqual(await waitingRun, { cancelled: true });
    assert.equal(waitingStarts, 0);

    releaseActive('done');
    assert.equal(await activeRun, 'done');
  });

  test(`${framework.name}: cancelling an active exclusive task aborts it and releases the next`, async () => {
    const queue = framework.createExclusiveTaskQueue();
    const active = { context: 'active' };
    const next = { context: 'next' };
    let aborted = false;
    let nextStarted = false;

    const activeRun = queue.run(active, 'network-bandwidth', (signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          resolve({ cancelled: true });
        }, { once: true });
      }));
    const nextRun = queue.run(next, 'network-bandwidth', async () => {
      nextStarted = true;
      return 'next-result';
    });

    await Promise.resolve();
    assert.equal(queue.cancel(active, 'network-bandwidth'), true);
    assert.deepEqual(await activeRun, { cancelled: true });
    assert.equal(await nextRun, 'next-result');
    assert.equal(aborted, true);
    assert.equal(nextStarted, true);
  });

  test(`${framework.name}: createState failures are guarded onto the instance`, () => {
    const instance = { context: 'ctx', actionUuid: 'unknown', settings: {}, active: true };
    const originalConsoleLog = console.log;

    try {
      console.log = () => {};
      framework.initializeInstanceState(instance, {
        createState: () => {
          throw new Error('state exploded');
        },
      });
    } finally {
      console.log = originalConsoleLog;
    }

    assert.equal(instance.lastError?.phase, 'createState');
    assert.equal(instance.lastError?.message, 'state exploded');
  });

  test(`${framework.name}: production event processor restores persisted settings and syncs them to host`, () => {
    const sent = [];
    const writes = [];
    const controller = framework.createSettingsEventProcessor({
      ud: {
        sendParamFromPlugin: (settings, context) => sent.push({ settings, context }),
      },
      instances: new Map(),
      readPersisted: () => ({
        ...framework.actionConfigs[framework.configKey].defaults,
        theme: 'mono',
      }),
      writePersisted: (context, config, settings) => writes.push({ context, config, settings }),
      render: () => {},
      ready: () => {},
    });

    const instance = controller.hostRestore(framework.context, { theme: 'mint' });

    assert.equal(instance.settings.theme, 'mono');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].settings.__settingsSync, 'true');
    assert.equal(sent[0].settings.theme, 'mono');
    assert.equal(sent[0].context, framework.context);
    assert.equal(writes.length, 0);
  });

  test(`${framework.name}: host restore always echoes authoritative settings to a newly opened inspector`, () => {
    const persisted = {
      ...framework.actionConfigs[framework.configKey].defaults,
      theme: 'mono',
    };
    const sent = [];
    const controller = framework.createSettingsEventProcessor({
      ud: {
        sendParamFromPlugin: (settings, context) => sent.push({ settings, context }),
      },
      instances: new Map(),
      readPersisted: () => ({ ...persisted }),
      writePersisted: () => {},
      render: () => {},
      ready: () => {},
    });

    controller.hostRestore(framework.context, { ...persisted });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].settings.__settingsSync, 'true');
    assert.equal(sent[0].settings.theme, 'mono');
    assert.equal(sent[0].context, framework.context);
  });

  test(`${framework.name}: a late inspector can request authoritative settings without writing`, () => {
    const persisted = {
      ...framework.actionConfigs[framework.configKey].defaults,
      theme: 'mono',
      frameSize: 'max',
      showFrame: 'false',
    };
    const sent = [];
    const writes = [];
    const controller = framework.createSettingsEventProcessor({
      ud: { sendParamFromPlugin: (settings, context) => sent.push({ settings, context }) },
      instances: new Map(),
      readPersisted: () => ({ ...persisted }),
      writePersisted: (...args) => writes.push(args),
      render: () => {},
      ready: () => {},
    });

    controller.pluginSubmit(framework.context, { __requestSettings: 'true' });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].settings.__settingsSync, 'true');
    assert.equal(sent[0].settings.theme, 'mono');
    assert.equal(sent[0].settings.frameSize, 'max');
    assert.equal(sent[0].settings.showFrame, 'false');
    assert.equal(writes.length, 0);
  });

  test(`${framework.name}: current and legacy inspector sync echoes cannot overwrite persisted settings`, () => {
    const persisted = {
      ...framework.actionConfigs[framework.configKey].defaults,
      theme: 'mono',
    };
    const writes = [];
    let renders = 0;
    const controller = framework.createSettingsEventProcessor({
      ud: { sendParamFromPlugin: () => {} },
      instances: new Map(),
      readPersisted: () => ({ ...persisted }),
      writePersisted: (...args) => writes.push(args),
      render: () => { renders += 1; },
      ready: () => {},
    });

    const instance = controller.hostRestore(framework.context, { ...persisted });
    const rendersBeforeEcho = renders;
    controller.pluginSubmit(framework.context, {
      __settingsSync: 'true',
      theme: 'mint',
    });
    controller.pluginSubmit(framework.context, { theme: 'signal' });

    assert.equal(instance.settings.theme, 'mono');
    assert.equal(writes.length, 0);
    assert.equal(renders, rendersBeforeEcho);
  });

  test(`${framework.name}: production event processor persists incoming PI submission`, () => {
    const writes = [];
    const controller = framework.createSettingsEventProcessor({
      ud: { sendParamFromPlugin: () => {} },
      instances: new Map(),
      readPersisted: () => ({
        ...framework.actionConfigs[framework.configKey].defaults,
        theme: 'mono',
      }),
      writePersisted: (context, config, settings) => writes.push({ context, config, settings }),
      render: () => {},
      ready: () => {},
    });

    const instance = controller.pluginSubmit(framework.context, { __settingsSubmit: 'true', theme: 'signal' });

    assert.equal(instance.settings.theme, 'signal');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].settings.theme, 'signal');
  });

  test(`${framework.name}: createState error invokes the injected ERR renderer and returns control`, () => {
    const renderedErrors = [];
    const instance = { context: 'ctx', actionUuid: 'unknown', settings: {}, active: true };
    const originalConsoleLog = console.log;

    try {
      console.log = () => {};
      const returned = framework.initializeInstanceState(
        instance,
        { createState: () => { throw new Error('state exploded'); } },
        { renderError: (failedInstance) => renderedErrors.push(failedInstance) },
      );
      assert.equal(returned, instance);
    } finally {
      console.log = originalConsoleLog;
    }

    assert.equal(instance.lastError?.phase, 'createState');
    assert.deepEqual(renderedErrors, [instance]);
  });

  test(`${framework.name}: repeated host restore and unchanged PI do not write, changed PI writes once`, () => {
    let persisted = { theme: 'mono' };
    const writes = [];
    const controller = framework.createSettingsEventProcessor({
      ud: { sendParamFromPlugin: () => {} },
      instances: new Map(),
      readPersisted: () => ({ ...persisted }),
      writePersisted: (context, config, settings) => {
        writes.push({ context, settings: { ...settings } });
        persisted = { ...settings };
      },
      render: () => {},
      ready: () => {},
    });

    controller.hostRestore(framework.context, { theme: 'mint' });
    controller.hostRestore(framework.context, { theme: 'mint' });
    controller.pluginSubmit(framework.context, { __settingsSubmit: 'true', theme: 'mono' });
    assert.equal(writes.length, 0);

    controller.pluginSubmit(framework.context, { __settingsSubmit: 'true', theme: 'signal' });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].settings.theme, 'signal');
  });

  test(`${framework.name}: runtime ensure ignores host params and never persists existing instance`, () => {
    const writes = [];
    const controller = framework.createSettingsEventProcessor({
      ud: { sendParamFromPlugin: () => {} },
      instances: new Map(),
      readPersisted: () => ({
        ...framework.actionConfigs[framework.configKey].defaults,
        theme: 'mono',
      }),
      writePersisted: (...args) => writes.push(args),
      render: () => {},
      ready: () => {},
    });
    const instance = controller.hostRestore(framework.context, { theme: 'mint' });

    controller.runtime(framework.context, { theme: 'signal' });

    assert.equal(instance.settings.theme, 'mono');
    assert.equal(writes.length, 0);
  });

  test(`${framework.name}: safe frame scales content and toggles the frame chrome`, () => {
    const render = framework.actionConfigs[framework.configKey].render;
    const decode = (icon) => Buffer.from(icon.split(',')[1], 'base64').toString('utf8');
    const instanceFor = framework.renderInstance;

    // 几何：optimal 内容箱收到 30（壳→面板留白 12，放大 ~1.11）；max 放大 1.25。
    assert.equal(framework.frameFor({ frameSize: 'optimal' }).scale, (256 - 30 * 2) / 176);
    assert.equal(framework.frameFor({ frameSize: 'max' }).scale, 1.25);
    assert.equal(framework.frameFor({}).show, true);
    assert.equal(framework.frameFor({ showFrame: 'false' }).show, false);
    // 背景界：optimal 背景随安全框内缩，max 铺满整键。
    assert.equal(framework.frameFor({}).bleed, 12);
    assert.equal(framework.frameFor({ frameSize: 'max' }).bleed, 0);

    // 圆角规则：背景 = 自身边长 × 42/256（硬件键角），嵌套层与背景同心递减。
    for (const size of ['optimal', 'max']) {
      const frame = framework.frameFor({ frameSize: size });
      assert.equal(frame.bleedRadius, Math.round((256 - frame.bleed * 2) * (42 / 256)), size);
      assert.equal(frame.ringRadius, frame.bleedRadius - (frame.ring - frame.bleed), size);
      assert.equal(frame.shellRadius, frame.bleedRadius - (frame.shell - frame.bleed), size);
      assert.equal(frame.panelRadius, frame.bleedRadius - (frame.panel - frame.bleed), size);
      // 内框线（高亮区域）：贴面板内缘，圆角同样同心推导。
      assert.equal(frame.highlight, frame.panel + 4, size);
      assert.equal(frame.highlightRadius, Math.max(2, frame.bleedRadius - (frame.highlight - frame.bleed)), size);
    }

    // template 的 counter 直接消费 renderScreenFrame，可作为共享骨架的端到端夹具；
    // Lex Utility 的 latency 使用自己的主题背景，另有专门的安全框渲染测试覆盖。
    if (framework.name === 'template') {
      const optimal = decode(render(instanceFor({})));
      assert.ok(optimal.includes('stroke'), 'frame chrome should be drawn by default');
      assert.ok(optimal.includes('scale(1.1136'), 'optimal frame scales content into the tightened 30-inset box');
      assert.ok(
        optimal.includes('x="12" y="12" width="232" height="232" rx="38"'),
        'optimal background is inset to the safe frame instead of filling the key',
      );

      const max = decode(render(instanceFor({ frameSize: 'max' })));
      assert.ok(max.includes('scale(1.25'), 'max frame scales content to the larger safe area');
      assert.ok(
        max.includes('x="0" y="0" width="256" height="256" rx="42"'),
        'max background fills the whole key',
      );

      const hidden = decode(render(instanceFor({ showFrame: 'false' })));
      assert.ok(!hidden.includes('stroke'), 'hidden frame removes the chrome strokes');
    }
  });

  test(`${framework.name}: frame settings normalize with safe fallbacks`, () => {
    const controller = framework.createSettingsEventProcessor({
      ud: { sendParamFromPlugin: () => {} },
      instances: new Map(),
      readPersisted: () => ({}),
      writePersisted: () => {},
      render: () => {},
      ready: () => {},
    });

    const instance = controller.pluginSubmit(framework.context, {
      __settingsSubmit: 'true',
      frameSize: 'huge',
      showFrame: 'nope',
    });

    assert.equal(instance.settings.frameSize, 'optimal');
    assert.equal(instance.settings.showFrame, 'true');
  });

  test(`${framework.name}: PI reset-defaults control restores defaults, persists, and echoes to inspector`, () => {
    const sent = [];
    const writes = [];
    const hookCalls = [];
    let persisted = { theme: 'mono' };
    const actionConfig = framework.actionConfigs[framework.configKey];
    actionConfig.onParamFromPlugin = (instance, param) => hookCalls.push(param);
    try {
      const controller = framework.createSettingsEventProcessor({
        ud: { sendParamFromPlugin: (settings, context) => sent.push({ settings, context }) },
        instances: new Map(),
        readPersisted: () => ({ ...persisted }),
        writePersisted: (context, config, settings) => {
          writes.push({ ...settings });
          persisted = { ...settings };
        },
        render: () => {},
        ready: () => {},
      });
      controller.hostRestore(framework.context, { ...persisted });
      sent.length = 0;

      const instance = controller.pluginSubmit(framework.context, { __resetDefaults: 'true' });

      const defaults = actionConfig.defaults;
      assert.equal(instance.settings.theme, defaults.theme);
      assert.equal(writes.length, 1);
      assert.equal(writes[0].theme, defaults.theme);
      assert.equal(Object.hasOwn(writes[0], '__resetDefaults'), false);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].settings.theme, defaults.theme);
      assert.equal(sent[0].settings.__resetDefaults, undefined);
      assert.equal(sent[0].context, framework.context);
      assert.deepEqual(hookCalls, [], 'control param must not reach action onParamFromPlugin');

      // 已是默认值时再次恢复：不重复写盘，但仍回推让表单刷新。
      controller.pluginSubmit(framework.context, { __resetDefaults: 'true' });
      assert.equal(writes.length, 1);
      assert.equal(sent.length, 2);
    } finally {
      delete actionConfig.onParamFromPlugin;
    }
  });

  test(`${framework.name}: storage atomically replaces data without temp residue`, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ulanzi-store-'));
    const storePath = path.join(directory, 'action-settings.json');
    try {
      const storage = framework.storageFactory({ storePath, logger: () => {} });
      assert.equal(storage.write({ key: { title: 'saved' } }), true);
      assert.deepEqual(JSON.parse(fs.readFileSync(storePath, 'utf8')), { key: { title: 'saved' } });
      assert.deepEqual(fs.readdirSync(directory).filter((name) => name.includes('.tmp')), []);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test(`${framework.name}: failed atomic rename removes temp file and preserves old store`, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ulanzi-store-fail-'));
    const storePath = path.join(directory, 'action-settings.json');
    fs.writeFileSync(storePath, JSON.stringify({ old: true }));
    const errors = [];
    const failingFs = {
      ...fs,
      renameSync: () => { throw new Error('rename failed'); },
    };
    try {
      const storage = framework.storageFactory({
        storePath,
        fsImpl: failingFs,
        logger: (...args) => errors.push(args),
      });
      assert.equal(storage.write({ fresh: true }), false);
      assert.deepEqual(JSON.parse(fs.readFileSync(storePath, 'utf8')), { old: true });
      assert.deepEqual(fs.readdirSync(directory).filter((name) => name.includes('.tmp')), []);
      assert.equal(errors.length, 1);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test(`${framework.name}: corrupt store becomes read-only and rejects later writes`, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ulanzi-readonly-'));
    const storePath = path.join(directory, 'action-settings.json');
    const corrupt = '{broken json';
    const errors = [];
    try {
      fs.writeFileSync(storePath, corrupt);
      const storage = framework.storageFactory({
        storePath,
        logger: (...args) => errors.push(args),
      });

      assert.deepEqual(storage.load(), {});
      assert.equal(storage.storeCorrupt, true);
      assert.equal(storage.write({ replacement: true }), false);
      assert.equal(fs.readFileSync(storePath, 'utf8'), corrupt);
      assert.equal(errors.length, 2);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test(`${framework.name}: non-object JSON store is corrupt, read-only, and never replaced`, () => {
    const invalidStores = [null, [], 42, 'text'];
    for (const [index, invalidStore] of invalidStores.entries()) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ulanzi-shape-'));
      const storePath = path.join(directory, 'action-settings.json');
      const legacyPath = path.join(directory, 'latency-settings.json');
      const original = JSON.stringify(invalidStore);
      try {
        fs.writeFileSync(storePath, original);
        fs.writeFileSync(legacyPath, JSON.stringify({ legacy: { title: 'must not load' } }));
        const storage = framework.storageFactory({
          storePath,
          legacyPath,
          logger: () => {},
        });

        assert.deepEqual(storage.load(), {}, `invalid store index ${index}`);
        assert.equal(storage.storeCorrupt, true, `invalid store index ${index}`);
        assert.equal(storage.loadedFromLegacy, false, `invalid store index ${index}`);
        assert.equal(storage.write({ replacement: true }), false, `invalid store index ${index}`);
        assert.equal(fs.readFileSync(storePath, 'utf8'), original, `invalid store index ${index}`);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  test(`${framework.name}: failed persist keeps mirror stale so identical PI submit retries`, () => {
    const mirror = {};
    let disk = {};
    let attempts = 0;
    const storage = {
      write(candidate) {
        attempts += 1;
        if (attempts === 1) {
          return false;
        }
        disk = structuredClone(candidate);
        return true;
      },
    };
    const writePersisted = (context, config, settings) => framework.writePersistedSettings(
      context,
      config,
      settings,
      {
        store: mirror,
        storage,
        keyFromContext: () => 'slot',
      },
    );
    const controller = framework.createSettingsEventProcessor({
      ud: { sendParamFromPlugin: () => {} },
      instances: new Map(),
      readPersisted: () => mirror.slot || {},
      writePersisted,
      render: () => {},
      ready: () => {},
    });
    const retryTheme = framework.actionConfigs[framework.configKey].defaults.theme === 'signal'
      ? 'mono'
      : 'signal';

    controller.pluginSubmit(framework.context, { __settingsSubmit: 'true', theme: retryTheme });
    assert.equal(attempts, 1);
    assert.deepEqual(mirror, {});

    controller.pluginSubmit(framework.context, { __settingsSubmit: 'true', theme: retryTheme });
    assert.equal(attempts, 2);
    assert.equal(mirror.slot.theme, retryTheme);
    assert.deepEqual(disk, mirror);
  });
}

test('lex utility: storage falls back to legacy only when new store is missing', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ulanzi-legacy-'));
  const storePath = path.join(directory, 'action-settings.json');
  const legacyPath = path.join(directory, 'latency-settings.json');
  try {
    fs.writeFileSync(legacyPath, JSON.stringify({ legacy: { title: 'legacy' } }));
    const storage = lexTesting.createSettingsStorage({ storePath, legacyPath, logger: () => {} });
    assert.deepEqual(storage.load(), { legacy: { title: 'legacy' } });
    assert.equal(storage.loadedFromLegacy, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(storePath, 'utf8')), { legacy: { title: 'legacy' } });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('lex utility: corrupt new store is preserved and never replaced by legacy data', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ulanzi-corrupt-'));
  const storePath = path.join(directory, 'action-settings.json');
  const legacyPath = path.join(directory, 'latency-settings.json');
  const corrupt = '{not valid json';
  const errors = [];
  try {
    fs.writeFileSync(storePath, corrupt);
    fs.writeFileSync(legacyPath, JSON.stringify({ legacy: { title: 'must not load' } }));
    const storage = lexTesting.createSettingsStorage({
      storePath,
      legacyPath,
      logger: (...args) => errors.push(args),
    });
    assert.deepEqual(storage.load(), {});
    assert.equal(storage.storeCorrupt, true);
    assert.equal(storage.write({ replacement: true }), false);
    assert.equal(fs.readFileSync(storePath, 'utf8'), corrupt);
    assert.equal(errors.length, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('lex utility: inner highlight frame draws only when a status triggers it', () => {
  const decode = (icon) => Buffer.from(icon.split(',')[1], 'base64').toString('utf8');
  const latencyRender = lexActionConfigs.latency.render;
  const instanceFor = (status) => ({
    settings: {
      url: 'https://example.com',
      intervalSec: '30',
      warnMs: '800',
      timeoutMs: '8000',
      theme: 'signal',
      frameSize: 'optimal',
      showFrame: 'true',
      graphMode: 'bars',
    },
    recent: [{ t: Date.now(), ok: status !== 'down', ms: 42 }],
    buckets: [],
    lastMs: status === 'down' ? null : 42,
    status,
    checking: false,
    requestId: 1,
  });

  // optimal 档内框线：panel(30)+4=34，同心圆角 radiusAt(34)=16。
  const highlightMarker = 'x="34" y="34" width="188" height="188" rx="16"';
  assert.ok(decode(latencyRender(instanceFor('down'))).includes(highlightMarker), 'down status draws the highlight');
  assert.ok(!decode(latencyRender(instanceFor('up'))).includes(highlightMarker), 'normal status keeps it hidden');
});

test('lex utility: latency background art follows the safe frame size without clipPath', () => {
  const decode = (icon) => Buffer.from(icon.split(',')[1], 'base64').toString('utf8');
  const latencyRender = lexActionConfigs.latency.render;
  const instanceFor = (frameSize) => ({
    settings: {
      url: 'https://example.com',
      intervalSec: '30',
      warnMs: '800',
      timeoutMs: '8000',
      theme: 'signal',
      frameSize,
      showFrame: 'true',
      graphMode: 'bars',
    },
    recent: [{ t: Date.now(), ok: true, ms: 42 }],
    buckets: [],
    lastMs: 42,
    status: 'up',
    checking: false,
    requestId: 1,
  });

  const optimal = decode(latencyRender(instanceFor('optimal')));
  assert.ok(
    optimal.includes('translate(12 12) scale(0.9063)'),
    'optimal art must scale into the inset background box',
  );
  assert.ok(!optimal.includes('clipPath'), 'background must not rely on clipPath (host support unreliable)');

  const max = decode(latencyRender(instanceFor('max')));
  assert.ok(max.includes('<rect width="256" height="256" rx="42"'), 'max art fills the whole key');
  assert.ok(!max.includes('translate(12 12)'), 'max art needs no inset transform');
});

test('lex utility: real pomowave config resets only for resetTimer message', () => {
  const config = lexActionConfigs.pomowave;
  const instance = {
    settings: { ...config.defaults },
    ...config.createState(),
    phase: 'focus',
    running: true,
    remainingSec: 12,
    totalSec: 1500,
    completedFocusRounds: 3,
  };

  config.onParamFromPlugin(instance, { title: 'ordinary setting' });
  assert.equal(instance.phase, 'focus');
  assert.equal(instance.completedFocusRounds, 3);

  config.onParamFromPlugin(instance, { resetTimer: 'true' });
  assert.equal(instance.phase, 'idle');
  assert.equal(instance.running, false);
  assert.equal(instance.remainingSec, 1500);
  assert.equal(instance.completedFocusRounds, 0);
});

function createPomodoroInstance(context, overrides = {}) {
  const config = lexActionConfigs.pomowave;
  return {
    context,
    actionUuid: 'com.ulanzi.ulanzistudio.lexutility.pomowave',
    // active:false 让 renderInstance 直接短路，测试无需宿主连接
    active: false,
    settings: { ...config.defaults, soundEnabled: 'false' },
    ...config.createState(),
    ...overrides,
  };
}

test('lex utility: pomowave tick derives remaining from the wall clock', () => {
  const now = Date.now();
  const context = 'com.ulanzi.ulanzistudio.lexutility.pomowave___tick___t1';
  const instance = createPomodoroInstance(context, {
    phase: 'focus',
    running: true,
    totalSec: 1500,
    remainingSec: 1500,
    phaseEndAt: now + 91_000,
  });
  const instances = new Map([[context, instance]]);

  // 即使 setTimeout 晚了 500ms，剩余时间也按时钟算，不产生累计漂移。
  lexTesting.tickPomodoro(instance, { instances, now: now + 500 });
  assert.equal(instance.remainingSec, 91);
  assert.equal(instance.phase, 'focus');

  lexTesting.clearInstanceTimeout(instance, 'pomodoro');
  lexTesting.dropPersistedState(context);
});

test('lex utility: pomowave overdue tick advances the phase after a sleep gap', () => {
  const now = Date.now();
  const context = 'com.ulanzi.ulanzistudio.lexutility.pomowave___tick___t2';
  const instance = createPomodoroInstance(context, {
    phase: 'focus',
    running: true,
    totalSec: 1500,
    remainingSec: 40,
    phaseEndAt: now - 600_000, // 合盖睡了 10 分钟，专注早该结束
  });
  const instances = new Map([[context, instance]]);

  lexTesting.tickPomodoro(instance, { instances, now });
  assert.equal(instance.phase, 'shortBreak');
  assert.equal(instance.completedFocusRounds, 1);

  lexTesting.clearInstanceTimeout(instance, 'pomodoro');
  lexTesting.dropPersistedState(context);
});

// 拆分 action 模块后，pomowave 曾漏接 runtime 的 instances / frameHighlight，
// 而既有用例每次都显式传 instances、又从不构造告警脉冲，两条真机路径全部脱网。
// 这两个用例专门守住「按模块自身闭包解析依赖」这件事。
test('lex utility: pomowave tick without an explicit instance map falls back to the runtime registry', () => {
  const context = 'com.ulanzi.ulanzistudio.lexutility.pomowave___tick___fallback';
  const instance = createPomodoroInstance(context, {
    phase: 'focus',
    running: true,
    totalSec: 1500,
    remainingSec: 1500,
    phaseEndAt: Date.now() + 91_000,
  });

  // 实例不在框架注册表里，tick 应安静退出；修复前这里是 ReferenceError: INSTANCES is not defined。
  assert.doesNotThrow(() => lexTesting.tickPomodoro(instance));

  lexTesting.clearInstanceTimeout(instance, 'pomodoro');
  lexTesting.dropPersistedState(context);
});

test('lex utility: pomowave renders the alert pulse inside the final countdown window', () => {
  const context = 'com.ulanzi.ulanzistudio.lexutility.pomowave___render___pulse';
  const instance = createPomodoroInstance(context, {
    phase: 'focus',
    running: true,
    totalSec: 1500,
    remainingSec: 4,
    phaseEndAt: Date.now() + 4_000,
  });

  // 剩余 4 秒触发 frameHighlight；修复前渲染整键报 ReferenceError 并退化成 ERR 图。
  const icon = lexActionConfigs.pomowave.render(instance);
  assert.match(icon, /^data:image\/svg\+xml;base64,/);
  const svg = Buffer.from(icon.split(',')[1], 'base64').toString('utf8');
  assert.match(svg, /stroke-width="6"/);

  lexTesting.clearInstanceTimeout(instance, 'pomodoro');
  lexTesting.dropPersistedState(context);
});

test('lex utility: pomowave pause freezes remaining and resume rebuilds the deadline', () => {
  const now = Date.now();
  const context = 'com.ulanzi.ulanzistudio.lexutility.pomowave___toggle___t1';
  const instance = createPomodoroInstance(context, {
    phase: 'focus',
    running: true,
    totalSec: 1500,
    remainingSec: 1500,
    phaseEndAt: now + 90_000,
  });

  lexTesting.togglePomodoro(instance, now);
  assert.equal(instance.running, false);
  assert.equal(instance.remainingSec, 90);
  assert.equal(instance.phaseEndAt, null);

  lexTesting.togglePomodoro(instance, now + 5_000);
  assert.equal(instance.running, true);
  assert.equal(instance.phaseEndAt, now + 5_000 + 90_000);

  lexTesting.clearInstanceTimeout(instance, 'pomodoro');
  lexTesting.dropPersistedState(context);
});

test('lex utility: pomowave state round-trips through serialize/hydrate', () => {
  const now = Date.now();
  const raw = lexTesting.serializePomodoroState({
    phase: 'focus',
    running: true,
    remainingSec: 300,
    totalSec: 1500,
    completedFocusRounds: 2,
    phaseEndAt: now + 300_000,
  });

  const hydrated = lexTesting.hydratePomodoroState(raw, now + 60_000);
  assert.equal(hydrated.phase, 'focus');
  assert.equal(hydrated.running, true);
  assert.equal(hydrated.remainingSec, 240);
  assert.equal(hydrated.completedFocusRounds, 2);

  // 重启期间已越过截止点：水合成 0 剩余，交给 onReady 的追平 tick 去推进阶段。
  const overdue = lexTesting.hydratePomodoroState(raw, now + 400_000);
  assert.equal(overdue.remainingSec, 0);
  assert.equal(overdue.running, true);

  // 暂停态按冻结的 remainingSec 恢复，不看时间戳。
  const paused = lexTesting.hydratePomodoroState(
    { ...raw, running: false, phaseEndAt: null, remainingSec: 77 },
    now,
  );
  assert.equal(paused.running, false);
  assert.equal(paused.remainingSec, 77);
  assert.equal(paused.phaseEndAt, null);

  // 垃圾数据不还原：历史是增益，不是前置条件。
  assert.deepEqual(lexTesting.hydratePomodoroState({ v: 99, phase: 'focus' }), {});
  assert.deepEqual(lexTesting.hydratePomodoroState(null), {});
  assert.deepEqual(lexTesting.hydratePomodoroState({ v: 1, phase: 'nope' }), {});
});

test('lex utility: pomowave skip advances silently and counts the focus round', () => {
  const context = 'com.ulanzi.ulanzistudio.lexutility.pomowave___skip___t1';
  const instance = createPomodoroInstance(context, {
    phase: 'focus',
    running: true,
    totalSec: 1500,
    remainingSec: 900,
    phaseEndAt: Date.now() + 900_000,
  });

  lexTesting.skipPomodoroPhase(instance);
  assert.equal(instance.phase, 'shortBreak');
  assert.equal(instance.completedFocusRounds, 1);

  lexTesting.skipPomodoroPhase(instance);
  assert.equal(instance.phase, 'focus');

  lexTesting.clearInstanceTimeout(instance, 'pomodoro');
  lexTesting.dropPersistedState(context);
});

test('lex utility: pomowave idle skip is a no-op', () => {
  const idle = createPomodoroInstance('com.ulanzi.ulanzistudio.lexutility.pomowave___skip___t2');
  lexTesting.skipPomodoroPhase(idle);
  assert.equal(idle.phase, 'idle');
  lexTesting.dropPersistedState(idle.context);
});

test('lex utility: pomowave key art drops the title and shows a tomato only off "done"', () => {
  const config = lexActionConfigs.pomowave;
  const decode = (icon) => Buffer.from(icon.split(',')[1], 'base64').toString('utf8');
  const render = (phase) => decode(config.render({
    settings: { ...config.defaults },
    ...config.createState(),
    phase,
    running: phase !== 'idle',
    remainingSec: 300,
    totalSec: 1500,
  }));

  const focus = render('focus');
  // 标题与被遮挡的底部文字已移除。
  assert.ok(!focus.includes('POMOWAVE'), 'title text must be gone');
  assert.ok(!focus.includes('tap to'), 'footer hint must be gone');
  assert.ok(!focus.includes(' min'), 'settings summary line must be gone');
  // 单色番茄图标出现在运行态键面上。
  assert.ok(focus.includes('translate(128 78)'), 'tomato icon should render on active phases');

  // done 显示大对勾，不画番茄（避免与 ✓ 重叠）。
  const done = render('done');
  assert.ok(done.includes('✓'), 'done shows the check mark');
  assert.ok(!done.includes('translate(128 78)'), 'done must not draw the tomato');
});

test('lex utility: pomowave short press toggles and long press restarts the focus', () => {
  const t0 = Date.now();
  const context = 'com.ulanzi.ulanzistudio.lexutility.pomowave___tap___t1';
  const instance = createPomodoroInstance(context, {
    phase: 'focus',
    running: true,
    totalSec: 1500,
    remainingSec: 300,
    completedFocusRounds: 2,
    phaseEndAt: t0 + 300_000,
  });

  lexTesting.handlePomodoroShortPress(instance, { now: t0 });
  assert.equal(instance.running, false);
  assert.equal(instance.remainingSec, 300);

  const t1 = t0 + 600;
  lexTesting.handlePomodoroLongPress(instance, { now: t1 });
  assert.equal(instance.phase, 'focus');
  assert.equal(instance.running, true);
  assert.equal(instance.remainingSec, 1500);
  assert.equal(instance.totalSec, 1500);
  assert.equal(instance.completedFocusRounds, 2);
  assert.equal(instance.phaseEndAt, t1 + 1500 * 1000);

  lexTesting.handlePomodoroShortPress(instance, { now: t1 + 10 });
  assert.equal(instance.running, false);

  lexTesting.clearInstanceTimeout(instance, 'pomodoro');
  lexTesting.dropPersistedState(context);
});

function manualStartInstance(context, overrides = {}) {
  const config = lexActionConfigs.pomowave;
  return createPomodoroInstance(context, {
    settings: { ...config.defaults, soundEnabled: 'false', autoStartBreaks: 'false', autoStartFocus: 'false' },
    ...overrides,
  });
}

test('lex utility: pomowave focus end enters an awaiting break when auto-break is off', () => {
  const context = 'com.ulanzi.ulanzistudio.lexutility.pomowave___await___t1';
  const instance = manualStartInstance(context, {
    phase: 'focus',
    running: true,
    totalSec: 1500,
    remainingSec: 1,
    completedFocusRounds: 0,
    phaseEndAt: Date.now() - 2000,
  });
  const instances = new Map([[context, instance]]);

  lexTesting.tickPomodoro(instance, { instances, now: Date.now() });
  assert.equal(instance.phase, 'shortBreak');
  assert.equal(instance.awaiting, true, 'awaiting break, not auto-started');
  assert.equal(instance.running, false);
  assert.equal(instance.completedFocusRounds, 1, 'the finished focus still counts');

  lexTesting.clearInstanceTimeout(instance, 'pomodoro');
  lexTesting.dropPersistedState(context);
});

test('lex utility: pomowave short break end awaits the next focus when auto-focus is off', () => {
  const context = 'com.ulanzi.ulanzistudio.lexutility.pomowave___await___t2';
  const instance = manualStartInstance(context, {
    phase: 'shortBreak',
    running: true,
    totalSec: 300,
    remainingSec: 1,
    phaseEndAt: Date.now() - 2000,
  });
  const instances = new Map([[context, instance]]);

  lexTesting.tickPomodoro(instance, { instances, now: Date.now() });
  assert.equal(instance.phase, 'focus');
  assert.equal(instance.awaiting, true);
  assert.equal(instance.running, false);

  lexTesting.clearInstanceTimeout(instance, 'pomodoro');
  lexTesting.dropPersistedState(context);
});

test('lex utility: pomowave awaiting short press confirms and starts the phase', () => {
  const context = 'com.ulanzi.ulanzistudio.lexutility.pomowave___await___t3';
  const now = Date.now();
  const instance = manualStartInstance(context, {
    phase: 'shortBreak',
    awaiting: true,
    running: false,
    totalSec: 300,
    remainingSec: 300,
  });
  let cueKilled = false;
  instance.cueRepeating = true;
  instance.cueProcess = {
    killed: false,
    kill() {
      cueKilled = true;
      this.killed = true;
    },
  };

  lexTesting.handlePomodoroShortPress(instance, { now });
  assert.equal(instance.awaiting, false);
  assert.equal(instance.running, true);
  assert.equal(instance.phase, 'shortBreak');
  assert.equal(instance.phaseEndAt, now + 300_000);
  assert.equal(instance.cueRepeating, false);
  assert.equal(cueKilled, true, 'starting the awaited phase stops the repeating cue');

  lexTesting.clearInstanceTimeout(instance, 'pomodoro');
  lexTesting.dropPersistedState(context);
});

test('lex utility: pomowave long press while awaiting a break skips to a fresh focus', () => {
  const context = 'com.ulanzi.ulanzistudio.lexutility.pomowave___await___t4';
  const t0 = Date.now();
  const instance = manualStartInstance(context, {
    phase: 'shortBreak',
    awaiting: true,
    running: false,
    totalSec: 300,
    remainingSec: 300,
    completedFocusRounds: 2,
  });

  lexTesting.handlePomodoroLongPress(instance, { now: t0 + 600 });
  assert.equal(instance.phase, 'focus');
  assert.equal(instance.running, true);
  assert.equal(instance.awaiting, false);
  assert.equal(instance.completedFocusRounds, 2, 'rounds preserved through the skip');

  lexTesting.clearInstanceTimeout(instance, 'pomodoro');
  lexTesting.dropPersistedState(context);
});

test('lex utility: pomowave ring fills clockwise with elapsed time and blinks while awaiting', () => {
  const config = lexActionConfigs.pomowave;
  const decode = (icon) => Buffer.from(icon.split(',')[1], 'base64').toString('utf8');
  const circ = 2 * Math.PI * 79;

  const mk = (over) => ({ settings: { ...config.defaults }, ...config.createState(), ...over });

  // 已用一半：填充弧 dasharray 的可见段约为周长的一半，且带 rotate(-90) 顺时针铺开。
  const half = decode(config.render(mk({ phase: 'focus', running: true, totalSec: 1000, remainingSec: 500 })));
  assert.ok(half.includes('rotate(-90 128 128)'), 'progress ring keeps the clockwise transform');
  const m = half.match(/stroke-dasharray="([\d.]+) /);
  assert.ok(m, 'fill arc uses a two-value dasharray');
  assert.ok(Math.abs(Number(m[1]) - circ / 2) < 2, `visible arc ~ half circumference, got ${m[1]}`);

  // 刚开始（elapsed≈0）几乎不可见——填充从空环起步。
  const start = decode(config.render(mk({ phase: 'focus', running: true, totalSec: 1000, remainingSec: 1000 })));
  const ms = start.match(/stroke-dasharray="([\d.]+) /);
  assert.ok(Number(ms[1]) < 1, 'empty ring at the start of a phase');

  // 待命闪烁：亮帧不透明、灭帧低透明，且不画填充弧（无 rotate transform）。
  const blinkOn = decode(config.render(mk({ phase: 'shortBreak', awaiting: true, blinkOn: true, totalSec: 300, remainingSec: 300 })));
  const blinkOff = decode(config.render(mk({ phase: 'shortBreak', awaiting: true, blinkOn: false, totalSec: 300, remainingSec: 300 })));
  assert.ok(blinkOn.includes('opacity="1"'), 'bright blink frame');
  assert.ok(blinkOff.includes('opacity="0.16"'), 'dim blink frame');
  assert.ok(!blinkOn.includes('rotate(-90 128 128)'), 'awaiting draws a full ring, not a fill arc');
});

test('lex utility: pomowave cue plan honours preview override and enabled toggle', () => {
  const plan = lexTesting.pomodoroCuePlan;

  // 试听：ignoreEnabled 无视关闭开关，且用点选样式而非已存样式。
  assert.equal(plan({ soundEnabled: 'false', soundStyle: 'glass' }, { style: 'hero', ignoreEnabled: true }), 'hero');
  // 非法样式回退到 glass，绝不把脏值塞给播放器。
  assert.equal(plan({ soundEnabled: 'true', soundStyle: 'glass' }, { style: 'bogus', ignoreEnabled: true }), 'glass');
  // 阶段提示音（无 ignoreEnabled）：开关关闭时返回 null，不发声。
  assert.equal(plan({ soundEnabled: 'false', soundStyle: 'purr' }), null);
  // 开关开启时按 settings.soundStyle 发声。
  assert.equal(plan({ soundEnabled: 'true', soundStyle: 'purr' }), 'purr');
});

test('lex utility: pomowave repeats cues only while awaiting manual phase start', () => {
  const shouldRepeat = lexTesting.shouldRepeatPomodoroCue;

  assert.equal(shouldRepeat({ repeatManualCue: 'true' }, { autoStart: false }), true);
  assert.equal(shouldRepeat({ repeatManualCue: 'false' }, { autoStart: false }), false);
  assert.equal(shouldRepeat({ repeatManualCue: 'true' }, { autoStart: true }), false);
});

// 既有 commit 用例要么显式传 instances、要么以 feedbackCompleted:false 短路，
// 默认参数 `instances = INSTANCES` 那条路径从没被走过——而拆分时它一度被写成
// `instances = instances`（自引用默认值），真机每次定时检查都 TDZ 崩在这里。
test('lex utility: latency commit falls back to the runtime registry without an instance map', () => {
  const instance = {
    context: 'com.ulanzi.ulanzistudio.lexutility.latency___commit___fallback',
    requestId: 1,
    recent: [],
    buckets: [],
    status: 'checking',
    checking: true,
    settings: { warnMs: '800' },
  };

  let committed;
  assert.doesNotThrow(() => {
    committed = frameworkLatencyCommit(instance, { ok: true, ms: 25, code: 200 }, {
      requestId: 1,
      flush: () => {},
      render: () => {},
      schedule: () => {},
    });
  });

  // 实例不在框架注册表里，提交应被判定为过期而安静丢弃
  assert.equal(committed, false);
  assert.equal(instance.status, 'checking');
});

test('lex utility: cancelled latency feedback cannot commit stale result', async () => {
  const instance = {
    context: 'latency-context',
    requestId: 4,
    recent: [],
    buckets: [],
    status: 'checking',
    checking: true,
    settings: { warnMs: '800' },
  };
  const renders = [];
  const schedules = [];
  const delayed = delayLexInstance(instance, 'latencyFeedback', 10_000);

  clearLexTimeout(instance, 'latencyFeedback');
  const feedbackCompleted = await delayed;
  const committed = frameworkLatencyCommit(instance, { ok: true, ms: 25, code: 200 }, {
    requestId: 4,
    feedbackCompleted,
    instances: new Map([[instance.context, instance]]),
    render: () => renders.push('render'),
    schedule: () => schedules.push('schedule'),
    flush: () => {},
  });

  assert.equal(feedbackCompleted, false);
  assert.equal(committed, false);
  assert.deepEqual(instance.recent, []);
  assert.deepEqual(instance.buckets, []);
  assert.equal(instance.status, 'checking');
  assert.equal(instance.checking, true);
  assert.deepEqual(renders, []);
  assert.deepEqual(schedules, []);
});

// ---- latency：聚合桶、uptime 诚实性、重定向与长按 ----

const LATENCY_BUCKET_MS = 5 * 60 * 1000;
const latencyInstance = (overrides = {}) => ({
  context: 'latency-context',
  buckets: [],
  recent: [],
  ...overrides,
});

test('lex utility: latency samples fold into 5-minute buckets and roll over on the boundary', () => {
  const t0 = 1_700_000_000_000;
  const instance = latencyInstance();

  assert.equal(lexTesting.recordLatencySample(instance, { ok: true, ms: 40 }, t0), true, 'first sample opens a bucket');
  assert.equal(lexTesting.recordLatencySample(instance, { ok: true, ms: 60 }, t0 + 30_000), false, 'same bucket does not roll');
  assert.equal(instance.buckets.length, 1);
  assert.equal(instance.buckets[0].ok, 2);

  assert.equal(
    lexTesting.recordLatencySample(instance, { ok: false, ms: 0 }, t0 + LATENCY_BUCKET_MS),
    true,
    'crossing the boundary rolls a new bucket',
  );
  assert.equal(instance.buckets.length, 2);
  assert.equal(instance.buckets[1].fail, 1);
});

test('lex utility: uptime denominator counts only observed checks, and the span reports what was observed', () => {
  const t0 = 1_700_000_000_000;
  const instance = latencyInstance();
  // 两个相邻桶共 4 次探测、1 次失败。中间没有「宿主关着」的桶，因为那段根本没被观测到。
  lexTesting.recordLatencySample(instance, { ok: true, ms: 40 }, t0);
  lexTesting.recordLatencySample(instance, { ok: true, ms: 40 }, t0 + 30_000);
  lexTesting.recordLatencySample(instance, { ok: false, ms: 0 }, t0 + LATENCY_BUCKET_MS);
  lexTesting.recordLatencySample(instance, { ok: true, ms: 40 }, t0 + LATENCY_BUCKET_MS + 30_000);

  const stats = lexTesting.latencyStats(instance, t0 + LATENCY_BUCKET_MS + 60_000);
  assert.equal(stats.checks, 4);
  assert.equal(stats.uptime, 75);
  assert.equal(stats.observedMs, 2 * LATENCY_BUCKET_MS, 'span reflects buckets that actually hold data');
  assert.equal(lexTesting.formatUptimeLabel(stats), '10m 75.0%');
});

test('lex utility: a long host outage between sessions does not inflate the observed span', () => {
  const t0 = 1_700_000_000_000;
  const instance = latencyInstance();
  lexTesting.recordLatencySample(instance, { ok: true, ms: 40 }, t0);
  // 隔了 8 小时才有下一次探测：中间没有桶，观测时长只能是 10 分钟，不能是 8 小时。
  const later = t0 + 8 * 3_600_000;
  lexTesting.recordLatencySample(instance, { ok: true, ms: 40 }, later);

  const stats = lexTesting.latencyStats(instance, later);
  assert.equal(stats.observedMs, 2 * LATENCY_BUCKET_MS);
  assert.equal(lexTesting.formatUptimeLabel(stats), '10m 100%');
});

test('lex utility: buckets older than the 24h window fall out', () => {
  const now = 1_700_000_000_000;
  const instance = latencyInstance();
  lexTesting.recordLatencySample(instance, { ok: false, ms: 0 }, now - 25 * 3_600_000);
  lexTesting.recordLatencySample(instance, { ok: true, ms: 40 }, now);

  const stats = lexTesting.latencyStats(instance, now);
  assert.equal(stats.checks, 1, 'the 25h-old failure must not drag uptime down forever');
  assert.equal(stats.uptime, 100);
});

test('lex utility: uptime never rounds a real failure up to 100%', () => {
  const now = 1_700_000_000_000;
  const instance = latencyInstance();
  for (let i = 0; i < 1999; i += 1) {
    lexTesting.recordLatencySample(instance, { ok: true, ms: 40 }, now - i * 1000);
  }
  lexTesting.recordLatencySample(instance, { ok: false, ms: 0 }, now);

  const stats = lexTesting.latencyStats(instance, now);
  assert.ok(stats.uptime > 99.9 && stats.uptime < 100);
  assert.ok(
    lexTesting.formatUptimeLabel(stats).includes('99.9%'),
    'a 99.95% uptime must not be displayed as 100%',
  );
});

test('lex utility: p95 comes from the binned distribution and leans high, never optimistic', () => {
  const now = 1_700_000_000_000;
  const instance = latencyInstance();
  for (let i = 0; i < 95; i += 1) {
    lexTesting.recordLatencySample(instance, { ok: true, ms: 40 }, now);
  }
  for (let i = 0; i < 5; i += 1) {
    lexTesting.recordLatencySample(instance, { ok: true, ms: 1500 }, now);
  }
  const stats = lexTesting.latencyStats(instance, now);
  assert.ok(stats.p95 >= 40, 'p95 must not under-report');
  assert.equal(stats.p95, 50, 'the 95th sample sits in the 25-50ms bin, reported at its upper edge');
});

test('lex utility: latency state survives a restart and drops a corrupt or foreign payload', () => {
  const now = 1_700_000_000_000;
  const instance = latencyInstance({ paused: true, certExpiresAt: now + 86_400_000 });
  lexTesting.recordLatencySample(instance, { ok: true, ms: 40 }, now);

  const round = lexTesting.hydrateLatencyState(
    JSON.parse(JSON.stringify({
      v: 1,
      paused: instance.paused,
      buckets: instance.buckets,
      recent: instance.recent,
      certExpiresAt: instance.certExpiresAt,
    })),
    now,
  );
  assert.equal(round.paused, true);
  assert.equal(round.buckets.length, 1);
  assert.equal(round.certExpiresAt, now + 86_400_000);

  for (const bad of [null, undefined, {}, { v: 99, buckets: [{ t: now }] }, { v: 1, buckets: 'nope' }]) {
    const fallback = lexTesting.hydrateLatencyState(bad, now);
    assert.deepEqual(fallback.buckets, [], 'unusable history degrades to empty rather than throwing');
    assert.equal(fallback.paused, false);
  }
});

test('lex utility: ssl countdown only starts inside the warning window', () => {
  const now = 1_700_000_000_000;
  assert.equal(lexTesting.sslDaysLeft(null, now), null);
  assert.equal(lexTesting.sslDaysLeft(now + 40 * 86_400_000, now), 40);
  assert.equal(lexTesting.sslDaysLeft(now + 12 * 86_400_000, now), 12);
  assert.equal(lexTesting.sslDaysLeft(now - 86_400_000, now), -1, 'an expired cert reports negative days');
});

test('lex utility: latency renders ssl as a dot when healthy and as a countdown near expiry', () => {
  const decode = (icon) => Buffer.from(icon.split(',')[1], 'base64').toString('utf8');
  const render = lexActionConfigs.latency.render;
  const base = {
    settings: { ...lexActionConfigs.latency.defaults },
    recent: [{ t: Date.now(), ok: true, ms: 42 }],
    buckets: [],
    lastMs: 42,
    status: 'up',
    checking: false,
    requestId: 1,
  };

  const healthy = decode(render({ ...base, certExpiresAt: Date.now() + 90 * 86_400_000 }));
  assert.ok(healthy.includes('#22c55e'), 'a healthy cert shows the green dot');
  assert.ok(healthy.includes('>SSL<'), 'the dot is labeled SSL so it explains itself');
  assert.ok(!healthy.includes('SSL '), 'a healthy cert shows no countdown');

  // 加 1 小时余量：天数取 floor，正好压在 12.0 天边界上会因为渲染晚了 1ms 就掉成 11d。
  const expiring = decode(render({ ...base, certExpiresAt: Date.now() + 12 * 86_400_000 + 3_600_000 }));
  assert.ok(expiring.includes('SSL 12d'), 'inside 30 days the countdown takes the slot');

  const none = decode(render({ ...base, certExpiresAt: null }));
  assert.ok(!none.includes('SSL'), 'a plain-http target shows no ssl badge at all');

  // 阈值可配：同一张 45 天证书，阈值 90 已在提醒期、阈值 10 则还早。
  const cert45d = Date.now() + 45 * 86_400_000 + 3_600_000;
  const early = decode(render({
    ...base,
    certExpiresAt: cert45d,
    settings: { ...base.settings, sslWarnDays: '90' },
  }));
  assert.ok(early.includes('SSL 45d'), 'raising sslWarnDays starts the countdown sooner');
  const late = decode(render({
    ...base,
    certExpiresAt: cert45d,
    settings: { ...base.settings, sslWarnDays: '10' },
  }));
  assert.ok(late.includes('>SSL<'), 'lowering sslWarnDays keeps the green dot longer');
  assert.ok(!late.includes('SSL 45d'), 'no countdown outside the configured window');
});

test('lex utility: latency shows Pause instead of a stale number while paused', () => {
  const decode = (icon) => Buffer.from(icon.split(',')[1], 'base64').toString('utf8');
  const svg = decode(lexActionConfigs.latency.render({
    settings: { ...lexActionConfigs.latency.defaults },
    recent: [{ t: Date.now(), ok: true, ms: 42 }],
    buckets: [],
    lastMs: 42,
    status: 'up',
    paused: true,
    checking: false,
    requestId: 1,
  }));
  assert.ok(svg.includes('Pause'));
  assert.ok(!svg.includes('>42<'), 'a paused button must not keep showing the last latency as if it were live');
});

test('lex utility: a short press refreshes immediately', () => {
  const runs = [];
  const instance = latencyInstance({ requestId: 0, paused: false });
  lexTesting.handleLatencyShortPress(instance, {
    run: (_i, opts) => { runs.push(opts); },
    render: () => {},
    flush: () => {},
  });
  assert.equal(runs.length, 1, 'the refresh fires on the first tap, not after a 400ms delay');
  assert.equal(instance.paused, false);
});

test('lex utility: a long press cancels an in-flight refresh and enters Pause', () => {
  const runs = [];
  const flushes = [];
  const instance = latencyInstance({ requestId: 0, paused: false, checking: true });
  const opts = {
    run: (_i, o) => { runs.push(o); },
    render: () => {},
    flush: (i) => { flushes.push(i.paused); },
  };
  lexTesting.handleLatencyLongPress(instance, opts);

  assert.equal(runs.length, 0, 'entering Pause must not fire another probe');
  assert.equal(instance.paused, true);
  assert.equal(instance.status, 'paused');
  assert.equal(instance.checking, false);
  assert.equal(instance.requestId, 1, 'bumping requestId is what invalidates the in-flight refresh');
  assert.deepEqual(flushes, [true], 'pause is user intent and must reach disk immediately');
});

test('lex utility: short pressing a paused button refreshes and resumes', () => {
  const runs = [];
  const instance = latencyInstance({ requestId: 0, paused: true, status: 'paused' });
  lexTesting.handleLatencyShortPress(instance, {
    run: (_i, o) => { runs.push(o); },
    render: () => {},
    flush: () => {},
  });
  assert.equal(instance.paused, false);
  assert.equal(runs.length, 1);
});

test('lex utility: long pressing a paused button resumes and probes immediately', () => {
  const runs = [];
  const flushes = [];
  const instance = latencyInstance({ requestId: 2, paused: true, status: 'paused' });
  lexTesting.handleLatencyLongPress(instance, {
    run: (_i, options) => { runs.push(options); },
    render: () => {},
    flush: (current) => { flushes.push(current.paused); },
  });
  assert.equal(instance.paused, false);
  assert.equal(instance.requestId, 3);
  assert.equal(runs.length, 1);
  assert.deepEqual(flushes, [false]);
});

test('lex utility: repeated short presses are independent refreshes', () => {
  const runs = [];
  const instance = latencyInstance({ requestId: 0, paused: false });
  const opts = { run: () => { runs.push(1); }, render: () => {}, flush: () => {} };
  lexTesting.handleLatencyShortPress(instance, opts);
  lexTesting.handleLatencyShortPress(instance, opts);
  assert.equal(runs.length, 2);
  assert.equal(instance.paused, false, 'slow repeated taps must never silently pause monitoring');
});

test('lex utility: checkUrl follows redirects to the final status and keeps the first hop latency', async () => {
  const hops = [];
  const result = await lexTesting.checkUrl('https://example.com', 8000, {
    requestHop: (url) => {
      hops.push(url.href);
      if (hops.length === 1) {
        return Promise.resolve({ ms: 120, code: 301, location: 'https://www.example.com/', cert: 1234 });
      }
      return Promise.resolve({ ms: 900, code: 200, location: '', cert: 5678 });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, 200);
  assert.equal(result.ms, 120, 'latency stays the first hop so it does not drift with chain length');
  assert.equal(result.cert, 1234, 'the cert reported is the configured host, not the redirect target');
  assert.deepEqual(hops, ['https://example.com/', 'https://www.example.com/']);
});

test('lex utility: a redirect to a dead final destination reports down, not up', async () => {
  const result = await lexTesting.checkUrl('https://example.com', 8000, {
    requestHop: (url) => (url.href === 'https://example.com/'
      ? Promise.resolve({ ms: 100, code: 301, location: 'https://squatter.example/', cert: null })
      : Promise.resolve({ ms: 100, code: 404, location: '', cert: null })),
  });
  assert.equal(result.ok, false, 'a 301 into a 404 must not be reported as a healthy site');
  assert.equal(result.code, 404);
});

test('lex utility: redirect loops terminate instead of hanging', async () => {
  let calls = 0;
  const result = await lexTesting.checkUrl('https://example.com', 8000, {
    requestHop: () => {
      calls += 1;
      return Promise.resolve({ ms: 10, code: 302, location: 'https://example.com/loop', cert: null });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'too_many_redirects');
  assert.equal(calls, 4, 'the initial hop plus at most 3 redirects');
});

test('lex utility: a bad url never throws out of the probe', async () => {
  const result = await lexTesting.checkUrl('http://', 8000, { requestHop: () => Promise.resolve({ ms: 0, code: 200 }) });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'bad_url');
});

// ---- 共享层：运行态持久化与 onDispose，两份框架必须行为一致（规则 §9 回流门槛）----

const persistenceFrameworks = [
  {
    name: 'lex utility',
    t: lexTesting,
    configs: lexActionConfigs,
    configKey: 'latency',
    actionUuid: 'com.ulanzi.ulanzistudio.lexutility.latency',
    context: 'com.ulanzi.ulanzistudio.lexutility.latency___key-1___action-1',
  },
  {
    name: 'template',
    t: templateTesting,
    configs: templateActionConfigs,
    configKey: 'counter',
    actionUuid: '__PLUGIN_UUID__.counter',
    context: '__PLUGIN_UUID__.counter___key-1___action-1',
  },
];

for (const framework of persistenceFrameworks) {
  test(`${framework.name}: runtime state round-trips through its own store, separate from settings`, () => {
    const store = {};
    const written = [];
    const storage = { write: (data) => { written.push(data); return true; } };
    const options = { store, storage };

    assert.deepEqual(framework.t.readPersistedState(framework.context, options), {}, 'missing state reads as empty');

    framework.t.writePersistedState(framework.context, { buckets: [1, 2], paused: true }, options);
    assert.deepEqual(framework.t.readPersistedState(framework.context, options), { buckets: [1, 2], paused: true });
    assert.equal(written.length, 1);
    assert.deepEqual(Object.keys(store), ['action-1::key-1'], 'state is archived under actionid::key like settings');

    framework.t.dropPersistedState(framework.context, options);
    assert.deepEqual(framework.t.readPersistedState(framework.context, options), {});
  });

  test(`${framework.name}: a failed state write leaves the in-memory store untouched`, () => {
    const store = {};
    const storage = { write: () => false };
    const ok = framework.t.writePersistedState(framework.context, { buckets: [1] }, { store, storage });
    assert.equal(ok, false);
    assert.deepEqual(store, {}, 'a rejected write must not pretend it landed');
  });

  test(`${framework.name}: non-object persisted state degrades to empty instead of poisoning the action`, () => {
    for (const bad of ['string', 42, null, ['array']]) {
      const store = { 'action-1::key-1': bad };
      assert.deepEqual(framework.t.readPersistedState(framework.context, { store }), {});
    }
  });

  test(`${framework.name}: onDispose runs before timers are reclaimed`, async () => {
    const config = framework.configs[framework.configKey];
    const events = [];
    const instance = { context: framework.context, actionUuid: framework.actionUuid };
    const pending = framework.t.delayInstance(instance, 'slot', 10_000);

    config.onDispose = (received) => {
      // 此刻定时器还在：onDispose 必须能看到未回收的运行态，否则 flush 拿不到东西。
      events.push(['dispose', received.timers.size]);
    };
    try {
      framework.t.disposeInstance(instance);
    } finally {
      delete config.onDispose;
    }

    assert.deepEqual(events, [['dispose', 1]]);
    assert.equal(await pending, false, 'timers are still settled after the hook runs');
    assert.equal(instance.timers.size, 0);
  });

  test(`${framework.name}: a throwing onDispose still cannot leak timers`, async () => {
    const config = framework.configs[framework.configKey];
    const instance = { context: framework.context, actionUuid: framework.actionUuid };
    const pending = framework.t.delayInstance(instance, 'slot', 10_000);
    const originalConsoleLog = console.log;

    config.onDispose = () => { throw new Error('flush exploded'); };
    try {
      console.log = () => {};
      framework.t.disposeInstance(instance);
    } finally {
      console.log = originalConsoleLog;
      delete config.onDispose;
    }

    assert.equal(await pending, false);
    assert.equal(instance.timers.size, 0);
    assert.equal(instance.lastError?.phase, 'dispose');
  });

  test(`${framework.name}: disposing an instance with an unknown action does not dispatch a foreign hook`, () => {
    const config = framework.configs[framework.configKey];
    let called = false;
    config.onDispose = () => { called = true; };
    try {
      // 未知 UUID 不能把任一已注册 action 的钩子派发给一个不属于它的实例。
      framework.t.disposeInstance({ context: 'x', actionUuid: 'totally-unknown' });
    } finally {
      delete config.onDispose;
    }
    assert.equal(called, false);
  });
}
