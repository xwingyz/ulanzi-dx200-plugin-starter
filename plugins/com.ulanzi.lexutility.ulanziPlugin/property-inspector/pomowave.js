const POMOWAVE_FIELDS = [
  'focusMin',
  'shortBreakMin',
  'longBreakMin',
  'roundsBeforeLongBreak',
  'color',
  'theme',
  'backgroundStyle',
  'soundStyle',
  'soundEnabled',
  'autoStartBreaks',
  'autoStartFocus',
];

function syncPomowaveButtons() {
  const backgroundInput = document.getElementById('backgroundStyle');
  const soundInput = document.getElementById('soundStyle');

  document.querySelectorAll('[data-bg-style]').forEach((button) => {
    const active = button.dataset.bgStyle === backgroundInput.value;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });

  document.querySelectorAll('[data-sound-style]').forEach((button) => {
    const active = button.dataset.soundStyle === soundInput.value;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
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
    });

    form.addEventListener('input', () => {
      autosave();
    });

    bindThemeButtons(commitSettings);

    document.querySelectorAll('[data-bg-style]').forEach((button) => {
      button.addEventListener('click', () => {
        document.getElementById('backgroundStyle').value = button.dataset.bgStyle || 'gradient';
        syncPomowaveButtons();
        commitSettings();
      });
    });

    document.querySelectorAll('[data-sound-style]').forEach((button) => {
      button.addEventListener('click', () => {
        document.getElementById('soundStyle').value = button.dataset.soundStyle || 'glass';
        syncPomowaveButtons();
        commitSettings();
      });
    });

    document.getElementById('resetTimer').addEventListener('click', () => {
      autosave.flush();
      $UD.sendParamFromPlugin({ resetTimer: 'true' }, currentContext);
    });

    window.addEventListener('pagehide', () => {
      autosave.flush();
      autosave.cancel();
    });
    syncPomowaveButtons();
  }

  $UD.connect('com.ulanzi.ulanzistudio.lexutility.pomowave');

  $UD.onConnected(() => {
    document.querySelector('.uspi-wrapper').classList.remove('hidden');
    bindUiOnce();
  });

  function apply(message) {
    currentContext = message.context || currentContext;
    applySettings(POMOWAVE_FIELDS, message.param || {});
    syncPomowaveButtons();
  }

  $UD.onAdd(apply);
  $UD.onParamFromApp(apply);
  $UD.onParamFromPlugin(apply);
}

initPomowaveInspector();
