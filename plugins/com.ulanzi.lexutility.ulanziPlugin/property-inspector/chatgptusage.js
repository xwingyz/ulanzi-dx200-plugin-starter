const CHATGPTUSAGE_FIELDS = withLanguageField([
  'codexCommand',
  'limitId',
  'pollSec',
  'redrawSec',
  'timeoutSec',
  'showSecondary',
  'showResetCredits',
  'showBarBackground',
  'severityColors',
  'usageUrl',
  'theme',
  'frameSize',
  'showFrame',
]);

// 控制命令，与设置提交分开发送：探测是副作用，不该混进设置写盘链路。
const CHATGPTUSAGE_PROBE_PARAM = '__chatgptusageProbe';
const CHATGPTUSAGE_DIAG_PARAM = '__chatgptusageDiag';

const CHATGPT_DIAG_STATE_TEXT = {
  OK: 'OK',
  STALE: 'Stale (showing last values)',
  NO_CLI: 'Codex executable not found',
  NOT_LOGGED_IN: 'Not signed in',
  TIMEOUT: 'App server timed out',
  RPC_ERROR: 'API call failed',
  PENDING: 'Not fetched yet',
};

const CHATGPT_DIAG_ERROR_TEXT = {
  NO_CLI: 'Install Codex CLI or enter its absolute path above.',
  NOT_LOGGED_IN: 'Run codex login in Terminal.',
  TIMEOUT: 'The app server did not respond in time. Increase Timeout.',
  RPC_ERROR: 'The API returned an error or an unrecognized response.',
};

function formatChatGptDiagTime(value) {
  if (!Number.isFinite(value)) {
    return '—';
  }
  const stamp = new Date(value).toLocaleTimeString();
  const diffSec = Math.round((Date.now() - value) / 1000);
  if (diffSec < 60) {
    return `${stamp} (${$UD.t('%ss ago').replace('%s', String(diffSec))})`;
  }
  if (diffSec < 3600) {
    return `${stamp} (${$UD.t('%sm ago').replace('%s', String(Math.round(diffSec / 60)))})`;
  }
  return `${stamp} (${$UD.t('%sh ago').replace('%s', String(Math.round(diffSec / 3600)))})`;
}

function setChatGptDiagField(id, text, tone) {
  const node = document.getElementById(id);
  if (!node) {
    return;
  }
  node.textContent = text;
  node.classList.toggle('good', tone === 'good');
  node.classList.toggle('bad', tone === 'bad');
}

function renderChatGptDiagnostics(diag) {
  if (!diag || typeof diag !== 'object') {
    return;
  }
  setChatGptDiagField('diag-platform', diag.platform || '—');
  setChatGptDiagField(
    'diag-path',
    diag.codexPath || $UD.t('Not found'),
    diag.codexPath ? 'good' : 'bad',
  );
  setChatGptDiagField('diag-login', $UD.t(diag.loggedIn ? 'Signed in' : 'Not signed in'), diag.loggedIn ? 'good' : 'bad');
  setChatGptDiagField('diag-plan', diag.planType || '—');

  const state = diag.displayState || 'PENDING';
  setChatGptDiagField(
    'diag-state',
    $UD.t(CHATGPT_DIAG_STATE_TEXT[state] || state),
    state === 'OK' ? 'good' : state === 'STALE' || state === 'PENDING' ? '' : 'bad',
  );
  setChatGptDiagField('diag-fetched', formatChatGptDiagTime(diag.fetchedAt));
  setChatGptDiagField(
    'diag-error',
    diag.lastErrorKind ? $UD.t(CHATGPT_DIAG_ERROR_TEXT[diag.lastErrorKind] || diag.lastErrorKind) : $UD.t('None'),
    diag.lastErrorKind ? 'bad' : 'good',
  );
}

function initChatGptUsageInspector() {
  let currentContext = '';
  let uiBound = false;
  let lastDiagnostics = null;

  function pushSettings() {
    $UD.sendParamFromPlugin(collectSettings(CHATGPTUSAGE_FIELDS), currentContext);
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
    bindLanguageSelection(commitSettings, () => renderChatGptDiagnostics(lastDiagnostics));

    document.getElementById('probe')?.addEventListener('click', () => {
      // 先 flush 待提交的设置，否则探测跑的是旧路径/旧超时。
      autosave.flush();
      $UD.sendParamFromPlugin({ [CHATGPTUSAGE_PROBE_PARAM]: 'true' }, currentContext);
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

  $UD.connect('com.ulanzi.ulanzistudio.lexutility.chatgptusage');

  $UD.onConnected(() => {
    document.querySelector('.uspi-wrapper').classList.remove('hidden');
    bindUiOnce();
    $UD.sendParamFromPlugin({ [REQUEST_SETTINGS_PARAM]: 'true' }, currentContext);
  });

  function apply(message) {
    currentContext = message.context || currentContext;
    const param = message.param || {};
    applySettings(CHATGPTUSAGE_FIELDS, param);
    lastDiagnostics = param[CHATGPTUSAGE_DIAG_PARAM] || lastDiagnostics;
    void afterLanguageSelection(() => renderChatGptDiagnostics(lastDiagnostics));
  }

  $UD.onAdd(apply);
  $UD.onParamFromApp(apply);
  $UD.onParamFromPlugin(apply);
}

initChatGptUsageInspector();
