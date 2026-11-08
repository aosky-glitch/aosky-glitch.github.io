/* ============================================================
   发布后台逻辑：可视化编辑 → GitHub Contents API 提交
   ============================================================ */
import { icon, escapeHtml, escapeAttr, toast, uid, nowISO } from './utils.js';
import { renderCard, TYPE_META } from './renderers.js';
import { GitHubRepo } from './github.js';

const $ = (s) => document.querySelector(s);
const CONFIG_KEY = 'mb-gh-config';
const THEME_KEY = 'mb-theme';
const POSTS_PATH = 'data/posts.json';
const SITE_PATH = 'data/site.json';

let repo = new GitHubRepo(readConfig());
let postsCache = [];
let editingId = null;
let uploadTarget = null;
let draft = defaultDraft();

/* ---------- 草稿模型 ---------- */
function defaultDraft() {
  return {
    id: '',
    type: 'text',
    created_at: nowISO(),
    title: '',
    content: '',
    tags: [],
    pinned: false,
    images: [{ src: '', alt: '', caption: '' }, { src: '', alt: '', caption: '' }, { src: '', alt: '', caption: '' }],
    cover: '',
    reading_time: '',
    link: { url: '', title: '', description: '', site: '', image: '', favicon: '' },
    location: { name: '', address: '', lat: '', lng: '', zoom: '15', note: '' },
    video: { platform: 'bilibili', id: '', bvid: '', page: '1', title: '', cover: '', duration: '', caption: '' },
    music: { platform: 'netease', kind: 'single', id: '', title: '', artist: '', cover: '', note: '', tracks: [{ title: '', artist: '', src: '' }] },
  };
}

function mergeDraft(post) {
  const base = defaultDraft();
  base.created_at = nowISO();
  const out = { ...base, ...post };
  ['link', 'location', 'video', 'music'].forEach((k) => { out[k] = { ...base[k], ...(post[k] || {}) }; });
  out.images = Array.isArray(post.images) && post.images.length ? post.images.map((x) => ({ src: '', alt: '', caption: '', ...x })) : base.images;
  out.music.tracks = Array.isArray(out.music.tracks) && out.music.tracks.length
    ? out.music.tracks.map((x) => ({ title: '', artist: '', src: '', ...x })) : [{ title: '', artist: '', src: '' }];
  out.tags = Array.isArray(post.tags) ? post.tags : [];
  if (!TYPE_META[out.type]) out.type = 'text';
  return out;
}

/** 支持 a.b / a[0].b 路径写入 */
function setPath(obj, path, value) {
  const parts = String(path).replace(/\[(\d+)\]/g, '.$1').split('.');
  let cur = obj;
  parts.forEach((key, i) => {
    if (i === parts.length - 1) { cur[key] = value; return; }
    if (cur[key] == null || typeof cur[key] !== 'object') {
      cur[key] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    }
    cur = cur[key];
  });
}

/* ---------- 配置 / 主题 ---------- */
function readConfig() {
  try { return JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}'); }
  catch { return {}; }
}
function saveConfig() {
  const cfg = {
    token: $('#cfgToken').value.trim(),
    owner: $('#cfgOwner').value.trim(),
    repo: $('#cfgRepo').value.trim(),
    branch: $('#cfgBranch').value.trim() || 'main',
  };
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  repo = new GitHubRepo(cfg);
  return cfg;
}
function fillConfigForm(cfg) {
  $('#cfgToken').value = cfg.token || '';
  $('#cfgOwner').value = cfg.owner || '';
  $('#cfgRepo').value = cfg.repo || '';
  $('#cfgBranch').value = cfg.branch || 'main';
}

function applyTheme(mode) {
  document.documentElement.dataset.theme = mode;
  $('#themeToggle').innerHTML = icon(mode === 'dark' ? 'sun' : 'moon', 18);
}
function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const mode = saved && saved !== 'auto' ? saved
    : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  applyTheme(mode);
  $('#themeToggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  });
}

function setConn(status, text) {
  const badge = $('#connBadge');
  badge.className = `adm-status${status ? ` ${status}` : ''}`;
  badge.textContent = text;
}
function showConnResult(ok, html) {
  const el = $('#connStatus');
  el.hidden = false;
  el.className = `conn-result ${ok ? 'ok' : 'bad'}`;
  el.innerHTML = html;
}

