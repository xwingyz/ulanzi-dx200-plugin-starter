const HEALTHBREAK_FIELDS = withLanguageField([
  'groups',
  'intervalMin',
  'dailyGoal',
  'activeStart',
  'activeEnd',
  'activeDays',
  'lunchEnabled',
  'lunchStart',
  'lunchEnd',
  'repeatReminderMin',
  'soundEnabled',
  'theme',
  'frameSize',
  'showFrame',
]);

const HEALTHBREAK_GROUPS = ['eyes', 'neck', 'hands', 'stand', 'breathe', 'pelvic'];
const HEALTHBREAK_GROUP_SECONDS = { eyes: 30, neck: 65, hands: 50, stand: 70, breathe: 50, pelvic: 50 };

function parseUniqueList(value, allowed) {
  const seen = new Set();
  return String(value || '').split(',').flatMap((part) => {
    const item = part.trim();
    if (!allowed.includes(item) || seen.has(item)) return [];
    seen.add(item);
    return [item];
  });
}

function initHealthBreakInspector() {
  let currentContext = '';
  let uiBound = false;
  let lastStats = null;
  let selectedGroups = ['eyes', 'neck'];
  let selectedDays = ['0', '1', '2', '3', '4', '5', '6'];

  function syncGroupUi() {
    document.getElementById('groups').value = selectedGroups.join(',');
    const list = document.getElementById('groupList');
    const rows = [...document.querySelectorAll('[data-group-row]')];
    rows.sort((left, right) => {
      const leftKey = left.dataset.groupRow;
      const rightKey = right.dataset.groupRow;
      const leftIndex = selectedGroups.indexOf(leftKey);
      const rightIndex = selectedGroups.indexOf(rightKey);
      if (leftIndex >= 0 && rightIndex >= 0) return leftIndex - rightIndex;
      if (leftIndex >= 0) return -1;
      if (rightIndex >= 0) return 1;
      return HEALTHBREAK_GROUPS.indexOf(leftKey) - HEALTHBREAK_GROUPS.indexOf(rightKey);
    });
    rows.forEach((row) => list.appendChild(row));
    rows.forEach((row) => {
      const key = row.dataset.groupRow;
      const index = selectedGroups.indexOf(key);
      row.querySelector('[data-group-key]').classList.toggle('active', index >= 0);
      row.querySelector('[data-move="up"]').disabled = index <= 0;
      row.querySelector('[data-move="down"]').disabled = index < 0 || index >= selectedGroups.length - 1;
    });
    const seconds = selectedGroups.reduce((total, key) => total + (HEALTHBREAK_GROUP_SECONDS[key] || 0), 0);
    document.getElementById('durationHint').textContent = $UD.t('%s groups selected · about %s min %s sec')
      .replace('%s', String(selectedGroups.length))
      .replace('%s', String(Math.floor(seconds / 60)))
      .replace('%s', String(seconds % 60));
  }

  function syncDayUi() {
    document.getElementById('activeDays').value = selectedDays.join(',');
    document.querySelectorAll('[data-day]').forEach((button) => {
      button.classList.toggle('active', selectedDays.includes(button.dataset.day));
    });
  }

  function heatmapDayKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function renderHeatmap(history, goal) {
    const container = document.getElementById('heatmap');
    if (!container) return;
    const byDay = new Map();
    history.forEach((entry) => { if (entry && entry.dayKey) byDay.set(entry.dayKey, entry); });
    const WEEKS = 13;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const currentMonday = new Date(today);
    currentMonday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    const start = new Date(currentMonday);
    start.setDate(currentMonday.getDate() - (WEEKS - 1) * 7);
    const cells = [];
    for (let col = 0; col < WEEKS; col += 1) {
      for (let row = 0; row < 7; row += 1) {
        const date = new Date(start);
        date.setDate(start.getDate() + col * 7 + row);
        const key = heatmapDayKey(date);
        const entry = date > today ? null : byDay.get(key);
        const done = entry ? Number(entry.completed) || 0 : 0;
        const bonus = entry ? Number(entry.bonus) || 0 : 0;
        let cls = '';
        if (done > 0) {
          const ratio = goal > 0 ? done / goal : 1;
          cls = ratio >= 1 ? 'l4' : ratio >= 0.67 ? 'l3' : ratio >= 0.34 ? 'l2' : 'l1';
          if (ratio >= 1 && bonus > 0) cls += ' bonus';
        }
        cells.push(`<i class="${cls}" title="${key}${done ? ` · ✓${done}` : ''}"></i>`);
      }
    }
    container.innerHTML = cells.join('');
  }

  function renderStats(raw) {
    let stats;
    try { stats = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return; }
    if (!stats || typeof stats !== 'object') return;
    lastStats = stats;
    const goal = Number(stats.goal) || 0;
    const todayDone = Number(stats.today?.completed) || 0;
    document.getElementById('todayCompleted').textContent = goal ? `${todayDone}/${goal}` : String(todayDone);
    document.getElementById('todayBonus').textContent = `+${Number(stats.today?.bonus) || 0}`;
    document.getElementById('weekGoalDays').textContent = String(Number(stats.weekGoalDays) || 0);
    document.getElementById('weekCompleted').textContent = String(Number(stats.weekCompleted) || 0);
    document.getElementById('streak').textContent = String(Number(stats.streak) || 0);
    renderHeatmap(Array.isArray(stats.history) ? stats.history : [], goal);
  }

  function pushSettings() {
    $UD.sendParamFromPlugin(collectSettings(HEALTHBREAK_FIELDS), currentContext);
  }
  const autosave = debounce(pushSettings, AUTOSAVE_DEBOUNCE_MS);
  function commitSettings() {
    if (!autosave.flush()) pushSettings();
  }

  function bindUiOnce() {
    if (uiBound) return;
    uiBound = true;
    const form = document.getElementById('property-inspector');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      commitSettings();
      flashInspectorFeedback('saved');
    });
    form.addEventListener('input', () => autosave());
    bindThemeButtons(commitSettings);
    bindLanguageSelection(commitSettings, () => {
      syncGroupUi();
      renderStats(lastStats);
    });

    document.querySelectorAll('[data-group-key]').forEach((button) => {
      button.addEventListener('click', () => {
        const key = button.dataset.groupKey;
        const index = selectedGroups.indexOf(key);
        if (index >= 0) {
          if (selectedGroups.length === 1) return;
          selectedGroups.splice(index, 1);
        } else {
          if (selectedGroups.length >= 3) return;
          if (key === 'pelvic' && typeof window.confirm === 'function' && !window.confirm($UD.t('A tighter pelvic floor is not always better. Confirm that you read the safety note and will stop if you feel discomfort.'))) return;
          selectedGroups.push(key);
        }
        syncGroupUi();
        commitSettings();
      });
    });

    document.querySelectorAll('[data-move]').forEach((button) => {
      button.addEventListener('click', () => {
        const key = button.closest('[data-group-row]').dataset.groupRow;
        const index = selectedGroups.indexOf(key);
        const nextIndex = button.dataset.move === 'up' ? index - 1 : index + 1;
        if (index < 0 || nextIndex < 0 || nextIndex >= selectedGroups.length) return;
        [selectedGroups[index], selectedGroups[nextIndex]] = [selectedGroups[nextIndex], selectedGroups[index]];
        syncGroupUi();
        commitSettings();
      });
    });

    document.querySelectorAll('[data-day]').forEach((button) => {
      button.addEventListener('click', () => {
        const day = button.dataset.day;
        if (selectedDays.includes(day)) {
          if (selectedDays.length === 1) return;
          selectedDays = selectedDays.filter((item) => item !== day);
        } else {
          selectedDays.push(day);
        }
        syncDayUi();
        commitSettings();
      });
    });

    bindResetDefaults(() => {
      autosave.cancel();
      $UD.sendParamFromPlugin({ [RESET_DEFAULTS_PARAM]: 'true' }, currentContext);
    });
    window.addEventListener('pagehide', () => {
      autosave.flush();
      autosave.cancel();
    });
  }

  $UD.connect('com.ulanzi.ulanzistudio.lexutility.healthbreak');
  $UD.onConnected(() => {
    document.querySelector('.uspi-wrapper').classList.remove('hidden');
    bindUiOnce();
    $UD.sendParamFromPlugin({ [REQUEST_SETTINGS_PARAM]: 'true' }, currentContext);
    $UD.sendParamFromPlugin({ __requestHealthStats: 'true' }, currentContext);
  });

  function apply(message) {
    currentContext = message.context || currentContext;
    const param = message.param || {};
    applySettings(HEALTHBREAK_FIELDS, param);
    const groups = parseUniqueList(param.groups ?? document.getElementById('groups').value, HEALTHBREAK_GROUPS);
    if (groups.length) selectedGroups = groups.slice(0, 3);
    const days = parseUniqueList(param.activeDays ?? document.getElementById('activeDays').value, ['0', '1', '2', '3', '4', '5', '6']);
    if (days.length) selectedDays = days;
    syncGroupUi();
    syncDayUi();
    if (param.healthStats) lastStats = typeof param.healthStats === 'string' ? param.healthStats : param.healthStats;
    void afterLanguageSelection(() => {
      syncGroupUi();
      renderStats(lastStats);
    });
  }

  $UD.onAdd(apply);
  $UD.onParamFromApp(apply);
  $UD.onParamFromPlugin(apply);
  syncGroupUi();
  syncDayUi();
}

initHealthBreakInspector();
