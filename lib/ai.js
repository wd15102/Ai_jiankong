// 视觉大模型分析: 主链 mota→ali, 备用链 agnes→xiaohongshu(主链全失败才启用, 串行)
// analyzeImage 单结论用(报警自动判读, 省配额)
//
// ---------- 渠道额度熔断(2026-10-09, 2026-10-11 修时区假设) ----------
// 需求(东哥): mota 额度用完后自动切 ali, 但额度恢复后必须**自动恢复 mota 优先**。
// 原来每张图都从 mota 起步: 欠费后每张都白等超时 + 一次失败请求才回落
// (实测「insufficient balance」连报 785 次), 判读整体变慢。
// 做法: 识别"额度耗尽"这类错误, 记一个熔断窗口; 窗口内直接跳过该渠道, 到期自动重试恢复优先。
//   **只熔断明确的额度错误**, 网络抖动/超时等瞬态失败不熔断(下次可能就好)。
//
// ⚠️ **熔断窗口不能按「北京次日 0 点」写死**(2026-10-11 踩坑, 东哥反馈"今天怎么全走阿里"):
// 魔塔的额度是**按 UTC 0 点重置 = 北京 08:00**, 不是北京 0 点。
//   事故: 10-11 01:06 mota 报 insufficient balance → 熔断到 10-12 00:00(北京次日 0 点),
//   可额度当天 08:00 就回来了, 结果 **mota 被白锁一整天**(10-11 全天 ali 58 条 / mota 0 条;
//   对照 10-10 mota 149 / ali 13 正常; 10-09 凌晨 h00~h07 全 ali、h08 起 mota 恢复, 正是 08:00 这个界)。
//   修法: **不猜提供商的时区**, 改成每小时重探一次 —— 无论按哪个时区重置, 最多 1 小时内
//   自动恢复优先。探测成本极低(欠费错误是**立即返回**, 不是等超时), 一天最多 24 次失败请求。
const QUOTA_RECHECK_MS = 60 * 60e3;   // 额度熔断后的重探间隔: 1 小时
//
// ⚠️ require 必须写在最前面(2026-10-09 踩过): 下面 CHANNEL_BLOCK_FILE 在模块加载期
// 就用 path.join 计算路径, 若 require 在其后→ `ReferenceError: path is not defined`
// → webhook/webapp/monitor **三个服务同时起不来**(花生壳报"内网连接失败"就是这个)。
// **教训: 改 lib/ 下任何文件后, 除了 --check 语法, 还要真的 require 一次验证能加载。**
const fs = require("fs");
const path = require("path");

const CHANNEL_BLOCK_FILE = path.join(__dirname, "..", "data", "ai_channel_block.json");

// 额度耗尽的特征串(小写匹配)。命中才当日熔断。
//
// ⚠️ **不要把 429/rate limit 当成额度耗尽**(2026-10-09 实测踩过): 魔塔(mota)在额度充足时
// 也会返回 `Throttling.ServiceOverLoaded <429> InternalError.Algo`(算法侧繁忙/限流),
// 那是**分钟级可恢复**的瞬态抖动。结果被误判成"额度耗尽"→ 熔断锁到当天 24:00
// → 东哥明明还有额度却一直走阿里(实测 mota 当天仍成功 20 次, 最新 09:52)。
// 只有**明确的余额/配额字样**才当日熔断; 429/限流走下面的短窗口重试。
const QUOTA_ERR_RE = /(insufficient\s*balance|exceeded\s*your\s*current\s*quota|quota\s*exceeded|out\s*of\s*credits|账户余额不足|额度已用完|额度不足|余额不足|配额不足|已超额|欠费)/i;
// 瞬态限流(分钟级可恢复): 不当作额度耗尽, 走短窗口冷却后重试
const TRANSIENT_ERR_RE = /(429|too\s*many\s*requests|rate\s*limit|throttling|serviceoverloaded|overloaded)/i;

// 瞬态限流的冷却时长: 5 分钟起步, 最多 30 分钟(同一个渠道连续失败会越来越久)
const TRANSIENT_COOLDOWN_MS = 5 * 60e3;

