/**
 * リーグのデータモデルと、保存/読み込み(エクスポート・インポート)形式
 *
 * 保存形式（localStorage もエクスポートファイルも同じ。人が読める・編集できるよう名前で参照する）
 * {
 *   "app": "league-simulator", "version": 1,
 *   "leagues": [{
 *     "name": "Aブロック",
 *     "participants": ["竹下", "後藤", ...],
 *     "outcomes": [
 *       { "id":"win",  "name":"勝ち",   "kind":"decisive", "win":2, "lose":0, "mark":"○", "loseMark":"●", "simulate":true },
 *       { "id":"draw", "name":"引き分け","kind":"shared",   "pts":1,            "mark":"△", "simulate":false }
 *     ],
 *     "matches": [ { "a":"竹下", "b":"後藤", "outcome":"win", "winner":"竹下" }, ... ],
 *     "target": { "mode":"within", "n":2 }
 *   }]
 * }
 * 書かれていない組み合わせは「未実施」。
 */
(function (root) {
  'use strict';

  const E = (typeof module !== 'undefined' && module.exports) ? require('./engine.js') : root.LeagueEngine;
  const { pairKey } = E;

  const APP_ID = 'league-simulator';
  const FORMAT_VERSION = 1;
  const MAX_PARTICIPANTS = 24;

  const makeId = prefix => prefix + Math.random().toString(36).slice(2, 8);

  function defaultOutcomes() {
    return [
      { id: 'win', name: '勝ち', kind: 'decisive', win: 2, lose: 0, mark: '○', loseMark: '●', simulate: true },
      { id: 'draw', name: '引き分け', kind: 'shared', pts: 1, mark: '△', simulate: false },
      { id: 'void', name: '無効試合', kind: 'shared', pts: 0, mark: '─', simulate: false },
      { id: 'forfeit', name: '不戦勝', kind: 'decisive', win: 2, lose: 0, mark: '◻', loseMark: '▪', simulate: false },
    ];
  }

  function newLeague(name) {
    return {
      id: makeId('l'), name: name || '新しいリーグ',
      participants: [], outcomes: defaultOutcomes(), results: {},
      target: { mode: 'within', n: 1 },
    };
  }

  // ─────────────────────────────────────────────
  // 内部表現 ⇔ 保存形式
  // ─────────────────────────────────────────────

  // opts.withId: 端末内の保存やGist同期用に、リーグの id と更新日時も含める(ファイルのエクスポートには含めない)
  function serializeLeague(lg, opts) {
    const ps = lg.participants;
    const nameOf = id => (ps.find(p => p.id === id) || {}).name;
    const matches = [];
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const r = lg.results[pairKey(ps[i].id, ps[j].id)];
        if (!r) continue;
        const m = { a: ps[i].name, b: ps[j].name, outcome: r.outcome };
        if (r.winner) m.winner = nameOf(r.winner);
        matches.push(m);
      }
    }
    const out = {};
    if (opts && opts.withId) {
      out.id = lg.id;
      if (isNum(lg.updatedAt)) out.updatedAt = lg.updatedAt;
    }
    return Object.assign(out, {
      name: lg.name,
      participants: ps.map(p => p.name),
      outcomes: lg.outcomes.map(o => Object.assign({}, o)),
      matches,
      target: Object.assign({}, lg.target),
    });
  }

  const isNum = v => typeof v === 'number' && isFinite(v);
  const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

  // opts.keepId: 保存データやGistから戻すときに、raw の id と更新日時を引き継ぐ(通常の取り込みは新しい id を振る)
  function deserializeLeague(raw, opts) {
    if (!raw || typeof raw !== 'object') throw new Error('リーグのデータが不正です');
    const label = `リーグ「${raw.name || ''}」`;

    if (!Array.isArray(raw.participants)) throw new Error(`${label}: participants が配列ではありません`);
    const names = raw.participants.map(s => String(s).trim());
    if (names.some(s => !s)) throw new Error(`${label}: 空の参加者名があります`);
    if (new Set(names).size !== names.length) throw new Error(`${label}: 参加者名が重複しています`);
    if (names.length > MAX_PARTICIPANTS) throw new Error(`${label}: 参加者は${MAX_PARTICIPANTS}名までです`);

    const outcomesRaw = Array.isArray(raw.outcomes) && raw.outcomes.length ? raw.outcomes : defaultOutcomes();
    const seen = new Set();
    const outcomes = outcomesRaw.map(o => {
      if (!o || !o.id || seen.has(o.id)) throw new Error(`${label}: 結果の種類の id が不正または重複しています`);
      seen.add(o.id);
      const base = { id: String(o.id), name: String(o.name || o.id), simulate: !!o.simulate };
      if (o.kind === 'shared') {
        if (!isNum(o.pts)) throw new Error(`${label}: 「${base.name}」の pts が数値ではありません`);
        return Object.assign(base, { kind: 'shared', pts: o.pts, mark: String(o.mark || base.name.slice(0, 1)) });
      }
      if (!isNum(o.win) || !isNum(o.lose)) throw new Error(`${label}: 「${base.name}」の win / lose が数値ではありません`);
      return Object.assign(base, {
        kind: 'decisive', win: o.win, lose: o.lose,
        mark: String(o.mark || '勝'), loseMark: String(o.loseMark || '負'),
      });
    });
    const outById = new Map(outcomes.map(o => [o.id, o]));

    const participants = names.map(name => ({ id: makeId('p'), name }));
    const idOf = new Map(participants.map(p => [p.name, p.id]));

    const results = {};
    for (const m of (raw.matches || [])) {
      const a = idOf.get(m.a), b = idOf.get(m.b);
      if (!a) throw new Error(`${label}: 不明な参加者「${m.a}」が試合結果に含まれています`);
      if (!b) throw new Error(`${label}: 不明な参加者「${m.b}」が試合結果に含まれています`);
      if (a === b) throw new Error(`${label}: 同じ参加者同士の試合「${m.a}」があります`);
      const o = outById.get(m.outcome);
      if (!o) throw new Error(`${label}: ${m.a} vs ${m.b} の結果「${m.outcome}」は outcomes にありません`);
      const key = pairKey(a, b);
      if (results[key]) throw new Error(`${label}: ${m.a} vs ${m.b} の結果が重複しています`);
      if (o.kind === 'decisive') {
        const w = idOf.get(m.winner);
        if (w !== a && w !== b) throw new Error(`${label}: ${m.a} vs ${m.b} の winner は2人のどちらかにしてください`);
        results[key] = { outcome: o.id, winner: w };
      } else {
        results[key] = { outcome: o.id };
      }
    }

    const t = raw.target || {};
    const target = {
      mode: t.mode === 'exact' ? 'exact' : 'within',
      n: Math.min(Math.max(parseInt(t.n, 10) || 1, 1), Math.max(names.length, 1)),
    };
    const keep = !!(opts && opts.keepId);
    const lg = {
      id: keep && typeof raw.id === 'string' && ID_PATTERN.test(raw.id) ? raw.id : makeId('l'),
      name: String(raw.name || '無題のリーグ'), participants, outcomes, results, target,
    };
    if (keep && isNum(raw.updatedAt)) lg.updatedAt = raw.updatedAt;
    return lg;
  }

  function exportFile(leagues, opts) {
    return {
      app: APP_ID, version: FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      leagues: leagues.map(lg => serializeLeague(lg, opts)),
    };
  }

  // ─────────────────────────────────────────────
  // 既存ツール(league.js)の形式の取り込み
  // ─────────────────────────────────────────────

  // pairs: [{a, b, status:'win'|'loss'|'draw'|'void'}]  win は a の勝ち
  function legacyToRaw(name, names, scoring, simulate, pairs) {
    const outcomes = [{
      id: 'win', name: '勝ち', kind: 'decisive', win: scoring.win, lose: scoring.loss,
      mark: '○', loseMark: '●', simulate: true,
    }];
    if (scoring.draw !== undefined) {
      outcomes.push({ id: 'draw', name: '引き分け', kind: 'shared', pts: scoring.draw, mark: '△', simulate: simulate.draw === true });
    }
    if (scoring.void !== undefined) {
      outcomes.push({ id: 'void', name: '無効試合', kind: 'shared', pts: scoring.void, mark: '─', simulate: simulate.void === true });
    }
    const matches = pairs.map(({ a, b, status }) => {
      if (status === 'win') return { a, b, outcome: 'win', winner: a };
      if (status === 'loss') return { a, b, outcome: 'win', winner: b };
      return { a, b, outcome: status };
    });
    return { name, participants: names, outcomes, matches, target: { mode: 'within', n: 1 } };
  }

  function parseKeyValues(str, lineNo) {
    const out = {};
    for (const token of str.trim().split(/\s+/).filter(Boolean)) {
      const m = token.match(/^([a-zA-Z_]+)=(.+)$/);
      if (!m) throw new Error(`不正な指定「${token}」(行:${lineNo}) 形式は key=値 です`);
      out[m[1]] = m[2];
    }
    return out;
  }

  // 「竹下 > 後藤」形式のテキスト
  function parsePlainText(text, name) {
    let names = null, scoringRaw = null, simulateRaw = null;
    const statements = [];
    text.split(/\r?\n/).forEach((rawLine, idx) => {
      const lineNo = idx + 1;
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) return;
      let m;
      if ((m = line.match(/^participants\s*:\s*(.+)$/i))) { names = m[1].trim().split(/[\s,、]+/).filter(Boolean); return; }
      if ((m = line.match(/^scoring\s*:\s*(.+)$/i))) { scoringRaw = parseKeyValues(m[1], lineNo); return; }
      if ((m = line.match(/^simulate\s*:\s*(.+)$/i))) { simulateRaw = parseKeyValues(m[1], lineNo); return; }
      const tk = line.split(/\s+/);
      if (tk.length !== 3 || !['>', '<', '=', 'x'].includes(tk[1])) {
        throw new Error(`解釈できない行です (行:${lineNo}): "${line}"\n試合結果は「参加者名 記号 参加者名」(記号は > < = x)の形式で書いてください`);
      }
      statements.push({ a: tk[0], op: tk[1], b: tk[2], lineNo });
    });

    if (!names || names.length < 2) throw new Error('「participants: 名前1 名前2 ...」の行が必要です(2名以上)');
    if (!scoringRaw || scoringRaw.win === undefined || scoringRaw.loss === undefined) {
      throw new Error('「scoring: win=数値 loss=数値 ...」の行が必要です(win, loss は必須)');
    }
    const num = v => (v === undefined ? undefined : Number(v));
    const scoring = { win: num(scoringRaw.win), loss: num(scoringRaw.loss), draw: num(scoringRaw.draw), void: num(scoringRaw.void) };
    if (Number.isNaN(scoring.win) || Number.isNaN(scoring.loss)) throw new Error('scoring の win / loss は数値にしてください');

    const simulate = {};
    for (const key of ['draw', 'void']) {
      const v = simulateRaw ? simulateRaw[key] : undefined;
      if (v === undefined) continue;
      if (v !== 'true' && v !== 'false') throw new Error(`simulate の ${key} は true か false で指定してください`);
      simulate[key] = v === 'true';
    }

    const known = new Set(names);
    const seen = new Set();
    const pairs = statements.map(({ a, op, b, lineNo }) => {
      if (!known.has(a)) throw new Error(`不明な参加者名「${a}」(行:${lineNo})`);
      if (!known.has(b)) throw new Error(`不明な参加者名「${b}」(行:${lineNo})`);
      if (a === b) throw new Error(`同一人物同士は指定できません「${a}」(行:${lineNo})`);
      const key = pairKey(a, b);
      if (seen.has(key)) throw new Error(`「${a}」と「${b}」の対戦が複数回書かれています(行:${lineNo})`);
      seen.add(key);
      const status = { '>': 'win', '<': 'loss', '=': 'draw', x: 'void' }[op];
      if (status === 'draw' && scoring.draw === undefined) throw new Error(`引き分けには scoring の draw が必要です(行:${lineNo})`);
      if (status === 'void' && scoring.void === undefined) throw new Error(`無効試合には scoring の void が必要です(行:${lineNo})`);
      return { a, b, status };
    });
    return legacyToRaw(name, names, scoring, simulate, pairs);
  }

  // 星取マトリクス形式のJSON（w/l/d/x と空文字）
  function parseMatrixJson(cfg, name) {
    const names = cfg.participants.map(String);
    if (new Set(names).size !== names.length) throw new Error('participants に重複する名前があります');
    const sc = cfg.scoring || {};
    if (!isNum(sc.win) || !isNum(sc.loss)) throw new Error('scoring には win, loss (数値) が必要です');
    const scoring = { win: sc.win, loss: sc.loss, draw: isNum(sc.draw) ? sc.draw : undefined, void: isNum(sc.void) ? sc.void : undefined };
    const meaning = { w: 'win', l: 'loss', d: 'draw', x: 'void', '': 'pending' };
    const opposite = { win: 'loss', loss: 'win', draw: 'draw', void: 'void', pending: 'pending' };
    const results = cfg.results || {};
    const pairs = [];
    for (let i = 0; i < names.length; i++) {
      if (!Array.isArray(results[names[i]]) || results[names[i]].length !== names.length) {
        throw new Error(`results["${names[i]}"] は参加者数(${names.length})と同じ長さの配列にしてください`);
      }
    }
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const ca = results[names[i]][j], cb = results[names[j]][i];
        if (!(ca in meaning) || !(cb in meaning)) throw new Error(`不正な記号: ${names[i]} vs ${names[j]} (使えるのは w,l,d,x,空文字)`);
        const ma = meaning[ca], mb = meaning[cb];
        let status;
        if (ma === 'pending') status = opposite[mb];
        else if (mb === 'pending') status = ma;
        else if (opposite[ma] !== mb) throw new Error(`矛盾する結果: ${names[i]} vs ${names[j]}`);
        else status = ma;
        if (status === 'pending') continue;
        if (status === 'draw' && scoring.draw === undefined) throw new Error('引き分けがありますが scoring.draw がありません');
        if (status === 'void' && scoring.void === undefined) throw new Error('無効試合がありますが scoring.void がありません');
        pairs.push({ a: names[i], b: names[j], status });
      }
    }
    return legacyToRaw(name, names, scoring, cfg.simulate || {}, pairs);
  }

  /**
   * ファイルの中身を判別して、リーグ(内部表現)の配列にする
   *  - このアプリのエクスポートファイル
   *  - 星取マトリクス形式のJSON / 「竹下 > 後藤」形式のテキスト（league.js の入力ファイル）
   */
  function parseImport(text, fileName, opts) {
    const baseName = (fileName || '').replace(/\.[^.]+$/, '') || 'インポート';
    const trimmed = text.trim();
    if (!trimmed) throw new Error('内容が空です');

    let raws;
    if (trimmed[0] === '{' || trimmed[0] === '[') {
      let obj;
      try { obj = JSON.parse(trimmed); } catch (e) { throw new Error('JSONとして読み込めません: ' + e.message); }
      if (obj && obj.app === APP_ID && Array.isArray(obj.leagues)) {
        if (obj.version > FORMAT_VERSION) throw new Error('新しいバージョンのファイルです。アプリを更新してください');
        raws = obj.leagues;
      } else if (obj && Array.isArray(obj.participants) && obj.results && !Array.isArray(obj.results)) {
        raws = [parseMatrixJson(obj, baseName)];
      } else if (obj && Array.isArray(obj.participants)) {
        raws = [obj];
      } else {
        throw new Error('対応していないJSON形式です');
      }
    } else {
      raws = [parsePlainText(trimmed, baseName)];
    }
    return raws.map(raw => deserializeLeague(raw, opts));
  }

  const api = { MAX_PARTICIPANTS, ID_PATTERN, makeId, defaultOutcomes, newLeague, serializeLeague, deserializeLeague, exportFile, parseImport };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LeagueModel = api;
})(typeof self !== 'undefined' ? self : globalThis);
