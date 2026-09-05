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

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, normalize, relative } from "node:path";

import { KYOTEN, readText, splitFrontmatter } from "./util.ts";
import { listFiles } from "./cli.ts";
// 年表の1行の形。書いた側から借りる（`events.ts` は `import.meta.main` で
// 守ってあるので、import しただけでは走らない —— 落とし穴21）
import { EVENT_LINE } from "./events.ts";

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

// ---------------------------------------------------------------- 出来事

/**
 * 年表の1行。
 *
 * ここは冒頭の「パースするのは並べ替えと絵に要る値だけ」の例外に見えるが、
 * そうではない —— `出来事/` の行は**書き手が形を決めて書いている**もので、
 * 箇条書きの書式に賭けているわけではない。形は `events.ts` の
 * `EVENT_LINE` が正で、ここは借りている（落とし穴21: 同じものを2か所で
 * 別々に解釈させない）。
 */
export interface Event {
  /** `MM-DD`。年は月の側が持っている */
  readonly date: string;
  /** その月でいちばん大きいもの。1か月に1つまで */
  readonly big: boolean;
  readonly name: string;
  readonly note: string;
}

export interface EventMonth {
  readonly month: string;
  /** 誰が書いたか。日記と同じく書き手が LLM なので機種を残す */
  readonly by: string;
  /** 出来事の前に置かれた、その月がどういう月だったか */
  readonly lead: string;
  /** 出来事のあとに置かれた、言いたいこと1行。無いこともある */
  readonly tail: string;
  readonly commits: number;
  readonly articles: number;
  readonly events: readonly Event[];
  readonly path: string;
}

export function eventList(): readonly EventMonth[] {
  const paths = listFiles(room("出来事"), ".md");
  return cached("events", paths, () =>
    paths.map((abs) => {
      const doc = readDoc(abs);
      const events: Event[] = [];
      const lead: string[] = [];
      const tail: string[] = [];
      for (const raw of doc.body.split("\n")) {
        const line = raw.replace(/\r$/, "").trim();
        const got = EVENT_LINE.exec(line);
        if (got) {
          events.push({
            date: got[2],
            big: Boolean(got[1]),
            name: got[3].trim(),
            note: (got[4] ?? "").trim(),
          });
        } else if (!line) {
          continue;
        } else if (!events.length) {
          // 出来事の前が前置き、あとが「言いたいこと」。どちらも捨てない
          // —— 出来事だけ拾って地の文を落とすと、書いた側の声が消える
          lead.push(line);
        } else {
          tail.push(line);
        }
      }
      return {
        month: doc.fields.month || doc.title.replace(/ の出来事$/, ""),
        by: doc.fields.by ?? "",
        lead: lead.join(" "),
        tail: tail.join(" "),
        commits: num(doc.fields.commits),
        articles: num(doc.fields.articles),
        events,
        path: doc.path,
      };
    }).sort((a, b) => a.month.localeCompare(b.month)));
}

export function events(month: string): Doc | null {
  const abs = room("出来事", `${safeName(month)}.md`);
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
  /** 同じ日を外から書いた者。一覧で「よそも書いた日」が分かるように */
  readonly readBy: readonly string[];
}

export function diaryList(): readonly DiaryHead[] {
  const paths = listFiles(room("日記"), ".md");
  // よその日記は書き手ごとに1枚あるので、日ごとに引くと日数×書き手数だけ
  // 舐めることになる。ここで1回だけ並べて、ファイル名から日付と書き手に割る
  const said = listFiles(room("よその日記"), ".md");
  return cached("diary", [...paths, ...said], () => {
    const readers = new Map<string, string[]>();
    for (const abs of said) {
      const got = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/.exec(basename(abs));
      if (!got) continue;
      const list = readers.get(got[1]) ?? [];
      list.push(got[2]);
      readers.set(got[1], list);
    }
    return paths.map((abs) => {
      const doc = readDoc(abs);
      const date = doc.fields.date || doc.title.replace(/ の日記$/, "");
      return {
        date,
        by: doc.fields.by ?? "",
        lead: doc.lead,
        path: doc.path,
        readBy: (readers.get(date) ?? []).sort(),
      };
    }).sort((a, b) => a.date.localeCompare(b.date));
  });
}

export function diary(date: string): Doc | null {
  const abs = room("日記", safeName(date).slice(0, 7), `${safeName(date)}.md`);
  return existsSync(abs) ? readDoc(abs) : null;
}

// ---------------------------------------------------------------- よその日記

export interface GuestHead {
  /** 誰が書いたか。日記の `by` と同じで、書き手が LLM なので機種を残す */
  readonly by: string;
  readonly doc: Doc;
}

