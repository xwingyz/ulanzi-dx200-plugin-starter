import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createStudyLightAction } from '../plugins/com.ulanzi.mihome.ulanziPlugin/plugin/actions/studylight.js';

function createRuntime({
  ha,
  persistedState = {},
  renderCalls = [],
} = {}) {
  return {
    clearInstanceTimeout(instance, slot) {
      instance.timers?.delete(slot);
    },
    escapeXml: (value) => String(value),
    frameFor: () => ({}),
    ha,
    readPersistedState: () => persistedState,
    renderInstance: (instance) => {
      renderCalls.push({ connectionState: instance.connectionState, lightState: instance.lightState });
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

function fakeHa({ configured = true, getStateImpl, callServiceImpl } = {}) {
  return {
    configured,
    getState: getStateImpl ?? (async () => ({ ok: true, json: { state: 'off' } })),
    callService: callServiceImpl ?? (async () => ({ ok: true, json: null })),
  };
}

// ---- 纯函数 ----

test('studylight haStateToLightState only accepts on/off, else unknown', () => {
  const { testing } = createStudyLightAction(createRuntime({ ha: fakeHa() }));
  assert.equal(testing.studylightHaStateToLightState('on'), 'on');
  assert.equal(testing.studylightHaStateToLightState('off'), 'off');
  assert.equal(testing.studylightHaStateToLightState('unavailable'), 'unknown');
  assert.equal(testing.studylightHaStateToLightState(undefined), 'unknown');
});

test('studylight backoffDelay starts at 60s and caps at 120s', () => {
  const { testing } = createStudyLightAction(createRuntime({ ha: fakeHa() }));
  assert.equal(testing.studylightBackoffDelay(1), 60_000);
  assert.equal(testing.studylightBackoffDelay(2), 120_000);
  assert.equal(testing.studylightBackoffDelay(5), 120_000);
});

test('studylight hydrateState rejects mismatched version and invalid light state', () => {
  const { testing } = createStudyLightAction(createRuntime({ ha: fakeHa() }));
  assert.deepEqual(testing.studylightHydrateState({ v: 1, lightState: 'on', lastSeenAt: 42 }), {
    lightState: 'on',
    lastSeenAt: 42,
  });
  assert.deepEqual(testing.studylightHydrateState({ v: 2, lightState: 'on', lastSeenAt: 42 }), {
    lightState: 'unknown',
    lastSeenAt: null,
  });
  assert.deepEqual(testing.studylightHydrateState(null), { lightState: 'unknown', lastSeenAt: null });
});

// ---- applyPollResult ----

test('studylight applyPollResult reports CONFIG_REQUIRED when ha is not configured', () => {
  const ha = fakeHa({ configured: false });
  const { testing, config } = createStudyLightAction(createRuntime({ ha }));
  const instance = createInstance(config);
  testing.studylightApplyPollResult(instance, { ok: true, json: { state: 'on' } });
  assert.equal(instance.connectionState, 'CONFIG_REQUIRED');
});

test('studylight applyPollResult moves to ONLINE and resets failure count on success', () => {
  const ha = fakeHa();
  const { testing, config } = createStudyLightAction(createRuntime({ ha }));
  const instance = createInstance(config);
  instance.failureCount = 3;
  testing.studylightApplyPollResult(instance, { ok: true, json: { state: 'on' } }, 1_000);
  assert.equal(instance.connectionState, 'ONLINE');
  assert.equal(instance.lightState, 'on');
  assert.equal(instance.failureCount, 0);
  assert.equal(instance.lastSeenAt, 1_000);
});

test('studylight applyPollResult moves to OFFLINE and tracks errorKind on failure', () => {
  const ha = fakeHa();
  const { testing, config } = createStudyLightAction(createRuntime({ ha }));
  const instance = createInstance(config);
  testing.studylightApplyPollResult(instance, { ok: false, kind: 'NETWORK' });
  assert.equal(instance.connectionState, 'OFFLINE');
  assert.equal(instance.errorKind, 'NETWORK');
  assert.equal(instance.failureCount, 1);
});

// ---- viewFor ----

test('studylight viewFor maps connection/light state to the right pill word', () => {
  const { testing, config } = createStudyLightAction(createRuntime({ ha: fakeHa() }));
  const base = createInstance(config);

  assert.equal(testing.studylightViewFor({ ...base, connectionState: 'CONFIG_REQUIRED' }).mode, 'config');
  assert.equal(testing.studylightViewFor({ ...base, connectionState: 'OFFLINE', errorKind: 'AUTH' }).mode, 'offline');
  assert.equal(testing.studylightViewFor({ ...base, connectionState: 'ONLINE', lightState: 'on' }).mode, 'on');
  assert.equal(testing.studylightViewFor({ ...base, connectionState: 'ONLINE', lightState: 'off' }).mode, 'off');
  assert.equal(testing.studylightViewFor({ ...base, connectionState: 'PENDING', lightState: 'unknown' }).mode, 'pending');
});

// ---- handleToggle ----

test('studylight handleToggle optimistically flips state before the network call resolves', async () => {
  const renderCalls = [];
  let resolveCall;
  const callService = () => new Promise((resolve) => { resolveCall = resolve; });
  const ha = fakeHa({ callServiceImpl: callService });
  const { testing, config } = createStudyLightAction(createRuntime({ ha, renderCalls }));
  const instance = createInstance(config);
  instance.connectionState = 'ONLINE';
  instance.lightState = 'off';

  const pending = testing.studylightHandleToggle(instance);
  assert.equal(instance.lightState, 'on', 'flips immediately, before awaiting the network call');
  assert.equal(renderCalls.at(-1).lightState, 'on');

  resolveCall({ ok: true, json: null });
  await pending;
  assert.ok(instance.timers.has('studylightPoll'), 'schedules a reconcile poll after a successful toggle');
  assert.equal(instance.timers.get('studylightPoll').ms, 900);
});

test('studylight handleToggle goes OFFLINE and backs off when the toggle call fails', async () => {
  const ha = fakeHa({ callServiceImpl: async () => ({ ok: false, kind: 'NETWORK' }) });
  const { testing, config } = createStudyLightAction(createRuntime({ ha }));
  const instance = createInstance(config);
  instance.connectionState = 'ONLINE';
  instance.lightState = 'off';

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

test('studylight runPoll drops a response once the instance requestId has moved on', async () => {
  let resolveFetch;
  const ha = fakeHa({ getStateImpl: () => new Promise((resolve) => { resolveFetch = resolve; }) });
  const { testing, config } = createStudyLightAction(createRuntime({ ha }));
  const instance = createInstance(config);

  const pending = testing.studylightRunPoll(instance);
  // 模拟并发事件（例如 onDispose）在这次请求还没返回时推进了世代号。
  instance.requestId += 1;
  resolveFetch({ ok: true, json: { state: 'on' } });
  await pending;

  assert.equal(instance.lightState, 'unknown', 'stale response must not overwrite state');
  assert.equal(instance.fetching, false, 'fetching flag still clears even when the response is dropped');
});

test('studylight runPoll schedules the next poll at the fast interval once online', async () => {
  const ha = fakeHa({ getStateImpl: async () => ({ ok: true, json: { state: 'off' } }) });
  const { testing, config } = createStudyLightAction(createRuntime({ ha }));
  const instance = createInstance(config);

  await testing.studylightRunPoll(instance);
  assert.equal(instance.connectionState, 'ONLINE');
  assert.equal(instance.timers.get('studylightPoll').ms, 5_000);
});

// ---- render ----

function decode(icon) {
  return Buffer.from(icon.replace(/^data:image\/svg\+xml;base64,/, ''), 'base64').toString('utf8');
}

test('studylight render draws a distinct pill word for on, off, offline and config states', () => {
  const { config } = createStudyLightAction(createRuntime({ ha: fakeHa() }));
  const cases = [
    [{ connectionState: 'ONLINE', lightState: 'on' }, 'ON'],
    [{ connectionState: 'ONLINE', lightState: 'off' }, 'OFF'],
    [{ connectionState: 'OFFLINE', errorKind: 'NETWORK' }, 'OFFLINE'],
    [{ connectionState: 'CONFIG_REQUIRED' }, 'SETUP'],
    [{ connectionState: 'PENDING', lightState: 'unknown' }, 'SYNC'],
  ];
  for (const [overrides, expectedWord] of cases) {
    const instance = createInstance(config, overrides);
    const svg = decode(config.render(instance));
    assert.match(svg, new RegExp(`>${expectedWord}<`), `expected pill word ${expectedWord} for ${JSON.stringify(overrides)}`);
    assert.doesNotMatch(svg, /undefined|NaN/);
  }
});
