#!/usr/bin/env node
/**
 * otsuge — おつげ（週ごとの観測）
 *
 * うらないババが週に1度、拠点を読んで告げる。数の羅列はステータスと年表に
 * あるので、こちらは**その週に何が起きて、先週と何が違ったか**を書く。
 *
 * 出力は `otsuge/<ISO年>-W<週>.md`（月曜はじまりの ISO 週）。
 *
 * ふくろ・ステータスと同じく**拠点の中しか見ない**。走らせる順番は
 * … → teato → fukuro → status → otsuge。
 *
 * ## その週の目でだけ書く
 *
 * 「45日止まっている」のような話は、**その週の終わりの時点**で数える。
 * 今日から数えると、過去のおつげが毎晩書き換わって、読み返したときに
 * 「あのとき何と言われたか」が残らない。未来を知らないおつげは二度と
 * 変わらないので、冪等が完全に保たれる。
 *
 * 掟:
 *   - 決定論的: 走らせた日で結果が変わらない。
 *   - 冪等: 内容が変わらなければファイルに触れない。
 *   - 手で書かせない: 素材が増えれば勝手に増える。
 *
 * 使い方:
 *     otsuge.ts                   # 全部
 *     otsuge.ts --dry-run
 *     otsuge.ts --quiet
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  KYOTEN,
  frontmatter,
  n,
  readText,
  splitFrontmatter,
  writeIfChanged,
  type WriteState,
} from "./dougu.ts";
import { listFiles, parseArgs } from "./cli.ts";

const ROOM = join(KYOTEN, "otsuge");

/** ひさしぶりと見なす空き。1か月ぶりに戻ってきたら言う価値がある。 */
const BACK_AFTER = 30;

/**
 * 止まっていると見なす日数と、それを言うに値する重み。数コミットで
 * 終わった実験まで並べると「止まっているもの」が数十行になる。
 */
const STALE_AFTER = 60;
const STALE_MIN_COMMITS = 10;
const STALE_SHOWN = 8;

