#!/usr/bin/env node
/**
 * reading — polidog が読んだものの記録
 *
 * `おすすめ/` の根拠になる部屋。アイボが何を勧めるかは、ここが決める。
 *
 * ## 1階なのに外を見る（`株/` と同じ立ち位置）
 *
 * 素材が jsonl でも git でもなく **手元の Chrome の履歴**と、拠点に
 * 既にある `投稿/` なので、2階（畳む側）より先にいればいい。ただし
 * `投稿/` を読むので `posts.ts` の**あと**に走らせる。
 *
 * ## 何を入れるか —— allowlist で絞る（拠点から起こす）
 *
 * 履歴をそのまま入れると、読んだものはほとんど入らない。実測（2026-09-05）:
 * 2つのプロファイルで 29,645 訪問・ホスト 883 種のうち、上位は仕事の開発
 * 環境 3,965・localhost 3,490・Google 検索 4,213・会社のポータル 800・
 * 漫画 459・不動産 290・証券口座 130。**読み物は数%しかない。**
 *
 * だから拾う側を並べる（denylist にしない）。仕事のドメインは増え続ける
 * ので、除外を数え上げる形だと必ず漏れる。漏れたものは `日記/` と
 * `おすすめ/` の素材として LLM に渡ってしまう。
 *
 * allowlist は**手で書かない**（原則4）。`投稿/` に出てくる外部リンクの
 * ホスト —— polidog が過去に自分でシェアした先 —— がそのまま台帳になる。
 * 20年ぶんで 554 種あり、投稿が増えれば allowlist も伸びる。
 * それに `KNOWN`（読み物と分かっているサイト）を足し、`NEVER`（読み物
 * ではないカテゴリ）を引く。`NEVER` は増え続けない固定のリストで、
 * denylist の保守とは性質が違う。
 *
 * ## 履歴は 90 日で消える
 *
 * 実測: Chrome は古い訪問を落とすので、Default に残っていたのは
 * 2026-06-07 から。会話ログを `cleanupPeriodDays` で守ったのと同じ構図で、
 * ここに写しておかないと過去は取り返せない。
 *
 * そのぶん**「その日の履歴が 0 件」は「その日は読まなかった」ではない**
 * （落とし穴14 と同じ形）。0 件の日はファイルに触らない —— 空を書くと、
 * 消えた過去を「読まなかった日」として上書きしてしまう。
 *
 * 使い方:
 *     reading.ts                  # 書けるところまで
 *     reading.ts --dry-run        # 書かずに、どのホストが何件入るか見る
 *     reading.ts --source chrome  # ソースを絞る（chrome / posts）
 *     reading.ts --since 2026-08-01
 *     reading.ts --hosts          # allowlist を出すだけ（拠点に書かない）
 *     reading.ts --quiet          # 1行だけ（定時便用）
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { parseArgs, parseSince } from "./cli.ts";
import { chromeRoot, fleetNote, markCollected, readSozai, writeSozai } from "./machine.ts";
import {
  KYOTEN,
  frontmatter,
  n,
  readText,
  splitFrontmatter,
  take,
  writeIfChanged,
  type WriteState,
} from "./util.ts";

const ROOM = join(KYOTEN, "読んだ");
const POSTS = join(KYOTEN, "投稿");

/** Chrome のプロファイル。両方見る（Default は 90 日ぶん、Profile 1 は新しい）。 */
const CHROME_ROOT = chromeRoot();

/**
 * Chrome の `visit_time` は 1601-01-01 からのマイクロ秒で 1.3e16 になる。
 * JS の安全な整数（9.0e15）を超えるので `node:sqlite` が
 * `Value is too large to be represented as a JavaScript number` で投げる。
 * SQLite 側でミリ秒に落としてから受け取る。
 */
const CHROME_EPOCH_MS = 11_644_473_600_000;

