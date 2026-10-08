#!/usr/bin/env node
// 电脑 Web 报错看板 + 实时控制（零框架依赖, 仅 jimp 用于缩略图, Node >= 18）
// 运行: node webapp.js  ->  浏览器打开 http://localhost:8790
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { createClient } = require("./lib/ys7");
const { analyzeImage } = require("./lib/ai");
const { judgePerson } = require("./lib/judge"); // 判人逻辑唯一实现(与 monitor/webhook 共用)
const store = require("./lib/store"); // events.json 跨进程事务存储(与 monitor/webhook 共用同一把锁)
const hdcapture = require("./lib/hdcapture"); // 高清抓图: 主码流截帧, 失败回落原抓图接口
const { push, pushTestTemplate } = require("./lib/push"); // 消息推送: 单用户推送 /api/push-single 端点用

const ROOT = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const PORT = ((cfg.webapp || {}).port) || 8790;
const VERSION = "2026-10-07.30"; // +推送记录四筛选全部服务端化: person/day 也进 buildPushGroups(修"筛选出2条却有39页"的页内筛选错位), API 返回 grand

// ---------- Web 看板鉴权：防止公网隧道下被未授权抓图/删记录/一键关服 ----------
// 本地 127.0.0.1 访问免令牌（同机/SSH 转发均视为本地）；非本地访问敏感接口必须带 ?token=xxx
// token 来源：config.json webapp.apiToken；未配置则自动生成并持久化到 data/webapp_token.txt
function resolveApiToken() {
  const fromCfg = (cfg.webapp && cfg.webapp.apiToken) || "";
  if (fromCfg) return fromCfg;
  const tpath = path.join(ROOT, "data", "webapp_token.txt");
  try { if (fs.existsSync(tpath)) { const t = fs.readFileSync(tpath, "utf8").trim(); if (t) return t; } } catch (e) {}
  try {
    const t = crypto.randomBytes(16).toString("hex");
    fs.mkdirSync(path.dirname(tpath), { recursive: true });
    fs.writeFileSync(tpath, t);
    console.log("[鉴权] webapp.apiToken 未配置，已自动生成并持久化到 data/webapp_token.txt");
    console.log("       远程访问看板请在地址后加 ?token=" + t + "（本地 127.0.0.1 无需令牌）");
    return t;
  } catch (e) { return ""; }
}
const API_TOKEN = resolveApiToken();
const PROTECTED_PATHS = ["/api/capture", "/api/analyze", "/api/alarms/check", "/api/alarms/check-today", "/api/events/delete", "/api/events/delete-all"];
function isLoopback(req) {
  const a = req.socket && req.socket.remoteAddress;
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}
// 返回 true 表示已被拦截（已回 401/403，调用方应 return）
function tokenGate(req, u, res) {
  const p = u.pathname;
  const sensitive = PROTECTED_PATHS.indexOf(p) >= 0 || p === "/__shutdown" || p === "/__who";
  if (!sensitive) return false;
  if (isLoopback(req)) return false;
  if (API_TOKEN && u.searchParams.get("token") === API_TOKEN) return false;
  sendJson(res, 401, { error: "未授权：非本地访问需在 URL 携带 ?token=<webapp.apiToken>" });
  return true;
}

const PID_FILE = path.join(ROOT, "data", "webapp.pid");
const client = createClient(cfg);

