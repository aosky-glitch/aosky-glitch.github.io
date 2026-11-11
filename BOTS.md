# 用聊天机器人更新微博客

在 iOS 快捷指令之外，再加一个入口：**给机器人发条消息就能发内容**。所有内容依旧写回仓库的 `data/posts.json`，没有数据库、没有服务器数据，符合这个站点「数据都存在 GitHub 仓库」的设计。

> 本文配套文件：`.github/scripts/bot_text.py`（命令语法）、`.github/scripts/poll_telegram.py`、`.github/workflows/telegram.yml`（方案 A）、`bots/worker.js` + `bots/wrangler.toml`（方案 B）。改动 `append_post.py` 让它接受 `bot_text` 透传，并给 `shortcut.yml` / `telegram.yml` 加了同一个 `concurrency` 组，避免两个入口同时写 `posts.json`。

---

## 一、先选方案

| | **方案 A：Telegram 零后端** | **方案 B：实时中转（Worker）** |
| --- | --- | --- |
| 支持平台 | 仅 Telegram | Telegram + 飞书 + 其他能发 HTTP 回调的平台 |
| 额外基础设施 | **无**，只用 GitHub Actions | 一个 Cloudflare Worker（免费额度足够） |
| 延迟 | 0～5 分钟 + Actions 排队 | 秒级（dispatch 后约 20～30 秒上线） |
| 原理 | 定时轮询 Telegram `getUpdates` | 平台把消息 POST 给 Worker → Worker 转发 `repository_dispatch` |
| 适合 | 只想用 Telegram、不想多注册任何服务 | 想用飞书、想秒级生效、以后还想接别的平台 |

**关键区别**：Telegram 提供「拉取」接口（`getUpdates`），所以 GitHub Actions 定时去拉就能工作，**不需要公网地址**；飞书只提供「推送」接口（事件订阅要填一个公网 HTTPS 回调 URL，且 URL 验证要在 1 秒内应答），GitHub Actions 无法被动接收 HTTP，因此**飞书必须有一个中转服务**。

> ⚠️ 两个方案**不要同时用在 Telegram 上**：`getUpdates` 与 webhook 互斥，设置了 webhook 后轮询会返回 `409 Conflict`。选定一个即可。

---

## 二、共同前提：GitHub Token

两条链路最终都调用仓库的 `repository_dispatch`，所以需要同一个 Token：

- **Fine-grained PAT**，Resource owner 选 `aosky-glitch`，Repository access 只勾 `aosky-glitch.github.io`
- Repository permissions 只给 **Contents: Read and Write**
- 发布后台、iOS 快捷指令、机器人可以共用它

方案 A 里这个 Token **不需要**存进仓库（Actions 用自己的 `GITHUB_TOKEN` 写文件）；方案 B 里把它设为 Worker 的 `GH_TOKEN` secret。

---

## 三、方案 A：Telegram 零后端（推荐先试这个）

### 1. 创建 Bot

