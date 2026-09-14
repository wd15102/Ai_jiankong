// 多进程并发写 events.json 压力测试的 worker(由 tools/stress_events.js 拉起)
// 用法: node stress_events_worker.js <mode:naive|locked> <count> <targetFile>
// 结束打印: FAILED=<放弃写入的次数>  (非 0 即为静默丢数据)
const fs = require("fs");
const store = require("../lib/store");

const mode = process.argv[2];
const count = Number(process.argv[3] || 200);
const FILE = process.argv[4];

// 模拟真实场景: "读完"和"写之前"还要干点活(下载图片/调AI), 这是原来丢数据的窗口
function work() {
  const t = Date.now() + 1 + Math.floor(Math.random() * 3);
  while (Date.now() < t) {}
}

(async function () {
  let failed = 0;
  for (let i = 0; i < count; i++) {
    const ev = { ts: Date.now(), n: i, pid: process.pid, file: "f" + process.pid + "_" + i + ".jpg" };
    if (mode === "naive") {
      // 对照组 = 原实现的写法: 读全量 -> push -> 写全量
      let arr = [];
      try { arr = JSON.parse(fs.readFileSync(FILE, "utf8")); if (!Array.isArray(arr)) arr = []; } catch (e) {}
      work();
      arr.push(ev);
      fs.writeFileSync(FILE, JSON.stringify(arr, null, 1));
    } else {
      const r = await store.updateJson(FILE, function (arr) { work(); arr.push(ev); return true; });
      if (!r.ok) failed++;
    }
  }
  console.log("FAILED=" + failed);
  process.exit(0);
})();
