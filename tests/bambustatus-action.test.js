import assert from 'node:assert/strict';
import { test } from 'node:test';

import { __testing as testing } from '../plugins/com.ulanzi.lexutility.ulanziPlugin/plugin/app.js';

test('bambustatus maps detailed preparation stages with a raw fallback', () => {
  assert.equal(testing.stageLabel({ mc_print_stage: 1 }), '自动调平');
  assert.equal(testing.stageLabel({ mc_print_stage: 14 }), '清洁喷嘴');
  assert.equal(testing.stageLabel({ mc_print_stage: 99 }), '准备阶段 99');
  assert.equal(testing.stageLabel({ stg_cur_name: 'Custom calibration' }), 'Custom calibration');
});

test('bambustatus resolves the principal printer states', () => {
  assert.equal(testing.resolvePrintState({ gcode_state: 'RUNNING', mc_percent: 25 }), 'RUNNING');
  assert.equal(testing.resolvePrintState({ gcode_state: 'RUNNING', mc_percent: 0, mc_print_stage: 2 }), 'PREPARING');
  assert.equal(testing.resolvePrintState({ gcode_state: 'PAUSE' }), 'PAUSED');
  assert.equal(testing.resolvePrintState({ gcode_state: 'FINISH' }), 'FINISHED');
  assert.equal(testing.resolvePrintState({ gcode_state: 'FAILED' }), 'FAILED');
});

test('bambustatus derives elapsed and remaining time without a ticking counter', () => {
  const now = 1_800_000;
  assert.deepEqual(
    testing.deriveTimes({ gcode_start_time: 1200, mc_remaining_time: 5 }, now),
    { elapsedSec: 600, remainingSec: 300 },
  );
  assert.deepEqual(
    testing.deriveTimes({ mc_percent: 25, mc_remaining_time: 15 }, now),
    { elapsedSec: 300, remainingSec: 900 },
  );
});

test('bambustatus parses Bambu SSDP headers and normalizes P2S model code', () => {
  const packet = [
    'HTTP/1.1 200 OK',
    'Location: http://192.168.20.31:80/',
    'USN: uuid:TEST-SERIAL::urn:bambulab-com:device:3dprinter:1',
    'DevModel.bambu.com: N2S',
    'DevName.bambu.com: Workshop Printer',
    '', '',
  ].join('\r\n');
  assert.deepEqual(testing.parseSsdpPacket(packet), {
    printerIp: '192.168.20.31',
    serialNumber: 'TEST-SERIAL',
    model: 'P2S',
    name: 'Workshop Printer',
  });
});

test('bambustatus reads only access code maps and merges them with LAN discovery', () => {
  const fsImpl = {
    readFileSync: () => JSON.stringify({
      access_code: { 'TEST-SERIAL': '12345678' },
      unrelated: { token: 'must-not-be-read' },
    }),
  };
  const codes = testing.readBambuStudioAccessCodes({ fsImpl, platform: 'darwin', homeDir: '/tmp/test-home' });
  assert.deepEqual(codes, [{ serialNumber: 'TEST-SERIAL', accessCode: '12345678', source: 'BambuStudio' }]);
  assert.deepEqual(testing.mergeDiscovery(codes, [{
    printerIp: '192.168.20.31', serialNumber: 'TEST-SERIAL', model: 'P2S', name: 'Workshop Printer',
  }]), {
    printerIp: '192.168.20.31',
    serialNumber: 'TEST-SERIAL',
    accessCode: '12345678',
    printerName: 'Workshop Printer',
    model: 'P2S',
    name: 'Workshop Printer',
  });
});

test('bambustatus does not reconnect on repeated ready while a client already exists', () => {
  assert.equal(testing.shouldConnectOnReady({ mqttClient: { connected: true } }), false);
  assert.equal(testing.shouldConnectOnReady({ mqttClient: null }), true);
});

test('bambustatus host restore echoes the saved printer name and connection settings', () => {
  const context = 'com.ulanzi.ulanzistudio.lexutility.bambustatus___3_1___saved-bambu';
  const persisted = {
    ...testing.ACTION_CONFIGS.bambustatus.defaults,
    printerName: '书房打印机',
    printerIp: '192.168.1.180',
    serialNumber: 'TEST-SERIAL',
    accessCode: 'TEST-CODE',
    theme: 'mono',
    frameSize: 'max',
    showFrame: 'false',
  };
  const sent = [];
  const controller = testing.createSettingsEventProcessor({
    instances: new Map(),
    readPersisted: () => ({ ...persisted }),
    writePersisted: () => {},
    render: () => {},
    ready: () => {},
    ud: { sendParamFromPlugin: (settings) => sent.push(settings) },
  });

  controller.hostRestore(context, { ...persisted });

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { __settingsSync: 'true', ...persisted });
});

