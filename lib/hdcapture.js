// 高清抓图: 走萤石直播接口拉主码流, ffmpeg 截帧 —— 分辨率是设备原始档(实测 3200x1800),
// 而开放平台抓图接口 /api/lapp/device/capture 被锁在 768x432(quality/imageSize 参数均无效, 2026-09-17 实测)。
// 任何环节失败(无 ffmpeg / 取流失败 / 截帧失败)都自动回落原抓图接口, 保证链路不断。
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

const ROOT = path.join(__dirname, "..");
// 拉流并发锁: 萤石直播流有账号级并发观看限制(9048错误), 多个进程(webhook/monitor/webapp)
// 同时用 ffmpeg 拉流截帧会触发超限。用文件锁串行化: 抢到锁才拉流。
//
// 2026-10-08 改为**排队等待**(原实现抢不到立即抛错):
// 实测 monitor 高清截帧 574 次尝试 **成功 0 次** —— 锁几乎永远被 webhook 占着(webhook 成功 1545 次),
// monitor 每次抢不到就抛错回落 client.capture, 而 client.capture 正是吃萤石 10028 抓图配额的接口,
// 于是「拉不到流 → 回落 → 爆配额 → 更拉不到流」形成死循环。
// 排队等待后, 报警链路的实时性不受影响(截帧本身只要几秒), 却能让巡检真正截到帧、不再白烧配额。
const STREAM_LOCK = path.join(ROOT, "data", "stream_frame.lock");
const STREAM_LOCK_WAIT_MS = Number(process.env.HDC_STREAM_LOCK_WAIT_MS || 25000); // 排队上限
const STREAM_LOCK_POLL_MS = 300;

// ---------- 9048 退避 ----------
// 萤石账号并发观看限制(9048)是账号级状态, 被占住时通常持续数分钟: 期间每次拉流都是
// "拉流锁占用15~45秒 → 得到512x288错误占位帧 → 抛错", 既产不出图还反复占用拉流锁、
// 白烧免费快照回落。检测到占位流后记一个账号级退避窗口, 窗口内 captureHD 直接走
// 免费快照回落(不再尝试拉流)。文件落在 data/ 供 webhook/monitor/webapp 三个进程共享。
const BACKOFF_FILE = path.join(ROOT, "data", "stream_backoff.json");
const BACKOFF_MS = 5 * 60e3; // 退避时长: 5分钟
function markStreamBackoff() {
  // 退避时长**递增**(2026-10-08): 原来固定 5 分钟, 而窗口一过立刻又去拉流 → 再撞 9048 → 回到原点,
  // 形成"退避-撞墙-再退避"的死循环(实测 803 次 9048)。现在按连续次数 5→10→20→40 分钟封顶,
  // 让账号级并发限制有时间真正释放。
  let fails = 0;
  try {
    const b = JSON.parse(fs.readFileSync(BACKOFF_FILE, "utf8"));
    // 上次退避已结束才算新的一轮, 否则连续累加(否则偶尔一次失败会永久锁死)
    if (b && Number(b.until) <= Date.now()) fails = 0;
    fails = Math.min(3, (Number(b && b.fails) || 0) + 1); // 封顶 3 → 40 分钟
  } catch (e) {}
  // fails=1→5分钟, 2→10, 3→20, 4+→40 封顶
  const ms = Math.pow(2, Math.max(0, fails - 1)) * 5 * 60e3;
  try { fs.writeFileSync(BACKOFF_FILE, JSON.stringify({ until: Date.now() + ms, at: Date.now(), fails: fails, untilMin: ms / 60e3 })); } catch (e) {}
}
function inStreamBackoff() {
  try {
    const b = JSON.parse(fs.readFileSync(BACKOFF_FILE, "utf8"));
    if (b && Number(b.until) > Date.now()) return true;
    // 退避已过: 顺手清掉 fails, 下一轮从头算(否则 failCount 只增不减, 永远顶在 40 分钟)
    if (b && Number(b.fails) > 0) { try { fs.writeFileSync(BACKOFF_FILE, JSON.stringify({ until: 0, fails: 0 })); } catch (e) {} }
  } catch (e) {}
  return false;
}
// 失败产物清理: streamFrame 抛错前 outFile 可能已被 ffmpeg 写入半截/错误占位帧,
// 不删除就会以 {serial}_{ms}.jpg 的"高清"名字留在 captures/ 永久污染看板选图
// (2026-09-29 实测: 9048 期间每次失败泄漏一张 512x288 白屏错误帧, 存量达 130 张)。
function discardOutFile(outFile) {
  try { fs.unlinkSync(outFile); } catch (e) {}
}

