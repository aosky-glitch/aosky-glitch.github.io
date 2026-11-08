# 用 iOS 快捷指令更新内容

不用打开电脑、不用登录后台：在 iPhone 上点一下（或从任意 App 的分享菜单），内容就会写进 `data/posts.json`，约半分钟后出现在站点上。

## 原理

```
iOS 快捷指令  ──POST──▶  GitHub repository_dispatch  ──▶  Actions 工作流
（只发一个 JSON）        /repos/.../dispatches              ├─ 清洗、补全 id/时间
                                                          ├─ 追加 data/posts.json
                                                          ├─ 重生成 feed.xml
                                                          └─ commit 到 main
                                                                 │
                                                    GitHub Pages 自动重建
                                                                 ▼
                                                    https://aicode.0728.im/
```

快捷指令**不需要**计算文件 `sha`、不需要 base64、不需要拼接整个 JSON 数组——这些全部交给仓库里的 `.github/workflows/shortcut.yml` 和 `.github/scripts/append_post.py`。接口一次成功返回 `204 No Content`。

> `client_payload` 顶层最多 10 个属性、总大小 < 64KB。本方案只用一个 `post` 属性，属性内部字段数量不受限制。

---

## 1. 准备 Token

1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**
2. Resource owner 选 `aosky-glitch`；Repository access 选 **Only select repositories** → 勾 `aosky-glitch.github.io`
3. Repository permissions 里只需把 **Contents** 设为 **Read and Write**（触发 dispatch 也只需要这一项）
4. 生成后复制 `github_pat_…` 字符串

> 发布后台 `admin.html` 用的是同一类 Token，可以直接复用那个，不必再建新的。Classic `ghp_` Token 需要 `repo` scope 才能触发，权限过大，不建议。

**Token 放在哪里**（三选一）：

| 方式 | 做法 | 适用 |
| --- | --- | --- |
| 独立配置指令（推荐） | 另建一个「微博客 Token」快捷指令，内容只有一个「文本」动作 + 「停止并输出」；主指令用「运行快捷指令」取值 | 换 Token 只改一处，便于多台设备 |
| 直接填 | 把 Token 写进主指令的第 1 个「文本」动作 | 最快，但**分享快捷指令会泄露 Token** |
| 每次询问 | 用「询问输入」代替「文本」动作，运行时手输 | 最安全，最麻烦 |

---

## 2. 搭一个最小快捷指令（纯文字）

打开「快捷指令」App → 新建，按顺序加入 7 个动作：

| # | 动作 | 配置 |
| --- | --- | --- |
| 1 | **文本** | 内容填 `<YOUR_TOKEN>`（或改成「运行快捷指令」取配置） |
| 2 | **询问输入** | 提示「写点什么」，输入类型「文本」，开启「允许多行」 |
| 3 | **词典** | 加 2 项：`type` = `text`（文本）；`content` = 魔法变量「询问输入」 |
| 4 | **词典** | 加 1 项：`post` = **类型选「词典」**，值为第 3 步的词典变量 |
| 5 | **词典** | 加 2 项：`event_type` = `microblog-post`；`client_payload` = 类型「词典」，值为第 4 步的词典变量 |
| 6 | **获取 URL 内容** | 见下方「可复制的配置值」 |
| 7 | **显示通知** | 标题「已提交」，内容「约 30 秒后出现在站点」 |

第 6 步展开「显示更多」后：

- **URL**：`https://api.github.com/repos/aosky-glitch/aosky-glitch.github.io/dispatches`
- **方法**：`POST`
- **头部**（4 项）：

  | 键 | 值 |
  | --- | --- |
  | `Authorization` | `Bearer ` ＋ 第 1 步的文本变量（注意 `Bearer` 后有空格） |
  | `Accept` | `application/vnd.github+json` |
  | `Content-Type` | `application/json` |
  | `X-GitHub-Api-Version` | `2022-11-28` |

- **请求体** → 选 **JSON** → 值放第 5 步的词典变量

> **务必用「词典」动作构造请求体，不要手写 JSON 文本。** 词典会由系统自动转义中文、换行、引号和反斜杠；手写文本遇到正文里的 `"` 或换行就会变成非法 JSON，接口直接返回 422。

完整请求体长这样（第 5 步的词典）：

```json
{
  "event_type": "microblog-post",
  "client_payload": {
    "post": {
      "type": "text",
      "content": "今天写点什么…",
      "tags": "随想, iOS"
    }
  }
}
```

---

## 3. `post` 字段速查

放进 `client_payload.post` 里的字段，**全部可选，除 `type` 与对应类型的必填项**：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `type` | 文本 | `text` / `image` / `gallery` / `article` / `link` / `location` / `video` / `music`，默认 `text` |
| `content` | 文本 | 正文，支持 Markdown；`text` / `article` 必填 |
| `title` | 文本 | 标题 |
| `tags` | 文本或数组 | `"生活,随想"` 或 `["生活","随想"]` |
| `url` | 文本 | **通用网址**：按 `type` 自动解析成链接卡片 / B站 / YouTube / 网易云 / Spotify / 图片 |
| `images` | 文本或数组 | 逗号分隔的图片地址，或 `[{"src":"…","alt":"…"}]` |
| `cover` | 文本 | 文章封面图地址 |
| `place` / `lat` / `lng` | 文本 / 数字 | 位置简写，自动合并进 `location` |
| `link` / `location` / `video` / `music` | 词典 | 完整结构化字段，优先级高于 `url` 自动解析 |
| `reading_time` / `layout` / `pinned` | 文本 / 布尔 | 可选 |

服务端会自动生成 `id` 和 `created_at`（北京时间），**外部传入的这两个字段一律丢弃**；所有字段都过白名单，危险协议（`javascript:`、`data:text/html`）会被拒绝。

