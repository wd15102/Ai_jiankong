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

const ROOT = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const WX = cfg.wxServer || {};
const PORT = WX.port || 8787;
const VERSION = "2026-08-27.30"; // +图片加速:萤石CDN原图优先(picEz)+隧道兜底(onerror切pic)+/captures强缓存7天immutable+加载占位 // 图文卡片(news)推送+今日无数据回退昨日; token限流自动重试2s // 今日活动/today时间线页+微信推链接; 照片md5去重; H265-fMP4直播; 验签宽松; token自愈
const PID_FILE = path.join(ROOT, "data", "webhook.pid");
const client = createClient(cfg);

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
  const dir = path.join(ROOT, "captures");
  let best = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.indexOf(serial) !== 0 || f.slice(-4).toLowerCase() !== ".jpg") continue;
      const p = path.join(dir, f);
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
const ALARM_TYPE_NAMES = { 10002: "移动侦测", 15504: "人形检测", 15505: "区域入侵", SmartHumanDet: "人形检测", intelligentDetection: "智能侦测" };

function logPush(entry) {
  try {
    fs.mkdirSync(path.dirname(PUSH_LOG), { recursive: true });
    let arr = [];
    try { arr = JSON.parse(fs.readFileSync(PUSH_LOG, "utf8")); if (!Array.isArray(arr)) arr = []; } catch (e) {}
    arr.push(entry);
    fs.writeFileSync(PUSH_LOG, JSON.stringify(arr.slice(-200), null, 1));
  } catch (e) {}
}
function loadEventsArr() {
  const f = path.join(ROOT, "data", "events.json");
  try { const a = JSON.parse(fs.readFileSync(f, "utf8")); return Array.isArray(a) ? a : []; }
  catch (e) {
    // 解析失败(常见于并发写被打断): 把损坏文件留档再返回空, 避免静默丢失全部历史
    try { if (fs.existsSync(f) && fs.statSync(f).size > 0) fs.copyFileSync(f, f + ".corrupt." + Date.now()); } catch (e2) {}
    return [];
  }
}
function saveEventsArr(arr) {
  if (arr.length > 500) arr = arr.slice(-500);
  fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
  const f = path.join(ROOT, "data", "events.json");
  const content = JSON.stringify(arr, null, 1);
  // 先写临时文件再改名: 读方要么看到完整旧文件要么完整新文件, 不会读到写了一半的内容
  try {
    fs.writeFileSync(f + ".tmp", content);
    try { fs.renameSync(f + ".tmp", f); }
    catch (e) { fs.writeFileSync(f, content); fs.unlinkSync(f + ".tmp"); } // 改名被占用(Windows并发读)时退回直写
  } catch (e2) { console.log("[事件] events.json 写入失败: " + e2.message.slice(0, 80)); }
}
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
  const cands = [
    crypto.createHash("md5").update(P.secret + bodyRaw).digest("hex"),
    crypto.createHash("md5").update(bodyRaw + P.secret).digest("hex"),
    crypto.createHmac("sha256", P.secret).update(bodyRaw).digest("hex"),
    crypto.createHash("sha256").update(P.secret + bodyRaw).digest("hex")
  ].map(function(s){ return s.toLowerCase(); });
  return cands.indexOf(got.toLowerCase()) >= 0;
}
async function handleEzvizPush(bodyRaw, headers) {
  const t = Date.now();
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
  var isAiNotice = /AI|agent|智能体/i.test(String(typeCode)) || /算法结果/.test(raw.slice(0,300));
  var personByText = /【有人】|检测到人|人形|男子|女子|老人|小孩|人员/.test(textMsg);
  // 只落两类：人形类告警、AI算法结果；普通移动侦测只记日志不进看板
  if (!isPersonType && !isAiNotice && !personByText) {
    // 仍然下载保存图片，但不同步到看板
    if (serial && picUrl) {
      var _fname = "";
      try {
        _fname = serial + "_p" + (ts || Date.now()) + ".jpg";
        await client.downloadTo(picUrl, path.join(ROOT, "captures", _fname));
        console.log("[萤石推送] 移动侦测图片已保存(不进看板): " + _fname);
      } catch (e) { console.log("[萤石推送] 移动侦测图片保存失败: " + e.message); }
    }
    return;
  }
  if (serial) {
    var evts = loadEventsArr();
    var dupKey = serial + "@" + (ts || 0);
    if (evts.some(function(e){ return e.serial + "@" + e.ts === dupKey; })) { console.log("[萤石推送] 重复消息跳过 " + dupKey); return; }
    // 图片：优先报警自带截图，失败现场抓图兜底
    var fname = "";
    if (picUrl) {
      fname = serial + "_p" + (ts || Date.now()) + ".jpg";
      try { await client.downloadTo(picUrl, path.join(ROOT, "captures", fname)); }
      catch (e) { console.log("[萤石推送] 截图下载失败: " + e.message); fname = ""; }
    }
    if (!fname) {
      try {
        const r = await client.capture(serial);
        if (r.code === "200") {
          const d = r.data;
          const url = Array.isArray(d) ? d[0].picUrl : d.picUrl;
          fname = serial + "_" + Date.now() + ".jpg";
          await client.downloadTo(url, path.join(ROOT, "captures", fname));
        }
      } catch (e2) { console.log("[萤石推送] 兜底抓图失败: " + e2.message); }
    }
    var alarmTime = ts ? new Date(ts).toLocaleString("zh-CN",{hour12:false}) : new Date().toLocaleString("zh-CN",{hour12:false});
    var devName = ((cfg.devices||[]).find(function(x){ return x.serial===serial; })||{}).name || serial;
    evts.push({ ts: ts || Date.now(), time: alarmTime, serial: serial, name: devName, file: fname,
      title: typeName || (isAiNotice ? "AI识别" : "告警"), provider: isAiNotice ? "萤石AI" : "",
      ai: textMsg || "(点击AI分析)", person: Boolean(isPersonType || personByText), abnormal: false, pushed: false,
      ezvizPic: picUrl || "" });
    saveEventsArr(evts);
    console.log("[萤石推送] 已记录: " + devName + " " + alarmTime + " " + (typeName || "AI结果"));
    // 自动AI判读后推送到家人微信（测试号模板消息）
    const pubBase = String(((cfg.wxTest || {}).publicBase) || "").replace(/\/$/, "");
    let aiTxt = "";
    if (fname && (cfg.ai || {}).enabled && (cfg.ai || {}).autoAnalyze !== false) {
      try { aiTxt = await analyzeAndStore(fname); } catch (eAi) { console.log("[AI] 自动判读失败: " + eAi.message); }
    }
    // 无人判定: 兼容【无人】(默认prompt)和行首"无人"(config自定义prompt不带括号), 否则无人事件也会被标成"有人员活动"误推
    const noPerson = /【无人】/.test(aiTxt) || /^\s*无人/.test(String(aiTxt).trim());
    // 语义化标题: 含设备名, 去掉"⚠️老家"等冗余前缀; 称呼(亲爱的东哥等)由 dear() 在发送时自动加在 first 前
    let firstLine;
    if (aiTxt) {
      firstLine = noPerson ? ("检测到" + devName + "画面变化（AI判定无人）") : ("检测到" + devName + "有人员活动");
    } else if (isPersonType || personByText) {
      firstLine = "检测到" + devName + "有人员活动";
    } else {
      firstLine = "检测到" + devName + "有移动侦测";
    }
    pushTestTemplate(
      firstLine,
      alarmTime,
      devName,
      "点击查看详情，查看 AI 现场分析结论 👉",
      fname ? (pubBase + "/detail?file=" + encodeURIComponent(fname)) : (picUrl || ""),
      false,
      { serial: serial }  // 按设备所属村过滤推送对象(双溪村组只收双溪村/同事组不收)
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
      if (txt) return String(txt).trim();
      console.log("[AI]", p.name, "响应异常:", JSON.stringify(j).slice(0, 120));
    } catch (e) {
      console.log("[AI]", p.name, "调用失败:", e.message.slice(0, 80));
    }
  }
  return "";
}
async function analyzeAndStore(file) {
  if (!file) return "";
  const absPath = path.isAbsolute(file) ? file : path.join(ROOT, "captures", file);
  const baseName = path.basename(absPath);
  if (_aiFlight[baseName]) return "";
  _aiFlight[baseName] = true;
  try {
    const txt = await analyzeImageAI(absPath);
    if (txt) {
      const evts = loadEventsArr();
      const rec = evts.find(function (e) { return e.file === baseName || e.file === file; });
      if (rec) { rec.ai = txt; rec.person = /有人/.test(String(txt)); saveEventsArr(evts); }
    }
    return txt;
  } finally { delete _aiFlight[baseName]; }
}

