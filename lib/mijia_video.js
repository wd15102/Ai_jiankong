// lib/mijia_video.js — 米家报警视频取高清帧
//
// 报警事件带 HLS 视频(AES-128-CBC):
//   1) business.smartcamera.api.io.mi.com/common/app/m3u8  -> m3u8 文本(key URI + IV + 分片 URL)
//   2) key:  app.processor.smartcamera.api.io.mi.com/miot/camera/app/play/v1/key
//   3) 分片: app.processor.smartcamera.api.io.mi.com/miot/camera/app/play/v1/video/ts
//   4) AES-128-CBC 解密后合并 -> ffmpeg 截帧
// 用途: ① 对报警取高清帧; ② fetchVideo 下载**完整报警片段**(约9s)并转码为
//        H.264 MP4(faststart), 供微信详情页/看板点击回看。
//        米家分片是 H.265, 手机浏览器(含微信X5内核)播不了, 必须转码 H.264
//        (优先 NVENC 硬编, 失败回落 libx264 软编)。
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const FFmpeg_CANDIDATES = [
  path.join(ROOT, "bin", "ffmpeg.exe"),
  path.join(ROOT, "bin", "ffmpeg"),
  "C:/Users/wd/.workbuddy/binaries/node/workspace/node_modules/ffmpeg-static/ffmpeg.exe"
];

function findFfmpeg() {
  for (const p of FFmpeg_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch (e) {}
  }
  return null;
}

function headers(tok) {
  // 与 tools/mijia_hd.py 一致只带 Cookie(m3u8/key/分片接口响应均为明文/二进制, 无需加密头)
  return {
    "Cookie": "serviceToken=" + tok.serviceToken + "; yetAnotherServiceToken=" + tok.serviceToken + "; userId=" + tok.userId
  };
}

// 取 m3u8 文本(明文)
async function fetchM3u8(fileId, tok, mijia) {
  const api = "https://business.smartcamera.api.io.mi.com/common/app/m3u8";
  const rqd = { did: mijia.DID, model: mijia.MODEL, fileId: fileId, isAlarm: true, videoCodec: "H265" };
  const params = mijia.rc4Params("GET", api, { data: JSON.stringify(rqd) }, tok.ssecurity);
  params["yetAnotherServiceToken"] = tok.serviceToken;
  const u = new URL(api);
  for (const k of Object.keys(params)) u.searchParams.set(k, params[k]);
  const res = await fetch(u.toString(), { headers: headers(tok), signal: AbortSignal.timeout(40000) });
  const buf = Buffer.from(await res.arrayBuffer());
  // m3u8 接口返回**明文**(mijia_hd.py 直接 r.text 解析), 不要做 RC4 解密
  return buf.toString("utf8");
}

// 下载视频并截帧, 返回图片路径(失败返回 null)
async function fetchVideoFrame(fileId, outFile, tok, mijia) {
  const ff = findFfmpeg();
  if (!ff) { console.log("[mijia-video] 未找到 ffmpeg"); return null; }
  let txt;
  try { txt = await fetchM3u8(fileId, tok, mijia); }
  catch (e) { console.log("[mijia-video] m3u8 获取失败: " + e.message); return null; }
  const mKey = txt.match(/URI="([^"]+)"/);
  const mIv = txt.match(/IV=0x([0-9A-Fa-f]+)/);
  const segs = txt.split("\n").map(function (s) { return s.trim(); }).filter(function (s) { return s.indexOf("https://") === 0; });
  if (!mKey || !mIv || !segs.length) { console.log("[mijia-video] m3u8 解析失败"); return null; }
  const iv = Buffer.from(mIv[1], "hex");
  try {
    const keyRes = await fetch(mKey[1], { headers: headers(tok), signal: AbortSignal.timeout(30000) });
    const key = Buffer.from(await keyRes.arrayBuffer());
    let merged = Buffer.alloc(0);
    for (let i = 0; i < segs.length; i++) {
      const r = await fetch(segs[i], { headers: headers(tok), signal: AbortSignal.timeout(90000) });
      const enc = Buffer.from(await r.arrayBuffer());
      const d = crypto.createDecipheriv("aes-128-cbc", key, iv);
      merged = Buffer.concat([merged, d.update(enc), d.final()]);
    }
    const tmpTs = outFile + ".ts";
    fs.writeFileSync(tmpTs, merged);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    execFileSync(ff, ["-y", "-i", tmpTs, "-frames:v", "1", "-q:v", "2", outFile], { timeout: 120000 });
    try { fs.unlinkSync(tmpTs); } catch (e) {}
    if (fs.existsSync(outFile) && fs.statSync(outFile).size > 1000) return outFile;
    return null;
  } catch (e) {
    console.log("[mijia-video] 下载/截帧失败: " + e.message);
    return null;
  }
}

