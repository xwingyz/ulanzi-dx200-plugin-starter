export function createBadgeAction(runtime) {
  const { escapeXml, frameFor, renderScreenFrame, themeFor, toDataUrl } = runtime;
function renderBadgeIcon(settings, active) {
  const theme = themeFor(settings);
  const accent = theme.accent;
  const pillFill = active ? accent : theme.low;
  const pillText = active ? theme.contrast : theme.text;

  return toDataUrl(`
    <svg width="256" height="256" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
      ${renderScreenFrame(
        theme,
        accent,
        `
          <rect x="54" y="56" width="148" height="42" rx="21" fill="${pillFill}"/>
          <text x="128" y="84" text-anchor="middle" fill="${pillText}" font-size="20" font-weight="700" font-family="Arial, Helvetica, sans-serif">${active ? 'LIVE' : 'PAUSED'}</text>
          <text x="128" y="136" text-anchor="middle" fill="${theme.text}" font-size="30" font-weight="700" font-family="Arial, Helvetica, sans-serif">${escapeXml(settings.title)}</text>
          <text x="128" y="170" text-anchor="middle" fill="${theme.muted}" font-size="22" font-family="Arial, Helvetica, sans-serif">${escapeXml(settings.subtitle)}</text>
          <text x="128" y="202" text-anchor="middle" fill="${accent}" font-size="16" font-family="Arial, Helvetica, sans-serif">press to toggle</text>
        `,
        frameFor(settings),
      )}
    </svg>
  `);
}


const config = {
    defaults: {
      title: '__PLUGIN_NAME__',
      subtitle: 'Status',
      theme: 'ember',
      frameSize: 'optimal',
      showFrame: 'true',
    },
    createState: () => ({ activeBadge: true }),
    onRun: (instance) => {
      instance.activeBadge = !instance.activeBadge;
    },
    render: (instance) => renderBadgeIcon(instance.settings, instance.activeBadge),
  };
  return { key: 'badge', config };
}