// ---------- 自愈启动：HTTP 握手识别并接管旧实例（零子进程，跨环境可靠） ----------
const APP_NAME = "webapp";
function removePidIfMine() {
  try { if (fs.readFileSync(PID_FILE, "utf8").trim() === String(process.pid)) fs.unlinkSync(PID_FILE); } catch (e) {}
}
async function askOldInstance() {
  try {
    const r = await fetch("http://127.0.0.1:" + PORT + "/__who", { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}
async function shutdownOldInstance() {
  const old = await askOldInstance();
  if (!old || old.app !== APP_NAME || old.pid === process.pid) return false;
  console.log("[启动] 检测到旧实例 PID=" + old.pid + "，请求其退出...");
  try { await fetch("http://127.0.0.1:" + PORT + "/__shutdown?pid=" + old.pid, { signal: AbortSignal.timeout(2000) }); } catch (e) {}
  for (let i = 0; i < 10; i++) {
    await new Promise(function(r2){ setTimeout(r2, 300); });
    if (!(await askOldInstance())) { console.log("[启动] 旧实例已退出，端口已释放"); return true; }
  }
  console.log("[启动] 旧实例未响应退出请求");
  return false;
}
async function cleanupStaleInstance() {
  const old = await askOldInstance();
  if (old && old.app !== APP_NAME) {
    console.warn("[启动] 警告: 端口 " + PORT + " 被其他程序占用(app=" + (old.app || "unknown") + ")，启动可能失败");
  } else if (old) {
    await shutdownOldInstance();
  }
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid));
}

// AI 模型展示名
const PROVIDER_LABELS = { mota: "魔塔DeepSeek", ali: "阿里DeepSeek", agnes: "Agnes", xiaohongshu: "小红书" };
function providerLabel(name) { return PROVIDER_LABELS[name] || name; }

const PAGE = fs.existsSync(path.join(ROOT, "webapp.html"))
  ? fs.readFileSync(path.join(ROOT, "webapp.html"), "utf8")
  : "<h1>webapp.html 未找到</h1>";

// events.json 统一走 lib/store: 跨进程文件锁 + 「锁内重读最新内容再改」的事务。
// 原来 loadEvents -> 改 -> saveEvents 的写法会和 webhook/monitor 的写入互相整份覆盖(丢事件)。
function loadEvents() { return store.readEvents(ROOT); }
// 提交一次 events.json 事务。mutate 必须是**同步**函数:
//   返回 false -> 内容无变化, 不写盘; 返回数组 -> 整体替换; 其他 -> 用原地修改后的数组
// 返回 { ok, written }: ok=false 表示没拿到锁(改动被放弃), 调用方必须处理
function mutateEvents(mutate) { return store.updateEvents(ROOT, mutate, { cap: store.eventCap(cfg) }); }
function recordEvent(ev) { return mutateEvents(function (arr) { arr.push(ev); return true; }); }
// (原 deleteEventByFile 已移除: 删除统一走 /api/events/delete 的 items 定位 —— 没有配图的记录
//  file 是空串, 只按 file 匹配既分不清是哪一条、又会连同其他无图记录一起删掉。)

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function devName(serial) {
  const d = (cfg.devices || []).find(function(x){ return x.serial === serial; });
  return d ? d.name : serial;
}
// 设备归属村子(按设备名前缀, 与 webhook.js 保持一致)
function deviceVillage(serial) {
  const d = (cfg.devices || []).find(function(x){ return x.serial === serial; });
  const name = d ? d.name : String(serial || "");
  if (name.indexOf("双溪村") >= 0) return "双溪村";
  if (name.indexOf("木山村") >= 0) return "木山村";
  return "";
}

// ---- 萤石推送记录（webhook 收到的 push_log.json，按消息类型分组展示） ----
const PUSH_TYPE_NAMES = {
  "sound_detection": "声音侦测",
  "10002": "移动侦测", "15504": "人形检测", "15505": "区域入侵", "15506": "人形侦测",
  "device_online": "设备上线", "device_offline": "设备离线", "online": "设备上线", "offline": "设备离线",
  "intelligentDetection": "智能检测", "SmartHumanDet": "人形检测", "AI": "AI算法结果", "agent": "AI算法结果",
  "VMD": "视频移动侦测", "motiondetect": "移动侦测", "pet_detection": "宠物侦测", "PetDetection": "宠物侦测",
  "SmartVehicleDet": "车辆检测", "VehicleDet": "车辆检测", "CarDet": "车辆检测",
  "storage_status": "存储状态"
};
function pushTypeName(type) {
  if (PUSH_TYPE_NAMES[type]) return PUSH_TYPE_NAMES[type];
  if (String(type).indexOf("155") === 0) return "人形检测";
  if (String(type).indexOf("Ircut") === 0) return "红外滤光切换";
  if (String(type).indexOf("IntelligentTag") === 0) return "智能标签";
  if (String(type).indexOf("Pet") === 0 || String(type).indexOf("pet") === 0) return "宠物侦测";
  if (String(type).indexOf("Vehicle") >= 0 || String(type).indexOf("Car") >= 0) return "车辆检测";
  return type;
}
function loadPushLog() {
  // 容错: webhook 的 logPush 是「readFileSync → push → writeFileSync 整份覆盖」(**非原子**),
  // 文件现在 4.7MB+, 写入窗口有几十毫秒。这个窗口里 webapp 读到的会是**被截断的 JSON**,
  // 直接 catch 返回 [] → 整个推送记录页瞬间空白(2026-10-08 撞到过一次)。
  // 退而求其次读 .bak(上次成功快照), 宁可少几条也别整页空白。
  const p = path.join(ROOT, "data", "push_log.json");
  const tries = [p, p + ".bak"];
  for (const f of tries) {
    try {
      const arr = JSON.parse(fs.readFileSync(f, "utf8"));
      if (Array.isArray(arr)) return arr;
    } catch (e) { /* 试下一个 */ }
  }
  return [];
}
// captures 抓图按 {serial}_p{ms}.jpg / {serial}_{ms}.jpg 命名, 文件名里自带毫秒时间戳,
// 推送记录按"同设备 ±2分钟内最近的抓图"关联(与 webhook 复用存图的窗口一致)
function loadCaptureIndex() {
  const idx = {};
  // 两个目录都要扫: 事件图在 captures/, 普通移动侦测的截图在 captures/motion/(见 webhook.js 的分级留存)。
  // 不扫 motion 的话, 推送记录页里占八成以上的移动侦测条目会全部变成"没有关联图"。
  const dirs = [
    { d: path.join(ROOT, "captures"), pre: "/captures/" },
    { d: path.join(ROOT, "captures", "motion"), pre: "/captures/motion/" }
  ];
  for (const src of dirs) {
    try {
      for (const f of fs.readdirSync(src.d)) {
        if (!/\.jpg$/i.test(f)) continue;
        const us = f.indexOf("_");
        if (us <= 0) continue;
        const serial = f.slice(0, us);
        let rest = f.slice(us + 1, -4);
        // 文件名含 "p" 前缀 = 低清图(设备端报警截图 768x432); 不含 = 高清原图(ffmpeg 主码流截帧 3200x1800)
        const isHD = rest.charAt(0) !== "p";
        if (!isHD) rest = rest.slice(1);
        const t = Number(rest);
        if (!isFinite(t) || t <= 0) continue;
        if (!idx[serial]) idx[serial] = [];
        idx[serial].push({ t: t, file: f, pre: src.pre, hd: isHD });
      }
    } catch (e) {} // motion/ 还没产生过: 静默跳过
  }
  return idx;
}
function findCapturePic(idx, serial, refMs) {
  const list = idx[serial];
  if (!list || !refMs) return "";
  // 三级优先级: 高清 > 主目录 > 时间最近
  // hd=true: captures/{serial}_{ms}.jpg (ffmpeg 主码流截帧, 3200x1800)
  // hd=false: captures/{serial}_p{ms}.jpg 或 captures/motion/{serial}_p{ms}.jpg (萤石设备端 768x432)
  let best = null;
  for (const x of list) {
    if (Math.abs(x.t - refMs) > 120e3) continue;
    // 计算排序键: (非高清, 非主目录) — 越小越优先
    const key = (x.hd ? 0 : 1) * 2 + (x.pre === "/captures/" ? 0 : 1);
    if (!best || key < best.key || (key === best.key && Math.abs(x.t - refMs) < Math.abs(best.t - refMs))) {
      best = x;
      best.key = key;
    }
  }
  return best ? best.pre + best.file : "";
}
// 推送记录页的时间筛选键(与原前端逻辑一致: 按本地日历日, 兼容 "2026-10-06T10:51" 和 "2026/10/6" 两种格式)
function pushDayKey(s) {
  const m = String(s || "").match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  return m ? m[1] + "-" + ("0" + m[2]).slice(-2) + "-" + ("0" + m[3]).slice(-2) : "";
}
function pushDayOffset(off) {
  const d = new Date(); d.setDate(d.getDate() - off);
  return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
}
// 归一化推送条目的时间展示格式。同一页里时间来自三处, 原生格式各不相同:
//   e.time  = "2026/10/8 09:29:26"  (webhook 收到时刻, toLocaleString zh-CN)
//   alarmTime = "2026-10-08T09:31:29" (v2 推送展平后的本机时间)
//   payload.dateTime = "2026-10-08T09:29:17.000+08:00" (IntelligentTag 真实发生时刻)
// 不统一的话同一天的时间在列表里会呈现三种排版, 也让前端按时间定位条目变得困难。
function normPushTime(s) {
  const raw = String(s == null ? "" : s);
  if (!raw) return "";
  // 已经是 "YYYY/M/D HH:mm:ss" 形态就直接截断, 避免时区偏移把时间改掉
  const zh = raw.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (zh) return zh[1] + "/" + Number(zh[2]) + "/" + Number(zh[3]) + " " + zh[4] + ":" + zh[5] + ":" + zh[6];
  const d = new Date(raw);
  if (isNaN(d.getTime())) return raw.slice(0, 19);
  return d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate() + " " +
    ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2) + ":" + ("0" + d.getSeconds()).slice(-2);
}
function buildPushGroups(limit, offset, typeFilter, deviceFilter, personFilter, dayFilter) {
  // 展示"移动侦测"(含 VMD/video_motion/10002)、"人形检测"、"宠物侦测"和"车辆检测"四个分类, 其他全过滤
  // limit/offset 用于分页; typeFilter 可选: "all"/"motiondetect"/"human"/"pet"/"vehicle" 服务端类型筛选
  // deviceFilter 可选: "all" / 村名("双溪村"/"木山村") / **设备 serial**(按具体设备筛)
  // personFilter 可选: "all"/"yes"(有人)/"no"(无人)/"none"(无AI结论)
  // dayFilter 可选: "all"/"today"/"yesterday"/"before"
  // person/day 必须在服务端筛: 之前"时间"在浏览器里只筛当前页, 分页却按服务端全量算,
  // 出现"筛选出2条却有39页"的错位(2026-10-07 用户截图实测) —— 四个筛选现在全部进服务端, 总数/页码恒一致
  const VISIBLE = { "motiondetect": "移动侦测", "human": "人形检测", "pet": "宠物侦测", "vehicle": "车辆检测" };
  // 人形状: 萤石上报人形的 4 种格式。但 **IntelligentTag 不能整包算人形** ——
  // 它是"多标签"上报, 标签藏在 payload.intelligentTag.tags 里, 2026-10-08 实测 1889 条构成:
  //   pet 1046(全是双溪村 CP1) / human 833 / abnormal_voice 10。
  // 把 1889 条全塞进人形状 = 宠物报警混进人形状, 白名单就白加了。必须按真实标签分流。
  // PeopleDetectionEvent(400) payload 恒为字符串 "null", 无法再细分, 按人形算(与 webhook.js 一致)。
  // 它们是「没消息类排查三步」第 2 步唯一能证明"设备端到底有没有发"的证据, 之前全部命中
  // else continue 被丢弃 —— 导致 events.json 有记录、push_log.json 有原文, 但推送记录页查不到
  // (09:29 双溪村 CP1 实例)。
  const HUMAN_TYPES = /^(SmartHumanDet|PeopleDetectionEvent|intelligentDetection)$/;
  // IntelligentTag 的真实标签解析: 返回 "human"/"pet"/"voice"/"" (无标签或解析失败)。
  // 判据与 webhook.js:667 的 /human|person|people|人形|^人$/i 保持一致, 否则看板与推送链路口径会分叉。
  function intelligentTagKind(payload) {
    if (!payload) return "";
    let pr = null;
    try { pr = JSON.parse(payload); } catch (e) { return ""; }
    const arr = (pr && pr.intelligentTag && Array.isArray(pr.intelligentTag.tags)) ? pr.intelligentTag.tags : [];
    const types = arr.map(function (t) { return String((t && t.type) || ""); });
    if (types.some(function (t) { return /human|person|people|人形|^人$/i.test(t); })) return "human";
    if (types.some(function (t) { return /pet/i.test(t); })) return "pet";
    if (types.some(function (t) { return /voice/i.test(t); })) return "voice";
    return "";
  }
  // IntelligentTag 是**活动片段型上报**, 不是"每次活动一条"(2026-10-08 实测 733 组同毫秒双报/1466 条):
  // 对一次持续活动, 萤石在活动期间每 ~30 秒就重推一次, payload.intelligentTag 里
  //   startTime 固定不变(活动开始), endTime 不断往后延(活动还在持续)。
  // 例: 同一 basic.dateTime=16:56:06 的两条, endTime 分别是 16:56:41 与 16:59:23。
  // 所以 **basic.dateTime(上报时刻)不是活动标识, startTime 才是** ——
  // 用上报时刻去重会把同一次活动算成多条, 看板成对刷屏且看起来像"重复数据"。
  // 返回 { startMs, endMs, uuid }; 解析不出时 startMs 退回 0(调用方按上报时刻处理, 不做归并)。
  function intelligentTagActivity(payload) {
    const empty = { startMs: 0, endMs: 0, uuid: "" };
    if (!payload) return empty;
    let pr = null;
    try { pr = JSON.parse(payload); } catch (e) { return empty; }
    const info = (pr && pr.intelligentTag) || {};
    const uuid = String((pr && pr.basic && pr.basic.UUID) || "");
    const s = info.startTime ? new Date(String(info.startTime)).getTime() : 0;
    const en = info.endTime ? new Date(String(info.endTime)).getTime() : 0;
    return { startMs: isNaN(s) ? 0 : s, endMs: isNaN(en) ? 0 : en, uuid: uuid };
  }
  // 人形状即使命中, 也要能配上图才展示(与移动侦测共用下面 it.pic 的过滤)——
  // IntelligentTag 故意不带 picUrl(设备本地 fileid 取不到), 无图条目对排查没有价值。
  const logs = loadPushLog(); // 全部日志(按时间正序, 最旧在前)
  const groups = {}, order = [];
  for (const e of logs) {
    let body = e.body || e;
    try { if (typeof body === "string") body = JSON.parse(body); if (body && body.body) body = body.body; } catch (err) {}
    if (!body || typeof body !== "object") continue;
    const rawType = String(body.alarmType || body.type || body.eventType || body.msgType || body.identifier || body.messageType || "unknown");
    // 归类: motiondetect/10002/video_motion 合并到移动侦测; IntelligentTag 按真实标签分流到人形/宠物/丢弃;
  // SmartHumanDet/PeopleDetectionEvent/intelligentDetection → 人形; pet/PetDetection → 宠物侦测; VehicleDet/CarDet/SmartVehicleDet → 车辆检测
    let key = "";
    if (rawType === "VMD" || /^video_motion/i.test(rawType)) continue; // VMD高频噪音已不落盘, 历史遗留记录也不再展示
    if (rawType === "IntelligentTag") {
      // 多标签上报, 必须解 payload 才知道是人还是宠物(见 intelligentTagKind 注释)
      const kind = intelligentTagKind(body.payload);
      if (kind === "human") key = "human";
      else if (kind === "pet") key = "pet";
      else continue; // abnormal_voice 等非人物活动类型
    }
    else if (rawType === "motiondetect" || rawType === "10002") key = "motiondetect";
    else if (HUMAN_TYPES.test(rawType)) key = "human";
    // 兜底: 155xx 报警码(15504 人形检测 / 15506 人形侦测 / 15505 区域入侵…)。这两台设备当前
    // 不推 155 码(2026-10-08 实测 18750 条里一条都没有), 但代码里 PUSH_TYPE_NAMES 已经认它们,
    // 说明文档/其它型号设备可能上报 —— 一旦萤石改格式, 别静默丢掉人物活动事件。
    else if (/^155\d\d$/.test(rawType) || /SmartHuman|HumanDet|PeopleDet|intelligentDet/i.test(rawType)) key = "human";
    else if (/pet/i.test(rawType)) key = "pet";
    else if (/vehicle|car/i.test(rawType)) key = "vehicle";
    else continue; // 声音/存储状态/上下线/红外切换/开关心跳... 全部丢弃
    const serial = String(body.devSerial || body.serial || body.deviceId || "?");
    let time = String(body.alarmTime || body.time || "");
    const text = String(body.describe || body.content || body.text || body.channelName || "");
    // IntelligentTag 没有 alarmTime: 真实发生时间只存在于 payload.basic.dateTime(ISO 串)。
    // 必须**优先于 e.time**(webhook 收到时刻)取, 否则展示时间会比 events.json 里的事件晚几秒~几十秒
    // (2026-10-08 实测: payload 是 09:29:17, webhook 09:29:26 才收到), 排查时按时间找不到对应记录。
    if (!time && body.payload && String(body.payload).indexOf("dateTime") >= 0) {
      const m = String(body.payload).match(/"dateTime":"([^"]+)"/);
      if (m) time = m[1];
    }
    if (!time) time = String(e.time || e.ts || "");
    time = normPushTime(time);
    // 用于关联抓图的毫秒时间戳: 优先 body 里的报警时间(ISO/毫秒), 否则退回 webhook 收到时间
    let tsMs = 0;
    const tRaw = body.alarmTime || body.time || time;
    if (tRaw) {
      const n = Number(tRaw);
      if (isFinite(n) && n > 0) tsMs = n < 1e12 ? n * 1000 : n;
      else { const d = new Date(String(tRaw)); if (!isNaN(d.getTime())) tsMs = d.getTime(); }
    }
    if (!tsMs) tsMs = Number(e.ts) || 0;
    if (!groups[key]) { groups[key] = { type: key, name: VISIBLE[key], count: 0, items: [] }; order.push(key); }
    groups[key].count++;
    // act: IntelligentTag 的活动片段标识(startTime/endTime/UUID), 供后面按活动归并;
    // 其他类型为 null。durable 表示这条是否"值得长期留存" —— 宠物组只有带独立 pet_detection
    // 报文(自带截图)的那条才留, IntelligentTag(pet) 同活动的片段一律丢弃(见下方宠物归并)。
    const act = rawType === "IntelligentTag" ? intelligentTagActivity(body.payload) : null;
    groups[key].items.push({
      time: time.slice(0, 19), serial: serial, devName: devName(serial), text: text.slice(0, 120),
      tsMs: tsMs, rawType: rawType, act: act, merged: 1,
    });
  }
  // ---------- IntelligentTag 活动片段归并 ----------
  // 一次持续活动被萤石每 ~30s 重推一次(startTime 相同、endTime 延伸), 直接展示会成对刷屏。
  // 归并规则: 同设备 + 同 startTime(缺失时退化为同 basic.dateTime) 的多条合成一条,
  // 以**最后一条**(endTime 最晚)为代表, 并记录合并条数与活动时长, 展示成"持续 N 秒"。
  for (const gk of Object.keys(groups)) {
    const g = groups[gk];
    if (!g.items.length) continue;
    const byAct = {}, kept = [];
    for (const it of g.items) {
      const aid = it.act && it.act.startMs ? ("s" + it.act.startMs) : ("d" + it.tsMs);
      const k2 = it.serial + "@" + aid;
      const prev = byAct[k2];
      if (prev) {
        prev.merged++;
        // 保留活动时长更长的那条作为代表(它的 endTime 最晚, 也最接近"活动仍在继续")
        const prevDur = (prev.act && prev.act.endMs ? prev.act.endMs : prev.tsMs) - (prev.act && prev.act.startMs ? prev.act.startMs : prev.tsMs);
        const curDur = (it.act && it.act.endMs ? it.act.endMs : it.tsMs) - (it.act && it.act.startMs ? it.act.startMs : it.tsMs);
        if (curDur > prevDur || it.tsMs > prev.tsMs) {
          prev.merged--; it.merged = prev.merged + 1; byAct[k2] = it;
        }
      } else byAct[k2] = it;
    }
    for (const k2 in byAct) kept.push(byAct[k2]);
    // 只有存在真实重复(merged>1)的组才需要重排, 避免无谓改变原有顺序
    if (kept.length !== g.items.length) {
      g.items = kept;
      // 活动时长(秒)展示: endTime-startTime。endTime 缺失/早于 startTime(设备时钟漂移)时不算时长,
      // 免得显示「持续 0 秒」这种反直觉的数字 —— 前端只在 durSec>0 时才渲染。
      for (const it of g.items) {
        if (it.merged > 1 && it.act && it.act.startMs) {
          const end = (it.act.endMs && it.act.endMs > it.act.startMs) ? it.act.endMs : 0;
          if (end) it.durSec = Math.round((end - it.act.startMs) / 1000);
        }
      }
    }
  }
  // 固定按白名单顺序展示: 人形检测 → 移动侦测 → 宠物侦测 → 车辆检测(人形最重要, 排最前)
  const capIdx = loadCaptureIndex();
    // 宠物组内去重: 同一次宠物活动会被萤石双报 —— IntelligentTag(payload 带 pet 标签, 无截图)
  // 与独立的 PetDetection/pet_detection(带截图)。2026-10-08 实测 ±10s 内重合 93.6%、
  // ±5s 内 80.7%, 直接并列展示会让同一只猫出现两遍。同设备 ±15s 只留一条, 优先留带独立
  // pet_detection 报文的(它才有截图和 AI 结论)。
  // 注: IntelligentTag 内部的**同活动片段**已在上一步按 startTime 归并, 这里只处理
  // "标签报文 vs 独立报文"这一层的重复(两者 startTime 不同, 归并键不同)。
  if (groups.pet && groups.pet.items.length > 1) {
    const hasShot = function (it) { return it.rawType === "PetDetection" || it.rawType === "pet_detection"; };
    const sorted = groups.pet.items.slice().sort(function (a, b) {
      const d = (hasShot(b) ? 1 : 0) - (hasShot(a) ? 1 : 0); // 带截图的优先
      return d !== 0 ? d : a.tsMs - b.tsMs;
    });
    const kept = [];
    for (const it of sorted) {
      const dup = kept.find(function (k) { return k.serial === it.serial && Math.abs(k.tsMs - it.tsMs) <= 15e3; });
      if (dup) {
        dup.merged += it.merged; // 被丢弃的条目数要累加到保留条目上, 否则"合并 N 条"会少算
        if (it.act && it.act.endMs && it.act.endMs > (dup.act && dup.act.endMs ? dup.act.endMs : 0)) dup.act = it.act;
        continue;
      }
      kept.push(it);
    }
    groups.pet.items = kept;
  }
  // AI结论来自 events.json: 优先取"同一张抓图"对应事件的判读, 否则取同设备±90秒同活动事件
  // (90秒与 webhook 的同活动去重窗口一致; 文件精确命中的事件代表分析的就是这张图, 最可信)
  const events = loadEvents();
  const evByFile = {}, evBySerial = {};
  for (const ev of events) {
    if (ev.file) evByFile[ev.file] = ev;
    if (ev.serial) (evBySerial[ev.serial] = evBySerial[ev.serial] || []).push(ev);
  }
  // 每组 items 按时间倒序(tsMs, 不用字符串—— 月/日不补零会让字典序错乱), 补齐 pic/person/ai
  const full = ["human", "motiondetect", "pet", "vehicle"].filter(function(k){ return groups[k]; }).map(function(t){
    const g = groups[t];
    g.items.sort(function (a, b) { return (b.tsMs || 0) - (a.tsMs || 0); });
    // count 必须是**归并后**的条目数(页头"X 条"和分组头"X / Y 条"都靠它), 否则同一活动
    // 合并成一条后会出现"显示 1 条但写着 6 条"的自相矛盾。原始报文数另存 rawCount 供排查。
    g.rawCount = g.count;
    g.count = g.items.length;
    for (const it of g.items) {
      // 图文同源(2026-09-29): 先按"同设备±90秒(有AI结论优先, 同分取时间最近)"定事件,
      // 配图直接用**事件自己的 file** —— AI 分析的就是事件 file 那张图, 展示它才保证结论与画面一致。
      // (事故: 旧逻辑先按"就近抓图"独立选图、再反查事件, 选到的抓图与事件实际分析的图不是同一张,
      //  出现"图里有人、AI结论无人"的错位)
      let ev = null;
      if (evBySerial[it.serial]) {
        let best = null;
        for (const e of evBySerial[it.serial]) {
          if (!e.ts || !it.tsMs || Math.abs(e.ts - it.tsMs) > 90e3) continue;
          const usable = e.ai && e.ai !== "(点击AI分析)" && e.ai !== "(等待分析...)";
          const score = (usable ? 0 : 1e9) + Math.abs(e.ts - it.tsMs); // 有AI结论的优先, 同分取时间最近
          if (!best || score < best.score) best = { e: e, score: score };
        }
        ev = best ? best.e : null;
      }
      const nearbyPic = findCapturePic(capIdx, it.serial, it.tsMs);
      // 时间窗没命中事件时退回按图反查(旧路径兼容: 抓图文件名精确对应某条事件)
      if (!ev && nearbyPic) ev = evByFile[path.basename(nearbyPic)] || null;
      // 配图: 事件有自己的图就用它; 事件无图(抓图/截图全失败)才用就近抓图兜底 ——
      // 兜底场景事件本身没有AI结论(无图不分析), 不存在"结论与画面不符"
      it.pic = (ev && ev.file) ? ("/captures/" + encodeURIComponent(ev.file)) : nearbyPic;
      it.ai = ev && ev.ai && ev.ai !== "(点击AI分析)" ? String(ev.ai).trim() : "";
      // person 三态(2026-10-08 修): 原来 it.person 只取 ev.person===true 得到的布尔,
      // 于是 personFilter=none(无AI结论) **恒为 0 条** —— 筛选按钮点了永远空白。
      // 根因: events.json 的 person 只有 true/false 两态(实测 1154 true / 3747 false, 无第三态),
      // 「无AI结论」这条记录在 events.json 里是 person=true + ai 是占位文案, 跟"AI判有人"长得一样。
      // 正确的三态判据是 **ai 字段有没有真结论**:
      //   hasAi=false → null (无AI结论: 设备端人形标签直通, 或压根没跑过 AI)
      //   hasAi=true  → ev.person===true ? true : false
      const hasAi = !!(it.ai && it.ai !== "(点击AI分析)" && it.ai !== "(等待分析...)");
      it.hasAi = hasAi;
      it.person = !ev ? null : (hasAi ? (ev.person === true) : null);
      it.pushed = ev ? ev.pushed === true : false;   // 推送状态对齐 events.json 的 pushed 字段
      it.file = ev ? (ev.file || "") : "";          // 关联的抓图文件名, 供前端"未推送"按钮定位
      it.provider = ev ? (ev.provider || "") : "";  // AI分析模型名, 供前端卡片展示
      it.veh = ev ? (ev.veh || 0) : 0;             // 车辆标记
      delete it.tsMs;
      delete it.act;                                // 归并用的内部字段, 不外发
    }
    return g;
  });
  // 展平后按**时间全局倒序**(最新在前), 而不是"按组分块 + 组内倒序"。
  // 为什么: 2026-10-08 加了人形状分组后, 它有 1814 条有图条目 / 移动侦测 12672 条,
  // 若按组分块排, "全部"视图的前 19 页全被人形状占满, 移动侦测永远翻不到 ——
  // 而看这个页面的典型场景是"刚才那会儿到底上报了什么", 要的是一条时间线。
  // 各类型仍各自成组渲染(页面按组标题分段), 同一页内组内保持时间倒序。
  // 只保留有关联抓图(pic)的条目: 无截图的移动侦测推送是纯噪音, 不在看板展示
  let flat = [];
  for (const g of full) for (const it of g.items) if (it.pic) flat.push({ type: g.type, name: g.name, count: g.count, rawCount: g.rawCount, tsMs: it.tsMs, it: it });
  // 排序键必须用 tsMs(毫秒), **不能用 it.time 字符串** ——
  // 时间的月/日不补零("2026/9/30" vs "2026/10/8"), 字典序比较会把 9/30 排到 10/8 后面,
  // 表现为"第 1 页显示 9 月 30 日"而不是最新(2026-10-08 实测)。
  flat.sort(function (a, b) { return (b.tsMs || 0) - (a.tsMs || 0); });
  // 服务端类型筛选(看板点"移动侦测"/"宠物侦测"标签时传 type 参数, 按类型过滤后再分页)
  if (typeFilter && typeFilter !== "all") flat = flat.filter(function(x){ return x.type === typeFilter; });
  // 服务端设备筛选(device 参数, 2026-10-08 支持按**具体设备**筛):
  //   "all"          = 不限
  //   "双溪村"/"木山村" = 按村归并(deviceVillage 从设备名里的村名判断, 新设备只要命名带村名就能自动归对)
  //   其它值(设备 serial) = 只看这一台设备 —— 同村多台设备时必需,
  //     否则同一村里两台机只能"整村一起看", 无法单独查其中一台。
  if (deviceFilter && deviceFilter !== "all") {
    flat = flat.filter(function (x) {
      if (deviceVillage(x.it.serial) === deviceFilter) return true;   // 按村
      return x.it.serial === deviceFilter;                            // 按 serial 指定具体设备
    });
  }
  const grand = flat.length; // 类型+设备筛选后的池子(页面"全量 X 条"展示用)
  // 是否有人筛选(person 三态: true=有人, false=无人, null=无AI结论)
  if (personFilter === "yes") flat = flat.filter(function(x){ return x.it.person === true; });
  else if (personFilter === "no") flat = flat.filter(function(x){ return x.it.person === false; });
  else if (personFilter === "none") flat = flat.filter(function(x){ return x.it.person !== true && x.it.person !== false; });
  // 时间筛选(按条目时间的本地日历日)
  if (dayFilter && dayFilter !== "all") {
    const today = pushDayOffset(0), yesterday = pushDayOffset(1);
    flat = flat.filter(function(x){
      const k = pushDayKey(x.it.time);
      if (dayFilter === "today") return k === today;
      if (dayFilter === "yesterday") return k === yesterday;
      if (dayFilter === "before") return !!k && k < yesterday;
      return true;
    });
  }
  const total = flat.length;
  offset = Math.max(0, parseInt(offset, 10) || 0);
  limit = Math.max(1, Math.min(1000, parseInt(limit, 10) || 300));
  const page = flat.slice(offset, offset + limit);
  // 按本页首次出现顺序重新聚合 —— flat 已是时间倒序, 所以各组的先后 = 该组最新条目的时间先后,
  // 与全局时间线一致(不再按固定白名单顺序, 否则会出现"时间倒序但组块乱序"的错觉)
  const out = [], byType = {};
  for (const x of page) {
    // rawCount 一并带出: 页头可显示"已合并 N 条原始报文", 排查时能看到归并掉了多少
    if (!byType[x.type]) { byType[x.type] = { type: x.type, name: x.name, count: x.count, rawCount: x.rawCount, items: [] }; out.push(byType[x.type]); }
    byType[x.type].items.push(x.it);
  }
  return { groups: out, total: total, grand: grand, loaded: page.length };
}

