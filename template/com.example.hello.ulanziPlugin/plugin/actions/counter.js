export function createCounterAction(runtime) {
  const { escapeXml, frameFor, renderScreenFrame, themeFor, toDataUrl } = runtime;
function renderCounterIcon(settings, count) {
  const theme = themeFor(settings);
  const accent = theme.accent;

  return toDataUrl(`
    <svg width="392" height="392" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
      ${renderScreenFrame(
        theme,
        accent,
        `
          <rect x="54" y="54" width="148" height="20" rx="10" fill="${accent}" opacity="0.2"/>
          <text x="128" y="78" text-anchor="middle" fill="${theme.text}" font-size="22" font-family="Arial, Helvetica, sans-serif">${escapeXml(settings.title)}</text>
          <text x="128" y="138" text-anchor="middle" fill="${accent}" font-size="72" font-weight="700" font-family="Arial, Helvetica, sans-serif">${count}</text>
          <text x="128" y="174" text-anchor="middle" fill="${theme.muted}" font-size="22" font-family="Arial, Helvetica, sans-serif">${escapeXml(settings.subtitle)}</text>
          <text x="128" y="204" text-anchor="middle" fill="${theme.low}" font-size="16" font-family="Arial, Helvetica, sans-serif">press to increment</text>
        `,
        frameFor(settings),
      )}
    </svg>
  `);
}


const config = {
    defaults: {
      title: '__PLUGIN_NAME__',
      subtitle: 'Counter',
      theme: 'mint',
      frameSize: 'optimal',
      showFrame: 'true',
    },
    createState: () => ({ count: 0 }),
    onRun: (instance) => {
      instance.count += 1;
    },
    render: (instance) => renderCounterIcon(instance.settings, instance.count),
  };
  return { key: 'counter', config };
}
