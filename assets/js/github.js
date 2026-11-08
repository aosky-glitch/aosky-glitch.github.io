/* ============================================================
   GitHub Contents API 封装（浏览器直连，无需后端）
   ============================================================ */

export function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(String(str));
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function base64ToUtf8(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

const ERROR_HINTS = {
  401: 'Token 无效或已过期，请重新生成 Personal Access Token。',
  403: '没有权限或触发了 API 速率限制。请确认 Token 拥有该仓库 Contents 的读写权限。',
  404: '找不到仓库或文件。请检查 Owner / Repo / Branch 是否填写正确，以及 Token 是否可见该仓库。',
  409: '提交冲突，请重新拉取后再试。',
  422: '文件已存在或 sha 不匹配，请重新拉取后再试。',
};

export class GitHubRepo {
  constructor(config = {}) {
    this.token = (config.token || '').trim();
    this.owner = (config.owner || '').trim();
    this.repo = (config.repo || '').trim();
    this.branch = (config.branch || 'main').trim() || 'main';
  }

  get configured() {
    return Boolean(this.token && this.owner && this.repo);
  }

  get base() {
    return `https://api.github.com/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`;
  }

  headers() {
    return {
      'Authorization': `Bearer ${this.token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    };
  }

  encodePath(path) {
    return String(path).replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
  }

  async request(url, options = {}) {
    let res;
    try {
      res = await fetch(url, { ...options, headers: { ...this.headers(), ...(options.headers || {}) } });
    } catch (err) {
      throw new Error(`网络请求失败：${err.message}（请检查网络或浏览器扩展拦截）`);
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).message || ''; } catch { /* ignore */ }
      const hint = ERROR_HINTS[res.status] || `GitHub API 返回 ${res.status}`;
      throw new Error(`${hint}${detail && detail !== hint ? ` · ${detail}` : ''}`);
    }
    return res.status === 204 ? null : res.json();
  }

  /** 仓库信息，用于测试连接 */
  async info() {
    return this.request(this.base);
  }

  /** 读取仓库中的文本文件，返回 { text, sha }；文件不存在返回 null */
  async getText(path) {
    const url = `${this.base}/contents/${this.encodePath(path)}?ref=${encodeURIComponent(this.branch)}`;
    let res;
    try {
      res = await fetch(url, { headers: this.headers(), cache: 'no-store' });
    } catch (err) {
      throw new Error(`网络请求失败：${err.message}`);
    }
    if (res.status === 404) return null;
    if (!res.ok) {
      const hint = ERROR_HINTS[res.status] || `GitHub API 返回 ${res.status}`;
      throw new Error(hint);
    }
    const data = await res.json();
    if (Array.isArray(data)) throw new Error('目标路径是一个目录，不是文件');
    return { text: base64ToUtf8(data.content || ''), sha: data.sha, htmlUrl: data.html_url };
  }

  /** 写入文件。contentBase64 为不含 data URL 前缀的纯 base64 */
  async putFile(path, contentBase64, message, sha) {
    const body = { message, content: contentBase64, branch: this.branch };
    if (sha) body.sha = sha;
    return this.request(`${this.base}/contents/${this.encodePath(path)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  }

  async putText(path, text, message, sha) {
    return this.putFile(path, utf8ToBase64(text), message, sha);
  }

  async deleteFile(path, message, sha) {
    return this.request(`${this.base}/contents/${this.encodePath(path)}`, {
      method: 'DELETE',
      body: JSON.stringify({ message, branch: this.branch, sha }),
    });
  }

  /** 读取 posts.json 并解析为数组 */
  async loadPosts(path = 'data/posts.json') {
    const file = await this.getText(path);
    if (!file) return { posts: [], sha: null };
    const parsed = JSON.parse(file.text);
    const posts = Array.isArray(parsed) ? parsed : (parsed.posts || []);
    if (!Array.isArray(posts)) throw new Error('posts.json 格式不正确，应为数组');
    return { posts, sha: file.sha };
  }

  async savePosts(posts, sha, message, path = 'data/posts.json') {
    return this.putText(path, `${JSON.stringify(posts, null, 2)}\n`, message, sha);
  }
}
