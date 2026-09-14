#!/usr/bin/env node
// 公众号「看家」被动查询服务 · 零框架依赖（仅 jimp 用于缩略图, Node >= 18）
// 用法: 先开内网穿透指向本服务端口, 再到公众号后台「设置与开发->基本配置->服务器配置」启用:
//   URL = 穿透公网地址   Token = config.json 里 wxServer.token   消息加解密 = 明文模式
// 家人关注公众号后发送【看家】/【门口】等关键词, 几秒内收到对应摄像头的现场照片
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { createClient } = require("./lib/ys7");
const { judgePerson } = require("./lib/judge"); // 判人逻辑唯一实现(与 monitor/webapp 共用)
const store = require("./lib/store"); // events.json 跨进程事务存储(与 monitor/webapp 共用同一把锁)

const ROOT = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const WX = cfg.wxServer || {};
const PORT = WX.port || 8787;
const VERSION = "2026-09-12.36"; // +自动AI判读回写 provider(看板据此区分"AI 判定"与"设备端人形标签直通"); prompt 抗幻觉重写见 config.json
// 变更历史 2026-09-12.33: events.json 三进程并发写改为 lib/store 跨进程事务(文件锁+锁内重读), 修复读改写期间夹 await 导致的丢事件
// 变更历史 2026-09-04.31: +历史查询:文本指令「查询双溪村10点左右的监控」按时段返回报警截图+AI结论(不筛是否有人,云端按窗补录) // +/history历史页(有人记录+历史日报按日回看)+/api/history-* 3接口 // 日报快照存档data/daily_reports/ // events保留上限500→storage.eventRetention(默认20000≈90天,配合截图90天)
const PID_FILE = path.join(ROOT, "data", "webhook.pid");
const client = createClient(cfg);

// ---------- 抓图分级留存 ----------
// 原来所有截图都平铺在 captures/ 一个目录里, 但其中约 80% 是"普通移动侦测"(画面里有车开过、
// 树叶晃动、光斑变化)。这类消息高频(实测 200 条推送里 159 条)、不推微信、不进看板, 下载后
// 再没有任何记录引用它 —— 成了孤儿图(实测 11692 张里 11261 张 = 96.3%, 白占 638MB)。
// 改为两个目录、两套保留期:
//   captures/         事件图(人形/车辆/AI结论等有推送价值的画面) —— storage.captureRetentionDays(默认60天)
//   captures/motion/  移动侦测的临时素材, 只给"同一次活动的垫图"当备用帧 —— storage.motionRetentionHours(默认3小时)
// motion 图仍会被垫图逻辑捡走: 人形标签消息自带截图为空时, 会从这里取帧并"搬进"主目录长期留存。
const CAPTURE_DIR = path.join(ROOT, "captures");
const MOTION_DIR = path.join(CAPTURE_DIR, "motion");
function motionRetentionMs() {
  const h = Number((cfg.storage && cfg.storage.motionRetentionHours) || 3);
  return (h > 0 ? h : 3) * 3600e3;
}

// 判断请求是否来自本机回环（127.0.0.1 / ::1）。来自公网隧道的请求不算本地。
function isLoopback(req) {
  const a = req.socket && req.socket.remoteAddress;
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

// ---------- 自愈启动：HTTP 握手识别并接管旧实例（零子进程） ----------
const APP_NAME = "webhook";
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
cleanupStaleInstance();

function checkSignature(q) {
  if (!WX.token || !q.signature || !q.timestamp || !q.nonce) return false;
  const sha1 = crypto.createHash("sha1")
    .update([WX.token, q.timestamp, q.nonce].sort().join(""))
    .digest("hex");
  return sha1 === q.signature;
}

function xmlVal(xml, tag) {
  const open = "<" + tag + ">", close = "</" + tag + ">";
  let s = xml.indexOf(open);
  if (s < 0) return "";
  s += open.length;
  const e = xml.indexOf(close, s);
  if (e < 0) return "";
  let v = xml.slice(s, e);
  if (v.indexOf("<![CDATA[") === 0) v = v.slice(9, v.length - 3);
  return v.trim();
}

function pickDevice(text) {
  for (const c of (WX.commands || [])) {
    if ((c.keywords || []).some(function (k) { return text.indexOf(k) >= 0; })) {
      const d = (cfg.devices || []).find(function (x) { return x.serial === c.device && x.watch; });
      if (d) return d;
    }
  }
  return (cfg.devices || []).find(function (d) { return d.watch; }) || (cfg.devices || [])[0];
}

function latestCapture(serial) {
  // 只扫 captures/ 主目录, **故意不扫 motion/**:
  // 返回值会被 recordKanjiaCapture() 记进 events 的 file 字段, 而 motion 图只保留几小时 ——
  // 一旦记进去, 几小时后这条记录就成了"有记录、图已裂"。
  // 主目录也不会空: handleKanJia 每次查询后都会异步预抓一张存着(见那里 freshCapture 那行),
  // 所以「看家」的 30 秒新鲜度缓存照旧能命中, 不会多烧抓图配额。
  let best = null;
  try {
    for (const f of fs.readdirSync(CAPTURE_DIR)) {
      if (f.indexOf(serial) !== 0 || f.slice(-4).toLowerCase() !== ".jpg") continue;
      const p = path.join(CAPTURE_DIR, f);
      const st = fs.statSync(p);
      if (!best || st.mtimeMs > best.mtimeMs) best = { file: p, mtimeMs: st.mtimeMs };
    }
  } catch (e) { /* 目录不存在 */ }
  return best;
}

var _tkInflight = {}; // 同账号并发取token只发一次请求(防互踩把新token刷成"not latest")
function isTokErr(x) { return x === 40001 || x === 42001 || x === 40014 || /"errcode":\s*(40001|42001|40014)\b/.test(String(x)); }
async function getWxToken(appId, appSecret, cacheName, force) {
  const cacheFile = path.join(ROOT, "data", cacheName);
  const key = appId + "@" + cacheName;
  if (!force) {
    try {
      const t = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      if (t.access_token && t.expireAt > Date.now() + 120e3) return t.access_token;
    } catch (e) { /* 无缓存 */ }
    if (_tkInflight[key]) return _tkInflight[key];
  }
  const p = (async function () {
    const res = await fetch("https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=" + appId + "&secret=" + appSecret);
    const j = await res.json();
    if (!j.access_token) throw new Error("获取access_token失败 " + JSON.stringify(j).slice(0, 150));
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({ access_token: j.access_token, expireAt: Date.now() + (j.expires_in || 7200) * 1000 }));
    return j.access_token;
  })();
  if (!force) {
    _tkInflight[key] = p.finally(function () { delete _tkInflight[key]; });
    return _tkInflight[key];
  }
  return p;
}
async function wxAccessToken(force) { // force=true: 忽略缓存强刷(40001自愈)
  return getWxToken(WX.appId, WX.appSecret, "wx_token.json", force);
}

async function uploadTempImage(file, token) {
  if (!token) token = await wxAccessToken();
  const boundary = "----aicamBoundary" + Date.now();
  const buf = fs.readFileSync(file);
  const parts = [];
  parts.push("--" + boundary);
  parts.push('Content-Disposition: form-data; name="media"; filename="cam.jpg"');
  parts.push("Content-Type: image/jpeg");
  parts.push("");
  const head = Buffer.from(parts.join("\r\n") + "\r\n", "utf8");
  const tail = Buffer.from("\r\n--" + boundary + "--\r\n", "utf8");
  const res = await fetch("https://api.weixin.qq.com/cgi-bin/media/upload?access_token=" + token + "&type=image", {
    method: "POST",
    headers: { "Content-Type": "multipart/form-data; boundary=" + boundary },
    body: Buffer.concat([head, buf, tail])
  });
  const j = await res.json();
  if (!j.media_id) throw new Error("上传素材失败 " + JSON.stringify(j).slice(0, 150));
  return j.media_id;
}

function replyImage(fromUser, toUser, mediaId) {
  return "<xml><ToUserName><![CDATA[" + fromUser + "]]></ToUserName>" +
    "<FromUserName><![CDATA[" + toUser + "]]></FromUserName>" +
    "<CreateTime>" + Math.floor(Date.now() / 1000) + "</CreateTime>" +
    "<MsgType><![CDATA[image]]></MsgType>" +
    "<Image><MediaId><![CDATA[" + mediaId + "]]></MediaId></Image></xml>";
}
function replyText(fromUser, toUser, content) {
  return "<xml><ToUserName><![CDATA[" + fromUser + "]]></ToUserName>" +
    "<FromUserName><![CDATA[" + toUser + "]]></FromUserName>" +
    "<CreateTime>" + Math.floor(Date.now() / 1000) + "</CreateTime>" +
    "<MsgType><![CDATA[text]]></MsgType>" +
    "<Content><![CDATA[" + content + "]]></Content></xml>";
}

// ---------- 萤石开放平台 消息推送接收端 ----------
// 控制台「消息推送」填回调地址: https://隧道域名/ezviz/push
// config.json 可选配置: "ezvizPush": { "secret": "签名密钥", "strictVerify": true }
const PUSH_LOG = path.join(ROOT, "data", "push_log.json");
const ALARM_TYPE_NAMES = { 10002: "移动侦测", 15504: "人形检测", 15505: "区域入侵", SmartHumanDet: "人形检测", intelligentDetection: "智能侦测", SmartVehicleDet: "车辆检测", VehicleDet: "车辆检测", CarDet: "车辆检测" };