// 尝试获取拉流锁(异步): 成功返回 true。抢不到时**排队等待**直到 STREAM_LOCK_WAIT_MS,
// 期间每次用 process.kill(pid,0) 判断持有进程是否还活着(进程崩溃遗留的脏锁当场回收)。
// 超时返回 false —— 由调用方决定回落策略(见 captureHD: 退避期外才允许回落抓图接口)。
//
// 必须用 async 版本 + 真正的异步 sleep: 同步自旋/Atomics.wait 会**阻塞事件循环**,
// 而萤石推送回调必须在 2 秒内应答, 阻塞在这里会把应答挤掉(2026-10-08 改动的硬约束)。
async function tryStreamLock() {
  const deadline = Date.now() + STREAM_LOCK_WAIT_MS;
  for (;;) {
    try {
      // wx = 排他创建, 文件已存在则抛错(说明锁被占用)
      const fd = fs.openSync(STREAM_LOCK, "wx");
      fs.writeSync(fd, String(process.pid) + " " + Date.now());
      fs.closeSync(fd);
      return true;
    } catch (e) {
      // 锁文件已存在: 检查持有进程是否还活着, 死了就回收(进程崩溃遗留的脏锁)
      let holderPid = 0;
      try { holderPid = parseInt(fs.readFileSync(STREAM_LOCK, "utf8"), 10) || 0; } catch (e0) {}
      let dead = false;
      if (holderPid && holderPid !== process.pid) {
        try { process.kill(holderPid, 0); } catch (e2) { dead = true; }
      } else if (holderPid === process.pid) {
        dead = true; // 自己持有的锁(理论上不该发生) 当作可接管
      }
      if (dead) {
        try { fs.unlinkSync(STREAM_LOCK); } catch (e3) {}
        continue; // 立刻重试一次抢占
      }
      if (Date.now() >= deadline) return false; // 排队超时
      await new Promise(function (r) { setTimeout(r, STREAM_LOCK_POLL_MS); });
    }
  }
}

function releaseStreamLock() {
  try {
    const txt = fs.readFileSync(STREAM_LOCK, "utf8");
    const pid = parseInt(txt, 10);
    if (pid === process.pid) fs.unlinkSync(STREAM_LOCK);
  } catch (e) { /* 锁已不存在, 忽略 */ }
}
// ffmpeg 查找顺序: 项目 bin/ → 环境变量 → WorkBuddy 托管 workspace(开发机兜底)
const FFMPEG_CANDIDATES = [
  path.join(ROOT, "bin", "ffmpeg.exe"),
  path.join(ROOT, "bin", "ffmpeg"),
  process.env.FFMPEG_PATH,
  "C:/Users/wd/.workbuddy/binaries/node/workspace/node_modules/ffmpeg-static/ffmpeg.exe"
].filter(Boolean);

let _ffmpeg = null; // 缓存查找结果, 不存在时缓存 false 避免每次磁盘扫描
function findFfmpeg() {
  if (_ffmpeg !== null) return _ffmpeg || null;
  for (const p of FFMPEG_CANDIDATES) {
    try { fs.accessSync(p, fs.constants.X_OK); _ffmpeg = p; return p; } catch (e) { /* 下一个 */ }
  }
  _ffmpeg = false;
  return null;
}

