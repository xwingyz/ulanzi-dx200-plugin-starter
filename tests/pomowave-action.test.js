import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { createPomowaveAction } from '../plugins/com.ulanzi.lexutility.ulanziPlugin/plugin/actions/pomowave.js';

function createRuntime({ platform = 'darwin', player } = {}) {
  return {
    clearInstanceTimeout(instance, slot) {
      instance.timers?.delete(slot);
    },
    escapeXml: (value) => String(value),
    execFile: player,
    frameContent: (_frame, body) => body,
    frameFor: () => ({}),
    frameHighlight: () => '',
    instances: new Map(),
    mixHex: (a) => a,
    normalizeBooleanString: (value, fallback) => String(value) === 'true' || String(value) === 'false' ? String(value) : fallback,
    normalizeChoice: (value, fallback, choices) => choices.includes(value) ? value : fallback,
    normalizeNumberString: (value, fallback, min, max) => {
      const number = Number.parseInt(value, 10);
      return Number.isFinite(number) && number >= min && number <= max ? String(number) : fallback;
    },
    platform: () => platform,
    readPersistedState: () => ({}),
    renderInstance: () => {},
    renderThemeBackdrop: () => ({ outer: '', low: '#222', text: '#fff' }),
    setInstanceTimeout(instance, slot, callback, ms) {
      instance.timers ||= new Map();
      instance.timers.set(slot, { callback, ms });
    },
    t: (key) => key,
    themeFor: () => ({ accent: '#f00', text: '#fff', muted: '#888' }),
    toDataUrl: (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
    writePersistedState: () => true,
  };
}

function createInstance(config, overrides = {}) {
  return {
    context: 'com.ulanzi.ulanzistudio.lexutility.pomowave___special___1',
    active: false,
    settings: { ...config.defaults, soundEnabled: 'false' },
    ...config.createState(),
    ...overrides,
  };
}

test('pomowave normalizes bounded cues and background settings without retaining legacy repeatManualCue', () => {
  const { config } = createPomowaveAction(createRuntime());
  const settings = config.normalizeSettings({
    cueDuration: '600',
    backgroundSound: 'ocean',
    backgroundRandom: 'true',
    backgroundVolume: '84',
    repeatManualCue: 'true',
  }, config.defaults);

  assert.equal(config.defaults.cueDuration, '180');
  assert.equal(settings.cueDuration, '600');
  assert.equal(settings.backgroundSound, 'ocean');
  assert.equal(settings.backgroundRandom, 'true');
  assert.equal(settings.backgroundVolume, '84');
  assert.equal('repeatManualCue' in config.defaults, false);
  assert.equal('repeatManualCue' in settings, false);
  assert.equal(config.normalizeSettings({ cueDuration: 'nope', backgroundSound: 'bogus', backgroundVolume: '101' }, config.defaults).cueDuration, '180');
  assert.equal(config.normalizeSettings({ cueDuration: 'nope', backgroundSound: 'bogus', backgroundVolume: '101' }, config.defaults).backgroundSound, 'rain');
});

test('pomowave long press resets to a paused full focus while preserving completed rounds', () => {
  const { config, testing } = createPomowaveAction(createRuntime());
  const instance = createInstance(config, {
    phase: 'shortBreak',
    running: true,
    remainingSec: 30,
    totalSec: 300,
    completedFocusRounds: 2,
    phaseEndAt: Date.now() + 30_000,
  });

  testing.handlePomodoroLongPress(instance);
  assert.equal(instance.phase, 'focus');
  assert.equal(instance.running, false);
  assert.equal(instance.remainingSec, 1500);
  assert.equal(instance.completedFocusRounds, 2);
});

test('pomowave double press skips the phase visible before the first short press', () => {
  const { config, testing } = createPomowaveAction(createRuntime());
  const instance = createInstance(config, {
    active: true,
    phase: 'focus',
    running: true,
    remainingSec: 900,
    totalSec: 1500,
    phaseEndAt: Date.now() + 900_000,
  });

  testing.handlePomodoroShortPress(instance);
  assert.equal(instance.running, false, 'the first short press pauses immediately');
  testing.handlePomodoroDoublePress(instance);
  assert.equal(instance.phase, 'shortBreak');
  assert.equal(instance.completedFocusRounds, 1);

  const idle = createInstance(config);
  testing.handlePomodoroShortPress(idle);
  testing.handlePomodoroDoublePress(idle);
  assert.equal(idle.phase, 'idle');
});

test('pomowave persists the selected background and only plays it for a running focus', () => {
  const starts = [];
  const { config, testing } = createPomowaveAction(createRuntime({
    player: (command, args, callback) => {
      starts.push({ command, args });
      return { killed: false, kill() { this.killed = true; callback?.(null); } };
    },
  }));
  const instance = createInstance(config, {
    active: true,
    phase: 'focus',
    running: true,
    remainingSec: 1500,
    totalSec: 1500,
    phaseEndAt: Date.now() + 1500_000,
  });

  testing.startPomodoroBackground(instance);
  assert.equal(instance.selectedBackgroundSound, 'rain');
  assert.equal(starts.length, 1);
  assert.match(starts[0].args.at(-1), /assets\/audio\/pomowave\/rain\.mp3$/);
  assert.equal(testing.serializePomodoroState(instance).v, 2);
  assert.equal(testing.serializePomodoroState(instance).selectedBackgroundSound, 'rain');

  instance.running = false;
  testing.startPomodoroBackground(instance);
  assert.equal(starts.length, 1);
});

test('pomowave applies cue duration limits, keeps continuous cues open, and never loops auto transitions', () => {
  const calls = [];
  const { config, testing } = createPomowaveAction(createRuntime({
    player: (command, args, callback) => {
      calls.push({ command, args, callback });
      return { killed: false, kill() { this.killed = true; } };
    },
  }));
  const bounded = createInstance(config, { settings: { ...config.defaults, cueDuration: '600', soundEnabled: 'true' } });
  testing.playPomodoroPhaseEndCue(bounded, { autoStart: false });
  assert.equal(bounded.cueRepeating, true);
  assert.equal(bounded.timers.get('pomodoroCueLimit').ms, 600_000);
  testing.stopPomodoroCue(bounded);
  assert.equal(bounded.cueProcess, null);
  assert.equal(bounded.timers.has('pomodoroCue'), false);
  assert.equal(bounded.timers.has('pomodoroCueLimit'), false);

  const continuous = createInstance(config, { settings: { ...config.defaults, cueDuration: 'continuous', soundEnabled: 'true' } });
  testing.playPomodoroPhaseEndCue(continuous, { autoStart: false });
  assert.equal(continuous.cueRepeating, true);
  assert.equal(continuous.timers?.has('pomodoroCueLimit') ?? false, false);

  const automatic = createInstance(config, { settings: { ...config.defaults, cueDuration: '180', soundEnabled: 'true' } });
  testing.playPomodoroPhaseEndCue(automatic, { autoStart: true });
  assert.equal(automatic.cueRepeating, false);
  assert.equal(automatic.timers?.has('pomodoroCueLimit') ?? false, false);
  assert.equal(calls.length, 3, 'each transition begins with exactly one cue playback');
});

test('pomowave background random selection is stable through pause and serialization, and audio failure is inert', () => {
  const signals = [];
  const started = [];
  const originalRandom = Math.random;
  Math.random = () => 0.51;
  try {
    const { config, testing } = createPomowaveAction(createRuntime({
      player: (command, args) => {
        started.push({ command, args });
        return { killed: false, kill(signal) { signals.push(signal || 'TERM'); this.killed = true; } };
      },
    }));
    const instance = createInstance(config, {
      active: true,
      settings: { ...config.defaults, backgroundRandom: 'true', backgroundVolume: '35' },
      phase: 'focus', running: true, totalSec: 1500, remainingSec: 1500, phaseEndAt: Date.now() + 1_500_000,
    });
    testing.startPomodoroBackground(instance);
    const selected = instance.selectedBackgroundSound;
    assert.equal(selected, 'ocean');
    assert.deepEqual(testing.hydratePomodoroState(testing.serializePomodoroState(instance)).selectedBackgroundSound, selected);
    testing.pausePomodoroBackground(instance);
    assert.deepEqual(signals, ['SIGSTOP']);
    testing.startPomodoroBackground(instance);
    assert.deepEqual(signals, ['SIGSTOP', 'SIGCONT']);
    assert.equal(instance.selectedBackgroundSound, selected);
    assert.equal(started[0].args.at(-1).endsWith(`${selected}.mp3`), true);
    assert.equal(started[0].args[1], '0.35');

    const failed = createPomowaveAction(createRuntime({ player: () => { throw new Error('missing player'); } }));
    const failedInstance = createInstance(failed.config, {
      active: true,
      phase: 'focus', running: true, totalSec: 1500, remainingSec: 1500, phaseEndAt: Date.now() + 1_500_000,
    });
    assert.doesNotThrow(() => failed.testing.startPomodoroBackground(failedInstance));
    assert.equal(failedInstance.running, true);
    assert.equal(failedInstance.backgroundProcess, null);
  } finally {
    Math.random = originalRandom;
  }
});

test('pomowave background preview is isolated from the timer and has bounded cleanup', () => {
  const { config, testing } = createPomowaveAction(createRuntime({
    player: () => ({ killed: false, kill() { this.killed = true; } }),
  }));
  const instance = createInstance(config, { active: true, phase: 'idle' });

  testing.playPomodoroBackgroundPreview(instance, 'forest');
  assert.equal(instance.phase, 'idle');
  assert.equal(instance.running, false);
  assert.equal(instance.previewPlaying, true);
  assert.equal(instance.timers.get('pomodoroPreview').ms, 15_000);
  testing.stopPomodoroPreview(instance);
  assert.equal(instance.previewPlaying, false);
  assert.equal(instance.timers.has('pomodoroPreview'), false);
});

test('pomowave dispose stops isolated cue, background and preview channels', () => {
  const { config } = createPomowaveAction(createRuntime());
  const stopped = [];
  const processHandle = (name) => ({ killed: false, kill() { stopped.push(name); this.killed = true; } });
  const instance = createInstance(config, {
    cueProcess: processHandle('cue'),
    backgroundProcess: processHandle('background'),
    previewProcess: processHandle('preview'),
  });
  config.onDispose(instance);
  assert.deepEqual(stopped.sort(), ['background', 'cue', 'preview']);
});

test('pomowave distributes every declared CC0 preview background with honest credits under the size cap', () => {
  const audioDir = path.resolve(import.meta.dirname, '../plugins/com.ulanzi.lexutility.ulanziPlugin/assets/audio/pomowave');
  const expected = ['rain', 'fireplace', 'forest', 'ocean', 'cafe', 'brownNoise'];
  const credits = fs.readFileSync(path.join(audioDir, 'CREDITS.md'), 'utf8');
  const publicPreviewIds = ['595717_2530992', '852107_18387771', '723913_2008500', '852826_17997500', '540299_10965608', '737409_16041797'];
  const previewSha256 = {
    rain: 'c42458d0383b82d5b03e09650ae3db75368d14f51702acf28c8125a23eadfa73',
    fireplace: 'ac83ce6f89fff58e547c0e49d29eb77fab8556f0fee3a558c8ce87d464969d96',
    forest: '9aebcb869cf37040c4588fc05d72bed197951aaa1beacb6874b379c69e379dbb',
    ocean: '68cd94cdf360945f187e59ce583e45f7cd24dbf70e1cefac30b02e23a36035ed',
    cafe: '37720997fe0c7dec610c8ee4d66ea0434e5026bf7f955767e6e1c830afd892d8',
    brownNoise: 'ede75031c9944f017bce310ff040772d411cf4b689c1f50e1f05efa1d9ddc098',
  };
  const files = expected.map((sound) => path.join(audioDir, `${sound}.mp3`));

  assert.ok(files.every((file) => fs.existsSync(file)), 'every selectable background has a packaged MP3');
  assert.ok(files.reduce((total, file) => total + fs.statSync(file).size, 0) <= 15 * 1024 * 1024);
  assert.match(credits, /public Freesound HQ \*\*preview\*\* MP3s/);
  for (const [index, sound] of expected.entries()) {
    assert.ok(credits.includes(`\`${sound}.mp3\``));
    assert.match(credits, new RegExp(publicPreviewIds[index]));
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(audioDir, `${sound}.mp3`))).digest('hex'), previewSha256[sound]);
  }
});
