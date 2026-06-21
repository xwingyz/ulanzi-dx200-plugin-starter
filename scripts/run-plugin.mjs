import { spawn } from 'node:child_process';
import fs from 'node:fs';
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const pluginName = args.plugin;
  const address = args.address || '127.0.0.1';
  const port = args.port || '39069';

  if (!pluginName) {
    console.error('Missing required argument: --plugin');
    process.exit(1);
  }

  const rootDir = process.cwd();
  const pluginDir = path.join(rootDir, 'plugins', pluginName);
  const appPath = path.join(pluginDir, 'plugin', 'app.js');
  if (!fs.existsSync(appPath)) {
    console.error(`Plugin entry not found: ${appPath}`);
    process.exit(1);
  }

  const child = spawn('node', [appPath, address, port], {
    cwd: pluginDir,
    stdio: 'inherit',
  });

  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });
}

main();
