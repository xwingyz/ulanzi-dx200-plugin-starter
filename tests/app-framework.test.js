import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { __testing as lexTesting } from '../plugins/com.ulanzi.lexutility.ulanziPlugin/plugin/app.js';
import { __testing as templateTesting } from '../template/com.example.hello.ulanziPlugin/plugin/app.js';

const lexActionConfigs = lexTesting.ACTION_CONFIGS;
const templateActionConfigs = templateTesting.ACTION_CONFIGS;
const clearLexTimeout = lexTesting.clearInstanceTimeout;
const delayLexInstance = lexTesting.delayInstance;
const frameworkLatencyCommit = lexTesting.commitLatencyResult;

const frameworks = [
  {
    name: 'lex utility',
    actionConfigs: lexActionConfigs,
    clearTimeout: lexTesting.clearInstanceTimeout,
    createSettingsEventProcessor: lexTesting.createSettingsEventProcessor,
    delayInstance: lexTesting.delayInstance,
    dispatchActionParam: lexTesting.dispatchActionParam,
    disposeInstance: lexTesting.disposeInstance,
    initializeInstanceState: lexTesting.initializeInstanceState,
    resolveSettings: lexTesting.resolveSettingsForEvent,
    storageFactory: lexTesting.createSettingsStorage,
    writePersistedSettings: lexTesting.writePersistedSettings,
    context: 'com.ulanzi.ulanzistudio.lexutility.counter___key-1___action-1',
  },
  {
    name: 'template',
    actionConfigs: templateActionConfigs,
    clearTimeout: templateTesting.clearInstanceTimeout,
    createSettingsEventProcessor: templateTesting.createSettingsEventProcessor,
    delayInstance: templateTesting.delayInstance,
    dispatchActionParam: templateTesting.dispatchActionParam,
    disposeInstance: templateTesting.disposeInstance,
    initializeInstanceState: templateTesting.initializeInstanceState,
    resolveSettings: templateTesting.resolveSettingsForEvent,
    storageFactory: templateTesting.createSettingsStorage,
    writePersistedSettings: templateTesting.writePersistedSettings,
    context: '__PLUGIN_UUID__.counter___key-1___action-1',
  },
];

