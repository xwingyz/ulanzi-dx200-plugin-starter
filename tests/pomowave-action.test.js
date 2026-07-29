import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { createPomowaveAction } from '../plugins/com.ulanzi.lexutility.ulanziPlugin/plugin/actions/pomowave.js';

function createRuntime({ platform = 'darwin', player, persistedState = {} } = {}) {
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
    mixHex: (from, to, ratio) => {
      const a = Number.parseInt(from.slice(1), 16);
      const b = Number.parseInt(to.slice(1), 16);
      const channel = (shift) => Math.round(
        ((a >> shift) & 0xff) * (1 - ratio) + ((b >> shift) & 0xff) * ratio,
      );
      return `#${[16, 8, 0].map((shift) => channel(shift).toString(16).padStart(2, '0')).join('')}`;
    },
    normalizeBooleanString: (value, fallback) => String(value) === 'true' || String(value) === 'false' ? String(value) : fallback,
    normalizeChoice: (value, fallback, choices) => choices.includes(value) ? value : fallback,
    normalizeNumberString: (value, fallback, min, max) => {
      const number = Number.parseInt(value, 10);
      return Number.isFinite(number) && number >= min && number <= max ? String(number) : fallback;
    },
    platform: () => platform,
    readPersistedState: () => persistedState,
    renderInstance: () => {},
    renderThemeBackdrop: () => ({ outer: '', low: '#222', text: '#fff', muted: '#888' }),
    setInstanceTimeout(instance, slot, callback, ms) {
      instance.timers ||= new Map();
      instance.timers.set(slot, { callback, ms });
    },
    t: (key) => key,
    themeFor: () => ({
      accent: '#f00',
      panel: '#111',
      text: '#fff',
      muted: '#888',
      low: '#222',
      ok: '#0f0',
      warn: '#fbbf24',
    }),
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

function decodeSvg(dataUrl) {
  return Buffer.from(dataUrl.split(',')[1], 'base64').toString('utf8');
}

test('pomowave normalizes bounded cues and background settings without retaining legacy repeatManualCue', () => {
  const { config } = createPomowaveAction(createRuntime());
  const settings = config.normalizeSettings({
    cueDuration: '600',
    backgroundSound: 'wave',
    backgroundRandom: 'true',
    backgroundVolume: '84',
    repeatManualCue: 'true',
  }, config.defaults);

  assert.equal(config.defaults.cueDuration, '180');
  assert.equal(settings.cueDuration, '600');
  assert.equal(settings.backgroundSound, 'wave');
  assert.equal(settings.backgroundRandom, 'true');
  assert.equal(settings.backgroundVolume, '84');
  assert.equal('repeatManualCue' in config.defaults, false);
  assert.equal('repeatManualCue' in settings, false);
  assert.equal(config.normalizeSettings({ cueDuration: 'nope', backgroundSound: 'bogus', backgroundVolume: '101' }, config.defaults).cueDuration, '180');
  assert.equal(config.normalizeSettings({ cueDuration: 'nope', backgroundSound: 'bogus', backgroundVolume: '101' }, config.defaults).backgroundSound, 'rain');
  assert.equal(config.normalizeSettings({ backgroundSound: 'fireplace' }, config.defaults).backgroundSound, 'stove');
  assert.equal(config.normalizeSettings({ backgroundSound: 'ocean' }, config.defaults).backgroundSound, 'wave');
  assert.equal(config.normalizeSettings({ backgroundSound: 'brownNoise' }, config.defaults).backgroundSound, 'deepSea');
});

test('pomowave applies characteristic-aware playback gain without rewriting source audio', () => {
  const { testing } = createPomowaveAction(createRuntime());
  const expectedGains = {
    rain: 9,
    clock: 6,
    wave: 7,
    forest: 10,
    cafe: 8,
    morning: 6,
    summer: 2,
    storm: 4,
    stove: 0.5,
    stream: 8,
    deepSea: 2,
    desert: 8,
    chirp: 4,
    boiling: 8,
    musicBox: 5,
    woodenFish: 4,
    streetTraffic: 9,
  };
  for (const [sound, gainDb] of Object.entries(expectedGains)) {
    assert.equal(testing.pomodoroBackgroundGainDb(sound), gainDb);
    assert.ok(testing.amplifiedPomodoroBackgroundVolume(sound, 35) > 35);
  }
  assert.ok(
    testing.pomodoroBackgroundGainDb('forest') > testing.pomodoroBackgroundGainDb('stove'),
    'quiet continuous ambience should receive more gain than sharp near-peak transients',
  );
  assert.equal(testing.amplifiedPomodoroBackgroundVolume('rain', 0), 0);
});

test('pomowave long press is a no-op outside focus', () => {
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
  assert.equal(instance.phase, 'shortBreak');
  assert.equal(instance.running, true);
  assert.equal(instance.remainingSec, 30);
  assert.equal(instance.completedFocusRounds, 2);
});

test('pomowave double press abandons the visible phase, starts the next one, and does not complete focus', () => {
  const { config, testing } = createPomowaveAction(createRuntime());
  const instance = createInstance(config, {
    active: true,
    settings: { ...config.defaults, autoStartBreaks: 'false' },
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
  assert.equal(instance.running, true);
  assert.equal(instance.awaiting, false);
  assert.equal(instance.completedFocusRounds, 0);

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
  assert.match(starts[0].args.at(-1), /assets\/audio\/pomowave\/rain\.m4a$/);
  assert.equal(testing.serializePomodoroState(instance).v, 2);
  assert.equal(testing.serializePomodoroState(instance).selectedBackgroundSound, 'rain');
  assert.equal(testing.serializePomodoroState(instance).backgroundMuted, false);

  instance.running = false;
  testing.startPomodoroBackground(instance);
  assert.equal(starts.length, 1);
});

test('pomowave long press toggles the current focus background without changing timer progress', () => {
  const starts = [];
  const { config, testing } = createPomowaveAction(createRuntime({
    player: (_command, args) => {
      const handle = {
        args,
        killed: false,
        exitCode: null,
        kill() {
          this.killed = true;
          return true;
        },
      };
      starts.push(handle);
      return handle;
    },
  }));
  const phaseEndAt = Date.now() + 900_000;
  const instance = createInstance(config, {
    active: true,
    phase: 'focus',
    running: true,
    remainingSec: 900,
    totalSec: 1500,
    phaseEndAt,
    selectedBackgroundSound: 'wave',
  });

  testing.startPomodoroBackground(instance);
  const firstProcess = instance.backgroundProcess;
  testing.handlePomodoroLongPress(instance);
  assert.equal(instance.backgroundMuted, true);
  assert.equal(firstProcess.killed, true);
  assert.equal(instance.backgroundProcess, null);
  assert.equal(instance.phase, 'focus');
  assert.equal(instance.running, true);
  assert.equal(instance.remainingSec, 900);
  assert.equal(instance.phaseEndAt, phaseEndAt);

  const serialized = testing.serializePomodoroState(instance);
  assert.equal(serialized.backgroundMuted, true);
  assert.equal(testing.hydratePomodoroState(serialized).backgroundMuted, true);

  testing.handlePomodoroLongPress(instance);
  assert.equal(instance.backgroundMuted, false);
  assert.equal(starts.length, 2);
  assert.match(starts.at(-1).args.at(-1), /wave\.m4a$/);
});

test('pomowave paused focus long press controls the next resume and a new focus clears temporary mute', () => {
  const starts = [];
  const { config, testing } = createPomowaveAction(createRuntime({
    player: (_command, args) => {
      starts.push(args);
      return { killed: false, exitCode: null, kill() { this.killed = true; return true; } };
    },
  }));
  const instance = createInstance(config, {
    active: true,
    phase: 'focus',
    running: false,
    remainingSec: 700,
    totalSec: 1500,
    phaseEndAt: null,
    selectedBackgroundSound: 'forest',
  });

  testing.handlePomodoroLongPress(instance);
  assert.equal(instance.backgroundMuted, true);
  assert.equal(starts.length, 0);

  testing.handlePomodoroShortPress(instance);
  assert.equal(instance.running, true);
  assert.equal(starts.length, 0, 'muted focus must stay silent when resumed');

  testing.startPomodoroPhase(instance, 'focus', { autoStart: false, playSound: false });
  assert.equal(instance.phase, 'focus');
  assert.equal(instance.running, false);
  assert.equal(instance.backgroundMuted, false, 'a new focus clears the temporary mute');
});

test('pomowave applies every cue duration limit, leaves awaiting intact at expiry, and never loops auto transitions', () => {
  const calls = [];
  const { config, testing } = createPomowaveAction(createRuntime({
    player: (command, args, callback) => {
      calls.push({ command, args, callback });
      return { killed: false, kill() { this.killed = true; } };
    },
  }));
  for (const duration of ['60', '180', '300', '600']) {
    const bounded = createInstance(config, {
      awaiting: true,
      phase: 'shortBreak',
      settings: { ...config.defaults, cueDuration: duration, soundEnabled: 'true' },
    });
    testing.playPomodoroPhaseEndCue(bounded, { autoStart: false });
    assert.equal(bounded.cueRepeating, true);
    assert.equal(bounded.timers.get('pomodoroCueLimit').ms, Number(duration) * 1000);
    bounded.timers.get('pomodoroCueLimit').callback();
    assert.equal(bounded.cueProcess, null);
    assert.equal(bounded.timers.has('pomodoroCue'), false);
    assert.equal(bounded.timers.has('pomodoroCueLimit'), false);
    assert.equal(bounded.awaiting, true, '提醒到期只停声，等待状态不应被推进');
    assert.equal(bounded.phase, 'shortBreak');
  }

  const continuous = createInstance(config, { settings: { ...config.defaults, cueDuration: 'continuous', soundEnabled: 'true' } });
  testing.playPomodoroPhaseEndCue(continuous, { autoStart: false });
  assert.equal(continuous.cueRepeating, true);
  assert.equal(continuous.timers?.has('pomodoroCueLimit') ?? false, false);

  const automatic = createInstance(config, { settings: { ...config.defaults, cueDuration: '180', soundEnabled: 'true' } });
  testing.playPomodoroPhaseEndCue(automatic, { autoStart: true });
  assert.equal(automatic.cueRepeating, false);
  assert.equal(automatic.timers?.has('pomodoroCueLimit') ?? false, false);
  assert.equal(calls.length, 6, '每种有界时长、continuous 和自动衔接各只启动一次播放');
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
    assert.equal(selected, 'stove');
    assert.deepEqual(testing.hydratePomodoroState(testing.serializePomodoroState(instance)).selectedBackgroundSound, selected);
    testing.pausePomodoroBackground(instance);
    assert.deepEqual(signals, ['SIGSTOP']);
    testing.startPomodoroBackground(instance);
    assert.deepEqual(signals, ['SIGSTOP', 'SIGCONT']);
    assert.equal(instance.selectedBackgroundSound, selected);
    assert.equal(started[0].args.at(-1).endsWith(`${selected}.m4a`), true);
    assert.equal(
      started[0].args[1],
      String(testing.amplifiedPomodoroBackgroundVolume(selected, 35) / 100),
    );

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

test('pomowave long press only toggles focus background and leaves non-focus state and audio untouched', () => {
  const stopped = [];
  const { config, testing } = createPomowaveAction(createRuntime({
    player: (command) => ({
      killed: false,
      kill(signal) { stopped.push(`${command}:${signal || 'TERM'}`); this.killed = true; },
    }),
  }));
  const instance = createInstance(config, {
    active: true,
    phase: 'focus',
    running: true,
    totalSec: 1500,
    remainingSec: 700,
    phaseEndAt: Date.now() + 700_000,
    settings: { ...config.defaults, soundEnabled: 'true' },
  });

  config.onParamFromPlugin(instance, { previewSound: 'hero' });
  const cuePreview = instance.previewProcess;
  assert.ok(cuePreview);
  assert.equal(instance.previewPlaying, true);
  assert.equal(instance.timers.get('pomodoroPreview').ms, 15_000);

  config.onParamFromPlugin(instance, { previewBackgroundSound: 'wave' });
  assert.equal(cuePreview.killed, true, '新试听必须终止上一个试听句柄');
  const backgroundPreview = instance.previewProcess;
  assert.ok(backgroundPreview);
  testing.playPomodoroPhaseEndCue(instance, { autoStart: false });
  const cue = instance.cueProcess;
  testing.startPomodoroBackground(instance);
  const background = instance.backgroundProcess;

  testing.handlePomodoroLongPress(instance);
  assert.equal(instance.backgroundMuted, true);
  assert.equal(cue.killed, false, 'focus long press must not interfere with the cue channel');
  assert.equal(background.killed, true);
  assert.equal(backgroundPreview.killed, false, 'focus long press must not interfere with preview');

  instance.phase = 'shortBreak';
  testing.handlePomodoroLongPress(instance);
  assert.equal(instance.phase, 'shortBreak');
  assert.equal(instance.running, true);
  assert.equal(cue.killed, false);
  assert.equal(backgroundPreview.killed, false);
  assert.equal(instance.previewProcess, backgroundPreview);
  assert.equal(instance.timers.has('pomodoroPreview'), true);
  assert.equal(stopped.length, 2, 'only the replaced preview and muted focus background should stop');
});

test('pomowave clears awaiting cues when confirming, skipping, resetting, or disposing', () => {
  const { config, testing } = createPomowaveAction(createRuntime({
    player: () => ({ killed: false, kill() { this.killed = true; } }),
  }));
  const makeAwaiting = () => createInstance(config, {
    active: true,
    phase: 'shortBreak',
    awaiting: true,
    totalSec: 300,
    remainingSec: 300,
    settings: { ...config.defaults, soundEnabled: 'true' },
  });

  const confirmed = makeAwaiting();
  testing.playPomodoroPhaseEndCue(confirmed, { autoStart: false });
  const confirmCue = confirmed.cueProcess;
  testing.handlePomodoroShortPress(confirmed);
  assert.equal(confirmCue.killed, true);
  assert.equal(confirmed.cueProcess, null);

  const skipped = makeAwaiting();
  testing.playPomodoroPhaseEndCue(skipped, { autoStart: false });
  const skipCue = skipped.cueProcess;
  testing.skipPomodoroPhase(skipped);
  assert.equal(skipCue.killed, true);
  assert.equal(skipped.cueProcess, null);

  const reset = makeAwaiting();
  testing.playPomodoroPhaseEndCue(reset, { autoStart: false });
  const resetCue = reset.cueProcess;
  config.onParamFromPlugin(reset, { resetTimer: 'true' });
  assert.equal(resetCue.killed, true);
  assert.equal(reset.cueProcess, null);

  const disposed = makeAwaiting();
  testing.playPomodoroPhaseEndCue(disposed, { autoStart: false });
  const disposeCue = disposed.cueProcess;
  config.onDispose(disposed);
  assert.equal(disposeCue.killed, true);
  assert.equal(disposed.cueProcess, null);
});

test('pomowave double press handles paused, awaiting, done, and break snapshots without count drift', () => {
  const { config, testing } = createPomowaveAction(createRuntime());
  const paused = createInstance(config, {
    settings: { ...config.defaults, autoStartBreaks: 'false' },
    phase: 'focus', running: false, totalSec: 1500, remainingSec: 800, completedFocusRounds: 2,
  });
  testing.handlePomodoroShortPress(paused);
  testing.handlePomodoroDoublePress(paused);
  assert.equal(paused.phase, 'shortBreak');
  assert.equal(paused.running, true);
  assert.equal(paused.awaiting, false);
  assert.equal(paused.completedFocusRounds, 2);

  const awaiting = createInstance(config, {
    phase: 'shortBreak', awaiting: true, running: false, totalSec: 300, remainingSec: 300, completedFocusRounds: 3,
  });
  testing.handlePomodoroShortPress(awaiting);
  testing.handlePomodoroDoublePress(awaiting);
  assert.equal(awaiting.phase, 'focus');
  assert.equal(awaiting.running, true);
  assert.equal(awaiting.awaiting, false);
  assert.equal(awaiting.completedFocusRounds, 3);

  const done = createInstance(config, {
    phase: 'done', running: true, totalSec: 4, remainingSec: 4, completedFocusRounds: 4,
  });
  testing.handlePomodoroShortPress(done);
  testing.handlePomodoroDoublePress(done);
  assert.equal(done.phase, 'idle');
  assert.equal(done.completedFocusRounds, 0);

  const breakPhase = createInstance(config, {
    phase: 'longBreak', running: true, totalSec: 900, remainingSec: 500, completedFocusRounds: 4,
    phaseEndAt: Date.now() + 500_000,
  });
  testing.handlePomodoroShortPress(breakPhase);
  testing.handlePomodoroDoublePress(breakPhase);
  assert.equal(breakPhase.phase, 'done');
  assert.equal(breakPhase.completedFocusRounds, 0);
});

test('pomowave renders distinct status colors and a per-sound focus badge with mute slash', () => {
  const { config, testing } = createPomowaveAction(createRuntime());
  const instance = createInstance(config, {
    phase: 'focus',
    running: true,
    totalSec: 1500,
    remainingSec: 900,
    phaseEndAt: Date.now() + 900_000,
    selectedBackgroundSound: 'rain',
  });

  const runningSvg = decodeSvg(config.render(instance));
  assert.match(runningSvg, /data-pomodoro-status="FOCUS"[^>]+fill="#f00"/);
  assert.match(runningSvg, /data-background-sound="rain"/);
  assert.match(runningSvg, /data-background-muted="false"/);
  assert.doesNotMatch(runningSvg, /data-background-muted-slash/);
  assert.match(
    runningSvg,
    /data-background-sound="rain"[^>]+transform="translate\(118 174\)"/,
    'background icon should stay centered below the round lights',
  );
  assert.match(runningSvg, /data-background-sound="rain"[^]*?transform="scale\(0\.8333\)"/);
  assert.doesNotMatch(runningSvg, /cx="10" cy="10" r="9\.5"/, 'background icon should not have an outer circle');
  const roundLights = runningSvg.match(/<rect x="(?:95|113|131|149)" y="163" width="12" height="4" rx="2"[^>]+>/g) || [];
  assert.equal(roundLights.length, 4);
  roundLights.forEach((light) => {
    assert.match(light, /y="163" width="12" height="4" rx="2"/);
  });
  assert.doesNotMatch(runningSvg, /cy="174" r="5\.5"/, 'legacy circular round lights should be removed');

  instance.running = false;
  instance.phaseEndAt = null;
  const pausedSvg = decodeSvg(config.render(instance));
  assert.match(pausedSvg, /data-pomodoro-status="PAUSED"[^>]+fill="#fbbf24"/);
  assert.match(pausedSvg, /data-background-muted="false"/, 'pause is not the same as a user mute');

  instance.backgroundMuted = true;
  const mutedSvg = decodeSvg(config.render(instance));
  assert.match(mutedSvg, /data-background-muted="true"/);
  assert.match(mutedSvg, /data-background-muted-slash d="M2 18 18 2"/);

  const states = [
    { key: 'READY', phase: 'idle', running: false },
    { key: 'FOCUS', phase: 'focus', running: true },
    { key: 'SHORT', phase: 'shortBreak', running: true },
    { key: 'LONG', phase: 'longBreak', running: true },
    { key: 'DONE', phase: 'done', running: true },
    { key: 'PAUSED', phase: 'focus', running: false },
  ];
  const statusColors = states.map(({ key, phase, running }) => {
    const svg = decodeSvg(config.render(createInstance(config, {
      phase,
      running,
      totalSec: phase === 'done' ? 4 : 300,
      remainingSec: phase === 'done' ? 4 : 200,
      phaseEndAt: running ? Date.now() + 200_000 : null,
    })));
    const match = svg.match(new RegExp(`data-pomodoro-status="${key}"[^>]+fill="([^"]+)"`));
    assert.ok(match, `${key} needs a visible colored status label`);
    return match[1];
  });
  assert.equal(new Set(statusColors).size, states.length, 'every displayed status needs a distinct color');

  const sounds = [
    'rain', 'clock', 'wave', 'forest', 'cafe', 'morning', 'summer', 'storm', 'stove',
    'stream', 'deepSea', 'desert', 'chirp', 'boiling', 'musicBox', 'woodenFish', 'streetTraffic',
  ];
  const glyphs = sounds.map((sound) => testing.pomodoroBackgroundGlyph(sound));
  assert.equal(new Set(glyphs).size, sounds.length, 'every background sound needs a distinct vector glyph');
});

test('pomowave random overrides none, redraws only for a new focus, and restarts immediately for live background changes', () => {
  const starts = [];
  const stopped = [];
  const values = [0, 0.99, 0.5];
  const originalRandom = Math.random;
  Math.random = () => values.shift() ?? 0;
  try {
    const { config, testing } = createPomowaveAction(createRuntime({
      player: (command, args) => {
        starts.push({ command, args });
        return { killed: false, kill() { stopped.push(args.at(-1)); this.killed = true; } };
      },
    }));
    const instance = createInstance(config, {
      active: true,
      settings: { ...config.defaults, backgroundSound: 'none', backgroundRandom: 'true' },
      phase: 'focus', running: true, totalSec: 1500, remainingSec: 1500, phaseEndAt: Date.now() + 1_500_000,
    });
    testing.startPomodoroBackground(instance);
    assert.equal(instance.selectedBackgroundSound, 'rain');
    assert.match(starts[0].args.at(-1), /rain\.m4a$/);

    testing.pausePomodoroBackground(instance);
    testing.startPomodoroBackground(instance);
    assert.equal(instance.selectedBackgroundSound, 'rain', '暂停恢复不能重抽');

    testing.startPomodoroPhase(instance, 'focus', { autoStart: false, playSound: false });
    assert.equal(instance.selectedBackgroundSound, 'streetTraffic', '新 focus 轮次必须重抽，即使固定项是 none');

    instance.running = true;
    instance.phaseEndAt = Date.now() + 1_500_000;
    testing.startPomodoroBackground(instance);
    const previous = { ...instance.settings };
    instance.settings = { ...instance.settings, backgroundRandom: 'false', backgroundSound: 'wave', backgroundVolume: '77' };
    config.onSettingsChanged(instance, previous);
    assert.equal(stopped.length >= 1, true);
    assert.match(starts.at(-1).args.at(-1), /wave\.m4a$/);
    assert.equal(
      starts.at(-1).args[1],
      String(testing.amplifiedPomodoroBackgroundVolume('wave', 77) / 100),
    );

    const beforeVolume = { ...instance.settings };
    instance.settings = { ...instance.settings, backgroundVolume: '66' };
    config.onSettingsChanged(instance, beforeVolume);
    assert.match(starts.at(-1).args.at(-1), /wave\.m4a$/);
    assert.equal(
      starts.at(-1).args[1],
      String(testing.amplifiedPomodoroBackgroundVolume('wave', 66) / 100),
    );

    const beforeRandom = { ...instance.settings };
    instance.settings = { ...instance.settings, backgroundSound: 'none', backgroundRandom: 'true' };
    config.onSettingsChanged(instance, beforeRandom);
    assert.equal(instance.selectedBackgroundSound, 'stove');
    assert.match(starts.at(-1).args.at(-1), /stove\.m4a$/);

    testing.handlePomodoroLongPress(instance);
    const startsWhileMuted = starts.length;
    const mutedBefore = { ...instance.settings };
    instance.settings = { ...instance.settings, backgroundVolume: '55' };
    config.onSettingsChanged(instance, mutedBefore);
    assert.equal(starts.length, startsWhileMuted, 'settings changes must not restart a temporarily muted focus');
  } finally {
    Math.random = originalRandom;
  }
});

test('pomowave safely drops v1 state and audio failures or phase changes cannot leave background playback alive', () => {
  const { config, testing } = createPomowaveAction(createRuntime({
    persistedState: { v: 1, phase: 'focus', running: true, totalSec: 1500, remainingSec: 500, phaseEndAt: Date.now() + 500_000 },
  }));
  const hydrated = config.createState({ context: 'legacy' });
  assert.equal(hydrated.phase, 'idle');
  assert.equal(hydrated.running, false);

  let callback;
  const player = (command, _args, onComplete) => {
    callback = onComplete;
    return { killed: false, kill() { this.killed = true; } };
  };
  const action = createPomowaveAction(createRuntime({ player }));
  const instance = createInstance(action.config, {
    active: true, phase: 'focus', running: true, totalSec: 1500, remainingSec: 1000, phaseEndAt: Date.now() + 1_000_000,
  });
  action.testing.startPomodoroBackground(instance);
  const processHandle = instance.backgroundProcess;
  callback(new Error('player failed'));
  assert.equal(instance.backgroundProcess, null);
  assert.equal(instance.running, true);
  assert.equal(instance.timers?.has('pomodoroBackground') ?? false, false);

  action.testing.startPomodoroBackground(instance);
  const phaseProcess = instance.backgroundProcess;
  action.testing.skipPomodoroPhase(instance);
  assert.equal(phaseProcess.killed, true);
  assert.equal(instance.phase, 'shortBreak');
  assert.equal(instance.backgroundProcess, null);
  assert.notEqual(processHandle, phaseProcess);
});

test('pomowave encodes Windows background playback without exposing paths in argv', () => {
  const { testing } = createPomowaveAction(createRuntime({ platform: 'win32' }));
  const audioPath = "C:\\Users\\A B\\O'Neill\\rain.m4a";
  const plan = testing.windowsBackgroundPlaybackCommand(audioPath, 42.6);
  assert.equal(plan.command, 'powershell');
  assert.deepEqual(plan.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.equal(plan.args.length, 4, '原始路径不得作为尾随 argv 传入');
  assert.equal(plan.args.join(' ').includes(audioPath), false);
  const script = Buffer.from(plan.args[3], 'base64').toString('utf16le');
  const encodedPath = script.match(/FromBase64String\('([^']+)'\)/)?.[1];
  assert.ok(encodedPath);
  assert.equal(Buffer.from(encodedPath, 'base64').toString('utf8'), audioPath);
  assert.match(script, /\$player\.settings\.volume = 43;/);
  assert.match(script, /\$player\.URL = \$audioPath;/);

  const packagedPlan = testing.backgroundPlaybackCommand('rain', 35);
  assert.equal(packagedPlan.command, 'powershell');
  assert.deepEqual(packagedPlan.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.equal(packagedPlan.args.length, 4);
  const packagedScript = Buffer.from(packagedPlan.args[3], 'base64').toString('utf16le');
  assert.match(packagedScript, /\$player\.settings\.volume = 99;/);

  const linux = createPomowaveAction(createRuntime({ platform: 'linux' })).testing;
  const ffplayPlan = linux.backgroundPlaybackCommand('forest', 35);
  assert.deepEqual(ffplayPlan.args.slice(-3), ['-af', 'volume=10dB', ffplayPlan.args.at(-1)]);
});

test('pomowave terminates a SIGSTOP background process on stop and dispose', () => {
  const signals = [];
  const makeHandle = () => ({
    killed: false,
    exitCode: null,
    kill(signal = 'SIGTERM') {
      signals.push(signal);
      this.killed = true;
      return true;
    },
  });
  const { config, testing } = createPomowaveAction(createRuntime({ player: () => makeHandle() }));
  const instance = createInstance(config, {
    active: true, phase: 'focus', running: true, totalSec: 1500, remainingSec: 1500, phaseEndAt: Date.now() + 1_500_000,
  });

  testing.startPomodoroBackground(instance);
  testing.pausePomodoroBackground(instance);
  testing.stopPomodoroBackground(instance);
  assert.deepEqual(signals, ['SIGSTOP', 'SIGTERM']);

  instance.running = true;
  testing.startPomodoroBackground(instance);
  testing.pausePomodoroBackground(instance);
  config.onDispose(instance);
  assert.deepEqual(signals, ['SIGSTOP', 'SIGTERM', 'SIGSTOP', 'SIGTERM']);
});

test('pomowave cue errors immediately stop all repeat scheduling and stale callbacks stay inert', () => {
  const callbacks = [];
  const { config, testing } = createPomowaveAction(createRuntime({
    player: (_command, _args, callback) => {
      callbacks.push(callback);
      return { killed: false, exitCode: null, kill() { this.killed = true; return true; } };
    },
  }));
  for (const cueDuration of ['continuous', '180']) {
    const instance = createInstance(config, { settings: { ...config.defaults, soundEnabled: 'true', cueDuration } });
    testing.playPomodoroPhaseEndCue(instance, { autoStart: false });
    const callback = callbacks.at(-1);
    const generation = instance.cueGeneration;
    callback(new Error('audio device failed'));
    assert.equal(instance.cueRepeating, false);
    assert.equal(instance.cueProcess, null);
    assert.equal(instance.timers?.has('pomodoroCue') ?? false, false);
    assert.equal(instance.timers?.has('pomodoroCueLimit') ?? false, false);
    assert.equal(instance.cueGeneration, generation + 1);
    callback(null);
    assert.equal(instance.timers?.has('pomodoroCue') ?? false, false, '失效 generation 的回调不得重排');
  }

  const automatic = createInstance(config, { settings: { ...config.defaults, soundEnabled: 'true' } });
  testing.playPomodoroPhaseEndCue(automatic, { autoStart: true });
  const automaticGeneration = automatic.cueGeneration;
  callbacks.at(-1)(new Error('automatic cue failed'));
  assert.equal(automatic.cueGeneration, automaticGeneration + 1);
  assert.equal(automatic.cueProcess, null);
});

test('pomowave updates paused focus background settings without restart until resume', () => {
  const signals = [];
  const starts = [];
  const originalRandom = Math.random;
  Math.random = () => 0.34;
  try {
    const { config, testing } = createPomowaveAction(createRuntime({
      player: (_command, args) => {
        starts.push(args);
        return {
          killed: false,
          exitCode: null,
          kill(signal = 'SIGTERM') { signals.push(signal); this.killed = true; return true; },
        };
      },
    }));
    const instance = createInstance(config, {
      active: true, phase: 'focus', running: true, totalSec: 1500, remainingSec: 1200, phaseEndAt: Date.now() + 1_200_000,
    });
    testing.startPomodoroBackground(instance);
    testing.togglePomodoro(instance);
    const fixedBefore = { ...instance.settings };
    instance.settings = { ...instance.settings, backgroundSound: 'wave' };
    config.onSettingsChanged(instance, fixedBefore);
    assert.deepEqual(signals, ['SIGSTOP', 'SIGTERM']);
    assert.equal(instance.selectedBackgroundSound, 'wave');
    assert.equal(starts.length, 1, '暂停期改固定音源不得立即重启');

    testing.togglePomodoro(instance);
    assert.match(starts.at(-1).at(-1), /wave\.m4a$/);
    testing.togglePomodoro(instance);
    const randomBefore = { ...instance.settings };
    instance.settings = { ...instance.settings, backgroundSound: 'none', backgroundRandom: 'true' };
    config.onSettingsChanged(instance, randomBefore);
    assert.equal(instance.selectedBackgroundSound, 'morning');
    assert.equal(starts.length, 2, '暂停期改随机开关不得立即重启');

    testing.togglePomodoro(instance);
    assert.match(starts.at(-1).at(-1), /morning\.m4a$/);
    testing.togglePomodoro(instance);
    const volumeBefore = { ...instance.settings };
    instance.settings = { ...instance.settings, backgroundVolume: '66' };
    config.onSettingsChanged(instance, volumeBefore);
    assert.equal(starts.length, 3, '暂停期改音量不得立即重启');
    testing.togglePomodoro(instance);
    assert.match(starts.at(-1).at(-1), /morning\.m4a$/);
    assert.equal(
      starts.at(-1)[1],
      String(testing.amplifiedPomodoroBackgroundVolume('morning', 66) / 100),
    );
  } finally {
    Math.random = originalRandom;
  }
});

test('pomowave onReady starts background once when overdue break or done advances into focus', () => {
  for (const phase of ['shortBreak', 'done']) {
    const starts = [];
    const runtime = createRuntime({ player: (_command, args) => {
      starts.push(args);
      return { killed: false, exitCode: null, kill() { this.killed = true; return true; } };
    } });
    const { config } = createPomowaveAction(runtime);
    const instance = createInstance(config, {
      context: `on-ready-${phase}`,
      active: true,
      phase,
      running: true,
      totalSec: phase === 'done' ? 4 : 300,
      remainingSec: 0,
      phaseEndAt: Date.now() - 1_000,
    });
    runtime.instances.set(instance.context, instance);
    config.onReady(instance);
    assert.equal(instance.phase, 'focus');
    assert.equal(instance.running, true);
    assert.equal(starts.length, 1, `${phase} 逾期推进不得二次启动背景音`);
  }
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

test('pomowave packages every locally extracted TickTick background with exact identity and provenance', () => {
  const audioDir = path.resolve(import.meta.dirname, '../plugins/com.ulanzi.lexutility.ulanziPlugin/assets/audio/pomowave');
  const expected = [
    'rain', 'clock', 'wave', 'forest', 'cafe', 'morning', 'summer', 'storm', 'stove',
    'stream', 'deepSea', 'desert', 'chirp', 'boiling', 'musicBox', 'woodenFish', 'streetTraffic',
  ];
  const credits = fs.readFileSync(path.join(audioDir, 'CREDITS.md'), 'utf8');
  const previewSha256 = {
    rain: 'd0ea8c934c0ea4ed8ef7de92a1c70c9cc657c1841b964d303228969150fdd684',
    clock: '56fc3bbbd84e83ea25cc4b9fa7d722176c1b875d3bffbe677404c39eb5936ad2',
    wave: 'bb84a08f319b2b9c951169079229f91b8038bbddd9e89e11efd7316da4beed80',
    forest: '7651ed119e0be8e1a94cfbbd9f76cd57b25b894be9caccac55b377288b779899',
    cafe: 'c3a226b634f798b7750180c9b58f79c245c1a3ece6ffe032fe0ea86407739bea',
    morning: '71390416b3591a848a328c144fba77d9e2b7739084458e82aa53baa10d9df68d',
    summer: '8d6aa8531d8a26e9d0574a29c4bd2de5fef7547419a55f3237f064c1a900c4db',
    storm: '31e674a3b6fc215c9f55a9a149e40c9e2bfc07d72e4dfc2b523f39259791328c',
    stove: '80bd39400f8bb0b8c05d326c78dc84f85f2b5cc6ebbdc0a4c11d1928c237d765',
    stream: '9381fa1819534981d4166865a0450257ecf2fba84146972f2be66f8d5a7ba54c',
    deepSea: 'f791469a130ad0cdfa708de5969c89b36fdbd3ec93a3f78411480cbcf2d3003b',
    desert: '0bb717880d5933497cc175d54140badcdceba9783674d80d046ff13b9d3df492',
    chirp: '25a838b7fe86acb3a21bb5db51cab7b4abe9db03f308c94c7acc002fea9d959d',
    boiling: 'ffabbab2063701e027ec7087660356218ed1dd5bddf2728d064de31ee5725952',
    musicBox: 'b7e2def0392e0f52300d8902826135c89a5f7f953a32444da0dd4c34c2a7db02',
    woodenFish: '6fb17df6f2e89ce15c781b4a56d997027c500e801400a68ce555c650164d7e98',
    streetTraffic: 'a578ac65a18eb4950a2f2675271dd07ed59a847aef85e4b3ec01707cd1520923',
  };
  const files = expected.map((sound) => path.join(audioDir, `${sound}.m4a`));

  assert.ok(files.every((file) => fs.existsSync(file)), 'every selectable background has a packaged M4A');
  assert.ok(files.reduce((total, file) => total + fs.statSync(file).size, 0) <= 30 * 1024 * 1024);
  assert.match(credits, /TickTick 8\.0\.80/);
  assert.match(credits, /licensing status is not established/i);
  assert.match(credits, /Do not redistribute/i);
  for (const sound of expected) {
    assert.ok(credits.includes(`\`${sound}.m4a\``));
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(audioDir, `${sound}.m4a`))).digest('hex'), previewSha256[sound]);
  }
});
