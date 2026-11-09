#!/usr/bin/env python3
"""
iOS 快捷指令 / repository_dispatch 写入入口。

把 github.event.client_payload.post 清洗、补全后追加进 data/posts.json，
并重新生成 feed.xml。id 与 created_at 一律由服务端生成，避免伪造与冲突。

本地调试：
  POST_JSON='{"type":"text","content":"来自终端的测试"}' \
    python3 .github/scripts/append_post.py
"""
from __future__ import annotations

import json
import math
import os
import re
import secrets
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build  # 同目录：复用 validate / build_feed / site_base_url / parse_time
import bot_text  # 同目录：聊天消息命令语法解析

ROOT = Path(__file__).resolve().parents[2]
POSTS = ROOT / "data" / "posts.json"
SITE = ROOT / "data" / "site.json"
FEED = ROOT / "feed.xml"
TZ = timezone(timedelta(hours=8))
TYPES = build.TYPES
MAX_TEXT = 20_000
MAX_ITEMS = 30

# 只允许这些字段进入 posts.json；id / created_at 由服务端生成，不接受外部传入
TOP_KEYS = {
    # bot_text 是机器人入口透传的原始消息，会在 build_post 里展开后被移除
    "bot_text",
    "type", "title", "content", "tags", "pinned", "place", "lat", "lng", "url",
    "images", "cover", "reading_time", "layout",
    "link", "location", "video", "music",
}
SUB_KEYS = {
    "images": {"src", "alt", "caption"},
    "link": {"url", "title", "description", "site", "image", "favicon"},
    "location": {"name", "address", "lat", "lng", "zoom", "note"},
    "video": {"platform", "id", "bvid", "page", "title", "cover", "duration", "caption"},
    "music": {"platform", "kind", "id", "title", "artist", "cover", "note", "tracks"},
    "tracks": {"title", "artist", "src"},
}
DANGEROUS = re.compile(r"javascript\s*:|data\s*:\s*text/html|vbscript\s*:", re.I)


class BadPayload(Exception):
    """payload 不合法：工作流应失败且不得提交。"""


def clean(value, depth: int = 0):
    """递归清洗：限制长度与数量，拒绝非有限数值和危险 URL 协议。"""
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            raise BadPayload("包含非有限数值（NaN / Infinity）")
        return value
    if isinstance(value, str):
        s = value.replace("\x00", "")
        if len(s) > MAX_TEXT:
            raise BadPayload(f"文本超过 {MAX_TEXT} 字符")
        if DANGEROUS.search(s):
            raise BadPayload("包含不安全的 URL 协议")
        return s
    if isinstance(value, list):
        if len(value) > MAX_ITEMS:
            raise BadPayload(f"数组超过 {MAX_ITEMS} 项")
        return [clean(v, depth + 1) for v in value]
    if isinstance(value, dict):
        if depth > 4:
            raise BadPayload("嵌套层级过深")
        return {k: clean(v, depth + 1) for k, v in value.items() if isinstance(k, str)}
    raise BadPayload(f"不支持的值类型：{type(value).__name__}")


def keep(obj: dict, keys: set[str]) -> dict:
    return {k: v for k, v in obj.items() if k in keys}


def meaningful(v) -> bool:
    if v is None or v is False:
        return False
    if isinstance(v, (str, list, dict)) and len(v) == 0:
        return False
    return True


def as_tags(value) -> list[str]:
    if isinstance(value, str):
        parts = re.split(r"[,，\n、]", value)
    elif isinstance(value, list):
        parts = [v for v in value if isinstance(v, str)]
    else:
        return []
    return [t.strip() for t in parts if isinstance(t, str) and t.strip()][:20]


def as_images(value) -> list[dict]:
    if isinstance(value, str):
        value = [s.strip() for s in value.split(",") if s.strip()]
    out = []
    if isinstance(value, list):
        for item in value[:MAX_ITEMS]:
            if isinstance(item, str) and item.strip():
                out.append({"src": item.strip()})
            elif isinstance(item, dict) and item.get("src"):
                out.append(keep(item, SUB_KEYS["images"]))
    return out


def host_of(url: str) -> str:
    try:
        return (urlparse(url).hostname or "").lower().removeprefix("www.")
    except ValueError:
        return ""


