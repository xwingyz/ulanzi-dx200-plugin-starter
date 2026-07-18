const FONT_TEST_LINES = [
  { size: 28, y: 96 },
  { size: 32, y: 144 },
  { size: 36, y: 198 },
];
const FONT_TEST_TEXT = '测速128Kbps';
const FONT_TEST_FAMILY = '"Arial Black", "Helvetica Neue", Arial, Helvetica, sans-serif';

export function createFontprobeAction(runtime) {
  const { escapeXml, frameFor, renderScreenFrame, themeFor, toDataUrl } = runtime;
function renderFontTestIcon(settings) {
  const theme = themeFor(settings);
  const accent = theme.accent;
  const samples = FONT_TEST_LINES.map(({ size, y }, index) => {
    const fill = index === 2 ? accent : theme.text;
    return `
      <text x="128" y="${y}" text-anchor="middle" fill="${fill}" font-size="${size}" font-weight="800" font-family="${FONT_TEST_FAMILY}">${escapeXml(FONT_TEST_TEXT)}</text>
    `;
  }).join('');

  return toDataUrl(`
    <svg width="256" height="256" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
      ${renderScreenFrame(
        theme,
        accent,
        `
          <rect x="50" y="50" width="156" height="156" rx="20" fill="none" stroke="${accent}" stroke-width="2"/>
          <rect x="40" y="40" width="176" height="176" rx="24" fill="none" stroke="${theme.muted}" stroke-width="1.5" stroke-dasharray="6 6" opacity="0.8"/>
          ${samples}
        `,
        frameFor(settings),
      )}
    </svg>
  `);
}


const config = {
    defaults: {
      title: '__PLUGIN_NAME__',
      subtitle: 'Font Test',
      theme: 'mono',
      frameSize: 'optimal',
      showFrame: 'true',
    },
    createState: () => ({}),
    onRun: () => {},
    render: (instance) => renderFontTestIcon(instance.settings),
  };
  return { key: 'fontprobe', config };
}
