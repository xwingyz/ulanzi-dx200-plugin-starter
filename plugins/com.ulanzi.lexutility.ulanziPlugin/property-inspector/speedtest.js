const SPEEDTEST_FIELDS = [
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
];

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
      ? '不勾选：在当前区域的全部节点里每日随机。'
      : count === 1
        ? '已勾选 1 个：固定使用该节点。'
        : `已勾选 ${count} 个：每天在这些节点里随机选一个。`;
  }

  function renderServers() {
    const list = document.getElementById('serverList');
    if (!(runtime.servers || []).length) {
      list.innerHTML = '<div class="server">正在获取节点…如果长时间没有结果，可点「重新获取节点」。</div>';
      renderSelectionSummary();
      return;
    }
    const checkedIds = new Set(readCandidates().map((server) => String(server.id)));
    const candidates = filteredServers();
    list.innerHTML = candidates.length ? candidates.map((server) => {
      const official = `${server.city || '未知城市'} · ${server.country || server.countryCode || '未知地区'}`;
      const ipLocation = server.ip
        ? `<br>IP ${server.ip}${server.ipCity || server.ipCountry ? ` · ${server.ipCity || ''} ${server.ipCountry || server.ipCountryCode || ''}` : ''}`
        : `<br>${server.host || ''}`;
      const checked = checkedIds.has(String(server.id));
      return `<label class="server${checked ? ' checked' : ''}"><input type="checkbox" data-server-id="${server.id}"${checked ? ' checked' : ''}><span><b>#${server.id} ${server.name || server.city || 'Unknown'}</b><br>节点 ${official}${ipLocation}</span></label>`;
    }).join('') : '<div class="server">当前筛选没有节点；可换个区域或重新获取。</div>';
    renderSelectionSummary();
  }

  function renderRuntime() {
    const last = runtime.lastResult;
    const status = runtime.cliFound ? (runtime.phase || 'idle') : '未找到 Ookla CLI';
    const discovered = runtime.serverCacheUpdatedAt
      ? `<br>节点库 ${new Date(runtime.serverCacheUpdatedAt).toLocaleString()} · ${(runtime.servers || []).length} 个`
      : '<br>节点库正在自动获取…';
    document.getElementById('runtime').innerHTML = `<strong>${status}</strong>${discovered}${last ? `<br>↓ ${Math.round(last.downloadMbps)} Mbps · ↑ ${Math.round(last.uploadMbps)} Mbps · ${Math.round(last.pingMs || 0)} ms<br>#${last.server?.id || '—'} ${last.server?.city || ''} ${last.server?.ip || ''}` : '<br>暂无测速结果'}${runtime.errorCode ? `<br><span class="danger">${runtime.errorCode}</span>` : ''}`;
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
      if (window.confirm('清除该实例的测速历史？')) {
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
    renderRuntime();
  }

  $UD.connect('com.ulanzi.ulanzistudio.lexutility.speedtest');

  $UD.onConnected(() => {
    document.querySelector('.uspi-wrapper').classList.remove('hidden');
    bindUiOnce();
  });

  $UD.onAdd(apply);
  $UD.onParamFromApp(apply);
  $UD.onParamFromPlugin(apply);
}

initSpeedtestInspector();
