import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDiningSpotlightsAction } from '../plugins/com.ulanzi.mihome.ulanziPlugin/plugin/actions/diningspotlights.js';

const ENTITY_1 = 'light.yeelink_cn_1084383117_spot2_s_2_light';
const ENTITY_2 = 'light.yeelink_cn_1084388920_spot2_s_2_light';

function haStateToLightState(value) {
  return value === 'on' || value === 'off' ? value : 'unknown';
}

function combineLightStates(states) {
  if (states.some((value) => value === 'on')) return 'on';
  if (states.length > 0 && states.every((value) => value === 'off')) return 'off';
  return 'unknown';
}

function lightGroupBackoffDelay(attempt) {
  const delays = [60_000, 120_000];
  return delays[Math.min(Math.max(attempt, 1) - 1, delays.length - 1)];
}

function createRuntime({
  ha,
  persistedState = {},
  renderCalls = [],
} = {}) {
  return {
    clearInstanceTimeout(instance, slot) {
      instance.timers?.delete(slot);
    },
    combineLightStates,
    escapeXml: (value) => String(value),
    frameFor: () => ({}),
    ha,
    haStateToLightState,
    lightGroupBackoffDelay,
    readPersistedState: () => persistedState,
    renderInstance: (instance) => {
      renderCalls.push({ connectionState: instance.connectionState, lightStates: [...instance.lightStates] });
    },
    renderScreenFrame: (_theme, _accent, body) => body,
    setInstanceTimeout(instance, slot, callback, ms) {
      instance.timers ||= new Map();
      instance.timers.set(slot, { callback, ms });
    },
    t: (key) => key,
    themeFor: () => ({
      accent: '#fb7185',
      canvas: '#1f0910',
      panel: '#38121f',
      shell: '#2a0d17',
      text: '#fff1f2',
      muted: '#fda4af',
      low: '#9f1239',
      contrast: '#4c0519',
      crit: '#ef4444',
    }),
    toDataUrl: (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
    writePersistedState: () => true,
  };
}

function createInstance(config, overrides = {}) {
  const instance = {
    context: 'com.ulanzi.ulanzistudio.mihome.diningspotlights___1___1',
    active: true,
    settings: { ...config.defaults },
  };
  Object.assign(instance, config.createState(instance));
  Object.assign(instance, overrides);
  return instance;
}

function fakeHa({ configured = true, getStateImpl, callServiceImpl } = {}) {
  return {
    configured,
    getState: getStateImpl ?? (async () => ({ ok: true, json: { state: 'off' } })),
    callService: callServiceImpl ?? (async () => ({ ok: true, json: null })),
  };
}

function bothOff() {
  return Promise.resolve({ ok: true, json: { state: 'off' } });
}

// ---- hydrateState ----

test('diningspotlights hydrateState rejects mismatched version and wrong-length payloads', () => {
  const { testing } = createDiningSpotlightsAction(createRuntime({ ha: fakeHa() }));
  assert.deepEqual(
    testing.diningspotlightsHydrateState({ v: 3, lightStates: ['on', 'off'], lastSeenAt: 42 }),
    { lightStates: ['on', 'off'], lastSeenAt: 42 },
  );
  assert.deepEqual(
    testing.diningspotlightsHydrateState({ v: 2, lightStates: ['on', 'off'], lastSeenAt: 42 }),
    { lightStates: ['unknown', 'unknown'], lastSeenAt: null },
    'wrong version is discarded',
  );
  assert.deepEqual(
    testing.diningspotlightsHydrateState({ v: 3, lightStates: ['on'], lastSeenAt: 42 }),
    { lightStates: ['unknown', 'unknown'], lastSeenAt: null },
    'wrong entity count is discarded',
  );
  assert.deepEqual(testing.diningspotlightsHydrateState(null), {
    lightStates: ['unknown', 'unknown'],
    lastSeenAt: null,
  });
});

// ---- applyPollResult ----

test('diningspotlights applyPollResult reports CONFIG_REQUIRED when ha is not configured', () => {
  const ha = fakeHa({ configured: false });
  const { testing, config } = createDiningSpotlightsAction(createRuntime({ ha }));
  const instance = createInstance(config);
  testing.diningspotlightsApplyPollResult(instance, [
    { ok: true, json: { state: 'on' } },
    { ok: true, json: { state: 'on' } },
  ]);
  assert.equal(instance.connectionState, 'CONFIG_REQUIRED');
});

test('diningspotlights applyPollResult moves to ONLINE and stores each light state independently', () => {
  const ha = fakeHa();
  const { testing, config } = createDiningSpotlightsAction(createRuntime({ ha }));
  const instance = createInstance(config);
  instance.failureCount = 3;
  testing.diningspotlightsApplyPollResult(instance, [
    { ok: true, json: { state: 'on' } },
    { ok: true, json: { state: 'off' } },
  ], 1_000);
  assert.equal(instance.connectionState, 'ONLINE');
  assert.deepEqual(instance.lightStates, ['on', 'off']);
  assert.equal(instance.failureCount, 0);
  assert.equal(instance.lastSeenAt, 1_000);
});

test('diningspotlights applyPollResult goes OFFLINE if any entity request fails', () => {
  const ha = fakeHa();
  const { testing, config } = createDiningSpotlightsAction(createRuntime({ ha }));
  const instance = createInstance(config);
  testing.diningspotlightsApplyPollResult(instance, [
    { ok: true, json: { state: 'on' } },
    { ok: false, kind: 'NETWORK' },
  ]);
  assert.equal(instance.connectionState, 'OFFLINE');
  assert.equal(instance.errorKind, 'NETWORK');
  assert.equal(instance.failureCount, 1);
});

// ---- viewFor ----

test('diningspotlights viewFor derives the pill word from the combined group state', () => {
  const { testing, config } = createDiningSpotlightsAction(createRuntime({ ha: fakeHa() }));
  const base = createInstance(config);

  assert.equal(testing.diningspotlightsViewFor({ ...base, connectionState: 'CONFIG_REQUIRED' }).mode, 'config');
  assert.equal(testing.diningspotlightsViewFor({ ...base, connectionState: 'OFFLINE', errorKind: 'AUTH' }).mode, 'offline');
  assert.equal(
    testing.diningspotlightsViewFor({ ...base, connectionState: 'ONLINE', lightStates: ['on', 'off'] }).mode,
    'on',
  );
  assert.equal(
    testing.diningspotlightsViewFor({ ...base, connectionState: 'ONLINE', lightStates: ['off', 'off'] }).mode,
    'off',
  );
  assert.equal(
    testing.diningspotlightsViewFor({ ...base, connectionState: 'PENDING', lightStates: ['unknown', 'unknown'] }).mode,
    'pending',
  );
});

// ---- handleToggle ----

test('diningspotlights handleToggle optimistically flips both lights before the network call resolves', async () => {
  const renderCalls = [];
  let resolveCall;
  const callService = () => new Promise((resolve) => { resolveCall = resolve; });
  const ha = fakeHa({ callServiceImpl: callService });
  const { testing, config } = createDiningSpotlightsAction(createRuntime({ ha, renderCalls }));
  const instance = createInstance(config);
  instance.connectionState = 'ONLINE';
  instance.lightStates = ['off', 'off'];

  const pending = testing.diningspotlightsHandleToggle(instance);
  assert.deepEqual(instance.lightStates, ['on', 'on'], 'flips immediately, before awaiting the network call');
  assert.deepEqual(renderCalls.at(-1).lightStates, ['on', 'on']);

  resolveCall({ ok: true, json: null });
  await pending;
  assert.ok(instance.timers.has('diningspotlightsPoll'), 'schedules a reconcile poll after a successful toggle');
  assert.equal(instance.timers.get('diningspotlightsPoll').ms, 900);
});

test('diningspotlights handleToggle calls turn_off with both entities when the group is currently on', async () => {
  const calls = [];
  const ha = fakeHa({
    callServiceImpl: (domain, service, entityIds) => {
      calls.push({ domain, service, entityIds });
      return Promise.resolve({ ok: true, json: null });
    },
  });
  const { testing, config } = createDiningSpotlightsAction(createRuntime({ ha }));
  const instance = createInstance(config);
  instance.connectionState = 'ONLINE';
  instance.lightStates = ['on', 'off'];

  await testing.diningspotlightsHandleToggle(instance);
  assert.deepEqual(calls, [{ domain: 'light', service: 'turn_off', entityIds: [ENTITY_1, ENTITY_2] }]);
  assert.deepEqual(instance.lightStates, ['off', 'off']);
});

test('diningspotlights handleToggle calls turn_on with both entities when the group is currently off', async () => {
  const calls = [];
  const ha = fakeHa({
    callServiceImpl: (domain, service, entityIds) => {
      calls.push({ domain, service, entityIds });
      return Promise.resolve({ ok: true, json: null });
    },
  });
  const { testing, config } = createDiningSpotlightsAction(createRuntime({ ha }));
  const instance = createInstance(config);
  instance.connectionState = 'ONLINE';
  instance.lightStates = ['off', 'off'];

  await testing.diningspotlightsHandleToggle(instance);
  assert.deepEqual(calls, [{ domain: 'light', service: 'turn_on', entityIds: [ENTITY_1, ENTITY_2] }]);
  assert.deepEqual(instance.lightStates, ['on', 'on']);
});

test('diningspotlights handleToggle goes OFFLINE and backs off when the toggle call fails', async () => {
  const ha = fakeHa({ callServiceImpl: async () => ({ ok: false, kind: 'NETWORK' }) });
  const { testing, config } = createDiningSpotlightsAction(createRuntime({ ha }));
  const instance = createInstance(config);
  instance.connectionState = 'ONLINE';
  instance.lightStates = ['off', 'off'];

  await testing.diningspotlightsHandleToggle(instance);
  assert.equal(instance.connectionState, 'OFFLINE');
  assert.equal(instance.failureCount, 1);
  assert.equal(instance.timers.get('diningspotlightsPoll').ms, 60_000);
});

test('diningspotlights handleToggle does not call the network when ha is not configured', async () => {
  let called = false;
  const ha = fakeHa({ configured: false, callServiceImpl: async () => { called = true; return { ok: true }; } });
  const { testing, config } = createDiningSpotlightsAction(createRuntime({ ha }));
  const instance = createInstance(config);

  await testing.diningspotlightsHandleToggle(instance);
  assert.equal(called, false);
  assert.equal(instance.connectionState, 'CONFIG_REQUIRED');
});

// ---- runPoll ----

test('diningspotlights runPoll fetches both entities and drops a response once the requestId has moved on', async () => {
  const resolvers = [];
  const calls = [];
  const ha = fakeHa({
    getStateImpl: (entityId) => {
      calls.push(entityId);
      return new Promise((resolve) => { resolvers.push(resolve); });
    },
  });
  const { testing, config } = createDiningSpotlightsAction(createRuntime({ ha }));
  const instance = createInstance(config);

  const pending = testing.diningspotlightsRunPoll(instance);
  assert.deepEqual(calls, [ENTITY_1, ENTITY_2]);
  instance.requestId += 1;
  for (const resolve of resolvers) {
    resolve({ ok: true, json: { state: 'on' } });
  }
  await pending;

  assert.deepEqual(instance.lightStates, ['unknown', 'unknown'], 'stale response must not overwrite state');
  assert.equal(instance.fetching, false);
});

test('diningspotlights runPoll schedules the next poll at the fast interval once online', async () => {
  const ha = fakeHa({ getStateImpl: bothOff });
  const { testing, config } = createDiningSpotlightsAction(createRuntime({ ha }));
  const instance = createInstance(config);

  await testing.diningspotlightsRunPoll(instance);
  assert.equal(instance.connectionState, 'ONLINE');
  assert.deepEqual(instance.lightStates, ['off', 'off']);
  assert.equal(instance.timers.get('diningspotlightsPoll').ms, 5_000);
});

// ---- render ----

function decode(icon) {
  return Buffer.from(icon.replace(/^data:image\/svg\+xml;base64,/, ''), 'base64').toString('utf8');
}

test('diningspotlights render draws a distinct pill word for on, off, offline and config states', () => {
  const { config } = createDiningSpotlightsAction(createRuntime({ ha: fakeHa() }));
  const cases = [
    [{ connectionState: 'ONLINE', lightStates: ['on', 'off'] }, 'ON'],
    [{ connectionState: 'ONLINE', lightStates: ['off', 'off'] }, 'OFF'],
    [{ connectionState: 'OFFLINE', errorKind: 'NETWORK' }, 'OFFLINE'],
    [{ connectionState: 'CONFIG_REQUIRED' }, 'SETUP'],
    [{ connectionState: 'PENDING', lightStates: ['unknown', 'unknown'] }, 'SYNC'],
  ];
  for (const [overrides, expectedWord] of cases) {
    const instance = createInstance(config, overrides);
    const svg = decode(config.render(instance));
    assert.match(svg, new RegExp(`>${expectedWord}<`), `expected pill word ${expectedWord} for ${JSON.stringify(overrides)}`);
    assert.doesNotMatch(svg, /undefined|NaN/);
  }
});
