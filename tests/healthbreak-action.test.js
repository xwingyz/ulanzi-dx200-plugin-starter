import assert from 'node:assert/strict';
import { test } from 'node:test';

import { __testing as lexTesting } from '../plugins/com.ulanzi.lexutility.ulanziPlugin/plugin/app.js';

const config = lexTesting.ACTION_CONFIGS.healthbreak;

function localTimestamp(year, month, day, hours, minutes = 0) {
  return new Date(year, month - 1, day, hours, minutes).getTime();
}

test('healthbreak normalizes one to four unique built-in groups', () => {
  assert.deepEqual(
    lexTesting.healthBreakNormalizeGroups({ groups: 'stand,eyes,stand,pelvic,hands,neck' }),
    ['stand', 'eyes', 'pelvic', 'hands'],
  );
  assert.deepEqual(lexTesting.healthBreakNormalizeGroups({ groups: 'unknown' }), ['eyes', 'neck']);

  const normalized = config.normalizeSettings({
    groups: 'hands,eyes,hands',
    intervalMin: '999',
    dailyGoal: '0',
    activeStart: 'bad',
    activeEnd: '23:15',
    activeDays: '1,3,3,6',
    repeatReminderMin: '-2',
    soundEnabled: false,
  }, config.defaults);
  assert.equal(normalized.groups, 'hands,eyes');
  assert.equal(normalized.intervalMin, '240');
  assert.equal(normalized.dailyGoal, '1');
  assert.equal(normalized.activeStart, '09:00');
  assert.equal(normalized.activeEnd, '23:15');
  assert.equal(normalized.activeDays, '1,3,6');
  assert.equal(normalized.repeatReminderMin, '0');
  assert.equal(normalized.soundEnabled, 'false');
});

test('healthbreak builds the complete selected-group plan in user order', () => {
  const plan = lexTesting.healthBreakBuildSessionPlan({ groups: 'eyes,hands' });
  assert.deepEqual(plan.map((stage) => stage.groupKey), ['eyes', 'eyes', 'hands', 'hands', 'hands']);
  assert.deepEqual(plan.map((stage) => stage.id), ['far', 'blink', 'open', 'wristLeft', 'wristRight']);
  assert.equal(plan.reduce((total, stage) => total + stage.durationMs, 0), 80_000);
});

test('healthbreak assigns a cross-midnight window to its start date and weekday', () => {
  const settings = { activeStart: '20:00', activeEnd: '03:00', activeDays: '1' };
  const mondayLate = lexTesting.healthBreakHealthWindowFor(settings, localTimestamp(2026, 7, 20, 22));
  const tuesdayEarly = lexTesting.healthBreakHealthWindowFor(settings, localTimestamp(2026, 7, 21, 2));
  const tuesdayLate = lexTesting.healthBreakHealthWindowFor(settings, localTimestamp(2026, 7, 21, 22));

  assert.deepEqual(mondayLate, { active: true, dayKey: '2026-07-20' });
  assert.deepEqual(tuesdayEarly, { active: true, dayKey: '2026-07-20' });
  assert.deepEqual(tuesdayLate, { active: false, dayKey: null });
});

test('healthbreak state hydrate pauses interrupted sessions and sanitizes history', () => {
  const settings = { ...config.defaults, intervalMin: '45' };
  const raw = {
    v: 1,
    healthStatus: 'running',
    intervalRemainingMs: 999_999_999,
    dueAt: 1234,
    today: { dayKey: '<script>', completed: 2.4, bonus: -1, skipped: 1, cancelled: 0 },
    history: Array.from({ length: 35 }, (_, index) => ({
      dayKey: `2026-06-${String(index + 1).padStart(2, '0')}`,
      completed: index,
    })),
    sessionStepIndex: 3,
    stageRemainingMs: 4_500,
  };
  const restored = lexTesting.healthBreakHydrateState(raw, settings);

  assert.equal(restored.healthStatus, 'paused');
  assert.equal(restored.intervalRemainingMs, 45 * 60_000);
  assert.equal(restored.today.dayKey, null);
  assert.equal(restored.today.completed, 2);
  assert.equal(restored.today.bonus, 0);
  assert.equal(restored.history.length, 30);
  assert.equal(restored.sessionStepIndex, 3);
  assert.equal(restored.stageRemainingMs, 4_500);

  const roundTrip = lexTesting.healthBreakSerializeState({ ...restored, sessionWasBonus: false });
  assert.equal(roundTrip.v, 1);
  assert.equal(roundTrip.healthStatus, 'paused');
});

