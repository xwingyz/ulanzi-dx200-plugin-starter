import assert from 'node:assert/strict';
import { test } from 'node:test';

import { __testing } from '../plugins/com.ulanzi.lexutility.ulanziPlugin/plugin/app.js';

const {
  ACTION_CONFIGS,
  nasApplyResult,
  nasBackoffDelay,
  nasBuildBaseUrl,
  nasFetchWithRetry,
  nasFormatBytes,
  nasHandleLongPress,
  nasHandleShortPress,
  nasHydrateState,
  nasIsCompleteSettings,
  nasParseApiInfo,
  nasParseDsmInfo,
  nasParseVolumes,
  nasPickVolume,
  nasRunProbe,
  nasSelectedVolumes,
  nasTemperatureSeverity,
  nasUsagePercent,
  nasUsageSeverity,
} = __testing;

const TIB = 2 ** 40;

function decode(icon) {
  return Buffer.from(icon.replace(/^data:image\/svg\+xml;base64,/, ''), 'base64').toString('utf8');
}

function completeSettings(overrides = {}) {
  return {
    ...ACTION_CONFIGS.nasstatus.defaults,
    nasHost: '192.168.1.10',
    username: 'monitor',
    password: 'secret',
    ...overrides,
  };
}

function instance(settings = {}, state = {}) {
  return {
    context: 'com.ulanzi.ulanzistudio.lexutility.nasstatus___test___key',
    active: false,
    settings: completeSettings(settings),
    connectionState: 'PENDING',
    errorKind: null,
    hostname: 'DiskStation',
    model: 'DS920+',
    temperature: 42,
    temperatureWarn: false,
    tempHistory: [],
    volumes: [{ id: 'volume_1', totalBytes: 7.1 * TIB, usedBytes: 3.2 * TIB, status: 'normal', description: '' }],
    session: { apiInfo: null, sid: null },
    fetching: false,
    refreshing: false,
    pollStarted: false,
    requestId: 0,
    failureCount: 0,
    lastManualAt: 0,
    lastSeenAt: Date.now(),
    ...state,
  };
}

// ---- DSM 响应解析 ----

test('nasstatus parses SYNO.API.Info and clamps preferred versions', () => {
  const parsed = nasParseApiInfo({
    data: {
      'SYNO.API.Auth': { path: 'auth.cgi', minVersion: 1, maxVersion: 3 },
      'SYNO.DSM.Info': { path: 'entry.cgi', minVersion: 1, maxVersion: 2 },
    },
  });
  assert.deepEqual(parsed, {
    auth: { path: 'auth.cgi', version: 3 },
    dsm: { path: 'entry.cgi', version: 2 },
  });
  // 缺 auth/dsm 视为不可用；存储接口不走预发现（DSM 7.3 未登录清单不暴露它）。
  assert.equal(nasParseApiInfo({ data: { 'SYNO.DSM.Info': { path: 'entry.cgi' } } }), null);
});

test('nasstatus parses DSM info and volume list with byte clamping', () => {
  assert.deepEqual(nasParseDsmInfo({
    data: { hostname: ' DiskStation ', model: 'DS920+', temperature: 43, temperature_warn: false },
  }), { hostname: 'DiskStation', model: 'DS920+', temperature: 43, temperatureWarn: false });
  assert.equal(nasParseDsmInfo({}), null);

  // DSM 实测会把 volume_2 排在前面：解析必须按 id 数值序恢复稳定顺序。
  const volumes = nasParseVolumes({
    data: {
      volumes: [
        { id: 'volume_2', size: { total: '2000', used: '500' }, status: 'normal', vol_desc: '备份' },
        { id: 'volume_1', size: { total: '1000', used: '1200' }, status: 'normal' },
        { id: '', size: { total: '10', used: '1' } },
        { id: 'volume_3', size: { total: 'x', used: '1' } },
      ],
    },
  });
  assert.equal(volumes.length, 2);
  assert.equal(volumes[0].id, 'volume_1', '默认第一个卷的语义依赖排序');
  assert.equal(volumes[0].usedBytes, 1000, '已用不得超过总量');
  assert.equal(volumes[1].description, '备份');
});

