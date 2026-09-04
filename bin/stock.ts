#!/usr/bin/env node
/**
 * stock — 保有株の値動き
 *
 * 拠点の `株/` に、確定した日の終値と評価額を1日1枚積む。
 * 見立て（予想・助言）はここでは書かない。それは `outlook.ts` の仕事。
 *
 * ## 保有だけは手で書く（原則4 の唯一の例外）
 *
 * 台帳は **Markdown の表**にしてある。JSON で置いていたが、**Obsidian は
 * `.json` をファイル一覧に出さない**（`showUnsupportedFiles` が既定で off）。
 * 唯一手で書くファイルが Obsidian で開けないのでは、拠点をベースにする
 * 意味が無い。表なら Obsidian でそのまま開いて、行を足して閉じられる。
 *
 * そのぶん JSON の厳しさが無くなるので、**読めない行は飛ばさずに止める**。
 * 黙って飛ばすと保有が1本減ったまま評価額を書き、`株/` は追記のみなので
 * あとから直せない。
 *
 * 原則4 は「拠点に人間が手入力する部屋を作らない」だが、**何を何株
 * 持っているかはログから機械では起こせない**。証券会社のログは手元に
 * 無いし、会話ログにも書いていない。
 *
 * だから `株/保有.md` の1枚だけを例外にする。手で書くのはここだけで、
 * **値も評価額も見立ても全部そこから機械が起こす**。原則4 が止めたかった
 * のは「毎日せっせと書き足す部屋」であって（`00_思考`・Discord秘書・
 * agent-tracer は全部それで死んだ）、買ったときに1行足すだけの台帳は
 * その形にならない。
 *
 * ## どこから取るか（依存ゼロ・API キー無し）
 *
 *   - 日本株・米国株・ETF・為替・指数 … Yahoo Finance の chart
 *     `query1.finance.yahoo.com/v8/finance/chart/<symbol>`
 *   - 日本の投資信託 … 投資信託協会の CSV
 *     `toushin-lib.fwg.ne.jp/FdsWeb/FDST030000/csv-file-download`
 *     （Shift_JIS。`TextDecoder("shift_jis")` で開く）
 *
 * 投信は Yahoo の口では 404 になる（実測: `0331418A` も `0331418A.T` も
 * だめ）。だからソースを2つ持っている。
 *
 * ## 冪等をどう守るか
 *
 * 株価は毎秒動くので、素直に書くと原則1・2 が両方壊れる。2つで守る。
 *
 * 1. **場が開いているあいだのバーは書かない。** Yahoo の日足は、当日ぶんの
 *    バーが場中も返ってくる（まだ動く値）。確定したかは `regularMarketTime`
 *    が `currentTradingPeriod.regular.end` に届いたかで見分ける。
 *    投信協会の CSV は確定した基準価額しか載らないので、こちらは捨てない。
 *
 * 2. **拠点にある最後の日より先だけ書く**（落とし穴18 の形）。過去を
 *    埋め戻さないのは、`保有.md` が**いまの株数**しか持っていないから。
 *    去年の株価に今日の株数を掛けたら、持っていなかった株の評価額を
 *    でっち上げることになる。だから `株/` は実質**追記のみ** —— あとで
 *    買い増しても、書いてある日は書き換えない。
 *
 * いま幾らかを見たいだけなら `--now`。こちらは**拠点に一切書かない**。
 *
 * 使い方:
 *     stock.ts                 # 確定した日を書く
 *     stock.ts --now           # いまの値を出すだけ（書かない）
 *     stock.ts --dry-run       # 書かずに結果だけ
 *     stock.ts --quiet         # 1行だけ（定時便用）
 *     stock.ts --init          # 保有.md の雛形を出す
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { KYOTEN, frontmatter, n, readText, writeIfChanged } from "./util.ts";
import { listFiles, parseArgs } from "./cli.ts";

const ROOM = join(KYOTEN, "株");
const HOLDINGS = join(ROOM, "保有.md");

/** 1本にかける上限。夜に走るので待てるが、ぶら下がらせはしない。 */
const TIMEOUT = 20_000;

/** 投信の基準価額は 1万口あたり。評価額は 口数 ÷ 10000 を掛ける。 */
const FUND_UNIT = 10_000;

const YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart";
const TOUSHIN = "https://toushin-lib.fwg.ne.jp/FdsWeb/FDST030000/csv-file-download";

