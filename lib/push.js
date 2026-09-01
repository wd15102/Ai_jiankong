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
    body: JSON.stringify(body)
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
  const res = await fetch("https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=" + T.appId + "&secret=" + T.appSecret);
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
  let uj;
  try {
    let ur = await fetch("https://api.weixin.qq.com/cgi-bin/user/get?access_token=" + token + "&next_openid=");
    uj = await ur.json();
  } catch (e) { return { ok: false, reason: "拉取关注者失败: " + e.message.slice(0, 120) }; }
  if (uj.errcode) { // 40001/42001: 缓存token失效，强刷重来
    try {
      token = await getWxTestToken(true);
      const ur = await fetch("https://api.weixin.qq.com/cgi-bin/user/get?access_token=" + token + "&next_openid=");
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
  // 报警推送时段限制(config.push.timeWindow): 名单内openid只在每天 startHour~endHour 之间推送(其余时段静默不推)
  const TW = (cfgRoot.push && cfgRoot.push.timeWindow) || null;
  const inTimeWindow = function (oid) {
    if (!TW || !Array.isArray(TW.openids) || TW.openids.indexOf(oid) < 0) return true; // 不在名单不限制
    const h = new Date().getHours();
    return h >= (Number(TW.startHour) || 0) && h < (Number(TW.endHour) || 24);
  };
  const targets = openids.filter(function (oid) {
    if (!canPushTo(oid)) return false;
    if (serial && now - (throttle[oid] || 0) < 2 * 3600e3) return false;
    if (!inTimeWindow(oid)) return false; // 时段限制(10:00~19:00)
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
          })
        });
        const rj = await res.json();
        if (rj.errcode === 0) { ok++; throttle[oid] = now; break; }
        errs.push("oid=" + oid.slice(0, 6) + " err=" + rj.errcode + " " + rj.errmsg);
        if (att === 0 && (rj.errcode === 40001 || rj.errcode === 42001)) { try { token = await getWxTestToken(true); continue; } catch (e3) { break; } }
        break;
      } catch (e) { errs.push(e.message); break; }
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
        body: JSON.stringify(body)
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

module.exports = { push: push };