// 看家（手动抓图）写一条 events.json 占位记录，让 /detail?file=xxx 能查到
// 已有同 file 记录则跳过（幂等）；带 source:"kanjia" 标记，方便按场景过滤
function recordKanjiaCapture(file, dev) {
  try {
    if (!file || !dev) return;
    const baseName = path.basename(String(file));
    const evts = loadEventsArr();
    if (evts.some(function (e) { return e.file === baseName; })) return;
    const ts = Date.now();
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
    saveEventsArr(evts);
  } catch (e) { console.log("[看家] 写events占位失败: " + e.message.slice(0, 80)); }
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
// 每个微信(openid) 2小时内最多推送1次（报警类）：窗口内只记录不推送，2h后首条人物推送才发出
const PUSH_THROTTLE_MS = 2 * 3600e3;
let _throttleCache = null;
function loadThrottle() {
  if (_throttleCache) return _throttleCache;
  try { _throttleCache = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "push_throttle.json"), "utf8")); }
  catch (e) { _throttleCache = {}; }
  return _throttleCache;
}
function saveThrottle(map) { try { fs.writeFileSync(path.join(ROOT, "data", "push_throttle.json"), JSON.stringify(map)); } catch (e) {} }
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
      // 2小时内已推过该微信：本窗口内的新报警仅记录不推送，避免轰炸
      if (throttle && (now - (throttle[oid] || 0)) < PUSH_THROTTLE_MS) { skipped++; continue; }
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
          if (rj.errcode === 0) { ok++; if (throttle) { throttle[oid] = now; } break; }
          errs.push(oid.slice(0, 8) + ":" + rj.errcode);
          console.log("[测试号推送] 失败 openid=" + oid.slice(0, 8) + "... err=" + rj.errcode + " " + rj.errmsg);
          if (att === 0 && isTokErr(rj.errcode)) { try { await new Promise(function(r){setTimeout(r,2000)}); token = await wxTestToken(true); continue; } catch (e2) { break; } }
          break;
        } catch (e) { errs.push(oid.slice(0, 8) + ":EXC"); break; }
      }
    }
    if (openids.length) console.log("[测试号推送] 已推送 " + ok + "/" + openids.length + " 位关注者" + (skipped ? "，限频跳过 " + skipped + " 位(2h窗口内)" : "") + (scoped ? "，分组过滤 " + scoped + " 位" : ""));
    auditPush(serialScope, ok, attempted, skipped, scoped, errs);
    if (throttle) saveThrottle(throttle);
    // 该设备本应送达却一个都没成功(网络/token抖动)：60秒后自动重试一次(仍受2h节流约束,重试本身不再递归)
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
    const hasPerson = txt.indexOf("有人") >= 0;
    const pub = (cfg.wxTest || {}).publicBase || "";
    const fname = path.basename(String(file || ""));
    const picUrl = pub && fname ? pub + "/captures/" + encodeURIComponent(fname) : "";
    const cardTitle = dear(openid) + (hasPerson ? "检测到" + devName + "有人员活动" : (txt.indexOf("无人") >= 0 ? devName + " 暂时未发现人员" : "检测到" + devName + "画面有变化"));
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
      const evts = loadEventsArr();
      let added = 0;
      for (const a of r.data) {
        const typeCode = String(pickStr(a, ["alarmType", "type", "eventType"]) || "");
        if (typeCode.indexOf("155") !== 0) continue; // 只补录人形类
        const tsRaw = Number(pickStr(a, ["alarmTime", "time", "timestamp"]) || 0);
        const ts = tsRaw < 1e12 ? tsRaw * 1000 : tsRaw;
        if (!ts || ts < midnight) continue;
        const key = dev.serial + "@" + ts;
        if (evts.some(function (e) { return e.serial + "@" + e.ts === key; })) continue;
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
        evts.push({
          ts: ts,
          time: new Date(ts).toLocaleString("zh-CN", { hour12: false }),
          serial: dev.serial,
          name: dev.name || dev.serial,
          file: fname,
          title: ALARM_TYPE_NAMES[Number(typeCode)] || "人形检测",
          provider: "", ai: "", person: true, abnormal: false, pushed: false,
          ezvizPic: picUrl || ""
        });
        added++;
      }
      if (added) {
        saveEventsArr(evts);
        console.log("[" + new Date().toLocaleTimeString() + "] [今日查询] " + dev.name + " 补录 " + added + " 条");
      }
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
        recordKanjiaCapture(f2, dev); // 写占位记录, /detail?file=... 才能查到
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
  recordKanjiaCapture(file, dev); // 写占位记录, /detail?file=... 才能查到
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
            res.end(replyText(fromUser, toUser, "欢迎关注！发送【看家】获取老家摄像头最新画面，发送【门口】看前门。"));
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
          res.end(replyText(fromUser, toUser, "回复【看家】获取老家摄像头最新画面，【门口】看前门。"));
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
});

process.on("SIGINT", function() {
  console.log("\n正在关闭...");
  removePidIfMine();
  try { if (currentServer) currentServer.close(); } catch (e) {}
  setTimeout(function() { process.exit(0); }, 800);
});
