/* ============================================================
   内容渲染器：把一条 post 数据渲染成卡片 HTML
   所有动态内容均经转义 / 白名单校验后再拼接
   ============================================================ */
import {
  icon, escapeHtml, escapeAttr, safeUrl, safeMediaUrl, safeId,
  markdown, relativeTime, formatFull, dateParts, domainOf, letterFavicon,
} from './utils.js';

export const TYPE_META = {
  text:     { label: '文字', icon: 'text' },
  image:    { label: '图文', icon: 'image' },
  gallery:  { label: '相册', icon: 'gallery' },
  article:  { label: '文章', icon: 'article' },
  link:     { label: '链接', icon: 'link' },
  location: { label: '位置', icon: 'pin' },
  video:    { label: '视频', icon: 'video' },
  music:    { label: '音乐', icon: 'music' },
};

const DEFAULT_VIDEO_COVER = ''; // 为空时由 CSS 渐变兜底

function imagesHtml(images, { gallery = false, group = '' } = {}) {
  const list = (Array.isArray(images) ? images : []).filter((x) => x && (x.src || x.url));
  if (!list.length) return '';
  const cls = gallery
    ? `media-gallery g-count-${list.length}${list.length % 2 === 1 && list.length > 1 ? ' g-odd' : ''}`
    : 'media-images';
  const buttons = list.map((im, i) => {
    const src = safeMediaUrl(im.src || im.url);
    if (!src) return '';
    const cap = escapeHtml(im.caption || im.alt || '');
    return `<button class="media-image${gallery ? '' : ' single'}" type="button" data-action="lightbox" data-lb-group="${escapeAttr(group)}" data-lb-src="${escapeAttr(src)}" data-lb-caption="${cap}" aria-label="查看图片：${cap}">
      <img src="${escapeAttr(src)}" alt="${escapeHtml(im.alt || im.caption || '')}" loading="lazy">
      ${cap ? `<span class="image-caption">${cap}</span>` : ''}
    </button>`;
  }).join('');
  return `<div class="${cls}">${buttons}</div>`;
}

/* ---------- 文章 ---------- */
function renderArticle(post) {
  const cover = safeMediaUrl(post.cover);
  const coverHtml = cover
    ? `<img class="article-cover" src="${escapeAttr(cover)}" alt="${escapeHtml(post.title || '')}" loading="lazy">`
    : '';
  return `<div class="article-wrap">
    ${coverHtml}
    ${post.title ? `<h2 class="card-title">${escapeHtml(post.title)}</h2>` : ''}
    <div class="article-meta">${icon('clock', 14)} ${escapeHtml(post.reading_time || '长文章')} · 点击展开全文</div>
    <div class="card-text md">${markdown(post.content)}</div>
    <button class="expand-btn" type="button" data-action="expand">${icon('chevronDown', 15)} 阅读全文</button>
  </div>`;
}

/* ---------- 链接 ---------- */
function renderLink(post) {
  const l = post.link || {};
  const url = safeUrl(l.url || post.url);
  const domain = l.site || domainOf(url);
  const favicon = safeMediaUrl(l.favicon) || letterFavicon(domain);
  const thumb = safeMediaUrl(l.image);
  return `<a class="link-card" href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">
    <div class="link-main">
      <div class="link-site"><img class="site-favicon" src="${escapeAttr(favicon)}" alt="" loading="lazy"><span>${escapeHtml(domain)}</span></div>
      <div class="link-title">${escapeHtml(l.title || post.title || domain)}</div>
      ${l.description ? `<div class="link-desc">${escapeHtml(l.description)}</div>` : ''}
      <div class="link-url">${icon('external', 13)} 打开链接</div>
    </div>
    ${thumb ? `<div class="link-thumb"><img src="${escapeAttr(thumb)}" alt="" loading="lazy"></div>` : ''}
  </a>`;
}

