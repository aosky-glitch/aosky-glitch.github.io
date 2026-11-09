/**
 * 微博客机器人中转（Cloudflare Workers）
 * ------------------------------------------------------------------
 * Telegram webhook  +  飞书事件订阅 → 统一转发成 GitHub repository_dispatch
 * → .github/workflows/shortcut.yml → append_post.py → 写入 data/posts.json
 *
 * 本 Worker **不解析消息语法**：只把原文作为 bot_text 透传，
 * 命令解析、URL 识别、XSS 清洗、字段白名单全部由仓库里的 Python 脚本负责。
 * 因此 Telegram / 飞书 / 以后任何能发 HTTP 回调的平台都共用同一套规则。
 *
 * 需要的环境变量（用 `wrangler secret put NAME` 设置，见 BOTS.md 方案 B）：
 *   GH_TOKEN             必填  GitHub Fine-grained PAT，Contents: Read and Write
 *   GH_REPO              可选  默认 aosky-glitch/aosky-glitch.github.io
 *   TG_SECRET            必填(用 Telegram 时)  setWebhook 的 secret_token
 *   TG_ALLOWED           必填(用 Telegram 时)  允许发布的 chat_id，逗号分隔
 *   TG_BOT_TOKEN         可选  用于回复 /help
 *   FEISHU_VERIFY_TOKEN  可选(用飞书时)  Verification Token
 *   FEISHU_ENCRYPT_KEY   可选(用飞书时)  Encrypt Key，配了就启用验签 + AES 解密
 *   FEISHU_ALLOWED       可选  允许发布的 open_id / chat_id，逗号分隔
 */

const DEFAULT_REPO = 'aosky-glitch/aosky-glitch.github.io';
const MAX_TEXT = 20000;

const HELP = `📝 直接发文字即可（支持 Markdown），或在开头加命令：

/post 正文              文字（默认）
/article 标题 | 正文    长文章
/link 网址 说明         链接卡片
/video 网址 说明        B 站 / YouTube 视频
/music 网址 说明        网易云 / Spotify
/photo 网址 说明        单图
/gallery 网址1,网址2    相册
/location 名称 | 纬度 | 经度 | 备注   位置
/help                  显示本帮助

正文末尾写 #标签 可加标签。完整说明见仓库 BOTS.md。`;

const enc = new TextEncoder();
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

const csv = (s) => new Set(String(s || '').split(',').map((x) => x.trim()).filter(Boolean));
const isHelp = (t) => /^\s*\/(help|start)(?:@[\w]+)?(?:\s|$)/i.test(t);

