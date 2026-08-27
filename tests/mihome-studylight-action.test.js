import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createStudyLightAction } from '../plugins/com.ulanzi.mihome.ulanziPlugin/plugin/actions/studylight.js';

const SPOTLIGHT_ENTITY_ID = 'light.mijia_cn_group_1749469573210054656_group3_s_2_light';
const SCREEN_ENTITY_ID = 'light.yeelink_cn_554094998_lamp22_s_2';

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
      renderCalls.push({
        connectionState: instance.connectionState,
        spotlightState: instance.spotlightState,
        screenState: instance.screenState,
      });
    },
    renderScreenFrame: (_theme, _accent, body) => body,
    setInstanceTimeout(instance, slot, callback, ms) {
      instance.timers ||= new Map();
      instance.timers.set(slot, { callback, ms });
    },
    t: (key) => key,
    themeFor: () => ({
      accent: '#f97316',
      canvas: '#1a0d08',
      panel: '#2a140c',
      shell: '#140a06',
      text: '#fff7ed',
      muted: '#fdba74',
      low: '#9a3412',
      contrast: '#431407',
      crit: '#ef4444',
    }),
    toDataUrl: (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
    writePersistedState: () => true,
  };
}

function createInstance(config, overrides = {}) {
  const instance = {
    context: 'com.ulanzi.ulanzistudio.mihome.studylight___1___1',
    active: true,
    settings: { ...config.defaults },
  };
  Object.assign(instance, config.createState(instance));
  Object.assign(instance, overrides);
  return instance;
}

// getStateImpl, when given, receives the entity_id being polled so tests can return
// different results per entity.
function fakeHa({ configured = true, getStateImpl, callServiceImpl } = {}) {
  return {
    configured,
    getState: getStateImpl ?? (async () => ({ ok: true, json: { state: 'off' } })),
    callService: callServiceImpl ?? (async () => ({ ok: true, json: null })),
  };
}

function bothOff(entityId) {
  return Promise.resolve({ ok: true, json: { state: 'off' } });
}

// haStateToLightState / combineLightStates / lightGroupBackoffDelay are now shared
// primitives injected via runtime (see tests/mihome-app-framework.test.js) — studylight
// no longer defines or re-exports them itself.

test('studylight hydrateState rejects mismatched version and invalid light states', () => {
  const { testing } = createStudyLightAction(createRuntime({ ha: fakeHa() }));
  assert.deepEqual(
    testing.studylightHydrateState({ v: 2, spotlightState: 'on', screenState: 'off', lastSeenAt: 42 }),
    { spotlightState: 'on', screenState: 'off', lastSeenAt: 42 },
  );
  assert.deepEqual(
    testing.studylightHydrateState({ v: 1, spotlightState: 'on', screenState: 'off', lastSeenAt: 42 }),
    { spotlightState: 'unknown', screenState: 'unknown', lastSeenAt: null },
  );
  assert.deepEqual(testing.studylightHydrateState(null), {
    spotlightState: 'unknown',
    screenState: 'unknown',
    lastSeenAt: null,
  });
});

// ---- applyPollResult ----

test('studylight applyPollResult reports CONFIG_REQUIRED when ha is not configured', () => {
  const ha = fakeHa({ configured: false });
  const { testing, config } = createStudyLightAction(createRuntime({ ha }));
  const instance = createInstance(config);
  testing.studylightApplyPollResult(instance, [
    { ok: true, json: { state: 'on' } },
    { ok: true, json: { state: 'on' } },
  ]);
  assert.equal(instance.connectionState, 'CONFIG_REQUIRED');
});

test('studylight applyPollResult moves to ONLINE and stores both light states independently', () => {
  const ha = fakeHa();
  const { testing, config } = createStudyLightAction(createRuntime({ ha }));
  const instance = createInstance(config);
  instance.failureCount = 3;
  testing.studylightApplyPollResult(instance, [
    { ok: true, json: { state: 'on' } },
    { ok: true, json: { state: 'off' } },
  ], 1_000);
  assert.equal(instance.connectionState, 'ONLINE');
  assert.equal(instance.spotlightState, 'on');
  assert.equal(instance.screenState, 'off');
  assert.equal(instance.failureCount, 0);
  assert.equal(instance.lastSeenAt, 1_000);
});

