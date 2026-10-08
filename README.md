# AI 看家 · 萤石云摄像头 AI 监控系统

摄像头装在**湖南常德老家**，本服务跑在**长沙的电脑**上：萤石开放平台 API 远程取图 → 视觉大模型判人 → 微信推送 + 公众号被动查询 + Web 看板。

零框架依赖（Node >= 18，仅 `jimp` 用于生成抓图缩略图），**无需公网 IP**，微信回调走花生壳内网穿透。

---

## 架构总览

```
                         ┌──────────────┐
   萤石云报警推送 ──────▶│              │────▶ 抓图 ──▶ AI 判人 ──▶ 微信模板消息推送
   (POST /ezviz/push)    │  webhook.js  │              │              (30分钟窗口限流)
                         │    :8787     │              └──▶ 写入 data/events.json
   微信菜单/关键词 ──────▶│              │────▶ 现场抓图 ──▶ 图片消息 + AI 卡片
   (POST / 回调)          │              │
                         └──────┬───────┘
                                │  /detail?file=xxx    /today
                                ▼
                          手机微信浏览器（图片可点击放大）

   monitor.js  ──每台≥30分钟定时存档抓图──▶ captures/（看板垫图，不做AI不推送）  （常驻后台）

   webapp.js :8790 ──▶ Web 看板（实时抓图 / AI 分析 / 历史报警 / 推送记录）
```

---

## 三个服务

| 服务 | 端口 | 入口 | 职责 |
|------|------|------|------|
| **微信服务** | 8787 | `webhook.js` | 公众号回调与权限分组、萤石报警接收、抓图、AI 跟进、模板消息推送、每日 20:00 日报、详情页/今日页 H5 |
| **Web 看板** | 8790 | `webapp.js` + `webapp.html` | 实时抓图、手动 AI 分析、历史报警卡片、萤石推送记录、补录今日人形报警 |
| **常驻监控** | — | `monitor.js watch` | 每台设备 ≥30 分钟定时存档抓图一张（看板垫图素材，不做 AI 不推送）。报警的 AI 判人 + 推送由 webhook.js 事件驱动链路统一处理，monitor 不再重复消耗配额 |

日常只需双击 **`一键启动全部.bat`**，它会自动拉起穿透、停旧进程、启动三个服务、做健康检查、打开看板，并进入守护循环（服务挂了自动重启）。按 `Q` 优雅停止。

---

## 设备

| 名称 | 序列号 | 型号 | 状态 |
|------|--------|------|------|
| 双溪村-CP1云台机 | BK2385850 | CS-CP1-V200-1Q6WFL | ✅ 监控中 |
| 木山村前门-PD1 | BG6569629 | CS-PD1-V105-1J4WF | ✅ 监控中 |
| 双溪村老家-C6H | D24049607 | CS-C6H-3B1WFR | 已淘汰（`hidden:true`） |

`watch:true` 才纳入监控；`hidden:true` 在看板和推送中完全隐藏。

---

## 核心功能

**智能判人，省配额**
只在**移动侦测报警**时才抓图 + 调 AI；AI 判断「有人或异常」才推送微信，无人只记日志。AI 全渠道失败也会告警（5 分钟限频），避免监控悄悄失效。

判人结论统一由 `lib/judge.js` 解析（三个服务共用同一份实现，不再各写一份正则）。它按「显式标记 `【有人】/【无人】` → 首行裸结论 → 逐句否定优先」三级判定，能正确处理「画面中没有人」和「画面中有一个人」这类叙述式结论。AI 输出格式漂移、结论读不懂时，报警链路**不拦截推送**并打警告日志（`⚠ AI结论无法解析`），避免漏报；看板则显示「未识别出结论」而不是误标成「无人」。

存量记录如果被旧逻辑判错过，用 `node tools/rejudge_events.js` 预演、`--apply` 写盘校正（会先自动备份 `events.json`）。

**看板上的「有人」是谁下的？**
有两种来源，别混为一谈：

- **AI 判定** —— 记录带 `provider`（`Agnes` / `GLM-4v`），是视觉大模型看过图之后的结论。
- **设备端判定** —— `provider` 为空、`ai` 是 `(点击AI分析)` 这种占位文案。这是萤石相机自己的人形检测（报警码 `15504` / IntelligentTag 的 human 标签）报上来的，`webhook.js` 会**无条件采信**（`person: Boolean(isPersonType || personByText)`），从头到尾没调用过模型。设备端算法对风吹树影、光斑变化很敏感，误报不少。

