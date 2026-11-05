'use strict';
/**
 * Gist 連携の検証(GitHub API は偽のサーバーに差し替える)。
 *   node tests/gist.test.js
 */
const assert = require('assert');
const M = require('../js/model.js');
const G = require('../js/gist.js');

let failed = 0;
// fetch や localStorage をテストごとに差し替えるので、1件ずつ順に実行する
let chain = Promise.resolve();
function test(name, fn) {
  chain = chain.then(fn).then(
    () => console.log('ok   ' + name),
    e => { failed++; console.log('FAIL ' + name + '\n     ' + (e.stack || e)); });
}

// ── 偽のGist(必要な部分だけ) ──
function fakeGitHub(initialFiles) {
  const gists = new Map([['a'.repeat(32), { files: Object.assign({}, initialFiles) }]]);
  const calls = [];
  const res = (status, body) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body && JSON.parse(init.body) });
    const m = /\/gists(?:\/([0-9a-f]+))?$/.exec(url);
    if (url.startsWith('https://raw.example/')) return res(200, 'RAW:' + url);
    if (!m) return res(404, {});
    const method = init.method || 'GET';
    if (method === 'POST') {
      const body = JSON.parse(init.body);
      if (!(init.headers || {}).Authorization) return res(401, {});
      const id = 'b'.repeat(32);
      gists.set(id, { files: Object.fromEntries(Object.entries(body.files).map(([k, v]) => [k, { content: v.content }])) });
      return res(201, { id });
    }
    const g = gists.get(m[1]);
    if (!g) return res(404, {});
    if (method === 'PATCH') {
      if (!(init.headers || {}).Authorization) return res(401, {});
      for (const [name, v] of Object.entries(JSON.parse(init.body).files)) {
        if (v === null) delete g.files[name]; else g.files[name] = { content: v.content };
      }
      return res(200, {});
    }
    return res(200, { files: g.files, truncated: false });
  };
  return { impl, gists, calls, id: 'a'.repeat(32) };
}

function leagueWith(name, id, matches) {
  const lg = M.deserializeLeague({
    id, name, participants: ['A', 'B', 'C'], outcomes: M.defaultOutcomes(),
    matches: matches || [], target: { mode: 'within', n: 1 },
  }, { keepId: true });
  return lg;
}

test('id と更新日時は withId のときだけ保存される', () => {
  const lg = leagueWith('X', 'lAbc12');
  lg.updatedAt = 1700000000000;
  assert.strictEqual(M.serializeLeague(lg).id, undefined);
  assert.strictEqual(M.serializeLeague(lg).updatedAt, undefined);
  const withId = M.serializeLeague(lg, { withId: true });
  assert.strictEqual(withId.id, 'lAbc12');
  assert.strictEqual(withId.updatedAt, 1700000000000);
  // 通常の取り込みは id を引き継がず、keepId のときだけ引き継ぐ
  assert.notStrictEqual(M.deserializeLeague(withId).id, 'lAbc12');
  const back = M.deserializeLeague(withId, { keepId: true });
  assert.strictEqual(back.id, 'lAbc12');
  assert.strictEqual(back.updatedAt, 1700000000000);
});

test('不正な id は引き継がず振り直す', () => {
  const raw = M.serializeLeague(leagueWith('X', 'ok1'), { withId: true });
  raw.id = '../evil name';
  assert.ok(M.ID_PATTERN.test(M.deserializeLeague(raw, { keepId: true }).id));
  assert.notStrictEqual(M.deserializeLeague(raw, { keepId: true }).id, raw.id);
});

test('ファイル名とリーグ id の相互変換、Gist URL からの ID 抽出', () => {
  assert.strictEqual(G.fileName('lab12'), 'league-simulator-lab12.json');
  assert.strictEqual(G.leagueIdOf('league-simulator-lab12.json'), 'lab12');
  assert.strictEqual(G.leagueIdOf('tycoon-filter-mute.csv'), null);
  assert.strictEqual(G.leagueIdOf('league-simulator-.json'), null);
  const id = '0123456789abcdef0123456789abcdef';
  assert.strictEqual(G.parseGistId(`https://gist.github.com/user/${id}`), id);
  assert.strictEqual(G.parseGistId('xyz'), '');
});

