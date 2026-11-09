# 拾光 · 一个把数据存在 GitHub 仓库里的微博客

一个**纯静态、无服务器、无数据库**的微博客站点。所有内容（文字、图片、位置、音乐、视频）都以文件形式存放在 GitHub 仓库里，页面由 GitHub Pages 托管，发布内容就是一次 `git commit`。

支持 **8 种内容形式**：文字、图文、相册、长文章、链接卡片、位置（地图）、YouTube / 哔哩哔哩视频、音乐单曲与歌单（网易云 / Spotify / 仓库自带音频）。

内置可视化**发布后台**：在浏览器里填写表单、上传图片，点击发布后由前端直接调用 GitHub Contents API 写入 `data/posts.json`，GitHub Pages 随即自动重新构建。

---

## 一、部署与当前配置

### 当前仓库的部署状态

本仓库已部署为 **用户站点（User Pages）**，配置如下：

| 项目 | 值 |
| --- | --- |
| 仓库 | `aosky-glitch/aosky-glitch.github.io` |
| 分支 / 目录 | `main` / `/`（root） |
| 构建方式 | `Deploy from a branch`（legacy） |
| 访问地址 | `https://aicode.0728.im/`（自定义域名；`https://aosky-glitch.github.io/` 会跳转过去） |
| CNAME | 仓库根目录 `CNAME` 文件，内容为 `aicode.0728.im` |
| `.nojekyll` | 存在，Pages 跳过 Jekyll，原样发布所有静态文件 |

因此**把代码推送到 `main` 即完成部署**，通常 30 秒～1 分钟生效。`.github/workflows/validate.yml` 只在 `data/` 变更时校验数据结构并生成 RSS 预览，不调用 `deploy-pages`，不会与现有的分支部署冲突。

> 若把本仓库 fork 到别处：在 Settings → Pages 里把 Source 设为 `Deploy from a branch`（选 `main` / `/`），或修改 `data/site.json` 的 `url` 与 `repo` 字段。若想改用 GitHub Actions 部署，需要把 Source 切换为 **GitHub Actions**，并新增一个使用 `actions/deploy-pages@v4` 的工作流（可参考 `.github/scripts/build.py` 组装 `_site/` 的逻辑）。

### 改成你自己的站点

编辑 `data/site.json`：

| 字段 | 说明 |
| --- | --- |
| `title` / `subtitle` / `description` | 站点名称、副标题、简介 |
| `url` | 站点绝对地址（当前为 `https://aicode.0728.im/`），用于生成 RSS 链接；留空则按 `repo` 推断 |
| `author` | 昵称、`@handle`、签名、所在地、头像路径 |
| `cover` | 顶部封面图路径 |
| `links` | 顶部导航链接数组，如 `{ "label": "GitHub", "url": "...", "icon": "github" }` |
| `theme.accent` / `theme.defaultMode` | 强调色（十六进制）与默认主题（`auto` / `light` / `dark`） |
| `pageSize` | 首屏加载条数 |
| `footer` | 页脚文字 |
| `repo` | 仓库 `owner` / `name` / `branch`，发布后台会自动读取并预填 |

示例图片在 `media/` 目录（SVG，离线可用），替换成自己的照片即可。

---

## 二、发布内容

1. 打开站点的 `admin.html`（顶部导航「写点什么」）。
2. 创建 **Fine-grained Personal Access Token**：GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens，作用范围选 `aosky-glitch.github.io` 这个仓库，权限只勾选 **Contents: Read and Write**。
3. 在后台左栏填入 Token、Owner（`aosky-glitch`）、Repo（`aosky-glitch.github.io`）、Branch（`main`），点「保存配置」。三项仓库信息已由 `site.json` 自动预填。
4. 在右栏选择内容类型、填写表单，点「预览效果」确认，再点「发布到 GitHub 仓库」。

发布流程是：读取 `data/posts.json` → 追加 / 更新一条 → 以 commit 形式写回 → Pages 自动重新构建。写错了在 GitHub 上 `git revert` 即可恢复。

后台还提供：**已有内容列表**（编辑 / 删除）、**站点设置**可视化编辑、**图片/音频上传到仓库** `media/` 目录、**导入导出 posts.json**、**JSON 视图**（直接编辑单条数据的 JSON）。

