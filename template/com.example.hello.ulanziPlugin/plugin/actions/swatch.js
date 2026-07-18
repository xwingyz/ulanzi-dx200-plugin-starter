const SWATCH_COLORS = ['#8b5cf6', '#14b8a6', '#f97316', '#ef4444', '#22c55e'];

export function createSwatchAction(runtime) {
  const { escapeXml, frameFor, normalizeColor, renderScreenFrame, themeFor, toDataUrl } = runtime;
function renderSwatchIcon(settings, step, currentColor) {
  const theme = themeFor(settings);
  const accent = normalizeColor(currentColor, theme.accent);
  const dots = SWATCH_COLORS.map((color, index) => {
    const cx = 72 + index * 28;
    const stroke = step % SWATCH_COLORS.length === index ? theme.text : theme.shell;
    return `<circle cx="${cx}" cy="194" r="10" fill="${color}" stroke="${stroke}" stroke-width="3"/>`;
  }).join('');

  return toDataUrl(`
    <svg width="256" height="256" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
      ${renderScreenFrame(
        theme,
        accent,
        `
          <rect x="54" y="54" width="148" height="76" rx="20" fill="${accent}"/>
          <text x="128" y="162" text-anchor="middle" fill="${theme.text}" font-size="28" font-weight="700" font-family="Arial, Helvetica, sans-serif">${escapeXml(settings.title)}</text>
          <text x="128" y="188" text-anchor="middle" fill="${theme.muted}" font-size="17" font-family="Arial, Helvetica, sans-serif">${escapeXml(settings.subtitle)}</text>
          <text x="128" y="218" text-anchor="middle" fill="${theme.text}" font-size="17" font-family="Arial, Helvetica, sans-serif">${escapeXml(accent.toUpperCase())}</text>
          ${dots}
        `,
        frameFor(settings),
      )}
    </svg>
  `);
}


const config = {
    defaults: {
      title: '__PLUGIN_NAME__',
      subtitle: 'Palette',
      theme: 'signal',
      frameSize: 'optimal',
      showFrame: 'true',
    },
    createState: () => ({ step: 0, currentColor: SWATCH_COLORS[0] }),
    onRun: (instance) => {
      instance.step = (instance.step + 1) % SWATCH_COLORS.length;
      instance.currentColor = SWATCH_COLORS[instance.step];
    },
    render: (instance) => renderSwatchIcon(instance.settings, instance.step, instance.currentColor),
  };
  return { key: 'swatch', config };
}
