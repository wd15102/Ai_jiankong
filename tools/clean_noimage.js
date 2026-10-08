// tools/clean_noimage.js — 清理 events.json 中没有截图(file为空)的记录
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const { updateEvents } = require("../lib/store");

(async function() {
  const r = await updateEvents(ROOT, function(arr) {
    const next = arr.filter(function(e) { return !!e.file; });
    if (next.length === arr.length) return false; // 没有需要清理的
    return next;
  });
  if (r.ok) {
    console.log(r.written ? "清理完成" : "无需清理");
  } else {
    console.log("清理失败: " + (r.error && r.error.message));
    process.exit(1);
  }
})().catch(function(e) { console.error("错误:", e); process.exit(1); });