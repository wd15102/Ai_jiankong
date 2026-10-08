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
const { analyzeImage } = require("./lib/ai"); // AI 判读: 复用 lib/ai.js(含大图压缩+冷却+故障切换)
const motiondetect = require("./lib/motiondetect"); // 本地补充人形检测(自写算法, 零 API 消耗)
const store = require("./lib/store"); // events.json 跨进程事务存储(与 monitor/webapp 共用同一把锁)
const hdcapture = require("./lib/hdcapture"); // 高清抓图: 主码流截帧, 失败回落原抓图接口

const ROOT = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const WX = cfg.wxServer || {};
const PORT = WX.port || 8787;
const VERSION = "2026-10-07.53"; // +PeopleDetectionEvent接入人形链路 +无图人形事件60秒补拍→AI→判定推送(不再盲推无图无结论)
// 变更历史 2026-10-07.53: +设备端人形检测第三种上报格式 PeopleDetectionEvent(ys.iot/domain=HumanBodyDetection)归一为SmartHumanDet进人形链路(payload恒为"null",事件即信号; 之前完全未处理,9月每天32~55条全浪费) +无图人形事件不盲推: 改走60秒后补拍→图回写→补跑AI→判有人/读不懂才带图推送,AI判无人只记录,补拍也失败按旧行为无图放行(修10-07 12:56无图无结论盲推)
// 变更历史 2026-09-30.51: +车辆复核AI回答中的人形信息不再丢弃: judgePerson提取personFromVeh, 有人则按人员活动推送(标题/kw4/徽章联动), 修18:0x菜地站人整条按无人车辆丢弃的漏报
// 变更历史 2026-09-30.50: +同活动双推送治理: 入库判重认pushed/pushPending(车辆事件person=false挡不住同人二次消息), 推送前打占位/失败清除 —— 修15:52双推占满限流窗口致16:11真实事件被拦
// 变更历史 2026-09-30.49: +车辆检测算法用71张真实双溪村样本校准: ASPECT_MAX 0.95→1.35(回收人骑车/车尾局部形态, 召回50%→75%, 误报+8pp由AI确认兜住) +vehicledetect返回blob明细
// 变更历史 2026-09-30.48: +本地人形命中判定移除Agnes双AI交叉, 改mota(阿里备用)单链判定(9-30两次空画面误判有人实测: Agnes光影误判劫持结论) +config停用Agnes
// 变更历史 2026-09-29.47: +车辆检测校准(真实双溪村样本): 冷却180→30秒(实测冷却跳帧造成骑车人漏报) +参考图反馈刷新(AI确认的干净帧回写ref, 治光照失真) +vehicledetect返回blob明细供校准
// 变更历史 2026-09-29.46: +修车辆AI确认门控被"无其他异常"套话绕过(18:36空院子误报车实测): 车辆确认路径不吃异常豁免 +judge.NEG_ABNORMAL补无其他异常/无明显异常
// 变更历史 2026-09-29.45: +/today卡片加结论来源徽章(算法/DeepSeek/设备端, 推导自provider); 修todayPersonEvents等映射丢失provider/ezvizPic
// 变更历史 2026-09-29.44: +/today今日页卡片排版优化: AI结论改彩色徽章(有人红/无人绿)+依据压缩为单行摘要, 完整判读点图灯箱看
// 变更历史 2026-09-29.43: +车辆事件改AI确认制: 本地算法只做免费预筛, 命中后同一张快照跑车辆复核AI, AI明确说没车才拦(可vehicleDetect.aiConfirm=false回退) +修vehVerdictFromAi对车辆prompt否定句式的误判
// 变更历史 2026-09-29.42: +同设备主链路串行化(消除AI延迟窗口内的同活动双事件/双推送) +隧道未开时推送/日报不再发相对路径链接 +报警截图文件名防冲突
// 变更历史 2026-09-29.41: +主链路选图改为报警自带截图优先(picUrl->captureHD): 判人看报警时刻, 时机远比分辨率重要
// 变更历史 2026-09-29.40: +refreshTodayEvents 报警自带截图优先(补录不再逐条拉流/图文不符) +aiFollowUp 复用已有AI结论(重复查询不再烧AI)
// 变更历史 2026-09-29.39: +hdcapture: 截帧失败清理产物(根治512x288错误帧泄漏130张)、占位流不重试、9048账号级退避5分钟、回落快照尺寸校验
// 变更历史 2026-09-29.38: +修复 patchPushLog 永远"等锁超时"的根因(acquire 用 resolve 传结果, run 永远拿到 undefined -> 改写从未执行过且锁文件遗留); 改写目标匹配改用接收时间戳并逆序查找
// 变更历史 2026-09-28.37: +冷却表提升到模块级(局部变量导致60s抓图/180s本地检测冷却每条消息重置失效) +evTs声明前移(消除patchPushLog回调对var提升时序的依赖)
// 变更历史 2026-09-12.36: 自动AI判读回写 provider(看板据此区分"AI 判定"与"设备端人形标签直通"); prompt 抗幻觉重写见 config.json
// 变更历史 2026-09-12.33: events.json 三进程并发写改为 lib/store 跨进程事务(文件锁+锁内重读), 修复读改写期间夹 await 导致的丢事件
// 变更历史 2026-09-04.31: +历史查询:文本指令「查询双溪村10点左右的监控」按时段返回报警截图+AI结论(不筛是否有人,云端按窗补录) // +/history历史页(有人记录+历史日报按日回看)+/api/history-* 3接口 // 日报快照存档data/daily_reports/ // events保留上限500→storage.eventRetention(默认20000≈90天,配合截图90天)
const PID_FILE = path.join(ROOT, "data", "webhook.pid");
const client = createClient(cfg);

// ---------- 本地补充检测配置(自写算法, 零外部依赖) ----------
// 对"普通移动侦测"图做帧差+连通域+人形启发式分析(不耗云配额), 命中即升级为智能事件,
// 弥补萤石设备端人形检测漏检(实测: 有人场景命中率~62%, 无人场景误报0%)。
// 命中后仍走云端 AI 复核做最终门控, 本地只当前置筛。
const LOCAL_DETECT = Object.assign({ enabled: false, cooldownSec: 180 }, cfg.localDetect || {});
if (LOCAL_DETECT.enabled) {
  console.log("[本地检测] 已启用: 移动侦测图将做人形特征分析(帧差+连通域, 零API消耗), 冷却 " + LOCAL_DETECT.cooldownSec + "秒");
}
// 本地车辆检测配置: 对"人形事件"的高清图追加车辆识别(帧差宽扁blob+水平边缘dominance),
// 命中即在标题/推送标注"驾车/骑车经过", 车型由云端AI复核(零API消耗的前置标记)
const VEHICLE_DETECT = Object.assign({ enabled: true }, cfg.vehicleDetect || {});
// 车辆事件需AI确认才推送(算法只做免费预筛); false=回退旧B方案(本地命中即推, 不看AI结论)
const VEH_AI_CONFIRM = !((cfg.vehicleDetect || {}).aiConfirm === false);
const vehicledetect = require("./lib/vehicledetect");
// 设备级车辆检测开关(2026-09-30): config.json → devices[].vehicleDetect, 默认true。
// 木山村前门场景(晾衣架/植被/光影)车辆误报偏高, 用户要求仅双溪村启用车辆检测。
function vehEnabledFor(serial) {
  const d = (cfg.devices || []).find(function (x) { return x.serial === serial; });
  return VEHICLE_DETECT.enabled && !(d && d.vehicleDetect === false);
}
if (VEHICLE_DETECT.enabled) {
  console.log("[车辆检测] 已启用: 移动侦测快照先本地帧差预筛, 命中后同图AI确认(" + (VEH_AI_CONFIRM ? "AI确认制" : "本地命中即推") + ")");
}

// 本地检测/抓图冷却表 —— 必须放在模块级。
// handleEzvizPushInner 每收到一条萤石推送就会调用一次, 这些表若声明成函数局部变量,
// 每条消息都会重置为空对象, 60秒抓图冷却/180秒本地检测冷却全部失效
// (高频移动侦测每 20~30 秒一条, 每条都会触发 captureHD+AI 复核, 白烧配额与磁盘)。
const _localCool = {};  // serial -> ts, 本地人形检测冷却(避免同一次活动反复跑全链路+烧AI)
const _vehCool = {};    // serial -> ts, 本地车辆检测冷却
const _motionCool = {}; // serial -> ts, 移动侦测抓图冷却(无picUrl时用streamFrame补图, 防止高频消息刷爆磁盘)

// ---------- API 调用统计 ----------
// 监控微信 API 配额使用情况，避免超限
const API_STATS_FILE = path.join(ROOT, "data", "api_stats.json");
let _apiStats = {
  date: new Date().toDateString(),
  total: 0,
  byType: {
    token: 0,        // access_token 获取
    userGet: 0,      // 获取关注者列表
    userInfo: 0,     // 获取用户信息
    templateSend: 0, // 模板消息发送
    mediaUpload: 0,  // 素材上传
    customSend: 0    // 客服消息发送
  }
};

function loadApiStats() {
  try {
    const data = JSON.parse(fs.readFileSync(API_STATS_FILE, "utf8"));
    const today = new Date().toDateString();
    if (data.date === today) {
      _apiStats = data;
    } else {
      // 日期变更，重置统计
      _apiStats = {
        date: today,
        total: 0,
        byType: {
          token: 0,
          userGet: 0,
          userInfo: 0,
          templateSend: 0,
          mediaUpload: 0,
          customSend: 0
        }
      };
    }
  } catch (e) {
    // 文件不存在或损坏，使用默认值
  }
}

function saveApiStats() {
  try {
    fs.mkdirSync(path.dirname(API_STATS_FILE), { recursive: true });
    fs.writeFileSync(API_STATS_FILE, JSON.stringify(_apiStats, null, 2));
  } catch (e) {}
}

function trackApiCall(type) {
  if (_apiStats.byType[type] !== undefined) {
    _apiStats.byType[type]++;
    _apiStats.total++;
    // 每 10 次调用保存一次，避免频繁写盘
    if (_apiStats.total % 10 === 0) {
      saveApiStats();
    }
    // 接近配额限制时警告（假设每日限额 1000 次）
    if (_apiStats.total === 800) {
      console.log("[API统计] ⚠️ 今日 API 调用已达 800 次，接近配额限制");
    } else if (_apiStats.total === 950) {
      console.log("[API统计] 🚨 今日 API 调用已达 950 次，即将耗尽配额！");
    }
  }
}

function getApiStats() {
  return {
    date: _apiStats.date,
    total: _apiStats.total,
    byType: _apiStats.byType,
    quotaWarning: _apiStats.total >= 800
  };
}

// 启动时加载统计
loadApiStats();

// 每天午夜重置统计
setInterval(function() {
  const now = new Date();
  if (now.getHours() === 0 && now.getMinutes() === 0) {
    console.log("[API统计] 新的一天，重置 API 调用统计");
    _apiStats = {
      date: now.toDateString(),
      total: 0,
      byType: {
        token: 0,
        userGet: 0,
        userInfo: 0,
        templateSend: 0,
        mediaUpload: 0,
        customSend: 0
      }
    };
    saveApiStats();
  }
}, 60000); // 每分钟检查一次

// 每小时打印一次 API 调用统计, 便于从日志观察配额消耗
setInterval(function () {
  const s = getApiStats();
  console.log("[API统计] 今日累计 " + s.total + " 次 | token:" + s.byType.token +
    " userGet:" + s.byType.userGet + " userInfo:" + s.byType.userInfo +
    " templateSend:" + s.byType.templateSend + " mediaUpload:" + s.byType.mediaUpload +
    " customSend:" + s.byType.customSend);
  saveApiStats();
}, 3600e3);

// 进程退出前落盘统计, 避免丢失最近几次计数
process.on("exit", function () { saveApiStats(); });

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

