#!/usr/bin/env python3
"""把聊天消息文本解析成一条 post payload。

设计要点：所有机器人入口（Telegram 轮询、Cloudflare Worker 中转）都**不解析文本**，
只把原文放进 client_payload.post.bot_text 透传；解析统一在这里做。
于是命令语法、类型映射、URL 提取只维护一份，安全清洗仍由 append_post.py 负责。
"""
from __future__ import annotations

import re

URL_RE = re.compile(r"https?://[^\s<>\"'，,；;]+", re.I)
TAG_RE = re.compile(r"(?<!\S)#([^\s#，,。、]{1,24})")
CMD_RE = re.compile(r"^/([a-zA-Z]+)(?:@[A-Za-z0-9_]+)?(?:\s+|$)")

# 命令 → 内容类型。未列出的命令不会吞掉正文，按普通文字处理。
COMMANDS = {
    "post": "text", "text": "text", "note": "text",
    "article": "article", "long": "article",
    "link": "link",
    "video": "video",
    "music": "music", "song": "music",
    "photo": "image", "image": "image", "pic": "image",
    "gallery": "gallery", "album": "gallery",
    "location": "location", "place": "location",
}
NEEDS_URL = {"link", "video", "music", "image", "gallery"}

HELP = """📝 发内容：直接发文字即可（支持 Markdown），或在开头加命令：

/post 正文              文字（默认）
/article 标题 | 正文    长文章
/link 网址 说明         链接卡片
/video 网址 说明        B 站 / YouTube 视频
/music 网址 说明        网易云 / Spotify 单曲或歌单
/photo 网址 说明        单图
/gallery 网址1,网址2    相册
/location 名称 | 纬度 | 经度 | 备注   位置
/help                  显示本帮助

正文末尾写 #标签 可加标签（如：今天天气不错 #日常 #随想）。
图片请发图片网址，不要直接发图片文件。"""

MAX_LEN = 20_000


class HelpRequested(Exception):
    """消息是 /help：入口应回复帮助文本，不要发布。"""


def _split_title(s: str):
    """把 `标题 | 正文` 拆开；没有 | 时标题为空。"""
    if "|" not in s:
        return "", s.strip()
    title, _, rest = s.partition("|")
    return title.strip(), rest.strip()


def parse_bot_text(text) -> dict:
    """返回可直接交给 append_post.build_post 的标准 post 字典。"""
    if not isinstance(text, str):
        raise ValueError("bot_text 必须是字符串")
    s = text.replace("\x00", "").strip()
    if not s:
        raise ValueError("消息为空，没有可发布的内容")
    if len(s) > MAX_LEN:
        raise ValueError(f"消息超过 {MAX_LEN} 字符")

    # 1) 标签：#标签 提取为 tags，并从正文移除（Markdown 的 `## 标题` 不会被误判）
    tags = TAG_RE.findall(s)
    s = TAG_RE.sub("", s).strip()

    # 2) 命令
    ptype = "text"
    m = CMD_RE.match(s)
    if m:
        cmd = m.group(1).lower()
        if cmd in ("help", "start"):
            raise HelpRequested(HELP)
        if cmd in COMMANDS:
            ptype = COMMANDS[cmd]
            s = s[m.end():].strip()

    post: dict = {"type": ptype}

    # 3) 位置：名称 | 纬度 | 经度 | 备注
    if ptype == "location":
        parts = [x.strip() for x in s.split("|")]
        if len(parts) < 3:
            raise ValueError("位置格式：/location 名称 | 纬度 | 经度 | 备注")
        try:
            lat, lng = float(parts[1]), float(parts[2])
        except ValueError:
            raise ValueError("位置的纬度 / 经度必须是数字")
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            raise ValueError("纬度需在 -90~90，经度需在 -180~180")
        post["place"] = parts[0] or "未命名地点"
        post["lat"], post["lng"] = lat, lng
        rest = parts[3] if len(parts) > 3 else ""
        if rest:
            post["content"] = rest
        if tags:
            post["tags"] = tags
        return post

    # 4) 需要网址的类型：抽出 URL，剩余文字作说明
    if ptype in NEEDS_URL:
        urls = URL_RE.findall(s)
        if not urls:
            raise ValueError(f"/{ptype} 需要在消息里包含一个 https:// 网址")
        rest = URL_RE.sub("", s).strip()
        title, body = _split_title(rest)
        if ptype == "gallery":
            post["images"] = urls
        else:
            post["url"] = urls[0]
        if title:
            post["title"] = title
        if body:
            post["content"] = body
        elif not title:
            # 只有网址时给一句兜底说明，避免卡片看起来是空的
            post["content"] = ""
        if tags:
            post["tags"] = tags
        return post

    # 5) 文字 / 长文
    title, body = _split_title(s) if ptype == "article" else ("", s)
    if title:
        post["title"] = title
    if body:
        post["content"] = body
    if tags:
        post["tags"] = tags
    return post
