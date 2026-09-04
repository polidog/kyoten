#!/usr/bin/env node
/**
 * entities — 事典（長期記憶）
 *
 * 拠点に溜まったものを、**プロジェクトごとに1枚**へ畳み直す。
 * 会話・自分・作業・投稿は時間で並んでいるので、
 * 「このプロジェクトで何をしていたのか」を見るには何十日ぶんも辿ることに
 * なる。事典はその横串。
 *
 * 出力は `事典/プロジェクト/<name>.md`。素材はすべて**拠点の中**にある
 * （jsonl や git を直接見にいかない）—— 拠点が正本で、事典はその畳み方だ、
 * という関係を保つため。順番は sessions → me → work → entities。
 *
 * 原則:
 *   - 決定論的: 同じ拠点なら必ず同じ出力。
 *   - 冪等: 内容が変わらなければファイルに触れない。
 *   - 手で書かせない: ここに人が書き足す欄は作らない。増えるのは素材の側。
 *
 * 使い方:
 *     entities.ts                   # 全部
 *     entities.ts --dry-run
 *     entities.ts --quiet
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

const ROOM = join(KYOTEN, "事典", "プロジェクト");

/**
 * よく出てくる語の数と、拾う語の形。日本語を分かち書きせずに済ませるため、
 * 「2文字以上のカタカナ」「2文字以上の漢字」「3文字以上の英数字」を語と
 * みなす。形態素解析を入れれば精度は上がるが、依存を増やさない（原則6）。
 */
const WORDS_SHOWN = 20;
const RE_WORD = /[ァ-ヶー]{2,}|[一-龥]{2,}|[A-Za-z][A-Za-z0-9_.-]{2,}/gu;

/** どのプロジェクトでも上位に来てしまう語。残しても何も区別できない。 */
const STOPWORDS = new Set([
  "こと", "もの", "これ", "それ", "ため", "よう", "場合", "自分", "今回",
  "確認", "実装", "対応", "修正", "追加", "変更", "作成", "削除", "実行",
  "使用", "利用", "設定", "処理", "表示", "取得", "問題", "内容", "部分",
  "以下", "以上", "現在", "状態", "情報", "方法", "感じ", "気持", "説明",
  "the", "and", "for", "with", "that", "this", "you", "not", "are", "但",
  "http", "https", "com", "org", "www", "html", "json", "true", "false",
  "null", "して", "ください", "です", "ます", "した", "する", "ある",
  // GitHub が書く定型のコミット件名（"Merge pull request #12 from …"）。
  // どのリポジトリでも上位に来るので、区別の役に立たない。
  "merge", "pull", "request", "from", "into", "branch", "commit",
]);

/**
 * 投稿の本文でプロジェクトを探すときの手がかり。`polidog/kyoten` の
 * 記事が `kyoten` としか書かれていないことが多いので、名前の末尾も見る。
 * 短すぎる名前（`web` など）は普通の単語に当たるので使わない。
 */
const SHORT_NAME_MIN = 5;

class Project {
  // Node は型注釈を剥がすだけで実行するので、`constructor(readonly name)`
  // のような「実行時の意味を持つ TypeScript 構文」は使えない
  // （parameter property・enum・namespace・decorator が該当）。
  // フィールドは自分で宣言して代入する。
  readonly name: string;
  sessions = 0;
  utterances = 0;
  replies = 0;
  readonly sources = new Map<string, number>();
  readonly models = new Map<string, number>();
  first = "";
  last = "";
  commits = 0;
  troubles = 0;
  readonly mineDays: string[] = [];
  readonly soto: [string, string, string][] = [];

  constructor(name: string) {
    this.name = name;
  }

  /** サブディレクトリで分かれていた自分を取り込む。 */
  absorb(other: Project): void {
    this.sessions += other.sessions;
    this.utterances += other.utterances;
    this.replies += other.replies;
    for (const [k, v] of other.sources) this.sources.set(k, (this.sources.get(k) ?? 0) + v);
    for (const [k, v] of other.models) this.models.set(k, (this.models.get(k) ?? 0) + v);
    this.commits += other.commits;
    this.troubles += other.troubles;
    this.saw(other.first);
    this.saw(other.last);
    for (const date of other.mineDays) {
      if (!this.mineDays.includes(date)) this.mineDays.push(date);
    }
    this.soto.push(...other.soto);
  }