// ---------------------------------------------------------------- 保有

export interface Holding {
  /** Yahoo の銘柄コード（`7203.T` `AAPL` `1306.T`）。投信ならこちらは空。 */
  readonly symbol: string;
  /** 投資信託協会コード（`0331418A`）。株ならこちらは空。 */
  readonly fund: string;
  readonly isin: string;
  readonly name: string;
  /** 株数（投信なら口数）。 */
  readonly units: number;
  /** 取得単価。投信は 1万口あたり。**書いていなければ null**（0 ではない）。 */
  readonly cost: number | null;
  /** 外貨建てを買ったときのレート。無ければ円建ての損益は出さない。 */
  readonly rate: number | null;
}

export interface Book {
  readonly holdings: readonly Holding[];
  /** 持ってはいないが横に置いておきたいもの（指数・為替）。 */
  readonly refs: readonly string[];
}

const TEMPLATE = `---
room: 株
---

# 保有

**ここだけ手で書く。** 買ったら行を足し、売ったら行を消す。
値も評価額も見立ても、ぜんぶここから機械が起こす。

- \`銘柄\` … 株・ETF は Yahoo のコード（\`4813.T\` \`AAPL\`）。投資信託は協会コード
- \`isin\` … 投資信託のときだけ要る（株なら空のまま）
- \`数\` … 株数。投資信託は口数
- \`取得単価\` … 買った値段。投資信託は1万口あたり。分からなければ空でよい
  （評価額だけ出て、損益は \`—\` になる）
- \`取得レート\` … 外貨で買ったときの円レート。円建てなら空

| 銘柄 | isin | 名前 | 数 | 取得単価 | 取得レート |
|---|---|---|---|---|---|
| 4813.T |  | ACCESS | 100 | 380 |  |
| AAPL |  | Apple | 10 | 180 | 148.2 |
| 0331418A | JP90C000H1T1 | eMAXIS Slim 全世界株式（オール・カントリー） | 1234567 | 21500 |  |

## 参考

持ってはいないが、横に置いておきたいもの。

- ^N225
- USDJPY=X
`;

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * 人が手で書いた数を読む。`1,234,567` も `100株` も通す。
 * 空なら null（「書いていない」）、数として読めなければ undefined（＝止める合図）。
 */
function cell(raw: string): number | null | undefined {
  const t = raw.replace(/[,\s円株口]/g, "");
  if (!t) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : undefined;
}

/** `| a | b |` の1行を升目に割る。 */
function cells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

/** 区切りの行（`|---|---|`）か。 */
function isRule(row: readonly string[]): boolean {
  return row.length > 0 && row.every((c) => /^:?-{2,}:?$/.test(c));
}

const TROUBLE = `雛形は stock.ts --init`;

/**
 * `株/保有.md` を読む。手で書く唯一の場所なので、見出しも列の名前も日本語。
 *
 * **読めない行は飛ばさない。** 黙って飛ばすと保有が1本減ったまま評価額を
 * 書いてしまい、`株/` は追記のみなので後から直せない（落とし穴14 と同じ形で、
 * 「読めなかった」を「持っていない」にしない）。
 */