test('studylight applyPollResult goes OFFLINE if either entity request fails', () => {
  const ha = fakeHa();
  const { testing, config } = createStudyLightAction(createRuntime({ ha }));
  const instance = createInstance(config);
  testing.studylightApplyPollResult(instance, [
    { ok: true, json: { state: 'on' } },
    { ok: false, kind: 'NETWORK' },
  ]);
  assert.equal(instance.connectionState, 'OFFLINE');
  assert.equal(instance.errorKind, 'NETWORK');
  assert.equal(instance.failureCount, 1);
});

// ---- viewFor ----

test('studylight viewFor derives the pill word from the combined group state', () => {
  const { testing, config } = createStudyLightAction(createRuntime({ ha: fakeHa() }));
  const base = createInstance(config);

  assert.equal(testing.studylightViewFor({ ...base, connectionState: 'CONFIG_REQUIRED' }).mode, 'config');
  assert.equal(testing.studylightViewFor({ ...base, connectionState: 'OFFLINE', errorKind: 'AUTH' }).mode, 'offline');
  assert.equal(
    testing.studylightViewFor({ ...base, connectionState: 'ONLINE', spotlightState: 'on', screenState: 'off' }).mode,
    'on',
    'either light on counts as the group being on',
  );
  assert.equal(
    testing.studylightViewFor({ ...base, connectionState: 'ONLINE', spotlightState: 'off', screenState: 'off' }).mode,
    'off',
  );
  assert.equal(
    testing.studylightViewFor({ ...base, connectionState: 'PENDING', spotlightState: 'unknown', screenState: 'unknown' }).mode,
    'pending',
  );
});

// ---- handleToggle ----

test('studylight handleToggle optimistically flips both lights before the network call resolves', async () => {
  const renderCalls = [];
  let resolveCall;
  const callService = () => new Promise((resolve) => { resolveCall = resolve; });
  const ha = fakeHa({ callServiceImpl: callService });
  const { testing, config } = createStudyLightAction(createRuntime({ ha, renderCalls }));
  const instance = createInstance(config);
  instance.connectionState = 'ONLINE';
  instance.spotlightState = 'off';
  instance.screenState = 'off';

  const pending = testing.studylightHandleToggle(instance);
  assert.equal(instance.spotlightState, 'on', 'flips immediately, before awaiting the network call');
  assert.equal(instance.screenState, 'on');
  assert.equal(renderCalls.at(-1).spotlightState, 'on');
  assert.equal(renderCalls.at(-1).screenState, 'on');

  resolveCall({ ok: true, json: null });
  await pending;
  assert.ok(instance.timers.has('studylightPoll'), 'schedules a reconcile poll after a successful toggle');
  assert.equal(instance.timers.get('studylightPoll').ms, 900);
});

test('studylight handleToggle calls turn_off with both entities when the group is currently on', async () => {
  const calls = [];
  const ha = fakeHa({
    callServiceImpl: (domain, service, entityIds) => {
      calls.push({ domain, service, entityIds });
      return Promise.resolve({ ok: true, json: null });
    },
  });
  const { testing, config } = createStudyLightAction(createRuntime({ ha }));
  const instance = createInstance(config);
  instance.connectionState = 'ONLINE';
  instance.spotlightState = 'on';
  instance.screenState = 'off';

  await testing.studylightHandleToggle(instance);
  assert.deepEqual(calls, [{ domain: 'light', service: 'turn_off', entityIds: [SPOTLIGHT_ENTITY_ID, SCREEN_ENTITY_ID] }]);
  assert.equal(instance.spotlightState, 'off');
  assert.equal(instance.screenState, 'off');
});

test('studylight handleToggle calls turn_on with both entities when the group is currently off', async () => {
  const calls = [];
  const ha = fakeHa({
    callServiceImpl: (domain, service, entityIds) => {
      calls.push({ domain, service, entityIds });
      return Promise.resolve({ ok: true, json: null });
    },
  });
  const { testing, config } = createStudyLightAction(createRuntime({ ha }));
  const instance = createInstance(config);
  instance.connectionState = 'ONLINE';
  instance.spotlightState = 'off';
  instance.screenState = 'off';

  await testing.studylightHandleToggle(instance);
  assert.deepEqual(calls, [{ domain: 'light', service: 'turn_on', entityIds: [SPOTLIGHT_ENTITY_ID, SCREEN_ENTITY_ID] }]);
  assert.equal(instance.spotlightState, 'on');
  assert.equal(instance.screenState, 'on');
});

