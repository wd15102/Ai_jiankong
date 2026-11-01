// tools/clean_noimage.js — 清理 events.json 中没有截图(file 为空串)的记录
//
// 2026-10-08 重写。原版有两个高危问题(审查发现):
//   ① **无预演直接写盘**: 同目录其它工具(sweep_captures / repair_noimage_events / rejudge_events /
//      recheck_events / backfill_veh_pushlog)全部是"默认预演 + --apply 写盘 + 备份"三件套,
//      只有这个直接改生产数据, 没有确认也没有备份。
//   ② **会静默截断历史**: 它调 updateEvents 时没传 opts, 走 store.js 的默认 cap=20000;
//      而生产 config.json 配的是 eventRetention: -1(不限制)。当前记录数没到 20000 所以没暴露,
//      一旦超过就跑这个工具会把最早的历史悄悄裁掉 —— 而用户明明配了"不限制"。
//      现在显式传 { cap: eventCap(cfg) }, 与其它工具对齐。
//
// 用法:
//   node tools/clean_noimage.js            # 预演, 只报数量
//   node tools/clean_noimage.js --apply    # 实际写盘(先自动备份)
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..");
const { updateEvents, eventCap } = require("../lib/store");

const APPLY = process.argv.includes("--apply");
const CFG = (function () {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8")); }
  catch (e) { return {}; }
})();
const CAP = eventCap(CFG);

(async function () {
  let preview = null;
  // 第一遍: 锁内重读 + 只统计, 不写盘(mutate 返回 false = 无改动)
  const r0 = await updateEvents(ROOT, function (arr) {
    const noImg = arr.filter(function (e) { return !e.file; });
    preview = { total: arr.length, noImg: noImg.length, cap: CAP };
    return false;
  }, { cap: CAP });
  if (!r0.ok) {
    console.error("读取失败: " + (r0.error && r0.error.message));
    process.exit(1);
  }
  console.log("events.json 共 " + preview.total + " 条, 其中无截图 " + preview.noImg + " 条");
  console.log("保留条数上限 cap = " + (CAP > 0 ? CAP : "不限制(eventRetention=-1)"));
  if (preview.noImg === 0) {
    console.log("无需清理");
    return;
  }
  if (!APPLY) {
    console.log("\n这是预演。加 --apply 才会真正写盘。");
    console.log("将删除 " + preview.noImg + " 条无截图记录(注意: 这些是 file=\"\" 的历史记录,");
    console.log("删掉后看板/历史页里就查不到它们了)。");
    return;
  }

  // 写盘前备份(全量, 便于误删后回滚)
  const src = path.join(ROOT, "data", "events.json");
  const bak = path.join(ROOT, "data", "events.json.bak.clean_noimage." + Date.now());
  try { fs.copyFileSync(src, bak); console.log("已备份 -> " + path.basename(bak)); }
  catch (e) { console.error("备份失败, 中止: " + e.message); process.exit(1); }

  const r = await updateEvents(ROOT, function (arr) {
    const next = arr.filter(function (e) { return !!e.file; });
    if (next.length === arr.length) return false;
    return next;
  }, { cap: CAP }); // cap 显式传入, 不让默认 20000 截断用户配的"不限制"
  console.log(r.ok && r.written ? "清理完成, 剩余 " + (r.value ? r.value.length : "?") + " 条"
                                  : (r.ok ? "无需清理" : "清理失败: " + (r.error && r.error.message)));
  if (!r.ok) process.exit(1);
})().catch(function (e) { console.error("错误:", e); process.exit(1); });