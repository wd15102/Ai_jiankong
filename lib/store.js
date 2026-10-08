// lib/store.js — 跨进程安全的 JSON 存储(文件锁 + 读-改-写事务)
//
// 要解决的问题:
//   data/events.json 被 webhook.js / webapp.js / monitor.js 三个**独立进程**同时读写。
//   原来的写法是「读全量 -> 改 -> 写全量」, 两个进程交错执行时, 后写的会把先写的整份覆盖掉:
//     P1 读(459条) ... P2 读(459条) -> P1 写(460条) -> P2 写(460条)   # P1 那条永久丢失
//   「先写 .tmp 再改名」只保证读方看到的是完整文件, 不保证「不丢更新」——这是两件事。
//   实测对照(6进程×120条): 无锁只落盘 16/720 条。
//
// 这里补上跨进程文件锁, 并把「读-改-写」收敛成一个事务:
//   加锁 -> 重新读最新内容 -> mutate(arr) 原地改 -> 原子落盘 -> 解锁
//
// 两条硬约束:
//   1) mutate 必须是**同步函数**, 且不能在里面 await。需要异步准备(下载图片/调 AI)就先做完,
//      最后用 updateJson/updateEvents 一次性提交 —— 在"读"和"写"之间夹 await 正是原来丢数据的根因。
//   2) 拿不到锁时返回 ok:false, 调用方**必须**处理。静默丢弃和静默覆盖一样都是 bug。
//
// 另外修掉一个隐性竞态: 原来三个进程共用同一个临时文件名 `events.json.tmp`,
// 并发写时两个进程往同一个 tmp 里交错写, 谁先改名谁就把对方的半截内容发布出去。现在 tmp 名带 pid。
const fs = require("fs");
const path = require("path");
const os = require("os");

const LOCK_TIMEOUT_MS = 10000; // 等锁上限。事务体是纯同步代码, 正常持锁在毫秒级, 真等这么久说明异常
const LOCK_STALE_MS = 8000;    // 只在「无法判断持锁进程是否存活」时才按年龄抢锁
const DEFAULT_EVENT_CAP = 20000; // events.json 默认保留条数(≈90天), 与截图保留期对齐
const HOST = os.hostname();

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// 判断 pid 是否存活: 用于识别"崩溃/被强杀后残留的锁", 避免误抢活进程的锁
function pidAlive(pid) {
  const n = Number(pid);
  if (!n || n <= 0) return false;
  try { process.kill(n, 0); return true; }
  catch (e) { return e.code === "EPERM"; } // EPERM = 进程存在但无信号权限
}

// 解析失败时把损坏内容留档(保留原行为)。
// 加 60 秒节流: 避免文件损坏后每个读方各留一份档、短时间内刷出一堆 .corrupt 文件。
const _lastBackup = {};
function backupCorrupt(file) {
  try {
    const now = Date.now();
    if (_lastBackup[file] && now - _lastBackup[file] < 60e3) return;
    _lastBackup[file] = now;
    if (fs.existsSync(file) && fs.statSync(file).size > 0) {
      fs.copyFileSync(file, file + ".corrupt." + now);
      console.log("[store] " + path.basename(file) + " 解析失败, 已留档 " + path.basename(file) + ".corrupt." + now);
    }
  } catch (e) {}
}

function readJson(file, fallback) {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return v === null || v === undefined ? fallback : v;
  } catch (e) {
    if (e.code !== "ENOENT") backupCorrupt(file); // 文件不存在是正常的首次启动, 不算损坏
    return fallback;
  }
}

// 原子落盘: 先写临时文件再改名, 读方要么看到完整旧内容要么看到完整新内容
function writeJsonAtomic(file, value, indent) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const content = JSON.stringify(value, null, indent === undefined ? 1 : indent);
  const tmp = file + ".tmp." + process.pid; // 带 pid: 三个进程各有各的 tmp, 不再互相踩
  fs.writeFileSync(tmp, content);
  try { fs.renameSync(tmp, file); }
  catch (e) {
    // Windows 上目标被占用(杀软扫描/索引/别的进程正在读)时 rename 可能失败 -> 退回原地直写
    try { fs.writeFileSync(file, content); } finally { try { fs.unlinkSync(tmp); } catch (e2) {} }
  }
}

function lockPath(file) { return file + ".lock"; }

// 事务进行中的文件集合: 用于拦截"mutate 里又调 updateJson"这种会自锁死的重入
const _inTxn = new Set();