/**
 * その日を外から書いた日記。
 *
 * アイボの日記は1日1枚なので日付で引けるが、よその日記は**書き手ごとに
 * 1枚**なので引けない。`よその日記/YYYY-MM/YYYY-MM-DD-<書き手>.md` を
 * 前方一致で拾う。
 *
 * 無い日がふつうにある（書き手がこけた日、ニュースが取れなかった日）。
 * よそが無いことはアイボの日記が読めない理由にならないので、空で返す。
 */
export function guestOn(date: string): readonly GuestHead[] {
  const dir = room("よその日記", safeName(date).slice(0, 7));
  if (!existsSync(dir)) return [];
  const head = `${safeName(date)}-`;
  return listFiles(dir, ".md")
    .filter((abs) => basename(abs).startsWith(head))
    .map((abs) => {
      const doc = readDoc(abs);
      return { by: doc.fields.by || "", doc };
    })
    .sort((a, b) => a.by.localeCompare(b.by));
}

// ---------------------------------------------------------------- 株

export interface StockHead {
  readonly date: string;
  /** 円での評価額。frontmatter にあるものをそのまま */
  readonly value: number;
  /** 損益。取得単価が書かれていなければ **null**（0 ではない） */
  readonly gain: number | null;
  readonly holdings: number;
  readonly path: string;
  /** その日に見立てが書かれているか。一覧で「言ってある日」が分かるように */
  readonly said: boolean;
}

export function stockList(): readonly StockHead[] {
  // `株/保有.md`（手で書く台帳）は日ごとの値ではないので数えない。
  // 日付の形をしたファイルだけを拾う
  const paths = listFiles(room("株"), ".md")
    .filter((abs) => /^\d{4}-\d{2}-\d{2}\.md$/.test(basename(abs)));
  const seen = listFiles(room("見立て"), ".md");
  return cached("stock", [...paths, ...seen], () => {
    const days = new Set(seen.map((abs) => basename(abs).slice(0, -3)));
    return paths.map((abs) => {
      const doc = readDoc(abs);
      const date = doc.fields.date || doc.title.replace(/ の株$/, "");
      return {
        date,
        value: num(doc.fields["評価額"]),
        // 取得単価を書いていない銘柄があると frontmatter に `損益` が出ない。
        // それを 0 にすると「損も得もしていない」に化ける（落とし穴63 と同じ形）
        gain: doc.fields["損益"] === undefined ? null : num(doc.fields["損益"]),
        holdings: num(doc.fields["銘柄"]),
        path: doc.path,
        said: days.has(date),
      };
    }).sort((a, b) => a.date.localeCompare(b.date));
  });
}

export function stock(date: string): Doc | null {
  const abs = room("株", safeName(date).slice(0, 7), `${safeName(date)}.md`);
  return existsSync(abs) ? readDoc(abs) : null;
}

// ---------------------------------------------------------------- 見立て

/**
 * その日の値に付いた見立て。
 *
 * よその日記（書き手ごとに1枚）と違って1日1枚なので、日付でそのまま引ける。
 * 見立ての無い日はふつうにある（`stock.ts` を流したが `outlook.ts` を
 * まだ流していない日）。無いことは値が読めない理由にならないので null。
 */
export function outlookOn(date: string): Doc | null {
  const abs = room("見立て", safeName(date).slice(0, 7), `${safeName(date)}.md`);
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
  /** 同じ日を外から書いた日記。まとめでもアイボの日記のすぐ下に出す */
  readonly diaryComments: readonly GuestHead[];
  /** 出来事が書けている月の数。年表の見出しに出す */
  readonly eventMonths: number;
  /** いちばん新しい株の1日。持っていなければ null */
  readonly stock: Doc | null;
  readonly stockHead: StockHead | null;
  readonly stockDays: number;
  /** その日に付いた見立て。まとめでも値のすぐ下に出す */
  readonly stockOutlook: Doc | null;
  /** ひとつ前の確定日の評価額。まとめで向きを出すため */
  readonly stockBefore: number;
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
    diaryComments: guestOn(diaryList().at(-1)?.date ?? ""),
    eventMonths: eventList().length,
    // 株もいちばん新しい1日だけ。持っていなければ全部 null / 0 になる
    stock: (() => {
      const tail = stockList().at(-1);
      return tail ? stock(tail.date) : null;
    })(),
    stockHead: stockList().at(-1) ?? null,
    stockDays: stockList().length,
    stockOutlook: outlookOn(stockList().at(-1)?.date ?? ""),
    // 前の日と比べたいだけなので、1つ前の確定日から借りる（自分で計算しない）
    stockBefore: stockList().at(-2)?.value ?? 0,
  };
}