function latestCapture(serial) {
  const dir = path.join(ROOT, "captures");
  let best = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.indexOf(serial + "_") !== 0) continue;
      if (!/\.(jpg|jpeg)$/i.test(f)) continue;
      const st = fs.statSync(path.join(dir, f));
      if (!best || st.mtimeMs > best.mtimeMs) best = { file: path.basename(f), mtimeMs: st.mtimeMs };
    }
  } catch (e) {}
  return best;
}

const _capInflight = {}; // 同设备并发抓图去重
async function doCapture(serial, forceNew) {
  if (!serial) serial = ((cfg.devices || [])[0] || {}).serial;
  if (!serial) throw new Error("没有可用的设备");
  if (_capInflight[serial]) {
    try { return await _capInflight[serial]; } catch (e) {}
  }
  const p = (async function() {
  if (!forceNew) {
    const latest = latestCapture(serial);
    if (latest && Date.now() - latest.mtimeMs < 600e3) {
      return { file: latest.file, time: new Date(latest.mtimeMs).toLocaleString("zh-CN",{hour12:false}), url: "/captures/" + latest.file, serial: serial, name: devName(serial), cached: true };
    }
  }
  // 高清抓图: 主码流截帧(3200x1800), 失败自动回落原抓图接口(768x432)
  const file = path.join(ROOT, "captures", serial + "_" + Date.now() + ".jpg");
  await hdcapture.captureHD(client, serial, file);
  return { file: path.basename(file), time: new Date().toLocaleString("zh-CN",{hour12:false}), url: "/captures/" + path.basename(file), serial: serial, name: devName(serial), cached: false, hd: true };
  })();
  _capInflight[serial] = p;
  try { return await p; } finally { delete _capInflight[serial]; }
}