/** 読み物と分かっているサイト。投稿に出てこなくても拾う。 */
const KNOWN: readonly string[] = [
  // fetch.py が回っているのと同じ顔ぶれ
  "news.ycombinator.com", "lobste.rs", "dev.to", "b.hatena.ne.jp",
  "zenn.dev", "qiita.com", "arxiv.org", "techfeed.io",
  "www3.nhk.or.jp", "news.yahoo.co.jp",
  // 技術メディア・ドキュメント
  "publickey1.jp", "gihyo.jp", "atmarkit.itmedia.co.jp", "itmedia.co.jp",
  "infoq.com", "techcrunch.com", "theverge.com", "arstechnica.com",
  "wired.jp", "gigazine.net", "developer.mozilla.org", "web.dev",
  "github.blog", "blog.cloudflare.com", "stackoverflow.com",
  "speakerdeck.com", "docswell.com", "slideshare.net",
  "note.com", "medium.com", "zenn.dev", "scrapbox.io",
  // 経済（`株/` と `見立て/` があるので）
  "nikkei.com", "bloomberg.co.jp", "reuters.com", "toyokeizai.net",
  "diamond.jp", "moneyworld.jp",
];

/**
 * 読み物ではないカテゴリ。allowlist に入っていても引く。
 *
 * ここが増え続けないのが denylist との違い —— 「会社の新しい環境」は
 * 足さなくていい（allowlist に無いので最初から入らない）。足すのは
 * 「polidog が投稿でシェアしたが、読み物ではない先」だけ。
 */
const NEVER: readonly string[] = [
  // 自分のサイトと、その裏側
  "polidog.jp", "relayer.polidog.jp", "kani.show",
  // リポジトリを見て回るのは読み物ではなく作業。`作業/` が既にコミットを
  // 持っている。実測（2026-09-04）: 761 件のほとんどが仕事の private
  // リポジトリで、PR 題・issue 題・ファイルパスがそのまま入った。
  // 技術記事のほうは `github.blog` として KNOWN に入れてある。
  "github.com", "gist.github.com",
  // SNS 本体（個々の投稿ではなくタイムライン）
  "x.com", "twitter.com", "bsky.app", "misskey.io", "facebook.com",
  "instagram.com", "discord.com", "threads.net", "reddit.com",
  // 短縮 URL（展開先が履歴にも残るので、そちらを拾う）
  "t.co", "bit.ly", "git.io", "buff.ly", "ow.ly", "amzn.to", "goo.gl",
  // 検索
  "google.com", "google.co.jp", "bing.com", "duckduckgo.com",
  "search.yahoo.co.jp", "search.brave.com",
  // 道具の画面（読み物ではなく作業）
  "accounts.google.com", "mail.google.com", "calendar.google.com",
  "docs.google.com", "drive.google.com", "meet.google.com",
  "notion.so", "app.notion.com", "slack.com", "app.slack.com",
  "dash.cloudflare.com", "vercel.com", "dashboard.heroku.com",
  "claude.ai", "chatgpt.com", "gemini.google.com",
  "console.aws.amazon.com", "console.cloud.google.com",
  // 買い物・暮らし
  "amazon.co.jp", "amazon.com", "rakuten.co.jp", "mercari.com",
  "uniqlo.com", "soundhouse.co.jp", "pizza-la.co.jp", "printgraph.jp",
  "tabelog.com", "r.tabelog.com", "homes.co.jp", "suumo.jp",
  // 動画・漫画
  "youtube.com", "youtu.be", "nicovideo.jp", "netflix.com",
  "mechacomic.jp", "cmoa.jp", "shueisha.online",
  // 画像・CDN（本文が無い）
  "pbs.twimg.com", "img.esa.io", "i.imgur.com", "imgur.com",
];

/** 仕事の場所。サフィックスで丸ごと落とす。 */
const NEVER_SUFFIX: readonly string[] = [
  ".ptyhard.co.jp", "ptyhard.co.jp",
  ".partyhard-inc.workers.dev", "partyhard-inc.workers.dev",
  ".30min.page", "30min.page",
  ".rakuten-sec.co.jp", "rakuten-sec.co.jp",
  ".herokuapp.com",
  ".local", ".test", ".internal",
];

