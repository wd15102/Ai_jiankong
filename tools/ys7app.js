// 萤石 App 私有接口客户端（不依赖开放平台套餐）
const fs = require("fs");
const path = require("path");

const BASE = "https://api.ys7.com";
const SESSION_FILE = path.join(__dirname, "..", "data", "app_session.json");
const CLIENT = { "clientType": "3", "osVersion": "12", "clientVersion": "7.9.6.261030",
                 "netType": "WIFI", "clientNo": "web_site", "clientName": "PGBM10",
                 "featureCode": "8249f766ba49607d81e66ca4c9cf908b", "appId": "ys7" };

function loadSession() {
  const j = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
  if (j.exp && j.exp < Date.now()) throw new Error("sessionId 已过期，请先运行 ys7app_session.js");
  return j.sessionId;
}

async function req(method, p, body, form) {
  const sid = loadSession();
  const h = Object.assign({ sessionId: sid }, CLIENT);
  const url = BASE + p;
  const opt = { method, headers: h, signal: AbortSignal.timeout(30000) };
  if (form) { h["Content-Type"] = "application/x-www-form-urlencoded";
    opt.body = new URLSearchParams(form).toString(); }
  else if (body) { h["Content-Type"] = "application/json; charset=UTF-8";
    opt.body = JSON.stringify(body); }
  const r = await fetch(url, opt);
  const t = await r.text();
  try { return JSON.parse(t); } catch (e) { throw new Error("HTTP " + r.status + " " + t.slice(0, 200)); }
}

async function download(url, file) {
  const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error("下载失败 HTTP " + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return buf.length;
}

module.exports = {
  capture: (serial, channelNo = 1, isEncrypted = 0) =>
    req("PUT", "/v3/devices/security/cover/home/capture",
        null, { deviceSerial: serial, channelNo, isEncrypted }),
  deviceList: () => req("GET", "/v3/humanservice/devices/mine"),
  userInfo: () => req("GET", "/v3/users/info"),
  download: download
};

if (require.main === module) {
  const serial = process.argv[2];
  if (!serial) { console.error("用法: node ys7app.js capture <设备序列号> [输出文件]"); process.exit(1); }
  const out = process.argv[3] || path.join(__dirname, "..", "data", "app_capture_" + serial + ".jpg");
  module.exports.capture(serial).then(async j => {
    const u = j && j.captureInfo && j.captureInfo.picUrl;
    if (!u) { console.error("抓图失败: " + JSON.stringify(j).slice(0, 300)); process.exit(1); }
    const n = await download(u, out);
    console.log("已保存 " + out + " (" + n + " bytes)");
  }).catch(e => { console.error("失败: " + e.message); process.exit(1); });
}