const RE_COMMIT = /^- `([0-9a-f]{4,})` /;
const RE_FILE = /^- `([^`]+)`/;
const RE_HEAD2 = /^## ([^\n]+)$/;
const RE_HEAD3 = /^### ([^\n]+)$/;

const EXT_IGNORE = new Set([
  "png", "jpg", "jpeg", "gif", "svg", "ico", "webp", "avif", "pdf",
  "lock", "sum", "map", "min", "snap", "log", "txt", "csv",
]);
const ALIAS: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  go: "golang", py: "python", rb: "ruby", rs: "rust",
  md: "markdown", sh: "shell", bash: "shell", yml: "yaml",
  scss: "css", sass: "css",
};

const MS_PER_DAY = 86_400_000;

function bump(counter: Map<string, number>, key: string, by = 1): void {
  counter.set(key, (counter.get(key) ?? 0) + by);
}

function merge(into: Map<string, number>, from: Map<string, number>): void {
  for (const [k, v] of from) bump(into, k, v);
}

function mostCommon(counter: Map<string, number>, limit: number): [string, number][] {
  return [...counter.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

class Day {
  commits = 0;
  readonly projects = new Map<string, number>();
  readonly exts = new Map<string, number>();
  troubles = 0;
  readonly troubleTools = new Map<string, number>();
  articles = 0;
  posts = 0;
  utterances = 0;
  sessions = 0;
  readonly titles: string[] = [];
}

function extName(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const ext = (base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : base).toLowerCase();
  if (!ext || ext.length > 12 || EXT_IGNORE.has(ext) || !/^[0-9a-z]+$/i.test(ext)) return "";
  return ALIAS[ext] ?? ext;
}

function dayOf(days: Map<string, Day>, key: string): Day {
  let d = days.get(key);
  if (!d) {
    d = new Day();
    days.set(key, d);
  }
  return d;
}

/** 拠点の各部屋を日付ごとに集める。 */
function scan(days: Map<string, Day>): void {
  const teato = join(KYOTEN, "teato");
  if (existsSync(teato)) {
    for (const path of listFiles(teato, ".md")) {
      const [fields, body] = splitFrontmatter(readText(path));
      const dateKey = fields.date ?? "";
      if (!dateKey) continue;
      const day = dayOf(days, dateKey);
      let project = "";
      let section = "";

      for (const line of body.split("\n")) {
        const gotHead2 = RE_HEAD2.exec(line);
        if (gotHead2) {
          project = gotHead2[1].trim();
          section = "";
          continue;
        }
        const gotHead3 = RE_HEAD3.exec(line);
        if (gotHead3) {
          section = gotHead3[1].trim();
          continue;
        }

        if (section === "つくった" && RE_COMMIT.test(line)) {
          day.commits += 1;
          if (project) bump(day.projects, project);
        } else if (section === "さわった") {
          const got = RE_FILE.exec(line);
          if (got) {
            const name = extName(got[1]);
            if (name) bump(day.exts, name);
          }
        } else if (section === "つまずいた" && line.startsWith("- ")) {
          day.troubles += 1;
          // "- 12:34:56 Bash `…`" の道具の名前だけ数える。
          const parts = line.split(/\s+/);
          if (parts.length >= 3) bump(day.troubleTools, parts[2]);
        }
      }
    }
  }

  const soto = join(KYOTEN, "soto");
  if (existsSync(soto)) {
    for (const path of listFiles(soto, ".md")) {
      const [fields] = splitFrontmatter(readText(path).slice(0, 3000));
      const dateKey = fields.date ?? "";
      if (!dateKey) continue;
      const day = dayOf(days, dateKey);
      if (fields.source === "polidog.jp") {
        day.articles += 1;
        if (fields.title) day.titles.push(fields.title);
      } else {
        day.posts += 1;
      }
    }
  }

  const kotonoha = join(KYOTEN, "kotonoha");
  if (existsSync(kotonoha)) {
    for (const path of listFiles(kotonoha, ".md")) {
      const [fields] = splitFrontmatter(readText(path).slice(0, 2000));
      const dateKey = fields.date ?? "";
      if (!dateKey) continue;
      const got = Number.parseInt(fields.utterances ?? "0", 10);
      if (!Number.isNaN(got)) dayOf(days, dateKey).utterances += got;
    }
  }

  const bouken = join(KYOTEN, "bouken");
  if (existsSync(bouken)) {
    for (const path of listFiles(bouken, ".md")) {
      const [fields] = splitFrontmatter(readText(path).slice(0, 2000));
      const dateKey = (fields.started ?? "").slice(0, 10);
      if (dateKey) dayOf(days, dateKey).sessions += 1;
    }
  }
}

// ---------------------------------------------------------------- 週に畳む

function toUtc(date: string): number {
  return Date.parse(date + "T00:00:00Z");
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function monday(date: string): string {
  const ms = toUtc(date);
  const day = new Date(ms).getUTCDay() || 7; // 月曜=1, 日曜=7
  return fromUtc(ms - (day - 1) * MS_PER_DAY);
}

/** Python の `date.isocalendar()` と同じ ISO 週。 */
function weekKey(date: string): string {
  const t = new Date(toUtc(date));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day); // その週の木曜へ
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / MS_PER_DAY + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

class Week {
  readonly key: string;
  readonly start: string;
  readonly end: string;
  commits = 0;
  readonly projects = new Map<string, number>();
  readonly exts = new Map<string, number>();
  troubles = 0;
  readonly troubleTools = new Map<string, number>();
  articles = 0;
  posts = 0;
  utterances = 0;
  sessions = 0;
  readonly titles: string[] = [];
  daysWorked = 0;

  constructor(key: string, start: string) {
    this.key = key;
    this.start = start;
    this.end = fromUtc(toUtc(start) + 6 * MS_PER_DAY);
  }

  add(day: Day): void {
    this.commits += day.commits;
    merge(this.projects, day.projects);
    merge(this.exts, day.exts);
    this.troubles += day.troubles;
    merge(this.troubleTools, day.troubleTools);
    this.articles += day.articles;
    this.posts += day.posts;
    this.utterances += day.utterances;
    this.sessions += day.sessions;
    this.titles.push(...day.titles);
    if (day.commits) this.daysWorked += 1;
  }

  empty(): boolean {
    return !(this.commits || this.articles || this.posts || this.utterances || this.sessions);
  }
}

function fold(days: Map<string, Day>): Week[] {
  const weeks = new Map<string, Week>();
  for (const [key, day] of days) {
    if (Number.isNaN(toUtc(key))) continue;
    const wk = weekKey(key);
    let week = weeks.get(wk);
    if (!week) {
      week = new Week(wk, monday(key));
      weeks.set(wk, week);
    }
    week.add(day);
  }
  return [...weeks.keys()].sort().map((k) => weeks.get(k)!).filter((w) => !w.empty());
}

// ---------------------------------------------------------------- 告げる

function diff(now: number, before: number | null): string {
  if (before === null) return "";
  const delta = now - before;
  if (delta === 0) return `（先週 ${n(before)} / 同じ）`;
  return `（先週 ${n(before)} / ${delta > 0 ? "+" : ""}${n(delta)}）`;
}

/**
 * 1週ぶんのおつげ。
 *
 * `seen` はその週に入る**前**までの、プロジェクトごとの最後の日。
 * `totals` は同じくコミットの累計。どちらも未来を含まない。
 */
function render(
  week: Week,
  before: Week | null,
  seen: ReadonlyMap<string, string>,
  totals: ReadonlyMap<string, number>,
): string {
  const head = frontmatter({
    room: "otsuge",
    week: week.key,
    from: week.start,
    to: week.end,
    commits: week.commits,
  });

  const body: string[] = [`# ${week.key} のおつげ`, `${week.start} 〜 ${week.end}`];

  const lines: string[] = [];
  if (week.commits) {
    lines.push(`- コミット ${n(week.commits)}${diff(week.commits, before?.commits ?? null)}` +
      `　手を動かした日 ${week.daysWorked}`);
  }
  if (week.articles) {
    lines.push(`- 記事 ${n(week.articles)}${diff(week.articles, before?.articles ?? null)}`);
  }
  if (week.posts) {
    lines.push(`- SNS ${n(week.posts)} 日ぶん${diff(week.posts, before?.posts ?? null)}`);
  }
  if (week.sessions) {
    lines.push(`- 会話 ${n(week.sessions)}${diff(week.sessions, before?.sessions ?? null)}` +
      (week.utterances ? `　発言 ${n(week.utterances)}` : ""));
  }
  if (lines.length) body.push("## 今週\n\n" + lines.join("\n"));

  if (week.projects.size) {
    const rows: string[] = [];
    for (const [name, count] of mostCommon(week.projects, 8)) {
      let mark = "";
      const last = seen.get(name);
      if (last === undefined) {
        mark = "（はじめて）";
      } else {
        const gap = Math.round((toUtc(week.start) - toUtc(last)) / MS_PER_DAY);
        if (gap >= BACK_AFTER) mark = `（${gap}日ぶり）`;
      }
      rows.push(`- ${name} ${n(count)}${mark}`);
    }
    body.push("## よくいた場所\n\n" + rows.join("\n"));
  }

  if (week.exts.size) {
    body.push("## 手が動いたもの\n\n" +
      mostCommon(week.exts, 8).map(([name, count]) => `${name} ${n(count)}`).join("、"));
  }

  if (week.troubles) {
    const detail = mostCommon(week.troubleTools, 5).map(([t, c]) => `${t} ${c}`).join("、");
    body.push(`## つまずき\n\n${week.troubles} 件${diff(week.troubles, before?.troubles ?? null)}` +
      (detail ? `\n\n${detail}` : ""));
  }

  if (week.titles.length) {
    body.push("## そとに出したもの\n\n" + week.titles.map((t) => `- ${t}`).join("\n"));
  }

  // 止まっているもの。**この週の終わりの時点で**数える。
  const stale: [number, string, number][] = [];
  for (const [name, last] of seen) {
    if (week.projects.has(name)) continue;
    const total = totals.get(name) ?? 0;
    if (total < STALE_MIN_COMMITS) continue;
    const gap = Math.round((toUtc(week.end) - toUtc(last)) / MS_PER_DAY);
    if (gap >= STALE_AFTER) stale.push([gap, name, total]);
  }
  if (stale.length) {
    // Python の sorted(reverse=True) はタプルの辞書順。
    stale.sort((a, b) => (b[0] - a[0]) || (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : b[2] - a[2]));
    body.push("## 止まっているもの\n\n" + stale.slice(0, STALE_SHOWN)
      .map(([gap, name, count]) => `- ${name} ${gap}日（${n(count)} コミット積んで）`).join("\n"));
  }

  return head + "\n\n" + body.join("\n\n") + "\n";
}

