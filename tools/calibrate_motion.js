// tools/calibrate_motion.js — 本地人形检测阈值批量校准
// 用法: node tools/calibrate_motion.js [maxEvents]
// 用 events.json 的 AI 结论做真值标签, 批量跑 motiondetect.analyzePair,
// 输出人形 vs 非人的 blob 特征分布 + 最优阈值推荐 + 当前精度/召回率
const fs = require("fs");
const path = require("path");
const md = require("../lib/motiondetect");
const { judgePerson } = require("../lib/judge");

const ROOT = path.resolve(__dirname, "..");
const CAPTURE_DIR = path.join(ROOT, "captures");
const MAX_EVENTS = parseInt(process.argv[2], 10) || 500;

(async function() {
// ---- 加载数据 ----
let events = [];
try { events = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "events.json"), "utf8")); }
catch (e) { console.error("无法加载 events.json:", e.message); process.exit(1); }

// ---- 真值判定规则 ----
// 优先用 AI 结论文本判断, 不直接用 person 字段(因为 person 可能被本地检测提前置 true)
function labelEvent(e) {
  if (!e.file) return null; // 无截图, 跳过
  const aiTxt = String(e.ai || "");
  const j = judgePerson(aiTxt);
  // 明确有人: AI 判有人 且 描述里有清晰的人体描述(非"模糊的人影"/"人形轮廓"这类模糊词)
  if (j.matched && j.person) {
    const hasClearHuman = /(头部|躯干|四肢|行走|站立|蹲|坐|骑车|驾驶|衣服|头盔|帽子|老人|小孩|男子|女子|男人|女人)/.test(aiTxt);
    const vagueOnly = /(模糊的人影|人形大小的目标|类似人形|人形的轮廓)/.test(aiTxt);
    if (hasClearHuman && !vagueOnly) return "person";
    if (hasClearHuman && vagueOnly) return "person"; // 有清晰描述即使同时有模糊词也算有人
    if (vagueOnly) return "vague"; // 纯模糊描述(可能是阴影/反光误报), 单独分类
    // AI说有人但无明显人体描述 且不是模糊词 -> 仍归为有人(可能是简短结论)
    return "person";
  }
  // 明确无人: AI 判无人
  if (j.matched && !j.person) return "empty";
  // 无法解析: 跳过
  return null;
}

// 找与目标文件同设备的参考图
function findRefFor(fileName) {
  // 从文件名提取 serial: BK2385850_p1790401471244.jpg -> BK2385850
  const serial = fileName.split("_")[0];
  if (!serial) return null;
  const refGray = md.loadRef(ROOT, serial);
  return refGray ? { serial, ref: refGray } : null;
}

// ---- 主流程 ----
console.log("=== 本地人形检测阈值校准 ===\n");
console.log("事件总数: " + events.length);

// 分类统计
const labeled = [];
let personCount = 0, emptyCount = 0, vagueCount = 0, skipCount = 0;
for (const e of events) {
  const label = labelEvent(e);
  if (!label) { skipCount++; continue; }
  // 检查截图文件是否存在
  const fp = path.join(CAPTURE_DIR, e.file);
  if (!fs.existsSync(fp)) { skipCount++; continue; }
  // 检查同设备参考图
  const refInfo = findRefFor(e.file);
  if (!refInfo) { skipCount++; continue; }
  labeled.push({ event: e, label, file: fp, serial: refInfo.serial, ref: refInfo.ref });
  if (label === "person") personCount++;
  else if (label === "empty") emptyCount++;
  else if (label === "vague") vagueCount++;
}

console.log("有明确标签: person=" + personCount + " empty=" + emptyCount + " vague(模糊)=" + vagueCount + " 跳过=" + skipCount);

// 采样(均匀覆盖 person/empty/vague)
const sample = [];
const maxPerLabel = Math.ceil(MAX_EVENTS / 3);
for (const lab of ["person", "empty", "vague"]) {
  const pool = labeled.filter(l => l.label === lab);
  // 按时间均匀采样
  const step = Math.max(1, Math.floor(pool.length / Math.min(maxPerLabel, pool.length)));
  for (let i = 0; i < pool.length; i += step) {
    sample.push(pool[i]);
    if (sample.filter(s => s.label === lab).length >= maxPerLabel) break;
  }
}
console.log("采样数: " + sample.length + " (person=" + sample.filter(s => s.label === "person").length +
  " empty=" + sample.filter(s => s.label === "empty").length +
  " vague=" + sample.filter(s => s.label === "vague").length + ")\n");