def parse_url(url: str, post: dict) -> None:
    """把通用 url 按内容类型解析成结构化字段，方便 iOS 分享链接直接发布。"""
    if not url:
        return
    t, host = post["type"], host_of(url)

    if t == "link":
        lk = post.setdefault("link", {})
        lk.setdefault("url", url)
        lk.setdefault("title", post.get("title") or host or "链接")
        lk.setdefault("site", host)
        return

    if t == "video":
        v = post.setdefault("video", {})
        m = re.search(r"BV[0-9A-Za-z]{10}", url)
        if m:
            v.setdefault("platform", "bilibili")
            v.setdefault("bvid", m.group(0))
        else:
            m = re.search(
                r"(?:youtube\.com/watch\?[^\s]*?v=|youtu\.be/|youtube\.com/embed/)([A-Za-z0-9_-]{11})",
                url,
            )
            if m:
                v.setdefault("platform", "youtube")
                v.setdefault("id", m.group(1))
        if not v:
            raise BadPayload("无法从网址识别视频，请改传 video.bvid 或 video.id")
        return

    if t == "music":
        mu = post.setdefault("music", {})
        m = re.search(r"open\.spotify\.com/(track|playlist|album)/([A-Za-z0-9]+)", url)
        if m:
            mu.setdefault("platform", "spotify")
            mu.setdefault("id", m.group(2))
            mu.setdefault("kind", "single" if m.group(1) == "track" else "playlist")
        else:
            m = re.search(r"(?:[?&#]id=|/song/)(\d+)", url)
            if m:
                mu.setdefault("platform", "netease")
                mu.setdefault("id", m.group(1))
                mu.setdefault("kind", "single")
        if not mu:
            raise BadPayload("无法从网址识别音乐，请改传 music.platform 与 music.id")
        return

    if t in ("image", "gallery"):
        post["images"] = [{"src": url}] + (post.get("images") or [])
        return
    # text / article / location：url 不解析


def build_post(raw) -> dict:
    if not isinstance(raw, dict):
        raise BadPayload("client_payload.post 必须是对象")
    raw = clean(raw)

    # 机器人入口只透传原始文本（bot_text），命令语法在这里统一展开；
    # 显式传来的标准字段优先于解析结果。HelpRequested 由 append_posts 处理。
    if "bot_text" in raw:
        text = raw.pop("bot_text")
        for k, v in bot_text.parse_bot_text(text).items():
            raw.setdefault(k, v)
        raw = clean(raw)

    post = {k: v for k, v in keep(raw, TOP_KEYS).items() if meaningful(v)}

    post["type"] = post.get("type") or "text"
    if post["type"] not in TYPES:
        raise BadPayload(f"type 非法：{post['type']!r}，可选：{', '.join(sorted(TYPES))}")

    if "tags" in post:
        post["tags"] = as_tags(post["tags"])
    if "images" in post:
        post["images"] = as_images(post["images"])
    if "pinned" in post:
        post["pinned"] = post["pinned"] is True or str(post["pinned"]).lower() in ("1", "true", "yes")

    for key in ("link", "location", "video", "music"):
        if key in post:
            if not isinstance(post[key], dict):
                raise BadPayload(f"{key} 必须是对象")
            post[key] = keep(post[key], SUB_KEYS[key])
    if isinstance(post.get("music"), dict) and isinstance(post["music"].get("tracks"), list):
        post["music"]["tracks"] = [
            keep(t, SUB_KEYS["tracks"]) for t in post["music"]["tracks"] if isinstance(t, dict)
        ]

    # 位置简写：place / lat / lng → location 对象
    if post["type"] == "location":
        loc = post.setdefault("location", {})
        if "place" in post:
            loc.setdefault("name", post.pop("place"))
        for key in ("lat", "lng"):
            if key in post:
                try:
                    loc[key] = float(post.pop(key))
                except (TypeError, ValueError):
                    raise BadPayload(f"{key} 必须是数值")
    post.pop("place", None)
    post.pop("lat", None)
    post.pop("lng", None)

    parse_url(post.pop("url", None), post)

    for key in ("link", "location", "video", "music"):
        if key in post and not post[key]:
            del post[key]

    now = datetime.now(TZ)
    post["created_at"] = now.isoformat(timespec="seconds")
    post["id"] = now.strftime("%Y%m%d-%H%M%S-") + f"{secrets.randbelow(90) + 10:02d}"

    t = post["type"]
    if t in ("text", "article") and not str(post.get("content", "")).strip():
        raise BadPayload("文字 / 文章类型必须填写 content 正文")
    if t in ("image", "gallery") and not post.get("images"):
        raise BadPayload("图文 / 相册类型必须提供 images（图片地址）")
    if t == "link" and not (post.get("link") or {}).get("url"):
        raise BadPayload("链接类型必须提供 url 或 link.url")
    if t == "location":
        loc = post.get("location") or {}
        if not isinstance(loc.get("lat"), (int, float)) or not isinstance(loc.get("lng"), (int, float)):
            raise BadPayload("位置类型必须提供数值型 lat / lng")
    if t == "video":
        v = post.get("video") or {}
        if v.get("platform") == "youtube" and not v.get("id"):
            raise BadPayload("YouTube 视频需要提供 video.id")
        if v.get("platform") == "bilibili" and not v.get("bvid"):
            raise BadPayload("B 站视频需要提供 video.bvid")
    return post


