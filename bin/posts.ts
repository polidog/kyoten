#!/usr/bin/env node
/**
 * posts — 外に出した言葉を集める
 *
 * polidog.jp・Bluesky・Misskey・X から、自分が外に向けて出した言葉を拠点へ
 * 写す。`会話/` や `自分/` が「閉じた場所での言葉」なのに対して、
 * こちらは公開された言葉。
 *
 * 出力:
 *     投稿/<YYYY-MM>/<DD>-<slug>.md           polidog.jp の記事 1 本
 *     投稿/<YYYY-MM>/bluesky-<YYYY-MM-DD>.md  その日の Bluesky
 *     投稿/<YYYY-MM>/misskey-<YYYY-MM-DD>.md  その日の Misskey
 *     投稿/<YYYY-MM>/x-<YYYY-MM-DD>.md        その日の X（旧 Twitter）
 *
 * X だけ取りに行く先が API ではなく**手元のアーカイブ**。2026-02-06 に無料枠が
 * 廃止され、投稿の読み取りは 1 件 $0.005 の従量課金になった。毎晩叩く道具に
 * 課金の口を持たせるより、公式のアーカイブ（設定 → データのアーカイブを
 * ダウンロード）を 1 回展開して読むほうが安全で、しかも全期間が入る。
 * 代わりにこれから先の投稿は入らない —— いま書いているのは Bluesky と
 * Misskey なので、X は「過去ログを流し込む」側として扱う。
 *
 * 記事が 1 本 1 ファイルで SNS が日ごとなのは、長さが 2 桁違うため。1 投稿
 * 1 ファイルにすると数千の断片ができて、検索で引いたときに前後が見えない。
 *
 * 原則:
 *   - 決定論的: 同じ入力なら必ず同じ出力。取得日時のような揺れる値を書かない。
 *     **いいね数・リアクション数・リノート数は書かない** —— 過去の投稿でも
 *     増減するので、書くと毎回全ファイルが書き換わって冪等が壊れる。
 *   - 冪等: 内容が変わらなければファイルに触れない (mtime も動かさない)。
 *   - 原文ママ: 本文は加工しない。
 *   - 取りに行く先が落ちていても止まらない: 取れなかったソースは黙って飛ばし、
 *     他のソースは続ける。「取れなかった」と「空だった」を混同しないよう、
 *     失敗したソースのファイルには一切触れない。
 *
 * 使い方:
 *     posts.ts                    # 全部集める
 *     posts.ts --dry-run          # 書かずに結果だけ
 *     posts.ts --since 2026-08-01
 *     posts.ts --quiet            # 1行だけ（定時便用）
 *     posts.ts --source bluesky   # ソースを絞る（blog / bluesky / misskey / x）
 *     posts.ts --site http://127.0.0.1:8123   # 手元の polidog.jp を見る
 *
 * 環境変数 `KYOTEN_X_ARCHIVE` で X のアーカイブの場所を変えられる
 * （既定 `~/Documents/twitter-archive`）。展開済みのディレクトリを指す ——
 * zip のままでは読めない（Node の標準ライブラリに展開する口が無い）。
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  KYOTEN,
  frontmatter,
  hhmm,
  jst,
  n,
  readText,
  safePath,
  splitFrontmatter,
  writeIfChanged,
  ymd,
  type WriteState,
} from "./util.ts";
import { parseArgs, parseSince } from "./cli.ts";

const SITE = "https://polidog.jp";
const BLUESKY_API = "https://public.api.bsky.app/xrpc";
const BLUESKY_ACTOR = "polidog.jp";
const MISSKEY_API = "https://misskey.io/api";
const MISSKEY_USER_ID = "9cw03lelar";
const X_ARCHIVE = process.env.KYOTEN_X_ARCHIVE ??
  join(homedir(), "Documents/twitter-archive");

/**
 * 1 リクエストで取る件数と、遡る上限。上限は暴走よけで、実際は
 * 「もう返ってこない」で止まる。
 */
const PAGE = 100;
const MAX_PAGES = 200;

const TIMEOUT = 30_000;
const UA = "kyoten/posts (+https://github.com/polidog/kyoten)";

const ROOM = join(KYOTEN, "投稿");

// ---------------------------------------------------------------- 取りに行く

