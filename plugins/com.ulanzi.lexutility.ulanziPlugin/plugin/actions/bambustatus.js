import dgram from 'node:dgram';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect as mqttConnect } from 'mqtt';

const STATE_VERSION = 1;
const SSDP_HOST = '239.255.255.250';
const SSDP_PORT = 1990;
const MQTT_PORT = 8883;
const STATUS_TIMEOUT_MS = 12_000;
const ACTIVE_REFRESH_MS = 10_000;
const PASSIVE_REDRAW_MS = 30_000;
const COMPLETION_HOLD_MS = 3 * 60_000;
const MANUAL_REFRESH_FEEDBACK_MS = 650;
const RECONNECT_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000, 60_000];
const STATUS_TEXT_MAX_WIDTH = 164;
const STATUS_FONT_SIZES = [34, 32, 30, 28, 26, 24, 22, 20, 18];
const SCAN_PARAM = '__bambustatusScan';
const SCAN_RESULT_PARAM = '__bambustatusDiscovery';
const DIAG_PARAM = '__bambustatusDiag';
const BAMBU_MARK_PATH = 'M12.662 24V8.959l8.535 3.369V24zm-9.859-.003v-7.521l8.534-3.371-.001 10.892zM2.803 0h8.533l.001 11.672-8.534 3.369zm9.859 0h8.535v10.892l-8.535-3.371z';
const MAKERWORLD_URLS = Object.freeze({
  global: 'https://makerworld.com/',
  china: 'https://makerworld.com.cn/',
});

