const SPEEDTEST_FIELDS = withLanguageField([
  'scope',
  'intervalMin',
  'activeAllDay',
  'activeStart',
  'activeEnd',
  'timeoutSec',
  'candidateServers',
  'chartType',
  'theme',
  'geoIpEnabled',
  'frameSize',
  'showFrame',
  'cliPath',
]);

// 只驱动本地筛选，不属于实例设置，不能触发自动保存。
const LOCAL_ONLY_INPUTS = ['serverSearch'];

function syncChartButtons() {
  const chartInput = document.getElementById('chartType');

  document.querySelectorAll('[data-chart-type]').forEach((button) => {
    const active = button.dataset.chartType === chartInput.value;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function initSpeedtestInspector() {
  let currentContext = '';
  let runtime = {};
  let uiBound = false;
  let serversRequested = false;

  function pushSettings() {
    $UD.sendParamFromPlugin(collectSettings(SPEEDTEST_FIELDS), currentContext);
  }
  const autosave = debounce(pushSettings, AUTOSAVE_DEBOUNCE_MS);

  function commitSettings() {
    if (!autosave.flush()) {
      pushSettings();
    }
  }

  function filteredServers() {
    const query = String(document.getElementById('serverSearch').value || '').toLowerCase();
    const scope = document.getElementById('scope').value;
    return (runtime.servers || []).filter((server) => {
      const country = String(server.country || '').toLowerCase();
      const mainland = String(server.countryCode || '').toUpperCase() === 'CN' || /^(china|中国|中国大陆|people'?s republic of china)$/i.test(country);
      // 与 plugin/actions/speedtest.js 的 speedtestCandidates 保持同一套判定。
      const inScope = scope === 'any' ? true : scope === 'mainland' ? mainland : !mainland;
      return inScope && JSON.stringify(server).toLowerCase().includes(query);
    });
  }

  // 节点清单为空时向插件要一次；插件侧 ensureServers 不 force，
  // 由 needsSpeedtestDiscovery + 退避决定是否真的去拉，这里只负责触发。
  // 拉到节点后解除标记，之后清单再次变空（比如换了区域）还能再要一次。
  function requestServersIfEmpty() {
    const empty = !(runtime.servers || []).length;
    if (empty && !serversRequested && currentContext) {
      serversRequested = true;
      $UD.sendParamFromPlugin({ ensureServers: 'true' }, currentContext);
    }
    if (!empty) {
      serversRequested = false;
    }
  }

  function readCandidates() {
    try {
      return JSON.parse(document.getElementById('candidateServers').value || '[]');
    } catch {
      return [];
    }
  }

  // 选择模式完全由勾选数量推导，没有单独的模式开关；
  // 这行文案要和 plugin/actions/speedtest.js 的 chooseSpeedtestServer 说的是同一件事。
  function renderSelectionSummary() {
    const count = readCandidates().length;
    document.getElementById('selectionSummary').textContent = count === 0
      ? $UD.t('No selection: choose daily from all servers in this region.')
      : count === 1
        ? $UD.t('One server selected: always use this server.')
        : $UD.t('%s servers selected: choose one daily.').replace('%s', String(count));
  }

  function renderServers() {
    const list = document.getElementById('serverList');
    if (!(runtime.servers || []).length) {
      list.innerHTML = `<div class="server">${$UD.t('Fetching servers… If this takes too long, select Refresh servers.')}</div>`;
      renderSelectionSummary();
      return;
    }
    const checkedIds = new Set(readCandidates().map((server) => String(server.id)));
    const candidates = filteredServers();
    list.innerHTML = candidates.length ? candidates.map((server) => {
      const official = `${server.city || $UD.t('Unknown city')} · ${server.country || server.countryCode || $UD.t('Unknown region')}`;
      const ipLocation = server.ip
        ? `<br>IP ${server.ip}${server.ipCity || server.ipCountry ? ` · ${server.ipCity || ''} ${server.ipCountry || server.ipCountryCode || ''}` : ''}`
        : `<br>${server.host || ''}`;
      const checked = checkedIds.has(String(server.id));
      return `<label class="server${checked ? ' checked' : ''}"><input type="checkbox" data-server-id="${server.id}"${checked ? ' checked' : ''}><span><b>#${server.id} ${server.name || server.city || $UD.t('Unknown')}</b><br>${$UD.t('Server')} ${official}${ipLocation}</span></label>`;
    }).join('') : `<div class="server">${$UD.t('No servers match this filter. Change the region or refresh the list.')}</div>`;
    renderSelectionSummary();
  }

  function renderRuntime() {
    const last = runtime.lastResult;
    const phaseLabels = {
      idle: 'Idle',
      queued: 'Queued',
      running: 'Running',
      discovering: 'Discovering servers',
      error: 'Error',
    };
    const status = runtime.autoPaused
      ? $UD.t('Automatic tests paused')
      : runtime.cliFound
        ? $UD.t(phaseLabels[runtime.phase] || runtime.phase || 'Idle')
      : $UD.t('Ookla CLI not found');
    const discovered = runtime.serverCacheUpdatedAt
      ? `<br>${$UD.t('Server catalog')} ${new Date(runtime.serverCacheUpdatedAt).toLocaleString()} · ${(runtime.servers || []).length} ${$UD.t('servers')}`
      : `<br>${$UD.t('Fetching server catalog…')}`;
    document.getElementById('runtime').innerHTML = `<strong>${status}</strong>${discovered}${last ? `<br>↓ ${Math.round(last.downloadMbps)} Mbps · ↑ ${Math.round(last.uploadMbps)} Mbps · ${Math.round(last.pingMs || 0)} ms<br>#${last.server?.id || '—'} ${last.server?.city || ''} ${last.server?.ip || ''}` : `<br>${$UD.t('No test results yet')}`}${runtime.errorCode ? `<br><span class="danger">${runtime.errorCode}</span>` : ''}`;
    renderServers();
    requestServersIfEmpty();
  }

  function toggleCandidate(server, checked) {
    const current = readCandidates().filter((item) => String(item.id) !== String(server.id));
    document.getElementById('candidateServers').value = JSON.stringify(
      checked ? [...current, server] : current,
    );
    renderSelectionSummary();
    commitSettings();
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

    form.addEventListener('input', (event) => {
      if (!LOCAL_ONLY_INPUTS.includes(event.target.id)) {
        autosave();
      }
    });

    bindThemeButtons(commitSettings);
    bindLanguageSelection(commitSettings, renderRuntime);

    document.querySelectorAll('[data-chart-type]').forEach((button) => {
      button.addEventListener('click', () => {
        document.getElementById('chartType').value = button.dataset.chartType || 'line';
        syncChartButtons();
        commitSettings();
      });
    });

    document.getElementById('serverSearch').addEventListener('input', renderServers);
    document.getElementById('scope').addEventListener('change', renderServers);
    document.getElementById('serverList').addEventListener('change', (event) => {
      const box = event.target.closest('[data-server-id]');
      if (!box) {
        return;
      }
      const server = (runtime.servers || []).find((item) => String(item.id) === box.dataset.serverId);
      if (server) {
        box.closest('.server')?.classList.toggle('checked', box.checked);
        toggleCandidate(server, box.checked);
      }
    });

    document.getElementById('refreshServers').addEventListener('click', () => {
      $UD.sendParamFromPlugin({ refreshServers: 'true' }, currentContext);
    });
    document.getElementById('testSelected').addEventListener('click', () => {
      $UD.sendParamFromPlugin({ testSelected: 'true' }, currentContext);
    });
    document.getElementById('clearHistory').addEventListener('click', () => {
      if (window.confirm($UD.t('Clear the test history for this action instance?'))) {
        $UD.sendParamFromPlugin({ clearSpeedtestHistory: 'true' }, currentContext);
      }
    });

    bindResetDefaults(() => {
      autosave.cancel();
      $UD.sendParamFromPlugin({ [RESET_DEFAULTS_PARAM]: 'true' }, currentContext);
    });
    window.addEventListener('pagehide', () => {
      autosave.flush();
      autosave.cancel();
    });
    syncChartButtons();
  }

  function apply(message) {
    currentContext = message.context || currentContext;
    const param = message.param || {};
    applySettings(SPEEDTEST_FIELDS, param);
    syncChartButtons();
    try {
      if (param.speedtestRuntime) {
        runtime = JSON.parse(param.speedtestRuntime);
      }
    } catch {}
    void afterLanguageSelection(renderRuntime);
  }

  $UD.connect('com.ulanzi.ulanzistudio.lexutility.speedtest');

  $UD.onConnected(() => {
    document.querySelector('.uspi-wrapper').classList.remove('hidden');
    bindUiOnce();
    $UD.sendParamFromPlugin({ [REQUEST_SETTINGS_PARAM]: 'true' }, currentContext);
  });

  $UD.onAdd(apply);
  $UD.onParamFromApp(apply);
  $UD.onParamFromPlugin(apply);
}

initSpeedtestInspector();