// ---- 批量分析 ----
const results = [];
let done = 0;
console.log("正在分析...");
for (const s of sample) {
  try {
    const r = await md.analyzePair(s.file, s.ref);
    // top blob 特征
    if (r.top) {
      results.push({
        label: s.label,
        serial: s.serial,
        file: path.basename(s.file),
        area: r.top.area / md.PX0,         // 归一化面积
        aspect: r.top.aspect,
        fill: r.top.fill,
        edgeRatio: r.top.edgeRatio || 0,
        blobCount: r.blobs,
        diffRatio: r.ratio,
        personLike: r.personLike
      });
    } else if (!r.skipped) {
      // 有差异但无 blob 通过 MIN_BLOB 筛选
      results.push({
        label: s.label,
        serial: s.serial,
        file: path.basename(s.file),
        area: 0, aspect: 0, fill: 0, edgeRatio: 0,
        blobCount: r.blobs || 0,
        diffRatio: r.ratio,
        personLike: false
      });
    }
    // skipped (lighting/noref) 跳过
  } catch (e) {
    // 解码失败等, 跳过
  }
  done++;
  if (done % 50 === 0) process.stdout.write("\r已分析: " + done + "/" + sample.length);
}
console.log("\r已分析: " + done + "/" + sample.length + " 有效结果: " + results.length + "\n");

// ---- 统计分析 ----
const personResults = results.filter(r => r.label === "person");
const emptyResults = results.filter(r => r.label === "empty");
const vagueResults = results.filter(r => r.label === "vague");

function stats(arr, key) {
  const vals = arr.map(r => r[key]).filter(v => v > 0).sort((a, b) => a - b);
  if (!vals.length) return { count: 0 };
  const sum = vals.reduce((a, b) => a + b, 0);
  const mean = sum / vals.length;
  const p50 = vals[Math.floor(vals.length * 0.5)];
  const p25 = vals[Math.floor(vals.length * 0.25)];
  const p75 = vals[Math.floor(vals.length * 0.75)];
  return { count: vals.length, min: vals[0], max: vals[vals.length - 1], mean, p25, p50, p75 };
}

function printStats(label, arr, key, unit) {
  const s = stats(arr, key);
  if (!s.count) { console.log("  " + label + ": (无数据)"); return; }
  console.log("  " + label + " (n=" + s.count + "): " +
    s.p25.toFixed(3) + " / " + s.p50.toFixed(3) + " / " + s.p75.toFixed(3) +
    " (p25/p50/p75) 范围 " + s.min.toFixed(3) + "-" + s.max.toFixed(3) + " 均值 " + s.mean.toFixed(3) + (unit || ""));
}

console.log("=== 特征分布 (有人 vs 无人 vs 模糊) ===\n");

// 只统计有 blob 命中(results with area>0 means a blob was found)
const personHits = personResults.filter(r => r.area > 0);
const emptyHits = emptyResults.filter(r => r.area > 0);
const vagueHits = vagueResults.filter(r => r.area > 0);

console.log("--- 竖直边缘密度(edgeRatio) 当前阈值: 0.25 ---");
printStats("有人(person)", personHits, "edgeRatio");
printStats("无人(empty)", emptyHits, "edgeRatio");
printStats("模糊(vague)", vagueHits, "edgeRatio");
console.log();

console.log("--- 填充率(fill) 当前阈值: 0.30 ---");
printStats("有人(person)", personHits, "fill");
printStats("无人(empty)", emptyHits, "fill");
printStats("模糊(vague)", vagueHits, "fill");
console.log();

console.log("--- 面积占比(area) 当前阈值: 0.008-0.08 ---");
printStats("有人(person)", personHits, "area");
printStats("无人(empty)", emptyHits, "area");
printStats("模糊(vague)", vagueHits, "area");
console.log();

console.log("--- 高宽比(aspect) 当前阈值: 0.75-2.0 ---");
printStats("有人(person)", personHits, "aspect");
printStats("无人(empty)", emptyHits, "aspect");
printStats("模糊(vague)", vagueHits, "aspect");
console.log();

console.log("--- 帧差异占比(diffRatio) ---");
printStats("有人(person)", personResults, "diffRatio");
printStats("无人(empty)", emptyResults, "diffRatio");
printStats("模糊(vague)", vagueResults, "diffRatio");
console.log();

