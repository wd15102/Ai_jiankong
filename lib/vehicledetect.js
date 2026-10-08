// lib/vehicledetect.js — 本地车辆检测（自写算法，零外部依赖）
// 与 motiondetect(人形) 共用"帧差+连通域"骨架, 判别式针对车辆特征标定:
//   · 宽扁形态: 高宽比 0.25~0.9 (人形 0.75~2.0, 二者用 0.75~0.9 过渡带)
//   · 大面积: 2%~18% (车身比人大)
//   · 水平边缘 dominance: 车身上沿/车轮/货箱横线 -> 水平边缘密度 > 竖直边缘
//     (人形相反: 竖直边缘 dominance; 这是人/车区分的关键判据)
//   · 路面位置: blob 中心在画面下 2/3 (车在地面, 人可站立在画面上部)
// 命中即"疑似车辆(驾车/骑车经过)", 仍走云端 AI 复核车型, 本地只做前置筛
// 校准数据: 2026-09-25 用 captures 全库 AI 标注样本回测(见 debug_calib.js 输出)
const fs = require("fs");
const path = require("path");
const { Jimp } = require("jimp");

const W = 320, H = 180;
const PX = W * H;

// ---- 车辆阈值(经真实样本回测校准, 宁紧勿松) ----
const DIFF_TH = 22;              // 帧差灰度阈值(与人形一致)
const AREA_MIN = 0.025;          // 车辆最小面积占比(2.5%): 远处三轮车实测~2.5%, 再小多是被滤碎光影
const AREA_MAX = 0.18;           // 最大占比(18%): 更大会并入院子/光照, 跳过
const ASPECT_MAX = 1.35;         // 高宽比上限: 0.95时把"人骑车"形态(blob高宽比1.0~1.3)整体拒之门外=漏报骑电动车。
                                 // 2026-09-30 用71张真实双溪村样本(4阳/67阴)网格寻优: 放宽到1.35召回50%→75%
                                 // (回收蓝色汽车局部/骑电动车), 误报34%→42%, 误报代价由AI确认制兜住(不推给用户)
const ASPECT_MIN = 0.22;         // 下限: 极扁的长条(路面反光带)滤掉
const FILL_MIN = 0.25;           // 填充率下限(车轮/车窗/货箱有间隙)
const FILL_MAX = 0.92;           // 填充率上限: 接近全满是规则色块(光照/墙面), 非车
const HEDGE_MIN = 0.12;          // 水平边缘密度下限(车身上沿/车轮横线): 实测车辆 >0.25, 光影普遍 <0.1
const VEDGE_MAX = 0.45;          // 竖直边缘密度上限: 车竖直特征少(人形普遍>0.25)
const CENTER_Y_MIN = 0.15;       // blob 中心纵坐标占比下限: 实测三轮车远处时 cy≈0.23, 人形 cy 普遍>0.4;
                                 // 0.15 主要挡天空/树冠区域的碎块(它们多被面积/形态先行滤掉)
const MIN_BLOB = 240;            // 最小连通域像素
const MASK_MAX = 0.45;           // 单 blob 面积超过此值视为"地面光影连片/光照剧变", 整帧跳过

function refPath(root, serial) { return path.join(root, "data", "refs", serial + ".gray"); }

async function loadGray(file) {
  const img = await Jimp.read(file);
  img.resize({ w: W, h: H });
  const d = img.bitmap.data;
  const g = new Float32Array(PX);
  for (let i = 0, p = 0; i < PX; i++, p += 4) g[i] = (d[p] + d[p + 1] + d[p + 2]) / 3;
  return g;
}

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

// 带标号连通域(人/车共用实现)
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
      blobs.push({ area: area, bw: bw, bh: bh, aspect: bh / bw, fill: area / (bw * bh), cy: (y0 + y1) / 2 / H, cx: (x0 + x1) / 2 / W, lb: cur });
    }
  }
  return blobs;
}

function loadRef(root, serial) {
  try {
    const buf = fs.readFileSync(refPath(root, serial));
    if (buf.length !== PX * 4) return null;
    return new Float32Array(new Uint8Array(buf).slice().buffer, 0, PX);
  } catch (e) { return null; }
}