/**
 * 取りに行けなかった。呼び出し側はそのソースを丸ごと諦める。
 *
 * 「取れなかった」と「0 件だった」を取り違えると、落ちている日に
 * 空のファイルを書いて過去を消してしまう。例外で区別する。
 */
class Unreachable extends Error {}

/**
 * JSON を取る。落ちていたら Unreachable。
 *
 * 途中まで取れたページを混ぜると欠けたまま完成したように見えるので、
 * ページングの途中で失敗した場合も呼び出し側で丸ごと捨てる。
 */
async function fetchJson(url: string, payload?: unknown): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json", "User-Agent": UA };
  const init: RequestInit = { headers, signal: AbortSignal.timeout(TIMEOUT) };
  if (payload !== undefined) {
    headers["Content-Type"] = "application/json";
    init.method = "POST";
    init.body = JSON.stringify(payload);
  }

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    throw new Unreachable(`${url}: ${(err as Error).message}`);
  }
  if (!response.ok) {
    throw new Unreachable(`${url}: HTTP Error ${response.status}: ${response.statusText}`);
  }

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Unreachable(`${url}: JSON として読めない (${(err as Error).message})`);
  }
}

// ---------------------------------------------------------------- 書き出す

/** 書いた結果を数える。dry-run のときは数えるだけ。 */
class Writer {
  readonly dryRun: boolean;
  readonly stats: Record<WriteState, number> = { new: 0, updated: 0, same: 0 };
  /** 1 件だけ取れなかったもの（ソース丸ごと諦めるのとは別）。 */
  failed = 0;

  constructor(dryRun: boolean) {
    this.dryRun = dryRun;
  }

  write(path: string, body: string): WriteState {
    const state = writeIfChanged(path, body, this.dryRun);
    this.stats[state] += 1;
    return state;
  }

  /** 取りに行くまでもなく前と同じだったもの。 */
  skip(): void {
    this.stats.same += 1;
  }

  get total(): number {
    return this.stats.new + this.stats.updated + this.stats.same;
  }
}

/** 既存ファイルの frontmatter だけ読む。無ければ空。 */
function headFields(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const [fields] = splitFrontmatter(readText(path).slice(0, 2000));
  return fields;
}

// ---------------------------------------------------------------- polidog.jp

interface JsonPost {
  readonly path?: string;
  readonly url?: string;
  readonly title?: string;
  readonly publishedAt?: string;
  readonly updatedAt?: string;
  readonly markdown?: string;
  readonly tags?: readonly { slug?: string }[];
}

/**
 * polidog.jp の記事。索引を 1 本引き、変わったものだけ本文を取りに行く。
 *
 * 索引には本文が入っていないので、1,300 件ぶんを毎回落とさずに済む。
 * 版は記事の `updatedAt`。書き出したファイルの frontmatter に控えてあるので、
 * 突き合わせるのに別の状態ファイルは要らない。
 *
 * 諦めるのは索引が引けなかったときだけ。個々の記事が落ちても他は書く。
 */
async function blog(writer: Writer, site: string, since: string | null): Promise<number> {
  const index = await fetchJson(`${site.replace(/\/+$/, "")}/archives/`);
  const posts = index && typeof index === "object"
    ? (index as { posts?: unknown }).posts
    : undefined;
  if (!Array.isArray(posts)) throw new Unreachable(`${site}: 索引の形が違う`);

  let written = 0;
  for (const raw of posts as JsonPost[]) {
    if (!raw || typeof raw !== "object") continue;
    const published = jst(raw.publishedAt);
    if (!published) continue;
    const date = ymd(published);
    if (since && date < since) continue;

    const path = String(raw.path ?? "");
    const tail = path.replace(/\/+$/, "");
    const slug = safePath(tail.slice(tail.lastIndexOf("/") + 1));
    if (!slug) continue;

    const out = join(ROOM, date.slice(0, 7), `${date.slice(8, 10)}-${slug}.md`);
    const updated = String(raw.updatedAt ?? "");
    if (updated && headFields(out).updated === updated) {
      writer.skip();
      continue;
    }

    // 索引の `url` は本番の絶対 URL。手元の写しを見ているときに使えないので、
    // 取りに行く先は --site と path から組み立てる（url は frontmatter に残す）。
    // 日本語スラッグの記事が 248 本ある。そのまま渡すと ascii に落とせず
    // 落ちるので、セグメントごとにエンコードする。
    const encoded = tail.split("/").map(encodeURIComponent).join("/");
    const url = `${site.replace(/\/+$/, "")}${encoded}/`;
    let detail: JsonPost;
    try {
      const got = await fetchJson(url);
      if (!got || typeof got !== "object" || !("markdown" in got)) {
        throw new Unreachable(`${url}: 記事の形が違う`);
      }
      detail = got as JsonPost;
    } catch (err) {
      // 記事は 1 本ずつ独立しているので、1 本落ちても残りは進める
      // （SNS のページングと違って、欠けても他の記事が壊れない）。
      writer.failed += 1;
      console.error(`  ✗ blog ${path}: ${(err as Error).message}`);
      continue;
    }

    writer.write(out, renderPost(detail, date));
    written += 1;
  }

  return written;
}