> Token 只保存在当前浏览器的 `localStorage`，不会写入仓库，也只向 `api.github.com` 发请求。请勿在公共设备上保存 Token；不用时点「清除」。

**在 iPhone / iPad 上发内容**：用 iOS「快捷指令」向仓库的 `repository_dispatch` 接口 POST 一个 JSON，GitHub Actions 会清洗、补全并追加进 `posts.json`，同时重生成 RSS，Pages 随后自动重建。完整搭建步骤（含从分享菜单发链接、8 种类型的请求体、图片上传与排错）见 **[SHORTCUTS.md](SHORTCUTS.md)**。

**给聊天机器人发消息也能发内容**：Telegram 可以纯靠 GitHub Actions 定时轮询（零后端、无需公网地址），飞书则需要一个 Cloudflare Worker 做实时中转；两者共用同一套消息语法，内容同样写回 `posts.json`。配置步骤、命令语法、安全建议与排错见 **[BOTS.md](BOTS.md)**。

---

## 三、数据格式

全部内容存放在 **`data/posts.json`**，是一个数组（新的在前、旧的在后均可，前端会按时间倒序排列，置顶内容最前）。

### 通用字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 唯一 ID，后台自动生成（如 `20261108-194200-a1b2`） |
| `type` | string | `text` / `image` / `gallery` / `article` / `link` / `location` / `video` / `music` |
| `created_at` | string | ISO 8601 时间，建议带时区，如 `2026-11-08T18:20:00+08:00` |
| `title` | string | 可选标题 |
| `content` | string | 正文，支持 Markdown（标题、粗斜体、列表、引用、代码块、链接、图片） |
| `tags` | string[] | 标签数组，用于筛选与搜索 |
| `pinned` | boolean | 可选，置顶 |

### 各类型专属字段

| 类型 | 字段 | 说明 |
| --- | --- | --- |
| `text` | — | 仅正文 |
| `image` / `gallery` | `images: [{ src, alt, caption }]` | 图片数组，`gallery` 可加 `"layout": "grid"` |
| `article` | `cover`、`reading_time` | 长文正文写在 `content`，卡片内默认折叠 |
| `link` | `link: { url, title, description, site, image, favicon }` | 链接卡片；`site` / `favicon` 留空会自动从域名生成 |
| `location` | `location: { name, address, lat, lng, zoom, note }` | 经纬度为数值，地图用 OpenStreetMap 嵌入，点击封面才加载 |
| `video` | `video: { platform, id, bvid, page, title, cover, duration, caption }` | `platform` 为 `youtube`（填 `id`）或 `bilibili`（填 `bvid`） |
| `music` | `music: { platform, kind, id, title, artist, cover, note, tracks }` | `platform`: `netease` / `spotify` / `custom`；`kind`: `single` / `playlist`；`custom` 时用 `tracks: [{ title, artist, src }]` |

### 最小示例

```json
[
  {
    "id": "20261108-194200-demo",
    "type": "text",
    "created_at": "2026-11-08T19:42:00+08:00",
    "content": "把想法写下来，它就不再占用脑子里的内存了。",
    "tags": ["随想"]
  },
  {
    "id": "20261108-194300-demo",
    "type": "video",
    "created_at": "2026-11-08T19:43:00+08:00",
    "content": "一个讲得很清楚的入门视频。",
    "tags": ["编程"],
    "video": {
      "platform": "bilibili",
      "bvid": "BV1xx411c7mD",
      "page": 1,
      "title": "光线追踪入门"
    }
  }
]
```

发布后台的 **JSON 视图** 可以直接看到任意一条内容生成的完整结构，是最方便的参考。

---

## 四、目录结构

