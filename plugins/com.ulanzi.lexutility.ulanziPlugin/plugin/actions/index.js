import { createChatGptUsageAction } from './chatgptusage.js';
import { createBambuStatusAction } from './bambustatus.js';
import { createClaudeUsageAction } from './claudeusage.js';
import { createLatencyAction } from './latency.js';
import { createPomowaveAction } from './pomowave.js';
import { createSpeedtestAction } from './speedtest.js';
import { createSystemStatusAction } from './systemstatus.js';

export function createActionModules(runtime) {
  return [
    createSpeedtestAction(runtime),
    createPomowaveAction(runtime),
    createLatencyAction(runtime),
    createClaudeUsageAction(runtime),
    createChatGptUsageAction(runtime),
    createBambuStatusAction(runtime),
    createSystemStatusAction(runtime),
  ];
}
