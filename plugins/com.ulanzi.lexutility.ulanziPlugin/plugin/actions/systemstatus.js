import { execFile } from 'node:child_process';
import systeminformation from 'systeminformation';

const METRIC_KEYS = Object.freeze(['cpu', 'ram', 'gpu', 'temperature', 'upload', 'download']);
const DEFAULT_METRICS = Object.freeze(['cpu', 'ram', 'download']);
const LHM_DEFAULT_URL = 'http://127.0.0.1:8085/data.json';
const IOREG_PATH = '/usr/sbin/ioreg';
const COMMAND_TIMEOUT_MS = 1_500;
const LHM_TIMEOUT_MS = 1_500;
const HISTORY_LIMIT = 24;
const HISTORY_FLUSH_SAMPLES = 24;
const SYSTEM_STATUS_STATE_VERSION = 1;
const MANUAL_REFRESH_FEEDBACK_MS = 300;

function finite(value) {
  if (value == null || value === '') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function percent(value) {
  const number = finite(value);
  return number == null ? null : Math.max(0, Math.min(100, number));
}

function parseSensorValue(value) {
  const match = String(value ?? '').replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  return match ? finite(match[0]) : null;
}

function normalizeLhmUrl(value) {
  try {
    const url = new URL(String(value || LHM_DEFAULT_URL));
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname.toLowerCase());
    if (url.protocol !== 'http:' || !loopback) {
      return LHM_DEFAULT_URL;
    }
    url.username = '';
    url.password = '';
    url.hash = '';
    return url.toString();
  } catch {
    return LHM_DEFAULT_URL;
  }
}

function normalizeMetricSlots(settings = {}) {
  const chosen = [];
  const slots = [settings.metric1, settings.metric2, settings.metric3];
  for (let index = 0; index < slots.length; index += 1) {
    const allowNone = index > 0;
    let key = METRIC_KEYS.includes(slots[index]) ? slots[index] : (allowNone && slots[index] === 'none' ? 'none' : null);
    if (!key || (key !== 'none' && chosen.includes(key))) {
      key = DEFAULT_METRICS.find((candidate) => !chosen.includes(candidate)) || 'none';
    }
    if (index === 0 && key === 'none') {
      key = METRIC_KEYS.find((candidate) => !chosen.includes(candidate)) || DEFAULT_METRICS[index];
    }
    if (key !== 'none') {
      chosen.push(key);
    }
    slots[index] = key;
  }
  const compacted = slots.filter((key) => key !== 'none');
  return {
    metric1: compacted[0] || DEFAULT_METRICS[0],
    metric2: compacted[1] || 'none',
    metric3: compacted[2] || 'none',
  };
}

function selectedMetrics(settings = {}) {
  return [settings.metric1, settings.metric2, settings.metric3]
    .filter((key, index, all) => METRIC_KEYS.includes(key) && all.indexOf(key) === index)
    .slice(0, 3);
}

function runFile(file, args, execFileImpl = execFile) {
  return new Promise((resolve) => {
    execFileImpl(file, args, {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
      signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
    }, (error, stdout) => resolve(error ? '' : String(stdout || '')));
  });
}

function parseMacGpuUtilization(output) {
  const matches = [...String(output || '').matchAll(/"(?:Device|Renderer|Tiler) Utilization %"\s*=\s*(\d+(?:\.\d+)?)/g)];
  const values = matches.map((match) => percent(match[1])).filter((value) => value != null);
  return values.length ? Math.max(...values) : null;
}

function walkLhm(node, ancestry = [], sensors = []) {
  if (!node || typeof node !== 'object') {
    return sensors;
  }
  const identity = [node.HardwareId, node.Text].filter(Boolean).join(' ');
  const path = identity ? [...ancestry, identity] : ancestry;
  if (node.Type && node.Value != null) {
    sensors.push({
      type: String(node.Type).toLowerCase(),
      text: String(node.Text || '').toLowerCase(),
      id: String(node.SensorId || '').toLowerCase(),
      path: path.join(' ').toLowerCase(),
      value: parseSensorValue(node.Value),
    });
  }
  for (const child of Array.isArray(node.Children) ? node.Children : []) {
    walkLhm(child, path, sensors);
  }
  return sensors;
}