// 抢锁: 用 O_CREAT|O_EXCL 原子创建锁文件, 三个进程中只有一个能成功
// 注意 Windows 的坑: 文件已存在时 openSync("wx") 返回的是 EPERM 而不是 EEXIST
// (Node 在 Windows 上 O_CREAT|O_EXCL 的已知行为), 必须一并当作"被占用"重试,
// 否则会把正常的锁竞争误判成致命错误 -> 静默丢事件(实测 6 进程压测每轮丢 1~2 条)。
const BUSY_CODES = { EEXIST: 1, EPERM: 1, EACCES: 1, EBUSY: 1 };
let _selfStealLogged = false; // "回收本进程遗留锁" 只提示一次, 避免高频并发下刷屏
function newToken() {
  return process.pid + "@" + HOST + "@" + Date.now() + "@" + Math.random().toString(36).slice(2, 8);
}
// 解析锁文件内容 -> { pid, host }
function parseLock(info) {
  const p = String(info || "").split("@");
  return { pid: p[0] || "", host: p[1] || "" };
}
// 删除"确认是自己的"锁: 先比对内容, 内容变了说明已被别人接手, 不能删
function unlinkIfMine(lp, token) {
  try {
    if (fs.readFileSync(lp, "utf8") !== token) return "changed";
    fs.unlinkSync(lp);
    return "ok";
  } catch (e) {
    return e.code === "ENOENT" ? "ok" : "err";
  }
}

