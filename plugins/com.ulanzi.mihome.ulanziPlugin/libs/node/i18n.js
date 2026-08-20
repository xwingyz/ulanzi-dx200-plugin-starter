import fs from 'node:fs';
import path from 'node:path';

// Node 侧运行态 i18n：与 PI 复用同一套 `<locale>.json`（Localization 段）。
// 语言优先级：调用方传入的显式 locale（来自 action 的 uiLanguage 设置）> OS locale。
// uiLanguage 为 'auto'/空时跟随 OS locale——宿主不向插件主进程下发语言，这是通行做法，
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

// dir 为插件根目录（语言文件与 libs/ 同级）。按需惰性加载各 locale 的 Localization 表。
// 译文缺失时按 目标语言 → 英文 → key 回退。
export function createI18n(options = {}) {
  const dir = options.dir;
  const fsImpl = options.fsImpl ?? fs;
  const autoLocale = options.locale ?? resolveLocale();
  const cache = new Map();

  const load = (loc) => {
    if (cache.has(loc)) {
      return cache.get(loc);
    }
    let table;
    try {
      const json = JSON.parse(fsImpl.readFileSync(path.join(dir, `${loc}.json`), 'utf8'));
      table = json.Localization || {};
    } catch {
      table = null;
    }
    cache.set(loc, table);
    return table;
  };

  // pref：显式 locale（如 'zh_CN'）；'auto'/空则跟随 autoLocale（OS）。
  const resolve = (pref) => (!pref || pref === 'auto' ? autoLocale : pref);

  return {
    autoLocale,
    locale: autoLocale,
    t(key, pref) {
      const table = load(resolve(pref)) || {};
      if (Object.prototype.hasOwnProperty.call(table, key)) {
        return table[key];
      }
      const en = load('en') || {};
      if (Object.prototype.hasOwnProperty.call(en, key)) {
        return en[key];
      }
      return key;
    },
  };
}
