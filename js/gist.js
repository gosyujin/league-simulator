/**
 * GitHub Gist によるリーグの保存・共有
 *
 * - 1つのGistに、リーグ1件につき1ファイル(league-simulator-<リーグid>.json)を置く。リーグが増えれば
 *   ファイルが1つずつ増える。他のアプリのファイルが同居していても、この名前でないものは無視する。
 * - 読み取りは認証不要(Gist ID を知っていれば読める)。書き込み・作成・削除には classic PAT の
 *   gist スコープが必要(fine-grained PAT は Gist 非対応)。トークンはこの端末の localStorage にだけ置く。
 * - 同期は自動では行わない。ローカルとGistの差(Gistにだけある/この端末にだけある/内容が違う)を
 *   一覧にして、リーグ単位で読み込み・書き込みを選ぶ(黙って上書きしない)。
 * - 1つのGistのファイル数は、APIで取得できるのが300件まで(それ以上は一覧が切り詰められる)。
 *   各ファイルも本文は1MBまでしか返らない(リーグ1件は数KBなので問題にならない)。
 */
(function (root) {
  'use strict';

  const API = 'https://api.github.com/gists';
  const TOKEN_KEY = 'league-simulator:gistToken';
  const CONFIG_KEY = 'league-simulator:gist';
  const FILE_PREFIX = 'league-simulator-';
  const FILE_RE = /^league-simulator-([A-Za-z0-9_-]{1,40})\.json$/;
  const MAX_FILES = 300;
  // classic PAT の作成画面(gist スコープ選択済み)。開くだけで、発行は本人がGitHub上で行う
  const TOKEN_ISSUE_URL = 'https://github.com/settings/tokens/new?scopes=gist&description=league-simulator';

  // ── 設定(Gist ID・トークン) ──

  function readStore(key) {
    try { return root.localStorage.getItem(key) || ''; } catch (_) { return ''; }
  }
  function writeStore(key, value) {
    try { root.localStorage.setItem(key, value); } catch (_) { /* localStorage が使えない環境では記憶をあきらめる */ }
  }

  const getToken = () => readStore(TOKEN_KEY);
  const setToken = token => writeStore(TOKEN_KEY, String(token || '').trim());

  function getConfig() {
    try {
      const c = JSON.parse(readStore(CONFIG_KEY) || '{}');
      return { gistId: c && typeof c.gistId === 'string' ? c.gistId : '' };
    } catch (_) {
      return { gistId: '' };
    }
  }
  const setConfig = cfg => writeStore(CONFIG_KEY, JSON.stringify({ gistId: cfg.gistId || '' }));

  // Gist の URL(https://gist.github.com/user/<id> 等)を貼られても ID を取り出す
  function parseGistId(input) {
    const m = /([0-9a-f]{20,40})(?![0-9a-f])/i.exec(String(input || ''));
    return m ? m[1].toLowerCase() : '';
  }

  // ユーザー名なしでも、持ち主のGistページへリダイレクトされる
  const pageUrl = gistId => (gistId ? `https://gist.github.com/${gistId}` : '');

  // ── ファイル名 ──

  const fileName = leagueId => `${FILE_PREFIX}${leagueId}.json`;
  function leagueIdOf(name) {
    const m = FILE_RE.exec(String(name));
    return m ? m[1] : null;
  }

  // ── API ──

  let fetchOverride = null;
  const doFetch = (...args) => (fetchOverride || root.fetch).apply(root, args);

  const TOKEN_INVALID = 'トークンが無効です(失効の可能性)';
  const NOT_FOUND = 'Gistが見つかりません(IDを確認してください。書き込み時はトークンの権限も確認)';

  function describeHttpError(status) {
    if (status === 401) return TOKEN_INVALID;
    if (status === 403) return 'アクセス拒否またはレート制限です(しばらく待つか、トークンを設定してください)';
    if (status === 404) return NOT_FOUND;
    if (status === 422) return 'GitHubが内容を受け付けませんでした(ファイル数やサイズの上限の可能性)';
    return `HTTP ${status}`;
  }

  function authHeaders() {
    const token = getToken();
    if (!token) throw new Error('先にGitHubトークン(Gist用)を入力してください');
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  async function request(url, init, errorText) {
    let res;
    try { res = await doFetch(url, init); } catch (e) { throw new Error(errorText || 'GitHubに接続できませんでした'); }
    if (!res.ok) throw new Error(describeHttpError(res.status));
    return res;
  }

  /**
   * Gist を取得して、リーグのファイルだけを取り出す。
   * 戻り値: { files: [{ id, file, text }], fileCount, truncated }
   *   fileCount は他アプリのファイルも含めた総数(300件の上限は総数にかかる)
   */
  async function fetchLeagueFiles(gistId) {
    const res = await request(`${API}/${gistId}`, { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' });
    const json = await res.json();
    const all = json.files || {};
    const files = [];
    for (const [file, info] of Object.entries(all)) {
      const id = leagueIdOf(file);
      if (!id || !info) continue;
      let text = info.content || '';
      if (info.truncated && info.raw_url) {
        const raw = await request(info.raw_url, { cache: 'no-store' });
        text = await raw.text();
      }
      files.push({ id, file, text });
    }
    return { files, fileCount: Object.keys(all).length, truncated: !!json.truncated };
  }

  // files: { ファイル名: 本文 | null }。null はそのファイルの削除。指定したファイルだけが変わる
  async function update(gistId, files) {
    const body = { files: {} };
    for (const [name, content] of Object.entries(files)) body.files[name] = content === null ? null : { content };
    await request(`${API}/${gistId}`, { method: 'PATCH', headers: authHeaders(), body: JSON.stringify(body) });
  }

  // 新しいシークレットGistを作成してIDを返す(ファイルが1つ以上必要)
  async function create(description, files) {
    const body = { description, public: false, files: {} };
    for (const [name, content] of Object.entries(files)) body.files[name] = { content };
    const res = await request(API, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
    return (await res.json()).id;
  }

  // ── リーグとファイルの変換・差分 ──

  // M: LeagueModel。ファイルの中身は「このアプリのエクスポート形式でリーグ1件」+ id と更新日時
  const leagueFileText = (M, lg) => JSON.stringify(M.exportFile([lg], { withId: true }), null, 2);

  // 内容が同じかどうかの判定用(id と更新日時は含めない)
  const signature = (M, lg) => JSON.stringify(M.serializeLeague(lg));

  /**
   * ローカルのリーグ一覧とGistのファイルを突き合わせる。
   * 行: { id, file, name, local, remote, error, status, newer }
   *   status: 'same' | 'local-only' | 'remote-only' | 'differs' | 'broken'(Gist側が読めない)
   *   newer:  'local' | 'remote' | null(更新日時が両方あり、違うときだけ)
   */
  function buildPlan(M, locals, remoteFiles) {
    const rows = [];
    const byId = new Map();
    for (const lg of locals) {
      const row = { id: lg.id, file: fileName(lg.id), name: lg.name, local: lg, remote: null, error: null, status: 'local-only', newer: null };
      rows.push(row);
      byId.set(lg.id, row);
    }
    const remoteOnly = [];
    for (const rf of remoteFiles) {
      let remote = null, error = null;
      try {
        const leagues = M.parseImport(rf.text, '', { keepId: true });
        if (leagues.length !== 1) throw new Error('1ファイルにリーグが1件ではありません');
        remote = leagues[0];
        remote.id = rf.id; // ファイル名を正とする
      } catch (e) {
        error = e.message;
      }
      let row = byId.get(rf.id);
      if (!row) {
        row = { id: rf.id, file: rf.file, name: remote ? remote.name : rf.file, local: null, remote: null, error: null, status: 'remote-only', newer: null };
        remoteOnly.push(row);
        byId.set(rf.id, row);
      }
      row.file = rf.file;
      row.remote = remote;
      row.error = error;
      if (error) row.status = 'broken';
      else if (row.local) {
        row.status = signature(M, row.local) === signature(M, remote) ? 'same' : 'differs';
        const a = row.local.updatedAt, b = remote.updatedAt;
        if (row.status === 'differs' && typeof a === 'number' && typeof b === 'number' && a !== b) row.newer = a > b ? 'local' : 'remote';
      }
    }
    return rows.concat(remoteOnly);
  }

  const api = {
    MAX_FILES, TOKEN_ISSUE_URL, fileName, leagueIdOf, getToken, setToken, getConfig, setConfig,
    parseGistId, pageUrl, describeHttpError, fetchLeagueFiles, update, create,
    leagueFileText, signature, buildPlan,
    setFetch: fn => { fetchOverride = fn; }, // テスト用
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LeagueGist = api;
})(typeof self !== 'undefined' ? self : globalThis);
