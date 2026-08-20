// 书房射灯：单击调用 Home Assistant light.toggle，乐观翻转图标后用轮询校正真实状态。
// entity_id 是这次唯一的示例场景，直接写死；要控制第二盏灯时再决定复制新 action
// 还是把 entity_id 升级成可配置项（见仓库 AGENTS.md「先做实一个场景」的取舍）。
const ENTITY_ID = 'light.mijia_cn_group_1749469573210054656_group3_s_2_light';

const STATE_VERSION = 1;
const POLL_INTERVAL_MS = 5_000;
// 失败退避：与 nasstatus.js 一致，60s 起步、120s 封顶；成功后回到 POLL_INTERVAL_MS。
const BACKOFF_DELAYS_MS = [60_000, 120_000];
// HA 执行 light.toggle 后状态还没落定就轮询会读到旧值；本地链路延迟通常 <1s
// （见仓库 README「首期验收」），留够余量再校正。
const RECONCILE_DELAY_MS = 900;
const POLL_TIMER_SLOT = 'studylightPoll';

function backoffDelay(attempt) {
  const index = Math.min(Math.max(attempt, 1) - 1, BACKOFF_DELAYS_MS.length - 1);
  return BACKOFF_DELAYS_MS[index];
}

function haStateToLightState(value) {
  if (value === 'on' || value === 'off') {
    return value;
  }
  return 'unknown';
}