/* ---------- 表单控件模板 ---------- */
function inp(label, path, value = '', opts = {}) {
  const type = opts.type || 'text';
  return `<label class="field"><span>${label}${opts.hint ? ` <em>${opts.hint}</em>` : ''}</span>
    <input data-path="${escapeAttr(path)}" type="${type}" ${type === 'number' ? 'step="any"' : ''}
      value="${escapeAttr(value ?? '')}" placeholder="${escapeAttr(opts.placeholder || '')}" spellcheck="false"></label>`;
}
function inpUpload(label, path, value, kind = 'image', placeholder = '') {
  return `<label class="field"><span>${label}</span>
    <div class="input-row">
      <input data-path="${escapeAttr(path)}" type="text" value="${escapeAttr(value ?? '')}" placeholder="${escapeAttr(placeholder || 'media/… 或 https://…')}" spellcheck="false">
      <button type="button" class="mini-btn" data-upload-path="${escapeAttr(path)}" data-upload-kind="${kind}" title="上传到仓库">${icon('upload', 13)} 上传</button>
    </div></label>`;
}
function sel(label, path, value, options) {
  return `<label class="field"><span>${label}</span><select data-path="${escapeAttr(path)}">
    ${options.map(([v, t]) => `<option value="${escapeAttr(v)}"${String(value) === String(v) ? ' selected' : ''}>${escapeHtml(t)}</option>`).join('')}
  </select></label>`;
}
function groupBox(title, iconName, body, note = '') {
  return `<div class="group-box"><h3>${icon(iconName, 15)} ${title}</h3>${note ? `<p class="group-note">${note}</p>` : ''}${body}</div>`;
}
function imageRows() {
  return draft.images.map((im, i) => `<div class="repeat-row">
    ${inp('图片地址', `images[${i}].src`, im.src, { placeholder: 'media/photo.jpg' })}
    ${inp('替代文字', `images[${i}].alt`, im.alt)}
    ${inp('图注（可选）', `images[${i}].caption`, im.caption)}
    <div class="row-tools">
      <button type="button" data-upload-path="images[${i}].src" data-upload-kind="image" title="上传图片">${icon('upload', 15)}</button>
      <button type="button" data-remove-key="images" data-remove-index="${i}" title="移除这一行">${icon('trash', 15)}</button>
    </div>
  </div>`).join('');
}
function trackRows() {
  return (draft.music.tracks || []).map((t, i) => `<div class="repeat-row tracks">
    ${inp('曲目标题', `music.tracks[${i}].title`, t.title)}
    ${inp('艺人', `music.tracks[${i}].artist`, t.artist)}
    ${inp('音频地址', `music.tracks[${i}].src`, t.src, { placeholder: 'media/audio/01.mp3' })}
    <div class="row-tools">
      <button type="button" data-upload-path="music.tracks[${i}].src" data-upload-kind="audio" title="上传音频">${icon('upload', 15)}</button>
      <button type="button" data-remove-key="tracks" data-remove-index="${i}" title="移除这一行">${icon('trash', 15)}</button>
    </div>
  </div>`).join('');
}
function addRowBtn(key, label) {
  return `<button type="button" class="btn add-row" data-add-key="${key}">${icon('plus', 14)} ${label}</button>`;
}

const TYPE_TIPS = {
  text: '最轻量的形式：一段话、一个念头。支持 Markdown。',
  image: '文字配一张图。图片可上传到仓库 media/ 目录，也可填外链。',
  gallery: '多张图片以网格排列，点击可放大查看。',
  article: '长文章，卡片内默认折叠，读者点击「阅读全文」展开。',
  link: '生成一个带站点图标、标题、描述与缩略图的链接卡片。',
  location: '填写经纬度后嵌入 OpenStreetMap 地图，点击封面才加载，省流量。',
  video: '填写 YouTube 视频 ID 或哔哩哔哩 BV 号，点击封面加载播放器。',
  music: '支持网易云 / Spotify 外链播放器，也支持把音频文件放进仓库自建歌单。',
};

