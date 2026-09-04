/**
 * yomi — 拠点を読む
 *
 * 城（`shiro.ts`）と つよさ（`tsuyosa.ts`）が共通で使う読み取り層。
 * ここは**読むだけ**で、拠点には一切書かない（掟5: 書き込み口を絞る）。
 *
 * 数える値は frontmatter と表から取り、本文は見出しで切ったまま渡す。
 * 箇条書きの書式に賭けてパースを増やすより、原文をそのまま見せるほうが
 * 掟3（原文ママ）に合う。パースするのは「並べ替えと絵に要る値」だけ。
 */

import { existsSync, statSync } from "node:fs";
import { join, normalize, relative } from "node:path";

import { KYOTEN, readText, splitFrontmatter } from "./dougu.ts";
import { listFiles } from "./cli.ts";

// ---------------------------------------------------------------- 切る

/** 見出しの `.` は `\r` にマッチしない（踏んだ罠23）。`[^\n]` で書く。 */
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
    if (got) {
      cur = { head: got[2].trim(), lines: [] };
      sections.push(cur);
      continue;
    }
    if (cur) cur.lines.push(line);
    else if (!lead && line.trim()) lead = line.trim();
  }

  for (const s of sections) trimEnds(s.lines);
  return { path: relative(KYOTEN, abs), fields, title, lead, sections };
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

/** 拠点の年数の数え方は status.ts と同じ（終わりの年 − 始まりの年 + 1）。 */
export function years(first: string, last: string): number {
  if (!first || !last) return 0;
  return Number(last.slice(0, 4)) - Number(first.slice(0, 4)) + 1;
}

// ---------------------------------------------------------------- ためる

/**
 * 素材が変わっていなければ読み直さない。
 *
 * 拠点はよるのとばりが書き換えるので、立ち上げっぱなしの城が古いものを
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

// ---------------------------------------------------------------- ステータス

export interface Tsuyosa {
  readonly label: string;
  readonly value: string;
}

export interface Nagaku {
  readonly name: string;
  readonly first: string;
  readonly last: string;
  readonly years: number;
}

export interface Ima {
  readonly name: string;
  readonly count: number;
}

export interface Ayumi {
  readonly year: number;
  readonly commits: number;
  readonly articles: number;
  readonly main: readonly string[];
}

export interface StatusView {
  readonly doc: Doc;
  readonly first: string;
  readonly last: string;
  readonly span: number;
  readonly tokugi: number;
  readonly tsuyosa: readonly Tsuyosa[];
  readonly ima: readonly Ima[];
  readonly imaHead: string;
  readonly nagaku: readonly Nagaku[];
  readonly ayumi: readonly Ayumi[];
}

/** `- ぼうけんのしょ　325 さつ` — 見た目を揃える全角スペースで割れている */
const RE_TSUYOSA = /^([^\d]+?)[ 　]+([\d,]+.*)$/;
/** `- typescript 2,812` */
const RE_IMA = /^(.+?)[ 　]+([\d,]+)$/;
/** `- php 2006-11 〜 2026-09（21年）` */
const RE_NAGAKU = /^(.+?)[ 　]+(\S+)[ 　]*〜[ 　]*(\S+)（(\d+)年）$/;

