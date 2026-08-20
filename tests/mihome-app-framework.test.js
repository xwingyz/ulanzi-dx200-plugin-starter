import assert from 'node:assert/strict';
import { test } from 'node:test';

import { __testing } from '../plugins/com.ulanzi.mihome.ulanziPlugin/plugin/app.js';

const { createHaClient } = __testing;

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