function renderTypeFields() {
  const t = draft.type;
  $('#fType').value = t;
  $('#typeTip').textContent = TYPE_TIPS[t] || '';
  let html = '';

  if (t === 'text') {
    html = groupBox('纯文本', 'text', `<p class="group-note" style="margin:0">这种类型没有额外字段。写点什么，然后点「发布到 GitHub 仓库」即可。</p>`);
  }

  if (t === 'image' || t === 'gallery') {
    html = groupBox(t === 'image' ? '图片' : '相册图片', 'gallery',
      imageRows() + addRowBtn('images', '添加一张图片'),
      '留空的行会被自动忽略。点击上传按钮会把本地图片提交到仓库的 media/ 目录并自动填入地址。');
  }

  if (t === 'article') {
    html = groupBox('文章设置', 'article',
      `<div class="field-grid">
        ${inpUpload('封面图（可选）', 'cover', draft.cover, 'image')}
        ${inp('阅读时长', 'reading_time', draft.reading_time, { placeholder: '约 6 分钟' })}
      </div>`,
      '正文写在上面的「正文」输入框里，支持 Markdown 标题、列表、引用、代码块。');
  }

  if (t === 'link') {
    const l = draft.link;
    html = groupBox('链接卡片', 'link',
      `<div class="field-grid">
        ${inp('目标网址 *', 'link.url', l.url, { placeholder: 'https://example.com/post' })}
        ${inp('卡片标题 *', 'link.title', l.title)}
      </div>
      ${inp('描述', 'link.description', l.description)}
      <div class="field-grid">
        ${inp('站点名（可选）', 'link.site', l.site, { placeholder: '留空则自动从网址提取' })}
        ${inpUpload('缩略图（可选）', 'link.image', l.image, 'image')}
      </div>
      ${inp('站点图标地址（可选）', 'link.favicon', l.favicon, { placeholder: '留空则自动生成字母图标' })}`);
  }

  if (t === 'location') {
    const l = draft.location;
    html = groupBox('位置信息', 'pin',
      `<div class="field-grid">
        ${inp('地点名称 *', 'location.name', l.name, { placeholder: '茅家埠 · 西湖' })}
        ${inp('详细地址', 'location.address', l.address)}
      </div>
      <div class="field-grid">
        ${inp('纬度 lat *', 'location.lat', l.lat, { type: 'number', placeholder: '30.2386' })}
        ${inp('经度 lng *', 'location.lng', l.lng, { type: 'number', placeholder: '120.1294' })}
      </div>
      <div class="field-grid">
        ${inp('缩放级别', 'location.zoom', l.zoom, { type: 'number', placeholder: '15' })}
        ${inp('备注', 'location.note', l.note, { placeholder: '推荐从北侧小路走进去' })}
      </div>`,
      '地图使用 OpenStreetMap 嵌入，无需 API Key；坐标可在 openstreetmap.org 右键「显示地址」获取。');
  }

  if (t === 'video') {
    const v = draft.video;
    html = groupBox('视频信息', 'video',
      `<div class="field-grid">
        ${sel('平台', 'video.platform', v.platform, [['bilibili', '哔哩哔哩'], ['youtube', 'YouTube']])}
        ${inp('页码（B站分P）', 'video.page', v.page, { type: 'number', placeholder: '1' })}
      </div>
      <div class="field-grid">
        ${inp('YouTube 视频 ID', 'video.id', v.id, { hint: '仅 YouTube 需要', placeholder: 'aqz-KE-bpKQ' })}
        ${inp('哔哩哔哩 BV 号', 'video.bvid', v.bvid, { hint: '仅 B 站需要', placeholder: 'BV1xx411c7mD' })}
      </div>
      <div class="field-grid">
        ${inp('视频标题', 'video.title', v.title)}
        ${inp('时长（可选）', 'video.duration', v.duration, { placeholder: '18:24' })}
      </div>
      ${inpUpload('封面图（可选）', 'video.cover', v.cover, 'image')}
      ${inp('说明文字', 'video.caption', v.caption, { placeholder: '点击封面加载播放器' })}`,
      'YouTube ID 是网址 watch?v= 后面那串字符；B 站 BV 号在视频网址里，以 BV 开头。');
  }

  if (t === 'music') {
    const m = draft.music;
    let extra = '';
    if (m.platform === 'custom') {
      extra = groupBox('自建歌单音轨', 'list', trackRows() + addRowBtn('tracks', '添加一条音轨'),
        '音频文件可以上传到仓库 media/audio/ 目录；留空 src 的音轨仍会列出，但提示无法播放。');
    } else {
      extra = `<div class="group-box"><h3>${icon('info', 15)} 外链播放器 ID</h3>
        ${inp(m.platform === 'netease' ? '网易云资源 ID' : 'Spotify 资源 ID', 'music.id', m.id,
          { hint: '单曲 ID 或歌单 ID', placeholder: m.platform === 'netease' ? '纯数字 ID' : 'Track / Playlist ID' })}
        <p class="group-note">ID 可从分享链接中获得：网易云单曲/歌单链接里的数字；Spotify 打开 Share → Embed 可见。外链播放器由对应平台提供，部分地区可能无法访问。</p></div>`;
    }
    html = groupBox('音乐信息', 'music',
      `<div class="field-grid">
        ${sel('播放方式', 'music.platform', m.platform, [['netease', '网易云音乐外链'], ['spotify', 'Spotify 外链'], ['custom', '仓库自带音频（自定义播放器）']])}
        ${sel('类型', 'music.kind', m.kind, [['single', '单曲'], ['playlist', '歌单']])}
      </div>
      <div class="field-grid">
        ${inp('标题 *', 'music.title', m.title)}
        ${inp('艺人 / 说明', 'music.artist', m.artist)}
      </div>
      ${inpUpload('封面图（可选）', 'music.cover', m.cover, 'image')}
      ${inp('附注（可选）', 'music.note', m.note)}`) + extra;
  }

  $('#typeFields').innerHTML = html;
}

