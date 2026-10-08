#!/usr/bin/env node
// 萤石云摄像头 AI 监控 · 零框架依赖 CLI（仅 jimp 用于缩略图, Node >= 18，运行于长沙侧，无需公网IP）
// 用法:
//   node monitor.js status            查看 accessToken 与账号下所有设备状态
//   node monitor.js capture [序列号]   抓一张图存入 captures/
//   node monitor.js once [序列号]      抓图 + AI分析 + 推送（手动测试全链路，绕过有人门控）
//   node monitor.js watch [秒]         常驻：每台设备 ≥30 分钟定时存档抓图一张(看板垫图素材, 不做AI不推送)
//                                      —— 报警的 AI 判人 + 推送由 webhook.js 事件驱动链路统一处理
//   node monitor.js ptz <up|down|left|right> [序列号]   云台转动0.8秒
const fs = require("fs");
const path = require("path");
const { createClient } = require("./lib/ys7");
const { analyzeImage } = require("./lib/ai");
const { push } = require("./lib/push");
const { judgePerson } = require("./lib/judge"); // 判人逻辑唯一实现(与 webapp/webhook 共用)
const store = require("./lib/store"); // events.json 跨进程事务存储(与 webapp/webhook 共用同一把锁)
const hdcapture = require("./lib/hdcapture"); // 高清抓图: 主码流截帧, 失败回落原抓图接口

const ROOT = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const client = createClient(cfg);

function pickSerial(arg) {
  if (arg) return arg;
  const w = (cfg.devices || []).find(function (d) { return d.watch; });
  if (!w) throw new Error("config.json 的 devices 里没有 watch=true 的设备，也未在命令行指定序列号");
  return w.serial;
}
function devName(serial) {
  const d = (cfg.devices || []).find(function (x) { return x.serial === serial; });
  return d ? d.name : serial;
}
function ts() { return new Date().toLocaleTimeString(); }

async function grab(serial) {
  console.log("[" + ts() + "] 抓图 " + devName(serial) + " ...");
  const file = path.join(ROOT, "captures", serial + "_" + Date.now() + ".jpg");
  // 高清抓图: 主码流截帧(3200x1800), 失败自动回落原抓图接口(768x432)
  const meta = await hdcapture.captureHD(client, serial, file);
  const bytes = fs.statSync(file).size;
  console.log("  已保存 captures/" + path.basename(file) + " (" + (bytes / 1024).toFixed(1) + " KB)" +
    (meta.hd ? " 高清" + meta.w + "x" + meta.h : " 普清(回落原接口)"));
  return file;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, "data", "state.json"), "utf8")); }
  catch (e) { return {}; }
}
function saveState(s) {
  fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "data", "state.json"), JSON.stringify(s, null, 2));
}

// 写 Web 看板事件记录（报警画面+AI结论）
// 走 lib/store 的跨进程事务: 锁内重读最新 events.json 再追加, 避免与 webhook/webapp 的写入互相覆盖。
// 保留上限统一读 config.json 的 storage.eventRetention(原来这里硬编码 20000, 改配置等于没改)。
function recordEvent(ev) {
  return store.updateEvents(ROOT, function (arr) {
    arr.push(ev);
    return true;
  }, { cap: store.eventCap(cfg) });
}

// AI 全渠道失败的通知限频：5分钟最多推一次，避免刷屏
function shouldNotifyAIFail(state) {
  const now = Date.now();
  if (!state.lastAIFailNotify || now - state.lastAIFailNotify > 5 * 60e3) {
    state.lastAIFailNotify = now;
    saveState(state);
    return true;
  }
  return false;
}

// 判定 AI 结论是否为"有人/异常" —— 实现已收敛到 lib/judge.js
// (原实现里 /^\s*无人/ 缺 m 标志 + 关键词命中子串, 会把"没有人""未见人员活动"误判成有人)

