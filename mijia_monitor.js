// mijia_monitor.js — 米家摄像机报警轮询（事件驱动，不依赖模拟器 App）
//
// 数据源: 米家云 business.smartcamera.api.io.mi.com 报警事件接口
// 凭证:   data/mijia_token.json (tools/mijia_login.py 登录生成, 长期有效)
// 产出:   data/mijia_events.json     报警记录(看板用)
//         captures/mijia/<日期>/<时间>_<类型>_<fileId>.jpg  报警图片(永久保存)
// 推送:   有人移动(PeopleMotion) / 画面变动(ObjectMotion) -> 微信模板消息 + 看板
//         其它类型 -> 仅看板记录
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const mijia = require("./lib/mijia");
const store = require("./lib/store");
const pushLib = require("./lib/push");
const mijiaVideo = require("./lib/mijia_video");

const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const EVENTS_FILE = path.join(ROOT, "data", "mijia_events.json");
const CAP_DIR = path.join(ROOT, "captures", "mijia");
const HD_DIR = CAP_DIR; // 高清帧与标清同目录, 文件名带 _hd 后缀
// 报警视频(约9s): 整段下载+转码 H.264 后存 captures/mijia/videos/<日期>/<时间>_<类型>_<fileId>.mp4
const VIDEO_CFG = CFG.mijiaVideo || {};
const VIDEO_ENABLED = VIDEO_CFG.enabled !== false;
const VIDEO_RETENTION_DAYS = Number(VIDEO_CFG.retentionDays === undefined ? 7 : VIDEO_CFG.retentionDays);
const VIDEO_DIR = path.join(CAP_DIR, "videos");
const VQ_MAX_ATTEMPTS = 4;     // 云端报警片段要事件结束后1-2分钟才完整, 失败定时重试
const VQ_RETRY_MS = 90 * 1000; // 重试间隔
const PY = process.env.MIJIA_PY || "C:\\Users\\wd\\.dsh\\dsh-runtimes\\dsh-next-primary-runtime\\dependencies\\python\\python.exe";
const HD_SCRIPT = path.join(ROOT, "tools", "mijia_hd.py");

// 有人移动时取视频高清帧(失败返回 false, 由调用方回落标清图)
function tryHdFrame(fileId, outFile) {
  try {
    execFileSync(PY, [HD_SCRIPT, String(fileId), outFile], { timeout: 180000, stdio: "ignore" });
    return fs.existsSync(outFile) && fs.statSync(outFile).size > 1000;
  } catch (e) {
    log("高清帧失败 fileId=" + fileId + ": " + String(e.message).slice(0, 100));
    return false;
  }
}
const INTERVAL_MS = Math.max(15, Number(process.env.MIJIA_INTERVAL_SEC || 60)) * 1000;
const LOOKBACK_MS = Number(process.env.MIJIA_LOOKBACK_HOURS || 72) * 3600000;

function log() { console.log.apply(console, ["[mijia]"].concat([].slice.call(arguments))); }

function loadEvents() {
  try {
    const a = JSON.parse(fs.readFileSync(EVENTS_FILE, "utf8"));
    return Array.isArray(a) ? a : [];
  } catch (e) { return []; }
}

function pad(n) { return String(n).padStart(2, "0"); }

