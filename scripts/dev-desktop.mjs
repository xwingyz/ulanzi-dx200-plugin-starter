import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { syncPluginDir } from './lib/plugin-sync.mjs';

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

function syncPlugin(rootDir, pluginName, { resetData = false } = {}) {
  const sourceDir = path.join(rootDir, 'plugins', pluginName);
  const targetDir = path.join(desktopPluginRoot(), pluginName);
  return syncPluginDir(sourceDir, targetDir, { resetData });
}

function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function restartDesktopApp() {
  if (process.platform === 'darwin') {
    spawnSync('pkill', ['-f', '/Applications/Ulanzi Studio.app/Contents/MacOS/UlanziDeck'], {
      stdio: 'inherit'
    });
    // 主程序退出后，它拉起的插件 Node 子进程会变成孤儿并占住旧代码，
    // 不清掉会导致 Studio 重启失败或继续运行旧插件。
    spawnSync('pkill', ['-f', 'Ulanzi Studio.app/Contents/MacOS/NodeJS/node'], {
      stdio: 'inherit'
    });
    sleepSync(1500);
    spawnSync('open', ['-a', 'Ulanzi Studio'], { stdio: 'inherit' });
    return;
  }

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/IM', 'UlanziDeck.exe', '/F'], { stdio: 'inherit' });
    spawnSync('powershell', [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'UlanziDeck\\\\Plugins' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
    ], { stdio: 'inherit' });
    sleepSync(1500);
    spawnSync('cmd', ['/c', 'start', '', 'Ulanzi Studio'], { stdio: 'inherit' });
    return;
  }

  throw new Error(`Unsupported desktop platform: ${process.platform}`);
}

function printModeHint(mode, pluginName, targetDir) {
  console.log(`Synced ${pluginName}`);
  console.log(targetDir);
  console.log(`Mode: ${mode}`);

  if (mode === 'sync') {
    console.log('Use this after runtime-only changes such as SVG drawing, button state text, or non-manifest JS logic.');
    console.log('If the button on device still points to an old UUID, delete that key and drag the action again.');
    return;
  }

  if (mode === 'rebind') {
    console.log('Delete the old key instance in UlanziDeck, then drag the action in again.');
    console.log('Use this after UUID, action UUID, or action identity changes.');
    return;
  }

  if (mode === 'restart') {
    console.log('UlanziDeck was restarted after sync.');
    console.log('Use this after manifest changes, main-service entry changes, dependency changes, or first-time plugin install.');
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const pluginName = args.plugin;
  const mode = args.mode || 'sync';

  if (!pluginName) {
    console.error('Missing required argument: --plugin');
    process.exit(1);
  }

  if (!['sync', 'rebind', 'restart'].includes(mode)) {
    console.error('Invalid --mode. Use one of: sync, rebind, restart');
    process.exit(1);
  }

  const rootDir = process.cwd();
  const resetData = args['reset-data'] === 'true';
  const targetDir = syncPlugin(rootDir, pluginName, { resetData });

  if (resetData) {
    console.log('--reset-data: cleared deployed runtime state (data/).');
  }

  if (mode === 'restart') {
    restartDesktopApp();
  }

  printModeHint(mode, pluginName, targetDir);
}

main();
