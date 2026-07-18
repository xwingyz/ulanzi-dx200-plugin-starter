import fs from 'node:fs';
import path from 'node:path';

// 部署目录里有一批"只存在于那边"的运行时状态：用户逐键设置、latency 24 小时历史、
// speedtest 7 天记录。仓库里没有它们的副本，删掉就是永久丢失。
// 同步时这些顶层条目必须原样留下。
export const PRESERVED_ENTRIES = new Set(['data']);

export function removeDir(targetPath) {
  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  }
}

// 清空目录但保留指定的顶层条目。等价于 removeDir + 重建，只是漏掉 preserved 的那些。
export function clearDirExcept(targetDir, preserved = PRESERVED_ENTRIES) {
  if (!fs.existsSync(targetDir)) {
    return;
  }
  for (const entry of fs.readdirSync(targetDir)) {
    if (preserved.has(entry)) {
      continue;
    }
    fs.rmSync(path.join(targetDir, entry), { recursive: true, force: true });
  }
}

// skip 只在最外层生效：插件根下的 data/ 是运行时状态，不能从仓库覆盖过去；
// 但更深层叫 data 的目录（图标资源、静态数据等）是代码资产，必须照常拷贝。
// 递归调用时不再传 skip，正是为了保住这个区别。
export function copyDir(sourceDir, targetDir, skip = new Set()) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (skip.has(entry.name)) {
      continue;
    }
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDir(sourcePath, targetPath);
    } else {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

// 把插件同步到部署目录：删掉仓库里已不存在的文件，但保住运行时状态。
//
// resetData 为 true 时才连 data/ 一起删（显式 opt-in 的破坏性路径）。
// 注意即便 reset，也不会把仓库的 data/ 拷过去——仓库那份通常是本地调试残留，
// 覆盖过去比留空更糟。仓库的 data/ 永远不是运行时状态的合法来源。
export function syncPluginDir(sourceDir, targetDir, { resetData = false } = {}) {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Plugin not found: ${sourceDir}`);
  }

  fs.mkdirSync(path.dirname(targetDir), { recursive: true });

  if (resetData) {
    removeDir(targetDir);
  } else {
    clearDirExcept(targetDir, PRESERVED_ENTRIES);
  }

  copyDir(sourceDir, targetDir, PRESERVED_ENTRIES);
  return targetDir;
}