function logPush(entry) {
  try {
    fs.mkdirSync(path.dirname(PUSH_LOG), { recursive: true });
    let arr = [];
    try { arr = JSON.parse(fs.readFileSync(PUSH_LOG, "utf8")); if (!Array.isArray(arr)) arr = []; } catch (e) {}
    arr.push(entry);
    fs.writeFileSync(PUSH_LOG, JSON.stringify(arr.slice(-200), null, 1));
  } catch (e) {}
}
// events.json 统一走 lib/store: 跨进程文件锁 + 「锁内重读最新内容再改」的事务。
// 原来这里是"读全量 -> 改 -> 写全量", webhook/webapp/monitor 三个进程交错时会互相整份覆盖,
// 刚写进去的报警会被另一个进程用早一毫秒读到的旧数组盖掉(丢事件)。
function loadEventsArr() { return store.readEvents(ROOT); }
// 提交一次 events.json 事务。mutate 必须是**同步**函数:
//   返回 false -> 内容无变化, 不写盘; 返回数组 -> 整体替换; 其他 -> 用原地修改后的数组
// 返回 { ok, written, value }: ok=false 表示没拿到锁(本次改动被放弃), 调用方必须处理, 不要当成写成功
function mutateEvents(mutate) { return store.updateEvents(ROOT, mutate, { cap: store.eventCap(cfg) }); }
function pickStr(obj, keys) {
  for (const k of keys) { if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k]; }
  return "";
}
function verifyEzvizSign(bodyRaw, headers) {
  const P = cfg.ezvizPush || {};
  // 未配置密钥：开发期放行，但必须给出醒目安全警告——此时任何人都能伪造家族告警
  if (!P.secret) {
    console.warn("[安全告警] ezvizPush.secret 未配置，/ezviz/push 不做签名校验，攻击者可伪造「人员活动」家族告警！请尽快在 config.json 填入萤石推送密钥并重启。");
    return true;
  }
  // 已配置密钥：必须携带且匹配签名，否则一律拒绝（杜绝伪造）
  const h = {};
  for (const k in headers) h[String(k).toLowerCase()] = String(headers[k]);
  const got = h["x-ezviz-signature"] || h["signature"] || h["x-signature"] || "";
  if (!got) return false; // 配了密钥就必须带签名，缺签名直接拒绝
  // 萤石推送签名协议: signature = HMAC-SHA1(secret, body + t)，t 为请求头里的毫秒时间戳
  const t = h["t"] || "";
  const cands = [];
  if (t) cands.push(crypto.createHmac("sha1", P.secret).update(bodyRaw + t).digest("hex"));
  cands.push(
    crypto.createHash("md5").update(P.secret + bodyRaw).digest("hex"),
    crypto.createHash("md5").update(bodyRaw + P.secret).digest("hex"),
    crypto.createHmac("sha256", P.secret).update(bodyRaw).digest("hex"),
    crypto.createHash("sha256").update(P.secret + bodyRaw).digest("hex")
  );
  return cands.map(function(s){ return String(s).toLowerCase(); }).indexOf(got.toLowerCase()) >= 0;
}
async function handleEzvizPush(bodyRaw, headers) {
  const t = Date.now();
  // VMD(VideoMotionDetection)是设备本地视频移动侦测的持续上报: 高频(每20~30秒一条)、无截图、
  // 下游零用途(不进AI/不进微信/不建事件), 在落盘前直接丢弃, 避免刷爆push_log挤掉有效记录
  try {
    const peek = JSON.parse(bodyRaw);
    const inner = (peek && peek.body && typeof peek.body === "object") ? peek.body : peek;
    if (inner && (inner.identifier === "VMD" || inner.domain === "VideoMotionDetection")) return;
  } catch (e) {}
  logPush({ ts: t, time: new Date(t).toLocaleString("zh-CN",{hour12:false}), headers: headers, body: String(bodyRaw).slice(0, 2500) });
  if (!verifyEzvizSign(bodyRaw, headers)) {
    console.log("[萤石推送] 签名校验失败，已丢弃（拒绝伪造/未授权推送）");
    return;
  }
  let p = null;
  try { p = JSON.parse(bodyRaw); } catch (e) {}
  if (!p) { try { p = Object.fromEntries(new URLSearchParams(bodyRaw)); } catch (e2) {} }
  if (!p || typeof p !== "object") { console.log("[萤石推送] 非JSON载荷，已记录到push_log"); return; }
  // v2推送格式: {body:{告警字段...}, header:{messageId,messageTime...}} — 展平到顶层
  var v2hdr = (p && typeof p.header === "object") ? p.header : null;
  if (p.body && typeof p.body === "object") {
    var v2b = p.body;
    if (!v2b.devSerial && !v2b.deviceSerial) v2b.devSerial = v2b.deviceId || (v2hdr && v2hdr.deviceId) || "";
    if (!v2b.alarmTime && v2hdr && v2hdr.messageTime) v2b.alarmTime = String(v2hdr.messageTime);
    p = v2b; // 用内层body作为主对象继续兼容老逻辑
  }
  // IntelligentTag(ys.iot)消息: 设备端人形检测的另一种上报格式, 人形结论藏在 payload.tags 里,
  // 不带155/SmartHumanDet等报警码, 之前会被当普通消息丢弃(17:08漏推的根因)。
  // 命中 human 标签即归一成人形报警, 复用下游统一的人形判定/"人形检测"标题/推送链路。
  if (p && (p.identifier === "IntelligentTag" || p.domain === "IntelligentTag")) {
    var tagRoot = null;
    try { tagRoot = JSON.parse(p.payload); } catch (eTag) {}
    var tagInfo = tagRoot && tagRoot.intelligentTag;
    var tagArr = (tagInfo && Array.isArray(tagInfo.tags)) ? tagInfo.tags : [];
    if (tagArr.some(function (x) { return /human|person|people|人形|^人$/i.test(String((x && x.type) || "")); })) {
      p.alarmType = "SmartHumanDet";
      var tagBasic = (tagRoot && tagRoot.basic) || (tagInfo && tagInfo.basic) || null; // basic在payload顶层, 与intelligentTag同级
      if (tagBasic && tagBasic.dateTime) p.alarmTime = tagBasic.dateTime; // 段开始时间比messageTime(收到时间)准
      // 注: payload里的截图fileid是设备本地存储, streamer/alarm/url/get取不到(Read error),
      // 故不设picUrl, 由下游"复用同活动报警存图→现场抓图"兜底
    }
  }
  // 兼容多种字段命名(老v1平铺 + v2展平后)
  var raw = JSON.stringify(p);
  var serial = String(pickStr(p, ["deviceSerial","devSerial","device_serial","serial"]) || "");
  // 隐藏设备（老设备/不再推送）：直接丢弃，不记录、不AI、不推送
  if (serial && isDeviceHidden(serial)) {
    console.log("[萤石推送] 隐藏设备 " + serial + " 已忽略(配置 hidden=true)");
    return;
  }
  var ts = 0;
  var tsRaw = pickStr(p, ["alarmTime","alarm_time","time","timestamp","msgTime"]);
  if (tsRaw) {
    var tsNum = Number(tsRaw);
    if (isFinite(tsNum) && tsNum > 0) { ts = tsNum; if (ts < 1e12) ts *= 1000; } // 纯数字: 秒/毫秒
    else if (String(tsRaw).indexOf("T") > 0) { var d = new Date(tsRaw); if (!isNaN(d.getTime())) ts = d.getTime(); } // ISO: 2026-08-27T13:08:25
  }
  if (!ts && v2hdr && v2hdr.messageTime) ts = Number(v2hdr.messageTime) || 0;
  var typeCode = pickStr(p, ["alarmType","alarm_type","type","msgType","eventType"]);
  var picUrl = String(pickStr(p, ["alarmPicUrl","picUrl","pic_url","pictureUrl"]) || "");
  if (!picUrl && Array.isArray(p.pictureList) && p.pictureList.length && p.pictureList[0].url) picUrl = String(p.pictureList[0].url);
  var textMsg = String(pickStr(p, ["content","aiResult","result","text","remark","alarmName","describe","channelName"]) || "");
  var typeName = ALARM_TYPE_NAMES[typeCode] || "";
  // 人形判定: 老数字码155xx + v2字符串类型(SmartHumanDet/intelligentDetection)
  var typeStr = String(typeCode || "");
  var isPersonType = typeStr.indexOf("155") === 0 || typeStr === "SmartHumanDet" || typeStr === "intelligentDetection" || /human/i.test(typeStr);
  // 设备端"智能检测"的更大集合(含车辆等活动): 决定是否进看板 + 是否长期留存图片。
  // 原判定只认"人", 车辆检测类消息会掉进下面的移动侦测分支 —— 既不推送也不留档。
  // 注意别把它放宽到 motiondetect: 那个才是真正要短期回收的噪音。
  var isSmartType = isPersonType || /^(smart|intelligent)/i.test(typeStr) || /vehicle|car|face|pet|bike|motor/i.test(typeStr);
  var isAiNotice = /AI|agent|智能体/i.test(String(typeCode)) || /算法结果/.test(raw.slice(0,300));
  var personByText = /【有人】|检测到人|人形|男子|女子|老人|小孩|人员/.test(textMsg);
  // 只落两类：人形类告警、AI算法结果；普通移动侦测只记日志不进看板
  if (!isSmartType && !isAiNotice && !personByText) {
    // 普通移动侦测(高频噪音: 车经过/树叶晃动/光斑变化): 不推微信也不进看板。
    // 截图仍然下载, 但只当"同一次活动的备用帧"给垫图用 —— 落到 captures/motion/ 并按小时回收,
    // 不再往 captures/ 主目录堆长期无人引用的孤儿图(这是 96% 孤儿图的唯一来源)。
    if (serial && picUrl) {
      try {
        var _fname = serial + "_p" + (ts || Date.now()) + ".jpg";
        fs.mkdirSync(MOTION_DIR, { recursive: true });
        await client.downloadTo(picUrl, path.join(MOTION_DIR, _fname));
        console.log("[萤石推送] 移动侦测图暂存 motion/(不进看板, " + (motionRetentionMs() / 3600e3) + "小时回收): " + _fname);
      } catch (e) { console.log("[萤石推送] 移动侦测图片保存失败: " + e.message); }
    }
    return;
  }
  if (serial) {
    var evts = loadEventsArr(); // 只读快照: 用于尽早跳过同一次活动, 真正提交时会在锁内用最新数据复查
    var evTs = ts || Date.now();
    // 同设备90秒内的消息视为同一次活动: 人形tag与报警消息常成对到达, tag还会在段首/段尾各发一次, 只推一条。
    // 例外: 报警消息自带相机的人形快照(picUrl)时, 若90秒内的旧事件被AI判了"无人"(person=false),
    // 说明可能漏判, 放行用自带快照二次判定; 旧事件已确认有人则仍去重, 避免同一次活动双推。
    // (20:47漏推教训: tag先到复用了人进场前的空帧被判无人, 随后带有人快照的报警被去重吞掉)
    var recentEvts = evts.filter(function(e){ return e.source !== "kanjia" && e.serial === serial && Math.abs((e.ts || 0) - evTs) < 90e3; });
    var confirmedRecent = recentEvts.some(function(e){ return e.person === true; });
    if (recentEvts.length && (confirmedRecent || !picUrl)) {
      console.log("[萤石推送] 90秒内同设备已有记录，视为同一次活动跳过 " + serial + "@" + new Date(evTs).toLocaleTimeString());
      return;
    }
    // 图片：优先报警自带截图 → 复用同活动已落地的报警存图 → 现场抓图兜底
    var fname = "";
    if (picUrl) {
      fname = serial + "_p" + (ts || Date.now()) + ".jpg";
      try { await client.downloadTo(picUrl, path.join(ROOT, "captures", fname)); }
      catch (e) { console.log("[萤石推送] 截图下载失败: " + e.message); fname = ""; }
    }
    if (!fname) {
      // 无报警自带截图时(如IntelligentTag人形标签): 同一次活动往往伴随移动侦测消息先到并存了图,
      // 按文件名时间戳找同设备±2分钟内的报警存图复用——画面贴近事件时刻还省抓图配额; 找不到再抓现况
      try {
        var evTsRef = evTs;
        // 候选来自两处: captures/(已长期留存的事件图) 与 captures/motion/(移动侦测临时图)。
        // motion 里还留着图, 说明这次活动刚发生不久, 是垫图的主要来源。
        var cands = [];
        [{ d: CAPTURE_DIR, motion: false }, { d: MOTION_DIR, motion: true }].forEach(function (src) {
          try {
            fs.readdirSync(src.d).forEach(function (f) {
              if (f.indexOf(serial + "_p") !== 0 || f.slice(-4) !== ".jpg") return;
              var t = Number(f.slice(serial.length + 2, -4));
              if (isFinite(t) && t <= evTsRef + 60e3 && evTsRef - t < 120e3) cands.push({ f: f, t: t, motion: src.motion });
            });
          } catch (e) {}
        });
        // 人是"走进画面"的: 优先事件时刻之后的帧(人在段内通常停留15-60秒), 同侧再取离事件时刻最近的
        var reused = cands.sort(function (a, b) {
          var pa = a.t < evTsRef ? 1 : 0, pb = b.t < evTsRef ? 1 : 0;
          return (pa - pb) || (Math.abs(a.t - evTsRef) - Math.abs(b.t - evTsRef));
        })[0];
        if (reused && reused.motion) {
          // 事件记录的 file 只存文件名、静态服务也只服务 captures/ 根目录 —— 选中就必须搬进主目录。
          // 否则几小时后 motion 清理一跑, 这条事件就成了"有记录、图已裂"。
          try {
            var _srcP = path.join(MOTION_DIR, reused.f), _dstP = path.join(CAPTURE_DIR, reused.f);
            try { fs.renameSync(_srcP, _dstP); }
            catch (eR) { fs.copyFileSync(_srcP, _dstP); try { fs.unlinkSync(_srcP); } catch (eU) {} }
          } catch (eM) {
            console.log("[萤石推送] 垫图搬运失败, 改用现场抓图: " + String(eM.message).slice(0, 60));
            reused = null;
          }
        }
        if (reused) { fname = reused.f; console.log("[萤石推送] 复用同活动存图" + (reused.motion ? "(自 motion 移入主目录)" : "") + ": " + fname); }
      } catch (eReuse) {}
    }
    if (!fname) {
      try {
        const r = await client.capture(serial);
        if (String((r || {}).code) === "200") {
          const d = r.data;
          const url = Array.isArray(d) ? d[0].picUrl : d.picUrl;
          fname = serial + "_" + Date.now() + ".jpg";
          await client.downloadTo(url, path.join(ROOT, "captures", fname));
        } else {
          // 原来这条是静默的: 萤石拒了(日配额/频控/设备休眠)时既不打印也没图, 事后完全无从排查。
          // 2026-09-12 07:32「推送点击没反应」事故就是这条静默路径把 fname 留空、进而让推送 url 变空串导致的。
          console.log("[萤石推送] 兜底抓图被拒: " + serial + " code=" + String((r || {}).code) + " " + String((r || {}).msg || ""));
        }
      } catch (e2) { console.log("[萤石推送] 兜底抓图失败: " + e2.message); }
    }
    var alarmTime = ts ? new Date(ts).toLocaleString("zh-CN",{hour12:false}) : new Date().toLocaleString("zh-CN",{hour12:false});
    var devName = ((cfg.devices||[]).find(function(x){ return x.serial===serial; })||{}).name || serial;
    var newRec = { ts: ts || Date.now(), time: alarmTime, serial: serial, name: devName, file: fname,
      title: typeName || (isAiNotice ? "AI识别" : "告警"), provider: isAiNotice ? "萤石AI" : "",
      ai: textMsg || "(点击AI分析)", person: Boolean(isPersonType || personByText), abnormal: false, pushed: false,
      ezvizPic: picUrl || "" };
    // 提交事务: 锁内重新读最新 events.json 再复查去重。
    // 原来这里是"读(第309行) -> 下载图片/复用存图/兜底抓图(多个 await) -> 写", 中间隔了几百毫秒到几秒,
    // 期间 webapp/monitor 写入的新事件会被这份过期数组整份覆盖(丢事件)。
    var commit = await mutateEvents(function (arr) {
      var dup = arr.filter(function (e) { return e.source !== "kanjia" && e.serial === serial && Math.abs((e.ts || 0) - evTs) < 90e3; });
      if (dup.length && (dup.some(function (e) { return e.person === true; }) || !picUrl)) {
        // 锁内复查发现同一次活动已入库 → 不新增, 避免双记录。
        // 但已有那条**可能根本没截到图**: 萤石对同一次活动会连推数条(人形标签不带截图 + 智能侦测带截图),
        // 人形标签那条先落库时, 智能侦测的图还在下载中, 垫图扫不到、兜底抓图又可能失败 ——
        // 于是留下一条 file="" 的记录, 看板上就是一张纯黑卡片(webapp.html 的 .card img 黑底)。
        // 若本次拿到了图, 就把图补到那条无图记录上, 而不是再push一条。
        var noPicDup = dup.filter(function (e) { return !e.file; });
        if (fname && noPicDup.length) {
          var tgt = noPicDup[noPicDup.length - 1];
          tgt.file = fname;
          tgt.ezvizPic = tgt.ezvizPic || picUrl || "";
          if (textMsg && (!tgt.ai || tgt.ai === "(点击AI分析)")) tgt.ai = textMsg;
          console.log("[萤石推送] 同活动已有记录但缺截图, 本次补上: " + serial + " -> " + fname);
          return true; // 有实际改动, 需要落盘
        }
        return false;
      }
      arr.push(newRec);
      return true;
    });
    if (!commit.ok) {
      console.log("[萤石推送] ⚠ 事件未能写入 events.json(等锁超时)，本条可能没进看板: " + devName + " " + alarmTime);
    } else if (!commit.written) {
      console.log("[萤石推送] 90秒内同设备已有记录(锁内复查)，视为同一次活动跳过 " + serial + "@" + new Date(evTs).toLocaleTimeString());
      return;
    } else {
      console.log("[萤石推送] 已记录: " + devName + " " + alarmTime + " " + (typeName || "AI结果"));
    }
    // 自动AI判读后推送到家人微信（测试号模板消息）
    const pubBase = String(((cfg.wxTest || {}).publicBase) || "").replace(/\/$/, "");
    let aiTxt = "";
    if (fname && (cfg.ai || {}).enabled && (cfg.ai || {}).autoAnalyze !== false) {
      try { aiTxt = await analyzeAndStore(fname); } catch (eAi) { console.log("[AI] 自动判读失败: " + eAi.message); }
    }
    // 无人/异常判定: 统一走 lib/judge.js(唯一实现)。
    // 原实现 /【无人】/ || /^\s*无人/ 缺 m 标志且靠子串匹配, 会把"没有人""未见人员活动"判成有人误推。
    // matched=false 表示 AI 输出格式漂移、结论没读懂 —— 此时**不拦截**(照原策略按"可能有人"推送),
    // 避免格式漂移导致漏报, 同时打警告便于发现。
    const aiJudge = aiTxt ? judgePerson(aiTxt) : null;
    const noPerson = !!(aiJudge && aiJudge.matched && !aiJudge.person);
    // AI结论里的异常关键词: 即使判了无人, 提到"异常/闯入"等仍值得推
    const hasAbnormal = !!(aiJudge && aiJudge.abnormal);
    if (aiJudge && !aiJudge.matched) {
      console.log("[萤石推送] ⚠ AI结论无法解析(依据=" + aiJudge.source + ")，已按'可能有人'放行推送，请检查AI输出格式: " + String(aiTxt).replace(/\s+/g, " ").slice(0, 60));
    }
    // AI明确判无人且无异常描述 → 只入看板不推送: 设备端人形检测误报多(风吹草动也报),
    // 二道AI把关后仍推"无人"会狼来了。AI全渠道失败(aiTxt为空)时仍推, 避免渠道故障期漏报
    if (aiTxt && noPerson && !hasAbnormal) {
      console.log("[萤石推送] AI判定无人，仅记录看板不推送: " + devName + " " + alarmTime);
      return;
    }
    // 语义化标题: 含设备名, 去掉"⚠️老家"等冗余前缀; 称呼(亲爱的东哥等)由 dear() 在发送时自动加在 first 前
    let firstLine;
    if (aiTxt) {
      firstLine = noPerson ? ("检测到" + devName + "画面异常，AI提示需关注") : ("检测到" + devName + "有人员活动");
    } else if (isPersonType || personByText) {
      firstLine = "检测到" + devName + "有人员活动";
    } else {
      firstLine = "检测到" + devName + "有移动侦测";
    }
    // 推送链接必须兜底到"一定有响应"的地址。
    // 事故(2026-09-12 07:32): IntelligentTag人形标签本身不带图, 复用同活动报警存图与兜底抓图又双双失败,
    //   于是 fname="" 且 picUrl="" -> 模板消息 url 传空串。微信对空 url 的模板消息**点击无任何跳转**,
    //   用户看到的就是"点了没反应"。三层兜底: 本事件图 -> 萤石原图 -> 看板今日页。
    //   pubBase 也没有时(隧道未开)宁可不给 url, 但文案如实说明, 不让用户以为点得动。
    let detailUrl = "";
    if (fname) detailUrl = pubBase + "/detail?file=" + encodeURIComponent(fname);
    else if (picUrl) detailUrl = picUrl;
    else if (pubBase) detailUrl = pubBase + "/today" + (serial ? "?serial=" + encodeURIComponent(serial) : "");
    const pushRemark = detailUrl
      ? (fname || picUrl ? "点击查看现场照片与 AI 分析 👉" : "本次未取到照片，点击查看今日记录 👉")
      : "本次未取到照片（内网穿透未开启）";
    pushTestTemplate(
      firstLine,
      alarmTime,
      devName,
      pushRemark,
      detailUrl,
      false,
      { serial: serial, alarm: true }  // alarm=true: 应用报警推送时段限制(名单内openid只在10~19点之间推); 按设备所属村过滤推送对象(双溪村组只收双溪村/同事组不收)
    ).catch(function () {});
  }
}

// ---------- AI图像判读（OpenAI兼容多供应商容错，结果回写events.json） ----------
const _aiFlight = {};
function aiProviders() {
  const A = cfg.ai || {};
  if (!A.enabled) return [];
  return (A.providers || []).filter(function (p) { return p.enabled && p.baseURL && p.apiKey && p.model; });
}
// 与 webapp.js 的 PROVIDER_LABELS 保持同一套写法 —— 同一条 events 记录不能出现两种模型名
const AI_PROVIDER_LABELS = { zhipu: "GLM-4v", agnes: "Agnes", xiaohongshu: "小红书" };
function aiProviderLabel(name) { return AI_PROVIDER_LABELS[name] || String(name || ""); }

// 返回 { content, provider }。provider 必须带出来 —— 以前只返回文本, 于是"自动分析"过的记录
// provider 一直是空串, 看板无法区分「AI 判定有人」与「萤石设备端人形标签直通(从没跑过 AI)」,
// 两种记录都顶着同一个红色"有人", 看起来都像 AI 的结论(2026-09-12 东哥反馈的误报之一)。
async function analyzeImageAI(file) {
  const A = cfg.ai || {};
  const prompt = A.prompt || "判断画面中是否有人。第一行必须输出【有人】或【无人】，然后用一句话简述画面内容和异常点。";
  const dataUrl = "data:image/jpeg;base64," + fs.readFileSync(file).toString("base64");
  for (const p of aiProviders()) {
    try {
      const res = await fetch(p.baseURL.replace(/\/$/, "") + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + p.apiKey },
        body: JSON.stringify({
          model: p.model,
          max_tokens: p.maxTokens || 300,
          messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: dataUrl } }, { type: "text", text: prompt }] }]
        }),
        signal: AbortSignal.timeout((p.timeoutSec || 25) * 1000)
      });
      const j = await res.json();
      const txt = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (txt) return { content: String(txt).trim(), provider: p.name };
      console.log("[AI]", p.name, "响应异常:", JSON.stringify(j).slice(0, 120));
    } catch (e) {
      console.log("[AI]", p.name, "调用失败:", e.message.slice(0, 80));
    }
  }
  return { content: "", provider: "" };
}
async function analyzeAndStore(file) {
  if (!file) return "";
  const absPath = path.isAbsolute(file) ? file : path.join(ROOT, "captures", file);
  const baseName = path.basename(absPath);
  if (_aiFlight[baseName]) return "";
  _aiFlight[baseName] = true;
  try {
    const r = await analyzeImageAI(absPath);
    const txt = r.content;
    if (txt) {
      const j = judgePerson(txt);
      // 锁内重读最新内容再定位记录: AI判读期间别的进程可能刚追加了新事件
      await mutateEvents(function (evts) {
        const rec = evts.find(function (e) { return e.file === baseName || e.file === file; });
        if (!rec) return false;
        rec.ai = txt; rec.person = j.person;
        // 记下是哪家模型判的。看板靠 provider 是否为空来区分「AI 的结论」与
        // 「萤石设备端人形标签直通、压根没跑过 AI 的结论」—— 以前这里没写, 自动分析过的
        // 记录 provider 也是空的, 两类记录在看板上长得一模一样。
        if (r.provider) rec.provider = aiProviderLabel(r.provider);
        return true;
      });
    }
    return txt;
  } finally { delete _aiFlight[baseName]; }
}

// 看家（手动抓图）写一条 events.json 占位记录，让 /detail?file=xxx 能查到
// 已有同 file 记录则跳过（幂等）；带 source:"kanjia" 标记，方便按场景过滤
function recordKanjiaCapture(file, dev) {
  try {
    if (!file || !dev) return Promise.resolve();
    const baseName = path.basename(String(file));
    const ts = Date.now();
    return mutateEvents(function (evts) {
      if (evts.some(function (e) { return e.file === baseName; })) return false; // 幂等: 已有同 file 记录就跳过
      evts.push({
        ts: ts,
        time: new Date(ts).toLocaleString("zh-CN", { hour12: false }),
        serial: dev.serial,
        name: dev.name || dev.serial,
        file: baseName,
        title: "实时抓图",
        provider: "",
        ai: "(等待分析...)",
        person: false,
        abnormal: false,
        pushed: false,
        source: "kanjia",
        ezvizPic: ""
      });
      return true;
    });
  } catch (e) { console.log("[看家] 写events占位失败: " + e.message.slice(0, 80)); return Promise.resolve(); }
}

// 「状态」菜单回复
async function buildStatusReply(fromUser, toUser) {
  const evs = loadEventsArr();
  const todays = todayPersonEvents();
  // "最近一条记录"只看实际报警/今日人员活动, 跳过手动看家记录
  const last = evs.filter(function (e) { return e.source !== "kanjia"; }).slice(-1)[0];
  const lastTxt = last ? (new Date(last.ts || Date.now()).toLocaleString("zh-CN", { hour12: false }) + " " + (last.name || "")) : "暂无";
  // 设备在线状态：一次 deviceList 拿全部
  const onlineMap = {};
  try {
    const dl = await client.deviceList();
    if (dl && dl.code === "200" && Array.isArray(dl.data)) {
      for (const d of dl.data) onlineMap[d.deviceSerial] = d.status === 1;
    }
  } catch (e) { console.log("[状态] 设备列表查询失败: " + e.message); }
  const devLines = (cfg.devices || []).filter(function (d) { return !d.hidden; }).map(function (d) {
    const on = onlineMap[d.serial];
    const st = on === true ? "🟢 在线" : (on === false ? "🔴 离线" : "❓ 未知");
    return "· " + d.name + " (" + d.serial + ") " + st;
  }).join("\n");
  return replyText(fromUser, toUser,
    dear(fromUser) + "🏠 老家监控系统状态\n" +
    "· 服务版本: v" + VERSION + "\n" +
    "· 今日人员活动: " + todays.length + " 次\n" +
    "· 最近一条记录: " + lastTxt + "\n\n" +
    "📶 设备状态:\n" + (devLines || "（无设备）") + "\n\n" +
    "菜单/指令：【看家】实时画面 · 【今日有人】图文汇总 · 【状态】本页");
}

// ---------- 关注者昵称缓存 + 专属称呼 ----------
let _nickCache = null;
function loadNickCache() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "followers.json"), "utf8"));
    return (j && j.map) ? j : { map: {}, at: 0 };
  } catch (e) { return { map: {}, at: 0 }; }
}
function saveNickCache(c) {
  fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "data", "followers.json"), JSON.stringify(c));
}
async function refreshFollowers(force) {
  try {
    const cache = _nickCache || (_nickCache = loadNickCache());
    if (!force && Date.now() - (cache.at || 0) < 3600e3) return; // 1小时内不重复拉取
    let token = await wxTestToken();
    let ur = await fetch("https://api.weixin.qq.com/cgi-bin/user/get?access_token=" + token + "&next_openid=");
    let uj = await ur.json();
    if (isTokErr(uj.errcode)) {
      token = await wxTestToken(true);
      ur = await fetch("https://api.weixin.qq.com/cgi-bin/user/get?access_token=" + token + "&next_openid=");
      uj = await ur.json();
    }
    const openids = (uj.data && uj.data.openid) || [];
    for (const oid of openids) {
      if (!force && cache.map[oid]) continue;
      try {
        const ir = await fetch("https://api.weixin.qq.com/cgi-bin/user/info?access_token=" + token + "&openid=" + oid + "&lang=zh_CN");
        const ij = await ir.json();
        if (ij.nickname) cache.map[oid] = ij.nickname;
      } catch (e1) {}
    }
    cache.at = Date.now();
    saveNickCache(cache);
    console.log("[" + new Date().toLocaleTimeString() + "] [昵称] 关注者缓存 " + Object.keys(cache.map).length + "/" + openids.length);
  } catch (e2) { console.log("[昵称] 刷新失败: " + e2.message.slice(0, 80)); }
}
function stripEmoji(s) {
  return String(s || "")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}\u{2190}-\u{21FF}]/gu, "")
    .replace(/\s+/g, "");
}
function dear(openid) {
  if (!openid) return "";
  const om = cfg.openidNames || {};
  if (om[openid]) return om[openid] + "，"; // openid直绑优先(测试号API已拿不到昵称)
  const c = _nickCache || (_nickCache = loadNickCache());
  const nick = c.map[openid];
  const map = cfg.nicknames || {};
  if (!nick) return "";
  if (map[nick]) return map[nick] + "，"; // 精确命中
  // 宽松匹配: 双方都去表情+去空格+忽略大小写后, 互相包含即命中(适配昵称带emoji如"WZ🌸""睡不醒💤")
  const nn = stripEmoji(nick).toLowerCase();
  if (!nn) return "";
  for (const k of Object.keys(map)) {
    const kk = stripEmoji(k).toLowerCase();
    if (!kk) continue;
    if (nn === kk || nn.indexOf(kk) >= 0 || kk.indexOf(nn) >= 0) return map[k] + "，";
  }
  return "";
}

