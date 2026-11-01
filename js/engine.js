/**
 * リーグ戦シミュレーションの計算エンジン（DOM に依存しない）
 *
 * ブラウザ(メインスレッド)・Web Worker・Node.js のどれからでも読み込める。
 *
 * 順位の決め方:
 *   1. 勝ち点の多い順
 *   2. 同点者が複数いれば「同点者同士の対戦だけ」で勝ち点を再計算して分割
 *   3. 分割後に同点が残るグループには同じ処理を再帰的に適用
 *   4. それでも分割できない(三すくみなど)グループは「決定戦が必要」
 */
(function (root) {
  'use strict';

  // 勝ち点を整数で扱うための倍率（0.5点などの小数を浮動小数点誤差なしで比較するため）
  const SCALE = 1000;

  const pairKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);

  // ─────────────────────────────────────────────
  // 問題の組み立て（リーグ定義 → 計算用の配列）
  // ─────────────────────────────────────────────

  // 1試合の結果から [先に書いた側の点, 後の側の点] を返す。解釈できなければ null
  function matchPoints(outcome, result, idA, idB) {
    if (outcome.kind === 'shared') return [outcome.pts, outcome.pts];
    if (result.winner === idA) return [outcome.win, outcome.lose];
    if (result.winner === idB) return [outcome.lose, outcome.win];
    return null;
  }

  /**
   * league: { participants:[{id,name}], outcomes:[...], results:{ "idA|idB": {outcome, winner?} } }
   * 戻り値は structured clone で Worker に渡せるプレーンな形。
   */
  function compile(league) {
    const ps = league.participants;
    const n = ps.length;
    const outcomeById = new Map(league.outcomes.map(o => [o.id, o]));
    const basePts = new Float64Array(n);
    const h2h = new Float64Array(n * n); // h2h[i*n+j] = i が j との対戦で得た点（確定分）
    const pending = [];

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const r = league.results[pairKey(ps[i].id, ps[j].id)];
        const o = r && outcomeById.get(r.outcome);
        const mp = o && matchPoints(o, r, ps[i].id, ps[j].id);
        if (!mp) { pending.push({ i, j }); continue; }
        const a = Math.round(mp[0] * SCALE);
        const b = Math.round(mp[1] * SCALE);
        basePts[i] += a; basePts[j] += b;
        h2h[i * n + j] = a; h2h[j * n + i] = b;
      }
    }

    // 未実施試合1つあたりに取り得る結果（シミュレート対象にチェックが入った結果だけ）
    // winner: 'i'=先に書いた側の勝ち, 'j'=後の側の勝ち, null=双方同点
    const options = [];
    for (const o of league.outcomes) {
      if (!o.simulate) continue;
      if (o.kind === 'shared') {
        const p = Math.round(o.pts * SCALE);
        options.push({ outcome: o.id, winner: null, pi: p, pj: p });
      } else {
        const w = Math.round(o.win * SCALE), l = Math.round(o.lose * SCALE);
        options.push({ outcome: o.id, winner: 'i', pi: w, pj: l });
        options.push({ outcome: o.id, winner: 'j', pi: l, pj: w });
      }
    }

    return { n, names: ps.map(p => p.name), scale: SCALE, basePts, h2h, pending, options };
  }

  function countPatterns(problem) {
    const k = problem.pending.length;
    if (k === 0) return 1;
    return Math.pow(problem.options.length, k);
  }

  // ─────────────────────────────────────────────
  // 順位付け
  // ─────────────────────────────────────────────

  /**
   * pts / h2h を参照するだけの順位計算器。呼び出し側が pts と h2h を書き換えてから rank() を呼ぶ。
   * rank() 後、posStart[p] = 参加者 p の順位（同順位は先頭の順位）、
   *            posSize[p]  = p が属する「決着のつかない同順位グループ」の人数
   * 例: 3人が2位タイ → 3人とも posStart=2, posSize=3（2〜4位のどこに入るか未定）
   */
  function makeRanker(n, pts, h2h) {
    const order = new Int32Array(n);
    const posStart = new Int32Array(n);
    const posSize = new Int32Array(n);

    function assign(group, start) {
      const len = group.length;
      if (len === 1) { posStart[group[0]] = start; posSize[group[0]] = 1; return; }

      // グループ内の対戦だけで勝ち点を数え直す
      const sp = new Array(len);
      for (let x = 0; x < len; x++) {
        let t = 0;
        const a = group[x];
        for (let y = 0; y < len; y++) if (y !== x) t += h2h[a * n + group[y]];
        sp[x] = t;
      }
      const idx = group.map((_, x) => x).sort((x, y) => sp[y] - sp[x] || x - y);

      // 全員同じ → これ以上分けられない（三すくみ等）= 決定戦
      if (sp[idx[0]] === sp[idx[len - 1]]) {
        for (const a of group) { posStart[a] = start; posSize[a] = len; }
        return;
      }
      // 分けられた → 同じ値のクラスタごとに再帰
      let pos = start, s = 0;
      while (s < len) {
        let e = s + 1;
        while (e < len && sp[idx[e]] === sp[idx[s]]) e++;
        assign(idx.slice(s, e).map(x => group[x]), pos);
        pos += e - s;
        s = e;
      }
    }

    function rank() {
      // 挿入ソート(勝ち点降順・同点は参加者順)。n が小さいので十分速い
      for (let a = 0; a < n; a++) {
        const pv = pts[a];
        let b = a - 1;
        while (b >= 0 && pts[order[b]] < pv) { order[b + 1] = order[b]; b--; }
        order[b + 1] = a;
      }
      let s = 0;
      while (s < n) {
        const pv = pts[order[s]];
        let e = s + 1;
        while (e < n && pts[order[e]] === pv) e++;
        if (e - s === 1) {
          posStart[order[s]] = s + 1; posSize[order[s]] = 1;
        } else {
          const g = [];
          for (let x = s; x < e; x++) g.push(order[x]);
          assign(g, s + 1);
        }
        s = e;
      }
    }

    return { rank, posStart, posSize };
  }

  function createState(problem) {
    const pts = Float64Array.from(problem.basePts);
    const h2h = Float64Array.from(problem.h2h);
    return { pts, h2h, ranker: makeRanker(problem.n, pts, h2h) };
  }

  // 未実施試合 pend の全組み合わせを深さ優先で列挙する。
  // 各葉で onLeaf(code) を呼ぶ。code は結果番号を m 進数で並べた通し番号（昇順に呼ばれる）
  function enumerateAll(state, problem, pend, onLeaf) {
    const { pts, h2h } = state;
    const n = problem.n;
    const m = problem.options.length;
    const k = pend.length;
    const optPi = problem.options.map(o => o.pi);
    const optPj = problem.options.map(o => o.pj);
    const I = pend.map(p => p.i);
    const J = pend.map(p => p.j);

    function rec(d, code) {
      if (d === k) { onLeaf(code); return; }
      const i = I[d], j = J[d];
      const ij = i * n + j, ji = j * n + i;
      for (let o = 0; o < m; o++) {
        const a = optPi[o], b = optPj[o];
        pts[i] += a; pts[j] += b;
        h2h[ij] = a; h2h[ji] = b;
        rec(d + 1, code * m + o);
        pts[i] -= a; pts[j] -= b;
      }
    }
    rec(0, 0);
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ─────────────────────────────────────────────
  // 全体集計
  // ─────────────────────────────────────────────

  /**
   * opts: { lo, hi, mode:'exhaustive'|'sample', sampleN, seed }
   *   [lo, hi] が「狙う順位の範囲」（1位以内なら 1〜1、2位以内なら 1〜2、ちょうど2位なら 2〜2）
   *
   * 参加者 p の順位の幅 [s, e]（同点で決着しない場合は s〜s+人数-1）と比べて
   *   範囲に完全に収まる → certain（確定）
   *   一部だけ重なる     → playoff（決定戦が必要）
   *   重ならない         → 圏外
   */
  function run(problem, opts, onProgress) {
    const { n, pending, options } = problem;
    const k = pending.length, m = options.length;
    if (k > 0 && m === 0) throw new Error('未実施試合の予測に使う結果が選ばれていません');
    const { lo, hi } = opts;
    const total = countPatterns(problem);
    const sample = opts.mode === 'sample';
    const planned = sample ? opts.sampleN : total;

    const st = createState(problem);
    const { rank, posStart, posSize } = st.ranker;
    const hist = new Float64Array(n * (n + 1));
    const certain = new Float64Array(n);
    const playoff = new Float64Array(n);
    const ties = new Map();
    let processed = 0;

    function leaf() {
      rank();
      let seen = 0;
      for (let p = 0; p < n; p++) {
        const s = posStart[p], e = s + posSize[p] - 1;
        hist[p * (n + 1) + s]++;
        if (s >= lo && e <= hi) {
          certain[p]++;
        } else if (e >= lo && s <= hi) {
          playoff[p]++;
          if (!(seen & (1 << s))) {
            seen |= 1 << s;
            let mask = 0;
            for (let q = 0; q < n; q++) if (posStart[q] === s) mask |= 1 << q;
            ties.set(mask, (ties.get(mask) || 0) + 1);
          }
        }
      }
      processed++;
      if (onProgress && (processed & 0xFFFF) === 0) onProgress(processed, planned);
    }

    if (sample) {
      const rng = mulberry32(opts.seed || 1);
      const { pts, h2h } = st;
      for (let s = 0; s < opts.sampleN; s++) {
        pts.set(problem.basePts);
        for (let d = 0; d < k; d++) {
          const o = options[Math.floor(rng() * m)];
          const { i, j } = pending[d];
          pts[i] += o.pi; pts[j] += o.pj;
          h2h[i * n + j] = o.pi; h2h[j * n + i] = o.pj;
        }
        leaf();
      }
    } else {
      enumerateAll(st, problem, pending, leaf);
    }

    return {
      mode: sample ? 'sample' : 'exhaustive',
      total, processed, lo, hi,
      hist, certain, playoff,
      ties: [...ties].map(([mask, count]) => ({ mask, count })),
    };
  }

  // ─────────────────────────────────────────────
  // 特定の参加者が条件を満たす結果パターンの一覧（圧縮表示用）
  // ─────────────────────────────────────────────

  /**
   * 結果番号の通し番号(code)の昇順リストを、ひと塊の条件(キューブ)に圧縮する。
   * 各変数(=1試合)について「この試合は A or B ならどちらでもよい」という選択肢の集合を持つ。
   * 同じ後続を持つ枝を束ねる(MDD を作って経路を列挙する)ので、行同士は重ならず、
   * 行の count を合計すると元のパターン数に一致する。
   */
  function buildCubes(codes, k, m, maxRows) {
    const count = codes.length;
    if (!count) return { rows: [], truncated: false };

    const pw = new Array(k);
    if (k > 0) pw[k - 1] = 1;
    for (let L = k - 2; L >= 0; L--) pw[L] = pw[L + 1] * m;
    const digit = (c, L) => Math.floor(c / pw[L]) % m;

    // ノード 0=偽(該当なし), 1=真(全部満たす)
    const level = [k, k];
    const kids = [null, null];
    const unique = new Map();

    function build(L, lo, hi) {
      if (L === k) return 1;
      const children = new Array(m).fill(0);
      let s = lo;
      while (s < hi) {
        const d = digit(codes[s], L);
        let e = s + 1;
        while (e < hi && digit(codes[e], L) === d) e++;
        children[d] = build(L + 1, s, e);
        s = e;
      }
      const first = children[0];
      if (children.every(c => c === first)) return first; // この試合はどの結果でも同じ → 条件から外す
      const key = L + ':' + children.join(',');
      let id = unique.get(key);
      if (id === undefined) {
        id = level.length;
        level.push(L); kids.push(children);
        unique.set(key, id);
      }
      return id;
    }

    const root = build(0, 0, count);
    const rows = [];
    let truncated = false;
    const cells = new Array(k).fill(null);

    function walk(id, L, mult) {
      if (rows.length >= maxRows) { truncated = true; return; }
      if (id === 1) {
        for (let l = L; l < k; l++) cells[l] = null;
        rows.push({ cells: cells.slice(), count: mult * Math.pow(m, k - L) });
        return;
      }
      const nl = level[id];
      const skip = Math.pow(m, nl - L);
      const groups = new Map(); // 子ノード → その子に進む結果番号の集合
      kids[id].forEach((c, v) => {
        if (c === 0) return;
        if (!groups.has(c)) groups.set(c, []);
        groups.get(c).push(v);
      });
      for (const [c, vals] of groups) {
        for (let l = L; l < nl; l++) cells[l] = null;
        cells[nl] = vals;
        walk(c, nl + 1, mult * skip * vals.length);
        if (truncated) return;
      }
      cells[nl] = null;
    }
    walk(root, 0, 1);
    rows.sort((a, b) => b.count - a.count);
    return { rows, truncated };
  }

  /**
   * focus 番の参加者について、[lo,hi] に「確定で入る」パターンと「決定戦になる」パターンを集めて圧縮する。
   * focus 自身の試合を先頭に並べ替えて列挙するので、条件が読みやすくなる。
   * opts: { focus, lo, hi, cap, maxRows }
   */
  function detail(problem, opts) {
    const { n, pending, options } = problem;
    const { focus, lo, hi } = opts;
    const cap = opts.cap || 3000000;
    const maxRows = opts.maxRows || 10000;
    const k = pending.length, m = options.length;
    if (k > 0 && m === 0) throw new Error('未実施試合の予測に使う結果が選ばれていません');

    const order = [];
    pending.forEach((p, x) => { if (p.i === focus || p.j === focus) order.push(x); });
    pending.forEach((p, x) => { if (p.i !== focus && p.j !== focus) order.push(x); });
    const pend = order.map(x => pending[x]);

    const st = createState(problem);
    const { rank, posStart, posSize } = st.ranker;
    const certainCodes = [];
    const playMap = new Map(); // 同順位グループ(mask) → code[]
    let stored = 0;
    let overflow = false;
    const STOP = {};

    function leaf(code) {
      rank();
      const s = posStart[focus], e = s + posSize[focus] - 1;
      if (s >= lo && e <= hi) {
        certainCodes.push(code);
      } else if (e >= lo && s <= hi) {
        let mask = 0;
        for (let q = 0; q < n; q++) if (posStart[q] === s) mask |= 1 << q;
        let list = playMap.get(mask);
        if (!list) playMap.set(mask, list = []);
        list.push(code);
      } else {
        return;
      }
      if (++stored >= cap) { overflow = true; throw STOP; }
    }

    try {
      enumerateAll(st, problem, pend, leaf);
    } catch (err) {
      if (err !== STOP) throw err;
    }

    // 行数は全体で maxRows まで（確定の条件を優先し、残りを件数の多い決定戦グループから割り当てる）
    let budget = maxRows;
    const certain = Object.assign({ count: certainCodes.length }, buildCubes(certainCodes, k, m, budget));
    budget -= certain.rows.length;
    const playoffs = [...playMap]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([mask, codes]) => {
        const cubes = budget > 0 ? buildCubes(codes, k, m, budget) : { rows: [], truncated: true };
        budget -= cubes.rows.length;
        return Object.assign({ mask, count: codes.length }, cubes);
      });

    return { focus, lo, hi, order, k, m, overflow, certain, playoffs };
  }

  const api = { SCALE, pairKey, compile, countPatterns, run, detail, buildCubes, makeRanker };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LeagueEngine = api;
})(typeof self !== 'undefined' ? self : globalThis);
