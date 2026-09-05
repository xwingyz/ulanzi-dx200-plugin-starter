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
    this.reconnectDelayMs = 5000;
    this.reconnectTimer = null;
  }

  connect(uuid, port = 3906, address = '127.0.0.1') {
    const [argvAddress, argvPort] = process.argv.slice(2);
    this.address = argvAddress || address;
    this.port = argvPort || port;
    this.uuid = uuid;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.websocket) {
      this.websocket.onerror = null;
      this.websocket.onclose = null;
      this.websocket.close();
      this.websocket = null;
    }

    const isMain = uuid.split('.').length === 4;
    const websocket = new WebSocket(`ws://${this.address}:${this.port}`);
    this.websocket = websocket;

    websocket.onopen = () => {
      websocket.send(JSON.stringify({ code: 0, cmd: Events.CONNECTED, uuid }));
      this.emit(Events.CONNECTED, {});
    };

    websocket.onerror = (error) => {
      console.error(
        `[UlanzideckApi] WebSocket 连接异常 ws://${this.address}:${this.port}: ${error?.message || error}`,
      );
      if (this.listenerCount(Events.ERROR) > 0) {
        this.emit(Events.ERROR, error);
      }
    };

    websocket.onclose = () => {
      this.emit(Events.CLOSE);
      if (this.websocket === websocket) {
        this.scheduleReconnect();
      }
    };

    websocket.onmessage = (event) => {
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

  scheduleReconnect() {
    if (this.reconnectTimer) {
      return;
    }
    console.error(
      `[UlanzideckApi] 未连接到宿主 ws://${this.address}:${this.port}，请先启动 Ulanzi Studio 或 Simulator，${this.reconnectDelayMs / 1000} 秒后自动重连`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(this.uuid, this.port, this.address);
    }, this.reconnectDelayMs);
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

  // 未验证。2026-09-05 在 3.3.8 上实测两轮，宿主日志里既没出现插件日志前缀、也没出现
  // `"cmd":"logMessage"`，没有观察到任何效果；但也无法断定是参数名错——宿主对不同命令在不同位置
  // 记日志（add 记在 pluginmanager.cpp:1168，paramfromplugin 记在 :1504 并附完整原始 JSON），
  // logMessage 很可能走的是一条根本不打日志的分支，所以「我们没发出去」和「宿主收下不记账」分不开。
  // 参数名 `message` 是按二进制里 `message`/`level` 成对出现推断的（toast 用的是 `msg`）。
  //
  // **不需要用它做插件日志落盘**：宿主自带机制——插件管理界面勾选「调试模式」后，
  // 插件进程的 stdout 会被原样捕获到 `logs/<插件UUID>/<插件UUID>_<PID>.log`，纯文本、按插件分文件、
  // 不用解码 xlog。详见 docs/development-rules.md。曾经接过一版 log() 转发到这里，
  // 因为零已证实收益又有行为改动，已回退。
  logMessage(message) {
    this.send(Events.LOGMESSAGE, { message: String(message) });
  }

  // 协议 V3.1.0 新增。2026-09-05 在 Ulanzi Studio 3.3.8 上核对了宿主二进制的命令表，结论分两半，
  // 别按「3.3.0+ 就全都能用」理解：
  //   - setFeedbackLayout / setFeedback 已在 JS 插件命令表里，可用。
  //   - setState / setImage / setTitle 只出现在 plugindef.cpp / pluginmanager.cpp 的 **native 插件**
  //     接口表（配套 onStateUpdate / onTitleUpdate / onRuntimeIconUpdate），JS 插件的命令表里没有，
  //     调了不会生效。运行态图标仍然只能走 setBaseDataIcon（Events.STATE）。
  // 核对方法：strings 宿主二进制，定位 `PluginJsManager::keyEvent` 之后那段入站命令表——
  // 3.3.8 的完整表是 paramfromplugin / openurl / openview / selectdialog / toast / logMessage /
  // sendToPropertyInspector / sendToPlugin / showAlert / setSettings / getSettings /
  // setGlobalSettings / getGlobalSettings / setFeedbackLayout / setFeedback / subscribeAiAgentState /
  // unsubscribeAiAgentState / getAiAgentProjects / getAiAgentSessions / didReceiveAiAgentState。
  // 换宿主版本后要重新核对这张表，不要直接信版本号。

  setState(context, state) {
    const { uuid, key, actionid } = this.decodeContext(context);
    this.send(Events.SETSTATE, {
      param: { uuid, key, actionid, state },
    });
  }

  setImage(context, options) {
    const { uuid, key, actionid } = this.decodeContext(context);
    this.send(Events.SETIMAGE, {
      param: { uuid, key, actionid, ...(options || {}) },
    });
  }

  setTitle(context, text) {
    const { uuid, key, actionid } = this.decodeContext(context);
    this.send(Events.SETTITLE, {
      param: { uuid, key, actionid, text },
    });
  }

  setFeedbackLayout(context, layout) {
    const { uuid, key, actionid } = this.decodeContext(context);
    this.send(Events.SETFEEDBACKLAYOUT, { uuid, key, actionid, layout });
  }

  setFeedback(context, layout) {
    const { uuid, key, actionid } = this.decodeContext(context);
    this.send(Events.SETFEEDBACK, { uuid, key, actionid, layout });
  }

  onConnected(handler) { this.on(Events.CONNECTED, handler); return this; }
  onClose(handler) { this.on(Events.CLOSE, handler); return this; }
  onError(handler) { this.on(Events.ERROR, handler); return this; }
  onAdd(handler) { this.on(Events.ADD, handler); return this; }
  onParamFromApp(handler) { this.on(Events.PARAMFROMAPP, handler); return this; }
  onParamFromPlugin(handler) { this.on(Events.PARAMFROMPLUGIN, handler); return this; }
  onRun(handler) { this.on(Events.RUN, handler); return this; }
  onKeyDown(handler) { this.on(Events.KEYDOWN, handler); return this; }
  onKeyUp(handler) { this.on(Events.KEYUP, handler); return this; }
  onSetActive(handler) { this.on(Events.SETACTIVE, handler); return this; }
  onClear(handler) { this.on(Events.CLEAR, handler); return this; }
}

export default UlanzideckApi;
