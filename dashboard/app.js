'use strict';
// Token Radar dashboard. The board is derived live from the snapshot figures in
// data.js: the category multiples come from the tokenized comparables, and every
// row's implied value and farm plan are computed here, never hardcoded.
//   implied = TVL x multiple x growth x age
//   multiple = median mcap/TVL of tokenized peers in the same category
//              (global median when a category has fewer than four peers)
//   growth   = 1 + clamp(7-day TVL change, -40, +80) / 200
//   age      = 1 + min(years listed with no token, 6) x 0.06

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

function median(nums) {
  var a = nums.slice().sort(function (x, y) { return x - y; });
  var n = a.length;
  return n === 0 ? 0 : n % 2 === 1 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

function categoryMultiples(tokenized) {
  var raw = {};
  tokenized.forEach(function (p) {
    if (!p.tvl || !p.mcap) return;
    (raw[p.cat] = raw[p.cat] || []).push(p.mcap / p.tvl);
  });
  var byCat = {};
  Object.keys(raw).forEach(function (c) {
    if (raw[c].length >= 4) byCat[c] = clamp(median(raw[c]), 0.02, 1.5);
  });
  var global = clamp(median(tokenized.filter(function (p) { return p.tvl && p.mcap; }).map(function (p) { return p.mcap / p.tvl; })), 0.02, 1.5);
  return { byCat: byCat, global: global };
}

function multipleFor(cat, mults) { return mults.byCat[cat || 'Uncategorised'] || mults.global; }

function yearsListed(listed, asOfMs) {
  if (!listed) return 0;
  var ms = Date.parse(listed + 'T00:00:00Z');
  if (!isFinite(ms)) return 0;
  return Math.max(0, (asOfMs - ms) / (365.25 * 86400000));
}

function impliedValue(row, mults, asOfMs) {
  var base = row.tvl * multipleFor(row.cat, mults);
  var chg = row.chg === null || row.chg === undefined ? 0 : row.chg;
  var growth = 1 + clamp(chg, -40, 80) / 200;
  var age = 1 + Math.min(yearsListed(row.listed, asOfMs), 6) * 0.06;
  return Math.round(base * growth * age);
}

function gasNote(chain) {
  if (chain === 'Ethereum' || chain === 'Bitcoin') return '$1-$5';
  if (chain === 'Solana') return 'about $0.01';
  if (chain === 'Tron') return 'about $1-$3';
  if (['Base', 'Arbitrum', 'Optimism', 'Ink', 'Unichain', 'Blast', 'Linea', 'Scroll', 'zkSync Era', 'Polygon', 'BSC', 'Binance'].indexOf(chain) >= 0) return '$0.05-$0.50';
  return '$0.10-$2';
}

function familyFor(category) {
  switch (category) {
    case 'Dexs': return 'dex';
    case 'Lending': return 'lending';
    case 'Yield':
    case 'Yield Aggregator': return 'yield';
    case 'RWA': return 'rwa';
    case 'Derivatives': return 'derivatives';
    case 'CDP': return 'cdp';
    case 'Risk Curators':
    case 'Onchain Capital Allocator': return 'curator';
    case 'Liquid Staking':
    case 'Liquid Restaking':
    case 'Restaking':
    case 'Staking Pool': return 'staking';
    case 'Bridge':
    case 'Canonical Bridge':
    case 'Cross Chain Bridge': return 'bridge';
    default: return 'defi';
  }
}

// Farm-plan templates. {name} {chain} {gas} are filled from the snapshot row.
// Every step is concrete: what to do, what it costs, how long it takes.
var PLAN_TEMPLATES = {
  dex: [
    'Open {name} on {chain} and connect a wallet holding {chain} gas money; a first swap of $25-$100 costs about {gas} in gas and takes 5 minutes.',
    'Swap $25-$100 into the pool\u2019s main pair on {name} to leave an on-chain footprint; repeat a small swap once a week for 4 weeks.',
    'Add $50-$200 of liquidity to a {name} pool on {chain} and hold the position at least 30 days; check the pool\u2019s fee earnings weekly.',
    'Try a limit order or a second pool on {name} so your wallet touches more than one of its contracts; budget about {gas} per transaction.',
    'Keep the position open and check {name} once a week for new pools or campaigns; exit only after 30 days so the activity reads as real use, not a one-off.',
  ],
  lending: [
    'Supply $50-$200 of collateral (ETH or a stablecoin) to {name} on {chain}; the deposit costs about {gas} in gas and takes 5 minutes.',
    'Borrow $10-$50 against the supplied collateral on {name} and repay it within a week to show a full lending cycle; keep the health factor above 2.',
    'Repeat a supply-borrow-repay cycle once a week for 4 weeks on {name}, varying the asset each time; budget about {gas} per transaction.',
    'Try a second market on {name} (a different collateral asset) so your wallet uses more than one of its lending pools.',
    'Leave a small supply position open on {name} for at least 30 days and check your health factor weekly; withdraw only after the month ends.',
  ],
  yield: [
    'Deposit $50-$200 into a {name} vault on {chain}; the deposit costs about {gas} in gas and takes 5 minutes.',
    'Leave the deposit compounding for at least 30 days and check the vault\u2019s APY weekly; do not withdraw early.',
    'Deposit a second, smaller amount into a different {name} vault so your wallet uses two of its strategies.',
    'Claim or compound any rewards {name} shows at least once during the month; budget about {gas} per claim.',
    'After 30 days, withdraw half and keep the rest deposited; a long, unbroken deposit reads as real use.',
  ],
  rwa: [
    'Read {name}\u2019s asset documentation and check what backs its tokenised asset; this takes 15 minutes and costs nothing.',
    'Deposit $50-$200 into {name} on {chain} to hold its tokenised asset; the deposit costs about {gas} in gas.',
    'Hold the position for at least 30 days and check the asset\u2019s backing report weekly; real RWA use is slow by design.',
    'Try a second {name} asset or a redemption of a small amount to prove the full mint-and-redeem cycle; budget about {gas} per transaction.',
    'Keep records of every {name} deposit and redemption; if a token launches, a documented holder history is what an airdrop checks.',
  ],
  derivatives: [
    'Open a small $25-$50 perpetual position on {name} on {chain} with 1x-2x leverage; the trade costs about {gas} in gas.',
    'Close the position after a day and open a second one in the opposite direction to show two-way use; keep each trade under $100.',
    'Try a limit order on {name} and leave it open for a day; budget about {gas} per order and never risk more than $50.',
    'Use {name} once a week for 4 weeks, varying the market each time; a steady weekly pattern beats one big trade.',
    'Withdraw your margin back to your wallet after the month and keep the account open; never leave funds on {name} longer than needed.',
  ],
  cdp: [
    'Lock $100-$300 of collateral in {name} on {chain} and mint $25-$75 of its stable asset; the transaction costs about {gas} in gas.',
    'Keep the collateral ratio above 200% on {name} and check it weekly; top up collateral if the ratio falls.',
    'Repay half the minted amount after two weeks and mint again; a full mint-repay cycle shows real CDP use.',
    'Try a second collateral type on {name} so your wallet touches more than one of its vaults.',
    'Close the position after 30 days by repaying in full and withdrawing collateral; budget about {gas} per transaction.',
  ],
  curator: [
    'Read the strategy page of a {name} vault on {chain} and pick one vault matching your risk appetite; research takes 20 minutes.',
    'Allocate $50-$200 to the chosen {name} vault; the deposit costs about {gas} in gas and takes 5 minutes.',
    'Leave the allocation untouched for at least 30 days and read the vault\u2019s rebalancing updates weekly.',
    'Allocate a smaller amount to a second {name} vault run by a different curator to diversify across strategies.',
    'After 30 days, withdraw half and keep the rest allocated; a patient allocation is what curator vaults reward.',
  ],
  staking: [
    'Stake $50-$200 of the native asset through {name} on {chain}; the stake costs about {gas} in gas and takes 5 minutes.',
    'Hold the staked receipt token for at least 30 days and use it once in a {chain} DeFi app to show the full loop.',
    'Add a second, smaller stake two weeks later so your wallet shows repeated staking, not a single deposit.',
    'Claim staking rewards on {name} at least once during the month; budget about {gas} per claim.',
    'Test a small unstake of $10-$25 to prove you can exit; keep the main stake running past 30 days.',
  ],
  bridge: [
    'Bridge $25-$50 from {chain} to another chain through {name} as a test; the bridge costs about {gas} in gas and takes 10-30 minutes.',
    'Bridge a second, slightly larger amount a week later; two separate bridges read as real use, not a one-off.',
    'Use the bridged funds in an app on the destination chain, then bridge a small amount back through {name}.',
    'Try a different route or destination chain on {name} so your wallet uses more than one of its bridge paths.',
    'Keep total bridged volume under $500 across the month and save every transaction hash; bridges are the most-scrutinised activity.',
  ],
  defi: [
    'Open {name} on {chain} and connect a wallet holding {chain} gas money; a first transaction of $25-$100 costs about {gas} and takes 5 minutes.',
    'Use {name}\u2019s main feature once with $25-$100 and leave the position or balance open for at least 30 days.',
    'Return once a week for 4 weeks and repeat the core action with a small amount; steady weekly use beats one big transaction.',
    'Try a second feature of {name} (a different pool, market or vault) so your wallet touches more than one of its contracts.',
    'After 30 days, withdraw or close half and keep the rest active; save every transaction hash in case a future claim asks for proof.',
  ],
};

function farmSteps(row) {
  var chain = (row.chains && row.chains[0]) || 'Ethereum';
  var gas = gasNote(chain);
  return PLAN_TEMPLATES[familyFor(row.cat)].map(function (t) {
    return t.split('{name}').join(row.name).split('{chain}').join(chain).split('{gas}').join(gas);
  });
}

/** Build the ranked board from the raw snapshot figures. Returns rows with
 *  rank, implied value and farm steps — the same board main.ts writes. */
function buildBoard(data) {
  var asOfMs = Date.parse(data.asOf + 'T00:00:00Z');
  var comps = data.comparables.map(function (c) {
    return { slug: c[0], name: c[1], cat: c[2], tvl: c[3], mcap: c[4], ratio: c[5] };
  });
  var mults = { byCat: data.multiples, global: data.globalMultiple };
  var rows = data.rows.map(function (r) {
    return { slug: r[0], name: r[1], cat: r[2], chains: r[3], tvl: r[4], chg: r[5], listed: r[6], wl: r[7] };
  });
  rows.forEach(function (row) {
    row.multiple = multipleFor(row.cat, mults);
    row.value = impliedValue(row, mults, asOfMs);
    row.years = Math.round(yearsListed(row.listed, asOfMs) * 100) / 100;
    row.steps = farmSteps(row);
  });
  rows.sort(function (a, b) { return b.value - a.value || b.tvl - a.tvl || (a.slug < b.slug ? -1 : 1); });
  rows.forEach(function (row, i) {
    row.rank = i + 1;
    if (i > 0 && row.value >= rows[i - 1].value) row.value = rows[i - 1].value - 1;
  });
  return { rows: rows, comparables: comps, mults: mults, asOfMs: asOfMs };
}

if (typeof window !== 'undefined') {
  window.RADAR = { buildBoard: buildBoard, farmSteps: farmSteps, impliedValue: impliedValue, PLAN_TEMPLATES: PLAN_TEMPLATES };
}

// ---- UI (browser only) ----------------------------------------------------
if (typeof document !== 'undefined') {
  var BOARD = buildBoard(RADAR_DATA);
  var rows = BOARD.rows;

  function fmtUsd(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  }
  function fmtPct(c) {
    if (c === null || c === undefined) return '<span class="mut">—</span>';
    var cls = c >= 0 ? 'up' : 'down';
    return '<span class="' + cls + '">' + (c >= 0 ? '+' : '') + c.toFixed(1) + '%</span>';
  }
  function fmtAge(y, listed) {
    if (!listed) return '<span class="mut">—</span>';
    return y >= 1 ? y.toFixed(1) + 'y' : Math.round(y * 12) + 'mo';
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  var $ = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(location.search);

  // Stats
  var total = rows.reduce(function (n, r) { return n + r.value; }, 0);
  $('stats').innerHTML =
    '<div class="stat"><b>' + rows.length + '</b><span>protocols</span></div>' +
    '<div class="stat"><b>' + rows.filter(function (r) { return r.wl; }).length + '</b><span>on watchlist</span></div>' +
    '<div class="stat"><b>' + fmtUsd(total) + '</b><span>total implied value</span></div>' +
    '<div class="stat"><b>' + BOARD.mults.global.toFixed(3) + '</b><span>global mcap/TVL</span></div>';
  $('asof').textContent = RADAR_DATA.asOf;

  // Filter options
  var cats = Array.from(new Set(rows.map(function (r) { return r.cat || 'Uncategorised'; }))).sort();
  cats.forEach(function (c) { $('cat').insertAdjacentHTML('beforeend', '<option>' + esc(c) + '</option>'); });
  var chains = Array.from(new Set(rows.reduce(function (a, r) { return a.concat(r.chains); }, []))).sort();
  chains.forEach(function (c) { $('chain').insertAdjacentHTML('beforeend', '<option>' + esc(c) + '</option>'); });

  // Comparables
  $('comps').innerHTML = BOARD.comparables.map(function (c) {
    return '<tr><td>' + esc(c.name) + '</td><td>' + esc(c.cat || '—') + '</td>' +
      '<td class="r">' + fmtUsd(c.tvl) + '</td><td class="r">' + fmtUsd(c.mcap) + '</td>' +
      '<td class="r">' + c.ratio.toFixed(3) + '</td></tr>';
  }).join('');

  function currentFilters() {
    return { q: $('q').value.trim().toLowerCase(), cat: $('cat').value, chain: $('chain').value, wl: $('wl').checked, sort: $('sort').value };
  }
  function filtered() {
    var f = currentFilters();
    var out = rows.filter(function (r) {
      if (f.wl && !r.wl) return false;
      if (f.cat && (r.cat || 'Uncategorised') !== f.cat) return false;
      if (f.chain && r.chains.indexOf(f.chain) < 0) return false;
      if (f.q && (r.name.toLowerCase().indexOf(f.q) < 0 && r.slug.toLowerCase().indexOf(f.q) < 0)) return false;
      return true;
    });
    if (f.sort === 'tvl') out.sort(function (a, b) { return b.tvl - a.tvl; });
    else if (f.sort === 'growth') out.sort(function (a, b) { return (b.chg === null ? -1e9 : b.chg) - (a.chg === null ? -1e9 : a.chg); });
    else if (f.sort === 'age') out.sort(function (a, b) { return b.years - a.years; });
    else out.sort(function (a, b) { return a.rank - b.rank; });
    return out;
  }
  function render() {
    var list = filtered();
    $('rows').innerHTML = list.map(function (r) {
      return '<tr data-slug="' + esc(r.slug) + '"><td class="r">' + r.rank + '</td>' +
        '<td><span class="name">' + esc(r.name) + '</span>' + (r.wl ? '<span class="badge">WATCHLIST</span>' : '') +
        '<br><span class="slug">' + esc(r.slug) + '</span></td>' +
        '<td>' + esc(r.cat || '—') + '</td><td>' + esc(r.chains.slice(0, 3).join(', ')) + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') + '</td>' +
        '<td class="r">' + fmtUsd(r.tvl) + '</td><td class="r">' + fmtPct(r.chg) + '</td>' +
        '<td class="r">' + fmtAge(r.years, r.listed) + '</td>' +
        '<td class="r"><b>' + fmtUsd(r.value) + '</b></td></tr>';
    }).join('');
    $('count').textContent = list.length + ' of ' + rows.length + ' protocols shown — click a row for its detail and farm plan.';
    Array.prototype.forEach.call(document.querySelectorAll('#rows tr'), function (tr) {
      tr.addEventListener('click', function () { showDetail(tr.getAttribute('data-slug')); });
    });
  }
  function showDetail(slug) {
    var r = rows.find(function (x) { return x.slug === slug; });
    if (!r) return;
    Array.prototype.forEach.call(document.querySelectorAll('#rows tr'), function (tr) {
      tr.classList.toggle('sel', tr.getAttribute('data-slug') === slug);
    });
    var base = r.tvl * r.multiple;
    var chg = r.chg === null ? 0 : r.chg;
    var growth = 1 + clamp(chg, -40, 80) / 200;
    var ageF = 1 + Math.min(r.years, 6) * 0.06;
    $('detail').hidden = false;
    $('detail').innerHTML =
      '<h2>' + esc(r.name) + (r.wl ? '<span class="badge">WATCHLIST</span>' : '') + '</h2>' +
      '<p class="meta">' + esc(r.slug) + ' · ' + esc(r.cat || 'Uncategorised') + ' · ' + esc(r.chains.join(', ')) + ' · records no token</p>' +
      '<div class="kv">' +
      '<div><b>' + fmtUsd(r.value) + '</b><span>implied value · rank #' + r.rank + '</span></div>' +
      '<div><b>' + fmtUsd(r.tvl) + '</b><span>TVL</span></div>' +
      '<div><b>' + (r.chg === null ? '—' : (r.chg >= 0 ? '+' : '') + r.chg.toFixed(1) + '%') + '</b><span>TVL change, 7d</span></div>' +
      '<div><b>' + fmtAge(r.years, r.listed) + '</b><span>listed with no token</span></div>' +
      '<div><b>' + r.multiple.toFixed(3) + '</b><span>category multiple</span></div>' +
      '</div>' +
      '<p><b>How the value is built:</b> ' + fmtUsd(r.tvl) + ' TVL &times; ' + r.multiple.toFixed(3) + ' multiple = ' + fmtUsd(base) +
      '; &times; ' + growth.toFixed(3) + ' growth &times; ' + ageF.toFixed(3) + ' age = <b>' + fmtUsd(r.value) + '</b>.</p>' +
      '<h3>Farm plan — how to farm ' + esc(r.name) + '</h3><ol>' +
      r.steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>';
  }

  ['q', 'cat', 'chain', 'wl', 'sort'].forEach(function (id) {
    $(id).addEventListener('input', render);
    $(id).addEventListener('change', render);
  });

  // Initial state from the URL (?slug= detail, ?cat= ?chain= ?q= ?watchlist=1 ?sort=).
  // A ?slug= load puts the detail first, so a screenshot of it needs no scrolling.
  if (params.get('slug')) document.body.classList.add('detail-top');
  if (params.get('q')) $('q').value = params.get('q');
  if (params.get('cat')) $('cat').value = params.get('cat');
  if (params.get('chain')) $('chain').value = params.get('chain');
  if (params.get('watchlist') === '1') $('wl').checked = true;
  if (params.get('sort')) $('sort').value = params.get('sort');
  render();
  if (params.get('slug')) showDetail(params.get('slug'));
}
