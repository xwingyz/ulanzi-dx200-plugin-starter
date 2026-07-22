import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isLinkedWorktree, assertDeployableRoot } from '../scripts/lib/worktree-guard.mjs';

// 主检出的 .git 是目录；联动 worktree 的 .git 是普通文件；非仓库则 statSync 抛错。
const fsWith = (kind) => ({
  statSync: () => {
    if (kind === 'missing') {
      throw new Error('ENOENT');
    }
    return { isFile: () => kind === 'file' };
  },
});

test('isLinkedWorktree keys off .git being a file, not a directory', () => {
  assert.equal(isLinkedWorktree('/x', { fsImpl: fsWith('file') }), true);
  assert.equal(isLinkedWorktree('/x', { fsImpl: fsWith('dir') }), false);
  // 不是仓库（CI 纯导出）不该被误判为 worktree——交给上层其它校验，不拦。
  assert.equal(isLinkedWorktree('/x', { fsImpl: fsWith('missing') }), false);
});

test('assertDeployableRoot blocks a worktree deploy but lets the main checkout through', () => {
  // 主检出：放行。
  assert.doesNotThrow(() => assertDeployableRoot('/main', { fsImpl: fsWith('dir') }));

  // 联动 worktree：拦，且带可编程识别的错误码。
  assert.throws(
    () => assertDeployableRoot('/wt', { fsImpl: fsWith('file') }),
    (err) => err.code === 'DEPLOY_FROM_WORKTREE' && /worktree/.test(err.message),
  );

  // 显式放行逃生阀：--allow-worktree 时即便在 worktree 也不拦。
  assert.doesNotThrow(() => assertDeployableRoot('/wt', { fsImpl: fsWith('file'), allowWorktree: true }));
});