看板对两者用不同措辞区分：只有拿到 AI 结论才显示红色「有人」，仅有设备端结论时显示黄色「人形·设备端」。

`config.json → ai.prompt` 明确要求：只有能分辨出**头部与躯干**才算人；阴影、树影、反光光斑、门框、雕塑、挂着的衣物、塑料袋、宠物一律不算；**禁止**用「似乎/可能/好像」充当判「有人」的理由，拿不准必须判「无人」。历史教训：旧 prompt 里那句「请仔细检查远处的人形轮廓」等于逼模型必须找出一个人，实测让 `glm-4v-flash` 对一张只有树影和柱子的画面编出「有一个人影正在行走，旁边还有一只狗」。

存量的设备端记录（`person=true` 但没有任何 AI 结论）用 `node tools/recheck_events.js` 复核：默认只列清单不调 AI，`--apply` 才真正判读并写回 `person`/`provider`/`ai`（`ts`/`time`/`pushed` 一律不动），另有 `--file <存图名>` 点名单条、`--limit N` 限制条数、`--channel <渠道名>` 指定模型。

**报警记录的配图**
萤石对同一次活动会连推数条消息（人形标签**不带**截图、智能侦测带截图），两条几乎同时到达。若人形标签那条先落库，而它的「复用同活动存图」和「兜底抓图」都没成功，就会留下一条没有配图的记录 —— 看板上原本表现为一块黑屏。现在 `webhook.js` 在事务**锁内**做了补图：同一次活动已有记录但缺截图时，会用后来那条的截图补到它身上，而不是再加一条；前端对没有配图的记录渲染「无截图」占位，图片被清理时也会换成「截图已失效」，不再出现黑屏。

存量的无图记录用 `node tools/repair_noimage_events.js` 预演、`--apply` 写盘找回配图 —— 按「同设备 + 时间邻近」认领那张其实早就躺在 `captures/` 里、只是没有任何记录引用它的图。

**数据写入约定（改代码前务必看）**
`data/events.json` 被 `webhook.js` / `webapp.js` / `monitor.js` **三个独立进程**同时读写，所以**不要**再写「读全量 → 改 → 写全量」。统一用 `lib/store.js` 的事务接口：

```js
await store.updateEvents(ROOT, function (arr) {
  arr.push(newRec);   // 这里必须是同步代码, 不能有 await
  return true;        // 返回 false = 内容无变化, 跳过写盘
}, { cap: store.eventCap(cfg) });
```

它会在**锁内重新读最新内容**再交给 mutator，所以「读到写」之间夹了 `await` 也不会丢事件。
需要异步准备（下载图片、调 AI）就先做完、收集到一个数组里，最后一次性提交。
返回值的 `{ ok, written }` 必须处理：`ok=false` 表示没抢到锁、本次改动被放弃。

回归测试：`node tools/stress_events.js`（6 进程 × 120 条并发写，对照无锁实现会丢 600+ 条）。

**语义化推送**
标题形如 `亲爱的东哥 检测到双溪村-CP1云台机有人员活动`，点击卡片进入详情页看现场原图 + AI 结论（图片可点击放大、双指缩放）。

**30 分钟滑动窗口限流**
同一微信 30 分钟内最多收到 2 条萤石报警推送，窗口随时间滚动（30 分钟前的推送不再占用名额）；可在 `config.json → push.throttleWindowSec` / `push.throttleMax` 调整，避免频繁打扰。

**推送可靠性**
每次模板推送的结果（成功/失败 errcode）都追加写入 `data/push_audit.txt`；本应送达却全部失败时 60 秒后自动重试一次。推送"消失"时先查这两个文件。

**网页直播 + 云台方向盘**
`/live` 页面用 EZUIKit 播放 HLS（H265 wasm 软解码）；若设备只出 H265 流且微信内置浏览器放不了，页面自动提示「右上角···在浏览器打开」并支持一键复制链接。`ptz: true` 的设备在直播页显示云台方向盘（点按转 0.8 秒自动停）。语音对讲萤石开放平台未提供 HTTP 接口，需用萤石 App。

