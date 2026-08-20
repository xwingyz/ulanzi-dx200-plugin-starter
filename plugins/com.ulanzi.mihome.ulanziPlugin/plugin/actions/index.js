import { createStudyLightAction } from './studylight.js';

export function createActionModules(runtime) {
  return [
    createStudyLightAction(runtime),
  ];
}
