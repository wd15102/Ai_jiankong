// lib/mijia.js — 米家云（小米 IoT 云 io.mi.com）报警事件与图片
//
// 协议与米家 App 一致:
//   nonce      = base64(8字节有符号随机 + 分钟级时间戳大端)
//   signed     = base64(sha256(b64decode(ssecurity) + b64decode(nonce)))
//   签名        = base64(sha1("METHOD&path&k=v&...&signed_nonce"))
//   参数        = 逐项 RC4(signed_nonce, 值)  (RC4 丢弃前 1024 字节密钥流)
//   事件接口    = business.smartcamera.api.io.mi.com/common/app/get/eventlist
//   图片接口    = processor.smartcamera.api.io.mi.com/miot/camera/app/v1/img
//   图片加密    = AES-128-CBC, key=ssecurity, iv=随机16字节(随请求下发)
//
// 凭证来自 data/mijia_token.json (tools/mijia_login.py 登录后生成), 不依赖模拟器 App。
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const TOKEN_FILE = path.join(ROOT, "data", "mijia_token.json");
const DID = process.env.MIJIA_DID || "129586269";
const MODEL = process.env.MIJIA_MODEL || "mijia.camera.v3";
const REGION = "CN";

function loadToken() {
  let t;
  try { t = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8")); }
  catch (e) { throw new Error("未找到 " + TOKEN_FILE + "，请先运行 python tools/mijia_login.py login"); }
  const pair = t.xiaomiio;
  if (!Array.isArray(pair) || !pair[0] || !pair[1]) {
    throw new Error("token 缺少 xiaomiio(ssecurity/serviceToken)，请重新登录");
  }
  return { ssecurity: pair[0], serviceToken: pair[1], userId: String(t.userId || ""), deviceId: t.deviceId || "" };
}

// 与 micloud miutils.gen_nonce 对齐
function genNonce() {
  const b = Buffer.alloc(8);
  let v = crypto.randomBytes(8).readBigUInt64BE();
  if (v >= (1n << 63n)) v -= (1n << 64n);
  b.writeBigInt64BE(v);
  let x = BigInt(Math.floor(Date.now() / 60000));
  const len = Math.max(1, Math.ceil(x.toString(2).length / 8));
  const buf = Buffer.alloc(len);
  for (let i = len - 1; i >= 0; i--) { buf[i] = Number(x & 255n); x >>= 8n; }
  return Buffer.concat([b, buf]).toString("base64");
}

function signedNonce(ssecurity, nonce) {
  return crypto.createHash("sha256")
    .update(Buffer.from(ssecurity, "base64"))
    .update(Buffer.from(nonce, "base64"))
    .digest("base64");
}

function sha1Sign(method, url, dat, nonce) {
  let p = new URL(url).pathname;
  if (p.slice(0, 5) === "/app/") p = p.slice(4);
  const arr = [String(method).toUpperCase(), p];
  for (const k of Object.keys(dat)) arr.push(k + "=" + dat[k]);
  arr.push(nonce);
  return crypto.createHash("sha1").update(arr.join("&"), "utf8").digest("base64");
}

// RC4, 丢弃前 1024 字节密钥流(米家所谓的 init1024)
function rc4Crypt(key, data) {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) & 0xff;
    const t = S[i]; S[i] = S[j]; S[j] = t;
  }
  let i = 0; j = 0;
  const out = Buffer.alloc(data.length);
  const total = 1024 + data.length;
  for (let k = 0; k < total; k++) {
    i = (i + 1) & 0xff;
    j = (j + S[i]) & 0xff;
    const t = S[i]; S[i] = S[j]; S[j] = t;
    if (k >= 1024) out[k - 1024] = data[k - 1024] ^ S[(S[i] + S[j]) & 0xff];
  }
  return out;
}

