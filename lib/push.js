// 消息推送
// wecombos: 企业微信群机器人 —— 图片base64直入聊天窗口+markdown文字，点开即看（推荐）
// wxpusher / ntfy 备选；wecombot 未配置 webhook 时自动回落 wxpusher
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  try { return await res.json(); } catch (e) { return { errcode: -1, errmsg: "HTTP " + res.status }; }
}

async function wecomBotSend(pcfg, title, markdownBody, imageFile) {
  const url = pcfg.wecomWebhook;
  const results = [];
  let allOk = true;

  // 1) 图片：base64 内嵌消息，聊天里直接显示（上限2MB）
  if (imageFile && fs.existsSync(imageFile)) {
    const buf = fs.readFileSync(imageFile);
    if (buf.length <= 2 * 1024 * 1024) {
      const r = await postJson(url, {
        msgtype: "image",
        image: { base64: buf.toString("base64"), md5: crypto.createHash("md5").update(buf).digest("hex") }
      });
      const ok = r.errcode === 0;
      allOk = allOk && ok;
      results.push("图片:" + (ok ? "ok" : JSON.stringify(r).slice(0, 80)));
    } else {
      results.push("图片:跳过(超2MB)");
    }
  }

  // 2) AI 分析文字：markdown 消息（上限4096字节）
  const md = ("**" + title + "**\n" + String(markdownBody || "")).slice(0, 3800);
  const r2 = await postJson(url, { msgtype: "markdown", markdown: { content: md } });
  const ok2 = r2.errcode === 0;
  allOk = allOk && ok2;
  results.push("文字:" + (ok2 ? "ok" : JSON.stringify(r2).slice(0, 80)));

  return { ok: allOk, detail: results.join(", ") };
}

// ---------- 微信测试号模板消息（出站调用 api.weixin.qq.com，不依赖公网URL/Funnel） ----------
// 复用 config.json 的 wxTest 配置(appId/appSecret/templateId) + openidNames 昵称
async function getWxTestToken(force) {
  const cfgRoot = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.json"), "utf8"));
  const T = cfgRoot.wxTest || {};
  const cacheFile = path.join(__dirname, "..", "data", "wx_test_token.json");
  if (!force) {
    try {
      const t = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      if (t.access_token && t.expireAt > Date.now() + 120e3) return t.access_token;
    } catch (e) { /* 无缓存 */ }
  }
  const res = await fetch("https://api.weixin.qq.com/cgi-bin/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credential&appid=" + encodeURIComponent(T.appId) + "&secret=" + encodeURIComponent(T.appSecret),
    signal: AbortSignal.timeout(10000)
  });
  const j = await res.json();
  if (!j.access_token) throw new Error("获取access_token失败 " + JSON.stringify(j).slice(0, 150));
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({ access_token: j.access_token, expireAt: Date.now() + (j.expires_in || 7200) * 1000 }));
  return j.access_token;
}

