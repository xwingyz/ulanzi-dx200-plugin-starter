import fs from 'node:fs';
import path from 'node:path';

// 部署会「整目录替换 + 全局重启唯一宿主」（见 dev-desktop.mjs）。从某个 git 联动
// worktree 部署，会把该 worktree 里没有的兄弟 action 从实机上一并删掉，而全局重启又
// 会把宿主从别的 agent 脚下抽走。所以规则是：只从主检出（已合并主线的规范树）部署。
//
// 判定依据是纯文件系统事实，不 spawn git：主检出的 `.git` 是**目录**；联动 worktree 的
// `.git` 是一个内容为 `gitdir: ...` 的**普通文件**。据此即可区分，且无需 git 可执行。
export function isLinkedWorktree(rootDir, options = {}) {
  const fsImpl = options.fsImpl ?? fs;
  const gitPath = path.join(rootDir, '.git');
  let stat;
  try {
    stat = fsImpl.statSync(gitPath);
  } catch {
    // 不是仓库（例如 CI 里的纯导出）——不拦，交给上层其它校验。
    return false;
  }
  return stat.isFile();
}

// 部署前置校验：从联动 worktree 部署时抛出，除非显式 allowWorktree 放行。
// 抛错而非仅告警——这是「合并前不得进入部署验收」这条硬约束的机器执行点。
export function assertDeployableRoot(rootDir, options = {}) {
  if (options.allowWorktree) {
    return;
  }
  if (isLinkedWorktree(rootDir, options)) {
    const error = new Error(
      [
        '拒绝从 git 联动 worktree 部署到共享实机。',
        `  当前根目录: ${rootDir}`,
        '  部署是「整目录替换 + 全局重启唯一宿主」：从缺少兄弟 action 的 worktree 部署，',
        '  会把那些 action 从实机上删掉，重启还会打断其它 agent 的实机联调。',
        '  正确做法：先把本 action 合并回主线，再从主检出（.git 为目录的那份）部署一次。',
        '  确需从 worktree 部署（仅限单人、无并行 agent）时，附加 --allow-worktree 显式放行。',
      ].join('\n'),
    );
    error.code = 'DEPLOY_FROM_WORKTREE';
    throw error;
  }
}
