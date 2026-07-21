import assert from 'node:assert/strict';
import { test } from 'node:test';

import { __testing } from '../plugins/com.ulanzi.lexutility.ulanziPlugin/plugin/app.js';
import { createSystemStatusAction } from '../plugins/com.ulanzi.lexutility.ulanziPlugin/plugin/actions/systemstatus.js';

const {
  ACTION_CONFIGS,
  readPersistedState,
  systemStatusCollectSample,
  systemStatusAppendHistory,
  systemStatusChartTypeForMetric,
  systemStatusHydrateState,
  systemStatusNetworkRates,
  systemStatusNormalizeLhmUrl,
  systemStatusNormalizeMetricSlots,
  systemStatusParseLhmMetrics,
  systemStatusParseMacGpuUtilization,
  systemStatusRenderIcon,
  systemStatusSerializeState,
  systemStatusSelectedMetrics,
  systemStatusSumNetworkCounters,
  writePersistedState,
} = __testing;

function decode(icon) {
  return Buffer.from(icon.replace(/^data:image\/svg\+xml;base64,/, ''), 'base64').toString('utf8');
}

function instance(settings = {}, values = {}) {
  const defaults = ACTION_CONFIGS.systemstatus.defaults;
  return {
    context: 'com.ulanzi.ulanzistudio.lexutility.systemstatus___test___key',
    active: false,
    platform: 'darwin',
    settings: { ...defaults, ...settings },
    values: { cpu: 42, ram: 68, gpu: 31, temperature: 57.5, upload: 1_500_000, download: 24_000_000, ...values },
    history: {
      cpu: Array.from({ length: 24 }, (_, index) => 25 + index),
      ram: Array.from({ length: 24 }, (_, index) => 50 + index),
      gpu: Array.from({ length: 24 }, (_, index) => 15 + index),
      temperature: Array.from({ length: 24 }, (_, index) => 45 + index / 2),
      upload: Array.from({ length: 24 }, (_, index) => 250_000 + index * 50_000),
      download: Array.from({ length: 24 }, (_, index) => 2_000_000 + index * 500_000),
    },
    lastSampleAt: 1,
    sampling: false,
    sampleError: false,
  };
}

test('system status defaults and slots enforce one to three unique metrics', () => {
  assert.deepEqual(
    systemStatusSelectedMetrics(ACTION_CONFIGS.systemstatus.defaults),
    ['cpu', 'ram', 'download'],
  );
  assert.deepEqual(
    systemStatusNormalizeMetricSlots({ metric1: 'gpu', metric2: 'gpu', metric3: 'none' }),
    { metric1: 'gpu', metric2: 'cpu', metric3: 'none' },
  );
  assert.deepEqual(
    systemStatusNormalizeMetricSlots({ metric1: 'none', metric2: 'bad', metric3: 'temperature' }),
    { metric1: 'cpu', metric2: 'ram', metric3: 'temperature' },
  );
  assert.deepEqual(
    systemStatusNormalizeMetricSlots({ metric1: 'cpu', metric2: 'none', metric3: 'none' }),
    { metric1: 'cpu', metric2: 'none', metric3: 'none' },
  );
  assert.deepEqual(
    systemStatusNormalizeMetricSlots({ metric1: 'cpu', metric2: 'none', metric3: 'download' }),
    { metric1: 'cpu', metric2: 'download', metric3: 'none' },
  );
  assert.deepEqual(systemStatusSelectedMetrics({ metric1: 'ram', metric2: 'ram', metric3: 'none' }), ['ram']);
});

test('LibreHardwareMonitor parser prefers CPU package temperature and GPU core load', () => {
  const fixture = {
    Text: 'Machine',
    Children: [
      {
        Text: 'AMD Ryzen', HardwareId: '/amdcpu/0', Children: [
          { Text: 'Temperatures', Children: [{ Text: 'CPU Package', Type: 'Temperature', SensorId: '/amdcpu/0/temperature/0', Value: '61.5 °C' }] },
          { Text: 'Load', Children: [{ Text: 'CPU Total', Type: 'Load', SensorId: '/amdcpu/0/load/0', Value: '44.0 %' }] },
        ],
      },
      {
        Text: 'NVIDIA GeForce', HardwareId: '/gpu-nvidia/0', Children: [
          { Text: 'Load', Children: [{ Text: 'GPU Core', Type: 'Load', SensorId: '/gpu-nvidia/0/load/0', Value: '73.2 %' }] },
        ],
      },
    ],
  };

  assert.deepEqual(systemStatusParseLhmMetrics(fixture), { gpu: 73.2, temperature: 61.5 });
  assert.deepEqual(systemStatusParseLhmMetrics({ Children: [] }), { gpu: null, temperature: null });
});

