const Utils = {
  getQueryParams(name) {
    return new URLSearchParams(window.location.search).get(name);
  },
  getPluginPath() {
    return window.location.pathname.split('/property-inspector/')[0];
  },
  getLanguage() {
    let userLanguage = navigator.languages && navigator.languages.length
      ? navigator.languages[0]
      : (navigator.language || navigator.userLanguage || 'en');
    if (userLanguage === 'zh') {
      userLanguage = 'zh_CN';
    } else if (userLanguage.indexOf('-') !== -1) {
      userLanguage = userLanguage.replace(/-/g, '_');
    }
    return this.adaptLanguage(userLanguage);
  },
  // 对齐官方 plugin-common-html：未知 locale 保留 `xx_YY` 形态，直接映射到
  // 同名 `<locale>.json`。新增语言 = 丢一个语言文件，无需改这里。
  adaptLanguage(language) {
    const value = String(language || 'en');
    if (value.indexOf('zh') === 0) {
      return value.indexOf('CN') > -1 ? 'zh_CN' : 'zh_HK';
    }
    if (value.indexOf('en') === 0) {
      return 'en';
    }
    return value.indexOf('-') !== -1 ? value.replace(/-/g, '_') : value;
  },
  async readJson(url) {
    const response = await fetch(url);
    return response.json();
  },
};