function jpegSize(buf) {
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m === 0xc0 || m === 0xc1 || m === 0xc2) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd9) || m === 0x01) { i += 2; continue; }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

function execFileP(cmd, args, timeoutMs) {
  return new Promise(function (resolve, reject) {
    execFile(cmd, args, { timeout: timeoutMs || 45000, windowsHide: true }, function (err, stdout, stderr) {
      if (err) { err.message = String(err.message).slice(0, 200) + (stderr ? " | " + String(stderr).slice(0, 200) : ""); reject(err); }
      else resolve();
    });
  });
}

// 探测流地址是否是错误占位流(设备离线/并发超限时萤石返回包含 /ErrCode/ 的流,
// ffmpeg 拉这种流截帧会得到带错误提示文字的图, 不应保存)
async function probeErrCode(url) {
  try {
    const txt = await (await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(4000) })).text();
    if (txt.indexOf("/ErrCode/") >= 0) {
      throw new Error("平台返回错误占位流(可能9048超限/设备离线)，不截错误图");
    }
  } catch (e) {
    if (e.message.indexOf("占位流") >= 0) throw e; // 确认为错误占位流, 抛出错让上层回落
    // fetch 超时/网络失败不一定是错误流, 静默放过, 继续尝试 ffmpeg 截帧
  }
}

// 从主码流截一帧到 outFile。成功返回 { hd:true, w, h }。
// 取帧策略(2026-09): 直播流中途直接 -ss 跳转可能取到非关键帧, 解码上下文缺失 → 马赛克/绿屏。
// 改为 -skip_frame nokey 只等关键帧(I帧, 完整画面)输出; 偶发丢包导致产物损坏时重新取流重试一次。
async function streamFrame(client, serial, outFile) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error("ffmpeg 不可用");
  // 拉流并发锁: 抢不到就排队等待(原实现抢不到立即抛错, 导致 monitor 574 次尝试全失败 ——
  // 锁被 webhook 占着时它每次都回落吃配额的抓图接口, 反而更快爆 10028)。超时才抛错回落。
  if (!(await tryStreamLock())) throw new Error("拉流并发锁排队超时(避免9048超限)，回落快照");
  try {
    // quality=1 主码流(高清); H265 设备必须 supportH265:1 + containerFormat:1(fMP4), 与预览页约定一致
    const r = await client.liveAddress(serial, { quality: 1, protocol: 2, supportH265: 1, containerFormat: 1, expireTime: 600 });
    if (r.code !== "200") throw new Error("取流地址失败 code=" + r.code + " " + (r.msg || ""));
    const d = Array.isArray(r.data) ? r.data[0] : r.data;
    if (!d || !d.url) throw new Error("流地址为空");
    // 检测是否是错误占位流(设备离线/并发超限时平台返回ErrCode流)
    // ffmpeg 拉这种流截帧会得到带错误提示的图(如 9048 "同时观看人数超限"), 不应存这种无效图
    // probeErrCode 只在确认占位流时 reject —— 此时记账号级退避, 5分钟内不再尝试拉流
    await probeErrCode(d.url).catch(function (e0) { markStreamBackoff(); throw e0; });
    const attempt = async function () {
      await execFileP(ffmpeg, [
        "-y", "-loglevel", "error", "-timeout", "15000000",
        "-i", d.url,
        "-skip_frame", "nokey",   // 只输出关键帧(完整画面), 避免取到残缺变化帧
        "-vsync", "0",
        "-frames:v", "1", "-q:v", "2", outFile
      ], 45000);
      const sz = jpegSize(fs.readFileSync(outFile));
      if (!sz || !sz.w) throw new Error("截帧产物异常");
      // 尺寸校验: 错误占位图(如9048/设备离线提示)只有512x288, 正常主码流≥1280x720。
      // 9048"同时观看人数超限"会把错误提示烧进视频流里(m3u8无/ErrCode/标记), 只能靠尺寸拦截
      if (sz.w < 1280) throw new Error("截帧尺寸异常(" + sz.w + "x" + sz.h + "),疑似错误占位流");
      return sz;
    };
    let sz;
    try { sz = await attempt(); }
    catch (e) {
      // 错误占位流(9048超限/设备离线)是账号级状态: 立刻换流地址重试必然再撞墙, 还多占一次
      // 拉流锁15~45秒 —— 不重试, 记退避, 删掉已写盘的错误帧, 直接抛错让上层回落免费快照。
      if (/占位流/.test(e.message)) {
        markStreamBackoff();
        discardOutFile(outFile);
        throw e;
      }
      // 偶发丢包/取流抖动: 换新流地址再试一次, 仍失败才抛错(触发上层回落)
      try {
        const r2 = await client.liveAddress(serial, { quality: 1, protocol: 2, supportH265: 1, containerFormat: 1, expireTime: 600 });
        const d2 = Array.isArray(r2.data) ? r2.data[0] : r2.data;
        if (d2 && d2.url) { d.url = d2.url; await probeErrCode(d.url).catch(function (e0) { markStreamBackoff(); throw e0; }); sz = await attempt(); }
        else throw new Error("重试取流地址为空");
      } catch (e2) {
        if (/占位流/.test(e2.message)) markStreamBackoff();
        discardOutFile(outFile);
        throw new Error("截帧失败(" + e.message.slice(0, 80) + "), 重试也失败(" + e2.message.slice(0, 60) + ")");
      }
    }
    return { hd: true, w: sz.w, h: sz.h };
  } finally {
    releaseStreamLock();
  }
}