function rc4Params(method, url, params, ssecurity) {
  const nonce = genNonce();
  const sn = signedNonce(ssecurity, nonce);
  const p = Object.assign({}, params);
  p["rc4_hash__"] = sha1Sign(method, url, p, sn);
  for (const k of Object.keys(p)) {
    p[k] = rc4Crypt(Buffer.from(sn, "base64"), Buffer.from(String(p[k]), "utf8")).toString("base64");
  }
  p["signature"] = sha1Sign(method, url, p, sn);
  p["ssecurity"] = ssecurity;
  p["_nonce"] = nonce;
  return p;
}

function headers(tok) {
  return {
    "MIOT-ENCRYPT-ALGORITHM": "ENCRYPT-RC4",
    "Cookie": "serviceToken=" + tok.serviceToken + "; yetAnotherServiceToken=" + tok.serviceToken + "; userId=" + tok.userId
  };
}

function buildUrl(api, params) {
  const u = new URL(api);
  for (const k of Object.keys(params)) u.searchParams.set(k, params[k]);
  return u.toString();
}

async function apiGetJson(url, data, tok) {
  const params = rc4Params("GET", url, { data: JSON.stringify(data) }, tok.ssecurity);
  const res = await fetch(buildUrl(url, params), { headers: headers(tok), signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  const plain = rc4Crypt(
    Buffer.from(signedNonce(tok.ssecurity, params._nonce), "base64"),
    Buffer.from(text, "base64")
  ).toString("utf8");
  return JSON.parse(plain);
}

// 拉取报警事件(按时间倒序)
async function fetchEvents(begin, end, limit) {
  const tok = loadToken();
  const now = Date.now();
  const rqd = {
    did: DID, model: MODEL, doorBell: false, eventType: "Default",
    needMerge: true, sortType: "DESC", region: REGION, language: "zh_CN",
    beginTime: begin || now - 7 * 86400000, endTime: end || now, limit: limit || 50
  };
  const url = "https://business.smartcamera.api.io.mi.com/common/app/get/eventlist";
  const d = await apiGetJson(url, rqd, tok);
  if (d.code !== 0) throw new Error("eventlist code=" + d.code + " " + (d.message || "") + " " + (d.result || ""));
  return (d.data && d.data.thirdPartPlayUnits) || [];
}

// 下载并解密报警图片, 返回 JPEG Buffer
async function fetchImage(fileId, storeId, tok) {
  tok = tok || loadToken();
  const iv = crypto.randomBytes(16);
  const dat = { did: DID, fileId: fileId, stoId: storeId, segmentIv: iv.toString("base64") };
  const api = "https://processor.smartcamera.api.io.mi.com/miot/camera/app/v1/img";
  const pms = rc4Params("GET", api, { data: JSON.stringify(dat) }, tok.ssecurity);
  pms["yetAnotherServiceToken"] = tok.serviceToken;
  const res = await fetch(buildUrl(api, pms), { headers: headers(tok), signal: AbortSignal.timeout(30000) });
  const enc = Buffer.from(await res.arrayBuffer());
  const decipher = crypto.createDecipheriv("aes-128-cbc", Buffer.from(tok.ssecurity, "base64"), iv);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

// 事件类型 -> 中文(用于推送/看板)
const TYPE_LABELS = {
  PeopleMotion: "有人移动",
  ObjectMotion: "画面变动",
  PetMotion: "宠物侦测",
  VehicleMotion: "车辆侦测",
  FaceMotion: "人脸侦测",
  BabyCry: "婴儿啼哭",
  VoiceMotion: "异响侦测"
};

// 需要推送微信的类型(用户要求: 有人移动 / 画面变动 都推)
const PUSH_TYPES = ["PeopleMotion", "ObjectMotion"];

module.exports = {
  loadToken, fetchEvents, fetchImage, TYPE_LABELS, PUSH_TYPES,
  genNonce, signedNonce, sha1Sign, rc4Params, rc4Crypt,
  DID, MODEL, TOKEN_FILE
};
