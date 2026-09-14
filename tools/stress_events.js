// 多进程并发写 events.json 压力测试: 对照组(原实现, 无锁) vs 实验组(lib/store 事务式)
// 用法: node tools/stress_events.js [进程数] [每进程条数]
// 期望: naive 明显丢条(实测 6进程x120条只落盘 ~20 条); locked 一条不丢、0 次放弃写入
// 这是「三进程并发写 events.json 丢数据」那个 bug 的回归测试, 改动 lib/store.js 后请重跑。
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PROCS = Number(process.argv[2] || 6);
const PER = Number(process.argv[3] || 120);
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "evstress-"));

function run(mode, file) {
  return new Promise(function (resolve) {
    let done = 0, failed = 0;
    const logs = [];
    for (let i = 0; i < PROCS; i++) {
      const p = spawn(process.execPath, [path.join(__dirname, "stress_events_worker.js"), mode, String(PER), file], { stdio: ["ignore", "pipe", "pipe"] });
      p.stdout.on("data", function (b) { logs.push(String(b)); });
      p.stderr.on("data", function (b) { logs.push(String(b)); });
      p.on("exit", function (code) { if (code !== 0) failed++; if (++done === PROCS) resolve({ failed, logs: logs.join("") }); });
    }
  });
}

function count(file) {
  try { const a = JSON.parse(fs.readFileSync(file, "utf8")); return Array.isArray(a) ? a.length : -1; }
  catch (e) { return -1; }
}
function unique(file) {
  try {
    const a = JSON.parse(fs.readFileSync(file, "utf8"));
    return new Set(a.map(function (e) { return e.file; })).size;
  } catch (e) { return -1; }
}

(async function () {
  const expect = PROCS * PER;
  console.log("=== events.json 多进程并发写压力测试 ===");
  console.log("进程数 " + PROCS + " × 每进程 " + PER + " 条 = 期望 " + expect + " 条\n");

  for (const mode of ["naive", "locked"]) {
    const file = path.join(DIR, "events_" + mode + ".json");
    fs.writeFileSync(file, "[]");
    const t0 = Date.now();
    const r = await run(mode, file);
    const failed = r.failed;
    const ms = Date.now() - t0;
    const n = count(file), u = unique(file);
    console.log((mode === "naive" ? "[对照组 无锁] " : "[实验组 加锁] ") +
      "落盘 " + n + " 条 (去重后 " + u + ") / 期望 " + expect +
      "  丢失 " + (expect - u) + " 条" +
      "  " + (u === expect ? "PASS 一条不丢" : "FAIL") +
      "  耗时 " + ms + "ms" + (failed ? "  (子进程异常退出 " + failed + ")" : ""));
    const warns = (r.logs.match(/\[store\][^\n]*/g) || []);
    if (warns.length) {
      const kinds = {};
      warns.forEach(function (w) { const k = w.replace(/\d+/g, "N").trim(); kinds[k] = (kinds[k] || 0) + 1; });
      console.log("   store 告警 " + warns.length + " 条:");
      Object.keys(kinds).forEach(function (k) { console.log("     " + kinds[k] + " x " + k); });
    }
    const gaveUp = (r.logs.match(/FAILED=(\d+)/g) || []).reduce(function (s, x) { return s + Number(x.slice(7)); }, 0);
    console.log("   放弃写入次数 = " + gaveUp + (gaveUp ? "  <-- 静默丢数据的来源, 必须为 0" : "  (无静默丢弃)"));
  }
  // 同进程并发: 多条事务链交错发起(每笔 await 都会让出), 会真正走到"回收本进程遗留锁"那条分支
  const store = require("../lib/store");
  const CONC = 8, PERCHAIN = 60;
  const f2 = path.join(DIR, "events_inproc.json");
  fs.writeFileSync(f2, "[]");
  const chains = [];
  for (let i = 0; i < CONC; i++) {
    chains.push((async function () {
      for (let j = 0; j < PERCHAIN; j++) {
        await store.updateJson(f2, function (arr) { arr.push({ chain: i, n: j, file: "c" + i + "_" + j }); return true; });
      }
    })());
  }
  const t1 = Date.now();
  await Promise.all(chains);
  const got = count(f2), uniq = unique(f2), want = CONC * PERCHAIN;
  console.log("[同进程并发] " + CONC + " 条事务链 × " + PERCHAIN + " 笔 = 期望 " + want +
    "  落盘 " + got + " (唯一 " + uniq + ")  丢失 " + (want - uniq) + " 条  " +
    (uniq === want ? "PASS 一条不丢" : "FAIL") + "  耗时 " + (Date.now() - t1) + "ms");

  fs.rmSync(DIR, { recursive: true, force: true });
})();
