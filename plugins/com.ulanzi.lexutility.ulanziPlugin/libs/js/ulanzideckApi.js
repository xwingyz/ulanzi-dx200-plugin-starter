/// <reference path="eventEmitter.js"/>
/// <reference path="utils.js"/>

class UlanziDeck {
  constructor() {
    this.key = '';
    this.uuid = '';
    this.actionid = '';
    this.websocket = null;
    this.language = 'en';
    this.localization = null;
    this.listeners = {};
    this.on = EventEmitter.on;
    this.emit = EventEmitter.emit;
  }

  connect(uuid) {
    this.port = Utils.getQueryParams('port') || 3906;
    this.address = Utils.getQueryParams('address') || '127.0.0.1';
    this.actionid = Utils.getQueryParams('actionid') || '';
    this.key = Utils.getQueryParams('key') || '';
    this.language = Utils.adaptLanguage(Utils.getQueryParams('language') || Utils.getLanguage());
    this.uuid = Utils.getQueryParams('uuid') || uuid || '';
    this.isMain = this.uuid.split('.').length === 4;

    if (this.websocket) {
      this.websocket.close();
      this.websocket = null;
    }

    this.websocket = new WebSocket(`ws://${this.address}:${this.port}`);

    this.websocket.onopen = () => {
      this.websocket.send(JSON.stringify({
        code: 0,
        cmd: Events.CONNECTED,
        actionid: this.actionid,
        key: this.key,
        uuid: this.uuid,
      }));
      this.emit(Events.CONNECTED, {});
      if (!this.isMain) {
        this.localizeUI();
      }
    };

    this.websocket.onerror = (error) => this.emit(Events.ERROR, error);
    this.websocket.onclose = () => this.emit(Events.CLOSE);

    this.websocket.onmessage = (event) => {
      const data = event?.data ? JSON.parse(event.data) : null;
      if (!data || (typeof data.code !== 'undefined' && data.cmdType !== 'REQUEST')) {
        return;
      }

      if (!this.key && data.uuid === this.uuid && data.key) {
        this.key = data.key;
      }
      if (!this.actionid && data.uuid === this.uuid && data.actionid) {
        this.actionid = data.actionid;
      }

      if (data.cmd === Events.CLEAR && Array.isArray(data.param)) {
        data.param.forEach((item) => {
          item.context = this.encodeContext(item);
        });
      } else {
        data.context = this.encodeContext(data);
      }

      this.emit(data.cmd, data);
    };
  }

  async localizeUI() {
    const wrapper = document.querySelector('.uspi-wrapper') || document.querySelector('.udpi-wrapper');
    if (!wrapper) {
      return;
    }
    if (!this.localization) {
      try {
        const json = await Utils.readJson(`${Utils.getPluginPath()}/${this.language}.json`);
        this.localization = json.Localization || null;
      } catch {
        this.localization = null;
      }
    }
    if (!this.localization) {
      return;
    }
    wrapper.querySelectorAll('[data-localize]').forEach((element) => {
      const key = element.dataset.localize;
      if (key && this.localization[key]) {
        element.textContent = this.localization[key];
      }
    });
  }

  encodeContext(data) {
    return `${data.uuid}___${data.key}___${data.actionid}`;
  }

  send(cmd, params = {}) {
    this.websocket?.send(JSON.stringify({
      cmd,
      uuid: this.uuid,
      key: this.key,
      actionid: this.actionid,
      ...params,
    }));
  }

  sendParamFromPlugin(settings, context) {
    const scoped = context ? this.decodeContext(context) : {};
    this.send(Events.PARAMFROMPLUGIN, {
      uuid: scoped.uuid || this.uuid,
      key: scoped.key || this.key,
      actionid: scoped.actionid || this.actionid,
      param: settings,
    });
  }

  decodeContext(context) {
    const [uuid, key, actionid] = String(context || '').split('___');
    return { uuid, key, actionid };
  }

  onConnected(handler) { this.on(Events.CONNECTED, handler); return this; }
  onParamFromApp(handler) { this.on(Events.PARAMFROMAPP, handler); return this; }
  onParamFromPlugin(handler) { this.on(Events.PARAMFROMPLUGIN, handler); return this; }
}

const $UD = new UlanziDeck();
