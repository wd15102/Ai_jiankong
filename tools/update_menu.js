// 更新公众号菜单: 追加「历史记录」按钮(key=history), 幂等(已存在则跳过)
// 用法: node tools/update_menu.js  (或双击 更新公众号菜单.bat)
// 对 config.json 里的 测试号(wxTest) 和 主号(wxServer) 依次尝试; 无菜单接口权限的账号会提示手动添加
const fs = require("fs");
const https = require("https");

const config = JSON.parse(fs.readFileSync(__dirname + "/../config.json", "utf8"));
// 2026-09-04 起只维护测试号: 主号(wxServer)因IP白名单+家里动态IP频繁40164, 东哥决定弃用不再管
const accts = [];
if (config.wxTest && config.wxTest.appId && config.wxTest.appSecret) accts.push({ name: "测试号", appId: config.wxTest.appId, secret: config.wxTest.appSecret });
if (!accts.length) { console.log("config.json 里没有找到 wxTest 的 appId/appSecret"); process.exit(1); }

function req(p, post) {
  return new Promise(function (resolve) {
    const data = post ? JSON.stringify(post) : null;
    const opt = { hostname: "api.weixin.qq.com", port: 443, path: p, method: post ? "POST" : "GET", rejectUnauthorized: false, headers: { "Content-Type": "application/json" } };
    if (data) opt.headers["Content-Length"] = Buffer.byteLength(data);
    const r = https.request(opt, function (res) {
      let s = "";
      res.on("data", function (c) { s += c; });
      res.on("end", function () { resolve(s); });
    });
    r.on("error", function (e) { resolve(JSON.stringify({ err: e.message })); });
    if (data) r.write(data);
    r.end();
  });
}

(async function () {
  for (const a of accts) {
    console.log("---- " + a.name + " ----");
    const tk = JSON.parse(await req("/cgi-bin/token?grant_type=client_credential&appid=" + a.appId + "&secret=" + a.secret));
    if (!tk.access_token) { console.log("token 获取失败: " + JSON.stringify(tk)); continue; }
    const t = tk.access_token;
    let menu = null;
    try { menu = JSON.parse(await req("/cgi-bin/menu/get?access_token=" + t)); } catch (e) {}
    let buttons = (menu && menu.menu && menu.menu.button) ? menu.menu.button : (menu && menu.button) ? menu.button : [];
    if (!buttons.length) console.log("未读到现有菜单(可能无权限或菜单为空), 将创建新菜单");
    const exists = buttons.some(function (b) { return b.key === "history" || (b.sub_button || []).some(function (s) { return s.key === "history"; }); });
    if (exists) { console.log("菜单里已有历史记录按钮, 跳过"); continue; }
    const btn = { type: "click", name: "历史记录", key: "history" };
    if (buttons.length < 3) buttons.push(btn);
    else {
      const last = buttons[buttons.length - 1];
      last.sub_button = last.sub_button || [];
      if (last.sub_button.length < 5) last.sub_button.push(btn);
      else { console.log("最后一个主按钮的子按钮已满5个, 无法追加, 请到公众号后台手动添加"); continue; }
    }
    const r2 = JSON.parse(await req("/cgi-bin/menu/create?access_token=" + t, { button: buttons }));
    if (r2.errcode === 0) console.log("[OK] " + a.name + " 菜单已更新(共" + buttons.length + "个主按钮)");
    else console.log("[失败] " + a.name + ": " + JSON.stringify(r2) + " (无接口权限时请到公众号后台手动添加: 名称=历史记录 类型=点击 值=history)");
  }
  console.log("");
  console.log("提示: 手机微信菜单刷新可能要几分钟, 或取关再关注立即生效");
})();
