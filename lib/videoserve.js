// lib/videoserve.js — 米家报警视频静态服务(HTTP Range 支持)
//
// 路由: /videos/<YYYY-MM-DD>/<文件名>.mp4 -> captures/mijia/videos/<YYYY-MM-DD>/<文件名>.mp4
// 供 8787(wxServer 详情页) 与 8790(webapp 看板) 两个服务共用。
// 手机浏览器(含微信内置浏览器)播 <video> 必须支持 HTTP Range(206 分片), 否则 iOS Safari 拒播。
const fs = require("fs");
const path = require("path");

// 返回 true = 已接管响应; false = 路径不匹配, 调用方继续走后续路由
function serveMijiaVideo(ROOT, req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  if (String(pathname).indexOf("/videos/") !== 0) return false;
  let rel;
  try { rel = decodeURIComponent(pathname.slice("/videos/".length)); }
  catch (e) { res.writeHead(400); res.end(""); return true; }
  // 严格校验: 只允许 日期目录/文件名.mp4, 防路径穿越
  const m = rel.match(/^(\d{4}-\d{2}-\d{2})\/([A-Za-z0-9._-]+\.mp4)$/);
  if (!m) { res.writeHead(403); res.end(""); return true; }
  const baseDir = path.join(ROOT, "captures", "mijia", "videos");
  const abs = path.join(baseDir, m[1], m[2]);
  if (abs.indexOf(baseDir) !== 0) { res.writeHead(403); res.end(""); return true; }
  let st;
  try { st = fs.statSync(abs); } catch (e) { res.writeHead(404); res.end("not found"); return true; }
  if (!st.isFile()) { res.writeHead(404); res.end("not found"); return true; }
  const size = st.size;
  const base = { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Cache-Control": "public, max-age=604800, immutable" };
  const range = req.headers.range;
  if (range) {
    const mm = String(range).match(/bytes=(\d*)-(\d*)/);
    if (mm) {
      let start, end;
      if (mm[1] === "") { // bytes=-N (后缀 range)
        start = Math.max(0, size - parseInt(mm[2] || "0", 10));
        end = size - 1;
      } else {
        start = parseInt(mm[1], 10);
        end = mm[2] === "" ? size - 1 : Math.min(parseInt(mm[2], 10), size - 1);
      }
      if (isNaN(start) || start > end || start >= size) {
        res.writeHead(416, { "Content-Range": "bytes */" + size });
        res.end("");
        return true;
      }
      res.writeHead(206, Object.assign({}, base, {
        "Content-Range": "bytes " + start + "-" + end + "/" + size,
        "Content-Length": end - start + 1
      }));
      if (req.method === "HEAD") { res.end(""); return true; }
      fs.createReadStream(abs, { start: start, end: end }).pipe(res);
      return true;
    }
  }
  res.writeHead(200, Object.assign({}, base, { "Content-Length": size }));
  if (req.method === "HEAD") { res.end(""); return true; }
  fs.createReadStream(abs).pipe(res);
  return true;
}

module.exports = { serveMijiaVideo };