export function createStudyLightAction(runtime) {
  const {
    clearInstanceTimeout,
    escapeXml,
    frameFor,
    ha,
    readPersistedState,
    renderInstance,
    renderScreenFrame,
    setInstanceTimeout,
    t,
    themeFor,
    toDataUrl,
    writePersistedState,
  } = runtime;

  // ---------------------------------------------------------------- 运行态持久化

  function serializeState(instance) {
    return { v: STATE_VERSION, lightState: instance.lightState, lastSeenAt: instance.lastSeenAt ?? null };
  }

  function hydrateState(raw) {
    const valid = raw && typeof raw === 'object' && raw.v === STATE_VERSION;
    return {
      lightState: valid && (raw.lightState === 'on' || raw.lightState === 'off') ? raw.lightState : 'unknown',
      lastSeenAt: valid && Number.isFinite(raw.lastSeenAt) ? raw.lastSeenAt : null,
    };
  }

  function flushState(instance) {
    return writePersistedState(instance.context, serializeState(instance));
  }

  // ---------------------------------------------------------------- 轮询

  function isInstanceCurrent(instance, requestId) {
    return requestId === instance.requestId;
  }

  function scheduleNextPoll(instance) {
    const delay = instance.connectionState === 'ONLINE'
      ? POLL_INTERVAL_MS
      : backoffDelay(instance.failureCount);
    setInstanceTimeout(instance, POLL_TIMER_SLOT, () => runPoll(instance), delay);
  }

  function applyPollResult(instance, result, now = Date.now()) {
    if (!ha.configured) {
      instance.connectionState = 'CONFIG_REQUIRED';
      instance.errorKind = null;
      return;
    }
    if (result.ok) {
      instance.connectionState = 'ONLINE';
      instance.errorKind = null;
      instance.failureCount = 0;
      instance.lightState = haStateToLightState(result.json?.state);
      instance.lastSeenAt = now;
      return;
    }
    instance.failureCount += 1;
    instance.connectionState = result.kind === 'CONFIG' ? 'CONFIG_REQUIRED' : 'OFFLINE';
    instance.errorKind = result.kind;
  }

  async function runPoll(instance, options = {}) {
    if (!instance || instance.fetching) return;
    instance.fetching = true;
    instance.requestId += 1;
    const requestId = instance.requestId;

    const result = await (options.getState ?? ha.getState)(ENTITY_ID);

    if (!isInstanceCurrent(instance, requestId)) {
      instance.fetching = false;
      return;
    }
    instance.fetching = false;
    applyPollResult(instance, result);
    flushState(instance);
    renderInstance(instance);
    scheduleNextPoll(instance);
  }

  // ---------------------------------------------------------------- 交互

  async function handleToggle(instance, options = {}) {
    if (!ha.configured) {
      instance.connectionState = 'CONFIG_REQUIRED';
      renderInstance(instance);
      return;
    }
    if (instance.toggling) return;
    instance.toggling = true;
    // 乐观翻转：不等接口响应先给用户即时反馈；未知状态时先假定要点亮。
    instance.lightState = instance.lightState === 'on' ? 'off' : 'on';
    renderInstance(instance);
    clearInstanceTimeout(instance, POLL_TIMER_SLOT);

    const result = await (options.callService ?? ha.callService)('light', 'toggle', ENTITY_ID);
    instance.toggling = false;

    if (!result.ok) {
      instance.failureCount += 1;
      instance.connectionState = result.kind === 'CONFIG' ? 'CONFIG_REQUIRED' : 'OFFLINE';
      instance.errorKind = result.kind;
      renderInstance(instance);
      scheduleNextPoll(instance);
      return;
    }
    // 服务调用成功不代表已经拿到权威新状态，短延迟后轮询一次校正。
    setInstanceTimeout(instance, POLL_TIMER_SLOT, () => runPoll(instance), RECONCILE_DELAY_MS);
  }

  // ---------------------------------------------------------------- 渲染

  const BULB_CENTER = { x: 128, y: 90 };
  const BULB_RADIUS = 30;

  function viewFor(instance) {
    if (instance.connectionState === 'CONFIG_REQUIRED') {
      return { mode: 'config', word: t('SETUP'), hint: t('config/local.json missing') };
    }
    if (instance.connectionState === 'OFFLINE') {
      const hintKey = instance.errorKind === 'AUTH' ? 'ha token invalid'
        : instance.errorKind === 'NETWORK' ? 'ha unreachable'
          : 'ha error';
      return { mode: 'offline', word: t('OFFLINE'), hint: t(hintKey) };
    }
    if (instance.lightState === 'on') {
      return { mode: 'on', word: t('ON'), hint: '' };
    }
    if (instance.lightState === 'off') {
      return { mode: 'off', word: t('OFF'), hint: '' };
    }
    return { mode: 'pending', word: t('SYNC'), hint: '' };
  }

  function colorFor(theme, mode) {
    if (mode === 'on') return theme.accent;
    if (mode === 'offline') return theme.crit;
    if (mode === 'config') return theme.muted;
    return theme.low;
  }

  function renderBulb(theme, mode, color) {
    const { x, y } = BULB_CENTER;
    const glow = mode === 'on'
      ? `<circle cx="${x}" cy="${y}" r="${BULB_RADIUS + 16}" fill="${color}" opacity="0.16"/>`
      : '';
    const filament = mode === 'on'
      ? `<path d="M ${x - 8} ${y - 6} L ${x} ${y + 6} L ${x + 8} ${y - 6}" stroke="${theme.contrast}" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>`
      : '';
    return `
      ${glow}
      <circle cx="${x}" cy="${y}" r="${BULB_RADIUS}" fill="${color}" stroke="${theme.text}" stroke-opacity="0.16" stroke-width="2"/>
      ${filament}
      <rect x="${x - 18}" y="${y + BULB_RADIUS - 6}" width="36" height="20" rx="5" fill="${theme.shell}" stroke="${color}" stroke-width="2"/>
    `;
  }

  function renderStudyLightIcon(instance) {
    const theme = themeFor(instance.settings);
    const view = viewFor(instance);
    const color = colorFor(theme, view.mode);
    const bottomLine = view.hint || instance.settings.subtitle || '';
    const bottomColor = view.hint ? color : theme.muted;

    return toDataUrl(`
      <svg width="392" height="392" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
        ${renderScreenFrame(theme, theme.accent, `
          ${renderBulb(theme, view.mode, color)}
          <rect x="78" y="140" width="100" height="32" rx="16" fill="${color}"/>
          <text x="128" y="162" text-anchor="middle" fill="${theme.contrast}" font-size="18" font-weight="700" font-family="Arial, Helvetica, sans-serif">${escapeXml(view.word)}</text>
          <text x="128" y="196" text-anchor="middle" fill="${theme.text}" font-size="24" font-weight="700" font-family="Arial, Helvetica, sans-serif">${escapeXml(instance.settings.title)}</text>
          <text x="128" y="218" text-anchor="middle" fill="${bottomColor}" font-size="15" font-family="Arial, Helvetica, sans-serif">${escapeXml(bottomLine)}</text>
        `, frameFor(instance.settings))}
      </svg>
    `);
  }

  const config = {
    defaults: {
      title: 'Study Light',
      subtitle: 'Study Spotlight',
      theme: 'ember',
      frameSize: 'optimal',
      showFrame: 'true',
    },
    createState: (instance) => ({
      connectionState: ha.configured ? 'PENDING' : 'CONFIG_REQUIRED',
      errorKind: null,
      failureCount: 0,
      fetching: false,
      toggling: false,
      pollStarted: false,
      requestId: 0,
      lastSeenAt: null,
      ...hydrateState(readPersistedState(instance.context)),
    }),
    onRun: (instance) => handleToggle(instance),
    onReady: (instance) => {
      if (!ha.configured) {
        instance.connectionState = 'CONFIG_REQUIRED';
        renderInstance(instance);
        return undefined;
      }
      // 恢复既有实例（宿主重放 add/paramFromApp）时不重复取数，轮询已在跑。
      if (instance.pollStarted) return undefined;
      instance.pollStarted = true;
      return runPoll(instance);
    },
    onDispose: (instance) => {
      instance.requestId += 1;
      clearInstanceTimeout(instance, POLL_TIMER_SLOT);
      flushState(instance);
    },
    render: renderStudyLightIcon,
  };

  return {
    key: 'studylight',
    config,
    testing: {
      studylightApplyPollResult: applyPollResult,
      studylightBackoffDelay: backoffDelay,
      studylightHaStateToLightState: haStateToLightState,
      studylightHandleToggle: handleToggle,
      studylightHydrateState: hydrateState,
      studylightRunPoll: runPoll,
      studylightViewFor: viewFor,
    },
  };
}
