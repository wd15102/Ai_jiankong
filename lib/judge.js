// 判人/异常结论的唯一实现 —— monitor.js / webapp.js / webhook.js 全部引用此处
// 之前有 4 份各自的正则实现且已经漂移(webapp 版多排了 3 种否定式, monitor 版没有), 同一句 AI
// 结论经不同入口会得出不同判定。收敛到这里, 以后只改一个地方。
//
// 2026-09-11 修复的两个真实缺陷(实测复现):
//   1) 原 `/^\s*无人/` 缺 `m` 标志 —— 只能匹配整个多行字符串的行首, AI 结论只要不在第一行行首
//      就落到关键词分支, 结果"判断结论：无人"被判成"有人"。
//   2) 关键词命中子串 —— "没有人" 里包含 "有人"、"未见人员活动" 里包含 "人员活动",
//      于是明明没人却被判成有人并推送微信。
//
// 判定优先级: 显式标记 → 首行裸结论 → 逐句(否定优先)  → 都解析不出则记为无法解析
// 返回: { person, abnormal, matched, source }
//   person   是否有人(true/false)
//   abnormal 是否含异常描述
//   matched  是否真的解析到了结论。false 表示 AI 输出格式漂移、没读懂——
//            调用方应据此告警, 且**不要**把"读不懂"当成"无人"来拦截推送(避免漏报)
//   source   判定依据(marker/firstLine/negation/keyword/empty/unknown), 便于排查

// 人的名词: 正负两侧共用, 保证"否定 + 人"能被对称识别
// 注意"人类"不在列表里 —— "没看到明显的人类活动迹象"属于否定描述, 若把"人类"当有人标志会误报
// (2026-09-11 实测: 该措辞导致动物画面被判成有人)
var HUMAN_NOUN = "人员活动|人员|人影|人形|男子|女子|老人|小孩|男人|女人";

// 否定 + 近距离(4字符内)出现人的名词 → 判无人。用近距离而非直接相连, 才能覆盖
// "未发现有人员进入"/"没有发现任何人员"/"未发现可疑人员" 这些真实写法;
// 同时不会误伤 "无异常"/"未见异常"(后面 4 字符内没有人的名词)。
var NEG_PERSON = new RegExp(
  "(?:未|没有|没|无|非|不曾|不见|看不到|未发现|未检测到|没发现|没有发现|并无|并没有)" +
  "[^，。！？；\\n]{0,4}?(?:" + HUMAN_NOUN + "|人)"
);

// 有人: 前面不能是否定字, 否则 "没有人" 会被当成 "有人"
// (否定侧已在句中优先判定, 这里再加 lookbehind 双保险)
var POS_PERSON = new RegExp("(?<![没无未不非])(?:有人|检测到人|出现人|一个人|" + HUMAN_NOUN + ")");

var POS_ABNORMAL = /异常|需关注|注意|陌生|闯入|可疑/;
var NEG_ABNORMAL = /无异常|没有异常|没异常|未见异常|看不到异常|未发现异常|无危险|一切正常|平安无事|无可疑|未发现可疑/;

// 显式标记与"结论:"式前缀, 取最先出现的那一个
var MARKERS = [
  /【\s*(有人|无人)\s*】/,
  /\[\s*(有人|无人)\s*\]/,
  /[（(]\s*(有人|无人)\s*[)）]/,
  /(?:结论|判定|判断|结果|答复|答)\s*[:：]\s*(有人|无人)/
];

function judgeAbnormal(content) {
  var c = String(content == null ? "" : content);
  return POS_ABNORMAL.test(c) && !NEG_ABNORMAL.test(c);
}

function firstMarker(text) {
  var best = null;
  for (var i = 0; i < MARKERS.length; i++) {
    var m = MARKERS[i].exec(text);
    if (m && (!best || m.index < best.index)) best = { index: m.index, verdict: m[1] };
  }
  return best ? best.verdict : "";
}

function judgePerson(content) {
  var raw = String(content == null ? "" : content);
  var abnormal = judgeAbnormal(raw);
  function out(person, source) {
    return { person: person, abnormal: abnormal, matched: source !== "unknown", source: source };
  }
  if (!raw.trim()) return out(false, "empty");

  // 1) 显式标记: 【有人】/【无人】/ [无人] / (有人) / "结论：无人"
  var marked = firstMarker(raw);
  if (marked) return out(marked === "有人", "marker");

  // 2) 首行裸结论: 去掉 markdown/序号/前缀后以 "有人"/"无人" 开头
  var firstLine = (raw.split(/\r?\n/).filter(function (l) { return l.trim(); })[0] || "").trim();
  var bare = firstLine
    .replace(/^[#>*\-\s]+/, "")
    .replace(/^(?:结论|判定|判断|结果|答复|答)\s*[:：]?\s*/, "");
  if (/^无人/.test(bare)) return out(false, "firstLine");
  if (/^有人/.test(bare)) return out(true, "firstLine");

  // 3) 逐句判定, 句内否定优先(所以"没有人"判无人而非有人), 取第一句给出结论的
  var clauses = raw.split(/[。！!？?；;\n，,]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  for (var i = 0; i < clauses.length; i++) {
    if (NEG_PERSON.test(clauses[i])) return out(false, "negation");
    if (POS_PERSON.test(clauses[i])) return out(true, "keyword");
  }

  // 4) 读不懂: 返回 matched=false, 由调用方决定(报警链路按"可能有人"放行, 避免漏报)
  return out(false, "unknown");
}

module.exports = { judgePerson: judgePerson, judgeAbnormal: judgeAbnormal };