**每日 20:00 日报**
自动汇总当天各设备的**人形记录 + AI 分析结论**，按分组权限分别推送（分组成员的日报链接也只看本村记录）；推送全部失败时不记账，自动重试直到成功。

**微信分组权限**
在 `config.json` 的 `wxGroups` 里配置。微信测试号的菜单是全局的、无法按用户隐藏，因此越权按钮会返回「📴 该设备当前已下线」来实现分组隔离。

| 组 | 推送范围 | 查询范围 |
|----|---------|---------|
| 双溪村亲属组 | 仅双溪村 | 仅双溪村，木山村按钮被拦截 |
| 同事组 | 不推送 | 仅设备状态 |
| 未分组（默认） | 全部 | 全部 |

---

## 快速开始

**完整部署步骤见 [docs/快速启动.md](./docs/快速启动.md)**，这里是最小路径：

```bash
npm install
copy config.example.json config.json     # 然后填入自己的密钥
```

编辑 `config.json` 填好萤石 AppKey/AppSecret、设备序列号、AI 平台 apiKey、微信测试号配置、花生壳域名，然后双击 **`一键启动全部.bat`**。

> ⚠️ `config.json` 含全部密钥，**已被 .gitignore 排除，不会上传 Git**。仓库里只有脱敏模板 `config.example.json`。

---

## 目录结构

```
├── monitor.js          # CLI 入口：status / capture / once / watch / ptz
├── webapp.js           # Web 看板后端 (8790)
├── webapp.html         # Web 看板前端
├── webhook.js          # 微信服务 (8787)：回调 / 推送 / AI / 日报 / 详情页
├── lib/
│   ├── ys7.js          # 萤石平台客户端（token 缓存 / 抓图 / 报警 / 云台）
│   ├── ai.js           # 多渠道视觉模型分析 + 故障切换
│   ├── judge.js        # 判人/异常结论的唯一实现（三个服务共用，改这里就够）
│   ├── store.js        # data/*.json 的跨进程文件锁 + 读-改-写事务（三个服务共用同一把锁）
│   └── push.js         # 推送通道（wecombot / wxpusher / ntfy）
├── tools/
│   ├── update_menu.js      # 追加公众号「历史记录」菜单（幂等）
│   ├── rejudge_events.js        # 用最新判人逻辑校正存量 events.json（默认预演，--apply 才写盘）
│   ├── recheck_events.js        # 用当前 prompt 复核「设备端人形标签直通、没跑过 AI」的存量记录
│   ├── repair_noimage_events.js # 给没配图的记录找回截图（默认预演，--apply 才写盘）
│   ├── sweep_captures.js        # 清理历史遗留的孤儿抓图（默认预演，--apply 才删）
│   └── stress_events.js         # 多进程并发写 events.json 的回归测试（对照组 vs 加锁组）
├── config.example.json # 脱敏配置模板
├── config.json         # 真实配置（gitignore，含密钥）
├── public/ezuikit/     # 萤石直播播放器静态资源
├── data/               # 运行时数据（gitignore，代码自动创建）
├── captures/           # 抓图存档（gitignore，代码自动创建）
│   └── motion/         # 普通移动侦测的临时图：只为「同一次活动垫图」存在，默认 3 小时回收
├── docs/               # 文档
└── *.bat               # Windows 快捷启动脚本
```

> **抓图为什么要分两个目录？** 萤石推来的消息里约八成是「普通移动侦测」（车开过、树叶晃动、光斑变化）。
> 这类消息高频、不推微信、不进看板，截图下载后没有任何记录引用它 —— 全堆在 `captures/` 就成了只占磁盘、
> 任何界面都看不到的孤儿图（实测占 96%）。所以现在把它们单独放到 `captures/motion/`，只保留
> `storage.motionRetentionHours`（默认 3 小时）供垫图当备用帧，被选中的会搬回主目录长期留存；主目录
> 只放事件图（人形、车辆、AI 结论等），按 `storage.captureRetentionDays`（默认 60 天）清理。

---

## 微信菜单 / 关键词

在微信测试号后台添加**点击事件**菜单，EventKey 填下表：