test('読み込み: リーグのファイルだけを取り出し、トークン無しでも読める', async () => {
  const lg = leagueWith('Aブロック', 'l1');
  const gh = fakeGitHub({
    [G.fileName('l1')]: { content: G.leagueFileText(M, lg) },
    'tycoon-filter-mute.csv': { content: 'type,value\n' },        // 他アプリのファイルは無視
    [G.fileName('l2')]: { content: 'x', truncated: true, raw_url: 'https://raw.example/l2' },
  });
  G.setFetch(gh.impl);
  const snap = await G.fetchLeagueFiles(gh.id);
  assert.deepStrictEqual(snap.files.map(f => f.id).sort(), ['l1', 'l2']);
  assert.strictEqual(snap.fileCount, 3);
  assert.strictEqual(snap.files.find(f => f.id === 'l2').text, 'RAW:https://raw.example/l2');
  assert.ok(!('Authorization' in gh.calls[0].headers), '読み取りにトークンは送らない');
});

test('存在しない Gist は日本語のエラー', async () => {
  G.setFetch(fakeGitHub({}).impl);
  await assert.rejects(() => G.fetchLeagueFiles('c'.repeat(32)), /Gistが見つかりません/);
});

test('書き込みにはトークンが必要で、指定したファイルだけが変わる', async () => {
  const gh = fakeGitHub({ keep: { content: 'そのまま' }, [G.fileName('l1')]: { content: 'old' } });
  G.setFetch(gh.impl);
  await assert.rejects(() => G.update(gh.id, { [G.fileName('l1')]: 'new' }), /トークン/);
  const store = {};
  global.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  try {
    G.setToken('  ghp_test  ');
    assert.strictEqual(G.getToken(), 'ghp_test');
    await G.update(gh.id, { [G.fileName('l1')]: 'new', [G.fileName('l3')]: 'added' });
    const files = gh.gists.get(gh.id).files;
    assert.strictEqual(files.keep.content, 'そのまま');
    assert.strictEqual(files[G.fileName('l1')].content, 'new');
    assert.strictEqual(files[G.fileName('l3')].content, 'added');
    assert.strictEqual(gh.calls.at(-1).headers.Authorization, 'Bearer ghp_test');
    await G.update(gh.id, { [G.fileName('l3')]: null });
    assert.ok(!(G.fileName('l3') in files), 'null で削除される');
  } finally {
    delete global.localStorage;
  }
});

test('未アップの目印: 最後にGistと同じだった内容と違うリーグだけが挙がる', () => {
  const store = {};
  global.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  try {
    const entries = [['l1', '内容A'], ['l2', '内容B']];
    assert.deepStrictEqual(G.unsyncedIds(entries), [], 'Gist ID が未設定なら何も挙げない');
    G.setConfig({ gistId: 'a'.repeat(32) });
    assert.deepStrictEqual(G.unsyncedIds(entries), ['l1', 'l2'], '記録がないリーグは未アップ');
    G.markSynced('l1', '内容A');
    assert.deepStrictEqual(G.unsyncedIds(entries), ['l2']);
    assert.deepStrictEqual(G.unsyncedIds([['l1', '内容A(編集後)'], ['l2', '内容B']]), ['l1', 'l2'], '内容が変わると未アップに戻る');
    G.setConfig({ gistId: 'b'.repeat(32) });
    assert.deepStrictEqual(G.unsyncedIds(entries), ['l1', 'l2'], '別のGistに切り替えると、突き合わせるまで未アップ');
    G.markSynced('l2', '内容B', 'a'.repeat(32));
    assert.deepStrictEqual(G.unsyncedIds(entries), ['l1', 'l2'], 'Gist ID を指定して記録すると、そのGistの分になる');
    store['league-simulator:gistSynced'] = '壊れたJSON';
    assert.deepStrictEqual(G.unsyncedIds(entries), ['l1', 'l2'], '記録が壊れていても落ちず、未アップ扱い');
  } finally {
    delete global.localStorage;
  }
});

