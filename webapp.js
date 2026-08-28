#!/usr/bin/env node
// 电脑 Web 报警看板 + 实时控制（零依赖, Node >= 18）
// 运行: node webapp.js  ->  浏览器打开 http://localhost:8790
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { createClient } = require("./lib/ys7");
const { analyzeImage } = require("./lib/ai");

const ROOT = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const PORT = ((cfg.webapp || {}).port) || 8790;
const VERSION = "2026-08-25.25";
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
const PROVIDER_LABELS = { zhipu: "GLM-4v", agnes: "Agnes", xiaohongshu: "小红书" };
function providerLabel(name) { return PROVIDER_LABELS[name] || name; }

const PAGE = fs.existsSync(path.join(ROOT, "webapp.html"))
  ? fs.readFileSync(path.join(ROOT, "webapp.html"), "utf8")
  : "<h1>webapp.html 未找到</h1>";

function loadEvents() {
  try {
    const arr = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "events.json"), "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function saveEvents(arr) {
  if (arr.length > 500) arr = arr.slice(-500);
  fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "data", "events.json"), JSON.stringify(arr, null, 1));
}
function recordEvent(ev) { const arr = loadEvents(); arr.push(ev); saveEvents(arr); }
function deleteEventByFile(file) { saveEvents(loadEvents().filter(function(e){ return e.file !== file; })); return true; }