// ---------- 设备显隐 & 推送节流 ----------
// 隐藏设备（老设备/不再推送）：hidden=true 的设备不出现在状态报告、今日汇总、日报，萤石回调直接丢弃
function isDeviceHidden(serial) {
  const d = (cfg.devices || []).find(function (x) { return x.serial === serial; });
  return !!(d && d.hidden);
}
function hiddenSerialSet() {
  return new Set((cfg.devices || []).filter(function (d) { return d.hidden; }).map(function (d) { return d.serial; }));
}
// ---------- 微信分组权限 ----------
// 分组模型(config.wxGroups): 每个分组有 members(openid数组)/push(推送范围)/query(查询范围)/blockMushanMenu
//   push/query 取值: "all"(默认, 全部) | "双溪村"/"木山村"(仅该村) | "none"(完全不推/不可查) | "status"(同事组: 仅可看设备状态)
// 未在任何分组的 openid => 默认组, 拥有全部权限(东哥等主账号即此类)
function groupOf(openid) {
  const groups = cfg.wxGroups || {};
  for (const key of Object.keys(groups)) {
    const g = groups[key];
    if (g && Array.isArray(g.members) && g.members.indexOf(openid) >= 0) {
      return Object.assign({ key: key }, g);
    }
  }
  return null; // 默认组: 全部权限
}
// 设备归属哪个村(按名称前缀推断)
function deviceVillage(serial) {
  const d = (cfg.devices || []).find(function (x) { return x.serial === serial; });
  const name = d ? d.name : (serial || "");
  if (name.indexOf("双溪村") >= 0) return "双溪村";
  if (name.indexOf("木山村") >= 0) return "木山村";
  return "";
}
// 该微信能否接收指定设备的报警推送
function canPushTo(openid, serial) {
  const g = groupOf(openid);
  if (!g) return true; // 默认全推
  const scope = g.push || "all";
  if (scope === "none") return false;
  if (scope === "all") return true;
  return deviceVillage(serial) === scope;
}
// 报警推送时段限制(config.push.timeWindow): 名单内openid只在每天 startHour~endHour 之间收到报警推送(其余时段静默不推)
function inAlarmTimeWindow(openid) {
  const W = (cfg.push && cfg.push.timeWindow) || null;
  if (!W || !Array.isArray(W.openids) || W.openids.indexOf(openid) < 0) return true; // 不在名单不限制
  const h = new Date().getHours();
  return h >= (Number(W.startHour) || 0) && h < (Number(W.endHour) || 24);
}
// 该微信能否查询(截图/直播/今日汇总)指定设备
function canQuery(openid, serial) {
  const g = groupOf(openid);
  if (!g) return true; // 默认全可查
  const scope = g.query || "all";
  if (scope === "status") return false; // 同事组: 仅设备状态
  if (scope === "none") return false;
  if (scope === "all") return true;
  return deviceVillage(serial) === scope;
}
// 某村下的设备名(用于日报/汇总按组分发)
function deviceNamesByVillage(village) {
  return (cfg.devices || [])
    .filter(function (d) { return d.watch && !d.hidden && deviceVillage(d.serial) === village; })
    .map(function (d) { return d.name; });
}
// 菜单按钮拦截: 返回拦截提示文案, 或 null 表示放行
// 适用场景: 微信测试号菜单全局不可分, 故在按钮点击时按组拦截
function menuGuard(openid, key) {
  const g = groupOf(openid);
  if (!g) return null; // 默认组全开
  if (key === "status") return null; // 状态任何人可看(同事组仅此一项)
  if ((g.query || "all") === "status") {
    return "🚫 您当前账号仅可查看设备状态，暂无查询/截图权限。";
  }
  if (g.blockMushanMenu) {
    const mushanKeys = ["menkou", "door", "today_bg", "shot_bg", "live_bg"]; // 木山村前门相关按钮
    const offlineKeys = ["today_c6", "shot_c6", "live_c6"]; // 双溪村老家-C6H 已离线/隐藏
    if (mushanKeys.indexOf(key) >= 0 || offlineKeys.indexOf(key) >= 0) {
      return "📴 该设备当前已下线，暂不可查看。";
    }
  }
  return null;
}
// 查询被拦截时的提示文案
function queryBlockedMsg(openid, devName) {
  const g = groupOf(openid);
  if (g && (g.query || "all") === "status") return "🚫 您当前账号仅可查看设备状态，暂无查询/截图权限。";
  if (g && g.query && g.query !== "all") return "🚫 您当前账号仅可查看「" + g.query + "」设备，其他设备暂不开放。";
  return "🚫 您暂无权限查看该设备。";
}
// 根据分组算出某微信查询时应用的村过滤(用于今日汇总/全部画面/直播按组裁剪); 无村限制返回 null
function villageScopeOf(openid) {
  const g = groupOf(openid);
  if (!g) return null;
  const s = g.query || "all";
  if (s === "双溪村" || s === "木山村") return s;
  return null;
}
// 每个微信(openid)的报警推送滑动窗口限流：窗口内最多 max 条，窗口随时间滚动，旧记录自动出窗
// 默认 30 分钟内最多 2 条；可在 config.json push.throttleWindowSec / push.throttleMax 调整
function pushThrottleCfg() {
  const P = cfg.push || {};
  return {
    windowMs: (Number(P.throttleWindowSec) > 0 ? Number(P.throttleWindowSec) : 1800) * 1000,
    max: Number(P.throttleMax) > 0 ? Number(P.throttleMax) : 2
  };
}
function throttleHistory(v) { return Array.isArray(v) ? v.filter(function(t){ return t > 0; }) : (v > 0 ? [v] : []); } // 兼容旧格式(单时间戳数字)
let _throttleCache = null;
function loadThrottle() {
  if (_throttleCache) return _throttleCache;
  try { _throttleCache = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "push_throttle.json"), "utf8")); }
  catch (e) { _throttleCache = {}; }
  return _throttleCache;
}
function saveThrottle(map) {
  try {
    const winMs = pushThrottleCfg().windowMs, now = Date.now(), pruned = {};
    for (const k in map) {
      const recent = throttleHistory(map[k]).filter(function(t) { return now - t < winMs; });
      if (recent.length) pruned[k] = recent; // 窗口外记录直接丢弃, 文件不无限增长
    }
    _throttleCache = pruned;
    fs.writeFileSync(path.join(ROOT, "data", "push_throttle.json"), JSON.stringify(pruned));
  } catch (e) {}
}
// 推送审计: 每次模板推送的结果都落盘(成功/失败/失败errcode)，控制台窗口丢了也有据可查
function auditPush(serial, ok, attempted, skipped, scoped, errs) {
  try {
    const line = "[" + new Date().toLocaleString("zh-CN", { hour12: false }) + "] serial=" + (serial || "-") +
      " 成功=" + ok + "/" + attempted + " 节流跳过=" + skipped + " 分组过滤=" + scoped +
      (errs.length ? " 失败详情=" + Array.from(new Set(errs)).join(",") : "") + "\n";
    fs.appendFileSync(path.join(ROOT, "data", "push_audit.txt"), line);
  } catch (e) {}
}

// ---------- 微信测试号 主动推送（模板消息，无48小时窗口限制） ----------
// config.json: "wxTest": { "enabled": true, "appId":"", "appSecret":"", "templateId":"",
//                            "publicBase":"http://你的花生壳域名.vicp.fun" }
async function wxTestToken(force) {
  const T = cfg.wxTest || {};
  return getWxToken(T.appId, T.appSecret, "wx_test_token.json", force);
}
async function pushTestTemplate(first, timeStr, deviceStr, remark, detailUrl, force, opt) {
  const T = cfg.wxTest || {};
  if (!T.enabled || !T.templateId || !T.appId || !T.appSecret) return 0;
  const throttle = force ? null : loadThrottle();
  const th = pushThrottleCfg();
  const now = Date.now();
  opt = opt || {};
  try {
    let token = await wxTestToken();
    let ur = await fetch("https://api.weixin.qq.com/cgi-bin/user/get?access_token=" + token + "&next_openid=");
    let uj = await ur.json();
    if (isTokErr(uj.errcode)) { // 缓存token被外部轮换过: 强刷重来
      token = await wxTestToken(true);
      ur = await fetch("https://api.weixin.qq.com/cgi-bin/user/get?access_token=" + token + "&next_openid=");
      uj = await ur.json();
    }
    const openids = (uj.data && uj.data.openid) || [];
    const serialScope = opt.serial;   // 仅向可接收该设备的 openid 推送(分组)
    const allowOid = opt.allowOid;    // 仅向白名单 openid 推送(日报按组分发)
    let ok = 0, skipped = 0, scoped = 0, attempted = 0;
    const errs = [];
    for (const oid of openids) {
      // 分组白名单(日报按组分发): 不在名单直接跳过
      if (allowOid && !allowOid(oid)) { scoped++; continue; }
      // 按设备所属村过滤(如双溪村组只能收双溪村报警; 同事组 push=none 全程被拦)
      if (serialScope && !canPushTo(oid, serialScope)) { scoped++; continue; }
      // 报警推送时段限制(仅报警 opt.alarm=true 生效, 日报等非报警推送不受限)
      if (opt.alarm && !inAlarmTimeWindow(oid)) { scoped++; continue; }
      // 滑动窗口限流(默认30分钟内最多2条)：窗口内已推满则本条仅记录不推送
      if (throttle) {
        const recent = throttleHistory(throttle[oid]).filter(function(t0) { return now - t0 < th.windowMs; });
        if (recent.length >= th.max) { skipped++; continue; }
        throttle[oid] = recent; // 预裁剪出窗旧记录, 发送成功后再追加本次
      }
      attempted++;
      for (let att = 0; att < 2; att++) {
        try {
          const res = await fetch("https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=" + token, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              touser: oid,
              template_id: T.templateId,
              url: detailUrl || "",
              data: {
                first: { value: dear(oid) + first },
                keyword1: { value: timeStr },
                keyword2: { value: deviceStr },
                remark: { value: remark || "点击本消息可查看现场照片" }
              }
            })
          });
          const rj = await res.json();
          if (rj.errcode === 0) { ok++; if (throttle) { throttle[oid] = (Array.isArray(throttle[oid]) ? throttle[oid] : []).concat(now); } break; }
          errs.push(oid.slice(0, 8) + ":" + rj.errcode);
          console.log("[测试号推送] 失败 openid=" + oid.slice(0, 8) + "... err=" + rj.errcode + " " + rj.errmsg);
          if (att === 0 && isTokErr(rj.errcode)) { try { await new Promise(function(r){setTimeout(r,2000)}); token = await wxTestToken(true); continue; } catch (e2) { break; } }
          break;
        } catch (e) { errs.push(oid.slice(0, 8) + ":EXC"); break; }
      }
    }
    if (openids.length) console.log("[测试号推送] 已推送 " + ok + "/" + openids.length + " 位关注者" + (skipped ? "，限频跳过 " + skipped + " 位(" + Math.round(th.windowMs / 60e3) + "分钟窗口已满" + th.max + "条)" : "") + (scoped ? "，分组过滤 " + scoped + " 位" : ""));
    auditPush(serialScope, ok, attempted, skipped, scoped, errs);
    if (throttle) saveThrottle(throttle);
    // 该设备本应送达却一个都没成功(网络/token抖动)：60秒后自动重试一次(仍受滑动窗口限流约束,重试本身不再递归)
    if (!force && !opt._isRetry && attempted > 0 && ok === 0) {
      console.log("[测试号推送] 全部失败，60秒后自动重试一次");
      setTimeout(function () {
        pushTestTemplate(first, timeStr, deviceStr, remark, detailUrl, force, Object.assign({}, opt, { _isRetry: true })).catch(function () {});
      }, 60e3);
    }
    return ok;
  } catch (e) {
    console.log("[测试号推送] 异常: " + e.message.slice(0, 120));
    return 0;
  }
}

// ---------- 客服消息（用户48小时内互动过即可主动补发） ----------
async function sendCustomText(openid, content) {
  const T = cfg.wxTest || {};
  const accts = [];
  if (T.enabled && T.appId && T.appSecret) accts.push({ name: "测试号", test: true });
  accts.push({ name: "主号" });
  for (const a of accts) {
    let tk;
    try { tk = a.test ? await getWxToken(T.appId, T.appSecret, "wx_test_token.json") : await wxAccessToken(); } catch (e0) { continue; }
    for (let att = 0; att < 2; att++) {
      try {
        const res = await fetch("https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=" + tk, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ touser: openid, msgtype: "text", text: { content: content } })
        });
        const j = await res.json();
        if (j.errcode === 0) return true;
        console.log("[客服消息] errcode=" + j.errcode + " " + j.errmsg);
        if (att === 0 && isTokErr(j.errcode)) { try { await new Promise(function(r){setTimeout(r,2000)}); tk = a.test ? await getWxToken(T.appId, T.appSecret, "wx_test_token.json", true) : await wxAccessToken(true); continue; } catch (e2) { break; } }
        break;
      } catch (e) { break; }
    }
  }
  return false;
}
// 客服消息发图片(微信托管原图秒开): file 支持绝对路径或captures下文件名; 测试号token优先
async function sendCustomImage(openid, file) {
  try {
    const fp = path.isAbsolute(file) ? file : path.join(ROOT, "captures", file);
    if (!fs.existsSync(fp)) return false;
    const T = cfg.wxTest || {};
    const accts = [];
    if (T.enabled && T.appId && T.appSecret) accts.push({ name: "测试号", test: true });
    accts.push({ name: "主号" });
    for (const a of accts) {
      let tk;
      try { tk = a.test ? await getWxToken(T.appId, T.appSecret, "wx_test_token.json") : await wxAccessToken(); } catch (e0) { continue; }
      for (let att = 0; att < 2; att++) {
        try {
          const mediaId = await uploadTempImage(fp, tk);
          const res = await fetch("https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=" + tk, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ touser: openid, msgtype: "image", image: { media_id: mediaId } })
          });
          const j = await res.json();
          if (j.errcode === 0) return true;
          console.log("[客服图片] errcode=" + j.errcode + " " + j.errmsg);
          if (att === 0 && isTokErr(j.errcode)) { try { await new Promise(function(r){setTimeout(r,2000)}); tk = a.test ? await getWxToken(T.appId, T.appSecret, "wx_test_token.json", true) : await wxAccessToken(true); continue; } catch (e2) { break; } }
          break;
        } catch (e3) {
          // uploadTempImage抛错(含40001)同样走强刷重试
          if (att === 0 && isTokErr(e3.message)) { try { await new Promise(function(r){setTimeout(r,2000)}); tk = a.test ? await getWxToken(T.appId, T.appSecret, "wx_test_token.json", true) : await wxAccessToken(true); continue; } catch (e4) { break; } }
          break;
        }
      }
    }
  } catch (e) {}
  return false;
}
// 客服消息-图文卡片: 标题+描述+缩略图+链接, 一条消息代替之前的文字+图片+N条
async function sendCustomNews(openid, title, desc, picUrl, linkUrl) {
  const T = cfg.wxTest || {};
  const accts = [];
  if (T.enabled && T.appId && T.appSecret) accts.push({ name: "测试号", test: true });
  accts.push({ name: "主号" });
  for (const a of accts) {
    let tk;
    try { tk = a.test ? await getWxToken(T.appId, T.appSecret, "wx_test_token.json") : await wxAccessToken(); } catch (e0) { continue; }
    for (let att = 0; att < 2; att++) {
      try {
        const res = await fetch("https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=" + tk, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            touser: openid, msgtype: "news",
            news: { articles: [{ title: (title || "").slice(0, 64), description: (desc || "").slice(0, 200), picurl: picUrl || "", url: linkUrl || "" }] }
          })
        });
        const j = await res.json();
        if (j.errcode === 0) return true;
        console.log("[客服图文] errcode=" + j.errcode + " " + j.errmsg);
        if (att === 0 && isTokErr(j.errcode)) { await new Promise(function(r){setTimeout(r,2000)}); try { tk = a.test ? await getWxToken(T.appId, T.appSecret, "wx_test_token.json", true) : await wxAccessToken(true); continue; } catch (e2) { break; } }
        break;
      } catch (e3) {
        if (att === 0 && isTokErr(e3.message)) { await new Promise(function(r){setTimeout(r,2000)}); try { tk = a.test ? await getWxToken(T.appId, T.appSecret, "wx_test_token.json", true) : await wxAccessToken(true); continue; } catch (e4) { break; } }
        break;
      }
    }
  }
  return false;
}
async function aiFollowUp(file, openid, dev) {
  try {
    const txt = await analyzeAndStore(file);
    if (!txt) { await sendCustomText(openid, "🤖 AI暂时没认出这张画面, 请稍后到看板查看"); return; }
    // 设备名: 调用方传入的 dev 优先, 否则按文件名前缀反查 serial
    let devName = (dev && dev.name) || "";
    if (!devName) {
      var pre = String(path.basename(String(file || ""))).split("_")[0];
      var hit = (cfg.devices || []).find(function (d) { return d.serial === pre; });
      devName = hit ? hit.name : "监控点";
    }
    // 语义化标题: 去掉 "⚠️ AI识别:" 冗余前缀, 含设备名(称呼由 dear() 自动加在前面)
    // 用统一的判人实现: 原 txt.indexOf("有人") 会被"没有人"命中, 导致卡片误写"有人员活动"
    const jAi = judgePerson(txt);
    const hasPerson = jAi.person;
    const pub = (cfg.wxTest || {}).publicBase || "";
    const fname = path.basename(String(file || ""));
    const picUrl = pub && fname ? pub + "/captures/" + encodeURIComponent(fname) : "";
    const cardTitle = dear(openid) + (hasPerson ? "检测到" + devName + "有人员活动" : (jAi.matched ? devName + " 暂时未发现人员" : "检测到" + devName + "画面有变化"));
    const cardDesc = txt.replace(/\s+/g, " ").slice(0, 190);
    const linkUrl = pub && fname ? (pub + "/detail?file=" + encodeURIComponent(fname)) : picUrl;
    await sendCustomNews(openid, cardTitle, cardDesc, picUrl, linkUrl);
  } catch (e) {
    console.log("[看家] AI跟进失败: " + e.message.slice(0, 80));
  }
}

