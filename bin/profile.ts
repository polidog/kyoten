#!/usr/bin/env node
/**
 * profile — プロフィール・スキル・年表（観測結果の2階）
 *
 * 1階（会話・自分・アイボ・日記・投稿・作業・事典）に溜まったものを、**人が読む形**
 * へ畳む。事典が「プロジェクトごとの横串」なら、こちらは「技ごと」と
 * 「年ごと」と「いま」。
 *
 *     プロフィール/プロフィール.md    いまの自分（1枚）
 *     プロフィール/スキル/<name>.md   技ごと。いつ覚えて、いつ使ったか
 *     プロフィール/年表/<YYYY>.md     年ごと。その年に何をしていたか
 *
 * 事典と同じく**拠点の中しか見ない**。jsonl も git も直接は読まない。
 * 走らせる順番は … → work → entities → profile。
 *
 * 原則:
 *   - 決定論的: 同じ拠点なら必ず同じ出力。「今日から何日」のような、
 *     走らせた日で変わる数は書かない。
 *   - 冪等: 内容が変わらなければファイルに触れない。
 *   - 手で書かせない: 技の一覧も年表も、素材が増えれば勝手に増える。
 *
 * 使い方:
 *     profile.ts                   # 全部
 *     profile.ts --dry-run
 *     profile.ts --quiet
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  KYOTEN,
  frontmatter,
  n,
  readText,
  safePath,
  splitFrontmatter,
  writeIfChanged,
  type WriteState,
} from "./util.ts";
import { listFiles, parseArgs } from "./cli.ts";

const ROOM = join(KYOTEN, "プロフィール");

/**
 * スキルとして1枚立てる下限。これを下回るものは、その年に一度触っただけの
 * ものが大半で、並べても技には見えない。
 */
const MIN_ARTICLES = 5;
const MIN_FILES = 50;

/**
 * 「いま」の窓。直近の日数ではなく**拠点にある最後の日から**遡る
 * —— 走らせた日で結果が変わると決定論が崩れる。
 */
const RECENT_DAYS = 90;

/**
 * 言語の名前と、手が動いたときに残る拡張子。タグと拡張子が同じ名前の
 * ものは書かない（`php` ↔ `.php` は名前で結びつく）。ここに並ぶのは
 * 「名前と拡張子が違う」ものだけ。
 */
const ALIAS: Record<string, string[]> = {
  typescript: ["ts", "tsx", "mts", "cts"],
  javascript: ["js", "mjs", "cjs", "jsx"],
  golang: ["go"],
  python: ["py"],
  ruby: ["rb"],
  rust: ["rs"],
  markdown: ["md"],
  shell: ["sh", "bash", "zsh"],
  yaml: ["yml"],
  docker: ["dockerfile"],
  css: ["scss", "sass"],
  actionscript: ["as"],
  "objective-c": ["m"],
  kotlin: ["kt"],
  sql: ["sql"],
  terraform: ["tf"],
  vue: ["vue"],
  swift: ["swift"],
  java: ["java"],
  perl: ["pl", "pm"],
  elixir: ["ex", "exs"],
};

/** 拡張子から技の名前を引く逆引き。 */
const EXT_TO_NAME = new Map<string, string>();
for (const [name, exts] of Object.entries(ALIAS)) {
  for (const ext of exts) EXT_TO_NAME.set(ext, name);
}

/**
 * 数えても技にならないもの。画像やロックファイルは、どのプロジェクトでも
 * 増えるだけで何も語らない。
 */
const EXT_IGNORE = new Set([
  "png", "jpg", "jpeg", "gif", "svg", "ico", "webp", "avif", "pdf",
  "lock", "sum", "map", "min", "snap", "log", "txt", "csv",
]);

