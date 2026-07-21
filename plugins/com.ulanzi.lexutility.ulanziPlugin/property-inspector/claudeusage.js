const CLAUDEUSAGE_FIELDS = [
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
];

// 控制命令，与设置提交分开发送：探测是副作用，不该混进设置写盘链路。
const CLAUDEUSAGE_PROBE_PARAM = '__claudeusageProbe';
const CLAUDEUSAGE_DIAG_PARAM = '__claudeusageDiag';

const DIAG_STATE_TEXT = {
  OK: '正常',
  STALE: '陈旧（保留上次数值）',
  NO_TOKEN: '钥匙串无凭据',
  AUTH: '凭据已过期',
  NETWORK: '网络失败',
  RATE_LIMITED: '被限流',
  PENDING: '尚未拉取',
  UNSUPPORTED: '当前平台不支持',
};

const DIAG_ERROR_TEXT = {
  NO_TOKEN: '钥匙串里没有 Claude Code 凭据，请在终端登录',
  AUTH: 'accessToken 已过期，用一次 Claude Code 即可刷新',
  NETWORK: '请求失败或接口结构变化',
  RATE_LIMITED: '请求过密被限流，请调大拉取间隔',
};

function formatDiagTime(value) {
  if (!Number.isFinite(value)) {
    return '—';
  }
  const date = new Date(value);
  const diffSec = Math.round((Date.now() - value) / 1000);
  const stamp = date.toLocaleTimeString();
  if (diffSec < 60) {
    return `${stamp}（${diffSec}s 前）`;
  }
  if (diffSec < 3600) {
    return `${stamp}（${Math.round(diffSec / 60)}m 前）`;
  }
  return `${stamp}（${Math.round(diffSec / 3600)}h 前）`;
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
  setDiagField('diag-platform', mac ? 'macOS' : `${diag.platform}（不支持）`, mac ? 'good' : 'bad');
  setDiagField('diag-token', diag.hasToken ? '已找到' : '未找到', diag.hasToken ? 'good' : 'bad');

  const state = diag.displayState || 'PENDING';
  setDiagField(
    'diag-state',
    DIAG_STATE_TEXT[state] || state,
    state === 'OK' ? 'good' : state === 'STALE' || state === 'PENDING' ? '' : 'bad',
  );
  setDiagField('diag-fetched', formatDiagTime(diag.fetchedAt));
  setDiagField(
    'diag-error',
    diag.lastErrorKind ? (DIAG_ERROR_TEXT[diag.lastErrorKind] || diag.lastErrorKind) : '无',
    diag.lastErrorKind ? 'bad' : 'good',
  );
}

function initClaudeUsageInspector() {
  let currentContext = '';
  let uiBound = false;

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
  });

  function apply(message) {
    currentContext = message.context || currentContext;
    const param = message.param || {};
    applySettings(CLAUDEUSAGE_FIELDS, param);
    renderDiagnostics(param[CLAUDEUSAGE_DIAG_PARAM]);
  }

  $UD.onAdd(apply);
  $UD.onParamFromApp(apply);
  $UD.onParamFromPlugin(apply);
}

initClaudeUsageInspector();