/* ---------- 表单 ↔ 草稿 ---------- */
function isoToInput(iso) {
  const s = String(iso || '');
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) ? s.slice(0, 16) : '';
}
function localToISO(local) {
  if (!local) return null;
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return null;
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const pad = (n) => String(Math.abs(n)).padStart(2, '0');
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00${sign}${pad(Math.floor(off / 60))}:${pad(off % 60)}`;
}

function fillFormFromDraft() {
  $('#fType').value = draft.type;
  $('#fTitle').value = draft.title || '';
  $('#fContent').value = draft.content || '';
  $('#fTags').value = (draft.tags || []).join(', ');
  $('#fDate').value = isoToInput(draft.created_at) || isoToInput(nowISO());
  $('#fPinned').checked = Boolean(draft.pinned);
  renderTypeFields();
}

function syncCommonToDraft() {
  draft.type = $('#fType').value;
  draft.title = $('#fTitle').value.trim();
  draft.content = $('#fContent').value;
  draft.tags = $('#fTags').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  draft.pinned = $('#fPinned').checked;
  const iso = localToISO($('#fDate').value);
  if (iso) draft.created_at = iso;
}

function buildPost() {
  syncCommonToDraft();
  const p = {
    id: draft.id || editingId || uid(),
    type: draft.type,
    created_at: draft.created_at || nowISO(),
    title: draft.title,
    content: draft.content,
    tags: draft.tags,
  };
  if (draft.pinned) p.pinned = true;

  switch (p.type) {
    case 'image':
    case 'gallery': {
      const imgs = (draft.images || []).filter((x) => x && String(x.src || '').trim()).map((x) => {
        const o = { src: String(x.src).trim() };
        if (x.alt) o.alt = x.alt;
        if (x.caption) o.caption = x.caption;
        return o;
      });
      p.images = imgs;
      if (p.type === 'gallery') p.layout = 'grid';
      break;
    }
    case 'article':
      if (draft.cover) p.cover = draft.cover;
      if (draft.reading_time) p.reading_time = draft.reading_time;
      break;
    case 'link': {
      const l = draft.link || {};
      p.link = {};
      ['url', 'title', 'description', 'site', 'image', 'favicon'].forEach((k) => { if (String(l[k] || '').trim()) p.link[k] = String(l[k]).trim(); });
      break;
    }
    case 'location': {
      const l = draft.location || {};
      p.location = {};
      ['name', 'address', 'note'].forEach((k) => { if (String(l[k] || '').trim()) p.location[k] = String(l[k]).trim(); });
      if (l.lat !== '' && l.lat != null) p.location.lat = Number(l.lat);
      if (l.lng !== '' && l.lng != null) p.location.lng = Number(l.lng);
      if (l.zoom !== '' && l.zoom != null) p.location.zoom = Number(l.zoom);
      break;
    }
    case 'video': {
      const v = draft.video || {};
      p.video = { platform: v.platform === 'youtube' ? 'youtube' : 'bilibili' };
      ['id', 'bvid', 'title', 'cover', 'duration', 'caption'].forEach((k) => { if (String(v[k] || '').trim()) p.video[k] = String(v[k]).trim(); });
      const page = parseInt(v.page, 10);
      if (page > 1) p.video.page = page;
      break;
    }
    case 'music': {
      const m = draft.music || {};
      p.music = {
        platform: ['netease', 'spotify', 'custom'].includes(m.platform) ? m.platform : 'custom',
        kind: m.kind === 'playlist' ? 'playlist' : 'single',
      };
      ['id', 'title', 'artist', 'cover', 'note'].forEach((k) => { if (String(m[k] || '').trim()) p.music[k] = String(m[k]).trim(); });
      if (p.music.platform === 'custom') {
        p.music.tracks = (m.tracks || []).map((t) => {
          const o = { title: t.title || '未命名曲目' };
          if (t.artist) o.artist = t.artist;
          if (t.src) o.src = t.src;
          return o;
        });
      }
      break;
    }
    default: break;
  }
  return p;
}

function validate(post) {
  switch (post.type) {
    case 'text': if (!post.content.trim()) return '请填写正文'; break;
    case 'image': case 'gallery': if (!post.images?.length) return '请至少填写一张图片的地址（或点击上传）'; break;
    case 'article': if (!post.content.trim()) return '请填写文章正文'; break;
    case 'link': if (!post.link?.url) return '请填写链接地址'; break;
    case 'location': if (!post.location?.name || !Number.isFinite(post.location.lat) || !Number.isFinite(post.location.lng)) return '请填写地点名称与经纬度'; break;
    case 'video':
      if (post.video.platform === 'youtube' && !post.video.id) return 'YouTube 需要填写视频 ID';
      if (post.video.platform === 'bilibili' && !post.video.bvid) return '哔哩哔哩需要填写 BV 号';
      break;
    case 'music':
      if (!post.music.title) return '请填写音乐标题';
      if (post.music.platform !== 'custom' && !post.music.id) return '请填写音乐资源 ID';
      break;
  }
  return null;
}

/* ---------- 预览 / JSON ---------- */
function refreshPreview() {
  const post = buildPost();
  $('#previewWrap').innerHTML = renderCard(post);
}
function refreshJSON() {
  $('#jsonEditor').value = JSON.stringify(buildPost(), null, 2);
  $('#jsonError').hidden = true;
}
function applyJSON() {
  try {
    const obj = JSON.parse($('#jsonEditor').value);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('应为一个内容对象，而不是数组');
    draft = mergeDraft(obj);
    fillFormFromDraft();
    $('#jsonError').hidden = true;
    switchTab('compose');
    toast('JSON 已应用到表单');
  } catch (err) {
    $('#jsonError').hidden = false;
    $('#jsonError').textContent = `JSON 解析失败：${err.message}`;
  }
}

function switchTab(name) {
  document.querySelectorAll('.adm-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  ['compose', 'preview', 'json'].forEach((n) => { $(`#tab-${n}`).hidden = n !== name; });
  if (name === 'preview') refreshPreview();
  if (name === 'json') refreshJSON();
}