/* ---------- 位置 ---------- */
function renderLocation(post) {
  const loc = post.location || {};
  const lat = Number(loc.lat), lng = Number(loc.lng);
  const valid = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  const zoom = Math.min(18, Math.max(1, Number(loc.zoom) || 14));
  const delta = 0.02 / Math.pow(2, zoom - 14);
  const bbox = valid ? [lng - delta, lat - delta / 2, lng + delta, lat + delta / 2].map((n) => n.toFixed(6)).join('%2C') : '';
  const osm = valid
    ? `https://www.openstreetmap.org/?mlat=${lat.toFixed(6)}&mlon=${lng.toFixed(6)}#map=${zoom}/${lat.toFixed(6)}/${lng.toFixed(6)}`
    : 'https://www.openstreetmap.org/';
  const embed = valid
    ? `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat.toFixed(6)}%2C${lng.toFixed(6)}`
    : '';
  return `<div class="location-card">
    <div class="map-frame" ${valid ? `data-map-src="${escapeAttr(embed)}"` : ''}>
      ${valid
        ? `<button class="map-placeholder" type="button" data-action="load-map" aria-label="加载 ${escapeHtml(loc.name || '地图')} 的地图">
            <span class="map-pin-big"></span>
            <span class="map-hint">点击加载地图</span>
          </button>`
        : `<div class="map-placeholder"><span class="map-hint">未设置坐标</span></div>`}
    </div>
    <div class="location-info">
      <span class="loc-icon">${icon('pin', 19)}</span>
      <div>
        <div class="location-name">${escapeHtml(loc.name || '未知位置')}</div>
        ${loc.address ? `<div class="location-addr">${escapeHtml(loc.address)}</div>` : ''}
        ${loc.note ? `<div class="location-note">${escapeHtml(loc.note)}</div>` : ''}
      </div>
      <a class="location-open" href="${escapeAttr(osm)}" target="_blank" rel="noopener noreferrer">${icon('external', 13)} 在地图中打开</a>
    </div>
  </div>`;
}

/* ---------- 视频 ---------- */
function renderVideo(post) {
  const v = post.video || {};
  const platform = v.platform === 'youtube' ? 'youtube' : 'bilibili';
  const id = safeId(v.id || v.bvid, platform === 'youtube' ? /^[A-Za-z0-9_-]{6,32}$/ : /^BV[0-9A-Za-z]{8,16}$/i);
  const page = Math.max(1, Math.min(999, parseInt(v.page, 10) || 1));
  const cover = safeMediaUrl(v.cover) || DEFAULT_VIDEO_COVER;
  const platformLabel = platform === 'youtube' ? 'YouTube' : '哔哩哔哩';
  const external = platform === 'youtube'
    ? `https://www.youtube.com/watch?v=${encodeURIComponent(v.id || '')}`
    : `https://www.bilibili.com/video/${encodeURIComponent(v.bvid || '')}/?p=${page}`;
  const iframe = platform === 'youtube'
    ? `https://www.youtube-nocookie.com/embed/${id}?rel=0&autoplay=1`
    : `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(v.bvid || '')}&page=${page}&high_quality=1&danmaku=0&autoplay=0`;

  return `<div class="video-frame" ${id ? `data-video-src="${escapeAttr(iframe)}"` : ''}>
    <button class="video-placeholder" type="button" data-action="load-video" aria-label="播放 ${escapeHtml(v.title || '视频')}">
      ${cover ? `<img src="${escapeAttr(cover)}" alt="" loading="lazy">` : ''}
      <span class="video-shade"></span>
      <span class="video-label">${icon('video', 14)} ${platformLabel}</span>
      <span class="video-play">${icon('play', 26)}</span>
      <span class="video-caption">
        <span class="video-title">${escapeHtml(v.title || platformLabel + ' 视频')}</span>
        ${v.duration ? `<span class="video-duration">${escapeHtml(v.duration)}</span>` : ''}
      </span>
    </button>
  </div>
  <div class="video-meta">
    <span>${icon('info', 13)} ${escapeHtml(v.caption || '点击封面加载播放器')}</span>
    ${id ? `<a href="${escapeAttr(external)}" target="_blank" rel="noopener noreferrer">${icon('external', 13)} 在 ${platformLabel} 打开</a>` : ''}
  </div>`;
}