// 额度熔断的窗口终点 = min(1 小时后, 下一个 UTC 0 点 + 1 分钟)
//   · 上限 1 小时: 保证"无论提供商按哪个时区重置, 最多 1 小时内自动恢复 mota 优先"
//   · 对齐 UTC 0 点: 魔塔实测按 UTC 重置(= 北京 08:00), 命中时恢复更精准(08:01 就回来)
function nextQuotaRecheckMs() {
  const now = Date.now();
  const d = new Date(now);
  const nextUtcMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0) + 60e3;
  return Math.min(now + QUOTA_RECHECK_MS, nextUtcMidnight);
}
function readChannelBlocks() {
  try {
    const o = JSON.parse(fs.readFileSync(CHANNEL_BLOCK_FILE, "utf8"));
    const now = Date.now();
    const live = {};
    let changed = false;
    for (const k of Object.keys(o || {})) {
      if (Number(o[k]) > now) live[k] = Number(o[k]);
      else changed = true;
    }
    if (changed) { try { fs.writeFileSync(CHANNEL_BLOCK_FILE, JSON.stringify(live)); } catch (e) {} }
    return live;
  } catch (e) { return {}; }
}
// 某渠道当前是否被当日熔断
function channelBlocked(name) {
  return Number(readChannelBlocks()[name]) > Date.now();
}
// 因**额度耗尽**熔断该渠道: 熔断到 nextQuotaRecheckMs()(最多 1 小时), 到点自动重探,
// 成功即恢复优先。**不能锁到"北京次日 0 点"** —— 魔塔按 UTC 0 点(北京 08:00)重置,
// 锁到北京 0 点会把额度已恢复的大半天全白锁掉(2026-10-11 事故)。
function blockChannelForQuota(name) {
  const blocks = readChannelBlocks();
  const until = nextQuotaRecheckMs();
  blocks[name] = until;
  try {
    fs.mkdirSync(path.dirname(CHANNEL_BLOCK_FILE), { recursive: true });
    fs.writeFileSync(CHANNEL_BLOCK_FILE, JSON.stringify(blocks));
    const mins = Math.round((until - Date.now()) / 60000);
    console.log("  [AI] " + name + " 额度已耗尽, 熔断 " + mins + " 分钟后自动重探(成功即恢复优先)");
  } catch (e) {}
}
// 因**瞬态限流**(429/Throttling/ServiceOverloaded)短暂冷却 —— 分钟级可恢复, 不是额度问题。
// 不能锁到当日 24:00: 那样额度明明还有也会被一直跳过(2026-10-09 东哥"mota 还有额度却全走阿里")。
// 冷却窗口到期自动重试该渠道, 成功即恢复优先。
function coolChannelForTransient(name) {
  const blocks = readChannelBlocks();
  const cur = Number(blocks[name]) || 0;
  const base = cur > Date.now() ? cur : Date.now();      // 已有冷却则顺延, 避免反复重试
  blocks[name] = base + TRANSIENT_COOLDOWN_MS;
  try {
    fs.mkdirSync(path.dirname(CHANNEL_BLOCK_FILE), { recursive: true });
    fs.writeFileSync(CHANNEL_BLOCK_FILE, JSON.stringify(blocks));
  } catch (e) {}
  const mins = Math.round((blocks[name] - Date.now()) / 60000);
  console.log("  [AI] " + name + " 限流/繁忙(非额度问题), 冷却 " + mins + " 分钟后自动重试");
}
// 判定错误属于哪一类: "quota"(当日熔断) / "transient"(短冷却) / "" (不熔断)
function classifyAiError(msg) {
  const s = String(msg || "");
  if (QUOTA_ERR_RE.test(s)) return "quota";
  if (TRANSIENT_ERR_RE.test(s)) return "transient";
  return "";
}

// 主模型 + 备用配对
const PRIMARY_PAIRS = [
  { primary: "mota", backup: "ali" },
  { primary: "agnes", backup: "xiaohongshu" }
];

function usableProviders(aiCfg) {
  return (aiCfg.providers || []).filter(function (p) {
    return p.enabled === true && p.baseURL && p.apiKey && String(p.apiKey).indexOf("填") !== 0;
  });
}

function findProvider(aiCfg, name) {
  return usableProviders(aiCfg).find(function (p) { return p.name === name; }) || null;
}

