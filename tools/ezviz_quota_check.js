// 萤石配额体检: 扫描运行日志, 按天普查配额类错误码 + 消耗量指标, 判断是否被萤石接口限流
// 用法: node tools/ezviz_quota_check.js [最近天数, 默认10]
// 配额事实(2026-10 官方公告+社区实测, 以控制台套餐页为准):
//   10028=抓图接口调用次数超限(试用版抓图 2026-09-01 起正式计费, 每日免费上限约100次)
//   9048 =取流超限(免费版 1Mbps 带宽/最多3路并发)
//   10026=设备数量超出个人版限制; 10002=accessToken失效; 20008=设备响应超时(瞬态,非配额)
const fs = require("fs");
const path = require("path");

const DATA = path.join(__dirname, "..", "data");
const DAYS = Math.max(1, parseInt(process.argv[2], 10) || 10);

// 日期锚定: webhook日志靠"已记录: ... YYYY/M/D"行, monitor日志无日期靠抓图文件名里的13位时间戳
const RE_DATE = /已记录: .*?(\d{4}\/\d{1,2}\/\d{1,2}) /;
const RE_FILETS = /_p?(\d{13})\.jpg/;

const CODES = [
  ["10028", "抓图次数超限(试用版约100次/日)"],
  ["9048", "取流超限(免费版1Mbps/3路并发)"],
  ["20008", "设备响应超时(瞬态,非配额)"],
  ["10002", "accessToken失效"],
  ["10026", "设备数量超个人版限制"]
];

function scan(logFile) {
  const file = path.join(DATA, logFile);
  if (!fs.existsSync(file)) return null;
  const stat = fs.statSync(file);
  if (!stat.size) return null;
  // 日志可能很大, 只读末尾 4MB 足够覆盖最近几天
  const TAIL = 4 * 1024 * 1024;
  const fd = fs.openSync(file, "r");
  const start = Math.max(0, stat.size - TAIL);
  const buf = Buffer.alloc(stat.size - start);
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  const lines = buf.toString("utf8").split("\n");
  let cur = ""; // 当前日期 YYYY-MM-DD
  const days = {}; // day -> {code:count, streamPull, captureFail, archiveOK}
  function bucket() {
    if (!cur) return null;
    return days[cur] || (days[cur] = { e: {}, streamPull: 0, captureFail: 0, archiveOK: 0 });
  }
  for (const line of lines) {
    const mD = RE_DATE.exec(line);
    if (mD) {
      const [y, m, d] = mD[1].split("/");
      cur = y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
    } else {
      const mT = RE_FILETS.exec(line);
      if (mT) cur = new Date(Number(mT[1])).toISOString().slice(0, 10);
    }
    const b = bucket();
    if (!b) continue;
    for (const [code] of CODES) {
      if (code === "9048" ? /9048/.test(line) : line.indexOf("code=" + code) >= 0) b.e[code] = (b.e[code] || 0) + 1;
    }
    if (logFile.indexOf("webhook") === 0 && /\[萤石推送\] 高清截帧: /.test(line)) b.streamPull++;
    if (/定时抓图失败/.test(line)) b.captureFail++;
    if (logFile.indexOf("monitor") === 0 && /已保存 captures\//.test(line)) b.archiveOK++;
  }
  return days;
}

const wh = scan("webhook_run.log") || {};
const mo = scan("monitor_run.log") || {};
const allDays = Array.from(new Set([].concat(Object.keys(wh), Object.keys(mo)))).sort().slice(-DAYS);
if (!allDays.length) { console.log("两个日志里都没解析出带日期的记录"); process.exit(0); }

console.log("日期        高清截帧(取流)  定时存档OK  抓图失败  " + CODES.map(c => c[0]).join("  "));
let verdicts = [];
for (const d of allDays) {
  const w = wh[d] || { e: {}, streamPull: 0 };
  const m = mo[d] || { e: {}, captureFail: 0, archiveOK: 0 };
  const e = (c) => (w.e[c] || 0) + (m.e[c] || 0);
  const row = [d,
    String(w.streamPull).padEnd(10),
    String(m.archiveOK).padEnd(8),
    String(m.captureFail).padEnd(6)].concat(CODES.map(c => String(e(c[0])).padEnd(c[0].length + 2)));
  console.log(row.join("  "));
  if (e("10028")) verdicts.push(d + " 出现10028 x" + e("10028") + " → 当日抓图配额(试用版约100次/日)已超限, monitor/webhook抓图全天报废");
  if (e("9048")) verdicts.push(d + " 出现9048 x" + e("9048") + " → 取流被限(免费版1Mbps/3并发), 高清截帧回落抓图接口会连带烧抓图配额");
  if (m.captureFail >= 50) verdicts.push(d + " 定时抓图连败 " + m.captureFail + " 次 → 有退避前的硬试风暴特征(v.53修复后应≤每小时1-2条)");
}
console.log("");
if (verdicts.length) verdicts.forEach(v => console.log("⚠ " + v));
else console.log("✓ 最近 " + allDays.length + " 天未发现配额类错误(10028/9048/10026)");
console.log("");
console.log("实时探针(每次消耗1次抓图配额,勿连点):");
console.log("  node -e \"const p=require('path'),f=require('fs');const{createClient}=require(p.join(process.cwd(),'lib','ys7.js'));const c=createClient(JSON.parse(f.readFileSync('config.json','utf8')).ezviz);c.capture('BK2385850').then(r=>console.log('code='+r.code, r.code==='200'?'配额有余':'已被限流:'+r.msg))\"");
console.log("控制台核对: open.ys7.com → 我的应用(套餐类型/调用统计/站内信) + 消息推送页(按日看推送条数与状态)");