test('nasstatus picks the configured volume and falls back to the first one', () => {
  const volumes = [{ id: 'volume_1' }, { id: 'volume_2' }];
  assert.equal(nasPickVolume(volumes, 'volume_2').id, 'volume_2');
  assert.equal(nasPickVolume(volumes, '').id, 'volume_1');
  assert.equal(nasPickVolume(volumes, 'volume_9').id, 'volume_1');
  assert.equal(nasPickVolume([], 'volume_1'), null);
});

test('nasstatus shows at most two volumes and deduplicates the second slot', () => {
  const volumes = [{ id: 'volume_1' }, { id: 'volume_2' }, { id: 'volume_3' }];
  assert.deepEqual(
    nasSelectedVolumes(volumes, { volumeId: '', volumeId2: 'volume_2' }).map((v) => v.id),
    ['volume_1', 'volume_2'],
  );
  assert.deepEqual(
    nasSelectedVolumes(volumes, { volumeId: '', volumeId2: '' }).map((v) => v.id),
    ['volume_1'],
    '卷 2 留空则只显示一行存储',
  );
  assert.deepEqual(
    nasSelectedVolumes(volumes, { volumeId: 'volume_2', volumeId2: 'volume_2' }).map((v) => v.id),
    ['volume_2'],
    '卷 2 与卷 1 相同则去重',
  );
  assert.deepEqual(nasSelectedVolumes([], { volumeId: '', volumeId2: 'volume_2' }), []);
});

// ---- 取数状态机 ----

function respond(routes) {
  const calls = [];
  return {
    calls,
    getJson: async (url) => {
      calls.push(url);
      const hit = routes.find(([match]) => url.includes(match));
      if (!hit) throw new Error(`unexpected url: ${url}`);
      return typeof hit[1] === 'function' ? hit[1](url) : hit[1];
    },
  };
}

const API_INFO_OK = {
  ok: true,
  json: {
    success: true,
    data: {
      'SYNO.API.Auth': { path: 'auth.cgi', minVersion: 1, maxVersion: 6 },
      'SYNO.DSM.Info': { path: 'entry.cgi', minVersion: 1, maxVersion: 2 },
    },
  },
};
const DSM_INFO_OK = {
  ok: true,
  json: { success: true, data: { hostname: 'DiskStation', model: 'DS920+', temperature: 41, temperature_warn: false } },
};
const STORAGE_OK = {
  ok: true,
  json: { success: true, data: { volumes: [{ id: 'volume_1', size: { total: '1000', used: '450' } }] } },
};

test('nasstatus full fetch flow logs in once and reuses the session', async () => {
  const { getJson, calls } = respond([
    ['SYNO.API.Info', API_INFO_OK],
    ['method=login', { ok: true, json: { success: true, data: { sid: 'sid-1' } } }],
    ['SYNO.DSM.Info', DSM_INFO_OK],
    ['api=SYNO.Storage.CGI.Storage', STORAGE_OK],
  ]);
  const session = { apiInfo: null, sid: null, storageApi: null };
  const first = await nasFetchWithRetry(completeSettings(), session, { getJson });
  assert.equal(first.state, 'ONLINE');
  assert.equal(first.system.hostname, 'DiskStation');
  assert.equal(first.volumes.length, 1);
  assert.equal(session.sid, 'sid-1');
  assert.equal(session.storageApi, 'SYNO.Storage.CGI.Storage', '命中的存储接口名应缓存进会话');

  const before = calls.length;
  const second = await nasFetchWithRetry(completeSettings(), session, { getJson });
  assert.equal(second.state, 'ONLINE');
  const newCalls = calls.slice(before);
  assert.equal(newCalls.some((url) => url.includes('method=login')), false, '会话复用不得重复登录');
  assert.equal(newCalls.some((url) => url.includes('SYNO.API.Info')), false);
});