// 判断请求是否来自本机回环（127.0.0.1 / ::1）。注意: 花生壳穿透也从 127.0.0.1 反代, 单凭回环不足以判"本机"; 真正本机 = 回环地址 + 回环 Host + 无代理转发头(见 lib/publicgate.js isLocalRequest)。
function isLoopback(req) {
  const a = req.socket && req.socket.remoteAddress;
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

// ---------- 公网访问鉴权(实现见 lib/publicgate.js; wxServer.publicToken 配置后启用) ----------
const _pg = require("./lib/publicgate").createPublicGate(cfg, isLoopback);
const publicGate = _pg.publicGate, tokUrl = _pg.tokUrl, PUBLIC_TOKEN = _pg.PUBLIC_TOKEN;

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

const _captureDirCache = {}; // serial -> { file, mtimeMs, dirMtimeMs } 目录 mtime 不变则无需重新扫描
function latestCapture(serial) {
  // 只扫 captures/ 主目录, **故意不扫 motion/**:
  // 返回值会被 recordKanjiaCapture() 记进 events 的 file 字段, 而 motion 图只保留几小时 ——
  // 一旦记进去, 几小时后这条记录就成了"有记录、图已裂"。
  // 主目录也不会空: handleKanJia 每次查询后都会异步预抓一张存着(见那里 freshCapture 那行),
  // 所以「看家」的 30 秒新鲜度缓存照旧能命中, 不会多烧抓图配额。
  let dirMtimeMs = 0;
  try { dirMtimeMs = fs.statSync(CAPTURE_DIR).mtimeMs; } catch (e) { return null; }
  const c = _captureDirCache[serial];
  // 目录 mtime 未变 → 无新增/修改文件 → 直接复用缓存, 避免逐文件 statSync
  if (c && c.dirMtimeMs === dirMtimeMs) return c.file ? { file: c.file, mtimeMs: c.mtimeMs } : null;
  let best = null;
  try {
    for (const f of fs.readdirSync(CAPTURE_DIR)) {
      if (f.indexOf(serial) !== 0 || f.slice(-4).toLowerCase() !== ".jpg") continue;
      const p = path.join(CAPTURE_DIR, f);
      const st = fs.statSync(p);
      if (!best || st.mtimeMs > best.mtimeMs) best = { file: p, mtimeMs: st.mtimeMs };
    }
  } catch (e) { /* 目录不存在 */ }
  _captureDirCache[serial] = best
    ? { file: best.file, mtimeMs: best.mtimeMs, dirMtimeMs: dirMtimeMs }
    : { file: null, mtimeMs: 0, dirMtimeMs: dirMtimeMs };
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
    trackApiCall("token");
    const res = await fetch("https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=" + appId + "&secret=" + appSecret, { signal: AbortSignal.timeout(10000) });
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

// 图片上传缓存：避免重复上传同一张图片，节省 API 调用
// 微信临时素材有效期 3 天，缓存设置 2 天过期
const IMAGE_CACHE_FILE = path.join(ROOT, "data", "image_upload_cache.json");
let _imageCache = null;
const IMAGE_CACHE_TTL = 2 * 24 * 3600e3; // 2天

function loadImageCache() {
  if (_imageCache) return _imageCache;
  try {
    _imageCache = JSON.parse(fs.readFileSync(IMAGE_CACHE_FILE, "utf8"));
    // 清理过期缓存
    const now = Date.now();
    for (const hash of Object.keys(_imageCache)) {
      if (now - _imageCache[hash].ts > IMAGE_CACHE_TTL) {
        delete _imageCache[hash];
      }
    }
  } catch (e) {
    _imageCache = {};
  }
  return _imageCache;
}

function saveImageCache() {
  try {
    fs.mkdirSync(path.dirname(IMAGE_CACHE_FILE), { recursive: true });
    fs.writeFileSync(IMAGE_CACHE_FILE, JSON.stringify(_imageCache));
  } catch (e) {}
}

async function uploadTempImage(file, token) {
  if (!token) token = await wxAccessToken();
  
  // 读一次文件: 同时用于计算 hash 和 multipart 上传, 避免重复读取同一张图
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) { throw new Error("读取图片失败: " + e.message); }
  const hash = crypto.createHash("md5").update(buf).digest("hex");
  
  // 检查缓存
  const cache = loadImageCache();
  if (cache[hash] && Date.now() - cache[hash].ts < IMAGE_CACHE_TTL) {
    console.log("[图片] 使用缓存 media_id: " + cache[hash].media_id.slice(0, 20) + "...");
    return cache[hash].media_id;
  }
  
  const boundary = "----aicamBoundary" + Date.now();
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
    body: Buffer.concat([head, buf, tail]),
    signal: AbortSignal.timeout(30000)
  });
  const j = await res.json();
  if (!j.media_id) throw new Error("上传素材失败 " + JSON.stringify(j).slice(0, 150));
  
  // 写入缓存
  if (hash) {
    const cache = loadImageCache();
    cache[hash] = { media_id: j.media_id, ts: Date.now() };
    saveImageCache();
  }
  
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
    // 默认不裁剪: 保留全部推送历史, 磁盘满了由用户自行处理。
    // 需要主动限制时, 在 config.json 的 storage.pushLogRetention 填正整数条数(0/未填 = 不限)。
    const keep = Number((cfg.storage && cfg.storage.pushLogRetention));
    if (keep > 0) arr = arr.slice(-keep);
    // **原子写(2026-10-08)**: 原来是 writeFileSync 整份直接覆盖, 文件已 4.7MB+,
    // 写入窗口几十毫秒内 webapp/monitor 会读到**被截断的 JSON** → 推送记录页整页空白(实测撞到)。
    // 改成: 先写 .tmp 再 rename(rename 在同一卷上是原子操作), 顺便留一份 .bak 供读取侧兜底。
    // 4.7MB 每次全量重写本身也偏重 —— 若日志持续膨胀, 下一步应改成分片(push_log.0.json/.1.json)。
    const tmp = PUSH_LOG + ".tmp." + process.pid;
    const bak = PUSH_LOG + ".bak";
    const txt = JSON.stringify(arr, null, 1);
    fs.writeFileSync(tmp, txt);
    try { fs.copyFileSync(PUSH_LOG, bak); } catch (eBak) { /* 首次写入时没有原文件, 正常 */ }
    fs.renameSync(tmp, PUSH_LOG);
  } catch (e) {}
}
// 跨进程文件锁 + 「锁内重读最新内容再改」的 push_log.json 事务。
// 与 lib/store.js 的 updateJson 同理: webhook/webapp/monitor 三个进程都可能访问 push_log.json,
// 必须用文件锁防止读-改-写期间被其他进程整份覆盖。锁内重读最新内容再改, 避免基于过期快照写回。
function patchPushLog(mutate) {
  return new Promise(function (resolve) {
    const lp = PUSH_LOG + ".lock";
    const token = process.pid + "@" + os.hostname() + "@" + Date.now() + "@" + Math.random().toString(36).slice(2, 8);
    let waited = 0, spins = 0;
    function parseLock(info) { const p = String(info || "").split("@"); return { pid: p[0] || "", host: p[1] || "" }; }
    function pidAlive(pid) { const n = Number(pid); if (!n || n <= 0) return false; try { process.kill(n, 0); return true; } catch (e) { return e.code === "EPERM"; } }
    function unlinkIfMine() {
      try { if (fs.readFileSync(lp, "utf8") !== token) return false; fs.unlinkSync(lp); return true; }
      catch (e) { return e.code === "ENOENT"; }
    }
    // 抢锁结果通过**返回值**交给 run() 判断。
    // 2026-09-29 修复: 原来成功/失败都调外层 Promise 的 resolve() 且函数本身 return undefined,
    // run() 里 `const ok = await acquire()` 永远拿到 undefined -> 永远走"等锁超时"分支提前 return:
    // 改写从未执行过(车辆命中 151 次 0 次成功), 且 try/finally 的释放锁被跳过、锁文件每次遗留。
    // (lib/store.js 的 acquireLock 正确做法是返回 token/由调用方检查返回值, 此处对齐)
    async function acquire() {
      const deadline = Date.now() + 10000;
      for (;;) {
        try { const fd = fs.openSync(lp, "wx"); try { fs.writeSync(fd, token); } finally { fs.closeSync(fd); } return true; }
        catch (e) {
          if (!["EEXIST", "EPERM", "EACCES", "EBUSY"].includes(e.code)) return false; // 真·致命(路径不可写等): 由调用方决定
          let info = null;
          try { info = fs.readFileSync(lp, "utf8"); } catch (e2) { if (e2.code !== "ENOENT") info = ""; }
          if (info === null) { if (Date.now() >= deadline && waited > 0) return false; if (++spins > 500) { spins = 0; await new Promise(function (r) { setTimeout(r, 3); }); } continue; }
          const lk = parseLock(info);
          let shouldSteal = false;
          if (lk.host === os.hostname() && lk.pid) {
            if (!pidAlive(lk.pid) || lk.pid === String(process.pid)) shouldSteal = true;
          } else {
            let age = 0; try { age = Date.now() - fs.statSync(lp).mtimeMs; } catch (e3) { age = 0; }
            if (age > 8000) shouldSteal = true;
          }
          if (shouldSteal) {
            try { const g = lp + ".stale." + process.pid; fs.renameSync(lp, g); fs.unlinkSync(g); } catch (e4) {}
            if (++spins > 500) { spins = 0; await new Promise(function (r) { setTimeout(r, 3); }); }
            if (Date.now() >= deadline && waited > 0) return false;
            continue;
          }
          if (Date.now() >= deadline) return false;
          const nap = 4 + Math.floor(Math.random() * 16);
          waited += nap;
          await new Promise(function (r) { setTimeout(r, nap); });
        }
      }
    }
    async function run() {
      const ok = await acquire();
      if (!ok) { console.log("[patchPushLog] 等锁超时, 放弃本次写入"); resolve({ ok: false, error: "lock timeout" }); return; }
      try {
        let arr = [];
        try { arr = JSON.parse(fs.readFileSync(PUSH_LOG, "utf8")); if (!Array.isArray(arr)) arr = []; } catch (e) {}
        const r = mutate(arr);
        if (r === false) { resolve({ ok: true, written: false }); return; }
        const content = JSON.stringify(arr, null, 1);
        const tmp = PUSH_LOG + ".tmp." + process.pid;
        fs.writeFileSync(tmp, content);
        try { fs.renameSync(tmp, PUSH_LOG); }
        catch (e) { try { fs.writeFileSync(PUSH_LOG, content); } finally { try { fs.unlinkSync(tmp); } catch (e2) {} } }
        resolve({ ok: true, written: true });
      } catch (e) { resolve({ ok: false, error: e.message }); }
      finally { unlinkIfMine(); }
    }
    run();
  });
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
  // 仅保留 HMAC 算法; MD5/SHA256 裸哈希回退去掉(长度扩展攻击风险, 且非官方协议)
  const t = h["t"] || "";
  const cands = [];
  if (t) {
    cands.push(crypto.createHmac("sha1", P.secret).update(bodyRaw + t).digest("hex"));
    cands.push(crypto.createHmac("sha256", P.secret).update(bodyRaw + t).digest("hex"));
  }
  return cands.map(function(s){ return String(s).toLowerCase(); }).indexOf(got.toLowerCase()) >= 0;
}
// 缩略图缓存路径: md5(文件名_w600) 前12位, 与 /captures/thumb/ 路由完全一致(预生成/按需生成共用同一文件)
function thumbPathOf(file) {
  const hash = crypto.createHash("md5").update(file + "_w600").digest("hex").slice(0, 12);
  return path.join(ROOT, "captures", "thumb_" + hash + ".jpg");
}
// 预生成缩略图缓存: 报警推送抓到图后立即生成, 用户从微信点进详情页时缓存已就绪 -> 主图秒开
function ensureThumbFile(file) {
  try {
    if (!file) return;
    const base = path.basename(file);
    const origPath = path.join(ROOT, "captures", base);
    if (!fs.existsSync(origPath)) return;
    const thumbPath = thumbPathOf(base);
    if (fs.existsSync(thumbPath)) return;
    hdcapture.makeThumb(origPath, thumbPath, 600, 5).then(function (sz) {
      console.log("[缩略图] 推送预生成 " + base + " " + sz.w + "x" + sz.h);
    }).catch(function (e) {
      console.log("[缩略图] 预热失败 " + base + ": " + String(e.message).slice(0, 80));
    });
  } catch (e) {}
}
// 从 AI 结论中提取"车辆判定": 不依赖第一行有车/无车的格式(AGNES 渠道实测格式遵循差:
// 常在第二行描述里认出了车、第一行却答"无车")。整篇扫描: 明确否认(没有/未见/未出现+车辆词) -> "no";
// 出现具体车型词 -> "yes"; 都没有(结论没提车) -> "" (未表态, 按信任本地放行, 由调用方决定)
function vehVerdictFromAi(aiTxt) {
  const s = String(aiTxt || "");
  // 车型/车辆关键词
  const VEH_KW = /汽车|轿车|面包车|货车|三轮车|摩托车|电动车|踏板车|小车|车辆|车子/;
  // 明确否认: "没有看到任何车辆"/"未见交通工具"/"未看到车辆及车型位置"/"未发现任何车辆"
  // (2026-09-29 修复: 否定词表缺"未看到/未发现/无", 车辆复核prompt的否定回答"画面中未看到车辆"
  //  会被下面的 VEH_KW 整篇扫描误判成"yes" -> AI说没车却推"检测到车辆")
  const NEG = /(没有|未见|未出现|未看到|未发现|无明显|不存在|无)[^。；\n]{0,10}(车辆|车子|汽车|轿车|面包车|货车|三轮车|摩托车|电动车|交通工具)/;
  // 肯定量词/姿态: "有一辆黑色摩托车"/"停放着一辆三轮车"/"骑着电动车" —— 带量词或姿态动词的
  // 具体车型提及是**确认**, 优先级高于否定: 同一句可能两者并存("画面中有一辆黑色摩托车...未发现
  // 其他行驶中的车辆", "其他"否定的不是这辆)。刻意不含"行驶"二字, 免得把"未发现其他行驶中的车辆"
  // 当成确认; 否定量词的"没有一辆"用负向环视排除。
  const AFF = /(?<![没无未][^。；\n]{0,3})(?:一辆|一台|停放|停在|停着|骑着|开着|驶过|驶来|驶去)[^。；\n]{0,10}(?:摩托车|电动车|三轮车|汽车|轿车|面包车|货车)/;
  // 车辆复核prompt要求"最后用一句话说明是否看到车辆" —— 结论以**最后一句**为准:
  // 前文的逐项枚举可能同时出现"没有看到人"和"发现一辆摩托车", 整篇扫描会互相干扰
  const parts = s.split(/[。；！？\n]/).map(function (x) { return x.trim(); }).filter(Boolean);
  const last = parts.length ? parts[parts.length - 1] : s;
  if (AFF.test(last)) return "yes";
  if (NEG.test(last)) return "no";
  if (VEH_KW.test(last)) return "yes";
  // 最后一句没结论时整篇兜底(兼容其他输出格式): 先查明确否认, 再查具体车型词
  if (NEG.test(s)) return "no";
  if (VEH_KW.test(s)) return "yes";
  // 第一行格式(有车/无车)兜底: 前面关键词没命中时按首行判一次
  const first = s.trim().split(/\r?\n/)[0] || "";
  if (/^有车/.test(first)) return "yes";
  if (/^无车/.test(first)) return "no";
  return ""; // 未表态(调用方按放行处理, 不确定不拦防漏报)
}

// 顶层包装: 任何未预料异常都必须留醒目日志 —— 2026-09-26 事故(TDZ bug 导致 08:46~09:01
// 所有人形/车辆事件静默崩溃、没入库没推送, 只在日志里留一行"处理失败")的教训。

