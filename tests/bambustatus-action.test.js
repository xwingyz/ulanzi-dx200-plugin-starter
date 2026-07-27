import assert from 'node:assert/strict';
import { test } from 'node:test';

import { __testing as testing } from '../plugins/com.ulanzi.lexutility.ulanziPlugin/plugin/app.js';

test('bambustatus maps detailed preparation stages to stable localization keys with a raw fallback', () => {
  assert.equal(testing.stageLabel({ mc_print_stage: 1 }), 'Auto bed leveling');
  assert.equal(testing.stageLabel({ mc_print_stage: 14 }), 'Cleaning the nozzle');
  assert.equal(testing.stageLabel({ mc_print_stage: 99 }), 'Preparation stage 99');
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

test('bambustatus uses compact one-unit times and refreshes active printing states every ten seconds', () => {
  assert.deepEqual(testing.formatDurationParts(5040), { value: '1', unit: 'h' });
  assert.deepEqual(testing.formatDurationParts(2160), { value: '36', unit: 'm' });
  assert.equal(testing.refreshDelay('RUNNING'), 10_000);
  assert.equal(testing.refreshDelay('PREPARING'), 10_000);
  assert.equal(testing.refreshDelay('PAUSED'), 10_000);
  assert.equal(testing.refreshDelay('IDLE'), 30_000);
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
  // uiLanguage 是框架级通用设置，归一化后恒存在（默认 'auto'）。
  assert.deepEqual(sent[0], { __settingsSync: 'true', uiLanguage: 'auto', ...persisted });
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

test('bambustatus keeps refresh, app launch and MakerWorld on the shared gesture hooks', () => {
  const config = testing.ACTION_CONFIGS.bambustatus;
  assert.equal(typeof config.onRun, 'function');
  assert.equal(typeof config.onDoublePress, 'function');
  assert.equal(typeof config.onLongPress, 'function');
  assert.equal(config.defaults.makerworldSite, 'china');
  assert.equal(config.normalizeSettings({ makerworldSite: 'global' }).makerworldSite, 'global');
  assert.equal(config.normalizeSettings({ makerworldSite: 'invalid' }).makerworldSite, 'china');
});

test('bambustatus launches Bambu Studio and the configured MakerWorld site through the OS', async () => {
  const calls = [];
  const execFile = (command, args, options, callback) => {
    calls.push({ command, args, options });
    callback(null);
  };
  assert.equal(
    await testing.bambuOpenBambuStudio({ platform: 'darwin', execFile }),
    'BambuStudio',
  );
  assert.equal(
    await testing.bambuOpenMakerWorld('global', { platform: 'darwin', execFile }),
    'https://makerworld.com/',
  );
  assert.equal(
    await testing.bambuOpenMakerWorld('china', { platform: 'win32', execFile }),
    'https://makerworld.com.cn/',
  );
  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
    ['/usr/bin/open', ['-a', 'BambuStudio']],
    ['/usr/bin/open', ['https://makerworld.com/']],
    ['rundll32.exe', ['url.dll,FileProtocolHandler', 'https://makerworld.com.cn/']],
  ]);
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

test('bambustatus renders manual refresh as centered dots without highlighting the brand mark', () => {
  const config = testing.ACTION_CONFIGS.bambustatus;
  const context = 'com.ulanzi.ulanzistudio.lexutility.bambustatus___refresh-feedback';
  const instance = {
    context,
    active: false,
    settings: { ...config.defaults },
    ...config.createState({ context }),
    connectionState: 'ONLINE',
    liveStatus: 'IDLE',
    manualRefreshing: true,
  };
  const svg = Buffer.from(config.render(instance).split(',')[1], 'base64').toString('utf8');
  assert.match(svg, /data-manual-refresh-feedback="active"[^>]*>\.\.\.<\/text>/);
  assert.doesNotMatch(svg, /<circle[^>]+cx="62" cy="65"/);
  assert.match(svg, new RegExp(`<path d="[^"]+" fill="#00AE42"`));
  testing.dropPersistedState(context);
});

test('bambustatus running layout centers the meter and uses spaced icons for estimated and remaining time', () => {
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
  assert.match(svg, /x="154\.2" y="152\.2" dominant-baseline="middle"[^>]*><tspan[^>]*>68<\/tspan><tspan[^>]*>%<\/tspan>/);
  assert.match(svg, /data-print-animation-frame="0"/);
  assert.match(svg, /data-bambu-time-row="paired"[^>]+font-variant-numeric="tabular-nums"/);
  assert.match(svg, /data-bambu-time-icon="estimated"[^>]+stroke="#14b8a6"/);
  assert.match(svg, /data-bambu-time-icon="remaining"[^>]+stroke="#14b8a6"/);
  assert.match(svg, /data-bambu-time-value="estimated"[^>]*><tspan[^>]+font-size="26">2<\/tspan><tspan[^>]+font-size="14" xml:space="preserve"> h<\/tspan>/);
  assert.match(svg, /data-bambu-time-separator="slash"[^>]*>\/<\/text>/);
  assert.match(svg, /data-bambu-time-value="remaining"[^>]*><tspan[^>]+font-size="26">36<\/tspan><tspan[^>]+font-size="14" xml:space="preserve"> m<\/tspan>/);
  assert.doesNotMatch(svg, />[ETR] /);
  testing.dropPersistedState(context);
});

test('bambustatus running E shows estimated total instead of elapsed time near completion', () => {
  const config = testing.ACTION_CONFIGS.bambustatus;
  const context = 'com.ulanzi.ulanzistudio.lexutility.bambustatus___near-completion-times';
  const instance = {
    context,
    active: false,
    settings: { ...config.defaults },
    ...config.createState({ context }),
    connectionState: 'ONLINE',
    liveStatus: 'RUNNING',
    progress: 88,
    elapsedSec: 31 * 60,
    remainingSec: 4 * 60,
  };
  const svg = Buffer.from(config.render(instance).split(',')[1], 'base64').toString('utf8');
  assert.match(svg, /data-bambu-time-value="estimated"[^>]*><tspan[^>]+font-size="26">35<\/tspan><tspan[^>]+font-size="14" xml:space="preserve"> m<\/tspan>/);
  assert.match(svg, /data-bambu-time-value="remaining"[^>]*><tspan[^>]+font-size="26">4<\/tspan><tspan[^>]+font-size="14" xml:space="preserve"> m<\/tspan>/);
  testing.dropPersistedState(context);
});

test('bambustatus keeps stable idle, connecting and finished status lines short', () => {
  const config = testing.ACTION_CONFIGS.bambustatus;
  const context = 'com.ulanzi.ulanzistudio.lexutility.bambustatus___short-stable-states';
  const base = {
    context,
    active: false,
    settings: { ...config.defaults, uiLanguage: 'zh_CN' },
    ...config.createState({ context }),
  };

  const idleSvg = Buffer.from(config.render({
    ...base,
    connectionState: 'ONLINE',
    liveStatus: 'IDLE',
  }).split(',')[1], 'base64').toString('utf8');
  assert.match(idleSvg, /data-bambu-status-line="single"[^>]*>空闲<\/text>/);
  assert.doesNotMatch(idleSvg, /等待新任务| · /);

  const connectingSvg = Buffer.from(config.render({
    ...base,
    connectionState: 'CONNECTING',
  }).split(',')[1], 'base64').toString('utf8');
  assert.match(connectingSvg, /data-bambu-status-line="single"[^>]*>连接中<\/text>/);
  assert.doesNotMatch(connectingSvg, /正在读取打印机状态| · /);

  const finishedSvg = Buffer.from(config.render({
    ...base,
    connectionState: 'ONLINE',
    liveStatus: 'FINISHED',
    taskName: '一个特别长且不应出现在完成状态中的模型名称.3mf',
    elapsedSec: 35 * 60,
  }).split(',')[1], 'base64').toString('utf8');
  assert.match(finishedSvg, /data-bambu-status-line="single"[^>]*>已完成<\/text>/);
  assert.doesNotMatch(finishedSvg, /模型名称|打印任务| · /);
  assert.match(finishedSvg, /data-bambu-time-row="single"/);
  assert.match(finishedSvg, /data-bambu-time-icon="estimated"/);
  assert.match(finishedSvg, /data-bambu-time-value="estimated"[^>]*><tspan[^>]+font-size="26">35<\/tspan><tspan[^>]+font-size="14" xml:space="preserve"> m<\/tspan>/);
  testing.dropPersistedState(context);
});

test('bambustatus diagnostic snapshots include status fields only', () => {
  const entry = testing.bambuStatusLogEntry({
    gcode_state: 'RUNNING',
    mc_percent: 42,
    mc_remaining_time: 18,
    gcode_start_time: 1_700_000_000,
    mc_print_stage: 7,
    stg_cur_name: 'Heating the nozzle',
    subtask_name: 'Calibration cube.3mf',
    dev_model_name: 'N2S',
    print_error: 1234,
    access_code: 'SECRET-CODE',
    ipcam: { ip: '192.168.1.8' },
    serial_number: 'SECRET-SERIAL',
  }, 'RUNNING', 1_700_001_000_000);

  assert.deepEqual(entry, {
    at: '2023-11-14T22:30:00.000Z',
    status: 'RUNNING',
    gcodeState: 'RUNNING',
    progress: 42,
    remainingMinutes: 18,
    startTime: 1_700_000_000,
    stageCode: 7,
    stageName: 'Heating the nozzle',
    taskName: 'Calibration cube.3mf',
    model: 'P2S',
    errorCode: 1234,
  });
  const serialized = JSON.stringify(entry);
  assert.doesNotMatch(serialized, /SECRET|192\.168\.1\.8|access_code|serial_number|ipcam/);
});

test('bambustatus shows only a detailed preparation stage and advances the print icon on reports', () => {
  const config = testing.ACTION_CONFIGS.bambustatus;
  const context = 'com.ulanzi.ulanzistudio.lexutility.bambustatus___state-line';
  const base = {
    context,
    active: false,
    settings: { ...config.defaults, uiLanguage: 'zh_CN' },
    ...config.createState({ context }),
    connectionState: 'ONLINE',
  };
  const preparing = { ...base, liveStatus: 'PREPARING', stage: 'Auto bed leveling' };
  const preparingSvg = Buffer.from(config.render(preparing).split(',')[1], 'base64').toString('utf8');
  assert.match(preparingSvg, /data-bambu-status-line="single"[^>]*>自动调平热床<\/text>/);
  assert.doesNotMatch(preparingSvg, /准备中| · /);
  assert.equal((preparingSvg.match(/data-bambu-status-line=/g) || []).length, 1);

  const genericPreparing = { ...base, liveStatus: 'PREPARING', stage: 'Preparing to print' };
  const genericSvg = Buffer.from(config.render(genericPreparing).split(',')[1], 'base64').toString('utf8');
  assert.match(genericSvg, /data-bambu-status-line="single"[^>]*>准备中<\/text>/);

  const running = { ...base, liveStatus: 'RUNNING', printAnimationFrame: 0 };
  testing.applyPrintReport(running, { gcode_state: 'RUNNING', mc_percent: 10 }, 10_000);
  const firstSvg = Buffer.from(config.render(running).split(',')[1], 'base64').toString('utf8');
  testing.applyPrintReport(running, { mc_percent: 11 }, 11_000);
  const secondSvg = Buffer.from(config.render(running).split(',')[1], 'base64').toString('utf8');
  assert.match(firstSvg, /data-print-animation-frame="1"/);
  assert.match(secondSvg, /data-print-animation-frame="2"/);
  testing.dropPersistedState(context);
});