test('macOS IORegistry parser reads the highest available GPU utilization field', () => {
  const output = '"PerformanceStatistics" = {"Tiler Utilization %"=22,"Renderer Utilization %"=38,"Device Utilization %"=35}';
  assert.equal(systemStatusParseMacGpuUtilization(output), 38);
  assert.equal(systemStatusParseMacGpuUtilization('no compatible sensor'), null);
});

test('network counters exclude internal and virtual interfaces and calculate per-second rates', () => {
  const counters = systemStatusSumNetworkCounters(
    [
      { iface: 'lo0', internal: true, virtual: false, operstate: 'up' },
      { iface: 'en0', internal: false, virtual: false, operstate: 'up' },
      { iface: 'utun0', internal: false, virtual: true, operstate: 'up' },
    ],
    [
      { iface: 'lo0', rx_bytes: 9_999, tx_bytes: 9_999 },
      { iface: 'en0', rx_bytes: 5_000, tx_bytes: 2_000 },
      { iface: 'utun0', rx_bytes: 8_000, tx_bytes: 8_000 },
    ],
  );
  assert.deepEqual(counters, { rx: 5_000, tx: 2_000 });
  assert.deepEqual(
    systemStatusNetworkRates({ rx: 1_000, tx: 500, at: 1_000 }, counters, 3_000),
    { download: 2_000, upload: 750, baseline: { rx: 5_000, tx: 2_000, at: 3_000 } },
  );
});

test('fixed systeminformation fixture produces CPU, RAM, GPU and network readings', async () => {
  const si = {
    currentLoad: async () => ({ currentLoad: 47.4 }),
    mem: async () => ({ total: 1_000, available: 250, active: 700 }),
    cpuTemperature: async () => ({ main: 54 }),
    networkInterfaces: async () => [{ iface: 'Ethernet', ifaceName: 'Ethernet', internal: false, virtual: false, operstate: 'up' }],
    networkStats: async () => [{ iface: 'Ethernet', rx_bytes: 9_000, tx_bytes: 5_000 }],
    graphics: async () => ({ controllers: [{ utilizationGpu: 33 }] }),
  };
  const result = await systemStatusCollectSample({
    si,
    platform: 'linux',
    now: 3_000,
    previousNetwork: { rx: 1_000, tx: 1_000, at: 1_000 },
  });

  assert.equal(result.ok, true);
  assert.equal(result.values.cpu, 47.4);
  assert.equal(result.values.ram, 75);
  assert.equal(result.values.gpu, 33);
  assert.equal(result.values.temperature, 54);
  assert.equal(result.values.download, 4_000);
  assert.equal(result.values.upload, 2_000);
});

test('LHM URL is constrained to loopback HTTP', () => {
  assert.equal(systemStatusNormalizeLhmUrl('http://localhost:8085/data.json'), 'http://localhost:8085/data.json');
  assert.equal(systemStatusNormalizeLhmUrl('https://127.0.0.1/data.json'), 'http://127.0.0.1:8085/data.json');
  assert.equal(systemStatusNormalizeLhmUrl('http://example.com/data.json'), 'http://127.0.0.1:8085/data.json');
});

test('one, two and three metric layouts stay legible and structurally clean', () => {
  const settingsList = [
    { metric1: 'cpu', metric2: 'none', metric3: 'none' },
    { metric1: 'cpu', metric2: 'temperature', metric3: 'none' },
    { metric1: 'cpu', metric2: 'ram', metric3: 'download' },
  ];
  const minimumSizes = [42, 34, 29];

  settingsList.forEach((settings, index) => {
    const svg = decode(systemStatusRenderIcon(instance(settings)));
    assert.equal((svg.match(/data-metric=/g) || []).length, index + 1);
    assert.match(svg, new RegExp(`font-size="${minimumSizes[index]}"`));
    assert.doesNotMatch(svg, /undefined|NaN|\[object Object\]/);
  });
});

test('unavailable sensor is shown honestly as N/A instead of zero', () => {
  const svg = decode(systemStatusRenderIcon(instance({ metric1: 'temperature', metric2: 'none', metric3: 'none' }, { temperature: null })));
  assert.match(svg, />N\/A</);
  assert.doesNotMatch(svg, />0(?:\.0)?</);
});

test('network rows use compact direction icons and distinct 15px units', () => {
  const svg = decode(systemStatusRenderIcon(instance({ metric1: 'upload', metric2: 'download', metric3: 'none' })));
  const networkUnits = [...svg.matchAll(/<text data-role="unit" data-unit-kind="network"[^>]*fill="([^"]+)" font-size="15"[^>]*>([^<]+)<\/text>/g)];

  assert.equal(networkUnits.length, 2);
  assert.deepEqual(networkUnits.map((match) => match[2]), ['MB/s', 'MB/s']);
  assert.ok(networkUnits.every((match) => match[1] !== '#f4f7fb'), 'unit colour differs from the signal theme main text');
  assert.doesNotMatch(svg, />NET<\/text>/);
  assert.match(svg, /data-metric-icon="upload"/);
  assert.match(svg, /data-metric-icon="download"/);
  assert.match(svg, /data-network-direction="upload"/);
  assert.match(svg, /data-network-direction="download"/);
  assert.doesNotMatch(svg, />UP<\/text>|>DOWN<\/text>/);
});