const STAGE_LABELS = {
  1: 'Auto bed leveling',
  2: 'Heating the bed',
  3: 'Checking XY mechanics',
  4: 'Changing filament',
  5: 'Waiting for motion',
  6: 'Paused: filament runout',
  7: 'Heating the nozzle',
  8: 'Calibrating extrusion',
  9: 'Scanning the build plate',
  10: 'Checking the first layer',
  11: 'Identifying the build plate',
  12: 'Calibrating micro lidar',
  13: 'Homing the toolhead',
  14: 'Cleaning the nozzle',
  15: 'Checking extrusion temperature',
  16: 'Paused by user',
  17: 'Paused: front cover issue',
  18: 'Calibrating lidar',
  19: 'Calibrating extrusion flow',
  20: 'Nozzle temperature issue',
  21: 'Bed temperature issue',
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

function statusGlyphUnits(character) {
  if (/\s/.test(character)) return 0.28;
  if (/[ilIjtfr1]/.test(character)) return 0.32;
  if (/[MW@%]/.test(character)) return 0.9;
  if (/[A-Z]/.test(character)) return 0.68;
  if (/[0-9]/.test(character)) return 0.58;
  if (/[\u0000-\u007f]/.test(character)) return 0.56;
  return 1;
}

function estimateStatusTextWidth(value, fontSize) {
  const units = [...cleanString(value)]
    .reduce((sum, character) => sum + statusGlyphUnits(character), 0);
  return units * Number(fontSize) * 1.05;
}

function truncateStatusText(value, fontSize, maxWidth = STATUS_TEXT_MAX_WIDTH) {
  const text = cleanString(value);
  if (estimateStatusTextWidth(text, fontSize) <= maxWidth) return text;
  let fitted = '';
  for (const character of text) {
    if (estimateStatusTextWidth(`${fitted}${character}…`, fontSize) > maxWidth) break;
    fitted += character;
  }
  return `${fitted}…`;
}

function fitStatusText(value) {
  const text = cleanString(value);
  const fontSize = STATUS_FONT_SIZES.find(
    (candidate) => estimateStatusTextWidth(text, candidate) <= STATUS_TEXT_MAX_WIDTH,
  ) || STATUS_FONT_SIZES.at(-1);
  const fittedText = truncateStatusText(text, fontSize);
  return {
    text: fittedText,
    fontSize,
    estimatedWidth: estimateStatusTextWidth(fittedText, fontSize),
  };
}

function normalizeModel(value) {
  const raw = cleanString(value);
  return MODEL_NAMES[raw.toUpperCase()] || raw;
}

function runExternal(command, args, options = {}) {
  const execFileImpl = options.execFile ?? execFile;
  return new Promise((resolve, reject) => {
    execFileImpl(command, args, { timeout: 4_000, windowsHide: true }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function openBambuStudio(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === 'darwin') {
    await runExternal('/usr/bin/open', ['-a', 'BambuStudio'], options);
  } else if (platform === 'win32') {
    await runExternal('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Start-Process -FilePath 'bambu-studio.exe'",
    ], options);
  } else if (platform === 'linux') {
    await runExternal('bambu-studio', [], options);
  } else {
    throw new Error(`Opening Bambu Studio is not supported on ${platform}`);
  }
  return 'BambuStudio';
}

async function openMakerWorld(site, options = {}) {
  const normalizedSite = Object.hasOwn(MAKERWORLD_URLS, site) ? site : 'china';
  const url = MAKERWORLD_URLS[normalizedSite];
  const platform = options.platform ?? process.platform;
  if (platform === 'darwin') {
    await runExternal('/usr/bin/open', [url], options);
  } else if (platform === 'win32') {
    await runExternal('rundll32.exe', ['url.dll,FileProtocolHandler', url], options);
  } else if (platform === 'linux') {
    await runExternal('xdg-open', [url], options);
  } else {
    throw new Error(`Opening MakerWorld is not supported on ${platform}`);
  }
  return url;
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
  return stage != null && stage > 0 ? `Preparation stage %s`.replace('%s', String(stage)) : 'Preparing to print';
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

function bambuStatusLogEntry(print = {}, status = resolvePrintState(print), now = Date.now()) {
  const stageCode = finiteNumber(print.mc_print_stage ?? print.stg_cur);
  const rawStageName = cleanString(print.stg_cur_name || print.stage_name || print.print_stage);
  const rawErrorCode = print.mc_print_error_code ?? print.print_error ?? print.error_code;
  const errorCode = finiteNumber(rawErrorCode) ?? clipText(String(rawErrorCode ?? ''), 80);
  const entry = {
    at: new Date(now).toISOString(),
    status: cleanString(status).toUpperCase() || 'IDLE',
  };
  const fields = [
    ['gcodeState', cleanString(print.gcode_state).toUpperCase()],
    ['progress', clampPercent(print.mc_percent)],
    ['remainingMinutes', finiteNumber(print.mc_remaining_time)],
    ['startTime', finiteNumber(print.gcode_start_time)],
    ['stageCode', stageCode],
    ['stageName', clipText(rawStageName || (stageCode != null ? stageLabel(print) : ''), 120)],
    ['taskName', clipText(print.subtask_name || print.gcode_file, 120)],
    ['model', normalizeModel(print.dev_model_name || print.dev_model || print.model)],
    ['errorCode', errorCode],
    ['errorMessage', clipText(print.fail_reason || print.error_message || print.error, 120)],
  ];
  fields.forEach(([key, value]) => {
    if (value !== null && value !== '') entry[key] = value;
  });
  return entry;
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
  const { value, unit } = formatDurationParts(seconds);
  return `${value}${unit}`;
}

function formatDurationParts(seconds) {
  if (!Number.isFinite(seconds)) return { value: '--', unit: '' };
  const totalMinutes = Math.max(0, Math.floor(seconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  if (hours >= 100) return { value: String(Math.min(99, Math.floor(hours / 24))), unit: 'd' };
  if (hours > 0) return { value: String(hours), unit: 'h' };
  return { value: String(Math.min(99, totalMinutes)), unit: 'm' };
}

function estimatedTotalSeconds(elapsedSec, remainingSec) {
  return Number.isFinite(elapsedSec) && Number.isFinite(remainingSec)
    ? Math.max(0, elapsedSec) + Math.max(0, remainingSec)
    : null;
}

function refreshDelay(status) {
  return ['RUNNING', 'PREPARING', 'PAUSED'].includes(status)
    ? ACTIVE_REFRESH_MS
    : PASSIVE_REDRAW_MS;
}

function formatAge(timestamp, now = Date.now(), translate = (key) => key) {
  if (!Number.isFinite(timestamp)) return translate('No data yet');
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return translate('%ss ago').replace('%s', String(seconds));
  if (seconds < 3600) return translate('%sm ago').replace('%s', String(Math.floor(seconds / 60)));
  return translate('%sh ago').replace('%s', String(Math.floor(seconds / 3600)));
}

function formatAgeShort(timestamp, now = Date.now(), translate = (key) => key) {
  if (!Number.isFinite(timestamp)) return '';
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return translate('%ss short').replace('%s', String(Math.min(59, seconds)));
  if (seconds < 3600) {
    return translate('%sm short').replace('%s', String(Math.min(59, Math.floor(seconds / 60))));
  }
  return translate('%sh short').replace('%s', String(Math.min(99, Math.floor(seconds / 3600))));
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
    t,
    themeFor,
    toDataUrl,
    writePersistedState,
    appendDiagnosticLog = () => false,
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

  function scheduleStatusRefresh(instance) {
    setInstanceTimeout(instance, 'bambustatusRefresh', () => {
      if (['RUNNING', 'PREPARING', 'PAUSED'].includes(instance.liveStatus)) {
        requestCurrentStatus(instance);
      }
      renderInstance(instance);
      scheduleStatusRefresh(instance);
    }, refreshDelay(instance.liveStatus));
  }

  function requestCurrentStatus(instance) {
    const serial = cleanString(instance.settings?.serialNumber);
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

  function refreshCurrentStatus(instance, options = {}) {
    if (options.manualFeedback) {
      instance.manualRefreshing = true;
      renderInstance(instance);
      setInstanceTimeout(instance, 'bambustatusManualRefreshFeedback', () => {
        instance.manualRefreshing = false;
        renderInstance(instance);
      }, MANUAL_REFRESH_FEEDBACK_MS);
    }
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
    const statusLogEntry = bambuStatusLogEntry(print, nextStatus, now);
    const { at: ignoredAt, ...statusLogValues } = statusLogEntry;
    const statusLogSignature = JSON.stringify(statusLogValues);
    if (statusLogSignature !== instance.lastStatusLogSignature) {
      if (appendDiagnosticLog('bambustatus-status', statusLogEntry)) {
        instance.lastStatusLogSignature = statusLogSignature;
      }
    }
    if (nextStatus === 'RUNNING') {
      instance.printAnimationFrame = (instance.printAnimationFrame + 1) % 3;
    }
    if (instance.active !== false && instance.settings) {
      scheduleStatusRefresh(instance);
    }
    if (nextStatus === 'FINISHED' && !instance.completionLatched) {
      instance.completedSnapshot = snapshotFromInstance(instance);
      instance.completionLatched = true;
      flushSnapshot(instance);
      scheduleCompletionExpiry(instance, now);
    }
  }

  function markOffline(instance, reason = 'Connection interrupted') {
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
      try { fn(...args); } catch { markOffline(instance, 'Status parsing failed'); }
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
      markOffline(instance, 'Unable to connect');
      return;
    }
    instance.mqttClient = client;
    client.on('connect', safeNetwork(instance, generation, () => {
      instance.reconnectAttempt = 0;
      client.subscribe(topic, { qos: 0 }, safeNetwork(instance, generation, (error) => {
        if (error) { markOffline(instance, 'Status subscription failed'); return; }
        requestCurrentStatus(instance);
        setInstanceTimeout(instance, 'bambustatusStatusTimeout', () => {
          if (!instance.statusReceived) {
            instance.connectionState = 'INCOMPATIBLE';
            instance.diagnostic = 'The current printer mode does not expose local status';
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
        sendParamFromPlugin({ [DIAG_PARAM]: { state: 'online', message: 'Live printer status received' } }, instance.context);
      }
      renderInstance(instance);
    }));
    client.on('error', safeNetwork(instance, generation, () => {
      closeClient(instance);
      markOffline(instance, 'Authentication or network connection failed');
    }));
    client.on('close', safeNetwork(instance, generation, () => {
      if (instance.connectionState !== 'INCOMPATIBLE') markOffline(instance, 'Connection closed');
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
    const language = settings.uiLanguage;
    const localizeStage = (value, fallback) => {
      const source = value || fallback;
      const numbered = /^Preparation stage (\d+)$/.exec(source);
      return numbered
        ? t('Preparation stage %s', language).replace('%s', numbered[1])
        : t(source, language);
    };
    const preparingDetail = data.stage && data.stage !== 'Preparing to print'
      ? localizeStage(data.stage, 'Preparing to print')
      : '';
    const labels = {
      IDLE: [t('Idle', language), ''],
      PREPARING: [preparingDetail || t('Preparing', language), ''],
      PAUSED: [
        data.stage && data.stage !== 'Preparing to print'
          ? localizeStage(data.stage, 'Print paused')
          : t('Paused', language),
        '',
      ],
      FINISHED: [t('Finished', language), ''],
      FAILED: [t('Print failed', language), ''],
    };
    const lineText = (primary, secondary = '') => {
      return cleanString(secondary ? `${primary} · ${secondary}` : primary);
    };
    const renderStatusLine = (text, color = theme.text) => {
      const fitted = fitStatusText(text);
      return `<text data-bambu-status-line="single" data-bambu-status-width="${fitted.estimatedWidth.toFixed(1)}" x="128" y="158" text-anchor="middle" fill="${color}" font-size="${fitted.fontSize}" font-weight="800">${escapeXml(fitted.text)}</text>`;
    };
    const renderTimeIcon = (kind, x) => kind === 'estimated'
      ? `<g data-bambu-time-icon="estimated" transform="translate(${x} 198)" fill="none" stroke="${theme.accent}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle r="7"/><path d="M0 -3.8 V0 L3.6 2.1"/></g>`
      : `<g data-bambu-time-icon="remaining" transform="translate(${x} 198)" fill="none" stroke="${theme.accent}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M-6 -7 H6 M-6 7 H6 M-5 -6 C-5 -2 -2 -1 0 0 C2 1 5 2 5 6 M5 -6 C5 -2 2 -1 0 0 C-2 1 -5 2 -5 6"/></g>`;
    const renderTimeValue = (kind, seconds, x) => {
      const { value, unit } = formatDurationParts(seconds);
      return `<text data-bambu-time-value="${kind}" x="${x}" y="207" text-anchor="middle" font-weight="800"><tspan fill="${theme.text}" font-size="26">${value}</tspan>${unit ? `<tspan fill="${theme.muted}" font-size="14" xml:space="preserve"> ${unit}</tspan>` : ''}</text>`;
    };
    const renderTimes = (showRemaining = true) => showRemaining
      ? `<g data-bambu-time-row="paired" font-family="Arial, Helvetica, sans-serif" font-variant-numeric="tabular-nums">${renderTimeIcon('estimated', 56)}${renderTimeValue('estimated', estimatedTotalSeconds(data.elapsedSec, data.remainingSec), 89)}<text data-bambu-time-separator="slash" x="128" y="205" text-anchor="middle" fill="${theme.low}" font-size="18" font-weight="700">/</text>${renderTimeIcon('remaining', 153)}${renderTimeValue('remaining', data.remainingSec, 186)}</g>`
      : `<g data-bambu-time-row="single" font-family="Arial, Helvetica, sans-serif" font-variant-numeric="tabular-nums">${renderTimeIcon('estimated', 105)}${renderTimeValue('estimated', data.elapsedSec, 139)}</g>`;
    const renderPrintingIcon = () => {
      const frameIndex = Math.abs(Number(instance.printAnimationFrame) || 0) % 3;
      const nozzleX = 55 + frameIndex * 6;
      return `<g data-print-animation-frame="${frameIndex}" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <rect x="50" y="124" width="29" height="33" rx="3" stroke="${theme.muted}" stroke-width="2" opacity="0.9"/>
        <path d="M54 151 H75 M55 147 H74" stroke="${theme.accent}" stroke-width="2"/>
        <path d="M54 129 H75 M${nozzleX} 129 V137" stroke="${theme.muted}" stroke-width="2"/>
        <path d="M${nozzleX - 3} 137 H${nozzleX + 3} L${nozzleX + 1} 141 H${nozzleX - 1} Z" fill="${theme.accent}" stroke="${theme.accent}" stroke-width="1"/>
      </g>`;
    };
    let body = '';
    if (instance.manualRefreshing) {
      body = `<text data-manual-refresh-feedback="active" x="128" y="158" text-anchor="middle" fill="${theme.text}" font-size="44" font-weight="800">...</text>`;
    } else if (instance.connectionState === 'CONFIG_REQUIRED') {
      body = renderStatusLine(t('Setup required', language));
    } else if (instance.connectionState === 'CONNECTING') {
      body = renderStatusLine(t('Connecting', language));
    } else if (instance.connectionState === 'INCOMPATIBLE') {
      body = renderStatusLine(t('Status unavailable', language), theme.warn);
    } else if (instance.connectionState === 'OFFLINE') {
      body = renderStatusLine(lineText(
        t('Offline', language),
        formatAgeShort(instance.lastSeenAt, Date.now(), (key) => t(key, language)),
      ), theme.crit);
    } else if (status === 'RUNNING') {
      body = `
        ${renderMeterRow(
          { x: 43, y: 116, width: 170, height: 51 },
          theme,
          {
            percent: progress,
            color: theme.accent,
            value: `${progress}%`,
            showBar: true,
            centerText: true,
            centerTextOffset: 10.7,
            centerTextXOffset: 12,
          },
        )}
        ${renderPrintingIcon()}
        ${renderTimes(true)}`;
    } else {
      const [primary, secondary] = labels[status] || labels.IDLE;
      body = `${renderStatusLine(
        lineText(primary, secondary),
        status === 'FAILED' ? theme.crit : theme.text,
      )}${['PREPARING', 'PAUSED'].includes(status) ? renderTimes(true) : ''}${status === 'FINISHED' ? renderTimes(false) : ''}`;
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
      printerName: '', printerIp: '', serialNumber: '', accessCode: '', makerworldSite: 'china',
      theme: 'mint', frameSize: 'optimal', showFrame: 'true',
    },
    normalizeSettings: (settings) => ({
      printerName: cleanString(settings.printerName).slice(0, 40),
      printerIp: cleanString(settings.printerIp),
      serialNumber: cleanString(settings.serialNumber),
      accessCode: cleanString(settings.accessCode),
      makerworldSite: normalizeChoice(settings.makerworldSite, 'china', ['global', 'china']),
      theme: normalizeChoice(settings.theme, 'mint', ['mint', 'ember', 'mono', 'signal', 'neon', 'ice', 'sunset', 'forest', 'sand']),
    }),
    createState: (instance) => ({
      connectionState: 'CONFIG_REQUIRED', liveStatus: 'IDLE', model: '', taskName: '', stage: '',
      progress: null, elapsedSec: null, remainingSec: null, lastSeenAt: null, print: {}, mqttClient: null,
      discoverySocket: null, connectionGeneration: 0, reconnectAttempt: 0, statusReceived: false, diagnostic: '',
      completedSnapshot: null, completionLatched: false, suppressFinishedUntilNextTask: false,
      autoScanStarted: false, reportedOnline: false, manualRefreshing: false, printAnimationFrame: 0,
      lastStatusLogSignature: '',
      ...hydrateSnapshot(readPersistedState(instance.context)),
    }),
    onRun: (instance) => refreshCurrentStatus(instance, { manualFeedback: true }),
    onDoublePress: (instance) => openBambuStudio(),
    onLongPress: (instance) => openMakerWorld(instance.settings.makerworldSite),
    onReady: async (instance) => {
      scheduleStatusRefresh(instance);
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
      clearInstanceTimeout(instance, 'bambustatusRefresh');
      clearInstanceTimeout(instance, 'bambustatusCompletionExpiry');
      clearInstanceTimeout(instance, 'bambustatusManualRefreshFeedback');
      flushSnapshot(instance);
    },
    render: renderBambuStatus,
  };

  return {
    key: 'bambustatus',
    config,
    testing: {
      applyPrintReport,
      bambuStatusLogEntry,
      completionExpiryDelay,
      deriveTimes,
      estimatedTotalSeconds,
      formatAge,
      formatAgeShort,
      formatDuration,
      formatDurationParts,
      estimateStatusTextWidth,
      fitStatusText,
      hydrateSnapshot,
      isCompleteSettings,
      mergeDiscovery,
      bambuOpenBambuStudio: openBambuStudio,
      bambuOpenMakerWorld: openMakerWorld,
      parseSsdpPacket,
      readBambuStudioAccessCodes,
      refreshDelay,
      resolvePrintState,
      shouldConnectOnReady,
      stageLabel,
    },
  };
}
