import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const INSPECTOR_DIR = path.join(
  ROOT,
  'plugins/com.ulanzi.lexutility.ulanziPlugin/property-inspector',
);

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event) {
    event.target ||= this;
    event.preventDefault ||= () => {};
    for (const listener of this.listeners.get(event.type) || []) {
      listener.call(this, event);
    }
  }

  listenerCount(type) {
    return (this.listeners.get(type) || []).length;
  }
}

class FakeElement extends FakeEventTarget {
  constructor({ id = '', value = '', type = 'text', dataset = {} } = {}) {
    super();
    this.id = id;
    this.value = value;
    this.type = type;
    this.checked = false;
    this.dataset = dataset;
    this.attributes = new Map();
    this.style = {};
    this.children = [];
    this.classList = {
      toggle: () => {},
      remove: () => {},
    };
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  // 节点清单是唯一走 innerHTML 的地方，这里只存字符串供断言，不做解析。
  set innerHTML(html) {
    this._innerHTML = String(html);
  }

  get innerHTML() {
    return this._innerHTML || '';
  }
}

function createHarness(entryFile) {
  const window = new FakeEventTarget();
  const form = new FakeElement({ id: 'property-inspector' });
  const wrapper = new FakeElement();
  const elements = new Map([
    ['property-inspector', form],
    ['theme', new FakeElement({ id: 'theme', value: 'mint' })],
    ['title', new FakeElement({ id: 'title', value: 'latest' })],
    ['frameSize', new FakeElement({ id: 'frameSize', type: 'checkbox', dataset: { on: 'optimal', off: 'max' } })],
    ['showFrame', new FakeElement({ id: 'showFrame', type: 'checkbox' })],
    ['graphMode', new FakeElement({ id: 'graphMode', value: 'bars' })],
    ['soundStyle', new FakeElement({ id: 'soundStyle', value: 'glass' })],
    ['resetTimer', new FakeElement({ id: 'resetTimer' })],
  ]);
  const selectors = new Map();

  if (entryFile === 'latency.js') {
    selectors.set('[data-graph-mode]', [
      new FakeElement({ dataset: { graphMode: 'line' } }),
    ]);
  }
  if (entryFile === 'pomowave.js') {
    selectors.set('[data-sound-style]', [
      new FakeElement({ dataset: { soundStyle: 'bell' } }),
    ]);
  }
  if (entryFile === 'speedtest.js') {
    selectors.set('[data-chart-type]', [
      new FakeElement({ dataset: { chartType: 'bar' } }),
    ]);
  }
  selectors.set('[data-theme-value]', []);

  const themeRow = new FakeElement();
  const document = {
    getElementById: (id) => {
      if (!elements.has(id)) {
        elements.set(id, new FakeElement({ id, value: '' }));
      }
      return elements.get(id);
    },
    createElement: () => new FakeElement({}),
    querySelector: (selector) =>
      selector === '.uspi-wrapper' ? wrapper : selector === '.theme-row' ? themeRow : null,
    querySelectorAll: (selector) => selectors.get(selector) || [],
  };

  let nextTimerId = 1;
  const timers = new Map();
  let scheduledTimerCount = 0;
  const setTimeout = (callback) => {
    const id = nextTimerId++;
    scheduledTimerCount += 1;
    timers.set(id, callback);
    return id;
  };
  const clearTimeout = (id) => timers.delete(id);
  const runTimers = () => {
    const callbacks = [...timers.values()];
    timers.clear();
    callbacks.forEach((callback) => callback());
  };

  const callbacks = { connected: [], add: [], app: [], plugin: [] };
  const sends = [];
  const $UD = {
    connect: () => {},
    onConnected: (callback) => callbacks.connected.push(callback),
    onAdd: (callback) => callbacks.add.push(callback),
    onParamFromApp: (callback) => callbacks.app.push(callback),
    onParamFromPlugin: (callback) => callbacks.plugin.push(callback),
    sendParamFromPlugin: (settings, context) => sends.push({ settings, context }),
  };

  const context = vm.createContext({
    console,
    document,
    window,
    $UD,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(
    fs.readFileSync(path.join(INSPECTOR_DIR, 'inspector-shared.js'), 'utf8'),
    context,
    { filename: 'inspector-shared.js' },
  );
  if (entryFile) {
    vm.runInContext(
      fs.readFileSync(path.join(INSPECTOR_DIR, entryFile), 'utf8'),
      context,
      { filename: entryFile },
    );
  } else {
    vm.runInContext("initInspector('test.action', ['title', 'theme', 'frameSize'])", context);
  }

  callbacks.add.forEach((callback) => callback({ context: 'ctx-1', param: {} }));

  return {
    callbacks,
    elements,
    form,
    runTimers,
    selectors,
    sends,
    themeRow,
    timerCount: () => timers.size,
    scheduledTimerCount: () => scheduledTimerCount,
    window,
  };
}

test('shared inspector binds input and exit lifecycle only once across reconnects', () => {
  const harness = createHarness();
  harness.callbacks.connected[0]();
  harness.callbacks.connected[0]();

  harness.form.dispatchEvent({ type: 'input' });
  harness.runTimers();

  assert.equal(harness.form.listenerCount('input'), 1);
  assert.equal(harness.window.listenerCount('pagehide'), 1);
  assert.equal(harness.scheduledTimerCount(), 1);
  assert.equal(harness.sends.filter(({ settings }) => !settings.__requestSettings).length, 1);
});

test('pagehide flushes the latest pending input once and clears its timer', () => {
  const harness = createHarness();
  harness.callbacks.connected[0]();
  harness.form.dispatchEvent({ type: 'input' });

  harness.elements.get('title').value = 'tail value';
  harness.window.dispatchEvent({ type: 'pagehide' });

  assert.equal(harness.sends.length, 2);
  assert.equal(harness.sends.at(-1).settings.title, 'tail value');
  assert.equal(harness.timerCount(), 0);

  harness.runTimers();
  assert.equal(harness.sends.length, 2);
});

test('pagehide without pending input does not send settings', () => {
  const harness = createHarness();
  harness.callbacks.connected[0]();

  harness.window.dispatchEvent({ type: 'pagehide' });

  assert.equal(harness.sends.length, 1);
  assert.equal(harness.sends[0].settings.__requestSettings, 'true');
  assert.equal(harness.timerCount(), 0);
});

test('theme chips render from shared swatches and clicking one commits the theme', () => {
  const harness = createHarness();
  harness.callbacks.connected[0]();

  const chips = harness.themeRow.children;
  assert.ok(chips.length >= 9, `expected at least 9 theme chips, got ${chips.length}`);
  const neon = chips.find((chip) => chip.dataset.themeValue === 'neon');
  assert.ok(neon, 'neon chip should exist');
  assert.ok(String(neon.children[0].style.background).includes('#e879f9'));

  neon.dispatchEvent({ type: 'click' });

  assert.equal(harness.elements.get('theme').value, 'neon');
  assert.equal(harness.sends.length, 2);
  assert.equal(harness.sends.at(-1).settings.theme, 'neon');
});

test('mapped checkbox collects data-on/off values and applies back from settings', () => {
  const harness = createHarness();
  harness.callbacks.connected[0]();
  const frameSize = harness.elements.get('frameSize');

  frameSize.checked = true;
  harness.form.dispatchEvent({ type: 'submit' });
  assert.equal(harness.sends.at(-1).settings.frameSize, 'optimal');

  frameSize.checked = false;
  harness.form.dispatchEvent({ type: 'submit' });
  assert.equal(harness.sends.at(-1).settings.frameSize, 'max');

  harness.callbacks.add.forEach((callback) => callback({ context: 'ctx-1', param: { frameSize: 'optimal' } }));
  assert.equal(frameSize.checked, true);
  harness.callbacks.add.forEach((callback) => callback({ context: 'ctx-1', param: { frameSize: 'max' } }));
  assert.equal(frameSize.checked, false);
});

test('reset defaults button cancels pending autosave and sends only the reset control', () => {
  const harness = createHarness();
  harness.callbacks.connected[0]();
  harness.form.dispatchEvent({ type: 'input' });

  harness.elements.get('resetDefaults').dispatchEvent({ type: 'click' });
  harness.runTimers();

  assert.deepEqual(
    harness.sends.map(({ settings }) => JSON.parse(JSON.stringify(settings))),
    [{ __requestSettings: 'true' }, { __resetDefaults: 'true' }],
  );
  assert.equal(harness.sends.at(-1).context, 'ctx-1');
});

test('save and reset defaults flash distinct feedback that auto-hides', () => {
  const harness = createHarness();
  harness.callbacks.connected[0]();

  harness.form.dispatchEvent({ type: 'submit' });
  const container = harness.elements.get('inspector-feedback');
  assert.equal(container.hidden, false);
  assert.equal(harness.elements.get('feedback-saved').hidden, false);
  assert.equal(harness.elements.get('feedback-reset').hidden, true);

  harness.elements.get('resetDefaults').dispatchEvent({ type: 'click' });
  assert.equal(container.hidden, false);
  assert.equal(harness.elements.get('feedback-saved').hidden, true);
  assert.equal(harness.elements.get('feedback-reset').hidden, false);

  harness.runTimers();
  assert.equal(container.hidden, true);
});

test('pomowave reset defaults sends the framework control param once', () => {
  const harness = createHarness('pomowave.js');
  harness.callbacks.connected[0]();

  harness.elements.get('resetDefaults').dispatchEvent({ type: 'click' });

  assert.deepEqual(
    harness.sends.map(({ settings }) => JSON.parse(JSON.stringify(settings))),
    [{ __resetDefaults: 'true' }],
  );
});

test('latency mode button sends once after reconnect', () => {
  const harness = createHarness('latency.js');
  harness.callbacks.connected[0]();
  harness.callbacks.connected[0]();

  harness.selectors.get('[data-graph-mode]')[0].dispatchEvent({ type: 'click' });

  assert.equal(harness.sends.length, 1);
  assert.equal(harness.sends[0].settings.graphMode, 'line');
});

test('pomowave reset sends once after reconnect without an extra settings send', () => {
  const harness = createHarness('pomowave.js');
  harness.callbacks.connected[0]();
  harness.callbacks.connected[0]();

  harness.elements.get('resetTimer').dispatchEvent({ type: 'click' });

  assert.deepEqual(
    harness.sends.map(({ settings }) => JSON.parse(JSON.stringify(settings))),
    [{ resetTimer: 'true' }],
  );
});

test('pomowave skip phase sends the control param once', () => {
  const harness = createHarness('pomowave.js');
  harness.callbacks.connected[0]();

  harness.elements.get('skipPhase').dispatchEvent({ type: 'click' });

  assert.deepEqual(
    harness.sends.map(({ settings }) => JSON.parse(JSON.stringify(settings))),
    [{ skipPhase: 'true' }],
  );
});

test('pomowave sound button commits the style then auditions it', () => {
  const harness = createHarness('pomowave.js');
  harness.callbacks.connected[0]();

  harness.selectors.get('[data-sound-style]')[0].dispatchEvent({ type: 'click' });

  // 点选样式先落到隐藏输入，再作为设置提交，最后追发一条试听控制参数。
  assert.equal(harness.elements.get('soundStyle').value, 'bell');
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.sends.at(-1).settings)),
    { previewSound: 'bell' },
  );
  assert.equal(harness.sends.at(-2).settings.soundStyle, 'bell');
});

