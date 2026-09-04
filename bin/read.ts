/**
 * read — 拠点を読む
 *
 * ブラウザ（`web.ts`）と端末（`browse.ts`）が共通で使う読み取り層。
 * ここは**読むだけ**で、拠点には一切書かない（原則5: 書き込み口を絞る）。
 *
 * 数える値は frontmatter と表から取り、本文は見出しで切ったまま渡す。
 * 箇条書きの書式に賭けてパースを増やすより、原文をそのまま見せるほうが
 * 原則3（原文ママ）に合う。パースするのは「並べ替えと絵に要る値」だけ。
 */

import { existsSync, statSync } from "node:fs";
import { join, normalize, relative } from "node:path";

import { KYOTEN, readText, splitFrontmatter } from "./util.ts";
import { listFiles } from "./cli.ts";

// ---------------------------------------------------------------- 切る

/** 見出しの `.` は `\r` にマッチしない（落とし穴23）。`[^\n]` で書く。 */
const RE_H = /^(#{1,6}) +([^\n]*)$/;

export interface Section {
  readonly head: string;
  readonly lines: readonly string[];
}

export interface Doc {
  /** 拠点からの相対パス。原文を開くときの住所になる */
  readonly path: string;
  readonly fields: Record<string, string>;
  /** `# 見出し` */
  readonly title: string;
  /** `#` の直後の1行（`2004-12-26 から … まで。23 年。`） */
  readonly lead: string;
  /**
   * 見出し（`#`）を除いた本文まるごと。
   *
   * 日記のように**見出しを持たない部屋**があるので要る。`sections` だけ
   * 見ていると、段落しかない文書は `lead` の1行しか取れず、残りが消える。
   */
  readonly body: string;
  readonly sections: readonly Section[];
}

function trimEnds(lines: string[]): string[] {
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines;
}

export function readDoc(abs: string): Doc {
  const text = readText(abs);
  const [fields, body] = splitFrontmatter(text);

  let title = "";
  let lead = "";
  const kept: string[] = [];
  const sections: { head: string; lines: string[] }[] = [];
  let cur: { head: string; lines: string[] } | null = null;

  for (const raw of body.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const got = RE_H.exec(line);
    if (got && got[1].length === 1) {
      title = got[2].trim();
      cur = null;
      continue;
    }
    kept.push(line);
    if (got) {
      cur = { head: got[2].trim(), lines: [] };
      sections.push(cur);
      continue;
    }
    if (cur) cur.lines.push(line);
    else if (!lead && line.trim()) lead = line.trim();
  }

  for (const s of sections) trimEnds(s.lines);
  return {
    path: relative(KYOTEN, abs),
    fields,
    title,
    lead,
    body: trimEnds(kept).join("\n"),
    sections,
  };
}

/** 見出しの前方一致で節を引く。`いま手が動いているもの（… 以降）` のため。 */
export function section(doc: Doc, head: string): Section | null {
  return doc.sections.find((s) => s.head.startsWith(head)) ?? null;
}

export function bullets(sec: Section | null): string[] {
  if (!sec) return [];
  return sec.lines.filter((l) => l.trimStart().startsWith("- "))
    .map((l) => l.trimStart().slice(2).trim());
}

/** `1,221` を数にする。読めなければ 0。 */
export function num(s: string | undefined): number {
  if (!s) return 0;
  const v = Number.parseInt(s.replaceAll(",", ""), 10);
  return Number.isNaN(v) ? 0 : v;
}

/** 拠点の年数の数え方は profile.ts と同じ（終わりの年 − 始まりの年 + 1）。 */
export function years(first: string, last: string): number {
  if (!first || !last) return 0;
  return Number(last.slice(0, 4)) - Number(first.slice(0, 4)) + 1;
}

// ---------------------------------------------------------------- ためる

/**
 * 素材が変わっていなければ読み直さない。
 *
 * 拠点は定時便が書き換えるので、立ち上げっぱなしのサーバが古いものを
 * 見せないよう、ファイル数と mtime の最大値で見張る。
 */
const memo = new Map<string, { stamp: string; value: unknown }>();

function stampOf(paths: readonly string[]): string {
  let max = 0;
  for (const p of paths) {
    try {
      const t = statSync(p).mtimeMs;
      if (t > max) max = t;
    } catch {
      continue;
    }
  }
  return `${paths.length}:${max}`;
}

function cached<T>(key: string, paths: readonly string[], load: () => T): T {
  const stamp = stampOf(paths);
  const got = memo.get(key);
  if (got && got.stamp === stamp) return got.value as T;
  const value = load();
  memo.set(key, { stamp, value });
  return value;
}

function room(...parts: string[]): string {
  return join(KYOTEN, ...parts);
}

// ---------------------------------------------------------------- プロフィール

export interface Stat {
  readonly label: string;
  readonly value: string;
}

export interface LongTerm {
  readonly name: string;
  readonly first: string;
  readonly last: string;
  readonly years: number;
}

export interface Now {
  readonly name: string;
  readonly count: number;
}

export interface YearRow {
  readonly year: number;
  readonly commits: number;
  readonly articles: number;
  readonly main: readonly string[];
}

export interface ProfileView {
  readonly doc: Doc;
  readonly first: string;
  readonly last: string;
  readonly span: number;
  readonly skills: number;
  readonly stats: readonly Stat[];
  readonly now: readonly Now[];
  readonly nowHead: string;
  readonly longTerm: readonly LongTerm[];
  readonly years: readonly YearRow[];
}

/** `- 会話　　　351 本` — 見た目を揃える全角スペースで割れている */
const RE_STAT = /^([^\d]+?)[ 　]+([\d,]+.*)$/;
/** `- typescript 2,812` */
const RE_NOW = /^(.+?)[ 　]+([\d,]+)$/;
/** `- php 2006-11 〜 2026-09（21年）` */
const RE_LONG = /^(.+?)[ 　]+(\S+)[ 　]*〜[ 　]*(\S+)（(\d+)年）$/;

function parseYears(sec: Section | null): YearRow[] {
  if (!sec) return [];
  const out: YearRow[] = [];
  for (const line of sec.lines) {
    const s = line.trim();
    if (!s.startsWith("|")) continue;
    const cells = s.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 3) continue;
    const year = Number.parseInt(cells[0], 10);
    if (Number.isNaN(year)) continue; // 見出し行と `|---|` を落とす
    out.push({
      year,
      commits: num(cells[1]),
      articles: num(cells[2]),
      main: (cells[3] ?? "").split("、").map((s) => s.trim()).filter(Boolean),
    });
  }
  return out;
}

