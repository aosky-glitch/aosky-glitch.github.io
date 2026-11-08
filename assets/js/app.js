/* ============================================================
   主站逻辑：加载仓库数据 → 渲染时间线 → 筛选 / 搜索 / 交互
   ============================================================ */
import { icon, escapeAttr, escapeHtml, safeMediaUrl, toast, debounce, nowISO } from './utils.js';
import { TYPE_META, renderFeedItem } from './renderers.js';

const $ = (sel) => document.querySelector(sel);
const state = {
  site: {},
  all: [],
  filtered: [],
  type: 'all',
  query: '',
  visible: 0,
  rendered: 0,
  pageSize: 8,
};

/* ---------- 主题 ---------- */
function hexToRgba(hex, alpha) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex || ''));
  if (!m) return `rgba(217, 86, 79, ${alpha})`;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
}

function currentTheme() {
  const saved = localStorage.getItem('mb-theme');
  const def = state.site.theme?.defaultMode || 'auto';
  const mode = saved || def;
  if (mode !== 'auto') return mode;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(mode) {
  document.documentElement.dataset.theme = mode;
  const btn = $('#themeToggle');
  btn.innerHTML = icon(mode === 'dark' ? 'sun' : 'moon', 18);
  btn.title = mode === 'dark' ? '切换到浅色' : '切换到深色';
}

function injectStaticIcons() {
  $('#searchIcon').innerHTML = icon('search', 16);
  $('#searchClear').innerHTML = icon('x', 14);
  $('#lbClose').innerHTML = icon('x', 20);
  $('#lbPrev').innerHTML = icon('chevronLeft', 20);
  $('#lbNext').innerHTML = icon('chevronRight', 20);
  $('#emptyState .empty-icon').innerHTML = icon('inbox', 24);
  $('#adminLink').innerHTML = `${icon('pen', 14)} 写点什么`;
}

function initTheme() {
  const accent = state.site.theme?.accent || '#d9564f';
  document.documentElement.style.setProperty('--accent', accent);
  document.documentElement.style.setProperty('--accent-soft', hexToRgba(accent, .12));
  applyTheme(currentTheme());
  $('#themeToggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('mb-theme', next);
    applyTheme(next);
  });
}

