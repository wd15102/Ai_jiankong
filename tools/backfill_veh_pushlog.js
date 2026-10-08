#!/usr/bin/env node
// 回填历史「车辆检测」分类: 把 push_log.json 中"本地车辆算法命中过"的移动侦测条目改写为 SmartVehicleDet,
// 让 webapp 看板的「萤石推送记录 → 车辆检测」分类能看到历史记录。
//
// 背景: webhook.js 的 patchPushLog 曾因 acquire() 用外层 resolve 传结果(run 永远拿到 undefined)
// 导致改写从未成功过(2026-09-29 修复): 历史上 151 次车辆命中在 push_log 里全部还是 motiondetect。
// 本工具按「同设备 + 报警时间±5秒」把 events.json 里 veh=1 的事件映射回 push_log 的移动侦测条目。
// 只改移动侦测(motiondetect/10002)条目 —— 人形/智能标签条目即使时间匹配也不动, 与线上 patchPushLog 行为一致。
//
// 用法:
//   node tools/backfill_veh_pushlog.js          # 预演: 只打印将改动的条目, 不写盘
//   node tools/backfill_veh_pushlog.js --apply  # 实际写盘(自动备份 push_log.json, 与 webhook 共用文件锁协议)
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const APPLY = process.argv.indexOf("--apply") >= 0;
const PUSH_LOG = path.join(ROOT, "data", "push_log.json");
const EVENTS = path.join(ROOT, "data", "events.json");

