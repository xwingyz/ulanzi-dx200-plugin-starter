import assert from 'node:assert/strict';
import { test } from 'node:test';

import fs from 'node:fs';
import path from 'node:path';

import { __testing } from '../plugins/com.ulanzi.lexutility.ulanziPlugin/plugin/app.js';

const {
  ACTION_CONFIGS,
  chooseSpeedtestServer,
  fetchSpeedtestDirectoryServers,
  handleSpeedtestDoublePress,
  handleSpeedtestRun,
  hydrateSpeedtestState,
  isWithinActiveWindow,
  parseSpeedtestResult,
  openSpeedtestWebsite,
  mapSpeedtestDirectoryServers,
  mergeSpeedtestGeo,
  needsSpeedtestDiscovery,
  renderSpeedtestIcon,
  serializeSpeedtestState,
  speedChart,
  speedtestCandidates,
  speedtestNextActiveWindowStart,
  speedtestNextDueAt,
  SPEEDTEST_REGIONS,
} = __testing;

const PLUGIN_DIR = path.resolve(import.meta.dirname, '../plugins/com.ulanzi.lexutility.ulanziPlugin');

const ICON_NOW = Date.UTC(2026, 6, 18, 12);

function iconSvg(phase, extra = {}, now = ICON_NOW) {
  return Buffer.from(
    renderSpeedtestIcon({
      settings: { theme: 'signal', frameSize: 'optimal', showFrame: 'true', scope: 'china', chartType: 'line' },
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
  assert.match(svg('idle'), />CHINA</);
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

  assert.match(scoped('any'), />GLOBAL</);
  assert.match(scoped('china'), />CHINA</);
  assert.match(scoped('japankorea'), />JP·KR</);
  assert.match(scoped('southeastasia'), />SE ASIA</);
  assert.match(scoped('europe'), />EUROPE</);
  assert.match(scoped('useast'), />US EAST</);
  assert.match(scoped('uswest'), />US WEST</);
  assert.match(scoped('canada'), />CANADA</);
  assert.match(scoped('oceania'), />OCEANIA</);
  // 旧设置里的 mainland / overseas 归一化后回到默认的 China。
  assert.match(scoped('mainland'), />CHINA</);
  assert.match(scoped('overseas'), />CHINA</);
  // 标题行只放得下 8 个字符，每个区域代号都得守住这个宽度。
  for (const region of Object.values(SPEEDTEST_REGIONS)) {
    assert.ok(region.label.length <= 8, `${region.label} is wider than the title row`);
  }
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

test('scope filters candidates by region table or everything', () => {
  const serverCache = [
    { id: '1', countryCode: 'CN', city: 'Nanjing' },
    { id: '2', countryCode: 'HK', city: 'Hong Kong' },
    { id: '3', country: '中国', city: 'Shanghai' },
    { id: '4', countryCode: 'JP', city: 'Tokyo' },
    { id: '5', countryCode: 'TW', city: 'Taipei' },
    { id: '6', countryCode: 'MO', city: 'Macau' },
    { id: '7', countryCode: 'KR', city: 'Seoul' },
    { id: '8', countryCode: 'SG', city: 'Singapore' },
    { id: '9', countryCode: 'DE', city: 'Frankfurt' },
    { id: '10', countryCode: 'GB', city: 'London' },
    { id: '11', countryCode: 'US', city: 'Seattle', lon: -122.33 },
    { id: '12', countryCode: 'CA', city: 'Toronto' },
    { id: '15', countryCode: 'US', city: 'New York', lon: -74.01 },
    { id: '16', countryCode: 'US', city: 'Dallas', lon: -96.8 },
    { id: '17', countryCode: 'US', city: 'Denver', lon: -104.99 },
    { id: '18', countryCode: 'US', city: 'Unknown' },
    { id: '13', countryCode: 'AU', city: 'Sydney' },
    { id: '14', countryCode: 'BR', city: 'São Paulo' },
  ];
  const ids = (scope) => speedtestCandidates({ scope }, { serverCache }).map((server) => server.id);

  assert.deepEqual(ids('china'), ['1', '2', '3', '5', '6']);
  assert.deepEqual(ids('japankorea'), ['4', '7']);
  assert.deepEqual(ids('southeastasia'), ['8']);
  assert.deepEqual(ids('europe'), ['9', '10']);
  // 以西经 100° 为界：达拉斯归东，丹佛归西；CLI 回退没坐标的美国节点两边都不进，只在 any 里。
  assert.deepEqual(ids('useast'), ['15', '16']);
  assert.deepEqual(ids('uswest'), ['11', '17']);
  assert.deepEqual(ids('canada'), ['12']);
  assert.deepEqual(ids('oceania'), ['13']);
  // 没归到任何大区的节点（巴西）只在 any 里出现。
  assert.deepEqual(ids('any'), serverCache.map((server) => server.id));
});

test('the inspector region table and the plugin region table stay identical', () => {
  const extract = (file) => {
    const source = fs.readFileSync(path.join(PLUGIN_DIR, file), 'utf8');
    const match = source.match(/const SPEEDTEST_REGION_RULES = (\{[\s\S]*?\n\});/);
    assert.ok(match, `${file}: SPEEDTEST_REGION_RULES block not found`);
    return new Function(`return ${match[1]};`)();
  };
  assert.deepEqual(extract('property-inspector/speedtest.js'), extract('plugin/actions/speedtest.js'));

  // Inspector 下拉的选项必须和插件接受的 scope 一一对应，顺序也一致。
  const html = fs.readFileSync(path.join(PLUGIN_DIR, 'property-inspector/speedtest.html'), 'utf8');
  const select = html.match(/<select id="scope"[\s\S]*?<\/select>/)[0];
  const options = [...select.matchAll(/<option value="([a-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(options, Object.keys(SPEEDTEST_REGIONS));
});

test('speedtest action defaults match the confirmed product contract', () => {
  const defaults = ACTION_CONFIGS.speedtest.defaults;

  assert.equal(defaults.scope, 'china');
  assert.equal(defaults.intervalMin, '30');
  assert.equal(defaults.activeAllDay, 'false');
  assert.equal(defaults.activeStart, '08:00');
  assert.equal(defaults.activeEnd, '01:00');
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

  const serialized = serializeSpeedtestState({ history, lastCompletedAt: now, autoPaused: true }, now);
  const hydrated = hydrateSpeedtestState(serialized, now);

  assert.equal(serialized.version, 2);
  assert.equal(hydrated.history.length, 672);
  assert.ok(hydrated.history.every((entry) => entry.at >= now - 7 * 24 * 60 * 60 * 1000));
  assert.equal(hydrated.lastCompletedAt, now);
  assert.equal(hydrated.autoPaused, true);
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

test('next automatic due time is clamped to the next active window when needed', () => {
  const at = (day, hour, minute = 0) => new Date(2026, 6, day, hour, minute).getTime();
  const daytime = { activeAllDay: 'false', activeStart: '08:00', activeEnd: '23:00' };
  const overnight = { activeAllDay: 'false', activeStart: '08:00', activeEnd: '01:00' };

  assert.equal(speedtestNextActiveWindowStart(daytime, at(18, 3)), at(18, 8));
  assert.equal(speedtestNextActiveWindowStart(daytime, at(18, 23)), at(19, 8));
  assert.equal(speedtestNextActiveWindowStart(overnight, at(18, 3)), at(18, 8));

  assert.equal(speedtestNextDueAt(daytime, at(18, 22, 45), 30 * 60_000), at(19, 8));
  assert.equal(speedtestNextDueAt(overnight, at(18, 0, 45), 30 * 60_000), at(18, 8));
  assert.equal(speedtestNextDueAt(overnight, at(18, 23), 30 * 60_000), at(18, 23, 30));
  assert.equal(speedtestNextDueAt({ activeAllDay: 'true' }, at(18, 23), 30 * 60_000), at(18, 23, 30));
});

test('manual key press runs once outside the automatic active window', async () => {
  const calls = [];
  const instance = {
    phase: 'idle',
    settings: { activeAllDay: 'false', activeStart: '08:00', activeEnd: '09:00' },
  };

  const result = await handleSpeedtestRun(instance, {
    request: async (target, options) => {
      calls.push({ target, options });
      return 'measured';
    },
  });

  assert.equal(result, 'measured');
  assert.deepEqual(calls, [{ target: instance, options: { source: 'manual' } }]);
});

test('double press pauses automatic tests, cancels active work, and resumes scheduling', () => {
  const calls = [];
  const instance = {
    autoPaused: false,
    phase: 'running',
    nextDueAt: 123,
  };
  const options = {
    cancelTask: () => { calls.push('cancel'); },
    clearTimer: (_instance, slot) => { calls.push(`clear:${slot}`); },
    flush: () => { calls.push('flush'); },
    render: () => { calls.push('render'); },
    sendRuntime: () => { calls.push('runtime'); },
    schedule: () => { calls.push('schedule'); },
  };

  handleSpeedtestDoublePress(instance, options);
  assert.equal(instance.autoPaused, true);
  assert.equal(instance.nextDueAt, 0);
  assert.deepEqual(calls, [
    'clear:speedtestSchedule',
    'clear:speedtestRetry',
    'cancel',
    'flush',
    'runtime',
    'render',
  ]);

  calls.length = 0;
  instance.phase = 'idle';
  handleSpeedtestDoublePress(instance, options);
  assert.equal(instance.autoPaused, false);
  assert.deepEqual(calls, ['schedule', 'runtime', 'render']);
});

test('long press opens the Speedtest website with the platform launcher', async () => {
  const invocations = [];
  const execFile = (command, args, options, callback) => {
    invocations.push({ command, args, options });
    callback(null);
  };

  assert.equal(await openSpeedtestWebsite({ platform: 'darwin', execFile }), 'https://www.speedtest.net/');
  assert.deepEqual(invocations[0], {
    command: '/usr/bin/open',
    args: ['https://www.speedtest.net/'],
    options: { windowsHide: true },
  });

  invocations.length = 0;
  await openSpeedtestWebsite({ platform: 'win32', execFile });
  assert.deepEqual(invocations[0].args, ['url.dll,FileProtocolHandler', 'https://www.speedtest.net/']);
});

test('checked nodes replace the full cache as the candidate pool', () => {
  const serverCache = [
    { id: '1', countryCode: 'CN', city: 'Nanjing' },
    { id: '2', countryCode: 'CN', city: 'Shanghai' },
    { id: '3', countryCode: 'CN', city: 'Beijing' },
  ];
  const checked = JSON.stringify([serverCache[0], serverCache[2]]);

  assert.deepEqual(
    speedtestCandidates({ scope: 'china', candidateServers: checked }, { serverCache })
      .map((server) => server.id),
    ['1', '3'],
  );
  // 勾选仍然要过区域筛选：勾了中国节点但区域切到欧洲时候选池为空，
  // 由 needsSpeedtestDiscovery 触发重新发现，而不是拿着不匹配的节点硬测。
  assert.deepEqual(
    speedtestCandidates({ scope: 'europe', candidateServers: checked }, { serverCache }),
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
    lat: '31.2222',
    lon: '121.4581',
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
    lat: 31.2222,
    lon: 121.4581,
  }]);
  // 坐标缺失或非数字时保留为 null，不能变成 0 落到赤道上。
  assert.equal(mapSpeedtestDirectoryServers([{ id: '1', lon: 'n/a' }])[0].lon, null);
  assert.equal(mapSpeedtestDirectoryServers([{ id: '1' }])[0].lat, null);
});

test('daily random picks a region first so one crowded region cannot monopolise the draw', () => {
  const servers = [
    ...Array.from({ length: 30 }, (_, i) => ({ id: `tw${i}`, countryCode: 'TW', city: 'Taipei' })),
    { id: 'jp1', countryCode: 'JP', city: 'Tokyo' },
    { id: 'sg1', countryCode: 'SG', city: 'Singapore' },
  ];
  const now = new Date(2026, 6, 18, 9).getTime();
  // 三个国家各占一票；random 落在最后一档时抽到 SG，而不是被 30 个台湾节点淹没。
  const state = {};
  assert.equal(chooseSpeedtestServer(state, servers, now, () => 0.99)?.id, 'sg1');
  // 随机值落在第二档 → JP；国家内部再用同一随机数选节点。
  assert.equal(chooseSpeedtestServer({}, servers, now, () => 0.5)?.id, 'jp1');
  // 当天粘性仍然生效。
  assert.equal(chooseSpeedtestServer(state, servers, now + 3_600_000, () => 0)?.id, 'sg1');
});

test('directory discovery queries a fixed set of regions instead of only the nearby list', async () => {
  const queries = [];
  const fetcher = async (url) => {
    const search = url.searchParams.get('search') || '';
    const limit = Number(url.searchParams.get('limit'));
    queries.push({ search, limit });
    const byRegion = {
      '': [{ id: '1', cc: 'TW', country: 'Taiwan', name: 'Taipei', sponsor: 'A', host: 'a' },
           { id: '2', cc: 'TW', country: 'Taiwan', name: 'Taipei', sponsor: 'B', host: 'b' }],
      China: [{ id: '3', cc: 'CN', country: 'China', name: 'Shanghai', sponsor: 'C', host: 'c' }],
      Japan: [{ id: '4', cc: 'JP', country: 'Japan', name: 'Tokyo', sponsor: 'D', host: 'd' },
              { id: '1', cc: 'TW', country: 'Taiwan', name: 'Taipei', sponsor: 'A', host: 'a' }],
    };
    if (search === 'Singapore') throw new Error('HTTP 503');
    return byRegion[search] || [];
  };

  const servers = await fetchSpeedtestDirectoryServers(fetcher, 'any');
  const searched = queries.map((query) => query.search);

  // 就近列表之外，Any 要固定覆盖中/港/台/日/韩/新/美/英/德/澳，才不会只剩出口附近那一个地区。
  for (const region of ['', 'China', 'Hong Kong', 'Taiwan', 'Japan', 'Korea', 'Singapore',
    'United States', 'United Kingdom', 'Germany', 'Australia']) {
    assert.ok(searched.includes(region), `missing region query: ${region || '(nearby)'}`);
  }
  // 地区查询只取少量节点，避免 100 条上限被前面的地区吃光。
  assert.ok(queries.filter((query) => query.search === 'Japan').every((query) => query.limit <= 8));
  // 单个地区失败不影响其他地区；结果按 ID 去重并按国家排序。
  assert.deepEqual(servers.map((server) => server.id), ['3', '4', '1', '2']);

  // 具体大区只查自己的国家：查询数少了，每个国家就能多拿一些节点。
  queries.length = 0;
  await fetchSpeedtestDirectoryServers(fetcher, 'japankorea');
  assert.deepEqual(queries.map((query) => query.search).sort(), ['', 'Japan', 'Korea']);
  assert.ok(queries.filter((query) => query.search).every((query) => query.limit >= 20));

  queries.length = 0;
  await fetchSpeedtestDirectoryServers(fetcher, 'europe');
  assert.ok(queries.some((query) => query.search === 'Germany'));
  assert.ok(queries.some((query) => query.search === 'France'));
  assert.ok(!queries.some((query) => query.search === 'Japan'));

  // 单个搜索词第一次失败要重试一次；并发受限，不会把十几个请求一次全发出去。
  let inFlight = 0;
  let peak = 0;
  const attempts = {};
  const flaky = async (url) => {
    const search = url.searchParams.get('search') || '';
    attempts[search] = (attempts[search] || 0) + 1;
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    if (search === 'Germany' && attempts[search] === 1) throw new Error('HTTP 503');
    return search === 'Germany' ? [{ id: '9', cc: 'DE', country: 'Germany', name: 'Berlin', sponsor: 'E', host: 'e' }] : [];
  };
  const retried = await fetchSpeedtestDirectoryServers(flaky, 'europe');
  assert.equal(attempts.Germany, 2);
  assert.deepEqual(retried.map((server) => server.id), ['9']);
  assert.ok(peak <= 4, `directory concurrency reached ${peak}`);

  // 每个大区的搜索词都不能为空，否则该大区永远拉不到节点。
  for (const [scope, region] of Object.entries(SPEEDTEST_REGIONS)) {
    assert.ok(region.searches.length > 0, `${scope} has no directory searches`);
  }
});

test('node discovery runs initially, when stale, or when the configured scope is absent', () => {
  const now = Date.UTC(2026, 6, 18, 12);
  const china = { id: '1', countryCode: 'CN', country: 'China' };
  const america = { id: '2', countryCode: 'US', country: 'United States' };

  assert.equal(needsSpeedtestDiscovery({ scope: 'china' }, {}, now), true);
  assert.equal(needsSpeedtestDiscovery({ scope: 'china' }, {
    serverCacheUpdatedAt: now,
    serverCache: [china, america],
  }, now), false);
  assert.equal(needsSpeedtestDiscovery({ scope: 'canada' }, {
    serverCacheUpdatedAt: now,
    serverCache: [china],
  }, now), true);
  assert.equal(needsSpeedtestDiscovery({ scope: 'china' }, {
    serverCacheUpdatedAt: now - 25 * 60 * 60 * 1000,
    serverCache: [china],
  }, now), true);
  assert.equal(needsSpeedtestDiscovery({ scope: 'china' }, {
    serverCacheUpdatedAt: now,
    serverCache: [{ ...china, ip: '210.22.155.34', locationSource: 'geoip' }],
  }, now), true);
  // 目录是按区域拉的：缓存记着上次为哪个区域拉的，区域一换就算有零星候选也要重拉。
  assert.equal(needsSpeedtestDiscovery({ scope: 'europe' }, {
    serverCacheUpdatedAt: now,
    serverCacheScope: 'any',
    serverCache: [{ id: '3', countryCode: 'DE' }],
  }, now), true);
  assert.equal(needsSpeedtestDiscovery({ scope: 'europe' }, {
    serverCacheUpdatedAt: now,
    serverCacheScope: 'europe',
    serverCache: [{ id: '3', countryCode: 'DE' }],
  }, now), false);
});

test('the server cache remembers which region it was fetched for', () => {
  const state = hydrateSpeedtestState({
    serverCache: [{ id: '3', countryCode: 'DE' }],
    serverCacheUpdatedAt: 1,
    serverCacheScope: 'europe',
  });
  assert.equal(state.serverCacheScope, 'europe');
  assert.equal(hydrateSpeedtestState({}).serverCacheScope, '');
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
