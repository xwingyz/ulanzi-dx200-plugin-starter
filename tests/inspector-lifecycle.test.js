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
  assert.equal(harness.sends.length, 1);
});

test('pagehide flushes the latest pending input once and clears its timer', () => {
  const harness = createHarness();
  harness.callbacks.connected[0]();
  harness.form.dispatchEvent({ type: 'input' });

  harness.elements.get('title').value = 'tail value';
  harness.window.dispatchEvent({ type: 'pagehide' });

  assert.equal(harness.sends.length, 1);
  assert.equal(harness.sends[0].settings.title, 'tail value');
  assert.equal(harness.timerCount(), 0);

  harness.runTimers();
  assert.equal(harness.sends.length, 1);
});

test('pagehide without pending input does not send settings', () => {
  const harness = createHarness();
  harness.callbacks.connected[0]();

  harness.window.dispatchEvent({ type: 'pagehide' });

  assert.equal(harness.sends.length, 0);
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
  assert.equal(harness.sends.length, 1);
  assert.equal(harness.sends[0].settings.theme, 'neon');
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
    [{ __resetDefaults: 'true' }],
  );
  assert.equal(harness.sends[0].context, 'ctx-1');
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