async function acquireLock(file, timeoutMs) {
  if (_inTxn.has(file)) throw new Error("updateJson 重入: mutate 里不要再调 updateJson/updateEvents");
  const lp = lockPath(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + (timeoutMs > 0 ? timeoutMs : LOCK_TIMEOUT_MS);
  const token = newToken();
  let waited = 0, spins = 0;
  for (;;) {
    try {
      const fd = fs.openSync(lp, "wx");
      try { fs.writeSync(fd, token); } finally { fs.closeSync(fd); }
      if (waited > 200) console.log("[store] 等锁 " + waited + "ms 后取得 " + path.basename(lp));
      return token;
    } catch (e) {
      if (!BUSY_CODES[e.code]) return false; // 真·致命(路径不可写/磁盘只读等): 不阻塞业务, 由调用方决定
    }
    // 读锁内容, 判断持锁者是否还活着 —— 比单纯看年龄可靠, 不会抢走活进程的锁
    let info = null;
    try { info = fs.readFileSync(lp, "utf8"); }
    catch (e2) { if (e2.code !== "ENOENT") info = ""; } // 读不到(被占用等): info="" 走年龄兜底
    let shouldSteal = false, reason = "";
    if (info === null) {
      // 锁刚被释放(文件已不存在): 立即重试, 不要傻等
      if (Date.now() >= deadline && waited > 0) return false;
      if (++spins > 500) { spins = 0; await sleep(3); }
      continue;
    }
    const lk = parseLock(info);
    let quiet = false;
    if (lk.host === HOST && lk.pid) {
      if (!pidAlive(lk.pid)) { shouldSteal = true; reason = "持锁进程 " + lk.pid + " 已不存在"; }
      else if (lk.pid === String(process.pid)) {
        // 本进程自己的锁, 且我们此时不在事务里(_inTxn 已拦截重入) —— 只可能是上次 releaseLock 没删掉。
        // 抢它不会丢数据: releaseLock 删之前会比对自己那把锁的 token, 内容变了就说明已被别人接手, 不会误删。
        shouldSteal = true; reason = "本进程上次释放失败留下的锁"; quiet = true;
      }
    } else {
      let age = 0;
      try { age = Date.now() - fs.statSync(lp).mtimeMs; } catch (e3) { age = 0; }
      if (age > LOCK_STALE_MS) { shouldSteal = true; reason = "锁已存在 " + Math.round(age / 1000) + "s(无法确认持锁进程)"; }
    }
    if (shouldSteal) {
      // 先改名再删: 避免删掉别的进程在这两步之间刚创建的新锁
      try {
        const g = lp + ".stale." + process.pid; fs.renameSync(lp, g); fs.unlinkSync(g);
        // 自己回收自己的锁是正常自愈, 高频并发下会刷屏 -> 每个进程只提示一次
        if (!quiet || !_selfStealLogged) { console.log("[store] 清理残留锁 " + path.basename(lp) + " (" + reason + ")"); _selfStealLogged = true; }
      } catch (e4) {}
      if (++spins > 500) { spins = 0; await sleep(3); }
      if (Date.now() >= deadline && waited > 0) return false;
      continue;
    }
    if (Date.now() >= deadline) return false;
    const nap = 4 + Math.floor(Math.random() * 16); // 抖动退避, 避免多进程同步重试
    waited += nap;
    await sleep(nap);
  }
}

// 释放锁。Windows 上 unlink 偶发 EPERM(文件被杀软/索引短暂占用), 直接失败会让
// 本进程自己的锁残留、下次抢锁时撞上"持锁者=自己"的僵局, 所以带重试。
async function releaseLock(file, token) {
  const lp = lockPath(file);
  for (let i = 0; i < 6; i++) {
    const r = unlinkIfMine(lp, token);
    if (r === "ok" || r === "changed") return;
    await sleep(3 + i * 3);
  }
  console.log("[store] 释放锁失败(已重试), 残留 " + path.basename(lp) + " 将在下次抢锁时按 pid 自愈");
}

// 事务式读改写(异步)。mutate 必须是同步函数, 返回值约定:
//   false      -> 内容无变化, 跳过写入(省一次落盘)
//   []         -> 用返回的数组整体替换
//   其他返回值 -> 使用 mutate 原地修改后的数组
// 返回 { ok, written, value, error }: ok=false 表示**没拿到锁, 本次改动被放弃**
async function updateJson(file, mutate, opts) {
  opts = opts || {};
  const fallback = opts.fallback === undefined ? [] : opts.fallback;
  const cap = Number(opts.cap) > 0 ? Number(opts.cap) : 0;
  if (_inTxn.has(file)) throw new Error("updateJson 重入: mutate 里不要再调 updateJson/updateEvents (" + path.basename(file) + ")");
  const token = await acquireLock(file, opts.lockTimeoutMs);
  if (!token) {
    const msg = "等待 " + path.basename(file) + ".lock 超时, 放弃本次写入";
    console.log("[store] " + msg);
    return { ok: false, written: false, value: undefined, error: new Error(msg) };
  }
  // 从这里到 releaseLock 之间**不能有 await**: 事务体全同步, 所以本进程不会并发进入同一文件的事务
  _inTxn.add(file);
  let result;
  try {
    let arr = readJson(file, fallback);
    if (fallback instanceof Array && !Array.isArray(arr)) arr = fallback;
    const r = mutate(arr);
    if (r === false) result = { ok: true, written: false, value: r };
    else {
      const next = Array.isArray(r) ? r : arr;
      const capped = cap > 0 && next.length > cap ? next.slice(-cap) : next;
      writeJsonAtomic(file, capped, opts.indent === undefined ? 1 : opts.indent);
      result = { ok: true, written: true, value: r };
    }
  } catch (e) {
    console.log("[store] 写入 " + path.basename(file) + " 失败: " + String(e.message).slice(0, 100));
    result = { ok: false, written: false, value: undefined, error: e };
  } finally {
    _inTxn.delete(file);
  }
  await releaseLock(file, token);
  return result;
}

// ---------- events.json 专用封装(三个服务共用同一份文件与同一把锁) ----------
function eventsPath(root) { return path.join(root, "data", "events.json"); }

// 读不加锁: 落盘是「改名」原子操作, 读方看到的永远是完整内容(旧或新), 不会读到半截
function readEvents(root) {
  const a = readJson(eventsPath(root), []);
  return Array.isArray(a) ? a : [];
}

// 保留条数: 统一读 config.json 的 storage.eventRetention
// -1 = 不限制(长期保存); 0/未配置 = 回落默认 20000; >0 = 按条数保留
// (原来 monitor/webapp 里硬编码 20000, 只有 webhook 读配置, 改配置等于没改)
function eventCap(cfg) {
  const n = cfg && cfg.storage && Number(cfg.storage.eventRetention);
  if (n === -1) return -1; // 不限制
  return n > 0 ? n : DEFAULT_EVENT_CAP;
}

async function updateEvents(root, mutate, opts) {
  const merged = Object.assign({ fallback: [], cap: DEFAULT_EVENT_CAP }, opts || {});
  merged.fallback = [];
  return updateJson(eventsPath(root), mutate, merged);
}

module.exports = {
  readJson, writeJsonAtomic, updateJson,
  readEvents, updateEvents, eventsPath, eventCap,
  sleep, pidAlive, LOCK_TIMEOUT_MS, LOCK_STALE_MS
};
