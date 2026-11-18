// 抓图文件名公共模块: 生成 / 解析 / 校验 captures 目录下的图片文件名
// 命名规则: {村名}_{YYYY}_{MM}_{DD}_{HH}_{mm}_{ss}_{序列号}[_p].jpg
//   无 _p 后缀: 高清截帧(hdcapture.captureHD, ffmpeg 主码流 3200x1800) → hd=true
//   带 _p 后缀: 萤石设备端自带截图(picUrl 下载, 768x432 普通档)      → hd=false
// 同一活动同秒重复抓图时, webhook 会在结尾再追加 "_{毫秒时间戳}" 去重, 解析时兼容。

"use strict";

// Windows 文件名非法字符 + 控制字符
var ILLEGAL_RE = /[\\/:*?"<>|\x00-\x1f\x7f]/g;

function pad2(n) { return (n < 10 ? "0" : "") + n; }

function safePart(s) { return String(s || "").replace(ILLEGAL_RE, "").trim(); }

// 生成抓图文件名。withP=true 表示设备端普通截图(_p 后缀), false 表示高清截帧(无后缀)
function captureFileName(serial, tsMs, village, withP) {
  var d = new Date(tsMs || Date.now());
  return (safePart(village) || "unknown") +
    "_" + d.getFullYear() +
    "_" + pad2(d.getMonth() + 1) +
    "_" + pad2(d.getDate()) +
    "_" + pad2(d.getHours()) +
    "_" + pad2(d.getMinutes()) +
    "_" + pad2(d.getSeconds()) +
    "_" + (safePart(serial) || "unknown") +
    (withP ? "_p" : "") +
    ".jpg";
}

// village_YYYY_M_D_H_m_s_serial[_p][_去重序号].jpg
// 去重后缀: 新版是 13 位毫秒时间戳, 旧版是 _2/_3 计数器, 都兼容
// serial 用惰性匹配: 让结尾的 _p / _去重序号 优先归各自的分组, 而不是被吞进 serial
var PARSE_RE = /^(.+?)_(\d{4})_(\d{1,2})_(\d{1,2})_(\d{1,2})_(\d{1,2})_(\d{1,2})_(.+?)(_p)?(?:_(\d+))?\.jpe?g$/i;

// 解析抓图文件名 → { name, village, serial, t, hd, p, ms }
// t: 按文件名里的本地日期时间算出的毫秒时间戳; hd: 是否高清截帧(无 _p 后缀);
// ms: 去重后缀里的数字(新版本为毫秒时间戳, 旧版本为计数器; 无则 null)。缩略图等无法识别的名字返回 null。
function parseCaptureName(f) {
  if (typeof f !== "string") return null;
  var m = PARSE_RE.exec(f);
  if (!m) return null;
  var y = +m[2], mo = +m[3], d = +m[4], h = +m[5], mi = +m[6], s = +m[7];
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31 ||
      h > 23 || mi > 59 || s > 59) return null;
  var t = new Date(y, mo - 1, d, h, mi, s).getTime();
  if (!isFinite(t)) return null;
  var p = m[9] === "_p";
  return {
    name: f,
    village: m[1],
    serial: m[8],
    t: t,
    hd: !p,
    p: p,
    ms: m[10] ? +m[10] : null
  };
}

// 静态访问 captures 图片时的文件名安全校验(防路径穿越/非图片文件)
// 只放行纯文件名 + 常见图片扩展名; 缩略图 thumb_*.jpg 等同样放行
function safeImageName(name) {
  if (typeof name !== "string" || !name || name.length > 255) return false;
  if (/[/\\]/.test(name)) return false;            // 禁路径分隔符
  if (/[\x00-\x1f\x7f]/.test(name)) return false;  // 禁控制字符
  if (/^\.|\.\./.test(name)) return false;         // 禁以.开头与..片段
  if (!/\.(jpe?g|png|gif|webp|bmp)$/i.test(name)) return false;
  return true;
}

module.exports = { captureFileName: captureFileName, parseCaptureName: parseCaptureName, safeImageName: safeImageName };