  saw(date: string): void {
    if (!date) return;
    if (!this.first || date < this.first) this.first = date;
    if (!this.last || date > this.last) this.last = date;
  }
}

type Projects = Map<string, Project>;
type Texts = Map<string, string[]>;

function get(projects: Projects, name: string): Project {
  let p = projects.get(name);
  if (!p) {
    p = new Project(name);
    projects.set(name, p);
  }
  return p;
}

function bump(counter: Map<string, number>, key: string, by = 1): void {
  counter.set(key, (counter.get(key) ?? 0) + by);
}

/** Python の Counter.most_common と同じ並び（頻度降順、同数は挿入順）。 */
function mostCommon(counter: Map<string, number>, limit?: number): [string, number][] {
  const rows = [...counter.entries()].sort((a, b) => b[1] - a[1]);
  return limit === undefined ? rows : rows.slice(0, limit);
}

function intOf(value: string | undefined): number {
  const got = Number.parseInt((value ?? "").trim(), 10);
  return Number.isNaN(got) ? 0 : got;
}

// ---------------------------------------------------------------- 素材を読む

/** `会話/`。1ファイル = 1セッション。 */
function scanSessions(projects: Projects): void {
  const root = join(KYOTEN, "会話");
  if (!existsSync(root)) return;

  for (const path of listFiles(root, ".md")) {
    const [fields] = splitFrontmatter(readText(path).slice(0, 2000));
    const name = fields.project;
    if (!name) continue;

    const project = get(projects, name);
    project.sessions += 1;
    project.utterances += intOf(fields.utterances);
    project.replies += intOf(fields.replies);
    if (fields.source) bump(project.sources, fields.source);
    for (const model of (fields.models ?? "").split(",")) {
      const m = model.trim();
      if (m) bump(project.models, m);
    }
    project.saw((fields.started ?? "").slice(0, 10));
    project.saw((fields.ended ?? "").slice(0, 10));
  }
}

/**
 * `作業/`。日ごとのファイルを、プロジェクトの見出しで割って数える。
 *
 * frontmatter の `projects` はその日に触れた顔ぶれしか持たないので、
 * 件数は本文から数える（`## <project>` の下の `- \`sha\` 件名` の数）。
 */
function scanWork(projects: Projects, texts: Texts): void {
  const root = join(KYOTEN, "作業");
  if (!existsSync(root)) return;

  const headProject = /^## ([^\n]+)$/;
  const headSection = /^### ([^\n]+)$/;
  const commitLine = /^- `[0-9a-f]{4,}` /;

  for (const path of listFiles(root, ".md")) {
    const [fields, body] = splitFrontmatter(readText(path));
    const date = fields.date ?? "";
    let name = "";
    let section = "";

    for (const line of body.split("\n")) {
      const gotProject = headProject.exec(line);
      if (gotProject) {
        name = gotProject[1].trim();
        section = "";
        if (name) get(projects, name).saw(date);
        continue;
      }
      const gotSection = headSection.exec(line);
      if (gotSection) {
        section = gotSection[1].trim();
        continue;
      }
      if (!name) continue;

      if (section === "つくった" && commitLine.test(line)) {
        get(projects, name).commits += 1;
        // コミットの件名も本人が書いた言葉。`自分/` と同じ資格で
        // 「よく出てくる語」の素材にする（発言が少ないプロジェクトほど、
        // 何をしていたかはコミットの側に残っている）。
        const at = line.indexOf("` ");
        const subject = at < 0 ? line : line.slice(at + 2);
        const list = texts.get(name);
        if (list) list.push(subject);
        else texts.set(name, [subject]);
      } else if (section === "つまずいた" && line.startsWith("- ")) {
        get(projects, name).troubles += 1;
      }
    }
  }
}