export function profile(): ProfileView | null {
  const abs = room("プロフィール", "プロフィール.md");
  return cached("profile", [abs], () => {
    if (!existsSync(abs)) return null;
    const doc = readDoc(abs);
    const first = doc.fields.first ?? "";
    const last = doc.fields.last ?? "";
    const nowSec = section(doc, "いま手が動いているもの");

    const stats: Stat[] = [];
    for (const b of bullets(section(doc, "記録の量"))) {
      const got = RE_STAT.exec(b);
      stats.push(got ? { label: got[1].trim(), value: got[2].trim() } : { label: b, value: "" });
    }

    const now: Now[] = [];
    for (const b of bullets(nowSec)) {
      const got = RE_NOW.exec(b);
      if (got) now.push({ name: got[1].trim(), count: num(got[2]) });
    }

    const longTerm: LongTerm[] = [];
    for (const b of bullets(section(doc, "長くいっしょにいるもの"))) {
      const got = RE_LONG.exec(b);
      if (got) {
        longTerm.push({
          name: got[1].trim(),
          first: got[2],
          last: got[3],
          years: Number(got[4]),
        });
      }
    }

    return {
      doc,
      first,
      last,
      span: years(first, last),
      skills: num(doc.fields.skills),
      stats,
      now,
      nowHead: nowSec?.head ?? "いま手が動いているもの",
      longTerm,
      years: parseYears(section(doc, "あゆみ")),
    };
  });
}

// ---------------------------------------------------------------- スキル

export interface Skill {
  readonly name: string;
  readonly first: string;
  readonly last: string;
  readonly years: number;
  readonly articles: number;
  readonly files: number;
  readonly path: string;
}

