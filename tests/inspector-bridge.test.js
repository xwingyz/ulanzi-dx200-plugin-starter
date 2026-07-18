import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';

import { __testing as pluginTesting } from '../plugins/com.ulanzi.lexutility.ulanziPlugin/plugin/app.js';
import { __testing as templateTesting } from '../template/com.example.hello.ulanziPlugin/plugin/app.js';

// 这组测试与 inspector-lifecycle.test.js 的区别：不 mock $UD，而是加载真实的
// libs/js 桥接文件（constants / eventEmitter / ulanzideckApi）跑完整回显链路。
// 它兜住的回归是“桥接层 API 面与 inspector 调用漂移”——mock 版测试看不见这类断裂。

const ROOT = path.resolve(import.meta.dirname, '..');
const COPIES = [
  {
    name: 'plugin',
    base: path.join(ROOT, 'plugins/com.ulanzi.lexutility.ulanziPlugin'),
    testing: pluginTesting,
  },
  {
    name: 'template',
    base: path.join(ROOT, 'template/com.example.hello.ulanziPlugin'),
    testing: templateTesting,
  },
];

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
}

class FakeElement extends FakeEventTarget {
  constructor({ id = '', value = '', type = 'text' } = {}) {
    super();
    this.id = id;
    this.value = value;
    this.type = type;
    this.checked = false;
    this.dataset = {};
    this.style = {};
    this.children = [];
    this.classList = {
      toggle: () => {},
      remove: () => {},
    };
  }

  setAttribute() {}

  appendChild(child) {
    this.children.push(child);
    return child;
  }
}

function createBridgeHarness(base) {
  const wrapper = new FakeElement();
  const themeRow = new FakeElement();
  const elements = new Map();
  const document = {
    getElementById: (id) => {
      if (!elements.has(id)) {
        elements.set(id, new FakeElement({ id }));
      }
      return elements.get(id);
    },
    createElement: () => new FakeElement({}),
    querySelector: (selector) =>
      selector === '.uspi-wrapper' ? wrapper : selector === '.theme-row' ? themeRow : null,
    querySelectorAll: () => [],
  };

  const sockets = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      sockets.push(this);
    }

    send(payload) {
      this.sent.push(JSON.parse(payload));
    }

    close() {}
  }

  // 假定时器：反馈条的自动隐藏定时不真正等待，也不拖住测试进程。
  const timers = new Map();
  let nextTimerId = 1;
  const fakeSetTimeout = (callback) => {
    const id = nextTimerId++;
    timers.set(id, callback);
    return id;
  };
  const fakeClearTimeout = (id) => timers.delete(id);

  const context = vm.createContext({
    console,
    document,
    window: new FakeEventTarget(),
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    WebSocket: FakeWebSocket,
    Utils: {
      getQueryParams: () => '',
      adaptLanguage: (value) => value || 'en',
      getLanguage: () => 'en',
      getPluginPath: () => '',
      readJson: async () => {
        throw new Error('no localization in tests');
      },
    },
  });

  for (const file of [
    'libs/js/constants.js',
    'libs/js/eventEmitter.js',
    'libs/js/ulanzideckApi.js',
    'property-inspector/inspector-shared.js',
  ]) {
    vm.runInContext(fs.readFileSync(path.join(base, file), 'utf8'), context, {
      filename: file,
    });
  }

  return { context, document, elements, sockets, themeRow, timers };
}

function hostMessage(socket, message) {
  socket.onmessage({ data: JSON.stringify(message) });
}

