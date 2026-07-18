import assert from 'node:assert/strict';
import { test } from 'node:test';

import { __testing } from '../plugins/com.ulanzi.lexutility.ulanziPlugin/plugin/app.js';

const {
  ACTION_CONFIGS,
  chooseSpeedtestServer,
  hydrateSpeedtestState,
  isWithinActiveWindow,
  parseSpeedtestResult,
  mapSpeedtestDirectoryServers,
  mergeSpeedtestGeo,
  needsSpeedtestDiscovery,
  renderSpeedtestIcon,
  serializeSpeedtestState,
  speedChart,
  speedtestCandidates,
} = __testing;

const ICON_NOW = Date.UTC(2026, 6, 18, 12);

function iconSvg(phase, extra = {}, now = ICON_NOW) {
  return Buffer.from(
    renderSpeedtestIcon({
      settings: { theme: 'signal', frameSize: 'optimal', showFrame: 'true', scope: 'mainland', chartType: 'line' },
      history: [{ at: ICON_NOW, ok: true, downloadMbps: 215, uploadMbps: 66 }],
      lastResult: { at: ICON_NOW, downloadMbps: 215, uploadMbps: 66 },
      lastCompletedAt: ICON_NOW,
      phase, queuePosition: -1, errorCode: '', ...extra,
    }, now).replace(/^data:image\/svg\+xml;base64,/, ''),
    'base64',
  ).toString('utf8');
}