async function doAnalyze(serial, modelName, existFile) {
  let cap;
  if (existFile && fs.existsSync(path.join(ROOT, "captures", existFile))) {
    cap = { file: existFile, time: "当前画面", serial: serial, name: devName(serial) };
  } else {
    cap = await doCapture(serial, true);
  }
  const providers = (cfg.ai.providers || []).filter(function(p){ return p.enabled; });
  let selected = providers[0];
  if (modelName) {
    const found = providers.find(function(p){ return p.name === modelName; });
    if (found) selected = found;
  }
  if (!selected) throw new Error("未找到可用模型");
  const singleCfg = Object.assign({}, cfg.ai, { providers: [selected] });
  const r = await analyzeImage(singleCfg, path.join(ROOT, "captures", cap.file));
  if (!r.ok) throw new Error(r.reason);
  const j = judgePerson(r.content);
  if (!j.matched) console.log("[AI] 结论无法解析(依据=" + j.source + "), 已标记: " + r.content.replace(/\s+/g, " ").slice(0, 60));
  // 如果该文件已有记录则更新，否则新增(放在同一个事务里, 避免"读完"到"写入"之间被别的进程插入)
  const nowStr = new Date().toLocaleString("zh-CN",{hour12:false});
  await mutateEvents(function (eventsArr) {
    var existing = eventsArr.find(function(e){ return e.file === cap.file; });
    if (existing) {
      existing.ai = r.content;
      existing.person = j.person;
      existing.abnormal = j.abnormal;
      existing.provider = providerLabel(selected.name);
      existing.time = nowStr;
      return true;
    }
    eventsArr.push({ ts: Date.now(), time: nowStr, serial: serial, name: devName(serial), file: cap.file, title: "Web实时分析", provider: providerLabel(selected.name), ai: r.content, person: j.person, abnormal: j.abnormal, pushed: false });
    return true;
  });
  // matched 一并返回: 前端据此区分"AI判了无人"与"AI输出没读懂", 避免把后者显示成"无人"
  return { file: cap.file, ai: r.content, provider: providerLabel(selected.name), person: j.person, abnormal: j.abnormal, matched: j.matched, time: new Date().toLocaleString("zh-CN",{hour12:false}) };
}