export function readBook(): Book | null {
  const text = readText(HOLDINGS);
  if (!text.trim()) return null;

  const lines = text.split("\n");
  const table = lines.filter((l) => l.trim().startsWith("|"));
  if (table.length < 2) {
    console.error(`${HOLDINGS} に保有の表がありません`);
    console.error(TROUBLE);
    return null;
  }

  const head = cells(table[0]);
  const at = (name: string) => head.indexOf(name);
  const iCode = at("銘柄");
  const iName = at("名前");
  const iUnits = at("数");
  if (iCode < 0 || iName < 0 || iUnits < 0) {
    console.error(`${HOLDINGS} の表の見出しに「銘柄」「名前」「数」が要ります`);
    console.error(`  いまの見出し: ${head.join(" / ")}`);
    return null;
  }
  const iIsin = at("isin");
  const iCost = at("取得単価");
  const iRate = at("取得レート");

  const holdings: Holding[] = [];
  for (let n = 1; n < table.length; n++) {
    const row = cells(table[n]);
    if (isRule(row)) continue;
    const code = (row[iCode] ?? "").trim();
    // 空の行は、表の下に余白として置かれることがある。銘柄が無ければ飛ばす
    if (!code) continue;

    const name = (row[iName] ?? "").trim();
    const units = cell(row[iUnits] ?? "");
    const cost = iCost < 0 ? null : cell(row[iCost] ?? "");
    const rate = iRate < 0 ? null : cell(row[iRate] ?? "");
    const bad = [
      units === undefined ? "数" : "",
      cost === undefined ? "取得単価" : "",
      rate === undefined ? "取得レート" : "",
    ].filter(Boolean);
    if (bad.length) {
      console.error(`${HOLDINGS} の「${name || code}」の ${bad.join("・")} が数として読めません`);
      console.error(`  ${table[n].trim()}`);
      return null;
    }

    const isin = iIsin < 0 ? "" : (row[iIsin] ?? "").trim();
    holdings.push({
      // isin が書いてあれば投資信託。無ければ Yahoo の銘柄コード
      symbol: isin ? "" : code,
      fund: isin ? code : "",
      isin,
      name: name || code,
      units: units ?? 0,
      // 0 も「書いていない」扱い。買値が 0 円の持ち株は無いので、
      // 埋め忘れたまま流しても損益が評価額まるごとに化けない
      cost: cost !== null && cost > 0 ? cost : null,
      rate: rate !== null && rate > 0 ? rate : null,
    });
  }

  // `## 参考` の下の箇条書き
  const refs: string[] = [];
  let inRefs = false;
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      inRefs = /^#{1,6}\s*参考\s*$/.test(line.trim());
      continue;
    }
    if (!inRefs) continue;
    const got = /^\s*[-*]\s+(\S+)/.exec(line);
    if (got) refs.push(got[1]);
  }

  return { holdings, refs };
}

// ---------------------------------------------------------------- 取ってくる

/** 1銘柄ぶんの値。`closes` は取引所の現地日付 → 終値。 */
export interface Series {
  readonly key: string;
  readonly name: string;
  readonly currency: string;
  /** 確定した日足だけ。日付は YYYY-MM-DD 昇順。 */
  readonly closes: ReadonlyMap<string, number>;
  /** いまの値（場中なら動く）。書く側は使わない。 */
  readonly now: number | null;
  readonly nowChangePct: number | null;
  readonly high52: number | null;
  readonly low52: number | null;
  readonly error: string;
}

function empty(key: string, name: string, error: string): Series {
  return {
    key, name, currency: "", closes: new Map(),
    now: null, nowChangePct: null, high52: null, low52: null, error,
  };
}

async function get(url: string): Promise<Response> {
  return await fetch(url, {
    headers: { "User-Agent": "kyoten/1.0 (+https://github.com/polidog/kyoten)" },
    signal: AbortSignal.timeout(TIMEOUT),
  });
}

/**
 * いちばん新しいバーがまだ動くか（＝その日の場が続いているか）。
 *
 * 最初は「最後のバーを必ず捨てる」にしていたが、それだと**確定した日まで
 * 捨てていた** —— Yahoo は場が引けた直後、当日ぶんのバーを `close: null` の
 * まま返すことがある（実測: 東証が 15:30 に引けたあと、09-04 のバーが null
 * で、null を落としてから捨てたので 09-03 まで消えた）。
 *
 * 見分けかたは2つ。バーの日付がその場の日付と違えば、もう終わっている。
 * 同じなら `regularMarketTime` が引け（`regular.end`）に届いたかで見る。
 * 分からないときは捨てる（書いたものが翌日変わるほうが困る）。
 */
function stillMoving(
  meta: Record<string, unknown>,
  lastDate: string,
  offset: number,
): boolean {
  const period = (meta.currentTradingPeriod as Record<string, unknown> | undefined)
    ?.regular as Record<string, unknown> | undefined;
  const end = num(period?.end);
  const seen = num(meta.regularMarketTime);
  if (!end || !seen) return true;

  const endDate = new Date((end + offset) * 1000).toISOString().slice(0, 10);
  if (lastDate !== endDate) return false;
  return seen < end;
}