/** トラッキングのためだけに付く問い合わせ。落としても行き先は変わらない。 */
const TRACKING =
  /^(utm_|fbclid$|gclid$|mc_|ref$|ref_src$|ref_url$|share$|spm$|s$|si$|cmpid$|from$|slide$)/i;

// ---------------------------------------------------------------- ホスト

function hostOf(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.host.toLowerCase().replace(/^www\./, "");
  // 投稿にはコード片も入っている（`http://{$_server...`）。`new URL()` は
  // その手のものも通すので、ホストとして成り立つ形だけ拾う。
  if (!/^[a-z0-9.-]+(:\d+)?$/.test(host) || !host.includes(".")) return null;
  return host;
}

/** ローカルのものは読み物ではない（開発中の画面）。 */
function isLocal(host: string): boolean {
  const name = host.split(":")[0];
  return name === "localhost" || name === "0.0.0.0" ||
    /^\d+\.\d+\.\d+\.\d+$/.test(name) || name.endsWith(".local");
}

function isNever(host: string): boolean {
  if (isLocal(host)) return true;
  // 認証・ログインの画面は、どのサイトのものでも読み物ではない
  if (/^(auth|login|signin|accounts|account|id|sso)\./.test(host)) return true;
  // NEVER はサブドメインごと落とす（`item.rakuten.co.jp` は `rakuten.co.jp` で）
  if (NEVER.some((e) => host === e || host.endsWith(`.${e}`))) return true;
  return NEVER_SUFFIX.some((e) => host === e || host.endsWith(e));
}

/**
 * 行き先を1つに揃える。同じ記事を2回開いても1行になるように。
 * 問い合わせはトラッキングだけ落とす（`?p=123` のように中身を指すものは残す）。
 */
function normalize(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING.test(key)) url.searchParams.delete(key);
  }
  // トップページは「読んだ記事」ではない
  if (url.pathname === "/" && !url.search) return null;
  return url.toString();
}

// ---------------------------------------------------------------- allowlist

/** `投稿/` の中を全部読んで、外部リンクのホストを集める。 */
function hostsFromPosts(): Set<string> {
  const found = new Set<string>();
  for (const path of walk(POSTS, ".md")) {
    for (const m of readText(path).matchAll(/https?:\/\/[^\s<>()\[\]"'）」、。]+/g)) {
      const host = hostOf(m[0]);
      if (host && !isNever(host)) found.add(host);
    }
  }
  return found;
}

function allowlist(): Set<string> {
  const list = hostsFromPosts();
  for (const host of KNOWN) if (!isNever(host)) list.add(host);
  return list;
}

/** allowlist に入っているか。サブドメインは親が入っていれば通す。 */
function allowed(host: string, list: ReadonlySet<string>): boolean {
  if (isNever(host)) return false;
  if (list.has(host)) return true;
  // `blog.example.com` は `example.com` が台帳にあれば通す
  const parts = host.split(".");
  for (let i = 1; i < parts.length - 1; i += 1) {
    if (list.has(parts.slice(i).join("."))) return true;
  }
  return false;
}

// ---------------------------------------------------------------- 読む

interface Link {
  readonly url: string;
  readonly host: string;
  readonly title: string;
  readonly via?: string;
}

function walk(root: string, suffix: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root, { recursive: true, encoding: "utf8" }) as string[];
  } catch {
    return [];
  }
  return entries.filter((r) => r.endsWith(suffix)).map((r) => join(root, r)).sort();
}

/** Chrome のプロファイルを新しい順に。無ければ空。 */
function profiles(): string[] {
  let names: string[];
  try {
    names = readdirSync(CHROME_ROOT);
  } catch {
    return [];
  }
  return names
    .filter((name) => name === "Default" || /^Profile \d+$/.test(name))
    .map((name) => join(CHROME_ROOT, name, "History"))
    .filter((path) => existsSync(path))
    .sort();
}

