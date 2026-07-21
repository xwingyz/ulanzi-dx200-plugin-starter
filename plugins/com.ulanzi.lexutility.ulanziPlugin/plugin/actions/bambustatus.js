import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect as mqttConnect } from 'mqtt';

const STATE_VERSION = 1;
const SSDP_HOST = '239.255.255.250';
const SSDP_PORT = 1990;
const MQTT_PORT = 8883;
const STATUS_TIMEOUT_MS = 12_000;
const REDRAW_MS = 30_000;
const COMPLETION_HOLD_MS = 3 * 60_000;
const RECONNECT_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000, 60_000];
const SCAN_PARAM = '__bambustatusScan';
const SCAN_RESULT_PARAM = '__bambustatusDiscovery';
const DIAG_PARAM = '__bambustatusDiag';
const BAMBU_MARK_PATH = 'M12.662 24V8.959l8.535 3.369V24zm-9.859-.003v-7.521l8.534-3.371-.001 10.892zM2.803 0h8.533l.001 11.672-8.534 3.369zm9.859 0h8.535v10.892l-8.535-3.371z';

const STAGE_LABELS = {
  1: '自动调平',
  2: '热床预热',
  3: '检测 XY 机构',
  4: '更换耗材',
  5: '等待运动完成',
  6: '耗材用尽暂停',
  7: '喷嘴加热',
  8: '校准挤出',
  9: '扫描打印平台',
  10: '检查首层',
  11: '识别打印板',
  12: '校准微型雷达',
  13: '工具头归位',
  14: '清洁喷嘴',
  15: '检查挤出温度',
  16: '用户暂停',
  17: '前盖异常暂停',
  18: '校准雷达',
  19: '校准挤出流量',
  20: '喷嘴温度异常',
  21: '热床温度异常',
};

const MODEL_NAMES = {
  N2S: 'P2S',
  P2S: 'P2S',
};

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clipText(value, maxLength) {
  const text = cleanString(value);
  return text.length > maxLength ? `${text.slice(0, Math.max(1, maxLength - 1))}…` : text;
}

function normalizeModel(value) {
  const raw = cleanString(value);
  return MODEL_NAMES[raw.toUpperCase()] || raw;
}

function isCompleteSettings(settings = {}) {
  return Boolean(cleanString(settings.printerIp)
    && cleanString(settings.serialNumber)
    && cleanString(settings.accessCode));
}