async function buildRecord(unit, existIds, isBackfill) {
  const fileId = String(unit.fileId);
  if (existIds.indexOf(fileId) >= 0) return null;
  let types = (unit.eventTypeDetail || []).map(function (d) { return d && d.event; }).filter(Boolean);
  if (!types.length && unit.eventType) {
    types = String(unit.eventType).split(":").filter(Boolean);
  }
  const labels = types.map(function (t) { return mijia.TYPE_LABELS[t] || t; });
  const shouldPush = types.some(function (t) { return mijia.PUSH_TYPES.indexOf(t) >= 0; });
  const ct = Number(unit.createTime) || Date.now();
  const d = new Date(ct);
  const day = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  const hhmmss = pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  const base = day + "/" + hhmmss + "_" + (types[0] || "event") + "_" + fileId;
  const imgFile = base + ".jpg";
  const hdFile = base + "_hd.jpg";
  const isPerson = types.indexOf("PeopleMotion") >= 0;

  // 所有事件都优先取视频高清帧; 失败 -> 回落设备标清图
  let imgOk = false, hdOk = false;
  {
    const hdAbs = path.join(HD_DIR, hdFile);
    if (tryHdFrame(unit.fileId, hdAbs)) {
      hdOk = true;
      log("高清帧已保存 " + hdFile);
    }
  }
  if (!hdOk) {
    try {
      const buf = await mijia.fetchImage(unit.fileId, unit.imgStoreId);
      if (buf && buf.length > 100) {
        const abs = path.join(CAP_DIR, imgFile);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, buf);
        imgOk = true;
        log("图片已保存 " + imgFile + " (" + buf.length + " bytes)");
      }
    } catch (e) {
      log("图片下载失败 fileId=" + fileId + ": " + e.message);
    }
  }

  return {
    id: fileId,
    createTime: ct,
    time: d.toLocaleString("zh-CN", { hour12: false }),
    types: types,
    labels: labels,
    push: isBackfill ? false : shouldPush,
    pushed: isBackfill ? true : false,
    backfill: !!isBackfill,
    fileId: unit.fileId,
    imgStoreId: unit.imgStoreId || "",
    imgFile: imgOk ? imgFile : "",
    hdFile: hdOk ? hdFile : "",
    desc: unit.eventDesc || "",
    videoFile: "",
    videoSize: 0,
    videoRel: base + ".mp4",
    did: mijia.DID,
    model: mijia.MODEL,
    source: "mijia"
  };
}

// 米家报警推送名单: 从 config.json 的 mijiaPushOpenids 读取(含 openid, 不入库)
const MIJIA_PUSH_LIST = CFG.mijiaPushOpenids || [];
async function pushOne(rec) {
  const title = "爷爷老家 · " + rec.labels.join("/");
  const body = "时间：" + rec.time + "\n类型：" + rec.labels.join("、") +
    (rec.desc ? "\n备注：" + rec.desc : "") + "\n地点：爷爷老家";
  const imgFile = rec.hdFile || rec.imgFile || "";
  const imgAbs = imgFile ? path.join(CAP_DIR, imgFile) : "";
  try {
    // 详情页链接(带 token): /detail?file=xxx 展示现场照片
    const pubBase = ((CFG.wxTest || {}).publicBase || "").replace(/\/$/, "");
    const TOKEN = String(((CFG.wxServer || {}).publicToken) || "");
    let detailUrl = "";
    if (pubBase && imgFile) {
      detailUrl = pubBase + "/detail?file=" + encodeURIComponent("mijia/" + imgFile);
      if (TOKEN) detailUrl += "&token=" + encodeURIComponent(TOKEN);
    }
    const n = await pushLib.pushTestTemplate(title, rec.time, "爷爷老家", body, detailUrl, false, {
      allowOid: function(oid) { return MIJIA_PUSH_LIST.some(function(x) { return x.oid === oid; }); },
      serial: "",
      kw3: "设备端侦测",
      kw4: rec.labels.join("、").slice(0, 20),
      kw5: "点击详情查看现场"
    });
    if (n > 0) return { ok: true, detail: "推送 " + n + " 人" };
    return { ok: false, reason: "推送 0 人(可能配额耗尽)" };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function markPushed(id) {
  await store.updateJson(EVENTS_FILE, function (arr) {
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].id === id) { arr[i].pushed = true; break; }
    }
    return arr;
  }, { cap: 0 });
}

// ---- 报警视频异步下载队列(不阻塞报警推送; 有人移动优先) ----
let _videoQueue = [], _videoBusy = false, _lastVideoCleanup = 0;

function queueVideo(item) {
  if (!VIDEO_ENABLED || !item || !item.fileId || !item.rel) return;
  if ((item.attempts || 0) >= VQ_MAX_ATTEMPTS) return;
  for (let i = 0; i < _videoQueue.length; i++) { if (_videoQueue[i].id === item.id) return; }
  _videoQueue.push(item);
}

