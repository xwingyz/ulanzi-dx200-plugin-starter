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
    this.classList = {
      toggle: () => {},
      remove: () => {},
    };
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
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
    ['graphMode', new FakeElement({ id: 'graphMode', value: 'bars' })],
    ['backgroundStyle', new FakeElement({ id: 'backgroundStyle', value: 'gradient' })],
    ['soundStyle', new FakeElement({ id: 'soundStyle', value: 'glass' })],
    ['resetTimer', new FakeElement({ id: 'resetTimer' })],
  ]);
  const selectors = new Map();

  if (entryFile === 'latency.js') {
    selectors.set('[data-graph-mode]', [
      new FakeElement({ dataset: { graphMode: 'line' } }),
    ]);
    selectors.set('[data-bg-style]', [
      new FakeElement({ dataset: { bgStyle: 'solid' } }),
    ]);
  }
  if (entryFile === 'pomowave.js') {
    selectors.set('[data-bg-style]', [
      new FakeElement({ dataset: { bgStyle: 'solid' } }),
    ]);
    selectors.set('[data-sound-style]', [
      new FakeElement({ dataset: { soundStyle: 'bell' } }),
    ]);
  }
  selectors.set('[data-theme-value]', []);

  const document = {
    getElementById: (id) => {
      if (!elements.has(id)) {
        elements.set(id, new FakeElement({ id, value: '' }));
      }
      return elements.get(id);
    },
    querySelector: (selector) => selector === '.uspi-wrapper' ? wrapper : null,
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
    vm.runInContext("initInspector('test.action', ['title', 'theme'])", context);
  }

  callbacks.add.forEach((callback) => callback({ context: 'ctx-1', param: {} }));

  return {
    callbacks,
    elements,
    form,
    runTimers,
    selectors,
    sends,
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
