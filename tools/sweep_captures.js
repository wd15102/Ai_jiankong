#!/usr/bin/env node
// 存量"孤儿抓图"清理: 删掉 captures/ 里没有任何 events.json 记录引用的抓图。
//
// 背景: 改造前所有截图(含高频的普通移动侦测)都平铺在 captures/, 其中约 96% 下载之后
// 再无任何记录引用 —— 看板、历史、日报里都查不到, 却白占磁盘(实测 11261/11692 = 638MB)。
// 改造后移动侦测图改存 captures/motion/ 并按小时回收(见 webhook.js 的分级留存),
// 这个工具用来一次性收掉改造之前留下的历史存量。
//
// 用法:
//   node tools/sweep_captures.js                    # 预演(默认), 只报告会删多少、能释放多少
//   node tools/sweep_captures.js --apply            # 实际删除(删除清单留档到 data/sweep_removed_*.txt)
//   node tools/sweep_captures.js --protect-hours=24 # 放宽保护期, 默认 3 小时
//
// 安全约束:
//   1. 默认只预演, 必须显式 --apply 才动文件; 删除前先把完整清单落盘, 事后可追溯。
//   2. 只处理 captures/ 根目录下命名形如 {serial}_{ms}.jpg / {serial}_p{ms}.jpg 的抓图。
//   3. motion/ 子目录与 thumb_*.jpg 缩略图一律不碰(缩略图交给 webhook 的定期清理)。
//   4. 保护期内的图不动 —— 它们可能正在被"同一次活动垫图"复用(垫图窗口是事件前后 2 分钟)。
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CAPTURE_DIR = path.join(ROOT, "captures");
const EVENTS = path.join(ROOT, "data", "events.json");

const APPLY = process.argv.indexOf("--apply") >= 0;
const protectArg = process.argv.filter(function (a) { return a.indexOf("--protect-hours=") === 0; })[0];
const PROTECT_HOURS = protectArg ? Number(protectArg.split("=")[1]) : 3;

// 抓图命名: {serial}_{毫秒}.jpg(现场抓图) / {serial}_p{毫秒}.jpg(报警自带截图) / {serial}_a{毫秒}.jpg(补录截图)
const CAP_RE = /^[A-Za-z0-9]+_[pa]?\d{10,}\.jpg$/i;

function mb(n) { return (n / 1048576).toFixed(1) + " MB"; }
function dayOf(ms) {
  const d = new Date(ms);
  return ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
}

function readRefs() {
  let arr;
  try { arr = JSON.parse(fs.readFileSync(EVENTS, "utf8")); }
  catch (e) { console.error("读取 events.json 失败, 已中止: " + e.message); process.exit(1); }
  if (!Array.isArray(arr)) { console.error("events.json 内容不是数组, 已中止"); process.exit(1); }
  const ref = new Set();
  for (const e of arr) if (e && e.file) ref.add(String(e.file));
  return { ref: ref, total: arr.length };
}