// ---------- 「全部画面」图文回复：两台设备最新截图一次看完 ----------
function buildShotAllReply(fromUser, toUser, village) {
  const devs = [];
  for (const d of (cfg.devices || []).filter(function (d) { return d.watch && (!village || deviceVillage(d.serial) === village); })) {
    const latest = latestCapture(d.serial);
    if (latest) devs.push({ dev: d, latest: latest });
  }
  if (!devs.length) return null; // 无任何缓存图 -> 调用方回退单设备实时抓图
  setTimeout(async function () {
    for (const it of devs) {
      const ok = await sendCustomImage(fromUser, it.latest.file);
      if (!ok) { await sendCustomText(fromUser, "⚠️ 图片发送失败(通道受限)，请稍后重试"); break; }
if ((cfg.ai || {}).enabled && (cfg.ai || {}).autoAnalyze !== false && aiProviders().length) {
          await aiFollowUp(it.latest.file, fromUser, it.dev);
        }
    }
  }, 200);
  const names = devs.map(function (x) { return x.dev.name; }).join("、");
  return replyText(fromUser, toUser, "📸 正在发送 " + names + " 的最新画面(" + devs.length + "张)，每张随后附AI识别...");
}

// ---------- 监控直播 ----------
// 各设备的H264可用性探测缓存: { serial -> { h265Only: bool, at: ts } }，10分钟过期
// H264流可被微信内置浏览器直接播放; H265流多数手机微信放不了, /live页会提示"在浏览器打开"
const _h264Probe = {};
// 云台限频: serial -> 上次操作时间戳
const _ptzLast = {};
const LIVE_PAGE_HTML = "<!doctype html><html><head><meta charset=\"utf-8\">" +
  "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,user-scalable=no\">" +
  "<title>家庭监控直播</title>" +
  "<link rel=\"stylesheet\" href=\"/ezui/style/css.css\">" +
  "<style>body{margin:0;background:#111;color:#eee;font-family:-apple-system,sans-serif;text-align:center}" +
  "#stage{position:relative;width:100%}" +
  "#app{width:100%;height:56vw;max-height:70vh;background:#000}" +
  "#pad{position:absolute;right:12px;top:50%;transform:translateY(-50%);z-index:6;display:none;flex-direction:column;gap:8px;align-items:center}" +
  "#pad button{width:46px;height:46px;border-radius:50%;border:1px solid rgba(255,255,255,.4);background:rgba(0,0,0,.5);color:#fff;font-size:15px;-webkit-tap-highlight-color:transparent}" +
  "#pad button:active{background:rgba(47,111,237,.8)}" +
  "#tip{padding:14px;font-size:15px;color:#9cf}" +
  ".bar{margin:10px auto;max-width:88%;padding:10px 14px;background:#3d3407;color:#ffd54a;border-radius:10px;font-size:13px;line-height:1.8;text-align:left}" +
  "#fail{display:none;margin:16px auto;max-width:88%;background:#1b2130;border:1px solid #2a3448;border-radius:12px;padding:18px;font-size:15px;line-height:2.1;text-align:left}" +
  "#fail b{color:#ffd54a}" +
  "button.act{margin:4px 6px 0 0;padding:7px 16px;border:0;border-radius:8px;background:#2f6fed;color:#fff;font-size:14px}" +
  "#copybar{position:fixed;left:0;right:0;bottom:0;padding:10px;background:#161a20;font-size:13px;color:#9ab;border-top:1px solid #262c36}" +
  "</style></head><body>" +
  "<div id=\"h265bar\" class=\"bar\" style=\"display:none\">⚠️ 该摄像头直播是 <b>H265</b> 画面，多数手机的微信放不了。<br>点右上角「···」→「<b>在浏览器打开</b>」即可观看。</div>" +
  "<div id=\"stage\"><div id=\"app\"></div>" +
  "<div id=\"pad\"><button onclick=\"ptzTurn('up')\">▲</button><div style=\"display:flex;gap:8px\"><button onclick=\"ptzTurn('left')\">◀</button><button onclick=\"ptzTurn('right')\">▶</button></div><button onclick=\"ptzTurn('down')\">▼</button></div>" +
  "</div><div id=tip>正在连接直播...</div>" +
  "<div id=\"fail\">😢 微信内无法播放此直播<br><b>两种方法观看：</b><br>① 点右上角「···」→ 选择「<b>在浏览器打开</b>」<br>② 或复制链接粘贴到手机浏览器打开<br><button class=\"act\" onclick=\"copyLink(this)\">📋 复制链接</button><span id=\"copied\" style=\"display:none;color:#6f6\">已复制 ✓</span></div>" +
  "<script>function copyLink(btn){var t=document.createElement('textarea');t.value=location.href;t.style.position='fixed';t.style.opacity='0';document.body.appendChild(t);t.focus();t.select();var ok=false;try{ok=document.execCommand('copy')}catch(e){}document.body.removeChild(t);if(ok){var sp=document.getElementById('copied');if(sp)sp.style.display='inline';if(btn){btn.textContent='已复制 ✓';setTimeout(function(){btn.textContent='📋 复制链接'},2000);}}else{prompt('长按全选并复制本链接:',location.href);}}</scr" + "ipt>" +
  "<script src=\"/ezui/index.umd.js\"></scr" + "ipt>" +
  "<script>var qs=new URLSearchParams(location.search),s=qs.get('serial')||'',tip=document.getElementById('tip');" +
  "var isWX=/MicroMessenger/i.test(navigator.userAgent);" +
  "function showFail(){if(!isWX){tip.textContent='画面加载慢或失败，可刷新重试';return}document.getElementById('fail').style.display='block';tip.textContent='微信内播放失败，按下方/上方方法打开';}" +
  "function ptzTurn(d){tip.textContent='⏳ 转动中...';fetch('/api/ptz?serial='+encodeURIComponent(s)+'&dir='+d).then(function(r){return r.json()}).then(function(j2){tip.textContent=j2.ok?('✅ 已向'+({'up':'上','down':'下','left':'左','right':'右'}[d]||d)+'转动'):('⚠️ '+(j2.err||'转动失败'))}).catch(function(){tip.textContent='⚠️ 网络错误'})};" +
  "fetch('/api/live-url?serial='+encodeURIComponent(s)).then(function(r){return r.json()}).then(function(j){" +
  "if(!j.url){tip.textContent='获取失败:'+(j.err||'未知');return}" +
  "if(j.ptz){document.getElementById('pad').style.display='flex'}" +
  "if(j.h265Only&&isWX){document.getElementById('h265bar').style.display='block'}" +
  "try{var p=new HlsPlayer({id:'app',url:j.url,staticPath:'/ezui/',autoPlay:true});p.play();" +
  "tip.textContent='缓冲中... 首次加载解码器约需3~8秒';" +
  "var n=0,tm=setInterval(function(){var v=document.querySelector('#app video'),c=document.querySelector('#app canvas');" +
  "if((v&&v.videoWidth>0)||c){clearInterval(tm);tip.textContent='● 直播中';document.getElementById('h265bar').style.display='none';document.getElementById('fail').style.display='none';return}" +
  "n++;if(n>18){clearInterval(tm);showFail();}},1000);" +
  "}catch(e){showFail();}}" +
  ").catch(function(e){tip.textContent='网络错误:'+e});</scr" + "ipt>" +
  "<div style=\"height:56px\"></div>" +
  "<div id=\"copybar\">微信打不开？复制链接到浏览器观看 <button class=\"act\" onclick=\"copyLink(this)\">复制链接</button></div>" +
  "</body></html>";

// 「今日人员活动」时间线页面: 全部记录+照片+AI判读, 微信只推一条链接
const TODAY_PAGE_HTML = "<!doctype html><html><head><meta charset=\"utf-8\">" +
  "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,user-scalable=no\">" +
  "<title>今日人员活动</title>" +
  "<style>body{margin:0;background:#0f1115;color:#e8eaed;font-family:-apple-system,'PingFang SC',sans-serif}" +
  "header{padding:14px 16px;font-size:18px;font-weight:600;border-bottom:1px solid #23262d;position:sticky;top:0;background:#0f1115;z-index:9}" +
  ".meta{font-size:12px;color:#9aa0a6;font-weight:400;margin-top:2px}" +
  ".card{margin:12px;padding:12px;background:#171a21;border-radius:12px}" +
  ".card img{width:100%;border-radius:8px;display:block;background:#000;min-height:120px;margin-top:2px}" +
  ".row{display:flex;justify-content:space-between;margin-bottom:4px;font-size:13px}" +
  ".tm{color:#8ab4f8;font-weight:600}.dev{color:#9aa0a6}" +
  ".ai{font-size:14px;line-height:1.55;margin-top:8px;color:#cfd4da;white-space:pre-wrap}" +
  "</style></head><body>" +
  "<header>📋 今日人员活动<div class=\"meta\" id=\"sub\">加载中...</div></header><div id=\"list\"></div>" +
  "<scr" + "ipt>" +
  "var qs=new URLSearchParams(location.search);var qSerial=qs.get('serial')||'';var qVillage=qs.get('village')||'';" +
  "var qp=[];if(qSerial)qp.push('serial='+encodeURIComponent(qSerial));if(qVillage)qp.push('village='+encodeURIComponent(qVillage));" +
  "fetch('/api/today-events'+(qp.length?'?'+qp.join('&'):'')).then(function(r){return r.json()}).then(function(j){" +
  "if(qVillage){document.querySelector('header').childNodes[0].nodeValue='📋 今日人员活动·'+qVillage}" +
  "if(j.devName){document.querySelector('header').childNodes[0].nodeValue='📋 '+(j.isToday===false?'昨日':'今日')+'人员活动·'+j.devName}" +
  "var sub0=document.getElementById('sub');if(j.date){sub0.textContent='📅 '+j.date+(j.isToday===false?'(回退显示)':'')}" +
  "var L=document.getElementById('list');" +
  "if(!j.count){var e0=document.createElement('div');e0.className='card';e0.textContent='📭 今天暂无人员活动，一切平安 ✅ 📅(历史记录请在电脑看板查看)';L.appendChild(e0);return}" +
  "j.items.forEach(function(it){var d=document.createElement('div');d.className='card';" +
  "var r1=document.createElement('div');r1.className='row';" +
  "r1.innerHTML='<span class=tm>⏰ '+it.hhmm+'</span><span class=dev>'+it.dev+'</span>';" +
  "d.appendChild(r1);" +
  "if(it.pic||it.picEz){var im=new Image();im.decoding='async';im.style.width='100%';im.style.borderRadius='8px';im.style.display='block';im.style.background='#1a1a1a';im.style.minHeight='120px';var ph=document.createElement('div');ph.textContent='⏳图片加载中…';ph.style.color='#5f6368';ph.style.fontSize='12px';ph.style.padding='20px';ph.style.textAlign='center';d.appendChild(ph);im.onload=function(){ph.remove()};im.onerror=function(){if(it.picEz&&im.src!==it.picEz){im.src=it.picEz}else{ph.textContent='⚠️图片加载失败'}};im.loading='lazy';im.src=it.pic||it.picEz;d.appendChild(im)}" +
  "var ad=document.createElement('div');ad.className='ai';" +
  "if(it.ai){ad.textContent='🤖 '+it.ai}else{ad.textContent='(暂无AI判读)';ad.style.color='#5f6368'}" +
  "d.appendChild(ad);L.appendChild(d)})" +
  "}).catch(function(e){document.getElementById('sub').textContent='加载失败:'+e})" +
  "</scr" + "ipt></body></html>";

// 历史记录页: 按日回看「有人记录/全部报警记录/历史日报」(配 /api/history-days /api/history-events /api/history-report)
const HISTORY_PAGE_HTML = "<!doctype html><html><head><meta charset=\"utf-8\">" +
  "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,user-scalable=no\">" +
  "<title>历史记录查询</title>" +
  "<style>body{margin:0;background:#0f1115;color:#e8eaed;font-family:-apple-system,'PingFang SC',sans-serif}" +
  "header{padding:12px 16px;font-size:18px;font-weight:600;border-bottom:1px solid #23262d;position:sticky;top:0;background:#0f1115;z-index:9}" +
  ".nav{display:flex;align-items:center;gap:8px;margin-top:8px}" +
  ".nav button{background:#23262d;color:#e8eaed;border:0;border-radius:8px;padding:6px 16px;font-size:16px}" +
  ".nav select{flex:1;background:#23262d;color:#e8eaed;border:0;border-radius:8px;padding:6px 8px;font-size:14px}" +
  ".bar{display:flex;gap:8px;padding:10px 12px 0}" +
  ".bar button{flex:1;background:#23262d;color:#9aa0a6;border:0;border-radius:20px;padding:8px 0;font-size:14px}" +
  ".bar button.on{background:#1a3a5c;color:#8ab4f8;font-weight:600}" +
  ".sum{font-size:13px;color:#9aa0a6;padding:10px 14px 2px}" +
  ".card{margin:10px 12px;padding:12px;background:#171a21;border-radius:12px}" +
  ".card img{width:100%;border-radius:8px;display:block;background:#000;min-height:120px;margin-top:6px}" +
  ".row{display:flex;justify-content:space-between;align-items:center;font-size:13px}" +
  ".tm{color:#8ab4f8;font-weight:600}.dev{color:#9aa0a6}" +
  ".tag{font-size:11px;border-radius:8px;padding:1px 6px;margin-left:6px}" +
  ".tagp{background:rgba(255,107,107,.18);color:#ff6b6b}.tago{background:rgba(138,180,248,.15);color:#8ab4f8}" +
  ".ai{font-size:14px;line-height:1.55;margin-top:8px;color:#cfd4da;white-space:pre-wrap}" +
  ".rp{font-size:14px;line-height:1.8;color:#cfd4da}" +
  ".rp b{color:#8ab4f8}" +
  ".empty{text-align:center;color:#5f6368;padding:40px 20px;font-size:14px;line-height:1.8}" +
  "</style></head><body>" +
  "<header>📜 历史记录" +
  "<div class=\"nav\"><button id=\"prev\">‹</button><select id=\"day\"></select><button id=\"next\">›</button></div></header>" +
  "<div class=\"bar\"><button id=\"bP\" class=\"on\">👤 有人记录</button><button id=\"bA\">📋 全部记录</button><button id=\"bR\">📊 日报</button></div>" +
  "<div class=\"sum\" id=\"sum\">加载中...</div><div id=\"list\"></div>" +
  "<scr" + "ipt>" +
  "var qs=new URLSearchParams(location.search);var qVillage=qs.get('village')||'';" +
  "var cur=qs.get('date')||'';var mode='P';" +
  "var el=function(id){return document.getElementById(id)};" +
  "function api(p){return fetch(p).then(function(r){return r.json()})}" +
  "function qp(extra){var a=[];if(cur)a.push('date='+encodeURIComponent(cur));if(qVillage)a.push('village='+encodeURIComponent(qVillage));if(extra)a.push(extra);return a.length?'?'+a.join('&'):''}" +
  "function todayStr(){var d=new Date();return d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate()}" +
  "function mkD(s){var p=s.split('-');return new Date(Number(p[0]),Number(p[1])-1,Number(p[2])).getTime()}" +
  "function setMode(m){mode=m;el('bP').className=(m==='P'?'on':'');el('bA').className=(m==='A'?'on':'');el('bR').className=(m==='R'?'on':'');render()}" +
  "el('bP').onclick=function(){setMode('P')};el('bA').onclick=function(){setMode('A')};el('bR').onclick=function(){setMode('R')};" +
  "el('prev').onclick=function(){shiftDay(-1)};el('next').onclick=function(){shiftDay(1)};" +
  "el('day').onchange=function(){cur=this.value;render()};" +
  "function shiftDay(d){var sel=el('day');var base=cur||todayStr();var p=base.split('-');var dt=new Date(Number(p[0]),Number(p[1])-1,Number(p[2]));dt.setDate(dt.getDate()+d);" +
  "var nn=dt.getFullYear()+'-'+(dt.getMonth()+1)+'-'+dt.getDate();" +
  "var minV=sel.options.length?sel.options[sel.options.length-1].value:null;" +
  "if(mkD(nn)>mkD(todayStr()))return;if(minV&&mkD(nn)<mkD(minV))return;cur=nn;render()}" +
  "function render(){var L=el('list');L.innerHTML='';" +
  "if(!cur){cur=todayStr()}" +
  "var sel=el('day');" +
  "api('/api/history-days'+qp()).then(function(j){" +
  "var days=j.days||[];var t=todayStr();var have=[];for(var i=0;i<sel.options.length;i++)have.push(sel.options[i].value);" +
  "if(!have.length){var opts=days.map(function(d){return d.date});if(opts.indexOf(t)<0)opts.unshift(t);" +
  "opts.slice(0,120).forEach(function(d){var o=document.createElement('option');o.value=d;var dd=days.filter(function(x){return x.date===d})[0];o.textContent=dd?(d+' ·有人'+dd.person):d;sel.appendChild(o)})}" +
  "if(cur&&have.indexOf(cur)<0){var have2=[];for(var i2=0;i2<sel.options.length;i2++)have2.push(sel.options[i2].value);if(have2.indexOf(cur)<0){var o0=document.createElement('option');o0.value=cur;o0.textContent=cur;sel.insertBefore(o0,sel.firstChild)}}" +
  "sel.value=cur;}).catch(function(e2d){});" + // 语句结尾必须有分号: 页面脚本无换行, 缺号会整段SyntaxError(2026-09-04卡"加载中"根因)
  "if(mode==='R'){api('/api/history-report'+qp()).then(function(j){var r=j.report;" +
  "if(!j.found){el('sum').textContent=cur+' · 无日报';L.innerHTML='<div class=empty>📭 该日期没有日报存档<br>日报从2026-09-04起每晚自动存档；<br>更早日期若本地有监控记录会自动重算一份</div>';return}" +
  "el('sum').textContent='📅 '+r.date+' · 有人活动 '+r.total+' 次';" +
  "var d0=document.createElement('div');d0.className='card';var vs=[];var vv=r.villages||{};for(var v in vv)vs.push(v+' '+vv[v]+'次');var ds=[];var dv=r.devices||{};for(var dn in dv)ds.push(dn+'×'+dv[dn]);" +
  "d0.innerHTML='<div class=rp>📊 当日人员活动 <b>'+r.total+'</b> 次'+(vs.length?'<br>🏘 '+vs.join(' · '):'')+(ds.length?'<br>📷 '+ds.join(' · '):'')+(r.rebuilt?'<br><span style=color:#5f6368>(由本地监控记录自动重算)</span>':'')+'</div>';" +
  "L.appendChild(d0);" +
  "(r.lines||[]).forEach(function(ln){var d1=document.createElement('div');d1.className='card';d1.innerHTML='<div class=rp>'+ln+'</div>';L.appendChild(d1)})" +
  "}).catch(function(e){el('sum').textContent='加载失败:'+e});return}" +
  "api('/api/history-events'+qp(mode==='P'?'person=1':'')).then(function(j){" +
  "el('sum').textContent='📅 '+j.date+' · 有人 '+j.person+' 次 / 全部 '+j.total+' 条'+(qVillage?' · '+qVillage:'');" +
  "var L=el('list');if(!j.items.length){L.innerHTML='<div class=empty>📭 '+j.date+' 暂无'+(mode==='P'?'「有人」':'')+'记录'+(j.total?'<br>当天共有'+j.total+'条, 可切「全部记录」查看':'')+'</div>';return}" +
  "j.items.forEach(function(it){var d=document.createElement('div');d.className='card';" +
  "var tg=it.person?'有人':'报警';var tc=it.person?'tagp':'tago';" +
  "var r1=document.createElement('div');r1.className='row';" +
  "r1.innerHTML='<span class=tm>⏰ '+it.hhmm+'</span><span class=dev>'+it.dev+'<span class='+tc+'>'+tg+'</span></span>';" +
  "d.appendChild(r1);" +
  "if(it.title&&it.title!=='人形检测'){var tt=document.createElement('div');tt.style.cssText='font-size:12px;color:#5f6368;margin-top:2px';tt.textContent=it.title;d.appendChild(tt)}" +
  "if(it.pic||it.picEz){var im=new Image();im.decoding='async';im.style.cssText='width:100%;border-radius:8px;display:block;background:#1a1a1a;min-height:120px';var ph=document.createElement('div');ph.textContent='⏳图片加载中…';ph.style.cssText='color:#5f6368;font-size:12px;padding:20px;text-align:center';d.appendChild(ph);im.onload=function(){ph.remove()};im.onerror=function(){if(it.picEz&&im.src!==it.picEz){im.src=it.picEz}else{ph.textContent='⚠️图片加载失败'}};im.loading='lazy';im.src=it.pic||it.picEz;d.appendChild(im)}" +
  "var ad=document.createElement('div');ad.className='ai';if(it.ai){ad.textContent='🤖 '+it.ai}else{ad.textContent='(暂无AI判读)';ad.style.color='#5f6368'}d.appendChild(ad);" +
  "L.appendChild(d)})" +
  "}).catch(function(e){el('sum').textContent='加载失败:'+e})" +
  "}" +
  "render();" +
  "</scr" + "ipt></body></html>";

