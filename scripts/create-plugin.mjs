import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const templateDir = path.join(rootDir, 'template', 'com.example.hello.ulanziPlugin');
const outputRoot = path.join(rootDir, 'plugins');

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

function toPluginSegment(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function toTitle(value) {
  return String(value || '')
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

function copyDir(sourceDir, targetDir, replacements) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetName = replaceTokens(entry.name, replacements);
    const targetPath = path.join(targetDir, targetName);

    if (entry.isDirectory()) {
      copyDir(sourcePath, targetPath, replacements);
      continue;
    }

    const raw = fs.readFileSync(sourcePath);
    if (isTextFile(sourcePath)) {
      const replaced = replaceTokens(raw.toString('utf8'), replacements);
      fs.writeFileSync(targetPath, replaced, 'utf8');
    } else {
      fs.writeFileSync(targetPath, raw);
    }
  }
}

function replaceTokens(input, replacements) {
  let output = input;
  for (const [key, value] of Object.entries(replacements)) {
    output = output.replaceAll(key, value);
  }
  return output;
}

function isTextFile(filePath) {
  const textExtensions = new Set([
    '.json',
    '.js',
    '.mjs',
    '.html',
    '.css',
    '.md',
    '.svg',
    '.txt',
  ]);
  return textExtensions.has(path.extname(filePath));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rawId = args.id;
  if (!rawId) {
    console.error('Missing required argument: --id');
    process.exit(1);
  }

  const pluginSegment = toPluginSegment(rawId);
  if (!pluginSegment) {
    console.error('Invalid --id: must contain at least one ASCII letter or digit');
    process.exit(1);
  }

  const pluginFolder = `com.ulanzi.${pluginSegment}.ulanziPlugin`;
  const pluginName = args.name || toTitle(rawId);
  const pluginUuid = args['plugin-uuid'] || `com.ulanzi.ulanzistudio.${pluginSegment}`;
  const actionUuid = args['action-uuid'] || `${pluginUuid}.default`;
  const description = args.description || `${pluginName} plugin for Ulanzi DX200.`;
  const author = args.author || 'yuanlei';

  const replacements = {
    '__PLUGIN_FOLDER__': pluginFolder,
    '__PLUGIN_NAME__': pluginName,
    '__PLUGIN_AUTHOR__': author,
    '__PLUGIN_DESCRIPTION__': description,
    '__PLUGIN_UUID__': pluginUuid,
    '__ACTION_UUID__': actionUuid,
  };

  const targetDir = path.join(outputRoot, pluginFolder);
  if (fs.existsSync(targetDir)) {
    console.error(`Target already exists: ${targetDir}`);
    process.exit(1);
  }

  if (!fs.existsSync(templateDir)) {
    console.error(`Template not found: ${templateDir}`);
    process.exit(1);
  }

  fs.mkdirSync(outputRoot, { recursive: true });
  copyDir(templateDir, targetDir, replacements);

  console.log(`Created ${pluginFolder}`);
  console.log(targetDir);
}

main();
