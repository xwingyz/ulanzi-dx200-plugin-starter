const SPEEDTEST_FIELDS = ['scope','intervalMin','activeAllDay','activeStart','activeEnd','timeoutSec','selectionMode','fixedServerId','candidateServers','chartType','theme','geoIpEnabled','frameSize','showFrame','cliPath'];

function initSpeedtestInspector() {
  let currentContext = '';
  let runtime = {};
  let uiBound = false;
  const push = () => $UD.sendParamFromPlugin(collectSettings(SPEEDTEST_FIELDS), currentContext);
  const autosave = debounce(push, AUTOSAVE_DEBOUNCE_MS);
  const commit = () => { if (!autosave.flush()) push(); };

  function filteredServers() {
    const query = String(document.getElementById('serverSearch').value || '').toLowerCase();
    const scope = document.getElementById('scope').value;
    return (runtime.servers || []).filter((server) => {
      const country = String(server.country || '').toLowerCase();
      const mainland = String(server.countryCode || '').toUpperCase() === 'CN' || /^(china|中国|中国大陆|people'?s republic of china)$/i.test(country);
      const inScope = scope === 'mainland' ? mainland : !mainland;
      return inScope && JSON.stringify(server).toLowerCase().includes(query);
    });
  }

  function renderServers() {
    const list = document.getElementById('serverList');
    const candidates = filteredServers();
    list.innerHTML = candidates.length ? candidates.map((server) => {
      const official = `${server.city || '未知城市'} · ${server.country || server.countryCode || '未知地区'}`;
      const ipLocation = server.ip
        ? `<br>IP ${server.ip}${server.ipCity || server.ipCountry ? ` · ${server.ipCity || ''} ${server.ipCountry || server.ipCountryCode || ''}` : ''}`
        : `<br>${server.host || ''}`;
      return `<button class="server" type="button" data-server-id="${server.id}"><b>#${server.id} ${server.name || server.city || 'Unknown'}</b><br>节点 ${official}${ipLocation}</button>`;
    }).join('') : '<div class="server">当前筛选没有节点；可重新获取或手动输入 Server ID。</div>';
  }

  function renderRuntime() {
    const last = runtime.lastResult;
    const status = runtime.cliFound ? (runtime.phase || 'idle') : '未找到 Ookla CLI';
    const discovered = runtime.serverCacheUpdatedAt
      ? `<br>节点库 ${new Date(runtime.serverCacheUpdatedAt).toLocaleString()} · ${(runtime.servers || []).length} 个`
      : '<br>节点库正在自动获取…';
    document.getElementById('runtime').innerHTML = `<strong>${status}</strong>${discovered}${last ? `<br>↓ ${Math.round(last.downloadMbps)} Mbps · ↑ ${Math.round(last.uploadMbps)} Mbps · ${Math.round(last.pingMs || 0)} ms<br>#${last.server?.id || '—'} ${last.server?.city || ''} ${last.server?.ip || ''}` : '<br>暂无测速结果'}${runtime.errorCode ? `<br><span class="danger">${runtime.errorCode}</span>` : ''}`;
    const recent = (runtime.history || []).slice(-8).reverse();
    document.getElementById('recentDetails').innerHTML = recent.length
      ? recent.map((entry) => `<div class="server">${new Date(entry.at).toLocaleString()} · ${entry.ok ? `↓ ${Math.round(entry.downloadMbps)} / ↑ ${Math.round(entry.uploadMbps)} Mbps · ${Math.round(entry.pingMs || 0)} ms` : `<span class="danger">${entry.errorCode || 'NET'}</span>`}</div>`).join('')
      : '';
    renderServers();
  }

  function bindOnce() {
    if (uiBound) return; uiBound = true;
    const form = document.getElementById('property-inspector');
    form.addEventListener('submit', (event) => { event.preventDefault(); commit(); flashInspectorFeedback('saved'); });
    form.addEventListener('input', (event) => { if (!['serverSearch','manualServerId'].includes(event.target.id)) autosave(); });
    document.getElementById('serverSearch').addEventListener('input', renderServers);
    document.getElementById('scope').addEventListener('change', renderServers);
    document.getElementById('serverList').addEventListener('click', (event) => {
      const button = event.target.closest('[data-server-id]'); if (!button) return;
      const server = (runtime.servers || []).find((item) => String(item.id) === button.dataset.serverId); if (!server) return;
      const current = (() => { try { return JSON.parse(document.getElementById('candidateServers').value || '[]'); } catch { return []; } })();
      const exists = current.some((item) => String(item.id) === String(server.id));
      document.getElementById('candidateServers').value = JSON.stringify(exists ? current.filter((item) => String(item.id) !== String(server.id)) : [...current, server]);
      document.getElementById('fixedServerId').value = String(server.id);
      commit();
    });
    document.getElementById('refreshServers').addEventListener('click', () => $UD.sendParamFromPlugin({ refreshServers:'true' }, currentContext));
    document.getElementById('testSelected').addEventListener('click', () => $UD.sendParamFromPlugin({ testSelected:'true' }, currentContext));
    document.getElementById('verifyServer').addEventListener('click', () => { const id=document.getElementById('manualServerId').value; if (id) $UD.sendParamFromPlugin({ verifyServerId:id }, currentContext); });
    document.getElementById('clearHistory').addEventListener('click', () => { if (window.confirm('清除该实例的测速历史？')) $UD.sendParamFromPlugin({ clearSpeedtestHistory:'true' }, currentContext); });
    bindResetDefaults(() => { autosave.cancel(); $UD.sendParamFromPlugin({ [RESET_DEFAULTS_PARAM]:'true' }, currentContext); });
    window.addEventListener('pagehide', () => { autosave.flush(); autosave.cancel(); });
  }

  function apply(message) {
    currentContext = message.context || currentContext;
    const param = message.param || {};
    applySettings(SPEEDTEST_FIELDS, param);
    try { if (param.speedtestRuntime) runtime = JSON.parse(param.speedtestRuntime); } catch {}
    renderRuntime();
  }

  $UD.connect('com.ulanzi.ulanzistudio.lexutility.speedtest');
  $UD.onConnected(() => { document.querySelector('.uspi-wrapper').classList.remove('hidden'); bindOnce(); });
  $UD.onAdd(apply); $UD.onParamFromApp(apply); $UD.onParamFromPlugin(apply);
}

initSpeedtestInspector();
