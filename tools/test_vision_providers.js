// tools/test_vision_providers.js
// 免费视觉模型可用性 + 输出格式合规性实测。
// 用真实抓图 + 项目真实 prompt 打各候选模型，检查是否满足 judgePerson 的第一行「有人/无人」要求。
// 用法: node tools/test_vision_providers.js [图片文件名]
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const prompt = cfg.ai.prompt;

// 取一张真实抓图（默认最新一张事件图）
const cp = path.join(root, 'captures');
let imgFile = process.argv[2];
if (!imgFile) {
  const list = fs.readdirSync(cp)
    .filter(f => /\.jpg$/i.test(f) && !f.startsWith('thumb_'))
    .map(f => ({ f, m: fs.statSync(path.join(cp, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  imgFile = list[0].f;
}
const imgPath = path.join(cp, imgFile);
const dataUrl = 'data:image/jpeg;base64,' + fs.readFileSync(imgPath).toString('base64');
console.log('测试图:', imgFile);
console.log('prompt 头两行:', JSON.stringify(prompt.split('\n').slice(0, 2).join(' / ')));
console.log('='.repeat(70));

const zk = (cfg.ai.providers.find(p => p.name === 'zhipu') || {}).apiKey;
const ak = (cfg.ai.providers.find(p => p.name === 'agnes') || {}).apiKey;

// 候选清单：只测「当前有 key、能立刻验证」的；其余列在报告里等东哥决定是否申请
const CASES = [
  { label: '智谱 glm-4.6v-flash (默认)', base: 'https://open.bigmodel.cn/api/paas/v4', key: zk, model: 'glm-4.6v-flash', extra: {} },
  { label: '智谱 glm-4.6v-flash (thinking关)', base: 'https://open.bigmodel.cn/api/paas/v4', key: zk, model: 'glm-4.6v-flash', extra: { thinking: { type: 'disabled' } } },
  { label: '智谱 glm-4.1v-thinking-flash', base: 'https://open.bigmodel.cn/api/paas/v4', key: zk, model: 'glm-4.1v-thinking-flash', extra: {} },
  { label: '智谱 glm-4v-flash (现基线)', base: 'https://open.bigmodel.cn/api/paas/v4', key: zk, model: 'glm-4v-flash', extra: {} },
  { label: 'agnes-3.0-flash (现基线)', base: 'https://apihub.agnes-ai.com/v1', key: ak, model: 'agnes-3.0-flash', extra: {} },
  { label: 'agnes-3.0-flash 中国站', base: 'https://apihub.agnes-ai.cn/v1', key: ak, model: 'agnes-3.0-flash', extra: {} },
];

// 与 lib/judge.js 同源的第一行判定（粗判，仅用于展示合规性）
function firstLineVerdict(txt) {
  if (!txt) return '(空)';
  const l = String(txt).trim().split(/\r?\n/)[0].trim();
  if (/^无人/.test(l) || l === '无人') return '无人 ✓';
  if (/^有人/.test(l) || l === '有人') return '有人 ✓';
  return '格式异常 ✗ [' + l.slice(0, 24) + ']';
}

(async () => {
  for (const c of CASES) {
    if (!c.key) { console.log(`\n【${c.label}】 跳过：无 key`); continue; }
    const url = c.base.replace(/\/$/, '') + '/chat/completions';
    const body = Object.assign({
      model: c.model,
      max_tokens: 600,
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl } }, { type: 'text', text: prompt }] }],
    }, c.extra);
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
      });
      const dt = Date.now() - t0;
      let j = null;
      try { j = await res.json(); } catch (e) { }
      const txt = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      console.log(`\n【${c.label}】`);
      console.log(`  HTTP ${res.status}  ${dt}ms`);
      if (!txt) {
        console.log('  ✗ 无 content:', JSON.stringify(j).slice(0, 220));
        continue;
      }
      console.log('  第一行判定:', firstLineVerdict(txt));
      console.log('  原始输出:', JSON.stringify(String(txt).slice(0, 200)));
      if (j.usage) console.log('  usage:', JSON.stringify(j.usage));
    } catch (e) {
      console.log(`\n【${c.label}】`);
      console.log('  ✗ 失败 ' + (Date.now() - t0) + 'ms:', String(e.message).slice(0, 120));
    }
  }
  console.log('\n' + '='.repeat(70));
})();
