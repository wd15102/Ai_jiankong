// 从 MuMu 模拟器 logcat 提取萤石 App 当前 sessionId，写入 data/app_session.json
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ADB = process.env.ADB || "adb";
const SERIAL = process.env.ADB_SERIAL || "127.0.0.1:7555";
const OUT = path.join(__dirname, "..", "data", "app_session.json");

function jwtExp(jwt) {
  try {
    const p = JSON.parse(Buffer.from(jwt.split(".")[1], "base64").toString("utf8"));
    return p.exp ? p.exp * 1000 : 0;
  } catch (e) { return 0; }
}

function extract() {
  const raw = execSync(ADB + " -s " + SERIAL + " logcat -d -t 5000",
    { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: 30000 });
  const re = /"sessionId":"(eyJ[A-Za-z0-9_.-]+)"/g;
  let m, last = null;
  while ((m = re.exec(raw))) last = m[1];
  return last;
}

function main() {
  const sid = extract();
  if (!sid) { console.error("未在 logcat 找到 sessionId，请确认 App 已登录并近期加载过页面"); process.exit(1); }
  const exp = jwtExp(sid);
  const leftMin = Math.round((exp - Date.now()) / 60000);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ sessionId: sid, exp, updatedAt: Date.now() }, null, 2));
  console.log("sessionId 已写入 " + OUT + "，剩余约 " + leftMin + " 分钟");
  if (leftMin < 0) { console.error("该 sessionId 已过期，需要重新登录 App"); process.exit(2); }
}
main();