/**
 * `自分/`。プロジェクトごとの日数と、頻出語のための本文を集める。
 *
 * 見出しは `## HH:MM:SS <project>（source · command）`。プロジェクト名に
 * 括弧は入らないので、最初の `（` までを名前として切る。
 */
function scanMine(projects: Projects): Texts {
  const texts: Texts = new Map();
  const root = join(KYOTEN, "自分");
  if (!existsSync(root)) return texts;

  const head = /^## \d\d:\d\d:\d\d +(.+?)（/;

  for (const path of listFiles(root, ".md")) {
    const [fields, body] = splitFrontmatter(readText(path));
    const date = fields.date ?? "";
    let name = "";

    for (const line of body.split("\n")) {
      const got = head.exec(line);
      if (got) {
        name = got[1].trim();
        const project = get(projects, name);
        project.saw(date);
        if (date && !project.mineDays.includes(date)) project.mineDays.push(date);
        continue;
      }
      if (name && line.trim() && !line.startsWith("#")) {
        const list = texts.get(name);
        if (list) list.push(line);
        else texts.set(name, [line]);
      }
    }
  }

  return texts;
}

/**
 * `投稿/`。プロジェクトの名前が出てくる記事・投稿を拾う。
 *
 * 素朴な部分一致。`polidog/kyoten` は記事の中で `kyoten` としか書かれない
 * ので末尾の名前でも探すが、短い名前（`web` `shares`）は普通の単語に
 * 当たるので使わない。
 */
function scanPosts(projects: Projects): void {
  const root = join(KYOTEN, "投稿");
  if (!existsSync(root)) return;

  const needles: [string, string[]][] = [];
  for (const name of projects.keys()) {
    // 探すのは ghq のリポジトリ（`<user>/<repo>`）だけ。`Work` や
    // `_home` は「そのディレクトリで作業した」という擬似プロジェクトで、
    // 名前が普通の単語なので部分一致が総なめになる（実測: `Work` が
    // "work" を含む記事 87 本を、`_home` が 4 本を拾っていた）。
    if (!name.includes("/")) continue;
    const tail = name.slice(name.lastIndexOf("/") + 1);
    const keys = [name];
    if (tail.length >= SHORT_NAME_MIN) keys.push(tail);
    needles.push([name, keys]);
  }

  for (const path of listFiles(root, ".md")) {
    const [fields, body] = splitFrontmatter(readText(path));
    const low = body.toLowerCase();
    const date = fields.date ?? "";
    const source = fields.source ?? "";
    const title = fields.title || path.slice(path.lastIndexOf("/") + 1, -3);

    for (const [name, keys] of needles) {
      if (keys.some((key) => low.includes(key.toLowerCase()))) {
        projects.get(name)!.soto.push([date, source, title]);
      }
    }
  }
}

/**
 * `<repo>/apps/web` のような枝を `<repo>` に畳む。
 *
 * `slugFromCwd()` は cwd をそのまま名前にするので、モノレポの奥で
 * 作業した回は別のプロジェクトに見える。台帳が分かれると「このリポジトリを
 * どれだけ触ったか」が分からなくなるので、親が実在するなら合流させる。
 * 長い名前から順に畳むのは、2 段以上ネストした枝を取りこぼさないため。
 */
function fold(projects: Projects, texts: Texts): void {
  const names = [...projects.keys()].sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (!projects.has(name)) continue;
    const parts = name.split("/");
    for (let i = parts.length - 1; i > 0; i--) {
      const head = parts.slice(0, i).join("/");
      if (projects.has(head) && head !== name) {
        projects.get(head)!.absorb(projects.get(name)!);
        projects.delete(name);
        const moved = texts.get(name);
        if (moved) {
          const into = texts.get(head);
          if (into) into.push(...moved);
          else texts.set(head, moved);
          texts.delete(name);
        }
        break;
      }
    }
  }
}