function buildLiveReply(fromUser, toUser, onlySerial, village) {
  const pubBase = String(((cfg.wxTest || {}).publicBase) || "").replace(/\/$/, "");
  if (!pubBase) return replyText(fromUser, toUser, "⚠️ 公网隧道未开启，无法看直播。请先在电脑上双击一键启动全部.bat");
  const devs = (cfg.devices || []).filter(function (d) { return d.watch && (!onlySerial || d.serial === onlySerial) && (!village || deviceVillage(d.serial) === village); });
  const lines = devs.map(function (d) {
    return "📺 " + d.name + " 直播：\n" + pubBase + "/live?serial=" + d.serial;
  });
  if (!lines.length) return replyText(fromUser, toUser, "没有启用的摄像头设备");
  return replyText(fromUser, toUser,
    dear(fromUser) + "🔴 监控直播（点链接直接看）：\n\n" + lines.join("\n\n") +
    "\n\n💡 首次缓冲约3~8秒。\n若微信里转圈或提示格式不支持：点右上角「···」→「在浏览器打开」即可观看。\n画面卡顿就退出重新点链接（会自动换新地址）");
}

// ---------- 今日人员事件统计 ----------
// 主动拉取今天所有布防设备的人形报警补录进events.json（点「今天有人吗」时先刷新再汇总）
async function refreshTodayEvents() {
  const devs = (cfg.devices || []).filter(function (d) { return d.watch; });
  const d0 = new Date();
  const midnight = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate()).getTime();
  await Promise.all(devs.map(async function (dev) {
    try {
      const r = await client.alarms(dev.serial, midnight, Date.now(), 20);
      if (!r || String(r.code) !== "200" || !Array.isArray(r.data)) return;
      const seen = loadEventsArr(); // 只读快照: 尽早跳过已存在的, 避免白白下载图片消耗配额
      const pending = [];
      for (const a of r.data) {
        const typeCode = String(pickStr(a, ["alarmType", "type", "eventType"]) || "");
        if (typeCode.indexOf("155") !== 0) continue; // 只补录人形类
        const tsRaw = Number(pickStr(a, ["alarmTime", "time", "timestamp"]) || 0);
        const ts = tsRaw < 1e12 ? tsRaw * 1000 : tsRaw;
        if (!ts || ts < midnight) continue;
        const key = dev.serial + "@" + ts;
        if (pending.some(function (p) { return p.key === key; })) continue;
        if (seen.some(function (e) { return e.serial + "@" + e.ts === key; })) continue;
        var fname = "";
        var picUrl = String(pickStr(a, ["alarmPicUrl", "picUrl", "pictureUrl"]) || "");
        if (picUrl) {
          fname = dev.serial + "_p" + ts + ".jpg";
          try { await client.downloadTo(picUrl, path.join(ROOT, "captures", fname)); }
          catch (e1) { fname = ""; }
        }
        if (!fname) {
          try {
            const c = await client.capture(dev.serial);
            if (String(c.code) === "200") {
              const dd = c.data;
              const url = Array.isArray(dd) ? dd[0].picUrl : dd.picUrl;
              fname = dev.serial + "_" + Date.now() + ".jpg";
              await client.downloadTo(url, path.join(ROOT, "captures", fname));
            }
          } catch (e2) {}
        }
        pending.push({ key: key, rec: {
          ts: ts,
          time: new Date(ts).toLocaleString("zh-CN", { hour12: false }),
          serial: dev.serial,
          name: dev.name || dev.serial,
          file: fname,
          title: ALARM_TYPE_NAMES[Number(typeCode)] || "人形检测",
          provider: "", ai: "", person: true, abnormal: false, pushed: false,
          ezvizPic: picUrl || ""
        } });
      }
      if (!pending.length) return;
      // 图片下载等异步准备做完后一次性提交: 锁内重读最新内容并再次按"设备@时间戳"复查去重
      let added = 0;
      const commit = await mutateEvents(function (evts) {
        for (const p of pending) {
          if (evts.some(function (e) { return e.serial + "@" + e.ts === p.key; })) continue;
          evts.push(p.rec);
          added++;
        }
        return added > 0;
      });
      if (commit.ok && commit.written) console.log("[" + new Date().toLocaleTimeString() + "] [今日查询] " + dev.name + " 补录 " + added + " 条");
      else if (!commit.ok) console.log("[今日查询] " + dev.name + " ⚠ 补录未写入(等锁超时) " + pending.length + " 条");
    } catch (e3) {
      console.log("[今日查询] " + dev.name + " 失败: " + e3.message.slice(0, 90));
    }
  }));
}
// 查询完经客服消息发汇总+最近照片(被动回复5秒内先回提示); onlySerial可只看单台设备; village可只限某村(分组裁剪)
async function sendDigestCustom(openid, onlySerial, village) {
  try {
    await refreshTodayEvents();
    let evs = todayPersonEvents();
    const dev = onlySerial ? (cfg.devices || []).find(function (d) { return d.serial === onlySerial; }) : null;
    const label = dev ? dev.name : (village ? village + " " : "");
    if (onlySerial) evs = evs.filter(function (e) { return e.serial === onlySerial; });
    if (village) evs = evs.filter(function (e) { return deviceVillage(e.serial) === village; });
    if (!evs.length) { await sendCustomText(openid, dear(openid) + "📭 " + (label ? label + " " : "") + "今天暂无人员活动记录，一切平安 ✅"); return; }
    const brief = function (e) {
      const aiOk = e.ai && e.ai.indexOf("(") !== 0;
      return e.timeText + " " + e.name + (aiOk ? "｜" + e.ai.replace(/\s+/g, " ").slice(0, 50) : "");
    };
    const pub2 = (cfg.wxTest || {}).publicBase || "";
    // 找最新有图记录作为缩略图
    const latestPic = evs.slice().reverse().find(function (e) { return e.file; });
    const picUrl = latestPic && pub2 ? pub2 + "/captures/" + encodeURIComponent(latestPic.file) : "";
    // 构建卡片描述: 最多5条摘要
    const cardDesc = evs.slice(0, 5).map(function (e) {
      const aiOk = e.ai && String(e.ai).indexOf("(") !== 0;
      return "⏰ " + e.timeText + " " + e.name + (aiOk ? " · " + String(e.ai).replace(/\s+/g, " ").slice(0, 35) : "");
    }).join("\n") + (evs.length > 5 ? "\n... 共" + evs.length + "次" : "") + (pub2 ? "\n\n📖 点击查看全部记录" : "");
    await sendCustomNews(openid,
      dear(openid) + "📋 " + (label ? label + " " : "") + "今日人员活动 " + evs.length + " 次",
      cardDesc, picUrl, pub2 ? pub2 + "/today" + (onlySerial ? "?serial=" + onlySerial : "") : picUrl);
  } catch (e) {
    await sendCustomText(openid, "查询失败: " + e.message.slice(0, 60));
  }
}
function todayPersonEvents() {
  const evts = loadEventsArr();
  const hidden = hiddenSerialSet();
  const d = new Date();
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return evts.filter(function (e) {
    return e.source !== "kanjia" && (e.ts || 0) >= midnight && (e.person === true || /人形检测/.test(String(e.title))) && !hidden.has(e.serial);
  }).map(function (e) {
    const t = new Date(e.ts || Date.now());
    const hh = ("0" + t.getHours()).slice(-2) + ":" + ("0" + t.getMinutes()).slice(-2);
    return { timeText: hh, name: e.name || e.serial || "", file: e.file || "", ai: String(e.ai || ""), serial: e.serial || "" };
  }).sort(function (a, b) { return a.timeText < b.timeText ? -1 : 1; });
}

// ---------- 被动回复:图文消息(news) ----------
function replyNews(fromUser, toUser, articles) {
  let xml = "<xml><ToUserName><![CDATA[" + fromUser + "]]></ToUserName>" +
    "<FromUserName><![CDATA[" + toUser + "]]></FromUserName>" +
    "<CreateTime>" + Math.floor(Date.now() / 1000) + "</CreateTime>" +
    "<MsgType><![CDATA[news]]></MsgType><ArticleCount>" + articles.length + "</ArticleCount><Articles>";
  for (const a of articles) {
    xml += "<item><Title><![CDATA[" + a.title + "]]></Title>" +
      "<Description><![CDATA[" + (a.desc || "") + "]]></Description>" +
      "<PicUrl><![CDATA[" + (a.pic || "") + "]]></PicUrl>" +
      "<Url><![CDATA[" + (a.url || "") + "]]></Url></item>";
  }
  return xml + "</Articles></xml>";
}

// 「今天有人吗」文本汇总 + 异步补发最近现场照片(微信原生图秒开)
function buildTodayDigestReply(fromUser, toUser) {
  try {
    const evs = todayPersonEvents();
    if (!evs.length) return replyText(fromUser, toUser, "📭 今天暂无人员活动，一切平安 ✅\n\n点【当前画面】可看实时截图。");
    const n = evs.length;
    const brief = function (e) {
      const aiOk = e.ai && e.ai.indexOf("(") !== 0;
      return e.timeText + " " + e.name + (aiOk ? "｜" + e.ai.replace(/\s+/g, " ").slice(0, 50) : "");
    };
    const seenH = {}; const withPic = [];
    for (let i = evs.length - 1; i >= 0 && withPic.length < 3; i--) {
      const e2 = evs[i];
      if (!e2.file) continue;
      try {
        const hs = crypto.createHash("md5").update(fs.readFileSync(path.join(ROOT, "captures", e2.file))).digest("hex");
        if (seenH[hs]) continue;
        seenH[hs] = 1;
      } catch (eH) {}
      withPic.unshift(e2);
    }
    const pub3 = (cfg.wxTest || {}).publicBase || "";
    const latestPic = evs.slice().reverse().find(function (e) { return e.file; });
    const picUrl3 = latestPic && pub3 ? pub3 + "/captures/" + encodeURIComponent(latestPic.file) : "";
    const cardDesc3 = evs.slice(0, 5).map(function (e) {
      const aiOk = e.ai && String(e.ai).indexOf("(") !== 0;
      return "⏰ " + e.timeText + " " + e.name + (aiOk ? " · " + String(e.ai).replace(/\s+/g, " ").slice(0, 35) : "");
    }).join("\n") + (n > 5 ? "\n... 共" + n + "次" : "") + (pub3 ? "\n\n📖 点击查看全部记录" : "");
    setTimeout(async function () {
      await sendCustomNews(fromUser,
        dear(fromUser) + "📋 今日人员活动 " + n + " 次",
        cardDesc3, picUrl3, pub3 ? pub3 + "/today" : picUrl3);
    }, 300);
    return replyText(fromUser, toUser,
      "🔍 正在查询 " + (label || "所有设备") + " 今天的报警记录，结果马上发你...");
  } catch (e) {
    return replyText(fromUser, toUser, "查询失败: " + e.message.slice(0, 50));
  }
}

// ---------- 历史查询: 文本指令(如「查询双溪村10点左右的监控」) ----------
// 解析查询指令 -> { village, dayOff, startTs, endTs, label }; 不匹配返回 null
// 支持: 双溪村/木山村 + 今天/昨天/前天 + 凌晨/早上/上午/中午/下午/傍晚/晚上 + X点[半/一刻/三刻/Y分][左右] + X点到Y点
function parseHistoryQuery(text) {
  const t = String(text || "").trim();
  const strictHit = /(查询|查看|查一下|调取|调看|回看)/.test(t) && /(监控|报警|告警|记录|录像)/.test(t);
  const looseHit = /看看/.test(t) && /(监控|录像)/.test(t) && /(\d{1,2}\s*[点时:：]|凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|深夜|昨天|前天|双溪|木山)/.test(t);
  if (!strictHit && !looseHit) return null;
  if (/直播/.test(t)) return null; // 直播走已有分支
  let village = null;
  if (t.indexOf("双溪") >= 0) village = "双溪村";
  else if (t.indexOf("木山") >= 0) village = "木山村";
  let dayOff = 0;
  if (/昨天|昨日|昨晚|昨夜|昨早/.test(t)) dayOff = 1;
  else if (/前天/.test(t)) dayOff = 2;
  const toMin = function (h, part) {
    let m = 0;
    if (part === "半") m = 30;
    else if (part === "一刻") m = 15;
    else if (part === "三刻") m = 45;
    else if (part) m = Number(part) || 0;
    return h * 60 + m;
  };
  const periodMap = [["凌晨", 0, 6], ["今早", 6, 9], ["早上", 6, 9], ["早晨", 6, 9], ["上午", 8, 12], ["中午", 11, 14], ["下午", 13, 18], ["傍晚", 17, 19], ["晚上", 19, 24], ["昨晚", 19, 24], ["今晚", 19, 24], ["夜里", 21, 24], ["昨夜", 21, 24], ["深夜", 23, 24]];
  let period = null;
  for (const p of periodMap) { if (t.indexOf(p[0]) >= 0) { period = p; break; } }
  const pmAdj = function (h) {
    if (period && (period[0] === "下午" || period[0] === "傍晚" || period[0] === "晚上" || period[0] === "昨晚" || period[0] === "今晚" || period[0] === "夜里" || period[0] === "昨夜" || period[0] === "深夜") && h < 12) return h + 12;
    if (period && period[0] === "中午" && h === 1) return 13;
    return h;
  };
  const base = new Date();
  const dayMid = new Date(base.getFullYear(), base.getMonth(), base.getDate() - dayOff).getTime();
  let sMin = null, eMin = null;
  const rangeM = /(\d{1,2})\s*[点时:：]\s*(半|一刻|三刻|\d{1,2})?\s*分?\s*(?:到|至|~|～|—|－|-)\s*(\d{1,2})\s*[点时:：]?\s*(半|一刻|三刻|\d{1,2})?\s*分?/.exec(t);
  if (rangeM) {
    const a = pmAdj(Number(rangeM[1])), b = pmAdj(Number(rangeM[3]));
    if (a > 23 || b > 23 || a === b) return null;
    sMin = toMin(a, rangeM[2]); eMin = toMin(b, rangeM[4]);
    if (eMin <= sMin) { const tmp = sMin; sMin = eMin; eMin = tmp; }
  } else {
    const oneM = /(\d{1,2})\s*[点时:：]\s*(半|一刻|三刻|\d{1,2})?\s*分?\s*(左右|前后|附近|上下)?/.exec(t);
    if (oneM) {
      const h = pmAdj(Number(oneM[1]));
      if (h > 23) return null;
      const c = toMin(h, oneM[2]);
      const half = (oneM[2] && /^\d{1,2}$/.test(String(oneM[2]))) ? 30 : 60; // 精确到分给±30分钟, 只到小时(含"左右")给±60分钟
      sMin = Math.max(0, c - half); eMin = Math.min(24 * 60, c + half);
    } else if (period) {
      sMin = period[1] * 60; eMin = period[2] * 60;
    }
  }
  if (sMin === null) { sMin = 0; eMin = 24 * 60; } // 无时间词: 查全天
  const fmt = function (m2) { return ("0" + Math.floor(m2 / 60) % 24).slice(-2) + ":" + ("0" + (m2 % 60)).slice(-2); };
  const whole = (sMin === 0 && eMin === 24 * 60);
  const dayLabel = (dayOff === 0 ? "今天" : dayOff === 1 ? "昨天" : "前天");
  const head = (period && /昨|今/.test(period[0])) ? period[0] : dayLabel + (period ? period[0] : ""); // "昨晚/今晚"自带日期, 不再重复"昨天/今天"
  const label = head + (whole ? "全天" : " " + fmt(sMin) + "-" + fmt(eMin));
  return { village: village, dayOff: dayOff, startTs: dayMid + sMin * 60000, endTs: dayMid + eMin * 60000, label: label };
}
// 按时间窗收集报警记录(不筛是否有人): 先萤石云端按窗补录(全类型), 再本地events过滤+90秒软去重
async function collectWindowEvents(startTs, endTs, village, serial) {
  const devs = (cfg.devices || []).filter(function (d) {
    return d.watch && (!serial || d.serial === serial) && (!village || deviceVillage(d.serial) === village);
  });
  let downloaded = 0;
  for (const dev of devs) {
    try {
      const r = await client.alarms(dev.serial, startTs, endTs, 20);
      if (!r || String(r.code) !== "200" || !Array.isArray(r.data) || !r.data.length) continue;
      const seen = loadEventsArr(); // 只读快照: 尽早跳过已存在的
      const pending = [];
      for (const a of r.data) {
        const tsRaw = Number(pickStr(a, ["alarmTime", "time", "timestamp"]) || 0);
        const ts = tsRaw < 1e12 ? tsRaw * 1000 : tsRaw;
        if (!ts || ts < startTs || ts > endTs) continue;
        const key = dev.serial + "@" + ts;
        if (pending.some(function (p) { return p.key === key; })) continue;
        if (seen.some(function (e) { return e.serial + "@" + e.ts === key; })) continue;
        const picUrl = String(pickStr(a, ["alarmPicUrl", "picUrl", "pictureUrl"]) || "");
        let fname = "";
        if (picUrl && downloaded < 10) { // 每次查询最多补下10张图, 防止大窗口拖慢回复
          fname = dev.serial + "_p" + ts + ".jpg";
          try { await client.downloadTo(picUrl, path.join(ROOT, "captures", fname)); downloaded++; }
          catch (e1) { fname = ""; }
        }
        const typeCode = String(pickStr(a, ["alarmType", "type", "eventType"]) || "");
        const isPerson = /^155/.test(typeCode) || typeCode === "SmartHumanDet" || typeCode === "intelligentDetection" || /human/i.test(typeCode);
        const typeName = ALARM_TYPE_NAMES[typeCode] || (isPerson ? "人形检测" : "报警");
        pending.push({ key: key, rec: {
          ts: ts, time: new Date(ts).toLocaleString("zh-CN", { hour12: false }), serial: dev.serial,
          name: dev.name || dev.serial, file: fname, title: typeName, provider: "", ai: "",
          person: isPerson, abnormal: false, pushed: false, ezvizPic: picUrl || ""
        } });
      }
      if (!pending.length) continue;
      // 异步准备(下载图片)做完后一次性提交, 锁内重读最新内容并按"设备@时间戳"复查去重
      let added = 0;
      const commit = await mutateEvents(function (evts) {
        for (const p of pending) {
          if (evts.some(function (e) { return e.serial + "@" + e.ts === p.key; })) continue;
          evts.push(p.rec);
          added++;
        }
        return added > 0;
      });
      if (commit.ok && commit.written) console.log("[" + new Date().toLocaleTimeString() + "] [历史查询] " + dev.name + " 云端补录 " + added + " 条");
      else if (!commit.ok) console.log("[历史查询] " + dev.name + " ⚠ 补录未写入(等锁超时) " + pending.length + " 条");
    } catch (e) { console.log("[历史查询] " + dev.name + " 云端补录失败: " + e.message.slice(0, 80)); }
  }
  const hidden = hiddenSerialSet();
  const filtered = loadEventsArr().filter(function (e) {
    return e.source !== "kanjia" && !hidden.has(e.serial) && (e.ts || 0) >= startTs && (e.ts || 0) <= endTs &&
      (!village || deviceVillage(e.serial) === village) && (!serial || e.serial === serial);
  }).sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
  // 软去重: 同设备90秒内多条(实时推送与云端补录时间戳差异)合并为一条, 优先保留有图有AI的
  const merged = [];
  for (const e of filtered) {
    const prev = merged[merged.length - 1];
    if (prev && prev.serial === e.serial && Math.abs((prev.ts || 0) - (e.ts || 0)) < 90e3) {
      if (!prev.file && e.file) prev.file = e.file;
      if ((!prev.ai || String(prev.ai).indexOf("(") === 0) && e.ai) { prev.ai = e.ai; prev.person = e.person; }
      continue;
    }
    merged.push(e);
  }
  return merged;
}
// 查询结果经客服消息发: 文字汇总(含AI结论) + 最多3张窗口内截图 + 图文卡片(跳/history完整页)
async function sendHistoryQueryResult(openid, pq) {
  try {
    const villageScope = villageScopeOf(openid);
    const village = pq.village || villageScope;
    const evs = await collectWindowEvents(pq.startTs, pq.endTs, village, null);
    if (!evs.length) { await sendCustomText(openid, dear(openid) + "📭 " + pq.label + (village ? " " + village : "") + " 暂无报警记录，一切平安 ✅"); return; }
    // 补AI判读: 最多补2条无AI且有本地图的, 避免回复太慢
    let aiDone = 0;
    for (const e of evs) {
      if (aiDone >= 2) break;
      if (e.file && (!e.ai || String(e.ai).indexOf("(") === 0)) {
        try {
          const txt = await analyzeAndStore(e.file);
          if (txt) { e.ai = txt; e.person = judgePerson(txt).person; }
          aiDone++;
        } catch (eA) {}
      }
    }
    const lines = evs.slice(0, 8).map(function (e) {
      const t2 = new Date(e.ts || 0);
      const hhmm = ("0" + t2.getHours()).slice(-2) + ":" + ("0" + t2.getMinutes()).slice(-2);
      const aiOk = e.ai && String(e.ai).indexOf("(") !== 0;
      return "⏰ " + hhmm + " " + e.name + "（" + (e.title || "报警") + "）" + (aiOk ? "\n🤖 " + String(e.ai).replace(/\s+/g, " ").slice(0, 60) : "");
    });
    const msg = dear(openid) + "📋 " + pq.label + (village ? " " + village : "") + " 报警记录 共" + evs.length + " 条\n\n" +
      lines.join("\n") + (evs.length > 8 ? "\n... 共" + evs.length + "条, 点下面卡片看全部" : "");
    await sendCustomText(openid, msg);
    // 截图: 取离查询时段中心最近的3条有本地图的记录
    const mid = (pq.startTs + pq.endTs) / 2;
    const withPic = evs.filter(function (e) { return e.file; })
      .sort(function (a, b) { return Math.abs((a.ts || 0) - mid) - Math.abs((b.ts || 0) - mid); })
      .slice(0, 3).sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
    for (const e of withPic) { try { await sendCustomImage(openid, e.file); } catch (eI) {} }
    // 图文卡片 -> /history 完整页(全部截图+AI结论)
    const pub = (cfg.wxTest || {}).publicBase || "";
    if (pub) {
      const d = new Date(pq.startTs);
      const dateKey = d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
      const latestPic = evs.slice().reverse().find(function (e) { return e.file; });
      const picUrl = latestPic ? pub + "/captures/" + encodeURIComponent(latestPic.file) : "";
      const qs = "?date=" + encodeURIComponent(dateKey) + (village ? "&village=" + encodeURIComponent(village) : "");
      await sendCustomNews(openid, "📜 " + pq.label + (village ? " " + village : "") + " 报警记录 " + evs.length + " 条", "点开查看全部截图+AI分析结论", picUrl, pub + "/history" + qs);
    } else {
      await sendCustomText(openid, "💡 公网隧道未开启, 暂时只能看以上摘要。开启后点卡片可看全部记录。");
    }
  } catch (e) {
    await sendCustomText(openid, "查询失败: " + e.message.slice(0, 60)).catch(function () {});
  }
}
// 「历史」入口(菜单/文本): 被动回复图文卡片跳 /history 页(分组成员自动带村过滤)
function buildHistoryEntryReply(fromUser, toUser, villageScope) {
  const pub = (cfg.wxTest || {}).publicBase || "";
  if (!pub) return replyText(fromUser, toUser, "⚠️ 公网隧道未开启，暂无法打开历史记录页。请先在电脑上双击一键启动全部.bat");
  const qs = villageScope ? "?village=" + encodeURIComponent(villageScope) : "";
  return replyNews(fromUser, toUser, [{ title: "📜 历史记录查询", description: "有人活动记录 + 历史日报，按日期回看", pic: "", url: pub + "/history" + qs }]);
}

