const CHATGPTUSAGE_FIELDS = [
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
];

// 控制命令，与设置提交分开发送：探测是副作用，不该混进设置写盘链路。
const CHATGPTUSAGE_PROBE_PARAM = '__chatgptusageProbe';
const CHATGPTUSAGE_DIAG_PARAM = '__chatgptusageDiag';

const CHATGPT_DIAG_STATE_TEXT = {
  OK: '正常',
  STALE: '陈旧（保留上次数值）',
  NO_CLI: '找不到 codex 可执行文件',
  NOT_LOGGED_IN: '未登录',
  TIMEOUT: 'app-server 超时',
  RPC_ERROR: '接口调用失败',
  PENDING: '尚未拉取',
};

const CHATGPT_DIAG_ERROR_TEXT = {
  NO_CLI: '请安装 Codex CLI，或在上方填写绝对路径',
  NOT_LOGGED_IN: '请在终端运行 codex login',
  TIMEOUT: 'app-server 未在超时内返回，可调大 Timeout',
  RPC_ERROR: '调用返回错误或结构无法解析（app-server 是实验接口，可能已变更）',
};

function formatChatGptDiagTime(value) {
  if (!Number.isFinite(value)) {
    return '—';
  }
  const stamp = new Date(value).toLocaleTimeString();
  const diffSec = Math.round((Date.now() - value) / 1000);
  if (diffSec < 60) {
    return `${stamp}（${diffSec}s 前）`;
  }
  if (diffSec < 3600) {
    return `${stamp}（${Math.round(diffSec / 60)}m 前）`;
  }
  return `${stamp}（${Math.round(diffSec / 3600)}h 前）`;
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
    diag.codexPath || '未找到',
    diag.codexPath ? 'good' : 'bad',
  );
  setChatGptDiagField('diag-login', diag.loggedIn ? '已登录' : '未登录', diag.loggedIn ? 'good' : 'bad');
  setChatGptDiagField('diag-plan', diag.planType || '—');

  const state = diag.displayState || 'PENDING';
  setChatGptDiagField(
    'diag-state',
    CHATGPT_DIAG_STATE_TEXT[state] || state,
    state === 'OK' ? 'good' : state === 'STALE' || state === 'PENDING' ? '' : 'bad',
  );
  setChatGptDiagField('diag-fetched', formatChatGptDiagTime(diag.fetchedAt));
  setChatGptDiagField(
    'diag-error',
    diag.lastErrorKind ? (CHATGPT_DIAG_ERROR_TEXT[diag.lastErrorKind] || diag.lastErrorKind) : '无',
    diag.lastErrorKind ? 'bad' : 'good',
  );
}

function initChatGptUsageInspector() {
  let currentContext = '';
  let uiBound = false;

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
  });

  function apply(message) {
    currentContext = message.context || currentContext;
    const param = message.param || {};
    applySettings(CHATGPTUSAGE_FIELDS, param);
    renderChatGptDiagnostics(param[CHATGPTUSAGE_DIAG_PARAM]);
  }

  $UD.onAdd(apply);
  $UD.onParamFromApp(apply);
  $UD.onParamFromPlugin(apply);
}

initChatGptUsageInspector();
