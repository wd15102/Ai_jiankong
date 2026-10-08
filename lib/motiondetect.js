// lib/motiondetect.js — 本地补充人形检测（自写算法，零外部依赖）
// 原理: 背景帧差(背景减除) + 3x3 模糊去噪 + 二值化 + 连通域分析 + 人形启发式筛选
//   人形启发式 = 面积占比 + 高宽比 + 填充率 + **竖直边缘密度**(区分人vs地面光影的关键)
// 依赖: 仅 jimp(项目已有, 只用于 JPEG 解码与缩放); 不调用萤石云/任何外部 AI, 无 API 配额消耗
// 局限: 启发式算法, 不是神经网络。静止不动的人检测不到(帧差依赖变化), 宠物/大幅光影可能误报
//       —— 因此命中后仍走原有"云端 AI 复核"链路, 由 judgePerson 做最终门控, 本地只做"省配额的前置筛"
const fs = require("fs");
const path = require("path");
const { Jimp } = require("jimp");

// 分析分辨率(16:9 降采样): 足够刻画人形轮廓, 单张处理几十毫秒
const W = 320, H = 180;
const PX = W * H;
// 阈值均经真实 motion 图回测校准(187张样本): 树影/灌木/狗/车是高发误报源, 宁紧勿松
// —— 本地只做前置筛, 漏几个无妨, 误报会浪费云端AI配额+打扰用户
const DIFF_TH = 22;              // 灰度差阈值(0-255), 低于此视为噪声
const LIGHT_RATIO = 0.75;        // 掩膜面积占比超过此值且无大型集中blob -> 光照/红外切换/镜头遮挡, 跳过
const BIG_BLOB_PCT = 0.08;       // 最大 blob 面积占比超过此值 -> 认为是大型物体(人/车), 不做光照跳过
const MIN_BLOB = 40;             // 最小连通域像素, 滤掉小噪点(虫/叶尖)
const AREA_MIN = 0.008;          // 人形最小面积占比: 实测真人>0.8%, 树影碎片常<0.5%
const AREA_MAX = 0.08;           // 最大占比: 实测>8%的大blob几乎全是树影/动物/车, 直接砍掉
const ASPECT_MIN = 0.75;         // 高宽比下限(高/宽 >= 0.75): 人形大致竖直, 地面光影宽扁被滤
const ASPECT_MAX = 2.0;          // 上限: >2 的细长块实测几乎全是树干/灌木
const FILL_MIN = 0.30;           // 填充率下限(实心度): 树影/飘动衣物稀疏, 通常被滤掉
const EDGE_MIN = 0.25;           // 竖直边缘密度下限: 人形轮廓富含竖直边缘, 树影/地面光影普遍<0.2
const REF_MIN_AGE_MS = 8 * 60 * 1000;    // 背景参考图须早于当前至少 8 分钟(否则把"同一次活动"当背景)
const REF_MAX_AGE_MS = 3 * 3600 * 1000;  // 背景参考图太老(>3h)不用: 场景可能已大变
const STATIC_RATIO = 0.004;      // 差异占比低于此值 -> 静态背景, 顺手刷新参考图
// 静态伪影复核: 同一位置反复命中人形 -> 水塘反光/固定杂物/树影(真人会移动), 判非人并强制刷新参考
const PERSIST_DIST_PX = 12;      // 两次人形命中的 blob 质心位移低于此值(320x180 下约 3.75% 画面宽)视为同一位置
const PERSIST_WINDOW_MS = 30 * 60 * 1000; // 上次命中距今超过 30 分钟不复核(场景可能已大变, 旧位置失去参考意义)

function refDir(root) { return path.join(root, "data", "refs"); }
function refPath(root, serial) { return path.join(refDir(root), serial + ".gray"); }