const RE_COMMIT = /^- `([0-9a-f]{4,})` ([^\n]*)$/;
const RE_FILE = /^- `([^`]+)`/;
const RE_HEAD2 = /^## ([^\n]+)$/;
const RE_HEAD3 = /^### ([^\n]+)$/;

function bump(counter: Map<string, number>, key: string, by = 1): void {
  counter.set(key, (counter.get(key) ?? 0) + by);
}

/** Python の Counter.most_common と同じ並び（頻度降順、同数は挿入順）。 */
function mostCommon(counter: Map<string, number>, limit?: number): [string, number][] {
  const rows = [...counter.entries()].sort((a, b) => b[1] - a[1]);
  return limit === undefined ? rows : rows.slice(0, limit);
}

/** 1つの技。書いたもの（記事）と、手が動いたもの（ファイル）の両面。 */
class Skill {
  readonly name: string;
  articles = 0;
  firstWrote = "";
  lastWrote = "";
  readonly exts = new Map<string, number>();
  firstTouched = "";
  lastTouched = "";
  readonly titles: [string, string][] = [];
  readonly friends = new Map<string, number>();
  /**
   * 月ごとの内訳。「いま手が動いているもの」を全期間の合計で語ると
   * 「21年ぶんの php 3,620」が「直近90日」の欄に出てしまう。
   */
  readonly byMonth = new Map<string, number>();

  constructor(name: string) {
    this.name = name;
  }

  get files(): number {
    let sum = 0;
    for (const v of this.exts.values()) sum += v;
    return sum;
  }

  /** cut（YYYY-MM-DD）以降に触ったファイル数。月の粒度で数える。 */
  since(cut: string): number {
    let sum = 0;
    for (const [month, count] of this.byMonth) {
      if (month >= cut.slice(0, 7)) sum += count;
    }
    return sum;
  }

  wrote(date: string): void {
    if (!date) return;
    if (!this.firstWrote || date < this.firstWrote) this.firstWrote = date;
    if (!this.lastWrote || date > this.lastWrote) this.lastWrote = date;
  }

  touched(date: string): void {
    if (!date) return;
    if (!this.firstTouched || date < this.firstTouched) this.firstTouched = date;
    if (!this.lastTouched || date > this.lastTouched) this.lastTouched = date;
  }

  first(): string {
    const got = [this.firstWrote, this.firstTouched].filter(Boolean);
    return got.length ? got.reduce((a, b) => (a < b ? a : b)) : "";
  }

  last(): string {
    const got = [this.lastWrote, this.lastTouched].filter(Boolean);
    return got.length ? got.reduce((a, b) => (a > b ? a : b)) : "";
  }

  worthAPage(): boolean {
    return this.articles >= MIN_ARTICLES || this.files >= MIN_FILES;
  }
}

class Year {
  readonly year: string;
  commits = 0;
  days = 0;
  articles = 0;
  posts = 0;
  sessions = 0;
  readonly exts = new Map<string, number>();
  readonly projects = new Map<string, number>();
  readonly titles: [string, string][] = [];
  readonly tags = new Map<string, number>();

  constructor(year: string) {
    this.year = year;
  }
}

type Skills = Map<string, Skill>;
type Years = Map<string, Year>;

function skillOf(skills: Skills, name: string): Skill {
  let s = skills.get(name);
  if (!s) {
    s = new Skill(name);
    skills.set(name, s);
  }
  return s;
}

function yearOf(years: Years, year: string): Year {
  let y = years.get(year);
  if (!y) {
    y = new Year(year);
    years.set(year, y);
  }
  return y;
}

// ---------------------------------------------------------------- 素材

function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return (base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : base).toLowerCase();
}

/** ファイルの名前から技の名前を出す。技でなければ空。 */
function extName(path: string): string {
  const ext = extOf(path);
  if (!ext || ext.length > 12 || EXT_IGNORE.has(ext)) return "";
  if (!/^[0-9a-z]+$/i.test(ext)) return "";
  return EXT_TO_NAME.get(ext) ?? ext;
}

/** `投稿/`。記事のタグが「書いたこと」、日付が年表の骨。 */
function scanPosts(skills: Skills, years: Years, span: string[]): void {
  const root = join(KYOTEN, "投稿");
  if (!existsSync(root)) return;

  for (const path of listFiles(root, ".md")) {
    const [fields] = splitFrontmatter(readText(path).slice(0, 3000));
    const date = fields.date ?? "";
    if (!date) continue;
    // プロフィールの「いつから」は拠点にある最初の日。タグの付いた記事に
    // 限ると、タグを使い始める前（2004〜2005）が丸ごと落ちる。
    span.push(date);
    const year = yearOf(years, date.slice(0, 4));

    if (fields.source !== "polidog.jp") {
      year.posts += 1;
      continue;
    }

    year.articles += 1;
    const title = fields.title ?? "";
    if (title) year.titles.push([date, title]);

    const tags = (fields.tags ?? "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
    for (const tag of tags) {
      bump(year.tags, tag);
      const skill = skillOf(skills, tag);
      skill.articles += 1;
      skill.wrote(date);
      if (title) skill.titles.push([date, title]);
      for (const other of tags) {
        if (other !== tag) bump(skill.friends, other);
      }
    }
  }
}

/** `作業/`。触ったファイルの拡張子が「手が動いたもの」。 */
function scanWork(skills: Skills, years: Years, span: string[]): void {
  const root = join(KYOTEN, "作業");
  if (!existsSync(root)) return;

  for (const path of listFiles(root, ".md")) {
    const [fields, body] = splitFrontmatter(readText(path));
    const date = fields.date ?? "";
    if (!date) continue;
    span.push(date);
    const year = yearOf(years, date.slice(0, 4));
    year.days += 1;

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
        year.commits += 1;
        if (project) bump(year.projects, project);
      } else if (section === "さわった") {
        const got = RE_FILE.exec(line);
        if (!got) continue;
        const name = extName(got[1]);
        if (!name) continue;
        bump(year.exts, name);
        const skill = skillOf(skills, name);
        bump(skill.exts, extOf(got[1]));
        bump(skill.byMonth, date.slice(0, 7));
        skill.touched(date);
      }
    }
  }
}

/** 各部屋の大きさ。プロフィールの「記録の量」になる。 */
function scanRooms(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const room of ["会話", "自分", "アイボ", "日記", "投稿", "作業"]) {
    const root = join(KYOTEN, room);
    counts[room] = existsSync(root) ? listFiles(root, ".md").length : 0;
  }
  const entities = join(KYOTEN, "事典", "プロジェクト");
  counts["事典"] = existsSync(entities) ? listFiles(entities, ".md").length : 0;
  return counts;
}

// ---------------------------------------------------------------- 書く

function renderSkill(skill: Skill): string {
  const head = frontmatter({
    room: "プロフィール",
    kind: "スキル",
    name: skill.name,
    first: skill.first(),
    last: skill.last(),
    articles: skill.articles,
    files: skill.files,
  });

  let span = "";
  const first = skill.first();
  const last = skill.last();
  if (first && last) {
    const held = Number(last.slice(0, 4)) - Number(first.slice(0, 4)) + 1;
    span = `${first} 〜 ${last}（${held}年）`;
  }

  const body: string[] = [`# ${skill.name}`, span || "（記録なし）"];

  if (skill.articles) {
    const lines = [`記事 ${n(skill.articles)} 本　${skill.firstWrote} 〜 ${skill.lastWrote}`];
    const sorted = [...skill.titles].sort((a, b) => {
      for (let i = 0; i < 2; i++) if (a[i] !== b[i]) return a[i] < b[i] ? 1 : -1;
      return 0;
    });
    for (const [date, title] of sorted.slice(0, 10)) lines.push(`- ${date} ${title}`);
    if (skill.titles.length > 10) lines.push(`- … ほか ${skill.titles.length - 10} 本`);
    body.push("## 書いた\n\n" + lines.join("\n"));
  }

  if (skill.files) {
    const lines = [`ファイル ${n(skill.files)}　${skill.firstTouched} 〜 ${skill.lastTouched}`];
    for (const [ext, count] of mostCommon(skill.exts, 8)) lines.push(`- \`.${ext}\` ${n(count)}`);
    body.push("## 手が動いた\n\n" + lines.join("\n"));
  }

  if (skill.friends.size) {
    body.push("## となりにいるもの\n\n" + mostCommon(skill.friends, 12)
      .map(([name, count]) => `${name}(${count})`).join("、"));
  }

  return head + "\n\n" + body.join("\n\n") + "\n";
}