// ---- 萤石报警检测 ----
function loadAlarmState() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, "data", "alarm_state.json"), "utf8")); }
  catch (e) { return { seenAlarms: [], lastQuery: {} }; }
}
function saveAlarmState(s) {
  fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "data", "alarm_state.json"), JSON.stringify(s, null, 2));
}

async function checkDeviceAlarms(serial) {
  const state = loadAlarmState();
  const end = Date.now();
  // 从上次查询时间开始查（首次则回退30分钟），一条不漏也不浪费配额
  const last = (state.lastQuery || {})[serial];
  const start = last || (end - 30 * 60 * 1000);
  const results = [];
  try {
    const al = await client.alarms(serial, start, end, 20);
    if (al.code !== "200") return { ok: false, error: "报警查询失败 code=" + al.code + " " + (al.msg || "") };
    const fresh = (al.data || []).filter(function(a){ return state.seenAlarms.indexOf(a.alarmId) < 0; });
    fresh.reverse();
    // 每次最多处理5条，防止抓图+AI分析耗时过长；剩余下次查询再处理
    const limited = fresh.slice(0, 5);
    for (const a of limited) {
      state.seenAlarms.push(a.alarmId);
      // 报警检查只做抓图+记录，AI分析由用户手动触发（点"AI分析"按钮），避免阻塞
      // 时间用萤石报警时间(a.alarmTime)，不是系统时间
      // 报警自带截图优先(与 webhook refreshTodayEvents 同策略): 零拉流消耗且画面是报警
      // 时刻的场景; 无自带截图或下载失败才现场抓图兜底(2026-09-29 额度审查)
      var alarmTime = a.alarmTime ? new Date(a.alarmTime).toLocaleString("zh-CN",{hour12:false}) : new Date().toLocaleString("zh-CN",{hour12:false});
      var tsMs = new Date(a.alarmTime).getTime();
      if (!isFinite(tsMs)) tsMs = Date.now();
      var picFile = "";
      if (a.alarmPicUrl) {
        picFile = serial + "_a" + tsMs + ".jpg";
        try { await client.downloadTo(a.alarmPicUrl, path.join(ROOT, "captures", picFile)); }
        catch (eD) { picFile = ""; }
      }
      const f = picFile ? { file: picFile, time: alarmTime } : await doCapture(serial, true);
      await recordEvent({ ts: a.alarmTime || Date.now(), time: alarmTime, serial: serial, name: devName(serial), file: f.file, title: "移动侦测", provider: "", ai: "(点击AI分析)", person: false, abnormal: false, pushed: false });
      results.push({ file: f.file, time: f.time, person: false, abnormal: false, provider: "", ai: "(点击AI分析)" });
    }
    state.seenAlarms = state.seenAlarms.slice(-200);
    if (!state.lastQuery) state.lastQuery = {};
    state.lastQuery[serial] = end;
    saveAlarmState(state);
  } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true, count: results.length, events: results };
}