/* ---------- 顶部资料 ---------- */
function cssUrl(url) {
  const u = safeMediaUrl(url);
  if (!u || /["'()\\\n\r]/.test(u)) return '';
  return `url("${u}")`;
}

function renderHero() {
  const s = state.site;
  const a = s.author || {};
  document.title = `${s.title || '微博客'} · ${s.subtitle || ''}`.replace(/\s·\s$/, '').trim();
  $('#brandTitle').textContent = s.title || '微博客';

  const cover = cssUrl(s.cover);
  if (cover) $('#heroCover').style.backgroundImage = cover;

  const links = (Array.isArray(s.links) ? s.links : []).map((l) => {
    const raw = String(l.url || '').trim();
    const unsafeScheme = /^[a-z][a-z0-9+.\-]*:/i.test(raw) && !/^https?:\/\//i.test(raw);
    const href = !raw || unsafeScheme ? '#' : raw;
    return `<a href="${escapeAttr(href)}"${/^https?:\/\//i.test(href) ? ' target="_blank" rel="noopener noreferrer"' : ''}>${icon(l.icon || 'link', 14)} ${escapeHtml(l.label || '')}</a>`;
  }).join('');

  $('#heroProfile').innerHTML = `
    <img class="profile-avatar" src="${escapeAttr(safeMediaUrl(a.avatar) || 'media/avatar.svg')}" alt="${escapeHtml(a.name || '')} 的头像">
    <div class="profile-main">
      <h1 class="profile-name">${escapeHtml(a.name || '微博客')}${a.handle ? `<span class="profile-handle">${escapeHtml(a.handle)}</span>` : ''}</h1>
      <p class="profile-bio">${escapeHtml(a.bio || s.description || '')}</p>
      <div class="profile-sub">
        ${a.location ? `<span>${icon('pin', 14)} ${escapeHtml(a.location)}</span>` : ''}
        <span>${icon('inbox', 14)} <span id="heroCount">—</span> 条内容</span>
        <span>${icon('github', 14)} 数据存储于 GitHub 仓库</span>
      </div>
    </div>
    <div class="profile-links">${links}</div>`;
  $('#heroCount').textContent = state.all.length;
  $('#footerText').textContent = s.footer || '内容即数据 · 全部存放于 GitHub 仓库';
}

/* ---------- 筛选器 ---------- */
function renderFilters() {
  const counts = {};
  state.all.forEach((p) => { const t = TYPE_META[p.type] ? p.type : 'text'; counts[t] = (counts[t] || 0) + 1; });
  const items = [`<button class="filter-chip${state.type === 'all' ? ' active' : ''}" type="button" data-type="all">${icon('layers', 15)} 全部 <span class="count">${state.all.length}</span></button>`];
  Object.entries(TYPE_META).forEach(([key, meta]) => {
    if (!counts[key]) return;
    items.push(`<button class="filter-chip${state.type === key ? ' active' : ''}" type="button" data-type="${key}">${icon(meta.icon, 15)} ${meta.label} <span class="count">${counts[key]}</span></button>`);
  });
  $('#filters').innerHTML = items.join('');
}

/* ---------- 搜索 / 过滤 ---------- */
function haystack(p) {
  return [
    p.title, p.content, (p.tags || []).join(' '),
    p.link?.title, p.link?.description, p.link?.site,
    p.video?.title, p.music?.title, p.music?.artist,
    p.location?.name, p.location?.address,
  ].filter(Boolean).join(' ').toLowerCase();
}

function applyFilter() {
  const q = state.query.trim().toLowerCase().replace(/^#/, '');
  state.filtered = state.all.filter((p) => {
    if (state.type !== 'all' && (TYPE_META[p.type] ? p.type : 'text') !== state.type) return false;
    if (q && !haystack(p).includes(q)) return false;
    return true;
  });
  state.visible = Math.min(state.pageSize, state.filtered.length);
  renderFeed(true);
}

function renderFeed(reset = false) {
  const feed = $('#feed');
  if (reset) {
    feed.innerHTML = '';
    state.rendered = 0;
  }
  const slice = state.filtered.slice(state.rendered, state.visible);
  if (slice.length) {
    feed.insertAdjacentHTML('beforeend', slice.map(renderFeedItem).join(''));
    state.rendered = state.visible;
  }
  const hasMore = state.visible < state.filtered.length;
  $('#loadMoreWrap').hidden = !hasMore;
  $('#loadMoreBtn').innerHTML = `${icon('chevronDown', 15)} 加载更多（还有 ${state.filtered.length - state.visible} 条）`;

  const isEmpty = state.filtered.length === 0;
  $('#emptyState').hidden = !isEmpty;
  $('#feed').hidden = isEmpty;
  if (isEmpty) {
    $('#emptyHint').textContent = state.query
      ? `没有找到与「${state.query}」相关的内容，换个关键词试试。`
      : '当前类型下还没有内容，换个筛选条件试试。';
  }
  $('#feedSummary').textContent = state.query
    ? `找到 ${state.filtered.length} 条与「${state.query}」相关的内容`
    : `共 ${state.filtered.length} 条内容 · 已显示 ${state.visible} 条`;
}

/* ---------- 灯箱 ---------- */
const lb = { list: [], index: 0 };

function openLightbox(group, clickedSrc) {
  const all = [...document.querySelectorAll('#feed [data-action="lightbox"]')]
    .filter((el) => el.dataset.lbGroup === group)
    .map((el) => ({ src: el.dataset.lbSrc, caption: el.dataset.lbCaption || '' }));
  if (!all.length) return;
  lb.list = all;
  lb.index = Math.max(0, all.findIndex((x) => x.src === clickedSrc));
  $('#lightbox').hidden = false;
  document.body.classList.add('lb-open');
  updateLightbox();
}

function updateLightbox() {
  const item = lb.list[lb.index];
  if (!item) return;
  $('#lbImage').src = item.src;
  $('#lbImage').alt = item.caption;
  $('#lbCaption').textContent = item.caption;
  $('#lbCounter').textContent = `${lb.index + 1} / ${lb.list.length}`;
  const single = lb.list.length < 2;
  $('#lbPrev').hidden = single;
  $('#lbNext').hidden = single;
}

function closeLightbox() {
  $('#lightbox').hidden = true;
  document.body.classList.remove('lb-open');
  $('#lbImage').src = '';
}

function stepLightbox(delta) {
  if (!lb.list.length) return;
  lb.index = (lb.index + delta + lb.list.length) % lb.list.length;
  updateLightbox();
}

/* ---------- 复制 ---------- */
function copyText(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  }
  return fallbackCopy(text);
}
function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;left:-9999px;top:0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch { /* ignore */ }
  ta.remove();
}

/* ---------- 事件委托 ---------- */
function bindEvents() {
  $('#filters').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-type]');
    if (!btn) return;
    state.type = btn.dataset.type;
    renderFilters();
    applyFilter();
  });

  $('#searchInput').addEventListener('input', debounce((e) => {
    state.query = e.target.value;
    $('#searchClear').hidden = !state.query;
    applyFilter();
  }, 200));

  $('#searchClear').addEventListener('click', () => {
    $('#searchInput').value = '';
    state.query = '';
    $('#searchClear').hidden = true;
    applyFilter();
    $('#searchInput').focus();
  });

  $('#resetFilters').addEventListener('click', () => {
    state.type = 'all';
    state.query = '';
    $('#searchInput').value = '';
    $('#searchClear').hidden = true;
    history.replaceState(null, '', location.pathname + location.search);
    renderFilters();
    applyFilter();
  });

  $('#loadMoreBtn').addEventListener('click', () => {
    state.visible = Math.min(state.visible + state.pageSize, state.filtered.length);
    renderFeed(false);
  });

  // 卡片内所有交互
  $('#feed').addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;

    if (action === 'expand') {
      const wrap = target.closest('.article-wrap');
      const expanded = wrap.classList.toggle('expanded');
      target.classList.toggle('expanded', expanded);
      target.innerHTML = expanded
        ? `${icon('chevronDown', 15)} 收起全文` : `${icon('chevronDown', 15)} 阅读全文`;
      return;
    }

    if (action === 'load-map') {
      const frame = target.closest('.map-frame');
      const src = frame?.dataset.mapSrc;
      if (!src) return;
      frame.innerHTML = `<iframe src="${escapeAttr(src)}" loading="lazy" referrerpolicy="no-referrer" title="位置地图"></iframe>`;
      return;
    }

    if (action === 'load-video') {
      const frame = target.closest('.video-frame');
      const src = frame?.dataset.videoSrc;
      if (!src) { toast('视频 ID 无效，请使用「在平台打开」链接'); return; }
      frame.innerHTML = `<iframe src="${escapeAttr(src)}" loading="lazy" referrerpolicy="no-referrer" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowfullscreen title="视频播放器"></iframe>`;
      return;
    }

    if (action === 'lightbox') {
      openLightbox(target.dataset.lbGroup, target.dataset.lbSrc);
      return;
    }

    if (action === 'play-track') {
      const player = target.closest('[data-audio-player]');
      const audio = player?.querySelector('[data-audio-el]');
      const src = target.dataset.trackSrc;
      if (!audio) return;
      if (!src) { toast('这条音轨还没有填写音频地址'); return; }
      player.querySelectorAll('.track-item').forEach((li) => li.classList.remove('active'));
      target.classList.add('active');
      audio.src = src;
      audio.play().catch(() => toast('浏览器阻止了自动播放，请点击播放按钮'));
      return;
    }

    if (action === 'copy') {
      const url = `${location.href.split('#')[0]}#post-${encodeURIComponent(target.dataset.id)}`;
      copyText(url);
      toast('本条链接已复制');
      return;
    }

    if (action === 'tag') {
      e.preventDefault();
      const tag = decodeURIComponent((target.getAttribute('href') || '').replace('#tag-', ''));
      state.query = tag;
      state.type = 'all';
      $('#searchInput').value = tag;
      $('#searchClear').hidden = false;
      renderFilters();
      applyFilter();
      window.scrollTo({ top: $('#main').offsetTop - 20, behavior: 'smooth' });
    }
  });

  // 键盘可达：音轨回车
  $('#feed').addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-action="play-track"]')) {
      e.preventDefault();
      e.target.click();
    }
  });

  // 灯箱
  $('#lbClose').addEventListener('click', closeLightbox);
  $('#lbPrev').addEventListener('click', () => stepLightbox(-1));
  $('#lbNext').addEventListener('click', () => stepLightbox(1));
  $('#lightbox').addEventListener('click', (e) => {
    if (e.target.id === 'lightbox') closeLightbox();
  });
  document.addEventListener('keydown', (e) => {
    if ($('#lightbox').hidden) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft') stepLightbox(-1);
    if (e.key === 'ArrowRight') stepLightbox(1);
  });

  window.addEventListener('hashchange', handleHash);
}