(function main() {
  const { ref, total } = readRefs();
  const hours = (isFinite(PROTECT_HOURS) && PROTECT_HOURS > 0) ? PROTECT_HOURS : 3;
  const cutoff = Date.now() - hours * 3600e3;

  let names;
  try { names = fs.readdirSync(CAPTURE_DIR); }
  catch (e) { console.error("captures/ 不可读: " + e.message); process.exit(1); }

  let totalCount = 0, totalBytes = 0;
  let refCount = 0, refBytes = 0;
  let orphanCount = 0, orphanBytes = 0;
  const purge = [], shielded = [], ignored = [];

  for (const name of names) {
    const fp = path.join(CAPTURE_DIR, name);
    let st;
    try { st = fs.statSync(fp); } catch (e) { continue; }
    if (!st.isFile()) continue;                       // motion/ 子目录
    if (!/\.jpe?g$/i.test(name)) continue;
    totalCount++; totalBytes += st.size;

    if (ref.has(name)) { refCount++; refBytes += st.size; continue; }   // 有记录引用: 保留
    if (name.indexOf("thumb_") === 0 || !CAP_RE.test(name)) { ignored.push(name); continue; } // 缩略图等非抓图命名: 不碰

    orphanCount++; orphanBytes += st.size;
    if (st.mtimeMs > cutoff) shielded.push({ name: name, size: st.size, m: st.mtimeMs });
    else purge.push({ name: name, size: st.size, m: st.mtimeMs });
  }

  const purgeBytes = purge.reduce(function (a, x) { return a + x.size; }, 0);

  console.log("=== 存量孤儿抓图清理 ===");
  console.log("模式      : " + (APPLY ? "实际删除(--apply)" : "预演(不会动任何文件)"));
  console.log("保护期    : 最近 " + hours + " 小时内的图跳过(可能正被垫图复用)");
  console.log("");
  console.log("captures/ 根目录 jpg 合计 = " + totalCount + "  (" + mb(totalBytes) + ")");
  console.log("  被 events.json 引用      = " + refCount + "  (" + mb(refBytes) + ")   [保留]");
  console.log("  孤儿(无任何引用)         = " + orphanCount + "  (" + mb(orphanBytes) + ")" +
    (totalCount ? "   占 " + (orphanCount / totalCount * 100).toFixed(1) + "%" : ""));
  console.log("    可立即清理             = " + purge.length + "  (" + mb(purgeBytes) + ")");
  console.log("    保护期内跳过           = " + shielded.length);
  console.log("    非抓图命名跳过         = " + ignored.length + (ignored.length ? "  (thumb_*.jpg 等)" : ""));
  console.log("");

  if (purge.length) {
    const byDay = {};
    for (const x of purge) { const k = dayOf(x.m); byDay[k] = (byDay[k] || 0) + 1; }
    console.log("可清理抓图的日期分布(最多显示 12 天):");
    Object.keys(byDay).sort().slice(-12).forEach(function (k) {
      console.log("  " + k + "   " + String(byDay[k]).padStart(5) + " 张");
    });
    console.log("");
  }

  if (!APPLY) {
    console.log("以上为预演, 未改动任何文件。");
    if (purge.length) console.log("确认无误后执行: node tools/sweep_captures.js --apply");
    else console.log("没有可清理的文件。");
    console.log("提示: 删掉的只是「看板 / 历史 / 日报里都查不到」的图; 想更保守可用 --protect-hours=24。");
    return;
  }

  if (!purge.length) { console.log("没有可清理的文件, 未做任何改动。"); return; }

  const listFile = path.join(ROOT, "data", "sweep_removed_" + Date.now() + ".txt");
  try {
    fs.writeFileSync(listFile,
      "# 本次删除的孤儿抓图清单 (共 " + purge.length + " 个, " + mb(purgeBytes) + ")\n" +
      "# 生成时间: " + new Date().toLocaleString("zh-CN", { hour12: false }) + "\n" +
      purge.map(function (x) { return x.name + "\t" + new Date(x.m).toLocaleString("zh-CN", { hour12: false }); }).join("\n") + "\n");
  } catch (e) {
    console.error("清单写入失败, 为安全起见已中止(未删除任何文件): " + e.message);
    process.exit(1);
  }

  let removed = 0, freed = 0, failed = 0;
  for (const x of purge) {
    try { fs.unlinkSync(path.join(CAPTURE_DIR, x.name)); removed++; freed += x.size; }
    catch (e) { failed++; }
  }
  console.log("已删除 " + removed + " 个孤儿抓图, 释放 " + mb(freed) + (failed ? ", 失败 " + failed + " 个(被占用, 可再跑一次)" : ""));
  console.log("删除清单留档: " + path.relative(ROOT, listFile));
  console.log("");
  console.log("提示: 三个服务无需重启; 之后新产生的抓图由 webhook 的分级清理自动维护。");
})();