function renderPost(post: JsonPost, date: string): string {
  const tags = (post.tags ?? []).map((t) => String(t?.slug ?? "")).filter(Boolean);
  const head = frontmatter({
    room: "投稿",
    source: "polidog.jp",
    date,
    updated: String(post.updatedAt ?? ""),
    url: String(post.url ?? ""),
    title: String(post.title ?? ""),
    tags: tags.join(", "),
  });
  const body = String(post.markdown ?? "").replace(/^\n+|\n+$/g, "");
  return `${head}\n\n# ${post.title ?? ""}\n\n${body}\n`;
}

// ---------------------------------------------------------------- SNS

/** SNS の 1 投稿。ソースが違っても同じ形に均してから束ねる。 */
interface Post {
  readonly dt: Date;
  readonly ident: string;
  readonly text: string;
  readonly note: string;
  /** 本文から辿れない URL（Bluesky はリンクを省略表示するため）。 */
  readonly links: readonly string[];
}

/**
 * `--since` の範囲を通り越したか。通り越したらもう遡らなくていい。
 *
 * 投稿は新しい順に返るので、あるページの最古が since より前まで届いた
 * なら、since 当日ぶんはそのページまでで出揃っている。ここで止めないと
 * 定時便が毎回 3 年ぶんを取りに行くことになる。
 */
function reached(oldest: Date | null, since: string | null): boolean {
  if (since === null || oldest === null) return false;
  return ymd(oldest) < since;
}

/**
 * 本文で省略されている URL を facets と embed から集める。
 *
 * 並びは record に現れた順のまま（決定論のため並べ替えない）。同じ URL が
 * facets と embed の両方に出ることがあるので、最初の 1 回だけ残す。
 */
function blueskyLinks(record: Record<string, unknown>): string[] {
  const links: string[] = [];
  const add = (uri: unknown) => {
    const value = String(uri ?? "");
    if ((value.startsWith("http://") || value.startsWith("https://")) && !links.includes(value)) {
      links.push(value);
    }
  };

  for (const facet of Array.isArray(record.facets) ? record.facets : []) {
    if (!facet || typeof facet !== "object") continue;
    const features = (facet as Record<string, unknown>).features;
    for (const feature of Array.isArray(features) ? features : []) {
      if (feature && typeof feature === "object") add((feature as Record<string, unknown>).uri);
    }
  }

  const embed = record.embed;
  if (embed && typeof embed === "object") {
    const external = (embed as Record<string, unknown>).external;
    if (external && typeof external === "object") {
      add((external as Record<string, unknown>).uri);
    }
  }

  return links;
}

/**
 * Bluesky。認証は要らない（public.api.bsky.app）。
 *
 * リポストは他人の言葉なので落とす（`reason` が付く）。返信は自分の言葉
 * なので拾い、返信だと分かる印だけ付ける。
 *
 * 本文の URL は `github.com/polidog/omar...` のように**省略された表示**が
 * 入っていて、そのままでは辿れない。実際の URL は facets（リッチテキストの
 * 注釈）と embed に別で入っているので、そちらから拾って本文の後ろに添える。
 * 本文自体は原文ママのまま触らない。
 */
