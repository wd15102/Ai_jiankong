// 存量 events.json 判人结论校正: 用 lib/judge.js 重新判定每条记录的 person 字段
// 背景: 旧的判人正则会把"没有人""未见人员活动"判成"有人", 已入库的记录 person 可能是错的。
//
// 用法:
//   node tools/rejudge_events.js          # 预演(默认), 只报告会改多少条, 不写盘
//   node tools/rejudge_events.js --apply  # 实际写盘
//
// 写盘走 lib/store 的跨进程事务(同一把 events.json 锁), 所以**可以在三个服务运行中安全执行**:
// 锁内会重新读最新内容再按键合并, 既不会覆盖服务刚写入的新事件, 也不会被服务覆盖。
//
// 只处理"AI 结论"型记录(ai 字段非空且不以 "(" 开头); 设备侧人形报警(15504)写的 person
// 是设备给的结论, 不由 AI 文本judge, 一律跳过。判定结果与旧值相同的也跳过。
const fs = require("fs");
const path = require("path");
const { judgePerson } = require("../lib/judge");
const store = require("../lib/store");

const ROOT = path.join(__dirname, "..");
const FILE = path.join(ROOT, "data", "events.json");
const APPLY = process.argv.indexOf("--apply") >= 0;

let arr;
try { arr = JSON.parse(fs.readFileSync(FILE, "utf8")); }
catch (e) { console.error("读取 data/events.json 失败: " + e.message); process.exit(1); }
if (!Array.isArray(arr)) { console.error("events.json 不是数组, 已中止"); process.exit(1); }

// 判定是否为"AI 结论"型记录: 有 ai 文本且不是占位符
function isAiRecord(e) {
  const ai = String((e && e.ai) || "").trim();
  if (!ai) return false;
  if (ai.charAt(0) === "(") return false;   // "(点击AI分析)" / "(等待分析...)" / "(AI全渠道失败:...)"
  return true;
}

const changes = [];
const keyOf = function (e) { return String(e.ts || 0) + "@" + String(e.file || ""); };
for (let i = 0; i < arr.length; i++) {
  const e = arr[i];
  if (!isAiRecord(e)) continue;
  const j = judgePerson(e.ai);
  if (!j.matched) continue;                 // 读不懂的保持原样, 不猜
  const before = e.person === true;
  if (before === j.person) continue;
  changes.push({ key: keyOf(e), time: e.time, name: e.name, before: before, after: j.person, source: j.source, ai: String(e.ai).replace(/\s+/g, " ").slice(0, 70) });
}

console.log("=== 判人结论校正 " + (APPLY ? "[写盘模式]" : "[预演模式]") + " ===");
console.log("events.json 共 " + arr.length + " 条; 其中 AI 结论型 " + arr.filter(isAiRecord).length + " 条");
console.log("需要修正 " + changes.length + " 条:" +
  (changes.length ? "  有人->无人 " + changes.filter(function (c) { return c.before; }).length +
                    " 条 / 无人->有人 " + changes.filter(function (c) { return !c.before; }).length + " 条" : ""));
console.log("");
for (const c of changes.slice(0, 30)) {
  console.log("  [" + (c.time || "?") + "] " + (c.name || "?") + "  " + (c.before ? "有人" : "无人") + " -> " + (c.after ? "有人" : "无人") + "  (依据:" + c.source + ")");
  console.log("      " + c.ai);
}
if (changes.length > 30) console.log("  ... 另有 " + (changes.length - 30) + " 条");

if (!APPLY) {
  console.log("");
  console.log("以上为预演, 未改动任何文件。确认无误后执行: node tools/rejudge_events.js --apply");
} else if (changes.length) {
  // 锁内重读最新内容再按键合并: 服务可能在这期间刚写入了新事件, 直接按旧下标写会把它覆盖掉
  const want = {};
  for (const c of changes) want[c.key] = c.after;
  let applied = 0, missed = 0, bak = "";
  (async function () {
    const r = await store.updateJson(FILE, function (fresh) {
      for (const e of fresh) {
        if (!isAiRecord(e)) continue;
        const k = keyOf(e);
        if (want[k] === undefined) continue;
        if ((e.person === true) === want[k]) { missed++; continue; }   // 已被服务改过, 不再重复计入
        e.person = want[k];
        applied++;
      }
      if (!applied) return false; // 无需改动, 不写盘也不备份
      bak = FILE + ".bak." + Date.now();
      fs.copyFileSync(FILE, bak); // 备份与将要修改的内容完全一致(就在锁内取)
      return true;
    }, { lockTimeoutMs: 15000 });
    console.log("");
    if (!r.ok) {
      console.error("写盘失败(未拿到 events.json 锁或写入出错), 文件未改动。请稍后重试。");
      process.exitCode = 1;
    } else if (!r.written) {
      console.log("无需修正, 未改动文件。");
    } else {
      console.log("已修正 " + applied + " 条" + (missed ? " (" + missed + " 条已被服务改动, 跳过)" : "") + "; 原文件备份在 " + path.basename(bak));
      console.log("提示: 三个服务的内存状态不影响本次结果(它们改动时会重新读盘)。");
    }
  })();
} else {
  console.log("");
  console.log("无需修正, 未改动文件。");
}
