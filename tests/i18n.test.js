import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  adaptLocale,
  resolveLocale,
  createI18n,
} from '../plugins/com.ulanzi.lexutility.ulanziPlugin/libs/node/i18n.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const PLUGINS = [
  { name: 'lex utility', dir: path.join(ROOT, 'plugins/com.ulanzi.lexutility.ulanziPlugin') },
  { name: 'template', dir: path.join(ROOT, 'template/com.example.hello.ulanziPlugin') },
];
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const LEX_ACTION_KEYS = [
  'speedtest',
  'latency',
  'pomowave',
  'claudeusage',
  'chatgptusage',
  'bambustatus',
  'nasstatus',
  'systemstatus',
  'healthbreak',
];
const LEX_ACTION_NAMES = {
  en: [
    'Network Speed Test',
    'Web Latency Monitor',
    'Pomowave',
    'Claude Usage',
    'ChatGPT Usage',
    'Bambu 3D Printer Status',
    'Synology NAS Status',
    'System Status',
    'MicroBreak',
  ],
  zh_CN: [
    '网络测速',
    '网站延迟监测',
    '番茄钟',
    'Claude 用量',
    'ChatGPT 用量',
    'Bambu 3D 打印机状态',
    '群晖 NAS 状态',
    '系统状态',
    '休息一下',
  ],
};
const LEX_DYNAMIC_LOCALIZATION_KEYS = [
  // Speed Test Inspector 运行阶段与范围。
  'Idle', 'Queued', 'Running', 'Discovering servers', 'Error',
  'GLOBAL', 'OVERSEAS', 'MAINLAND', 'CLI', 'LICENSE', 'NODE', 'TIMEOUT', 'NET',
  // PomoWave 阶段。
  'READY', 'FOCUS', 'PAUSED', 'SHORT', 'LONG', 'DONE',
  // Claude / ChatGPT 诊断映射与键面错误文案。
  'Stale (showing last values)', 'No Keychain credential', 'Credential expired',
  'Network failure', 'Rate limited', 'Not fetched yet', 'Unsupported platform',
  'No Claude Code credential in Keychain. Sign in from Terminal.',
  'The access token expired. Use Claude Code once to refresh it.',
  'The request failed or the API response changed.',
  'Requests are rate limited. Increase the polling interval.',
  'Sign in', 'Re-auth', 'Offline', 'Slow down', 'macOS only',
  'Codex executable not found', 'Not signed in', 'App server timed out', 'API call failed',
  'Install Codex CLI or enter its absolute path above.', 'Run codex login in Terminal.',
  'The app server did not respond in time. Increase Timeout.',
  'The API returned an error or an unrecognized response.',
  'No codex', 'codex login', 'Timeout',
  // Bambu 准备阶段。
  'Auto bed leveling', 'Heating the bed', 'Checking XY mechanics', 'Changing filament',
  'Waiting for motion', 'Paused: filament runout', 'Heating the nozzle',
  'Calibrating extrusion', 'Scanning the build plate', 'Checking the first layer',
  'Identifying the build plate', 'Calibrating micro lidar', 'Homing the toolhead',
  'Cleaning the nozzle', 'Checking extrusion temperature', 'Paused by user',
  'Paused: front cover issue', 'Calibrating lidar', 'Calibrating extrusion flow',
  'Nozzle temperature issue', 'Bed temperature issue', 'Preparation stage %s',
  // NAS 错误类型。
  'Authentication failed', 'Permission denied', 'API error',
  // System Status 动态生成的指标选项。
  'CPU usage', 'RAM usage', 'GPU usage', 'CPU temperature', 'Upload speed', 'Download speed',
  // MicroBreak 运行计划。
  'Eyes', 'Look far', 'Blink', 'Neck and shoulders', 'Chin tuck', 'Turn left', 'Turn right',
  'Shoulder blades', 'Wrists', 'Open and close', 'Left wrist', 'Right wrist', 'Stand',
  'Stand up', 'Heel raises', 'Walk', 'Breathing', 'Inhale', 'Exhale', 'Pelvic floor',
  'Contract', 'Relax',
];

