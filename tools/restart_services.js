// 以 detached 方式重启 webhook 与 monitor。
// 用途：脱离 AI 会话进程树地拉起服务(会话内 spawn 的子进程会随会话被回收)。
//   - webhook: 自带"新实例接管旧实例"机制, 直接拉新即可(旧实例收到接管请求会自行退出)
//   - monitor: 无接管机制, 必须先按 data/monitor.pid 杀掉旧进程再拉, 否则会出现两个轮询进程
// 用法: node tools/restart_services.js
"use strict";
const fs = require("fs"), cp = require("child_process"), path = require("path");
const root = path.join(__dirname, "..");
const dataDir = path.join(root, "data");

function pidAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch (e) { return false; }
}
function launch(script, args, log) {
  const fd = fs.openSync(path.join(dataDir, log), "a"); // 追加模式, 与 bat 的 >> 行为一致
  const child = cp.spawn(process.execPath, [script].concat(args), { cwd: root, detached: true, stdio: ["ignore", fd, fd] });
  child.unref();
  console.log("已启动 " + script + (args.length ? " " + args.join(" ") : "") + "  pid=" + child.pid);
}

// 1) 先杀掉旧 monitor(无接管机制, 不清会双进程轮询)
try {
  const mp = fs.readFileSync(path.join(dataDir, "monitor.pid"), "utf8").trim();
  if (mp && pidAlive(mp)) { process.kill(Number(mp)); console.log("已停止旧 monitor pid=" + mp); }
} catch (e) { /* 无 pid 文件或已退出 */ }

// 2) 拉起(webhook 自行接管旧实例)
launch("webhook.js", [], "webhook_run.log");
launch("monitor.js", ["watch"], "monitor_run.log");