// ---------------------------------------------------------------- 原文

/** ファイル名に使われる部分。`/` と `..` を弾く（住所を外に出さない）。 */
function safeName(s: string): string {
  return s.replaceAll("/", "_").replaceAll("\\", "_").replaceAll("..", "_");
}

/**
 * 拠点の相対パスを絶対パスに直す。
 *
 * 拠点の外は読まない。`..` で外に出ようとしたものは null で落とす
 * （ローカル専用とはいえ、住所を組み立てるのはブラウザなので）。
 */
function inside(rel: string): string | null {
  if (rel.includes("\0")) return null;
  const abs = normalize(join(KYOTEN, rel));
  if (abs !== KYOTEN && !abs.startsWith(KYOTEN + "/")) return null;
  return abs;
}

/** 拠点の相対パスから原文を読む。 */
export function raw(rel: string): { path: string; text: string } | null {
  const abs = rel ? inside(rel) : null;
  if (!abs || !abs.endsWith(".md") || !existsSync(abs)) return null;
  return { path: relative(KYOTEN, abs), text: readText(abs) };
}

/** 拠点の相対パスから、切ったものを読む。ブラウザが1枚を開くときの口。 */
export function docAt(rel: string): Doc | null {
  const abs = rel ? inside(rel) : null;
  if (!abs || !abs.endsWith(".md") || !existsSync(abs)) return null;
  return readDoc(abs);
}

// ---------------------------------------------------------------- 歩く

/**
 * 部屋の中を1階層ずつ。
 *
 * `会話/` `自分/` `投稿/` のように、まとめる関数を持たない部屋がある。
 * そこは畳まずに、置いてあるとおりに並べて渡す（原則3: 原文ママ）。
 */
export interface Entry {
  readonly kind: "dir" | "doc";
  /** 見出し（無ければファイル名）。ブラウザに出る名前 */
  readonly name: string;
  readonly path: string;
  /** 添える1行。frontmatter にあるものだけを拾う */
  readonly note: string;
  /** 部屋なら、その下にある .md の数 */
  readonly count: number;
}

export interface Tree {
  readonly path: string;
  /** ひとつ上。拠点の根なら null */
  readonly up: string | null;
  readonly dirs: readonly Entry[];
  readonly docs: readonly Entry[];
}

/** frontmatter の数。部屋ごとに名前が違うので、ありものを拾う */
const NOTE_NUM: readonly (readonly [string, string])[] = [
  ["utterances", "発言"],
  ["speech", "発言"],
  ["replies", "応答"],
  ["tools", "道具"],
  ["told", "言われたこと"],
  ["sessions", "会話"],
  ["commits", "コミット"],
  ["troubles", "つまずき"],
  ["銘柄", "銘柄"],
  ["評価額", "評価額"],
];

function noteOf(doc: Doc): string {
  const f = doc.fields;
  const when = f.date || (f.started ?? "").slice(0, 10) || f.week || f.year || "";
  const bits: string[] = [];
  if (when) bits.push(when);
  const where = f.project || f.source || f.by || "";
  if (where) bits.push(where);
  for (const [key, label] of NOTE_NUM) {
    const v = num(f[key]);
    if (v) bits.push(`${label} ${v}`);
  }
  return bits.join("　");
}

export function tree(rel: string): Tree | null {
  const abs = inside(rel || ".");
  if (!abs || !existsSync(abs) || !statSync(abs).isDirectory()) return null;
  const here = relative(KYOTEN, abs);
  const paths = listFiles(abs, ".md");

  return cached(`tree:${here}`, [abs, ...paths], () => {
    const dirs: Entry[] = [];
    const docs: Entry[] = [];
    for (const name of readdirSync(abs).sort()) {
      if (name.startsWith(".")) continue;
      const child = join(abs, name);
      const path = relative(KYOTEN, child);
      if (statSync(child).isDirectory()) {
        dirs.push({
          kind: "dir",
          name,
          path,
          note: "",
          count: listFiles(child, ".md").length,
        });
        continue;
      }
      if (!name.endsWith(".md")) continue;
      const doc = readDoc(child);
      docs.push({
        kind: "doc",
        name: doc.fields.title || doc.title || name.replace(/\.md$/, ""),
        path,
        note: noteOf(doc),
        count: 0,
      });
    }
    return { path: here, up: here ? dirname(here).replace(/^\.$/, "") : null, dirs, docs };
  });
}