def load_raw():
    event_path = os.environ.get("GITHUB_EVENT_PATH")
    raw = None
    if event_path and Path(event_path).exists():
        event = json.loads(Path(event_path).read_text(encoding="utf-8"))
        raw = (event.get("client_payload") or {}).get("post")
    if raw is None:
        raw = json.loads(os.environ.get("POST_JSON") or "null")
    return raw


def append_posts(raws, strict: bool = False):
    """清洗并批量追加内容。

    返回 results：与 raws 一一对应的 [("ok", post) | ("skip", 原因), ...]。
    strict=True（单条 dispatch 入口）时，任何一条不合法就整批放弃且不写文件；
    strict=False（机器人轮询）时逐条跳过坏消息、好消息照常入库，
    避免一条格式错误的消息卡住 offset 造成反复重试。
    """
    prepared, results = [], []
    for raw in raws:
        try:
            post = build_post(raw)
            prepared.append(post)
            results.append(("ok", post))
        except bot_text.HelpRequested as e:
            results.append(("skip", f"帮助命令（不发布）：{e}"))
        except (BadPayload, ValueError) as e:
            results.append(("skip", str(e)))

    if strict and any(s == "skip" for s, _ in results):
        for s, v in results:
            if s == "skip":
                print(f"错误：payload 不合法 —— {v}", file=sys.stderr)
        return results
    if not prepared:
        return results

    site = json.loads(SITE.read_text(encoding="utf-8"))
    posts = json.loads(POSTS.read_text(encoding="utf-8"))
    if not isinstance(posts, list):
        print("错误：data/posts.json 顶层不是数组", file=sys.stderr)
        return [("skip", "posts.json 顶层不是数组") for _ in results]

    for post in prepared:
        for _ in range(20):
            if not any(p.get("id") == post["id"] for p in posts):
                break
            post["id"] = post["id"][:-2] + f"{secrets.randbelow(90) + 10:02d}"
        posts.append(post)
    posts.sort(
        key=lambda p: build.parse_time(p.get("created_at", ""))
        or datetime.min.replace(tzinfo=timezone.utc),
        reverse=True,
    )

    build.errors.clear()
    build.warnings.clear()
    build.validate(site, posts)
    if build.errors:
        for e in build.errors:
            print(f"[ERROR] {e}", file=sys.stderr)
        print("数据校验未通过，已放弃本次追加（仓库不会被修改）。", file=sys.stderr)
        return [("skip", "数据校验未通过") for _ in results]

    POSTS.write_text(json.dumps(posts, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    FEED.write_text(build.build_feed(site, posts, build.site_base_url(site)), encoding="utf-8")

    ids = ", ".join(p["id"] for p in prepared)
    print(f"已追加 {len(prepared)} 条（{ids}），当前共 {len(posts)} 条内容。")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(
                f"### 新内容已写入仓库（{len(prepared)} 条）\n\n"
                + "".join(
                    f"- `{p['id']}` · 类型 `{p['type']}` · {(p.get('title') or p.get('content') or '')[:40]}\n"
                    for p in prepared
                )
                + f"\n内容总数：{len(posts)} 条。GitHub Pages 会在本次提交后自动重新构建。\n"
            )
    return results


def main() -> int:
    raw = load_raw()
    if raw is None:
        print("错误：缺少 client_payload.post（或 POST_JSON）", file=sys.stderr)
        return 1
    results = append_posts([raw], strict=True)
    return 0 if results and results[0][0] == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main())
