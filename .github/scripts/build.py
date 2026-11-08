#!/usr/bin/env python3
"""
构建脚本（GitHub Actions 中自动运行，也可本地执行）：
1. 校验 data/site.json 与 data/posts.json 的结构与安全性
2. 生成 feed.xml（RSS 2.0）
3. 组装 _site/ 纯静态产物目录

本地运行：python3 .github/scripts/build.py
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import format_datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "_site"
TYPES = {"text", "image", "gallery", "article", "link", "location", "video", "music"}
STATIC_FILES = ["index.html", "admin.html", "404.html"]
STATIC_DIRS = ["assets", "data", "media"]

errors: list[str] = []
warnings: list[str] = []


def fail(msg: str) -> None:
    errors.append(msg)


def warn(msg: str) -> None:
    warnings.append(msg)


def load_json(path: Path):
    if not path.exists():
        fail(f"缺少文件：{path.relative_to(ROOT)}")
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        fail(f"{path.relative_to(ROOT)} 不是合法 JSON：{e}")
        return None


def strip_markdown(text: str, limit: int = 260) -> str:
    s = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", str(text))
    s = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", s)
    s = re.sub(r"[`*_#>~|-]", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s[:limit] + ("…" if len(s) > limit else "")


def parse_time(value: str) -> datetime | None:
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


def validate(site, posts) -> None:
    if not isinstance(site, dict):
        fail("site.json 顶层应为对象")
    if not isinstance(posts, list):
        fail("posts.json 顶层应为数组（每条内容一个对象）")
        return

    seen: set[str] = set()
    for i, p in enumerate(posts):
        tag = f"第 {i + 1} 条"
        if not isinstance(p, dict):
            fail(f"{tag} 不是对象")
            continue
        pid, ptype = p.get("id"), p.get("type")
        if not pid or not isinstance(pid, str):
            fail(f"{tag} 缺少合法的 id")
        elif pid in seen:
            fail(f"id 重复：{pid}")
        else:
            seen.add(pid)
        if ptype not in TYPES:
            fail(f"{tag}（{pid}）的 type 非法：{ptype!r}，可选值：{', '.join(sorted(TYPES))}")
        if not p.get("created_at") or parse_time(p["created_at"]) is None:
            fail(f"{tag}（{pid}）缺少合法的 created_at（ISO 8601）")

        # 内容必填项的宽松提示，不阻断部署
        if ptype in ("text", "article") and not str(p.get("content", "")).strip():
            warn(f"{tag}（{pid}）正文为空")
        if ptype in ("image", "gallery"):
            imgs = [x for x in (p.get("images") or []) if isinstance(x, dict) and x.get("src")]
            if not imgs:
                warn(f"{tag}（{pid}）没有有效图片")
        if ptype == "link" and not (p.get("link") or {}).get("url"):
            warn(f"{tag}（{pid}）链接地址为空")
        if ptype == "location":
            loc = p.get("location") or {}
            if not isinstance(loc.get("lat"), (int, float)) or not isinstance(loc.get("lng"), (int, float)):
                warn(f"{tag}（{pid}）缺少数值型经纬度")
        if ptype == "video":
            v = p.get("video") or {}
            if v.get("platform") == "youtube" and not v.get("id"):
                warn(f"{tag}（{pid}）YouTube 缺少视频 ID")
            if v.get("platform") == "bilibili" and not v.get("bvid"):
                warn(f"{tag}（{pid}）B 站缺少 BV 号")

        # 安全：拒绝危险协议
        blob = json.dumps(p, ensure_ascii=False)
        if re.search(r"javascript\s*:|data\s*:\s*text/html|vbscript\s*:", blob, re.I):
            fail(f"{tag}（{pid}）包含不安全的 URL 协议")


def site_base_url(site: dict) -> str:
    if site.get("url"):
        return str(site["url"]).rstrip("/") + "/"
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    if "/" in repo:
        owner, name = repo.split("/", 1)
        if name.lower() == f"{owner.lower()}.github.io":
            return f"https://{owner}.github.io/"
        return f"https://{owner}.github.io/{name}/"
    cfg = site.get("repo") or {}
    owner = cfg.get("owner") or "your-name"
    name = cfg.get("name") or "microblog"
    if name.lower() == f"{owner.lower()}.github.io":
        return f"https://{owner}.github.io/"
    return f"https://{owner}.github.io/{name}/"


def build_feed(site: dict, posts: list, base: str) -> str:
    rss = ET.Element("rss", {"version": "2.0"})
    ch = ET.SubElement(rss, "channel")
    ET.SubElement(ch, "title").text = site.get("title") or "微博客"
    ET.SubElement(ch, "link").text = base
    ET.SubElement(ch, "description").text = site.get("description") or site.get("subtitle") or ""
    ET.SubElement(ch, "language").text = "zh-CN"
    ET.SubElement(ch, "generator").text = "GitHub Pages Microblog"

    ordered = sorted(
        posts,
        key=lambda p: parse_time(p.get("created_at", "")) or datetime.min.replace(tzinfo=timezone.utc),
        reverse=True,
    )
    for p in ordered[:30]:
        item = ET.SubElement(ch, "item")
        label = p.get("title") or strip_markdown(p.get("content", ""), 40) or p.get("type", "内容")
        ET.SubElement(item, "title").text = label
        link = f"{base}#post-{p.get('id', '')}"
        ET.SubElement(item, "link").text = link
        ET.SubElement(item, "guid", {"isPermaLink": "false"}).text = link
        dt = parse_time(p.get("created_at", "")) or datetime.now(timezone.utc)
        ET.SubElement(item, "pubDate").text = format_datetime(dt)
        ET.SubElement(item, "description").text = strip_markdown(p.get("content", ""))
        for t in (p.get("tags") or []):
            ET.SubElement(item, "category").text = str(t)
    ET.indent(rss, space="  ")
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(rss, encoding="unicode") + "\n"


def build_site() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    for name in STATIC_FILES:
        src = ROOT / name
        if src.exists():
            shutil.copy2(src, OUT / name)
    for d in STATIC_DIRS:
        src = ROOT / d
        if src.exists():
            shutil.copytree(src, OUT / d, ignore=shutil.ignore_patterns(".DS_Store", "__pycache__", "*.pyc"))
    feed = ROOT / "feed.xml"
    if feed.exists():
        shutil.copy2(feed, OUT / "feed.xml")


def main() -> int:
    site = load_json(ROOT / "data" / "site.json") or {}
    posts = load_json(ROOT / "data" / "posts.json") or []
    validate(site, posts)

    for w in warnings:
        print(f"[WARN] {w}")
    if errors:
        for e in errors:
            print(f"[ERROR] {e}", file=sys.stderr)
        print(f"\n数据校验失败，共 {len(errors)} 个错误，已停止构建。", file=sys.stderr)
        return 1

    base = site_base_url(site)
    (ROOT / "feed.xml").write_text(build_feed(site, posts, base), encoding="utf-8")
    build_site()
    print(f"校验通过：{len(posts)} 条内容 · {len(warnings)} 条提示")
    print(f"站点地址：{base}")
    print(f"RSS：feed.xml · 产物目录：_site/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