test('nasstatus adapts to DSM 7.3: storage name fallback and FileStation hostname', async () => {
  const { getJson } = respond([
    ['SYNO.API.Info', API_INFO_OK],
    ['method=login', { ok: true, json: { success: true, data: { sid: 'sid-73' } } }],
    // DSM 7.3 的 DSM.Info 不带 hostname
    ['SYNO.DSM.Info', { ok: true, json: { success: true, data: { model: 'DS923+', temperature: 76, temperature_warn: false } } }],
    ['SYNO.FileStation.Info', { ok: true, json: { success: true, data: { hostname: 'xwing-ds' } } }],
    // 点号新名不存在（102）→ 回退下划线旧名
    ['api=SYNO.Storage.CGI.Storage', { ok: true, json: { success: false, error: { code: 102 } } }],
    ['api=SYNO.Storage.CGI_Storage', STORAGE_OK],
  ]);
  const session = { apiInfo: null, sid: null, storageApi: null };
  const result = await nasFetchWithRetry(completeSettings(), session, { getJson });
  assert.equal(result.state, 'ONLINE');
  assert.equal(result.system.hostname, 'xwing-ds', '主机名应从 FileStation.Info 兜底');
  assert.equal(session.storageApi, 'SYNO.Storage.CGI_Storage');
  assert.equal(result.volumes.length, 1);
});

test('nasstatus re-login retries once on session expiry and classifies errors', async () => {
  let dsmCalls = 0;
  const { getJson } = respond([
    ['SYNO.API.Info', API_INFO_OK],
    ['method=login', { ok: true, json: { success: true, data: { sid: 'sid-next' } } }],
    ['SYNO.DSM.Info', () => {
      dsmCalls += 1;
      return dsmCalls === 1 ? { ok: true, json: { success: false, error: { code: 119 } } } : DSM_INFO_OK;
    }],
    ['SYNO.Storage.CGI', STORAGE_OK],
  ]);
  const session = { apiInfo: null, sid: 'stale-sid', storageApi: null };
  const result = await nasFetchWithRetry(completeSettings(), session, { getJson });
  assert.equal(result.state, 'ONLINE');
  assert.equal(session.sid, 'sid-next');

  const offline = await nasFetchWithRetry(completeSettings(), { apiInfo: null, sid: null, storageApi: null }, {
    getJson: async () => ({ ok: false, kind: 'NETWORK' }),
  });
  assert.deepEqual(offline, { state: 'OFFLINE' });

  const badLogin = respond([
    ['SYNO.API.Info', API_INFO_OK],
    ['method=login', { ok: true, json: { success: false, error: { code: 400 } } }],
  ]);
  const auth = await nasFetchWithRetry(completeSettings(), { apiInfo: null, sid: null, storageApi: null }, { getJson: badLogin.getJson });
  assert.equal(auth.state, 'ERROR');
  assert.equal(auth.kind, 'AUTH');

  // 402：账号存在、密码对，但无 DSM 登录权限（实测新 NAS 未授权账号）→ 权限不足，而非认证失败。
  const noLoginRight = respond([
    ['SYNO.API.Info', API_INFO_OK],
    ['method=login', { ok: true, json: { success: false, error: { code: 402 } } }],
  ]);
  const denied = await nasFetchWithRetry(completeSettings(), { apiInfo: null, sid: null, storageApi: null }, { getJson: noLoginRight.getJson });
  assert.equal(denied.state, 'ERROR');
  assert.equal(denied.kind, 'PERMISSION', '402 无登录权限应归权限不足，不误导查密码');

  const noPerm = respond([
    ['SYNO.API.Info', API_INFO_OK],
    ['method=login', { ok: true, json: { success: true, data: { sid: 's' } } }],
    ['SYNO.DSM.Info', DSM_INFO_OK],
    ['SYNO.Storage.CGI', { ok: true, json: { success: false, error: { code: 105 } } }],
  ]);
  const perm = await nasFetchWithRetry(completeSettings(), { apiInfo: null, sid: null, storageApi: null }, { getJson: noPerm.getJson });
  assert.equal(perm.state, 'ERROR');
  assert.equal(perm.kind, 'PERMISSION', '存储权限不足必须区别于普通接口异常');

  const noStorageApi = respond([
    ['SYNO.API.Info', API_INFO_OK],
    ['method=login', { ok: true, json: { success: true, data: { sid: 's' } } }],
    ['SYNO.DSM.Info', DSM_INFO_OK],
    ['SYNO.Storage.CGI', { ok: true, json: { success: false, error: { code: 102 } } }],
  ]);
  const gone = await nasFetchWithRetry(completeSettings(), { apiInfo: null, sid: null, storageApi: null }, { getJson: noStorageApi.getJson });
  assert.equal(gone.state, 'ERROR');
  assert.equal(gone.kind, 'API', '两个存储接口名都不存在时归为接口异常');
});