// 同设备主链路串行化(2026-09-29 审查): 同一设备的推送消息按到达顺序处理完(含AI+推送)再处理下一条。
// 并发处理的洞: 下一条消息在上一条的 AI 尚未回写时到达(person 仍是 false) ——
//   ① 带截图的消息走"二次判定"分支再建一条同活动事件(看板同活动重复卡片);
//   ② 300秒推送去重读到的 pushed 还是 false → 同活动推送两条。
// 串行后, 去重检查看到的是上一条处理完的最终状态, 两个问题同时消除; 不同设备仍然并行互不影响。
const _serialChains = {}; // serial -> 上一个处理承诺
function enqueueForSerial(serial, fn) {
  const key = serial || "_";
  const prev = _serialChains[key] || Promise.resolve();
  const next = prev.catch(function () {}).then(fn);
  _serialChains[key] = next;
  const done = function () { if (_serialChains[key] === next) delete _serialChains[key]; };
  next.then(done, done);
  return next;
}
async function handleEzvizPush(bodyRaw, headers) {
  try {
    // 快速解析设备序列号作为队列键(与 handleEzvizPushInner 的解析规则一致; 解析失败归入公共队列)
    var peekSerial = "";
    try {
      var peek = JSON.parse(bodyRaw);
      var peekInner = (peek && peek.body && typeof peek.body === "object") ? peek.body : peek;
      peekSerial = String((peekInner && (peekInner.devSerial || peekInner.deviceSerial || peekInner.deviceId)) || "");
    } catch (e) {}
    await enqueueForSerial(peekSerial, function () { return handleEzvizPushInner(bodyRaw, headers); });
  } catch (e) {
    console.log("[萤石推送] ❌ 事件处理异常(已捕获, 不影响后续消息): " + (e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e));
  }
}
async function handleEzvizPushInner(bodyRaw, headers) {
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
  // PeopleDetectionEvent(ys.iot): 设备端人形检测的第三种上报格式(domain=HumanBodyDetection),
  // payload 恒为字符串"null"(2026-10-07 实测399条全是), 事件本身即信号 —— 设备端AI认为出现了人形。
  // 之前完全没被处理: 无alarmType无textMsg, 走普通移动侦测门控, 无picUrl时静默结束不生成事件
  // (9月每天32~55条全部浪费, 10-07 12:27:09 实收一条无事件实证)。归一成 SmartHumanDet 复用
  // 人形链路; 时间戳用 header.messageTime(v2展平已写入 alarmTime)。无图人形事件由下方
  // "补拍→AI→判定推送"分支接管(不盲推), 90秒窗口会吸收与 SmartHumanDet/IntelligentTag 成对到达的同活动消息。
  if (p && (p.identifier === "PeopleDetectionEvent" || p.domain === "HumanBodyDetection")) {
    p.alarmType = "SmartHumanDet";
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
  // evTs(事件时间基准)在时间戳解析完就地定值: 下方 90 秒入库去重 / 300 秒推送去重 / 60 分钟本地命中
  // 窗口都拿它比对, 声明紧贴 ts 解析处, 保证所有引用点读到的都是已赋值变量而非 var 提升的 undefined
  // (2026-09-29 注: 车辆改写 push_log 的回调已改用接收时间戳 t, 不再引用本变量)
  var evTs = ts || Date.now();
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
  var localHit = false;   // 本地补充检测(自写算法)命中人形, 把移动侦测升级为智能事件
  var localHitEdge = 0;    // 本地人形命中的竖直边缘密度(衡量命中强弱): 刚过阈值0.25=弱, 疑似阴影/反光
  var localVehHit = false; // 本地车辆检测命中, 同样升级(抓高清图/AI复核车型/入库带veh标记)
  var localVeh = false;    // 本地车辆检测标记(人形事件高清图追加识别命中; 声明须早于 newRec, 避免 TDZ)
  var personFromVeh = false; // 车辆复核AI的回答中发现了人(2026-09-30新增: 车辆判"无车"但画面有人时, 按人员活动推送而非丢弃)
  // 冷却表 _localCool/_vehCool/_motionCool 已提升到模块级(见文件头), 函数局部变量会让冷却每条消息都重置
  // 车辆检测冷却(2026-09-29 校准后 180→30): 冷却的本质是"跳过这一帧的检测", 而车经过画面只有
  // 5~20秒 —— 180秒冷却实测把唯一有车的那帧跳掉了(16:11 骑车人: 16:10:46 刚跑过, 16:11:44 被跳,
  // 造成漏报)。本地检测仅~25ms零API, 30秒只挡同帧重复, 不再跳过真有车的帧。可 vehicleDetect.cooldownSec 调整。
  const VEHICLE_COOLDOWN_SEC = Number((cfg.vehicleDetect || {}).cooldownSec || 30);
  const MOTION_CAPTURE_COOLDOWN_SEC = 60; // 移动侦测抓图冷却: 每设备60秒最多抓一张(高频消息每20-30秒一条, 不冷却会刷出几千张)
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
        // 本地补充检测(自写算法, 零 API 消耗): 帧差+连通域+人形启发式(详见 lib/motiondetect.js)
        // 命中则升级为智能事件走完整链路(抓高清图/入库/云端AI复核/推送), 弥补设备端人形检测漏检
        if (LOCAL_DETECT.enabled && !isQuotaExhausted()) {
          const nowMs = Date.now();
          if (nowMs - (_localCool[serial] || 0) >= LOCAL_DETECT.cooldownSec * 1000) {
            _localCool[serial] = nowMs;
            const lr = await motiondetect.analyze(ROOT, serial, path.join(MOTION_DIR, _fname));
            if (lr && lr.personLike) {
              localHit = true;
              localHitEdge = (lr.top && typeof lr.top.edgeRatio === "number") ? lr.top.edgeRatio : 0;
              isSmartType = true;
              personByText = true; // 判定链路按"有人"走; 最终仍由云端AI复核(analyzeAndStore)做门控
              console.log("[本地检测] ★ 命中人形特征: " + serial + " 差异占比" + (lr.ratio * 100).toFixed(1) +
                "% blob面积" + (lr.top.area / motiondetect.PX0 * 100).toFixed(1) + "% 高宽比" + lr.top.aspect.toFixed(2) +
                " 填充" + lr.top.fill.toFixed(2) + " 边缘密度" + lr.top.edgeRatio.toFixed(2) + " (" + lr.ms + "ms)");
            } else if (lr && lr.staticArtifact) {
              // 静态伪影(同位置反复命中, 已强制刷新参考): 打日志便于排查, 不升级不推送
              console.log("[本地检测] 静态伪影(同位置反复命中, 已刷新参考): " + serial + " 差异占比" + (lr.ratio * 100).toFixed(1) + "% (" + lr.ms + "ms)");
            } else if (lr && lr.skipped) {
              // noref/ref-created/lighting: 静默(建参考/光照突变都不需要打扰日志)
            }
          }
        }
        // 本地车辆检测(自写算法, 零 API 消耗): 人形未命中时再判车辆(宽扁blob+水平边缘dominance)
        // 命中同样升级走完整链路: 抓高清图→入库(打veh标记)→云端AI复核(问车型)→判有内容才推送
        // 萤石设备端没开车辆检测上报, 车经过只会触发移动侦测, 这是捕获车辆的唯一通道
        if (!localHit && vehEnabledFor(serial) && !isQuotaExhausted()) {
          const nowMs2 = Date.now();
          if (nowMs2 - (_vehCool[serial] || 0) >= VEHICLE_COOLDOWN_SEC * 1000) {
            _vehCool[serial] = nowMs2;
            try {
              const vr = await vehicledetect.analyzeFrame(ROOT, serial, path.join(MOTION_DIR, _fname));
              if (vr && vr.vehicleLike) {
                localVehHit = true;
                isSmartType = true;
                // 改写 push_log.json 中该条移动侦测消息的 alarmType 为 SmartVehicleDet
                // 让 webapp.js 的 buildPushGroups 能正确归类为"车辆检测"
                // 匹配用**本条消息的接收时间戳 t**(logPush 落盘用的就是它), 不再用报警时间 evTs ——
                // push_log 条目的 ts 是接收时刻, 与报警时间可能相差数秒, 用 evTs 匹配会漏掉目标条目。
                // 从新到旧找第一条同设备条目: 本条消息刚落盘必在最新端, 同设备秒级成对推送时也不会误改旧条目。
                patchPushLog(function (arr) {
                  for (let i = arr.length - 1; i >= 0; i--) {
                    const e = arr[i];
                    if (!e || !e.body) continue;
                    let body = e.body;
                    try {
                      if (typeof body === "string") body = JSON.parse(body);
                      if (body && body.body) body = body.body;
                    } catch (err) {}
                    if (!body || typeof body !== "object") continue;
                    const bodySerial = String(body.devSerial || body.serial || body.deviceId || "");
                    const bodyTs = Number(e.ts) || 0;
                    if (bodySerial !== serial || Math.abs(bodyTs - t) > 5000) continue;
                    if (body.alarmType === "SmartVehicleDet") return false; // 已改过, 不重复
                    body.alarmType = "SmartVehicleDet";
                    // 保持原有 body 格式: 原来是字符串就序列化, 原来是对象就保持对象
                    if (typeof e.body === "string") e.body = JSON.stringify(body);
                    else e.body = body;
                    console.log("[patchPushLog] 改写 push_log.json: " + serial + " alarmType -> SmartVehicleDet");
                    return true;
                  }
                  return false;
                });
                console.log("[车辆检测] ★ 命中车辆特征: " + serial + " 差异占比" + (vr.ratio * 100).toFixed(1) +
                  "% blob面积" + (vr.top.area / vehicledetect.PX0 * 100).toFixed(1) + "% 高宽比" + vr.top.aspect.toFixed(2) +
                  " 水平边" + vr.top.hEdge.toFixed(2) + (vr.bigMask ? " [大mask场景]" : "") + " (" + vr.ms + "ms)");
              }
            } catch (eV) { console.log("[车辆检测] 分析失败: " + eV.message.slice(0, 60)); }
          }
        }
      } catch (e) { console.log("[萤石推送] 移动侦测图片保存失败: " + e.message); }
    } else if (serial) {
      // 没有 picUrl: 用 captureHD 截帧(streamFrame优先, 失败回落免费快照)
      // 冷却 60 秒/设备: 移动侦测高频(每 20-30 秒一条), 不冷却会刷出几千张图
      var nowMsCap = Date.now();
      if (nowMsCap - (_motionCool[serial] || 0) >= MOTION_CAPTURE_COOLDOWN_SEC * 1000) {
        _motionCool[serial] = nowMsCap;
        try {
          var _fname = serial + "_" + (ts || Date.now()) + ".jpg";
          fs.mkdirSync(CAPTURE_DIR, { recursive: true });
          await hdcapture.captureHD(client, serial, path.join(CAPTURE_DIR, _fname));
          console.log("[萤石推送] 移动侦测无截图, 抓图: " + _fname);
        } catch (e) { console.log("[萤石推送] 移动侦测抓图失败: " + String(e.message).slice(0, 80)); }
      }
    }
    if (!localHit && !localVehHit) return;
  }
  if (serial) {
    var evts = loadEventsArr(); // 只读快照: 用于尽早跳过同一次活动, 真正提交时会在锁内用最新数据复查
    // evTs 已在上方解析完时间戳时定值(见那里的注释), 这里直接使用
    // 同设备90秒内的消息视为同一次活动: 人形tag与报警消息常成对到达, tag还会在段首/段尾各发一次, 只推一条。
    // 例外: 报警消息自带相机的人形快照(picUrl)时, 若90秒内的旧事件被AI判了"无人"(person=false),
    // 说明可能漏判, 放行用自带快照二次判定; 旧事件已确认有人则仍去重, 避免同一次活动双推。
    // (20:47漏推教训: tag先到复用了人进场前的空帧被判无人, 随后带有人快照的报警被去重吞掉)
    var recentEvts = evts.filter(function(e){ return e.source !== "kanjia" && e.serial === serial && Math.abs((e.ts || 0) - evTs) < 90e3; });
    // 判重升级(2026-09-30): pushed/pushPending 也算"该活动已打扰过" —— 车辆事件只判车不判人
    // (person=false), 同一辆车经过触发的第二条消息(人形判定)会走二次判定分支再建一条事件并再推
    // 一次, 占满30分钟限流窗口的2个名额, 导致后续真正的新事件反被限流拦掉(9-30 15:52双推占坑→
    // 16:11骑车人被拦实测)
    var confirmedRecent = recentEvts.some(function(e){ return e.person === true || e.pushed === true || e.pushPending === true; });
    if (recentEvts.length && (confirmedRecent || !picUrl)) {
      console.log("[萤石推送] 90秒内同设备已有记录，视为同一次活动跳过 " + serial + "@" + new Date(evTs).toLocaleTimeString());
      return;
    }
    // 图片：三级回落
    //   ⓪ 本地算法(人形/车辆)命中时: 直接把算法分析的那张 motion/ 快照搬进 captures/ ——
    //      本地检测与 AI 必须**同一张图**(用户要求: 算法报了车, AI 就看算法看的那帧, 不再另抓)
    //   ① 报警自带截图(picUrl) —— 报警那一刻的画面, 零拉流消耗
    //   ② ffmpeg 主码流截帧(3200x1800 高清, captureHD 内含 streamFrame, 失败自动回落免费快照)
    //   ③ 都没有 → 复用同活动存图
    // 2026-09-29 事故教训: 原来高清截帧优先 —— 骑车人 16:11:38 经过, 消息 16:11:50 才处理,
    // captureHD 抓到人已走远的空帧判"无人"漏推, 而消息自带的有人快照被跳过没用。
    // 判人看的是"报警时刻", 时机远比分辨率重要(768x432 足够 AI 判读), 截图优先还能省拉流额度。
    var fname = "";
    if ((localHit || localVehHit) && _fname) {
      try {
        const srcP = path.join(MOTION_DIR, _fname);
        if (fs.existsSync(srcP)) {
          fname = _fname;
          try { fs.renameSync(srcP, path.join(ROOT, "captures", fname)); }
          catch (eR) { fs.copyFileSync(srcP, path.join(ROOT, "captures", fname)); try { fs.unlinkSync(srcP); } catch (eU) {} }
          console.log("[萤石推送] 使用本地算法检测的同一张快照: " + fname);
        }
      } catch (eM1) {}
    }
    if (!fname && picUrl) {
      fname = serial + "_p" + (ts || Date.now()) + ".jpg";
      // 同一活动多条消息可能携带相同报警时间 → 文件名相同: 已存在则加后缀避免共用同一文件
      // (两条事件共用一个 file 会让 analyzeAndStore 只回写先匹配到的那条, 另一条的 ai 永远是占位)
      if (fs.existsSync(path.join(ROOT, "captures", fname))) {
        fname = serial + "_p" + (ts || Date.now()) + "_" + Date.now() + ".jpg";
      }
      try {
        await client.downloadTo(picUrl, path.join(ROOT, "captures", fname));
        // 占位图防御: 快照正常档为768x432, 拿到≤640宽(如512x288错误提示图)视为无效, 转高清截帧
        var _snapSz = null;
        try { _snapSz = hdcapture.jpegSize(fs.readFileSync(path.join(ROOT, "captures", fname))); } catch (eSz) {}
        if (!_snapSz || !_snapSz.w || _snapSz.w <= 640) {
          console.log("[萤石推送] 报警截图疑似错误占位图(" + (_snapSz ? _snapSz.w + "x" + _snapSz.h : "无法解析") + "), 转高清截帧");
          try { fs.unlinkSync(path.join(ROOT, "captures", fname)); } catch (eU) {}
          fname = "";
        } else {
          console.log("[萤石推送] 报警自带截图: " + fname);
        }
      }
      catch (e) { console.log("[萤石推送] 截图下载失败, 转高清截帧: " + e.message); fname = ""; }
    }
    if (!fname) {
      try {
        fname = serial + "_" + Date.now() + ".jpg";
        await hdcapture.captureHD(client, serial, path.join(ROOT, "captures", fname));
        console.log("[萤石推送] 高清截帧: " + fname);
      } catch (e2) {
        fname = "";
        console.log("[萤石推送] 高清截帧失败: " + String(e2.message).slice(0, 80));
      }
    }
    if (!fname) {
      // 无报警自带截图时(如IntelligentTag人形标签): 同一次活动往往伴随移动侦测消息先到并存了图,
      // 按文件名时间戳找同设备±2分钟内的报警存图复用——画面贴近事件时刻还省抓图配额; 找不到再抓现况
      try {
        var evTsRef = evTs;
        // 候选来自两处: captures/(已长期留存的事件图) 与 captures/motion/(移动侦测临时图)。
        // motion 里还留着图, 说明这次活动刚发生不久, 是垫图的主要来源。
        var cands = [];
        for (const src of [{ d: CAPTURE_DIR, motion: false }, { d: MOTION_DIR, motion: true }]) {
          let files;
          try { files = await fs.promises.readdir(src.d); } catch (e) { continue; }
          for (const f of files) {
            if (f.indexOf(serial + "_p") !== 0 || f.slice(-4) !== ".jpg") continue;
            var fts = Number(f.slice(serial.length + 2, -4));
            if (isFinite(fts) && fts <= evTsRef + 60e3 && evTsRef - fts < 120e3) cands.push({ f: f, t: fts, motion: src.motion });
          }
        }
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
    // 预生成详情页缩略图(非阻塞): 用户从微信点进详情页主图秒开, 点击放大才加载原图
    if (fname) ensureThumbFile(fname);
    var alarmTime = ts ? new Date(ts).toLocaleString("zh-CN",{hour12:false}) : new Date().toLocaleString("zh-CN",{hour12:false});
    var devName = ((cfg.devices||[]).find(function(x){ return x.serial===serial; })||{}).name || serial;
    var newRec = { ts: ts || Date.now(), time: alarmTime, serial: serial, name: devName, file: fname,
      title: localVehHit ? "本地检测(疑似车辆)" : (localHit ? "本地检测(疑似有人)" : (typeName || (isAiNotice ? "AI识别" : "告警"))),
      provider: (localHit || localVehHit) ? "本地算法" : (isAiNotice ? "萤石AI" : ""),
      ai: textMsg || "(点击AI分析)", person: Boolean(isPersonType || personByText), abnormal: false, pushed: false,
      ezvizPic: picUrl || "", veh: (localVeh || localVehHit) ? 1 : 0 };
    // 提交事务: 锁内重新读最新 events.json 再复查去重。
    // 原来这里是"读(第309行) -> 下载图片/复用存图/兜底抓图(多个 await) -> 写", 中间隔了几百毫秒到几秒,
    // 期间 webapp/monitor 写入的新事件会被这份过期数组整份覆盖(丢事件)。
    var commit;
    try {
      commit = await mutateEvents(function (arr) {
      var dup = arr.filter(function (e) { return e.source !== "kanjia" && e.serial === serial && Math.abs((e.ts || 0) - evTs) < 90e3; });
      if (dup.length && (dup.some(function (e) { return e.person === true || e.pushed === true || e.pushPending === true; }) || !picUrl)) {
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
    } catch (eCommit) {
      // 入库异常(如 events.json 损坏/超限): 绝不能中断 AI+推送 —— 微信推送才是用户主链路
      console.log("[萤石推送] ⚠ 入库异常(继续走AI+推送): " + eCommit.message.slice(0, 80));
      commit = { ok: false, written: false };
    }
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
      // 本地车辆已命中的事件, 用"车辆专用prompt"复核: 找人prompt的严格人体标准会误杀
      // "人骑车/驾车"场景(人车合一+人偏小), 车辆prompt只要求明确车辆与车型, 避免漏判
      // 车辆专用prompt: 用"穷举物体"风格(实测8张里5张认出车, 远高于"第一行有车/无车"
      // 格式约束的1/8 —— AGNES 渠道在格式约束下会把已认出的车误判成"无车")
      const vehPrompt = "这是家里监控摄像头抓拍的画面，本地算法检测到疑似车辆经过。请逐个列出画面中所有会动或新出现的物体（人、动物、车辆、任何异常物品），特别注意地面上的小型车辆（摩托车、电动车、三轮车、汽车），它们可能位于画面边缘且较小。最后用一句话说明是否看到车辆及车型位置。";
      // 本地人形命中时的复核prompt: 标准prompt要求"能分辨头部与躯干", 会把远处小人
      // (只剩十几个像素)误判无人(2026-09-26 09:26 事故: 本地框到远处人影, AI按严标准判无人, 漏推)。
      // 因此在标准prompt基础上适当放宽：远处小人也能判有人，但明确列出水面反光/水波/树影等
      // 高发误报源为无人，且"拿不准时判无人"——本地算法已做人形启发式筛选，AI 复核定位是
      // "像不像人"而非"100%确定是人"，但必须防止 AI 被模糊光影诱导判有人（木山村水塘反光误报）。
      const hitPrompt = "这是家里监控摄像头抓拍的画面，本地算法已在画面中框出疑似人形的目标（本地帧差+轮廓分析命中）。请复核这个目标：第一行只输出『有人』或『无人』。判定标准：1) 能分辨出人形轮廓（头部与身体的形状，远处偏小的人也算，但至少要能看出是个人形）判『有人』；2) 目标只是模糊的光斑、水面反光、水波、树影、灌木或地面的光影变化，看不出人形特征，判『无人』；3) 拿不准、无法确认时判『无人』。第二行以『依据：』开头简述目标位置和形态。";
      try {
        if (localVehHit) {
          // 车辆事件: 直接调 AI(不走 analyzeAndStore 的找人链路), 结论按车/flag标记
          // 2026-09-30 补人形提取: vehPrompt的回答常附带画面里的人形描述("仅有一名女性人员处于站立状态"),
          // 旧逻辑只取"有没有车", 有人站着也被整条按"无车"记录不推送 → 漏报(18:0x 菜地站人实测)。
          // 用 judgePerson 从回答中提取人形判定: 有人 → personFromVeh=true, 后续按人员活动推送。
          const r = await analyzeImageAI(path.join(ROOT, "captures", fname), vehPrompt);
          aiTxt = r.content || "";
          const jVeh = aiTxt ? judgePerson(aiTxt) : null;
          if (jVeh && jVeh.matched && jVeh.person) personFromVeh = true;
          // 把车辆AI结论(含人形判定)写回记录
          if (aiTxt) {
            await mutateEvents(function (evts) {
              const rec = evts.find(function (e) { return e.file === fname; });
              if (rec) { rec.ai = aiTxt; if (jVeh && jVeh.matched) rec.person = jVeh.person; if (r.provider) rec.provider = (rec.provider === "本地算法") ? ("本地算法+" + aiProviderLabel(r.provider)) : aiProviderLabel(r.provider); return true; }
              return false;
            });
          }
        } else if (localHit) {
          // 本地人形命中事件: mota(阿里备用)单链复核 —— 2026-09-30 起按用户要求移除 Agnes 双AI交叉。
          // 旧规则"任一判有人即有人"实测被 Agnes 的光影误判劫持(9-30 12:42/13:04 两次: mota判无人、
          // Agnes误判有人 → 结论有人, 空画面标红"有人"); mota 校准 4/4 且卡片文案本就取 mota 的,
          // 单链判定后徽章与文字天然一致。判读失败(aiTxt空)时照旧放行, 不确定不拦防漏报。
          const r = await analyzeImageAI(path.join(ROOT, "captures", fname), hitPrompt);
          aiTxt = r.content || "";
          if (aiTxt) {
            const jHit = judgePerson(aiTxt);
            await mutateEvents(function (evts) {
              const rec = evts.find(function (e) { return e.file === fname; });
              if (rec) {
                rec.ai = aiTxt;
                // 仅在结论可解析时回写person: 读不懂时推送是放行的, 徽章保持与推送一致(有人), 不标无人
                if (jHit.matched) rec.person = jHit.person;
                if (r.provider) rec.provider = (rec.provider === "本地算法") ? ("本地算法+" + aiProviderLabel(r.provider)) : aiProviderLabel(r.provider);
                return true;
              }
              return false;
            });
            console.log("[AI复核] 本地命中事件单链判定(" + aiProviderLabel(r.provider) + "): " +
              String(aiTxt).replace(/\s+/g, " ").slice(0, 80) + " => " + (jHit.matched ? (jHit.person ? "有人" : "无人") : "未识别(放行)"));
          }
        } else {
          aiTxt = await analyzeAndStore(fname);
        }
      } catch (eAi) { console.log("[AI] 自动判读失败: " + eAi.message); }
    }
    // 本地车辆检测(零API消耗): 对本次高清图做人车区分, 命中则推送标题标注"驾车/骑车经过"
    // (refs 由人形本地检测维护; 车型问询交给云端AI, 本地只做前置标记)
    // localVehHit=true 的车辆事件不用再跑(上游已判定过)
    if (vehEnabledFor(serial) && fname && !localVehHit) {
      try {
        const vr = await vehicledetect.analyzeFrame(ROOT, serial, path.join(ROOT, "captures", fname));
        if (vr && vr.vehicleLike) {
          localVeh = true;
          console.log("[车辆检测] ★ 命中车辆特征: " + devName + " 面积占" + (vr.top.area / vehicledetect.PX0 * 100).toFixed(1) +
            "% 高宽比" + vr.top.aspect.toFixed(2) + " 水平边" + vr.top.hEdge.toFixed(2) + (vr.bigMask ? " [大mask场景]" : "") + " (" + vr.ms + "ms)");
          // 回写 events.json: 给刚入库的记录打 veh 标记(看板/历史可区分"驾车经过")
          await mutateEvents(function (evts) {
            const rec = evts.find(function (e) { return e.file === fname; });
            if (rec) { rec.veh = 1; return true; }
            return false;
          });
        }
      } catch (eVeh) { console.log("[车辆检测] 分析失败: " + eVeh.message.slice(0, 60)); }
    }
    // 无人/异常判定: 统一走 lib/judge.js(唯一实现)。
    // 原实现 /【无人】/ || /^\s*无人/ 缺 m 标志且靠子串匹配, 会把"没有人""未见人员活动"判成有人误推。
    // matched=false 表示 AI 输出格式漂移、结论没读懂 —— 此时**不拦截**(照原策略按"可能有人"推送),
    // 避免格式漂移导致漏报, 同时打警告便于发现。
    const aiJudge = aiTxt ? judgePerson(aiTxt) : null;
    // 萤石设备端自带AI结论(智能侦测/人形检测回传的 textMsg, 形如"无人。画面展示…"/"有人。画面…"):
    // 我们自己的AI(analyzeAndStore)在推送链路里若调用失败(aiTxt为空), 原逻辑会退化为"来啥推啥",
    // 于是设备已明确回报"无人"的消息也被推出去(用户反馈的"无人的推送")。这里把设备端结论也纳入门控,
    // 只要任一来源明确判无人且无异常描述, 就只入看板不推送——不再依赖我们AI在线。
    const devJudge = textMsg ? judgePerson(textMsg) : null;
    // 车辆事件门控(2026-09-29 改为AI确认制): 本地算法只做免费预筛, 命中后用**同一张图**跑车辆
    // 复核AI, AI明确说没车(vehVerdictFromAi="no")才拦, 未表态/渠道全失败仍放行(不确定不拦防漏报)。
    // 依据: 实测 DeepSeek-V4.1-Flash 对生产同款车辆prompt 4/4 准确(含人骑车), 旧"AI认不出车"
    // 的前提已不成立; 且此前推的"检测到有车"里 38% AI明确说没车, 多为图错位+误报, 用户要求AI把关。
    // 回退开关: config.json → vehicleDetect.aiConfirm=false 恢复旧B方案(本地命中即推)。
    // 误报控制靠: AI确认 + 微信侧30分钟2条限流 + 180秒设备冷却
    // 本地命中(人形/车辆)事件的AI门控:
    //   · 人形命中: mota(阿里备用)明确判无人才拦, 读不懂/渠道全失败都放行
    //   · 车辆命中: AI确认制 —— vehVerdictFromAi明确说"no"才拦, 其余放行(见上)
    // 2026-09-26 事故链: 单AI误判树影->已修; 但全拦又会漏掉"远处真人"(09:26 事故) -> 用双AI折中
    const noPerson = (localVehHit)
      ? (VEH_AI_CONFIRM && vehVerdictFromAi(aiTxt) === "no" && !personFromVeh)
      : (localHit
        ? (aiJudge && aiJudge.matched && !aiJudge.person)
        : ((aiJudge && aiJudge.matched && !aiJudge.person) || (devJudge && devJudge.matched && !devJudge.person)));
    // AI结论里的异常关键词: 即使判了无人, 提到"异常/闯入"等仍值得推
    const hasAbnormal = (aiJudge && aiJudge.abnormal) || (devJudge && devJudge.abnormal);
    if (aiJudge && !aiJudge.matched) {
      console.log("[萤石推送] ⚠ AI结论无法解析(依据=" + aiJudge.source + ")，改以设备端结论做门控: " + String(aiTxt).replace(/\s+/g, " ").slice(0, 60));
    }
    // 明确判无人且无异常描述 → 只入看板不推送: 设备端人形检测误报多(风吹草动也报), 二道把关仍推"无人"会狼来了。
    // 任一来源(我们AI / 萤石设备端)判无人即可拦截; 两边都读不懂时才放行, 保留"不确定就不漏报"的安全网。
    // 车辆事件的拦截已在上面 noPerson 里按"有车/无车"判定; AI 没跑通(aiTxt空)时不拦截, 保留"不确定不拦"的安全网。
    // 车辆确认路径不受"异常关键词"豁免: AI被问的是车, "无其他异常"是拒绝套话而非异常线索 ——
    // 否则AI明确说没车, 却因文本含"异常"二字触发豁免照推(2026-09-29 18:36 空院子误报车实测踩坑)
    // 人形命中(单链): mota(阿里备用)明确判无人 → 拦; 读不懂/AI全挂 → 放行(不确定不拦防漏报)。
    // 2026-09-30 移除 Agnes 双AI交叉: 旧"任一判有人即有人"被 Agnes 光影误判劫持(9-30 12:42/13:04 实测)
    if (noPerson && (localVehHit || !hasAbnormal)) {
      const src = localVehHit ? "AI车辆确认(明确说没车)" : (localHit ? "AI(mota判无人)" : ((devJudge && devJudge.matched && !devJudge.person) ? "设备端" : "AI"));
      console.log("[萤石推送] 判定无人(来源:" + src + ")，仅记录看板不推送: " + devName + " " + alarmTime);
      // 参考图反馈刷新(2026-09-29 校准): AI确认此帧无人无车 → 这就是干净的当前背景, 拿它刷新帧差
      // 参考图。双溪村场景光照变化快, ref 过时是帧差失真的主因(傍晚 25 分钟前的 ref 差异达 60~72%,
      // 巨型blob要么吞掉真车=漏报, 要么把光影变成"像车的块"=误报)。让背景跟随光照可同时降漏报与误报。
      // 只在 AI 明确判"无人"且"无车"时刷新, 保证不会把人/车烙进背景。
      try {
        const jRef = aiJudge && aiJudge.matched ? aiJudge : null;
        const clearFrame = fname && (!localVehHit || vehVerdictFromAi(aiTxt) === "no") &&
          (!jRef || jRef.person === false) && (!devJudge || !devJudge.matched || devJudge.person === false);
        if (clearFrame) {
          motiondetect.refreshRefFrom(ROOT, serial, path.join(ROOT, "captures", fname))
            .then(function () { console.log("[萤石推送] 已用AI确认的干净帧刷新背景参考图: " + serial); })
            .catch(function () {});
        }
      } catch (eRef) {}
      return;
    }
    // 同一次活动只推一条 —— 入库时的 90 秒窗口挡不住持续更久的活动。
    // 实测(2026-09-14 17:57:31 / 17:59:24 木山村): 萤石对同一次两人经过断续推了两条人形检测,
    // 间隔 113 秒 > 90 秒窗口, 第二条被当成"新活动"再次入库并再次推送 —— 用户收到两条通知
    // (第一条走 Agnes、第二条 Agnes 超时 fallback 到 GLM-4v, 所以微信里看到两个不同模型的结论)。
    // 更糟的是重复推送会吃光 30 分钟限流额度(默认 2 条), 真来了新活动反而被拦。
    // 这里按"同设备 + 该窗口内已有成功推送过的记录"再拦一道: 记录照常入看板保留轨迹, 只是不再打扰。
    var pushDedupMs = (Number((cfg.push || {}).sameActivityPushSec) > 0 ? Number(cfg.push.sameActivityPushSec) : 300) * 1000;
    var pushedNearby = evts.some(function (e) {
      return e.source !== "kanjia" && e.serial === serial && e.pushed === true &&
        Math.abs((e.ts || 0) - evTs) < pushDedupMs;
    });
    if (pushedNearby) {
      console.log("[萤石推送] 同设备 " + Math.round(pushDedupMs / 1000) + " 秒内已推送过同一次活动，仅记录看板不重复推送: " + devName + " " + alarmTime);
      return;
    }
    // 本地命中事件的独立节流: 同设备 60 分钟内最多因"本地算法命中"推 1 条。
    // 背景: 本地误报(树影/光影 1.7%) + AI 复核波动 -> 2026-09-26 一小时内误推 2 次;
    // 真人活动的告警价值不会因 60 分钟间隔而损失(同一活动 300 秒 dedup 已挡重复),
    // 但树影/光影的反复触发会被这个窗口压掉。设备端人形检测推送不受此限制。
    if (localHit || localVehHit) {
      const localPushWin = 60 * 60e3;
      const localPushedNearby = evts.some(function (e) {
        return e.source !== "kanjia" && e.serial === serial && e.pushed === true &&
          (e.provider || "").indexOf("本地算法") >= 0 &&
          Math.abs((e.ts || 0) - evTs) < localPushWin;
      });
      if (localPushedNearby) {
        console.log("[萤石推送] 同设备 60 分钟内已推送过本地命中事件，本次仅记录看板: " + devName + " " + alarmTime);
        return;
      }
    }
    // 无图人形事件不盲推(2026-10-07.53): 旧流程无图也照推"有人员活动+AI未判读"(10-07 12:56 实测:
    // 9048退避+20008设备超时抓图三连失败, 推出去既没照片也没结论)。抓图失败多为瞬态, 60秒后多已
    // 恢复 —— 交给 scheduleNoPicRecapture: 补到图→补跑AI→判有人/读不懂才带图推送, AI判无人只记录。
    // 补拍也失败则按旧行为无图放行(不确定不拦防漏报)。commit.written=false 说明入库失败没有事件,
    // 维持旧行为照推, 避免补拍链路找不到事件把报警弄丢。
    if (!fname && commit.written && (isPersonType || personByText)) {
      console.log("[萤石推送] 人形事件未取到图, 60秒后补拍再判再推(不盲推): " + devName + " " + alarmTime);
      scheduleNoPicRecapture(serial, evTs, devName);
      return;
    }
    // 语义化标题: 含设备名, 去掉"⚠️老家"等冗余前缀; 称呼(亲爱的东哥等)由 dear() 在发送时自动加在 first 前
    // localHit 时标注【本地算法】, 让家人知道这条是本地视觉算法(非萤石设备端/非云端AI)抓到的
    // localVeh/localVehHit 时标注【驾车/骑车】, 车型由云端AI复核后体现在kw3结论里
    let firstLine;
    const localTag = (localHit || localVehHit) ? "【本地算法】" : "";
    const vehTag = (!personFromVeh && (localVeh || localVehHit)) ? "【驾车/骑车】" : "";
    if (localVehHit && !localHit) {
      // AI在车辆复核中发现了人 → 按人员活动推送(车辆判"无车"时不再谎报"有车辆经过")
      if (personFromVeh) firstLine = localTag + "检测到" + devName + "有人员活动";
      else firstLine = localTag + vehTag + (aiTxt ? "检测到" + devName + "有车辆经过" : "检测到" + devName + "疑似有车辆经过");
    } else if (aiTxt) {
      firstLine = localTag + vehTag + (noPerson ? ("检测到" + devName + "画面异常，AI提示需关注") : ("检测到" + devName + "有人员活动"));
    } else if (isPersonType || personByText) {
      firstLine = localTag + vehTag + "检测到" + devName + "有人员活动";
    } else {
      firstLine = localTag + "检测到" + devName + "有移动侦测";
    }
    // 推送链接必须兜底到"一定有响应"的地址。
    // 事故(2026-09-12 07:32): IntelligentTag人形标签本身不带图, 复用同活动报警存图与兜底抓图又双双失败,
    //   于是 fname="" 且 picUrl="" -> 模板消息 url 传空串。微信对空 url 的模板消息**点击无任何跳转**,
    //   用户看到的就是"点了没反应"。三层兜底: 本事件图 -> 萤石原图 -> 看板今日页。
    //   pubBase 也没有时(隧道未开)宁可不给 url, 但文案如实说明, 不让用户以为点得动。
    let detailUrl = "";
    // pubBase 为空(花生壳未开)时不给url —— 相对路径发给微信"点了没反应"(2026-09-29审查:
    // 原来fname分支没判pubBase, 会把"/detail?file=.."这种相对路径塞进模板消息)
    if (fname && pubBase) detailUrl = tokUrl(pubBase + "/detail?file=" + encodeURIComponent(fname));
    else if (picUrl) detailUrl = picUrl;
    else if (pubBase) detailUrl = tokUrl(pubBase + "/today" + (serial ? "?serial=" + encodeURIComponent(serial) : ""));
    const pushRemark = detailUrl
      ? (fname || picUrl ? "点击查看现场照片与 AI 分析 👉" : "本次未取到照片，点击查看今日记录 👉")
      : ((fname || picUrl)
        ? "已拍到现场照片，内网穿透未开启暂点不开，稍后可在电脑看板查看"
        : "本次未取到照片（内网穿透未开启）");
    // 卡片增强字段(需在测试号模板内容里补对应占位符才会显示, 没加也不报错):
    // keyword3 = AI 结论摘要(带 emoji 标识有人/无人); keyword4 = 报警类型; keyword5 = 现场照片状态。
    let kw3 = "";
    if (aiTxt) {
      if (localVehHit && !personFromVeh) {
        // 车辆事件(AI确认有车): kw3 如实展示车辆复核结论
        const vLines = String(aiTxt).split(/\r?\n|[。；]/).map(function (s) { return s.trim(); }).filter(Boolean);
        const vehLine = vLines.filter(function (l) { return /汽车|轿车|面包车|货车|三轮车|摩托车|电动车|踏板车|车辆|车子/.test(l); })[0];
        const vHead = "🚗 本地检测到车";
        kw3 = (vHead + (vehLine ? "：" + vehLine.slice(0, 20) : (aiTxt ? "：" + String(aiTxt).replace(/\s+/g, " ").slice(0, 18) : ""))).slice(0, 30);
      } else if (localHit || (localVehHit && personFromVeh)) {
        // 本地人形命中(或车辆复核中发现了人): 直接展示AI结论
        kw3 = String(aiTxt).replace(/\s+/g, " ").slice(0, 30);
      } else {
        const lines = String(aiTxt).split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
        const head = (aiJudge && aiJudge.matched) ? (aiJudge.person ? "🟢 有人" : "⚪ 无人") : (lines[0] || "结论未识别").slice(0, 8);
        const why = (lines.filter(function (l) { return l.indexOf("依据") >= 0; })[0] || "")
          .replace(/^依据[:：]?\s*/, "").split(/[，。；！？]/)[0].replace(/[，。；！？]$/, "").slice(0, 16);
        kw3 = (head + (why ? "：" + why : "")).slice(0, 30);
      }
    } else {
      kw3 = "⏳ AI未判读，详见看板";
    }
    const kw4 = (localVehHit && !personFromVeh) ? "车辆检测(本地算法)" : (personFromVeh ? "人形检测(AI)" : (typeName || (isPersonType || personByText ? "人形检测" : "移动侦测")));
    const kw5 = fname ? "✅ 有现场照片" : "❌ 未取到照片";
    // 活动推送占位(2026-09-30): 同一活动的第二条消息在第一条推送尚未完成时到达, 旧判重只认
    // person===true, 车辆事件(不判人)person=false 挡不住 —— 同一辆电动车经过推出两条(9-30
    // 15:52:31车辆+15:52:32人形), 占满30分钟限流窗口的2个名额, 19分钟后真实的第二次经过
    // (16:11)反被限流拦掉。入库即打pushPending占位: 判重视为"该活动已打扰过"; 推送成功转
    // pushed=true, 全部失败清除占位(该活动后续消息可重试推送)。
    await mutateEvents(function (arr) {
      var t = fname ? arr.find(function (e) { return e.file === fname; }) : null;
      if (!t) t = arr.find(function (e) { return e.source !== "kanjia" && e.serial === serial && Math.abs((e.ts || 0) - evTs) < 90e3; });
      if (!t || t.pushed === true || t.pushPending === true) return false;
      t.pushPending = true;
      return true;
    });
    pushTestTemplate(
      firstLine,
      alarmTime,
      devName,
      pushRemark,
      detailUrl,
      false,
      { serial: serial, alarm: true, kw3: kw3, kw4: kw4, kw5: kw5 }  // alarm=true: 应用推送时段限制(名单内openid只在 config.push.timeWindow.windows 各时段内推, 当前为10~12/14~20); 按设备所属村过滤推送对象(双溪村组只收双溪村/同事组不收); kw3/kw4/kw5: 卡片显示的AI结论/报警类型/照片状态
    ).then(function (ok) {
      // 真正送达过才标记"已推送" —— 全部被时段/分组/限流跳过时(ok=0)不标记且清除占位,
      // 后续同活动的消息仍有机会送达, 不会因为一次谁都没收到就永久静默。
      if (ok > 0) markEventPushed(serial, evTs, fname);
      else clearPushPending(serial, evTs, fname);
    }).catch(function () { clearPushPending(serial, evTs, fname); });
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
const AI_PROVIDER_LABELS = { mota: "魔塔DeepSeek", ali: "阿里DeepSeek", agnes: "Agnes", xiaohongshu: "小红书" };
function aiProviderLabel(name) { return AI_PROVIDER_LABELS[name] || String(name || ""); }

// 返回 { content, provider }。provider 必须带出来 —— 以前只返回文本, 于是"自动分析"过的记录
// provider 一直是空串, 看板无法区分「AI 判定有人」与「萤石设备端人形标签直通(从没跑过 AI)」,
// 两种记录都顶着同一个红色"有人", 看起来都像 AI 的结论(2026-09-12 东哥反馈的误报之一)。
// 调用 lib/ai.js 的统一 AI 分析: 含大图压缩 + 渠道冷却 + 故障切换
// 不再内联 implement, 修复 monitor 路径有压缩而 webhook 路径缺压缩的不一致
async function analyzeImageAI(file, promptOverride) {
  const r = await analyzeImage(cfg.ai, file, promptOverride);
  if (r.ok) return { content: r.content, provider: r.provider };
  console.log("[AI] 所有渠道均失败: " + (r.reason || ""));
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
        // 本地算法先入库的(provider="本地算法"), 不覆盖而是拼接, 保留来源信息
        if (r.provider) {
          const aiLabel = aiProviderLabel(r.provider);
          rec.provider = (rec.provider === "本地算法") ? ("本地算法+" + aiLabel) : aiLabel;
        }
        return true;
      });
    }
    return txt;
  } finally { delete _aiFlight[baseName]; }
}

// ---------- 无图人形事件补拍链路(2026-10-07.53) ----------
// 主链路抓图三连失败(报警无自带截图+垫图找不到+高清截帧挂)时, 人形事件不再盲推, 改由这里接管:
// 60秒后补拍(设备/取流配额瞬态多已恢复) → 图回写事件 → 补跑AI → AI判有人或读不懂才带图推送,
// AI明确判无人且无异常描述则只记录(与主链路 noPerson 门控语义一致)。补拍也失败 → 按旧行为
// 无图放行推送(不确定不拦防漏报)。只负责这一条事件, 不做二次判重(90秒/300秒窗口主链路已挡)。
const _noPicRetry = {}; // "serial@ts" -> true, 同一事件只调度一次; 键10分钟后回收防泄漏
function scheduleNoPicRecapture(serial, evTs, devName) {
  const key = serial + "@" + evTs;
  if (_noPicRetry[key]) return;
  _noPicRetry[key] = true;
  setTimeout(function () { delete _noPicRetry[key]; }, 10 * 60 * 1000);
  setTimeout(async function () {
    let fname2 = "";
    try {
      const rec = loadEventsArr().find(function (e) {
        return e.source !== "kanjia" && e.serial === serial && Math.abs((e.ts || 0) - evTs) < 90e3;
      });
      if (!rec) return; // 事件不在了(异常情况), 无事可做
      if (rec.pushed) return; // 保险: 已推送过就不重复打扰
      if (rec.file) {
        // 60秒窗口内同活动消息(锁内复查路径)已把图补上 → 直接复用, 省一次抓图配额
        fname2 = rec.file;
        console.log("[补拍] 事件已有图(同活动消息补上), 直接补跑AI: " + devName + " " + fname2);
      } else {
        fname2 = serial + "_" + Date.now() + ".jpg";
        await hdcapture.captureHD(client, serial, path.join(ROOT, "captures", fname2));
        const w = await mutateEvents(function (arr) {
          const t = arr.find(function (e) {
            return e.source !== "kanjia" && e.serial === serial && Math.abs((e.ts || 0) - evTs) < 90e3 && !e.file;
          });
          if (!t) return false;
          t.file = fname2;
          return true;
        });
        if (!w || !w.written) {
          try { fs.unlinkSync(path.join(ROOT, "captures", fname2)); } catch (eU) {}
          console.log("[补拍] 已无对应无图记录(可能被并发消息处理), 放弃补拍: " + devName);
          return;
        }
        ensureThumbFile(fname2);
        console.log("[补拍] 无图事件补拍成功: " + devName + " -> " + fname2);
      }
      // 补跑AI判读(无图事件主链路必然没跑过AI)
      let aiTxt2 = "";
      if ((cfg.ai || {}).enabled && (cfg.ai || {}).autoAnalyze !== false) {
        try { aiTxt2 = await analyzeAndStore(fname2); }
        catch (eAi) { console.log("[补拍] AI补判失败(按不确定放行): " + String(eAi.message).slice(0, 60)); }
      }
      const j2 = aiTxt2 ? judgePerson(aiTxt2) : null;
      if (j2 && j2.matched && !j2.person && !j2.abnormal) {
        console.log("[补拍] 补拍帧AI判无人(来源:" + j2.source + ")，仅记录看板不推送: " + devName);
        return;
      }
      // 带图推送(AI判有人/读不懂/渠道失败都放行 —— 与主链路"不确定不拦"一致)
      const lines2 = String(aiTxt2 || "").split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
      const head2 = aiTxt2 ? ((j2 && j2.matched) ? (j2.person ? "🟢 有人" : "⚪ 无人") : (lines2[0] || "结论未识别").slice(0, 8)) : "";
      const why2 = (lines2.filter(function (l) { return l.indexOf("依据") >= 0; })[0] || "")
        .replace(/^依据[:：]?\s*/, "").split(/[，。；！？]/)[0].replace(/[，。；！？]$/, "").slice(0, 16);
      const kw3b = aiTxt2 ? ((head2 + (why2 ? "：" + why2 : "")).slice(0, 30)) : "⏳ AI未判读，详见看板";
      const pubBase2 = String(((cfg.wxTest || {}).publicBase) || "").replace(/\/$/, "");
      const detailUrl2 = pubBase2 ? tokUrl(pubBase2 + "/detail?file=" + encodeURIComponent(fname2)) : "";
      console.log("[补拍] 补拍判定推送: " + devName + " AI=" + (j2 && j2.matched ? (j2.person ? "有人" : "无人") : (aiTxt2 ? "未识别" : "未判读")));
      pushTestTemplate(
        "检测到" + devName + "有人员活动",
        new Date(evTs).toLocaleString("zh-CN", { hour12: false }),
        devName,
        (detailUrl2 ? "点击查看现场照片与 AI 分析 👉" : "已拍到现场照片，内网穿透未开启暂点不开，稍后可在电脑看板查看"),
        detailUrl2,
        false,
        { serial: serial, alarm: true, kw3: kw3b, kw4: "人形检测(补拍)", kw5: "✅ 有现场照片" }
      ).then(function (ok) {
        if (ok > 0) markEventPushed(serial, evTs, fname2);
        else clearPushPending(serial, evTs, fname2);
      }).catch(function () { clearPushPending(serial, evTs, fname2); });
    } catch (e) {
      // 补拍/判读整链失败: 回退旧行为 —— 无图也放行推送(不确定不拦防漏报)
      console.log("[补拍] 60秒后补拍仍失败(" + devName + "): " + String(e.message).slice(0, 80) + " -> 按旧行为无图放行推送");
      try {
        const pubBase3 = String(((cfg.wxTest || {}).publicBase) || "").replace(/\/$/, "");
        const detailUrl3 = pubBase3 ? tokUrl(pubBase3 + "/today?serial=" + encodeURIComponent(serial)) : "";
        pushTestTemplate(
          "检测到" + devName + "有人员活动",
          new Date(evTs).toLocaleString("zh-CN", { hour12: false }),
          devName,
          (detailUrl3 ? "本次未取到照片，点击查看今日记录 👉" : "本次未取到照片（内网穿透未开启）"),
          detailUrl3,
          false,
          { serial: serial, alarm: true, kw3: "⏳ AI未判读，详见看板", kw4: "人形检测", kw5: "❌ 未取到照片" }
        ).then(function (ok) {
          if (ok > 0) markEventPushed(serial, evTs, "");
          else clearPushPending(serial, evTs, "");
        }).catch(function () { clearPushPending(serial, evTs, ""); });
      } catch (ePush) {
        console.log("[补拍] 兜底推送也失败: " + String(ePush.message).slice(0, 60));
      }
    }
  }, 60 * 1000);
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
    // 配额耗尽时直接跳过
    if (isQuotaExhausted()) {
      console.log("[昵称] API配额已耗尽，跳过刷新关注者昵称");
      return;
    }
    
    const cache = _nickCache || (_nickCache = loadNickCache());
    if (!force && Date.now() - (cache.at || 0) < 3600e3) return; // 1小时内不重复拉取
    
    let token = await wxTestToken();
    let ur = await fetch("https://api.weixin.qq.com/cgi-bin/user/get?access_token=" + token + "&next_openid=", { signal: AbortSignal.timeout(10000) });
    let uj = await ur.json();
    
    // 检测配额错误
    if (uj.errcode === 45009) {
      markQuotaExhausted();
      return;
    }
    
    if (isTokErr(uj.errcode)) {
      token = await wxTestToken(true);
      ur = await fetch("https://api.weixin.qq.com/cgi-bin/user/get?access_token=" + token + "&next_openid=", { signal: AbortSignal.timeout(10000) });
      uj = await ur.json();
      
      // 重试后再次检测配额错误
      if (uj.errcode === 45009) {
        markQuotaExhausted();
        return;
      }
    }
    
    const openids = (uj.data && uj.data.openid) || [];
    
    // 只获取新增用户的昵称，避免重复调用
    const newOpenids = openids.filter(oid => !cache.map[oid]);
    if (newOpenids.length === 0) {
      cache.at = Date.now();
      saveNickCache(cache);
      console.log("[" + new Date().toLocaleTimeString() + "] [昵称] 无新增关注者，跳过昵称获取");
      return;
    }
    
    console.log("[昵称] 发现 " + newOpenids.length + " 个新增关注者，开始获取昵称...");
    
    // 并发限制：每次最多同时请求 3 个，避免触发限流
    const CONCURRENCY_LIMIT = 3;
    let successCount = 0;
    let quotaExhausted = false;
    
    for (let i = 0; i < newOpenids.length; i += CONCURRENCY_LIMIT) {
      // 配额耗尽时停止
      if (quotaExhausted || isQuotaExhausted()) {
        console.log("[昵称] API配额耗尽，停止获取剩余昵称");
        break;
      }
      
      const batch = newOpenids.slice(i, i + CONCURRENCY_LIMIT);
      const promises = batch.map(async (oid) => {
        try {
          const ir = await fetch("https://api.weixin.qq.com/cgi-bin/user/info?access_token=" + token + "&openid=" + oid + "&lang=zh_CN", { signal: AbortSignal.timeout(10000) });
          const ij = await ir.json();
          
          // 检测配额错误
          if (ij.errcode === 45009) {
            markQuotaExhausted();
            quotaExhausted = true;
            return;
          }
          
          if (ij.nickname) {
            cache.map[oid] = ij.nickname;
            successCount++;
          }
        } catch (e1) {
          // 单个请求失败不影响其他请求
        }
      });
      
      await Promise.all(promises);
      
      // 每批次之间延迟 200ms，避免触发限流
      if (i + CONCURRENCY_LIMIT < newOpenids.length) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    
    cache.at = Date.now();
    saveNickCache(cache);
    console.log("[" + new Date().toLocaleTimeString() + "] [昵称] 关注者缓存 " + Object.keys(cache.map).length + "/" + openids.length + "，本次新增 " + successCount + " 个");
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
// 推送时段限制(config.push.timeWindow): 名单内openid只在 windows 各时段收到推送(其余时段静默不推)
// windows 支持多时段 [{startHour,endHour},...]; 兼容旧的单时段 startHour/endHour 写法
// inclusiveEnd: 日报专用 —— 定时日报在 reportHour(默认20:00) 整点后触发, 若按严格 [start,end) 判定,
// endHour=20 时名单内用户永远收不到日报, 故日报把 endHour 整点这一小时也算在窗内
function inPushTimeWindow(openid, inclusiveEnd) {
  const W = (cfg.push && cfg.push.timeWindow) || null;
  if (!W || !Array.isArray(W.openids) || W.openids.indexOf(openid) < 0) return true; // 不在名单不限制
  const wins = (Array.isArray(W.windows) && W.windows.length) ? W.windows
    : (W.startHour != null ? [{ startHour: W.startHour, endHour: W.endHour }] : []);
  if (!wins.length) return true;
  const h = new Date().getHours();
  for (const w of wins) {
    const s = Number(w.startHour) || 0, e = Number(w.endHour) || 24;
    if (h >= s && (h < e || (inclusiveEnd && h === e))) return true;
  }
  return false;
}
// 报警免推名单(config.push.alarmDisabled): 名单内 openid 不收报警推送。
// 与分组 push:"none" 的区别 —— 仅屏蔽实时报警, 每日日报/查询/菜单权限均不受影响。
// 支持两种写法: ["openid1",...] 或 { openids: ["openid1",...] }
function isAlarmDisabled(openid) {
  const raw = cfg.push && cfg.push.alarmDisabled;
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.openids) ? raw.openids : []);
  return list.indexOf(openid) >= 0;
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
    const f = path.join(ROOT, "data", "push_audit.txt");
    fs.appendFileSync(f, line);
    // 轮转: 超过 1MB 时截断保留后半部分, 防止文件无限增长
    try {
      const st = fs.statSync(f);
      if (st.size > 1024 * 1024) {
        const buf = fs.readFileSync(f);
        fs.writeFileSync(f, buf.slice(buf.length - 512 * 1024));
      }
    } catch (e) {}
  } catch (e) {}
}

