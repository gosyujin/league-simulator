/* リーグ戦シミュレーター UI */
(function () {
  'use strict';

  const E = window.LeagueEngine;
  const M = window.LeagueModel;
  const G = window.LeagueGist;
  const B = window.LeagueBoards;
  const { pairKey } = E;
  const { fmt, fmtPts, namesOf, targetLabel, cellFromResult } = B;

  const STORAGE_KEY = 'league-simulator:v1';
  const EXHAUSTIVE_LIMIT = 20000000;   // これを超える場合は全網羅せずランダム抽出にする
  const SAMPLE_DEFAULT = 1000000;
  const DETAIL_PAGE = 300;

  const SAMPLE_NAME = 'G1 Aブロック(サンプル)';
  const SAMPLE_TEXT = `participants: 竹下 後藤 ボルチン 辻 鷹木 ジェイク SANADA オーカーン アイス 大岩
scoring: win=2 loss=0 draw=1 void=1

竹下 > 後藤
竹下 > ボルチン
竹下 < 辻
竹下 < 鷹木
竹下 > ジェイク
竹下 > SANADA
竹下 > オーカーン
竹下 > アイス
後藤 > ボルチン
後藤 > 辻
後藤 < 鷹木
後藤 < ジェイク
後藤 > SANADA
後藤 < オーカーン
後藤 < 大岩
ボルチン > 辻
ボルチン > 鷹木
ボルチン > ジェイク
ボルチン > SANADA
ボルチン > アイス
ボルチン < 大岩
辻 > 鷹木
辻 < SANADA
辻 > オーカーン
辻 > アイス
辻 > 大岩
鷹木 < ジェイク
鷹木 > オーカーン
鷹木 < アイス
鷹木 > 大岩
ジェイク < SANADA
ジェイク > オーカーン
ジェイク < アイス
ジェイク < 大岩
SANADA < オーカーン
SANADA > アイス
SANADA < 大岩
オーカーン < アイス
オーカーン < 大岩
アイス > 大岩
`;

  // ─────────────────────────────────────────────
  // DOM ヘルパー（innerHTML は使わず、名前などは常にテキストとして挿入する）
  // ─────────────────────────────────────────────

  const $ = sel => document.querySelector(sel);

  function appendKids(el, kids) {
    for (const k of kids) {
      if (k === null || k === undefined || k === false) continue;
      if (Array.isArray(k)) appendKids(el, k);
      else el.append(k instanceof Node ? k : document.createTextNode(String(k)));
    }
  }

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    let deferredValue;
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value' && tag === 'select') deferredValue = v;
      else if (k in el) el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    appendKids(el, kids);
    if (deferredValue !== undefined) el.value = deferredValue;
    return el;
  }

  function fmtBig(v) {
    if (v < 1e12) return fmt(v);
    const exp = Math.floor(Math.log10(v));
    return `約${(v / Math.pow(10, exp)).toFixed(1)}×10^${exp}`;
  }
  const pct = (a, b) => {
    if (!b) return '-';
    const v = a / b * 100;
    return (v === 0 || v === 100 ? v.toFixed(0) : v < 0.1 ? '<0.1' : v.toFixed(1)) + '%';
  };

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  // ─────────────────────────────────────────────
  // ダイアログ
  // ─────────────────────────────────────────────

  const dlg = $('#dlg');
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });

  /** buttons: [{label, cls, onClick}] — onClick が true を返すと閉じない */
  function openDialog(title, body, buttons, opts) {
    dlg.classList.toggle('wide', !!(opts && opts.wide));
    dlg.classList.toggle('mid', !!(opts && opts.mid));
    dlg.replaceChildren(
      h('div', { class: 'dlg-head' }, title),
      h('div', { class: 'dlg-body' }, body),
      h('div', { class: 'dlg-foot' }, buttons.map(b => h('button', {
        class: 'btn ' + (b.cls || ''),
        onclick: async () => {
          const keep = b.onClick ? await b.onClick() : undefined;
          if (keep !== true && dlg.open) dlg.close();
        },
      }, b.label))),
    );
    if (!dlg.open) dlg.showModal();
  }

  function confirmDialog(message, okLabel, danger) {
    return new Promise(resolve => {
      let done = false;
      const finish = v => { if (!done) { done = true; resolve(v); } };
      openDialog('確認', h('p', {}, message), [
        { label: 'キャンセル', onClick: () => finish(false) },
        { label: okLabel || 'OK', cls: danger ? 'danger' : 'primary', onClick: () => finish(true) },
      ]);
      dlg.addEventListener('close', () => finish(false), { once: true });
    });
  }

  function askText(title, label, initial) {
    return new Promise(resolve => {
      let done = false;
      const finish = v => { if (!done) { done = true; resolve(v); } };
      const input = h('input', { type: 'text', value: initial || '', maxlength: 40, style: 'width:100%' });
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { finish(input.value.trim() || null); dlg.close(); }
      });
      openDialog(title, h('label', {}, h('div', { class: 'muted' }, label), input), [
        { label: 'キャンセル', onClick: () => finish(null) },
        { label: 'OK', cls: 'primary', onClick: () => finish(input.value.trim() || null) },
      ]);
      dlg.addEventListener('close', () => finish(null), { once: true });
      input.focus(); input.select();
    });
  }

  // ─────────────────────────────────────────────
  // 状態と保存
  // ─────────────────────────────────────────────

  const state = { leagues: [], currentId: null, tab: 'board', sim: freshSim() };

  function freshSim() {
    return {
      job: null, running: false, progress: null, progressEl: null, error: null,
      result: null, snap: null, key: null,
      detail: null, detailFor: null, detailLoading: false, detailLimit: DETAIL_PAGE,
      pctMode: false, sampleN: SAMPLE_DEFAULT,
    };
  }

  const cur = () => state.leagues.find(l => l.id === state.currentId);
  const outcomeOf = (lg, id) => lg.outcomes.find(o => o.id === id);

  function load() {
    let raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        state.leagues = obj.leagues.map(raw => M.deserializeLeague(raw, { keepId: true }));
        const seen = new Set();
        for (const l of state.leagues) {   // 手で編集されて id が重複していても、別のリーグとして扱えるようにする
          if (seen.has(l.id)) l.id = M.makeId('l');
          seen.add(l.id);
        }
        const lg = state.leagues[obj.current] || state.leagues[0];
        state.currentId = lg && lg.id;
      }
    } catch (e) {
      console.warn('保存データを読み込めませんでした', e);
      state.leagues = [];
      try { localStorage.setItem(STORAGE_KEY + ':broken', raw); } catch (_) { /* 退避に失敗しても続行 */ }
      setTimeout(() => toast('保存データを読み込めませんでした。新しく始めます'), 0);
    }
    if (!state.leagues.length) {
      const lg = M.newLeague('リーグ1');
      state.leagues = [lg];
      state.currentId = lg.id;
    }
    for (const lg of state.leagues) leagueSigs.set(lg.id, G.signature(M, lg));
    state.tab = cur().participants.length ? 'board' : 'setup';
  }

  // リーグごとの「前回保存時の内容」。内容が変わったときだけ更新日時を進める(Gistとの新旧の目安)
  const leagueSigs = new Map();

  function touchLeagues() {
    for (const lg of state.leagues) {
      const sig = G.signature(M, lg);
      if (leagueSigs.get(lg.id) === sig) continue;
      // Gistから読み込んだ直後(記録なし・更新日時あり)は、Gist側の更新日時を保つ
      if (leagueSigs.has(lg.id) || !lg.updatedAt) lg.updatedAt = Date.now();
      leagueSigs.set(lg.id, sig);
    }
  }

  // Gistに未アップの変更があるリーグ(Gist ID を設定していないときは空)
  function gistDirtyIds() {
    return G.unsyncedIds(state.leagues.map(l => [l.id, leagueSigs.get(l.id) ?? G.signature(M, l)]));
  }

  // 歯車ボタンの目印。未アップのリーグがあれば赤い点を出す
  function updateGistMark() {
    const btn = document.getElementById('gist-btn');
    if (!btn) return;
    const n = gistDirtyIds().length;
    const label = n ? `Gistの設定(保存 / 共有)。Gistに未アップの変更があるリーグが${n}件あります` : 'Gistの設定(保存 / 共有)';
    btn.classList.toggle('dirty', n > 0);
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }

  // 同期した(Gistと同じ内容になった)リーグを記録して、目印を更新する
  function markSynced(lg, gistId) {
    G.markSynced(lg.id, G.signature(M, lg), gistId);
    updateGistMark();
  }

  // 未アップのリーグがあるままページを閉じようとしたら、ブラウザの確認を出す
  window.addEventListener('beforeunload', e => {
    if (!gistDirtyIds().length) return;
    e.preventDefault();
    e.returnValue = '';
  });

  let saveWarned = false;
  function save() {
    try {
      touchLeagues();
      updateGistMark();
      const obj = M.exportFile(state.leagues, { withId: true });
      obj.current = state.leagues.findIndex(l => l.id === state.currentId);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
    } catch (e) {
      if (!saveWarned) {
        saveWarned = true;
        toast('ブラウザに保存できませんでした。エクスポートで保存してください');
      }
    }
  }

  function switchLeague(id) {
    cancelSim();
    state.currentId = id;
    state.sim = freshSim();
    save();
    render();
    window.scrollTo(0, 0);
  }

  function setTab(tab) {
    state.tab = tab;
    render();
    window.scrollTo(0, 0);
  }

  // ─────────────────────────────────────────────
  // 計算ジョブ（Web Worker。使えない環境ではメインスレッドで実行）
  // ─────────────────────────────────────────────

  function startJob(msg, onProgress) {
    let worker = null;
    let rejectFn;
    const promise = new Promise((resolve, reject) => {
      rejectFn = reject;
      const inline = () => setTimeout(() => {
        try {
          if (msg.type === 'run') resolve(E.run(msg.problem, msg.opts));
          else resolve(E.detail(msg.problem, msg.opts));
        } catch (e) { reject(e); }
      }, 30);

      try { worker = new Worker('js/worker.js'); } catch (e) { inline(); return; }
      worker.onmessage = ev => {
        const d = ev.data;
        if (d.type === 'progress') { if (onProgress) onProgress(d); return; }
        worker.terminate(); worker = null;
        if (d.type === 'error') reject(new Error(d.message));
        else resolve(d.result);
      };
      worker.onerror = ev => {   // file:// で開いた場合など
        if (ev.preventDefault) ev.preventDefault();
        if (worker) { worker.terminate(); worker = null; }
        inline();
      };
      worker.postMessage(msg);
    });
    return {
      promise,
      cancel() {
        if (worker) { worker.terminate(); worker = null; }
        rejectFn(new Error('cancelled'));
      },
    };
  }

  function cancelSim() {
    const sim = state.sim;
    if (sim.job) { sim.job.cancel(); sim.job = null; }
    sim.running = false;
    sim.detailLoading = false;
  }

  // ─────────────────────────────────────────────
  // 画面全体
  // ─────────────────────────────────────────────

  function render() {
    const y = window.scrollY;
    renderAppbar();
    const lg = cur();
    const view = { setup: viewSetup, board: viewBoard, sim: viewSim }[state.tab];
    const app = $('#app');
    app.replaceChildren();
    appendKids(app, view(lg));
    window.scrollTo(0, y);
  }

  function renderAppbar() {
    const lg = cur();
    const tabs = [['setup', '1. 設定'], ['board', '2. 星取表'], ['sim', '3. シミュレーション']];
    $('#appbar').replaceChildren(
      h('div', { class: 'appbar-row' },
        h('span', { class: 'brand' }, '🏆 リーグ戦シミュレーター'),
        h('select', { 'aria-label': 'リーグを選択', onchange: e => switchLeague(e.target.value) },
          state.leagues.map(l => h('option', { value: l.id, selected: l.id === lg.id }, l.name))),
        h('button', { class: 'btn small', onclick: createLeague }, '＋ 新規リーグ'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn', onclick: staticDialog, title: '結果を1枚の静的HTMLとして保存(GitHub Pagesなどに置けます)' }, 'HTMLで保存'),
        h('button', { class: 'btn', onclick: ioDialog }, 'インポート / エクスポート'),
        h('button', { id: 'gist-btn', class: 'btn icon', onclick: gistDialog, 'aria-label': 'Gistの設定', title: 'Gistの設定(保存 / 共有)' }, '⚙')),
      h('nav', { class: 'tabs', role: 'tablist' }, tabs.map(([id, label]) => h('button', {
        class: 'tab', role: 'tab', 'aria-selected': String(state.tab === id), onclick: () => setTab(id),
      }, label))),
    );
    updateGistMark();
  }

  async function createLeague() {
    const name = await askText('新規リーグ', 'リーグ名（例: Bブロック）', '');
    if (!name) return;
    const lg = M.newLeague(name);
    state.leagues.push(lg);
    cancelSim();
    state.currentId = lg.id;
    state.sim = freshSim();
    state.tab = 'setup';
    save(); render();
  }

  // ─────────────────────────────────────────────
  // 1. 設定タブ
  // ─────────────────────────────────────────────

  function viewSetup(lg) {
    return [cardLeague(lg), cardParticipants(lg), cardOutcomes(lg)];
  }

  function cardLeague(lg) {
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'リーグ')),
      h('div', { class: 'row' },
        h('input', {
          type: 'text', value: lg.name, maxlength: 40, 'aria-label': 'リーグ名',
          onchange: e => {
            const v = e.target.value.trim();
            if (!v) { e.target.value = lg.name; return; }
            lg.name = v; save(); renderAppbar();
          },
        }),
        h('button', { class: 'btn', onclick: () => duplicateLeague(lg) }, '複製'),
        h('button', { class: 'btn danger', onclick: () => deleteLeague(lg) }, '削除')),
      h('p', { class: 'muted', style: 'margin:8px 0 0' },
        '入力した内容はこのブラウザ(localStorage)に自動保存されます。別の端末へ移すときは右上の「⚙」か「インポート / エクスポート」を使います。'));
  }

  function duplicateLeague(lg) {
    const copy = M.deserializeLeague(M.serializeLeague(lg));
    copy.name = lg.name + ' (コピー)';
    state.leagues.push(copy);
    cancelSim();
    state.currentId = copy.id;
    state.sim = freshSim();
    save(); render();
    toast('複製しました');
  }

  async function deleteLeague(lg) {
    const ok = await confirmDialog(`リーグ「${lg.name}」を削除します。元に戻せません(事前にエクスポートしておくと安心です)。`, '削除する', true);
    if (!ok) return;
    cancelSim();
    state.leagues = state.leagues.filter(l => l.id !== lg.id);
    if (!state.leagues.length) state.leagues.push(M.newLeague('リーグ1'));
    state.currentId = state.leagues[0].id;
    state.sim = freshSim();
    save(); render();
  }

  function cardParticipants(lg) {
    const ps = lg.participants;
    const input = h('input', {
      type: 'text', placeholder: '名前を入力して Enter（スペースや読点で区切ると複数まとめて追加）',
      'aria-label': '追加する参加者名',
      onkeydown: e => { if (e.key === 'Enter' && !e.isComposing) add(); },
    });
    const add = () => {
      const names = input.value.split(/[\s,、]+/).map(s => s.trim()).filter(Boolean);
      if (!names.length) return;
      const exist = new Set(ps.map(p => p.name));
      const skipped = [];
      for (const name of names) {
        if (exist.has(name)) { skipped.push(name); continue; }
        if (ps.length >= M.MAX_PARTICIPANTS) { toast(`参加者は${M.MAX_PARTICIPANTS}名までです`); break; }
        ps.push({ id: M.makeId('p'), name });
        exist.add(name);
      }
      if (skipped.length) toast(`すでにいる名前は追加しませんでした: ${skipped.join('、')}`);
      save(); render();
      const next = $('[aria-label="追加する参加者名"]');
      if (next) next.focus();
    };

    const list = h('ul', { class: 'plist' }, ps.map((p, i) => h('li', {},
      h('span', { class: 'idx' }, i + 1),
      h('input', {
        type: 'text', value: p.name, maxlength: 20, 'aria-label': `参加者${i + 1}の名前`,
        onchange: e => {
          const v = e.target.value.trim();
          if (!v || ps.some(q => q !== p && q.name === v)) {
            e.target.value = p.name;
            toast(v ? '同じ名前の参加者がいます' : '名前を入力してください');
            return;
          }
          p.name = v; save();
        },
      }),
      h('button', { class: 'btn icon small', title: '上へ', disabled: i === 0, onclick: () => moveParticipant(lg, i, -1) }, '↑'),
      h('button', { class: 'btn icon small', title: '下へ', disabled: i === ps.length - 1, onclick: () => moveParticipant(lg, i, 1) }, '↓'),
      h('button', { class: 'btn icon small danger', title: '削除', onclick: () => removeParticipant(lg, p) }, '✕'))));

    return h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h2', {}, `参加者（${ps.length}名）`),
        h('span', { class: 'hint' }, `2〜${M.MAX_PARTICIPANTS}名。並び順が星取表の並びになります`)),
      ps.length ? list : h('div', { class: 'empty', style: 'padding:12px' },
        h('p', {}, '参加者がまだいません。下の入力欄から追加するか、サンプルを読み込んでください。'),
        h('button', { class: 'btn', onclick: loadSample }, 'サンプル(G1 Aブロック)を読み込む')),
      h('div', { class: 'add-row' }, input, h('button', { class: 'btn primary', onclick: add }, '追加')));
  }

  function moveParticipant(lg, i, d) {
    const ps = lg.participants;
    [ps[i], ps[i + d]] = [ps[i + d], ps[i]];
    save(); render();
  }

  async function removeParticipant(lg, p) {
    const keys = Object.keys(lg.results).filter(k => k.split('|').includes(p.id));
    if (keys.length) {
      const ok = await confirmDialog(`「${p.name}」を削除すると、${p.name}の試合結果${keys.length}件も消えます。`, '削除する', true);
      if (!ok) return;
    }
    keys.forEach(k => delete lg.results[k]);
    lg.participants = lg.participants.filter(q => q !== p);
    save(); render();
  }

  function usageCount(lg, outcomeId) {
    return Object.values(lg.results).filter(r => r.outcome === outcomeId).length;
  }

  function dropResultsOf(lg, outcomeId) {
    for (const [k, r] of Object.entries(lg.results)) if (r.outcome === outcomeId) delete lg.results[k];
  }

  function cardOutcomes(lg) {
    const numInput = (value, onSet, label) => h('input', {
      type: 'number', step: 'any', value, 'aria-label': label,
      onchange: e => {
        const v = parseFloat(e.target.value);
        if (!isFinite(v)) { e.target.value = value; return; }
        onSet(v); save(); render();
      },
    });
    const markInput = (value, onSet, label) => h('input', {
      type: 'text', class: 'narrow', value, maxlength: 2, 'aria-label': label,
      onchange: e => {
        const v = e.target.value.trim();
        if (!v) { e.target.value = value; return; }
        onSet(v); save(); render();
      },
    });

    const rows = lg.outcomes.map(o => {
      const decisive = o.kind === 'decisive';
      return h('tr', {},
        h('td', {}, h('input', {
          type: 'text', value: o.name, maxlength: 12, 'aria-label': '結果の名前',
          onchange: e => { const v = e.target.value.trim(); if (!v) { e.target.value = o.name; return; } o.name = v; save(); },
        })),
        h('td', {}, h('select', {
          'aria-label': '種類', value: o.kind,
          onchange: async e => {
            const to = e.target.value;
            const used = usageCount(lg, o.id);
            if (used) {
              const ok = await confirmDialog(`種類を変えると、この結果が入力済みの${used}試合が未実施に戻ります。`, '変更する', true);
              if (!ok) { e.target.value = o.kind; return; }
              dropResultsOf(lg, o.id);
            }
            if (to === 'shared') { o.kind = 'shared'; o.pts = 1; o.mark = '△'; delete o.win; delete o.lose; delete o.loseMark; }
            else { o.kind = 'decisive'; o.win = 2; o.lose = 0; o.mark = '○'; o.loseMark = '●'; delete o.pts; }
            save(); render();
          },
        }, h('option', { value: 'decisive' }, '勝敗が決まる'), h('option', { value: 'shared' }, '双方同じ点'))),
        h('td', {}, decisive
          ? h('div', { class: 'pts-cell' }, '勝者', numInput(o.win, v => { o.win = v; }, '勝者の点'), '敗者', numInput(o.lose, v => { o.lose = v; }, '敗者の点'))
          : h('div', { class: 'pts-cell' }, '双方', numInput(o.pts, v => { o.pts = v; }, '双方の点'))),
        h('td', {}, decisive
          ? h('div', { class: 'pts-cell' }, markInput(o.mark, v => { o.mark = v; }, '勝者側の記号'), h('span', { class: 'sep' }, '/'), markInput(o.loseMark, v => { o.loseMark = v; }, '敗者側の記号'))
          : markInput(o.mark, v => { o.mark = v; }, '記号')),
        h('td', { style: 'text-align:center' }, h('input', {
          type: 'checkbox', checked: o.simulate, 'aria-label': '未実施試合の予測に含める',
          onchange: e => { o.simulate = e.target.checked; save(); render(); },
        })),
        h('td', {}, h('button', {
          class: 'btn icon small danger', title: '削除', disabled: lg.outcomes.length <= 1,
          onclick: async () => {
            const used = usageCount(lg, o.id);
            if (used) {
              const ok = await confirmDialog(`「${o.name}」を削除すると、この結果が入力済みの${used}試合が未実施に戻ります。`, '削除する', true);
              if (!ok) return;
            }
            dropResultsOf(lg, o.id);
            lg.outcomes = lg.outcomes.filter(x => x !== o);
            save(); render();
          },
        }, '✕')));
    });

    const addOutcome = () => {
      lg.outcomes.push({ id: 'o' + Date.now().toString(36), name: '新しい結果', kind: 'shared', pts: 0, mark: '他', simulate: false });
      save(); render();
    };

    // 結果の種類を初期設定に戻す。同じ id で種類も同じ結果の入力済み試合は残し、それ以外は未実施に戻す
    const resetOutcomes = async () => {
      const defs = M.defaultOutcomes();
      const lost = lg.outcomes.filter(o => {
        const d = defs.find(x => x.id === o.id);
        return !d || d.kind !== o.kind;
      });
      const affected = lost.reduce((n, o) => n + usageCount(lg, o.id), 0);
      const msg = '結果の種類と勝ち点を初期設定(勝ち・引き分け・無効試合・不戦勝)に戻します。'
        + (affected ? `初期設定に無い結果が入力済みの${affected}試合は未実施に戻ります。` : '');
      if (!await confirmDialog(msg, '初期設定にする', affected > 0)) return;
      for (const o of lost) dropResultsOf(lg, o.id);
      lg.outcomes = defs;
      save(); render();
    };

    return h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h2', {}, '試合結果の種類と勝ち点'),
        h('span', { class: 'hint' }, '勝ち・負け・引き分け・その他の決着と、それぞれに付く点を決めます')),
      h('div', { class: 'table-wrap' }, h('table', { class: 'otable' },
        h('thead', {}, h('tr', {},
          h('th', {}, '名前'), h('th', {}, '種類'), h('th', {}, '勝ち点'), h('th', {}, '星取表の記号'),
          h('th', { title: '未実施の試合が、この結果になる場合も数え上げる' }, '予測に含める'), h('th', {}, ''))),
        h('tbody', {}, rows))),
      h('p', { class: 'muted', style: 'margin:10px 0' },
        '「勝敗が決まる」は勝者と敗者に別々の点が入る結果です（例: 勝ち 2点/0点、反則勝ち 2点/0点）。',
        '「双方同じ点」は両者に同じ点が入る結果です（例: 引き分け 1点、無効試合 1点）。',
        '「予測に含める」にチェックした結果だけが、未実施試合で起こり得る結果として全パターンの列挙に使われます。'),
      h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' },
        h('button', { class: 'btn', onclick: addOutcome }, '＋ 結果の種類を追加'),
        h('button', { class: 'btn', onclick: resetOutcomes }, 'デフォルトに設定')));
  }

  // ─────────────────────────────────────────────
  // 2. 星取表タブ
  // ─────────────────────────────────────────────

  function emptyCard(message, tab) {
    return h('section', { class: 'card empty' },
      h('p', {}, message),
      h('button', { class: 'btn primary', onclick: () => setTab(tab || 'setup') }, '設定へ'));
  }

  function viewBoard(lg) {
    if (lg.participants.length < 2) return emptyCard('参加者を2名以上登録すると星取表が表示されます。');
    return [cardStarTable(lg), cardStandings(lg)];
  }

  function cellInfo(lg, r, c) {
    const ps = lg.participants;
    return cellFromResult(lg.outcomes, lg.results[pairKey(ps[r].id, ps[c].id)], ps[r].id);
  }

  // lg は { participants, outcomes, results } があればよい。readonly=true なら編集用のボタンを出さない(静的HTML用)
  function cardStarTable(lg, readonly) {
    const ps = lg.participants;
    const total = ps.length * (ps.length - 1) / 2;
    const done = Object.keys(lg.results).length;

    const ptsOf = new Map(computeStandings(lg).rows.map(row => [row.p.id, row.pts]));

    const head = h('tr', {}, h('th', {}),
      ps.map(p => h('th', { scope: 'col' }, h('div', { class: 'vname' }, p.name))),
      h('th', { class: 'rk', scope: 'col' }, '勝ち点'));
    const body = ps.map((rp, r) => h('tr', {},
      h('th', { scope: 'row', class: 'rname' }, rp.name),
      ps.map((cp, c) => {
        if (r === c) return h('td', { class: 'self' });
        const info = cellInfo(lg, r, c);
        if (readonly) return h('td', { class: info.cls, title: `${rp.name} vs ${cp.name}: ${info.label}` }, info.text);
        return h('td', { class: info.cls },
          h('button', {
            class: 'cell-btn', 'aria-label': `${rp.name} vs ${cp.name}: ${info.label}`,
            onclick: () => matchDialog(lg, rp, cp),
          }, info.text));
      }),
      h('td', { class: 'rk' }, fmtPts(ptsOf.get(rp.id)))));

    const legend = lg.outcomes.map(o => o.kind === 'shared'
      ? h('span', {}, h('span', { class: 'sw cell-shared' }, o.mark), o.name)
      : h('span', {}, h('span', { class: 'sw cell-win' }, o.mark), h('span', { class: 'sw cell-lose' }, o.loseMark), o.name));

    return h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h2', {}, '星取表'),
        h('span', { class: 'hint' }, `消化 ${done} / ${total} 試合（残り ${total - done} 試合）` + (readonly ? '' : '。マスをクリックして結果を入力'))),
      h('div', { class: 'table-wrap' }, h('table', { class: 'star' }, h('thead', {}, head), h('tbody', {}, body))),
      h('div', { class: 'legend' }, '行の選手から見た結果:', legend, h('span', {}, '空欄 = 未実施')));
  }

  // 「勝ち」の裏側の呼び名（勝ち→負け、反則勝ち→反則負け）。「勝」を含まない名前は「〜(負け側)」
  function loseName(o) {
    return /勝ち?$/.test(o.name) ? o.name.replace(/勝ち?$/, '負け') : `${o.name}(負け側)`;
  }

  function matchDialog(lg, a, b) {
    const key = pairKey(a.id, b.id);
    const now = lg.results[key];
    const set = res => {
      if (res) lg.results[key] = res; else delete lg.results[key];
      save(); render();
    };
    const choices = [];
    for (const o of lg.outcomes) {
      if (o.kind === 'shared') {
        choices.push({ title: o.name, sub: `双方 +${fmtPts(o.pts)}`, on: now && now.outcome === o.id, res: { outcome: o.id } });
      } else {
        // 常にAを主にして表現する（A 勝ち / A 負け）
        choices.push({
          title: `${a.name} ${o.name}`, sub: `${a.name} +${fmtPts(o.win)} / ${b.name} +${fmtPts(o.lose)}`,
          on: now && now.outcome === o.id && now.winner === a.id, res: { outcome: o.id, winner: a.id },
        });
        choices.push({
          title: `${a.name} ${loseName(o)}`, sub: `${a.name} +${fmtPts(o.lose)} / ${b.name} +${fmtPts(o.win)}`,
          on: now && now.outcome === o.id && now.winner === b.id, res: { outcome: o.id, winner: b.id },
        });
      }
    }
    openDialog(`${a.name} vs ${b.name}`,
      h('div', { class: 'choices' }, choices.map(c => h('button', {
        class: 'btn choice' + (c.on ? ' on' : ''), onclick: () => { set(c.res); dlg.close(); },
      }, h('span', {}, c.title), h('small', {}, c.sub)))),
      [
        { label: '未実施に戻す', onClick: () => set(null) },
        { label: '閉じる' },
      ]);
  }

  function computeStandings(lg) {
    const ps = lg.participants;
    const idx = new Map(ps.map((p, i) => [p.id, i]));
    const rows = ps.map(p => ({ p, pts: 0, played: 0, counts: {} }));
    const bump = (row, key) => { row.counts[key] = (row.counts[key] || 0) + 1; };

    for (const [key, res] of Object.entries(lg.results)) {
      const [ida, idb] = key.split('|');
      const ia = idx.get(ida), ib = idx.get(idb);
      const o = outcomeOf(lg, res.outcome);
      if (ia === undefined || ib === undefined || !o) continue;
      rows[ia].played++; rows[ib].played++;
      if (o.kind === 'shared') {
        rows[ia].pts += o.pts; rows[ib].pts += o.pts;
        bump(rows[ia], o.id + ':s'); bump(rows[ib], o.id + ':s');
      } else {
        const [w, l] = res.winner === ida ? [rows[ia], rows[ib]] : [rows[ib], rows[ia]];
        w.pts += o.win; l.pts += o.lose;
        bump(w, o.id + ':w'); bump(l, o.id + ':l');
      }
    }

    const best = Math.max(0, ...lg.outcomes.map(o => (o.kind === 'shared' ? o.pts : Math.max(o.win, o.lose))));
    rows.forEach(r => { r.remaining = ps.length - 1 - r.played; r.max = r.pts + r.remaining * best; });

    const sorted = [...rows].sort((x, y) => y.pts - x.pts);
    sorted.forEach((r, i) => { r.rank = i > 0 && sorted[i - 1].pts === r.pts ? sorted[i - 1].rank : i + 1; });

    const columns = lg.outcomes.flatMap(o => o.kind === 'shared'
      ? [{ key: o.id + ':s', label: o.mark, title: o.name }]
      : [{ key: o.id + ':w', label: o.mark, title: `${o.name}(勝者側)` }, { key: o.id + ':l', label: o.loseMark, title: `${o.name}(敗者側)` }]);
    return { rows: sorted, columns };
  }

  function cardStandings(lg) {
    const { rows, columns } = computeStandings(lg);
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h2', {}, '現在の順位'),
        h('span', { class: 'hint' }, '勝ち点順の暫定順位（同点の直接対決判定は「3. シミュレーション」で行います）')),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {},
          h('th', { class: 'num' }, '順位'), h('th', {}, '選手'), h('th', { class: 'num' }, '勝ち点'),
          h('th', { class: 'num' }, '消化'), h('th', { class: 'num' }, '残り'), h('th', { class: 'num', title: '残りを全部最高点で取った場合' }, '最大'),
          columns.map(c => h('th', { class: 'num', title: c.title }, c.label)))),
        h('tbody', {}, rows.map(r => h('tr', { class: r.rank === 1 ? 'rank-1' : '' },
          h('td', { class: 'num' }, r.rank), h('td', {}, r.p.name),
          h('td', { class: 'num' }, h('b', {}, fmtPts(r.pts))),
          h('td', { class: 'num' }, r.played), h('td', { class: 'num' }, r.remaining), h('td', { class: 'num' }, fmtPts(r.max)),
          columns.map(c => h('td', { class: 'num' }, r.counts[c.key] || 0))))))));
  }

  // ─────────────────────────────────────────────
  // 3. シミュレーションタブ
  // ─────────────────────────────────────────────

  function targetRange(lg) {
    return rangeOf(lg.target, lg.participants.length);
  }

  function rangeOf(target, count) {
    const n = Math.min(target.n, count);
    return target.mode === 'exact' ? { lo: n, hi: n } : { lo: 1, hi: n };
  }

  // 「どんな条件を調べるか」の説明文
  function targetNote(t) {
    return t.mode === 'exact'
      ? `ちょうど${t.n}位になる条件を調べます`
      : `${t.n === 1 ? '1位' : `1〜${t.n}位`}に入る(${t.n}位抜けできる)条件を調べます`;
  }

  function leagueKey(lg) {
    const s = M.serializeLeague(lg);
    delete s.name;
    return JSON.stringify(s);
  }

  function viewSim(lg) {
    const n = lg.participants.length;
    if (n < 2) return emptyCard('参加者を2名以上登録するとシミュレーションできます。');
    lg.target.n = Math.min(Math.max(lg.target.n, 1), n);

    const sim = state.sim;
    const prob = E.compile(lg);
    const total = E.countPatterns(prob);
    const k = prob.pending.length;
    const m = prob.options.length;
    const noOptions = k > 0 && m === 0;
    const tooMany = total > EXHAUSTIVE_LIMIT;

    const setTarget = patch => { Object.assign(lg.target, patch); save(); render(); };
    const optionText = optionTextOf(lg.outcomes);

    const targetRow = h('div', { class: 'controls' },
      h('label', {}, '狙う順位',
        h('select', { 'aria-label': '順位の条件', value: lg.target.mode, onchange: e => setTarget({ mode: e.target.value }) },
          h('option', { value: 'within' }, '以内（勝ち抜け）'), h('option', { value: 'exact' }, 'ちょうど'))),
      h('select', { 'aria-label': '順位', value: String(lg.target.n), onchange: e => setTarget({ n: parseInt(e.target.value, 10) }) },
        Array.from({ length: n }, (_, i) => h('option', { value: String(i + 1) }, `${i + 1}位`))),
      h('span', { class: 'muted' }, targetNote(lg.target)));

    const facts = h('div', { class: 'facts' },
      fact(String(k), '未実施の試合'),
      fact(String(m), '1試合あたりの結果'),
      fact(k === 0 ? '1' : fmtBig(total), '全結果パターン'));

    let runUi;
    if (noOptions) {
      runUi = h('div', { class: 'notice error' }, '「設定」タブで、未実施試合で起こり得る結果に「予測に含める」のチェックを1つ以上入れてください。');
    } else if (sim.running) {
      const bar = h('progress', { max: 1, value: 0 });
      const label = h('span', { class: 'muted' }, '計算中…');
      sim.progressEl = { bar, label };
      if (sim.progress) updateProgress();
      runUi = h('div', { class: 'controls' }, bar, label,
        h('button', { class: 'btn', onclick: () => { cancelSim(); render(); } }, '中止'));
    } else {
      const parts = [];
      if (tooMany) {
        parts.push(h('div', { class: 'notice' },
          `パターン数が ${fmtBig(total)} 通りと多すぎるため、全網羅はできません。残り試合が減ると全網羅できるようになります。今は、ランダムに抽出した結果から確率を概算できます（条件の一覧は出せません）。`));
        parts.push(h('div', { class: 'controls' },
          h('label', {}, '抽出件数',
            h('input', {
              type: 'number', min: 1000, step: 100000, value: sim.sampleN, 'aria-label': '抽出件数',
              onchange: e => { sim.sampleN = Math.min(Math.max(parseInt(e.target.value, 10) || SAMPLE_DEFAULT, 1000), 20000000); },
            })),
          h('button', { class: 'btn primary', onclick: () => runSim(lg, 'sample') }, 'ランダム抽出で概算')));
      } else {
        const secs = total / 500000; // 実測は端末により 50万〜100万通り/秒
        parts.push(h('div', { class: 'controls' },
          h('button', { class: 'btn primary', onclick: () => runSim(lg, 'exhaustive') }, '全パターンを計算'),
          secs > 3 ? h('span', { class: 'muted' }, `目安: 約${Math.ceil(secs)}秒`) : null));
      }
      runUi = parts;
    }

    const cards = [
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, '条件'), h('span', { class: 'hint' }, `未実施試合で数え上げる結果: ${optionText || 'なし'}`)),
        targetRow, facts, runUi,
        sim.error ? h('div', { class: 'notice error' }, sim.error) : null,
        rulesNote()),
    ];
    if (sim.result) cards.push(...resultCards(lg));
    return cards;
  }

  const optionTextOf = outcomes => outcomes.filter(o => o.simulate)
    .map(o => (o.kind === 'shared' ? o.name : `${o.name}(どちらが勝つか)`)).join('・');

  const fact = (value, label) => h('div', { class: 'fact' }, h('b', {}, value), h('span', {}, label));

  function rulesNote() {
    return h('details', {},
      h('summary', {}, '順位の決め方（同点の扱い）'),
      h('ul', {},
        h('li', {}, '勝ち点の多い順に並べます。'),
        h('li', {}, '勝ち点が同じ選手が複数いるときは、その選手たちの間の直接対決だけで勝ち点を数え直して順位を付けます。'),
        h('li', {}, 'それでも同じ勝ち点が残る選手たち（三すくみなど）には、その選手たちの間でもう一度同じ判定をします。'),
        h('li', {}, 'どうしても順位が付かない場合は「決定戦が必要」とします。決定戦になる範囲が狙う順位をまたぐ場合だけ、決定戦として数えます（例: 1〜2位が同点で「2位以内」なら、どちらも通過なので確定）。'),
        h('li', {}, '「決定戦」は結果パターンの数え上げには含めず、確定とは別の列に分けて表示します。')));
  }

  function updateProgress() {
    const sim = state.sim;
    const ui = sim.progressEl;
    if (!ui || !ui.bar.isConnected || !sim.progress) return;
    const { done, total } = sim.progress;
    ui.bar.max = total; ui.bar.value = done;
    ui.label.textContent = `${fmt(done)} / ${fmt(total)}`;
  }

  async function runSim(lg, mode) {
    const sim = state.sim;
    cancelSim();
    const problem = E.compile(lg);
    const { lo, hi } = targetRange(lg);
    const target = Object.assign({}, lg.target);
    sim.running = true; sim.progress = null; sim.error = null;
    sim.detail = null; sim.detailFor = null; sim.detailLimit = DETAIL_PAGE;
    render();

    const job = startJob(
      { type: 'run', problem, opts: { mode, lo, hi, sampleN: sim.sampleN, seed: (Date.now() & 0x7fffffff) || 1 } },
      p => { sim.progress = p; updateProgress(); });
    sim.job = job;
    try {
      const result = await job.promise;
      sim.result = result;
      sim.snap = {
        problem, n: problem.n, names: problem.names, lo, hi, target,
        outcomes: lg.outcomes.map(o => Object.assign({}, o)),
        // 確定済みの結果(星取表の再現用)。計算後に入力が変わっても、計算時点のまま描画できるよう複製する
        league: JSON.parse(JSON.stringify({ participants: lg.participants, results: lg.results })),
      };
      sim.key = leagueKey(lg);
    } catch (e) {
      if (e.message !== 'cancelled') sim.error = '計算に失敗しました: ' + e.message;
    }
    if (sim.job === job) { sim.job = null; sim.running = false; render(); }
  }

  async function loadDetail(focus) {
    const sim = state.sim;
    const { problem, lo, hi } = sim.snap;
    sim.detailLoading = true; sim.detailFor = focus; sim.detail = null; sim.detailLimit = DETAIL_PAGE;
    render();
    const job = startJob({ type: 'detail', problem, opts: { focus, lo, hi } });
    sim.job = job;
    try {
      sim.detail = await job.promise;
    } catch (e) {
      if (e.message !== 'cancelled') sim.error = '条件の集計に失敗しました: ' + e.message;
    }
    if (sim.job === job) { sim.job = null; sim.detailLoading = false; render(); }
  }

  // ── 結果の表示 ──

  function resultCards(lg) {
    const sim = state.sim;
    const { result, snap } = sim;
    const stale = sim.key !== leagueKey(lg);
    const cards = [];

    if (stale) {
      cards.push(h('div', { class: 'notice' }, '星取表や設定が変わっています。下の結果は計算したときの内容です。最新の内容で見るには、もう一度計算してください。'));
    }
    const wrap = node => (stale ? h('div', { class: 'stale' }, node) : node);

    cards.push(wrap(cardChances(snap, result, sim)));
    if (sim.detailFor !== null) cards.push(wrap(cardDetail(snap, result, sim)));
    if (result.ties.length) cards.push(wrap(cardTies(snap, result)));
    cards.push(wrap(cardDistribution(snap, result, sim)));
    return cards;
  }

  // 「入れる可能性」の並び順(確定+決定戦の多い順)
  function chanceRows(names, result) {
    return names.map((name, p) => ({ p, name, c: result.certain[p], po: result.playoff[p] }))
      .sort((a, b) => (b.c + b.po) - (a.c + a.po) || b.c - a.c || a.p - b.p);
  }

  function cardChances(snap, result, sim) {
    const { names, n } = snap;
    const done = result.processed;
    const rows = chanceRows(names, result);
    const sample = result.mode === 'sample';

    return h('section', { class: 'card', id: 'chances' },
      h('div', { class: 'card-head' },
        h('h2', {}, `${targetLabel(snap.target)}に入れる可能性`),
        h('span', { class: 'hint' }, sample
          ? `ランダム抽出 ${fmt(done)} 件による概算（全 ${fmtBig(result.total)} 通り中）`
          : `全 ${fmt(done)} 通りを計算`)),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {},
          h('th', {}, '選手'), h('th', {}, ''),
          h('th', { class: 'num', title: '決定戦なしで条件を満たすパターン' }, '確定'),
          h('th', { class: 'num', title: '同点で順位が付かず、決定戦に回るパターン' }, '決定戦'),
          h('th', { class: 'num' }, '合計'), h('th', { class: 'num' }, '可能性'), h('th', {}, ''))),
        h('tbody', {}, rows.map(r => {
          const any = r.c + r.po;
          const status = r.c === done ? h('span', { class: 'chip ok' }, '確定')
            : any === 0 ? h('span', { class: 'chip ng' }, '可能性なし')
              : r.c === 0 ? h('span', { class: 'chip warn' }, '決定戦のみ') : null;
          return h('tr', { class: any === 0 ? 'dim' : '' },
            h('td', {}, h('b', {}, r.name)), h('td', {}, status),
            h('td', { class: 'num' }, `${fmt(r.c)} (${pct(r.c, done)})`),
            h('td', { class: 'num' }, r.po ? `${fmt(r.po)} (${pct(r.po, done)})` : '-'),
            h('td', { class: 'num' }, fmt(any)),
            h('td', { class: 'num' }, h('b', {}, pct(any, done))),
            h('td', {}, !sample && any > 0 && n > 0
              ? (sim.static
                ? h('a', { class: 'btn small', href: '#' + condId(r.p) }, '条件を見る')   // 静的HTML: ページ内リンクで飛ばす
                : h('button', {
                  class: 'btn small', 'aria-pressed': String(sim.detailFor === r.p),
                  onclick: () => loadDetail(r.p),
                }, '条件を見る')) : null));
        })))),
      sample ? h('p', { class: 'muted', style: 'margin:8px 0 0' }, '概算のため件数は目安です。残り試合が減ると全パターンの計算と条件の一覧が使えます。') : null);
  }

  function cardDistribution(snap, result, sim) {
    const { names, n } = snap;
    const done = result.processed;
    const cellOf = (p, r) => {
      const v = result.hist[p * (n + 1) + r];
      if (!v) return h('td', { class: 'num muted' }, '·');
      return h('td', { class: 'num heat', style: `--p:${v / done}`, title: `${fmt(v)}通り (${pct(v, done)})` },
        sim.pctMode ? pct(v, done) : fmt(v));
    };
    const rows = [];
    for (let r = 1; r <= n; r++) rows.push(h('tr', {}, h('th', { scope: 'row' }, `${r}位`), names.map((_, p) => cellOf(p, r))));

    return h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h2', {}, '順位の分布'),
        h('div', { class: 'seg', role: 'group', 'aria-label': '表示' },
          h('button', { 'aria-pressed': String(!sim.pctMode), onclick: () => { sim.pctMode = false; render(); } }, '件数'),
          h('button', { 'aria-pressed': String(sim.pctMode), onclick: () => { sim.pctMode = true; render(); } }, '割合'))),
      h('div', { class: 'table-wrap' }, h('table', { class: 'dist' },
        h('thead', {}, h('tr', {}, h('th', {}, ''), names.map(nm => h('th', { class: 'vh' }, nm)))),
        h('tbody', {}, rows))),
      h('p', { class: 'muted', style: 'margin:8px 0 0' },
        '決着のつかない同順位グループは、グループの先頭の順位として数えます（例: 3人が2位タイなら3人とも「2位」）。'));
  }

  function cardTies(snap, result) {
    const { names } = snap;
    const done = result.processed;
    const total = result.ties.reduce((s, t) => s + t.count, 0);
    const rows = [...result.ties].sort((a, b) => b.count - a.count).map(t => h('tr', {},
      h('td', {}, namesOf(names, t.mask).join('・')),
      h('td', { class: 'num' }, fmt(t.count)), h('td', { class: 'num' }, pct(t.count, done))));
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h2', {}, '決定戦が必要になる組み合わせ'),
        h('span', { class: 'hint' }, `${targetLabel(snap.target)}の境目で、同点・直接対決でも決着しない ${fmt(total)} 通り`)),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, '同順位になる選手'), h('th', { class: 'num' }, 'パターン数'), h('th', { class: 'num' }, '割合'))),
        h('tbody', {}, rows))));
  }

  function optionNode(snap, pair, optIndex, focus) {
    const opt = snap.problem.options[optIndex];
    const o = snap.outcomes.find(x => x.id === opt.outcome);
    if (opt.winner === null) return o.name;
    const w = opt.winner === 'i' ? pair.i : pair.j;
    return h('span', { class: w === focus ? 'me' : '' }, `${snap.names[w]} ${o.mark}`);
  }

  const boardsDialog = (title, body) => openDialog(title, body, [{ label: '閉じる', cls: 'primary' }], { wide: true });

  const condId = p => `cond-${p}`;

  function cardDetail(snap, result, sim) {
    const focus = sim.detailFor;
    const name = snap.names[focus];
    const title = `${name} が ${targetLabel(snap.target)} に入る条件`;
    const head = h('div', { class: 'card-head' }, h('h2', {}, title),
      sim.static ? h('a', { class: 'back', href: '#chances' }, '↑ 可能性の一覧へ戻る') : null);
    const cardAttrs = cls => ({ class: cls, id: sim.static ? condId(focus) : null });

    if (sim.detailLoading || !sim.detail) {
      return h('section', cardAttrs('card'), head, h('p', { class: 'muted' }, '集計中…'));
    }
    const d = sim.detail;
    const all = [];
    for (const row of d.certain.rows) all.push({ kind: 'certain', row });
    for (const g of d.playoffs) for (const row of g.rows) all.push({ kind: 'playoff', row, mask: g.mask });

    const used = new Set();
    all.forEach(x => x.row.cells.forEach((c, v) => { if (c) used.add(v); }));
    const cols = [...used].sort((a, b) => a - b);
    const pairOf = v => snap.problem.pending[d.order[v]];

    const playoffTotal = d.playoffs.reduce((s, g) => s + g.count, 0);
    const summary = h('p', {},
      `全 ${fmt(result.processed)} 通りのうち、`,
      h('b', {}, `確定 ${fmt(d.certain.count)} 通り`),
      playoffTotal ? [' + ', h('b', {}, `決定戦 ${fmt(playoffTotal)} 通り`)] : null, '。',
      ' 表の1行は、その行の条件を満たす結果パターンをまとめたものです。「—」はどの結果でもよいことを表します。',
      ' パターン数をクリックすると、該当する結果を星取表ですべて表示します。');

    const notes = [];
    if (d.overflow) notes.push(h('div', { class: 'notice' }, '該当するパターンが多すぎるため、途中で集計を打ち切っています。下の表は一部です。'));
    if (d.certain.truncated || d.playoffs.some(g => g.truncated)) {
      notes.push(h('div', { class: 'notice' }, '条件の行数が多すぎるため、一部の行のみを表示しています。'));
    }

    if (!all.length) {
      return h('section', cardAttrs('card'), head, summary, h('p', { class: 'muted' }, '該当するパターンはありません。'));
    }
    if (!cols.length && all.length === 1) {
      const only = all[0];
      const what = only.kind === 'certain' ? '残りの試合がどんな結果でも確定します' : '残りの試合がどんな結果でも決定戦になります';
      return h('section', cardAttrs('card'), head, summary, notes, h('p', {}, what + '。'));
    }

    const shown = all.slice(0, sim.detailLimit);
    const thead = h('tr', {},
      h('th', {}, '#'),
      cols.map(v => {
        const pr = pairOf(v);
        return h('th', { class: 'mh' }, snap.names[pr.i], h('i', {}, 'vs'), snap.names[pr.j]);
      }),
      h('th', {}, '判定'), h('th', { class: 'num' }, 'パターン数'));
    const tbody = shown.map((x, idx) => h('tr', {},
      h('td', { class: 'muted' }, idx + 1),
      cols.map(v => {
        const c = x.row.cells[v];
        if (!c) return h('td', { class: 'mc any' }, '—');
        const nodes = [];
        c.forEach((o, i) => { if (i) nodes.push(' / '); nodes.push(optionNode(snap, pairOf(v), o, focus)); });
        return h('td', { class: 'mc' }, nodes);
      }),
      h('td', {}, x.kind === 'certain'
        ? h('span', { class: 'chip ok' }, '確定')
        : h('span', { class: 'chip warn' }, `決定戦 vs ${namesOf(snap.names, x.mask, focus).join('・')}`)),
      h('td', { class: 'num' }, h('button', {
        class: 'linkish', title: 'この条件に当てはまる結果を、星取表ですべて見る',
        // 静的HTMLでは、ページ内のスクリプトがこの属性から該当の行を探して開く
        'data-p': sim.static ? String(focus) : null, 'data-r': sim.static ? String(idx) : null,
        onclick: sim.static ? null : () => B.show(snap, d, x, boardsDialog),
      }, fmt(x.row.count)))));

    return h('section', cardAttrs('card pat'), head, summary, notes,
      h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, thead), h('tbody', {}, tbody))),
      all.length > shown.length
        ? h('div', { style: 'margin-top:10px' },
          h('button', { class: 'btn', onclick: () => { sim.detailLimit += DETAIL_PAGE; render(); } },
            `さらに表示（残り ${fmt(all.length - shown.length)} 行）`))
        : null);
  }

  // ─────────────────────────────────────────────
  // インポート / エクスポート
  // ─────────────────────────────────────────────

  function download(filename, text, mime) {
    const url = URL.createObjectURL(new Blob([text], { type: mime || 'application/json' }));
    const a = h('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const safeName = s => s.replace(/[\\/:*?"<>|]/g, '_');

  function loadSample() {
    const [lg] = M.parseImport(SAMPLE_TEXT, SAMPLE_NAME + '.txt');
    lg.outcomes = M.defaultOutcomes(); // 結果の種類と勝ち点は、既定の設定に合わせる
    lg.target = { mode: 'within', n: 2 };
    state.leagues.push(lg);
    cancelSim();
    state.currentId = lg.id;
    state.sim = freshSim();
    state.tab = 'board';
    save(); render();
    toast('サンプルを読み込みました');
  }

  function ioDialog() {
    const lg = cur();
    const file = h('input', { type: 'file', accept: '.json,.txt,text/plain,application/json', 'aria-label': '読み込むファイル' });
    const paste = h('textarea', { placeholder: 'ここにJSONやテキストを貼り付けることもできます', 'aria-label': '貼り付け' });
    const replace = h('input', { type: 'checkbox' });

    const doImport = async () => {
      try {
        let text = paste.value.trim(), fileName = '';
        if (!text && file.files[0]) { text = await file.files[0].text(); fileName = file.files[0].name; }
        if (!text) { toast('ファイルを選ぶか、内容を貼り付けてください'); return true; }
        const imported = M.parseImport(text, fileName);
        if (replace.checked) {
          const ok = await confirmDialog('今あるリーグをすべて消して、読み込んだ内容に置き換えます。', '置き換える', true);
          if (!ok) return true;
          state.leagues = imported;
        } else {
          state.leagues.push(...imported);
        }
        cancelSim();
        state.currentId = imported[0].id;
        state.sim = freshSim();
        state.tab = imported[0].participants.length ? 'board' : 'setup';
        save(); render();
        toast(`${imported.length}件のリーグを読み込みました`);
      } catch (e) {
        openDialog('読み込めませんでした', h('p', { style: 'white-space:pre-wrap' }, e.message), [{ label: '戻る', onClick: () => { ioDialog(); return true; } }]);
        return true;
      }
    };

    openDialog('インポート / エクスポート', [
      h('h3', {}, 'エクスポート（ファイルに保存）'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => download(safeName(lg.name) + '.json', JSON.stringify(M.exportFile([lg]), null, 2)) }, '表示中のリーグ'),
        h('button', { class: 'btn', onclick: () => download(`league-simulator-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(M.exportFile(state.leagues), null, 2)) }, `すべてのリーグ(${state.leagues.length}件)`)),
      h('h3', {}, 'インポート'),
      h('p', { class: 'muted' }, 'このアプリで保存した .json のほか、「竹下 > 後藤」形式のテキストや星取マトリクス形式の .json も読み込めます。'),
      file, h('div', { style: 'height:8px' }), paste,
      h('label', { class: 'row', style: 'margin-top:8px' }, replace, '今あるリーグを置き換える（オフなら追加）'),
      h('h3', {}, 'サンプル'),
      h('button', { class: 'btn', onclick: () => { dlg.close(); loadSample(); } }, 'G1 Aブロックのサンプルを追加'),
    ], [
      { label: '閉じる' },
      { label: '読み込む', cls: 'primary', onClick: doImport },
    ]);
  }

  // ─────────────────────────────────────────────
  // 静的HTMLとして保存
  // ─────────────────────────────────────────────
  // その時点の星取表と、指定した順位条件のシミュレーション結果を、CSSも含めた1枚のHTMLにする。
  // JavaScript は含めない(見るだけ。ページ内リンクだけで移動できる)。

  const STATIC_MAX_ROWS = 3000;   // 1人あたりの「条件」の行数の上限(HTMLが大きくなりすぎないように)

  async function loadCss() {
    try {
      const res = await fetch('css/style.css');
      if (res.ok) return await res.text();
    } catch (_) { /* file:// など。次の方法で取る */ }
    try {
      return [...document.styleSheets].flatMap(ss => [...ss.cssRules].map(r => r.cssText)).join('\n');
    } catch (_) {
      throw new Error('CSSを読み込めませんでした。ローカルサーバー(またはGitHub Pages)経由で開いてください');
    }
  }

  async function loadText(path) {
    let res;
    try { res = await fetch(path); } catch (_) { res = null; }
    if (!res || !res.ok) throw new Error(`${path} を読み込めませんでした。ローカルサーバー(またはGitHub Pages)経由で開いてください`);
    return res.text();
  }

  const safeScript = text => text.replace(/<\/script/gi, '<\\/script');

  const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function serialize(nodes) {
    const box = document.createElement('div');
    appendKids(box, [nodes]);
    return box.innerHTML;
  }

  // 書き出したページに埋め込むデータ(「全通りの星取表」をページ内で再現するのに必要な分だけ)
  function staticData(snap, details) {
    const { problem } = snap;
    const data = {
      snap: {
        names: snap.names, n: snap.n, target: snap.target, outcomes: snap.outcomes, league: snap.league,
        problem: {
          n: problem.n, pending: problem.pending, options: problem.options,
          basePts: Array.from(problem.basePts), h2h: Array.from(problem.h2h),
        },
      },
      details: Object.fromEntries(details),
    };
    return JSON.stringify(data).replace(/</g, '\\u003c');
  }

  // 書き出したページで動く小さなスクリプト。「パターン数」を押すと、該当する全通りの星取表をダイアログで表示する
  const STATIC_BOOT = `(function () {
  var data = JSON.parse(document.getElementById('league-data').textContent);
  var snap = data.snap, dlg = document.getElementById('dlg');
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }
  dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
  function open(title, body) {
    var foot = el('div', 'dlg-foot'), close = el('button', 'btn primary', '閉じる');
    close.addEventListener('click', function () { dlg.close(); });
    foot.append(close);
    var content = el('div', 'dlg-body');
    content.append(body);
    dlg.className = 'wide';
    dlg.replaceChildren(el('div', 'dlg-head', title), content, foot);
    if (!dlg.open) dlg.showModal();
  }
  function rowsOf(d) {
    var all = [];
    d.certain.rows.forEach(function (row) { all.push({ kind: 'certain', row: row }); });
    d.playoffs.forEach(function (g) { g.rows.forEach(function (row) { all.push({ kind: 'playoff', row: row, mask: g.mask }); }); });
    return all;
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button[data-r]') : null;
    if (!b) return;
    var d = data.details[b.getAttribute('data-p')];
    var x = rowsOf(d)[Number(b.getAttribute('data-r'))];
    if (d && x) LeagueBoards.show(snap, d, x, open);
  });
})();`;

  /** 計算結果から、完結した1枚のHTML文字列を作る */
  function buildStaticHtml({ name, league, snap, result, details, css, scripts, createdAt }) {
    const { target, names, problem } = snap;
    const label = targetLabel(target);
    const stamp = createdAt.toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' });
    const k = problem.pending.length;
    const total = E.countPatterns(problem);

    const board = cardStarTable(league, true);

    const cond = h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, '条件'),
        h('span', { class: 'hint' }, `未実施試合で数え上げる結果: ${optionTextOf(snap.outcomes) || 'なし'}`)),
      h('p', {}, h('b', {}, `狙う順位: ${label}`), h('span', { class: 'muted' }, ` — ${targetNote(target)}`)),
      h('div', { class: 'facts' },
        fact(String(k), '未実施の試合'),
        fact(String(problem.options.length), '1試合あたりの結果'),
        fact(k === 0 ? '1' : fmtBig(total), '全結果パターン')),
      rulesNote());

    const cards = [cond, cardChances(snap, result, { static: true, detailFor: null })];
    for (const row of chanceRows(names, result)) {
      if (!details.has(row.p)) continue;
      cards.push(cardDetail(snap, result, {
        static: true, detailFor: row.p, detail: details.get(row.p), detailLimit: Infinity, detailLoading: false,
      }));
    }
    if (result.ties.length) cards.push(Object.assign(cardTies(snap, result), { id: 'ties' }));

    const title = `${name} ${label} シミュレーション結果`;
    return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)}</title>
<meta name="description" content="${escHtml(`${stamp} 時点の星取表と、${label}に入る条件のシミュレーション結果`)}">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%8F%86%3C/text%3E%3C/svg%3E">
<style>
${css.replace(/<\/style/gi, '<\\/style')}
</style>
</head>
<body class="static">
<header class="appbar">
  <div class="appbar-row">
    <span class="brand">🏆 ${escHtml(name)}</span>
    <span class="muted">${escHtml(label)} ／ ${escHtml(stamp)} 時点のスナップショット</span>
  </div>
  <nav class="tabs"><a class="tab" href="#board">星取表</a><a class="tab" href="#sim">シミュレーション</a>${result.ties.length ? '<a class="tab" href="#ties">決定戦</a>' : ''}</nav>
</header>
<main>
<h2 class="sec" id="board">星取表</h2>
${serialize(board)}
<h2 class="sec" id="sim">シミュレーション</h2>
${serialize(cards)}
</main>
<dialog id="dlg"></dialog>
<footer class="foot">リーグ戦シミュレーターで ${escHtml(stamp)} に書き出した静的なページです(閲覧のみ)。</footer>
<script>
${scripts.engine}
</script>
<script>
${scripts.boards}
</script>
<script id="league-data" type="application/json">${staticData(snap, details)}</script>
<script>
${STATIC_BOOT}
</script>
</body>
</html>
`;
  }

  function staticDialog() {
    const lg = cur();
    const n = lg.participants.length;
    if (n < 2) { toast('参加者を2名以上登録すると保存できます'); return; }

    const problem = E.compile(lg);
    const total = E.countPatterns(problem);
    const k = problem.pending.length;
    const noOptions = k > 0 && problem.options.length === 0;
    const tooMany = total > EXHAUSTIVE_LIMIT;
    const target = { mode: lg.target.mode, n: Math.min(Math.max(lg.target.n, 1), n) };

    const note = h('span', { class: 'muted' }, targetNote(target));
    const modeSel = h('select', {
      'aria-label': '順位の条件', value: target.mode,
      onchange: e => { target.mode = e.target.value; note.textContent = targetNote(target); },
    }, h('option', { value: 'within' }, '以内（勝ち抜け）'), h('option', { value: 'exact' }, 'ちょうど'));
    const nSel = h('select', {
      'aria-label': '順位', value: String(target.n),
      onchange: e => { target.n = parseInt(e.target.value, 10); note.textContent = targetNote(target); },
    }, Array.from({ length: n }, (_, i) => h('option', { value: String(i + 1) }, `${i + 1}位`)));

    const bar = h('progress', { max: 1, value: 0, hidden: true });
    const status = h('p', { class: 'muted', style: 'margin:8px 0 0' });
    let job = null, running = false, cancelled = false;

    const blocker = noOptions
      ? '「設定」タブで、未実施試合で起こり得る結果に「予測に含める」のチェックを1つ以上入れてください。'
      : tooMany
        ? `パターン数が ${fmtBig(total)} 通りと多すぎるため、全網羅できません。条件の一覧を含むHTMLは、残り試合が減ってから保存してください。`
        : null;

    const setProgress = (done, all, text) => {
      bar.hidden = false; bar.max = all; bar.value = done;
      status.textContent = text;
    };

    async function run() {
      if (running) return true;
      if (blocker) { toast(blocker); return true; }
      running = true; cancelled = false;
      status.className = 'muted';
      // 計算中に入力が変わっても、押した時点の内容で作る
      const league = JSON.parse(JSON.stringify({ participants: lg.participants, outcomes: lg.outcomes, results: lg.results }));
      const prob = E.compile(league);
      const { lo, hi } = rangeOf(target, prob.n);
      const snap = {
        problem: prob, n: prob.n, names: prob.names, lo, hi, target: Object.assign({}, target),
        outcomes: league.outcomes, league,
      };
      const createdAt = new Date();
      try {
        setProgress(0, 1, '全パターンを計算しています…');
        job = startJob({ type: 'run', problem: prob, opts: { mode: 'exhaustive', lo, hi } },
          p => setProgress(p.done, p.total, `全パターンを計算しています… ${fmt(p.done)} / ${fmt(p.total)}`));
        const result = await job.promise;

        const targets = chanceRows(prob.names, result).filter(r => r.c + r.po > 0);
        const details = new Map();
        for (let i = 0; i < targets.length; i++) {
          setProgress(i, targets.length, `条件を集計しています… ${i + 1} / ${targets.length}人目（${targets[i].name}）`);
          job = startJob({ type: 'detail', problem: prob, opts: { focus: targets[i].p, lo, hi, maxRows: STATIC_MAX_ROWS } });
          details.set(targets[i].p, await job.promise);
        }
        job = null;

        setProgress(1, 1, 'HTMLを作っています…');
        const css = await loadCss();
        const scripts = { engine: safeScript(await loadText('js/engine.js')), boards: safeScript(await loadText('js/boards.js')) };
        const html = buildStaticHtml({ name: lg.name, league, snap, result, details, css, scripts, createdAt });
        const day = createdAt.toISOString().slice(0, 10);
        download(`${safeName(lg.name)}_${targetLabel(target)}_${day}.html`, html, 'text/html');
        status.textContent = `保存しました（${Math.round(html.length / 1024).toLocaleString('ja-JP')} KB）。ファイルを開くだけで表示できます。`;
        bar.hidden = true;
        toast('HTMLを保存しました');
      } catch (e) {
        bar.hidden = true;
        if (!cancelled) { status.className = 'notice error'; status.textContent = '保存できませんでした: ' + e.message; }
      }
      running = false; job = null;
      return true;
    }

    openDialog('結果を静的HTMLとして保存', [
      h('p', { class: 'muted', style: 'margin-top:0' },
        'いまの星取表と、下で決めた順位条件のシミュレーション結果(入れる可能性・各選手の条件・決定戦になる組み合わせ)を、CSSも含めた1枚のHTMLにします。',
        'GitHub Pagesなどに置くだけで公開でき、閲覧のみ(編集や再計算はできません)です。'),
      h('h3', {}, '狙う順位（保存する条件）'),
      h('div', { class: 'controls' }, h('label', {}, '狙う順位', modeSel), nSel, note),
      h('p', { class: 'muted', style: 'margin:0' }, `未実施 ${k} 試合 / 全結果パターン ${k === 0 ? '1' : fmtBig(total)} 通り`),
      blocker ? h('div', { class: 'notice error', style: 'margin-top:8px' }, blocker) : null,
      h('div', { style: 'margin-top:8px' }, bar), status,
    ], [
      { label: '閉じる' },
      { label: 'HTMLを保存', cls: 'primary', onClick: run },
    ]);
    dlg.addEventListener('close', () => {
      if (job) { cancelled = true; job.cancel(); job = null; }
    }, { once: true });
  }

  // ─────────────────────────────────────────────
  // Gist 同期
  // ─────────────────────────────────────────────

  const fmtTime = t => (t ? new Date(t).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' }) : '-');

  // Gist のリーグをこの端末へ取り込む(同じ id のリーグがあれば置き換える)
  function applyRemote(remote) {
    const i = state.leagues.findIndex(l => l.id === remote.id);
    leagueSigs.delete(remote.id);   // Gist側の更新日時をそのまま保つ(touchLeagues 参照)
    if (i >= 0) state.leagues[i] = remote; else state.leagues.push(remote);
    if (state.currentId === remote.id) { cancelSim(); state.sim = freshSim(); }
    save();
    markSynced(remote);
    render();
  }

  // 操作を実行し、結果を知らせて、最新の状態でGistのダイアログを開き直す
  async function runInGist(action) {
    try {
      const message = await action();
      if (message) toast(message);
    } catch (e) {
      toast(e.message);
    }
    gistDialog();
  }

  /** 確認ダイアログは同じ <dialog> を使うので、確認のあとに Gist のダイアログを開き直す */
  async function confirmInGist(message, okLabel, danger, action) {
    const ok = await confirmDialog(message, okLabel, danger);
    await new Promise(r => setTimeout(r, 0));   // 確認ダイアログが閉じ終わってから開き直す
    if (ok) await runInGist(action);
    else gistDialog();
  }

  function gistDialog() {
    const idInput = h('input', {
      type: 'text', value: G.getConfig().gistId, placeholder: 'Gist ID または URL', spellcheck: false,
      autocomplete: 'off', 'aria-label': 'Gist ID', style: 'flex:1',
    });
    const tokenInput = h('input', {
      type: 'password', value: G.getToken(), placeholder: 'ghp_… (書き込むときだけ必要)', autocomplete: 'off',
      'aria-label': 'GitHubトークン(Gist用)', style: 'flex:1',
    });
    const open = h('a', { class: 'btn small', target: '_blank', rel: 'noopener', title: 'GitHubでこのGistを開く' }, '↗');
    const status = h('p', { class: 'muted', style: 'margin:8px 0' });
    const listBox = h('div', {});
    let snap = null, plan = [], seq = 0;

    const saveSettings = () => {
      const gistId = G.parseGistId(idInput.value);
      G.setConfig({ gistId });
      G.setToken(tokenInput.value);
      open.hidden = !gistId;
      if (gistId) open.href = G.pageUrl(gistId);
      return gistId;
    };
    const canWrite = () => !!G.getToken();
    const setStatus = (text, cls) => { status.className = cls || 'muted'; status.textContent = text; };

    async function refresh() {
      const gistId = saveSettings();
      const mine = ++seq;
      listBox.replaceChildren();
      if (!gistId) {
        snap = null;
        setStatus('Gist ID を入れると、そのGistにあるリーグを読み込めます。トークンも設定すると書き込めます。IDがなければ「Gistを作成」を押してください。');
        return;
      }
      setStatus('Gistを確認しています…');
      try {
        const s = await G.fetchLeagueFiles(gistId);
        if (mine !== seq) return;
        snap = s;
        plan = G.buildPlan(M, state.leagues, s.files);
        // Gistと同じ内容だったリーグは、アップ済みとして記録する
        for (const r of plan) if (r.status === 'same') markSynced(r.local, gistId);
        renderPlan();
      } catch (e) {
        if (mine !== seq) return;
        snap = null;
        setStatus(e.message, 'notice error');
      }
    }

    const statusChip = row => {
      if (row.status === 'same') return h('span', { class: 'chip ok' }, '同じ内容');
      if (row.status === 'local-only') return h('span', { class: 'chip warn' }, 'この端末のみ');
      if (row.status === 'remote-only') return h('span', { class: 'chip warn' }, 'Gistのみ');
      if (row.status === 'broken') return h('span', { class: 'chip ng', title: row.error }, '読み込めない');
      return h('span', { class: 'chip ng' }, '内容が違う');
    };

    const newerNote = row => (row.newer === 'local' ? '(この端末が新しい)' : row.newer === 'remote' ? '(Gistが新しい)' : '');

    function renderPlan() {
      const total = snap.fileCount;
      const notes = [];
      if (snap.truncated) notes.push('Gistのファイルが多すぎるため、一部しか取得できていません。');
      else if (total >= G.MAX_FILES) notes.push(`このGistは上限(${G.MAX_FILES}ファイル)に達しています。新しいリーグは別のGistに書き込んでください。`);
      setStatus(`Gistにはリーグが${snap.files.length}件あります(ファイル総数 ${total}/${G.MAX_FILES})。` +
        (canWrite() ? '' : ' トークン未設定のため読み込み専用です。') + notes.join(' '));

      const remoteOnly = plan.filter(r => r.status === 'remote-only');
      const localOnly = plan.filter(r => r.status === 'local-only');
      const bulk = h('div', { class: 'row', style: 'margin-bottom:8px' },
        h('button', { class: 'btn', disabled: !remoteOnly.length, onclick: () => runInGist(() => pullRows(remoteOnly)) }, `Gistのみのリーグを取り込む(${remoteOnly.length})`),
        h('button', { class: 'btn', disabled: !localOnly.length || !canWrite(), onclick: () => runInGist(() => pushRows(localOnly)) }, `この端末のみのリーグを書き込む(${localOnly.length})`));

      const rows = plan.map(row => h('tr', { class: row.status === 'same' ? 'dim' : '' },
        h('td', {}, row.name),
        h('td', {}, statusChip(row)),
        h('td', { class: 'g-time' },
          row.local ? h('div', {}, '端末 ', fmtTime(row.local.updatedAt)) : null,
          row.remote ? h('div', {}, 'Gist ', fmtTime(row.remote.updatedAt)) : null,
          row.newer ? h('div', { class: 'muted' }, newerNote(row)) : null),
        h('td', { class: 'g-actions' }, rowActions(row))));

      listBox.replaceChildren(plan.length
        ? h('div', {}, bulk, h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'リーグ'), h('th', {}, '状態'), h('th', {}, '更新日時'), h('th', {}, ''))),
          h('tbody', {}, rows))))
        : h('p', { class: 'muted' }, 'Gistにもこの端末にもリーグがありません。'));
    }

    function rowActions(row) {
      const pull = label => h('button', {
        class: 'btn small', onclick: () => (row.local
          ? confirmInGist(`リーグ「${row.name}」を、Gistの内容で置き換えます。この端末の変更は失われます。`, '置き換える', true, () => pullRows([row]))
          : runInGist(() => pullRows([row]))),
      }, label);
      const push = label => h('button', {
        class: 'btn small', disabled: !canWrite(), title: canWrite() ? '' : 'トークンが必要です',
        onclick: () => (row.remote
          ? confirmInGist(`リーグ「${row.name}」を、この端末の内容でGistに上書きします。Gistの内容は失われます。`, '上書きする', true, () => pushRows([row]))
          : runInGist(() => pushRows([row]))),
      }, label);
      const del = h('button', {
        class: 'btn small danger', disabled: !canWrite(), title: canWrite() ? '' : 'トークンが必要です',
        onclick: () => confirmInGist(`Gistからリーグ「${row.name}」のファイルを削除します。この端末のリーグは残ります。`, 'Gistから削除', true, async () => {
          await G.update(G.getConfig().gistId, { [row.file]: null });
          return 'Gistから削除しました';
        }),
      }, 'Gistから削除');
      if (row.status === 'remote-only') return [pull('取り込む'), del];
      if (row.status === 'local-only') return [push('書き込む')];
      if (row.status === 'same') return [del];
      if (row.status === 'broken') return [row.local ? push('書き込んで直す') : null, del];
      return [pull('Gistで置き換え'), push('この端末で上書き'), del];
    }

    function pullRows(rows) {
      const list = rows.filter(r => r.remote);
      for (const r of list) applyRemote(r.remote);
      return `${list.length}件のリーグを読み込みました`;
    }

    async function pushRows(rows) {
      const gistId = saveSettings();
      const files = {};
      for (const r of rows) {
        if (!r.local) continue;
        if (!r.local.updatedAt) r.local.updatedAt = Date.now();
        files[r.file] = G.leagueFileText(M, r.local);
      }
      const added = rows.filter(r => r.local && !r.remote && r.status !== 'broken').length;
      if (snap && snap.fileCount + added > G.MAX_FILES) {
        throw new Error(`1つのGistは${G.MAX_FILES}ファイルまでです。別のGistに書き込んでください`);
      }
      await G.update(gistId, files);
      save();
      for (const r of rows) if (r.local) markSynced(r.local, gistId);
      return `${Object.keys(files).length}件のリーグをGistに書き込みました`;
    }

    // シークレットGistを新しく作り、そのIDを入力欄に入れる(今ある全リーグを1ファイルずつ書き込む)
    async function makeGist() {
      saveSettings();
      if (!G.getToken()) throw new Error('Gistの作成にはGitHubトークンが必要です。下の欄に入力してください');
      const files = {};
      for (const lg of state.leagues.slice(0, G.MAX_FILES)) {
        if (!lg.updatedAt) lg.updatedAt = Date.now();
        files[G.fileName(lg.id)] = G.leagueFileText(M, lg);
      }
      const id = await G.create('league-simulator', files);
      G.setConfig({ gistId: id });
      idInput.value = id;
      save();
      for (const lg of state.leagues.slice(0, G.MAX_FILES)) markSynced(lg, id);
      return 'シークレットGistを作成しました';
    }

    async function createGist() {
      if (G.parseGistId(idInput.value)) {
        return confirmInGist('今のGist IDとは別に、新しいシークレットGistを作ります。入力欄のIDは新しいGistのものに変わります(今のGistは削除されません)。',
          '作成する', false, makeGist);
      }
      setStatus('Gistを作成しています…');
      try {
        toast(await makeGist());
      } catch (e) {
        setStatus(e.message, 'notice error');
        if (!G.getToken()) tokenInput.focus();
        return;
      }
      saveSettings();   // リンク(↗)を新しいIDに更新する
      await refresh();
    }

    idInput.addEventListener('input', () => { const id = G.parseGistId(idInput.value); open.hidden = !id; if (id) open.href = G.pageUrl(id); });
    idInput.addEventListener('change', refresh);
    const onToken = () => { G.setToken(tokenInput.value); if (snap) renderPlan(); };
    tokenInput.addEventListener('input', onToken);
    tokenInput.addEventListener('change', onToken);

    openDialog('Gist で保存 / 共有', [
      h('p', { class: 'muted', style: 'margin-top:0' },
        'リーグ1件が、1つのGistの中の1ファイルになります。リーグが増えると、Gistのファイルも1つずつ増えます。自動では同期せず、下の一覧からリーグ単位で読み込み・書き込みを選びます。'),
      h('h3', {}, 'Gist'),
      h('div', { class: 'row' }, idInput, open,
        h('button', { class: 'btn', onclick: refresh }, '確認'),
        h('button', { class: 'btn', onclick: createGist }, 'Gistを作成')),
      h('h3', {}, 'GitHubトークン(Gist用)'),
      h('div', { class: 'row' }, tokenInput),
      h('p', { class: 'muted', style: 'margin:6px 0 0' },
        '読み込みだけならトークンは不要です(IDを知っている人は誰でも読めます)。書き込み・作成・削除には、gist スコープの classic トークンが必要です。',
        h('a', { href: G.TOKEN_ISSUE_URL, target: '_blank', rel: 'noopener' }, 'トークンを発行'),
        '。トークンはこの端末のlocalStorageにだけ保存され、GitHub以外には送りません。共有PCでは入力しないでください。'),
      status,
      listBox,
    ], [{ label: '閉じる' }], { mid: true });

    saveSettings();
    refresh();
  }

  // ─────────────────────────────────────────────

  load();
  render();
})();
