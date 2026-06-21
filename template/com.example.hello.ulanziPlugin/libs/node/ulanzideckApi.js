import WebSocket from 'ws';
import EventEmitter from 'node:events';
import { Events } from './constants.js';

class UlanzideckApi extends EventEmitter {
  constructor() {
    super();
    this.key = '';
    this.uuid = '';
    this.actionid = '';
    this.websocket = null;
  }

  connect(uuid, port = 3906, address = '127.0.0.1') {
    const [argvAddress, argvPort] = process.argv.slice(2);
    this.address = argvAddress || address;
    this.port = argvPort || port;
    this.uuid = uuid;

    if (this.websocket) {
      this.websocket.close();
      this.websocket = null;
    }

    const isMain = uuid.split('.').length === 4;
    this.websocket = new WebSocket(`ws://${this.address}:${this.port}`);

    this.websocket.onopen = () => {
      this.websocket.send(JSON.stringify({ code: 0, cmd: Events.CONNECTED, uuid }));
      this.emit(Events.CONNECTED, {});
    };

    this.websocket.onerror = (error) => {
      this.emit(Events.ERROR, error);
    };

    this.websocket.onclose = () => {
      this.emit(Events.CLOSE);
    };

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

      if (isMain) {
        this.send(data.cmd, { code: 0, ...data });
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

  encodeContext(data) {
    return `${data.uuid}___${data.key}___${data.actionid}`;
  }

  decodeContext(context) {
    const [uuid, key, actionid] = String(context || '').split('___');
    return { uuid, key, actionid };
  }

  send(cmd, params = {}) {
    this.websocket?.send(
      JSON.stringify({
        cmd,
        uuid: this.uuid,
        key: this.key,
        actionid: this.actionid,
        ...params,
      }),
    );
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

  setBaseDataIcon(context, dataUrl, text) {
    const { uuid, key, actionid } = this.decodeContext(context);
    this.send(Events.STATE, {
      param: {
        statelist: [
          {
            uuid,
            key,
            actionid,
            type: 1,
            data: dataUrl,
            textData: text || '',
            showtext: Boolean(text),
          },
        ],
      },
    });
  }

  toast(message) {
    this.send(Events.TOAST, { msg: message });
  }

  onConnected(handler) { this.on(Events.CONNECTED, handler); return this; }
  onClose(handler) { this.on(Events.CLOSE, handler); return this; }
  onError(handler) { this.on(Events.ERROR, handler); return this; }
  onAdd(handler) { this.on(Events.ADD, handler); return this; }
  onParamFromApp(handler) { this.on(Events.PARAMFROMAPP, handler); return this; }
  onParamFromPlugin(handler) { this.on(Events.PARAMFROMPLUGIN, handler); return this; }
  onRun(handler) { this.on(Events.RUN, handler); return this; }
  onSetActive(handler) { this.on(Events.SETACTIVE, handler); return this; }
  onClear(handler) { this.on(Events.CLEAR, handler); return this; }
}

export default UlanzideckApi;