在 Telegram 里找 **[@BotFather](https://t.me/BotFather)**，发 `/newbot`，按提示设名字和用户名，拿到一串 `123456789:AAH...` 的 **BOT_TOKEN**。

### 2. 拿到你自己的 chat_id

先给你的 Bot 随便发一条消息，然后执行：

```bash
curl -s "https://api.telegram.org/bot<BOT_TOKEN>/getUpdates" | python3 -m json.tool
```

在返回的 `result[0].message.chat.id` 里找到数字（私聊是正数，群组是负数）。也可以用 [@userinfobot](https://t.me/userinfobot) 查自己的 id。

### 3. 配置仓库 Secrets

GitHub 仓库 → **Settings → Secrets and variables → Actions → New repository secret**，添加：

| Secret | 值 |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | 第 1 步的 token |
| `TELEGRAM_ALLOWED_CHATS` | 第 2 步的 chat_id（多个用逗号分隔） |
| `TELEGRAM_ALLOWED_USERS` | 可选，按 user_id 白名单；两个白名单填一个即可 |

**白名单是强制的**：脚本检测到两个都没配会直接拒绝发布，否则任何人都能往你博客里发东西。

### 4. 启用工作流

把本仓库的 `.github/workflows/telegram.yml`、`.github/scripts/poll_telegram.py`、`bot_text.py` 推到 `main` 后：

1. 打开 `Actions → Telegram Bot - poll & append`，点 **Run workflow** 手动跑一次；
2. 脚本会建立并提交 `.github/bot-state.json` 状态文件（**队列为空时也会建立**），日志打印「已初始化状态文件，下一条消息会正常发布」；
3. 只有当状态文件尚不存在、而队列里已堆着旧消息时，那一批才会被当作历史消息跳过，日志打印「已跳过 N 条历史消息」，并给白名单用户回一句「Bot 已连接，请再发一条」；
4. 之后给 Bot 发消息，最多 5 分钟就会被处理，**不需要再发两条**。

工作流用 `cron: '2,7,12,... * * * *'` 每 5 分钟跑一次（分钟偏移 2，避开 GitHub 整点排队高峰，时间为 UTC，不用换算北京时间）。没有新消息时不会产生任何 commit。

### 5. 发一条试试

```
今天天气不错，躺阳台晒太阳 #日常 #随想
```

Bot 会回一条 `✅ 已发布（text）· 20261109-...`；约 20～30 秒后刷新 https://aicode.0728.im/ 就能看到。格式错误会回 `⚠️ 未发布：原因`，不会污染站点。

### 注意事项

- **群里用**：默认 Bot 开启 privacy mode，只能收到 `/命令` 或 @它 的消息。要么在 @BotFather 用 `/setprivacy` 关掉，要么每条都 @Bot。
- **Secret 必须放对位置**：是 **Repository secrets**（`Settings → Secrets and variables → Actions` 上半区），不是 Environment / Dependabot secrets；名字是 `TELEGRAM_BOT_TOKEN`，不是方案 B 的 `TG_BOT_TOKEN`。放错时脚本读不到，日志会打一条黄色 `::warning::`，但**工作流仍显示绿色成功**——所以「绿色 ≠ 配置生效」，要点开 run 看 Python 步骤的输出。
- **不能同时设 webhook**：若之前跑过方案 B，先执行 `curl "https://api.telegram.org/bot<TOKEN>/deleteWebhook"`。
- **公开仓库的定时工作流会在 60 天无仓库活动后自动禁用**。很久不发内容后突然不生效，去 Actions 页重新启用即可（改一下 cron 值再提交也会重新激活）。这是 GitHub 的官方限制，不是脚本故障。
- GitHub 明确说明定时任务在高负载时**可能延迟甚至跳过一轮**，所以整点前后别指望精确 5 分钟。要秒级就用方案 B。

---

## 四、方案 B：实时中转（Telegram + 飞书统一接入）

### 1. 部署 Worker

```bash
cd bots
npm i -g wrangler
wrangler login
wrangler deploy          # 按提示创建 Worker，得到 https://microblog-bot.<子域>.workers.dev
```

验证部署：浏览器打开这个地址，应返回一个说明 `service: microblog bot bridge` 的 JSON。

### 2. 配置 Secrets（不要写进 wrangler.toml，也不要提交到仓库）

```bash
wrangler secret put GH_TOKEN              # 第二节那个 Fine-grained PAT
wrangler secret put TG_SECRET             # 自己编的随机串，如 aB3d_9xK2mQ
wrangler secret put TG_ALLOWED            # 你的 chat_id
wrangler secret put TG_BOT_TOKEN          # 可选，用于回复 /help
wrangler secret put FEISHU_VERIFY_TOKEN  # 飞书应用的 Verification Token
wrangler secret put FEISHU_ENCRYPT_KEY   # 飞书 Encrypt Key（推荐）
wrangler secret put FEISHU_ALLOWED       # 可选，飞书 open_id / chat_id 白名单
```

`GH_REPO` 已经写在 `wrangler.toml` 的 `[vars]` 里，无需重复设置。

### 3a. 接 Telegram

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://microblog-bot.<子域>.workers.dev/telegram" \
  -d "secret_token=aB3d_9xK2mQ" \
  -d 'allowed_updates=["message"]'
```

`secret_token` 必须与 `TG_SECRET` 完全一致，只允许 `A-Z a-z 0-9 _ -`，1～256 字符。Worker 会校验请求头 `X-Telegram-Bot-Api-Secret-Token`，不匹配直接 401。用 `getWebhookInfo` 确认：

```bash
curl -s "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo" | python3 -m json.tool
```

> 启用 webhook 前请先按方案 A 注意事项里的 `deleteWebhook` 说明确认没有在跑轮询工作流，**两者互斥**。想切回轮询就执行 `deleteWebhook`。

### 3b. 接飞书

> 飞书「群里的自定义机器人 / Webhook」**只能往群里发消息，收不到消息**，别用那个。要收消息必须建**企业自建应用**。

1. 打开 [飞书开放平台](https://open.feishu.cn/) → **开发者后台 → 创建企业自建应用**，填名字、图标。
2. **添加应用能力** → 选择「机器人」。
3. **权限管理**：开通与「获取消息」相关的权限（控制台里搜 `im:message`，按提示申请；只是接收自己发的单聊消息时所需范围最小）。
4. **事件与回调 → 加密策略**：记下 **Verification Token**；推荐点「编辑」生成 **Encrypt Key**。这两个值分别填进上面的 `FEISHU_VERIFY_TOKEN` / `FEISHU_ENCRYPT_KEY`。
   - 配了 Encrypt Key：Worker 用 `sha256(timestamp + nonce + encrypt_key + 原始 body)` 校验 `X-Lark-Signature`，并做 AES-256-CBC 解密；
   - 不配也可以：Worker 退化为校验 Verification Token，但 token 是明文传输，安全性略低。
5. **事件订阅**：订阅方式选「**将事件发送至开发者服务器**」，请求地址填 `https://microblog-bot.<子域>.workers.dev/feishu`，保存时飞书会发一个 `url_verification` 请求，Worker 会原样返回 `challenge` —— **保存前 Worker 必须已部署成功**，否则验证过不了。
6. 添加事件 **「接收消息 `im.message.receive_v1`」**。
7. **创建版本并发布**（自建应用改配置后必须发版本才生效），设置可用范围，然后把机器人加到某个群，或直接私聊它。
8. 发一条文字试试。飞书的 HTTP 回调无法直接回消息，所以 `/help` 不会回复（语法见下一节 / 本文），发布结果请到 Actions 页或 `wrangler tail` 看。

> 群里 @机器人时，飞书文本里会带 `@_user_1` 之类的占位符，Worker 已自动清理。
> 飞书要求回调在 1～3 秒内返回 2xx，所以 Worker 先回 200，再用 `waitUntil` 异步转发 dispatch，避免超时重试造成重复发布。

---

## 五、消息语法（两个方案完全一致）

**直接发文字**就是一条 text 动态，支持 Markdown；命令放在开头：

| 消息 | 效果 |
| --- | --- |
| `今天天气不错 #日常` | 文字动态，标签 `日常` |
| `/post 正文` | 文字（等同于直接发） |
| `/article 标题 \| 正文` | 长文章，带封面折叠区与「阅读全文」 |
| `/link https://example.com 说明` | 链接卡片；写 `网址 自定义标题 \| 说明` 可改标题 |
| `/video https://www.bilibili.com/video/BV1xx411c7mD 说明` | B 站视频（自动提取 BV 号）；也支持 YouTube |
| `/music https://music.163.com/#/song?id=123456 说明` | 网易云单曲；Spotify 的 track/playlist 链接也支持 |
| `/photo https://.../a.jpg 说明` | 单图 |
| `/gallery https://.../a.jpg,https://.../b.jpg 说明` | 相册（网址用空格或逗号分隔都行） |
| `/location 良渚文化村 \| 30.39 \| 119.98 \| 周末散步` | 位置卡片 |
| `/help` | Telegram 会回语法；飞书忽略不发布 |

规则说明：

- 正文里的 `#标签` 会被提取成 `tags` 并从正文移除。Markdown 标题请写成 `# 标题`（带空格），`## 小标题` 不会被误判为标签。
- 网址必须是 `https://` 或 `http://`；`/link` `/video` 等命令缺网址会被拒绝并回错误。
- **图片只能发网址，不能直接发图片文件**（`repository_dispatch` 的 payload 上限 64KB）。上传图片的 3 种方案见 [SHORTCUTS.md](SHORTCUTS.md)。
- 命令由仓库里的 `.github/scripts/bot_text.py` 统一解析：Worker 和轮询脚本只透传原文。所以**加新命令只需改这一个文件**，所有入口同时生效；XSS 转义、URL 协议白名单、字段白名单、`id`/`created_at` 服务端生成仍复用 `append_post.py` 的既有逻辑。

---

## 六、链路一览

```
Telegram 消息 ─┬─ 方案 A: Actions 每 5 分钟 getUpdates → poll_telegram.py ─┐
              └─ 方案 B: webhook → Worker /telegram ─────────────────────┤
飞书 消息 ───────────── 事件订阅 → Worker /feishu ───────────────────────┤
iOS 快捷指令 ────────────── 直接 POST /dispatches ───────────────────────┤
                                                                          ▼
                                            client_payload.post.bot_text（原文）
                                                                          │
                                   repository_dispatch → shortcut.yml ─────┤
                                                                          ▼
                                   append_post.py：bot_text 展开 → 清洗 → 校验
                                                                          ▼
                       data/posts.json + feed.xml → commit → Pages 重建 → 站点可见
```

方案 A 是个例外：轮询脚本**直接调用** `append_post.append_posts()` 写文件，不再发一次 dispatch，避免自己触发自己。

---

## 七、安全清单

- ✅ **白名单必填**：Telegram 的 `TG_ALLOWED` / `TELEGRAM_ALLOWED_CHATS`、飞书建议配 `FEISHU_ALLOWED`。没有白名单 = 任何人都能发内容。
- ✅ **Telegram webhook 必配 `secret_token`**，Worker 会拒绝没有正确头的请求。
- ✅ **飞书配 Encrypt Key + 签名校验 + 5 分钟时间戳防重放**；不配至少也要校验 Verification Token。
- ✅ **GitHub Token 只给 Contents: Read and Write**，存 Worker secret / 浏览器 localStorage，绝不写进仓库。
- ✅ 消息文本经过 `clean()`：长度上限 20000 字符、拒绝 `javascript:` / `data:text/html`、URL 协议白名单。
- ✅ 两条写入链路共用一个 `concurrency: microblog-write` 组，避免并发覆盖。

---

## 八、排错对照

| 现象 | 原因 / 处理 |
| --- | --- |
| 消息发出去但站点没变 | 去 `Actions` 看对应工作流；`?cb=时间戳` 绕过 CDN 缓存；确认 `data/posts.json` 条数是否增加 |
| Telegram 轮询报 `Conflict: webhook is active` | 已设 webhook，执行 `deleteWebhook`；或改用方案 B（两者互斥） |
| Actions 日志显示 `未配置 TELEGRAM_BOT_TOKEN` | Secret 没建在 **Repository secrets**、名字写错（方案 A 是 `TELEGRAM_BOT_TOKEN`，不是方案 B 的 `TG_BOT_TOKEN`）、或刚创建还没轮到下一次定时；改完点 **Run workflow** 立即验证 |
| Actions 日志显示 `未配置 TELEGRAM_ALLOWED_CHATS / ...` | 白名单是强制的，至少配一个；私聊 chat_id 为正数、群组为负数 |
| Actions 日志显示 `无新消息` | Secret 已生效、Bot 也通了，只是队列里没有待处理消息；给 Bot 发一条**私聊**再触发一次 |
| Telegram 消息完全没反应 | 白名单 chat_id 不对；群里 privacy mode；定时工作流被 60 天规则禁用；看 Actions 日志 |
| 飞书保存回调地址失败 | Worker 没部署 / 路径不是 `/feishu`；`GET https://...workers.dev/` 应先返回 JSON；配了 Encrypt Key 但 Worker 没设对应 secret |
| 飞书保存成功、发消息没发布 | 应用改配置后**没发布版本**；没订阅 `im.message.receive_v1`；`wrangler tail` 看日志；签名/时间戳校验失败会返回 401 |
| Worker 日志里 `dispatch 失败：HTTP 401` | `GH_TOKEN` 被撤销或权限不足，换成 Contents: RW 的细粒度 token |
| 内容重复出现 | 平台回调超时重试；确认没有同时启用 webhook 与轮询；飞书可配 `FEISHU_ALLOWED` 与事件去重 |
| 机器人回了 `⚠️ 未发布` | 看具体原因：缺网址、经纬度非法、正文为空、含危险协议等，改完重发即可 |

---

## 九、接别的平台

Worker 里所有 handler 最后都只调一个函数：

```js
await dispatch(env, text, '来源名');
```

所以 Discord / Slack / 企业微信 / 钉钉 / 自建 Webhook 等，只要能 POST 一段 JSON 过来，加一个 `handleXxx()` 解析出 `text`、校验好签名与白名单，再复用 `dispatch()` 就行。命令语法无需改动——解析始终在仓库的 `bot_text.py` 里。