// ---------- 日报快照存档(data/daily_reports/日期.json): 支撑「历史日报」查询 ----------
function saveDailyReportSnapshot(dateKey, snap) {
  try {
    const dir = path.join(ROOT, "data", "daily_reports");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, String(dateKey).replace(/[^\w-]/g, "_") + ".json"), JSON.stringify(snap, null, 1));
  } catch (e) { console.log("[日报存档] 写入失败: " + e.message.slice(0, 80)); }
}
function loadDailyReportSnapshot(dateKey) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "data", "daily_reports", String(dateKey).replace(/[^\w-]/g, "_") + ".json"), "utf8"));
  } catch (e) { return null; }
}
// 无存档时从本地events重算某日日报(本地记录窗口内的日期都能算)
function buildReportForDate(dateKey) {
  const m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(dateKey || ""));
  if (!m) return null;
  const mid = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  const end = mid + 86400e3;
  const hidden = hiddenSerialSet();
  const evts = loadEventsArr().filter(function (e) {
    return e.source !== "kanjia" && !hidden.has(e.serial) && (e.ts || 0) >= mid && (e.ts || 0) < end;
  });
  const person = evts.filter(function (e) { return e.person === true || /人形检测/.test(String(e.title)); });
  const villages = {}, devices = {};
  for (const e of person) {
    const v = deviceVillage(e.serial) || "其他";
    villages[v] = (villages[v] || 0) + 1;
    devices[e.name || e.serial] = (devices[e.name || e.serial] || 0) + 1;
  }
  const lines = person.slice(0, 30).map(function (e) {
    const t2 = new Date(e.ts || 0);
    const hhmm = ("0" + t2.getHours()).slice(-2) + ":" + ("0" + t2.getMinutes()).slice(-2);
    const aiOk = e.ai && String(e.ai).indexOf("(") !== 0;
    return "⏰" + hhmm + " " + (e.name || e.serial) + (aiOk ? "｜" + String(e.ai).replace(/\s+/g, " ").slice(0, 40) : "｜（AI未判读）");
  });
  return { date: m[1] + "-" + m[2] + "-" + m[3], total: person.length, villages: villages, devices: devices, lines: lines, rebuilt: true };
}

// ---------- 每晚定时日报(默认20:00, 错过开机补发) ----------
function todayKey() {
  const d = new Date();
  return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
}
// 纳入日报的设备 = 启用监控(watch)且未隐藏(hidden)的；即当前主力2台
function dailyReportDevices() {
  return (cfg.devices || []).filter(function (x) { return x.watch && !x.hidden; })
    .map(function (x) { return x.name; });
}
// 拉取测试号全部关注者 openid(供分组推送/日报按组分发)
async function fetchOpenids() {
  try {
    let token = await wxTestToken();
    let ur = await fetch("https://api.weixin.qq.com/cgi-bin/user/get?access_token=" + token + "&next_openid=");
    let uj = await ur.json();
    if (isTokErr(uj.errcode)) {
      token = await wxTestToken(true);
      ur = await fetch("https://api.weixin.qq.com/cgi-bin/user/get?access_token=" + token + "&next_openid=");
      uj = await ur.json();
    }
    return (uj.data && uj.data.openid) || [];
  } catch (e) { console.log("[日报] 关注者列表获取失败: " + e.message.slice(0, 60)); return []; }
}
// 按给定事件列表与设备标签拼装日报文案; village 传村名时链接只看该村(分组日报防越权)
function buildDailyReportContent(evs, devLabels, village) {
  const n = evs.length;
  const pub = (cfg.wxTest || {}).publicBase || "";
  const todayUrl = pub + "/today" + (village ? ("?village=" + encodeURIComponent(village)) : "");
  let first, remark;
  if (!n) {
    first = "📊 老家监控日报";
    remark = "今天平安无事 ✅ 全天无人员活动\n覆盖设备: " + devLabels.join(" / ");
  } else {
    first = "📊 老家监控日报（人员活动 " + n + " 次）";
    const lines = evs.slice(0, 6).map(function (e) {
      const aiOk = e.ai && String(e.ai).indexOf("(") !== 0;
      const aiBrief = aiOk ? String(e.ai).replace(/\s+/g, " ").slice(0, 28) : "（AI未判读）";
      return "⏰" + e.timeText + " " + e.name + "｜" + aiBrief;
    });
    remark = lines.join("\n") + (n > 6 ? "\n... 共" + n + "次" : "") +
      "\n覆盖设备: " + devLabels.join(" / ") + "\n点本消息看完整AI分析 👉";
  }
  return { first: first, remark: remark, url: todayUrl };
}
let _dailyBusy = false;
async function maybeDailyReport() {
  const T = cfg.wxTest || {};
  if (T.enabled === false || T.dailyReport === false || !T.templateId) return;
  const d = new Date();
  if (d.getHours() < (T.reportHour || 20)) return;
  const key = todayKey();
  let st = {};
  try { st = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "daily_report.json"), "utf8")); } catch (e) {}
  if (st.last === key || _dailyBusy) return;
  _dailyBusy = true;
  try {
    // 全日人形事件(已过滤隐藏设备)
    const all = todayPersonEvents();
    let openids = [];
    try { openids = await fetchOpenids(); } catch (e) { console.log("[日报] 关注者列表获取失败: " + e.message.slice(0, 60)); }
    // token 未就绪时 openids 可能为空: 不标记已发, 下一分钟自动重试(避免当天整日漏报)
    if (!openids.length) { console.log("[日报] " + key + " 暂未取得关注者列表, 下个周期重试"); return; }

    // 按分组分发: 默认组(全量) + 各 scope 组(按村裁剪); 同事组(push=none)不发送
    const buckets = {}; // scope -> { ids:[], labels:[] }
    const defaultIds = [];
    for (const oid of openids) {
      const g = groupOf(oid);
      if (!g) { defaultIds.push(oid); continue; }
      const scope = g.push || "all";
      if (scope === "all") { defaultIds.push(oid); continue; }
      if (scope === "none") continue; // 同事组等: 不接收日报
      (buckets[scope] = buckets[scope] || { ids: [], labels: deviceNamesByVillage(scope) }).ids.push(oid);
    }
    const plan = [];
    // 默认组: 全部设备
    if (defaultIds.length) {
      const c = buildDailyReportContent(all, dailyReportDevices());
      plan.push(pushTestTemplate(c.first, key, "每日汇总", c.remark, c.url, true,
        { allowOid: function (oid) { return defaultIds.indexOf(oid) >= 0; } }));
    }
    // 按村分组: 仅该村民事件, 链接也只看该村
    for (const scope of Object.keys(buckets)) {
      const b = buckets[scope];
      if (!b.ids.length) continue;
      const evsV = all.filter(function (e) { return deviceVillage(e.serial) === scope; });
      const c = buildDailyReportContent(evsV, b.labels, scope);
      plan.push(pushTestTemplate(c.first, key, "每日汇总", c.remark, c.url, true,
        { allowOid: function (oid) { return b.ids.indexOf(oid) >= 0; } }));
    }
    const results = await Promise.all(plan);
    const sentAny = results.some(function (n) { return n > 0; });
    // 全部失败(网络/token抖动): 不记账, 下一分钟自动重试, 避免日报因瞬时故障整天丢失
    if (!sentAny) { console.log("[日报] " + key + " 本轮推送全部失败, 下个周期重试"); return; }
    const failedGroups = results.filter(function (n) { return n === 0; }).length;
    if (failedGroups > 0) console.log("[日报] 部分分组推送失败(" + failedGroups + "组), 已记账不再重试以免重复打扰");
    st.last = key;
    try { fs.writeFileSync(path.join(ROOT, "data", "daily_report.json"), JSON.stringify(st)); } catch (e2) {}
    // 日报快照存档: 供「历史日报」按日回查(无存档的历史日期由 buildReportForDate 从本地events重算)
    try {
      const snap = { date: key, total: all.length, villages: {}, devices: {}, lines: [], published: true };
      for (const e of all) {
        const v = deviceVillage(e.serial) || "其他";
        snap.villages[v] = (snap.villages[v] || 0) + 1;
        snap.devices[e.name || e.serial] = (snap.devices[e.name || e.serial] || 0) + 1;
      }
      snap.lines = all.slice(0, 30).map(function (e) {
        const aiOk = e.ai && String(e.ai).indexOf("(") !== 0;
        return (e.timeText || "") + " " + (e.name || "") + (aiOk ? "｜" + String(e.ai).replace(/\s+/g, " ").slice(0, 40) : "");
      });
      saveDailyReportSnapshot(key, snap);
      console.log("[日报] 快照已存档: " + key);
    } catch (eSnap) { console.log("[日报] 快照存档失败: " + eSnap.message.slice(0, 80)); }
    console.log("[日报] 已推送 " + key + " (活动" + all.length + "次); 默认组" + defaultIds.length + "人, 分组成员" + Object.keys(buckets).map(function (s) { return s + ":" + buckets[s].ids.length; }).join(","));
  } finally { _dailyBusy = false; }
}
setInterval(maybeDailyReport, 60e3);
setTimeout(maybeDailyReport, 20e3);

async function freshCapture(serial) {
  const r = await client.capture(serial);
  if (r.code !== "200") throw new Error("抓图失败 code=" + r.code);
  const d = r.data;
  const url = Array.isArray(d) ? d[0].picUrl : d.picUrl;
  const file = path.join(ROOT, "captures", serial + "_" + Date.now() + ".jpg");
  await client.downloadTo(url, file);
  return file;
}

async function handleKanJia(dev, fromUser, toUser) {
  // 分组权限: 该微信无权查询此设备(同事组仅状态/双溪村组仅双溪村) -> 拦截
  if (!canQuery(fromUser, dev.serial)) {
    return replyText(fromUser, toUser, queryBlockedMsg(fromUser, dev.name));
  }
  const latest = latestCapture(dev.serial);
  // 缓存窗口 30s(原 10min 过长, 5分钟前的图就被当作"新鲜"复用, 用户主动查询应拿到实时画面)
  const hasFresh = latest && Date.now() - latest.mtimeMs < 30 * 1000;
  const Tq = cfg.wxTest || {};
  if (!hasFresh && Tq.enabled && Tq.appId && Tq.appSecret) {
    // 无新鲜缓存时不让微信干等(被动回复>5秒会被静默丢弃): 秒回提示, 照片+AI走客服消息异步送达
    (async function () {
      try {
        const f2 = await freshCapture(dev.serial);
        await recordKanjiaCapture(f2, dev); // 写占位记录, /detail?file=... 才能查到
        const okImg = await sendCustomImage(fromUser, f2);
        if (!okImg) { console.log("[看家] 异步送图失败(通道受限)"); return; }
        if ((cfg.ai || {}).enabled && (cfg.ai || {}).autoAnalyze !== false && aiProviders().length) {
          await aiFollowUp(f2, fromUser, dev);
        }
      } catch (e0) { console.log("[看家] 异步截屏失败: " + e0.message.slice(0, 80)); }
    })();
    return replyText(fromUser, toUser, "📸 正在截取 " + dev.name + " 当前画面，几秒内自动发给你...");
  }
  let file = hasFresh ? latest.file : null;
  if (!file) file = await freshCapture(dev.serial);
  await recordKanjiaCapture(file, dev); // 写占位记录, /detail?file=... 才能查到
  // 异步再抓一张新的存着, 下次查询更新鲜（不阻塞本次回复）
  freshCapture(dev.serial).catch(function () {});
  // 异步AI判读, 结论用客服消息补发（微信被动回复限5秒, 不能等AI）
  if ((cfg.ai || {}).enabled && (cfg.ai || {}).autoAnalyze !== false && aiProviders().length) {
    aiFollowUp(file, fromUser, dev).catch(function () {});
  }
  // 多账号尝试上传：测试号优先(主公众号IP白名单频繁40164且动态IP漂移)
  // 惰性取token: 前一账号成功就不碰下一个; 40001(token被外部轮换)强刷重试一次自愈
  let lastErr = null;
  const Tw = cfg.wxTest || {};
  const accts = [];
  if (Tw.enabled && Tw.appId && Tw.appSecret) accts.push({ name: "测试号", test: true });
  accts.push({ name: "主公众号" });
  for (const a of accts) {
    let tk;
    try { tk = a.test ? await getWxToken(Tw.appId, Tw.appSecret, "wx_test_token.json") : await wxAccessToken(); }
    catch (e1) { if (a.name === "主公众号") console.log("[看家] 主号token失败: " + e1.message.slice(0, 110)); else lastErr = e1; continue; }
    for (let att = 0; att < 2; att++) {
      try {
        const mediaId = await uploadTempImage(file, tk);
        console.log("[看家] 照片经由" + a.name + "发送成功");
        return replyImage(fromUser, toUser, mediaId);
      } catch (e3) {
        lastErr = e3;
        console.log("[看家] " + a.name + " 上传失败: " + e3.message.slice(0, 110));
        if (att === 0 && isTokErr(e3.message)) { try { await new Promise(function(r){setTimeout(r,2000)}); tk = a.test ? await getWxToken(Tw.appId, Tw.appSecret, "wx_test_token.json", true) : await wxAccessToken(true); continue; } catch (e4) { break; } }
        break;
      }
    }
  }
  throw lastErr || new Error("无可用微信账号");
}