async function wxTestSend(title, markdownBody, opts) {
  opts = opts || {};
  const cfgRoot = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.json"), "utf8"));
  const T = cfgRoot.wxTest || {};
  if (!T.enabled || !T.templateId || !T.appId || !T.appSecret) return { ok: false, reason: "wxTest 未配置完整(enabled/templateId/appId/appSecret)" };
  const names = cfgRoot.openidNames || {};
  const dear = function (oid) { return names[oid] ? (names[oid] + "，") : ""; };
  let token;
  try { token = await getWxTestToken(false); } catch (e) { return { ok: false, reason: "token失败: " + e.message.slice(0, 120) }; }

  // 单用户推送模式: 跳过分组过滤/节流/时段限制, 直接推给指定 openid
  if (opts.onlyOpenid) {
    const oid = opts.onlyOpenid;
    const timeStr = new Date().toLocaleString("zh-CN", { hour12: false });
    const titleStr = String(title || "摄像头动态");
    for (let att = 0; att < 2; att++) {
      try {
        const res = await fetch("https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=" + token, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            touser: oid,
            template_id: T.templateId,
            data: {
              first: { value: dear(oid) + titleStr.slice(0, 60) },
              keyword1: { value: timeStr },
              keyword2: { value: titleStr.slice(0, 20) },
              remark: { value: String(markdownBody || "").slice(0, 100) }
            }
          }),
          signal: AbortSignal.timeout(10000)
        });
        const rj = await res.json();
        if (rj.errcode === 0) return { ok: true, detail: "推送给 " + oid.slice(0, 6) };
        if (att === 0 && (rj.errcode === 40001 || rj.errcode === 42001)) { try { token = await getWxTestToken(true); continue; } catch (e3) { break; } }
        return { ok: false, detail: "err=" + rj.errcode + " " + rj.errmsg };
      } catch (e) { return { ok: false, detail: e.message }; }
    }
    return { ok: false, detail: "未知错误" };
  }

  let uj;
  try {
    let ur = await fetch("https://api.weixin.qq.com/cgi-bin/user/get?access_token=" + token + "&next_openid=", { signal: AbortSignal.timeout(10000) });
    uj = await ur.json();
  } catch (e) { return { ok: false, reason: "拉取关注者失败: " + e.message.slice(0, 120) }; }
  if (uj.errcode) { // 40001/42001: 缓存token失效，强刷重来
    try {
      token = await getWxTestToken(true);
      const ur = await fetch("https://api.weixin.qq.com/cgi-bin/user/get?access_token=" + token + "&next_openid=", { signal: AbortSignal.timeout(10000) });
      uj = await ur.json();
    } catch (e2) { return { ok: false, reason: "token强刷失败: " + e2.message.slice(0, 120) }; }
  }
  const openids = (uj.data && uj.data.openid) || [];
  if (!openids.length) return { ok: false, reason: "测试号没有关注者" };
  // 分组过滤(与webhook同规则): 双溪村组只收双溪村报警, 同事组不推; 默认组全推
  const serial = opts.serial || "";
  const villageOf = function (ser) {
    const d = (cfgRoot.devices || []).find(function (x) { return x.serial === ser; });
    const nm = d ? d.name : (ser || "");
    if (nm.indexOf("双溪村") >= 0) return "双溪村";
    if (nm.indexOf("木山村") >= 0) return "木山村";
    return "";
  };
  const canPushTo = function (oid) {
    let g = null;
    for (const key of Object.keys(cfgRoot.wxGroups || {})) {
      const grp = cfgRoot.wxGroups[key];
      if (grp && Array.isArray(grp.members) && grp.members.indexOf(oid) >= 0) { g = grp; break; }
    }
    if (!g) return true; // 默认组全推
    const scope = g.push || "all";
    if (scope === "none") return false;
    if (scope === "all") return true;
    return villageOf(serial) === scope;
  };
  // 2小时节流(报警类, 带serial时生效): 与webhook共用push_throttle.json, 避免监控轮询与萤石回调双路重复推送
  const THROTTLE_FILE = path.join(__dirname, "..", "data", "push_throttle.json");
  let throttle = {};
  try { throttle = JSON.parse(fs.readFileSync(THROTTLE_FILE, "utf8")) || {}; } catch (e) {}
  const now = Date.now();
  // 节流窗口读取 config.push.throttleWindowSec(默认1800秒=30分钟), 与 webhook.js 保持一致, 不再硬编码 2h
  const throttleWindowMs = (Number((cfgRoot.push && cfgRoot.push.throttleWindowSec) > 0 ? cfgRoot.push.throttleWindowSec : 1800) || 1800) * 1000;
  // 推送时段限制(config.push.timeWindow): 名单内openid只在 windows 各时段推送(其余时段静默不推)
  // windows 支持多时段 [{startHour,endHour},...]; 兼容旧的单时段 startHour/endHour 写法(与 webhook.js inPushTimeWindow 同一套规则)
  const TW = (cfgRoot.push && cfgRoot.push.timeWindow) || null;
  const inTimeWindow = function (oid) {
    if (!TW || !Array.isArray(TW.openids) || TW.openids.indexOf(oid) < 0) return true; // 不在名单不限制
    const wins = (Array.isArray(TW.windows) && TW.windows.length) ? TW.windows
      : (TW.startHour != null ? [{ startHour: TW.startHour, endHour: TW.endHour }] : []);
    if (!wins.length) return true;
    const h = new Date().getHours();
    for (const w of wins) {
      const s = Number(w.startHour) || 0, e = Number(w.endHour) || 24;
      if (h >= s && h < e) return true;
    }
    return false;
  };
  // 报警免推名单(config.push.alarmDisabled): 名单内 openid 不收报警推送(与 webhook.js 同规则)
  const isAlarmDisabled = function (oid) {
    const raw = cfgRoot.push && cfgRoot.push.alarmDisabled;
    const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.openids) ? raw.openids : []);
    return list.indexOf(oid) >= 0;
  };
  // throttle[oid] 历史上有两种写法: webhook.js 写的是"滑动窗口时间戳数组", 本模块原来写单数字。
  // 直接 `now - throttle[oid]` 碰到数组会算出 NaN, 比较恒为 false —— 于是萤石回调刚推过的设备,
  // 监控轮询这一路完全看不见、隔一会儿又推一次(与 webhook 的"同一次活动只推一条"是同一个坑)。
  const lastPushAt = function (v) {
    if (Array.isArray(v)) {
      const ts = v.filter(function (t) { return t > 0; });
      return ts.length ? Math.max.apply(null, ts) : 0;
    }
    return Number(v) > 0 ? Number(v) : 0;
  };
  const targets = openids.filter(function (oid) {
    if (!canPushTo(oid)) return false;
    if (serial && now - lastPushAt(throttle[oid]) < throttleWindowMs) return false;
    if (!inTimeWindow(oid)) return false; // 时段限制(config.push.timeWindow.windows, 当前10~12/14~20)
    if (isAlarmDisabled(oid)) return false; // 报警免推名单(config.push.alarmDisabled)
    return true;
  });
  if (!targets.length) return { ok: false, reason: "分组过滤/节流/时段限制后无人可推", skipped: true };
  const timeStr = new Date().toLocaleString("zh-CN", { hour12: false });
  const titleStr = String(title || "摄像头动态");
  let ok = 0;
  const errs = [];
  for (const oid of targets) {
    for (let att = 0; att < 2; att++) {
      try {
        const res = await fetch("https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=" + token, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            touser: oid,
            template_id: T.templateId,
            url: opts.url || "",
            data: {
              first: { value: dear(oid) + titleStr.slice(0, 60) },
              keyword1: { value: timeStr },
              keyword2: { value: titleStr.slice(0, 20) },
              remark: { value: String(markdownBody || "").slice(0, 100) }
            }
          }),
          signal: AbortSignal.timeout(10000)
        });
        const rj = await res.json();
        if (rj.errcode === 0) { ok++; throttle[oid] = [now]; break; } // 写成数组, 与 webhook.js 的滑动窗口格式统一
        errs.push("oid=" + oid.slice(0, 6) + " err=" + rj.errcode + " " + rj.errmsg);
        if (att === 0 && (rj.errcode === 40001 || rj.errcode === 42001)) { try { token = await getWxTestToken(true); continue; } catch (e3) { break; } }
        break;
      } catch (e) { errs.push(e.message); continue; }
    }
  }
  if (serial) { try { fs.writeFileSync(THROTTLE_FILE, JSON.stringify(throttle)); } catch (e4) {} }
  return { ok: ok > 0, detail: "推送 " + ok + "/" + targets.length + " (关注者" + openids.length + ")" + (errs.length ? " | " + errs[0] : "") };
}