/* ---------- 预览区媒体交互（与主站保持一致） ---------- */
function bindPreviewInteractions() {
  $('#previewWrap').addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');
    if (!t) return;
    if (t.dataset.action === 'expand') {
      const wrap = t.closest('.article-wrap');
      const expanded = wrap.classList.toggle('expanded');
      t.classList.toggle('expanded', expanded);
      t.innerHTML = expanded ? `${icon('chevronDown', 15)} 收起全文` : `${icon('chevronDown', 15)} 阅读全文`;
    }
    if (t.dataset.action === 'load-map') {
      const f = t.closest('.map-frame');
      if (f?.dataset.mapSrc) f.innerHTML = `<iframe src="${escapeAttr(f.dataset.mapSrc)}" title="地图预览"></iframe>`;
    }
    if (t.dataset.action === 'load-video') {
      const f = t.closest('.video-frame');
      if (f?.dataset.videoSrc) f.innerHTML = `<iframe src="${escapeAttr(f.dataset.videoSrc)}" allowfullscreen title="视频预览"></iframe>`;
      else toast('视频 ID 无效');
    }
    if (t.dataset.action === 'play-track') toast('预览模式下不播放音频，发布后可在主站播放');
  });
}

/* ---------- 仓库读写 ---------- */
async function pullPosts(silent = false) {
  if (!repo.configured) { if (!silent) toast('请先填写并保存 GitHub 配置'); return; }
  try {
    const { posts } = await repo.loadPosts(POSTS_PATH);
    postsCache = posts;
    renderPostList();
    setConn('ok', `已连接 · ${posts.length} 条`);
    if (!silent) toast(`已从 ${repo.owner}/${repo.repo} 拉取 ${posts.length} 条内容`);
  } catch (err) {
    setConn('bad', '连接失败');
    showConnResult(false, escapeHtml(err.message));
    if (!silent) toast(`拉取失败：${err.message}`);
  }
}

function renderPostList() {
  const list = $('#postList');
  $('#listCount').textContent = `${postsCache.length} 条`;
  if (!postsCache.length) {
    list.innerHTML = '<p class="muted">仓库里还没有内容，写一条发布吧。</p>';
    return;
  }
  const sorted = [...postsCache].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  list.innerHTML = sorted.map((p) => {
    const meta = TYPE_META[p.type] || TYPE_META.text;
    const title = p.title || (p.content || '').replace(/[#*`>\-\[\]]/g, '').trim().slice(0, 26) || '（无标题）';
    return `<div class="list-item${editingId === p.id ? ' active' : ''}">
      <span class="list-icon">${icon(meta.icon, 15)}</span>
      <div class="list-main">
        <div class="list-title">${escapeHtml(title)}</div>
        <div class="list-sub">${meta.label} · ${escapeHtml(String(p.created_at || '').slice(0, 10))}</div>
      </div>
      <div class="list-actions">
        <button type="button" data-edit-id="${escapeAttr(p.id)}" title="编辑">${icon('pen', 14)}</button>
        <button type="button" data-del-id="${escapeAttr(p.id)}" title="删除">${icon('trash', 14)}</button>
      </div>
    </div>`;
  }).join('');
}

async function publish() {
  if (!repo.configured) { toast('请先填写并保存 GitHub 配置'); return; }
  const post = buildPost();
  const err = validate(post);
  if (err) { toast(err); return; }

  const btn = $('#btnPublish');
  btn.disabled = true;
  const old = btn.innerHTML;
  btn.innerHTML = `${icon('refresh', 15)} 正在提交…`;
  try {
    const { posts, sha } = await repo.loadPosts(POSTS_PATH);
    const idx = posts.findIndex((p) => p.id === post.id);
    const action = idx >= 0 ? '更新' : '新增';
    if (idx >= 0) posts[idx] = post; else posts.push(post);
    const res = await repo.savePosts(posts, sha, `${action}内容: ${post.title || TYPE_META[post.type].label} (${post.id})`, POSTS_PATH);
    postsCache = posts;
    renderPostList();
    const commitUrl = res?.commit?.html_url || res?.content?.html_url ||
      `https://github.com/${repo.owner}/${repo.repo}/commits/${encodeURIComponent(repo.branch)}`;
    $('#publishHint').innerHTML = `${action}成功 · <a href="${escapeAttr(commitUrl)}" target="_blank" rel="noopener noreferrer">查看这次 commit</a> · GitHub Pages 会自动重新构建，通常 1 分钟内生效。`;
    toast(`${action}成功，已提交到仓库`);
    clearForm();
    switchTab('compose');
  } catch (e) {
    toast(`发布失败：${e.message}`);
    $('#publishHint').textContent = `发布失败：${e.message}`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = old;
  }
}

async function deletePost(id) {
  const p = postsCache.find((x) => x.id === id);
  if (!p || !confirm(`确定删除「${p.title || p.id}」吗？\n这会向仓库提交一次删除操作（可用 git revert 恢复）。`)) return;
  try {
    const { posts, sha } = await repo.loadPosts(POSTS_PATH);
    const next = posts.filter((x) => x.id !== id);
    if (next.length === posts.length) { toast('仓库中已找不到这条内容'); return; }
    await repo.savePosts(next, sha, `删除内容: ${id}`, POSTS_PATH);
    postsCache = next;
    renderPostList();
    toast('已从仓库删除');
    if (editingId === id) clearForm();
  } catch (e) { toast(`删除失败：${e.message}`); }
}

function editPost(id) {
  const p = postsCache.find((x) => x.id === id);
  if (!p) return;
  draft = mergeDraft(p);
  draft.id = p.id;
  editingId = p.id;
  fillFormFromDraft();
  $('#editBadge').hidden = false;
  $('#btnCancelEdit').hidden = false;
  $('#btnPublish').innerHTML = `${icon('save', 15)} 更新这条内容`;
  renderPostList();
  switchTab('compose');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  toast('已载入内容，修改后点「更新这条内容」');
}

function clearForm() {
  draft = defaultDraft();
  editingId = null;
  $('#postForm').reset();
  fillFormFromDraft();
  $('#editBadge').hidden = true;
  $('#btnCancelEdit').hidden = true;
  $('#btnPublish').innerHTML = `${icon('upload', 15)} 发布到 GitHub 仓库`;
  $('#publishHint').textContent = '';
  renderPostList();
}

/* ---------- 上传到仓库 ---------- */
function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('读取文件失败'));
    fr.readAsDataURL(file);
  });
}

