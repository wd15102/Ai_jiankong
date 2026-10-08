// 视觉大模型分析: 主链 mota→ali, 备用链 agnes→xiaohongshu(主链全失败才启用, 串行)
// analyzeImage 单结论用(报警自动判读, 省配额); analyzeImageMulti 双链并行交叉复核用(本地命中事件)
const fs = require("fs");
const path = require("path");

const STATE_FILE = path.join(__dirname, "..", "data", "ai_state.json");

// 主模型 + 备用配对
const PRIMARY_PAIRS = [
  { primary: "mota", backup: "ali" },
  { primary: "agnes", backup: "xiaohongshu" }
];

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch (e) { return { cooldowns: {} }; }
}
function saveState(s) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch (e) { /* 状态写失败不中断AI调用 */ }
}

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
  const primary = findProvider(aiCfg, primaryName);
  if (!primary) {
    // 主模型未启用/不存在, 直接试备用
    const backup = findProvider(aiCfg, backupName);
    if (!backup) return null;
    const content = await callProvider(backup, bodyBase);
    return { content: content, provider: backup.name };
  }
  try {
    const content = await callProvider(primary, bodyBase);
    return { content: content, provider: primary.name };
  } catch (e) {
    console.log("  [AI] 主模型 " + primaryName + " 失败(" + String(e.message).slice(0, 80) + ")，切换备用 " + backupName + "...");
    const backup = findProvider(aiCfg, backupName);
    if (!backup) return null;
    try {
      const content = await callProvider(backup, bodyBase);
      return { content: content, provider: backup.name };
    } catch (e2) {
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
  // (代价是全失败场景的等待时间变长, 报警链路可接受)。双链并行交叉复核由 analyzeImageMulti 承担。
  // 注: 主链两个渠道都未启用时 callWithFallback 不发请求直接返回 null, 立即落到第二链
  // (webapp 单选模型传单渠道 providers 的场景不受影响)。
  const r1 = await callWithFallback(aiCfg, bodyBase, "mota", "ali");
  const best = r1 || (await callWithFallback(aiCfg, bodyBase, "agnes", "xiaohongshu"));
  if (!best) return { ok: false, reason: "所有AI渠道失败(mota/ali + agnes/xiaohongshu)" };
  return { ok: true, content: best.content, provider: best.provider };
}

// 本地命中交叉复核: 双主模型并行 + 各自备用, 返回最多2个结论
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

module.exports = { analyzeImage: analyzeImage, analyzeImageMulti: analyzeImageMulti, usableProviders: usableProviders };
