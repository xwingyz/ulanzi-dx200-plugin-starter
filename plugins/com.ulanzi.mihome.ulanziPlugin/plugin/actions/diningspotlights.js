// 餐厅射灯：单击同时控制"米家LED射灯1"和"米家LED射灯2"。注意 Xiaomi 集成没给灯组加
// 房间区分，HA 里存在两组重名的"米家LED射灯1/2"实体；这里选的是 2026-08-20 核对时
// 实际点亮的那一组（另一组同名实体当时是关的，属于别的房间，不要跟这里搞混）。
// 群组语义与 studylight 一致——任意一盏亮着就全部关掉，两盏都关才会全部点亮。
//
// haStateToLightState / combineLightStates / lightGroupBackoffDelay 由 app.js 注入，
// 与 studylight 共用（development-rules.md：第二个 action 出现同一纯能力时提升为
// 共享原语）。轮询/乐观切换/定时器调度这些带副作用的编排仍是每个 action 自己的实现，
// 与 nasstatus/bambustatus 的既有写法一致，不强行抽成通用引擎。
const ENTITY_IDS = [
  'light.yeelink_cn_1084383117_spot2_s_2_light',
  'light.yeelink_cn_1084388920_spot2_s_2_light',
];

// 换过两次目标实体（spot1 → 错的一组 spot2 同名灯 → 正确的一组），版本号一并进位：
// 旧持久化状态是别的灯的开关记录，不能当作这两盏灯的初始状态用，宁可丢弃回到 unknown
// 等下次轮询校正。
const STATE_VERSION = 3;
const POLL_INTERVAL_MS = 5_000;
// HA 执行 turn_on/turn_off 后状态还没落定就轮询会读到旧值，留够余量再校正。
const RECONCILE_DELAY_MS = 900;
const POLL_TIMER_SLOT = 'diningspotlightsPoll';

export function createDiningSpotlightsAction(runtime) {
  const {
    clearInstanceTimeout,
    combineLightStates,
    escapeXml,
    frameFor,
    ha,
    haStateToLightState,
    lightGroupBackoffDelay,
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
    return { v: STATE_VERSION, lightStates: instance.lightStates, lastSeenAt: instance.lastSeenAt ?? null };
  }

  function hydrateState(raw) {
    const valid = raw && typeof raw === 'object' && raw.v === STATE_VERSION
      && Array.isArray(raw.lightStates) && raw.lightStates.length === ENTITY_IDS.length;
    return {
      lightStates: valid
        ? raw.lightStates.map((value) => (value === 'on' || value === 'off' ? value : 'unknown'))
        : ENTITY_IDS.map(() => 'unknown'),
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
      : lightGroupBackoffDelay(instance.failureCount);
    setInstanceTimeout(instance, POLL_TIMER_SLOT, () => runPoll(instance), delay);
  }

  // 所有实体都成功才当作一次成功轮询——半成功不足以判断群组的真实合并状态，
  // 宁可整体退避重试。
  function applyPollResult(instance, results, now = Date.now()) {
    if (!ha.configured) {
      instance.connectionState = 'CONFIG_REQUIRED';
      instance.errorKind = null;
      return;
    }
    if (results.every((result) => result.ok)) {
      instance.connectionState = 'ONLINE';
      instance.errorKind = null;
      instance.failureCount = 0;
      instance.lightStates = results.map((result) => haStateToLightState(result.json?.state));
      instance.lastSeenAt = now;
      return;
    }
    instance.failureCount += 1;
    const failed = results.find((result) => !result.ok);
    instance.connectionState = failed.kind === 'CONFIG' ? 'CONFIG_REQUIRED' : 'OFFLINE';
    instance.errorKind = failed.kind;
  }

  async function runPoll(instance, options = {}) {
    if (!instance || instance.fetching) return;
    instance.fetching = true;
    instance.requestId += 1;
    const requestId = instance.requestId;
    const getState = options.getState ?? ha.getState;

    const results = await Promise.all(ENTITY_IDS.map((entityId) => getState(entityId)));

    if (!isInstanceCurrent(instance, requestId)) {
      instance.fetching = false;
      return;
    }
    instance.fetching = false;
    applyPollResult(instance, results);
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
    // 乐观翻转：不等接口响应先给用户即时反馈。当前合并状态是"开"（含未知，未知时优先
    // 假定要点亮）才关灯，否则点亮全部。
    const currentlyOn = combineLightStates(instance.lightStates) === 'on';
    const nextState = currentlyOn ? 'off' : 'on';
    instance.lightStates = ENTITY_IDS.map(() => nextState);
    renderInstance(instance);
    clearInstanceTimeout(instance, POLL_TIMER_SLOT);

    const service = currentlyOn ? 'turn_off' : 'turn_on';
    const result = await (options.callService ?? ha.callService)('light', service, ENTITY_IDS);
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
    const combined = combineLightStates(instance.lightStates);
    if (combined === 'on') {
      return { mode: 'on', word: t('ON'), hint: '' };
    }
    if (combined === 'off') {
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

  function renderDiningSpotlightsIcon(instance) {
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
      title: 'Dining Spotlights',
      subtitle: 'Spot 1 + 2',
      theme: 'sunset',
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
    render: renderDiningSpotlightsIcon,
  };

  return {
    key: 'diningspotlights',
    config,
    testing: {
      diningspotlightsApplyPollResult: applyPollResult,
      diningspotlightsHandleToggle: handleToggle,
      diningspotlightsHydrateState: hydrateState,
      diningspotlightsRunPoll: runPoll,
      diningspotlightsViewFor: viewFor,
    },
  };
}