// 把"该事件已成功推送"回写进 events.json，供推送层做"同一次活动只推一条"的去重。
// 历史问题: pushed 字段建了却从来没写过，一直是 false —— 于是无法判断"这件事是否已经打扰过用户"，
// 只能在入库时用 90 秒窗口挡一次，一旦活动持续超过窗口就必然重复推送(2026-09-14 东哥反馈)。
async function markEventPushed(serial, ts, file) {
  try {
    await mutateEvents(function (arr) {
      var t = null;
      if (file) t = arr.find(function (e) { return e.file === file; });
      if (!t) t = arr.find(function (e) { return e.serial === serial && e.ts === ts; });
      // 兜底: "补图到已有记录"分支下本次没有新增记录, ts 对不上, 按同设备时间最近的一条认领
      if (!t) t = arr.slice().reverse().find(function (e) {
        return e.source !== "kanjia" && e.serial === serial && Math.abs((e.ts || 0) - ts) < 90e3;
      });
      if (!t || t.pushed === true) return false;
      t.pushed = true;
      delete t.pushPending;
      return true;
    });
  } catch (e) {}
}
// 推送全部失败(或异常)时清除推送占位: 该活动后续消息仍可重试推送(定位逻辑与markEventPushed一致)
async function clearPushPending(serial, ts, file) {
  try {
    await mutateEvents(function (arr) {
      var t = null;
      if (file) t = arr.find(function (e) { return e.file === file; });
      if (!t) t = arr.find(function (e) { return e.serial === serial && e.ts === ts; });
      if (!t) t = arr.slice().reverse().find(function (e) {
        return e.source !== "kanjia" && e.serial === serial && Math.abs((e.ts || 0) - ts) < 90e3;
      });
      if (!t || t.pushPending !== true) return false;
      t.pushPending = false;
      return true;
    });
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
  
  // 配额耗尽时直接跳过
  if (!force && isQuotaExhausted()) {
    console.log("[测试号推送] API配额已耗尽，跳过本次推送");
    return 0;
  }
  
  const throttle = force ? null : loadThrottle();
  const th = pushThrottleCfg();
  const now = Date.now();
  opt = opt || {};
  try {
    // 使用缓存的用户列表
    const openids = await fetchOpenids();
    if (!openids.length) {
      console.log("[测试号推送] 关注者列表为空，跳过推送");
      return 0;
    }
    
    let token = await wxTestToken();
    const serialScope = opt.serial;   // 仅向可接收该设备的 openid 推送(分组)
    const allowOid = opt.allowOid;    // 仅向白名单 openid 推送(日报按组分发)
    let ok = 0, skipped = 0, scoped = 0, attempted = 0, muted = 0;
    const errs = [];
    let templateInvalid = false; // 模板无效标记
    
    for (const oid of openids) {
      // 分组白名单(日报按组分发): 不在名单直接跳过
      if (allowOid && !allowOid(oid)) { scoped++; continue; }
      // 按设备所属村过滤(如双溪村组只能收双溪村报警; 同事组 push=none 全程被拦)
      if (serialScope && !canPushTo(oid, serialScope)) { scoped++; continue; }
      // 报警免推名单(config.push.alarmDisabled): 仅屏蔽实时报警, 日报/查询不受影响
      if (opt.alarm && isAlarmDisabled(oid)) { muted++; continue; }
      // 推送时段限制: 报警(alarm=true)严格按 [start,end); 日报(dailyReport=true)把 endHour 整点计入(20:00定时日报)
      if ((opt.alarm || opt.dailyReport) && !inPushTimeWindow(oid, opt.dailyReport === true)) { scoped++; continue; }
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
                remark: { value: remark || "点击本消息可查看现场照片" },
                // 新版微信"服务通知"对模板消息只渲染 模板标题+keyword字段+详情, first/remark 不显示
                // (2026-09-14 东哥反馈推送卡片太秃)。keyword3/4 由 opt 传入(AI结论/报警类型)。
                // 模板内容里还没加 {{keyword3.DATA}}/{{keyword4.DATA}} 占位符时微信会忽略多余字段, 不报错,
                // 所以代码可以先上、模板后改, 互不阻塞。
                keyword3: opt.kw3 ? { value: String(opt.kw3).slice(0, 30) } : undefined,
                keyword4: opt.kw4 ? { value: String(opt.kw4).slice(0, 20) } : undefined,
                keyword5: opt.kw5 ? { value: String(opt.kw5).slice(0, 20) } : undefined
              }
            }),
            signal: AbortSignal.timeout(10000)
          });
          const rj = await res.json();
          
          // 检测配额错误
          if (rj.errcode === 45009) {
            markQuotaExhausted();
            errs.push(oid.slice(0, 8) + ":45009");
            console.log("[测试号推送] ⚠️ API配额耗尽，停止后续推送");
            break; // 跳出当前用户的重试循环
          }
          
          // 检测模板无效错误
          if (rj.errcode === 40037) {
            templateInvalid = true;
            errs.push(oid.slice(0, 8) + ":40037");
            console.log("[测试号推送] ⚠️ 模板ID无效(40037)，请检查 config.json 中的 templateId");
            break; // 跳出当前用户的重试循环
          }
          
          if (rj.errcode === 0) { ok++; if (throttle) { throttle[oid] = (Array.isArray(throttle[oid]) ? throttle[oid] : []).concat(now); } break; }
          errs.push(oid.slice(0, 8) + ":" + rj.errcode);
          console.log("[测试号推送] 失败 openid=" + oid.slice(0, 8) + "... err=" + rj.errcode + " " + rj.errmsg);
          if (att === 0 && isTokErr(rj.errcode)) { try { await new Promise(function(r){setTimeout(r,2000)}); token = await wxTestToken(true); continue; } catch (e2) { break; } }
          break;
        } catch (e) { errs.push(oid.slice(0, 8) + ":EXC"); break; }
      }
      
      // 如果配额耗尽或模板无效，停止后续用户的推送
      if (isQuotaExhausted() || templateInvalid) break;
    }
    
    if (openids.length) console.log("[测试号推送] 已推送 " + ok + "/" + openids.length + " 位关注者" + (skipped ? "，限频跳过 " + skipped + " 位(" + Math.round(th.windowMs / 60e3) + "分钟窗口已满" + th.max + "条)" : "") + (scoped ? "，分组过滤 " + scoped + " 位" : "") + (muted ? "，免推 " + muted + " 位(config.push.alarmDisabled)" : ""));
    auditPush(serialScope, ok, attempted, skipped, scoped, errs);
    if (throttle) saveThrottle(throttle);
    
    // 模板无效时不重试
    if (templateInvalid) {
      console.log("[测试号推送] 模板无效，跳过自动重试");
      return ok;
    }
    
    // 该设备本应送达却一个都没成功(网络/token抖动)：60秒后自动重试一次(仍受滑动窗口限流约束,重试本身不再递归)
    if (!force && !opt._isRetry && attempted > 0 && ok === 0 && !isQuotaExhausted()) {
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
          body: JSON.stringify({ touser: openid, msgtype: "text", text: { content: content } }),
          signal: AbortSignal.timeout(10000)
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
            body: JSON.stringify({ touser: openid, msgtype: "image", image: { media_id: mediaId } }),
            signal: AbortSignal.timeout(10000)
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
          }),
          signal: AbortSignal.timeout(10000)
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
    // 复用已有AI结论: 「看家」30秒缓存窗口内的重复查询、同一张图先后多次进入本函数时,
    // 不再重复烧AI(_aiFlight 只挡并发、不挡先后重放)。占位文案"(等待分析...)"/AI失败占位
    // 都以"("开头, 不算已有结论, 会照常重跑 —— 顺带保留了"AI失败后再查重试"的自愈路径。
    let cached = null;
    try { cached = loadEventsArr().find(function (e) { return e.file === path.basename(String(file || "")); }); } catch (e0) {}
    const cachedTxt = (cached && cached.ai && String(cached.ai).indexOf("(") !== 0) ? String(cached.ai) : "";
    const txt = cachedTxt || await analyzeAndStore(file);
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
    const picUrl = pub && fname ? tokUrl(pub + "/captures/" + encodeURIComponent(fname)) : "";
    const cardTitle = dear(openid) + (hasPerson ? "检测到" + devName + "有人员活动" : (jAi.matched ? devName + " 暂时未发现人员" : "检测到" + devName + "画面有变化"));
    const cardDesc = txt.replace(/\s+/g, " ").slice(0, 190);
    const linkUrl = pub && fname ? tokUrl(pub + "/detail?file=" + encodeURIComponent(fname)) : picUrl;
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
  "header{padding:14px 16px 10px;font-size:18px;font-weight:600;border-bottom:1px solid #23262d;position:sticky;top:0;background:#0f1115;z-index:9}" +
  ".meta{font-size:12px;color:#9aa0a6;font-weight:400;margin-top:2px}" +
  ".tags{display:flex;gap:6px;margin-top:8px}" +
  ".tags a{display:inline-block;padding:4px 12px;border-radius:14px;font-size:12px;font-weight:500;text-decoration:none;color:#9aa0a6;background:#23262d;border:1px solid transparent}" +
  ".tags a.on{color:#8ab4f8;background:#1a3a5c;border-color:#3a6a9c}" +
  ".card{display:flex;gap:10px;margin:10px 12px;padding:10px;background:#171a21;border-radius:12px;align-items:flex-start}" +
  ".card .ci{flex:1;min-width:0}" +
  ".card .thumb{flex-shrink:0;width:120px;height:80px;border-radius:6px;overflow:hidden;background:#0a0a0a;cursor:zoom-in;position:relative}" +
  ".card .thumb img{width:100%;height:100%;object-fit:cover;display:block}" +
  ".card .thumb .play-btn{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:24px;opacity:.7}" +
  ".row{display:flex;justify-content:space-between;margin-bottom:2px;font-size:13px}" +
  ".tm{color:#8ab4f8;font-weight:600}.dev{color:#9aa0a6}" +
  ".row2{display:flex;align-items:center;gap:6px;margin-top:4px;min-width:0}" +
  ".vd{flex-shrink:0;font-size:11px;font-weight:600;padding:1px 8px;border-radius:9px}" +
  ".vd-p{color:#ff6b6b;background:rgba(255,107,107,.16)}" +
  ".vd-n{color:#51cf66;background:rgba(81,207,66,.14)}" +
  ".brief{flex:1;min-width:0;font-size:12px;color:#cfd4da;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
  ".src{flex-shrink:0;font-size:10px;padding:1px 6px;border-radius:8px;color:#8ab4f8;background:rgba(138,180,248,.12);border:1px solid rgba(138,180,248,.25)}" +
  ".src-a{color:#ffa657;background:rgba(255,166,87,.1);border-color:rgba(255,166,87,.3)}" +
  ".lb{position:fixed;left:0;top:0;width:100%;height:100%;background:rgba(0,0,0,.96);z-index:99;display:none;align-items:center;justify-content:center;touch-action:none}.lb.show{display:flex}.lb img{max-width:100%;max-height:100%;-webkit-user-drag:none;user-select:none;transition:transform .15s ease}.lb-x{position:fixed;top:12px;right:14px;width:38px;height:38px;border-radius:19px;background:rgba(255,255,255,.18);color:#fff;font-size:22px;text-align:center;line-height:38px;z-index:100;cursor:pointer}.lb-t{position:fixed;left:0;right:0;bottom:16px;text-align:center;color:#fff;font-size:12px;opacity:.85;z-index:100}" +
  "</style></head><body>" +
  "<header>📋 今日人员活动<div class=\"meta\" id=\"sub\">加载中...</div>" +
  "<div class=\"tags\"><a href=\"?\" class=\"on\" id=\"tagAll\">全部</a><a href=\"?village=双溪村\" id=\"tagSX\">双溪村</a><a href=\"?village=木山村\" id=\"tagMS\">木山村</a></div></header>" +
  "<div id=\"list\"></div>" +
  "<div id='lb' class='lb'><img id='lbImg' src='' alt=''></div><div id='lbX' class='lb-x'>&#215;</div><div id='lbT' class='lb-t'>双击放大 &#183; 双指捏合缩放 &#183; 长按可保存</div>" +
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
  "var ci=document.createElement('div');ci.className='ci';" +
  "var r1=document.createElement('div');r1.className='row';" +
  "r1.innerHTML='<span class=tm>⏰ '+it.hhmm+'</span><span class=dev>'+it.dev+'</span>';" +
  "ci.appendChild(r1);" +
  "var r2=document.createElement('div');r2.className='row2';" +
  "if(it.verdict){var vb=document.createElement('span');vb.className='vd '+(it.verdict==='有人'?'vd-p':'vd-n');vb.textContent=it.verdict;r2.appendChild(vb)}" +
  "if(it.source){var sb=document.createElement('span');sb.className='src '+(it.source==='算法'?'src-a':'');sb.textContent=it.source;r2.appendChild(sb)}" +
  "var br=document.createElement('span');br.className='brief';if(it.brief){br.textContent=it.brief}else{br.textContent='暂无AI判读';br.style.color='#5f6368'}r2.appendChild(br);" +
  "ci.appendChild(r2);d.appendChild(ci);" +
  "if(it.pic||it.picEz){var th=document.createElement('div');th.className='thumb';" +
  "var im=new Image();im.decoding='async';im.alt='监控截图';th.appendChild(im);" +
  "im.onerror=function(){if(it.picThumb&&it.pic&&im.src.indexOf(it.pic)>=0&&it.picThumb!==it.pic){im.src=it.picThumb}else if(it.picEz&&im.src!==it.picEz){im.src=it.picEz}else{th.textContent='⚠️';th.style.cssText='color:#5f6368;font-size:12px;display:flex;align-items:center;justify-content:center'}};" +
  "im.onclick=function(ev){ev.stopPropagation();openLB(it.pic||it.picEz)};" +
  "im.src=it.picThumb||it.pic||it.picEz;d.appendChild(th)}" +
  "L.appendChild(d)});" +
  "var v=qVillage||'all';var ta=document.getElementById('tagAll');var ts=document.getElementById('tagSX');var tm=document.getElementById('tagMS');" +
  "if(v==='all')ta.classList.add('on');else if(v==='双溪村')ts.classList.add('on');else if(v==='木山村')tm.classList.add('on');" +
  "}).catch(function(e){document.getElementById('sub').textContent='加载失败:'+e});" +
  "function lbShow(){document.getElementById('lb').classList.add('show');document.getElementById('lbX').classList.add('show');document.getElementById('lbT').classList.add('show');document.body.style.overflow='hidden'}" +
  "function lbHide(){document.getElementById('lb').classList.remove('show');document.getElementById('lbX').classList.remove('show');document.getElementById('lbT').classList.remove('show');document.body.style.overflow='';resetZoom()}" +
  "function resetZoom(){var im=document.getElementById('lbImg');im.style.transform='translate(0,0) scale(1)';im.dataset.scale=1;im.dataset.tx=0;im.dataset.ty=0}" +
  "var _lbImg1=document.getElementById('lbImg'),_lt1=0,_d1=0,_s1=1,_px1=0,_py1=0,_ptx1=0,_pty1=0;" +
  "_lbImg1.addEventListener('touchstart',function(e){if(e.touches.length===2){_d1=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);_s1=parseFloat(_lbImg1.dataset.scale||1)}else if(e.touches.length===1){_px1=e.touches[0].clientX;_py1=e.touches[0].clientY;_ptx1=parseFloat(_lbImg1.dataset.tx||0);_pty1=parseFloat(_lbImg1.dataset.ty||0)}e.preventDefault()},{passive:false});" +
  "_lbImg1.addEventListener('touchmove',function(e){if(e.touches.length===2){var d=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);var ns=Math.min(8,Math.max(1,_s1*(d/(_d1||1))));_lbImg1.dataset.scale=ns;_lbImg1.style.transform='translate('+(_lbImg1.dataset.tx||0)+'px,'+(_lbImg1.dataset.ty||0)+'px) scale('+ns+')'}else if(e.touches.length===1&&parseFloat(_lbImg1.dataset.scale||1)>1){var dx=e.touches[0].clientX-_px1;var dy=e.touches[0].clientY-_py1;_lbImg1.dataset.tx=_ptx1+dx;_lbImg1.dataset.ty=_pty1+dy;_lbImg1.style.transform='translate('+_lbImg1.dataset.tx+'px,'+_lbImg1.dataset.ty+'px) scale('+(_lbImg1.dataset.scale||1)+')'}e.preventDefault()},{passive:false});" +
  "_lbImg1.addEventListener('click',function(){var now=Date.now();if(now-_lt1<300){var ns=parseFloat(_lbImg1.dataset.scale||1)>1.25?1:2.2;_lbImg1.dataset.scale=ns;_lbImg1.dataset.tx=0;_lbImg1.dataset.ty=0;_lbImg1.style.transform='translate(0,0) scale('+ns+')';var t=document.getElementById('lbT');t.textContent=ns>1?'双击恢复 &#183; 拖动可平移':'双击放大 &#183; 双指捏合缩放 &#183; 长按可保存'}else{_lt1=now;setTimeout(function(){_lt1=0},300)}});" +
  "document.getElementById('lb').addEventListener('click',function(e){if(e.target.id==='lb')lbHide()});" +
  "function openLB(src){var im=_lbImg1;resetZoom();if(im.src===src&&im.complete){lbShow()}else{im.onload=function(){lbShow()};im.src=src}}" +
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
  ".lb{position:fixed;left:0;top:0;width:100%;height:100%;background:rgba(0,0,0,.96);z-index:99;display:none;align-items:center;justify-content:center;touch-action:none}.lb.show{display:flex}.lb img{max-width:100%;max-height:100%;-webkit-user-drag:none;user-select:none;transition:transform .15s ease}.lb-x{position:fixed;top:12px;right:14px;width:38px;height:38px;border-radius:19px;background:rgba(255,255,255,.18);color:#fff;font-size:22px;text-align:center;line-height:38px;z-index:100;cursor:pointer}.lb-t{position:fixed;left:0;right:0;bottom:16px;text-align:center;color:#fff;font-size:12px;opacity:.85;z-index:100}" +
  "</style></head><body>" +
  "<header>📜 历史记录" +
  "<div class=\"nav\"><button id=\"prev\">‹</button><select id=\"day\"></select><button id=\"next\">›</button></div></header>" +
  "<div class=\"bar\"><button id=\"bP\" class=\"on\">👤 有人记录</button><button id=\"bA\">📋 全部记录</button><button id=\"bR\">📊 日报</button></div>" +
  "<div class=\"sum\" id=\"sum\">加载中...</div><div id=\"list\"></div>" +
  "<div id='lb' class='lb'><img id='lbImg' src='' alt=''></div><div id='lbX' class='lb-x'>&#215;</div><div id='lbT' class='lb-t'>双击放大 &#183; 双指捏合缩放 &#183; 长按可保存</div>" +
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
  "if(it.pic||it.picEz){var im=new Image();im.decoding='async';im.style.cssText='width:100%;border-radius:8px;display:block;background:#1a1a1a;min-height:120px';var ph=document.createElement('div');ph.textContent='⏳图片加载中…';ph.style.cssText='color:#5f6368;font-size:12px;padding:20px;text-align:center';d.appendChild(ph);im.onload=function(){ph.remove()};im.onerror=function(){if(it.picThumb&&it.pic&&im.src.indexOf(it.pic)>=0&&it.picThumb!==it.pic){im.src=it.picThumb}else if(it.picEz&&im.src!==it.picEz){im.src=it.picEz}else{ph.textContent='⚠️图片加载失败'}};im.onclick=function(ev){ev.stopPropagation();openLB(it.pic||it.picEz)};im.style.cursor='zoom-in';im.src=it.picThumb||it.pic||it.picEz;d.appendChild(im)}" +
  "var ad=document.createElement('div');ad.className='ai';if(it.ai){ad.textContent='🤖 '+it.ai}else{ad.textContent='(暂无AI判读)';ad.style.color='#5f6368'}d.appendChild(ad);" +
  "L.appendChild(d)})" +
  "}).catch(function(e){el('sum').textContent='加载失败:'+e})" +
  "}" +
  "render();" +
  "function lbShow(){document.getElementById('lb').classList.add('show');document.getElementById('lbX').classList.add('show');document.getElementById('lbT').classList.add('show');document.body.style.overflow='hidden'}" +
  "function lbHide(){document.getElementById('lb').classList.remove('show');document.getElementById('lbX').classList.remove('show');document.getElementById('lbT').classList.remove('show');document.body.style.overflow='';resetZoom()}" +
  "function resetZoom(){var im=document.getElementById('lbImg');im.style.transform='translate(0,0) scale(1)';im.dataset.scale=1;im.dataset.tx=0;im.dataset.ty=0}" +
  "var _lbImg2=document.getElementById('lbImg'),_lt2=0,_d2=0,_s2=1,_px2=0,_py2=0,_ptx2=0,_pty2=0;" +
  "_lbImg2.addEventListener('touchstart',function(e){if(e.touches.length===2){_d2=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);_s2=parseFloat(_lbImg2.dataset.scale||1)}else if(e.touches.length===1){_px2=e.touches[0].clientX;_py2=e.touches[0].clientY;_ptx2=parseFloat(_lbImg2.dataset.tx||0);_pty2=parseFloat(_lbImg2.dataset.ty||0)}e.preventDefault()},{passive:false});" +
  "_lbImg2.addEventListener('touchmove',function(e){if(e.touches.length===2){var d=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);var ns=Math.min(8,Math.max(1,_s2*(d/(_d2||1))));_lbImg2.dataset.scale=ns;_lbImg2.style.transform='translate('+(_lbImg2.dataset.tx||0)+'px,'+(_lbImg2.dataset.ty||0)+'px) scale('+ns+')'}else if(e.touches.length===1&&parseFloat(_lbImg2.dataset.scale||1)>1){var dx=e.touches[0].clientX-_px2;var dy=e.touches[0].clientY-_py2;_lbImg2.dataset.tx=_ptx2+dx;_lbImg2.dataset.ty=_pty2+dy;_lbImg2.style.transform='translate('+_lbImg2.dataset.tx+'px,'+_lbImg2.dataset.ty+'px) scale('+(_lbImg2.dataset.scale||1)+')'}e.preventDefault()},{passive:false});" +
  "_lbImg2.addEventListener('click',function(){var now=Date.now();if(now-_lt2<300){var ns=parseFloat(_lbImg2.dataset.scale||1)>1.25?1:2.2;_lbImg2.dataset.scale=ns;_lbImg2.dataset.tx=0;_lbImg2.dataset.ty=0;_lbImg2.style.transform='translate(0,0) scale('+ns+')';var t=document.getElementById('lbT');t.textContent=ns>1?'双击恢复 &#183; 拖动可平移':'双击放大 &#183; 双指捏合缩放 &#183; 长按可保存'}else{_lt2=now;setTimeout(function(){_lt2=0},300)}});" +
  "document.getElementById('lb').addEventListener('click',function(e){if(e.target.id==='lb')lbHide()});" +
  "function openLB(src){var im=_lbImg2;resetZoom();if(im.src===src&&im.complete){lbShow()}else{im.onload=function(){lbShow()};im.src=src}}" +
  "</scr" + "ipt></body></html>";