function renderYear(year: Year): string {
  const head = frontmatter({
    room: "プロフィール",
    kind: "年表",
    year: year.year,
    commits: year.commits,
    articles: year.articles,
  });

  const counts: string[] = [];
  if (year.commits) counts.push(`コミット ${n(year.commits)}`);
  if (year.days) counts.push(`手を動かした日 ${n(year.days)}`);
  if (year.articles) counts.push(`記事 ${n(year.articles)}`);
  if (year.posts) counts.push(`SNS ${n(year.posts)}日ぶん`);

  const body: string[] = [`# ${year.year}`, counts.join(" / ") || "（記録なし）"];

  if (year.exts.size) {
    body.push("## 手が動いたもの\n\n" + mostCommon(year.exts, 10)
      .map(([name, count]) => `- ${name} ${n(count)}`).join("\n"));
  }
  if (year.tags.size) {
    body.push("## 書いたこと\n\n" + mostCommon(year.tags, 15)
      .map(([tag, count]) => `${tag}(${count})`).join("、"));
  }
  if (year.projects.size) {
    body.push("## いた場所\n\n" + mostCommon(year.projects, 10)
      .map(([name, count]) => `- ${name} ${n(count)}`).join("\n"));
  }
  if (year.titles.length) {
    const sorted = [...year.titles].sort((a, b) => {
      for (let i = 0; i < 2; i++) if (a[i] !== b[i]) return a[i] < b[i] ? 1 : -1;
      return 0;
    });
    const lines = sorted.slice(0, 15).map(([d, t]) => `- ${d} ${t}`);
    if (year.titles.length > 15) lines.push(`- … ほか ${year.titles.length - 15} 本`);
    body.push("## そとに出したもの\n\n" + lines.join("\n"));
  }

  return head + "\n\n" + body.join("\n\n") + "\n";
}