function pickLhmSensor(sensors, predicate) {
  const hit = sensors.find((sensor) => sensor.value != null && predicate(sensor));
  return hit ? hit.value : null;
}

function parseLhmMetrics(payload) {
  const sensors = walkLhm(payload);
  const inCpu = (sensor) => /(?:amd|intel)?cpu|processor/.test(sensor.path);
  const inGpu = (sensor) => /gpu|nvidia|radeon/.test(sensor.path);
  const cpuTemperature = pickLhmSensor(sensors, (sensor) => (
    sensor.type === 'temperature' && inCpu(sensor)
    && (/cpu package|core \(tctl\/tdie\)|core max/.test(sensor.text) || /\/temperature\/(?:0|2)$/.test(sensor.id))
  ));
  const gpu = pickLhmSensor(sensors, (sensor) => (
    sensor.type === 'load' && inGpu(sensor)
    && (sensor.text === 'gpu core' || /\/load\/0$/.test(sensor.id))
  ));
  return { gpu: percent(gpu), temperature: cpuTemperature != null && cpuTemperature > 0 ? cpuTemperature : null };
}

function selectGraphicsUtilization(graphics) {
  const values = (graphics?.controllers || [])
    .map((controller) => percent(controller?.utilizationGpu))
    .filter((value) => value != null);
  return values.length ? Math.max(...values) : null;
}

function sumNetworkCounters(interfaces, stats) {
  const externalNames = new Set((Array.isArray(interfaces) ? interfaces : [])
    .filter((item) => !item?.internal && !item?.virtual && item?.operstate !== 'down')
    .flatMap((item) => [item.iface, item.ifaceName].filter(Boolean)));
  const rows = (Array.isArray(stats) ? stats : []).filter((item) => (
    externalNames.size === 0 || externalNames.has(item?.iface)
  ));
  if (!rows.length) {
    return null;
  }
  return rows.reduce((total, item) => ({
    rx: total.rx + Math.max(0, finite(item?.rx_bytes) || 0),
    tx: total.tx + Math.max(0, finite(item?.tx_bytes) || 0),
  }), { rx: 0, tx: 0 });
}

function networkRates(previous, current, now) {
  if (!previous || !current || now <= previous.at || current.rx < previous.rx || current.tx < previous.tx) {
    return { download: null, upload: null, baseline: current ? { ...current, at: now } : previous };
  }
  const seconds = (now - previous.at) / 1000;
  return {
    download: (current.rx - previous.rx) / seconds,
    upload: (current.tx - previous.tx) / seconds,
    baseline: { ...current, at: now },
  };
}

async function settled(call) {
  try {
    return await call();
  } catch {
    return null;
  }
}

async function fetchLhm(url, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(LHM_TIMEOUT_MS) });
    if (!response.ok) {
      return null;
    }
    return parseLhmMetrics(await response.json());
  } catch {
    return null;
  }
}