| EventKey | 作用 |
|----------|------|
| `kanjia` | 查看双溪村当前画面 |
| `menkou` / `door` | 查看木山村前门当前画面 |
| `today` | 今日是否有人活动（按权限范围） |
| `today_bk` / `today_bg` / `today_c6` | 今日有人（指定单设备） |
| `shot_bk` / `shot_bg` / `shot_c6` | 单设备抓拍 |
| `shot_all` | 全部设备画面 |
| `live_bk` / `live_bg` / `live_c6` | 看直播 |
| `status` | 系统/设备状态 |

**文字关键词**：`看家` / `家里` / `画面` → 双溪村；`门口` / `门前` / `大门` → 木山村；`今日有人`；`状态`。

---

## HTTP 接口

**webhook.js :8787**

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST | `/` | 微信回调（GET 做签名验证，POST 收消息/事件） |
| POST | `/ezviz/push` | 萤石报警推送回调 |
| GET | `/health` | 健康检查 |
| GET | `/detail?file=xxx` | 现场详情页（原图 + AI 结论，支持放大） |
| GET | `/today` | 今日人员活动页 |
| GET | `/live` | 直播页 |
| GET | `/api/today-events?serial=` | 今日人形事件 JSON（支持 `village=` 按村过滤） |
| GET | `/api/live-url` | 直播地址 |
| GET | `/api/ptz` | 云台控制（`serial` + `dir=up/down/left/right`，仅 `ptz:true` 设备） |
| GET | `/captures/xxx.jpg` | 抓图原图 |
| GET | `/captures/motion/xxx.jpg` | 移动侦测临时图（只留 `storage.motionRetentionHours`，供推送记录页关联展示） |
| GET | `/__shutdown` | 优雅停止（启动脚本用） |

**webapp.js :8790**

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 看板页面 |
| GET | `/api/models` | 可用 AI 模型列表 |
| GET | `/api/events` | 历史报警列表 |
| GET | `/api/events/changed` | 增量检测 |
| GET | `/api/push-log` | 萤石推送记录（含每条关联的 captures 抓图与 events.json 的 AI 有人/无人结论；VMD 视频移动侦测噪音消息 webhook 侧不落盘） |
| POST | `/api/events/delete` `/delete-all` | 删除记录 |
| GET | `/api/capture` | 实时抓图 |
| GET | `/api/analyze` | 手动 AI 分析 |
| GET | `/api/alarms/check` `/check-today` | 补录人形报警 |

---

## AI 渠道（自动故障切换）

按 `config.json → ai.providers` 数组顺序尝试；某个渠道失败后进入 `failCooldownSec`（默认 300s）冷却并自动沉底，成功后恢复优先级。要求全部为 **OpenAI 兼容 `/chat/completions`** 接口。

内置示例：agnes (`agnes-2.5-flash`)、智谱 (`glm-4v-flash`)。

---

## 文档

| 文档 | 内容 |
|------|------|
| [docs/快速启动.md](./docs/快速启动.md) | 从零部署全流程（含花生壳、微信测试号配置、常见问题） |
| [docs/穿透方案.md](./docs/穿透方案.md) | 花生壳 / Tailscale / Cloudflare 三方案选型与踩坑排查 |
| [docs/萤石开放平台API文档.md](./docs/萤石开放平台API文档.md) | 萤石接口速查 |
| [docs/编码教训.md](./docs/编码教训.md) | Windows `.bat` 编码规则（GBK + CRLF，血泪教训） |
| [docs/家族通知模板.md](./docs/家族通知模板.md) | 发给家人的公众号使用说明模板 |

---

## 注意事项

- **配额**：萤石免费版抓图 **100 次/天/设备**，全部 HTTP 接口合计 **1000 次/天/账号**。本服务按此设计（默认 300s 轮询、报警才抓图），**不要把 `watchIntervalSec` 调到 120 秒以下**。
- **视频内容加密**必须在萤石 App 里保持关闭，否则抓图异常。
- **花生壳客户端必须常驻**（含开机自启）。微信点菜单报「服务出现故障」时，99% 是穿透掉了，不是代码问题 —— 排查方法见 [docs/穿透方案.md](./docs/穿透方案.md)。
- **排查推送问题**：`data/push_audit.txt` 记录每次推送成功/失败详情；`data/webhook_run.log` 是微信服务运行日志（由 `一键启动全部.bat` 落盘，服务输出不再只进隐藏窗口）。
- 所有密钥都在 `config.json`，泄露后请到对应平台重置。