async function bluesky(writer: Writer, since: string | null): Promise<number> {
  const posts: Post[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    let url = `${BLUESKY_API}/app.bsky.feed.getAuthorFeed?actor=${BLUESKY_ACTOR}&limit=${PAGE}`;
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;

    const got = await fetchJson(url);
    const feed = got && typeof got === "object" ? (got as { feed?: unknown }).feed : undefined;
    if (!Array.isArray(feed) || !feed.length) break;

    let oldest: Date | null = null;
    for (const raw of feed) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      if (item.reason) continue; // リポスト
      const post = item.post;
      if (!post || typeof post !== "object") continue;
      const record = (post as Record<string, unknown>).record;
      if (!record || typeof record !== "object") continue;
      const rec = record as Record<string, unknown>;
      const text = String(rec.text ?? "").trim();
      if (!text) continue;
      const dt = jst(rec.createdAt as string | undefined);
      if (!dt) continue;
      // at://did:.../app.bsky.feed.post/<rkey> の rkey が投稿の名前。
      const uri = String((post as Record<string, unknown>).uri ?? "");
      posts.push({
        dt,
        ident: uri.slice(uri.lastIndexOf("/") + 1),
        text,
        note: rec.reply ? "返信" : "",
        links: blueskyLinks(rec),
      });
      if (oldest === null || dt < oldest) oldest = dt;
    }

    if (reached(oldest, since)) break;

    cursor = (got as { cursor?: string }).cursor;
    if (!cursor) break;
  }

  return bundle(writer, "bluesky", posts, since);
}

/**
 * Misskey (misskey.io)。こちらも認証なしで公開ノートが取れる。
 *
 * 純粋なリノートは `text` を持たないので自然に落ちる。引用リノートは
 * 自分のコメントがあるので拾う。cw（たたむ見出し）も本人の言葉なので残す。
 */
async function misskey(writer: Writer, since: string | null): Promise<number> {
  const posts: Post[] = [];
  let until: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const payload: Record<string, unknown> = {
      userId: MISSKEY_USER_ID,
      limit: PAGE,
      withReplies: true,
      withRenotes: false,
    };
    if (until) payload.untilId = until;

    const got = await fetchJson(`${MISSKEY_API}/users/notes`, payload);
    if (!Array.isArray(got) || !got.length) break;

    let oldest: Date | null = null;
    for (const raw of got) {
      if (!raw || typeof raw !== "object") continue;
      const note = raw as Record<string, unknown>;
      const text = String(note.text ?? "").trim();
      const cw = String(note.cw ?? "").trim();
      if (!text && !cw) continue;
      const dt = jst(note.createdAt as string | undefined);
      if (!dt) continue;

      const marks: string[] = [];
      if (note.replyId) marks.push("返信");
      if (note.renoteId) marks.push("引用");
      const body = cw ? `${cw}\n\n${text}`.trim() : text;
      posts.push({ dt, ident: String(note.id ?? ""), text: body, note: marks.join(" "), links: [] });
      if (oldest === null || dt < oldest) oldest = dt;
    }

    if (reached(oldest, since)) break;

    until = String((got[got.length - 1] as Record<string, unknown>).id ?? "");
    if (!until) break;
  }

  return bundle(writer, "misskey", posts, since);
}

// ---------------------------------------------------------------- X

/**
 * アーカイブの置き場所。見つからなければ null（＝まだ落としていない）。
 *
 * 展開すると `<どこか>/data/tweets.js` の形になる。どちらを渡されても
 * いいように、`data/` を持つディレクトリと `data/` 自身の両方を見る。
 */
function xRoot(): string | null {
  for (const dir of [join(X_ARCHIVE, "data"), X_ARCHIVE]) {
    try {
      if (statSync(dir).isDirectory() && xParts(dir).length) return dir;
    } catch {
      // 無ければ次を見る
    }
  }
  return null;
}

/**
 * `tweets.js` と、分割されたぶん（`tweets-part1.js` …）。
 *
 * 数が多いアーカイブは part に割れる。番号順に並べる（文字列順だと
 * part10 が part2 より前に来る）。
 */
function xParts(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => /^tweets(-part\d+)?\.js$/.test(name))
    .sort((a, b) => {
      const num = (name: string) => Number(name.match(/part(\d+)/)?.[1] ?? 0);
      return num(a) - num(b) || (a < b ? -1 : a > b ? 1 : 0);
    })
    .map((name) => join(dir, name));
}

/**
 * `tweets.js` は JSON ではなく JS の代入文。
 *
 *     window.YTD.tweets.part0 = [ { "tweet": { … } }, … ]
 *
 * `=` の後ろの `[` から先は素の JSON なので、頭を落とせば読める。
 */