async function collectSystemSample(options = {}) {
  const {
    si = systeminformation,
    platform = process.platform,
    execFileImpl = execFile,
    fetchImpl = fetch,
    lhmUrl = LHM_DEFAULT_URL,
    now = Date.now(),
    previousNetwork = null,
    wantGpu = true,
  } = options;

  const [load, memory, temperature, interfaces, stats, graphics] = await Promise.all([
    settled(() => si.currentLoad()),
    settled(() => si.mem()),
    settled(() => si.cpuTemperature()),
    settled(() => si.networkInterfaces()),
    settled(() => si.networkStats('*')),
    wantGpu && platform !== 'darwin' ? settled(() => si.graphics()) : Promise.resolve(null),
  ]);

  const counters = sumNetworkCounters(interfaces, stats);
  const rates = networkRates(previousNetwork, counters, now);
  const totalMemory = finite(memory?.total);
  const availableMemory = finite(memory?.available);
  const usedMemory = finite(memory?.active) ?? finite(memory?.used);
  let cpuTemperature = finite(temperature?.main) ?? finite(temperature?.max);
  cpuTemperature = cpuTemperature != null && cpuTemperature > 0 ? cpuTemperature : null;

  let gpu = selectGraphicsUtilization(graphics);
  let advancedSource = '';
  if (platform === 'darwin' && wantGpu) {
    const output = await runFile(IOREG_PATH, ['-r', '-c', 'IOAccelerator', '-d', '1'], execFileImpl);
    gpu = parseMacGpuUtilization(output) ?? gpu;
    if (gpu != null) {
      advancedSource = 'IOREG';
    }
  } else if (platform === 'win32') {
    const lhm = await fetchLhm(normalizeLhmUrl(lhmUrl), fetchImpl);
    gpu = lhm?.gpu ?? gpu;
    cpuTemperature = lhm?.temperature ?? cpuTemperature;
    if (lhm) {
      advancedSource = 'LHM';
    }
  }

  const ram = totalMemory > 0
    ? percent(((totalMemory - (availableMemory ?? (totalMemory - (usedMemory || 0)))) / totalMemory) * 100)
    : null;
  const values = {
    cpu: percent(load?.currentLoad),
    ram,
    gpu,
    temperature: cpuTemperature,
    upload: rates.upload,
    download: rates.download,
  };
  const hasBaseReading = values.cpu != null || values.ram != null || counters != null;
  return {
    ok: hasBaseReading,
    at: now,
    values,
    networkBaseline: rates.baseline,
    advancedSource,
  };
}

function formatRate(bytesPerSecond) {
  const value = finite(bytesPerSecond);
  if (value == null || value < 0) {
    return { value: '—', unit: 'WAIT' };
  }
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let scaled = value;
  let unit = 0;
  while (scaled >= 1000 && unit < units.length - 1) {
    scaled /= 1000;
    unit += 1;
  }
  const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return { value: scaled.toFixed(digits), unit: units[unit] };
}

function formatMetric(key, raw) {
  if (raw == null) {
    return { value: 'N/A', unit: '' };
  }
  if (['cpu', 'ram', 'gpu'].includes(key)) {
    const value = Math.round(percent(raw));
    return { value: String(value), unit: '%' };
  }
  if (key === 'temperature') {
    return { value: finite(raw).toFixed(1), unit: '°C' };
  }
  return formatRate(raw);
}

function emptyMetricHistory() {
  return Object.fromEntries(METRIC_KEYS.map((key) => [key, []]));
}

function normalizeMetricHistory(raw) {
  const history = emptyMetricHistory();
  for (const key of METRIC_KEYS) {
    const source = Array.isArray(raw?.[key]) ? raw[key] : [];
    history[key] = source
      .map((value) => finite(value))
      .filter((value) => value != null && value >= 0)
      .slice(-HISTORY_LIMIT);
  }
  return history;
}

function hydrateSystemStatusState(raw) {
  if (!raw || typeof raw !== 'object' || raw.v !== SYSTEM_STATUS_STATE_VERSION) {
    return { history: emptyMetricHistory() };
  }
  return { history: normalizeMetricHistory(raw.history) };
}

function serializeSystemStatusState(instance) {
  return {
    v: SYSTEM_STATUS_STATE_VERSION,
    history: normalizeMetricHistory(instance.history),
  };
}

function appendSystemStatusHistory(history, values) {
  if (!history || typeof history !== 'object') {
    return false;
  }
  let appended = false;
  for (const key of METRIC_KEYS) {
    const value = finite(values?.[key]);
    if (value == null || value < 0) {
      continue;
    }
    const series = Array.isArray(history[key]) ? history[key] : (history[key] = []);
    series.push(value);
    if (series.length > HISTORY_LIMIT) {
      series.splice(0, series.length - HISTORY_LIMIT);
    }
    appended = true;
  }
  return appended;
}

function chartTypeForMetric(key) {
  return key === 'upload' || key === 'download' ? 'line' : 'bars';
}

function historyScale(key, values) {
  if (key === 'temperature') {
    return Math.max(110, ...values);
  }
  if (['cpu', 'ram', 'gpu'].includes(key)) {
    return 100;
  }
  return Math.max(1, ...values);
}