const _alarmInflight = {}; // 同设备报警检测并发锁
async function checkAllAlarms() {
  const targets = (cfg.devices || []).filter(function(d){ return d.watch; });
  // 多设备并行查询，不再串行等待
  const tasks = targets.map(function(t) {
    if (_alarmInflight[t.serial]) return Promise.resolve({ serial: t.serial, name: t.name, error: "正在检测中" });
    _alarmInflight[t.serial] = true;
    return checkDeviceAlarms(t.serial).then(function(r) {
      delete _alarmInflight[t.serial];
      return r.ok ? { serial: t.serial, name: t.name, count: r.count, events: r.events || [] } : { serial: t.serial, name: t.name, error: r.error };
    }).catch(function(e) {
      delete _alarmInflight[t.serial];
      return { serial: t.serial, name: t.name, error: e.message };
    });
  });
  return Promise.all(tasks);
}

// 萤石报警类型映射
const ALARM_TYPE_NAMES = { 10002: "移动侦测", 15504: "人形检测", 15505: "区域入侵" };
// 查询今日"有人"(人形检测15504等智能人型报警)：下载报警自带截图，不实时抓图、不AI分析
// 仅查指定 serial 一台设备（按 web 端当前选中设备）；已存在的 (serial+ts) 自动跳过不重复入库
async function checkTodayPersonAlarms(serial) {
  const allWatch = (cfg.devices || []).filter(function(d){ return d.watch; });
  const targets = serial
    ? allWatch.filter(function(d){ return d.serial === serial; })
    : allWatch;
  const now = Date.now();
  const startOfToday = new Date(); startOfToday.setHours(0,0,0,0);
  const start = startOfToday.getTime();
  var allEvents = loadEvents();
  var existingKeys = new Set(allEvents.map(function(e){ return e.serial + "@" + e.ts; }));
  var captured = 0;
  var perDevice = {}; // serial -> { name, added, exist }
  for (const t of targets) {
    perDevice[t.serial] = { name: t.name, added: 0, exist: 0 };
    if (_alarmInflight[t.serial]) continue;
    _alarmInflight[t.serial] = true;
    try {
      const al = await client.alarms(t.serial, start, now, 50);
      if (al.code !== "200") { console.log("[今日有人] " + t.name + " 查询失败 code=" + al.code); continue; }
      const list = (al.data || []).slice().reverse(); // 旧→新
      for (const a of list) {
        // 只要人形/人员类报警（15504 等 15xxx 智能检测），普通移动侦测(10002)不要
        var typeName = ALARM_TYPE_NAMES[a.alarmType] || ("报警" + a.alarmType);
        if (String(a.alarmType).indexOf("155") !== 0) continue;
        var ts = a.alarmTime || 0;
        if (existingKeys.has(t.serial + "@" + ts)) { perDevice[t.serial].exist++; continue; }
        // 优先下载报警自带截图（报警那一刻的画面）；失败则现场抓图兜底
        var fname = t.serial + "_a" + ts + ".jpg";
        var ok = false;
        if (a.alarmPicUrl) {
          try { await client.downloadTo(a.alarmPicUrl, path.join(ROOT, "captures", fname)); ok = true; }
          catch(e) { console.log("[今日有人] 截图下载失败,改抓图: " + e.message); }
        }
        if (!ok) { try { const f2 = await doCapture(t.serial, true); fname = f2.file; ok = true; } catch(e2) {} }
        if (!ok) continue;
        var alarmTime = ts ? new Date(ts).toLocaleString("zh-CN",{hour12:false}) : new Date().toLocaleString("zh-CN",{hour12:false});
        await recordEvent({ ts: ts || Date.now(), time: alarmTime, serial: t.serial, name: devName(t.serial), file: fname, title: typeName, provider: "", ai: "(点击AI分析)", person: true, abnormal: false, pushed: false });
        existingKeys.add(t.serial + "@" + ts);
        perDevice[t.serial].added++;
        captured++;
      }
    } catch(e) { console.log("[今日有人] " + t.name + " 查询失败: " + e.message); }
    finally { delete _alarmInflight[t.serial]; }
  }
  return {
    ok: true,
    count: captured,
    scanned: targets.length,
    devices: targets.map(function(t){ return Object.assign({ serial: t.serial }, perDevice[t.serial]); })
  };
}

let _lastEventCount = -1;
function detectNewEvents() {
  const count = loadEvents().length;
  const result = { hasNew: false, newCount: 0 };
  if (_lastEventCount >= 0 && count > _lastEventCount) { result.hasNew = true; result.newCount = count - _lastEventCount; }
  _lastEventCount = count;
  return result;
}
setInterval(detectNewEvents, 30000);