function parseAyumi(sec: Section | null): Ayumi[] {
  if (!sec) return [];
  const out: Ayumi[] = [];
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

export function status(): StatusView | null {
  const abs = room("status", "status.md");
  return cached("status", [abs], () => {
    if (!existsSync(abs)) return null;
    const doc = readDoc(abs);
    const first = doc.fields.first ?? "";
    const last = doc.fields.last ?? "";
    const imaSec = section(doc, "いま手が動いているもの");

    const tsuyosa: Tsuyosa[] = [];
    for (const b of bullets(section(doc, "つよさ"))) {
      const got = RE_TSUYOSA.exec(b);
      tsuyosa.push(got ? { label: got[1].trim(), value: got[2].trim() } : { label: b, value: "" });
    }

    const ima: Ima[] = [];
    for (const b of bullets(imaSec)) {
      const got = RE_IMA.exec(b);
      if (got) ima.push({ name: got[1].trim(), count: num(got[2]) });
    }

    const nagaku: Nagaku[] = [];
    for (const b of bullets(section(doc, "長くいっしょにいるもの"))) {
      const got = RE_NAGAKU.exec(b);
      if (got) {
        nagaku.push({
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
      tokugi: num(doc.fields.tokugi),
      tsuyosa,
      ima,
      imaHead: imaSec?.head ?? "いま手が動いているもの",
      nagaku,
      ayumi: parseAyumi(section(doc, "あゆみ")),
    };
  });
}

// ---------------------------------------------------------------- とくぎ

export interface Tokugi {
  readonly name: string;
  readonly first: string;
  readonly last: string;
  readonly years: number;
  readonly articles: number;
  readonly files: number;
  readonly path: string;
}

export function tokugiList(): readonly Tokugi[] {
  const paths = listFiles(room("status", "tokugi"), ".md");
  return cached("tokugi", paths, () =>
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

export function tokugi(name: string): Doc | null {
  const abs = room("status", "tokugi", `${safeName(name)}.md`);
  return existsSync(abs) ? readDoc(abs) : null;
}

// ---------------------------------------------------------------- 年表

export interface Nenpyo {
  readonly year: number;
  readonly commits: number;
  readonly articles: number;
  readonly lead: string;
  readonly path: string;
}

export function nenpyoList(): readonly Nenpyo[] {
  const paths = listFiles(room("status", "nenpyo"), ".md");
  return cached("nenpyo", paths, () =>
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

export function nenpyo(year: string): Doc | null {
  const abs = room("status", "nenpyo", `${safeName(year)}.md`);
  return existsSync(abs) ? readDoc(abs) : null;
}

// ---------------------------------------------------------------- おつげ

export interface OtsugeHead {
  readonly week: string;
  readonly from: string;
  readonly to: string;
  readonly commits: number;
  readonly path: string;
}

export function otsugeList(): readonly OtsugeHead[] {
  const paths = listFiles(room("otsuge"), ".md");
  return cached("otsuge", paths, () =>
    paths.map((abs) => {
      const doc = readDoc(abs);
      return {
        week: doc.fields.week || doc.title.replace(/ のおつげ$/, ""),
        from: doc.fields.from ?? "",
        to: doc.fields.to ?? "",
        commits: num(doc.fields.commits),
        path: doc.path,
      };
    }).sort((a, b) => a.week.localeCompare(b.week)));
}

export function otsuge(week: string): Doc | null {
  const abs = room("otsuge", `${safeName(week)}.md`);
  return existsSync(abs) ? readDoc(abs) : null;
}

// ---------------------------------------------------------------- まちのうわさ

export interface UwasaHead {
  readonly week: string;
  readonly from: string;
  readonly to: string;
  /** その週の終わりまでの累計。おつげの `commits` は週内の数なので別もの */
  readonly commits: number;
  readonly projects: number;
  readonly path: string;
}

export function uwasaList(): readonly UwasaHead[] {
  const paths = listFiles(room("uwasa"), ".md");
  return cached("uwasa", paths, () =>
    paths.map((abs) => {
      const doc = readDoc(abs);
      return {
        week: doc.fields.week || doc.title.replace(/ のうわさ$/, ""),
        from: doc.fields.from ?? "",
        to: doc.fields.to ?? "",
        commits: num(doc.fields.commits),
        projects: num(doc.fields.projects),
        path: doc.path,
      };
    }).sort((a, b) => a.week.localeCompare(b.week)));
}

export function uwasa(week: string): Doc | null {
  const abs = room("uwasa", `${safeName(week)}.md`);
  return existsSync(abs) ? readDoc(abs) : null;
}

// ---------------------------------------------------------------- ふくろ

export interface FukuroHead {
  readonly name: string;
  readonly first: string;
  readonly last: string;
  readonly sessions: number;
  readonly commits: number;
  readonly path: string;
}

export function fukuroList(): readonly FukuroHead[] {
  const paths = listFiles(room("fukuro", "project"), ".md");
  return cached("fukuro", paths, () =>
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
 * 城に出すぶん。
 *
 * ブラウザで見たいのは**まとめ**で、776週の一覧でも71枚のとくぎでもない
 * （潜るのは端末の仕事）。だから一覧はどれも頭を落として渡す。
 * おつげだけは節をそのまま持たせる —— 向こうから来た問いは要約しない。
 */
export interface Summary {
  readonly first: string;
  readonly last: string;
  readonly span: number;
  readonly lead: string;
  readonly tsuyosa: readonly Tsuyosa[];
  readonly imaHead: string;
  readonly ima: readonly Ima[];
  readonly nagaku: readonly Nagaku[];
  readonly ayumi: readonly Ayumi[];
  readonly tokugi: number;
  readonly tokugiTop: readonly Tokugi[];
  readonly basho: readonly FukuroHead[];
  readonly weeks: number;
  readonly konshu: Doc | null;
  readonly uwasa: Doc | null;
}

export function summary(): Summary | null {
  const s = status();
  if (!s) return null;
  const weeks = otsugeList();
  const last = weeks[weeks.length - 1];
  return {
    first: s.first,
    last: s.last,
    span: s.span,
    lead: s.doc.lead,
    tsuyosa: s.tsuyosa,
    imaHead: s.imaHead,
    ima: s.ima,
    nagaku: s.nagaku,
    ayumi: s.ayumi,
    tokugi: s.tokugi,
    tokugiTop: tokugiList().slice(0, 12),
    basho: fukuroList().slice(0, 8),
    weeks: weeks.length,
    konshu: last ? otsuge(last.week) : null,
    // うわさは週の数がおつげと同じとは限らない（部屋を建てた時点で揃うが、
    // 片方だけ流した夜がありうる）ので、うわさ側の最後の週から引く
    uwasa: (() => {
      const u = uwasaList();
      const tail = u[u.length - 1];
      return tail ? uwasa(tail.week) : null;
    })(),
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
