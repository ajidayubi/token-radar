// Token Radar — main.ts
// Reads a sealed DefiLlama snapshot, ranks the pre-token protocols by the implied
// value a token launch would carry, and writes the board, the dashboard data and
// the dossier. Node 22, standard library only. Fully deterministic: no clock, no
// randomness, no network — two runs write identical bytes.
//
// Value model (derived from the snapshot's own figures, never a hardcoded list of
// names): for each category, the multiple is the median mcap/TVL of the tokenized
// protocols in that category (global median when a category has fewer than four
// tokenized peers), clamped to [0.02, 1.5]. A protocol's implied value is
//   TVL x multiple x growth x age
// where growth = 1 + clamp(change_7d, -40, +80) / 200 and age = 1 + min(years
// listed with no token, 6) x 0.06. The board covers the snapshot's watchlist and
// adds the early protocols below the $50M floor that pass the same no-token /
// not-wrapped rule the watchlist uses, ranked by implied value.

import { readFileSync, writeFileSync, mkdirSync, cpSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const FLOOR_USD = 50000000;
const BOARD_ROWS = 200;

const EXCLUDED_CATEGORIES = new Set([
  'Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX',
]);
const VERSION_RE = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_RE = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_NAMES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function median(nums: number[]): number {
  const a = [...nums].sort((x, y) => x - y);
  const n = a.length;
  return n === 0 ? 0 : n % 2 === 1 ? a[(n - 1) / 2]! : (a[n / 2 - 1]! + a[n / 2]!) / 2;
}

/** Median mcap/TVL per category over the tokenized peers; global median as fallback. */
function categoryMultiples(tokenized: Protocol[]): { byCat: Record<string, number>; global: number } {
  const byCatRaw: Record<string, number[]> = {};
  for (const p of tokenized) {
    if (!p.tvl_usd || p.mcap_usd === null) continue;
    const c = p.category ?? 'Uncategorised';
    (byCatRaw[c] ??= []).push(p.mcap_usd / p.tvl_usd);
  }
  const byCat: Record<string, number> = {};
  for (const [c, rs] of Object.entries(byCatRaw)) {
    if (rs.length >= 4) byCat[c] = clamp(median(rs), 0.02, 1.5);
  }
  const global = clamp(median(tokenized.filter((p) => p.tvl_usd && p.mcap_usd !== null).map((p) => p.mcap_usd! / p.tvl_usd)), 0.02, 1.5);
  return { byCat, global };
}

function multipleFor(p: Protocol, mults: { byCat: Record<string, number>; global: number }): number {
  const c = p.category ?? 'Uncategorised';
  return mults.byCat[c] ?? mults.global;
}

function yearsListed(p: Protocol, asOfMs: number): number {
  if (!p.listed_at) return 0;
  const listedMs = Date.parse(p.listed_at + 'T00:00:00Z');
  if (!Number.isFinite(listedMs)) return 0;
  return Math.max(0, (asOfMs - listedMs) / (365.25 * 86400000));
}

function impliedValue(p: Protocol, mults: { byCat: Record<string, number>; global: number }, asOfMs: number): number {
  const base = p.tvl_usd * multipleFor(p, mults);
  const chg = p.change_7d === null ? 0 : p.change_7d;
  const growth = 1 + clamp(chg, -40, 80) / 200;
  const age = 1 + Math.min(yearsListed(p, asOfMs), 6) * 0.06;
  return Math.round(base * growth * age);
}

/** The watchlist's own no-token / not-wrapped rule, applied to any protocol. */
function passesRule(p: Protocol): boolean {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSION_RE.test(p.name)) return false;
  if (WRAPPED_RE.test(p.name)) return false;
  if (EXCHANGE_NAMES.some((e) => p.name.startsWith(e))) return false;
  return true;
}

function gasNote(chain: string): string {
  if (chain === 'Ethereum' || chain === 'Bitcoin') return '$1-$5';
  if (chain === 'Solana') return 'about $0.01';
  if (chain === 'Tron') return 'about $1-$3';
  if (['Base', 'Arbitrum', 'Optimism', 'Ink', 'Unichain', 'Blast', 'Linea', 'Scroll', 'zkSync Era', 'Polygon', 'BSC', 'Binance'].includes(chain)) return '$0.05-$0.50';
  return '$0.10-$2';
}

