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
