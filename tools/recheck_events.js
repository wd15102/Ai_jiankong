// tools/recheck_events.js —— 复核"萤石设备端人形标签直通、从没跑过 AI"的历史记录
//
// 起因(2026-09-12): 看板上有多条"画面里根本没人却标着有人"的记录。查下来是两个不同的原因,
// 其中一个和 AI 无关 —— webhook.js 收到萤石的人形检测(报警码 15504 / IntelligentTag 的 human
// 标签)时会**无条件**把 person 置 true (person: Boolean(isPersonType || personByText)), 这类
// 记录从头到尾没调用过任何模型, 卡片上却和"AI 明确判有人"长得一模一样(provider 为空、ai 是
// 占位符 "(点击AI分析)")。设备端人形算法对风吹树影/光斑很敏感, 误报不少。
//
// 本工具用线上同一套 prompt、同一套渠道, 把这些记录的存图重新判读一遍, 把 person / provider / ai
// 刷成 AI 的真实结论。**只改判定相关的三个字段**, ts / time / pushed / ezvizPic 一律保持原样 ——
// 历史时间和推送状态不能被改写。
//
// 用法:
//   node tools/recheck_events.js                       # 预演: 只列清单, 不调 AI、不写盘
//   node tools/recheck_events.js --apply               # 复核全部(受 --limit 限制)
//   node tools/recheck_events.js --apply --limit 10    # 最多复核 10 条(每条 1 次 AI 调用)
//   node tools/recheck_events.js --apply --file <存图文件名>   # 点名复核单条
//     (点名时不看它当前有没有 AI 结论 —— 已有的结论也可能是模型幻觉, 一样用新 prompt 重跑)
//   node tools/recheck_events.js --apply --channel agnes   # 指定渠道(默认按配置顺序, 成功即止)
//
// 注意: 每条记录会消耗 1 次 AI 调用; AI 输出读不懂(matched=false)时跳过该条, 不写盘。

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const { analyzeImage } = require(path.join(ROOT, "lib", "ai"));
const judge = require(path.join(ROOT, "lib", "judge"));
const store = require(path.join(ROOT, "lib", "store"));

// 与 webapp.js 的 PROVIDER_LABELS 同一套写法
const LABELS = { zhipu: "GLM-4v", agnes: "Agnes", xiaohongshu: "小红书" };

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const argOf = (name) => { const i = args.indexOf(name); return i >= 0 ? String(args[i + 1] || "") : ""; };
const FILE_ARG = argOf("--file");
const CHANNEL = argOf("--channel");
const LIMIT = Number(argOf("--limit")) || 0;

// 占位文案: 出现这些说明这条记录从没跑过 AI
const PLACEHOLDER = new Set(["", "(点击AI分析)", "(等待分析...)"]);

(async () => {
  const events = store.readEvents(ROOT);
  let targets;
  if (FILE_ARG) {
    // 点名单条时不看它当前的状态: 已有的 AI 结论也可能是模型幻觉("画面中有一个人"其实没人),
    // 一样要能用新 prompt 重跑一遍。
    const want = path.basename(FILE_ARG);
    targets = events.filter(function (e) { return e.file && path.basename(e.file) === want; });
  } else {
    // 批量模式只挑"设备端直通、从没跑过 AI"的记录, 避免误伤确有人影的正常记录
    targets = events.filter(function (e) {
      return e.person === true && PLACEHOLDER.has(String(e.ai || "")) && e.file;
    });
  }
  if (!targets.length) {
    console.log("没有需要复核的记录(条件: person=true 且 ai 是占位符 且有存图)");
    return;
  }
  if (LIMIT) targets = targets.slice(0, LIMIT);

  console.log("待复核 " + targets.length + " 条" + (APPLY ? "" : " —— 预演模式, 不调 AI、不写盘(加 --apply 才执行)"));
  targets.forEach(function (e) { console.log("  " + e.time + "  " + e.title + "  " + (e.name || "") + "  " + e.file); });
  if (!APPLY) return;

  const providers = (cfg.ai.providers || []).filter(function (p) {
    return p.enabled && p.baseURL && p.apiKey && p.model && (!CHANNEL || p.name === CHANNEL);
  });
  if (!providers.length) { console.log("无可用 AI 渠道(检查 config.json -> ai.providers)"); return; }

  console.log("\n开始复核(渠道: " + providers.map(function (p) { return p.name; }).join(" -> ") + ")");
  const updates = [];
  for (const e of targets) {
    const abs = path.join(ROOT, "captures", path.basename(e.file));
    if (!fs.existsSync(abs)) { console.log("  [跳过] 存图已被清理: " + e.file); continue; }
    let ok = false;
    for (const p of providers) {
      const one = Object.assign({}, cfg.ai, { providers: [p] });
      let r;
      try { r = await analyzeImage(one, abs); }
      catch (eCall) { console.log("  [失败] " + e.file + " " + p.name + ": " + eCall.message.slice(0, 80)); continue; }
      if (!r.ok) { console.log("  [失败] " + e.file + " " + p.name + ": " + String(r.reason).slice(0, 90)); continue; }
      const j = judge.judgePerson(r.content);
      if (!j.matched) {
        // 读不懂就别写: 把"解析不出来"写成"无人"等于制造漏报
        console.log("  [跳过] " + e.file + " AI 输出无法解析(" + j.source + "): " + String(r.content).replace(/\s+/g, " ").slice(0, 60));
        ok = true; break;
      }
      updates.push({ file: e.file, person: j.person, provider: LABELS[p.name] || p.name, ai: r.content });
      console.log("  " + e.file + "  " + (e.person ? "有人" : "无人") + " -> " + (j.person ? "有人" : "无人") + "   [" + (LABELS[p.name] || p.name) + " / " + j.source + "]");
      ok = true;
      break;
    }
    if (!ok) console.log("  [失败] " + e.file + " 所有渠道都失败");
  }

  if (!updates.length) { console.log("\n没有可写回的结果"); return; }
  const byFile = new Map(updates.map(function (u) { return [u.file, u]; }));
  const res = await store.updateEvents(ROOT, function (arr) {
    let n = 0;
    for (const ev of arr) {
      const u = byFile.get(ev.file);
      if (!u) continue;
      ev.person = u.person;
      ev.provider = u.provider;
      ev.ai = u.ai;
      n++; // ts/time/pushed/ezvizPic 不动
    }
    return n > 0;
  }, { cap: store.eventCap(cfg) });
  console.log("\n写盘: ok=" + res.ok + " written=" + res.written + (res.ok ? "" : "  ⚠ 没抢到锁, 改动被放弃, 请重跑"));
})();
