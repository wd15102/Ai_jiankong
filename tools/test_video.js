const mijia = require("../lib/mijia");
const v = require("../lib/mijia_video");
(async () => {
  const tok = mijia.loadToken();
  const txt = await v.fetchM3u8(596476375571123072, tok, mijia);
  console.log("len", txt.length);
  console.log("head:", txt.slice(0, 300));
})().catch(e => console.log("ERR:", e.message));