test('pomowave inspector submits the manual-stage continuous cue setting', () => {
  const harness = createHarness('pomowave.js');
  harness.callbacks.connected[0]();
  harness.elements.get('repeatManualCue').type = 'checkbox';
  harness.elements.get('repeatManualCue').checked = true;

  harness.form.dispatchEvent({ type: 'submit' });

  assert.equal(harness.sends.at(-1).settings.repeatManualCue, 'true');
});

test('bambustatus applies discovery without resubmitting a cached result', () => {
  const harness = createHarness('bambustatus.js');
  harness.callbacks.connected[0]();

  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.sends.at(-1).settings)),
    { __requestSettings: 'true' },
  );

  harness.callbacks.plugin.forEach((callback) => callback({
    context: 'ctx-1',
    param: {
      __bambustatusDiscovery: {
        status: 'found',
        model: 'P2S',
        settings: {
          printerName: '书房打印机',
          printerIp: '192.168.1.180',
          serialNumber: 'TEST-SERIAL',
          accessCode: 'TEST-CODE',
        },
      },
    },
  }));

  assert.equal(harness.elements.get('printerName').value, '书房打印机');
  assert.equal(harness.elements.get('printerIp').value, '192.168.1.180');
  assert.equal(harness.sends.length, 1, 'discovery replay must not become a settings submit');
});