/* ---------- 音乐 ---------- */
function renderMusic(post) {
  const m = post.music || {};
  const kind = m.kind === 'playlist' ? 'playlist' : 'single';
  const kindLabel = kind === 'playlist' ? '歌单 / PLAYLIST' : '单曲 / SINGLE';
  const platform = ['netease', 'spotify', 'custom'].includes(m.platform) ? m.platform : 'custom';
  const platformLabel = { netease: '网易云音乐', spotify: 'Spotify', custom: '仓库自带音频' }[platform];
  const cover = safeMediaUrl(m.cover);
  const head = `<div class="music-head">
    ${cover ? `<img class="music-cover" src="${escapeAttr(cover)}" alt="" loading="lazy">` : ''}
    <div class="music-info">
      <div class="music-kind">${kindLabel}</div>
      <div class="music-title">${escapeHtml(m.title || post.title || '未命名音乐')}</div>
      <div class="music-artist">${escapeHtml(m.artist || '')}</div>
    </div>
    <span class="music-platform">${escapeHtml(platformLabel)}</span>
  </div>`;

  let body = '';
  if (platform === 'netease' || platform === 'spotify') {
    const id = safeId(m.id, /^[A-Za-z0-9]{1,64}$/);
    if (id) {
      let src = '';
      let heightClass = '';
      if (platform === 'netease') {
        src = kind === 'playlist'
          ? `https://music.163.com/outchain/player?type=0&id=${id}&auto=0&height=430`
          : `https://music.163.com/outchain/player?type=2&id=${id}&auto=0&height=66`;
        heightClass = kind === 'playlist' ? 'is-playlist' : '';
      } else {
        src = `https://open.spotify.com/embed/${kind === 'playlist' ? 'playlist' : 'track'}/${id}`;
        heightClass = kind === 'playlist' ? 'is-playlist' : '';
      }
      body = `<div class="music-embed"><iframe class="${heightClass}" src="${escapeAttr(src)}" frameborder="0" loading="lazy" referrerpolicy="no-referrer" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" title="${escapeHtml(m.title || '音乐播放器')}"></iframe></div>`;
    } else {
      body = `<div class="music-note">未填写有效的音乐 ID，暂时无法加载播放器。</div>`;
    }
  } else {
    const tracks = (Array.isArray(m.tracks) ? m.tracks : []).map((t, i) => {
      const src = safeMediaUrl(t.src || t.url);
      return `<li class="track-item" data-action="play-track" data-track-src="${escapeAttr(src)}" data-track-index="${i}" role="button" tabindex="0">
        <span class="track-num">${String(i + 1).padStart(2, '0')}</span>
        <span class="track-name">${escapeHtml(t.title || `曲目 ${i + 1}`)}</span>
        <span class="track-artist">${escapeHtml(t.artist || '')}</span>
        <span class="track-state">${icon('play', 13)}</span>
      </li>`;
    }).join('');
    const anySrc = (Array.isArray(m.tracks) ? m.tracks : []).some((t) => safeMediaUrl(t.src || t.url));
    body = `<div class="audio-player" data-audio-player>
      ${tracks ? `<ul class="track-list">${tracks}</ul>` : ''}
      <audio controls preload="none" data-audio-el></audio>
      ${!anySrc ? `<div class="audio-empty">提示：把音频文件放进仓库的 media/ 目录，并在后台填写音轨地址即可播放。</div>` : ''}
    </div>`;
  }

  const note = m.note ? `<div class="music-note">${escapeHtml(m.note)}</div>` : '';
  return `<div class="music-card">${head}${body}${note}</div>`;
}

/* ---------- 媒体区总入口 ---------- */
export function renderMedia(post) {
  switch (post.type) {
    case 'image':   return imagesHtml(post.images, { group: `${post.id}-img` });
    case 'gallery': return imagesHtml(post.images, { gallery: true, group: `${post.id}-gal` });
    case 'article': return renderArticle(post);
    case 'link':    return renderLink(post);
    case 'location':return renderLocation(post);
    case 'video':   return renderVideo(post);
    case 'music':   return renderMusic(post);
    default:        return '';
  }
}

/* ---------- 卡片 ---------- */
export function renderCard(post) {
  const meta = TYPE_META[post.type] || TYPE_META.text;
  const type = TYPE_META[post.type] ? post.type : 'text';
  const tags = (Array.isArray(post.tags) ? post.tags : [])
    .map((t) => `<a class="tag" href="#tag-${encodeURIComponent(String(t).replace(/^#/, ''))}" data-action="tag">#${escapeHtml(String(t).replace(/^#/, ''))}</a>`)
    .join('');
  const showText = type !== 'article' && post.content;
  const media = renderMedia(post);
  const iso = escapeAttr(post.created_at || '');

  return `<article class="post-card type-${type}" data-id="${escapeAttr(post.id || '')}">
    <div class="card-meta">
      <span class="type-chip">${icon(meta.icon, 14)} ${meta.label}</span>
      <time class="card-time" datetime="${iso}" title="${escapeAttr(formatFull(post.created_at))}">${relativeTime(post.created_at)}</time>
      ${post.pinned ? `<span class="pinned-badge">${icon('bookmark', 13)} 置顶</span>` : ''}
      <span class="spacer"></span>
      <button class="card-copy" type="button" data-action="copy" data-id="${escapeAttr(post.id || '')}" title="复制本条链接" aria-label="复制本条链接">${icon('copy', 15)}</button>
    </div>
    <div class="card-body">
      ${post.title && type !== 'article' ? `<h2 class="card-title">${escapeHtml(post.title)}</h2>` : ''}
      ${showText ? `<div class="card-text md">${markdown(post.content)}</div>` : ''}
      ${media ? `<div class="card-media">${media}</div>` : ''}
    </div>
    <div class="card-footer">
      <div class="tag-list">${tags}</div>
      <span class="card-source">${icon('file', 13)} data/posts.json</span>
    </div>
  </article>`;
}

export function renderFeedItem(post) {
  const p = dateParts(post.created_at);
  return `<div class="feed-item${post.pinned ? ' is-pinned' : ''}" id="post-${escapeAttr(post.id || '')}">
    <div class="feed-date"><span class="day">${p.month}.${p.day}</span><span class="year">${p.year}</span></div>
    ${renderCard(post)}
  </div>`;
}
