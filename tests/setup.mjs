// 测试进程的持久化隔离层。
//
// 多个测试会 import 真实的 plugin/app.js 并触发真实落盘（inspector-bridge 甚至跑真
// WebSocket 握手，走完整的 add → createState → flush 链路）。框架的 store 路径是
// import 期求值的模块常量，等测试跑起来再改已经晚了——只能在任何测试模块加载之前
// 用进程级环境变量把数据目录挪走。所以这个文件由 `node --test --import` 预加载。
//
// 不隔离的后果不只是仓库变脏：写进 plugins/*/data/ 的测试键会被同步脚本一路带到
// 用户的 Ulanzi 插件目录里。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ulanzi-test-data-'));
process.env.ULANZI_PLUGIN_DATA_DIR = dataDir;

process.on('exit', () => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // 清理失败不该让已经跑绿的测试进程以非零码退出；临时目录交给系统回收。
  }
});
