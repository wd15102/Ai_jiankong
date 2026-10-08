// 改 webapp.html 后必跑: 校验页面内所有 <script> 块的 JS 语法。
// 2026-10-08 教训: 我在 mergeTag 那行少写一个闭合引号, 整个 script 块解析失败,
// 看板前端全废(统计变"--"、画面卡"正在加载"、按钮无反应)而后端 API 一切正常 ——
// 这种"后端好、前端死"的情况没有工具提示就只能靠肉眼看浏览器控制台。
//
// 用法: node tools/check_webapp_syntax.js
// 退出码 0 = 通过, 1 = 有语法错误
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const FILE = path.join(ROOT, "webapp.html");

let html;
try {
  html = fs.readFileSync(FILE, "utf8");
} catch (e) {
  console.error("读不到 " + FILE + ": " + e.message);
  process.exit(1);
}

const blocks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (!blocks.length) {
  console.error("webapp.html 里没有 <script> 块 —— 这本身就不正常, 确认文件没被截断");
  process.exit(1);
}

let failed = 0;
blocks.forEach((code, i) => {
  try {
    new vm.Script(code);
    console.log("  script[" + i + "] 语法 OK (" + code.length + " 字符)");
  } catch (e) {
    failed++;
    console.error("  script[" + i + "] ★语法错误: " + e.message);
    // 逐行定位第一处出错的行
    const lines = code.split(/\r?\n/);
    for (let k = 0; k < lines.length; k++) {
      try {
        new vm.Script(lines.slice(0, k + 1).join("\n"));
      } catch (e2) {
        const ignorable = /Unexpected end of input|Unexpected token '}'|missing \) after|Invalid or unexpected|unterminated/i;
        if (!ignorable.test(e2.message)) {
          console.error("    第 " + (k + 1) + " 行: " + lines[k].trim());
          console.error("    上一行: " + (lines[k - 1] || "").trim());
          break;
        }
      }
    }
  }
});

// 附加检查: 奇数个单引号的行(字符串未闭合的典型特征)
blocks.forEach((code, i) => {
  const bad = [];
  code.split(/\r?\n/).forEach((l, k) => {
    const n = (l.match(/(?<!\\)'/g) || []).length;
    if (n % 2 === 1) bad.push((k + 1) + ": " + l.trim().slice(0, 110));
  });
  if (bad.length) {
    failed++;
    console.error("  script[" + i + "] ★单引号数为奇数(字符串可能未闭合):");
    bad.forEach((x) => console.error("    " + x));
  }
});

if (failed) {
  console.error("\n✗ webapp.html 有 " + failed + " 处问题 —— 前端会整页失效, 修完再重启 webapp");
  process.exit(1);
}
console.log("\n✓ webapp.html 全部 script 块语法通过");