test('adaptLocale keeps unknown locales as xx_YY so a language is a data-only add', () => {
  assert.equal(adaptLocale('en_US.UTF-8'), 'en');
  assert.equal(adaptLocale('zh_CN.UTF-8'), 'zh_CN');
  assert.equal(adaptLocale('zh_TW'), 'zh_HK');
  assert.equal(adaptLocale('zh'), 'zh_HK');
  assert.equal(adaptLocale('zh_CN'), 'zh_CN');
  // 未知 locale 不再被强制回退成 en——丢个 ja_JP.json / de_DE.json 就能用。
  assert.equal(adaptLocale('ja_JP.UTF-8'), 'ja_JP');
  assert.equal(adaptLocale('de-DE'), 'de_DE');
  assert.equal(adaptLocale(''), 'en');
});

test('resolveLocale reads the OS locale env with sensible precedence', () => {
  assert.equal(resolveLocale({ LANG: 'zh_CN.UTF-8' }), 'zh_CN');
  assert.equal(resolveLocale({ LC_ALL: 'ja_JP.UTF-8', LANG: 'en_US.UTF-8' }), 'ja_JP');
  assert.equal(resolveLocale({}), 'en');
});

for (const plugin of PLUGINS) {
  test(`[${plugin.name}] node i18n translates, falls back to English, then to the key`, () => {
    const zh = createI18n({ dir: plugin.dir, locale: 'zh_CN' });
    assert.equal(zh.locale, 'zh_CN');
    assert.equal(zh.t('see plugin log'), '详见插件日志');
    assert.equal(zh.t('a key that does not exist anywhere'), 'a key that does not exist anywhere');

    // 无对应语言文件时，整体回退英文表（而不是空/key）。
    const missing = createI18n({ dir: plugin.dir, locale: 'ja_JP' });
    assert.equal(missing.t('see plugin log'), 'see plugin log');

    const en = createI18n({ dir: plugin.dir, locale: 'en' });
    assert.equal(en.t('see plugin log'), 'see plugin log');
  });

  test(`[${plugin.name}] per-call language override beats the auto locale`, () => {
    // autoLocale=en，但调用方传入 uiLanguage='zh_CN' 时按中文出（运行态图标跟随实例语言）。
    const i18n = createI18n({ dir: plugin.dir, locale: 'en' });
    assert.equal(i18n.t('see plugin log', 'zh_CN'), '详见插件日志');
    assert.equal(i18n.t('see plugin log', 'en'), 'see plugin log');
    // 'auto'/空回落 autoLocale（此处 en）。
    assert.equal(i18n.t('see plugin log', 'auto'), 'see plugin log');
    assert.equal(i18n.t('see plugin log'), 'see plugin log');
    // 未知语言无文件 → 回退英文表。
    assert.equal(i18n.t('see plugin log', 'ja_JP'), 'see plugin log');
    // Language / Auto 两个语言选择器 key 存在并按语言解析。
    assert.equal(i18n.t('Auto', 'zh_CN'), '自动');
    assert.equal(i18n.t('Language', 'zh_CN'), '语言');
  });

  test(`[${plugin.name}] language files are complete: 4 sections, en/zh key parity, manifest alignment`, () => {
    const en = readJson(path.join(plugin.dir, 'en.json'));
    const zh = readJson(path.join(plugin.dir, 'zh_CN.json'));
    const manifest = readJson(path.join(plugin.dir, 'manifest.json'));

    for (const [label, doc] of [['en', en], ['zh_CN', zh]]) {
      assert.ok(typeof doc.Name === 'string' && doc.Name, `${label} missing Name`);
      assert.ok(typeof doc.Description === 'string' && doc.Description, `${label} missing Description`);
      assert.ok(Array.isArray(doc.Actions), `${label} missing Actions array`);
      assert.ok(doc.Localization && typeof doc.Localization === 'object', `${label} missing Localization`);
      // Actions[] 按 manifest 索引对齐，数量必须一致。
      assert.equal(doc.Actions.length, manifest.Actions.length, `${label} Actions length != manifest`);
      doc.Actions.forEach((action, index) => {
        assert.ok(action.Name, `${label} Actions[${index}] missing Name`);
        assert.ok(action.Tooltip, `${label} Actions[${index}] missing Tooltip`);
      });
      if (plugin.name === 'lex utility') {
        assert.deepEqual(
          doc.Actions.map((action) => action.Name),
          LEX_ACTION_NAMES[label],
          `${label} action names drifted from the product naming contract`,
        );
      }
    }

    // en 与 zh_CN 的 Localization key 集必须完全一致——缺 key 会在界面上漏出未翻译文案。
    const enKeys = Object.keys(en.Localization).sort();
    const zhKeys = Object.keys(zh.Localization).sort();
    assert.deepEqual(zhKeys, enKeys, `${plugin.name}: en/zh_CN Localization keys diverge`);

    // 运行态 key 必须存在（app.js 通过 node i18n 用它）。
    assert.ok('see plugin log' in en.Localization);
    assert.ok('see plugin log' in zh.Localization);
  });
}

