/**
 * 「条件」の1行に当てはまる結果パターンを、全試合が埋まった星取表として描画する。
 * 画面(app.js)と、書き出した静的HTMLの両方から使う(DOM と LeagueEngine だけに依存)。
 */
(function (root) {
  'use strict';

  const E = root.LeagueEngine;

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k in el) el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const fmt = v => v.toLocaleString('ja-JP');
  const fmtPts = v => String(Math.round(v * 1000) / 1000);
  const namesOf = (names, mask, except) => names.filter((_, i) => (mask & (1 << i)) && i !== except);

  function targetLabel(t) {
    return t.mode === 'exact' ? `ちょうど${t.n}位` : `${t.n}位以内`;
  }

  // 1試合の結果 res を、rowId の選手から見た星取表のマスにする
  function cellFromResult(outcomes, res, rowId) {
    const o = res && outcomes.find(x => x.id === res.outcome);
    if (!o) return { text: '', cls: 'cell-pending', label: '未実施' };
    if (o.kind === 'shared') return { text: o.mark, cls: 'cell-shared', label: o.name };
    return res.winner === rowId
      ? { text: o.mark, cls: 'cell-win', label: o.mark }
      : { text: o.loseMark, cls: 'cell-lose', label: o.loseMark };
  }

  /**
   * snap: { names, n, problem, league:{participants,results}, outcomes, target }
   * d: 1人分の条件(E.detail の結果)、x: その中の1行 { kind, row, mask }
   * open(title, body): ダイアログを開く関数。body は .dlg-body の中に置かれる想定
   */
  /**
   * 条件の1行(x)に当てはまる結果パターンを、全試合が埋まった星取表としてすべて描画する。
   * 未実施だった試合(シミュレーションした結果)のマスは暖色の背景にする。
   * 件数が多くても固まらないよう、スクロールに合わせて少しずつ描画する。
   */
  function show(snap, d, x, open) {
    const { names, n, problem, league, outcomes } = snap;
    const ps = league.participants;
    const { options } = problem;
    const pend = d.order.map(i => problem.pending[i]);
    const k = pend.length;
    // 試合ごとの取り得る結果。条件で「どれでもよい」(null)の試合は全結果
    const sets = x.row.cells.map(c => c || options.map((_, o) => o));
    const total = x.row.count;
    const focus = d.focus;

    const pts = new Float64Array(n);
    const h2h = new Float64Array(n * n);
    const ranker = E.makeRanker(n, pts, h2h);
    const simOpt = new Int32Array(n * n);

    function buildBoard(idx) {
      // idx 番目の組み合わせ(各試合の結果の選び方)を、桁ごとに取り出す
      let rest = idx;
      pts.set(problem.basePts); h2h.set(problem.h2h); simOpt.fill(-1);
      for (let v = k - 1; v >= 0; v--) {
        const s = sets[v];
        const o = s[rest % s.length];
        rest = Math.floor(rest / s.length);
        const { i, j } = pend[v];
        const opt = options[o];
        pts[i] += opt.pi; pts[j] += opt.pj;
        h2h[i * n + j] = opt.pi; h2h[j * n + i] = opt.pj;
        simOpt[i * n + j] = o;
      }
      ranker.rank();

      const head = h('tr', {}, h('th', {}),
        names.map(nm => h('th', { scope: 'col' }, h('div', { class: 'vname' }, nm))),
        h('th', { class: 'rk' }, '勝ち点'), h('th', { class: 'rk' }, '順位'));
      const body = names.map((nm, r) => {
        const cells = names.map((_, c) => {
          if (r === c) return h('td', { class: 'self' });
          const i = Math.min(r, c), j = Math.max(r, c);
          const so = simOpt[i * n + j];
          let info;
          if (so >= 0) {
            const opt = options[so];
            const winner = opt.winner === 'i' ? ps[i].id : opt.winner === 'j' ? ps[j].id : undefined;
            info = cellFromResult(outcomes, { outcome: opt.outcome, winner }, ps[r].id);
            info.cls += ' sim';
          } else {
            info = cellFromResult(outcomes, league.results[E.pairKey(ps[r].id, ps[c].id)], ps[r].id);
          }
          return h('td', { class: info.cls, title: so >= 0 ? 'シミュレーションした結果' : null }, info.text);
        });
        const s = ranker.posStart[r], z = ranker.posSize[r];
        return h('tr', { class: r === focus ? 'focus' : '' },
          h('th', { scope: 'row', class: 'rname' }, nm), cells,
          h('td', { class: 'rk' }, fmtPts(pts[r] / E.SCALE)),
          h('td', { class: 'rk' + (z > 1 ? ' tie' : ''), title: z > 1 ? '同点で決着がつかない(決定戦)' : null },
            z > 1 ? `${s}〜${s + z - 1}位` : `${s}位`));
      });
      return h('div', { class: 'board' },
        h('div', { class: 'board-no' }, `#${fmt(idx + 1)}`),
        h('div', { class: 'table-wrap' }, h('table', { class: 'star mini' }, h('thead', {}, head), h('tbody', {}, body))));
    }

    const verdict = x.kind === 'certain'
      ? h('span', { class: 'chip ok' }, '確定')
      : h('span', { class: 'chip warn' }, `決定戦 vs ${namesOf(names, x.mask, focus).join('・')}`);
    const legend = h('div', { class: 'legend', style: 'margin:8px 0 12px' },
      h('span', {}, h('span', { class: 'sw sim' }, '○'), '暖色のマス = 未実施だった試合のシミュレーション結果'),
      outcomes.map(o => (o.kind === 'shared'
        ? h('span', {}, h('span', { class: 'sw cell-shared' }, o.mark), o.name)
        : h('span', {}, h('span', { class: 'sw cell-win' }, o.mark), h('span', { class: 'sw cell-lose' }, o.loseMark), o.name))));

    const grid = h('div', { class: 'boards' });
    const status = h('div', { class: 'muted', style: 'text-align:center;padding:10px' });
    let shown = 0;
    const appendChunk = () => {
      const end = Math.min(shown + 12, total);
      const frag = document.createDocumentFragment();
      for (; shown < end; shown++) frag.append(buildBoard(shown));
      grid.append(frag);
      status.textContent = shown < total
        ? `${fmt(shown)} / ${fmt(total)} 件を表示中（下にスクロールすると続きを表示します）`
        : `全 ${fmt(total)} 件を表示しました`;
    };

    const body = h('div', {},
      h('div', { class: 'row' }, verdict, h('span', {}, `該当する結果 ${fmt(total)} 通り`)),
      legend, grid, status);
    open(`${names[focus]} が ${targetLabel(snap.target)} に入る結果`, body);

    const scroller = body.closest('.dlg-body') || body.parentElement;
    const pump = () => {
      if (!grid.isConnected || shown >= total) return;
      if (status.getBoundingClientRect().top < scroller.getBoundingClientRect().bottom + 800) {
        appendChunk();
        requestAnimationFrame(pump);
      }
    };
    scroller.addEventListener('scroll', pump, { passive: true });
    appendChunk();
    requestAnimationFrame(pump);
  }

  const api = { show, fmt, fmtPts, namesOf, targetLabel, cellFromResult };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LeagueBoards = api;
})(typeof self !== 'undefined' ? self : globalThis);