test('nasstatus applyResult drives the three visible states and failure counter', () => {
  const target = instance({}, { hostname: '', model: '', volumes: [], lastSeenAt: null });
  const changed = nasApplyResult(target, {
    state: 'ONLINE',
    system: { hostname: 'DiskStation', model: 'DS920+', temperature: 40, temperatureWarn: false },
    volumes: [],
  }, 1_000);
  assert.equal(changed, true, '身份首次出现应触发落盘');
  assert.equal(target.connectionState, 'ONLINE');
  assert.equal(target.failureCount, 0);
  assert.equal(target.lastSeenAt, 1_000);

  nasApplyResult(target, { state: 'OFFLINE' });
  assert.equal(target.connectionState, 'OFFLINE');
  assert.equal(target.errorKind, null);
  assert.equal(target.failureCount, 1);

  nasApplyResult(target, { state: 'ERROR', kind: 'AUTH' });
  assert.equal(target.connectionState, 'ERROR');
  assert.equal(target.errorKind, 'AUTH');
  assert.equal(target.failureCount, 2);
});

test('nasstatus backoff walks 60s then caps at 120s', () => {
  assert.equal(nasBackoffDelay(1), 60_000);
  assert.equal(nasBackoffDelay(2), 120_000);
  assert.equal(nasBackoffDelay(9), 120_000);
});

// ---- 格式化与阈值 ----

test('nasstatus formats bytes and maps usage severity thresholds', () => {
  assert.equal(nasFormatBytes(3.2 * TIB), '3.2T');
  assert.equal(nasFormatBytes(512 * 2 ** 30), '512.0G');
  assert.equal(nasFormatBytes(200 * 2 ** 20), '200M');
  assert.equal(nasFormatBytes(-1), '--');

  assert.equal(nasUsagePercent({ totalBytes: 1000, usedBytes: 450 }), 45);
  assert.equal(nasUsagePercent(null), null);
  assert.equal(nasUsageSeverity(45), 'normal');
  assert.equal(nasUsageSeverity(80), 'warning');
  assert.equal(nasUsageSeverity(90), 'critical');
});

test('nasstatus temperature severity turns above 75°C and honors the DSM warn flag', () => {
  assert.equal(nasTemperatureSeverity(42), 'normal');
  assert.equal(nasTemperatureSeverity(75), 'normal', '75 整数还在正常档，超过才变色');
  assert.equal(nasTemperatureSeverity(76), 'warning');
  assert.equal(nasTemperatureSeverity(90), 'critical');
  assert.equal(nasTemperatureSeverity(null), 'normal');
  assert.equal(nasTemperatureSeverity(null, true), 'warning', 'DSM temperature_warn 强制至少告警');
  assert.equal(nasTemperatureSeverity(60, true), 'warning');
});

// ---- 设置与运行态 ----

test('nasstatus settings normalize ports, intervals and completeness', () => {
  const defaults = ACTION_CONFIGS.nasstatus.defaults;
  const normalized = ACTION_CONFIGS.nasstatus.normalizeSettings({
    nasHost: ' 192.168.1.10 ',
    nasPort: '99999',
    useHttps: 'nope',
    pollSec: '1',
    username: ' monitor ',
    password: ' secret ',
  }, defaults);
  assert.equal(normalized.nasHost, '192.168.1.10');
  assert.equal(normalized.nasPort, '65535');
  assert.equal(normalized.useHttps, 'true');
  assert.equal(normalized.pollSec, '15');
  assert.equal(normalized.volumeId2, '');
  assert.equal(normalized.tempChart, 'line');
  assert.equal(
    ACTION_CONFIGS.nasstatus.normalizeSettings({ tempChart: 'bars' }, defaults).tempChart,
    'bars',
  );
  assert.equal(
    ACTION_CONFIGS.nasstatus.normalizeSettings({ tempChart: 'pie' }, defaults).tempChart,
    'line',
    '非法图表类型回落折线',
  );
  assert.equal(nasIsCompleteSettings(normalized), true);
  assert.equal(nasIsCompleteSettings({ ...normalized, password: '' }), false);

  assert.equal(nasBuildBaseUrl({ nasHost: 'nas.local', nasPort: '5000', useHttps: 'false' }), 'http://nas.local:5000');
  assert.equal(nasBuildBaseUrl({ nasHost: 'nas.local', nasPort: '5001', useHttps: 'true' }), 'https://nas.local:5001');
});