// ---- HTTP ----
function makeHandler() {
  return function (req, res) {
    const u = new URL(req.url, "http://localhost");
    const p = u.pathname;
    if (tokenGate(req, u, res)) return;
    if (p === "/__who") { sendJson(res, 200, { app: APP_NAME, version: VERSION, pid: process.pid }); return; }
    if (p === "/__shutdown") {
      if (u.searchParams.get("pid") === String(process.pid)) {
        sendJson(res, 200, { ok: true });
        console.log("[关闭] 收到新实例接管请求，正在退出...");
        removePidIfMine();
        setTimeout(function() { process.exit(0); }, 300);
      } else { res.writeHead(403); res.end(""); }
      return;
    }
    if (req.method === "GET" && p === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }
    if (req.method === "GET" && p === "/health") { sendJson(res, 200, { ok: true, app: APP_NAME, version: VERSION, pid: process.pid }); return; }
    if (req.method === "GET" && p === "/api/models") {
      const models = (cfg.ai.providers || []).filter(function(pr){ return pr.enabled; })
        .map(function(pr){ return { name: pr.name, model: pr.model, label: providerLabel(pr.name) + " · " + pr.model }; });
      sendJson(res, 200, { models: models });
      return;
    }
    if (req.method === "GET" && p === "/api/devices") {
      const devs = (cfg.devices || []).filter(function(d){ return !d.hidden; })
        .map(function(d){ return { serial: d.serial, name: d.name, watch: !!d.watch, ptz: !!d.ptz }; });
      sendJson(res, 200, { devices: devs });
      return;
    }
    if (req.method === "GET" && p === "/api/stats") {
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const evts = loadEvents().filter(function(e){ return (e.ts || 0) >= todayStart && e.source !== "kanjia"; });
      const personEvts = evts.filter(function(e){ return e.person === true; });
      const aiEvts = evts.filter(function(e){ return e.ai && e.ai !== "(点击AI分析)" && e.ai !== "(等待分析...)"; });
      const deviceCount = (cfg.devices || []).filter(function(d){ return d.watch && !d.hidden; }).length;
      const lastEvt = evts.length ? evts[evts.length - 1] : null;
      sendJson(res, 200, {
        personToday: personEvts.length,
        totalToday: evts.length,
        deviceCount: deviceCount,
        aiAnalyzed: aiEvts.length,
        aiRate: evts.length ? Math.round(aiEvts.length / evts.length * 100) : 0,
        lastTime: lastEvt ? lastEvt.time : ""
      });
      return;
    }
    if (req.method === "GET" && p === "/api/events/changed") { sendJson(res, 200, detectNewEvents()); return; }
    if (req.method === "GET" && p === "/api/push-log") {
      const limit = parseInt(u.searchParams.get("limit") || "300", 10);
      const offset = parseInt(u.searchParams.get("offset") || "0", 10);
      const type = u.searchParams.get("type") || "all";
      const device = u.searchParams.get("device") || "all"; // all/双溪村/木山村
      const person = u.searchParams.get("person") || "all"; // all/yes/no/none
      const day = u.searchParams.get("day") || "all";       // all/today/yesterday/before
      const r = buildPushGroups(limit, offset, type, device, person, day);
      sendJson(res, 200, { total: r.total, grand: r.grand, loaded: r.loaded, hasMore: offset + r.loaded < r.total, groups: r.groups });
      return;
    }
    // 有人记录专用接口: 从 events.json 读取(支持长期历史, 远超过 push_log 的200条限制)
    if (req.method === "GET" && p === "/api/person-events") {
      const day = u.searchParams.get("day") || "all";
      const village = u.searchParams.get("village") || "all"; // all/双溪村/木山村
      const limit = parseInt(u.searchParams.get("limit") || "200", 10);
      const offset = parseInt(u.searchParams.get("offset") || "0", 10);
      // 时间范围(本地时区): all=不限; today=今天; yesterday=昨天; before=前天及更早; date:YYYY-MM-DD=指定日期
      let tsStart = 0, tsEnd = Infinity;
      if (day === "today" || day === "yesterday" || day === "before" || day.indexOf("date:") === 0) {
        const base = new Date();
        if (day === "yesterday") base.setDate(base.getDate() - 1);
        const d0 = new Date(base.getFullYear(), base.getMonth(), base.getDate()); // 目标"今天"00:00
        if (day === "today" || day === "yesterday") {
          tsStart = d0.getTime();
          tsEnd = tsStart + 86400000; // +1天
        } else if (day === "before") {
          tsEnd = d0.getTime(); // 今天00:00之前(即排除今/昨)
        } else {
          // date:YYYY-MM-DD —— 用户选择的任意日期
          const m = day.slice(5).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
          if (m) {
            const p0 = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
            tsStart = p0.getTime();
            tsEnd = tsStart + 86400000;
          }
        }
      }
      let events = loadEvents().filter(function(e){
        if (e.source === "kanjia") return false; // 排除看家主动抓图
        if (e.person !== true) return false;
        if (village !== "all" && deviceVillage(e.serial) !== village) return false; // 按村筛选
        const t = e.ts || 0;
        if (t < tsStart || t >= tsEnd) return false; // 时间范围筛选
        return true;
      });
      const total = events.length;
      // 分页(limit 上限 500, 数据量大时保证渲染性能)
      const page = events.slice().reverse().slice(offset, offset + limit);
      // 转为与推送记录一致的格式, 复用 renderPersonRecords
      const items = page.map(function(e){
        const d = new Date(e.ts || 0);
        return {
          ts: e.ts || 0, // 带上时间戳, 前端排序/分组用(避免字符串排序错乱)
          time: e.time || d.toLocaleString("zh-CN", { hour12: false }),
          devName: e.name || e.serial || "",
          serial: e.serial || "",
          person: !!e.person,
          ai: e.ai || "",
          pic: e.file ? ("/captures/" + encodeURIComponent(e.file)) : "", // 高清原图(保存即3200x1800主码流截帧), 前端懒加载
          origin: e.file ? ("/captures/" + encodeURIComponent(e.file)) : "", // 灯箱同用原图
          provider: e.provider || "",
          file: e.file || "",
          pushed: !!e.pushed
        };
      });
      sendJson(res, 200, { total: total, loaded: items.length, groups: [{ name: "有人活动", type: "person", count: items.length, items: items }] });
      return;
    }
    if (req.method === "POST" && p === "/api/events/delete") {
      let body = "";
      req.on("data", function(chunk){ body += chunk; });
      req.on("end", async function() {
        try {
          const d = JSON.parse(body);
          // 定位一条记录: 有 file 就按 file 比; **没有 file 的**(萤石人形标签消息不带截图、
          // 兜底抓图又失败时记录里 file 是空串, 看板上显示"无截图")只能按 设备+时间戳 比。
          // 以前这里直接拿空 file 去 indexOf, 会一次删掉所有无图记录 —— 典型的过度删除。
          function sameEvent(e, it) {
            if (it && it.file) return e.file === it.file;
            if (!it || !it.ts) return false; // 既没有 file 也没有 ts: 不匹配任何记录, 绝不误删
            return String(e.serial || "") === String(it.serial || "") && Number(e.ts) === Number(it.ts);
          }
          const items = (Array.isArray(d.items) && d.items.length) ? d.items
            : (Array.isArray(d.files) ? d.files.map(function (f) { return { file: f }; })
              : (d.file ? [{ file: d.file }] : null));
          if (!items) { sendJson(res, 400, { error: "缺少 file / files / items 参数" }); return; }
          const r = await mutateEvents(function (arr) {
            let n = 0;
            for (let i = arr.length - 1; i >= 0; i--) {
              if (items.some(function (it) { return sameEvent(arr[i], it); })) { arr.splice(i, 1); n++; }
            }
            return n > 0;
          });
          sendJson(res, r.ok ? 200 : 500, r.ok ? { ok: true, deleted: items.length } : { error: "写入被占用，请重试" });
        } catch (e) { sendJson(res, 500, { error: e.message }); }
      });
      return;
    }
    if (req.method === "POST" && p === "/api/events/delete-all") {
      (async function () {
        const r = await mutateEvents(function (arr) { arr.length = 0; return true; });
        if (!r.ok) { sendJson(res, 500, { error: "写入被占用，请重试" }); return; }
        saveAlarmState({ seenAlarms: [], lastQuery: {} }); // 同步清空，避免删完后查不到
        _lastEventCount = loadEvents().length;
        sendJson(res, 200, { ok: true });
      })();
      return;
    }
    if (req.method === "GET" && p === "/api/events") {
      const person = u.searchParams.get("person") || "all";
      let arr = loadEvents().slice().reverse();
      if (person === "yes") arr = arr.filter(function(e){ return e.person === true; });
      if (person === "no") arr = arr.filter(function(e){ return e.person === false; });
      const limit = parseInt(u.searchParams.get("limit") || "100", 10);
      arr = arr.slice(0, Math.max(1, Math.min(500, limit)));
      sendJson(res, 200, { count: arr.length, events: arr });
      return;
    }
    if (req.method === "GET" && p === "/api/capture") {
      (async function() {
        try { sendJson(res, 200, await doCapture(u.searchParams.get("serial"), u.searchParams.get("force") === "1")); }
        catch(e) { sendJson(res, 500, { error: e.message }); }
      })();
      return;
    }
    if (req.method === "GET" && p === "/api/analyze") {
      (async function() {
        try { sendJson(res, 200, await doAnalyze(u.searchParams.get("serial"), u.searchParams.get("model"), u.searchParams.get("file"))); }
        catch(e) { sendJson(res, 500, { error: e.message }); }
      })();
      return;
    }
    if (req.method === "GET" && p === "/api/alarms/check") {
      (async function() {
        try {
          const serial = u.searchParams.get("serial");
          sendJson(res, 200, serial ? await checkDeviceAlarms(serial) : await checkAllAlarms());
        } catch(e) { sendJson(res, 500, { error: e.message }); }
      })();
      return;
    }
    if (req.method === "GET" && p === "/api/alarms/check-today") {
      (async function() {
        try {
          // ?serial=xxx 可选：不传/为空 = 全部 watch 设备；传了 = 只查当前选中那一台
          const serial = u.searchParams.get("serial") || "";
          sendJson(res, 200, await checkTodayPersonAlarms(serial));
        } catch(e) { sendJson(res, 500, { error: e.message }); }
      })();
      return;
    }
    if (req.method === "GET" && p.indexOf("/captures/") === 0) {
      let rel = decodeURIComponent(p.slice("/captures/".length));
      // 移动侦测暂存图在 captures/motion/ 子目录(见 webhook.js 的分级留存), 单独放行
      let dir = path.join(ROOT, "captures");
      if (rel.indexOf("motion/") === 0) { dir = path.join(ROOT, "captures", "motion"); rel = rel.slice("motion/".length); }
      const name = path.basename(rel); // basename 兜底防路径穿越
      if (!/^[A-Za-z0-9_\-]+\.(jpg|jpeg)$/i.test(name)) { res.writeHead(400); res.end(""); return; }
      fs.readFile(path.join(dir, name), function(err, buf) {
        if (err) { res.writeHead(404); res.end(""); return; }
        res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "max-age=600" });
        res.end(buf);
      });
      return;
    }
    // 单用户推送: 只推给 config.push.selfOpenid, 不推其他人
    // 调用 pushTestTemplate 构造完整字段(kw3=AI结论/kw4=报警类型/kw5=现场照片/detailUrl=详情链接)
    // 解决单用户推送只传 first/keyword1/keyword2/remark 导致 AI分析/报警类型/现场照片/详情链接全空白的问题
    if (req.method === "POST" && p === "/api/push-single") {
      let body = "";
      req.on("data", function(chunk){ body += chunk; });
      req.on("end", async function() {
        try {
          const d = JSON.parse(body);
          const selfOpenid = cfg.push && cfg.push.selfOpenid;
          if (!selfOpenid) { sendJson(res, 400, { error: "未配置 push.selfOpenid，请在 config.json 中填写你自己的微信 openid" }); return; }
          const file = d.file || "";
          const serial = d.serial || "";
          const ai = d.ai || "";
          const person = d.person;
          const title = d.title || (person === true ? "有人" : person === false ? "无人" : "监控") + " · " + (serial || "");
          const time = d.time || new Date().toLocaleString("zh-CN", { hour12: false });
          const devName = d.name || serial || "";
          // 构造完整字段(与 webhook.js pushTestTemplate 调用保持一致)
          let kw3 = "";
          if (ai) {
            const lines = String(ai).split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
            const head = person === true ? "🟢 有人" : person === false ? "⚪ 无人" : (lines[0] || "结论未识别").slice(0, 8);
            const why = (lines.filter(function (l) { return l.indexOf("依据") >= 0; })[0] || "")
              .replace(/^依据[:：]?\s*/, "").split(/[，。；！？]/)[0].replace(/[，。；！？]$/, "").slice(0, 16);
            kw3 = (head + (why ? "：" + why : "")).slice(0, 30);
          } else {
            kw3 = "⏳ AI未判读，详见看板";
          }
          const kw4 = d.alarmType || (person === true || person === false ? "人形检测" : "移动侦测");
          const kw5 = file ? "✅ 有现场照片" : "❌ 未取到照片";
          // 详情链接(点击卡片跳转)
          const pubBase = String(((cfg.wxTest || {}).publicBase) || "").replace(/\/$/, "");
          let detailUrl = "";
          if (file && pubBase) detailUrl = pubBase + "/detail?file=" + encodeURIComponent(file);
          else if (pubBase) detailUrl = pubBase + "/today" + (serial ? "?serial=" + encodeURIComponent(serial) : "");
          const remark = detailUrl ? (file ? "点击查看现场照片与 AI 分析 👉" : "本次未取到照片，点击查看今日记录 👉") : "本次未取到照片（内网穿透未开启）";
          // 调用 pushTestTemplate 只推给 selfOpenid
          const r = await pushTestTemplate(title, time, devName, remark, detailUrl, true, { allowOid: function(oid) { return oid === selfOpenid; }, serial: serial, kw3: kw3, kw4: kw4, kw5: kw5 });
          if (!r) { sendJson(res, 500, { error: "推送失败" }); return; }
          // 推送成功后更新 pushed 字段
          if (file) {
            const mr = await mutateEvents(function(arr) {
              const ev = arr.find(function(e){ return e.file === file; });
              if (ev && !ev.pushed) { ev.pushed = true; return true; }
              return false;
            });
            if (!mr.ok) console.log("[push-single] 更新 pushed 字段失败: " + (mr.error && mr.error.message));
          }
          sendJson(res, 200, { ok: true, detail: "推送给 " + selfOpenid.slice(0, 6) });
        } catch (e) { sendJson(res, 500, { error: e.message }); }
      });
      return;
    }
    res.writeHead(404);
    res.end("");
  };
}