test('speedtest inspector persists scope, schedule, checked nodes and chart type', () => {
  const harness = createHarness('speedtest.js');
  harness.callbacks.connected[0]();
  harness.elements.get('scope').value = 'overseas';
  harness.elements.get('intervalMin').value = '30';
  harness.elements.get('candidateServers').value = '[{"id":"12345"}]';
  harness.elements.get('chartType').value = 'bar';

  harness.form.dispatchEvent({ type: 'submit' });

  const settings = harness.sends.at(-1).settings;
  assert.equal(settings.scope, 'overseas');
  assert.equal(settings.intervalMin, '30');
  assert.equal(settings.candidateServers, '[{"id":"12345"}]');
  assert.equal(settings.chartType, 'bar');
  // 模式不再是独立设置项，勾选数量就是模式。
  assert.equal(settings.selectionMode, undefined);
  assert.equal(settings.fixedServerId, undefined);
});

test('speedtest chart button commits the chart type once after reconnect', () => {
  const harness = createHarness('speedtest.js');
  harness.callbacks.connected[0]();
  harness.callbacks.connected[0]();
  // 面板打开时空清单会先要一次节点，这里只关心图表按钮自己发了几次。
  const before = harness.sends.length;

  harness.selectors.get('[data-chart-type]')[0].dispatchEvent({ type: 'click' });

  assert.equal(harness.sends.length - before, 1);
  assert.equal(harness.sends.at(-1).settings.chartType, 'bar');
});

