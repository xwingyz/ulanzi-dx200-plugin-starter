import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = path.join(root, 'plugins/com.ulanzi.lexutility.ulanziPlugin/plugin');
const templateRoot = path.join(root, 'template/com.example.hello.ulanziPlugin/plugin');

const read = (file) => fs.readFileSync(file, 'utf8');

test('business actions live outside the Lex Utility framework entry', () => {
  const app = read(path.join(pluginRoot, 'app.js'));
  for (const symbol of ['renderLatencyIcon', 'renderPomodoroIcon', 'renderSpeedtestIcon']) {
    assert.doesNotMatch(app, new RegExp(`function ${symbol}\\b`));
  }
  for (const key of ['latency', 'pomowave', 'speedtest']) {
    assert.equal(fs.existsSync(path.join(pluginRoot, 'actions', `${key}.js`)), true);
  }
});

test('individual action modules do not import app.js or sibling actions', () => {
  for (const key of ['latency', 'pomowave', 'speedtest']) {
    const source = read(path.join(pluginRoot, 'actions', `${key}.js`));
    assert.doesNotMatch(source, /from\s+['"][^'"]*app\.js['"]/);
    assert.doesNotMatch(source, /from\s+['"]\.\/(?:latency|pomowave|speedtest)\.js['"]/);
  }
});

test('template demonstrates one module per action', () => {
  for (const key of ['counter', 'badge', 'swatch', 'fontprobe']) {
    assert.equal(fs.existsSync(path.join(templateRoot, 'actions', `${key}.js`)), true);
  }
});
