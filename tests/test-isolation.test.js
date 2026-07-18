import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { __testing as lexTesting } from '../plugins/com.ulanzi.lexutility.ulanziPlugin/plugin/app.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 这套断言守的是测试基础设施本身：不少测试会 import 真实 app.js 并触发真实落盘，
// 一旦隔离失效（改了 npm test 的 --import、或框架不再认 ULANZI_PLUGIN_DATA_DIR），
// 测试键就会写进仓库的 plugins/*/data/，再被同步脚本带到用户的插件目录里。
// 症状很安静——测试照样全绿——所以必须显式锁住。
test('test process writes persistence outside the repository', () => {
  const dataDir = process.env.ULANZI_PLUGIN_DATA_DIR;
  assert.ok(dataDir, 'ULANZI_PLUGIN_DATA_DIR 未设置：npm test 应带 --import ./tests/setup.mjs');
  assert.equal(
    path.resolve(dataDir).startsWith(repoRoot + path.sep),
    false,
    `持久化目录不能落在仓库内：${dataDir}`,
  );
});

test('framework persistence actually lands in the isolated directory', () => {
  const context = 'com.ulanzi.ulanzistudio.lexutility.latency___isolation___probe';
  assert.equal(lexTesting.writePersistedState(context, { probe: true }), true);

  // 落盘位置必须在隔离目录下，且仓库侧不因此长出 data/
  const isolated = path.join(
    path.resolve(process.env.ULANZI_PLUGIN_DATA_DIR),
    'com.ulanzi.ulanzistudio.lexutility',
    'action-state.json',
  );
  assert.equal(fs.existsSync(isolated), true, `未写入隔离目录：${isolated}`);
  // 不硬编码 persistenceKey 的拼法，用框架自己的读取入口确认这一份就是它写的
  assert.deepEqual(lexTesting.readPersistedState(context), { probe: true });
  assert.match(fs.readFileSync(isolated, 'utf8'), /"probe": true/);
  assert.equal(
    fs.existsSync(path.join(repoRoot, 'plugins/com.ulanzi.lexutility.ulanziPlugin/data')),
    false,
    '仓库内不应出现 data/',
  );

  lexTesting.dropPersistedState(context);
});