function buildLiveReply(fromUser, toUser, onlySerial, village) {
  const pubBase = String(((cfg.wxTest || {}).publicBase) || "").replace(/\/$/, "");
  if (!pubBase) return replyText(fromUser, toUser, "⚠️ 公网隧道未开启，无法看直播。请先在电脑上双击一键启动全部.bat");
  const devs = (cfg.devices || []).filter(function (d) { return d.watch && (!onlySerial || d.serial === onlySerial) && (!village || deviceVillage(d.serial) === village); });
  const lines = devs.map(function (d) {
    return "📺 " + d.name + " 直播：\n" + tokUrl(pubBase + "/live?serial=" + d.serial);
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
        // 报警自带截图优先(与 webapp checkTodayPersonAlarms 同策略): 零拉流消耗, 且画面是
        // 报警时刻的真实场景 —— 补录的多是几分钟/几小时前的报警, captureHD 抓到的是"查询时刻"
        // 的画面, 既白烧拉流额度又图文不符(2026-09-29 审查)。无自带截图才抓现况兜底。
        if (picUrl) {
          fname = dev.serial + "_p" + ts + ".jpg";
          try { await client.downloadTo(picUrl, path.join(ROOT, "captures", fname)); }
          catch (e1) { fname = ""; }
        }
        if (!fname) {
          try {
            fname = dev.serial + "_" + Date.now() + ".jpg";
            await hdcapture.captureHD(client, dev.serial, path.join(ROOT, "captures", fname));
          } catch (eHD) { fname = ""; }
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
    const picUrl = latestPic && pub2 ? tokUrl(pub2 + "/captures/" + encodeURIComponent(latestPic.file)) : "";
    // 构建卡片描述: 最多5条摘要
    const cardDesc = evs.slice(0, 5).map(function (e) {
      const aiOk = e.ai && String(e.ai).indexOf("(") !== 0;
      return "⏰ " + e.timeText + " " + e.name + (aiOk ? " · " + String(e.ai).replace(/\s+/g, " ").slice(0, 35) : "");
    }).join("\n") + (evs.length > 5 ? "\n... 共" + evs.length + "次" : "") + (pub2 ? "\n\n📖 点击查看全部记录" : "");
    await sendCustomNews(openid,
      dear(openid) + "📋 " + (label ? label + " " : "") + "今日人员活动 " + evs.length + " 次",
      cardDesc, picUrl, pub2 ? tokUrl(pub2 + "/today" + (onlySerial ? "?serial=" + onlySerial : "")) : picUrl);
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
    return { timeText: hh, name: e.name || e.serial || "", file: e.file || "", ai: String(e.ai || ""), serial: e.serial || "", provider: e.provider || "", ezvizPic: e.ezvizPic || "" };
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
    const picUrl3 = latestPic && pub3 ? tokUrl(pub3 + "/captures/" + encodeURIComponent(latestPic.file)) : "";
    const cardDesc3 = evs.slice(0, 5).map(function (e) {
      const aiOk = e.ai && String(e.ai).indexOf("(") !== 0;
      return "⏰ " + e.timeText + " " + e.name + (aiOk ? " · " + String(e.ai).replace(/\s+/g, " ").slice(0, 35) : "");
    }).join("\n") + (n > 5 ? "\n... 共" + n + "次" : "") + (pub3 ? "\n\n📖 点击查看全部记录" : "");
    setTimeout(async function () {
      await sendCustomNews(fromUser,
        dear(fromUser) + "📋 今日人员活动 " + n + " 次",
        cardDesc3, picUrl3, pub3 ? tokUrl(pub3 + "/today") : picUrl3);
    }, 300);
    return replyText(fromUser, toUser,
      "🔍 正在查询今天的报警记录，结果马上发你...");
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
      const picUrl = latestPic ? tokUrl(pub + "/captures/" + encodeURIComponent(latestPic.file)) : "";
      const qs = "?date=" + encodeURIComponent(dateKey) + (village ? "&village=" + encodeURIComponent(village) : "");
      await sendCustomNews(openid, "📜 " + pq.label + (village ? " " + village : "") + " 报警记录 " + evs.length + " 条", "点开查看全部截图+AI分析结论", picUrl, tokUrl(pub + "/history" + qs));
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
  return replyNews(fromUser, toUser, [{ title: "📜 历史记录查询", description: "有人活动记录 + 历史日报，按日期回看", pic: "", url: tokUrl(pub + "/history" + qs) }]);
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
// 优化: 缓存1小时, 避免频繁调用API消耗配额; 检测配额错误(45009)后停止当天重试
let _openidCache = { list: [], ts: 0 };
const OPENID_CACHE_TTL = 3600e3; // 非空列表缓存1小时
const OPENID_EMPTY_TTL = 60e3;   // 空列表缓存60秒(避免频繁重试消耗配额)
let _quotaExhaustedUntil = 0; // 配额耗尽时记录到当天23:59:59

function isQuotaExhausted() {
  return Date.now() < _quotaExhaustedUntil;
}

function markQuotaExhausted() {
  const now = new Date();
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  _quotaExhaustedUntil = endOfDay.getTime();
  console.log("[推送] ⚠️ API配额已耗尽，停止当天所有重试");
}

async function fetchOpenids(forceRefresh) {
  // 配额耗尽时直接返回空
  if (isQuotaExhausted()) {
    console.log("[推送] API配额已耗尽，跳过获取关注者列表");
    return _openidCache.list;
  }
  
  // 检查缓存: 非空列表长缓存, 空列表短缓存(避免频繁重试消耗配额)
  if (!forceRefresh && _openidCache.ts > 0) {
    const ttl = _openidCache.list.length > 0 ? OPENID_CACHE_TTL : OPENID_EMPTY_TTL;
    if (Date.now() - _openidCache.ts < ttl) return _openidCache.list;
  }
  
  try {
    let token = await wxTestToken();
    let ur = await fetch("https://api.weixin.qq.com/cgi-bin/user/get?access_token=" + token + "&next_openid=", { signal: AbortSignal.timeout(10000) });
    let uj = await ur.json();
    
    // 检测配额错误
    if (uj.errcode === 45009) {
      markQuotaExhausted();
      return _openidCache.list;
    }
    
    if (isTokErr(uj.errcode)) {
      token = await wxTestToken(true);
      ur = await fetch("https://api.weixin.qq.com/cgi-bin/user/get?access_token=" + token + "&next_openid=", { signal: AbortSignal.timeout(10000) });
      uj = await ur.json();
      
      // 重试后再次检测配额错误
      if (uj.errcode === 45009) {
        markQuotaExhausted();
        return _openidCache.list;
      }
    }
    
    const list = (uj.data && uj.data.openid) || [];
    // 无论空/非空都更新时间戳: 空列表也缓存, 用短 TTL 避免频繁重试消耗配额
    _openidCache = { list: list, ts: Date.now() };
    return list;
  } catch (e) { 
    console.log("[推送] 关注者列表获取失败: " + e.message.slice(0, 60)); 
    return _openidCache.list; // 失败时返回缓存
  }
}
// 按给定事件列表与设备标签拼装日报文案; village 传村名时链接只看该村(分组日报防越权)
function buildDailyReportContent(evs, devLabels, village) {
  const n = evs.length;
  const pub = (cfg.wxTest || {}).publicBase || "";
  // pubBase 为空(隧道未开)时不给url: 相对路径发到微信点了没反应, 文案如实说明(与实时推送同一规则)
  const todayUrl = pub ? tokUrl(pub + "/today" + (village ? ("?village=" + encodeURIComponent(village)) : "")) : "";
  let first, remark;
  if (!n) {
    first = "📊 老家监控日报";
    remark = "今天平安无事 ✅ 全天无人员活动\n覆盖设备: " + devLabels.join(" / ") + (todayUrl ? "" : "\n（内网穿透未开启，详情请到电脑看板查看）");
  } else {
    first = "📊 老家监控日报（人员活动 " + n + " 次）";
    const lines = evs.slice(0, 6).map(function (e) {
      const aiOk = e.ai && String(e.ai).indexOf("(") !== 0;
      const aiBrief = aiOk ? String(e.ai).replace(/\s+/g, " ").slice(0, 28) : "（AI未判读）";
      return "⏰" + e.timeText + " " + e.name + "｜" + aiBrief;
    });
    remark = lines.join("\n") + (n > 6 ? "\n... 共" + n + "次" : "") +
      "\n覆盖设备: " + devLabels.join(" / ") + "\n" +
      (todayUrl ? "点本消息看完整AI分析 👉" : "（内网穿透未开启，完整AI分析请到电脑看板查看）");
  }
  return { first: first, remark: remark, url: todayUrl };
}
let _dailyBusy = false;
let _dailyRetryCount = 0; // 日报重试次数
const DAILY_MAX_RETRIES = 5; // 最多重试5次

async function maybeDailyReport() {
  const T = cfg.wxTest || {};
  if (T.enabled === false || T.dailyReport === false || !T.templateId) return;
  
  // 配额耗尽时直接跳过
  if (isQuotaExhausted()) {
    console.log("[日报] API配额已耗尽，跳过今天日报推送");
    return;
  }
  
  const d = new Date();
  if (d.getHours() < (T.reportHour || 20)) return;
  const key = todayKey();
  let st = {};
  try { st = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "daily_report.json"), "utf8")); } catch (e) {}
  if (st.last === key || _dailyBusy) return;
  
  // 检查重试次数
  if (_dailyRetryCount >= DAILY_MAX_RETRIES) {
    console.log("[日报] " + key + " 已达最大重试次数(" + DAILY_MAX_RETRIES + ")，停止重试");
    return;
  }
  
  _dailyBusy = true;
  try {
    // 全日人形事件(已过滤隐藏设备)
    const all = todayPersonEvents();
    let openids = [];
    try { openids = await fetchOpenids(); } catch (e) { console.log("[日报] 关注者列表获取失败: " + e.message.slice(0, 60)); }
    
    // token 未就绪时 openids 可能为空: 不标记已发, 下个周期自动重试(避免当天整日漏报)
    if (!openids.length) {
      if (isQuotaExhausted()) {
        console.log("[日报] " + key + " API配额耗尽，停止重试");
      } else {
        _dailyRetryCount++;
        console.log("[日报] " + key + " 暂未取得关注者列表, 第" + _dailyRetryCount + "次重试");
      }
      return;
    }

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
        { allowOid: function (oid) { return defaultIds.indexOf(oid) >= 0; }, dailyReport: true }));
    }
    // 按村分组: 仅该村民事件, 链接也只看该村
    for (const scope of Object.keys(buckets)) {
      const b = buckets[scope];
      if (!b.ids.length) continue;
      const evsV = all.filter(function (e) { return deviceVillage(e.serial) === scope; });
      const c = buildDailyReportContent(evsV, b.labels, scope);
      plan.push(pushTestTemplate(c.first, key, "每日汇总", c.remark, c.url, true,
        { allowOid: function (oid) { return b.ids.indexOf(oid) >= 0; }, dailyReport: true }));
    }
    const results = await Promise.all(plan);
    const sentAny = results.some(function (n) { return n > 0; });
    
    // 全部失败(网络/token抖动): 不记账, 下个周期自动重试, 避免日报因瞬时故障整天丢失
    if (!sentAny) {
      if (isQuotaExhausted()) {
        console.log("[日报] " + key + " API配额耗尽，停止重试");
      } else {
        _dailyRetryCount++;
        console.log("[日报] " + key + " 本轮推送全部失败, 第" + _dailyRetryCount + "次重试");
      }
      return;
    }
    
    // 成功发送，重置重试计数
    _dailyRetryCount = 0;
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