for (const framework of frameworks) {
  test(`${framework.name}: host restore keeps persisted settings authoritative`, () => {
    const settings = framework.resolveSettings('hostRestore', {
      current: { title: 'current', theme: 'mint' },
      incoming: { title: 'stale host', color: '#111111' },
      persisted: { title: 'persisted', color: '#222222' },
    });

    assert.deepEqual(settings, { title: 'persisted', theme: 'mint', color: '#222222' });
  });

  test(`${framework.name}: PI submit keeps incoming settings authoritative`, () => {
    const settings = framework.resolveSettings('pluginSubmit', {
      current: { title: 'current', theme: 'mint' },
      incoming: { title: 'new PI', color: '#333333' },
      persisted: { title: 'persisted', color: '#222222' },
    });

    assert.deepEqual(settings, { title: 'new PI', theme: 'mint', color: '#333333' });
  });

  test(`${framework.name}: generic PI message hook is optional and receives the param`, () => {
    const calls = [];
    const instance = { context: 'ctx' };

    assert.doesNotThrow(() => framework.dispatchActionParam({}, instance, { ignored: true }));
    framework.dispatchActionParam(
      { onParamFromPlugin: (receivedInstance, param) => calls.push([receivedInstance, param]) },
      instance,
      { resetTimer: 'true' },
    );

    assert.deepEqual(calls, [[instance, { resetTimer: 'true' }]]);
  });

  test(`${framework.name}: a cancelled instance delay settles instead of hanging`, async () => {
    const instance = {};
    const delayed = framework.delayInstance(instance, 'feedback', 10_000);
    framework.clearTimeout(instance, 'feedback');

    assert.equal(await delayed, false);
    assert.equal(instance.timers.size, 0);
  });

  test(`${framework.name}: disposing an instance settles every registered delay`, async () => {
    const instance = {};
    const first = framework.delayInstance(instance, 'first', 10_000);
    const second = framework.delayInstance(instance, 'second', 10_000);
    framework.disposeInstance(instance);

    assert.deepEqual(await Promise.all([first, second]), [false, false]);
    assert.equal(instance.timers.size, 0);
  });

  test(`${framework.name}: createState failures are guarded onto the instance`, () => {
    const instance = { context: 'ctx', actionUuid: 'unknown', settings: {}, active: true };
    const originalConsoleLog = console.log;

    try {
      console.log = () => {};
      framework.initializeInstanceState(instance, {
        createState: () => {
          throw new Error('state exploded');
        },
      });
    } finally {
      console.log = originalConsoleLog;
    }

    assert.equal(instance.lastError?.phase, 'createState');
    assert.equal(instance.lastError?.message, 'state exploded');
  });

  test(`${framework.name}: swatch rotation changes runtime state without mutating settings`, () => {
    const config = framework.actionConfigs.swatch;
    const settings = { ...config.defaults };
    const originalSettings = { ...settings };
    const instance = { settings, ...config.createState() };

    config.onRun(instance);

    assert.deepEqual(instance.settings, originalSettings);
    assert.equal(instance.step, 1);
    assert.equal(instance.currentColor, '#14b8a6');
  });

  test(`${framework.name}: production event processor restores persisted settings and syncs them to host`, () => {
    const sent = [];
    const writes = [];
    const controller = framework.createSettingsEventProcessor({
      ud: {
        sendParamFromPlugin: (settings, context) => sent.push({ settings, context }),
      },
      instances: new Map(),
      readPersisted: () => ({ title: 'persisted', color: '#222222', theme: 'mono' }),
      writePersisted: (context, config, settings) => writes.push({ context, config, settings }),
      render: () => {},
      ready: () => {},
    });

    const instance = controller.hostRestore(framework.context, {
      title: 'stale host',
      color: '#111111',
      theme: 'mint',
    });

    assert.equal(instance.settings.title, 'persisted');
    assert.equal(instance.settings.color, '#222222');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].settings.title, 'persisted');
    assert.equal(sent[0].context, framework.context);
    assert.equal(writes.length, 0);
  });

  test(`${framework.name}: production event processor persists incoming PI submission`, () => {
    const writes = [];
    const controller = framework.createSettingsEventProcessor({
      ud: { sendParamFromPlugin: () => {} },
      instances: new Map(),
      readPersisted: () => ({ title: 'persisted', color: '#222222', theme: 'mono' }),
      writePersisted: (context, config, settings) => writes.push({ context, config, settings }),
      render: () => {},
      ready: () => {},
    });

    const instance = controller.pluginSubmit(framework.context, {
      title: 'fresh PI',
      color: '#333333',
      theme: 'signal',
    });

    assert.equal(instance.settings.title, 'fresh PI');
    assert.equal(instance.settings.color, '#333333');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].settings.title, 'fresh PI');
  });

  test(`${framework.name}: createState error invokes the injected ERR renderer and returns control`, () => {
    const renderedErrors = [];
    const instance = { context: 'ctx', actionUuid: 'unknown', settings: {}, active: true };
    const originalConsoleLog = console.log;

    try {
      console.log = () => {};
      const returned = framework.initializeInstanceState(
        instance,
        { createState: () => { throw new Error('state exploded'); } },
        { renderError: (failedInstance) => renderedErrors.push(failedInstance) },
      );
      assert.equal(returned, instance);
    } finally {
      console.log = originalConsoleLog;
    }

    assert.equal(instance.lastError?.phase, 'createState');
    assert.deepEqual(renderedErrors, [instance]);
  });

  test(`${framework.name}: repeated host restore and unchanged PI do not write, changed PI writes once`, () => {
    let persisted = {
      title: 'persisted',
      subtitle: 'Counter',
      color: '#222222',
      theme: 'mono',
    };
    const writes = [];
    const controller = framework.createSettingsEventProcessor({
      ud: { sendParamFromPlugin: () => {} },
      instances: new Map(),
      readPersisted: () => ({ ...persisted }),
      writePersisted: (context, config, settings) => {
        writes.push({ context, settings: { ...settings } });
        persisted = { ...settings };
      },
      render: () => {},
      ready: () => {},
    });

    controller.hostRestore(framework.context, { title: 'stale host' });
    controller.hostRestore(framework.context, { title: 'stale host' });
    controller.pluginSubmit(framework.context, { title: 'persisted' });
    assert.equal(writes.length, 0);

    controller.pluginSubmit(framework.context, { title: 'changed' });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].settings.title, 'changed');
  });

  test(`${framework.name}: runtime ensure ignores host params and never persists existing instance`, () => {
    const writes = [];
    const controller = framework.createSettingsEventProcessor({
      ud: { sendParamFromPlugin: () => {} },
      instances: new Map(),
      readPersisted: () => ({
        title: 'persisted',
        subtitle: 'Counter',
        color: '#222222',
        theme: 'mono',
      }),
      writePersisted: (...args) => writes.push(args),
      render: () => {},
      ready: () => {},
    });
    const instance = controller.hostRestore(framework.context, { title: 'stale host' });

    controller.runtime(framework.context, { title: 'runtime stale value' });

    assert.equal(instance.settings.title, 'persisted');
    assert.equal(writes.length, 0);
  });

  test(`${framework.name}: storage atomically replaces data without temp residue`, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ulanzi-store-'));
    const storePath = path.join(directory, 'action-settings.json');
    try {
      const storage = framework.storageFactory({ storePath, logger: () => {} });
      assert.equal(storage.write({ key: { title: 'saved' } }), true);
      assert.deepEqual(JSON.parse(fs.readFileSync(storePath, 'utf8')), { key: { title: 'saved' } });
      assert.deepEqual(fs.readdirSync(directory).filter((name) => name.includes('.tmp')), []);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test(`${framework.name}: failed atomic rename removes temp file and preserves old store`, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ulanzi-store-fail-'));
    const storePath = path.join(directory, 'action-settings.json');
    fs.writeFileSync(storePath, JSON.stringify({ old: true }));
    const errors = [];
    const failingFs = {
      ...fs,
      renameSync: () => { throw new Error('rename failed'); },
    };
    try {
      const storage = framework.storageFactory({
        storePath,
        fsImpl: failingFs,
        logger: (...args) => errors.push(args),
      });
      assert.equal(storage.write({ fresh: true }), false);
      assert.deepEqual(JSON.parse(fs.readFileSync(storePath, 'utf8')), { old: true });
      assert.deepEqual(fs.readdirSync(directory).filter((name) => name.includes('.tmp')), []);
      assert.equal(errors.length, 1);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test(`${framework.name}: corrupt store becomes read-only and rejects later writes`, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ulanzi-readonly-'));
    const storePath = path.join(directory, 'action-settings.json');
    const corrupt = '{broken json';
    const errors = [];
    try {
      fs.writeFileSync(storePath, corrupt);
      const storage = framework.storageFactory({
        storePath,
        logger: (...args) => errors.push(args),
      });

      assert.deepEqual(storage.load(), {});
      assert.equal(storage.storeCorrupt, true);
      assert.equal(storage.write({ replacement: true }), false);
      assert.equal(fs.readFileSync(storePath, 'utf8'), corrupt);
      assert.equal(errors.length, 2);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test(`${framework.name}: non-object JSON store is corrupt, read-only, and never replaced`, () => {
    const invalidStores = [null, [], 42, 'text'];
    for (const [index, invalidStore] of invalidStores.entries()) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ulanzi-shape-'));
      const storePath = path.join(directory, 'action-settings.json');
      const legacyPath = path.join(directory, 'latency-settings.json');
      const original = JSON.stringify(invalidStore);
      try {
        fs.writeFileSync(storePath, original);
        fs.writeFileSync(legacyPath, JSON.stringify({ legacy: { title: 'must not load' } }));
        const storage = framework.storageFactory({
          storePath,
          legacyPath,
          logger: () => {},
        });

        assert.deepEqual(storage.load(), {}, `invalid store index ${index}`);
        assert.equal(storage.storeCorrupt, true, `invalid store index ${index}`);
        assert.equal(storage.loadedFromLegacy, false, `invalid store index ${index}`);
        assert.equal(storage.write({ replacement: true }), false, `invalid store index ${index}`);
        assert.equal(fs.readFileSync(storePath, 'utf8'), original, `invalid store index ${index}`);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  test(`${framework.name}: failed persist keeps mirror stale so identical PI submit retries`, () => {
    const mirror = {};
    let disk = {};
    let attempts = 0;
    const storage = {
      write(candidate) {
        attempts += 1;
        if (attempts === 1) {
          return false;
        }
        disk = structuredClone(candidate);
        return true;
      },
    };
    const writePersisted = (context, config, settings) => framework.writePersistedSettings(
      context,
      config,
      settings,
      {
        store: mirror,
        storage,
        keyFromContext: () => 'slot',
      },
    );
    const controller = framework.createSettingsEventProcessor({
      ud: { sendParamFromPlugin: () => {} },
      instances: new Map(),
      readPersisted: () => mirror.slot || {},
      writePersisted,
      render: () => {},
      ready: () => {},
    });

    controller.pluginSubmit(framework.context, { title: 'retry me' });
    assert.equal(attempts, 1);
    assert.deepEqual(mirror, {});

    controller.pluginSubmit(framework.context, { title: 'retry me' });
    assert.equal(attempts, 2);
    assert.equal(mirror.slot.title, 'retry me');
    assert.deepEqual(disk, mirror);
  });
}

test('lex utility: storage falls back to legacy only when new store is missing', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ulanzi-legacy-'));
  const storePath = path.join(directory, 'action-settings.json');
  const legacyPath = path.join(directory, 'latency-settings.json');
  try {
    fs.writeFileSync(legacyPath, JSON.stringify({ legacy: { title: 'legacy' } }));
    const storage = lexTesting.createSettingsStorage({ storePath, legacyPath, logger: () => {} });
    assert.deepEqual(storage.load(), { legacy: { title: 'legacy' } });
    assert.equal(storage.loadedFromLegacy, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(storePath, 'utf8')), { legacy: { title: 'legacy' } });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('lex utility: corrupt new store is preserved and never replaced by legacy data', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ulanzi-corrupt-'));
  const storePath = path.join(directory, 'action-settings.json');
  const legacyPath = path.join(directory, 'latency-settings.json');
  const corrupt = '{not valid json';
  const errors = [];
  try {
    fs.writeFileSync(storePath, corrupt);
    fs.writeFileSync(legacyPath, JSON.stringify({ legacy: { title: 'must not load' } }));
    const storage = lexTesting.createSettingsStorage({
      storePath,
      legacyPath,
      logger: (...args) => errors.push(args),
    });
    assert.deepEqual(storage.load(), {});
    assert.equal(storage.storeCorrupt, true);
    assert.equal(storage.write({ replacement: true }), false);
    assert.equal(fs.readFileSync(storePath, 'utf8'), corrupt);
    assert.equal(errors.length, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('lex utility: real pomowave config resets only for resetTimer message', () => {
  const config = lexActionConfigs.pomowave;
  const instance = {
    settings: { ...config.defaults },
    ...config.createState(),
    phase: 'focus',
    running: true,
    remainingSec: 12,
    totalSec: 1500,
    completedFocusRounds: 3,
  };

  config.onParamFromPlugin(instance, { title: 'ordinary setting' });
  assert.equal(instance.phase, 'focus');
  assert.equal(instance.completedFocusRounds, 3);

  config.onParamFromPlugin(instance, { resetTimer: 'true' });
  assert.equal(instance.phase, 'idle');
  assert.equal(instance.running, false);
  assert.equal(instance.remainingSec, 1500);
  assert.equal(instance.completedFocusRounds, 0);
});

test('lex utility: cancelled latency feedback cannot commit stale result', async () => {
  const instance = {
    context: 'latency-context',
    requestId: 4,
    history: [],
    status: 'checking',
    checking: true,
    settings: { warnMs: '800' },
  };
  const renders = [];
  const schedules = [];
  const delayed = delayLexInstance(instance, 'latencyFeedback', 10_000);

  clearLexTimeout(instance, 'latencyFeedback');
  const feedbackCompleted = await delayed;
  const committed = frameworkLatencyCommit(instance, { ok: true, ms: 25, code: 200 }, {
    requestId: 4,
    feedbackCompleted,
    instances: new Map([[instance.context, instance]]),
    render: () => renders.push('render'),
    schedule: () => schedules.push('schedule'),
  });

  assert.equal(feedbackCompleted, false);
  assert.equal(committed, false);
  assert.deepEqual(instance.history, []);
  assert.equal(instance.status, 'checking');
  assert.equal(instance.checking, true);
  assert.deepEqual(renders, []);
  assert.deepEqual(schedules, []);
});