// ---- 当前精度 ----
console.log("=== 当前阈值下的检测精度 ===");
const curTP = personHits.filter(r => r.personLike).length;
const curFN = personHits.filter(r => !r.personLike).length;
const curFP = emptyHits.filter(r => r.personLike).length;
const curTN = emptyHits.filter(r => !r.personLike).length;
const curTotal = curTP + curFN + curFP + curTN;
if (curTotal > 0) {
  const precision = curTP / (curTP + curFP || 1);
  const recall = curTP / (curTP + curFN || 1);
  const f1 = 2 * precision * recall / (precision + recall || 1);
  console.log("TP(命中有人)=" + curTP + " FN(漏检)=" + curFN +
    " FP(误报)=" + curFP + " TN(正确无人)=" + curTN);
  console.log("准确率(Precision)=" + (precision * 100).toFixed(1) + "%  召回率(Recall)=" + (recall * 100).toFixed(1) +
    "%  F1=" + (f1 * 100).toFixed(1) + "%");
}
console.log();

// ---- 模糊类(vague)的命中分析 ----
const vagueHitsPersonLike = vagueHits.filter(r => r.personLike);
console.log("=== 模糊描述类(vague) 分析 ===");
console.log("vague样本命中人形: " + vagueHitsPersonLike.length + "/" + vagueHits.length +
  " (" + (vagueHitsPersonLike.length / Math.max(1, vagueHits.length) * 100).toFixed(1) + "%)");
if (vagueHitsPersonLike.length) {
  const vp = vagueHitsPersonLike;
  console.log("  边缘密度 " + stats(vp, "edgeRatio").p50.toFixed(3) +
    " 填充 " + stats(vp, "fill").p50.toFixed(3) +
    " 面积 " + stats(vp, "area").p50.toFixed(3));
}
console.log();

// ---- 网格搜索最优阈值 ----
console.log("=== 网格搜索最优阈值 ===");

// 用 person vs empty (排除 vague) 做训练集
const train = [...personHits, ...emptyHits];
const yTrue = [...personHits.map(() => 1), ...emptyHits.map(() => 0)];

function gridSearch() {
  // 主要调整 edgeRatio 阈值(这是区分人vs光影的关键)
  const edgeCandidates = [];
  for (let e = 0.15; e <= 0.50; e += 0.01) edgeCandidates.push(e);
  const fillCandidates = [];
  for (let f = 0.15; f <= 0.50; f += 0.02) fillCandidates.push(f);

  let bestF1 = -1, bestEdge = 0, bestFill = 0.30, bestTP = 0, bestFP = 0, bestFN = 0;

  for (const edgeTh of edgeCandidates) {
    for (const fillTh of fillCandidates) {
      let tp = 0, fp = 0, fn = 0;
      for (let i = 0; i < train.length; i++) {
        const r = train[i];
        // 用当前网格的阈值重判
        const areaPct = r.area;
        const passes = areaPct >= 0.008 && areaPct <= 0.08 &&
          r.aspect >= 0.75 && r.aspect <= 2.0 &&
          r.fill >= fillTh &&
          r.edgeRatio >= edgeTh;
        if (yTrue[i] === 1) { if (passes) tp++; else fn++; }
        else { if (passes) fp++; }
      }
      const prec = tp / (tp + fp || 1);
      const rec = tp / (tp + fn || 1);
      const f1 = 2 * prec * rec / (prec + rec || 1);
      if (f1 > bestF1) {
        bestF1 = f1; bestEdge = edgeTh; bestFill = fillTh;
        bestTP = tp; bestFP = fp; bestFN = fn;
      }
    }
  }
  return { edge: bestEdge, fill: bestFill, f1: bestF1, tp: bestTP, fp: bestFP, fn: bestFN, candidates: edgeCandidates };
}

const best = gridSearch();
const edgeCandidates = best.candidates;
console.log("最优 edgeRatio: " + best.edge.toFixed(2) + " (当前: 0.25)");
console.log("最优 fill: " + best.fill.toFixed(2) + " (当前: 0.30)");
console.log("最优时 TP=" + best.tp + " FP=" + best.fp + " FN=" + best.fn +
  " F1=" + (best.f1 * 100).toFixed(1) + "%");

