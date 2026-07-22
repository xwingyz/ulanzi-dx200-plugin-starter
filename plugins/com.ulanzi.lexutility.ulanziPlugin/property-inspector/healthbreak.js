const HEALTHBREAK_FIELDS = [
  'groups',
  'intervalMin',
  'dailyGoal',
  'activeStart',
  'activeEnd',
  'activeDays',
  'repeatReminderMin',
  'soundEnabled',
  'theme',
  'frameSize',
  'showFrame',
];

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

function escapeHealthBreakHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function initHealthBreakInspector() {
  let currentContext = '';
  let uiBound = false;
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
    document.getElementById('durationHint').textContent = `已选 ${selectedGroups.length} 组，预计 ${Math.floor(seconds / 60)}分${seconds % 60}秒。`;
  }

  function syncDayUi() {
    document.getElementById('activeDays').value = selectedDays.join(',');
    document.querySelectorAll('[data-day]').forEach((button) => {
      button.classList.toggle('active', selectedDays.includes(button.dataset.day));
    });
  }

  function renderStats(raw) {
    let stats;
    try { stats = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return; }
    if (!stats || typeof stats !== 'object') return;
    document.getElementById('todayCompleted').textContent = String(stats.today?.completed || 0);
    document.getElementById('todayBonus').textContent = String(stats.today?.bonus || 0);
    document.getElementById('streak').textContent = String(stats.streak || 0);
    const history = Array.isArray(stats.history) ? [...stats.history].reverse() : [];
    document.getElementById('history').innerHTML = history.length
      ? history.map((entry) => `<div class="history-row"><span>${escapeHealthBreakHtml(entry.dayKey)}</span><span>✓${Number(entry.completed) || 0}</span><span>+${Number(entry.bonus) || 0}</span><span>↷${Number(entry.skipped) || 0}</span><span>×${Number(entry.cancelled) || 0}</span></div>`).join('')
      : '<div class="history-row"><span>暂无记录</span></div>';
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

    document.querySelectorAll('[data-group-key]').forEach((button) => {
      button.addEventListener('click', () => {
        const key = button.dataset.groupKey;
        const index = selectedGroups.indexOf(key);
        if (index >= 0) {
          if (selectedGroups.length === 1) return;
          selectedGroups.splice(index, 1);
        } else {
          if (selectedGroups.length >= 4) return;
          if (key === 'pelvic' && typeof window.confirm === 'function' && !window.confirm('盆底肌并非越紧越好。确认已阅读安全提示，并在不适时立即停止？')) return;
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
    $UD.sendParamFromPlugin({ __requestHealthStats: 'true' }, currentContext);
  });

  function apply(message) {
    currentContext = message.context || currentContext;
    const param = message.param || {};
    if (param.healthStats) renderStats(param.healthStats);
    applySettings(HEALTHBREAK_FIELDS, param);
    const groups = parseUniqueList(param.groups ?? document.getElementById('groups').value, HEALTHBREAK_GROUPS);
    if (groups.length) selectedGroups = groups.slice(0, 4);
    const days = parseUniqueList(param.activeDays ?? document.getElementById('activeDays').value, ['0', '1', '2', '3', '4', '5', '6']);
    if (days.length) selectedDays = days;
    syncGroupUi();
    syncDayUi();
  }

  $UD.onAdd(apply);
  $UD.onParamFromApp(apply);
  $UD.onParamFromPlugin(apply);
  syncGroupUi();
  syncDayUi();
}

initHealthBreakInspector();