async function callProvider(p, bodyBase) {
  const body = Object.assign({}, bodyBase, { model: p.model });
  if (p.maxTokens) body.max_tokens = p.maxTokens;
  if (p.extra) Object.assign(body, p.extra);
  const res = await fetch(String(p.baseURL).replace(/\/+$/, "") + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + p.apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout((p.timeoutSec || 30) * 1000)
  });
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); }
  catch (e) { throw new Error("HTTP " + res.status + " 非JSON: " + text.slice(0, 120)); }
  if (j.error) throw new Error((j.error.code || "") + " " + String(j.error.message || JSON.stringify(j.error)).slice(0, 150));
  const choice = j.choices && j.choices[0];
  const msg = choice && choice.message;
  let content = msg && typeof msg.content === "string" ? msg.content : "";
  if (!content && msg && typeof msg.reasoning_content === "string") {
    content = msg.reasoning_content.slice(-500);
  }
  content = String(content || "").trim();
  if (!content) throw new Error("空回复(finish=" + ((choice && choice.finish_reason) || "?") + ")");
  return content;
}

// 调用一个主模型(带备用兜底): 主模型失败则自动切换备用模型
async function callWithFallback(aiCfg, bodyBase, primaryName, backupName) {
  let primary = findProvider(aiCfg, primaryName);
  // 主模型"当日已因额度耗尽被熔断" → 直接走备用, 不做那次注定失败的请求
  // (2026-10-09: 原来每张图都先试 mota, 当天欠费后每次白等 25 秒超时才回落)
  //
  // ⚠️ `primary` 必须是 **let** 不能是 const(2026-10-09 事故): 这行给它重新赋值,
  // 用 const 会抛 `TypeError: Assignment to constant variable` → 每张图 AI 判读全失败
  // → 表现为「推送了一堆但没有 AI 结论」。
  // **这个错 --check 查不出、check_loadable 也查不出**(加载期不执行到这行),
  // 只有真的调一次 analyzeImage 才会暴露 —— 改完 lib/ai.js 必须实跑一次。
  if (primary && channelBlocked(primaryName)) primary = null;
  if (!primary) {
    // 主模型未启用/不存在/今日已熔断, 直接试备用
    const backup = findProvider(aiCfg, backupName);
    if (!backup) return null;
    const content = await callProvider(backup, bodyBase);
    return { content: content, provider: backup.name };
  }
  try {
    const content = await callProvider(primary, bodyBase);
    return { content: content, provider: primary.name };
  } catch (e) {
    const msg = String(e.message || "");
    // 按错误类型分流(2026-10-09 修正):
    //   · 明确的余额/配额字样 → 当日熔断(次日恢复)
    //   · 429/Throttling/ServiceOverloaded → **短冷却**(分钟级), 不能锁当日:
    //     实测 mota 额度充足时也会报 `Throttling.ServiceOverLoaded <429> InternalError.Algo`,
    //     被当成"额度耗尽"后锁到 24:00 → 东哥明明有额度却一直走阿里。
    //   · 网络抖动/超时 → 不熔断(下次可能就好)
    const kind = classifyAiError(msg);
    if (kind === "quota") blockChannelForQuota(primaryName);
    else if (kind === "transient") coolChannelForTransient(primaryName);
    console.log("  [AI] 主模型 " + primaryName + " 失败(" + msg.slice(0, 80) + ")，切换备用 " + backupName + "...");
    const backup = findProvider(aiCfg, backupName);
    if (!backup) return null;
    try {
      const content = await callProvider(backup, bodyBase);
      return { content: content, provider: backup.name };
    } catch (e2) {
      // 备用也失败 → 同样按类型分流(quota 当日熔断 / transient 短冷却), 避免每张图都在同一渠道上再撞一次墙
      const k2 = classifyAiError(e2 && e2.message);
      if (k2 === "quota") blockChannelForQuota(backupName);
      else if (k2 === "transient") coolChannelForTransient(backupName);
      console.log("  [AI] 备用模型 " + backupName + " 也失败(" + String(e2.message).slice(0, 80) + ")");
      return null;
    }
  }
}