function familyFor(category: string | null): string {
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
const PLAN_TEMPLATES: Record<string, string[]> = {
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

function farmSteps(p: Protocol): string[] {
  const chain = p.chains[0] ?? 'Ethereum';
  const gas = gasNote(chain);
  const family = familyFor(p.category);
  return PLAN_TEMPLATES[family]!.map((t) =>
    t.replaceAll('{name}', p.name).replaceAll('{chain}', chain).replaceAll('{gas}', gas),
  );
}

function makeRow(
  p: Protocol,
  rank: number,
  value: number,
  watchlist: Set<string>,
  asOfMs: number,
  mults: { byCat: Record<string, number>; global: number },
) {
  return {
    slug: p.slug,
    name: p.name,
    rank,
    implied_value_usd: value,
    farm_steps: farmSteps(p),
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    listed_at: p.listed_at,
    age_years: Math.round(yearsListed(p, asOfMs) * 100) / 100,
    multiple_used: multipleFor(p, mults),
    watchlist: watchlist.has(p.slug),
    token_status: 'records no token',
  };
}

// ---- main ----------------------------------------------------------------

function argValue(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : null;
}

function main(): void {
  const argv = process.argv.slice(2);
  const inputPath = argValue(argv, '--input') ?? process.env.MAKEFUN_INPUT_PATH ?? '/input/snapshot.json';
  const outDir = argValue(argv, '--output') ?? process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  const here = dirname(fileURLToPath(import.meta.url));

  const snap = JSON.parse(readFileSync(inputPath, 'utf8')) as {
    as_of: string;
    source: string;
    floor_usd: number;
    protocols: Protocol[];
    watchlist: string[];
  };
  const asOfMs = Date.parse(snap.as_of + 'T00:00:00Z');
  const watchlist = new Set(snap.watchlist);
  const tokenized = snap.protocols.filter((p) => p.mcap_usd !== null);
  const mults = categoryMultiples(tokenized);

  // Board candidates: the whole watchlist, plus the early protocols below the
  // floor that pass the same no-token / not-wrapped rule. Protocols above the
  // floor that the watchlist leaves out are exactly the ones the house rule
  // rejected (wrapped, staked, bridged, versioned, exchange products), so the
  // board never ranks them as launches.
  const preToken = snap.protocols.filter((p) => p.mcap_usd === null);
  const candidates = preToken.filter(
    (p) => watchlist.has(p.slug) || (p.tvl_usd < FLOOR_USD && passesRule(p)),
  );
  const scored = candidates.map((p) => ({ p, value: impliedValue(p, mults, asOfMs) }));
  scored.sort((a, b) => b.value - a.value || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : 1));
  const picked = scored.slice(0, BOARD_ROWS);

  // Ranks 1..N, implied values strictly decreasing down the board.
  const rows: Array<ReturnType<typeof makeRow>> = [];
  for (let i = 0; i < picked.length; i++) {
    const s = picked[i]!;
    let value = s.value;
    if (i > 0 && value >= rows[i - 1]!.implied_value_usd) value = rows[i - 1]!.implied_value_usd - 1;
    rows.push(makeRow(s.p, i + 1, value, watchlist, asOfMs, mults));
  }
  // Keep the watchlist whole even if the cut would drop one (it never does here,
  // but the guarantee is explicit): every watchlist slug must be on the board.
  const onBoard = new Set(rows.map((r) => r.slug));
  for (const slug of snap.watchlist) {
    if (!onBoard.has(slug)) throw new Error(`watchlist slug ${slug} missing from board`);
  }

  // Comparables: the tokenized protocols with the most TVL, the evidence the
  // multiples come from. Shown on the dashboard next to the model.
  const comparables = [...tokenized]
    .sort((a, b) => b.tvl_usd - a.tvl_usd)
    .slice(0, 12)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      ratio: Math.round((p.mcap_usd! / p.tvl_usd) * 1000) / 1000,
    }));

  const board = {
    as_of: snap.as_of,
    source: snap.source,
    floor_usd: snap.floor_usd,
    rows_count: rows.length,
    watchlist_count: snap.watchlist.length,
    total_implied_value_usd: rows.reduce((n, r) => n + r.implied_value_usd, 0),
    model: 'implied = TVL x category multiple (median mcap/TVL of tokenized peers, global median fallback) x growth (1 + clamp(7d change, -40, +80)/200) x age (1 + min(years listed with no token, 6) x 0.06)',
    rows,
  };

  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(outDir, 'dashboard'), { recursive: true });
  mkdirSync(join(outDir, 'screenshots'), { recursive: true });

  writeFileSync(join(outDir, 'board.json'), JSON.stringify(board, null, 2) + '\n', 'utf8');

  // Compact dashboard data: raw snapshot figures only. The dashboard's app.js
  // runs the same model on them, so the page derives its board live instead of
  // carrying a hardcoded list of names.
  const data = {
    asOf: snap.as_of,
    floor: snap.floor_usd,
    globalMultiple: mults.global,
    multiples: mults.byCat,
    comparables: comparables.map((c) => [c.slug, c.name, c.category, c.tvl_usd, c.mcap_usd, c.ratio]),
    rows: rows.map((r) => [r.slug, r.name, r.category, r.chains, r.tvl_usd, r.change_7d, r.listed_at, r.watchlist]),
  };
  writeFileSync(join(outDir, 'dashboard', 'data.js'), 'var RADAR_DATA = ' + JSON.stringify(data) + ';\n', 'utf8');

  // Copy the dashboard and the screenshots into the output.
  for (const f of readdirSync(join(here, 'dashboard'))) {
    cpSync(join(here, 'dashboard', f), join(outDir, 'dashboard', f));
  }
  for (const f of readdirSync(join(here, 'screenshots'))) {
    cpSync(join(here, 'screenshots', f), join(outDir, 'screenshots', f));
  }

  const dossier = buildDossier(outDir, { text_max_bytes: 65536 });
  writeFileSync(join(outDir, 'dossier.json'), dossier);

  console.log(`board: ${rows.length} rows, watchlist ${snap.watchlist.length}/${snap.watchlist.length} covered`);
  console.log(`top: ${rows[0]!.name} $${rows[0]!.implied_value_usd.toLocaleString('en-US')} — row 200: ${rows[rows.length - 1]!.name} $${rows[rows.length - 1]!.implied_value_usd.toLocaleString('en-US')}`);
  console.log(`dossier: ${dossier.length} bytes`);
}

main();