test('healthbreak waiting tick counts only the supplied active time', () => {
  const now = localTimestamp(2026, 7, 22, 12);
  const context = 'com.ulanzi.ulanzistudio.lexutility.healthbreak___tick___one';
  const settings = {
    ...config.defaults,
    activeStart: '00:00',
    activeEnd: '00:00',
    intervalMin: '5',
  };
  const dayKey = lexTesting.healthBreakHealthWindowFor(settings, now).dayKey;
  const instance = {
    context,
    actionUuid: 'com.ulanzi.ulanzistudio.lexutility.healthbreak',
    active: false,
    settings,
    ...config.createState({ context: '', settings }),
    today: { dayKey, completed: 0, bonus: 0, skipped: 0, cancelled: 0 },
    intervalRemainingMs: 2_000,
    lastTickAt: now - 1_000,
  };
  const instances = new Map([[context, instance]]);

  lexTesting.healthBreakTick(instance, { now, userActive: true, instances });
  assert.equal(instance.intervalRemainingMs, 1_000);

  lexTesting.healthBreakTick(instance, { now: now + 1_000, userActive: false, instances });
  assert.equal(instance.intervalRemainingMs, 1_000);
  lexTesting.clearInstanceTimeout(instance, 'healthbreak');
});

test('healthbreak reminder strength softens then repeats on configured cadence', () => {
  const instance = { dueAt: 1_000, settings: { repeatReminderMin: '5' } };
  assert.equal(lexTesting.healthBreakReminderFlashStrong(instance, 120_000), true);
  assert.equal(lexTesting.healthBreakReminderFlashStrong(instance, 180_000), false);
  assert.equal(lexTesting.healthBreakReminderFlashStrong(instance, 302_000), true);
});

test('healthbreak short press starts, pauses and resumes; long press cancels', () => {
  const context = 'com.ulanzi.ulanzistudio.lexutility.healthbreak___press___one';
  const settings = { ...config.defaults, groups: 'eyes', soundEnabled: 'false' };
  const instance = {
    context,
    actionUuid: 'com.ulanzi.ulanzistudio.lexutility.healthbreak',
    active: false,
    settings,
    ...config.createState({ context: '', settings }),
  };

  config.onRun(instance);
  assert.equal(instance.healthStatus, 'running');
  assert.equal(instance.sessionPlan.length, 2);
  config.onRun(instance);
  assert.equal(instance.healthStatus, 'paused');
  config.onRun(instance);
  assert.equal(instance.healthStatus, 'running');
  config.onLongPress(instance);
  assert.equal(instance.healthStatus, 'waiting');
  assert.equal(instance.today.cancelled, 1);
  lexTesting.clearInstanceTimeout(instance, 'healthbreak');
});

test('healthbreak completes automatically after the last guide stage', () => {
  const context = 'com.ulanzi.ulanzistudio.lexutility.healthbreak___complete___one';
  const settings = {
    ...config.defaults,
    activeStart: '00:00',
    activeEnd: '00:00',
    groups: 'eyes',
    soundEnabled: 'false',
  };
  const instance = {
    context,
    actionUuid: 'com.ulanzi.ulanzistudio.lexutility.healthbreak',
    active: false,
    settings,
    ...config.createState({ context: '', settings }),
  };
  const instances = new Map([[context, instance]]);

  config.onRun(instance);
  instance.sessionPlan = [{ id: 'last', groupKey: 'eyes', label: '完成', durationMs: 500 }];
  instance.sessionStepIndex = 0;
  instance.stageRemainingMs = 500;
  const now = instance.lastTickAt + 1_000;
  lexTesting.healthBreakTick(instance, { now, userActive: true, instances });

  assert.equal(instance.healthStatus, 'waiting');
  assert.equal(instance.today.completed, 1);
  assert.equal(instance.sessionPlan.length, 0);
  lexTesting.clearInstanceTimeout(instance, 'healthbreak');
});