test('nasstatus hydrates persisted identity and degrades invalid payloads', () => {
  assert.deepEqual(nasHydrateState({ v: 1, hostname: 'DiskStation', model: 'DS920+', lastSeenAt: 123 }), {
    hostname: 'DiskStation', model: 'DS920+', lastSeenAt: 123,
  });
  assert.deepEqual(nasHydrateState({ v: 99, hostname: 'x' }), { hostname: '', model: '', lastSeenAt: null });
  assert.deepEqual(nasHydrateState(null), { hostname: '', model: '', lastSeenAt: null });
});

// ---- 交互 ----

test('nasstatus short press refreshes with a cooldown window', () => {
  const target = instance();
  let runs = 0;
  const run = () => { runs += 1; return Promise.resolve(); };
  nasHandleShortPress(target, { now: 10_000, run });
  assert.equal(runs, 1);
  assert.equal(target.refreshing, true);
  nasHandleShortPress(target, { now: 12_000, run });
  assert.equal(runs, 1, '冷却窗口内的连按必须忽略');
  nasHandleShortPress(target, { now: 16_000, run });
  assert.equal(runs, 2);
});

test('nasstatus long press opens the DSM url on macOS only', () => {
  const spawned = [];
  const spawnFn = (command, args) => {
    spawned.push([command, ...args]);
    return { on: () => {}, unref: () => {} };
  };
  nasHandleLongPress(instance(), { spawnFn, platform: 'darwin' });
  assert.deepEqual(spawned, [['open', 'https://192.168.1.10:5001/']]);

  nasHandleLongPress(instance(), { spawnFn, platform: 'win32' });
  assert.equal(spawned.length, 1, '非 macOS 平台跳过');
  nasHandleLongPress(instance({ nasHost: '' }), { spawnFn, platform: 'darwin' });
  assert.equal(spawned.length, 1, '缺地址时跳过');
});

test('nasstatus probe replies volume options and never echoes credentials', async () => {
  const target = instance();
  const sent = [];
  const send = (payload) => sent.push(payload);

  await nasRunProbe(target, { nasHost: '' }, { send });
  assert.equal(sent[0].__nasstatusProbeResult.status, 'incomplete');

  const fetchImpl = async () => ({
    state: 'ONLINE',
    system: { hostname: 'DiskStation', model: 'DS920+', temperature: 41, temperatureWarn: false },
    volumes: [{ id: 'volume_1', totalBytes: 1000 * 2 ** 30, usedBytes: 450 * 2 ** 30 }],
  });
  const payload = await nasRunProbe(target, {}, { send, fetchImpl });
  assert.equal(payload.status, 'ok');
  assert.equal(payload.volumes.length, 1);
  assert.match(payload.volumes[0].label, /^卷 1 · /);
  assert.equal(JSON.stringify(payload).includes('secret'), false, '诊断回传不得包含密码');

  const authFail = await nasRunProbe(target, {}, { send, fetchImpl: async () => ({ state: 'ERROR', kind: 'AUTH' }) });
  assert.match(authFail.message, /认证失败/);
});

// ---- 渲染 ----

test('nasstatus renders online face with name, temperature and capacity row', () => {
  const svg = decode(ACTION_CONFIGS.nasstatus.render(instance({}, { connectionState: 'ONLINE' })));
  // 机器名在头部右上角，超过 9 字符按设计截断（保留 8 字符 + 省略号）。
  assert.match(svg, /DiskStat…/);
  assert.match(svg, /DS920\+/, '型号显示在温度行');
  assert.match(svg, /°C/);
  assert.match(svg, />45</);
  assert.match(svg, />%</);
  assert.match(svg, /3\.2T\/7\.1T/);
  assert.match(svg, /data-row="temperature"/);
  assert.match(svg, /data-row="storage"/);
});

