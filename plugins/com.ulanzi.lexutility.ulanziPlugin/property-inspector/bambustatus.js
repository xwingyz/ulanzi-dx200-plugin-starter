const BAMBUSTATUS_FIELDS = ['printerName', 'printerIp', 'serialNumber', 'accessCode', 'theme', 'frameSize', 'showFrame'];
const BAMBUSTATUS_DISCOVERY_FIELDS = ['printerName', 'printerIp', 'serialNumber', 'accessCode'];
const BAMBUSTATUS_SCAN_PARAM = '__bambustatusScan';
const BAMBUSTATUS_SCAN_RESULT_PARAM = '__bambustatusDiscovery';
const BAMBUSTATUS_DIAG_PARAM = '__bambustatusDiag';

function initBambuStatusInspector() {
  let currentContext = '';
  let uiBound = false;
  const autosave = debounce(() => {
    $UD.sendParamFromPlugin(collectSettings(BAMBUSTATUS_FIELDS), currentContext);
  }, AUTOSAVE_DEBOUNCE_MS);

  function commitSettings() {
    if (!autosave.flush()) {
      $UD.sendParamFromPlugin(collectSettings(BAMBUSTATUS_FIELDS), currentContext);
    }
  }

  function showScanStatus(text, kind = '') {
    const element = document.getElementById('scanStatus');
    element.textContent = text;
    element.className = `scan-status ${kind}`.trim();
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
    document.getElementById('scanPrinter').addEventListener('click', () => {
      showScanStatus('正在读取 Bambu Studio 配置并扫描局域网…');
      $UD.sendParamFromPlugin({
        [BAMBUSTATUS_SCAN_PARAM]: collectSettings(['printerName', 'printerIp', 'serialNumber', 'accessCode']),
      }, currentContext);
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

  function apply(message) {
    currentContext = message.context || currentContext;
    const param = message.param || {};
    const result = param[BAMBUSTATUS_SCAN_RESULT_PARAM];
    if (result) {
      applySettings(BAMBUSTATUS_DISCOVERY_FIELDS, result.settings || {});
      if (result.status === 'found') {
        showScanStatus(`已找到${result.model ? ` ${result.model}` : '打印机'}并自动保存，可继续修改。`, 'ok');
      } else if (result.status === 'partial') {
        showScanStatus('已保存发现的信息，请补齐其余配置。', 'warn');
      } else {
        showScanStatus('未发现可用打印机，请确认同一局域网或手动填写。', 'warn');
      }
      return;
    }
    const diagnostic = param[BAMBUSTATUS_DIAG_PARAM];
    if (diagnostic) {
      showScanStatus(
        diagnostic.message || '状态已更新',
        diagnostic.state === 'online' ? 'ok' : 'warn',
      );
      return;
    }
    applySettings(BAMBUSTATUS_FIELDS, param);
  }

  $UD.connect('com.ulanzi.ulanzistudio.lexutility.bambustatus');
  $UD.onConnected(() => {
    document.querySelector('.uspi-wrapper').classList.remove('hidden');
    bindUiOnce();
    $UD.sendParamFromPlugin({ [REQUEST_SETTINGS_PARAM]: 'true' }, currentContext);
  });
  $UD.onAdd(apply);
  $UD.onParamFromApp(apply);
  $UD.onParamFromPlugin(apply);
}

initBambuStatusInspector();