test('bambustatus completion snapshot hydration is versioned', () => {
  const snapshot = { status: 'FINISHED', progress: 100, elapsedSec: 4800, completedAt: 10_000 };
  assert.deepEqual(testing.hydrateSnapshot({ v: 1, completedSnapshot: snapshot }, 100_000), {
    completedSnapshot: snapshot,
    completionLatched: true,
    suppressFinishedUntilNextTask: false,
  });
  assert.deepEqual(testing.hydrateSnapshot({
    v: 1, completedSnapshot: null, suppressFinishedUntilNextTask: true,
  }), {
    completedSnapshot: null,
    completionLatched: false,
    suppressFinishedUntilNextTask: true,
  });
  assert.deepEqual(testing.hydrateSnapshot({ v: 2, completedSnapshot: snapshot }), {});
});

test('bambustatus expires a completion snapshot after three minutes', () => {
  const snapshot = { status: 'FINISHED', progress: 100, completedAt: 10_000 };
  assert.equal(testing.completionExpiryDelay(snapshot, 189_999), 1);
  assert.equal(testing.completionExpiryDelay(snapshot, 190_000), 0);
  assert.deepEqual(testing.hydrateSnapshot({ v: 1, completedSnapshot: snapshot }, 190_000), {
    completedSnapshot: null,
    completionLatched: false,
    suppressFinishedUntilNextTask: true,
  });
});

test('bambustatus keeps an expired completion clear until the next task starts', () => {
  const instance = {
    print: {}, model: 'P2S', taskName: '', stage: '', progress: null, elapsedSec: null,
    remainingSec: null, lastSeenAt: null, connectionState: 'ONLINE', liveStatus: 'FINISHED',
    statusReceived: false, completionLatched: false, completedSnapshot: null,
    suppressFinishedUntilNextTask: true,
  };
  testing.applyPrintReport(instance, { gcode_state: 'FINISH', mc_percent: 100 }, 10_000);
  assert.equal(instance.liveStatus, 'IDLE');
  assert.equal(instance.completedSnapshot, null);
  testing.applyPrintReport(instance, { gcode_state: 'RUNNING', mc_percent: 1 }, 11_000);
  assert.equal(instance.liveStatus, 'RUNNING');
  assert.equal(instance.suppressFinishedUntilNextTask, false);
});

test('bambustatus uses a single click refresh and has no long-press action', () => {
  const config = testing.ACTION_CONFIGS.bambustatus;
  assert.equal(typeof config.onRun, 'function');
  assert.equal(config.onLongPress, undefined);
});

test('bambustatus header renders only the configured printer name', () => {
  const config = testing.ACTION_CONFIGS.bambustatus;
  const context = 'com.ulanzi.ulanzistudio.lexutility.bambustatus___name-only';
  const instance = {
    context,
    active: false,
    settings: { ...config.defaults, printerName: '书房打印机' },
    ...config.createState({ context }),
    connectionState: 'ONLINE',
    liveStatus: 'IDLE',
    model: 'P2S',
  };
  const svg = Buffer.from(config.render(instance).split(',')[1], 'base64').toString('utf8');
  assert.match(svg, />书房打印机<\/text>/);
  assert.doesNotMatch(svg, />P2S<\/text>/);
  testing.dropPersistedState(context);
});

test('bambustatus running layout reuses the ChatGPT meter style with larger T and R times', () => {
  const config = testing.ACTION_CONFIGS.bambustatus;
  const context = 'com.ulanzi.ulanzistudio.lexutility.bambustatus___progress-layout';
  const instance = {
    context,
    active: false,
    settings: { ...config.defaults, printerName: '书房打印机' },
    ...config.createState({ context }),
    connectionState: 'ONLINE',
    liveStatus: 'RUNNING',
    progress: 68,
    elapsedSec: 5040,
    remainingSec: 2160,
  };
  const svg = Buffer.from(config.render(instance).split(',')[1], 'base64').toString('utf8');
  assert.match(svg, /width="170" height="51" rx="3"/);
  assert.match(svg, /width="115\.6" height="51" rx="3"[^>]+opacity="0\.30"/);
  // 字号来自共享的 renderMeterRow：数字随行高自适应，单位固定 15px。
  // 共享原语调整时这里会一起变——这是预期的统一，不是回归。
  assert.match(svg, /<tspan font-size="30\.2">68<\/tspan><tspan font-size="15\.0">%<\/tspan>/);
  assert.match(svg, /font-size="25" font-weight="800">T 1h24<\/text>/);
  assert.match(svg, /font-size="25" font-weight="800">R 36m<\/text>/);
  testing.dropPersistedState(context);
});