test('header shows only the current platform mark without sampling status badges', () => {
  const macSvg = decode(systemStatusRenderIcon(instance()));
  const windowsInstance = instance();
  windowsInstance.platform = 'win32';
  windowsInstance.sampling = true;
  const windowsSvg = decode(systemStatusRenderIcon(windowsInstance));

  assert.match(macSvg, /data-platform-mark="macos"/);
  assert.match(macSvg, /data-platform-mark="macos"[^>]*translate\(45 40\)/);
  assert.doesNotMatch(macSvg, /data-platform-mark="windows"/);
  assert.match(windowsSvg, /data-platform-mark="windows"/);
  assert.match(windowsSvg, /data-platform-mark="windows"[^>]*translate\(45 43\)/);
  assert.doesNotMatch(windowsSvg, /data-platform-mark="macos"/);
  assert.doesNotMatch(`${macSvg}${windowsSvg}`, />LIVE<|>SCAN<|>STALE<|>WAIT<\/text>/);
});

test('manual refresh brightens the platform mark and adds a restrained halo', () => {
  const normalSvg = decode(systemStatusRenderIcon(instance()));
  const refreshingInstance = instance();
  refreshingInstance.manualRefreshing = true;
  const refreshingSvg = decode(systemStatusRenderIcon(refreshingInstance));

  assert.doesNotMatch(normalSvg, /data-manual-refresh-feedback="active"/);
  assert.match(refreshingSvg, /data-manual-refresh-feedback="active"/);
  assert.match(normalSvg, /data-platform-mark="macos" fill="#60a5fa"/);
  assert.match(refreshingSvg, /data-platform-mark="macos" fill="#eff6ff"/);
});

test('manual refresh starts immediately, stays bright through sampling, then restores and reschedules', async () => {
  let resolveCollection;
  const renders = [];
  const clearedSlots = [];
  const delayedSlots = [];
  const scheduledSlots = [];
  const instances = new Map();
  const collection = new Promise((resolve) => {
    resolveCollection = resolve;
  });
  const action = createSystemStatusAction({
    clearInstanceTimeout: (_instance, slot) => clearedSlots.push(slot),
    collectSystemSample: () => collection,
    delayInstance: async (_instance, slot, ms) => {
      delayedSlots.push([slot, ms]);
      return true;
    },
    instances,
    normalizeNumberString: (value) => String(value),
    readPersistedState: () => ({}),
    renderInstance: (current) => renders.push({
      manualRefreshing: current.manualRefreshing,
      sampling: current.sampling,
    }),
    setInstanceTimeout: (_instance, slot) => scheduledSlots.push(slot),
    writePersistedState: () => true,
  });
  const current = {
    ...instance(),
    historyDirtySamples: 0,
    historyNeedsFlush: false,
    manualRefreshing: false,
    manualRefreshQueued: false,
    networkBaseline: null,
  };
  instances.set(current.context, current);

  const refresh = action.config.onRun(current);
  assert.deepEqual(clearedSlots, ['systemstatus-poll']);
  assert.equal(current.manualRefreshing, true);
  assert.equal(current.sampling, true);
  assert.deepEqual(renders.at(-1), { manualRefreshing: true, sampling: true });

  resolveCollection({
    ok: true,
    at: 1234,
    values: current.values,
    networkBaseline: { rx: 10, tx: 20, at: 1234 },
    advancedSource: '',
  });
  await refresh;

  assert.equal(current.manualRefreshing, false);
  assert.equal(current.sampling, false);
  assert.equal(current.lastSampleAt, 1234);
  assert.equal(delayedSlots[0][0], 'systemstatus-manual-feedback');
  assert.ok(delayedSlots[0][1] > 0 && delayedSlots[0][1] <= 300);
  assert.deepEqual(renders.at(-1), { manualRefreshing: false, sampling: false });
  assert.deepEqual(scheduledSlots, ['systemstatus-poll']);
});

