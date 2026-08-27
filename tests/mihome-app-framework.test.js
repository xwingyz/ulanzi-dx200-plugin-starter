import assert from 'node:assert/strict';
import { test } from 'node:test';

import { __testing } from '../plugins/com.ulanzi.mihome.ulanziPlugin/plugin/app.js';

const { createHaClient, combineLightStates, haStateToLightState, lightGroupBackoffDelay } = __testing;

test('mihome createHaClient is unconfigured when the config file has no token', () => {
  const client = createHaClient({ config: { baseUrl: 'http://xwing-ds:8123', token: '' } });
  assert.equal(client.configured, false);
});

test('mihome createHaClient is unconfigured when the config file is missing entirely', () => {
  const client = createHaClient({ config: { baseUrl: '', token: '' } });
  assert.equal(client.configured, false);
});

test('mihome createHaClient rejects with kind CONFIG instead of calling out when unconfigured', async () => {
  let called = false;
  const client = createHaClient({
    config: { baseUrl: '', token: '' },
    request: () => { called = true; return Promise.resolve({ ok: true }); },
  });
  const stateResult = await client.getState('light.demo');
  const serviceResult = await client.callService('light', 'toggle', 'light.demo');
  assert.equal(called, false);
  assert.deepEqual(stateResult, { ok: false, kind: 'CONFIG' });
  assert.deepEqual(serviceResult, { ok: false, kind: 'CONFIG' });
});

test('mihome createHaClient getState calls the HA states endpoint with a bearer token', async () => {
  const calls = [];
  const client = createHaClient({
    config: { baseUrl: 'http://xwing-ds:8123', token: 'secret-token' },
    request: (method, url, token) => {
      calls.push({ method, url, token });
      return Promise.resolve({ ok: true, json: { state: 'on' } });
    },
  });
  const result = await client.getState('light.mijia_demo');
  assert.deepEqual(calls, [{
    method: 'GET',
    url: 'http://xwing-ds:8123/api/states/light.mijia_demo',
    token: 'secret-token',
  }]);
  assert.equal(result.json.state, 'on');
});

test('mihome createHaClient callService posts to the HA services endpoint with the entity id body', async () => {
  const calls = [];
  const client = createHaClient({
    config: { baseUrl: 'http://xwing-ds:8123', token: 'secret-token' },
    request: (method, url, token, body) => {
      calls.push({ method, url, token, body });
      return Promise.resolve({ ok: true, json: null });
    },
  });
  await client.callService('light', 'toggle', 'light.mijia_demo');
  assert.deepEqual(calls, [{
    method: 'POST',
    url: 'http://xwing-ds:8123/api/services/light/toggle',
    token: 'secret-token',
    body: { entity_id: 'light.mijia_demo' },
  }]);
});

test('mihome createHaClient callService accepts a list of entity ids for group calls', async () => {
  const calls = [];
  const client = createHaClient({
    config: { baseUrl: 'http://xwing-ds:8123', token: 'secret-token' },
    request: (method, url, token, body) => {
      calls.push({ method, url, body });
      return Promise.resolve({ ok: true, json: null });
    },
  });
  await client.callService('light', 'turn_off', ['light.a', 'light.b']);
  assert.deepEqual(calls, [{
    method: 'POST',
    url: 'http://xwing-ds:8123/api/services/light/turn_off',
    body: { entity_id: ['light.a', 'light.b'] },
  }]);
});

// ---- shared light-group helpers (used by both studylight and diningspotlights) ----

test('mihome haStateToLightState only accepts on/off, else unknown', () => {
  assert.equal(haStateToLightState('on'), 'on');
  assert.equal(haStateToLightState('off'), 'off');
  assert.equal(haStateToLightState('unavailable'), 'unknown');
  assert.equal(haStateToLightState(undefined), 'unknown');
});

test('mihome combineLightStates: any light on wins, all off is off, else unknown', () => {
  assert.equal(combineLightStates(['on', 'off']), 'on');
  assert.equal(combineLightStates(['off', 'on']), 'on');
  assert.equal(combineLightStates(['on', 'on', 'off']), 'on');
  assert.equal(combineLightStates(['off', 'off']), 'off');
  assert.equal(combineLightStates(['off', 'off', 'off']), 'off');
  assert.equal(combineLightStates(['unknown', 'off']), 'unknown');
  assert.equal(combineLightStates(['unknown', 'unknown']), 'unknown');
  assert.equal(combineLightStates([]), 'unknown');
});

test('mihome lightGroupBackoffDelay starts at 60s and caps at 120s', () => {
  assert.equal(lightGroupBackoffDelay(1), 60_000);
  assert.equal(lightGroupBackoffDelay(2), 120_000);
  assert.equal(lightGroupBackoffDelay(5), 120_000);
});