```
.
├── index.html                  # 主站（时间线、筛选、搜索、灯箱）
├── admin.html                  # 可视化发布后台
├── 404.html                    # 404 页
├── SHORTCUTS.md                # iOS 快捷指令发布教程
├── BOTS.md                     # Telegram / 飞书机器人发布教程
├── CNAME                       # 自定义域名 aicode.0728.im（勿删）
├── .nojekyll                   # 让 Pages 跳过 Jekyll，原样发布
├── bots/
│   ├── worker.js               # Cloudflare Worker：机器人消息 → repository_dispatch
│   └── wrangler.toml           # Worker 部署配置（敏感值走 secret）
├── data/
│   ├── site.json               # 站点配置
│   └── posts.json              # 所有内容 ← 数据都在这里
├── media/                      # 图片、音频等媒体文件
├── assets/
│   ├── css/style.css           # 主站样式
│   ├── css/admin.css           # 后台样式
│   └── js/
│       ├── app.js              # 主站逻辑
│       ├── renderers.js        # 8 种内容类型的渲染器
│       ├── admin.js            # 后台逻辑
│       ├── github.js           # GitHub Contents API 封装
│       └── utils.js            # Markdown / 图标 / 转义 / 时间
├── .github/
│   ├── workflows/
│   │   ├── validate.yml         # 数据校验（不参与部署）
│   │   ├── shortcut.yml         # repository_dispatch → 追加内容并推送
│   │   └── telegram.yml         # 定时轮询 Telegram → 追加内容并推送
│   ├── bot-state.json           # 机器人轮询游标（运行时自动生成）
│   └── scripts/
│       ├── build.py             # 构建 / 校验脚本
│       ├── append_post.py       # 清洗、追加（单条 / 批量）
│       ├── bot_text.py          # 聊天消息命令语法解析
│       └── poll_telegram.py     # Telegram getUpdates 轮询与去重
└── feed.xml                    # RSS（由构建脚本生成）
```

---

## 五、常见问题

**Q：视频 / 音乐播放器点开是空白？**
YouTube 使用 `youtube-nocookie.com`，在中国大陆可能无法访问；哔哩哔哩播放器需要不带 referrer，页面已设置 `<meta name="referrer" content="no-referrer">`。两个平台都提供「在平台中打开」的外链兜底。网易云外链播放器受地区与平台策略影响，若不可用，把音乐类型改成 `custom` 并把音频文件放到仓库 `media/` 里即可获得完全自主的播放器。

**Q：图片怎么存？**
后台的「上传」按钮会把本地图片以 commit 形式写入 `media/<年>/<月>/`，并自动填入路径。单个文件限制 20MB（GitHub Contents API 不适合大文件，大图建议先压缩）。也可以直接填外链 URL。

**Q：发布后页面没变化？**
Pages 重新构建通常需要 30 秒～1 分钟；CDN 还有短暂缓存，强制刷新（Ctrl/Cmd+Shift+R）即可。可在仓库 Actions 页查看 `Validate content data` 的运行结果。

**Q：地图能换成高德 / 谷歌吗？**
当前用 OpenStreetMap（无需 API Key）。如需更换，修改 `assets/js/renderers.js` 的 `renderLocation()` 即可。

**Q：可以增加新的内容类型吗？**
可以。在 `renderers.js` 的 `TYPE_META` 与 `renderMedia()` 中加一个分支，在 `admin.js` 的 `renderTypeFields()` / `buildPost()` 中加对应表单与字段，最后在 `build.py` 的 `TYPES` 集合里登记。

**Q：内容安全吗？**
渲染前所有文本都做 HTML 转义，链接与媒体地址经过协议白名单（拒绝 `javascript:`、`data:text/html`），第三方视频 / 音乐 ID 按正则校验后才拼进 iframe 地址。因此即使仓库收到恶意 PR 内容，也不会执行脚本。

---

## 六、本地预览

数据通过 `fetch` 读取，必须用 HTTP 服务打开（直接双击 `index.html` 以 `file://` 访问会被同源策略拦截）：

```bash
cd 本仓库
python3 -m http.server 8080
# 打开 http://localhost:8080/         主站
# 打开 http://localhost:8080/admin.html  发布后台
```

本地执行 `python3 .github/scripts/build.py` 可以校验数据并生成 `feed.xml` 与 `_site/`。推送代码：

```bash
git add -A && git commit -m "更新内容与站点配置" && git push origin main
```

---

## 七、技术栈

零依赖、零构建：原生 ES Modules + CSS 变量 + GitHub Contents API + GitHub Pages。没有框架、没有打包器、没有数据库。内容即数据，发布即提交。
