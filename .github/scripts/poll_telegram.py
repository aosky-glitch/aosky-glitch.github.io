#!/usr/bin/env python3
"""Telegram 机器人「零后端」入口：定时轮询 getUpdates 并把消息发布到微博客。

不需要服务器、不需要公网 IP、不需要 Cloudflare Worker。
由 .github/workflows/telegram.yml 每 5 分钟跑一次；消息原文透传给
append_post.append_posts()，命令语法与安全清洗全部在仓库侧统一处理。

环境变量（在仓库 Settings → Secrets 中配置）：
  TELEGRAM_BOT_TOKEN       必填，@BotFather 给的 token
  TELEGRAM_ALLOWED_CHATS   必填，允许发布的 chat_id，逗号分隔（也可用 ..._USERS 按 user_id）
  TELEGRAM_ALLOWED_USERS   可选，允许发布的 user_id，逗号分隔
  BOT_REPLY                可选，默认 1；是否向 Telegram 回一条确认消息
  BOT_STATE                可选，状态文件路径，默认 .github/bot-state.json

本地调试：
  TELEGRAM_BOT_TOKEN=xxx TELEGRAM_ALLOWED_CHATS=123 python3 .github/scripts/poll_telegram.py
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import append_post  # noqa: E402
import bot_text  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
STATE_PATH = ROOT / os.environ.get("BOT_STATE", ".github/bot-state.json")
MAX_PER_RUN = 20
MAX_SEEN = 200


def api(token: str, method: str, payload: dict) -> dict:
    """调用 Telegram Bot API（仅标准库）。"""
    import urllib.error
    import urllib.request

    url = f"https://api.telegram.org/bot{token}/{method}"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:400]
        return {"ok": False, "description": f"HTTP {e.code}: {body}"}
    except Exception as e:  # 网络异常不让整个工作流崩掉
        return {"ok": False, "description": f"{type(e).__name__}: {e}"}


def reply(token: str, chat_id, text: str, enabled: bool) -> None:
    if not enabled:
        return
    r = api(token, "sendMessage", {
        "chat_id": chat_id,
        "text": text[:4000],
        "disable_web_page_preview": True,
    })
    if not r.get("ok"):
        print(f"  ! 回复失败：{r.get('description')}")


def load_state() -> dict:
    if STATE_PATH.exists():
        try:
            s = json.loads(STATE_PATH.read_text(encoding="utf-8"))
            if isinstance(s, dict):
                return {
                    "telegram_offset": int(s.get("telegram_offset") or 0),
                    "seen_ids": [str(x) for x in (s.get("seen_ids") or [])][-MAX_SEEN:],
                }
        except (json.JSONDecodeError, ValueError, OSError):
            pass
    return {"telegram_offset": 0, "seen_ids": []}


def save_state(state: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(
        json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def csv_env(name: str) -> set[str]:
    return {x.strip() for x in os.environ.get(name, "").split(",") if x.strip()}


def main() -> int:
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    allowed_chats = csv_env("TELEGRAM_ALLOWED_CHATS")
    allowed_users = csv_env("TELEGRAM_ALLOWED_USERS")
    if not token:
        print("未配置 TELEGRAM_BOT_TOKEN，跳过本次轮询（不是错误）。")
        return 0
    if not allowed_chats and not allowed_users:
        print("未配置 TELEGRAM_ALLOWED_CHATS / TELEGRAM_ALLOWED_USERS，为安全起见拒绝发布。")
        return 0

    do_reply = os.environ.get("BOT_REPLY", "1") not in ("0", "false", "no", "")
    state = load_state()
    first_run = not STATE_PATH.exists()

    res = api(token, "getUpdates", {
        "offset": state["telegram_offset"],
        "limit": MAX_PER_RUN,
        "timeout": 0,
        "allowed_updates": ["message"],
    })
    if not res.get("ok"):
        desc = str(res.get("description", ""))
        print(f"getUpdates 失败：{desc}")
        if "webhook" in desc.lower() or "conflict" in desc.lower():
            print("提示：getUpdates 与 webhook 互斥。若已配置 webhook，请先调用 deleteWebhook，")
            print("      或改用 bots/worker.js 的实时方案（见 BOTS.md）。")
        return 1

    updates = res.get("result") or []
    if not updates:
        print("无新消息。")
        return 0

    updates.sort(key=lambda u: int(u.get("update_id", 0)))
    last_update_id = int(updates[-1].get("update_id", 0))

    # 首次运行只同步游标，绝不把 Bot 创建以来的历史消息一次性发出去。
    if first_run:
        state["telegram_offset"] = last_update_id + 1
        save_state(state)
        print(f"首次运行：已跳过 {len(updates)} 条历史消息，游标设为 {last_update_id + 1}。")
        return 0

    seen = set(state["seen_ids"])
    raws, metas = [], []
    for u in updates:
        msg = u.get("message") or {}
        chat = msg.get("chat") or {}
        user = msg.get("from") or {}
        chat_id = str(chat.get("id", ""))
        user_id = str(user.get("id", ""))
        message_id = str(msg.get("message_id", ""))
        text = msg.get("text")

        # 所有见过的 message_id 都记入去重表（含白名单外 / help / 非文本消息），
        # 这样即使 offset 因故回退也不会重复处理同一条消息。
        if message_id and message_id in seen:
            print(f"  - 跳过已处理消息 {message_id}")
            continue
        if message_id:
            seen.add(message_id)

        allowed = (allowed_chats and chat_id in allowed_chats) or (allowed_users and user_id in allowed_users)
        if not allowed:
            print(f"  - 跳过白名单外的消息 chat={chat_id or '?'} user={user_id or '?'}")
            continue

        if not isinstance(text, str) or not text.strip():
            reply(token, chat.get("id"), "暂不支持图片/文件消息，请发送图片网址或文字内容。发送 /help 查看语法。", do_reply)
            continue

        if text.lstrip().startswith("/help") or text.lstrip().startswith("/start"):
            m = bot_text.CMD_RE.match(text.strip())
            if m and m.group(1).lower() in ("help", "start"):
                reply(token, chat.get("id"), bot_text.HELP, do_reply)
                print("  - 回复了帮助文本")
                continue

        raws.append({"bot_text": text})
        metas.append({"chat": chat.get("id"), "mid": message_id, "text": text[:50]})

    # 无论是否真的发布，都要推进 offset（白名单外、help、格式错误的消息
    # 不能永远留在队列里），并把 message_id 记入去重表。
    state["telegram_offset"] = last_update_id + 1
    state["seen_ids"] = list(seen)[-MAX_SEEN:]
    save_state(state)

    if not raws:
        print(f"本批 {len(updates)} 条消息无需发布，游标推进到 {last_update_id + 1}。")
        return 0

    results = append_post.append_posts(raws, strict=False)
    for meta, (status, value) in zip(metas, results):
        if status == "ok":
            reply(token, meta["chat"], f"✅ 已发布（{value['type']}）· {value['id']}\n约 30 秒后出现在站点。", do_reply)
        else:
            reply(token, meta["chat"], f"⚠️ 未发布：{value}", do_reply)
    added = sum(1 for s, _ in results if s == "ok")
    print(f"本批 {len(raws)} 条：成功 {added} 条，跳过 {len(raws) - added} 条；游标 {last_update_id + 1}。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