function renderMetricHistory(key, rawHistory, geometry, color) {
  const values = (Array.isArray(rawHistory) ? rawHistory : [])
    .map((value) => finite(value))
    .filter((value) => value != null && value >= 0)
    .slice(-HISTORY_LIMIT);
  if (!values.length) {
    return '';
  }

  const { x, y, width, height } = geometry;
  const insetY = 4;
  const chartTop = y + insetY;
  const chartBottom = y + height - insetY;
  const chartHeight = Math.max(1, chartBottom - chartTop);
  const scale = historyScale(key, values);
  const startIndex = HISTORY_LIMIT - values.length;
  const slotWidth = width / HISTORY_LIMIT;
  const chartType = chartTypeForMetric(key);

  if (chartType === 'bars') {
    const barWidth = Math.max(2, slotWidth - 2);
    const bars = values.map((value, index) => {
      const ratio = Math.max(0, Math.min(1, value / scale));
      const barHeight = Math.max(1.5, ratio * chartHeight);
      const barX = x + (startIndex + index) * slotWidth + (slotWidth - barWidth) / 2;
      return `<rect data-history-bar="true" x="${barX.toFixed(1)}" y="${(chartBottom - barHeight).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="1.2" fill="${color}" opacity="0.28"/>`;
    }).join('');
    return `<g data-chart-type="bars" data-history-count="${values.length}">${bars}</g>`;
  }

  const points = values.map((value, index) => {
    const ratio = Math.max(0, Math.min(1, value / scale));
    const pointX = x + (startIndex + index + 0.5) * slotWidth;
    const pointY = chartBottom - ratio * chartHeight;
    return [pointX, pointY];
  });
  if (points.length === 1) {
    const [[pointX, pointY]] = points;
    return `<g data-chart-type="line" data-history-count="1"><circle cx="${pointX.toFixed(1)}" cy="${pointY.toFixed(1)}" r="2.3" fill="${color}" opacity="0.66"/></g>`;
  }
  const line = points.map(([pointX, pointY]) => `${pointX.toFixed(1)},${pointY.toFixed(1)}`).join(' ');
  const firstX = points[0][0].toFixed(1);
  const lastX = points.at(-1)[0].toFixed(1);
  const area = `${firstX},${chartBottom.toFixed(1)} ${line} ${lastX},${chartBottom.toFixed(1)}`;
  return `<g data-chart-type="line" data-history-count="${values.length}"><polygon points="${area}" fill="${color}" opacity="0.15"/><polyline points="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.64"/></g>`;
}

function metricColor(key, raw, theme) {
  if (raw == null) {
    return theme.muted;
  }
  const normalized = key === 'temperature' ? raw / 1.05 : raw;
  if (['cpu', 'ram', 'gpu', 'temperature'].includes(key) && normalized >= 90) {
    return theme.crit;
  }
  if (['cpu', 'ram', 'gpu', 'temperature'].includes(key) && normalized >= 75) {
    return theme.warn;
  }
  return theme.accent;
}