// 启动时/每小时清理过期视频目录(retentionDays=0 表示永久保留)
function cleanupOldVideos() {
  if (!(VIDEO_RETENTION_DAYS > 0)) return;
  let dirs = [];
  try { dirs = fs.readdirSync(VIDEO_DIR).filter(function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(d); }); } catch (e) { return; }
  const cutoff = Date.now() - VIDEO_RETENTION_DAYS * 86400000;
  let removed = 0;
  for (let i = 0; i < dirs.length; i++) {
    const ts = new Date(dirs[i] + "T00:00:00").getTime();
    if (!ts || ts >= cutoff) continue;
    try {
      const files = fs.readdirSync(path.join(VIDEO_DIR, dirs[i]));
      for (let j = 0; j < files.length; j++) { try { fs.unlinkSync(path.join(VIDEO_DIR, dirs[i], files[j])); removed++; } catch (e) {} }
      try { fs.rmdirSync(path.join(VIDEO_DIR, dirs[i])); } catch (e) {}
    } catch (e) {}
  }
  if (removed) log("已清理 " + VIDEO_RETENTION_DAYS + " 天前的报警视频 " + removed + " 个");
}

async function markVideoReady(id, rel, size) {
  await store.updateJson(EVENTS_FILE, function (arr) {
    let hit = false;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].id === id) { arr[i].videoFile = rel; arr[i].videoSize = size; arr[i].videoAt = Date.now(); hit = true; break; }
    }
    return hit ? arr : false; // false=无变化不写盘
  }, { cap: 0 });
  // 同步 events.json(看板/微信详情页用): 新条目按 fileId, 存量条目按文件名 base 兜底
  const base = String(rel).replace(/\.mp4$/, "");
  await store.updateEvents(ROOT, function (arr) {
    let hit = false;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].source === "mijia" && (arr[i].fileId === id || (arr[i].file && String(arr[i].file).indexOf(base) >= 0))) {
        arr[i].video = rel; hit = true; break;
      }
    }
    return hit ? arr : false;
  }, { cap: 0 });
}

async function markVideoAttempt(id, attempts) {
  await store.updateJson(EVENTS_FILE, function (arr) {
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].id === id) { arr[i].videoAttempts = attempts; break; }
    }
    return arr;
  }, { cap: 0 });
}

async function processVideoQueue() {
  if (_videoBusy) return;
  _videoBusy = true;
  try {
    while (_videoQueue.length) {
      const item = _videoQueue.shift();
      const abs = path.join(VIDEO_DIR, item.rel);
      let r = null;
      try {
        const tok = mijia.loadToken();
        r = await mijiaVideo.fetchVideo(item.fileId, abs, tok, mijia);
      } catch (e) { log("视频下载异常 fileId=" + item.fileId + ": " + e.message); }
      if (r) {
        await markVideoReady(item.id, item.rel, r.size);
        log("视频已保存 " + item.rel + " (" + Math.round(r.size / 1024) + "KB)");
      } else {
        item.attempts = (item.attempts || 0) + 1;
        markVideoAttempt(item.id, item.attempts).catch(function () {});
        if (item.attempts < VQ_MAX_ATTEMPTS) {
          log("视频下载失败(第" + item.attempts + "次) fileId=" + item.fileId + "，" + (VQ_RETRY_MS / 1000) + "s 后重试");
          setTimeout(function () { queueVideo(item); processVideoQueue().catch(function () {}); }, VQ_RETRY_MS);
        } else {
          log("视频下载放弃 fileId=" + item.fileId + "（已重试 " + VQ_MAX_ATTEMPTS + " 次）");
        }
      }
    }
  } finally { _videoBusy = false; }
}

// 补偿: 进程重启/历史遗留的「有报警无视频」记录(回看窗口内)重新入队
function backfillVideoQueue() {
  if (!VIDEO_ENABLED) return;
  let all = [];
  try { all = loadEvents(); } catch (e) { return; }
  const now = Date.now();
  for (let i = 0; i < all.length; i++) {
    const x = all[i];
    if (!x.fileId || x.videoFile) continue;
    const age = now - (x.createTime || 0);
    if (age < 30 * 1000 || age > LOOKBACK_MS) continue;
    const base = x.hdFile ? String(x.hdFile).replace(/_hd\.jpg$/, "") : String(x.imgFile || "").replace(/\.jpg$/, "");
    if (!base) continue;
    queueVideo({ id: x.id, fileId: x.fileId, rel: base + ".mp4", attempts: x.videoAttempts || 0 });
  }
}

