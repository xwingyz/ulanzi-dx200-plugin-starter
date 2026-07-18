import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PRESERVED_ENTRIES,
  clearDirExcept,
  copyDir,
  syncPluginDir
} from '../scripts/lib/plugin-sync.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(file, 'utf8');

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ulanzi-sync-test-'));
}

// 造一个最小的"仓库插件 + 已部署插件"现场：部署侧带着只存在于那边的运行时状态。
function scaffold() {
  const tmp = makeTempRoot();
  const sourceDir = path.join(tmp, 'repo', 'plugins', 'com.test.ulanziPlugin');
  const targetDir = path.join(tmp, 'deployed', 'com.test.ulanziPlugin');

  fs.mkdirSync(path.join(sourceDir, 'plugin'), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'manifest.json'), '{"version":"2"}');
  fs.writeFileSync(path.join(sourceDir, 'plugin', 'app.js'), 'export const v = 2;');

  fs.mkdirSync(path.join(targetDir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(targetDir, 'manifest.json'), '{"version":"1"}');
  fs.writeFileSync(path.join(targetDir, 'data', 'action-settings.json'), '{"key":"user"}');
  fs.writeFileSync(path.join(targetDir, 'data', 'action-state.json'), '{"history":[1,2,3]}');

  return { tmp, sourceDir, targetDir };
}

test('sync preserves deployed runtime state and never overwrites it from the repo', () => {
  const { sourceDir, targetDir } = scaffold();

  // 仓库里也有一份 data/——通常是本地调试残留，绝不能覆盖部署侧的真实状态。
  fs.mkdirSync(path.join(sourceDir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'data', 'action-state.json'), '{"history":[]}');
  fs.writeFileSync(path.join(sourceDir, 'data', 'debug-leftover.json'), '{"junk":true}');

  syncPluginDir(sourceDir, targetDir);

  assert.equal(read(path.join(targetDir, 'data', 'action-state.json')), '{"history":[1,2,3]}');
  assert.equal(read(path.join(targetDir, 'data', 'action-settings.json')), '{"key":"user"}');
  assert.equal(fs.existsSync(path.join(targetDir, 'data', 'debug-leftover.json')), false);

  // 代码本身照常更新。
  assert.equal(read(path.join(targetDir, 'manifest.json')), '{"version":"2"}');
  assert.equal(read(path.join(targetDir, 'plugin', 'app.js')), 'export const v = 2;');
});

test('sync removes deployed files that no longer exist in the repo', () => {
  const { sourceDir, targetDir } = scaffold();

  fs.writeFileSync(path.join(targetDir, 'stale-root.js'), 'old');
  fs.mkdirSync(path.join(targetDir, 'stale-dir'), { recursive: true });
  fs.writeFileSync(path.join(targetDir, 'stale-dir', 'gone.js'), 'old');
  fs.mkdirSync(path.join(targetDir, 'plugin'), { recursive: true });
  fs.writeFileSync(path.join(targetDir, 'plugin', 'removed-action.js'), 'old');

  syncPluginDir(sourceDir, targetDir);

  assert.equal(fs.existsSync(path.join(targetDir, 'stale-root.js')), false);
  assert.equal(fs.existsSync(path.join(targetDir, 'stale-dir')), false);
  assert.equal(fs.existsSync(path.join(targetDir, 'plugin', 'removed-action.js')), false);
  assert.equal(fs.existsSync(path.join(targetDir, 'data', 'action-state.json')), true);
});

test('--reset-data explicitly clears runtime state', () => {
  const { sourceDir, targetDir } = scaffold();

  fs.mkdirSync(path.join(sourceDir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'data', 'debug-leftover.json'), '{"junk":true}');

  syncPluginDir(sourceDir, targetDir, { resetData: true });

  // 部署侧的运行时状态被清掉了……
  assert.equal(fs.existsSync(path.join(targetDir, 'data', 'action-state.json')), false);
  assert.equal(fs.existsSync(path.join(targetDir, 'data', 'action-settings.json')), false);
  // ……但仓库那份 data/ 依然不是合法来源，不会被顺手播种进去。
  assert.equal(fs.existsSync(path.join(targetDir, 'data', 'debug-leftover.json')), false);

  assert.equal(read(path.join(targetDir, 'manifest.json')), '{"version":"2"}');
});