function b64ToBytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256Hex(prefix, bodyBytes) {
  const buf = new Uint8Array(prefix.length + bodyBytes.length);
  buf.set(prefix, 0);
  buf.set(bodyBytes, prefix.length);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 飞书 Encrypt Key 模式：body = {"encrypt": base64(iv + ciphertext)} */
async function decryptFeishu(encryptKey, encrypted) {
  const keyHash = await crypto.subtle.digest('SHA-256', enc.encode(encryptKey));
  const key = await crypto.subtle.importKey('raw', keyHash, { name: 'AES-CBC' }, false, ['decrypt']);
  const raw = b64ToBytes(encrypted);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv: raw.slice(0, 16) },
    key,
    raw.slice(16),
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

/** 把一条消息转发给 GitHub，复用已有的 shortcut.yml 写入链路。 */
async function dispatch(env, text, source) {
  const body = {
    event_type: 'microblog-post',
    client_payload: { post: { bot_text: text.slice(0, MAX_TEXT) } },
  };
  const res = await fetch(`https://api.github.com/repos/${env.GH_REPO || DEFAULT_REPO}/dispatches`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GH_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'microblog-bot-worker',
    },
    body: JSON.stringify(body),
  });
  if (res.status !== 204) {
    console.error(`[${source}] dispatch 失败：HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  } else {
    console.log(`[${source}] dispatch 成功，${text.length} 字符`);
  }
  return res.status === 204;
}

async function tgReply(env, chatId, text) {
  if (!env.TG_BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true }),
    });
  } catch (e) {
    console.error('[telegram] 回复失败', String(e));
  }
}

async function handleTelegram(request, env, ctx) {
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (!env.TG_SECRET || secret !== env.TG_SECRET) {
    return json({ error: 'bad secret token' }, 401);
  }
  const allowed = csv(env.TG_ALLOWED);
  if (!allowed.size) return json({ error: 'TG_ALLOWED 未配置，拒绝发布' }, 403);

  let update;
  try {
    update = await request.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  const msg = update.message || update.channel_post;
  // 先回 200，避免 Telegram 因超时重试造成重复发布。
  ctx.waitUntil(
    (async () => {
      if (!msg) return;
      const chatId = String(msg.chat?.id ?? '');
      if (!allowed.has(chatId)) {
        console.log(`[telegram] 白名单外 chat=${chatId}`);
        return;
      }
      const text = typeof msg.text === 'string' ? msg.text.trim() : '';
      if (!text) {
        await tgReply(env, msg.chat?.id, '暂不支持图片/文件消息，请发送图片网址或文字。发送 /help 查看语法。');
        return;
      }
      if (isHelp(text)) {
        await tgReply(env, msg.chat?.id, HELP);
        return;
      }
      await dispatch(env, text, 'telegram');
    })(),
  );
  return json({ ok: true });
}

async function handleFeishu(request, env, ctx) {
  const rawText = await request.text();
  let body;
  try {
    body = JSON.parse(rawText);
  } catch {
    return json({ error: 'invalid json' }, 400);
  }

  // 1) URL 验证：保存回调地址时飞书会发 challenge，必须原样返回（1 秒内）。
  if (body.type === 'url_verification' || body.encrypt) {
    let payload = body;
    if (body.encrypt) {
      if (!env.FEISHU_ENCRYPT_KEY) return json({ error: '缺少 FEISHU_ENCRYPT_KEY' }, 400);
      try {
        payload = await decryptFeishu(env.FEISHU_ENCRYPT_KEY, body.encrypt);
      } catch (e) {
        console.error('[feishu] 解密失败', String(e));
        return json({ error: 'decrypt failed' }, 400);
      }
    }
    if (payload.type === 'url_verification') {
      return json({ challenge: payload.challenge });
    }
    body = payload;
  }

  const header = body.header || {};
  const token = header.token || body.token || '';

  // 2) 安全校验：配了 Encrypt Key 走签名校验，否则用 Verification Token 兜底。
  if (env.FEISHU_ENCRYPT_KEY) {
    const ts = request.headers.get('X-Lark-Request-Timestamp') || '';
    const nonce = request.headers.get('X-Lark-Request-Nonce') || '';
    const sig = request.headers.get('X-Lark-Signature') || '';
    const expect = await sha256Hex(enc.encode(ts + nonce + env.FEISHU_ENCRYPT_KEY), enc.encode(rawText));
    // 时间戳可能是秒或毫秒，两种都兼容；超过 5 分钟视为重放。
    const t = Number(ts || 0);
    const tsSec = t > 1e11 ? t / 1000 : t;
    const fresh = Math.abs(Date.now() / 1000 - tsSec) < 300;
    if (!fresh || sig !== expect) {
      return json({ error: 'bad signature' }, 401);
    }
  } else if (env.FEISHU_VERIFY_TOKEN && token !== env.FEISHU_VERIFY_TOKEN) {
    return json({ error: 'bad verification token' }, 401);
  } else if (!env.FEISHU_VERIFY_TOKEN) {
    return json({ error: '未配置飞书校验凭据，拒绝发布' }, 403);
  }

  // 3) 只处理「接收消息」事件，其余（如 bot 被拉进群）直接确认。
  if ((header.event_type || body.event?.type || '') !== 'im.message.receive_v1') {
    return json({ ok: true, skipped: header.event_type || 'unknown' });
  }

  const ev = body.event || {};
  const msg = ev.message || {};
  const senderId = ev.sender?.sender_id?.open_id || '';
  const chatId = msg.chat_id || '';
  const allowed = csv(env.FEISHU_ALLOWED);
  const eventId = header.event_id || '';

  ctx.waitUntil(
    (async () => {
      if (allowed.size && !allowed.has(senderId) && !allowed.has(chatId)) {
        console.log(`[feishu] 白名单外 sender=${senderId} chat=${chatId}`);
        return;
      }
      if (msg.message_type && msg.message_type !== 'text') {
        console.log(`[feishu] 跳过非文本消息 ${msg.message_type}`);
        return;
      }
      let text = '';
      try {
        text = JSON.parse(msg.content || '{}').text || '';
      } catch {
        text = String(msg.content || '');
      }
      // 群聊里 @机器人 会留下 @_user_1 之类的占位符
      text = text.replace(/@_user_\d+/g, '').replace(/^@\S+\s*/, '').trim();
      if (!text) return;
      // 飞书 HTTP 回调无法直接回复消息，/help 请查 BOTS.md（不发布）
      if (isHelp(text)) {
        console.log(`[feishu] 收到 /help，event=${eventId}，语法见 BOTS.md`);
        return;
      }
      await dispatch(env, text, 'feishu');
    })(),
  );
  return json({ ok: true });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET') {
      return json({
        service: 'microblog bot bridge',
        endpoints: ['POST /telegram', 'POST /feishu'],
        docs: '见仓库 BOTS.md',
      });
    }
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    if (!env.GH_TOKEN) return json({ error: 'GH_TOKEN 未配置' }, 500);
    if (url.pathname === '/telegram') return handleTelegram(request, env, ctx);
    if (url.pathname === '/feishu') return handleFeishu(request, env, ctx);
    return json({ error: 'not found' }, 404);
  },
};
