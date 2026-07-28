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
    bindLanguageSelection(commitSettings);

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
  });

  function apply(message) {
    currentContext = message.context || currentContext;
    applySettings(POMOWAVE_FIELDS, message.param || {});
    syncPomowaveButtons();
    syncPomowaveBackgroundVolume();
    void applyLanguageSelection();
  }

  $UD.onAdd(apply);
  $UD.onParamFromApp(apply);
  $UD.onParamFromPlugin(apply);
}

initPomowaveInspector();