test('speedtest inspector asks for nodes once while the list is empty', () => {
  const harness = createHarness('speedtest.js');
  harness.callbacks.connected[0]();

  // 建 harness 时已经跑过一次 onAdd，空清单应该恰好要了一次节点。
  const asks = () => harness.sends.filter(({ settings }) => settings.ensureServers === 'true').length;
  assert.equal(asks(), 1);

  // 清单仍为空时重复推送运行态不再追加请求，避免打爆目录服务。
  harness.callbacks.app[0]({ context: 'ctx-1', param: { speedtestRuntime: JSON.stringify({ servers: [] }) } });
  assert.equal(asks(), 1);

  // 拉到节点后解除标记，之后再次变空还能再要一次。
  harness.callbacks.app[0]({
    context: 'ctx-1',
    param: { speedtestRuntime: JSON.stringify({ servers: [{ id: '1', countryCode: 'CN' }] }) },
  });
  assert.equal(asks(), 1);
  harness.callbacks.app[0]({ context: 'ctx-1', param: { speedtestRuntime: JSON.stringify({ servers: [] }) } });
  assert.equal(asks(), 2);
});

test('speedtest node list renders checkboxes and derives the mode from how many are checked', () => {
  const harness = createHarness('speedtest.js');
  harness.callbacks.connected[0]();
  harness.elements.get('scope').value = 'mainland';

  const servers = [
    { id: '3633', name: 'China Telecom', city: 'Nanjing', country: 'China', countryCode: 'CN' },
    { id: '5083', name: 'China Unicom', city: 'Shanghai', country: 'China', countryCode: 'CN' },
  ];
  harness.callbacks.app[0]({
    context: 'ctx-1',
    param: { candidateServers: '[]', speedtestRuntime: JSON.stringify({ servers }) },
  });

  const list = harness.elements.get('serverList');
  assert.equal((list.innerHTML.match(/type="checkbox"/g) || []).length, 2);
  assert.ok(!list.innerHTML.includes('checked'), '未勾选时不应有 checked 属性');
  assert.equal(harness.elements.get('selectionSummary').textContent, '不勾选：在当前区域的全部节点里每日随机。');

  // 勾第一个：写入候选池，文案切到「固定」。
  const check = (id, checked) => list.dispatchEvent({
    type: 'change',
    target: { closest: () => ({ dataset: { serverId: id }, checked, closest: () => null }) },
  });
  check('3633', true);
  assert.deepEqual(
    JSON.parse(harness.elements.get('candidateServers').value).map((server) => server.id),
    ['3633'],
  );
  assert.equal(harness.elements.get('selectionSummary').textContent, '已勾选 1 个：固定使用该节点。');

  // 再勾一个：变成在两个节点里随机。
  check('5083', true);
  assert.deepEqual(
    JSON.parse(harness.elements.get('candidateServers').value).map((server) => server.id),
    ['3633', '5083'],
  );
  assert.equal(harness.elements.get('selectionSummary').textContent, '已勾选 2 个：每天在这些节点里随机选一个。');

  // 取消勾选会从候选池里移除，且发出去的设置里带的是新值。
  check('3633', false);
  assert.deepEqual(
    JSON.parse(harness.elements.get('candidateServers').value).map((server) => server.id),
    ['5083'],
  );
  assert.equal(harness.sends.at(-1).settings.candidateServers, harness.elements.get('candidateServers').value);
});

test('speedtest inspector sends an immediate-test control without rewriting settings', () => {
  const harness = createHarness('speedtest.js');
  harness.callbacks.connected[0]();

  harness.elements.get('testSelected').dispatchEvent({ type: 'click' });

  assert.deepEqual(JSON.parse(JSON.stringify(harness.sends.at(-1).settings)), { testSelected: 'true' });
});