function shiftDays(date: string, delta: number): string {
  const ms = Date.parse(date + "T00:00:00Z");
  if (Number.isNaN(ms)) return date;
  return new Date(ms + delta * 86_400_000).toISOString().slice(0, 10);
}

function renderProfile(
  rooms: Record<string, number>,
  skills: Skills,
  years: Years,
  span: readonly [string, string],
): string {
  const [start, today] = span;

  const head = frontmatter({
    room: "プロフィール",
    kind: "プロフィール",
    first: start,
    last: today,
    skills: [...skills.values()].filter((s) => s.worthAPage()).length,
  });

  const body: string[] = ["# プロフィール"];

  if (start && today) {
    const held = Number(today.slice(0, 4)) - Number(start.slice(0, 4)) + 1;
    body.push(`${start} から ${today} まで。${held} 年。`);
  }

  body.push("## 記録の量\n\n" + [
    `- 会話　　　${n(rooms["会話"] ?? 0)} 本`,
    `- 自分　　　${n(rooms["自分"] ?? 0)} 日ぶん`,
    `- アイボ　　${n(rooms["アイボ"] ?? 0)} 日ぶん`,
    `- 日記　　　${n(rooms["日記"] ?? 0)} 日ぶん`,
    `- 投稿　　　${n(rooms["投稿"] ?? 0)}`,
    `- 作業　　　${n(rooms["作業"] ?? 0)} 日ぶん`,
    `- 事典　　　${n(rooms["事典"] ?? 0)} プロジェクト`,
  ].join("\n"));

  // 「いま」は拠点の最後の日から遡る。走らせた日を使うと、同じ拠点でも
  // 日をまたぐたびに中身が変わって冪等が壊れる。
  if (today) {
    const cut = shiftDays(today, -RECENT_DAYS);
    const now = [...skills.values()]
      .filter((s) => s.last() >= cut)
      .map((s) => [s, s.since(cut)] as const)
      .filter(([, count]) => count > 0)
      .sort((a, b) => (b[1] - a[1]) || (a[0].name < b[0].name ? -1 : a[0].name > b[0].name ? 1 : 0));
    if (now.length) {
      body.push(`## いま手が動いているもの（${cut} 以降）\n\n` +
        now.slice(0, 10).map(([s, count]) => `- ${s.name} ${n(count)}`).join("\n"));
    }
  }

  const long = [...skills.values()].filter((s) => s.worthAPage() && s.first() && s.last());
  long.sort((a, b) => {
    const spanA = Number(a.last().slice(0, 4)) - Number(a.first().slice(0, 4));
    const spanB = Number(b.last().slice(0, 4)) - Number(b.first().slice(0, 4));
    return spanB - spanA || b.files - a.files;
  });
  if (long.length) {
    body.push("## 長くいっしょにいるもの\n\n" + long.slice(0, 10).map((s) => {
      const held = Number(s.last().slice(0, 4)) - Number(s.first().slice(0, 4)) + 1;
      return `- ${s.name} ${s.first().slice(0, 7)} 〜 ${s.last().slice(0, 7)}（${held}年）`;
    }).join("\n"));
  }

  if (years.size) {
    const rows: string[] = [];
    for (const key of [...years.keys()].sort()) {
      const y = years.get(key)!;
      const top = mostCommon(y.exts, 3).map(([name]) => name).join("、") ||
        mostCommon(y.tags, 3).map(([tag]) => tag).join("、");
      rows.push(`| ${key} | ${n(y.commits)} | ${n(y.articles)} | ${top} |`);
    }
    body.push("## あゆみ\n\n| 年 | コミット | 記事 | 主に |\n|---|---:|---:|---|\n" + rows.join("\n"));
  }

  return head + "\n\n" + body.join("\n\n") + "\n";
}

