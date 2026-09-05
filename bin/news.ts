#!/usr/bin/env node
/**
 * news — その日の IT の話題
 *
 * 拠点にある唯一の「polidog でも AI でもない」記録。`よその日記/` を書く
 * ときの素材で、**その日、外で何が話されていたか**を1枚に置く。
 *
 * ## なぜ部屋にするか（拾って渡すだけにしない）
 *
 * 2階（拠点の中しか見ない）を割らないため。`guest.ts` が自分で取りに行くと、
 * 日記を書く道具が外へ出ることになる。1階に置けば、あとは今までどおり
 * 「拠点を読んで畳む」で済むし、全文検索にも乗って**あとから「その日、何が
 * あったか」を引ける**。`株/` と同じ立ち位置 —— 外から取ってくるが1階。
 *
 * ## 出どころ
 *
 * - **Hacker News**（Algolia の検索 API）—— **過去の日付で引ける**ので、
 *   拠点にある日をぜんぶ埋められる。キーも要らない。
 * - **はてなブックマーク（IT）** —— 日本語の話題。ただし RSS は直近2日ぶんしか
 *   持っていないので、**過去は埋まらない**。これから先だけ貯まる。
 *   落とし穴59 の X と同じ形（片方は静止画、片方は生き物）。
 *
 * ## 数を書かない（落とし穴11）
 *
 * HN の points もはてなのブックマーク数も、あとから増える。書くと同じ日が
 * 毎晩書き換わって冪等が壊れる。**並び順で大きさを表す**（取るときには使う。
 * 書かないだけ）。
 *
 * ## それでも冪等ではないので、追記のみ
 *
 * 順位そのものも動く。だから `日記/` と同じ:
 *
 *   **追記のみ・一度書いたら直さない。**
 *
 * 書き直したいときは、そのファイルを手で消す。
 *
 * 使い方:
 *     news.ts                  # 拠点にある日で、まだ無い日を埋める
 *     news.ts --dry-run        # 書かずに結果だけ
 *     news.ts --since 2026-09-01
 *     news.ts --quiet          # 1行だけ（定時便用）
 *     news.ts --show 2026-09-02  # 拠点に書かずに1日ぶん出す（中身を見る）
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { KYOTEN, frontmatter, n, take } from "./util.ts";
import { listFiles, parseArgs, parseSince } from "./cli.ts";

const ROOM = join(KYOTEN, "ニュース");

/** 立ち会った日の一覧はここから取る（＝拠点にある日）。 */
const AIBO = join(KYOTEN, "アイボ");

/** 1日に載せる本数。日記の素材なので、読み切れる数で止める。 */
const HN_LIMIT = 12;
const HATENA_LIMIT = 12;

/** 見出しの長さ。長いものは切る（原文ママの原則3は発話の話で、見出しは別）。 */
const TITLE_LIMIT = 160;

const TIMEOUT = 20_000;

const HN = "https://hn.algolia.com/api/v1/search";
const HATENA = "https://b.hatena.ne.jp/hotentry/it.rss";

type Item = { title: string; url: string };

// ---------------------------------------------------------------- 外から

async function get(url: string): Promise<Response> {
  return await fetch(url, {
    headers: { "User-Agent": "kyoten/1.0 (+https://github.com/polidog/kyoten)" },
    signal: AbortSignal.timeout(TIMEOUT),
  });
}

/** JST のその日の 00:00 と、翌日の 00:00（秒）。 */
function jstRange(date: string): [number, number] {
  const start = Date.parse(`${date}T00:00:00+09:00`) / 1000;
  return [start, start + 86_400];
}

/**
 * Hacker News。その日に立ったスレッドを、点数の高い順に。
 *
 * `search`（`search_by_date` ではない）は既定で人気順に返すので、日付で
 * 挟むだけで「その日いちばん話されたもの」が上から取れる。
 */
