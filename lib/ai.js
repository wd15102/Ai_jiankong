// 视觉大模型分析：多渠道自动故障切换（OpenAI 兼容接口）
// 渠道顺序按 config.json -> ai.providers 数组顺序；失败的渠道进入冷却期，成功后解除
const fs = require("fs");
const path = require("path");

const STATE_FILE = path.join(__dirname, "..", "data", "ai_state.json");

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch (e) { return { cooldowns: {} }; }
}
function saveState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function usableProviders(aiCfg) {
  return (aiCfg.providers || []).filter(function (p) {
    return p.enabled === true && p.baseURL && p.apiKey && String(p.apiKey).indexOf("填") !== 0;
  });
}

async function callProvider(p, bodyBase) {
  const body = Object.assign({}, bodyBase, { model: p.model });
  if (p.maxTokens) body.max_tokens = p.maxTokens; // 渠道级token上限（如agnes推理模型需要更大值）
  const res = await fetch(String(p.baseURL).replace(/\/+$/, "") + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + p.apiKey },
    body: JSON.stringify(body)
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
    content = msg.reasoning_content.slice(-500); // 推理模型兜底：截取思考尾部的结论
  }
  content = String(content || "").trim();
  if (!content) throw new Error("空回复(finish=" + ((choice && choice.finish_reason) || "?") + ")");
  return content;
}

async function analyzeImage(aiCfg, imageFile, promptOverride) {
  const providers = usableProviders(aiCfg);
  if (aiCfg.enabled === false || !providers.length)
    return { ok: false, reason: "无可用AI渠道（检查 config.json -> ai.providers 的 enabled/baseURL/apiKey/model）" };

  const b64 = fs.readFileSync(imageFile).toString("base64");
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

  const state = loadState();
  const now = Date.now();
  // 稳定排序：未冷却的保持配置顺序在前，冷却中的沉底
  const ordered = providers.slice().sort(function (a, b) {
    return (state.cooldowns[a.name] || 0) - (state.cooldowns[b.name] || 0);
  });

  const errors = [];
  for (const p of ordered) {
    if ((state.cooldowns[p.name] || 0) > now) { errors.push(p.name + ": 冷却中"); continue; }
    try {
      const content = await callProvider(p, bodyBase);
      delete state.cooldowns[p.name]; // 成功即解除冷却
      saveState(state);
      return { ok: true, content: content, provider: p.name };
    } catch (e) {
      state.cooldowns[p.name] = now + (aiCfg.failCooldownSec || 300) * 1000;
      saveState(state);
      errors.push(p.name + ": " + e.message.slice(0, 120));
      console.log("  [AI] 渠道 " + p.name + " 失败(" + e.message.slice(0, 90) + ")，自动切换下一家...");
    }
  }
  return { ok: false, reason: "所有AI渠道失败 -> " + errors.join("; ") };
}

module.exports = { analyzeImage: analyzeImage, usableProviders: usableProviders };