for (const copy of COPIES) {
  test(`[${copy.name}] persisted settings echo back into inspector fields via real bridge`, () => {
    const harness = createBridgeHarness(copy.base);
    const actionUuid = 'com.example.test.action.counter';
    vm.runInContext(
      `initInspector('${actionUuid}', ['title', 'subtitle', 'theme'])`,
      harness.context,
    );

    const [socket] = harness.sockets;
    assert.ok(socket, 'initInspector should open a websocket');
    socket.onopen();

    // 宿主在 PI 打开时下发 add：带着（与磁盘持久化对齐的）设置来件。
    hostMessage(socket, {
      cmd: 'add',
      uuid: actionUuid,
      key: 'key-1',
      actionid: 'action-1',
      param: { title: 'Saved Title', subtitle: 'Saved Sub', theme: 'ember' },
    });
    assert.equal(harness.elements.get('title').value, 'Saved Title');
    assert.equal(harness.elements.get('theme').value, 'ember');

    // 插件侧 syncInspectorSettings 的权威纠正（paramfromplugin）也必须刷新界面。
    hostMessage(socket, {
      cmd: 'paramfromplugin',
      uuid: actionUuid,
      key: 'key-1',
      actionid: 'action-1',
      param: { title: 'Normalized Title' },
    });
    assert.equal(harness.elements.get('title').value, 'Normalized Title');

    // 回填后的提交要带上 add 消息里学到的 context（key/actionid）。
    harness.document.getElementById('property-inspector').dispatchEvent({ type: 'submit' });
    const submitted = socket.sent.at(-1);
    assert.equal(submitted.cmd, 'paramfromplugin');
    assert.equal(submitted.key, 'key-1');
    assert.equal(submitted.actionid, 'action-1');
    assert.equal(submitted.param.title, 'Normalized Title');
    assert.equal(harness.elements.get('feedback-saved').hidden, false, 'save should flash feedback');

    // 恢复默认按钮只发框架控制参数，重置逻辑在插件侧。
    harness.document.getElementById('resetDefaults').dispatchEvent({ type: 'click' });
    const resetRequest = socket.sent.at(-1);
    assert.equal(resetRequest.cmd, 'paramfromplugin');
    assert.equal(resetRequest.param.__resetDefaults, 'true');
    assert.equal(resetRequest.key, 'key-1');
    assert.equal(harness.elements.get('feedback-reset').hidden, false, 'reset should flash feedback');
    assert.equal(harness.elements.get('feedback-saved').hidden, true);

    // 插件重置后的权威回推要把表单刷成默认值。
    hostMessage(socket, {
      cmd: 'paramfromplugin',
      uuid: actionUuid,
      key: 'key-1',
      actionid: 'action-1',
      param: { title: 'Lex Utility', subtitle: 'Counter', theme: 'mint' },
    });
    assert.equal(harness.elements.get('title').value, 'Lex Utility');
    assert.equal(harness.elements.get('theme').value, 'mint');
  });

  test(`[${copy.name}] theme chips render from shared swatches through the real bridge`, () => {
    const harness = createBridgeHarness(copy.base);
    const actionUuid = 'com.example.test.action.counter';
    vm.runInContext(`initInspector('${actionUuid}', ['title', 'theme'])`, harness.context);
    const [socket] = harness.sockets;
    socket.onopen();
    hostMessage(socket, { cmd: 'add', uuid: actionUuid, key: 'k1', actionid: 'a1', param: {} });

    const chips = harness.themeRow.children;
    const swatches = JSON.parse(vm.runInContext('JSON.stringify(THEME_SWATCHES)', harness.context));
    assert.equal(chips.length, Object.keys(swatches).length);

    const sand = chips.find((chip) => chip.dataset.themeValue === 'sand');
    assert.ok(sand, 'sand chip should exist');
    sand.dispatchEvent({ type: 'click' });
    assert.equal(socket.sent.at(-1).param.theme, 'sand');
  });

  test(`[${copy.name}] THEME_SWATCHES stays in sync with framework THEMES tokens`, () => {
    const context = vm.createContext({});
    vm.runInContext(
      fs.readFileSync(path.join(copy.base, 'property-inspector/inspector-shared.js'), 'utf8'),
      context,
    );
    const swatches = JSON.parse(vm.runInContext('JSON.stringify(THEME_SWATCHES)', context));
    const themes = copy.testing.THEMES;
    assert.deepEqual(Object.keys(swatches), Object.keys(themes));
    for (const [name, theme] of Object.entries(themes)) {
      // 五段角色：背景 / 填充 / 边框 / 强调 / 文字
      assert.deepEqual(
        swatches[name],
        [theme.canvas, theme.panel, theme.low, theme.accent, theme.text],
        `swatch colors drifted from THEMES for "${name}"`,
      );
    }
  });

  test(`[${copy.name}] every inspector page ships the reset button and feedback elements`, () => {
    const inspectorDir = path.join(copy.base, 'property-inspector');
    for (const file of fs.readdirSync(inspectorDir).filter((name) => name.endsWith('.html'))) {
      const source = fs.readFileSync(path.join(inspectorDir, file), 'utf8');
      for (const marker of [
        'id="resetDefaults"',
        'id="inspector-feedback"',
        'id="feedback-saved"',
        'id="feedback-reset"',
        'id="frameSize"',
        'data-on="optimal"',
        'data-off="max"',
        'id="showFrame"',
        'type="submit"',
        // 主题必须走共享色卡：隐藏 theme 输入 + 空的 .theme-row 容器，
        // 页面自建 select/色板会绕过 THEME_SWATCHES 的一致性校验。
        'id="theme" name="theme" type="hidden"',
        'class="theme-row"',
      ]) {
        assert.ok(source.includes(marker), `${file} is missing ${marker}`);
      }
    }
  });

  test(`[${copy.name}] every $UD method used by property-inspector exists on the real bridge`, () => {
    const harness = createBridgeHarness(copy.base);
    const inspectorDir = path.join(copy.base, 'property-inspector');
    const usedMethods = new Set();
    for (const file of fs.readdirSync(inspectorDir).filter((name) => name.endsWith('.js'))) {
      const source = fs.readFileSync(path.join(inspectorDir, file), 'utf8');
      for (const match of source.matchAll(/\$UD\.([A-Za-z_$][\w$]*)\s*\(/g)) {
        usedMethods.add(match[1]);
      }
    }
    assert.ok(usedMethods.size > 0, 'inspector files should reference $UD methods');
    for (const method of usedMethods) {
      assert.equal(
        vm.runInContext(`typeof $UD.${method}`, harness.context),
        'function',
        `UlanziDeck is missing "${method}" used by property-inspector scripts`,
      );
    }
  });
}

test('pomowave phase colors derive from each framework theme', () => {
  const phaseColors = { focus: new Set(), shortBreak: new Set(), longBreak: new Set(), done: new Set() };
  for (const [name, theme] of Object.entries(pluginTesting.THEMES)) {
    const palette = pluginTesting.pomodoroPalette({ theme: name });
    assert.equal(palette.focus, theme.accent);
    assert.equal(palette.longBreak, theme.muted);
    assert.equal(palette.done, theme.text);
    for (const phase of Object.keys(phaseColors)) {
      assert.match(palette[phase], /^#[0-9a-f]{6}$/i);
      phaseColors[phase].add(palette[phase]);
    }
  }
  for (const [phase, colors] of Object.entries(phaseColors)) {
    assert.equal(colors.size, Object.keys(pluginTesting.THEMES).length, `${phase} must change with every theme`);
  }
});

test('browser bridge and inspector shared layer stay identical between plugin and template', () => {
  for (const file of [
    'libs/js/constants.js',
    'libs/js/eventEmitter.js',
    'libs/js/ulanzideckApi.js',
    'libs/js/utils.js',
    'property-inspector/inspector-shared.js',
  ]) {
    assert.equal(
      fs.readFileSync(path.join(COPIES[0].base, file), 'utf8'),
      fs.readFileSync(path.join(COPIES[1].base, file), 'utf8'),
      `shared file drifted between plugin and template: ${file}`,
    );
  }
});