// 高清抓图: 截帧优先, 失败回落 /api/lapp/device/capture。
// 返回 { ok, hd, w, h, picUrl } —— picUrl 仅回落路径有(原接口语义), 调用方原来拿 picUrl 下载的逻辑不变。
async function captureHD(client, serial, outFile) {
  // 9048 退避窗口内跳过拉流截帧(必然撞墙还占拉流锁)。
  //
  // 2026-10-08 断环: 退避窗口内**直接抛错, 不再回落 client.capture()**。
  // 原来退避期内是"跳过拉流 → 回落抓图接口", 而 client.capture 正是吃萤石 10028 抓图配额的接口 ——
  // 于是「9048 退避 → 回落 → 爆抓图配额 → 拉流更困难 → 更快 9048」形成闭环死循环
  // (实测 10028 出现 589 次、9048 出现 803 次, monitor 高清截帧 574 次尝试成功 0 次)。
  // 现在退避期内宁可抛错让调用方走"无配图"占位, 也不再消耗抓图配额 —— 让配额留给真正需要的时刻。
  if (inStreamBackoff()) {
    throw new Error("取流限流退避中(9048), 跳过抓图以保留抓图配额");
  }
  // 抓图配额已耗尽: 主码流截帧**不吃抓图配额**, 所以仍然可以试一次(高清优先);
  // 只有回落路径才需要跳过, 在下面 client.capture 之前判断。
  let streamErr = null;
  try {
    const meta = await streamFrame(client, serial, outFile);
    return Object.assign({ ok: true }, meta);
  } catch (e) { streamErr = e; }
  // 回落原抓图接口: 保持老流程兼容(下载 picUrl 到 outFile)
  // 配额已耗尽则不再调用(10028 按自然日重置, 硬试只会刷屏且必然失败)
  if (captureQuotaExhausted()) {
    throw new Error("高清截帧失败(" + String(streamErr.message).slice(0, 80) + "), 抓图配额今日已耗尽(10028), 跳过回落抓图");
  }
  // 注意 10028(抓图次数超限) 是**当日配额**耗尽, 撞上就记 24 小时退避 —— 免费版配额按自然日重置,
  // 继续硬试只会刷屏且永远失败(webhook.js 的 isQuotaExhausted 只管微信 API 配额, 管不到萤石抓图配额)。
  const r = await client.capture(serial);
  if (r.code !== "200") {
    if (String(r.code) === "10028" || /次数超限|抓图.*超限/.test(String(r.msg || ""))) {
      markCaptureQuotaExhausted();
      throw new Error("抓图配额已耗尽(code=10028), 今日不再重试(等次日配额重置)");
    }
    throw new Error("高清截帧失败(" + String(streamErr.message).slice(0, 80) + "), 原抓图也失败 code=" + r.code + " " + (r.msg || ""));
  }
  const d = Array.isArray(r.data) ? r.data[0] : r.data;
  await client.downloadTo(d.picUrl, outFile);
  // 免费快照同样可能拿到错误占位图(512x288): 正常快照档为768x432, 宽度≤640判为无效 ——
  // 删除并抛错, 宁可让调用方走"无配图"占位, 也不让白屏错误帧混进 captures/ 污染看板选图
  let sz = null;
  try { sz = jpegSize(fs.readFileSync(outFile)); } catch (e) {}
  if (!sz || !sz.w || sz.w <= 640) {
    discardOutFile(outFile);
    throw new Error("回落快照疑似错误占位图(" + (sz ? sz.w + "x" + sz.h : "无法解析尺寸") + "), 已丢弃");
  }
  return { ok: true, hd: false, picUrl: d.picUrl };
}