// JPEG -> 320x180 灰度数组(Float32)
async function loadGray(file) {
  const img = await Jimp.read(file);
  img.resize({ w: W, h: H }); // jimp v1: resize 需对象参数(新版已不支持 resize(w,h) 位置参数)
  const d = img.bitmap.data;
  const g = new Float32Array(PX);
  for (let i = 0, p = 0; i < PX; i++, p += 4) g[i] = (d[p] + d[p + 1] + d[p + 2]) / 3;
  return g;
}

// 3x3 盒式模糊(水平+垂直两遍), 抑制 JPEG 噪声与传感器噪点
function blur3(g) {
  const tmp = new Float32Array(PX);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      let s = 0, n = 0;
      for (let k = -1; k <= 1; k++) { const xx = x + k; if (xx >= 0 && xx < W) { s += g[row + xx]; n++; } }
      tmp[row + x] = s / n;
    }
  }
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      let s = 0, n = 0;
      for (let k = -1; k <= 1; k++) { const yy = y + k; if (yy >= 0 && yy < H) { s += tmp[yy * W + x]; n++; } }
      g[y * W + x] = s / n;
    }
  }
}

// 带标号的连通域: label 图输出每个像素的 blob 序号(>=1), 返回 blob 列表(顺序与标号一致)
// (无标号版 components() 已删除: analyzePair 统一用本函数, 一次扫描同时得到 blob 与 label)
function componentsLabeled(mask, label, minArea) {
  const stack = new Int32Array(PX);
  const blobs = [];
  let cur = 0;
  for (let i = 0; i < PX; i++) {
    if (!mask[i] || label[i]) continue;
    cur++;
    let sp = 0; stack[sp++] = i; label[i] = cur;
    let area = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % W, y = (p - x) / W;
      area++;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && mask[p - 1] && !label[p - 1]) { label[p - 1] = cur; stack[sp++] = p - 1; }
      if (x < W - 1 && mask[p + 1] && !label[p + 1]) { label[p + 1] = cur; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - W] && !label[p - W]) { label[p - W] = cur; stack[sp++] = p - W; }
      if (y < H - 1 && mask[p + W] && !label[p + W]) { label[p + W] = cur; stack[sp++] = p + W; }
    }
    if (area >= minArea) {
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      blobs.push({ area: area, bw: bw, bh: bh, aspect: bh / bw, fill: area / (bw * bh), lb: cur, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 });
    }
  }
  return blobs;
}

// 人形启发式判定单个 blob
// edgeRatio: blob 内竖直边缘像素占 blob 面积比例(人形轮廓富含竖直边缘; 地面光影几乎为0)
function blobPasses(b, edgeRatio) {
  const areaPct = b.area / PX;
  if (areaPct < AREA_MIN || areaPct > AREA_MAX) return false;
  if (b.aspect < ASPECT_MIN || b.aspect > ASPECT_MAX) return false;
  if (b.fill < FILL_MIN) return false;
  if (edgeRatio < EDGE_MIN) return false;
  return true;
}

