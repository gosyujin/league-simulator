'use strict';
/**
 * エンジンの検証。
 *   node tests/engine.test.js
 * _example/ に league.js とサンプルがあれば、元のCLIの出力(順位分布・決定戦の件数)と突き合わせる。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const E = require('../js/engine.js');
const M = require('../js/model.js');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e.stack || e)); }
}

const exampleDir = path.join(__dirname, '..', '_example');

function problemOf(league) { return E.compile(league); }

// ── 手計算できる小さなケース ──
function league(names, matches, outcomesOverride) {
  const raw = {
    name: 't', participants: names, outcomes: outcomesOverride || M.defaultOutcomes(),
    matches, target: { mode: 'within', n: 1 },
  };
  return M.deserializeLeague(raw);
}

test('三すくみは決定戦になる', () => {
  // A>B, B>C, C>A の3人総当たり(完了)。全員1勝1敗で直接対決でも分けられない
  const lg = league(['A', 'B', 'C'], [
    { a: 'A', b: 'B', outcome: 'win', winner: 'A' },
    { a: 'B', b: 'C', outcome: 'win', winner: 'B' },
    { a: 'A', b: 'C', outcome: 'win', winner: 'C' },
  ]);
  const r = E.run(problemOf(lg), { mode: 'exhaustive', lo: 1, hi: 1 });
  assert.strictEqual(r.total, 1);
  assert.deepStrictEqual(Array.from(r.certain), [0, 0, 0]);
  assert.deepStrictEqual(Array.from(r.playoff), [1, 1, 1]);
});

test('同点でも直接対決で順位が決まる', () => {
  // A,B,C: A>B, A>C, B>C は A2勝/B1勝/C0勝で同点にならないので、ここは4人で作る
  // A,B が同点(勝ち点4)になるよう D を絡める: A>B, A>C, A<D / B>C, B>D / C>D
  //  A: B,C に勝ち D に負け = 4点, B: C,D に勝ち A に負け = 4点, C: D に勝ち = 2点, D: A に勝ち = 2点
  const lg = league(['A', 'B', 'C', 'D'], [
    { a: 'A', b: 'B', outcome: 'win', winner: 'A' },
    { a: 'A', b: 'C', outcome: 'win', winner: 'A' },
    { a: 'A', b: 'D', outcome: 'win', winner: 'D' },
    { a: 'B', b: 'C', outcome: 'win', winner: 'B' },
    { a: 'B', b: 'D', outcome: 'win', winner: 'B' },
    { a: 'C', b: 'D', outcome: 'win', winner: 'C' },
  ]);
  const r = E.run(problemOf(lg), { mode: 'exhaustive', lo: 1, hi: 1 });
  assert.strictEqual(r.certain[0], 1, 'A が直接対決で B に勝って1位');
  assert.strictEqual(r.certain[1], 0);
});

test('未実施の組み合わせ数は 結果数^試合数', () => {
  const lg = league(['A', 'B', 'C', 'D'], []);
  assert.strictEqual(E.countPatterns(problemOf(lg)), Math.pow(2, 6));
  const lg2 = M.deserializeLeague(Object.assign(M.serializeLeague(lg), {
    outcomes: M.defaultOutcomes().map(o => Object.assign(o, { simulate: (o.id === 'win' || o.id === 'draw') })),
  }));
  assert.strictEqual(E.countPatterns(problemOf(lg2)), Math.pow(3, 6));
});

test('圧縮した条件の件数合計が元の件数と一致する', () => {
  const lg = league(['A', 'B', 'C', 'D', 'E'], [
    { a: 'A', b: 'B', outcome: 'win', winner: 'A' },
  ], M.defaultOutcomes().map(o => Object.assign(o, { simulate: (o.id === 'win' || o.id === 'draw') })));
  const p = problemOf(lg);
  const stats = E.run(p, { mode: 'exhaustive', lo: 1, hi: 2 });
  for (let focus = 0; focus < p.n; focus++) {
    const d = E.detail(p, { focus, lo: 1, hi: 2 });
    assert.strictEqual(d.certain.rows.reduce((s, r) => s + r.count, 0), stats.certain[focus], 'certain ' + focus);
    assert.strictEqual(d.certain.count, stats.certain[focus]);
    const playSum = d.playoffs.reduce((s, g) => s + g.rows.reduce((t, r) => t + r.count, 0), 0);
    assert.strictEqual(playSum, stats.playoff[focus], 'playoff ' + focus);
  }
});

test('0.5点などの小数点でも同点判定がずれない', () => {
  const outs = M.defaultOutcomes();
  outs[0].win = 0.7; outs[0].lose = 0.1;
  const lg = league(['A', 'B', 'C'], [
    { a: 'A', b: 'B', outcome: 'win', winner: 'A' },
    { a: 'B', b: 'C', outcome: 'win', winner: 'B' },
    { a: 'A', b: 'C', outcome: 'win', winner: 'C' },
  ], outs);
  const r = E.run(problemOf(lg), { mode: 'exhaustive', lo: 1, hi: 1 });
  assert.deepStrictEqual(Array.from(r.playoff), [1, 1, 1]);
});

test('保存形式の往復で内容が変わらない', () => {
  const lg = league(['A', 'B', 'C'], [{ a: 'A', b: 'B', outcome: 'draw' }]);
  const once = M.serializeLeague(lg);
  const twice = M.serializeLeague(M.deserializeLeague(once));
  assert.deepStrictEqual(twice, once);
});

test('不正なインポートは分かりやすいエラーになる', () => {
  assert.throws(() => M.parseImport('participants: A B\nscoring: win=2 loss=0\nA > C'), /不明な参加者名/);
  assert.throws(() => M.parseImport('{'), /JSON/);
});

// ── 元のCLI(league.js)との突き合わせ ──
function parseCliDistribution(out, n) {
  const hist = {};
  for (const line of out.split('\n')) {
    const m = line.match(/^(\d+)位\s+(\d[\d\s]*)$/);
    if (m && m[2].trim().split(/\s+/).length === n) hist[+m[1]] = m[2].trim().split(/\s+/).map(Number);
  }
  return hist;
}

for (const block of ['2026-block-a', '2026-block-b']) {
  const txt = path.join(exampleDir, block + '.txt');
  if (!fs.existsSync(txt) || !fs.existsSync(path.join(exampleDir, 'league.js'))) continue;

  for (const top of [1, 2, 3]) {
    test(`CLIと一致: ${block} ${top}位以内`, () => {
      const out = execFileSync('node', [path.join(exampleDir, 'league.js'), txt, '--achieve-top', String(top), '--no-star-table'], { encoding: 'utf8' });
      const lg = M.parseImport(fs.readFileSync(txt, 'utf8'), block + '.txt')[0];
      const p = problemOf(lg);
      const r = E.run(p, { mode: 'exhaustive', lo: 1, hi: top });

      const cliHist = parseCliDistribution(out, p.n);
      assert.ok(Object.keys(cliHist).length === p.n, 'CLI出力の順位分布を読み取れない');
      for (let rank = 1; rank <= p.n; rank++) {
        const mine = Array.from({ length: p.n }, (_, q) => r.hist[q * (p.n + 1) + rank]);
        assert.deepStrictEqual(mine, cliHist[rank], `${rank}位の分布`);
      }
      const total = +out.match(/全結果パターン総数: ([\d,]+)通り/)[1].replace(/,/g, '');
      assert.strictEqual(r.total, total);

      // 決定戦が必要なパターン数: CLIは「top位を含む同着グループがあるパターン数」。
      // これは「ちょうどtop位」の判定と同じ。「top位以内」では、同着グループが範囲内に収まる
      // (例: 1〜2位が同着で2位以内を狙う)場合は両者通過なので決定戦にしない(CLIより厳密)。
      const cliTie = +out.match(/決定戦が必要なパターン数: ([\d,]+)/)[1].replace(/,/g, '');
      const exact = E.run(p, { mode: 'exhaustive', lo: top, hi: top });
      assert.strictEqual(exact.ties.reduce((s, t) => s + t.count, 0), cliTie, '決定戦パターン数');
      const within = r.ties.reduce((s, t) => s + t.count, 0);
      assert.ok(within <= cliTie, '以内の決定戦はCLI以下');
    });
  }
}

// ── 速度の目安 ──
test('性能: 10人・未実施12試合・3結果(531,441通り)', () => {
  const names = 'ABCDEFGHIJ'.split('');
  const matches = [];
  let skip = 0;
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    if (skip++ < 12) continue;
    matches.push({ a: names[i], b: names[j], outcome: 'win', winner: (i + j) % 2 ? names[i] : names[j] });
  }
  const lg = league(names, matches, M.defaultOutcomes().map(o => Object.assign(o, { simulate: (o.id === 'win' || o.id === 'draw') })));
  const p = problemOf(lg);
  assert.strictEqual(E.countPatterns(p), 531441);
  const t0 = Date.now();
  const r = E.run(p, { mode: 'exhaustive', lo: 1, hi: 2 });
  const ms = Date.now() - t0;
  console.log(`     ${r.processed.toLocaleString()}通りを ${ms}ms`);
  assert.strictEqual(r.processed, 531441);
  const t1 = Date.now();
  const d = E.detail(p, { focus: 0, lo: 1, hi: 2 });
  console.log(`     detail: 確定 ${d.certain.count}通り → ${d.certain.rows.length}行 (${Date.now() - t1}ms)`);
});

if (failed) { console.log(`\n${failed} 件失敗`); process.exit(1); }
console.log('\nすべて成功');