---

## 4. 各类型怎么发

下面都只列出 `post` 对象，外面照旧包 `event_type` + `client_payload`。

**文字** — 正文支持 Markdown、换行：

```json
{ "type": "text", "content": "把想法写下来，它就不再占用脑子里的内存了。\n\n**粗体**也可以。", "tags": "随想" }
```

**分享一个网页** — 从 Safari 分享菜单拿到的 URL 直接塞给 `url`，会自动生成带图标、站点名的链接卡片：

```json
{ "type": "link", "content": "这篇讲得挺清楚", "url": "https://example.com/article" }
```

**B 站 / YouTube 视频** — 自动从网址提取 BV 号或视频 ID：

```json
{ "type": "video", "content": "收藏", "url": "https://www.bilibili.com/video/BV1xx411c7mD" }
```

```json
{ "type": "video", "url": "https://www.youtube.com/watch?v=aqz-KE-bpKQ" }
```

**网易云 / Spotify 音乐** — 自动识别单曲与歌单：

```json
{ "type": "music", "content": "最近单曲循环", "url": "https://music.163.com/#/song?id=1336853777" }
```

**位置** — 可接「获取当前位置」动作，把纬度和经度传进来：

```json
{ "type": "location", "content": "人少，水面很静", "place": "茅家埠 · 西湖", "lat": 30.2386, "lng": 120.1294 }
```

**图文 / 相册** — `images` 可以是逗号分隔的地址字符串：

```json
{ "type": "gallery", "content": "随手拍", "images": "media/photo-01.svg, media/photo-02.svg", "layout": "grid" }
```

**长文章** — 卡片内默认折叠，读者点「阅读全文」展开：

```json
{ "type": "article", "title": "一篇长文", "content": "## 小标题\n\n- 列表 A\n- 列表 B", "cover": "media/cover.svg", "reading_time": "约 6 分钟" }
```

需要更细的控制（如视频分 P、歌单曲目、地图缩放）时，直接传 `video` / `music` / `location` 词典，字段与 `data/posts.json` 里的示例完全一致。

---

## 5. 从分享菜单发（推荐用法）

在快捷指令详情页 → 右上角 ⚙️ → 打开 **「在共享表单中显示」**，接受类型勾 **URL / 文本 / 图像**。把第 2 步「询问输入」换成：

1. **「如果」**：条件为「快捷指令输入」「是」「URL」
2. 成立时 → 第 3 步词典用 `type` = `link`，`url` = 「快捷指令输入」
3. 否则 → `type` = `text`，`content` = 「快捷指令输入」
4. 两条分支汇入同一个第 4 步词典

这样在任何 App 里点「共享 → 你的快捷指令」，就能一步把链接或文字发到微博客。

---

## 6. 图片怎么办

`client_payload` 有 **64KB 上限**，所以**不能直接把照片塞进 dispatch**。三种可行做法：

| 方案 | 做法 | 说明 |
| --- | --- | --- |
| A. 外链地址 | `images` 填公开图片 URL | 最简单，适合已有图床 |
| B. 先用后台上传 | 在 iPhone Safari 打开 `https://aicode.0728.im/admin.html` 上传图片到 `media/`，把返回的 `media/xxx.jpg` 填进 `images` | 图片仍存在自己仓库里，推荐 |
| C. 快捷指令内上传 | 在主指令前加一步「获取 URL 内容」`PUT https://api.github.com/repos/aosky-glitch/aosky-glitch.github.io/contents/media/<唯一文件名>`，请求体 JSON 为 `{"message":"upload","content":"<图片 Base64>","branch":"main"}`，拿到路径后再发 dispatch | 进阶；图片需先压缩，文件名要唯一，同名文件需带 `sha` |

方案 C 的字段与发布后台的上传逻辑一致，可参考 `assets/js/admin.js`。**注意**：新建文件不需要 `sha`，覆盖同名文件需要先 GET 取 `sha`，否则返回 422。

---

## 7. 验证与排错

工作流运行记录：<https://github.com/aosky-glitch/aosky-glitch.github.io/actions/workflows/shortcut.yml>

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `401` | Token 无效或已撤销 | 重新生成并更新快捷指令 |
| `404` | Token 权限不足，或仓库名写错 | 确认 Fine-grained Token 有 **Contents: write**；确认仓库名 `aosky-glitch.github.io` |
| `422` | 请求体不是合法 JSON / 超过 64KB | 改用「词典」构造；缩短正文 |
| 接口成功但站点没变 | 工作流失败 | 打开上面的 Actions 链接看红叉日志 |
| 日志里「payload 不合法」 | 类型必填项缺失（如正文为空、相册没图） | 按提示补字段，仓库不会被写入脏数据 |
| 完全不触发工作流 | `event_type` 不是 `microblog-post`，或工作流文件不在默认分支 | 检查第 5 步的 `event_type`；确认 `shortcut.yml` 在 `main` |

一次成功的流程：接口返回 `204` → Actions 里出现一次 `iOS Shortcut - append post` 运行并显示绿色 → `data/posts.json` 多一条 → Pages 约 20～60 秒后重建 → 站点与 `feed.xml` 同步更新。

---

## 8. 安全提醒

- **不要把含 Token 的快捷指令分享给别人或截图发出去**；分享前先导出一份副本并删掉 Token。
- Token 只给 `Contents: Read and Write`，不要勾 `Administration` 等其它权限。
- 撤销 / 轮换 Token 后，记得更新快捷指令里的文本动作（用「独立配置指令」方案只需改一处）。
- 服务端对每条内容做字段白名单与危险协议过滤；主站另有 HTML 转义与 URL 协议白名单，即使误发异常内容也不会执行脚本。
