const DEEPSEEKUSAGE_FIELDS = withLanguageField([
  'apiKey',
  'pollSec',
  'redrawSec',
  'budget24h',
  'budget7d',
  'balanceWarn',
  'balanceCrit',
  'usageUrl',
  'theme',
  'frameSize',
  'showFrame',
]);

// 控制命令，与设置提交分开发送：探测和清空历史都是副作用，不该混进设置写盘链路。
const DEEPSEEKUSAGE_PROBE_PARAM = '__deepseekusageProbe';
const DEEPSEEKUSAGE_CLEAR_PARAM = '__deepseekusageClearHistory';
const DEEPSEEKUSAGE_DIAG_PARAM = '__deepseekusageDiag';

// 清空历史不可撤销（差分记账没有备份），所以做成两段式：第一次点亮按钮并改文案，
// 第二次才真的发命令。窗口内不再点就自动解除，避免按钮长期停在"武装"状态。
const CLEAR_ARM_MS = 4000;

const DIAG_STATE_TEXT = {
  OK: 'OK',
  STALE: 'Stale (showing last values)',
  NO_KEY: 'No API key',
  AUTH: 'API key rejected',
  NETWORK: 'Network failure',
  RATE_LIMITED: 'Rate limited',
  PENDING: 'Not fetched yet',
};

const DIAG_ERROR_TEXT = {
  NO_KEY: 'Paste a DeepSeek API key above.',
  AUTH: 'DeepSeek rejected the key. Check it was not revoked.',
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
  setDiagField('diag-key', $UD.t(diag.hasKey ? 'Found' : 'Not found'), diag.hasKey ? 'good' : 'bad');

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
  setDiagField('diag-events', Number.isFinite(diag.events) ? String(diag.events) : '—');
  // 覆盖率是键面上那个 tail 的来源，两个窗口分别显示——只有它能解释"为什么 7d 偏低"。
  const coverage = Number.isFinite(diag.coverage24h) && Number.isFinite(diag.coverage7d)
    ? `24h ${diag.coverage24h}% · 7d ${diag.coverage7d}%`
    : '—';
  setDiagField('diag-coverage', coverage, diag.coverage7d === 100 ? 'good' : '');
}

function initDeepSeekUsageInspector() {
  let currentContext = '';
  let uiBound = false;
  let lastDiagnostics = null;
  let clearArmedAt = 0;

  function pushSettings() {
    $UD.sendParamFromPlugin(collectSettings(DEEPSEEKUSAGE_FIELDS), currentContext);
  }
  const autosave = debounce(pushSettings, AUTOSAVE_DEBOUNCE_MS);

  function commitSettings() {
    if (!autosave.flush()) {
      pushSettings();
    }
  }

  function disarmClear() {
    const button = document.getElementById('clearHistory');
    clearArmedAt = 0;
    if (button) {
      button.classList.remove('armed');
      button.textContent = $UD.t('Clear spend history');
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
    bindLanguageSelection(commitSettings, () => {
      renderDiagnostics(lastDiagnostics);
      disarmClear();
    });

    document.getElementById('probe')?.addEventListener('click', () => {
      // 先 flush 待提交的设置，否则探测跑的是旧 key / 旧间隔。
      autosave.flush();
      $UD.sendParamFromPlugin({ [DEEPSEEKUSAGE_PROBE_PARAM]: 'true' }, currentContext);
    });

    document.getElementById('clearHistory')?.addEventListener('click', (event) => {
      const button = event.currentTarget;
      const now = Date.now();
      if (!clearArmedAt || now - clearArmedAt > CLEAR_ARM_MS) {
        clearArmedAt = now;
        button.classList.add('armed');
        button.textContent = $UD.t('Click again to erase');
        setTimeout(disarmClear, CLEAR_ARM_MS);
        return;
      }
      disarmClear();
      $UD.sendParamFromPlugin({ [DEEPSEEKUSAGE_CLEAR_PARAM]: 'true' }, currentContext);
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

  $UD.connect('com.ulanzi.ulanzistudio.lexutility.deepseekusage');

  $UD.onConnected(() => {
    document.querySelector('.uspi-wrapper').classList.remove('hidden');
    bindUiOnce();
    $UD.sendParamFromPlugin({ [REQUEST_SETTINGS_PARAM]: 'true' }, currentContext);
  });

  function apply(message) {
    currentContext = message.context || currentContext;
    const param = message.param || {};
    applySettings(DEEPSEEKUSAGE_FIELDS, param);
    lastDiagnostics = param[DEEPSEEKUSAGE_DIAG_PARAM] || lastDiagnostics;
    void afterLanguageSelection(() => renderDiagnostics(lastDiagnostics));
  }

  $UD.onAdd(apply);
  $UD.onParamFromApp(apply);
  $UD.onParamFromPlugin(apply);
}

initDeepSeekUsageInspector();