test('studylight handleToggle goes OFFLINE and backs off when the toggle call fails', async () => {
  const ha = fakeHa({ callServiceImpl: async () => ({ ok: false, kind: 'NETWORK' }) });
  const { testing, config } = createStudyLightAction(createRuntime({ ha }));
  const instance = createInstance(config);
  instance.connectionState = 'ONLINE';
  instance.spotlightState = 'off';
  instance.screenState = 'off';

  await testing.studylightHandleToggle(instance);
  assert.equal(instance.connectionState, 'OFFLINE');
  assert.equal(instance.failureCount, 1);
  assert.equal(instance.timers.get('studylightPoll').ms, 60_000);
});

test('studylight handleToggle does not call the network when ha is not configured', async () => {
  let called = false;
  const ha = fakeHa({ configured: false, callServiceImpl: async () => { called = true; return { ok: true }; } });
  const { testing, config } = createStudyLightAction(createRuntime({ ha }));
  const instance = createInstance(config);

  await testing.studylightHandleToggle(instance);
  assert.equal(called, false);
  assert.equal(instance.connectionState, 'CONFIG_REQUIRED');
});

// ---- runPoll ----

test('studylight runPoll fetches both entities and drops a response once the requestId has moved on', async () => {
  const resolvers = [];
  const calls = [];
  const ha = fakeHa({
    getStateImpl: (entityId) => {
      calls.push(entityId);
      return new Promise((resolve) => { resolvers.push(resolve); });
    },
  });
  const { testing, config } = createStudyLightAction(createRuntime({ ha }));
  const instance = createInstance(config);

  const pending = testing.studylightRunPoll(instance);
  assert.deepEqual(calls, [SPOTLIGHT_ENTITY_ID, SCREEN_ENTITY_ID]);
  // 模拟并发事件（例如 onDispose）在这次请求还没返回时推进了世代号。
  instance.requestId += 1;
  for (const resolve of resolvers) {
    resolve({ ok: true, json: { state: 'on' } });
  }
  await pending;

  assert.equal(instance.spotlightState, 'unknown', 'stale response must not overwrite state');
  assert.equal(instance.screenState, 'unknown');
  assert.equal(instance.fetching, false, 'fetching flag still clears even when the response is dropped');
});

test('studylight runPoll schedules the next poll at the fast interval once online', async () => {
  const ha = fakeHa({ getStateImpl: bothOff });
  const { testing, config } = createStudyLightAction(createRuntime({ ha }));
  const instance = createInstance(config);

  await testing.studylightRunPoll(instance);
  assert.equal(instance.connectionState, 'ONLINE');
  assert.equal(instance.spotlightState, 'off');
  assert.equal(instance.screenState, 'off');
  assert.equal(instance.timers.get('studylightPoll').ms, 5_000);
});

// ---- render ----

function decode(icon) {
  return Buffer.from(icon.replace(/^data:image\/svg\+xml;base64,/, ''), 'base64').toString('utf8');
}

test('studylight render draws a distinct pill word for on, off, offline and config states', () => {
  const { config } = createStudyLightAction(createRuntime({ ha: fakeHa() }));
  const cases = [
    [{ connectionState: 'ONLINE', spotlightState: 'on', screenState: 'off' }, 'ON'],
    [{ connectionState: 'ONLINE', spotlightState: 'off', screenState: 'off' }, 'OFF'],
    [{ connectionState: 'OFFLINE', errorKind: 'NETWORK' }, 'OFFLINE'],
    [{ connectionState: 'CONFIG_REQUIRED' }, 'SETUP'],
    [{ connectionState: 'PENDING', spotlightState: 'unknown', screenState: 'unknown' }, 'SYNC'],
  ];
  for (const [overrides, expectedWord] of cases) {
    const instance = createInstance(config, overrides);
    const svg = decode(config.render(instance));
    assert.match(svg, new RegExp(`>${expectedWord}<`), `expected pill word ${expectedWord} for ${JSON.stringify(overrides)}`);
    assert.doesNotMatch(svg, /undefined|NaN/);
  }
});