// ---------- 抓图配额(10028)耗尽态 ----------
// 萤石免费版抓图配额按**自然日**重置(实测 code=10028 = 抓图接口调用次数超限, 100 次/天/设备)。
// 这是与 9048(并发观看) 完全不同的一回事: 9048 等几分钟能恢复, 10028 要等到次日 0 点。
// 之前系统对 10028 一无所知(isQuotaExhausted 只管微信 API 配额), 于是每次报警都去硬试一次,
// 每次都失败, 刷屏且永远拿不到图。这里记一个跨进程共享的耗尽标记(三个进程都能读), 撞上即当天停手。
const CAPTURE_QUOTA_FILE = path.join(ROOT, "data", "capture_quota.json");
function markCaptureQuotaExhausted() {
  try {
    const d = new Date();
    const endOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0).getTime();
    fs.writeFileSync(CAPTURE_QUOTA_FILE, JSON.stringify({ until: endOfDay, at: Date.now() }));
    console.log("[高清抓图] ⚠️ 抓图配额已耗尽(code=10028)，本进程今日不再调用抓图接口，等次日 0 点配额重置");
  } catch (e) {}
}
function captureQuotaExhausted() {
  try {
    const q = JSON.parse(fs.readFileSync(CAPTURE_QUOTA_FILE, "utf8"));
    return Number(q && q.until) > Date.now();
  } catch (e) { return false; }
}

// 生成缩略图(ffmpeg): 把 srcPath 压到 width 宽 JPEG 存到 outPath。
// 实测 3200x1800 原图(2.3MB) -> 600宽 q:v5 = 62KB(约38倍压缩), 用于详情页"秒开"(走花生壳隧道传输量至关重要)。
// 与 /captures/thumb/ 路由共用, 保证预生成与按需生成产物一致。
async function makeThumb(srcPath, outPath, width, quality) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error("ffmpeg 不可用");
  await execFileP(ffmpeg, [
    "-y", "-loglevel", "error",
    "-i", srcPath,
    "-vf", "scale=" + (width || 600) + ":-2",
    "-q:v", String(quality || 5),
    outPath
  ], 20000);
  const sz = jpegSize(fs.readFileSync(outPath));
  if (!sz || !sz.w) throw new Error("缩略图产物异常");
  return sz;
}

module.exports = {
  captureHD: captureHD, streamFrame: streamFrame, findFfmpeg: findFfmpeg, jpegSize: jpegSize, makeThumb: makeThumb,
  // 供调用方(webhook/monitor)在发请求前先判断配额/退避态, 避免无谓调用与日志刷屏
  captureQuotaExhausted: captureQuotaExhausted,
  inStreamBackoff: inStreamBackoff,
};