async function push(pcfg, title, markdownBody, opts) {
  opts = opts || {};
  const type = (pcfg && pcfg.type) || "none";
  try {
    if (type === "wecombot") {
      const r = await wecomBotSend(pcfg, title, markdownBody, opts.imageFile);
      return { ok: r.ok, reason: r.ok ? "" : r.detail, resp: r };
    }
    if (type === "wxpusher") {
      if (!pcfg.wxpusherAppToken) return { ok: false, reason: "未填 wxpusherAppToken" };
      const j = await postJson("https://wxpusher.zjiecode.com/api/send/message", {
        appToken: pcfg.wxpusherAppToken,
        content: title + "\n" + markdownBody,
        summary: String(title).slice(0, 90),
        contentType: 3,
        uids: [pcfg.wxpusherUid]
      });
      return { ok: j.code === 1000, resp: j };
    }
    if (type === "ntfy") {
      if (!pcfg.ntfyTopicUrl) return { ok: false, reason: "未填 ntfyTopicUrl" };
      const body = { topic: pcfg.ntfyTopicUrl.split("/").pop(), title: title, message: markdownBody };
      if (opts.imageFile && fs.existsSync(opts.imageFile)) body.attach = opts.imageFile;
      const res = await fetch(pcfg.ntfyTopicUrl.replace(/[^/]*$/, ""), {
        method: "POST",
        headers: { "Title": title, "Tags": "camera" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000)
      });
      return { ok: res.ok };
    }
    if (type === "wxTest") {
      const r = await wxTestSend(title, markdownBody, opts);
      return { ok: r.ok, reason: r.ok ? "" : r.detail, resp: r };
    }
    console.log("[push:none] " + title + "\n" + markdownBody);
    return { ok: true, skipped: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// ---------- 完整模板推送(供 webhook/webapp 共用, 补全 kw3/kw4/kw5 + detailUrl) ----------
// 原来 webhook.js 内部实现, 现抽出到 lib/push.js 让 webapp 的 /api/push-single 也能复用,
// 解决单用户推送只传 first/keyword1/keyword2/remark 导致 AI分析/报警类型/现场照片/详情链接全空白的问题。
function pushTestTemplate(first, timeStr, deviceStr, remark, detailUrl, force, opt) {
  const fs = require("fs");
  const path = require("path");
  return new Promise(function (resolve) {
    const cfgRoot = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.json"), "utf8"));
    const T = cfgRoot.wxTest || {};
    if (!T.enabled || !T.templateId || !T.appId || !T.appSecret) { resolve(0); return; }
    const names = cfgRoot.openidNames || {};
    const dear = function (oid) { return names[oid] ? (names[oid] + "，") : ""; };
    const allowOid = opt && opt.allowOid; // 仅向白名单 openid 推送(单用户推送用)
    const serial = opt && opt.serial;
    function fetchOpenids() {
      return new Promise(function (res) {
        wxTestToken().then(function (token) {
          fetch("https://api.weixin.qq.com/cgi-bin/user/get?access_token=" + token + "&next_openid=", { signal: AbortSignal.timeout(10000) })
            .then(function (r) { return r.json(); })
            .then(function (j) { res((j.data && j.data.openid) || []); })
            .catch(function () { res([]); });
        }).catch(function () { res([]); });
      });
    }
    function wxTestToken() {
      return getWxTestToken(false).catch(function () { return getWxTestToken(true); });
    }
    fetchOpenids().then(async function (openids) {
      let targets = openids;
      if (allowOid) targets = openids.filter(function (oid) { return allowOid(oid); });
      if (!targets.length) { resolve(0); return; }
      const token = await wxTestToken();
      let ok = 0;
      const timeNow = new Date().toLocaleString("zh-CN", { hour12: false });
      const titleStr = String(first || "摄像头动态");
      for (const oid of targets) {
        for (let att = 0; att < 2; att++) {
          try {
            const res = await fetch("https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=" + token, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                touser: oid,
                template_id: T.templateId,
                url: detailUrl || "",
                data: {
                  first: { value: dear(oid) + titleStr.slice(0, 60) },
                  keyword1: { value: timeStr || timeNow },
                  keyword2: { value: deviceStr || "" },
                  remark: { value: remark || "点击本消息可查看现场照片" },
                  keyword3: opt && opt.kw3 ? { value: String(opt.kw3).slice(0, 30) } : undefined,
                  keyword4: opt && opt.kw4 ? { value: String(opt.kw4).slice(0, 20) } : undefined,
                  keyword5: opt && opt.kw5 ? { value: String(opt.kw5).slice(0, 20) } : undefined
                }
              }),
              signal: AbortSignal.timeout(10000)
            });
            const rj = await res.json();
            if (rj.errcode === 0) { ok++; }
            else if (att === 0 && (rj.errcode === 40001 || rj.errcode === 42001)) { try { token = await getWxTestToken(true); continue; } catch (e3) { break; } }
            break;
          } catch (e) { break; }
        }
      }
      resolve(ok);
    }).catch(function () { resolve(0); });
  });
}

module.exports = { push: push, pushTestTemplate: pushTestTemplate };