function metricIcon(key, centerY, color) {
  const transform = `translate(54 ${(centerY - 10).toFixed(1)})`;
  const common = `fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;
  if (key === 'cpu') {
    return `<g data-metric-icon="cpu" transform="${transform}" ${common}><rect x="4" y="4" width="12" height="12" rx="2.5"/><rect x="8" y="8" width="4" height="4" rx="1" fill="${color}" stroke="none" opacity="0.72"/><path d="M7 1v3m6-3v3M7 16v3m6-3v3M1 7h3m-3 6h3m12-6h3m-3 6h3"/></g>`;
  }
  if (key === 'ram') {
    return `<g data-metric-icon="ram" transform="${transform}" ${common}><rect x="1" y="4" width="18" height="11" rx="2.5"/><path d="M5 8h2m3 0h2m3 0h1M5 15v3m4-3v3m4-3v3m4-3v3"/></g>`;
  }
  if (key === 'gpu') {
    return `<g data-metric-icon="gpu" transform="${transform}" ${common}><rect x="1" y="3" width="17" height="14" rx="2.5"/><circle cx="9.5" cy="10" r="4"/><path d="m9.5 6 1.2 2.8 2.8 1.2-2.8 1.2-1.2 2.8-1.2-2.8L5.5 10l2.8-1.2zM18 7h2v6h-2"/></g>`;
  }
  if (key === 'temperature') {
    return `<g data-metric-icon="temperature" transform="${transform}" ${common}><path d="M8 4a3 3 0 0 1 6 0v8.2a5 5 0 1 1-6 0z"/><path d="M11 7v8"/><circle cx="11" cy="16" r="2" fill="${color}" stroke="none"/></g>`;
  }
  const direction = key === 'upload' ? 'upload' : 'download';
  const arrow = key === 'upload' ? 'M10 14V3m-4 4 4-4 4 4' : 'M10 3v11m-4-4 4 4 4-4';
  return `<g data-metric-icon="${key}" data-network-direction="${direction}" transform="${transform}" ${common}><path d="${arrow}"/><path d="M3 16v2h14v-2"/></g>`;
}

function platformMark(platform, color) {
  if (platform === 'win32') {
    return `<g data-platform-mark="windows" fill="${color}" transform="translate(45 43)"><path d="M0 2.7 10.7 1.2v10.3H0zm12.2-1.7L25 0v11.5H12.2zM0 13h10.7v10.3L0 21.8zm12.2 0H25v11.5l-12.8-1.8z"/></g>`;
  }
  // 使用矢量轮廓而不是系统字体字形，确保宿主与设备端渲染一致。
  return `<g data-platform-mark="macos" fill="${color}" transform="translate(45 40) scale(0.92)"><path d="M16.3 5.5c1-1.2 1.6-2.9 1.4-4.5-1.5.1-3.2 1-4.2 2.2-.9 1-1.6 2.6-1.3 4.1 1.6.1 3.1-.7 4.1-1.8zM22.7 15.1c0-3.6 3-5.3 3.1-5.4-1.7-2.4-4.3-2.7-5.2-2.7-2.2-.2-4.3 1.3-5.4 1.3S12.4 7 10.6 7C8.3 7 6.1 8.4 4.9 10.5c-2.5 4.3-.7 10.7 1.8 14.2 1.2 1.7 2.6 3.7 4.4 3.6 1.8-.1 2.5-1.2 4.7-1.2 2.1 0 2.8 1.2 4.7 1.1 2 0 3.2-1.8 4.4-3.5 1.4-2 1.9-4 1.9-4.1-.1 0-4.1-1.6-4.1-5.5z"/></g>`;
}

function renderSystemStatusIcon(instance, runtime) {
  const { escapeXml, frameContent, frameFor, renderThemeBackdrop, themeFor, toDataUrl } = runtime;
  const theme = themeFor(instance.settings);
  const frame = frameFor(instance.settings);
  const backdrop = renderThemeBackdrop(theme, theme.accent, frame);
  const keys = selectedMetrics(instance.settings);
  const values = instance.values || {};
  const history = normalizeMetricHistory(instance.history);
  const gap = 6;
  const top = 80;
  const bottom = 214;
  const rowHeight = (bottom - top - gap * (keys.length - 1)) / keys.length;
  const platformColor = instance.manualRefreshing ? backdrop.text : theme.accent;
  const refreshFeedback = instance.manualRefreshing
    ? `<circle data-manual-refresh-feedback="active" cx="58" cy="54" r="18" fill="${theme.accent}" opacity="0.22"/><circle cx="58" cy="54" r="16" fill="none" stroke="${backdrop.text}" stroke-width="1.5" opacity="0.42"/>`
    : '';

  const rows = keys.map((key, index) => {
    const y = top + index * (rowHeight + gap);
    const display = formatMetric(key, values[key]);
    const color = metricColor(key, values[key], theme);
    const valueSize = keys.length === 1 ? 42 : keys.length === 2 ? 34 : 29;
    const isNetworkMetric = key === 'upload' || key === 'download';
    const unitSize = isNetworkMetric ? 15 : 14;
    const unitColor = isNetworkMetric ? theme.accent : theme.muted;
    const rowCenterY = Number((y + rowHeight / 2).toFixed(1));
    const icon = metricIcon(key, rowCenterY, color);
    const chart = renderMetricHistory(key, history[key], {
      x: 44,
      y,
      width: 170,
      height: rowHeight,
    }, color);
    const unitX = display.unit.length > 3 ? 210 : 212;
    return `
      <g data-metric="${key}">
        <rect x="44" y="${y.toFixed(1)}" width="170" height="${rowHeight.toFixed(1)}" rx="7" fill="${theme.panel}" opacity="0.64" stroke="${theme.low}" stroke-width="1"/>
        ${chart}
        ${icon}
        <text x="${display.unit ? 172 : 207}" y="${(y + rowHeight / 2 + valueSize * 0.34).toFixed(1)}" text-anchor="end" fill="${display.value === 'N/A' ? theme.muted : theme.text}" font-size="${valueSize}" font-weight="800" font-family="Arial,Helvetica,sans-serif">${escapeXml(display.value)}</text>
        ${display.unit ? `<text data-role="unit" data-unit-kind="${isNetworkMetric ? 'network' : 'standard'}" x="${unitX}" y="${(y + rowHeight / 2 + 5).toFixed(1)}" text-anchor="end" fill="${unitColor}" font-size="${unitSize}" font-weight="700" font-family="Arial,Helvetica,sans-serif">${escapeXml(display.unit)}</text>` : ''}
      </g>`;
  }).join('');

  const inner = `
    ${refreshFeedback}
    ${platformMark(instance.platform, platformColor)}
    <text x="82" y="59" fill="${backdrop.text}" font-size="20" font-weight="800" font-family="Arial,Helvetica,sans-serif">SYSTEM</text>
    ${rows}`;
  return toDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="392" height="392" viewBox="0 0 256 256">${backdrop.outer}${frameContent(frame, inner)}</svg>`);
}

