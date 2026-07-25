import fs from 'node:fs';
import path from 'node:path';

// Node 侧运行态 i18n：与 PI 复用同一套 `<locale>.json`（Localization 段）。
// 宿主不向插件主进程下发语言，因此从 OS locale 解析——这是此类插件后端的通行做法，
// 通常与用户系统 UI 语言（也即宿主 UI 语言）一致；解析不到时回退英文。
// 规则与 libs/js/utils.js 的 adaptLanguage 对齐：未知 locale 保留 `xx_YY`。
export function adaptLocale(raw) {
  const value = String(raw || 'en').split('.')[0].replace(/-/g, '_');
  if (value.indexOf('zh') === 0) {
    return value.indexOf('CN') > -1 ? 'zh_CN' : 'zh_HK';
  }
  if (value.indexOf('en') === 0) {
    return 'en';
  }
  return value || 'en';
}

export function resolveLocale(env = process.env) {
  return adaptLocale(env.LC_ALL || env.LC_MESSAGES || env.LANG || 'en');
}

// dir 为插件根目录（语言文件与 libs/ 同级）。译文缺失时按 当前语言 → 英文 → key 回退。
export function createI18n(options = {}) {
  const dir = options.dir;
  const fsImpl = options.fsImpl ?? fs;
  const locale = options.locale ?? resolveLocale();

  const load = (loc) => {
    try {
      const json = JSON.parse(fsImpl.readFileSync(path.join(dir, `${loc}.json`), 'utf8'));
      return json.Localization || {};
    } catch {
      return null;
    }
  };

  const table = load(locale) || {};
  const fallback = locale === 'en' ? table : (load('en') || {});

  return {
    locale,
    t(key) {
      if (Object.prototype.hasOwnProperty.call(table, key)) {
        return table[key];
      }
      if (Object.prototype.hasOwnProperty.call(fallback, key)) {
        return fallback[key];
      }
      return key;
    },
  };
}
