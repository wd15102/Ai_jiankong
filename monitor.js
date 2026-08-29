#!/usr/bin/env node
// 萤石云摄像头 AI 监控 · 零框架依赖 CLI（仅 jimp 用于缩略图, Node >= 18，运行于长沙侧，无需公网IP）
// 用法:
//   node monitor.js status            查看 accessToken 与账号下所有设备状态
//   node monitor.js capture [序列号]   抓一张图存入 captures/
//   node monitor.js once [序列号]      抓图 + AI分析 + 推送（手动测试全链路，绕过有人门控）
//   node monitor.js watch [秒]         常驻：仅在线设备 + 移动侦测报警 -> 抓图 -> AI判人 -> 有人才推送
//   node monitor.js ptz <up|down|left|right> [序列号]   云台转动0.8秒
const fs = require("fs");
const path = require("path");
const { createClient } = require("./lib/ys7");
const { analyzeImage } = require("./lib/ai");
const { push } = require("./lib/push");

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
function extractPicUrl(capRes) {
  if (capRes.code !== "200") throw new Error("抓图失败 code=" + capRes.code + " msg=" + capRes.msg);
  const d = capRes.data;
  return Array.isArray(d) ? d[0].picUrl : d.picUrl;
}
function ts() { return new Date().toLocaleTimeString(); }

async function grab(serial) {
  console.log("[" + ts() + "] 抓图 " + devName(serial) + " ...");
  const url = extractPicUrl(await client.capture(serial));
  const file = path.join(ROOT, "captures", serial + "_" + Date.now() + ".jpg");
  const bytes = await client.downloadTo(url, file);
  console.log("  已保存 captures/" + path.basename(file) + " (" + (bytes / 1024).toFixed(1) + " KB)");
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

// 写 Web 看板事件记录（报警画面+AI结论，最多保留500条）
function recordEvent(ev) {
  const f = path.join(ROOT, "data", "events.json");
  let arr = [];
  try {
    arr = JSON.parse(fs.readFileSync(f, "utf8"));
    if (!Array.isArray(arr)) arr = [];
  } catch (e) {
    // 解析失败(并发写被打断): 损坏文件留档再从空开始, 避免静默丢失全部历史
    try { if (fs.existsSync(f) && fs.statSync(f).size > 0) fs.copyFileSync(f, f + ".corrupt." + Date.now()); } catch (e2) {}
    arr = [];
  }
  arr.push(ev);
  if (arr.length > 500) arr = arr.slice(-500);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const content = JSON.stringify(arr, null, 1);
  // 先写临时文件再改名, 避免webhook/看板读到写了一半的内容; 改名被占用时退回直写
  try {
    fs.writeFileSync(f + ".tmp", content);
    try { fs.renameSync(f + ".tmp", f); }
    catch (e3) { fs.writeFileSync(f, content); fs.unlinkSync(f + ".tmp"); }
  } catch (e4) { console.log("  [警告] events.json 写入失败: " + e4.message.slice(0, 80)); }
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

// 判定 AI 结论是否为"有人/异常"
function judgePerson(content) {
  const c = String(content);
  const m = c.match(/【(有人|无人)】/);
  let person;
  if (m) person = m[1] === "有人";
  else if (/^\s*无人/.test(c.trim()) || /【无人】/.test(c)) {
    person = false; // 行首"无人"(config自定义prompt不带括号)优先判定: 防"未见人员活动"误命中下面的关键词
  }
  else person = /(有人|人员活动|检测到人|出现人|一个人)/.test(c);
  const abnormal = /(异常|需关注|注意|陌生|闯入)/.test(c) && !/无异常/.test(c);
  return { person: person === true, abnormal: abnormal };
}

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
      if (!opts.bypassGate && cfg.ai.pushOnlyWhenPerson !== false) {
        shouldPush = j.person || j.abnormal;
        console.log("  判定: " + (j.person ? "!! 有人" : "无人") + (j.abnormal ? " / 含异常描述" : "") + " -> " + (shouldPush ? "推送" : "不推送"));
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
  recordEvent({
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
  console.log("策略: 仅在线设备 / 仅移动侦测触发抓图+AI / 有人或异常才推送微信。按 Ctrl+C 退出");
  const bootAt = Date.now(); // 启动锚点: 早于(启动时刻-轮询间隔)的积压报警只登记不分析

  const state = Object.assign({ seenAlarms: [], lastQuery: {} }, loadState());
  let fallbackWarned = false;

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
        const end = Date.now();
        // 从上次查询时间开始查（首次则回退30分钟）
  const last = (state.lastQuery || {})[t.serial];
  const al = await client.alarms(t.serial, last || (end - 30 * 60 * 1000), end, 20);
        if (al.code !== "200") {
          if (!fallbackWarned) {
            console.log("[" + ts() + "] 报警列表不可用(code=" + al.code + ")，降级为定时抓图模式（AI只判人，无人不推送）");
            fallbackWarned = true;
          }
          // 抓图限流：免费版每设备仅100次/天，降级模式下每台设备至少隔10分钟才抓一次
          state.lastFallback = state.lastFallback || {};
          if (Date.now() - (state.lastFallback[t.serial] || 0) > 600e3) {
            state.lastFallback[t.serial] = Date.now();
            const f0 = await grab(t.serial);
            await analyzeAndPush(t.serial, f0, "定时巡查");
          }
          continue;
        }
        state.lastQuery[t.serial] = end; // 查询成功才推进本设备窗口(在循环作用域内,原写在循环外引用t/end必崩)
        const fresh = (al.data || []).filter(function (a) { return state.seenAlarms.indexOf(a.alarmId) < 0; });
        fresh.reverse(); // 时间正序逐条处理
        for (const a of fresh) {
          state.seenAlarms.push(a.alarmId);
          // 服务停机期间的积压报警: 只登记去重, 不再补抓图+AI(避免每次开机重放历史浪费配额)
          if (a.alarmTime < bootAt - interval) {
            console.log("[" + ts() + "] 跳过积压报警 @" + t.name + " " + new Date(a.alarmTime).toLocaleString() + "（停机期间发生）");
            continue;
          }
          console.log("[" + new Date(a.alarmTime).toLocaleString() + "] 移动侦测 @" + t.name);
          const f = await grab(t.serial);
          await analyzeAndPush(t.serial, f, "移动侦测·有人?");
        }
      } catch (e) {
        console.log("[" + ts() + "] 轮询出错(" + t.name + "): " + e.message);
      }
    }
    state.seenAlarms = state.seenAlarms.slice(-200);
    saveState(state);
  }

  await round();
  setInterval(round, interval);
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
    "  node monitor.js watch [秒]         常驻监控（在线设备+移动侦测+AI判人+推送）",
    "  node monitor.js ptz <up|down|left|right> [序列号]  云台控制"
  ].join("\n"));
}

main().catch(function (e) { console.error("出错:", e.message); process.exit(1); });