function readJson(f, fallback) {
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return fallback; }
}
// 报警时间归一为毫秒: 数字(秒/毫秒)或 ISO 字符串(萤石推送实测 "2026-09-25T19:10:59" 本地时间, 秒级精度)
function alarmTsOf(v) {
  if (v === undefined || v === null || v === "") return 0;
  const n = Number(v);
  if (isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? 0 : d.getTime();
}
function parseBody(e) {
  let body = e.body;
  try {
    if (typeof body === "string") body = JSON.parse(body);
    if (body && body.body) body = body.body;
  } catch (err) { return null; }
  return body && typeof body === "object" ? body : null;
}
// 匹配 + 收集待改写条目。返回 { scanned, already, hits, usedEvents, pending }
// pending[i] = { entry, body, wasString }: entry 是 push_log 数组元素, body 是解析后的内层对象
function matchAndCollect(logs, vehEvents) {
  const used = new Set();
  const pending = [];
  let scanned = 0, already = 0, hits = 0;
  for (const e of logs) {
    if (!e || !e.body) continue;
    const body = parseBody(e);
    if (!body) continue;
    const rawType = String(body.alarmType || body.type || body.eventType || body.msgType || body.identifier || body.messageType || "");
    if (/smartvehicle|vehicledet|cardet/i.test(rawType)) { already++; continue; } // 已是车辆分类(幂等)
    if (!/^(motiondetect|10002)$/i.test(rawType)) continue; // 只改移动侦测条目
    scanned++;
    const serial = String(body.devSerial || body.serial || body.deviceSerial || body.deviceId || "");
    const alarmTs = alarmTsOf(body.alarmTime || body.time) || Number(e.ts) || 0;
    if (!serial || !alarmTs) continue;
    let matched = null;
    for (const ev of vehEvents) {
      if (used.has(ev)) continue;
      if (ev.serial !== serial) continue;
      if (Math.abs((ev.ts || 0) - alarmTs) <= 5000) { matched = ev; break; }
    }
    if (!matched) continue;
    used.add(matched);
    hits++;
    pending.push({ entry: e, body: body, wasString: typeof e.body === "string", ev: matched });
  }
  return { scanned: scanned, already: already, hits: hits, usedEvents: used, pending: pending };
}
function printReport(logs, r) {
  console.log("push_log 总条数          : " + logs.length);
  console.log("移动侦测条目             : " + r.scanned + "  (已是车辆分类: " + r.already + ")");
  console.log("events.json veh=1 事件   : " + r.usedEvents.size + " 条可映射到移动侦测条目");
  console.log("将改写                   : " + r.hits + " 条 -> SmartVehicleDet");
  for (const p of r.pending.slice(0, 8)) {
    console.log("  例: " + p.body.devSerial + " " + (p.body.alarmTime || "?") + "  <- events[" + p.ev.title + "]");
  }
  if (r.pending.length > 8) console.log("  ... 共 " + r.pending.length + " 条");
}

// 文件锁协议与 webhook.js patchPushLog 兼容(pid@host@ts@rand, O_EXCL 原子创建, 残留锁按存活pid/年龄回收)
function acquireLock(lp) {
  return new Promise(function (resolve) {
    const token = process.pid + "@" + os.hostname() + "@" + Date.now() + "@" + Math.random().toString(36).slice(2, 8);
    const deadline = Date.now() + 10000;
    (function attempt() {
      try {
        const fd = fs.openSync(lp, "wx");
        fs.writeSync(fd, token); fs.closeSync(fd);
        resolve(token);
        return;
      } catch (e) {
        // 锁被占: 持锁进程已死或锁龄>8s 则回收后重试, 否则等待重试到超时
        let info = null;
        try { info = fs.readFileSync(lp, "utf8"); } catch (e2) {}
        let steal = false;
        if (info !== null) {
          const p = String(info).split("@");
          const pid = Number(p[0]) || 0;
          let alive = false;
          if (pid > 0) { try { process.kill(pid, 0); alive = true; } catch (e3) { alive = e3.code === "EPERM"; } }
          let age = 0;
          try { age = Date.now() - fs.statSync(lp).mtimeMs; } catch (e4) {}
          if (!alive || age > 8000) {
            try { const g = lp + ".stale." + process.pid; fs.renameSync(lp, g); fs.unlinkSync(g); } catch (e5) {}
            steal = true;
          }
        }
        if (Date.now() >= deadline) { resolve(null); return; }
        setTimeout(attempt, steal ? 5 : (20 + Math.floor(Math.random() * 30)));
      }
    })();
  });
}
function releaseLock(lp, token) {
  try { if (fs.readFileSync(lp, "utf8") === token) fs.unlinkSync(lp); } catch (e) {}
}

(async function main() {
  const vehEvents = (Array.isArray(readJson(EVENTS, [])) ? readJson(EVENTS, []) : [])
    .filter(function (e) { return e && e.veh === 1 && e.serial && e.ts; });

  if (!APPLY) {
    const logs = readJson(PUSH_LOG, []);
    if (!Array.isArray(logs)) { console.log("push_log.json 不是数组, 中止"); process.exit(1); }
    const r = matchAndCollect(logs, vehEvents);
    printReport(logs, r);
    if (!r.hits) { console.log("无可回填条目(可能已回填过)"); return; }
    console.log("以上为预演, 未改动任何文件。确认后执行: node tools/backfill_veh_pushlog.js --apply");
    return;
  }

  // --apply: 锁内重读最新 push_log 再匹配改写(避免与正在运行的 webhook 的 logPush 互相覆盖)
  const lp = PUSH_LOG + ".lock";
  const token = await acquireLock(lp);
  if (!token) { console.log("等锁超时, 未写盘, 请稍后重试"); process.exit(1); }
  try {
    const logs = readJson(PUSH_LOG, []);
    if (!Array.isArray(logs)) { console.log("push_log.json 不是数组, 中止"); process.exit(1); }
    const r = matchAndCollect(logs, vehEvents);
    console.log("[apply] 锁内重读后匹配: 将改写 " + r.hits + " 条");
    if (!r.hits) { console.log("无可回填条目"); return; }
    const bak = PUSH_LOG + ".bak." + Date.now();
    fs.copyFileSync(PUSH_LOG, bak);
    console.log("[apply] 原文件已备份: " + path.basename(bak));
    for (const p of r.pending) {
      p.body.alarmType = "SmartVehicleDet";
      p.entry.body = p.wasString ? JSON.stringify(p.body) : p.body;
    }
    const content = JSON.stringify(logs, null, 1);
    const tmp = PUSH_LOG + ".tmp." + process.pid;
    fs.writeFileSync(tmp, content);
    try { fs.renameSync(tmp, PUSH_LOG); }
    catch (e) { fs.writeFileSync(PUSH_LOG, content); try { fs.unlinkSync(tmp); } catch (e2) {} }
    console.log("[apply] 已写盘: " + r.hits + " 条移动侦测条目 -> 车辆检测分类");
  } finally { releaseLock(lp, token); }
})();