// 帧差分析: 当前图 vs 背景参考灰度
async function analyzePair(curFile, refGray) {
  const t0 = Date.now();
  const cur = await loadGray(curFile);
  blur3(cur);
  // refGray 是调用方缓存(可能复用), blur3 会原地修改 —— 先拷贝, 避免污染外部引用
  const ref = new Float32Array(refGray);
  blur3(ref);
  const mask = new Uint8Array(PX);
  let cnt = 0;
  for (let i = 0; i < PX; i++) {
    const v = Math.abs(cur[i] - ref[i]) > DIFF_TH ? 1 : 0;
    mask[i] = v; cnt += v;
  }
  const ratio = cnt / PX;
  const label = new Int32Array(PX);
  const blobs2 = componentsLabeled(mask, label, MIN_BLOB); // 带标号的 blob(供边缘密度统计)
  const maxBlobPct = blobs2.length ? Math.max.apply(null, blobs2.map(function (b) { return b.area / PX; })) : 0;
  // 光照/红外切换判定: 全画面大面积变化**且**没有集中的大型物体 -> 光照; 若存在占比>8%的集中blob,
  // 更可能是大型物体(人靠近/车), 不跳过(真实有人场景占比常达40-80%, 老阈值0.5会大量漏判)
  if (ratio > LIGHT_RATIO && maxBlobPct < BIG_BLOB_PCT) return { skipped: "lighting", ratio: ratio, ms: Date.now() - t0 };
  if (!blobs2.length) return { blobs: 0, ratio: ratio, hits: [], personLike: false, ms: Date.now() - t0 };

  // Sobel 竖直边缘图(|Gx| > 60 视为竖直边缘): 人形轮廓富含竖直边缘, 地面光影≈0
  const edge = new Uint8Array(PX);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const gx = -cur[i - W - 1] - 2 * cur[i - 1] - cur[i + W - 1] + cur[i - W + 1] + 2 * cur[i + 1] + cur[i + W + 1];
      edge[i] = Math.abs(gx) > 60 ? 1 : 0;
    }
  }
  // 每个 blob 的竖直边缘密度(人形轮廓富含竖直边缘; 地面光影/云影几乎为0, 这是区分人vs光影的关键)
  // 注意: label 编号含被 minArea 滤掉的小连通域, 必须用 blob 自身的 lb, 不能拿数组下标当 label
  let maxLb = 0;
  for (let i = 0; i < PX; i++) { if (label[i] > maxLb) maxLb = label[i]; }
  const edgeCnt = new Int32Array(maxLb + 1);
  const areaCnt = new Int32Array(maxLb + 1);
  for (let i = 0; i < PX; i++) {
    const lb = label[i];
    if (lb > 0) { areaCnt[lb]++; if (edge[i]) edgeCnt[lb]++; }
  }
  const hits = [];
  for (let k = 0; k < blobs2.length; k++) {
    const b = blobs2[k];
    const er = areaCnt[b.lb] > 0 ? edgeCnt[b.lb] / areaCnt[b.lb] : 0;
    b.edgeRatio = er;
    if (blobPasses(b, er)) hits.push(b);
  }
  hits.sort(function (a, b) { return b.area - a.area; });
  return { blobs: blobs2.length, ratio: ratio, hits: hits, personLike: hits.length > 0, top: hits[0] || null, ms: Date.now() - t0 };
}

// 用一张图重写背景参考(灰度降采样, 二进制存储)
async function refreshRefFrom(root, serial, file) {
  const g = await loadGray(file);
  fs.mkdirSync(refDir(root), { recursive: true });
  fs.writeFileSync(refPath(root, serial), Buffer.from(g.buffer, g.byteOffset, g.length * 4));
}

function loadRef(root, serial) {
  try {
    const buf = fs.readFileSync(refPath(root, serial));
    if (buf.length !== PX * 4) return null;
    // 拷贝到新 Buffer 确保 4 字节对齐(fs Buffer 来自池, 偏移可能不对齐), 再零拷贝视图化
    const aligned = new Uint8Array(buf).slice().buffer; // slice 拷贝 -> 新 ArrayBuffer, 偏移0必然对齐
    return new Float32Array(aligned, 0, PX);
  } catch (e) { return null; }
}

// 已命中 blob 的位置持久化(用于"静态伪影"复核: 同一位置反复命中 = 水塘反光/固定杂物/树影, 真人会移动)
function hitStatePath(root, serial) {
  return path.join(root, "data", "personhit", serial + ".json");
}
function loadHitState(root, serial) {
  try {
    const s = JSON.parse(fs.readFileSync(hitStatePath(root, serial), "utf8"));
    if (s && typeof s.cx === "number" && typeof s.cy === "number" && typeof s.area === "number" && typeof s.ts === "number")
      return s;
  } catch (e) {}
  return null;
}
function saveHitState(root, serial, state) {
  try {
    fs.mkdirSync(path.dirname(hitStatePath(root, serial)), { recursive: true });
    fs.writeFileSync(hitStatePath(root, serial), JSON.stringify(state));
  } catch (e) {}
}