// 下载完整报警视频(解密合并所有分片)并转码为 H.264 MP4, 返回 { path, size } 或 null
// outMp4: 目标 mp4 绝对路径(目录会自动创建)
async function fetchVideo(fileId, outMp4, tok, mijia) {
  const ff = findFfmpeg();
  if (!ff) { console.log("[mijia-video] 未找到 ffmpeg"); return null; }
  let txt;
  try { txt = await fetchM3u8(fileId, tok, mijia); }
  catch (e) { console.log("[mijia-video] m3u8 获取失败: " + e.message); return null; }
  const mKey = txt.match(/URI="([^"]+)"/);
  const mIv = txt.match(/IV=0x([0-9A-Fa-f]+)/);
  const segs = txt.split("\n").map(function (s) { return s.trim(); }).filter(function (s) { return s.indexOf("https://") === 0; });
  if (!mKey || !mIv || !segs.length) { console.log("[mijia-video] m3u8 解析失败"); return null; }
  const iv = Buffer.from(mIv[1], "hex");
  try {
    const keyRes = await fetch(mKey[1], { headers: headers(tok), signal: AbortSignal.timeout(30000) });
    const key = Buffer.from(await keyRes.arrayBuffer());
    let merged = Buffer.alloc(0);
    for (let i = 0; i < segs.length; i++) {
      const r = await fetch(segs[i], { headers: headers(tok), signal: AbortSignal.timeout(90000) });
      const enc = Buffer.from(await r.arrayBuffer());
      const d = crypto.createDecipheriv("aes-128-cbc", key, iv);
      merged = Buffer.concat([merged, d.update(enc), d.final()]);
    }
    if (merged.length < 1000) { console.log("[mijia-video] 分片数据过小(" + merged.length + "B), 放弃"); return null; }
    fs.mkdirSync(path.dirname(outMp4), { recursive: true });
    const tmpTs = outMp4 + ".ts";
    fs.writeFileSync(tmpTs, merged);
    // H.265 -> H.264: NVENC 硬编优先(快且不占CPU), 失败回落 libx264 软编。
    // -movflags +faststart: moov 前置, 手机端边下边播(9s 片段秒开)。
    const attempts = [
      ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "26", "-b:v", "0"],
      ["-c:v", "libx264", "-preset", "veryfast", "-crf", "24"]
    ];
    let ok = false, lastErr = "";
    for (const vargs of attempts) {
      try {
        execFileSync(ff, ["-y", "-i", tmpTs].concat(vargs, ["-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", outMp4]), { timeout: 300000, stdio: "ignore" });
        ok = fs.existsSync(outMp4) && fs.statSync(outMp4).size > 5000;
      } catch (e) { lastErr = e.message; ok = false; }
      if (ok) break;
      try { fs.unlinkSync(outMp4); } catch (e) {}
    }
    try { fs.unlinkSync(tmpTs); } catch (e) {}
    if (ok) return { path: outMp4, size: fs.statSync(outMp4).size };
    console.log("[mijia-video] 转码失败: " + String(lastErr).slice(0, 120));
    return null;
  } catch (e) {
    console.log("[mijia-video] 下载/转码失败: " + e.message);
    try { fs.unlinkSync(outMp4 + ".ts"); } catch (e2) {}
    return null;
  }
}

module.exports = { fetchVideoFrame, fetchVideo, findFfmpeg, fetchM3u8 };