let currentServer = null;
function startServer(retry) {
  currentServer = http.createServer(makeHandler());
  currentServer.once("error", function(err) {
    if (err.code === "EADDRINUSE" && retry) {
      console.log("[启动] 端口 " + PORT + " 被占用，尝试接管后重试...");
      (async function() {
        try { await shutdownOldInstance(); } catch (e) {}
        setTimeout(function(){ startServer(false); }, 500);
      })();
    } else {
      console.error("[启动失败]", err.message);
      process.exit(1);
    }
  });
  currentServer.listen(PORT, function() {
    console.log("=== 报警看板已启动 v" + VERSION + " (PID " + process.pid + ") ===");
    console.log("地址: http://localhost:" + PORT + "/");
    console.log("功能: 实时抓图 / AI分析 / 查报警 / 模型切换 / 历史报警(可删除)");
  });
}

cleanupStaleInstance().then(function() { startServer(true); });

// 启动时自动抓一轮所有在线设备的画面
setTimeout(async function() {
  const targets = (cfg.devices || []).filter(function(d){ return d.watch; });
  for (const t of targets) {
    try {
      const latest = latestCapture(t.serial);
      if (latest && Date.now() - latest.mtimeMs < 600e3) {
        console.log("[启动抓图] " + t.name + " 已有缓存，跳过");
        continue;
      }
      await doCapture(t.serial, true);
      console.log("[启动抓图] " + t.name + " OK");
    } catch(e) {
      console.log("[启动抓图] " + t.name + " 失败: " + e.message);
    }
  }
}, 1500);

function gracefulExit() {
  console.log("\n正在关闭...");
  removePidIfMine();
  try { if (currentServer) currentServer.close(); } catch (e) {}
  setTimeout(function() { process.exit(0); }, 800);
}

process.on("SIGINT", gracefulExit);
process.on("SIGTERM", gracefulExit);