async function analyzeAndPush(serial, file, extraTitle, opts) {
  opts = opts || {};
  let conclusion;
  let shouldPush = true;
  let person = false;
  let abnormal = false;
  let provider = "";

  if (cfg.ai && cfg.ai.enabled) {
    console.log("  AI 分析中 ...");
    const state = loadState();
    const r = await analyzeImage(cfg.ai, file);
    if (!r.ok) {
      conclusion = "(AI全渠道失败: " + r.reason + ")";
      console.log("  " + conclusion);
      provider = "fail";
      shouldPush = shouldNotifyAIFail(state); // 失败也要让人知道，但限频
    } else {
      provider = r.provider;
      conclusion = "[" + r.provider + "] " + r.content;
      console.log("  AI结论(" + r.provider + "): " + r.content.split("\n").join(" | "));
      const j = judgePerson(r.content);
      person = j.person;
      abnormal = j.abnormal;
      // 结论解析不出来(格式漂移): 打警告便于排查, 但仍按"未识别到有人"处理, 保持原有门控策略
      if (!j.matched) console.log("  [警告] AI结论无法解析(依据=" + j.source + "), 按'无人'处理: " + r.content.replace(/\s+/g, " ").slice(0, 60));
      if (!opts.bypassGate && cfg.ai.pushOnlyWhenPerson !== false) {
        shouldPush = j.person || j.abnormal;
        console.log("  判定: " + (j.person ? "!! 有人" : "无人") + (j.abnormal ? " / 含异常描述" : "") + " (依据:" + j.source + ") -> " + (shouldPush ? "推送" : "不推送"));
      }
    }
  } else {
    conclusion = "(AI未启用，仅完成抓图)";
    console.log("  " + conclusion);
  }

  if (shouldPush) {
    // 带上serial: 推送通道按设备所属村做分组过滤(双溪村组只收双溪村/同事组不推)
    const pr = await push(cfg.push, (extraTitle || "摄像头动态") + " - " + devName(serial), conclusion, { imageFile: file, serial: serial });
    if (!pr.skipped) console.log("  推送: " + (pr.ok ? "成功" : "失败 " + (pr.reason || "")));
  } else {
    console.log("  （未推送）");
  }

  // 写 Web 看板：报警画面 + AI 结论
  await recordEvent({
    ts: Date.now(),
    time: new Date().toLocaleString("zh-CN", { hour12: false }),
    serial: serial,
    name: devName(serial),
    file: path.basename(file),
    title: extraTitle || "摄像头动态",
    provider: provider,
    ai: conclusion,
    person: person,
    abnormal: abnormal,
    pushed: shouldPush
  });
}

async function cmdStatus() {
  await client.getToken();
  console.log("accessToken 获取并缓存成功 ✓");
  const dl = await client.deviceList();
  if (dl.code !== "200") throw new Error("设备列表失败: " + dl.msg);
  console.log("账号下共 " + (dl.data || []).length + " 台设备:");
  (dl.data || []).forEach(function (d) {
    const mark = (cfg.devices || []).some(function (x) { return x.serial === d.deviceSerial; }) ? " [watch]" : "";
    console.log("  " + (d.status === 1 ? "●在线" : "○离线") + "  " + d.deviceName + "  " + d.deviceType + "  " + d.deviceSerial + mark);
  });
  const provs = (cfg.ai.providers || []).map(function (p) {
    return p.name + (p.enabled ? "(" + p.model + ")" : "(停用)");
  });
  console.log("AI渠道顺序: " + provs.join(" -> "));
}