// 在 captures/ 与 captures/motion/ 中找同设备"较早"的最新一张图(建参考图用)
function newestOlderImage(root, serial, minAgeMs, maxAgeMs) {
  const now = Date.now();
  const dirs = [path.join(root, "captures"), path.join(root, "captures", "motion")];
  let best = null;
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(d); } catch (e) { continue; }
    for (const f of files) {
      if (f.indexOf(serial + "_") !== 0 || !/\.jpe?g$/i.test(f)) continue;
      const rest = f.slice(serial.length + 1, -4); // p<ms> 或 <ms>
      const num = Number(rest.charAt(0) === "p" ? rest.slice(1) : rest);
      if (!isFinite(num) || num <= 0) continue;
      const age = now - num;
      if (age < minAgeMs || age > maxAgeMs) continue;
      if (!best || num > best.ts) best = { ts: num, file: path.join(d, f) };
    }
  }
  return best;
}

// 主入口: 分析一张"移动侦测"图是否含人形特征
// 返回 { personLike, skipped?, ratio, hits, top, ms }
async function analyze(root, serial, curFile) {
  // 1) 无背景参考图 -> 用同设备较早的图建一张(本次不判定, 下次生效)
  if (!loadRef(root, serial)) {
    const cand = newestOlderImage(root, serial, REF_MIN_AGE_MS, REF_MAX_AGE_MS);
    if (!cand) return { skipped: "noref" };
    try { await refreshRefFrom(root, serial, cand.file); } catch (e) { return { skipped: "ref-fail" }; }
    return { skipped: "ref-created" };
  }
  const refGray = loadRef(root, serial);
  const r = await analyzePair(curFile, refGray);
  if (r.skipped) return r;
  // 2) 静态背景(几乎无差异) -> 用当前图刷新参考, 让背景缓慢自适应(昼夜/光线渐变)
  if (r.ratio < STATIC_RATIO) {
    try { await refreshRefFrom(root, serial, curFile); } catch (e) {}
    return { personLike: false, ratio: r.ratio, hits: [], ms: r.ms, refUpdated: true };
  }
  // 3) 命中人形 -> 先复核"静态伪影": 与上次命中的 blob 位置对比,
  //    质心几乎重合 + 面积相近 = 水塘反光/固定杂物/树影(真人会移动), 判为非人并强制刷新参考
  if (r.personLike) {
    const top = r.top;
    const prev = loadHitState(root, serial);
    const now = { cx: top.cx, cy: top.cy, area: top.area, ts: Date.now() };
    if (prev && (now.ts - prev.ts) < PERSIST_WINDOW_MS) {
      const dx = top.cx - prev.cx, dy = top.cy - prev.cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const ar = top.area / (prev.area || 1);
      if (dist < PERSIST_DIST_PX && ar > 0.5 && ar < 2.0) {
        try { await refreshRefFrom(root, serial, curFile); } catch (e) {}
        saveHitState(root, serial, now);
        return { personLike: false, ratio: r.ratio, hits: [], staticArtifact: true, ms: r.ms };
      }
    }
    saveHitState(root, serial, now);
    return r;
  }
  // 4) 有变化但不像人(树/光影/动物) -> 适度刷新参考, 避免旧背景导致长期误报
  if (r.ratio < 0.06) {
    try { await refreshRefFrom(root, serial, curFile); } catch (e) {}
  }
  return r;
}

module.exports = {
  analyze: analyze,
  analyzePair: analyzePair, // 测试/调试用: 直接对两张图做帧差
  refPath: refPath,
  refreshRefFrom: refreshRefFrom,
  newestOlderImage: newestOlderImage,
  loadRef: loadRef,
  PX0: PX // 调试统计用
};
