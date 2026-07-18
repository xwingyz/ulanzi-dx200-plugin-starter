import { createLatencyAction } from './latency.js';
import { createPomowaveAction } from './pomowave.js';
import { createSpeedtestAction } from './speedtest.js';

export function createActionModules(runtime) {
  return [
    createSpeedtestAction(runtime),
    createPomowaveAction(runtime),
    createLatencyAction(runtime),
  ];
}