function frequent(lines: readonly string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const line of lines) {
    for (const match of line.matchAll(RE_WORD)) {
      const word = match[0];
      // eslint-disable-next-line no-control-regex
      const key = /^[\x00-\x7f]*$/.test(word) ? word.toLowerCase() : word;
      if (STOPWORDS.has(key) || [...key].length < 2) continue;
      bump(counts, key);
    }
  }
  // 1 回しか出てこない語はその日の偶然。2 回以上だけ残す。
  return mostCommon(counts, WORDS_SHOWN * 2).filter(([, c]) => c >= 2).slice(0, WORDS_SHOWN);
}

// ---------------------------------------------------------------- 書く

function render(project: Project, words: readonly [string, number][]): string {
  const head = frontmatter({
    room: "事典",
    kind: "プロジェクト",
    name: project.name,
    first: project.first,
    last: project.last,
    sessions: project.sessions,
    commits: project.commits,
  });

  const counts: string[] = [];
  if (project.sessions) counts.push(`会話 ${n(project.sessions)}`);
  if (project.utterances) counts.push(`発言 ${n(project.utterances)}`);
  if (project.commits) counts.push(`コミット ${n(project.commits)}`);
  if (project.troubles) counts.push(`つまずき ${n(project.troubles)}`);

  const body: string[] = [`# ${project.name}`, counts.join(" / ") || "（まだ何もない）"];

  const span: string[] = [];
  if (project.first) span.push(`- はじめて: ${project.first}`);
  if (project.last) span.push(`- さいご  : ${project.last}`);
  if (project.sources.size) {
    span.push("- どこから: " + [...project.sources.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, v]) => `${k} ${v}`).join("、"));
  }
  if (project.models.size) {
    span.push("- だれと  : " + [...project.models.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, v]) => `${k} ${v}`).join("、"));
  }
  if (span.length) body.push("## いつ・どこで\n\n" + span.join("\n"));

  if (project.soto.length) {
    const seen = new Set<string>();
    const lines: string[] = [];
    // Python の sorted(..., reverse=True) はタプルの辞書順。
    const sorted = [...project.soto].sort((a, b) => {
      for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] < b[i] ? 1 : -1;
      }
      return 0;
    });
    for (const [date, source, title] of sorted) {
      const key = `${date}\u0000${title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`- ${date} ${source}: ${title}`);
    }
    body.push("## そとに出したもの\n\n" + lines.slice(0, 30).join("\n"));
  }

  if (project.mineDays.length) {
    const days = [...project.mineDays].sort().reverse();
    const shown = days.slice(0, 10).join("、");
    const more = days.length > 10 ? `（ほか ${days.length - 10} 日）` : "";
    body.push(`## しゃべった日\n\n${shown}${more}`);
  }

  if (words.length) {
    body.push("## よく出てくる語\n\n" + words.map(([w, c]) => `${w}(${c})`).join("、"));
  }

  return head + "\n\n" + body.join("\n\n") + "\n";
}

function main(): number {
  const args = parseArgs(process.argv.slice(2), ["dry-run", "quiet"]);

  const projects: Projects = new Map();
  scanSessions(projects);
  const texts = scanMine(projects);
  scanWork(projects, texts);
  fold(projects, texts);
  scanPosts(projects);

  const stats: Record<WriteState, number> = { new: 0, updated: 0, same: 0 };
  for (const name of [...projects.keys()].sort()) {
    const out = join(ROOM, safePath(name).replaceAll("/", "-") + ".md");
    const words = frequent(texts.get(name) ?? []);
    stats[writeIfChanged(out, render(projects.get(name)!, words), args.flags["dry-run"])] += 1;
  }

  const total = stats.new + stats.updated + stats.same;
  if (args.flags.quiet) {
    console.log(
      `entities: ${total}プロジェクト (new ${stats.new} ` +
        `/ upd ${stats.updated} / same ${stats.same})`,
    );
  } else {
    if (args.flags["dry-run"]) console.log("（書かずに確認）");
    console.log(`  事典         : ${n(total)} プロジェクト`);
    console.log(`    あたらしい : ${n(stats.new)}`);
    console.log(`    かきかえ   : ${n(stats.updated)}`);
    console.log(`    かわらず   : ${n(stats.same)}`);
    console.log(`  ばしょ : ${ROOM}`);
  }

  return 0;
}

process.exit(main());