/**
 * 引けたのに空いている当日ぶんを、確定した終値で埋める。
 *
 * Yahoo は場が引けたあとも、複数日ぶんを頼んだときの日足バーを
 * しばらく `close: null` のまま返す（実測: 東証が 15:30 に引けて
 * **9時間半たっても null**。`range=1d` だけは埋まっていて 421 だった）。
 *
 * 放っておくと、定時便（03:00）がその日を書けない。値も見立ても
 * まるまる1日遅れて積まれることになる。
 *
 * 引けていれば `regularMarketPrice` がその場の確定した終値なので、
 * **バーの無い日だけ**それで埋める（`range=1d` の値と一致することを
 * 実測で確かめてある）。バーがあるならそちらを優先するので、翌日に
 * 埋まっても値が二重にはならない。
 */
function fillClosed(
  closes: Map<string, number>,
  meta: Record<string, unknown>,
  offset: number,
): void {
  const period = (meta.currentTradingPeriod as Record<string, unknown> | undefined)
    ?.regular as Record<string, unknown> | undefined;
  const end = num(period?.end);
  const seen = num(meta.regularMarketTime);
  const price = meta.regularMarketPrice;
  // 引けていないなら、その値はまだ動く
  if (!end || !seen || seen < end) return;
  if (typeof price !== "number" || !Number.isFinite(price)) return;

  const date = new Date((end + offset) * 1000).toISOString().slice(0, 10);
  if (!closes.has(date)) closes.set(date, price);
}

