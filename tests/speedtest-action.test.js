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
  serializeSpeedtestState,
} = __testing;

test('speedtest action defaults match the confirmed product contract', () => {
  const defaults = ACTION_CONFIGS.speedtest.defaults;

  assert.equal(defaults.scope, 'mainland');
  assert.equal(defaults.intervalMin, '15');
  assert.equal(defaults.activeAllDay, 'false');
  assert.equal(defaults.activeStart, '08:00');
  assert.equal(defaults.activeEnd, '23:00');
  assert.equal(defaults.timeoutSec, '180');
  assert.equal(defaults.selectionMode, 'dailyRandom');
  assert.equal(defaults.chartType, 'line');
  assert.equal(defaults.geoIpEnabled, 'true');
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

test('fixed and daily-random server selection remain deterministic for the day', () => {
  const servers = [
    { id: '1', countryCode: 'CN', city: 'Nanjing' },
    { id: '2', countryCode: 'CN', city: 'Shanghai' },
  ];
  const now = new Date(2026, 6, 18, 9).getTime();

  assert.equal(
    chooseSpeedtestServer({ selectionMode: 'fixed', fixedServerId: '2' }, {}, servers, now)?.id,
    '2',
  );

  const state = {};
  const first = chooseSpeedtestServer(
    { selectionMode: 'dailyRandom' },
    state,
    servers,
    now,
    () => 0.99,
  );
  const second = chooseSpeedtestServer(
    { selectionMode: 'dailyRandom' },
    state,
    servers,
    now + 60 * 60 * 1000,
    () => 0,
  );

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