export function skillList(): readonly Skill[] {
  const paths = listFiles(room("プロフィール", "スキル"), ".md");
  return cached("skill", paths, () =>
    paths.map((abs) => {
      const doc = readDoc(abs);
      const first = doc.fields.first ?? "";
      const last = doc.fields.last ?? "";
      return {
        name: doc.fields.name || doc.title,
        first,
        last,
        years: years(first, last),
        articles: num(doc.fields.articles),
        files: num(doc.fields.files),
        path: doc.path,
      };
    }).sort((a, b) => b.files + b.articles - (a.files + a.articles) || a.name.localeCompare(b.name)));
}

export function skill(name: string): Doc | null {
  const abs = room("プロフィール", "スキル", `${safeName(name)}.md`);
  return existsSync(abs) ? readDoc(abs) : null;
}

// ---------------------------------------------------------------- 年表

export interface TimelineYear {
  readonly year: number;
  readonly commits: number;
  readonly articles: number;
  readonly lead: string;
  readonly path: string;
}

export function timelineList(): readonly TimelineYear[] {
  const paths = listFiles(room("プロフィール", "年表"), ".md");
  return cached("timeline", paths, () =>
    paths.map((abs) => {
      const doc = readDoc(abs);
      return {
        year: num(doc.fields.year),
        commits: num(doc.fields.commits),
        articles: num(doc.fields.articles),
        lead: doc.lead,
        path: doc.path,
      };
    }).sort((a, b) => a.year - b.year));
}

export function timeline(year: string): Doc | null {
  const abs = room("プロフィール", "年表", `${safeName(year)}.md`);
  return existsSync(abs) ? readDoc(abs) : null;
}

// ---------------------------------------------------------------- 週報

export interface WeeklyHead {
  readonly week: string;
  readonly from: string;
  readonly to: string;
  readonly commits: number;
  readonly path: string;
}

export function weeklyList(): readonly WeeklyHead[] {
  const paths = listFiles(room("週報"), ".md");
  return cached("weekly", paths, () =>
    paths.map((abs) => {
      const doc = readDoc(abs);
      return {
        week: doc.fields.week || doc.title.replace(/ の週報$/, ""),
        from: doc.fields.from ?? "",
        to: doc.fields.to ?? "",
        commits: num(doc.fields.commits),
        path: doc.path,
      };
    }).sort((a, b) => a.week.localeCompare(b.week)));
}

export function weekly(week: string): Doc | null {
  const abs = room("週報", `${safeName(week)}.md`);
  return existsSync(abs) ? readDoc(abs) : null;
}

// ---------------------------------------------------------------- 推移

export interface TrendHead {
  readonly week: string;
  readonly from: string;
  readonly to: string;
  /** その週の終わりまでの累計。週報の `commits` は週内の数なので別もの */
  readonly commits: number;
  readonly projects: number;
  readonly path: string;
}

export function trendList(): readonly TrendHead[] {
  const paths = listFiles(room("プロフィール", "推移"), ".md");
  return cached("trend", paths, () =>
    paths.map((abs) => {
      const doc = readDoc(abs);
      return {
        week: doc.fields.week || doc.title.replace(/ の推移$/, ""),
        from: doc.fields.from ?? "",
        to: doc.fields.to ?? "",
        commits: num(doc.fields.commits),
        projects: num(doc.fields.projects),
        path: doc.path,
      };
    }).sort((a, b) => a.week.localeCompare(b.week)));
}

export function trend(week: string): Doc | null {
  const abs = room("プロフィール", "推移", `${safeName(week)}.md`);
  return existsSync(abs) ? readDoc(abs) : null;
}

// ---------------------------------------------------------------- 日記

export interface DiaryHead {
  readonly date: string;
  /** 誰が書いたか。この部屋だけ書き手が LLM なので、機種を残してある */
  readonly by: string;
  readonly lead: string;
  readonly path: string;
}

export function diaryList(): readonly DiaryHead[] {
  const paths = listFiles(room("日記"), ".md");
  return cached("diary", paths, () =>
    paths.map((abs) => {
      const doc = readDoc(abs);
      return {
        date: doc.fields.date || doc.title.replace(/ の日記$/, ""),
        by: doc.fields.by ?? "",
        lead: doc.lead,
        path: doc.path,
      };
    }).sort((a, b) => a.date.localeCompare(b.date)));
}