export function createSystemStatusAction(runtime) {
  const {
    clearInstanceTimeout,
    collectSystemSample: collectSample = collectSystemSample,
    delayInstance,
    instances: INSTANCES,
    normalizeNumberString,
    readPersistedState,
    renderInstance,
    setInstanceTimeout,
    writePersistedState,
  } = runtime;

  function flushHistory(instance) {
    if (!instance.historyNeedsFlush) {
      return true;
    }
    const written = writePersistedState(instance.context, serializeSystemStatusState(instance));
    // 写失败也重新开始批次计数，避免只读/损坏存储导致之后每个采样点都重试写盘；
    // historyNeedsFlush 继续保留，实例释放时仍会再补一次。
    instance.historyDirtySamples = 0;
    if (written) {
      instance.historyNeedsFlush = false;
    }
    return written;
  }

  async function sample(instance, options = {}) {
    const { manualFeedback = false, ...collectOptions } = options;
    if (instance.sampling) {
      if (manualFeedback) {
        instance.manualRefreshQueued = true;
        instance.manualRefreshing = true;
        renderInstance(instance);
      }
      return;
    }
    const manualStartedAt = manualFeedback ? Date.now() : 0;
    if (manualFeedback) {
      instance.manualRefreshing = true;
    }
    instance.sampling = true;
    renderInstance(instance);
    try {
      const result = await collectSample({
        lhmUrl: instance.settings.lhmUrl,
        previousNetwork: instance.networkBaseline,
        wantGpu: selectedMetrics(instance.settings).includes('gpu'),
        ...collectOptions,
      });
      if (INSTANCES.get(instance.context) !== instance) {
        return;
      }
      instance.networkBaseline = result.networkBaseline;
      instance.advancedSource = result.advancedSource;
      instance.lastSampleAt = result.at;
      instance.sampleError = !result.ok;
      instance.values = { ...instance.values, ...result.values };
      if (appendSystemStatusHistory(instance.history, result.values)) {
        instance.historyNeedsFlush = true;
        instance.historyDirtySamples += 1;
        if (instance.historyDirtySamples >= HISTORY_FLUSH_SAMPLES) {
          flushHistory(instance);
        }
      }
    } catch {
      instance.sampleError = true;
    } finally {
      if (manualFeedback && INSTANCES.get(instance.context) === instance) {
        const remainingFeedbackMs = MANUAL_REFRESH_FEEDBACK_MS - (Date.now() - manualStartedAt);
        if (remainingFeedbackMs > 0) {
          await delayInstance(instance, 'systemstatus-manual-feedback', remainingFeedbackMs);
        }
      }
      instance.sampling = false;
      if (INSTANCES.get(instance.context) === instance) {
        if (instance.manualRefreshQueued) {
          instance.manualRefreshQueued = false;
          return sample(instance, { manualFeedback: true });
        }
        if (manualFeedback) {
          instance.manualRefreshing = false;
        }
        renderInstance(instance);
        setInstanceTimeout(instance, 'systemstatus-poll', () => sample(instance), Number(instance.settings.pollSec) * 1000);
      }
    }
  }

  function runManualRefresh(instance) {
    clearInstanceTimeout(instance, 'systemstatus-poll');
    return sample(instance, { manualFeedback: true });
  }

  const defaults = {
    metric1: 'cpu',
    metric2: 'ram',
    metric3: 'download',
    pollSec: '2',
    lhmUrl: LHM_DEFAULT_URL,
    theme: 'signal',
    frameSize: 'optimal',
    showFrame: 'true',
  };

  return {
    key: 'systemstatus',
    config: {
      defaults,
      normalizeSettings(settings) {
        return {
          ...normalizeMetricSlots(settings),
          pollSec: normalizeNumberString(settings.pollSec, defaults.pollSec, 1, 30),
          lhmUrl: normalizeLhmUrl(settings.lhmUrl),
        };
      },
      createState: (instance) => ({
        platform: process.platform,
        values: Object.fromEntries(METRIC_KEYS.map((key) => [key, null])),
        ...hydrateSystemStatusState(readPersistedState(instance.context)),
        historyDirtySamples: 0,
        historyNeedsFlush: false,
        networkBaseline: null,
        lastSampleAt: 0,
        sampleError: false,
        sampling: false,
        manualRefreshing: false,
        manualRefreshQueued: false,
        started: false,
        advancedSource: '',
      }),
      onRun: (instance) => runManualRefresh(instance),
      onReady(instance) {
        if (!instance.started) {
          instance.started = true;
          return sample(instance);
        }
        return undefined;
      },
      onSettingsChanged(instance, previousSettings) {
        const sourceChanged = previousSettings.lhmUrl !== instance.settings.lhmUrl;
        const intervalChanged = previousSettings.pollSec !== instance.settings.pollSec;
        if (sourceChanged) {
          instance.values.gpu = null;
          instance.values.temperature = null;
        }
        if (sourceChanged || intervalChanged) {
          clearInstanceTimeout(instance, 'systemstatus-poll');
          instance.networkBaseline = null;
        }
        return sample(instance);
      },
      onDispose(instance) {
        flushHistory(instance);
      },
      render: (instance) => renderSystemStatusIcon(instance, runtime),
    },
    testing: {
      systemStatusCollectSample: collectSystemSample,
      systemStatusAppendHistory: appendSystemStatusHistory,
      systemStatusChartTypeForMetric: chartTypeForMetric,
      systemStatusFormatMetric: formatMetric,
      systemStatusHydrateState: hydrateSystemStatusState,
      systemStatusNetworkRates: networkRates,
      systemStatusNormalizeLhmUrl: normalizeLhmUrl,
      systemStatusNormalizeMetricSlots: normalizeMetricSlots,
      systemStatusParseLhmMetrics: parseLhmMetrics,
      systemStatusParseMacGpuUtilization: parseMacGpuUtilization,
      systemStatusRenderIcon: (instance) => renderSystemStatusIcon(instance, runtime),
      systemStatusRunManualRefresh: runManualRefresh,
      systemStatusSample: sample,
      systemStatusSerializeState: serializeSystemStatusState,
      systemStatusSelectedMetrics: selectedMetrics,
      systemStatusSumNetworkCounters: sumNetworkCounters,
    },
  };
}