async function cmdWatch(sec) {
  const interval = ((sec || cfg.watchIntervalSec || 60)) * 1000;
  const targets = (cfg.devices || []).filter(function (d) { return d.watch; });
  if (!targets.length) throw new Error("没有 watch=true 的设备");
  // PID 文件：供 停止服务.bat 优雅终止
  try {
    fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
    fs.writeFileSync(path.join(ROOT, "data", "monitor.pid"), String(process.pid));
    process.on("exit", function () { try { fs.unlinkSync(path.join(ROOT, "data", "monitor.pid")); } catch (e) {} });
  } catch (e) { console.log("[monitor] pid 文件写入失败: " + e.message); }
  console.log("=== 常驻监控启动 === 轮询间隔 " + interval / 1000 + "s，关注设备: " + targets.map(function (t) { return t.name; }).join(", "));
  console.log("策略: 定时抓图存档(看板垫图素材) / AI分析+推送统一由 webhook 事件驱动链路处理，避免重复消耗配额");
  // 抓图间隔: 默认 **2 小时**/次/设备(2026-10-08 由 30 分钟上调)。
  //
  // 为什么是配额问题(不是"刷爆带宽"): 萤石免费版抓图配额只有 100 次/天/设备, 且路径三
  // `client.capture` 是唯一耗配额的取图方式。配额账(2 台设备):
  //   巡检 30 分钟/次 = 48 次/天/设备 + 报警补图约 50 次 = 98 次 → 紧贴 100 的上限, 稍有波动就爆。
  // 实测 2026-10-07~10-08 就是这么打爆的: code=10028 出现 589 次、9048 出现 803 次,
  // monitor 高清截帧 574 次尝试成功 0 次(抢不到拉流锁 → 回落吃配额接口 → 更拉不到流)。
  //
  // 2 小时/次 = 12 次/天/设备, 巡检总占用 24 次, 给报警链路留出 ~76 次/设备的余量。
  // 巡检图只是**垫图素材**(给人形消息补帧用), 没人来的时候根本不会被引用, 降频代价极小;
  // 而报警链路的取图是刚需, 不该被巡检挤掉配额。
  // 可调: config.json 的 watch.captureMinMinutes(不填则默认 120 分钟)。
  const CAPTURE_MIN_MS = Math.max(
    interval,
    Number((cfg.watch || {}).captureMinMinutes || 120) * 60 * 1000
  );
  console.log("定时存档间隔: " + Math.round(CAPTURE_MIN_MS / 60000) + " 分钟/设备(萤石抓图配额 100 次/天/设备, 报警链路优先)");

  const state = Object.assign({ lastCapture: {}, captureBackoff: {} }, loadState());

  async function round() {
    // 每轮动态获取在线状态
    let onlineSet = null;
    try {
      const dl = await client.deviceList();
      if (dl.code === "200") {
        onlineSet = new Set((dl.data || []).filter(function (d) { return d.status === 1; }).map(function (d) { return d.deviceSerial; }));
      }
    } catch (e) { /* 获取失败则本轮不筛离线 */ }

    for (const t of targets) {
      try {
        if (onlineSet && !onlineSet.has(t.serial)) {
          continue; // 离线设备静默跳过（不刷屏）
        }
        // 配额类失败退避中(10028抓图次数超限/9048取流超限): 未到冷却点静默跳过, 不硬试
        const bk = (state.captureBackoff || {})[t.serial];
        if (bk && bk.nextOk && Date.now() < bk.nextOk) continue;
        // 抓图接口当日配额已耗尽(hdcapture 记的跨进程标记, 见 lib/hdcapture.js CAPTURE_QUOTA_FILE):
        // 10028 按自然日重置, 当天再怎么试都必然失败 —— 直接整轮跳过, 不再逐设备硬试刷屏。
        // 注: 高清截帧(主码流)本身不吃抓图配额, 但退避期内 lib/hdcapture 也会一并跳过(宁缺勿烧配额)。
        if (hdcapture.captureQuotaExhausted() || hdcapture.inStreamBackoff()) continue;
        // 抓图间隔控制: 距上次存档不足 CAPTURE_MIN_MS 则跳过本轮, 避免高频拉流截帧刷爆带宽
        const lastCap = (state.lastCapture || {})[t.serial] || 0;
        if (Date.now() - lastCap < CAPTURE_MIN_MS) continue;
        // 定时抓图存档：只存图 + 写一条 events.json 垫图记录，不做 AI 分析、不推送。
        // (AI 判人 + 推送统一由 webhook.js 的事件驱动链路处理，monitor 不再重复)
        const f = await grab(t.serial);
        state.lastCapture[t.serial] = Date.now();
        if (state.captureBackoff && state.captureBackoff[t.serial]) delete state.captureBackoff[t.serial]; // 成功即复位退避
        await recordEvent({
          ts: Date.now(),
          time: new Date().toLocaleString("zh-CN", { hour12: false }),
          serial: t.serial,
          name: t.name,
          file: path.basename(f),
          title: "定时存档",
          provider: "",
          ai: "",
          person: false,
          abnormal: false,
          pushed: false
        });
      } catch (e) {
        const msg = String(e.message || "");
        console.log("[" + ts() + "] 定时抓图失败(" + t.name + "): " + msg.slice(0, 80));
        // 配额类失败指数退避(2026-10-07): 萤石免费版抓图/取流超限时每5分钟硬试只白烧调用次数还刷屏
        // (10-06 24小时连败571次实测)。按连续失败次数翻倍冷却: 5→10→20→40→60分钟封顶, 成功即复位。
        // 只认确定性标记: code=10028/"次数超限"(抓图配额)与"9048退避中"(本进程取流退避态)。
        // "可能9048超限/设备离线"是占位流错误里的猜测性套话, 纯20008设备超时不退避, 维持每轮正常重试。
        if (/10028|次数超限|9048退避中/.test(msg)) {
          if (!state.captureBackoff) state.captureBackoff = {};
          const bk2 = state.captureBackoff[t.serial] || (state.captureBackoff[t.serial] = { fails: 0, nextOk: 0 });
          bk2.fails = (bk2.fails || 0) + 1;
          const waitMin = Math.min(60, 5 * Math.pow(2, bk2.fails - 1));
          bk2.nextOk = Date.now() + waitMin * 60 * 1000;
          console.log("[" + ts() + "] [退避] " + t.name + " 连续第" + bk2.fails + "次配额类失败, 暂停抓图至 " +
            new Date(bk2.nextOk).toLocaleTimeString("zh-CN", { hour12: false }));
        }
      }
    }
    saveState(state);
  }

  let _rounding = false; // 重入保护：上一轮未完成时不触发下一轮
  async function scheduleNext() {
    if (_rounding) return; // 跳过本轮（上一轮还在跑）
    _rounding = true;
    try {
      await round();
    } catch (e) {
      console.log("[" + ts() + "] 轮询异常: " + e.message);
    } finally {
      _rounding = false;
    }
    setTimeout(scheduleNext, interval);
  }
  scheduleNext();
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd === "status") return cmdStatus();
  if (cmd === "capture") { await grab(pickSerial(argv[1])); return; }
  if (cmd === "once") {
    const s = pickSerial(argv[1]);
    const f = await grab(s);
    return analyzeAndPush(s, f, "手动测试", { bypassGate: true });
  }
  if (cmd === "watch") return cmdWatch(parseInt(argv[1], 10) || undefined);
  if (cmd === "ptz") {
    const dirMap = { up: 0, down: 1, left: 2, right: 3 };
    const dir = dirMap[argv[1]];
    if (dir === undefined) throw new Error("方向参数: up / down / left / right");
    const s = pickSerial(argv[2]);
    await client.ptzStart(s, dir);
    setTimeout(function () { client.ptzStop(s).catch(function () {}); }, 800);
    return console.log("云台 " + argv[1] + " 转动 0.8 秒");
  }
  console.log([
    "用法:",
    "  node monitor.js status     查看 token、设备与AI渠道状态",
    "  node monitor.js capture [序列号]   抓一张图",
    "  node monitor.js once [序列号]      手动全链路测试（抓图+AI+推送）",
    "  node monitor.js watch [秒]         常驻定时存档抓图（报警AI判人+推送由 webhook.js 处理）",
    "  node monitor.js ptz <up|down|left|right> [序列号]  云台控制"
  ].join("\n"));
}

main().catch(function (e) { console.error("出错:", e.message); process.exit(1); });
