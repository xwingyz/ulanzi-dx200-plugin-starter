import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      result[key] = 'true';
      continue;
    }
    result[key] = next;
    i += 1;
  }
  return result;
}

// 同步部署的是代码，不是运行态。data/ 是插件在目标目录里自己累积起来的：
// 用户的键位设置、latency 的 24h 历史、speedtest 的一周记录都只存在于那一份。
// 整目录删除重拷会把它换成仓库里的 data/——而仓库那份通常只是本地调试与测试残留，
// 用它覆盖等于静默清空用户数据。所以目标侧保留、源侧不拷。
const PRESERVED_ENTRIES = new Set(['data']);

function removeDir(targetPath) {
  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  }
}

// 清空目标目录但留下 preserved 里的顶层条目，返回实际保留下来的名字用于回显。
function clearDirExcept(targetPath, preserved) {
  if (!fs.existsSync(targetPath)) {
    return [];
  }
  const kept = [];
  for (const entry of fs.readdirSync(targetPath)) {
    if (preserved.has(entry)) {
      kept.push(entry);
      continue;
    }
    fs.rmSync(path.join(targetPath, entry), { recursive: true, force: true });
  }
  return kept;
}

// skip 只作用于插件根这一层：嵌套目录里同名的 data/ 属于代码资产，照常拷贝。
function copyDir(sourceDir, targetDir, skip = new Set()) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (skip.has(entry.name)) {
      continue;
    }
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDir(sourcePath, targetPath);
    } else {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

function desktopPluginRoot() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Ulanzi', 'UlanziDeck', 'Plugins');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || home, 'Ulanzi', 'UlanziDeck', 'Plugins');
  }
  throw new Error(`Unsupported desktop platform: ${process.platform}`);
}

function simulatorPluginRoot(args) {
  const simRoot = args['sim-root'] || process.env.ULANZI_SIMULATOR_DIR;
  if (!simRoot) {
    throw new Error('Missing simulator root. Pass --sim-root or set ULANZI_SIMULATOR_DIR.');
  }
  return path.join(path.resolve(simRoot), 'plugins');
}

function resolveTargetRoot(target, args) {
  if (target === 'desktop') {
    return desktopPluginRoot();
  }
  if (target === 'sim') {
    return simulatorPluginRoot(args);
  }
  throw new Error(`Unsupported target: ${target}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const pluginName = args.plugin;
  const target = args.target || 'desktop';
  if (!pluginName) {
    console.error('Missing required argument: --plugin');
    process.exit(1);
  }

  const rootDir = process.cwd();
  const sourceDir = path.join(rootDir, 'plugins', pluginName);
  if (!fs.existsSync(sourceDir)) {
    console.error(`Plugin not found: ${sourceDir}`);
    process.exit(1);
  }

  const targetRoot = resolveTargetRoot(target, args);
  const targetDir = path.join(targetRoot, pluginName);
  fs.mkdirSync(targetRoot, { recursive: true });

  // --reset-data 是显式的破坏性开关：想从干净运行态重来时才用，默认永远保留。
  const resetData = args['reset-data'] === 'true';
  const kept = resetData
    ? (removeDir(targetDir), [])
    : clearDirExcept(targetDir, PRESERVED_ENTRIES);
  copyDir(sourceDir, targetDir, resetData ? new Set() : PRESERVED_ENTRIES);

  console.log(`Synced ${pluginName}`);
  console.log(`Target: ${target}`);
  console.log(targetDir);
  if (resetData) {
    console.log('Runtime state: reset (--reset-data)');
  } else {
    console.log(`Runtime state: preserved${kept.length ? ` (${kept.join(', ')})` : ' (none yet)'}`);
  }
}

main();