test('a press during automatic sampling queues one immediate manual refresh', async () => {
  let resolveAutomatic;
  let collectionCount = 0;
  const instances = new Map();
  const result = {
    ok: true,
    at: 2345,
    values: { cpu: 20, ram: 30, gpu: null, temperature: 50, upload: 1000, download: 2000 },
    networkBaseline: { rx: 20, tx: 10, at: 2345 },
    advancedSource: '',
  };
  const action = createSystemStatusAction({
    clearInstanceTimeout: () => {},
    collectSystemSample: () => {
      collectionCount += 1;
      if (collectionCount === 1) {
        return new Promise((resolve) => {
          resolveAutomatic = resolve;
        });
      }
      return Promise.resolve(result);
    },
    delayInstance: async () => true,
    instances,
    normalizeNumberString: (value) => String(value),
    readPersistedState: () => ({}),
    renderInstance: () => {},
    setInstanceTimeout: () => {},
    writePersistedState: () => true,
  });
  const current = {
    ...instance(),
    historyDirtySamples: 0,
    historyNeedsFlush: false,
    manualRefreshing: false,
    manualRefreshQueued: false,
    networkBaseline: null,
  };
  instances.set(current.context, current);

  const automatic = action.testing.systemStatusSample(current);
  await action.config.onRun(current);
  assert.equal(current.manualRefreshing, true);
  assert.equal(current.manualRefreshQueued, true);
  resolveAutomatic(result);
  await automatic;

  assert.equal(collectionCount, 2);
  assert.equal(current.manualRefreshing, false);
  assert.equal(current.manualRefreshQueued, false);
});

test('all six metrics use vector icons instead of text labels', () => {
  const hardwareSvg = decode(systemStatusRenderIcon(instance({ metric1: 'cpu', metric2: 'ram', metric3: 'gpu' })));
  const sensorSvg = decode(systemStatusRenderIcon(instance({ metric1: 'temperature', metric2: 'upload', metric3: 'download' })));
  const combined = `${hardwareSvg}${sensorSvg}`;

  for (const key of ['cpu', 'ram', 'gpu', 'temperature', 'upload', 'download']) {
    assert.match(combined, new RegExp(`data-metric-icon="${key}"`));
  }
  assert.doesNotMatch(combined, />CPU<\/text>|>RAM<\/text>|>GPU<\/text>|>TEMP<\/text>|>NET<\/text>/);
});

test('system status history keeps only the latest 24 valid samples per metric', () => {
  const history = systemStatusHydrateState(null).history;
  for (let value = 1; value <= 30; value += 1) {
    assert.equal(systemStatusAppendHistory(history, {
      cpu: value,
      ram: value + 1,
      gpu: null,
      temperature: value + 2,
      upload: value * 1000,
      download: value * 2000,
    }), true);
  }
  systemStatusAppendHistory(history, { cpu: Number.NaN, ram: -1 });

  assert.equal(history.cpu.length, 24);
  assert.deepEqual(history.cpu, Array.from({ length: 24 }, (_, index) => index + 7));
  assert.equal(history.gpu.length, 0);
  assert.equal(history.download.at(-1), 60_000);
});

test('system status history hydrates safely and persists independently from settings', () => {
  const context = 'com.ulanzi.ulanzistudio.lexutility.systemstatus___history___key';
  const oversized = Array.from({ length: 30 }, (_, index) => index + 1);
  const payload = systemStatusSerializeState({ history: { cpu: oversized, download: [1000, 2000] } });
  assert.equal(writePersistedState(context, payload), true);

  const state = ACTION_CONFIGS.systemstatus.createState({ context });
  assert.deepEqual(state.history.cpu, oversized.slice(-24));
  assert.deepEqual(state.history.download, [1000, 2000]);
  assert.equal(readPersistedState(context).v, 1);
  assert.deepEqual(systemStatusHydrateState({ v: 99, history: { cpu: [88] } }).history.cpu, []);
});

test('CPU RAM GPU and temperature use bars while network uses line charts', () => {
  assert.equal(systemStatusChartTypeForMetric('cpu'), 'bars');
  assert.equal(systemStatusChartTypeForMetric('temperature'), 'bars');
  assert.equal(systemStatusChartTypeForMetric('upload'), 'line');
  assert.equal(systemStatusChartTypeForMetric('download'), 'line');

  const svg = decode(systemStatusRenderIcon(instance({ metric1: 'cpu', metric2: 'temperature', metric3: 'download' })));
  assert.equal((svg.match(/data-chart-type="bars"/g) || []).length, 2);
  assert.equal((svg.match(/data-chart-type="line"/g) || []).length, 1);
  assert.equal((svg.match(/data-history-count="24"/g) || []).length, 3);
  assert.equal((svg.match(/data-history-bar="true"/g) || []).length, 48);
  assert.match(svg, /<polyline /);
  assert.match(svg, /data-history-bar="true"[^>]*opacity="0\.28"/);
  assert.match(svg, /<polygon [^>]*opacity="0\.15"/);
  assert.match(svg, /<polyline [^>]*opacity="0\.64"/);
});