function main(): number {
  const args = parseArgs(process.argv.slice(2), ["dry-run", "quiet"]);

  const days = new Map<string, Day>();
  scan(days);
  const weeks = fold(days);

  // 週を古い順に見ながら「その時点までに知っていること」を育てる。
  // 先に全部集めてしまうと、過去のおつげが未来を知ってしまう。
  const seen = new Map<string, string>();
  const totals = new Map<string, number>();
  const stats: Record<WriteState, number> = { new: 0, updated: 0, same: 0 };
  let before: Week | null = null;

  for (const week of weeks) {
    const out = join(ROOM, `${week.key}.md`);
    stats[writeIfChanged(out, render(week, before, new Map(seen), new Map(totals)),
      args.flags["dry-run"])] += 1;

    // この週を見終えてから知識を更新する。
    for (const [name, count] of week.projects) {
      seen.set(name, week.end);
      totals.set(name, (totals.get(name) ?? 0) + count);
    }
    before = week;
  }

  const total = stats.new + stats.updated + stats.same;
  if (args.flags.quiet) {
    console.log(
      `otsuge: ${total}週 (new ${stats.new} / upd ${stats.updated} / same ${stats.same})`,
    );
  } else {
    if (args.flags["dry-run"]) console.log("（書かずに確認）");
    console.log(`  おつげ       : ${n(total)} 週`);
    console.log(`    あたらしい : ${n(stats.new)}`);
    console.log(`    かきかえ   : ${n(stats.updated)}`);
    console.log(`    かわらず   : ${n(stats.same)}`);
    if (weeks.length) console.log(`  期間         : ${weeks[0].key} 〜 ${weeks[weeks.length - 1].key}`);
    console.log(`  ばしょ : ${ROOM}`);
  }

  return 0;
}

process.exit(main());