// 每天0点重置重试计数
function resetDailyRetryCount() {
  _dailyRetryCount = 0;
  console.log("[日报] 新的一天，重置重试计数");
}

setInterval(maybeDailyReport, 60e3);
setTimeout(maybeDailyReport, 20e3);

// 每天0点重置重试计数
const now = new Date();
const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
setTimeout(function() {
  resetDailyRetryCount();
  setInterval(resetDailyRetryCount, 24 * 60 * 60 * 1000); // 每24小时重置
}, nextMidnight - now);

async function freshCapture(serial) {
  const file = path.join(ROOT, "captures", serial + "_" + Date.now() + ".jpg");
  // 高清抓图: 主码流截帧, 失败自动回落原抓图接口
  await hdcapture.captureHD(client, serial, file);
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
  if (publicGate(req, u, res)) return; // 公网鉴权: 未配置 publicToken 时直接放行
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
      // 远程：必须携带 shutdownToken，否则拒绝，防止公网隧道被恶意一键关服。
      // 注意：不 fallback 到 wxServer.token —— 那是微信验证 token，若泄露即可远程关服。
      const tok = ((cfg.wxServer && cfg.wxServer.shutdownToken) || "");
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
      // 限制请求体大小: 萤石推送正常 < 10KB, 防止超大 payload 耗尽内存
      const MAX_BODY = 64 * 1024; // 64KB 上限
      let size = 0;
      let tooLarge = false;
      var chunks = [];
      req.on("data", function (c) {
        size += c.length;
        if (size > MAX_BODY) { tooLarge = true; req.destroy(); return; }
        chunks.push(c);
      });
      req.on("end", function () {
        if (tooLarge) { console.log("[萤石推送] 请求体超过 " + MAX_BODY + " 字节，已丢弃"); return; }
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
            return { timeText: hh, name: e.name || e.serial || "", file: e.file || "", ai: String(e.ai || ""), serial: e.serial || "", provider: e.provider || "", ezvizPic: e.ezvizPic || "" };
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
        if (e.file) picUrl = tokUrl(pubBase + encodeURIComponent(e.file));
        let picEzUrl = "";
        if (e.ezvizPic) picEzUrl = e.ezvizPic;
        const picThumbUrl = e.file ? tokUrl(pubBase + "thumb/" + encodeURIComponent(e.file)) : "";
        // 卡片排版优化(2026-09-29): 结论拆成徽章(verdict), 依据压缩成一行摘要(brief) ——
        // 完整判读点图进灯箱/点推送进详情页看, 列表页不再被整段文字占满
        let verdict = "", brief = "";
        const aiText = (e.ai && String(e.ai).indexOf("(") !== 0) ? String(e.ai).replace(/\s+/g, " ").trim() : "";
        // 结论来源徽章(2026-09-29): 算法/DeepSeek等模型/设备端 —— 推导自provider(与看板同语义)。
        // "本地算法+模型"表示最终结论由模型复核裁决, 归模型; 无provider但有结论文本=设备端直通
        let source = "";
        if (aiText) {
          const prov = String(e.provider || "");
          const shorten = function (p) { return (p === "魔塔DeepSeek" || p === "阿里DeepSeek") ? "DeepSeek" : p; };
          if (prov.indexOf("+") >= 0) source = shorten(prov.split("+").pop());
          else if (prov === "本地算法") source = "算法";
          else if (prov) source = shorten(prov);
          else source = "设备端";
        }
        if (aiText) {
          const j = judgePerson(aiText);
          if (j.matched) verdict = j.person ? "有人" : "无人";
          brief = aiText
            .replace(/^[^：]{1,14}:有人\s*\/\s*[^：]{1,14}:无人\s*\|\s*/, "") // 双AI交叉复核前缀
            .replace(/^(有人|无人)\s*[:：]?\s*/, "")
            .replace(/^依据[:：]?\s*/, "");
          const sent = brief.split(/[。；]/).filter(Boolean)[0] || brief;
          brief = sent.length > 40 ? sent.slice(0, 40) + "…" : sent;
        }
        return {
          hhmm: e.timeText,
          dev: e.name,
          verdict: verdict,
          brief: brief,
          source: source,
          ai: (e.ai && String(e.ai).indexOf("(") !== 0) ? String(e.ai).replace(/\s+/g, " ").slice(0, 200) : "",
          pic: picUrl,
          picThumb: picThumbUrl || picUrl || picEzUrl, // 优先缩略图，回退原图
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
          picThumb: e.file ? tokUrl(pub + "/captures/thumb/" + encodeURIComponent(e.file)) : "", pic: e.file ? tokUrl(pub + "/captures/" + encodeURIComponent(e.file)) : "", picEz: e.ezvizPic || "", serial: e.serial || ""
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
    // 主图走600宽缩略图秒开(推送时已预生成缓存); 点击放大(openLB)才加载 2560x1440 原图
    const THUMB_URL = "/captures/thumb/" + encodeURIComponent(file || "");
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
      "function resetZoom(){var im=document.getElementById('lbImg');im.style.transform='translate(0,0) scale(1)';im.dataset.drag=null;im.dataset.scale=1;im.dataset.tx=0;im.dataset.ty=0;}" +
      // 灯箱内图片支持: 双击放大; 单指拖动平移; 双指缩放(用两指间距离变化)
      "var lbImg=document.getElementById('lbImg');" +
      "var pinch0=0,scale0=1,dist0=0,px0=0,py0=0,ptx0=0,pty0=0;" +
      "lbImg.addEventListener('touchstart',function(e){" +
        "if(e.touches.length===2){dist0=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);scale0=parseFloat(lbImg.dataset.scale||1)}else if(e.touches.length===1){px0=e.touches[0].clientX;py0=e.touches[0].clientY;ptx0=parseFloat(lbImg.dataset.tx||0);pty0=parseFloat(lbImg.dataset.ty||0)}e.preventDefault()" +
      "},{passive:false});" +
      "lbImg.addEventListener('touchmove',function(e){" +
        "if(e.touches.length===2){var d=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);var ns=Math.min(8,Math.max(1,scale0*(d/(dist0||1))));lbImg.dataset.scale=ns;lbImg.style.transform='translate('+(lbImg.dataset.tx||0)+'px,'+(lbImg.dataset.ty||0)+'px) scale('+ns+')'}else if(e.touches.length===1&&parseFloat(lbImg.dataset.scale||1)>1){var dx=e.touches[0].clientX-px0;var dy=e.touches[0].clientY-py0;lbImg.dataset.tx=ptx0+dx;lbImg.dataset.ty=pty0+dy;lbImg.style.transform='translate('+lbImg.dataset.tx+'px,'+lbImg.dataset.ty+'px) scale('+(lbImg.dataset.scale||1)+')'}e.preventDefault()" +
      "},{passive:false});" +
      "var lastTap=0;lbImg.addEventListener('click',function(){" +
        "var now=Date.now();if(now-lastTap<300){var ns=parseFloat(lbImg.dataset.scale||1)>1.25?1:2.2;lbImg.dataset.scale=ns;lbImg.dataset.tx=0;lbImg.dataset.ty=0;lbImg.style.transform='translate(0,0) scale('+ns+')';if(ns>1){var t=document.getElementById('lbTip');t.textContent='双击恢复 · 拖动可平移'}else{var t2=document.getElementById('lbTip');t2.textContent='双击放大 · 双指捏合缩放 · 长按可保存'}lastTap=0}else{lastTap=now;setTimeout(function(){lastTap=0},300)}" +
      "});" +
      "lbImg.addEventListener('load',function(){lbShow()});" +
      // 详情页主图点击 进入灯箱
      // 修复: 依赖 load 事件打开灯箱时, 第二次点击同一张图 src 不变不会触发 load, 灯箱打不开。
      // 改为: src 相同且已加载(complete)时直接打开; 否则设置 src 等 load。
      "function openLB(){var im=document.getElementById('lbImg');resetZoom();var s='" + ORIG_URL + "';var t='" + THUMB_URL + "';if(im.src===s&&im.complete){lbShow()}else{im.onload=function(){lbShow()};im.src=t;var f=new Image();f.onload=function(){if(im.src!==s){im.onload=function(){lbShow()};im.src=s}};f.src=s}}" +
      // 主图: 先用缩略图秒开(60KB级), 同时后台预加载原图, 原图就绪后自动替换为高清(用户无需操作)
      "var _mm=document.getElementById('mainImg');if(_mm&&_mm.getAttribute('data-orig')){var _mo=_mm.getAttribute('data-orig');var _mf=new Image();_mf.onload=function(){_mm.src=_mo};_mf.src=_mo}" +
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
        "<img id='mainImg' src='" + THUMB_URL + "' data-orig='" + ORIG_URL + "' alt='现场照片' loading='eager'>" +
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
      // 生成缩略图文件名(与 ensureThumbFile 预生成共用同一缓存)
      const thumbPath = thumbPathOf(origFn);
      // 已有缩略图直接输出
      if (fs.existsSync(thumbPath)) {
        res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=604800, immutable" });
        res.end(fs.readFileSync(thumbPath));
        return;
      }
      // ffmpeg 缩放(体积远小于 jimp: 600宽约62KB), 生成后落盘缓存再输出
      (async function() {
        try {
          await hdcapture.makeThumb(origPath, thumbPath, 600, 5);
          if (!fs.existsSync(thumbPath)) throw new Error("缩略图未生成");
          res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=604800, immutable" });
          res.end(fs.readFileSync(thumbPath));
        } catch (e) {
          console.log("[缩略图] 缩放失败 " + origFn + ": " + String(e.message).slice(0, 80));
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
    // 限制请求体大小: 微信 XML 消息正常 < 10KB, 防止超大 payload 耗尽内存
    const MAX_BODY = 64 * 1024; // 64KB 上限
    let body = "";
    let bodyTooLarge = false;
    req.on("data", function (c) {
      if (body.length + c.length > MAX_BODY) { bodyTooLarge = true; req.destroy(); return; }
      body += c;
    });
    req.on("end", async function () {
      if (bodyTooLarge) { console.log("[微信] 请求体超过 " + MAX_BODY + " 字节，已丢弃"); return; }
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
    console.log("公网鉴权: " + (PUBLIC_TOKEN ? "已启用 (wxServer.publicToken 已配置, 家人从推送/菜单链接进入自动放行)" : "⚠️ 未配置 wxServer.publicToken —— 任何人拿到隧道域名即可看照片/转云台, 请在 config.json 配置"));
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
  // captureRetentionDays=0 表示不清理(永久保留); 默认3小时的 motion 垫图仍按需清理
  const days = Number((cfg.storage && cfg.storage.captureRetentionDays) || 60);
  const hours = Number((cfg.storage && cfg.storage.motionRetentionHours) || 3);
  if (days > 0) sweepCaptureDir(CAPTURE_DIR, Date.now() - days * 86400e3, "事件图(超过 " + days + " 天)");
  if (hours > 0) sweepCaptureDir(MOTION_DIR, Date.now() - hours * 3600e3, "移动侦测暂存(超过 " + hours + " 小时)");
}

// 本地检测背景参考图定期刷新(每30分钟): 参考图太老(>3h)时用同设备"较早"的图重写,
// 保持背景与当前场景同步(昼夜/光线渐变), 避免参考过老导致漏检或误报
setInterval(function () {
  if (!LOCAL_DETECT.enabled) return;
  try {
    const serials = (cfg.devices || []).filter(function (d) { return d.watch && !d.hidden; }).map(function (d) { return d.serial; });
    for (const s of serials) {
      let stale = true;
      try { stale = (Date.now() - fs.statSync(motiondetect.refPath(ROOT, s)).mtimeMs) > 3 * 3600e3; } catch (e) {}
      if (!stale) continue;
      const c = motiondetect.newestOlderImage(ROOT, s, 8 * 60e3, 6 * 3600e3);
      if (c) {
        motiondetect.refreshRefFrom(ROOT, s, c.file)
          .then(function () { console.log("[本地检测] 已刷新背景参考图: " + s); })
          .catch(function () {});
      }
    }
  } catch (e) {}
}, 30 * 60e3);

// ---------- 磁盘空间监控: 记录/截图永久保留后, 磁盘满前提前微信提醒 ----------
// 每小时检查一次 captures 所在盘的剩余空间; 低于阈值(默认: 剩余<5GB 或 <10%)时:
//   1) 日志打印告警  2) 微信推送提醒(每天最多推1次, 避免刷屏)
let _diskWarnDay = ""; // 今天已推送过的日期
function diskFreeSpace(dirPath) {
  // Node 18+ 用 fs.statfs; 老版本回落 null
  try {
    if (fs.statfsSync) {
      const st = fs.statfsSync(dirPath);
      return { totalBytes: st.bsize * st.blocks, freeBytes: st.bsize * st.bavail };
    }
  } catch (e) {}
  return null;
}
async function checkDiskSpace() {
  try {
    const sp = diskFreeSpace(CAPTURE_DIR);
    if (!sp) return;
    const freeGB = sp.freeBytes / 1073741824;
    const freePct = (sp.freeBytes / sp.totalBytes) * 100;
    const cfgWarn = (cfg.storage || {});
    const warnGB = Number(cfgWarn.diskWarnFreeGB > 0 ? cfgWarn.diskWarnFreeGB : 5);
    const warnPct = Number(cfgWarn.diskWarnFreePercent > 0 ? cfgWarn.diskWarnFreePercent : 10);

    if (freeGB < warnGB || freePct < warnPct) {
      console.log("[磁盘告警] ⚠️ captures 所在磁盘剩余不足: " + freeGB.toFixed(1) + " GB / " + freePct.toFixed(1) + "%（阈值: " + warnGB + "GB 或 " + warnPct + "%），请及时上传云盘备份并清理！");
      // 微信推送提醒: 每天最多1次
      const today = new Date().toLocaleDateString("zh-CN");
      if (_diskWarnDay !== today) {
        _diskWarnDay = today;
        const msg = "⚠️ 监控磁盘空间不足\n\n剩余: " + freeGB.toFixed(1) + " GB（" + freePct.toFixed(1) + "%）\n阈值: " + warnGB + "GB / " + warnPct + "%\n\n请尽快上传云盘备份 captures/ 目录后清理旧文件";
        // 复用日报推送通道(force=true 绕过时段限制, 确保告警必达), 推送到全员
        if ((cfg.wxTest || {}).enabled) {
          pushTestTemplate("监控磁盘告警", new Date().toLocaleString("zh-CN", { hour12: false }), msg, "", "", true, {}).then(function () {}).catch(function () {});
        }
      }
    }
  } catch (e) { console.log("[磁盘监控] 检查失败: " + e.message.slice(0, 80)); }
}
setInterval(checkDiskSpace, 3600e3); // 每小时检查
setTimeout(checkDiskSpace, 60e3); // 启动60秒后先查一次

process.on("SIGINT", function() {
  console.log("\n正在关闭...");
  removePidIfMine();
  try { if (currentServer) currentServer.close(); } catch (e) {}
  setTimeout(function() { process.exit(0); }, 800);
});