interface Visit {
  readonly url: string;
  readonly title: string;
  readonly ms: number;
}

/**
 * 履歴を読む。Chrome が起きているとロックされているので、SQLite を読む
 * 側の作法どおり一時ディレクトリへ写してから開き、読み終えたら消す。
 */
function visits(path: string): Visit[] {
  const work = mkdtempSync(join(tmpdir(), "kyoten-history-"));
  try {
    const copy = join(work, "History");
    copyFileSync(path, copy);
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      // transition の下位 8bit が 3/4 のものは iframe（本人が開いた
      // ページではない）。落とし穴7 と同じで、来ているものと名前が違う。
      return db.prepare(`
        SELECT u.url AS url, u.title AS title,
               v.visit_time/1000 - ${CHROME_EPOCH_MS} AS ms
          FROM visits v JOIN urls u ON u.id = v.url
         WHERE (v.transition & 255) NOT IN (3, 4)
           AND u.title IS NOT NULL AND u.title <> ''
         ORDER BY v.visit_time
      `).all() as unknown as Visit[];
    } finally {
      db.close();
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** JST の日付。履歴の時刻は UTC のミリ秒で来る。 */
function dayOf(ms: number): string {
  return new Date(Number(ms) + 9 * 3_600_000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- 畳む

function chromeDays(list: ReadonlySet<string>, since: string | null): Map<string, Link[]> {
  const days = new Map<string, Map<string, Link>>();
  for (const path of profiles()) {
    for (const visit of visits(path)) {
      const date = dayOf(visit.ms);
      if (since && date < since) continue;
      const url = normalize(visit.url);
      if (!url) continue;
      const host = hostOf(url);
      if (!host || !allowed(host, list)) continue;
      let day = days.get(date);
      if (!day) days.set(date, (day = new Map()));
      // 同じ日に同じページを何度開いても1行にする。畳む鍵は URL では
      // なく **ホストと題** —— 検索欄に打った1文字ずつが `?draft=p`
      // `?draft=po` … と別の URL で残るし、`/` と `/index.html` も別に
      // 数えられる（実測: それだけで1日 20 行のうち 16 行が同じページ）。
      // 残すのはいちばん短い URL（余計な問い合わせが付いていないもの）。
      const title = take(visit.title.trim(), 200);
      const key = title ? `${host}\t${title}` : url;
      const seen = day.get(key);
      if (!seen || url.length < seen.url.length) day.set(key, { url, host, title });
    }
  }
  const out = new Map<string, Link[]>();
  for (const [date, day] of days) {
    out.set(date, [...day.values()].sort((a, b) =>
      a.host.localeCompare(b.host) || a.url.localeCompare(b.url)));
  }
  return out;
}

/** `投稿/` から、その日にシェアした外部リンクを拾う。 */
function postDays(list: ReadonlySet<string>, since: string | null): Map<string, Link[]> {
  const days = new Map<string, Map<string, Link>>();
  for (const path of walk(POSTS, ".md")) {
    const text = readText(path);
    const [head] = splitFrontmatter(text.slice(0, 2000));
    const date = head.date?.slice(0, 10) ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (since && date < since) continue;
    const via = head.source ?? "";
    for (const m of text.matchAll(/https?:\/\/[^\s<>()\[\]"'）」、。]+/g)) {
      const url = normalize(m[0].replace(/[.,、。）」]+$/, ""));
      if (!url) continue;
      const host = hostOf(url);
      if (!host || !allowed(host, list)) continue;
      let day = days.get(date);
      if (!day) days.set(date, (day = new Map()));
      if (!day.has(url)) day.set(url, { url, host, title: "", via });
    }
  }
  const out = new Map<string, Link[]>();
  for (const [date, day] of days) {
    out.set(date, [...day.values()].sort((a, b) =>
      a.host.localeCompare(b.host) || a.url.localeCompare(b.url)));
  }
  return out;
}

// ---------------------------------------------------------------- 素材

/**
 * Chrome の履歴は**その機械のもの**なので、素材に落としてから畳む。
 * `Link` はそのまま JSON になる（Date を持たない）ので、変換は要らない。
 *
 * `投稿/` から起こすほう（`postDays`）は拠点しか見ないので素材を通さない。
 * どの機械で走らせても同じものが出る。
 */
function collect(list: ReadonlySet<string>, since: string | null, dryRun: boolean): number {
  const days = chromeDays(list, since);
  let wrote = 0;
  for (const [date, links] of [...days].sort()) {
    // 0 件の日は書かない。履歴は 90 日で消えるので、「読まなかった日」と
    // 「もう残っていない日」の区別がつかない（落とし穴14）。
    if (!links.length) continue;
    writeSozai("読んだ", date, links, dryRun);
    wrote += 1;
  }
  markCollected(dryRun);
  return wrote;
}

/**
 * 全機械ぶんの Chrome の素材を1日1枚に畳む。
 *
 * 畳む鍵は `chromeDays()` と同じ **ホストと題**（無ければ URL）。同じ
 * ページを2台で開いていたら1行にする。残すのはいちばん短い URL。
 */
function foldChrome(since: string | null): Map<string, Link[]> {
  const out = new Map<string, Link[]>();
  for (const [date, links] of readSozai<Link>("読んだ")) {
    if (since && date < since) continue;
    const day = new Map<string, Link>();
    for (const link of links) {
      if (!link?.url || !link.host) continue;
      const key = link.title ? `${link.host}\t${link.title}` : link.url;
      const seen = day.get(key);
      if (!seen || link.url.length < seen.url.length) day.set(key, link);
    }
    out.set(date, [...day.values()].sort((a, b) =>
      a.host.localeCompare(b.host) || a.url.localeCompare(b.url)));
  }
  return out;
}

// ---------------------------------------------------------------- 書く

/** Markdown のリンクに入れて壊れない形にする（タイトルに `]` がありうる）。 */
function label(text: string): string {
  return text.replace(/[\[\]]/g, "").replace(/\s+/g, " ").trim();
}

function render(source: string, date: string, links: readonly Link[]): string {
  const head = frontmatter({ room: "読んだ", source, date, links: links.length });
  const title = source === "chrome" ? "開いたページ" : "シェアしたリンク";
  const lines = [head, "", `# ${date} に${title}`, ""];
  let host = "";
  for (const link of links) {
    if (link.host !== host) {
      host = link.host;
      lines.push("", `## ${host}`, "");
    }
    lines.push(link.title
      ? `- [${label(link.title)}](${link.url})`
      : `- <${link.url}>`);
  }
  return `${lines.join("\n").trim()}\n`;
}

class Writer {
  readonly dryRun: boolean;
  readonly stats: Record<WriteState, number> = { new: 0, updated: 0, same: 0 };

  constructor(dryRun: boolean) {
    this.dryRun = dryRun;
  }

  write(path: string, body: string): void {
    this.stats[writeIfChanged(path, body, this.dryRun)] += 1;
  }

  get total(): number {
    return this.stats.new + this.stats.updated + this.stats.same;
  }
}

function save(writer: Writer, source: string, days: ReadonlyMap<string, Link[]>): number {
  let count = 0;
  for (const [date, links] of [...days].sort()) {
    // 0 件の日は書かない。履歴は 90 日で消えるので、「読まなかった日」と
    // 「もう残っていない日」の区別がつかない（落とし穴14）。
    if (!links.length) continue;
    const dir = join(ROOM, date.slice(0, 7));
    if (!writer.dryRun) mkdirSync(dir, { recursive: true });
    writer.write(join(dir, `${source}-${date}.md`), render(source, date, links));
    count += links.length;
  }
  return count;
}

// ---------------------------------------------------------------- 入口

const SOURCES = ["chrome", "posts"] as const;
type Source = (typeof SOURCES)[number];

function main(): number {
  const args = parseArgs(
    process.argv.slice(2),
    ["dry-run", "quiet", "hosts", "collect-only", "fold-only"],
    ["since", "source", "show"],
  );
  const since = parseSince(args.values.since);
  if (since === undefined) return 2;

  const wanted: readonly Source[] = args.values.source
    ? args.values.source.split(",").filter((s): s is Source =>
      (SOURCES as readonly string[]).includes(s))
    : SOURCES;

  const list = allowlist();

  if (args.flags.hosts) {
    for (const host of [...list].sort()) console.log(host);
    console.error(`allowlist ${list.size} 種（投稿から起こしたもの＋既知）`);
    return 0;
  }

  // 1日ぶんを拠点に書かずに見る（何が入るのかを目で確かめるため）
  const show = args.values.show;
  if (show !== undefined) {
    for (const source of wanted) {
      const days = source === "chrome" ? chromeDays(list, show) : postDays(list, show);
      const links = days.get(show);
      if (links?.length) console.log(render(source, show, links));
    }
    return 0;
  }

  // 手元の Chrome から素材へ。畳むのは下（拠点しか見ない）。
  if (!args.flags["fold-only"] && wanted.includes("chrome")) {
    let gathered = 0;
    try {
      gathered = collect(list, since, args.flags["dry-run"]);
    } catch (err) {
      // 取りに行けなかったソースは無かったことにする（落とし穴14）
      console.error(`  ✗ chrome: ${(err as Error).message}`);
    }
    if (args.flags["collect-only"]) {
      if (args.flags.quiet) console.log(`reading: 集めた ${n(gathered)}日ぶん（畳まない）`);
      else {
        if (args.flags["dry-run"]) console.log("（書かずに確認）");
        console.log(`  素材（読んだ）: ${n(gathered)} 日ぶん`);
      }
      return 0;
    }
  }

  const writer = new Writer(args.flags["dry-run"]);
  const counts = new Map<Source, number>();
  const perHost = new Map<string, number>();
  let unreachable = false;

  for (const source of SOURCES) {
    if (!wanted.includes(source)) continue;
    try {
      const days = source === "chrome"
        ? foldChrome(since)
        : postDays(list, since);
      counts.set(source, save(writer, source, days));
      for (const links of days.values()) {
        for (const link of links) perHost.set(link.host, (perHost.get(link.host) ?? 0) + 1);
      }
    } catch (err) {
      // 取りに行けなかったソースは無かったことにする（落とし穴14）
      unreachable = true;
      console.error(`  ✗ ${source}: ${(err as Error).message}`);
    }
  }

  const stats = writer.stats;
  if (args.flags.quiet) {
    const got = [...counts.entries()].map(([k, v]) => `${k} ${v}`).join(" ");
    console.log(
      `reading: ${writer.total}ファイル (new ${stats.new} / upd ${stats.updated} ` +
      `/ same ${stats.same}) ${got} ／ allowlist ${list.size} ${fleetNote()}`,
    );
  } else {
    if (args.flags["dry-run"]) console.log("（書かずに確認）");
    console.log(`  読んだ : ${n(writer.total)} ファイル`);
    console.log(`    あたらしい : ${n(stats.new)}`);
    console.log(`    かきかえ   : ${n(stats.updated)}`);
    console.log(`    かわらず   : ${n(stats.same)}`);
    for (const [source, links] of counts) {
      console.log(`    ${source.padEnd(7)}: ${n(links)} リンク`);
    }
    console.log(`  台帳   : ${n(list.size)} ホスト（投稿から起こした）`);
    if (args.flags["dry-run"] && perHost.size) {
      console.log("  入るもの（上位20）:");
      for (const [host, c] of [...perHost].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
        console.log(`    ${String(c).padStart(5)}  ${host}`);
      }
    }
    console.log(`  ばしょ : ${ROOM}`);
  }

  return unreachable ? 1 : 0;
}

// import しただけで走らせない（落とし穴21）。`おすすめ/` 側が allowlist を
// 借りるので、守らないと import した瞬間に 600 日ぶんを書きにいく。
if (import.meta.main) process.exit(main());