test('nasstatus renders distinct offline, error and config states', () => {
  const offline = decode(ACTION_CONFIGS.nasstatus.render(instance({}, { connectionState: 'OFFLINE' })));
  assert.match(offline, /离线/);
  assert.match(offline, /上次在线/);

  const error = decode(ACTION_CONFIGS.nasstatus.render(instance({}, { connectionState: 'ERROR', errorKind: 'AUTH' })));
  assert.match(error, /异常/);
  assert.match(error, /认证失败/);

  const perm = decode(ACTION_CONFIGS.nasstatus.render(instance({}, { connectionState: 'ERROR', errorKind: 'PERMISSION' })));
  assert.match(perm, /权限不足/);

  const config = decode(ACTION_CONFIGS.nasstatus.render(instance({ nasHost: '' }, { connectionState: 'CONFIG_REQUIRED' })));
  assert.match(config, /待配置/);

  const pending = decode(ACTION_CONFIGS.nasstatus.render(instance({}, { connectionState: 'PENDING' })));
  assert.match(pending, /连接中/);
});

test('nasstatus temperature above 75 renders the value in warning color', () => {
  const { THEMES } = __testing;
  const hot = decode(ACTION_CONFIGS.nasstatus.render(instance({}, { connectionState: 'ONLINE', temperature: 80 })));
  assert.match(hot, new RegExp(`fill="${THEMES.mint.warn}" font-weight="800"><tspan font-size="22">80<`), '>75°C 数值应取 warn 色');
  const cool = decode(ACTION_CONFIGS.nasstatus.render(instance({}, { connectionState: 'ONLINE', temperature: 42 })));
  assert.match(cool, new RegExp(`fill="${THEMES.mint.text}" font-weight="800"><tspan font-size="22">42<`), '常温数值保持正文色');
});

test('nasstatus renders temperature history as line by default and bars on demand', () => {
  const history = { tempHistory: [40, 42, 45, 43, 44] };
  const line = decode(ACTION_CONFIGS.nasstatus.render(instance({}, { connectionState: 'ONLINE', ...history })));
  assert.match(line, /data-chart-type="line"/);
  const bars = decode(ACTION_CONFIGS.nasstatus.render(instance({ tempChart: 'bars' }, { connectionState: 'ONLINE', ...history })));
  assert.match(bars, /data-chart-type="bars"/);
  const empty = decode(ACTION_CONFIGS.nasstatus.render(instance({}, { connectionState: 'ONLINE', tempHistory: [] })));
  assert.doesNotMatch(empty, /data-chart-type/, '无历史时不画图表');
});

test('nasstatus renders a second storage row when volume 2 is configured', () => {
  const volumes = [
    { id: 'volume_1', totalBytes: 7.1 * TIB, usedBytes: 3.2 * TIB },
    { id: 'volume_2', totalBytes: 2 * TIB, usedBytes: 1 * TIB },
  ];
  const two = decode(ACTION_CONFIGS.nasstatus.render(
    instance({ volumeId2: 'volume_2' }, { connectionState: 'ONLINE', volumes }),
  ));
  assert.equal((two.match(/data-row="storage"/g) || []).length, 2);
  assert.match(two, /3\.2T\/7\.1T/);
  assert.match(two, /1\.0T\/2\.0T/);
  const one = decode(ACTION_CONFIGS.nasstatus.render(instance({}, { connectionState: 'ONLINE', volumes })));
  assert.equal((one.match(/data-row="storage"/g) || []).length, 1);
});

test('nasstatus falls back to model when hostname is unavailable', () => {
  const svg = decode(ACTION_CONFIGS.nasstatus.render(instance({}, { connectionState: 'ONLINE', hostname: '' })));
  assert.match(svg, /DS920\+/);
});

test('nasstatus display name prefers override and truncates long names', () => {
  const named = decode(ACTION_CONFIGS.nasstatus.render(instance({ displayName: '仓库' }, { connectionState: 'ONLINE' })));
  assert.match(named, /仓库/);
  const long = decode(ACTION_CONFIGS.nasstatus.render(
    instance({ displayName: 'A'.repeat(24) }, { connectionState: 'ONLINE' }),
  ));
  assert.match(long, /A{8}…/, '头部机器名收紧到 9 字符');
});