test('Gist を作成するとシークレットで、リーグごとにファイルができる', async () => {
  const gh = fakeGitHub({});
  G.setFetch(gh.impl);
  global.localStorage = { getItem: () => 'ghp_x', setItem() {} };
  try {
    const id = await G.create('league-simulator', { [G.fileName('l1')]: 'a', [G.fileName('l2')]: 'b' });
    assert.strictEqual(id, 'b'.repeat(32));
    const post = gh.calls.at(-1);
    assert.strictEqual(post.body.public, false);
    assert.deepStrictEqual(Object.keys(gh.gists.get(id).files).sort(), [G.fileName('l1'), G.fileName('l2')]);
  } finally {
    delete global.localStorage;
  }
});

test('差分: 同じ / 端末のみ / Gistのみ / 内容が違う / 読めない', () => {
  const same = leagueWith('同じ', 's');
  const localOnly = leagueWith('端末のみ', 'lo');
  const differsLocal = leagueWith('違う', 'd', [{ a: 'A', b: 'B', outcome: 'win', winner: 'A' }]);
  differsLocal.updatedAt = 2000;
  const differsRemote = leagueWith('違う', 'd');
  differsRemote.updatedAt = 1000;
  const remoteOnly = leagueWith('Gistのみ', 'ro');
  const file = (id, text) => ({ id, file: G.fileName(id), text });
  const plan = G.buildPlan(M, [same, localOnly, differsLocal], [
    file('s', G.leagueFileText(M, same)),
    file('d', G.leagueFileText(M, differsRemote)),
    file('ro', G.leagueFileText(M, remoteOnly)),
    file('bad', '{ これはJSONではない'),
  ]);
  const byId = Object.fromEntries(plan.map(r => [r.id, r]));
  assert.strictEqual(byId.s.status, 'same');
  assert.strictEqual(byId.lo.status, 'local-only');
  assert.strictEqual(byId.d.status, 'differs');
  assert.strictEqual(byId.d.newer, 'local');
  assert.strictEqual(byId.ro.status, 'remote-only');
  assert.strictEqual(byId.ro.name, 'Gistのみ');
  assert.strictEqual(byId.bad.status, 'broken');
  assert.ok(byId.bad.error);
  // 並びは「この端末のリーグ → Gistのみ」
  assert.deepStrictEqual(plan.map(r => r.id), ['s', 'lo', 'd', 'ro', 'bad']);
});

test('内容の比較はキーの順番に左右されない(新規作成直後と読み込み直しで同じ)', () => {
  const lg = M.newLeague('x');
  const reread = M.parseImport(G.leagueFileText(M, lg), '', { keepId: true })[0];
  assert.strictEqual(G.signature(M, lg), G.signature(M, reread));
  reread.name = 'y';
  assert.notStrictEqual(G.signature(M, lg), G.signature(M, reread), '内容が変われば違う');
});

test('更新日時だけが違う場合は同じ内容として扱う', () => {
  const a = leagueWith('X', 'x'); a.updatedAt = 1;
  const b = leagueWith('X', 'x'); b.updatedAt = 2;
  const [row] = G.buildPlan(M, [a], [{ id: 'x', file: G.fileName('x'), text: G.leagueFileText(M, b) }]);
  assert.strictEqual(row.status, 'same');
});

test('書き込んだファイルを読み戻すと同じリーグになる(往復)', () => {
  const lg = leagueWith('往復', 'rt', [{ a: 'A', b: 'B', outcome: 'win', winner: 'B' }, { a: 'B', b: 'C', outcome: 'draw' }]);
  lg.updatedAt = 12345;
  const [back] = M.parseImport(G.leagueFileText(M, lg), '', { keepId: true });
  assert.strictEqual(back.id, 'rt');
  assert.strictEqual(back.updatedAt, 12345);
  assert.strictEqual(G.signature(M, back), G.signature(M, lg));
});

chain.then(() => {
  G.setFetch(null);
  if (failed) { console.log(`\n${failed} 件失敗`); process.exit(1); }
  console.log('\nすべて成功');
});