// 仅在 edgeRatio 维度上的最优
console.log("\n--- 仅调 edgeRatio (保持 fill=0.30) ---");
let bestEdgeOnly = -1, bestEdgeF1 = -1, bestEdgeTP = 0, bestEdgeFP = 0, bestEdgeFN = 0;
for (const edgeTh of edgeCandidates) {
  let tp = 0, fp = 0, fn = 0;
  for (let i = 0; i < train.length; i++) {
    const r = train[i];
    const passes = r.area >= 0.008 && r.area <= 0.08 &&
      r.aspect >= 0.75 && r.aspect <= 2.0 &&
      r.fill >= 0.30 &&
      r.edgeRatio >= edgeTh;
    if (yTrue[i] === 1) { if (passes) tp++; else fn++; }
    else { if (passes) fp++; }
  }
  const prec = tp / (tp + fp || 1);
  const rec = tp / (tp + fn || 1);
  const f1 = 2 * prec * rec / (prec + rec || 1);
  if (f1 > bestEdgeF1) {
    bestEdgeF1 = f1; bestEdgeOnly = edgeTh; bestEdgeTP = tp; bestEdgeFP = fp; bestEdgeFN = fn;
  }
}
console.log("最优 edgeRatio: " + bestEdgeOnly.toFixed(2));
console.log("TP=" + bestEdgeTP + " FP=" + bestEdgeFP + " FN=" + bestEdgeFN +
  " F1=" + (bestEdgeF1 * 100).toFixed(1) + "%");

// 针对 FP 的最优(最小化误报, 同时维持 recall >= 0.7)
console.log("\n--- 最小化误报(recall ≥ 70%) ---");
let minFpEdge = 0.25, minFpCount = Infinity;
for (const edgeTh of edgeCandidates) {
  let tp = 0, fp = 0, fn = 0;
  for (let i = 0; i < train.length; i++) {
    const r = train[i];
    const passes = r.area >= 0.008 && r.area <= 0.08 &&
      r.aspect >= 0.75 && r.aspect <= 2.0 &&
      r.fill >= 0.30 &&
      r.edgeRatio >= edgeTh;
    if (yTrue[i] === 1) { if (passes) tp++; else fn++; }
    else { if (passes) fp++; }
  }
  const rec = tp / (tp + fn || 1);
  if (rec >= 0.7 && fp < minFpCount) {
    minFpCount = fp; minFpEdge = edgeTh;
  }
}
console.log("edgeRatio=" + minFpEdge.toFixed(2) + " 时误报最少(recall≥70%)");

// ---- 按设备分组统计 ----
console.log("\n=== 按设备分组(有人 vs 无人) ===");
const serials = [...new Set(results.map(r => r.serial))];
for (const s of serials) {
  const p = personHits.filter(r => r.serial === s);
  const e = emptyHits.filter(r => r.serial === s);
  const v = vagueHits.filter(r => r.serial === s);
  console.log(s + ": person=" + p.length + " empty=" + e.length + " vague=" + v.length);
  if (e.length) {
    const fp = e.filter(r => r.personLike).length;
    console.log("  无人但命中(误报): " + fp + "/" + e.length + " (" + (fp / e.length * 100).toFixed(1) + "%)");
    if (fp > 0) {
      const fpHits = e.filter(r => r.personLike);
      console.log("  误报特征: edgeRatio " + stats(fpHits, "edgeRatio").p50.toFixed(3) +
        " fill " + stats(fpHits, "fill").p50.toFixed(3) +
        " area " + stats(fpHits, "area").p50.toFixed(3) +
        " diffRatio " + stats(fpHits, "diffRatio").p50.toFixed(3));
    }
  }
}

// 保存原始数据到 CSV
const csvPath = path.join(ROOT, "data", "calibration_results.csv");
let csv = "label,serial,file,area,aspect,fill,edgeRatio,diffRatio,personLike\n";
for (const r of results) {
  csv += [r.label, r.serial, r.file, r.area.toFixed(5), r.aspect.toFixed(3), r.fill.toFixed(3),
    r.edgeRatio.toFixed(3), r.diffRatio.toFixed(4), r.personLike ? 1 : 0].join(",") + "\n";
}
fs.writeFileSync(csvPath, csv);
console.log("\n原始数据已保存: " + csvPath);
console.log("=== 校准完成 ===");
})().catch(function(e) { console.error("校准失败:", e.message); process.exit(1); });