async function fetchHN(date: string): Promise<Item[]> {
  const [from, to] = jstRange(date);
  const url = new URL(HN);
  url.searchParams.set("tags", "story");
  url.searchParams.set("numericFilters", `created_at_i>${from},created_at_i<${to}`);
  url.searchParams.set("hitsPerPage", String(HN_LIMIT));
  const res = await get(url.toString());
  if (!res.ok) throw new Error(`HN が ${res.status}`);
  const body = (await res.json()) as { hits?: { title?: string; url?: string; objectID?: string }[] };
  const out: Item[] = [];
  for (const hit of body.hits ?? []) {
    const title = (hit.title ?? "").trim();
    if (!title) continue;
    // 本文だけの投稿（Ask HN など）は URL を持たないので、スレッドを指す
    out.push({ title, url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}` });
  }
  return out;
}

/** XML の実体参照を開く。`&amp;` は最後（落とし穴62 と同じ順）。 */
function unescapeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * はてなブックマークの IT。RSS は直近ぶんしか持っていないので、頼んだ日が
 * 無ければ空で返す（**取れなかった、ではない**。落とし穴14 と同じ区別で、
 * 空の節を書かないことで「無い」を残す）。
 */
async function fetchHatena(date: string): Promise<Item[]> {
  const res = await get(HATENA);
  if (!res.ok) throw new Error(`はてなが ${res.status}`);
  const xml = await res.text();
  const out: Item[] = [];
  // RDF なので `<item rdf:about="...">` が1件。dc:date でその日のものだけ拾う
  for (const block of xml.split(/<item[\s>]/).slice(1)) {
    const when = /<dc:date>([0-9-]{10})/.exec(block);
    if (!when || when[1] !== date) continue;
    const title = /<title>([\s\S]*?)<\/title>/.exec(block);
    const link = /<link>([\s\S]*?)<\/link>/.exec(block);
    if (!title || !link) continue;
    out.push({ title: unescapeXml(title[1]).trim(), url: unescapeXml(link[1]).trim() });
    if (out.length >= HATENA_LIMIT) break;
  }
  return out;
}

// ---------------------------------------------------------------- 書く

function render(date: string, hn: Item[], hatena: Item[]): string {
  const head = frontmatter({
    room: "ニュース",
    date,
    hn: hn.length,
    hatena: hatena.length,
  });
  const parts = [head, `# ${date} の話題`];
  const list = (items: Item[]) =>
    items.map((it) => `- ${take(it.title, TITLE_LIMIT)}\n  ${it.url}`).join("\n");

  if (hn.length) parts.push(`## Hacker News\n\n${list(hn)}`);
  // はてなは過去が取れないので、無い日がふつうにある。節ごと出さない
  if (hatena.length) parts.push(`## はてなブックマーク（IT）\n\n${list(hatena)}`);
  return `${parts.join("\n\n")}\n`;
}

/** 日付ごとに1枚の部屋にある日付の一覧。 */
function datesIn(root: string): string[] {
  if (!existsSync(root)) return [];
  return listFiles(root, ".md")
    .map((p) => p.slice(p.lastIndexOf("/") + 1, -3))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
}

// ---------------------------------------------------------------- 入口

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2), ["dry-run", "quiet"], ["since", "show"]);
  const since = parseSince(args.values.since);
  if (since === undefined) return 2;

  // 中身を見るだけ。拠点には書かない
  const show = args.values.show;
  if (show) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(show)) {
      console.error(`日付は YYYY-MM-DD で: ${show}`);
      return 2;
    }
    const [hn, hatena] = await Promise.all([
      fetchHN(show).catch((e: Error) => { console.error(`HN: ${e.message}`); return []; }),
      fetchHatena(show).catch((e: Error) => { console.error(`はてな: ${e.message}`); return []; }),
    ]);
    if (!hn.length && !hatena.length) return 1;
    console.log(render(show, hn, hatena));
    return 0;
  }

  // 埋めるのは**拠点にある日**（＝アイボの記録がある日）。今日はまだ
  // 終わっていないので入れない（落とし穴18 とは別 —— 追記のみなので
  // 走らせた日を見てよい。日記と同じ扱い）
  const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
  const targets = datesIn(AIBO).filter((d) => d < today && (!since || d >= since));

  let written = 0;
  let already = 0;
  const lost: string[] = [];

  for (const date of targets) {
    const out = join(ROOM, date.slice(0, 7), `${date}.md`);
    if (existsSync(out)) {
      // 追記のみ。順位も点数もあとから動くので、できたものには触らない
      already += 1;
      continue;
    }

    let hn: Item[] = [];
    let hatena: Item[] = [];
    try {
      hn = await fetchHN(date);
    } catch (err) {
      // 取れなかった日は**書かない**（空の1枚を置くと、その日は永久に
      // 空のままになる —— 追記のみなので。落とし穴14 と同じ形）
      lost.push(`${date}（${(err as Error).message}）`);
      continue;
    }
    try {
      hatena = await fetchHatena(date);
    } catch {
      // はてなは落ちても HN があれば書く。過去の日はどのみち空で返る
    }
    if (!hn.length && !hatena.length) {
      lost.push(`${date}（1件も無い）`);
      continue;
    }

    if (args.flags["dry-run"]) {
      console.log(`━━━ ${date}（HN ${hn.length} / はてな ${hatena.length}）`);
      written += 1;
      continue;
    }

    mkdirSync(join(ROOM, date.slice(0, 7)), { recursive: true });
    writeFileSync(out, render(date, hn, hatena), "utf8");
    written += 1;
  }

  if (args.flags.quiet) {
    // 何もしなかった日も1行出す（落とし穴65）
    console.log(
      `news: ${n(already + written)}日 (new ${written} / ある ${already}` +
        (lost.length ? ` / とどかず ${lost.length}` : "") + ")",
    );
  } else {
    if (args.flags["dry-run"]) console.log("（書かずに確認）");
    console.log(`  ニュース     : ${n(already + written)} 日`);
    console.log(`    あたらしい : ${n(written)}`);
    console.log(`    もうある   : ${n(already)}`);
    for (const why of lost) console.log(`    とどかず   : ${why}`);
    console.log(`  ばしょ : ${ROOM}`);
  }

  // 1日も取れなかったときだけ非ゼロ（一部が欠けるのは普通の状態）
  return written === 0 && lost.length > 0 ? 1 : 0;
}

process.exit(await main());