function handleHash() {
  const hash = decodeURIComponent(location.hash || '');
  if (hash.startsWith('#tag-')) {
    const tag = hash.slice(5);
    if (state.query === tag && state.type === 'all') return; // 幂等，避免重复渲染
    state.query = tag;
    state.type = 'all';
    $('#searchInput').value = tag;
    $('#searchClear').hidden = false;
    renderFilters();
    applyFilter();
    window.scrollTo({ top: $('#main').offsetTop - 20, behavior: 'smooth' });
    return;
  }
  if (hash.startsWith('#post-')) {
    const el = document.getElementById(hash.slice(1));
    if (el) setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), 120);
  }
}

/* ---------- 启动 ---------- */
async function boot() {
  injectStaticIcons();
  bindEvents();
  try {
    const bust = `?t=${Date.now()}`;
    const [siteRes, postsRes] = await Promise.all([
      fetch(`data/site.json${bust}`, { cache: 'no-store' }),
      fetch(`data/posts.json${bust}`, { cache: 'no-store' }),
    ]);
    if (!siteRes.ok || !postsRes.ok) throw new Error(`HTTP ${siteRes.status}/${postsRes.status}`);
    state.site = await siteRes.json();
    const posts = await postsRes.json();
    state.all = (Array.isArray(posts) ? posts : (posts.posts || []))
      .filter((p) => p && p.id && p.type)
      .map((p) => ({ ...p, created_at: p.created_at || nowISO() }))
      .sort((a, b) => (Number(!!b.pinned) - Number(!!a.pinned)) ||
        new Date(b.created_at) - new Date(a.created_at));
    state.pageSize = Math.max(1, Number(state.site.pageSize) || 8);
  } catch (err) {
    $('#loadingState').innerHTML = `<div style="text-align:center;max-width:520px">
      <h2 style="font-family:var(--font-serif);color:var(--text);margin:0 0 8px">数据读取失败</h2>
      <p>无法读取 <code>data/site.json</code> 与 <code>data/posts.json</code>（${escapeHtml(err.message)}）。</p>
      <p>请通过 GitHub Pages 或本地 HTTP 服务访问本页；直接双击 <code>index.html</code> 以 <code>file://</code> 打开会被浏览器的同源策略拦截。</p>
    </div>`;
    return;
  }

  initTheme();
  renderHero();
  renderFilters();
  applyFilter();
  handleHash();
}

boot();