/** Yahoo の日足。まだ動いているバーは捨てる。 */
async function fetchQuote(symbol: string, fallbackName: string): Promise<Series> {
  let body: Record<string, unknown>;
  try {
    const res = await get(`${YAHOO}/${encodeURIComponent(symbol)}?range=1mo&interval=1d`);
    if (!res.ok) return empty(symbol, fallbackName, `HTTP ${res.status}`);
    body = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    return empty(symbol, fallbackName, (err as Error).message);
  }

  const chart = body.chart as Record<string, unknown> | undefined;
  const result = (chart?.result as Record<string, unknown>[] | undefined)?.[0];
  const meta = result?.meta as Record<string, unknown> | undefined;
  if (!result || !meta) return empty(symbol, fallbackName, "中身が読めない");

  const stamps = (result.timestamp as number[] | undefined) ?? [];
  const quote = (result.indicators as Record<string, unknown> | undefined)?.quote as
    | Record<string, unknown>[]
    | undefined;
  const closeRow = (quote?.[0]?.close as (number | null)[] | undefined) ?? [];

  // 取引所の現地日付に直す。実行環境の TZ に依存させない（util.ts と同じ考え）
  const offset = num(meta.gmtoffset);
  const pairs: [string, number][] = [];
  for (let i = 0; i < stamps.length; i++) {
    const close = closeRow[i];
    if (typeof close !== "number" || !Number.isFinite(close)) continue;
    pairs.push([new Date((stamps[i] + offset) * 1000).toISOString().slice(0, 10), close]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const newest = pairs.at(-1)?.[0];
  if (newest && stillMoving(meta, newest, offset)) pairs.pop();

  const closes = new Map(pairs);
  fillClosed(closes, meta, offset);

  return {
    key: symbol,
    name: String(meta.longName ?? meta.shortName ?? (fallbackName || symbol)),
    currency: String(meta.currency ?? ""),
    closes,
    now: typeof meta.regularMarketPrice === "number" ? meta.regularMarketPrice : null,
    nowChangePct:
      typeof meta.regularMarketChangePercent === "number"
        ? meta.regularMarketChangePercent
        : null,
    high52: typeof meta.fiftyTwoWeekHigh === "number" ? meta.fiftyTwoWeekHigh : null,
    low52: typeof meta.fiftyTwoWeekLow === "number" ? meta.fiftyTwoWeekLow : null,
    error: "",
  };
}

/**
 * 投資信託協会の CSV。Shift_JIS・`2026年09月03日,38285,…` の形。
 *
 * ここは**確定した基準価額しか載らない**（当日ぶんは夕方に出て、あとから
 * 動かない）ので、Yahoo と違って最後の行を捨てない。捨てると投信のほうが
 * 常に1日古くなり、全体の書ける日を無駄に引き戻す。
 */
async function fetchFund(fund: string, isin: string, fallbackName: string): Promise<Series> {
  if (!isin) return empty(fund, fallbackName, "isin が要る（協会コードだけでは引けない）");

  let text: string;
  try {
    const url = `${TOUSHIN}?isinCd=${encodeURIComponent(isin)}&associFundCd=${encodeURIComponent(fund)}`;
    const res = await get(url);
    if (!res.ok) return empty(fund, fallbackName, `HTTP ${res.status}`);
    text = new TextDecoder("shift_jis").decode(new Uint8Array(await res.arrayBuffer()));
  } catch (err) {
    return empty(fund, fallbackName, (err as Error).message);
  }

  const closes = new Map<string, number>();
  // `.` は CR にマッチしない（落とし穴30）。行は改行で割ってから trim する
  for (const line of text.split("\n")) {
    const m = /^(\d{4})年(\d{2})月(\d{2})日,(\d+)/.exec(line.trim());
    if (!m) continue;
    closes.set(`${m[1]}-${m[2]}-${m[3]}`, Number(m[4]));
  }
  if (closes.size === 0) return empty(fund, fallbackName, "基準価額が1行も読めない");

  const dates = [...closes.keys()].sort();
  const last = closes.get(dates.at(-1)!)!;
  const prev = dates.length > 1 ? closes.get(dates.at(-2)!)! : null;

  return {
    key: fund,
    name: fallbackName || fund,
    currency: "JPY",
    closes,
    now: last,
    nowChangePct: prev ? ((last - prev) / prev) * 100 : null,
    high52: Math.max(...closes.values()),
    low52: Math.min(...closes.values()),
    error: "",
  };
}

/** 保有と参考をまとめて取ってくる。銘柄コードで引ける形にして返す。 */
export async function fetchAll(book: Book): Promise<Map<string, Series>> {
  const jobs: Promise<Series>[] = [];
  for (const h of book.holdings) {
    jobs.push(h.fund ? fetchFund(h.fund, h.isin, h.name) : fetchQuote(h.symbol, h.name));
  }
  for (const s of book.refs) jobs.push(fetchQuote(s, s));

  const out = new Map<string, Series>();
  for (const series of await Promise.all(jobs)) out.set(series.key, series);
  return out;
}

// ---------------------------------------------------------------- 数える

export function keyOf(h: Holding): string {
  return h.fund || h.symbol;
}

/** 投信は 1万口あたりなので、掛ける前に単位を揃える。 */
function unitsOf(h: Holding): number {
  return h.fund ? h.units / FUND_UNIT : h.units;
}

/** その日までに分かっている、いちばん新しい終値。休場日をまたぐため。 */
export function closeAt(series: Series, date: string): number | null {
  let best: number | null = null;
  let bestDate = "";
  for (const [d, v] of series.closes) {
    if (d <= date && d > bestDate) {
      best = v;
      bestDate = d;
    }
  }
  return best;
}

export interface Line {
  readonly holding: Holding;
  readonly series: Series;
  readonly price: number | null;
  /** 前の終値からの変化率。出せなければ null。 */
  readonly changePct: number | null;
  /** 現地通貨での評価額。 */
  readonly value: number | null;
  /** 円での評価額。円建てならそのまま。 */
  readonly valueJpy: number | null;
  /** 円での取得額。取得単価か取得レートが無ければ null。 */
  readonly costJpy: number | null;
  /** 取得額が出せなかった理由（`保有.md` に無い項目の名前）。出せたなら空。 */
  readonly lacks: string;
}

/**
 * その日の円換算レート。
 *
 * **場中の値を使ってはいけない。** 使うと、同じ日について走らせるたびに
 * 違う評価額が出る（実測: 2回流して 5,550,631 → 5,550,638 と動いた）。
 * 書くときはその日の確定した終値を引く。`--now` のときだけ現在値を使う。
 */
export function fxAt(series: Series | null, date: string | null): number | null {
  if (!series) return null;
  if (date) return closeAt(series, date);
  return series.now ?? [...series.closes.values()].at(-1) ?? null;
}

/** 円換算に使うレート。円建てなら 1。 */
function rateFor(series: Series, fx: number | null): number | null {
  if (!series.currency || series.currency === "JPY") return 1;
  return fx;
}

export function valueOn(
  book: Book,
  data: Map<string, Series>,
  date: string | null,
  fx: number | null,
): Line[] {
  const out: Line[] = [];
  for (const h of book.holdings) {
    const series = data.get(keyOf(h)) ?? empty(keyOf(h), h.name, "取れなかった");
    const price = date ? closeAt(series, date) : series.now;

    let changePct: number | null = null;
    if (date) {
      const before = [...series.closes.keys()].filter((d) => d < date).sort().at(-1);
      const prev = before ? series.closes.get(before)! : null;
      if (prev && price) changePct = ((price - prev) / prev) * 100;
    } else {
      changePct = series.nowChangePct;
    }

    // 数が書かれていなければ、評価額は「分からない」。0 にすると
    // 「持っていない」ことになって、合計が静かに小さくなる
    const known = h.units > 0;
    const value = price === null || !known ? null : price * unitsOf(h);
    const rate = rateFor(series, fx);
    const valueJpy = value !== null && rate !== null ? value * rate : null;
    // 取得単価が要る。外貨ならさらに取得時のレートも要る。
    // どちらか欠けたら円建ての損益は出さない（でっち上げない）
    const costRate = !series.currency || series.currency === "JPY" ? 1 : h.rate;
    const lacks = !known
      ? (h.fund ? "口数" : "株数")
      : h.cost === null ? "取得単価" : costRate === null ? "取得レート" : "";
    const costJpy = lacks ? null : h.cost! * unitsOf(h) * costRate!;

    out.push({ holding: h, series, price, changePct, value, valueJpy, costJpy, lacks });
  }
  return out;
}

/** 全部の保有について終値が分かる、いちばん新しい日。 */
export function lastSettled(
  book: Book,
  data: Map<string, Series>,
  fx: Series | null = null,
): string | null {
  const seen: Series[] = [];
  for (const h of book.holdings) {
    const series = data.get(keyOf(h));
    if (!series) return null;
    seen.push(series);
    // 外貨建てがあるなら、為替の終値が無い日は評価額を出せない
    if (fx && series.currency && series.currency !== "JPY") seen.push(fx);
  }

  let last: string | null = null;
  for (const series of seen) {
    const newest = [...series.closes.keys()].sort().at(-1);
    if (!newest) return null;
    if (last === null || newest < last) last = newest;
  }
  return last;
}

// ---------------------------------------------------------------- 描く

function money(v: number | null, unit = ""): string {
  if (v === null) return "—";
  const rounded = Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100;
  return `${n(rounded)}${unit}`;
}

function pct(v: number | null): string {
  if (v === null) return "—";
  return `${v >= 0 ? "+" : ""}${(Math.round(v * 100) / 100).toFixed(2)}%`;
}

function signed(v: number | null, unit = ""): string {
  if (v === null) return "—";
  return `${v >= 0 ? "+" : "-"}${money(Math.abs(v), unit)}`;
}

export interface Total {
  readonly value: number | null;
  readonly cost: number | null;
  readonly gain: number | null;
  readonly gainPct: number | null;
  /** 円建ての取得額が出せなかった銘柄と、その理由。 */
  readonly missing: readonly string[];
}

export function totalOf(lines: readonly Line[]): Total {
  let value = 0;
  let cost = 0;
  let valueOk = true;
  const missing: string[] = [];

  for (const line of lines) {
    if (line.valueJpy === null) valueOk = false;
    else value += line.valueJpy;
    if (line.costJpy === null) missing.push(`${line.holding.name}: ${line.lacks}`);
    else cost += line.costJpy;
  }
  // 評価額が1つでも分からなければ、合計も分からない。足せるものだけ足すと
  // 「持っている額」が静かに小さく出る（落とし穴14 と同じ形）

  const v = valueOk ? value : null;
  const c = missing.length ? null : cost;
  const gain = v !== null && c !== null ? v - c : null;
  return {
    value: v,
    cost: c,
    gain,
    gainPct: gain !== null && c ? (gain / c) * 100 : null,
    missing,
  };
}

function table(lines: readonly Line[], fx: number | null): string {
  const rows = ["| 銘柄 | 値 | 前日比 | 数 | 評価額(円) | 損益(円) |", "|---|---|---|---|---|---|"];
  for (const line of lines) {
    const h = line.holding;
    const label = `${h.name}${h.fund ? ` (投信 ${h.fund})` : ` (${h.symbol})`}`;
    const cur = line.series.currency && line.series.currency !== "JPY"
      ? ` ${line.series.currency}`
      : "";
    const gain = line.valueJpy !== null && line.costJpy !== null
      ? line.valueJpy - line.costJpy
      : null;
    rows.push(
      `| ${label} | ${money(line.price)}${cur} | ${pct(line.changePct)} | ` +
        `${h.units > 0 ? n(h.units) : "—"} | ${money(line.valueJpy)} | ${signed(gain)} |`,
    );
  }
  // 外貨建てを1つも持っていないなら、為替の行は出さない（使っていないので）
  const foreign = lines.some((l) => l.series.currency && l.series.currency !== "JPY");
  if (foreign && fx !== null) rows.push(`\n（円換算 1USD = ${money(fx)}円）`);
  return rows.join("\n");
}

function refLine(book: Book, data: Map<string, Series>, date: string | null): string {
  const parts: string[] = [];
  for (const symbol of book.refs) {
    const series = data.get(symbol);
    if (!series || series.error) continue;
    const price = date ? closeAt(series, date) : series.now;
    if (price === null) continue;
    parts.push(`${series.name} ${money(price)}`);
  }
  return parts.join(" / ");
}

function render(
  book: Book,
  data: Map<string, Series>,
  date: string,
  lines: readonly Line[],
  fx: number | null,
): string {
  const total = totalOf(lines);
  const head = frontmatter({
    room: "株",
    date,
    銘柄: book.holdings.length,
    評価額: total.value === null ? null : Math.round(total.value),
    損益: total.gain === null ? null : Math.round(total.gain),
  });

  const body: string[] = [`# ${date} の株`, "", table(lines, fx), ""];
  body.push("## 合計", "");
  body.push(`- 評価額 ${money(total.value, "円")}`);
  if (total.cost !== null) {
    body.push(`- 取得額 ${money(total.cost, "円")}`);
    body.push(`- 損益 ${signed(total.gain, "円")}（${pct(total.gainPct)}）`);
  } else {
    body.push(`- 取得額 —（${total.missing.join("、")} が 保有.md に無い）`);
  }

  const refs = refLine(book, data, date);
  if (refs) body.push("", "## 参考", "", refs);

  return `${head}\n\n${body.join("\n")}\n`;
}

// ---------------------------------------------------------------- 入口

/** `株/` に書いてある、いちばん新しい日。 */
function lastWritten(): string | null {
  if (!existsSync(ROOM)) return null;
  const dates = listFiles(ROOM, ".md")
    .map((p) => p.slice(p.lastIndexOf("/") + 1, -3))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  return dates.at(-1) ?? null;
}

function showNow(book: Book, data: Map<string, Series>, fx: number | null): void {
  const lines = valueOn(book, data, null, fx);
  const total = totalOf(lines);

  console.log(table(lines, fx));
  console.log();
  console.log(`  評価額 ${money(total.value, "円")}`);
  if (total.cost !== null) {
    console.log(`  取得額 ${money(total.cost, "円")}`);
    console.log(`  損益   ${signed(total.gain, "円")}（${pct(total.gainPct)}）`);
  } else {
    console.log(`  取得額 —（${total.missing.join("、")} が 保有.md に無い）`);
  }

  const refs = refLine(book, data, null);
  if (refs) console.log(`  参考   ${refs}`);

  for (const line of lines) {
    if (line.series.error) console.error(`  ✗ ${line.holding.name}: ${line.series.error}`);
  }
  console.error("  （場中の値。拠点には書いていない）");
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2), ["dry-run", "quiet", "now", "init"]);

  if (args.flags.init) {
    console.log(TEMPLATE);
    console.error(`↑ これを ${HOLDINGS} に置く（拠点は private。リポジトリには入れない）`);
    return 0;
  }

  // 「まだ持っていない」と「壊れている」を分ける（落とし穴14 と同じ形）。
  // 無いだけなら 0 で終わる —— 定時便に組んであるので、保有.md を置く前の
  // 夜が毎晩「失敗」で埋まるのは違う。
  if (!existsSync(HOLDINGS)) {
    // `--quiet` でも黙らない。定時便は stdout の1行で読むので、何も出さないと
    // 「何も言わずに終わった」になる（落とし穴25 と同じ形）
    if (args.flags.quiet) console.log("stock: 保有.md がまだ無い（stock.ts --init）");
    else {
      console.log(`  株           : ${HOLDINGS} がまだ無い`);
      console.log("  雛形は stock.ts --init");
    }
    return 0;
  }

  const book = readBook();
  if (!book) return 1;
  if (book.holdings.length === 0) {
    console.error(`${HOLDINGS} に「保有」が1件もありません`);
    return 1;
  }

  // 株数を書き忘れたまま流すと、評価額 0 円の日が拠点に積まれる。
  // `株/` は追記のみで書き換えないので、積んでしまうと手で消すしかない。
  //
  // ここは「壊れている」ではなく「まだ書きかけ」なので **0 で終わる**
  // （落とし穴64）。定時便に組んであるので、埋めるまで毎晩「失敗」が
  // 並ぶのは違う。ただし黙りはしない —— 何が足りないかを毎回名指しする。
  //
  // 門を置くのは**書く道だけ**。`--now` は拠点に書かないので、埋まっている
  // ぶんは見せてよい（合計だけは出さない。足せるものだけ足すと嘘になる）。
  const blank = book.holdings.filter((h) => h.units <= 0);
  const names = blank.map((h) => `${h.name}: ${h.fund ? "口数" : "株数"}`);

  // 円換算のレート。`参考` に書いていなくても、外貨建てがあれば黙って引く
  const data = await fetchAll(book);
  const usd = data.get("USDJPY=X") ?? (await fetchQuote("USDJPY=X", "USD/JPY"));

  if (args.flags.now) {
    showNow(book, data, fxAt(usd, null));
    return 0;
  }

  if (blank.length) {
    if (args.flags.quiet) {
      console.log(`stock: まだ書きかけ（${names.join("、")} が ${HOLDINGS} に無い）`);
    } else {
      for (const name of names) console.log(`  ✗ ${name} が ${HOLDINGS} に無い`);
      console.log("  書きかけのまま流すと評価額 0 円の日が積まれるので、書きません");
    }
    return 0;
  }

  const settled = lastSettled(book, data, usd);
  const broken = book.holdings.filter((h) => (data.get(keyOf(h))?.error ?? "") !== "");
  if (!settled) {
    for (const h of broken) console.error(`  ✗ ${h.name}: ${data.get(keyOf(h))!.error}`);
    console.error("確定した終値が揃いません。今回は書きません（落ちた日に空を書かない）");
    return 1;
  }

  // 拠点にある最後の日より先だけ。過去は埋め戻さない（いまの株数しか無いため）
  const from = lastWritten();
  const dates: string[] = [];
  const all = new Set<string>();
  for (const h of book.holdings) {
    for (const d of data.get(keyOf(h))?.closes.keys() ?? []) all.add(d);
  }
  for (const d of [...all].sort()) {
    if (d > settled) continue;
    if (from !== null && d <= from) continue;
    dates.push(d);
  }
  // 何も書いていなければ、確定した最新の1日だけ（履歴をでっち上げない）
  const targets = from === null ? dates.slice(-1) : dates;

  let created = 0;
  for (const date of targets) {
    // レートもその日の確定値を引く。場中の値を混ぜると冪等が壊れる
    const fx = fxAt(usd, date);
    const lines = valueOn(book, data, date, fx);
    const out = join(ROOM, date.slice(0, 7), `${date}.md`);
    const state = writeIfChanged(out, render(book, data, date, lines, fx), args.flags["dry-run"]);
    if (state !== "same") created += 1;
  }

  const total = totalOf(valueOn(book, data, settled, fxAt(usd, settled)));

  if (args.flags.quiet) {
    console.log(
      `stock: 銘柄 ${n(book.holdings.length)} / new ${created}` +
        `（${settled} まで・評価額 ${money(total.value, "円")}）` +
        (broken.length ? ` / 取れず ${broken.length}` : ""),
    );
  } else {
    if (args.flags["dry-run"]) console.log("（書かずに確認）");
    console.log(`  株           : ${n(book.holdings.length)} 銘柄`);
    console.log(`    あたらしい : ${n(created)} 日ぶん`);
    console.log(`    確定        : ${settled} まで（場中のバーは書かない）`);
    console.log(`    評価額      : ${money(total.value, "円")}`);
    if (total.gain !== null) console.log(`    損益        : ${signed(total.gain, "円")}（${pct(total.gainPct)}）`);
    for (const h of broken) console.log(`    ✗ ${h.name}: ${data.get(keyOf(h))!.error}`);
    console.log(`  ばしょ : ${ROOM}`);
  }

  return 0;
}

if (import.meta.main) process.exit(await main());