function judgePerson(content) {
  const c = String(content || "");
  const m = c.match(/【(有人|无人)】/);
  let person = m ? (m[1] === "有人") : /(有人|人员活动|检测到人|出现人|一个人)/.test(c);
  const negated = /(无异常|没有.*?异常|看不到.*?异常|未发现.*?异常)/.test(c);
  const abnormal = /(异常|需关注|注意|陌生|闯入)/.test(c) && !negated;
  return { person: person, abnormal: abnormal };
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function devName(serial) {
  const d = (cfg.devices || []).find(function(x){ return x.serial === serial; });
  return d ? d.name : serial;
}

// ---- 萤石推送记录（webhook 收到的 push_log.json，按消息类型分组展示） ----
const PUSH_TYPE_NAMES = {
  "sound_detection": "声音侦测",
  "10002": "移动侦测", "15504": "人形检测", "15505": "区域入侵", "15506": "人形侦测",
  "device_online": "设备上线", "device_offline": "设备离线", "online": "设备上线", "offline": "设备离线",
  "intelligentDetection": "智能检测", "SmartHumanDet": "人形检测", "AI": "AI算法结果", "agent": "AI算法结果",
  "VMD": "视频移动侦测", "motiondetect": "移动侦测", "pet_detection": "宠物侦测", "PetDetection": "宠物侦测",
  "storage_status": "存储状态"
};
function pushTypeName(type) {
  if (PUSH_TYPE_NAMES[type]) return PUSH_TYPE_NAMES[type];
  if (String(type).indexOf("155") === 0) return "人形检测";
  if (String(type).indexOf("Ircut") === 0) return "红外滤光切换";
  if (String(type).indexOf("IntelligentTag") === 0) return "智能标签";
  if (String(type).indexOf("Pet") === 0 || String(type).indexOf("pet") === 0) return "宠物侦测";
  return type;
}
function loadPushLog() {
  try {
    const arr = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "push_log.json"), "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function buildPushGroups(limit) {
  // 只展示"移动侦测"(含 VMD/video_motion/10002) 和"宠物侦测"两个分类, 其他全过滤
  const VISIBLE = { "motiondetect": "移动侦测", "pet": "宠物侦测" };
  const logs = loadPushLog().slice(-Math.max(1, Math.min(1000, limit || 300)));
  const groups = {}, order = [];
  for (const e of logs) {
    let body = e.body || e;
    try { if (typeof body === "string") body = JSON.parse(body); if (body && body.body) body = body.body; } catch (err) {}
    if (!body || typeof body !== "object") continue;
    const rawType = String(body.alarmType || body.type || body.eventType || body.msgType || body.identifier || body.messageType || "unknown");
    // 归类: VMD/motiondetect/10002/video_motion 全部合并到移动侦测; pet/PetDetection → 宠物侦测
    let key = "";
    if (rawType === "VMD" || rawType === "motiondetect" || rawType === "10002" || /^video_motion/i.test(rawType)) key = "motiondetect";
    else if (/pet/i.test(rawType)) key = "pet";
    else continue; // 智能标签/声音/存储/上下线/人形... 全部丢弃
    const serial = String(body.devSerial || body.serial || body.deviceId || "?");
    let time = String(body.alarmTime || body.time || e.time || e.ts || "");
    const text = String(body.describe || body.content || body.text || body.channelName || "");
    if (!time && body.payload && String(body.payload).indexOf("dateTime") >= 0) {
      const m = String(body.payload).match(/"dateTime":"([^"]+)"/);
      if (m) time = m[1];
    }
    if (!groups[key]) { groups[key] = { type: key, name: VISIBLE[key], count: 0, items: [] }; order.push(key); }
    groups[key].count++;
    groups[key].items.push({ time: time.slice(0, 19), serial: serial, devName: devName(serial), text: text.slice(0, 120) });
  }
  // 固定按白名单顺序展示: 移动侦测 → 宠物侦测
  return ["motiondetect", "pet"].filter(function(k){ return groups[k]; }).map(function(t){
    const g = groups[t];
    g.items = g.items.slice(-20).reverse();
    return g;
  });
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
  const r = await client.capture(serial);
  if (r.code !== "200") throw new Error("抓图失败 code=" + r.code + " " + (r.msg || ""));
  const d = r.data;
  const url = Array.isArray(d) ? d[0].picUrl : d.picUrl;
  const file = path.join(ROOT, "captures", serial + "_" + Date.now() + ".jpg");
  await client.downloadTo(url, file);
  return { file: path.basename(file), time: new Date().toLocaleString("zh-CN",{hour12:false}), url: "/captures/" + path.basename(file), serial: serial, name: devName(serial), cached: false };
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
  // 如果该文件已有记录则更新，否则新增
  var eventsArr = loadEvents();
  var existing = eventsArr.find(function(e){ return e.file === cap.file; });
  if (existing) {
    existing.ai = r.content;
    existing.person = j.person;
    existing.abnormal = j.abnormal;
    existing.provider = providerLabel(selected.name);
    existing.time = new Date().toLocaleString("zh-CN",{hour12:false});
    saveEvents(eventsArr);
  } else {
    recordEvent({ ts: Date.now(), time: new Date().toLocaleString("zh-CN",{hour12:false}), serial: serial, name: devName(serial), file: cap.file, title: "Web实时分析", provider: providerLabel(selected.name), ai: r.content, person: j.person, abnormal: j.abnormal, pushed: false });
  }
  return { file: cap.file, ai: r.content, provider: providerLabel(selected.name), person: j.person, abnormal: j.abnormal, time: new Date().toLocaleString("zh-CN",{hour12:false}) };
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
      const f = await doCapture(serial, true);
      // 报警检查只做抓图+记录，AI分析由用户手动触发（点"AI分析"按钮），避免阻塞
      // 时间用萤石报警时间(a.alarmTime)，不是系统时间
      var alarmTime = a.alarmTime ? new Date(a.alarmTime).toLocaleString("zh-CN",{hour12:false}) : new Date().toLocaleString("zh-CN",{hour12:false});
      recordEvent({ ts: a.alarmTime || Date.now(), time: alarmTime, serial: serial, name: devName(serial), file: f.file, title: "移动侦测", provider: "", ai: "(点击AI分析)", person: false, abnormal: false, pushed: false });
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
        recordEvent({ ts: ts || Date.now(), time: alarmTime, serial: t.serial, name: devName(t.serial), file: fname, title: typeName, provider: "", ai: "(点击AI分析)", person: true, abnormal: false, pushed: false });
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
    if (req.method === "GET" && p === "/api/events/changed") { sendJson(res, 200, detectNewEvents()); return; }
    if (req.method === "GET" && p === "/api/push-log") {
      const limit = parseInt(u.searchParams.get("limit") || "300", 10);
      const groups = buildPushGroups(limit);
      sendJson(res, 200, { total: groups.reduce(function(s, g){ return s + g.count; }, 0), groups: groups });
      return;
    }
    if (req.method === "POST" && p === "/api/events/delete") {
      let body = "";
      req.on("data", function(chunk){ body += chunk; });
      req.on("end", function() {
        try {
          const d = JSON.parse(body);
          if (d.files && Array.isArray(d.files)) {
            // 批量删除
            saveEvents(loadEvents().filter(function(e){ return d.files.indexOf(e.file) < 0; }));
            sendJson(res, 200, { ok: true, deleted: d.files.length });
          } else if (d.file) {
            deleteEventByFile(d.file);
            sendJson(res, 200, { ok: true });
          } else {
            sendJson(res, 400, { error: "缺少 file 或 files 参数" });
          }
        } catch (e) { sendJson(res, 500, { error: e.message }); }
      });
      return;
    }
    if (req.method === "POST" && p === "/api/events/delete-all") {
      saveEvents([]);
      saveAlarmState({ seenAlarms: [], lastQuery: {} }); // 同步清空，避免删完后查不到
      _lastEventCount = loadEvents().length;
      sendJson(res, 200, { ok: true });
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
      const name = path.basename(decodeURIComponent(p.slice("/captures/".length)));
      if (!/^[A-Za-z0-9_\-]+\.(jpg|jpeg)$/i.test(name)) { res.writeHead(400); res.end(""); return; }
      fs.readFile(path.join(ROOT, "captures", name), function(err, buf) {
        if (err) { res.writeHead(404); res.end(""); return; }
        res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "max-age=3600" });
        res.end(buf);
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