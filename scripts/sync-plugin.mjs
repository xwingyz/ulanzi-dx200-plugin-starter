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

function removeDir(targetPath) {
  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  }
}

function copyDir(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
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
  removeDir(targetDir);
  copyDir(sourceDir, targetDir);

  console.log(`Synced ${pluginName}`);
  console.log(`Target: ${target}`);
  console.log(targetDir);
}

main();