const server = http.createServer(function (req, res) {
  const u = new URL(req.url, "http://localhost");
  if (req.method === "GET" && u.pathname === "/__who") {
    if (!isLoopback(req)) { res.writeHead(403); res.end(""); return; } // 不向公网暴露 pid
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ app: APP_NAME, version: VERSION, pid: process.pid }));
    return;
  }
  if (req.method === "GET" && u.pathname === "/__shutdown") {
    if (isLoopback(req)) {
      // 本机：仅允许新实例按 pid 接管退出（启动脚本自愈用）
      const sq = Object.fromEntries(u.searchParams.entries());
      if (sq.pid === String(process.pid)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
        console.log("[关闭] 收到新实例接管请求，正在退出...");
        removePidIfMine();
        setTimeout(function() { process.exit(0); }, 300);
      } else {
        res.writeHead(403);
        res.end("");
      }
    } else {
      // 远程：必须携带 shutdownToken（或 wxServer.token），否则拒绝，防止公网隧道被恶意一键关服
      const tok = ((cfg.wxServer && (cfg.wxServer.shutdownToken || cfg.wxServer.token)) || "");
      if (tok && u.searchParams.get("token") === tok) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
        console.log("[关闭] 收到鉴权通过的远程关闭请求，正在退出...");
        removePidIfMine();
        setTimeout(function() { process.exit(0); }, 300);
      } else {
        res.writeHead(403);
        res.end("");
      }
    }
    return;
  }
  if (req.method === "GET" && u.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, app: APP_NAME, version: VERSION, pid: process.pid }));
    return;
  }
  // ---- 萤石开放平台消息推送接收端 ----
  if (u.pathname === "/ezviz/push" || u.pathname === "/ezviz/push/") {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, hint: "ezviz push receiver ready (POST here)" }));
      return;
    }
    if (req.method === "POST") {
      var chunks = [];
      req.on("data", function (c) { chunks.push(c); });
      req.on("end", function () {
        const bodyRaw = Buffer.concat(chunks).toString("utf8");
        // 萤石要求2秒内响应且回显messageId(缺失会被后台判"推送失败/messageId缺失"), 先秒回再异步处理
        var mid = "";
        var mMid = /"messageId"\s*:\s*"([^"]+)"/.exec(bodyRaw);
        if (mMid) mid = mMid[1];
        else {
          var mAl = /"alarmId"\s*:\s*"([^"]+)"/.exec(bodyRaw);
          if (mAl) mid = mAl[1];
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(mid ? { code: 200, messageId: mid } : { code: 200 }));
        handleEzvizPush(bodyRaw, req.headers).catch(function (e) {
          console.log("[萤石推送] 处理失败: " + e.message);
        });
      });
      return;
    }
    res.writeHead(405); res.end(""); return;
  }
  // 监控直播H5播放页(微信内打开)
  if (req.method === "GET" && u.pathname === "/live") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(LIVE_PAGE_HTML);
    return;
  }
  // 直播地址实时获取(HLS, 每次打开页面都取新地址, 永不过期)
  // 今日人员活动数据接口(供/today时间线页用)
  if (req.method === "GET" && u.pathname === "/api/today-events") {
    try {
      const qSerial = u.searchParams.get("serial") || "";
      const qVillage = u.searchParams.get("village") || ""; // 分组过滤: 双溪村组打开日报链接只看该村的记录
      const byVillage = function (e) { return !qVillage || deviceVillage(e.serial) === qVillage; };
      let evs = todayPersonEvents().filter(byVillage);
      if (qSerial) evs = evs.filter(function (e) { return e.serial === qSerial; });
      let displayDate = todayKey();
      let isToday = true;
      if (!evs.length) {
        const all = loadEventsArr().filter(function (e) { return e.source !== "kanjia" && (e.person === true || /人形检测/.test(String(e.title))) && (!qSerial || e.serial === qSerial) && byVillage(e); });
        if (all.length) {
          const latest = all[all.length - 1];
          const lt = new Date(latest.ts || 0);
          const dayMid = new Date(lt.getFullYear(), lt.getMonth(), lt.getDate()).getTime();
          evs = all.filter(function (e) { return (e.ts || 0) >= dayMid; }).map(function (e) {
            const t = new Date(e.ts || 0);
            const hh = ("0" + t.getHours()).slice(-2) + ":" + ("0" + t.getMinutes()).slice(-2);
            return { timeText: hh, name: e.name || e.serial || "", file: e.file || "", ai: String(e.ai || ""), serial: e.serial || "" };
          }).sort(function (a, b) { return a.timeText < b.timeText ? -1 : 1; });
          displayDate = lt.getFullYear() + "-" + ("0" + (lt.getMonth() + 1)).slice(-2) + "-" + ("0" + lt.getDate()).slice(-2);
          isToday = false;
        }
      }
      const qDevName = qSerial ? (((cfg.devices || []).find(function (d) { return d.serial === qSerial; }) || {}).name || qSerial) : "";
      const pub = (cfg.wxTest || {}).publicBase || ("http://" + (req.headers.host || "127.0.0.1:8787"));
      const items = evs.slice().reverse().map(function (e) { // 最新在前
        const pubBase = pub + "/captures/";
        let picUrl = "";
        if (e.file) picUrl = pubBase + encodeURIComponent(e.file);
        let picEzUrl = "";
        if (e.ezvizPic) picEzUrl = e.ezvizPic;
        return {
          hhmm: e.timeText,
          dev: e.name,
          ai: (e.ai && String(e.ai).indexOf("(") !== 0) ? String(e.ai).replace(/\s+/g, " ").slice(0, 200) : "",
          pic: picUrl,
          picEz: picEzUrl
        };
      });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ date: displayDate, count: items.length, isToday: isToday, devName: qDevName, items: items }));
    } catch (eT) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ err: eT.message }));
    }
    return;
  }
  // ---- 历史记录页 + 历史API(有人记录/全部报警记录/日报存档 按日回查) ----
  if (req.method === "GET" && u.pathname === "/history") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HISTORY_PAGE_HTML);
    return;
  }
  // 某天的报警记录(默认全部类型不筛是否有人; person=1 只看有人; village 按村过滤)
  if (req.method === "GET" && u.pathname === "/api/history-events") {
    try {
      const qDate = u.searchParams.get("date") || todayKey();
      const qVillage = u.searchParams.get("village") || "";
      const onlyPerson = u.searchParams.get("person") === "1";
      const m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(qDate);
      if (!m) { res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify({ err: "bad date" })); return; }
      const mid = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
      const end = mid + 86400e3;
      const hidden = hiddenSerialSet();
      const evs = loadEventsArr().filter(function (e) {
        return e.source !== "kanjia" && !hidden.has(e.serial) && (e.ts || 0) >= mid && (e.ts || 0) < end &&
          (!qVillage || deviceVillage(e.serial) === qVillage);
      }).sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
      const isPersonEv = function (e) { return e.person === true || /人形检测/.test(String(e.title)); };
      const personN = evs.filter(isPersonEv).length;
      const shown = onlyPerson ? evs.filter(isPersonEv) : evs;
      const pub = (cfg.wxTest || {}).publicBase || ("http://" + (req.headers.host || "127.0.0.1:8787"));
      const items = shown.map(function (e) {
        const t = new Date(e.ts || 0);
        const hh = ("0" + t.getHours()).slice(-2) + ":" + ("0" + t.getMinutes()).slice(-2);
        return {
          hhmm: hh, dev: e.name || e.serial || "", title: String(e.title || ""), person: isPersonEv(e),
          ai: (e.ai && String(e.ai).indexOf("(") !== 0) ? String(e.ai).replace(/\s+/g, " ").slice(0, 300) : "",
          pic: e.file ? pub + "/captures/" + encodeURIComponent(e.file) : "", picEz: e.ezvizPic || "", serial: e.serial || ""
        };
      });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ date: qDate, total: evs.length, person: personN, count: items.length, items: items }));
    } catch (eH) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ err: eH.message }));
    }
    return;
  }
  // 有记录的日子列表(供历史页日期下拉: 每天总数/有人数/是否有日报存档)
  if (req.method === "GET" && u.pathname === "/api/history-days") {
    try {
      const qVillage = u.searchParams.get("village") || "";
      const hidden = hiddenSerialSet();
      const evts = loadEventsArr().filter(function (e) {
        return e.source !== "kanjia" && !hidden.has(e.serial) && (!qVillage || deviceVillage(e.serial) === qVillage);
      });
      const byDay = {};
      for (const e of evts) {
        const d2 = new Date(e.ts || 0);
        const k2 = d2.getFullYear() + "-" + (d2.getMonth() + 1) + "-" + d2.getDate();
        const b = byDay[k2] = byDay[k2] || { date: k2, total: 0, person: 0 };
        b.total++;
        if (e.person === true || /人形检测/.test(String(e.title))) b.person++;
      }
      const reports = {};
      try {
        for (const f of fs.readdirSync(path.join(ROOT, "data", "daily_reports"))) {
          if (/\.json$/.test(f)) reports[f.replace(/\.json$/, "")] = 1;
        }
      } catch (eR) {}
      const days = Object.keys(byDay).map(function (k2) {
        return { date: k2, total: byDay[k2].total, person: byDay[k2].person, report: !!reports[k2] };
      });
      days.sort(function (a, b) { return a.date < b.date ? 1 : -1; }); // 最新在前
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ days: days }));
    } catch (eD) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ err: eD.message }));
    }
    return;
  }
  // 某天的日报(优先读存档; 无存档且本地有记录时自动重算)
  if (req.method === "GET" && u.pathname === "/api/history-report") {
    try {
      const qDate = u.searchParams.get("date") || todayKey();
      const m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(qDate);
      if (!m) { res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify({ err: "bad date" })); return; }
      const norm = m[1] + "-" + m[2] + "-" + m[3];
      let rep = loadDailyReportSnapshot(norm);
      let rebuilt = false;
      if (!rep) { rep = buildReportForDate(norm); rebuilt = true; }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ date: norm, found: !!rep, report: rep }));
    } catch (eP) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ err: eP.message }));
    }
    return;
  }
  // ---- 推送详情页：/detail?file=xxx 展示现场照片 + AI 分析结论 ----
  function buildDetailHtml(file) {
    const esc = function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
    const ORIG_URL = "/captures/" + encodeURIComponent(file || "");
    const HEAD = "<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1.0'><title>老家监控 · 现场分析</title><style>" +
      ":root{--bg:#0f1419;--card:#161d26;--border:#232b36;--text:#e6e6e6;--text2:#b6c2cc;--accent:#f5c518;--person:#ff6b6b;--nobody:#51cf66}" +
      "*{box-sizing:border-box;margin:0;padding:0}" +
      "body{background:var(--bg);color:var(--text);font-family:'Microsoft YaHei',system-ui,sans-serif;min-height:100vh;padding:16px}" +
      ".wrap{max-width:640px;margin:0 auto}h1{font-size:18px;color:#fff;margin-bottom:4px}.sub{color:var(--text2);font-size:13px;margin-bottom:16px}" +
      ".tag{display:inline-block;padding:3px 12px;border-radius:12px;font-size:13px;margin-bottom:16px}" +
      ".tag.person{background:rgba(255,107,107,.2);color:var(--person)}.tag.nobody{background:rgba(81,207,102,.2);color:var(--nobody)}" +
      ".imgbox{background:#0b0f14;border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:8px;position:relative;cursor:zoom-in}" +
      ".imgbox img{width:100%;display:block;-webkit-user-drag:none;user-select:none;-webkit-touch-callout:none}" +
      ".hint{color:var(--text2);font-size:12px;margin:6px 0 16px 0;text-align:center}" +
      ".meta{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px 16px;margin-bottom:16px;font-size:14px;line-height:1.9}" +
      ".meta b{color:var(--text2);font-weight:400}" +
      ".ai{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px}.ai h2{font-size:14px;color:var(--accent);margin-bottom:10px}" +
      ".ai .body{font-size:15px;line-height:1.7;white-space:pre-wrap;word-break:break-word}" +
      ".empty{text-align:center;color:var(--text2);padding:60px 20px;line-height:1.8}" +
      // 灯箱lightbox样式
      ".lb-mask{position:fixed;left:0;top:0;width:100%;height:100%;background:rgba(0,0,0,.95);z-index:999;display:none;align-items:center;justify-content:center;touch-action:none}" +
      ".lb-mask.show{display:flex}" +
      ".lb-mask img{max-width:100%;max-height:100%;-webkit-user-drag:none;user-select:none;-webkit-touch-callout:none;transition:transform .15s ease}" +
      ".lb-close{position:fixed;top:14px;right:14px;width:42px;height:42px;border-radius:21px;background:rgba(255,255,255,.15);color:#fff;font-size:24px;text-align:center;line-height:42px;z-index:1000;display:none;cursor:pointer}" +
      ".lb-close.show{display:block}" +
      ".lb-tip{position:fixed;left:0;right:0;bottom:18px;text-align:center;color:#fff;font-size:13px;opacity:.85;z-index:1000;display:none}" +
      ".lb-tip.show{display:block}" +
      "</style></head><body><div class='wrap'>";
    const LB_HTML = "<div id='lb' class='lb-mask' onclick='lbHide()'><img id='lbImg' src='' alt=''></div><div id='lbClose' class='lb-close' onclick='lbHide()'>×</div><div id='lbTip' class='lb-tip'>双击放大 · 双指捏合缩放 · 长按可保存</div>" + "<scr" + "ipt>" +
      // 灯箱打开/关闭
      "function lbShow(){var m=document.getElementById('lb');var c=document.getElementById('lbClose');var t=document.getElementById('lbTip');m.classList.add('show');c.classList.add('show');t.classList.add('show');document.body.style.overflow='hidden';}" +
      "function lbHide(){var m=document.getElementById('lb');var c=document.getElementById('lbClose');var t=document.getElementById('lbTip');m.classList.remove('show');c.classList.remove('show');t.classList.remove('show');document.body.style.overflow='';resetZoom();}" +
      "function resetZoom(){var im=document.getElementById('lbImg');im.style.transform='translate(0,0) scale(1)';im.dataset.drag=null;im.dataset.scale=1;}" +
      // 灯箱内图片支持: 双击放大; 单指拖; 双指缩放(简单实现:用第一根+第二根手指距离变化)
      "var lbImg=document.getElementById('lbImg');" +
      "var pinch0=0,scale0=1,dist0=0;" +
      "lbImg.addEventListener('touchstart',function(e){" +
        "if(e.touches.length===2){dist0=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);scale0=parseFloat(lbImg.dataset.scale||1);e.preventDefault()}" +
      "},{passive:false});" +
      "lbImg.addEventListener('touchmove',function(e){" +
        "if(e.touches.length===2){var d=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);var ns=Math.min(8,Math.max(1,scale0*(d/(dist0||1))));lbImg.dataset.scale=ns;lbImg.style.transform='translate('+(lbImg.dataset.tx||0)+'px,'+(lbImg.dataset.ty||0)+'px) scale('+ns+')';e.preventDefault()}" +
      "},{passive:false});" +
      "var lastTap=0;lbImg.addEventListener('click',function(){" +
        "var now=Date.now();if(now-lastTap<300){var ns=parseFloat(lbImg.dataset.scale||1)>1.25?1:2.2;lbImg.dataset.scale=ns;lbImg.style.transform='translate(0,0) scale('+ns+')';if(ns>1){var t=document.getElementById('lbTip');t.textContent='双击恢复 · 拖动可平移'}else{var t2=document.getElementById('lbTip');t2.textContent='双击放大 · 双指捏合缩放 · 长按可保存'}}lastTap=0}else{lastTap=now;setTimeout(function(){lastTap=0},300)}" +
      "});" +
      "lbImg.addEventListener('load',function(){lbShow()});" +
      // 详情页主图点击 进入灯箱
      "function openLB(){var im=document.getElementById('lbImg');im.src='" + ORIG_URL + "';}" +
      "</scr" + "ipt>";
    const TAIL = "</div>" + LB_HTML + "</body></html>";
    if (!file) return HEAD + "<div class='empty'>缺少记录参数</div>" + TAIL;
    let ev = null;
    try { ev = loadEventsArr().find(function (e) { return e.file === file; }); } catch (e) {}
    if (!ev) return HEAD + "<div class='empty'>未找到该监控记录<br><br>可能是较早的记录，或图片已被清理</div>" + TAIL;
    const tagCls = ev.person ? 'person' : 'nobody';
    const aiText = (ev.ai && ev.ai !== '(点击AI分析)') ? ev.ai : '（暂无 AI 分析结论，可回到看板点击「AI分析」补充）';
    const inner =
      "<h1>📷 现场分析</h1>" +
      "<div class='sub'>" + esc(ev.name) + "</div>" +
      "<span class='tag " + tagCls + "'>" + (ev.person ? '有人' : '无人') + "</span>" +
      // 主图改为可点击放大
      "<div class='imgbox' onclick='openLB()'>" +
        "<img id='mainImg' src='" + ORIG_URL + "' alt='现场照片' loading='eager'>" +
      "</div>" +
      "<div class='hint'>☝️ 点图片放大 · 双击放大 · 双指捏合缩放 · 长按可保存原图</div>" +
      "<div class='meta'><b>时间：</b>" + esc(ev.time) + "<br><b>设备：</b>" + esc(ev.name) + (ev.provider ? ("<br><b>分析模型：</b>" + esc(ev.provider)) : '') + "</div>" +
      "<div class='ai'><h2>🤖 AI 分析结论</h2><div class='body'>" + esc(aiText) + "</div></div>";
    return HEAD + inner + TAIL;
  }

  if (req.method === 'GET' && u.pathname === '/detail') {
    const file = u.searchParams.get('file') || '';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buildDetailHtml(file));
    return;
  }

  if (req.method === 'GET' && u.pathname === '/today') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(TODAY_PAGE_HTML);
    return;
  }
  // 云台控制(直播页方向盘): 仅 config 里 ptz:true 的设备(云台机), 短促转动800ms后自动停
  if (req.method === "GET" && u.pathname === "/api/ptz") {
    const serial = u.searchParams.get("serial") || "";
    const dir = String(u.searchParams.get("dir") || "");
    const devObj = (cfg.devices || []).find(function (d) { return d.serial === serial; });
    const dirMap = { up: 0, down: 1, left: 2, right: 3 };
    const fail = function (msg) { res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify({ err: msg })); };
    if (!devObj || devObj.watch === false) return fail("设备不存在");
    if (!devObj.ptz) return fail("该设备不是云台机，无法转动");
    if (dirMap[dir] === undefined) return fail("方向参数: up/down/left/right");
    const now = Date.now();
    if (now - (_ptzLast[serial] || 0) < 1000) return fail("操作太频繁，稍等1秒");
    _ptzLast[serial] = now;
    (async function () {
      try {
        const r = await client.ptzStart(serial, dirMap[dir]);
        if (String(r.code) !== "200") throw new Error("code=" + r.code + " " + (r.msg || ""));
        setTimeout(function () {
          client.ptzStop(serial).catch(function (e3) {
            console.log("[云台] " + devObj.name + " 停止指令失败(设备可能持续转动!): " + e3.message.slice(0, 80));
          });
        }, 800);
        console.log("[" + new Date().toLocaleTimeString() + "] [云台] " + devObj.name + " " + dir);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e2) {
        console.log("[云台] " + devObj.name + " 转动失败: " + e2.message.slice(0, 100));
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ err: "转动失败: " + e2.message.slice(0, 80) }));
      }
    })();
    return;
  }
  if (req.method === "GET" && u.pathname === "/api/live-url") {
    const serial = u.searchParams.get("serial") || "";
    const okDev = (cfg.devices || []).some(function (d) { return d.watch && d.serial === serial; });
    if (!okDev) { res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ err: "设备不存在" })); return; }
    const ptzFlag = !!(((cfg.devices || []).find(function (d) { return d.serial === serial; }) || {}).ptz); // 云台机才在直播页显示方向盘
    // H264可被手机微信直接播放; 仅H265时多数手机微信放不了, /live页会引导"在浏览器打开"
    async function h264Available() {
      const c = _h264Probe[serial];
      if (c && Date.now() - c.at < 600e3) return !c.h265Only;
      let h265Only = true;
      try {
        const r0 = await client.liveAddress(serial, { protocol: 2, supportH265: 0 });
        const u0 = r0 && r0.data && r0.data.url;
        if (u0) {
          const pl0 = await (await fetch(u0, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(6000) })).text();
          h265Only = pl0.indexOf("/ErrCode/") >= 0;
        }
      } catch (e0) { /* 探测失败按仅H265处理 */ }
      _h264Probe[serial] = { h265Only: h265Only, at: Date.now() };
      console.log("[直播] " + serial + " H264探测: " + (h265Only ? "不支持(仅H265)" : "支持") + "，结果缓存10分钟");
      return !h265Only;
    }
    (async function () {
      try {
        const want264 = await h264Available();
        // v2接口取流: 有H264优先H264(微信能直接播); 否则H265+fMP4(前端EZUIKit软解)
        const r = await client.liveAddress(serial, { protocol: 2, supportH265: want264 ? 0 : 1 });
        const url = r && r.data && r.data.url;
        if (!url) throw new Error(JSON.stringify(r).slice(0, 120));
        // 校验清单是否为错误占位流(设备离线时平台返回ErrCode图片流而非真实画面)
        let pl = "";
        try { pl = await (await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) })).text(); } catch (ePl) {}
        if (pl.indexOf("/ErrCode/") >= 0) {
          console.log("[直播] " + serial + " 平台返回ErrCode占位流(设备可能离线或编码受限)");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ err: "摄像头暂时出不了画面：请检查它是否在线/正常供电；若多次出现请到萤石APP查看该设备的编码与状态" }));
          return;
        }
        console.log("[" + new Date().toLocaleTimeString() + "] [直播] 下发HLS(" + (want264 ? "H264" : "H265") + ")地址 " + serial);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ url: url, h265Only: !want264, ptz: ptzFlag }));
      } catch (e2) {
        // API失败回退到萤石云后台生成的固定地址(config.liveUrls, 为H265流)
        const manual = (cfg.liveUrls || {})[serial];
        if (manual) {
          console.log("[" + new Date().toLocaleTimeString() + "] [直播] API失败, 回退后台固定地址 " + serial);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ url: manual, h265Only: true, ptz: ptzFlag }));
          return;
        }
        console.log("[直播] 获取地址失败 " + serial + ": " + e2.message.slice(0, 110));
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ err: e2.message.slice(0, 120) }));
      }
    })();
    return;
  }
  // EZUIKit-HLS播放器静态资源(含H265软解wasm, 不依赖浏览器解码能力)
  if (req.method === "GET" && u.pathname.indexOf("/ezui/") === 0) {
    const fn = decodeURIComponent(u.pathname.slice("/ezui/".length));
    if (!fn || fn.indexOf("..") >= 0 || !/^[A-Za-z0-9_\/.-]+$/.test(fn)) { res.writeHead(403); res.end(""); return; }
    const fp = path.join(ROOT, "public", "ezuikit", fn);
    const mime = ({ ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".html": "text/html" })[path.extname(fn).toLowerCase()] || "application/octet-stream";
    fs.readFile(fp, function (err2, buf2) {
      if (err2) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { "Content-Type": mime });
      res.end(buf2);
    });
    return;
  }
  // 历史抓图静态访问（供推送详情链接打开现场照片）
  if (req.method === "GET" && u.pathname.indexOf("/captures/") === 0) {
    const fn = decodeURIComponent(u.pathname.slice("/captures/".length));
    // 缩略图路由: /captures/thumb/文件名 — 先于正则校验处理(含/字符)
    if (fn.startsWith("thumb/")) {
      const origFn = decodeURIComponent(fn.slice(6)); // remove "thumb/"
      if (!/^[A-Za-z0-9_.-]+\.jpe?g$/i.test(origFn)) { res.writeHead(403); res.end(""); return; }
      const origPath = path.join(ROOT, "captures", origFn);
      if (!fs.existsSync(origPath)) { res.writeHead(404); res.end("not found"); return; }
      // 生成缩略图文件名
      const hash = crypto.createHash("md5").update(origFn + "_w600").digest("hex").slice(0, 12);
      const thumbName = "thumb_" + hash + ".jpg";
      const thumbPath = path.join(ROOT, "captures", thumbName);
      // 已有缩略图直接输出
      if (fs.existsSync(thumbPath)) {
        res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=604800, immutable" });
        res.end(fs.readFileSync(thumbPath));
        return;
      }
      // jimp 缩放 (jimp 1.x API)
      (async function() {
        try {
          const { Jimp } = require("jimp");
          const buf = fs.readFileSync(origPath);
          const img = await Jimp.read(buf);
          const w = 600;
          const h = Math.round(600 * (img.bitmap.height / img.bitmap.width));
          const resized = await img.cover({ w: w, h: h });
          const thumbBuf = await resized.getBuffer("image/jpeg");
          fs.writeFileSync(thumbPath, thumbBuf);
          res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=604800, immutable" });
          res.end(thumbBuf);
        } catch (e) {
          console.log("[缩略图] 缩放失败 " + origFn + ": " + e.message.slice(0, 80));
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ err: e.message }));
        }
      })();
      return;
    }
    // 移动侦测暂存图: captures/motion/ 子目录(见分级留存)。只短期存在, 供"萤石推送记录"页关联展示
    if (fn.startsWith("motion/")) {
      const mfn = decodeURIComponent(fn.slice("motion/".length));
      if (!/^[A-Za-z0-9_.-]+\.jpe?g$/i.test(mfn)) { res.writeHead(403); res.end(""); return; }
      fs.readFile(path.join(MOTION_DIR, mfn), function (err, buf) {
        if (err) { res.writeHead(404); res.end("not found"); return; }
        res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=600" });
        res.end(buf);
      });
      return;
    }
    // 原图
    if (!/^[A-Za-z0-9_.-]+\.jpe?g$/i.test(fn)) { res.writeHead(403); res.end(""); return; }
    fs.readFile(path.join(ROOT, "captures", fn), function (err, buf) {
      if (err) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=604800, immutable" });
      res.end(buf);
    });
    return;
  }
  if (req.method === "GET") {
    const q = Object.fromEntries(u.searchParams.entries());
    if (q.signature && checkSignature(q)) {
      res.end(q.echostr || "");
      console.log("[" + new Date().toLocaleTimeString() + "] 微信服务器校验通过 ✓");
    } else {
      res.end("aicam kanjia service running");
    }
    return;
  }
  if (req.method === "POST") {
    let body = "";
    req.on("data", function (c) { body += c; });
    req.on("end", async function () {
      const t0 = Date.now();
      try {
        const q = Object.fromEntries(u.searchParams.entries());
        if (!checkSignature(q)) { res.end(""); return; }
        const msgType = xmlVal(body, "MsgType");
        const fromUser = xmlVal(body, "FromUserName");
        const toUser = xmlVal(body, "ToUserName");
        let text = xmlVal(body, "Content");
        // 分组上下文(供下方文本指令分支用): 同事组仅状态 / 双溪村组按村裁剪
        const gUser = groupOf(fromUser);
        const isColleague = gUser && (gUser.query || "all") === "status";
        const village4user = villageScopeOf(fromUser);

        if (msgType === "event") {
          const ev = xmlVal(body, "Event");
          if (ev === "subscribe") {
            refreshFollowers(true).catch(function () {});
            res.end(replyText(fromUser, toUser, "欢迎关注！发送【看家】获取老家摄像头最新画面，发送【门口】看前门。\n🔍 查监控可发「查询双溪村10点左右的监控」，发【历史】回看历史记录+日报。"));
            return;
          }
          if (ev === "CLICK") {
            const k = String(xmlVal(body, "EventKey"));
            // ---- 分组权限拦截: 同事组仅状态; 双溪村组屏蔽木山村/离线设备按钮(微信菜单全局不可分, 故点击时拦) ----
            const blocked = menuGuard(fromUser, k);
            if (blocked) {
              console.log("[" + new Date().toLocaleTimeString() + "] [权限] 拦截菜单 " + k + " -> " + fromUser.slice(0, 10) + " (组:" + ((groupOf(fromUser) || {}).key || "默认") + ")");
              res.end(replyText(fromUser, toUser, blocked));
              return;
            }
            const grpVillage = villageScopeOf(fromUser); // 双溪村组->"双溪村", 默认/同事->null
            if (k === "kanjia") text = "看家";
            else if (k === "menkou" || k === "door") text = "门口";
            else if (k === "today") {
              const devs4 = (cfg.devices || []).filter(function (d) { return d.watch && (!grpVillage || deviceVillage(d.serial) === grpVillage); });
              const devNames = devs4.map(function (d) { return d.name; }).join("、");
              console.log("[" + new Date().toLocaleTimeString() + "] [菜单] 今天是否有人活动");
              res.end(replyText(fromUser, toUser, "🔍 正在查询 " + devNames + " 今天的报警记录，结果马上发你..."));
              sendDigestCustom(fromUser, null, grpVillage).catch(function () {});
              return;
            }
            else if (k === "today_bk" || k === "today_bg" || k === "today_c6") {
              const serialMapT = { today_bk: "BK2385850", today_bg: "BG6569629", today_c6: "D24049607" };
              const dvT = (cfg.devices || []).find(function (d) { return d.serial === serialMapT[k]; });
              console.log("[" + new Date().toLocaleTimeString() + "] [菜单] 今日有人(单设备) " + k);
              res.end(replyText(fromUser, toUser, "🔍 正在查询 " + (dvT ? dvT.name : "") + " 今天的报警记录，结果马上发你..."));
              sendDigestCustom(fromUser, serialMapT[k]).catch(function () {});
              return;
            }
            else if (k === "status") { res.end(await buildStatusReply(fromUser, toUser)); console.log("[" + new Date().toLocaleTimeString() + "] [菜单] 状态"); return; }
            else if (k === "shot_bk" || k === "shot_bg" || k === "shot_c6") {
              const serialMap = { shot_bk: "BK2385850", shot_bg: "BG6569629", shot_c6: "D24049607" };
              const dv = (cfg.devices || []).find(function (d) { return d.serial === serialMap[k]; });
              if (dv && dv.watch !== false) {
                console.log("[" + new Date().toLocaleTimeString() + "] [菜单] 单设备画面 " + dv.name);
                res.end(await handleKanJia(dv, fromUser, toUser));
                return;
              }
              text = "看家";
            }
            else if (k === "shot_all") {
              const allRep = buildShotAllReply(fromUser, toUser, grpVillage);
              if (allRep) { console.log("[" + new Date().toLocaleTimeString() + "] [菜单] 全部画面(原生图片)"); res.end(allRep); return; }
              text = "看家"; // 回退: 无缓存图时走第一台实时抓图
            }
            else if (k === "live_bk" || k === "live_bg" || k === "live_c6") {
              const serialMapL = { live_bk: "BK2385850", live_bg: "BG6569629", live_c6: "D24049607" };
              console.log("[" + new Date().toLocaleTimeString() + "] [菜单] 看直播 " + k);
              // 同时按组所在村过滤(双保险): 即使拦截名单漏配, 分组成员也拿不到外村直播链接
              res.end(buildLiveReply(fromUser, toUser, serialMapL[k], grpVillage));
              return;
            }
            else if (k === "history") {
              console.log("[" + new Date().toLocaleTimeString() + "] [菜单] 历史记录");
              res.end(buildHistoryEntryReply(fromUser, toUser, grpVillage)); // 图文卡片跳/history页(分组成员自动带村过滤)
              return;
            }
          }
        }

        // 【今日有人】主动查询全部设备并汇总
        if (msgType === "text" && /今日.*是否有人|今天.*是否有人|今日有人|今天有人|今日情况/.test(text)) {
          if (isColleague) {
            res.end(replyText(fromUser, toUser, "🚫 您当前账号仅可查看设备状态，暂无查询权限。"));
            return;
          }
          const devNames = (cfg.devices || []).filter(function (d) { return d.watch && (!village4user || deviceVillage(d.serial) === village4user); }).map(function (d) { return d.name; }).join("、");
          res.end(replyText(fromUser, toUser, "🔍 正在查询 " + devNames + " 今天的报警记录，结果马上发你..."));
          console.log("[" + new Date().toLocaleTimeString() + "] 「今日有人」主动查询已触发");
          sendDigestCustom(fromUser, null, village4user).catch(function () {});
          return;
        }

        // 【直播】监控直播链接
        if (msgType === "text" && /直播|看监控/.test(text)) {
          if (isColleague) {
            res.end(replyText(fromUser, toUser, "🚫 您当前账号仅可查看设备状态，暂无直播/查询权限。"));
            return;
          }
          res.end(buildLiveReply(fromUser, toUser, null, village4user));
          console.log("[" + new Date().toLocaleTimeString() + "] 「直播」直播链接已回复");
          return;
        }

        // 【历史】历史记录页入口(有人记录+历史日报)
        if (msgType === "text" && /^(历史|历史记录|历史日报|查历史|历史查询)/.test(String(text).trim())) {
          if (isColleague) {
            res.end(replyText(fromUser, toUser, "🚫 您当前账号仅可查看设备状态，暂无查询权限。"));
            return;
          }
          console.log("[" + new Date().toLocaleTimeString() + "] 「历史」历史记录页已回复");
          res.end(buildHistoryEntryReply(fromUser, toUser, village4user));
          return;
        }

        // 【历史查询】如「查询双溪村10点左右的监控」: 该时段报警截图+AI结论(不筛是否有人)
        if (msgType === "text") {
          const pq = parseHistoryQuery(text);
          if (pq) {
            if (isColleague) {
              res.end(replyText(fromUser, toUser, "🚫 您当前账号仅可查看设备状态，暂无查询权限。"));
              return;
            }
            if (pq.village && village4user && pq.village !== village4user) {
              res.end(replyText(fromUser, toUser, "🚫 您只能查询「" + village4user + "」的记录。"));
              return;
            }
            console.log("[" + new Date().toLocaleTimeString() + "] 「历史查询」" + pq.label + (pq.village ? " " + pq.village : "") + " <- " + text);
            res.end(replyText(fromUser, toUser, dear(fromUser) + "🔍 正在查询 " + (pq.village ? pq.village + " " : "") + pq.label + " 的报警记录（截图+AI分析），结果马上发你..."));
            sendHistoryQueryResult(fromUser, pq).catch(function () {});
            return;
          }
        }

        const hit = (WX.commands || []).some(function (c) {
          return (c.keywords || []).some(function (k) { return text.indexOf(k) >= 0; });
        });

        if ((msgType === "text" || text) && hit) {
          if (!WX.appId || !WX.appSecret) {
            res.end(replyText(fromUser, toUser, "服务尚未配置完成（缺 appId/appSecret），请联系管理员"));
            return;
          }
          const dev = pickDevice(text);
          if (!dev) { res.end(replyText(fromUser, toUser, "没有可用的摄像头")); return; }
          console.log("[" + new Date().toLocaleTimeString() + "] 「" + text + "」-> " + dev.name);
          const xml = await handleKanJia(dev, fromUser, toUser);
          res.end(xml);
          console.log("  已回复现场照片 (" + (Date.now() - t0) + "ms)");
          return;
        }

        if (msgType === "text") {
          res.end(replyText(fromUser, toUser, "回复【看家】获取老家摄像头最新画面，【门口】看前门。\n🔍 查监控: 发「查询双溪村10点左右的监控」\n📜 发【历史】看历史有人记录+历史日报。"));
          return;
        }
        res.end("");
      } catch (e) {
        console.log("处理出错:", e.message.slice(0, 150));
        try { res.end(replyText(xmlVal(body, "FromUserName"), xmlVal(body, "ToUserName"), "看家失败了(" + e.message.slice(0, 60) + ")，稍后再试")); } catch (e2) { try { res.end(""); } catch (e3) {} }
      }
    });
    return;
  }
  res.end("");
});