function xRead(path: string): unknown[] {
  const text = readText(path);
  const eq = text.indexOf("=");
  const head = eq < 0 ? -1 : text.indexOf("[", eq);
  if (head < 0) throw new Unreachable(`${path}: tweets.js の形が違う`);
  let got: unknown;
  try {
    got = JSON.parse(text.slice(head));
  } catch (err) {
    throw new Unreachable(`${path}: JSON として読めない (${(err as Error).message})`);
  }
  if (!Array.isArray(got)) throw new Unreachable(`${path}: 配列ではない`);
  return got;
}

interface Tweet {
  readonly id_str?: string;
  readonly created_at?: string;
  readonly full_text?: string;
  readonly in_reply_to_screen_name?: string;
  readonly entities?: { readonly urls?: readonly Record<string, unknown>[] };
}

/**
 * 本文で t.co に短縮されている URL を entities から集める。
 *
 * Bluesky の facets とまったく同じ形の落とし穴 —— 本文に入っているのは
 * `https://t.co/xxxxx` で、そのままでは何のリンクか分からない。実 URL は
 * `entities.urls[].expanded_url` にある。本文は原文ママのまま、後ろに添える。
 *
 * 並びは現れた順（決定論のため並べ替えない）。同じ URL は最初の 1 回だけ。
 */
function xLinks(tweet: Tweet): string[] {
  const links: string[] = [];
  for (const entry of tweet.entities?.urls ?? []) {
    if (!entry || typeof entry !== "object") continue;
    const value = String(entry.expanded_url ?? entry.url ?? "");
    if ((value.startsWith("http://") || value.startsWith("https://")) && !links.includes(value)) {
      links.push(value);
    }
  }
  return links;
}

/**
 * X の `full_text` は `&` `<` `>` が HTML エスケープされている。
 *
 * これは本人が打った文字ではなく運び方の都合なので開く。開かないと
 * Obsidian で読みにくく、全文検索でも `&` を含む語が引けない
 * （MCP の `\uXXXX` を開くのと同じ理由）。`&amp;` は最後 ——
 * 先に開くと `&amp;lt;` が `<` まで戻ってしまう。
 */
