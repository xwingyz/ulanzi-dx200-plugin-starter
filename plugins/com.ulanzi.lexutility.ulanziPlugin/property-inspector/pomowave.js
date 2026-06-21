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

  function pushSettings() {
    $UD.sendParamFromPlugin(collectSettings(POMOWAVE_FIELDS), currentContext);
  }

  $UD.connect('com.ulanzi.ulanzistudio.lexutility.pomowave');

  $UD.onConnected(() => {
    document.querySelector('.uspi-wrapper').classList.remove('hidden');

    const form = document.getElementById('property-inspector');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      pushSettings();
    });

    form.addEventListener('input', () => {
      pushSettings();
    });

    bindThemeButtons(pushSettings);

    document.querySelectorAll('[data-bg-style]').forEach((button) => {
      button.addEventListener('click', () => {
        document.getElementById('backgroundStyle').value = button.dataset.bgStyle || 'gradient';
        syncPomowaveButtons();
        pushSettings();
      });
    });

    document.querySelectorAll('[data-sound-style]').forEach((button) => {
      button.addEventListener('click', () => {
        document.getElementById('soundStyle').value = button.dataset.soundStyle || 'glass';
        syncPomowaveButtons();
        pushSettings();
      });
    });

    document.getElementById('resetTimer').addEventListener('click', () => {
      $UD.sendParamFromPlugin({ resetTimer: 'true' }, currentContext);
    });

    syncPomowaveButtons();
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