function shouldConnectOnReady(instance) {
  return !instance.mqttClient;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampPercent(value) {
  const number = finiteNumber(value);
  return number == null ? null : Math.max(0, Math.min(100, Math.round(number)));
}

function parseStartTime(value) {
  const number = finiteNumber(value);
  if (number == null || number <= 0) {
    return null;
  }
  return number > 1e12 ? number : number * 1000;
}

function deriveTimes(print = {}, now = Date.now()) {
  const remainingMinutes = finiteNumber(print.mc_remaining_time);
  const remainingSec = remainingMinutes == null ? null : Math.max(0, Math.round(remainingMinutes * 60));
  const startedAt = parseStartTime(print.gcode_start_time);
  let elapsedSec = startedAt == null ? null : Math.max(0, Math.round((now - startedAt) / 1000));
  const progress = clampPercent(print.mc_percent);
  if (elapsedSec == null && remainingSec != null && progress != null && progress > 0 && progress < 100) {
    const totalSec = remainingSec / (1 - progress / 100);
    elapsedSec = Math.max(0, Math.round(totalSec - remainingSec));
  }
  return { elapsedSec, remainingSec };
}

function stageLabel(print = {}) {
  const stage = finiteNumber(print.mc_print_stage ?? print.stg_cur);
  if (stage != null && STAGE_LABELS[stage]) {
    return STAGE_LABELS[stage];
  }
  const raw = cleanString(print.stg_cur_name || print.stage_name || print.print_stage);
  if (raw) {
    return raw;
  }
  return stage != null && stage > 0 ? `准备阶段 ${stage}` : '准备打印';
}

function resolvePrintState(print = {}) {
  const raw = cleanString(print.gcode_state).toUpperCase();
  const stage = finiteNumber(print.mc_print_stage);
  if (['FINISH', 'FINISHED', 'SUCCESS', 'COMPLETED', 'COMPLETE'].includes(raw)) return 'FINISHED';
  if (['FAILED', 'ERROR'].includes(raw)) return 'FAILED';
  if (['PAUSE', 'PAUSED'].includes(raw)) return 'PAUSED';
  if (['PREPARE', 'PREPARING', 'SLICING'].includes(raw)) return 'PREPARING';
  if (['RUNNING', 'PRINTING'].includes(raw)) {
    return stage != null && stage > 0 && clampPercent(print.mc_percent) === 0 ? 'PREPARING' : 'RUNNING';
  }
  if (['IDLE', 'READY', ''].includes(raw)) return stage != null && stage > 0 ? 'PREPARING' : 'IDLE';
  return stage != null && stage > 0 ? 'PREPARING' : 'IDLE';
}

function mergePrint(previous = {}, incoming = {}) {
  const result = { ...previous };
  Object.entries(incoming || {}).forEach(([key, value]) => {
    if (value && typeof value === 'object' && !Array.isArray(value)
      && result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = mergePrint(result[key], value);
    } else {
      result[key] = value;
    }
  });
  return result;
}

function serializeSnapshot(instance) {
  return {
    v: STATE_VERSION,
    completedSnapshot: instance.completedSnapshot || null,
    suppressFinishedUntilNextTask: Boolean(instance.suppressFinishedUntilNextTask),
  };
}

function completionExpiryDelay(snapshot, now = Date.now()) {
  const completedAt = finiteNumber(snapshot?.completedAt);
  if (completedAt == null) return 0;
  return Math.max(0, completedAt + COMPLETION_HOLD_MS - now);
}

function hydrateSnapshot(raw, now = Date.now()) {
  if (!raw || raw.v !== STATE_VERSION) {
    return {};
  }
  let completedSnapshot = raw.completedSnapshot && typeof raw.completedSnapshot === 'object'
    ? raw.completedSnapshot
    : null;
  const expired = completedSnapshot && completionExpiryDelay(completedSnapshot, now) === 0;
  if (expired) completedSnapshot = null;
  return {
    completedSnapshot,
    completionLatched: Boolean(completedSnapshot),
    suppressFinishedUntilNextTask: expired || Boolean(raw.suppressFinishedUntilNextTask),
  };
}

function parseSsdpPacket(buffer, remote = {}) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
  const headers = {};
  text.split(/\r?\n/).slice(1).forEach((line) => {
    const splitAt = line.indexOf(':');
    if (splitAt > 0) headers[line.slice(0, splitAt).trim().toLowerCase()] = line.slice(splitAt + 1).trim();
  });
  const location = headers.location || '';
  let printerIp = cleanString(remote.address);
  if (location) {
    try {
      printerIp = new URL(location.includes('://') ? location : `http://${location}`).hostname || printerIp;
    } catch {}
  }
  const usn = headers.usn || '';
  const serialNumber = cleanString(headers['serial-number'] || headers['serial_number']
    || headers['devserial.bambu.com'] || usn.replace(/^uuid:/i, '').split('::')[0]);
  const model = normalizeModel(headers['devmodel.bambu.com'] || headers['dev-model'] || headers.model);
  const name = cleanString(headers['devname.bambu.com'] || headers['dev-name'] || headers.name);
  if (!printerIp && !serialNumber) return null;
  return { printerIp, serialNumber, model, name };
}

function bambuConfigPaths(options = {}) {
  const platform = options.platform || process.platform;
  const homeDir = options.homeDir || os.homedir();
  if (platform === 'darwin') {
    return [
      path.join(homeDir, 'Library/Application Support/BambuStudio/BambuStudio.conf'),
      path.join(homeDir, 'Library/Application Support/BambuStudioBeta/BambuStudio.conf'),
    ];
  }
  if (platform === 'win32') {
    const appData = options.appData || process.env.APPDATA || path.join(homeDir, 'AppData/Roaming');
    return [path.join(appData, 'BambuStudio/BambuStudio.conf')];
  }
  return [];
}

function readBambuStudioAccessCodes(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const found = new Map();
  bambuConfigPaths(options).forEach((configPath) => {
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(configPath, 'utf8'));
      const codes = parsed.access_code;
      if (!codes || typeof codes !== 'object' || Array.isArray(codes)) return;
      Object.entries(codes).forEach(([serialNumber, accessCode]) => {
        if (cleanString(serialNumber) && cleanString(accessCode)) {
          const serial = cleanString(serialNumber);
          if (!found.has(serial)) {
            found.set(serial, {
              serialNumber: serial,
              accessCode: cleanString(accessCode),
              source: path.basename(path.dirname(configPath)),
            });
          }
        }
      });
    } catch {
      // 未安装、未登录或配置格式变化都只意味着自动填充不可用。
    }
  });
  return [...found.values()];
}

