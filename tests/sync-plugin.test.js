import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repoRoot, 'scripts', 'sync-plugin.mjs');
const PLUGIN = 'com.example.sync.ulanziPlugin';

// 每个用例一套独立的「仓库 + 模拟器」目录，走 sim target 避免碰到真实桌面插件目录。
function createWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ulanzi-sync-'));
  const sourceDir = path.join(workspace, 'repo', 'plugins', PLUGIN);
  fs.mkdirSync(path.join(sourceDir, 'plugin', 'actions'), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'manifest.json'), '{"v":2}');
  fs.writeFileSync(path.join(sourceDir, 'plugin', 'actions', 'demo.js'), 'export const v = 2;');

  const simRoot = path.join(workspace, 'sim');
  const targetDir = path.join(simRoot, 'plugins', PLUGIN);
  return { workspace, sourceDir, simRoot, targetDir };
}

function sync({ workspace, simRoot }, extraArgs = []) {
  const result = spawnSync(process.execPath, [
    script, '--plugin', PLUGIN, '--target', 'sim', '--sim-root', simRoot, ...extraArgs,
  ], { cwd: path.join(workspace, 'repo'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

// 部署目录里的 data/ 是用户运行态的唯一副本（键位设置、latency 历史、speedtest 记录）。
// 这个脚本曾经整目录删除重拷，一次同步就会把它换成仓库里的调试残留。
test('sync preserves deployed runtime state and never overwrites it from the repo', () => {
  const ws = createWorkspace();

  // 首次部署
  sync(ws);
  assert.equal(fs.readFileSync(path.join(ws.targetDir, 'manifest.json'), 'utf8'), '{"v":2}');

  // 插件运行后在目标目录累积运行态，同时仓库侧留下无关的测试残留
  const deployedState = path.join(ws.targetDir, 'data', 'action-state.json');
  fs.mkdirSync(path.dirname(deployedState), { recursive: true });
  fs.writeFileSync(deployedState, '{"real::key":{"history":"7-days"}}');
  fs.mkdirSync(path.join(ws.sourceDir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(ws.sourceDir, 'data', 'action-state.json'), '{"repro::junk":{}}');

  // 代码更新后再次同步
  fs.writeFileSync(path.join(ws.sourceDir, 'plugin', 'actions', 'demo.js'), 'export const v = 3;');
  const stdout = sync(ws);

  assert.match(stdout, /Runtime state: preserved \(data\)/);
  assert.equal(
    fs.readFileSync(deployedState, 'utf8'),
    '{"real::key":{"history":"7-days"}}',
    '用户运行态必须原样保留',
  );
  assert.equal(
    fs.readFileSync(path.join(ws.targetDir, 'plugin', 'actions', 'demo.js'), 'utf8'),
    'export const v = 3;',
    '代码仍要被更新',
  );

  fs.rmSync(ws.workspace, { recursive: true, force: true });
});

test('sync removes deployed files that no longer exist in the repo', () => {
  const ws = createWorkspace();
  sync(ws);

  // 上一版遗留的文件不能留在目标目录里变成幽灵代码
  const stale = path.join(ws.targetDir, 'plugin', 'actions', 'removed.js');
  fs.writeFileSync(stale, 'export const gone = true;');
  sync(ws);

  assert.equal(fs.existsSync(stale), false);
  fs.rmSync(ws.workspace, { recursive: true, force: true });
});

test('--reset-data explicitly clears runtime state', () => {
  const ws = createWorkspace();
  sync(ws);

  const deployedState = path.join(ws.targetDir, 'data', 'action-state.json');
  fs.mkdirSync(path.dirname(deployedState), { recursive: true });
  fs.writeFileSync(deployedState, '{"real::key":{}}');

  const stdout = sync(ws, ['--reset-data']);
  assert.match(stdout, /Runtime state: reset/);
  assert.equal(fs.existsSync(deployedState), false);

  fs.rmSync(ws.workspace, { recursive: true, force: true });
});

test('nested directories named data are treated as code, not runtime state', () => {
  const ws = createWorkspace();
  // 只有插件根下的 data/ 是运行态；libs/data/ 这类嵌套同名目录属于代码资产
  const nested = path.join(ws.sourceDir, 'libs', 'data');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'table.json'), '{"lookup":1}');

  sync(ws);
  assert.equal(
    fs.readFileSync(path.join(ws.targetDir, 'libs', 'data', 'table.json'), 'utf8'),
    '{"lookup":1}',
  );

  fs.rmSync(ws.workspace, { recursive: true, force: true });
});