function main(): number {
  const args = parseArgs(process.argv.slice(2), ["dry-run", "quiet"]);

  const skills: Skills = new Map();
  const years: Years = new Map();
  const span: string[] = [];
  scanPosts(skills, years, span);
  scanWork(skills, years, span);
  const rooms = scanRooms();
  const period: [string, string] = span.length
    ? [span.reduce((a, b) => (a < b ? a : b)), span.reduce((a, b) => (a > b ? a : b))]
    : ["", ""];

  const stats: Record<WriteState, number> = { new: 0, updated: 0, same: 0 };

  const kept = [...skills.entries()].filter(([, s]) => s.worthAPage());
  for (const [name, skill] of kept.sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const out = join(ROOM, "スキル", safePath(name).replaceAll("/", "-") + ".md");
    stats[writeIfChanged(out, renderSkill(skill), args.flags["dry-run"])] += 1;
  }

  for (const key of [...years.keys()].sort()) {
    const out = join(ROOM, "年表", `${key}.md`);
    stats[writeIfChanged(out, renderYear(years.get(key)!), args.flags["dry-run"])] += 1;
  }

  stats[writeIfChanged(join(ROOM, "プロフィール.md"),
    renderProfile(rooms, skills, years, period), args.flags["dry-run"])] += 1;

  const total = stats.new + stats.updated + stats.same;
  if (args.flags.quiet) {
    console.log(
      `profile: ${total}枚 (new ${stats.new} / upd ${stats.updated} ` +
        `/ same ${stats.same}) スキル ${kept.length} 年 ${years.size}`,
    );
  } else {
    if (args.flags["dry-run"]) console.log("（書かずに確認）");
    console.log(`  プロフィール   : ${n(total)} 枚`);
    console.log(`    あたらしい : ${n(stats.new)}`);
    console.log(`    かきかえ   : ${n(stats.updated)}`);
    console.log(`    かわらず   : ${n(stats.same)}`);
    console.log(`  スキル       : ${n(kept.length)}（候補 ${n(skills.size)}）`);
    console.log(`  年表         : ${n(years.size)} 年`);
    console.log(`  ばしょ : ${ROOM}`);
  }

  return 0;
}

process.exit(main());