function mergeDiscovery(accessCodes, devices, hint = {}) {
  const bySerial = new Map(devices.filter(Boolean).map((device) => [device.serialNumber, device]));
  const candidates = accessCodes.map((entry) => ({ ...entry, ...(bySerial.get(entry.serialNumber) || {}) }));
  devices.forEach((device) => {
    if (!candidates.some((candidate) => candidate.serialNumber === device.serialNumber)) candidates.push(device);
  });
  const hintedSerial = cleanString(hint.serialNumber);
  const selected = candidates.find((candidate) => candidate.serialNumber === hintedSerial)
    || candidates.find((candidate) => normalizeModel(candidate.model) === 'P2S')
    || candidates[0]
    || null;
  return selected ? {
    printerIp: cleanString(selected.printerIp || hint.printerIp),
    serialNumber: cleanString(selected.serialNumber || hint.serialNumber),
    accessCode: cleanString(selected.accessCode || hint.accessCode),
    printerName: cleanString(selected.name || hint.printerName),
    model: normalizeModel(selected.model),
    name: cleanString(selected.name),
  } : null;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '--';
  const totalMinutes = Math.max(0, Math.floor(seconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours}h${String(minutes).padStart(2, '0')}` : `${minutes}m`;
}

function formatAge(timestamp, now = Date.now()) {
  if (!Number.isFinite(timestamp)) return '尚无数据';
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s 前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m 前`;
  return `${Math.floor(seconds / 3600)}h 前`;
}

export function createBambuStatusAction(runtime) {
  const {
    clearInstanceTimeout,
    escapeXml,
    frameContent,
    frameFor,
    frameHighlight,
    normalizeChoice,
    persistSettings,
    readPersistedState,
    renderInstance,
    renderMeterRow,
    renderThemeBackdrop,
    sendParamFromPlugin,
    setInstanceTimeout,
    themeFor,
    toDataUrl,
    writePersistedState,
  } = runtime;

  function flushSnapshot(instance) {
    if (!instance.context) return false;
    return writePersistedState(instance.context, serializeSnapshot(instance));
  }

  function closeDiscovery(instance) {
    if (!instance.discoverySocket) return;
    try { instance.discoverySocket.close(); } catch {}
    instance.discoverySocket = null;
    clearInstanceTimeout(instance, 'bambustatusScan');
  }

  function closeClient(instance) {
    instance.connectionGeneration += 1;
    clearInstanceTimeout(instance, 'bambustatusStatusTimeout');
    if (instance.mqttClient) {
      try { instance.mqttClient.end(true); } catch {}
      instance.mqttClient = null;
    }
  }

  function scheduleRedraw(instance) {
    setInstanceTimeout(instance, 'bambustatusRedraw', () => {
      renderInstance(instance);
      scheduleRedraw(instance);
    }, REDRAW_MS);
  }

  function requestCurrentStatus(instance) {
    const serial = cleanString(instance.settings.serialNumber);
    if (!serial || !instance.mqttClient?.connected) return false;
    instance.mqttClient.publish(`device/${serial}/request`, JSON.stringify({
      pushing: { sequence_id: String(Date.now()), command: 'pushall' },
    }), { qos: 0 });
    return true;
  }

  function clearCompletion(instance) {
    clearInstanceTimeout(instance, 'bambustatusCompletionExpiry');
    instance.completedSnapshot = null;
    instance.completionLatched = false;
    instance.suppressFinishedUntilNextTask = true;
    if (instance.liveStatus === 'FINISHED') instance.liveStatus = 'IDLE';
    flushSnapshot(instance);
    renderInstance(instance);
  }

  function refreshCurrentStatus(instance) {
    clearCompletion(instance);
    if (!requestCurrentStatus(instance)) connectPrinter(instance);
  }

  function scheduleCompletionExpiry(instance, now = Date.now()) {
    clearInstanceTimeout(instance, 'bambustatusCompletionExpiry');
    if (!instance.completionLatched || !instance.completedSnapshot) return;
    const delay = completionExpiryDelay(instance.completedSnapshot, now);
    if (delay === 0) {
      refreshCurrentStatus(instance);
      return;
    }
    setInstanceTimeout(instance, 'bambustatusCompletionExpiry', () => {
      refreshCurrentStatus(instance);
    }, delay);
  }

  function scheduleReconnect(instance) {
    if (!isCompleteSettings(instance.settings) || instance.active === false) return;
    const index = Math.min(instance.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1);
    instance.reconnectAttempt += 1;
    setInstanceTimeout(instance, 'bambustatusReconnect', () => connectPrinter(instance), RECONNECT_DELAYS_MS[index]);
  }

  function snapshotFromInstance(instance) {
    return {
      status: 'FINISHED',
      model: instance.model,
      taskName: instance.taskName,
      stage: instance.stage,
      progress: instance.progress ?? 100,
      elapsedSec: instance.elapsedSec,
      remainingSec: 0,
      completedAt: instance.lastSeenAt || Date.now(),
    };
  }

  function applyPrintReport(instance, report, now = Date.now()) {
    instance.print = mergePrint(instance.print, report);
    const print = instance.print;
    let nextStatus = resolvePrintState(print);
    const { elapsedSec, remainingSec } = deriveTimes(print, now);
    instance.model = normalizeModel(print.dev_model_name || print.dev_model || print.model || instance.model) || 'P2S';
    instance.taskName = cleanString(print.subtask_name || print.gcode_file || instance.taskName);
    instance.stage = stageLabel(print);
    instance.progress = clampPercent(print.mc_percent);
    instance.elapsedSec = elapsedSec;
    instance.remainingSec = remainingSec;
    instance.lastSeenAt = now;
    instance.connectionState = 'ONLINE';
    instance.statusReceived = true;
    clearInstanceTimeout(instance, 'bambustatusStatusTimeout');

    if (['RUNNING', 'PREPARING'].includes(nextStatus)) {
      instance.suppressFinishedUntilNextTask = false;
    }
    if (instance.completionLatched && ['RUNNING', 'PREPARING'].includes(nextStatus)) {
      clearInstanceTimeout(instance, 'bambustatusCompletionExpiry');
      instance.completionLatched = false;
      instance.completedSnapshot = null;
      flushSnapshot(instance);
    }
    if (nextStatus === 'FINISHED' && instance.suppressFinishedUntilNextTask) {
      nextStatus = 'IDLE';
    }
    instance.liveStatus = nextStatus;
    if (nextStatus === 'FINISHED' && !instance.completionLatched) {
      instance.completedSnapshot = snapshotFromInstance(instance);
      instance.completionLatched = true;
      flushSnapshot(instance);
      scheduleCompletionExpiry(instance, now);
    }
  }

  function markOffline(instance, reason = '连接中断') {
    instance.connectionState = 'OFFLINE';
    instance.diagnostic = reason;
    instance.reportedOnline = false;
    sendParamFromPlugin({ [DIAG_PARAM]: { state: 'offline', message: reason } }, instance.context);
    renderInstance(instance);
    scheduleReconnect(instance);
  }

  function safeNetwork(instance, generation, fn) {
    return (...args) => {
      if (generation !== instance.connectionGeneration || instance.active === false) return;
      try { fn(...args); } catch { markOffline(instance, '状态解析失败'); }
    };
  }

  function connectPrinter(instance, options = {}) {
    const connect = options.connect || mqttConnect;
    clearInstanceTimeout(instance, 'bambustatusReconnect');
    closeClient(instance);
    if (!isCompleteSettings(instance.settings)) {
      instance.connectionState = 'CONFIG_REQUIRED';
      renderInstance(instance);
      return;
    }
    const generation = instance.connectionGeneration;
    instance.connectionState = 'CONNECTING';
    instance.statusReceived = false;
    instance.diagnostic = '';
    renderInstance(instance);
    const serial = cleanString(instance.settings.serialNumber);
    const topic = `device/${serial}/report`;
    let client;
    try {
      client = connect(`mqtts://${cleanString(instance.settings.printerIp)}:${MQTT_PORT}`, {
        username: 'bblp',
        password: cleanString(instance.settings.accessCode),
        rejectUnauthorized: false,
        reconnectPeriod: 0,
        connectTimeout: 8_000,
        keepalive: 60,
        clean: true,
        clientId: `lex-bambu-${process.pid}-${Math.random().toString(16).slice(2, 10)}`,
      });
    } catch {
      markOffline(instance, '无法建立连接');
      return;
    }
    instance.mqttClient = client;
    client.on('connect', safeNetwork(instance, generation, () => {
      instance.reconnectAttempt = 0;
      client.subscribe(topic, { qos: 0 }, safeNetwork(instance, generation, (error) => {
        if (error) { markOffline(instance, '订阅状态失败'); return; }
        requestCurrentStatus(instance);
        setInstanceTimeout(instance, 'bambustatusStatusTimeout', () => {
          if (!instance.statusReceived) {
            instance.connectionState = 'INCOMPATIBLE';
            instance.diagnostic = '当前打印机模式未开放本地状态订阅';
            sendParamFromPlugin({
              [DIAG_PARAM]: { state: 'incompatible', message: instance.diagnostic },
            }, instance.context);
            closeClient(instance);
            renderInstance(instance);
          }
        }, STATUS_TIMEOUT_MS);
      }));
    }));
    client.on('message', safeNetwork(instance, generation, (receivedTopic, payload) => {
      if (receivedTopic !== topic) return;
      let message;
      try { message = JSON.parse(payload.toString('utf8')); } catch { return; }
      if (!message.print || typeof message.print !== 'object') return;
      applyPrintReport(instance, message.print);
      if (!instance.reportedOnline) {
        instance.reportedOnline = true;
        sendParamFromPlugin({ [DIAG_PARAM]: { state: 'online', message: '已收到实时状态' } }, instance.context);
      }
      renderInstance(instance);
    }));
    client.on('error', safeNetwork(instance, generation, () => {
      closeClient(instance);
      markOffline(instance, '认证或网络连接失败');
    }));
    client.on('close', safeNetwork(instance, generation, () => {
      if (instance.connectionState !== 'INCOMPATIBLE') markOffline(instance, '连接已断开');
    }));
  }

  function discoverDevices(instance, options = {}) {
    const createSocket = options.createSocket || ((socketOptions) => dgram.createSocket(socketOptions));
    const timeoutMs = options.timeoutMs || 3_500;
    closeDiscovery(instance);
    return new Promise((resolve) => {
      const devices = new Map();
      let settled = false;
      let socket;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearInstanceTimeout(instance, 'bambustatusScan');
        if (instance.discoverySocket === socket) instance.discoverySocket = null;
        try { socket?.close(); } catch {}
        resolve([...devices.values()]);
      };
      try {
        socket = createSocket({ type: 'udp4', reuseAddr: true });
        instance.discoverySocket = socket;
        socket.on('message', (message, remote) => {
          const device = parseSsdpPacket(message, remote);
          if (device) devices.set(device.serialNumber || device.printerIp, device);
        });
        socket.on('error', finish);
        socket.bind(SSDP_PORT, () => {
          try { socket.addMembership(SSDP_HOST); } catch {}
          const request = Buffer.from([
            'M-SEARCH * HTTP/1.1',
            `HOST:${SSDP_HOST}:${SSDP_PORT}`,
            'MAN:"ssdp:discover"',
            'MX:2',
            'ST:urn:bambulab-com:device:3dprinter:1',
            '', '',
          ].join('\r\n'));
          socket.send(request, SSDP_PORT, SSDP_HOST, () => {});
        });
        setInstanceTimeout(instance, 'bambustatusScan', finish, timeoutMs);
      } catch {
        finish();
      }
    });
  }

  async function runDiscovery(instance, hint = {}, options = {}) {
    const accessCodes = (options.readAccessCodes || readBambuStudioAccessCodes)();
    const devices = await (options.discover || discoverDevices)(instance);
    const selected = mergeDiscovery(accessCodes, devices, hint);
    const complete = Boolean(selected && isCompleteSettings(selected));
    if (selected?.model) instance.model = selected.model;
    if (selected) {
      const previousSettings = instance.settings;
      const discoveredSettings = Object.fromEntries(
        ['printerIp', 'serialNumber', 'accessCode', 'printerName']
          .filter((key) => cleanString(selected[key]))
          .map((key) => [key, selected[key]]),
      );
      instance.settings = { ...instance.settings, ...discoveredSettings };
      persistSettings(instance);
      const connectionChanged = ['printerIp', 'serialNumber', 'accessCode']
        .some((key) => previousSettings[key] !== instance.settings[key]);
      if (connectionChanged && isCompleteSettings(instance.settings)) {
        connectPrinter(instance);
      }
    }
    sendParamFromPlugin({
      [SCAN_RESULT_PARAM]: {
        status: complete ? 'found' : selected ? 'partial' : 'not_found',
        model: selected?.model || '',
        settings: selected ? {
          printerIp: instance.settings.printerIp,
          serialNumber: instance.settings.serialNumber,
          accessCode: instance.settings.accessCode,
          printerName: instance.settings.printerName,
        } : {},
      },
    }, instance.context);
    return selected;
  }

  function displayData(instance) {
    return instance.completionLatched && instance.completedSnapshot
      ? instance.completedSnapshot
      : {
        status: instance.liveStatus,
        model: instance.model,
        taskName: instance.taskName,
        stage: instance.stage,
        progress: instance.progress,
        elapsedSec: instance.elapsedSec,
        remainingSec: instance.remainingSec,
      };
  }

  function renderBambuStatus(instance) {
    const settings = instance.settings;
    const theme = themeFor(settings);
    const frame = frameFor(settings);
    const background = renderThemeBackdrop(theme, theme.accent, frame);
    const data = displayData(instance);
    const printerName = clipText(settings.printerName, 12);
    const status = data.status || 'IDLE';
    const progress = data.progress == null ? 0 : data.progress;
    const labels = {
      IDLE: ['空闲', '等待新任务'],
      PREPARING: ['准备中', data.stage || '准备打印'],
      PAUSED: ['已暂停', data.stage || '打印暂停'],
      FINISHED: ['已完成', data.taskName || '打印任务'],
      FAILED: ['打印失败', data.stage || '请检查打印机'],
    };
    let body = '';
    if (instance.connectionState === 'CONFIG_REQUIRED') {
      body = `<text x="128" y="143" text-anchor="middle" fill="${theme.text}" font-size="34" font-weight="750">待配置</text><text x="128" y="177" text-anchor="middle" fill="${theme.muted}" font-size="17">打开属性面板自动扫描</text>`;
    } else if (instance.connectionState === 'CONNECTING') {
      body = `<text x="128" y="143" text-anchor="middle" fill="${theme.text}" font-size="34" font-weight="750">连接中</text><text x="128" y="177" text-anchor="middle" fill="${theme.muted}" font-size="17">正在读取打印机状态</text>`;
    } else if (instance.connectionState === 'INCOMPATIBLE') {
      body = `<text x="128" y="137" text-anchor="middle" fill="${theme.warn}" font-size="27" font-weight="750">本地状态不可用</text><text x="128" y="174" text-anchor="middle" fill="${theme.muted}" font-size="16">保留云端模式</text><text x="128" y="198" text-anchor="middle" fill="${theme.muted}" font-size="16">不自动切换</text>`;
    } else if (instance.connectionState === 'OFFLINE') {
      body = `<text x="128" y="143" text-anchor="middle" fill="${theme.crit}" font-size="36" font-weight="800">未连接</text><text x="128" y="181" text-anchor="middle" fill="${theme.muted}" font-size="17">上次更新 ${escapeXml(formatAge(instance.lastSeenAt))}</text>`;
    } else if (status === 'RUNNING') {
      body = `
        ${renderMeterRow(
          { x: 43, y: 116, width: 170, height: 51 },
          theme,
          { percent: progress, color: theme.accent, value: `${progress}%`, showBar: true },
        )}
        <text x="46" y="205" text-anchor="start" fill="${theme.text}" font-size="25" font-weight="800">T ${formatDuration(data.elapsedSec)}</text>
        <text x="210" y="205" text-anchor="end" fill="${theme.text}" font-size="25" font-weight="800">R ${formatDuration(data.remainingSec)}</text>`;
    } else {
      const [primary, secondary] = labels[status] || labels.IDLE;
      body = `
        <text x="128" y="137" text-anchor="middle" fill="${status === 'FAILED' ? theme.crit : theme.text}" font-size="36" font-weight="800">${escapeXml(primary)}</text>
        <text x="128" y="172" text-anchor="middle" fill="${theme.muted}" font-size="18" font-weight="600">${escapeXml(clipText(secondary, 14))}</text>
        ${['PREPARING', 'PAUSED'].includes(status) ? `<text x="128" y="207" text-anchor="middle" fill="${theme.text}" font-size="17" font-weight="650">${progress}% · 用 ${formatDuration(data.elapsedSec)} · 余 ${formatDuration(data.remainingSec)}</text>` : ''}
        ${status === 'FINISHED' ? `<text x="128" y="207" text-anchor="middle" fill="${theme.text}" font-size="17" font-weight="650">100% · 用 ${formatDuration(data.elapsedSec)}</text>` : ''}`;
    }
    const highlightColor = instance.connectionState === 'OFFLINE' || status === 'FAILED'
      ? theme.crit
      : instance.connectionState === 'INCOMPATIBLE' ? theme.warn : theme.accent;
    return toDataUrl(`
      <svg width="392" height="392" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg" font-family="Arial, Helvetica, sans-serif">
        ${background.outer}
        ${frameContent(frame, `
          ${['OFFLINE', 'INCOMPATIBLE'].includes(instance.connectionState) || status === 'FAILED' ? frameHighlight(frameFor({ ...settings, frameSize: 'optimal' }), highlightColor, 0.75) : ''}
          <g transform="translate(43 46) scale(1.5833)"><path d="${BAMBU_MARK_PATH}" fill="#00AE42"/></g>
          ${printerName ? `<text x="213" y="72" text-anchor="end" fill="${theme.text}" font-size="23" font-weight="800">${escapeXml(printerName)}</text>` : ''}
          <line x1="43" y1="94" x2="213" y2="94" stroke="${theme.low}" stroke-width="1.8" opacity="0.6"/>
          ${body}
        `)}
      </svg>`);
  }

  const config = {
    defaults: {
      printerName: '', printerIp: '', serialNumber: '', accessCode: '', theme: 'mint', frameSize: 'optimal', showFrame: 'true',
    },
    normalizeSettings: (settings) => ({
      printerName: cleanString(settings.printerName).slice(0, 40),
      printerIp: cleanString(settings.printerIp),
      serialNumber: cleanString(settings.serialNumber),
      accessCode: cleanString(settings.accessCode),
      theme: normalizeChoice(settings.theme, 'mint', ['mint', 'ember', 'mono', 'signal', 'neon', 'ice', 'sunset', 'forest', 'sand']),
    }),
    createState: (instance) => ({
      connectionState: 'CONFIG_REQUIRED', liveStatus: 'IDLE', model: '', taskName: '', stage: '',
      progress: null, elapsedSec: null, remainingSec: null, lastSeenAt: null, print: {}, mqttClient: null,
      discoverySocket: null, connectionGeneration: 0, reconnectAttempt: 0, statusReceived: false, diagnostic: '',
      completedSnapshot: null, completionLatched: false, suppressFinishedUntilNextTask: false,
      autoScanStarted: false, reportedOnline: false, ...hydrateSnapshot(readPersistedState(instance.context)),
    }),
    onRun: (instance) => refreshCurrentStatus(instance),
    onReady: async (instance) => {
      scheduleRedraw(instance);
      scheduleCompletionExpiry(instance);
      if (isCompleteSettings(instance.settings)) {
        return shouldConnectOnReady(instance) ? connectPrinter(instance) : undefined;
      }
      instance.connectionState = 'CONFIG_REQUIRED';
      renderInstance(instance);
      if (instance.autoScanStarted) return undefined;
      instance.autoScanStarted = true;
      return runDiscovery(instance, instance.settings);
    },
    onSettingsChanged: (instance, previousSettings) => {
      const connectionChanged = ['printerIp', 'serialNumber', 'accessCode']
        .some((key) => previousSettings[key] !== instance.settings[key]);
      if (connectionChanged) connectPrinter(instance);
    },
    onParamFromPlugin: (instance, payload) => {
      if (payload?.[SCAN_PARAM]) return runDiscovery(instance, payload[SCAN_PARAM]);
      return undefined;
    },
    onDispose: (instance) => {
      closeClient(instance);
      closeDiscovery(instance);
      clearInstanceTimeout(instance, 'bambustatusReconnect');
      clearInstanceTimeout(instance, 'bambustatusRedraw');
      clearInstanceTimeout(instance, 'bambustatusCompletionExpiry');
      flushSnapshot(instance);
    },
    render: renderBambuStatus,
  };

  return {
    key: 'bambustatus',
    config,
    testing: {
      applyPrintReport,
      completionExpiryDelay,
      deriveTimes,
      formatAge,
      formatDuration,
      hydrateSnapshot,
      isCompleteSettings,
      mergeDiscovery,
      parseSsdpPacket,
      readBambuStudioAccessCodes,
      resolvePrintState,
      shouldConnectOnReady,
      stageLabel,
    },
  };
}