// 设备端人形检测/定时抓图: 双主模型并行, 返回首个成功的结论(prefer mota)
async function analyzeImage(aiCfg, imageFile, promptOverride) {
  const providers = usableProviders(aiCfg);
  if (aiCfg.enabled === false || !providers.length)
    return { ok: false, reason: "无可用AI渠道" };

  const b64 = (await aiInputImage(imageFile)).toString("base64");
  const bodyBase = {
    messages: [{
      role: "user",
      content: [
        { type: "text", text: promptOverride || aiCfg.prompt },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64," + b64 } }
      ]
    }],
    max_tokens: aiCfg.maxTokens || 300
  };

  // 主链失败才启用第二链(串行): 原来两链每次并行各调一次模型, 每张图固定烧 2 次配额
  // 而只用其中 1 个结论; 串行后正常路径只调 1 次, 仅主链全失败时才多花第二链的配额
  // (代价是全失败场景的等待时间变长, 报警链路可接受)。
  // 注: 主链两个渠道都未启用时 callWithFallback 不发请求直接返回 null, 立即落到第二链
  // (webapp 单选模型传单渠道 providers 的场景不受影响)。
  const r1 = await callWithFallback(aiCfg, bodyBase, "mota", "ali");
  const best = r1 || (await callWithFallback(aiCfg, bodyBase, "agnes", "xiaohongshu"));
  if (!best) return { ok: false, reason: "所有AI渠道失败(mota/ali + agnes/xiaohongshu)" };
  return { ok: true, content: best.content, provider: best.provider };
}

// 本地命中交叉复核: 双主模型并行 + 各自备用, 返回最多2个结论
//
// ⚠️ **当前零调用方**(2026-10-08 审查确认: webhook.js / webapp.js / monitor.js 都没引用它)。
// 双链交叉复核已在 2026-09-30 下线(webhook.js 变更历史"移除 Agnes 双AI交叉"), 本函数只是留个口子。
// **用它会每张图固定烧 2 次配额**, 上线前先想清楚。
async function analyzeImageMulti(aiCfg, imageFile, promptOverride) {
  const providers = usableProviders(aiCfg);
  if (aiCfg.enabled === false || !providers.length) return [];

  const b64 = (await aiInputImage(imageFile)).toString("base64");
  const bodyBase = {
    messages: [{
      role: "user",
      content: [
        { type: "text", text: promptOverride || aiCfg.prompt },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64," + b64 } }
      ]
    }],
    max_tokens: aiCfg.maxTokens || 300
  };

  const results = [];
  await Promise.all(PRIMARY_PAIRS.map(async function (pair) {
    const r = await callWithFallback(aiCfg, bodyBase, pair.primary, pair.backup);
    if (r) results.push(r);
  }));
  return results;
}

// AI 判人用图压缩: 高清抓图后原图可达 2MB+(3200x1800), 整个 base64 传给视觉模型上传慢、还可能超渠道图片限制。
// 人眼看推送详情走原图, AI 判人用 1280 宽缩图足够; jimp 失败/压缩不占优时回落原图。
async function aiInputImage(imageFile) {
  let buf;
  try { buf = fs.readFileSync(imageFile); }
  catch (e) { throw new Error("读取图片文件失败: " + e.message); }
  if (buf.length <= 1024 * 1024) return buf;
  try {
    const { Jimp } = require("jimp");
    const img = await Jimp.read(buf);
    await img.resize({ w: Math.min(1280, img.bitmap.width) });
    const out = await img.getBuffer("image/jpeg");
    return out.length < buf.length ? out : buf;
  } catch (e) {
    console.log("  [AI] 大图压缩失败, 用原图: " + String(e.message).slice(0, 60));
    return buf;
  }
}

// channelBlockStatus 一并导出: 排查"为什么一直用 ali"时要能直接看到当前熔断状态,
// 不必去翻 data/ai_channel_block.json。classifyAiError 导出便于外部做同样判断。
module.exports = {
  analyzeImage: analyzeImage,
  analyzeImageMulti: analyzeImageMulti,
  usableProviders: usableProviders,
  channelBlockStatus: readChannelBlocks,
  channelBlocked: channelBlocked,
  classifyAiError: classifyAiError,
  clearChannelBlocks: function () {
    try { fs.unlinkSync(CHANNEL_BLOCK_FILE); console.log("  [AI] 已清空渠道熔断状态, 下次调用立即重新尝试主模型"); } catch (e) {}
  },
};