async function handleUpload(file) {
  if (!uploadTarget) return;
  if (!repo.configured) { toast('请先填写并保存 GitHub 配置，才能上传文件'); $('#filePicker').value = ''; return; }
  const MAX = 20 * 1024 * 1024;
  if (file.size > MAX) { toast('文件超过 20MB，请压缩后再上传（GitHub API 不适合大文件）'); $('#filePicker').value = ''; return; }
  toast('正在上传到仓库 media/ …');
  try {
    const dataUrl = await fileToDataURL(file);
    const b64 = String(dataUrl).slice(String(dataUrl).indexOf(',') + 1);
    const safeName = (file.name || 'file').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+/, '') || 'file';
    const d = new Date();
    const ym = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}`;
    const remote = `media/${ym}/${Date.now()}-${safeName}`;
    await repo.putFile(remote, b64, `上传媒体文件: ${safeName}`);
    setPath(draft, uploadTarget.path, remote);
    renderTypeFields();
    toast(`已上传：${remote}`);
  } catch (e) {
    toast(`上传失败：${e.message}`);
  } finally {
    $('#filePicker').value = '';
    uploadTarget = null;
  }
}

/* ---------- 站点设置 ---------- */
async function loadSiteSettings() {
  if (!repo.configured) { toast('请先填写并保存 GitHub 配置'); return; }
  try {
    const file = await repo.getText(SITE_PATH);
    if (!file) { toast('仓库中还没有 data/site.json'); return; }
    const s = JSON.parse(file.text);
    $('#sTitle').value = s.title || '';
    $('#sSubtitle').value = s.subtitle || '';
    $('#sDescription').value = s.description || '';
    $('#sAuthorName').value = s.author?.name || '';
    $('#sAuthorHandle').value = s.author?.handle || '';
    $('#sAuthorBio').value = s.author?.bio || '';
    $('#sAuthorLocation').value = s.author?.location || '';
    $('#sAvatar').value = s.author?.avatar || '';
    $('#sCover').value = s.cover || '';
    $('#sAccent').value = /^#[0-9a-f]{6}$/i.test(s.theme?.accent || '') ? s.theme.accent : '#d9564f';
    $('#sPageSize').value = s.pageSize || 8;
    $('#sThemeMode').value = s.theme?.defaultMode || 'auto';
    $('#sFooter').value = s.footer || '';
    $('#sLinks').value = JSON.stringify(s.links || [], null, 2);
    toast('站点设置已读取');
  } catch (e) { toast(`读取失败：${e.message}`); }
}

async function saveSiteSettings() {
  if (!repo.configured) { toast('请先填写并保存 GitHub 配置'); return; }
  let links;
  try { links = JSON.parse($('#sLinks').value || '[]'); }
  catch { toast('导航链接不是合法的 JSON'); return; }
  if (!Array.isArray(links)) { toast('导航链接应为数组'); return; }
  try {
    const file = await repo.getText(SITE_PATH);
    const s = file ? JSON.parse(file.text) : {};
    s.title = $('#sTitle').value.trim();
    s.subtitle = $('#sSubtitle').value.trim();
    s.description = $('#sDescription').value.trim();
    s.author = {
      ...(s.author || {}),
      name: $('#sAuthorName').value.trim(),
      handle: $('#sAuthorHandle').value.trim(),
      bio: $('#sAuthorBio').value.trim(),
      location: $('#sAuthorLocation').value.trim(),
      avatar: $('#sAvatar').value.trim(),
    };
    s.cover = $('#sCover').value.trim();
    s.pageSize = Math.max(1, Number($('#sPageSize').value) || 8);
    s.footer = $('#sFooter').value.trim();
    s.links = links;
    s.theme = { ...(s.theme || {}), accent: $('#sAccent').value, defaultMode: $('#sThemeMode').value };
    await repo.putText(SITE_PATH, `${JSON.stringify(s, null, 2)}\n`, '更新站点设置 (site.json)', file?.sha);
    toast('站点设置已保存到仓库');
  } catch (e) { toast(`保存失败：${e.message}`); }
}

/* ---------- 导入 / 导出 ---------- */
function exportPosts() {
  const data = postsCache.length ? postsCache : [];
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'posts.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('已导出 posts.json');
}

async function importPosts(file) {
  if (!repo.configured) { toast('请先填写并保存 GitHub 配置'); return; }
  try {
    const text = await file.text();
    const arr = JSON.parse(text);
    const posts = Array.isArray(arr) ? arr : arr.posts;
    if (!Array.isArray(posts)) throw new Error('文件应为内容数组');
    if (!confirm(`将用本地文件的 ${posts.length} 条内容覆盖仓库中的 data/posts.json，确定吗？`)) return;
    const { sha } = await repo.loadPosts(POSTS_PATH);
    await repo.savePosts(posts, sha, `导入 posts.json（${posts.length} 条）`, POSTS_PATH);
    postsCache = posts;
    renderPostList();
    toast(`已导入 ${posts.length} 条内容`);
  } catch (e) { toast(`导入失败：${e.message}`); }
  $('#importFile').value = '';
}

/* ---------- 事件绑定 ---------- */
function injectIcons() {
  $('#backLink').innerHTML = icon('arrowLeft', 18);
}

function bindEvents() {
  // 配置
  $('#btnToggleToken').addEventListener('click', () => {
    const el = $('#cfgToken');
    const show = el.type === 'password';
    el.type = show ? 'text' : 'password';
    $('#btnToggleToken').textContent = show ? '隐藏' : '显示';
  });
  $('#btnSaveCfg').addEventListener('click', async () => {
    saveConfig();
    showConnResult(true, '配置已保存到本机浏览器。正在验证连接…');
    setConn('', '验证中…');
    try {
      const info = await repo.info();
      setConn('ok', '已连接');
      showConnResult(true, `连接成功：<strong>${escapeHtml(info.full_name)}</strong> · 默认分支 <code>${escapeHtml(info.default_branch || repo.branch)}</code> · ${info.private ? '私有仓库' : '公开仓库'}`);
      await pullPosts(true);
    } catch (e) {
      setConn('bad', '连接失败');
      showConnResult(false, escapeHtml(e.message));
    }
  });
  $('#btnTest').addEventListener('click', async () => {
    const cfg = saveConfig();
    if (!cfg.token || !cfg.owner || !cfg.repo) { toast('请填写 Token、Owner 和 Repo'); return; }
    setConn('', '验证中…');
    try {
      const info = await repo.info();
      setConn('ok', '已连接');
      showConnResult(true, `连接成功：<strong>${escapeHtml(info.full_name)}</strong> · 默认分支 <code>${escapeHtml(info.default_branch || repo.branch)}</code> · ${info.private ? '私有仓库' : '公开仓库'}`);
    } catch (e) {
      setConn('bad', '连接失败');
      showConnResult(false, escapeHtml(e.message));
    }
  });
  $('#btnClearCfg').addEventListener('click', () => {
    if (!confirm('清除本机保存的 GitHub 配置（不会影响仓库内容）？')) return;
    localStorage.removeItem(CONFIG_KEY);
    repo = new GitHubRepo({});
    fillConfigForm({});
    $('#cfgBranch').value = 'main';
    setConn('', '未连接');
    $('#connStatus').hidden = true;
    toast('配置已清除');
  });
  $('#btnReload').addEventListener('click', () => pullPosts(false));

  // 类型切换
  $('#fType').addEventListener('change', (e) => {
    draft.type = e.target.value;
    if (draft.type === 'image' && draft.images.length > 1) draft.images = draft.images.slice(0, 1);
    if (draft.type === 'gallery' && draft.images.length < 2) {
      while (draft.images.length < 3) draft.images.push({ src: '', alt: '', caption: '' });
    }
    renderTypeFields();
  });

  // 动态字段
  $('#typeFields').addEventListener('input', (e) => {
    const el = e.target.closest('[data-path]');
    if (el) setPath(draft, el.dataset.path, el.value);
  });
  $('#typeFields').addEventListener('change', (e) => {
    const el = e.target.closest('select[data-path]');
    if (el) {
      setPath(draft, el.dataset.path, el.value);
      if (['video.platform', 'music.platform'].includes(el.dataset.path)) renderTypeFields();
    }
  });
  $('#typeFields').addEventListener('click', (e) => {
    const up = e.target.closest('[data-upload-path]');
    if (up) {
      uploadTarget = { path: up.dataset.uploadPath, kind: up.dataset.uploadKind };
      const picker = $('#filePicker');
      picker.accept = uploadTarget.kind === 'audio' ? 'audio/*' : 'image/*';
      picker.click();
      return;
    }
    const add = e.target.closest('[data-add-key]');
    if (add) {
      if (add.dataset.addKey === 'images') draft.images.push({ src: '', alt: '', caption: '' });
      if (add.dataset.addKey === 'tracks') (draft.music.tracks ||= []).push({ title: '', artist: '', src: '' });
      renderTypeFields();
      return;
    }
    const del = e.target.closest('[data-remove-key]');
    if (del) {
      const i = Number(del.dataset.removeIndex);
      if (del.dataset.removeKey === 'images') {
        draft.images.splice(i, 1);
        if (!draft.images.length) draft.images.push({ src: '', alt: '', caption: '' });
      } else {
        draft.music.tracks.splice(i, 1);
        if (!draft.music.tracks.length) draft.music.tracks.push({ title: '', artist: '', src: '' });
      }
      renderTypeFields();
    }
  });
  $('#filePicker').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) handleUpload(file);
  });

  // Tabs
  document.querySelectorAll('.adm-tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('#btnPreview').addEventListener('click', () => switchTab('preview'));
  $('#btnRefreshPreview').addEventListener('click', refreshPreview);
  $('#btnRefreshJson').addEventListener('click', refreshJSON);
  $('#btnApplyJson').addEventListener('click', applyJSON);
  $('#btnCopyJson').addEventListener('click', () => {
    refreshJSON();
    navigator.clipboard?.writeText($('#jsonEditor').value).then(() => toast('JSON 已复制')).catch(() => toast('复制失败，请手动选择文本'));
  });

  // 发布 / 编辑 / 清空
  $('#btnPublish').addEventListener('click', publish);
  $('#btnClear').addEventListener('click', clearForm);
  $('#btnCancelEdit').addEventListener('click', clearForm);
  $('#postForm').addEventListener('submit', (e) => { e.preventDefault(); publish(); });
  $('#postList').addEventListener('click', (e) => {
    const edit = e.target.closest('[data-edit-id]');
    const del = e.target.closest('[data-del-id]');
    if (edit) editPost(edit.dataset.editId);
    if (del) deletePost(del.dataset.delId);
  });

  // 站点设置 / 导入导出
  $('#btnLoadSite').addEventListener('click', loadSiteSettings);
  $('#btnSaveSite').addEventListener('click', saveSiteSettings);
  $('#btnExport').addEventListener('click', exportPosts);
  $('#importFile').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) importPosts(file);
  });

  bindPreviewInteractions();
}

/* ---------- 启动 ---------- */
async function boot() {
  injectIcons();
  initTheme();
  const cfg = readConfig();
  fillConfigForm(cfg);

  // 站点仓库信息可作为默认值（来自 data/site.json）
  if (!cfg.owner || !cfg.repo) {
    try {
      const res = await fetch('data/site.json', { cache: 'no-store' });
      if (res.ok) {
        const s = await res.json();
        if (s.repo?.owner && s.repo?.owner !== 'your-name') {
          $('#cfgOwner').value = $('#cfgOwner').value || s.repo.owner;
          $('#cfgRepo').value = $('#cfgRepo').value || s.repo.name;
          $('#cfgBranch').value = s.repo.branch || 'main';
        }
      }
    } catch { /* 忽略：仅作为默认值 */ }
  }

  fillFormFromDraft();
  bindEvents();
  if (repo.configured) {
    setConn('', '连接中…');
    try {
      const info = await repo.info();
      setConn('ok', '已连接');
      showConnResult(true, `已连接 <strong>${escapeHtml(info.full_name)}</strong>，配置保存在本机浏览器。`);
      await pullPosts(true);
    } catch (e) {
      setConn('bad', '连接失败');
      showConnResult(false, escapeHtml(e.message));
    }
  } else {
    setConn('', '未连接');
    showConnResult(true, '填写 Token、Owner、Repo 后点「保存配置」即可开始发布。所有内容都会以 commit 的形式写入仓库的 <code>data/posts.json</code>。');
  }
}

boot();
