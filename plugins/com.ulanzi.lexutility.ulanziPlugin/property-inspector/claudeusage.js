const CLAUDEUSAGE_FIELDS = withLanguageField([
  'pollSec',
  'redrawSec',
  'showWeekly',
  'showFiveHour',
  'showScoped',
  'showBarBackground',
  'severityColors',
  'usageUrl',
  'theme',
  'frameSize',
  'showFrame',
]);

// 控制命令，与设置提交分开发送：探测是副作用，不该混进设置写盘链路。
const CLAUDEUSAGE_PROBE_PARAM = '__claudeusageProbe';
const CLAUDEUSAGE_DIAG_PARAM = '__claudeusageDiag';

const DIAG_STATE_TEXT = {
  OK: 'OK',
  STALE: 'Stale (showing last values)',
  NO_TOKEN: 'No Keychain credential',
  AUTH: 'Credential expired',
  NETWORK: 'Network failure',
  RATE_LIMITED: 'Rate limited',
  PENDING: 'Not fetched yet',
  UNSUPPORTED: 'Unsupported platform',
};

const DIAG_ERROR_TEXT = {
  NO_TOKEN: 'No Claude Code credential in Keychain. Sign in from Terminal.',
  AUTH: 'The access token expired. Use Claude Code once to refresh it.',
  NETWORK: 'The request failed or the API response changed.',
  RATE_LIMITED: 'Requests are rate limited. Increase the polling interval.',
};

function formatDiagTime(value) {
  if (!Number.isFinite(value)) {
    return '—';
  }
  const date = new Date(value);
  const diffSec = Math.round((Date.now() - value) / 1000);
  const stamp = date.toLocaleTimeString();
  if (diffSec < 60) {
    return `${stamp} (${$UD.t('%ss ago').replace('%s', String(diffSec))})`;
  }
  if (diffSec < 3600) {
    return `${stamp} (${$UD.t('%sm ago').replace('%s', String(Math.round(diffSec / 60)))})`;
  }
  return `${stamp} (${$UD.t('%sh ago').replace('%s', String(Math.round(diffSec / 3600)))})`;
}

function setDiagField(id, text, tone) {
  const node = document.getElementById(id);
  if (!node) {
    return;
  }
  node.textContent = text;
  node.classList.toggle('good', tone === 'good');
  node.classList.toggle('bad', tone === 'bad');
}

function renderDiagnostics(diag) {
  if (!diag || typeof diag !== 'object') {
    return;
  }
  const mac = diag.platform === 'darwin';
  setDiagField('diag-platform', mac ? 'macOS' : `${diag.platform} (${$UD.t('unsupported')})`, mac ? 'good' : 'bad');
  setDiagField('diag-token', $UD.t(diag.hasToken ? 'Found' : 'Not found'), diag.hasToken ? 'good' : 'bad');

  const state = diag.displayState || 'PENDING';
  setDiagField(
    'diag-state',
    $UD.t(DIAG_STATE_TEXT[state] || state),
    state === 'OK' ? 'good' : state === 'STALE' || state === 'PENDING' ? '' : 'bad',
  );
  setDiagField('diag-fetched', formatDiagTime(diag.fetchedAt));
  setDiagField(
    'diag-error',
    diag.lastErrorKind ? $UD.t(DIAG_ERROR_TEXT[diag.lastErrorKind] || diag.lastErrorKind) : $UD.t('None'),
    diag.lastErrorKind ? 'bad' : 'good',
  );
}

function initClaudeUsageInspector() {
  let currentContext = '';
  let uiBound = false;
  let lastDiagnostics = null;

  function pushSettings() {
    $UD.sendParamFromPlugin(collectSettings(CLAUDEUSAGE_FIELDS), currentContext);
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
    bindLanguageSelection(commitSettings, () => renderDiagnostics(lastDiagnostics));

    document.getElementById('probe')?.addEventListener('click', () => {
      // 先 flush 待提交的设置，否则探测跑的是旧间隔/旧 URL。
      autosave.flush();
      $UD.sendParamFromPlugin({ [CLAUDEUSAGE_PROBE_PARAM]: 'true' }, currentContext);
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

  $UD.connect('com.ulanzi.ulanzistudio.lexutility.claudeusage');

  $UD.onConnected(() => {
    document.querySelector('.uspi-wrapper').classList.remove('hidden');
    bindUiOnce();
    $UD.sendParamFromPlugin({ [REQUEST_SETTINGS_PARAM]: 'true' }, currentContext);
  });

  function apply(message) {
    currentContext = message.context || currentContext;
    const param = message.param || {};
    applySettings(CLAUDEUSAGE_FIELDS, param);
    lastDiagnostics = param[CLAUDEUSAGE_DIAG_PARAM] || lastDiagnostics;
    void afterLanguageSelection(() => renderDiagnostics(lastDiagnostics));
  }

  $UD.onAdd(apply);
  $UD.onParamFromApp(apply);
  $UD.onParamFromPlugin(apply);
}

initClaudeUsageInspector();