test('speed values are right-aligned against a fixed unit column', () => {
  // 两行数值共用一条右基线，位数变化不会让数字左右跳。
  const twoRows = /text-anchor="end"[^>]*font-size="46"[^>]*>215<[\s\S]*text-anchor="end"[^>]*font-size="46"[^>]*>66</;
  assert.match(iconSvg('idle'), twoRows);
  assert.equal((iconSvg('idle').match(/x="162" y="\d+" text-anchor="end"/g) || []).length, 2);

  // 单位是独立的一列，不再是贴着数字的小字。
  assert.equal((iconSvg('idle').match(/<text x="214"[^>]*font-size="16"[^>]*>Mbps</g) || []).length, 2);

  // 四位数收字号，避免顶到单位列。
  const gigabit = iconSvg('idle', { lastResult: { at: ICON_NOW, downloadMbps: 1024, uploadMbps: 66 } });
  assert.match(gigabit, /text-anchor="end"[^>]*font-size="38"[^>]*>1024</);

  // 方向箭头是描边路径而不是 ↓↑ 文字：字形来自回退字体时 font-weight
  // 不一定生效，粗细只有靠 stroke-width 才是确定的。
  assert.equal((iconSvg('idle').match(/<path d="M 51 [^"]+" fill="none" stroke=/g) || []).length, 2);
  assert.ok(!iconSvg('idle').includes('↓') && !iconSvg('idle').includes('↑'));
});

test('header shows how old the reading is, and yields to status', () => {
  const minutes = (n) => ICON_NOW + n * 60_000;

  assert.match(iconSvg('idle', {}, minutes(0)), />now</);
  assert.match(iconSvg('idle', {}, minutes(15)), />&gt;15m</);
  assert.match(iconSvg('idle', {}, minutes(90)), />&gt;1h</);
  assert.match(iconSvg('idle', {}, minutes(60 * 24 * 3)), />&gt;3d</);
  // 天数封顶 99，长期没测也不会挤掉标题。
  assert.match(iconSvg('idle', {}, minutes(60 * 24 * 400)), />&gt;99d</);

  // 测速中标题行让位给状态色块，否则色块会盖住时间。
  const stamp = /x="214" y="60"/;
  assert.doesNotMatch(iconSvg('running', {}, minutes(15)), stamp);
  // 没有测速结果时不显示时间，避免出现从 0 时间戳算出来的荒谬值。
  assert.doesNotMatch(iconSvg('idle', { lastResult: null, lastCompletedAt: 0 }, minutes(15)), stamp);
});

test('testing state drops the inner ring and puts the label on a filled pill', () => {
  const svg = (phase, extra = {}) => iconSvg(phase, extra);

  // frameHighlight 画的是 stroke-width="6" 的内框线，测速中不该再出现。
  assert.ok(!svg('running').includes('stroke-width="6"'), '测速状态不应再画内框线');
  assert.ok(!svg('idle').includes('stroke-width="6"'));

  // 状态文字压在底色块上，而不是裸文字。
  assert.match(svg('running'), /<rect x="44" y="38"[^>]*fill="#60a5fa"\/>\s*<text[^>]*>TESTING</);
  // 错误用红底白字，和"正在测速"的强调色块区分开。
  assert.match(svg('error', { errorCode: 'CLI' }), /<rect x="44" y="38"[^>]*fill="#ef4444"/);
  // 空闲状态没有色块，标题就是区域代号。
  assert.ok(!svg('idle').includes('y="38"'));
  assert.match(svg('idle'), />MAINLAND</);
});

test('scope renders as a full word beside the timestamp', () => {
  // 曾经缩成 CN/INTL 来腾地方，但那种简写带政治含义，不能为了排版用。
  // 全称保留，改用 `>15m` 这种短格式的时间戳来腾空间。
  const scoped = (scope) => Buffer.from(
    renderSpeedtestIcon({
      settings: { theme: 'signal', frameSize: 'optimal', showFrame: 'true', scope, chartType: 'line' },
      history: [{ at: ICON_NOW, ok: true, downloadMbps: 215, uploadMbps: 66 }],
      lastResult: { at: ICON_NOW, downloadMbps: 215, uploadMbps: 66 },
      lastCompletedAt: ICON_NOW, phase: 'idle', queuePosition: -1, errorCode: '',
    }, ICON_NOW).replace(/^data:image\/svg\+xml;base64,/, ''),
    'base64',
  ).toString('utf8');

  assert.match(scoped('mainland'), />MAINLAND</);
  assert.match(scoped('overseas'), />OVERSEAS</);
  assert.match(scoped('any'), />GLOBAL</);
});

test('chart spans the full width whatever the sample count', () => {
  const at = (n) => Array.from({ length: n }, (_, i) => ({ at: i, ok: true, downloadMbps: 100 + i }));
  const xs = (svg) => [...svg.matchAll(/(?:points="|x=")([\d.]+)/g)].map((m) => Number(m[1]));
  const span = (svg) => {
    const all = [...svg.matchAll(/[\s"]([\d.]+),[\d.]+/g)].map((m) => Number(m[1]));
    return all.length ? [Math.min(...all), Math.max(...all)] : xs(svg);
  };

  // 折线：首尾点必须落在绘图区左右边界，3 次和 12 次都一样。
  for (const count of [2, 3, 12]) {
    const [first, last] = span(speedChart(at(count), 'downloadMbps', 70, 68, '#fff', 'line'));
    assert.equal(first, 44, `${count} 个样本时折线没有从左边界起`);
    assert.equal(last, 214, `${count} 个样本时折线没有画到右边界`);
  }

  // 柱状：最后一根柱子的右缘要贴到右边界（允许柱间空隙的容差）。
  for (const count of [3, 12]) {
    const svg = speedChart(at(count), 'downloadMbps', 70, 68, '#fff', 'bar');
    const rects = [...svg.matchAll(/x="([\d.]+)"[^>]*width="([\d.]+)"/g)].map((m) => Number(m[1]) + Number(m[2]));
    assert.equal(rects.length, count);
    assert.ok(Math.max(...rects) > 211, `${count} 根柱子没有铺满宽度`);
  }

  // 历史再长也只画最近 12 次，且画的是最新的那一段。
  const long = speedChart(at(40), 'downloadMbps', 70, 68, '#fff', 'bar');
  assert.equal([...long.matchAll(/<rect /g)].length, 12);
  // 最后一根是最高的（样本值递增），说明取的是尾部而不是头部。
  const heights = [...long.matchAll(/height="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.equal(Math.max(...heights), heights.at(-1));

  // 单个样本画不出线段，落一个居中的点。
  assert.match(speedChart(at(1), 'downloadMbps', 70, 68, '#fff', 'line'), /<circle cx="129.0"/);
  assert.equal(speedChart([], 'downloadMbps', 70, 68, '#fff', 'line'), '');
});

test('scope filters candidates to mainland, overseas, or everything', () => {
  const serverCache = [
    { id: '1', countryCode: 'CN', city: 'Nanjing' },
    { id: '2', countryCode: 'HK', city: 'Hong Kong' },
    { id: '3', country: '中国', city: 'Shanghai' },
    { id: '4', countryCode: 'JP', city: 'Tokyo' },
  ];
  const ids = (scope) => speedtestCandidates({ scope }, { serverCache }).map((server) => server.id);

  assert.deepEqual(ids('mainland'), ['1', '3']);
  assert.deepEqual(ids('overseas'), ['2', '4']);
  assert.deepEqual(ids('any'), ['1', '2', '3', '4']);
});

test('speedtest action defaults match the confirmed product contract', () => {
  const defaults = ACTION_CONFIGS.speedtest.defaults;

  assert.equal(defaults.scope, 'mainland');
  assert.equal(defaults.intervalMin, '30');
  assert.equal(defaults.activeAllDay, 'false');
  assert.equal(defaults.activeStart, '08:00');
  assert.equal(defaults.activeEnd, '23:00');
  assert.equal(defaults.timeoutSec, '180');
  assert.equal(defaults.candidateServers, '[]');
  assert.equal(defaults.chartType, 'line');
  assert.equal(defaults.geoIpEnabled, 'true');
  // 选择模式由勾选数量推导，不再是独立设置项。
  assert.equal(defaults.selectionMode, undefined);
  assert.equal(defaults.fixedServerId, undefined);
});

test('official speedtest JSON is converted to Mbps without retaining client IP', () => {
  const result = parseSpeedtestResult({
    type: 'result',
    timestamp: '2026-07-18T03:00:00Z',
    ping: { latency: 18.25, jitter: 1.5 },
    download: { bandwidth: 65_000_000, bytes: 390_000_000, elapsed: 6000 },
    upload: { bandwidth: 8_000_000, bytes: 48_000_000, elapsed: 6000 },
    packetLoss: 0.5,
    interface: { externalIp: '203.0.113.10', internalIp: '192.168.1.8' },
    result: { id: 'secret-result', url: 'https://www.speedtest.net/result/c/secret-result' },
    server: {
      id: 12345,
      host: 'speed.example.net',
      name: 'Example Telecom',
      location: 'Nanjing',
      country: 'China',
      ip: '198.51.100.9',
    },
  });

  assert.equal(result.downloadMbps, 520);
  assert.equal(result.uploadMbps, 64);
  assert.equal(result.pingMs, 18.25);
  assert.equal(result.dataBytes, 438_000_000);
  assert.deepEqual(result.server, {
    id: '12345',
    host: 'speed.example.net',
    name: 'Example Telecom',
    city: 'Nanjing',
    country: 'China',
    ip: '198.51.100.9',
  });
  assert.equal('externalIp' in result, false);
  assert.equal('resultUrl' in result, false);
});

test('speedtest state keeps seven days and at most 672 records', () => {
  const now = Date.UTC(2026, 6, 18, 12);
  const history = Array.from({ length: 700 }, (_, index) => ({
    at: now - (699 - index) * 15 * 60 * 1000,
    ok: true,
    downloadMbps: index,
    uploadMbps: index / 10,
  }));
  history.unshift({ at: now - 8 * 24 * 60 * 60 * 1000, ok: true });

  const serialized = serializeSpeedtestState({ history, lastCompletedAt: now }, now);
  const hydrated = hydrateSpeedtestState(serialized, now);

  assert.equal(hydrated.history.length, 672);
  assert.ok(hydrated.history.every((entry) => entry.at >= now - 7 * 24 * 60 * 60 * 1000));
  assert.equal(hydrated.lastCompletedAt, now);
});

test('active windows support normal and cross-midnight schedules', () => {
  const at = (hour, minute = 0) => new Date(2026, 6, 18, hour, minute).getTime();

  assert.equal(isWithinActiveWindow({ activeAllDay: 'true' }, at(3)), true);
  assert.equal(isWithinActiveWindow({ activeAllDay: 'false', activeStart: '08:00', activeEnd: '23:00' }, at(9)), true);
  assert.equal(isWithinActiveWindow({ activeAllDay: 'false', activeStart: '08:00', activeEnd: '23:00' }, at(3)), false);
  assert.equal(isWithinActiveWindow({ activeAllDay: 'false', activeStart: '22:00', activeEnd: '06:00' }, at(23)), true);
  assert.equal(isWithinActiveWindow({ activeAllDay: 'false', activeStart: '22:00', activeEnd: '06:00' }, at(4)), true);
  assert.equal(isWithinActiveWindow({ activeAllDay: 'false', activeStart: '22:00', activeEnd: '06:00' }, at(12)), false);
});

test('checked nodes replace the full cache as the candidate pool', () => {
  const serverCache = [
    { id: '1', countryCode: 'CN', city: 'Nanjing' },
    { id: '2', countryCode: 'CN', city: 'Shanghai' },
    { id: '3', countryCode: 'CN', city: 'Beijing' },
  ];
  const checked = JSON.stringify([serverCache[0], serverCache[2]]);

  assert.deepEqual(
    speedtestCandidates({ scope: 'mainland', candidateServers: checked }, { serverCache })
      .map((server) => server.id),
    ['1', '3'],
  );
  // 勾选仍然要过区域筛选：勾了大陆节点但区域切到海外时候选池为空，
  // 由 needsSpeedtestDiscovery 触发重新发现，而不是拿着不匹配的节点硬测。
  assert.deepEqual(
    speedtestCandidates({ scope: 'overseas', candidateServers: checked }, { serverCache }),
    [],
  );
});

test('one checked node is fixed and several stay deterministic for the day', () => {
  const servers = [
    { id: '1', countryCode: 'CN', city: 'Nanjing' },
    { id: '2', countryCode: 'CN', city: 'Shanghai' },
  ];
  const now = new Date(2026, 6, 18, 9).getTime();

  // 勾一个：候选池只剩它，固定使用，且不写当日粘性状态。
  const singleState = {};
  assert.equal(chooseSpeedtestServer(singleState, [servers[1]], now, () => 0)?.id, '2');
  assert.equal(singleState.dailyServerId, undefined);

  // 一个都没勾：候选池是全部节点，随机结果当天保持不变。
  const state = {};
  const first = chooseSpeedtestServer(state, servers, now, () => 0.99);
  const second = chooseSpeedtestServer(state, servers, now + 60 * 60 * 1000, () => 0);

  assert.equal(first.id, '2');
  assert.equal(second.id, '2');
  assert.equal(state.dailyServerId, '2');
});

test('speedtest.net directory nodes map to the shared server model', () => {
  const servers = mapSpeedtestDirectoryServers([{
    id: '24447',
    host: 'mobile.shunicomtest.com.prod.hosts.ooklaserver.net:8080',
    sponsor: 'China Unicom 5G',
    name: 'Shanghai',
    country: 'China',
    cc: 'CN',
  }]);

  assert.deepEqual(servers, [{
    id: '24447',
    host: 'mobile.shunicomtest.com.prod.hosts.ooklaserver.net:8080',
    name: 'China Unicom 5G',
    city: 'Shanghai',
    country: 'China',
    countryCode: 'CN',
    ip: '',
    ipCity: '',
    ipCountry: '',
    ipCountryCode: '',
    locationSource: 'official',
  }]);
});

test('node discovery runs initially, when stale, or when the configured scope is absent', () => {
  const now = Date.UTC(2026, 6, 18, 12);
  const mainland = { id: '1', countryCode: 'CN', country: 'China' };
  const overseas = { id: '2', countryCode: 'US', country: 'United States' };

  assert.equal(needsSpeedtestDiscovery({ scope: 'mainland' }, {}, now), true);
  assert.equal(needsSpeedtestDiscovery({ scope: 'mainland' }, {
    serverCacheUpdatedAt: now,
    serverCache: [mainland, overseas],
  }, now), false);
  assert.equal(needsSpeedtestDiscovery({ scope: 'overseas' }, {
    serverCacheUpdatedAt: now,
    serverCache: [mainland],
  }, now), true);
  assert.equal(needsSpeedtestDiscovery({ scope: 'mainland' }, {
    serverCacheUpdatedAt: now - 25 * 60 * 60 * 1000,
    serverCache: [mainland],
  }, now), true);
  assert.equal(needsSpeedtestDiscovery({ scope: 'mainland' }, {
    serverCacheUpdatedAt: now,
    serverCache: [{ ...mainland, ip: '210.22.155.34', locationSource: 'geoip' }],
  }, now), true);
});

test('GeoIP verification preserves the official node location', () => {
  assert.deepEqual(mergeSpeedtestGeo({
    id: '24447', city: 'Shanghai', country: 'China', countryCode: 'CN', ip: '',
  }, '210.22.155.34', {
    city: 'Nanjing', country: 'China', countryCode: 'CN',
  }), {
    id: '24447', city: 'Shanghai', country: 'China', countryCode: 'CN',
    ip: '210.22.155.34', ipCity: 'Nanjing', ipCountry: 'China', ipCountryCode: 'CN',
    locationSource: 'geoip',
  });
});
