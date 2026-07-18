import { createBadgeAction } from './badge.js';
import { createCounterAction } from './counter.js';
import { createFontprobeAction } from './fontprobe.js';
import { createSwatchAction } from './swatch.js';

export function createActionModules(runtime) {
  return [
    createCounterAction(runtime),
    createBadgeAction(runtime),
    createSwatchAction(runtime),
    createFontprobeAction(runtime),
  ];
}