function xUnescape(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/**
 * X（旧 Twitter）。取りに行く先は API ではなく手元のアーカイブ。
 *
 * リツイートは他人の言葉なので落とす（Bluesky の `reason` と同じ扱い）。
 * 見分けるのは本文の `RT @name: ` —— アーカイブの `retweeted` は
 * リツイートでも false のまま入っているので当てにならない。しかも RT の
 * 本文はアーカイブの時点で切り詰められているので、拾っても原文にならない。
 *
 * 返信は自分の言葉なので拾う。誰への返信かだけ印に足す —— アーカイブには
 * 相手の投稿が入っていないので、これが唯一の手がかりになる。
 */
function x(writer: Writer, since: string | null): number {
  const dir = xRoot();
  if (dir === null) throw new Unreachable(`${X_ARCHIVE}: アーカイブがありません`);

  const posts: Post[] = [];
  for (const part of xParts(dir)) {
    for (const raw of xRead(part)) {
      if (!raw || typeof raw !== "object") continue;
      const tweet = (raw as { tweet?: unknown }).tweet;
      if (!tweet || typeof tweet !== "object") continue;
      const it = tweet as Tweet;

      const text = xUnescape(String(it.full_text ?? "")).trim();
      if (!text) continue;
      if (/^RT @[A-Za-z0-9_]+: /.test(text)) continue; // リツイート
      const dt = jst(it.created_at);
      if (!dt) continue;

      const to = String(it.in_reply_to_screen_name ?? "");
      posts.push({
        dt,
        ident: String(it.id_str ?? ""),
        text,
        note: to ? `返信 @${to}` : "",
        links: xLinks(it),
      });
    }
  }

  return bundle(writer, "x", posts, since);
}

/**
 * 投稿を日ごとに束ねて書く。
 *
 * その日の投稿を全部持っていない状態で書くと過去を削ってしまうので、
 * ここへ来るのは全ページ取り切ったあとだけ（途中で失敗したら Unreachable が
 * 上がって、この関数には来ない）。
 */
function bundle(writer: Writer, source: string, posts: readonly Post[], since: string | null): number {
  const days = new Map<string, Post[]>();
  for (const post of posts) {
    const date = ymd(post.dt);
    if (since && date < since) continue;
    const list = days.get(date);
    if (list) list.push(post);
    else days.set(date, [post]);
  }

  for (const date of [...days.keys()].sort()) {
    const items = days.get(date)!.sort((a, b) =>
      a.dt.getTime() !== b.dt.getTime()
        ? a.dt.getTime() - b.dt.getTime()
        : a.ident < b.ident ? -1 : a.ident > b.ident ? 1 : 0,
    );
    const out = join(ROOM, date.slice(0, 7), `${source}-${date}.md`);
    writer.write(out, renderDay(source, date, items));
  }

  return days.size;
}

function renderDay(source: string, date: string, items: readonly Post[]): string {
  const head = frontmatter({ room: "投稿", source, date, posts: items.length });
  const body: string[] = [];
  for (const post of items) {
    let label = `${hhmm(post.dt)} ${post.ident}`;
    if (post.note) label += `（${post.note}）`;
    let block = `## ${label}\n\n${post.text}`;
    if (post.links.length) {
      block += "\n\n" + post.links.map((url) => `→ ${url}`).join("\n");
    }
    body.push(block);
  }
  return head + `\n\n# ${date} ${source}\n\n` + body.join("\n\n") + "\n";
}

// ---------------------------------------------------------------- 入口

const SOURCES = ["blog", "bluesky", "misskey", "x"] as const;
type Source = (typeof SOURCES)[number];

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2), ["dry-run", "quiet"], ["since", "source", "site"]);
  const since = parseSince(args.values.since);
  if (since === undefined) return 2;

  // 名指しされたかどうかは下で使う（X をいつ黙って飛ばすかの判断）。
  const named = args.values.source !== undefined;
  const wanted: readonly Source[] = args.values.source
    ? (args.values.source.split(",").filter((s): s is Source =>
        (SOURCES as readonly string[]).includes(s)))
    : SOURCES;
  const site = args.values.site ?? SITE;

  const writer = new Writer(args.flags["dry-run"]);
  const counts = new Map<Source, number>();
  const unreachable: string[] = [];

  for (const name of SOURCES) {
    if (!wanted.includes(name)) continue;
    // X のアーカイブをまだ落としていないのは「とどかなかった」ではなく
    // 「まだ無い」。毎晩の便に嘘の失敗を出させないよう黙って飛ばす
    // （--source x と名指しされたときだけ、無いことをちゃんと言う）。
    if (name === "x" && !named && xRoot() === null) continue;

    const before = { ...writer.stats };
    try {
      const got = name === "blog"
        ? await blog(writer, site, since)
        : name === "bluesky"
          ? await bluesky(writer, since)
          : name === "misskey"
            ? await misskey(writer, since)
            : x(writer, since);
      counts.set(name, got);
    } catch (err) {
      // 取りに行けなかったソースは無かったことにする。この回に
      // 書いたぶんは残るが、書いていない日を空にはしない。
      Object.assign(writer.stats, before);
      unreachable.push(name);
      console.error(`  ✗ ${name}: ${(err as Error).message}`);
    }
  }

  const stats = writer.stats;
  if (args.flags.quiet) {
    const got = [...counts.entries()].map(([k, v]) => `${k} ${v}`).join(" ");
    let line = `posts: ${writer.total}ファイル (new ${stats.new} ` +
      `/ upd ${stats.updated} / same ${stats.same}) ${got}`;
    if (writer.failed) line += ` ／ とれず ${writer.failed}`;
    if (unreachable.length) line += ` ／ とどかず ${unreachable.join(",")}`;
    console.log(line);
  } else {
    if (args.flags["dry-run"]) console.log("（書かずに確認）");
    console.log(`  投稿   : ${n(writer.total)} ファイル`);
    console.log(`    あたらしい : ${n(stats.new)}`);
    console.log(`    かきかえ   : ${n(stats.updated)}`);
    console.log(`    かわらず   : ${n(stats.same)}`);
    for (const name of SOURCES) {
      if (counts.has(name)) {
        const unit = name === "blog" ? "記事" : "日ぶん";
        console.log(`    ${name.padEnd(9)}: ${n(counts.get(name)!)} ${unit}`);
      }
    }
    if (writer.failed) console.log(`    とれず     : ${n(writer.failed)} 件（次の便で取り直す）`);
    for (const name of unreachable) {
      console.log(`    ${name.padEnd(9)}: とどかず（次の便で取り直す）`);
    }
    console.log(`  ばしょ : ${ROOM}`);
  }

  return unreachable.length || writer.failed ? 1 : 0;
}

process.exit(await main());