let currentServer = null;
function startServer(retry) {
  currentServer = server;
  currentServer.once("error", function(err) {
    if (err.code === "EADDRINUSE" && retry) {
      console.log("[启动] 端口 " + PORT + " 被占用，尝试接管后重试...");
      (async function() {
        try { await shutdownOldInstance(); } catch (e) {}
        setTimeout(function(){ startServer(false); }, 500);
      })();
    } else { console.error("[启动失败]", err.message); process.exit(1); }
  });
  currentServer.listen(PORT, function () {
    const nets = os.networkInterfaces();
    let ip = "127.0.0.1";
    for (const k in nets) {
      for (const n of nets[k] || []) {
        if (n.family === "IPv4" && !n.internal) ip = n.address;
      }
    }
    console.log("=== 公众号看家+萤石推送服务已启动 v" + VERSION + " (PID " + process.pid + ") ===");
    console.log("本地地址: http://" + ip + ":" + PORT + "/health");
    console.log("萤石推送回调地址填: https://<你的隧道域名>/ezviz/push");
    console.log("下一步: 启动内网穿透指向该端口, 再到公众号后台「服务器配置」填入公网地址");
    console.log("  URL  = 穿透给的公网https地址");
    console.log("  Token = " + (WX.token ? ("<已配置 " + String(WX.token).length + " 字符，已脱敏不打印>") : "(config.json wxServer.token 未设置)"));
    console.log("  消息加解密方式 = 明文模式");
  });
}
cleanupStaleInstance().then(function() {
  startServer(true);
  // 启动即拉取关注者昵称(专属称呼用), 之后每小时刷新
  refreshFollowers().catch(function () {});
  setInterval(function () { refreshFollowers().catch(function () {}); }, 3600e3);
  // 抓图分级清理: 主目录按天(默认60天), motion 目录按小时(默认3小时) —— 所以每小时跑一次。
  // (原来是每天一次; motion 图按小时回收的话会被拖到最长 27 小时才删)
  setTimeout(cleanupCaptures, 60e3);
  setInterval(cleanupCaptures, 3600e3);
});

// ---------- 抓图分级清理 ----------
// captures/         事件图 + thumb_*.jpg 缩略图(平铺文件), 按 storage.captureRetentionDays(默认60天=2个月)
// captures/motion/  移动侦测临时素材, 按 storage.motionRetentionHours(默认3小时) 快速回收
// events.json 自身有 storage.eventRetention 条数上限, 不在这里处理。
function sweepCaptureDir(dir, cutoff, label) {
  let removed = 0, freed = 0;
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return; } // motion 目录还没产生过: 静默跳过
  for (const name of names) {
    const f = path.join(dir, name);
    let st;
    try { st = fs.statSync(f); } catch (e) { continue; } // 竞争中被删/被占用: 跳过本轮
    if (!st.isFile()) continue;                          // 子目录(motion/)不在这里处理
    if (st.mtimeMs >= cutoff) continue;
    try { fs.unlinkSync(f); removed++; freed += st.size; } catch (e2) {}
  }
  if (removed) console.log("[" + new Date().toLocaleTimeString() + "] [清理] " + label + ": 删除 " + removed + " 个, 释放 " + (freed / 1048576).toFixed(1) + " MB");
}

function cleanupCaptures() {
  const days = Number((cfg.storage && cfg.storage.captureRetentionDays) || 60);
  const hours = Number((cfg.storage && cfg.storage.motionRetentionHours) || 3);
  if (days > 0) sweepCaptureDir(CAPTURE_DIR, Date.now() - days * 86400e3, "事件图(超过 " + days + " 天)");
  if (hours > 0) sweepCaptureDir(MOTION_DIR, Date.now() - hours * 3600e3, "移动侦测暂存(超过 " + hours + " 小时)");
}

process.on("SIGINT", function() {
  console.log("\n正在关闭...");
  removePidIfMine();
  try { if (currentServer) currentServer.close(); } catch (e) {}
  setTimeout(function() { process.exit(0); }, 800);
});
