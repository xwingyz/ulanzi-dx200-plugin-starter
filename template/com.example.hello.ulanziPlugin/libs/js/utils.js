const Utils = {
  getQueryParams(name) {
    return new URLSearchParams(window.location.search).get(name);
  },
  getPluginPath() {
    return window.location.pathname.split('/property-inspector/')[0];
  },
  getLanguage() {
    return navigator.language || 'en';
  },
  adaptLanguage(language) {
    const value = String(language || 'en').replace('-', '_');
    if (value.startsWith('zh')) {
      return 'zh_CN';
    }
    return value.startsWith('en') ? 'en' : 'en';
  },
  async readJson(url) {
    const response = await fetch(url);
    return response.json();
  },
};