test('nested directories named data are treated as code, not runtime state', () => {
  const { sourceDir, targetDir } = scaffold();

  // 插件根下的 data/ 是运行时状态；更深层叫 data 的目录是代码资产，必须照常拷贝。
  const nested = path.join(sourceDir, 'plugin', 'assets', 'data');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'icons.json'), '{"icon":"svg"}');

  syncPluginDir(sourceDir, targetDir);

  const nestedTarget = path.join(targetDir, 'plugin', 'assets', 'data', 'icons.json');
  assert.equal(fs.existsSync(nestedTarget), true);
  assert.equal(read(nestedTarget), '{"icon":"svg"}');
  assert.equal(read(path.join(targetDir, 'data', 'action-state.json')), '{"history":[1,2,3]}');
});

test('sync works when the deployed plugin does not exist yet', () => {
  const { sourceDir, targetDir } = scaffold();
  fs.rmSync(targetDir, { recursive: true, force: true });

  syncPluginDir(sourceDir, targetDir);

  assert.equal(read(path.join(targetDir, 'manifest.json')), '{"version":"2"}');
  assert.equal(fs.existsSync(path.join(targetDir, 'data')), false);
});

test('syncPluginDir refuses to touch the target when the source plugin is missing', () => {
  const { sourceDir, targetDir } = scaffold();
  fs.rmSync(sourceDir, { recursive: true, force: true });

  assert.throws(() => syncPluginDir(sourceDir, targetDir), /Plugin not found/);
  // 抛错前不能已经把部署目录清掉了。
  assert.equal(read(path.join(targetDir, 'data', 'action-state.json')), '{"history":[1,2,3]}');
});

test('clearDirExcept keeps preserved entries and is a no-op on a missing dir', () => {
  const tmp = makeTempRoot();
  const dir = path.join(tmp, 'target');
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'plugin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'state.json'), 'keep');
  fs.writeFileSync(path.join(dir, 'plugin', 'app.js'), 'drop');
  fs.writeFileSync(path.join(dir, 'root.js'), 'drop');

  clearDirExcept(dir, PRESERVED_ENTRIES);

  assert.deepEqual(fs.readdirSync(dir), ['data']);
  assert.equal(read(path.join(dir, 'data', 'state.json')), 'keep');

  assert.doesNotThrow(() => clearDirExcept(path.join(tmp, 'nope'), PRESERVED_ENTRIES));
});

test('copyDir skip applies only at the top level', () => {
  const tmp = makeTempRoot();
  const source = path.join(tmp, 'src');
  const target = path.join(tmp, 'dst');
  fs.mkdirSync(path.join(source, 'data'), { recursive: true });
  fs.mkdirSync(path.join(source, 'nested', 'data'), { recursive: true });
  fs.writeFileSync(path.join(source, 'data', 'top.json'), 'top');
  fs.writeFileSync(path.join(source, 'nested', 'data', 'deep.json'), 'deep');

  copyDir(source, target, new Set(['data']));

  assert.equal(fs.existsSync(path.join(target, 'data')), false);
  assert.equal(read(path.join(target, 'nested', 'data', 'deep.json')), 'deep');
});

// 这条规则有两个调用点，重复实现一定会漂移，而失败模式是静默丢数据。
// 锁住"两个脚本都走同一个模块"，别让任何一边偷偷长回自己的删除逻辑。
test('both sync scripts route through the shared preserve-aware module', () => {
  for (const script of ['dev-desktop.mjs', 'sync-plugin.mjs']) {
    const source = read(path.join(root, 'scripts', script));
    assert.match(source, /from '\.\/lib\/plugin-sync\.mjs'/, `${script} must import the shared module`);
    assert.doesNotMatch(
      source,
      /rmSync\(/,
      `${script} must not delete the deployed tree itself`
    );
    assert.doesNotMatch(
      source,
      /function copyDir\b/,
      `${script} must not reimplement copyDir`
    );
  }
});
