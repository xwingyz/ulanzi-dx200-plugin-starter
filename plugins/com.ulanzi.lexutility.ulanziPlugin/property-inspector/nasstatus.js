const NASSTATUS_FIELDS = ['displayName', 'nasHost', 'nasPort', 'useHttps', 'username', 'password', 'volumeId', 'volumeId2', 'tempChart', 'pollSec', 'theme', 'frameSize', 'showFrame'];
const NASSTATUS_VOLUME_SELECTS = ['volumeId', 'volumeId2'];
const NASSTATUS_PROBE_PARAM = '__nasstatusProbe';
const NASSTATUS_PROBE_RESULT_PARAM = '__nasstatusProbeResult';

function initNasStatusInspector() {
  let currentContext = '';
  let uiBound = false;
  const autosave = debounce(() => {
    $UD.sendParamFromPlugin(collectSettings(NASSTATUS_FIELDS), currentContext);
  }, AUTOSAVE_DEBOUNCE_MS);

  function commitSettings() {
    if (!autosave.flush()) {
      $UD.sendParamFromPlugin(collectSettings(NASSTATUS_FIELDS), currentContext);
    }
  }

  function showProbeStatus(text, kind = '') {
    const element = document.getElementById('probeStatus');
    element.textContent = text;
    element.className = `probe-status ${kind}`.trim();
  }

  // 卷下拉的选项来自测试连接的回推；恢复设置时若持久化的卷 id 尚无对应
  // 选项（还没测试过连接），补一个占位项，避免 select 静默回落到默认值。
  function ensureVolumeOption(selectId, value, label) {
    const select = document.getElementById(selectId);
    if (!value || [...select.options].some((option) => option.value === value)) {
      return;
    }
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label || value;
    select.appendChild(option);
  }

  function fillVolumeOptions(volumes) {
    NASSTATUS_VOLUME_SELECTS.forEach((selectId) => {
      const select = document.getElementById(selectId);
      const current = select.value;
      while (select.options.length > 1) {
        select.remove(1);
      }
      volumes.forEach((volume) => {
        if (!volume || typeof volume.id !== 'string') return;
        const option = document.createElement('option');
        option.value = volume.id;
        option.textContent = volume.label || volume.id;
        select.appendChild(option);
      });
      ensureVolumeOption(selectId, current);
      select.value = current;
      if (select.value !== current) {
        select.value = '';
      }
    });
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
    document.getElementById('probeNas').addEventListener('click', () => {
      showProbeStatus('正在连接 NAS…');
      $UD.sendParamFromPlugin({
        [NASSTATUS_PROBE_PARAM]: collectSettings(['nasHost', 'nasPort', 'useHttps', 'username', 'password']),
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
    const result = param[NASSTATUS_PROBE_RESULT_PARAM];
    if (result) {
      if (result.status === 'ok') {
        fillVolumeOptions(Array.isArray(result.volumes) ? result.volumes : []);
        showProbeStatus(result.message || '连接成功。', 'ok');
      } else {
        showProbeStatus(result.message || '连接失败，请检查配置。', 'warn');
      }
      return;
    }
    if (typeof param.volumeId === 'string') {
      ensureVolumeOption('volumeId', param.volumeId);
    }
    if (typeof param.volumeId2 === 'string') {
      ensureVolumeOption('volumeId2', param.volumeId2);
    }
    applySettings(NASSTATUS_FIELDS, param);
  }

  $UD.connect('com.ulanzi.ulanzistudio.lexutility.nasstatus');
  $UD.onConnected(() => {
    document.querySelector('.uspi-wrapper').classList.remove('hidden');
    bindUiOnce();
    $UD.sendParamFromPlugin({ [REQUEST_SETTINGS_PARAM]: 'true' }, currentContext);
  });
  $UD.onAdd(apply);
  $UD.onParamFromApp(apply);
  $UD.onParamFromPlugin(apply);
}

initNasStatusInspector();