export function diary(date: string): Doc | null {
  const abs = room("日記", safeName(date).slice(0, 7), `${safeName(date)}.md`);
  return existsSync(abs) ? readDoc(abs) : null;
}

// ---------------------------------------------------------------- 事典

export interface EntityHead {
  readonly name: string;
  readonly first: string;
  readonly last: string;
  readonly sessions: number;
  readonly commits: number;
  readonly path: string;
}

export function entityList(): readonly EntityHead[] {
  const paths = listFiles(room("事典", "プロジェクト"), ".md");
  return cached("entity", paths, () =>
    paths.map((abs) => {
      const doc = readDoc(abs);
      return {
        name: doc.fields.name || doc.title,
        first: doc.fields.first ?? "",
        last: doc.fields.last ?? "",
        sessions: num(doc.fields.sessions),
        commits: num(doc.fields.commits),
        path: doc.path,
      };
    }).sort((a, b) => b.last.localeCompare(a.last) || a.name.localeCompare(b.name)));
}

// ---------------------------------------------------------------- まとめ

/**
 * ブラウザに出すぶん。
 *
 * ブラウザで見たいのは**まとめ**で、776週の一覧でも71枚のスキルでもない
 * （潜るのは端末の仕事）。だから一覧はどれも頭を落として渡す。
 * 週報だけは節をそのまま持たせる —— 向こうから来た問いは要約しない。
 */
export interface Summary {
  readonly first: string;
  readonly last: string;
  readonly span: number;
  readonly lead: string;
  readonly stats: readonly Stat[];
  readonly nowHead: string;
  readonly now: readonly Now[];
  readonly longTerm: readonly LongTerm[];
  readonly years: readonly YearRow[];
  readonly skills: number;
  readonly skillTop: readonly Skill[];
  readonly places: readonly EntityHead[];
  readonly weeks: number;
  readonly weekly: Doc | null;
  readonly trend: Doc | null;
  readonly diary: Doc | null;
  readonly diaryDate: string;
  readonly diaries: number;
}

export function summary(): Summary | null {
  const p = profile();
  if (!p) return null;
  const weeks = weeklyList();
  const last = weeks[weeks.length - 1];
  return {
    first: p.first,
    last: p.last,
    span: p.span,
    lead: p.doc.lead,
    stats: p.stats,
    nowHead: p.nowHead,
    now: p.now,
    longTerm: p.longTerm,
    years: p.years,
    skills: p.skills,
    skillTop: skillList().slice(0, 12),
    places: entityList().slice(0, 8),
    weeks: weeks.length,
    weekly: last ? weekly(last.week) : null,
    // 推移は週の数が週報と同じとは限らない（部屋を建てた時点で揃うが、
    // 片方だけ流した夜がありうる）ので、推移側の最後の週から引く
    trend: (() => {
      const t = trendList();
      const tail = t[t.length - 1];
      return tail ? trend(tail.week) : null;
    })(),
    // 日記はいちばん新しい1枚だけ。潜るのは端末の仕事
    diary: (() => {
      const tail = diaryList().at(-1);
      return tail ? diary(tail.date) : null;
    })(),
    diaryDate: diaryList().at(-1)?.date ?? "",
    diaries: diaryList().length,
  };
}

// ---------------------------------------------------------------- 原文

/** ファイル名に使われる部分。`/` と `..` を弾く（住所を外に出さない）。 */
function safeName(s: string): string {
  return s.replaceAll("/", "_").replaceAll("\\", "_").replaceAll("..", "_");
}

/**
 * 拠点の相対パスから原文を読む。
 *
 * 拠点の外は読まない。`..` で外に出ようとしたものは null で落とす
 * （ローカル専用とはいえ、住所を組み立てるのはブラウザなので）。
 */
export function raw(rel: string): { path: string; text: string } | null {
  if (!rel || rel.includes("\0")) return null;
  const abs = normalize(join(KYOTEN, rel));
  if (abs !== KYOTEN && !abs.startsWith(KYOTEN + "/")) return null;
  if (!abs.endsWith(".md") || !existsSync(abs)) return null;
  return { path: relative(KYOTEN, abs), text: readText(abs) };
}