// Sobel 双向边缘图: edgeH=水平梯度(检测水平边缘: 车身上沿/车轮横线)
//                    edgeV=竖直梯度(检测竖直边缘: 人形轮廓/树干)
// 车辆: 水平边缘 >> 竖直边缘;  人形: 竖直边缘 >> 水平边缘
async function analyzePair(curFile, refGray) {
  const t0 = Date.now();
  const cur = await loadGray(curFile);
  blur3(cur);
  const ref = new Float32Array(refGray); // 拷贝, 避免 blur 污染调用方缓存
  blur3(ref);

  const mask = new Uint8Array(PX);
  let cnt = 0;
  for (let i = 0; i < PX; i++) {
    const v = Math.abs(cur[i] - ref[i]) > DIFF_TH ? 1 : 0;
    mask[i] = v; cnt += v;
  }
  const ratio = cnt / PX;
  const label = new Int32Array(PX);
  const blobs = componentsLabeled(mask, label, MIN_BLOB);
  if (!blobs.length) return { blobs: 0, ratio: ratio, hits: [], vehicleLike: false, ms: Date.now() - t0 };
  // 存在"连片大mask"(地面光影/光照剧变把人车糊进去) -> 先标记, 但仍允许判定
  // 独立的次级大blob(2%~18%, 边缘特征强): 光影连片是地面, 但独立块体可能是车/人, 值得送AI复核
  const maxBlob = Math.max.apply(null, blobs.map(function (b) { return b.area; }));
  const bigMask = maxBlob / PX > MASK_MAX;

  // Sobel 双向边缘
  const edgeH = new Uint8Array(PX), edgeV = new Uint8Array(PX);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const gx = -cur[i - W - 1] - 2 * cur[i - 1] - cur[i + W - 1] + cur[i - W + 1] + 2 * cur[i + 1] + cur[i + W + 1];
      const gy = -cur[i - W - 1] - 2 * cur[i - W] - cur[i - W + 1] + cur[i + W - 1] + 2 * cur[i + W] + cur[i + W + 1];
      if (Math.abs(gx) > 60) edgeV[i] = 1; // Gx 大 -> 竖直边缘
      if (Math.abs(gy) > 60) edgeH[i] = 1; // Gy 大 -> 水平边缘
    }
  }
  // 每个 blob 的水平/竖直边缘密度(用 blob 自身 label 编号索引, 注意 label 含被
  // minArea 滤掉的小连通域, 不能拿 blobs 数组下标当 label)
  let maxLb = 0;
  for (let i = 0; i < PX; i++) { if (label[i] > maxLb) maxLb = label[i]; }
  const hCnt = new Int32Array(maxLb + 1), vCnt = new Int32Array(maxLb + 1), aCnt = new Int32Array(maxLb + 1);
  for (let i = 0; i < PX; i++) {
    const lb = label[i];
    if (lb > 0) { aCnt[lb]++; if (edgeH[i]) hCnt[lb]++; if (edgeV[i]) vCnt[lb]++; }
  }
  const hits = [];
  for (let k = 0; k < blobs.length; k++) {
    const b = blobs[k];
    const a = aCnt[b.lb] || 1;
    b.hEdge = hCnt[b.lb] / a;
    b.vEdge = vCnt[b.lb] / a;
    if (vehPasses(b, bigMask)) hits.push(b);
  }
  hits.sort(function (a, b) { return b.area - a.area; });
  // list: 全部blob的指标明细(诊断/校准用, 生产逻辑只读hits) —— 2026-09-29 校准时发现
  // 无法从返回值判断"漏报卡在哪个条件", 加此字段让校准工具能逐blob重放各阈值组合
  return { blobs: blobs.length, list: blobs, ratio: ratio, hits: hits, vehicleLike: hits.length > 0, top: hits[0] || null, ms: Date.now() - t0, bigMask: bigMask };
}

// 车辆启发式(blob 必需通过面积/形态/边缘/位置四类判据)
// strict=true(帧内存在连片大mask时): 标准收紧, 只认"独立成块"的车辆
function vehPasses(b, strict) {
  const areaPct = b.area / PX;
  if (areaPct < AREA_MIN || areaPct > AREA_MAX) return false;
  if (b.aspect > ASPECT_MAX || b.aspect < ASPECT_MIN) return false;
  if (b.fill < FILL_MIN || b.fill > FILL_MAX) return false;
  if (b.cy < CENTER_Y_MIN) return false; // 太靠画面上部(天空/树冠)不像路面车辆
  if (strict) {
    // 大 mask 场景(地面连片变化): 只认真正独立的车辆块 —— 面积和水平边缘都要更强
    if (areaPct < 0.04) return false;
    if (b.hEdge < 0.25) return false;
  } else {
    if (b.hEdge < HEDGE_MIN) return false;
  }
  if (b.vEdge > VEDGE_MAX) return false;
  return true;
}

// 对外入口: 直接用现成背景参考(调用方管理 ref 生命周期)
async function analyzeFrame(root, serial, curFile) {
  const ref = loadRef(root, serial);
  if (!ref) return { skipped: "noref" };
  return analyzePair(curFile, ref);
}

module.exports = {
  analyzeFrame: analyzeFrame,
  analyzePair: analyzePair,
  refPath: refPath,
  PX0: PX
};
