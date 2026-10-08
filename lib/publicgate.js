// lib/publicgate.js —— 公网访问鉴权(wxServer.publicToken 配置后启用)
// 花生壳/内网穿透从 127.0.0.1 反代, 服务端看到的 remoteAddress 是回环,
// 因此"真正本机"必须同时满足: 回环地址 + 回环 Host + 无任何代理转发头。
function createPublicGate(cfg, isLoopback) {
  const TOKEN = String((cfg.wxServer && cfg.wxServer.publicToken) || "").trim();
  const EXEMPT = { "/ezviz/push": 1, "/ezviz/push/": 1, "/health": 1, "/": 1 };
  function hostOnly(req) {
    let h = String((req.headers && req.headers.host) || "").toLowerCase();
    const c = h.indexOf("]");
    if (h.charAt(0) === "[" && c >= 0) return h.slice(1, c);
    const j = h.lastIndexOf(":");
    if (j >= 0) { const t = h.slice(j + 1); let d = t.length > 0; for (let k = 0; k < t.length; k++) { const x = t.charCodeAt(k); if (x < 48 || x > 57) { d = false; break; } } if (d) h = h.slice(0, j); }
    return h;
  }
  function hasProxyHeader(req) {
    const h = (req.headers || {});
    return !!(h["x-forwarded-for"] || h["x-real-ip"] || h["forwarded"] || h["x-forwarded-host"] || h["x-forwarded-proto"]);
  }
  function isLocalHost(h) { return h === "127.0.0.1" || h === "localhost" || h === "::1"; }
  function isLocalRequest(req) {
    if (!isLoopback(req)) return false;
    if (hasProxyHeader(req)) return false;
    return isLocalHost(hostOnly(req));
  }
  function publicCookie(req) {
    const parts = String((req.headers && req.headers.cookie) || "").split(";");
    for (let i = 0; i < parts.length; i++) {
      const s = parts[i].trim();
      if (s.indexOf("kj=") === 0) return decodeURIComponent(s.slice(3));
    }
    return "";
  }
  function publicGate(req, u, res, wxVerifyOk) {
    if (!TOKEN) return false;
    if (isLocalRequest(req)) return false;
    if (EXEMPT[u.pathname]) return false;
    if (req.method === "POST") return false;
    if (wxVerifyOk) return false;
    const given = u.searchParams.get("token") || publicCookie(req);
    if (given && given === TOKEN) {
      res.setHeader("Set-Cookie", "kj=" + encodeURIComponent(TOKEN) + "; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly");
      return false;
    }
    res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
    res.end("forbidden: append ?token= to the url");
    return true;
  }
  function tokUrl(url) {
    if (!url || !TOKEN || String(url).indexOf("token=") >= 0) return url;
    return url + (String(url).indexOf("?") >= 0 ? "&" : "?") + "token=" + encodeURIComponent(TOKEN);
  }
  return { publicGate: publicGate, tokUrl: tokUrl, publicCookie: publicCookie, PUBLIC_TOKEN: TOKEN };
}
module.exports = { createPublicGate: createPublicGate };
