// 萤石开放平台 API 客户端（零依赖，Node >= 18）
const fs = require("fs");
const path = require("path");

const BASE = "https://open.ys7.com";
const DATA_DIR = path.join(__dirname, "..", "data");

async function postForm(url, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15000)
  });
  const text = await res.text();
  try { return JSON.parse(text); }
  catch (e) { throw new Error("HTTP " + res.status + " 响应非JSON: " + text.slice(0, 200)); }
}

function loadToken() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, "token.json"), "utf8")); }
  catch (e) { return null; }
}
function saveToken(t) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, "token.json"), JSON.stringify(t, null, 2));
}

async function downloadTo(url, file) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error("下载失败 HTTP " + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return buf.length;
}

function createClient(cfg) {
  let memToken = null;

  async function getToken(force) {
    const cached = force ? null : (memToken || loadToken());
    if (cached && cached.accessToken && cached.expireTime > Date.now() + 3600e3) {
      memToken = cached;
      return cached.accessToken;
    }
    const r = await postForm(BASE + "/api/lapp/token/get", { appKey: cfg.appKey, appSecret: cfg.appSecret });
    if (r.code !== "200") throw new Error("获取accessToken失败 code=" + r.code + " msg=" + r.msg);
    memToken = r.data;
    saveToken(memToken);
    return memToken.accessToken;
  }

  async function api(ep, params) {
    const accessToken = await getToken();
    const r = await postForm(BASE + ep, Object.assign({ accessToken: accessToken }, params));
    if (r.code === "10002") { // token 失效则强制刷新重试一次
      const t = await getToken(true);
      return postForm(BASE + ep, Object.assign({ accessToken: t }, params));
    }
    return r;
  }

  return {
    getToken: getToken,
    deviceList: function () { return api("/api/lapp/device/list", { pageSize: 50, pageNum: 1 }); },
    deviceInfo: function (s) { return api("/api/lapp/device/info", { deviceSerial: s }); },
    capture: function (s) { return api("/api/lapp/device/capture", { deviceSerial: s, imageSize: 1 }); },
    liveAddress: function (s, opts) {
      opts = opts || {};
      // v2接口(旧版v1已废弃报source为空); H265设备必须 supportH265:1+containerFormat:1(fMP4),
      // 否则HLS默认TS封装装不下HEVC会返回ErrCode占位流(9053); 前端EZUIKit软解自适应
      return api("/api/lapp/v2/live/address/get", {
        deviceSerial: s,
        channelNo: opts.channelNo || 1,
        protocol: opts.protocol || 2,
        quality: opts.quality || 1,
        supportH265: opts.supportH265 != null ? opts.supportH265 : 1,
        containerFormat: opts.containerFormat != null ? opts.containerFormat : 1,
        expireTime: opts.expireTime || 600
      });
    },
    alarms: function (s, startMs, endMs, size) {
      return api("/api/lapp/alarm/device/list", { deviceSerial: s, startTime: startMs, endTime: endMs, pageSize: size || 10, pageNum: 1 });
    },
    ptzStart: function (s, direction, speed) { return api("/api/lapp/device/ptz/start", { deviceSerial: s, channelNo: 1, direction: direction, speed: speed || 2 }); },
    // channelNo 必传: 缺了stop会报10001(channelNo为空)且设备持续转动不停
    ptzStop: function (s) { return api("/api/lapp/device/ptz/stop", { deviceSerial: s, channelNo: 1 }); },
    downloadTo: downloadTo
  };
}

module.exports = { createClient: createClient, downloadTo: downloadTo, DATA_DIR: DATA_DIR };
