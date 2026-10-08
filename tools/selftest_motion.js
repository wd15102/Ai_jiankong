// tools/selftest_motion.js — 用真实图片自测本地人形检测 + 静态伪影复核
// 用法: node tools/selftest_motion.js [serial]
// 目标: 验证 (1) 真有人能被检出 (2) 同一位置的持续伪影(水塘反光/杂物)第二次被拦截
const fs = require("fs");
const path = require("path");
const md = require("../lib/motiondetect");

const ROOT = path.resolve(__dirname, "..");
const MOTION_DIR = path.join(ROOT, "captures", "motion");
const CAPTURE_DIR = path.join(ROOT, "captures");
const serial = process.argv[2] || "BG6569629";

// 按时间戳排序(文件名 serial_p<ms>.jpg)
function sortByTs(files) {
  return files.sort(function (a, b) {
    const ta = Number(a.slice(serial.length + 2, -4));
    const tb = Number(b.slice(serial.length + 2, -4));
    return ta - tb;
  });
}

(async function() {
  console.log("=== 自测: 本地人形检测 + 静态伪影复核 (设备 " + serial + ") ===\n");

  // 收集 motion 垫图
  let motionFiles = [];
  try { motionFiles = fs.readdirSync(MOTION_DIR).filter(f => f.indexOf(serial + "_") === 0 && /\.jpe?g$/i.test(f)); } catch (e) {}
  sortByTs(motionFiles);
  console.log("motion/ 垫图: " + motionFiles.length + " 张");

  // 收集 captures 主目录图(可能含高清截图)
  let capFiles = [];
  try { capFiles = fs.readdirSync(CAPTURE_DIR).filter(f => f.indexOf(serial + "_") === 0 && f.indexOf("thumb_") !== 0 && /\.jpe?g$/i.test(f)); } catch (e) {}
  sortByTs(capFiles);
  console.log("captures/ 主目录图: " + capFiles.length + " 张\n");

  // 备份并清空命中状态, 模拟"全新启动"
  const hitStatePath = path.join(ROOT, "data", "personhit", serial + ".json");
  let hitStateBackup = null;
  try { hitStateBackup = fs.readFileSync(hitStatePath, "utf8"); } catch (e) {}
  try { fs.rmSync(hitStatePath); } catch (e) {}
  console.log("已清空命中状态(原状态" + (hitStateBackup ? "已备份" : "无") + "), 开始自测...\n");

  // 用 motion 垫图按时间顺序跑完整 analyze 生命周期
  console.log("--- 用 motion/ 垫图按时间顺序测试 ---");
  let personHits = 0, staticHits = 0, nonPerson = 0, skipped = 0;
  let prevTop = null;

  for (let i = 0; i < motionFiles.length; i++) {
    const f = motionFiles[i];
    const filePath = path.join(MOTION_DIR, f);
    const r = await md.analyze(ROOT, serial, filePath);

    if (r.skipped) {
      skipped++;
      console.log("  [" + f.slice(serial.length + 2, -4) + "] " + r.skipped);
    } else if (r.personLike) {
      personHits++;
      const top = r.top;
      const pos = "质心(" + top.cx.toFixed(0) + "," + top.cy.toFixed(0) + ")";
      const prevPos = prevTop ? " 上次质心(" + prevTop.cx.toFixed(0) + "," + prevTop.cy.toFixed(0) + ")" : "";
      console.log("  [" + f.slice(serial.length + 2, -4) + "] ★命中人形 面积" + (top.area / md.PX0 * 100).toFixed(1) +
        "% 高宽比" + top.aspect.toFixed(2) + " 填充" + top.fill.toFixed(2) + " 边缘" + top.edgeRatio.toFixed(2) + " " + pos + prevPos);
      prevTop = top;
    } else if (r.staticArtifact) {
      staticHits++;
      console.log("  [" + f.slice(serial.length + 2, -4) + "] ★静态伪影(同位置反复命中,已拦截) 差异" + (r.ratio * 100).toFixed(1) + "%");
      prevTop = null;
    } else {
      nonPerson++;
      const extra = r.refUpdated ? " [参考图已刷新]" : "";
      console.log("  [" + f.slice(serial.length + 2, -4) + "] 非人(差异" + (r.ratio * 100).toFixed(1) + "%" + extra + ")");
      prevTop = null;
    }
  }

  console.log("\n=== motion/ 垫图统计 ===");
  console.log("命中人形: " + personHits + " | 静态伪影拦截: " + staticHits + " | 非人: " + nonPerson + " | 跳过: " + skipped);

  // 恢复命中状态
  if (hitStateBackup !== null) {
    try { fs.mkdirSync(path.dirname(hitStatePath), { recursive: true }); fs.writeFileSync(hitStatePath, hitStateBackup); } catch (e) {}
    console.log("已恢复原命中状态");
  }

  // 额外: 用已知真值图片做单帧验证(用 analyzePair, 不改状态)
  console.log("\n=== 用已知真值图片做单帧验证 ===");
  console.log("(通过 events.json 的 AI 结论确认真值)");

  const events = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "events.json"), "utf8"));
  const refGray = md.loadRef(ROOT, serial);
  if (!refGray) { console.log("无参考图, 跳过"); return; }

  // 找该设备最近的"本地算法"事件
  const localEvts = events.filter(e => e.serial === serial && (e.provider || "").indexOf("本地算法") >= 0 && e.file);
  console.log("该设备本地算法事件: " + localEvts.length + " 条\n");

  let verified = 0;
  for (const e of localEvts.slice(0, 8)) {
    const fp = path.join(CAPTURE_DIR, e.file);
    if (!fs.existsSync(fp)) continue;
    try {
      const r = await md.analyzePair(fp, refGray);
      const top = r.top;
      const aiShort = String(e.ai || "").replace(/\s+/g, " ").slice(0, 45);
      let verdict = "无blob";
      if (top) {
        verdict = "blob:面积" + (top.area / md.PX0 * 100).toFixed(1) + "% 边缘" + top.edgeRatio.toFixed(2) +
          " 填充" + top.fill.toFixed(2) + " 质心(" + top.cx.toFixed(0) + "," + top.cy.toFixed(0) + ")";
      }
      const aiPerson = /有人/.test(e.ai) && !/无人.*有人|zhipu:无人/.test(e.ai);
      const label = e.person ? "真值:有人" : "真值:无人";
      console.log("  " + e.time + " " + label + " | 本地" + (r.personLike ? "命中" : "未中") + " | " + verdict);
      console.log("      AI: " + aiShort);
      verified++;
    } catch (err) {
      console.log("  " + e.file + " 分析失败: " + err.message.slice(0, 50));
    }
  }
  console.log("\n已验证 " + verified + " 张真值图片");
  console.log("=== 自测完成 ===");
})().catch(function(e) { console.error("自测失败:", e); process.exit(1); });