let firstRun = true;
async function tick() {
  let units;
  try {
    units = await mijia.fetchEvents(Date.now() - LOOKBACK_MS, Date.now(), 50);
  } catch (e) {
    log("拉取事件失败: " + e.message);
    return;
  }
  const exist = loadEvents();
  const existIds = exist.map(function (e) { return e.id; });
  const fresh = [];
  for (let i = 0; i < units.length; i++) {
    try {
      const rec = await buildRecord(units[i], existIds, firstRun);
      if (rec) { fresh.push(rec); existIds.push(rec.id); }
    } catch (e) {
      log("处理事件失败: " + e.message);
    }
  }
  firstRun = false;
  if (fresh.length) {
    await store.updateJson(EVENTS_FILE, function (arr) {
      const merged = arr.concat(fresh);
      merged.sort(function (a, b) { return b.createTime - a.createTime; });
      return merged;
    }, { cap: 0 });
    // 同步写入 events.json, 让实时看板「历史报警记录」也能看到爷爷老家
    const evs = fresh.map(function (r) {
      return {
        time: r.time,
        ts: r.createTime,
        fileId: r.fileId,
        name: "爷爷老家",
        title: (r.labels || []).join("/"),
        file: (r.hdFile || r.imgFile) ? ("mijia/" + (r.hdFile || r.imgFile)) : "",
        person: (r.types || []).indexOf("PeopleMotion") >= 0,
        ai: "",
        pushed: r.pushed === true,
        source: "mijia",
        serial: "mijia",
        veh: 0,
        video: ""
      };
    });
    await store.updateEvents(ROOT, function (arr) {
      const ids = {};
      for (let i = 0; i < arr.length; i++) ids[arr[i].time + "|" + arr[i].file] = 1;
      const merged = arr.concat(evs.filter(function (e) { return !ids[e.time + "|" + e.file]; }));
      merged.sort(function (a, b) { return String(b.time || "").localeCompare(String(a.time || "")); });
      return merged;
    }, { cap: 0 });
    log("新增 " + fresh.length + " 条米家报警");
  }

  // 报警视频异步下载(不阻塞上面的推送): 有人移动优先
  if (VIDEO_ENABLED) {
    fresh.slice().sort(function (a, b) {
      const pa = (a.types || []).indexOf("PeopleMotion") >= 0 ? 0 : 1;
      const pb = (b.types || []).indexOf("PeopleMotion") >= 0 ? 0 : 1;
      return pa - pb;
    }).forEach(function (r) { queueVideo({ id: r.id, fileId: r.fileId, rel: r.videoRel, attempts: 0 }); });
    backfillVideoQueue();
    processVideoQueue().catch(function (e) { log("视频队列异常: " + e.message); });
    if (Date.now() - _lastVideoCleanup > 3600000) { _lastVideoCleanup = Date.now(); cleanupOldVideos(); }
  }

  // 推送待推记录
  const all = loadEvents();
  const pend = all.filter(function (x) { return x.push && !x.pushed; });
  for (let i = 0; i < pend.length; i++) {
    const r = pend[i];
    const res = await pushOne(r);
    if (res && res.ok) {
      await markPushed(r.id);
      log("已推送 " + r.id + " " + r.labels.join("/"));
    } else {
      log("推送失败 " + r.id + ": " + (res && (res.reason || res.detail) || "unknown"));
    }
    await new Promise(function (rs) { setTimeout(rs, 800); });
  }
}

log("米家报警轮询启动: 间隔 " + (INTERVAL_MS / 1000) + "s, 回看 " + (LOOKBACK_MS / 3600000) + "h, did=" + mijia.DID +
  (VIDEO_ENABLED ? ", 报警视频=开(保留" + (VIDEO_RETENTION_DAYS > 0 ? VIDEO_RETENTION_DAYS + "天" : "永久") + ")" : ", 报警视频=关"));
cleanupOldVideos();
backfillVideoQueue();
if (_videoQueue.length) processVideoQueue().catch(function () {});
tick();
setInterval(function () { tick().catch(function (e) { log("tick 异常: " + e.message); }); }, INTERVAL_MS);
