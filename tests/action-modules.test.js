import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { __testing as lexTesting } from '../plugins/com.ulanzi.lexutility.ulanziPlugin/plugin/app.js';
import { __testing as templateTesting } from '../template/com.example.hello.ulanziPlugin/plugin/app.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = path.join(root, 'plugins/com.ulanzi.lexutility.ulanziPlugin/plugin');
const templateRoot = path.join(root, 'template/com.example.hello.ulanziPlugin/plugin');

const read = (file) => fs.readFileSync(file, 'utf8');

test('business actions live outside the Lex Utility framework entry', () => {
  const app = read(path.join(pluginRoot, 'app.js'));
  for (const symbol of ['renderLatencyIcon', 'renderPomodoroIcon', 'renderSpeedtestIcon']) {
    assert.doesNotMatch(app, new RegExp(`function ${symbol}\\b`));
  }
  for (const key of ['latency', 'pomowave', 'speedtest', 'bambustatus']) {
    assert.equal(fs.existsSync(path.join(pluginRoot, 'actions', `${key}.js`)), true);
  }
});

test('individual action modules do not import app.js or sibling actions', () => {
  for (const key of ['latency', 'pomowave', 'speedtest', 'bambustatus']) {
    const source = read(path.join(pluginRoot, 'actions', `${key}.js`));
    assert.doesNotMatch(source, /from\s+['"][^'"]*app\.js['"]/);
    assert.doesNotMatch(source, /from\s+['"]\.\/(?:latency|pomowave|speedtest|bambustatus)\.js['"]/);
  }
});

// 拆分 action 后，每个模块只能看见自己从 runtime 解构出来的东西，漏接一个名字就是
// 运行时 ReferenceError——而且只在真正走到那条渲染分支时才炸（speedtest 是每次渲染，
// pomowave 只在最后 5 秒告警脉冲）。逐状态渲染一遍，让漏接在测试里立刻现形。
const RENDER_STATES = {
  latency: [
    { status: 'checking', lastMs: null },
    { status: 'up', lastMs: 42 },
    { status: 'slow', lastMs: 320 },
    { status: 'down', lastMs: null },
    { status: 'paused', lastMs: 88 },
  ],
  pomowave: [
    { phase: 'idle', totalSec: 1500, remainingSec: 1500 },
    { phase: 'focus', running: true, totalSec: 1500, remainingSec: 900, phaseEndAt: Date.now() + 900_000 },
    // 最后 5 秒的告警脉冲，走 frameHighlight 分支
    { phase: 'focus', running: true, totalSec: 1500, remainingSec: 4, phaseEndAt: Date.now() + 4_000 },
    // 待命闪烁，走 awaiting 圆环分支
    { phase: 'shortBreak', awaiting: true, blinkOn: true, totalSec: 300, remainingSec: 300 },
    { phase: 'longBreak', totalSec: 900, remainingSec: 450 },
    { phase: 'done', totalSec: 4, remainingSec: 0 },
  ],
  speedtest: [
    { phase: 'idle' },
    { phase: 'queued', queuePosition: 2 },
    { phase: 'running' },
    { phase: 'discovering' },
    { phase: 'error', errorCode: 'DNS' },
    {
      phase: 'idle',
      lastResult: { downloadMbps: 312.4, uploadMbps: 48.9, pingMs: 12 },
      history: Array.from({ length: 30 }, (_, index) => ({
        ok: true,
        at: Date.now() - index * 60_000,
        downloadMbps: 100 + index,
        uploadMbps: 20 + index,
      })),
    },
  ],
  bambustatus: [
    { connectionState: 'CONFIG_REQUIRED' },
    { connectionState: 'CONNECTING' },
    { connectionState: 'OFFLINE', lastSeenAt: Date.now() - 70_000 },
    { connectionState: 'INCOMPATIBLE' },
    { connectionState: 'ONLINE', liveStatus: 'IDLE', model: 'P2S' },
    { connectionState: 'ONLINE', liveStatus: 'PREPARING', model: 'P2S', stage: '自动调平', progress: 0, elapsedSec: 60, remainingSec: 1800 },
    { connectionState: 'ONLINE', liveStatus: 'RUNNING', model: 'P2S', progress: 42, elapsedSec: 3600, remainingSec: 1200 },
    { connectionState: 'ONLINE', liveStatus: 'PAUSED', model: 'P2S', progress: 43, elapsedSec: 3700, remainingSec: 1100 },
    { connectionState: 'ONLINE', liveStatus: 'FAILED', model: 'P2S', stage: '喷嘴温度异常' },
    { connectionState: 'ONLINE', liveStatus: 'FINISHED', model: 'P2S', progress: 100, elapsedSec: 5000, remainingSec: 0 },
  ],
};

test('every action renders each of its states without missing a runtime dependency', () => {
  for (const [key, states] of Object.entries(RENDER_STATES)) {
    const config = lexTesting.ACTION_CONFIGS[key];
    assert.ok(config, `missing action config: ${key}`);
    const context = `com.ulanzi.ulanzistudio.lexutility.${key}___render-smoke___${key}`;

    for (const state of states) {
      const instance = {
        context,
        // active:false 让框架层 renderInstance 短路，这里直接调 config.render 取图
        active: false,
        settings: { ...config.defaults },
        ...config.createState({ context }),
        ...state,
      };
      const label = `${key}:${state.status || state.phase}`;

      let icon;
      assert.doesNotThrow(() => { icon = config.render(instance); }, label);
      assert.match(icon, /^data:image\/svg\+xml;base64,/, label);

      const svg = Buffer.from(icon.split(',')[1], 'base64').toString('utf8');
      assert.match(svg, /^\s*<svg[\s\S]*<\/svg>\s*$/, label);
      // 模板字面量里漏掉的值会静默渲染成 "undefined"，肉眼在键面上很难认出来
      assert.doesNotMatch(svg, /undefined|NaN|\[object Object\]/, label);

      lexTesting.clearInstanceTimeout(instance, 'pomodoro');
    }

    lexTesting.dropPersistedState(context);
  }
});

test('template actions render from their own module closure', () => {
  for (const key of ['counter', 'badge', 'swatch', 'fontprobe']) {
    const config = templateTesting.ACTION_CONFIGS[key];
    assert.ok(config, `missing template action config: ${key}`);
    const context = `com.example.hello.${key}___render-smoke___${key}`;
    const instance = {
      context,
      active: false,
      settings: { ...config.defaults },
      ...config.createState({ context }),
    };

    let icon;
    assert.doesNotThrow(() => { icon = config.render(instance); }, key);
    assert.match(icon, /^data:image\/svg\+xml;base64,/, key);
    const svg = Buffer.from(icon.split(',')[1], 'base64').toString('utf8');
    assert.doesNotMatch(svg, /undefined|NaN|\[object Object\]/, key);
  }
});

test('template demonstrates one module per action', () => {
  for (const key of ['counter', 'badge', 'swatch', 'fontprobe']) {
    assert.equal(fs.existsSync(path.join(templateRoot, 'actions', `${key}.js`)), true);
  }
});
