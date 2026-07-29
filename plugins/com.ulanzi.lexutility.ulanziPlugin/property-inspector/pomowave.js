const POMOWAVE_FIELDS = withLanguageField([
  'focusMin',
  'shortBreakMin',
  'longBreakMin',
  'roundsBeforeLongBreak',
  'theme',
  'frameSize',
  'showFrame',
  'soundStyle',
  'soundEnabled',
  'cueDuration',
  'backgroundSound',
  'backgroundRandom',
  'backgroundVolume',
  'autoStartBreaks',
  'autoStartFocus',
]);

const POMOWAVE_BACKGROUND_LABELS = {
  none: 'None',
  random: 'Random background',
  rain: 'Rain',
  clock: 'Clock',
  wave: 'Wave',
  forest: 'Forest',
  cafe: 'Cafe',
  morning: 'Morning',
  summer: 'Summer',
  storm: 'Storm',
  stove: 'Stove',
  stream: 'Stream',
  deepSea: 'Deep sea',
  desert: 'Desert',
  chirp: 'Chirp',
  boiling: 'Boiling',
  musicBox: 'Music box',
  woodenFish: 'Wooden fish',
  streetTraffic: 'Street traffic',
};

function renderPomowaveStatus(raw) {
  let status;
  try {
    status = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return;
  }
  if (!status || typeof status !== 'object') return;

  const ids = {
    today: {
      focus: 'todayFocus',
      shortBreak: 'todayShortBreak',
      longBreak: 'todayLongBreak',
    },
    week: {
      focus: 'weekFocus',
      shortBreak: 'weekShortBreak',
      longBreak: 'weekLongBreak',
    },
  };
  for (const [period, phases] of Object.entries(ids)) {
    for (const [phase, prefix] of Object.entries(phases)) {
      document.getElementById(`${prefix}Completed`).textContent = String(
        Math.max(0, Number(status[period]?.[phase]?.completed) || 0),
      );
      document.getElementById(`${prefix}Cancelled`).textContent = String(
        Math.max(0, Number(status[period]?.[phase]?.cancelled) || 0),
      );
    }
  }

  const backgroundKey = String(status.backgroundSound || 'none');
  document.getElementById('currentBackgroundSound').textContent = $UD.t(
    POMOWAVE_BACKGROUND_LABELS[backgroundKey] || 'None',
  );
}

function syncPomowaveButtons() {
  const soundInput = document.getElementById('soundStyle');

  document.querySelectorAll('[data-sound-style]').forEach((button) => {
    const active = button.dataset.soundStyle === soundInput.value;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function syncPomowaveBackgroundVolume() {
  const value = document.getElementById('backgroundVolume').value || '0';
  document.getElementById('backgroundVolumeValue').textContent = value;
}

function initPomowaveInspector() {
  let currentContext = '';
  let uiBound = false;
  let lastStatus = null;

  function pushSettings() {
    $UD.sendParamFromPlugin(collectSettings(POMOWAVE_FIELDS), currentContext);
  }
  const autosave = debounce(pushSettings, AUTOSAVE_DEBOUNCE_MS);

  function commitSettings() {
    if (!autosave.flush()) {
      pushSettings();
    }
  }

  function bindUiOnce() {
    if (uiBound) {
      return;
    }
    uiBound = true;

    const form = document.getElementById('property-inspector');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      commitSettings();
      flashInspectorFeedback('saved');
    });

    form.addEventListener('input', () => {
      autosave();
    });

    bindThemeButtons(commitSettings);
    bindLanguageSelection(commitSettings, () => renderPomowaveStatus(lastStatus));

    document.querySelectorAll('[data-sound-style]').forEach((button) => {
      button.addEventListener('click', () => {
        const style = button.dataset.soundStyle || 'glass';
        document.getElementById('soundStyle').value = style;
        syncPomowaveButtons();
        commitSettings();
        // 点按即试听：让插件进程播放点选样式的系统提示音。
        $UD.sendParamFromPlugin({ previewSound: style }, currentContext);
      });
    });

    document.getElementById('previewBackgroundSound').addEventListener('click', () => {
      autosave.flush();
      $UD.sendParamFromPlugin({
        previewBackgroundSound: document.getElementById('backgroundSound').value,
      }, currentContext);
    });

    document.getElementById('stopPreviewBackgroundSound').addEventListener('click', () => {
      autosave.flush();
      $UD.sendParamFromPlugin({ stopPreviewBackgroundSound: 'true' }, currentContext);
    });

    document.getElementById('backgroundVolume').addEventListener('input', syncPomowaveBackgroundVolume);

    document.getElementById('resetTimer').addEventListener('click', () => {
      autosave.flush();
      $UD.sendParamFromPlugin({ resetTimer: 'true' }, currentContext);
    });

    document.getElementById('skipPhase').addEventListener('click', () => {
      autosave.flush();
      $UD.sendParamFromPlugin({ skipPhase: 'true' }, currentContext);
    });

    bindResetDefaults(() => {
      autosave.cancel();
      $UD.sendParamFromPlugin({ [RESET_DEFAULTS_PARAM]: 'true' }, currentContext);
    });
    window.addEventListener('pagehide', () => {
      autosave.flush();
      autosave.cancel();
    });
    syncPomowaveButtons();
    syncPomowaveBackgroundVolume();
  }

  $UD.connect('com.ulanzi.ulanzistudio.lexutility.pomowave');

  $UD.onConnected(() => {
    document.querySelector('.uspi-wrapper').classList.remove('hidden');
    bindUiOnce();
    $UD.sendParamFromPlugin({ [REQUEST_SETTINGS_PARAM]: 'true' }, currentContext);
    $UD.sendParamFromPlugin({ __requestPomodoroStatus: 'true' }, currentContext);
  });

  function apply(message) {
    currentContext = message.context || currentContext;
    const param = message.param || {};
    applySettings(POMOWAVE_FIELDS, param);
    syncPomowaveButtons();
    syncPomowaveBackgroundVolume();
    if (param.pomodoroStatus) lastStatus = param.pomodoroStatus;
    void afterLanguageSelection(() => renderPomowaveStatus(lastStatus));
  }

  $UD.onAdd(apply);
  $UD.onParamFromApp(apply);
  $UD.onParamFromPlugin(apply);
}

initPomowaveInspector();