test('browser i18n libs stay byte-identical between plugin and template', () => {
  for (const file of ['libs/js/utils.js', 'libs/js/ulanzideckApi.js', 'libs/node/i18n.js']) {
    assert.equal(
      fs.readFileSync(path.join(PLUGINS[0].dir, file), 'utf8'),
      fs.readFileSync(path.join(PLUGINS[1].dir, file), 'utf8'),
      `shared i18n lib drifted between plugin and template: ${file}`,
    );
  }
});

test('all Lex Utility action inspectors expose the shared language contract', () => {
  const dir = PLUGINS[0].dir;
  const localization = readJson(path.join(dir, 'en.json')).Localization;

  for (const actionKey of LEX_ACTION_KEYS) {
    const html = fs.readFileSync(path.join(dir, `property-inspector/${actionKey}.html`), 'utf8');
    const script = fs.readFileSync(path.join(dir, `property-inspector/${actionKey}.js`), 'utf8');

    assert.match(html, /<html lang="en">/, `${actionKey}: HTML default language must be English`);
    assert.match(html, /id="uiLanguage"/, `${actionKey}: missing #uiLanguage selector`);
    assert.match(script, /withLanguageField\(/, `${actionKey}: uiLanguage is not collected`);
    assert.match(script, /bindLanguageSelection\(/, `${actionKey}: language changes are not persisted`);
    assert.match(script, /REQUEST_SETTINGS_PARAM/, `${actionKey}: panel does not request authoritative settings`);

    const gestureNotes = [...html.matchAll(/<p class="pi-note gesture-note" data-localize=(["'])(.*?)\1>/g)];
    assert.equal(gestureNotes.length, 1, `${actionKey}: expected exactly one gesture note`);
    const gestureIndex = gestureNotes[0].index;
    const firstDividerIndex = html.indexOf('<hr class="pi-divider">');
    assert.ok(firstDividerIndex >= 0, `${actionKey}: missing common settings divider`);
    assert.ok(gestureIndex < firstDividerIndex, `${actionKey}: gesture note must precede the first common settings divider`);
    assert.match(gestureNotes[0][2], /^Single click:.* Double click:.* Long press:/, `${actionKey}: gesture note order is invalid`);

    for (const [, , rawKey] of html.matchAll(/data-localize=(["'])(.*?)\1/g)) {
      const key = rawKey.replaceAll('&amp;', '&');
      assert.ok(key in localization, `${actionKey}: missing HTML localization key: ${key}`);
    }
  }
});

test('all explicit and mapped Lex Utility action copy exists in both language tables', () => {
  const dir = PLUGINS[0].dir;
  const en = readJson(path.join(dir, 'en.json')).Localization;
  const zh = readJson(path.join(dir, 'zh_CN.json')).Localization;
  const referenced = new Set(LEX_DYNAMIC_LOCALIZATION_KEYS);

  for (const actionKey of LEX_ACTION_KEYS) {
    for (const relative of [
      `property-inspector/${actionKey}.js`,
      `plugin/actions/${actionKey}.js`,
    ]) {
      const source = fs.readFileSync(path.join(dir, relative), 'utf8');
      for (const match of source.matchAll(/(?:\$UD\.)?\bt\(\s*(["'])(.*?)\1/g)) {
        referenced.add(match[2]);
      }
    }
  }

  for (const key of referenced) {
    assert.ok(key in en, `en missing referenced localization key: ${key}`);
    assert.ok(key in zh, `zh_CN missing referenced localization key: ${key}`);
  }
});
