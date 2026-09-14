// 给 events.json 里「没有配图」的记录找回它的截图
//
// 背景: 萤石对同一次活动会连推数条消息 —— 人形标签(不带截图) + 智能侦测(带截图),
// 两条几乎同时到达、被并发处理。人形标签那条落库时, 智能侦测的截图还在下载中,
// 垫图扫不到、兜底抓图又可能被萤石拒掉 —— 于是留下一条 file="" 的记录,
// 看板上就是一张"无截图"的占位卡(webhook.js 已加锁内补图, 新记录不会再这样)。
// 而那张图往往已经躺在 captures/ 里, 只是没有任何记录引用它(孤儿图)。
//
// 本工具按「同设备 + 时间邻近」把这类图认回去, 让历史记录恢复配图。
//
// 用法:
//   node tools/repair_noimage_events.js                  # 预演(默认), 只报告不改文件
//   node tools/repair_noimage_events.js --apply           # 实际写盘(会先备份 events.json)
//   node tools/repair_noimage_events.js --window=180      # 放宽匹配窗口到 180 秒(默认 90)
//
// 判定是保守的: 只在同设备、时间差不超过窗口的候选里挑, 且优先挑「没有任何记录引用的孤儿图」
// (那才是真正属于这条记录的图)。找不到候选的记录会原样保留, 工具会列出来。
const fs = require("fs");
const path = require("path");
const store = require("../lib/store");

const ROOT = path.join(__dirname, "..");
const APPLY = process.argv.indexOf("--apply") >= 0;
const WINDOW_MS = (function () {
  for (const a of process.argv) {
    const m = /^--window=(\d+)$/.exec(a);
    if (m) return Number(m[1]) * 1000;
  }
  return 90e3; // 与 webhook.js 的「同一次活动」去重窗口一致
})();
const CAPTURE_DIR = path.join(ROOT, "captures");
const MOTION_DIR = path.join(ROOT, "captures", "motion");

// 从文件名里取时间戳: {serial}_{ms}.jpg / {serial}_p{ms}.jpg / {serial}_a{ms}.jpg
function picTs(f) {
  const m = /_([pa]?)(\d{10,})\.jpg$/i.exec(f);
  return m ? Number(m[2]) : 0;
}

// 扫描抓图目录, 建立 serial -> [{file, ts, motion}]
function scanCaptures() {
  const idx = {};
  for (const src of [{ d: CAPTURE_DIR, motion: false }, { d: MOTION_DIR, motion: true }]) {
    let names = [];
    try { names = fs.readdirSync(src.d); } catch (e) { continue; }
    for (const f of names) {
      if (!/\.jpg$/i.test(f)) continue;
      const us = f.indexOf("_");
      if (us <= 0) continue;                      // 没有设备前缀(如 thumb_xxx)不是抓图, 跳过
      const serial = f.slice(0, us);
      const ts = picTs(f);
      if (!ts) continue;                          // 认不出时间戳的图不参与匹配
      if (!idx[serial]) idx[serial] = [];
      idx[serial].push({ file: f, ts: ts, motion: src.motion });
    }
  }
  return idx;
}

function keyOf(e) { return String(e.serial || "") + "@" + Number(e.ts || 0); }
function fmt(ts) { return new Date(ts).toLocaleString("zh-CN", { hour12: false }); }

(async function main() {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
  const ev = store.readEvents(ROOT);
  const empty = ev.filter(function (e) { return !e.file; });

  console.log("events.json 共 " + ev.length + " 条, 其中无配图 " + empty.length + " 条");
  console.log("匹配窗口: 同设备 ±" + (WINDOW_MS / 1000) + " 秒; 优先认领没有被任何记录引用的孤儿图");
  console.log("");

  if (!empty.length) { console.log("没有需要修复的记录。"); return; }

  // 已被引用的图: 认领时要避开(优先孤儿图)
  const refs = {};
  ev.forEach(function (e) { if (e.file) refs[e.file] = 1; });
  const idx = scanCaptures();

  const plans = [];   // { key, time, name, file, delta, motion, orphan }
  const misses = [];  // 找不到候选的

  for (const e of empty) {
    const serial = String(e.serial || "");
    const ts = Number(e.ts || 0);
    const cands = (idx[serial] || []).filter(function (x) { return Math.abs(x.ts - ts) <= WINDOW_MS; });
    if (!cands.length) { misses.push(e); continue; }
    cands.sort(function (a, b) {
      const ra = refs[a.file] ? 1 : 0, rb = refs[b.file] ? 1 : 0;
      return (ra - rb) || (Math.abs(a.ts - ts) - Math.abs(b.ts - ts)); // 孤儿图优先, 其次时间最近
    });
    const c = cands[0];
    plans.push({
      key: keyOf(e), time: e.time, name: e.name, title: e.title,
      file: c.file, delta: Math.round((c.ts - ts) / 1000), motion: c.motion, orphan: !refs[c.file]
    });
  }

  if (plans.length) {
    console.log("可以找回配图的记录 (" + plans.length + " 条):");
    for (const p of plans) {
      console.log("  " + String(p.time || "").padEnd(21) + " " + String(p.name || "").padEnd(16) +
        " <- " + p.file +
        "  (" + (p.delta >= 0 ? "+" : "") + p.delta + "s" +
        ", " + (p.orphan ? "孤儿图" : "已被别的记录引用") +
        (p.motion ? ", 在 motion/" : "") + ")");
    }
    console.log("");
  }
  if (misses.length) {
    console.log("找不到邻近截图、补不了的记录 (" + misses.length + " 条):");
    for (const e of misses) console.log("  " + String(e.time || "").padEnd(21) + " " + String(e.name || "") + "  [" + (e.title || "") + "]");
    console.log("  （这些多半是当时兜底抓图也被萤石拒了, 从那以后就没有可用画面; 可在看板上直接删掉）");
    console.log("");
  }

  if (!APPLY) {
    console.log("以上为预演, 未改动任何文件。确认无误后执行: node tools/repair_noimage_events.js --apply");
    console.log("提示: 服务运行中执行也安全 —— 写盘前会在锁内重新读取最新 events.json 再/按 key 应用。");
    return;
  }
  if (!plans.length) { console.log("没有可应用的修复, 未改动文件。"); return; }

  // 锁内按 key 应用: 服务可能在这期间刚写了新记录, 直接按旧下标写会覆盖掉
  const want = {};
  for (const p of plans) want[p.key] = p.file;
  // 写盘前先备份原始内容 —— 事务一旦提交就无法回溯了
  const bak = path.join(ROOT, "data", "events.json.bak." + Date.now());
  fs.copyFileSync(path.join(ROOT, "data", "events.json"), bak);
  const r = await store.updateEvents(ROOT, function (arr) {
    let n = 0;
    for (const e of arr) {
      if (e.file) continue;                      // 已经有图的(可能刚被 webhook 补过)不再动
      const f = want[keyOf(e)];
      if (!f) continue;
      e.file = f;
      n++;
    }
    return n > 0;
  }, { cap: store.eventCap(cfg) });

  if (!r.ok) {
    console.error("写入失败(未拿到锁), 本次未改动。");
    console.error("改动前的原文件已备份在 " + path.basename(bak) + "，需要时可直接覆盖回去。");
    process.exit(1);
  }
  console.log("已为 " + plans.length + " 条记录补上配图。");
  console.log("改动前的 events.json 备份在: " + path.basename(bak));
})().catch(function (e) { console.error("执行失败: " + e.message); process.exit(1); });
