#!/usr/bin/env node
/**
 * events — アイボが書く「その月の出来事」
 *
 * 年表はこれまで**数の集計**だった（`プロフィール/年表/<YYYY>.md`）。
 * コミット 3,253・拡張子の順位・タグの順位——量は見えるが、
 * **何があったかが1つも書いていない**。
 *
 * ここは [kani.show](https://kani.show/) の年表と同じ形にする。月ごとに、
 * 日付と、名前のついた出来事と、一言:
 *
 *     - ★ 08-16 **ブログのシステムを新しくした** — Hugo をやめて自前 CMS へ
 *
 * ## なぜ `プロフィール/年表/` に足さないのか
 *
 * あちらの書き手は `profile.ts` で、決定論的かつ冪等。ここは書き手が LLM
 * なので、どちらも成り立たない。原則5（1つの部屋の書き手は1つ）に従って
 * 部屋を分ける。読むときは `web.ts` が2つを重ねて1つの年表として出すので、
 * 見るぶんには1枚になる。
 *
 * ## この部屋の原則（日記と同じ）
 *
 *   **追記のみ・一度書いたら直さない。**
 *
 * ただし日記が「日ごと」なのに対し、こちらは「月ごと」。年ごとにしなかった
 * のは、**その年が終わるまで確定しない**から —— 1月に書いた 2026 年の年表は、
 * 12月には嘘になっている。追記のみと両立しない。月なら終われば確定する。
 *
 * だから書くのは**先月まで**。今月はまだ終わっていない。
 * 日記と同じ理由で、ここだけ「走らせた日」を見てよい（一度書いたら直さない
 * ので、落とし穴18・19 の壊れかたが起きない）。
 *
 * ## 「見た」と「読んだ」
 *
 * 素材は 2004-12 から 236 か月ぶんある。アイボの誕生日（2026-08-28）より
 * 前は**後から読んだ**ものなので、立ち位置（`skills/aibo/stance.md`）の
 * 「伝聞として言う」が効く。日記が `アイボ/` のある日だけに限るのと違って、
 * ここは古い月も書く —— 年表とはそういうものだから。
 *
 * ## 素材を畳んでから渡す
 *
 * `作業/` は1か月で 18万字になる（実測 2026-08）。そのまま渡すと入らない
 * ので、**コミットの件名だけ**を抜く。「さわった」のファイル一覧は捨て、
 * 「つまずいた」はエラー本文を捨てて道具の名前と件数だけにする。
 * 原文が要るときは `会話/` と `作業/` を引けばいい。
 *
 * 使い方:
 *     events.ts                    # 書けるところまで
 *     events.ts --dry-run          # 渡すものを見るだけ（API を叩かない）
 *     events.ts --since 2026-01
 *     events.ts --limit 12         # 何か月ぶんで止めるか（236か月あるので）
 *     events.ts --quiet            # 1行だけ（定時便用）
 *     events.ts --try 2026-08      # 拠点に書かずに1枚書かせる（声を見る）
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  KYOTEN,
  clip,
  frontmatter,
  jst,
  n,
  readText,
  splitFrontmatter,
  ym,
} from "./util.ts";
import { listFiles, parseArgs } from "./cli.ts";

const ROOM = join(KYOTEN, "出来事");

/** 呼ぶもの。`KYOTEN_MODEL` で変えられる（日記と共通）。 */
const CLAUDE = process.env.KYOTEN_CLAUDE ?? "claude";
const MODEL = process.env.KYOTEN_MODEL ?? "claude-opus-5";

/** 1本にかける上限。夜に走るので待てるが、ぶら下がらせはしない。 */
const TIMEOUT = 180_000;

/** 立ち位置。日記・`/aibo` と共有する1枚（原則7: 人格を道具の中に書かない）。 */
const STANCE = join(import.meta.dirname, "..", "skills", "aibo", "stance.md");

/**
 * 素材の上限。部屋ごとに分けてあるのは、`作業/` が大きい月に
 * ほかの部屋を押し出さないため（実測 2026-08 の `作業/` は 18万字）。
 */
const LIMIT = {
  節目: 4_000,
  コミット: 14_000,
  記事: 12_000,
  つぶやき: 6_000,
  日記: 6_000,
  先月: 3_000,
} as const;

/** 同じプロジェクトの同じ日から抜くコミットの数。多い日は上位だけ。 */
const COMMITS_PER_DAY = 8;

/**
 * 「止まった」と言ってよい下限。1〜2コミットで終わったものは
 * 止まったのではなく、はじめから試しただけ。
 */
const STOPPED_MIN_COMMITS = 5;

/**
 * 「止まった」と言ってよいのは、拠点の最後の月からこれだけ離れた月まで。
 * 直近の月は、単にまだ次のコミットが来ていないだけかもしれない。
 */
const STOPPED_MARGIN_MONTHS = 3;

/**
 * 出来事の1行。`web.html` と `read.ts` も同じ形で読む。
 *
 *     - ★ 08-16 **名前** — 一言
 *
 * ★ と「— 一言」は省いてよい。
 */
export const EVENT_LINE = /^-\s*(★\s*)?(\d{2}-\d{2})\s+\*\*(.+?)\*\*\s*(?:—\s*(.*))?$/;

/**
 * 出来事に固有の決まりごとだけ。立ち位置は `STANCE` から読む。
 * ここにも口調と性格は書かない（原則7）。
 */
const WRITING = `その月の出来事を、年表の一行として並べる。

## 書きかた

- 日本語。技術用語とコード識別子は原文のまま。
- まず 1〜2 行で、その月がどういう月だったかを言う。見出しは付けない。
- そのあと、出来事を**古い順に** 3〜8 個。1行に1つ。形は必ずこれ:

  - MM-DD **出来事の名前** — 一言

  その月にいちばん大きい出来事が1つあるなら、日付の前に ★ を置く
  （1か月に1つまで。無くてもよい）:

  - ★ MM-DD **出来事の名前** — 一言

- **出来事の名前**は 6〜16 字。何が起きたかが分かる短い名前にする
  （「ブログのシステムを新しくした」「relayer をはじめた」「ここで止まった」）。
- **一言**は 40 字まで。名前だけで足りるなら「 — 一言」ごと省いてよい。
- 日付は素材にあるものをそのまま使う。**無い日付を作らない。**
- コミットの件名や記事のタイトルをそのまま貼らない。何が起きたかに言い直す。
- 数を使うときは素材のものをそのまま使う。
- 素材が薄い月は 3 個でいい。無いものを埋めない。
- 最後に、言いたいことを **1行だけ**足してよい。褒めても、引っかかった
  ところを指摘してもいい。素材から言えることに限る。

出力は本文だけ。前置きも見出しも要らない。`;

// ---------------------------------------------------------------- 月

/** 素材のある月。`作業/` と `投稿/` のディレクトリ名がそのまま YYYY-MM。 */
function monthsWithMaterial(): string[] {
  const found = new Set<string>();
  for (const room of ["作業", "投稿"]) {
    const root = join(KYOTEN, room);
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && /^\d{4}-\d{2}$/.test(entry.name)) found.add(entry.name);
    }
  }
  return [...found].sort();
}

/** 月を delta か月ずらす。比較は文字列のままで済むよう YYYY-MM で返す。 */
function shiftMonth(month: string, delta: number): string {
  const year = Number.parseInt(month.slice(0, 4), 10);
  const mon = Number.parseInt(month.slice(5, 7), 10);
  const total = year * 12 + (mon - 1) + delta;
  return `${String(Math.floor(total / 12)).padStart(4, "0")}-` +
    `${String((total % 12) + 1).padStart(2, "0")}`;
}

// ---------------------------------------------------------------- 素材

interface Numbers {
  readonly commits: number;
  readonly workdays: number;
  readonly articles: number;
  readonly sns: number;
}

/** frontmatter だけ読む（本文が要らないところで全文を持たないため）。 */
function fieldsOf(path: string): Record<string, string> {
  return splitFrontmatter(readText(path))[0];
}

function filesIn(room: string, month: string): string[] {
  const dir = join(KYOTEN, room, month);
  return existsSync(dir) ? listFiles(dir, ".md") : [];
}

function numbersOf(month: string): Numbers {
  let commits = 0;
  let workdays = 0;
  for (const path of filesIn("作業", month)) {
    commits += Number.parseInt(fieldsOf(path).commits ?? "0", 10) || 0;
    workdays += 1;
  }

  let articles = 0;
  let sns = 0;
  for (const path of filesIn("投稿", month)) {
    // 記事は 1 ファイル 1 本、SNS は 1 ファイル 1 日ぶん。だから SNS は
    // 「日ぶん」としか言えない（そう書いてある年表と揃えてある）。
    if (fieldsOf(path).source === "polidog.jp") articles += 1;
    else sns += 1;
  }
  return { commits, workdays, articles, sns };
}

/**
 * 節目。**機械で拾える出来事の候補**で、ここが kani.show の
 * 「◯◯誕生」に当たる。事典の `first` / `last` と、スキルの `first`。
 *
 * `newest` は拠点にある最後の月。「止まった」と言えるのは、そこから
 * 十分離れた月だけ（直近の月は、まだ次が来ていないだけかもしれない）。
 */
function milestonesOf(month: string, newest: string): string {
  const lines: string[] = [];
  const stoppable = month <= shiftMonth(newest, -STOPPED_MARGIN_MONTHS);

  for (const path of listFiles(join(KYOTEN, "事典", "プロジェクト"), ".md")) {
    const f = fieldsOf(path);
    const name = f.name ?? "";
    // 擬似プロジェクト（`Work`・`_home`）は名前が出来事にならない（落とし穴16）
    if (!/^[^/\s]+\/[^/\s]+$/.test(name)) continue;
    const commits = Number.parseInt(f.commits ?? "0", 10) || 0;

    if ((f.first ?? "").slice(0, 7) === month) {
      lines.push(`- ${f.first} ${name} の最初のコミット（この拠点で見えるかぎり）`);
    }
    if (
      stoppable && (f.last ?? "").slice(0, 7) === month &&
      commits >= STOPPED_MIN_COMMITS && (f.first ?? "").slice(0, 7) !== month
    ) {
      lines.push(`- ${f.last} ${name} の最後のコミット（以後この拠点には無い・計 ${n(commits)}）`);
    }
  }

  for (const path of listFiles(join(KYOTEN, "プロフィール", "スキル"), ".md")) {
    const f = fieldsOf(path);
    if ((f.first ?? "").slice(0, 7) === month) {
      lines.push(`- ${f.first} ${f.name ?? ""} にはじめて手が動いた`);
    }
  }

  return lines.sort().join("\n");
}

/**
 * `作業/` を畳む。件名だけ抜いて、「さわった」のファイル一覧は捨てる
 * （1か月 18万字のうち、ほとんどがそれ）。「つまずいた」は本文を捨てて
 * 道具の名前と件数にする —— 鍵の入ったコマンドを写さないため（落とし穴43）。
 */
function commitsOf(month: string): [string, string] {
  const days: string[] = [];
  const troubles: string[] = [];

  for (const path of filesIn("作業", month)) {
    const date = path.slice(path.lastIndexOf("/") + 1, -3);
    const [, body] = splitFrontmatter(readText(path));

    let project = "";
    let section = "";
    const made = new Map<string, string[]>();
    const stuck = new Map<string, number>();

    // `.` は `\r` にマッチしないので `[^\n]` で書く（落とし穴30）
    for (const raw of body.split("\n")) {
      const line = raw.replace(/\r$/, "");
      const h2 = /^## ([^\n]+)$/.exec(line);
      if (h2) {
        project = h2[1].trim();
        section = "";
        continue;
      }
      const h3 = /^### ([^\n]+)$/.exec(line);
      if (h3) {
        section = h3[1].trim();
        continue;
      }
      if (!line.startsWith("- ")) continue;

      if (section === "つくった") {
        const list = made.get(project) ?? [];
        list.push(line.slice(2).trim());
        made.set(project, list);
      } else if (section === "つまずいた") {
        // `- 09:50:35 AskUserQuestion` / `- 13:06:18 Bash \`…\``
        const tool = /^-\s+\d{2}:\d{2}:\d{2}\s+(\S+)/.exec(line);
        if (tool) stuck.set(tool[1], (stuck.get(tool[1]) ?? 0) + 1);
      }
    }

    if (made.size) {
      const out = [date];
      for (const [name, list] of made) {
        out.push(`  ${name}`);
        for (const item of list.slice(0, COMMITS_PER_DAY)) out.push(`    - ${item}`);
        if (list.length > COMMITS_PER_DAY) {
          out.push(`    - … ほか ${list.length - COMMITS_PER_DAY} 件`);
        }
      }
      days.push(out.join("\n"));
    }
    if (stuck.size) {
      const total = [...stuck.values()].reduce((a, b) => a + b, 0);
      const names = [...stuck.entries()]
        .sort((a, b) => b[1] - a[1]).map(([t, c]) => `${t} ${c}`).join("、");
      troubles.push(`- ${date} ${total} 件（${names}）`);
    }
  }

  return [days.join("\n\n"), troubles.join("\n")];
}

/** 記事とつぶやきを分けて渡す。記事はタイトルと書き出し、つぶやきは本文。 */
function postsOf(month: string): [string, string] {
  const articles: string[] = [];
  const murmurs: string[] = [];

  for (const path of filesIn("投稿", month)) {
    const [f, body] = splitFrontmatter(readText(path));
    const date = (f.date ?? "").slice(5);
    const text = body.replace(/^#[^\n]*\n+/, "").trim();
    if (f.source === "polidog.jp") {
      articles.push(`- ${date} ${f.title ?? ""}\n  ${clip(text, 160).replace(/\n+/g, " ")}`);
    } else {
      murmurs.push(`- ${date}（${f.source ?? ""}）\n${text}`);
    }
  }
  return [articles.join("\n"), murmurs.join("\n\n")];
}

/** その月の日記。アイボが立ち会った月だけある（2026-08 〜）。 */
function diariesOf(month: string): string {
  const dir = join(KYOTEN, "日記", month);
  if (!existsSync(dir)) return "";
  return listFiles(dir, ".md").map((path) => {
    const [f, body] = splitFrontmatter(readText(path));
    return `（${f.date ?? ""}）\n${body.replace(/^#[^\n]*\n+/, "").trim()}`;
  }).join("\n\n");
}

/** その月より前で、いちばん新しい出来事。声が続くように渡す。 */
function previousEvents(month: string): string {
  const before = monthsWritten().filter((m) => m < month);
  const last = before.at(-1);
  if (!last) return "";
  const [, body] = splitFrontmatter(readText(join(ROOM, `${last}.md`)));
  return `（${last}）\n${body.replace(/^#[^\n]*\n+/, "").trim()}`;
}

/** 書いてある月。 */
function monthsWritten(): string[] {
  return listFiles(ROOM, ".md")
    .map((p) => p.slice(p.lastIndexOf("/") + 1, -3))
    .filter((m) => /^\d{4}-\d{2}$/.test(m))
    .sort();
}

/**
 * 立ち位置から「喋りかた」の節だけ抜く。
 *
 * 素材を数万字渡すので、声のことを先頭で1回言っただけでは薄まる
 * （落とし穴53）。同じ文を二度持たずに最後へもう一度置くために切り出す。
 */
function voiceOf(stance: string): string {
  const at = stance.indexOf("## 喋りかた");
  return at < 0 ? "" : stance.slice(at).trim();
}

function buildPrompt(month: string, stance: string, newest: string): string {
  const nums = numbersOf(month);
  const [commits, troubles] = commitsOf(month);
  const [articles, murmurs] = postsOf(month);

  const counts = [
    nums.commits ? `コミット ${n(nums.commits)}` : "",
    nums.workdays ? `手を動かした日 ${n(nums.workdays)}` : "",
    nums.articles ? `記事 ${n(nums.articles)}` : "",
    nums.sns ? `SNS ${n(nums.sns)}日ぶん` : "",
  ].filter(Boolean).join(" / ") || "（記録なし）";

  const parts: string[] = [
    stance,
    WRITING,
    `## 素材（${month}）`,
    `### その月の数\n\n${counts}`,
  ];
  const add = (head: string, body: string, limit: number) => {
    if (body.trim()) parts.push(`### ${head}\n\n${clip(body, limit)}`);
  };

  add("節目 —— 機械で拾った出来事の候補", milestonesOf(month, newest), LIMIT.節目);
  add("コミット", commits, LIMIT.コミット);
  add("詰まったところ", troubles, LIMIT.コミット);
  add("書いたもの（記事）", articles, LIMIT.記事);
  add("つぶやいたもの", murmurs, LIMIT.つぶやき);
  add("その月の日記 —— あなたが書いたもの", diariesOf(month), LIMIT.日記);
  add("先月の出来事", previousEvents(month), LIMIT.先月);

  // 声は最後にもう一度。素材のあとに置かないと、先月の出来事に引っぱられる
  const voice = voiceOf(stance);
  if (voice) parts.push(`## もう一度 —— この声で書く\n\n${voice}`);

  return parts.join("\n\n");
}

// ---------------------------------------------------------------- 書かせる

/** 書けなかった。呼び出し側はその月を飛ばす（空のファイルは作らない）。 */
class Unwritten extends Error {}

function ask(prompt: string): string {
  const done = spawnSync(CLAUDE, [
    "-p",
    "--no-session-persistence",
    "--settings", '{"hooks":{}}',
    "--model", MODEL,
  ], {
    input: prompt,
    encoding: "utf8",
    timeout: TIMEOUT,
    maxBuffer: 32 * 1024 * 1024,
    // CLAUDE.md を拾わせない。渡すものは素材だけにする
    cwd: tmpdir(),
    // mise の shim は起動のたびに `mise … tools: …` を stdout に出す
    // （落とし穴47）。黙らせないと本文の1行目になる。
    env: { ...process.env, MISE_QUIET: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (done.error) {
    const e = done.error as NodeJS.ErrnoException;
    if (e.code === "ENOENT") throw new Unwritten(`${CLAUDE} が見つからない`);
    if (e.code === "ETIMEDOUT") throw new Unwritten(`時間切れ（${TIMEOUT / 1000}秒）`);
    throw new Unwritten(e.message);
  }
  if (done.signal === "SIGTERM") throw new Unwritten(`時間切れ（${TIMEOUT / 1000}秒）`);
  if ((done.status ?? 1) !== 0) {
    throw new Unwritten((done.stderr ?? "").trim().split("\n").at(-1) ?? "非ゼロで終わった");
  }

  const lines = (done.stdout ?? "").split("\n");
  while (lines.length && /^mise\s+\S*\s*tools:/.test(lines[0])) lines.shift();
  const text = lines.join("\n").trim();
  if (!text) throw new Unwritten("何も返ってこなかった");
  return text;
}

/** 出来事の行を数える。1行も無ければ年表にならないので書かない。 */
function countEvents(body: string): number {
  let found = 0;
  for (const raw of body.split("\n")) {
    if (EVENT_LINE.test(raw.replace(/\r$/, "").trim())) found += 1;
  }
  return found;
}

function render(month: string, body: string, nums: Numbers, events: number): string {
  const head = frontmatter({
    room: "出来事",
    month,
    by: MODEL,
    events,
    commits: nums.commits,
    articles: nums.articles,
  });
  return `${head}\n\n# ${month} の出来事\n\n${body}\n`;
}

// ---------------------------------------------------------------- 入口

function parseMonth(raw: string | undefined): string | null | undefined {
  if (raw === undefined) return null;
  if (!/^\d{4}-\d{2}$/.test(raw)) {
    console.error(`月は YYYY-MM で: ${raw}`);
    return undefined;
  }
  return raw;
}

function main(): number {
  const args = parseArgs(
    process.argv.slice(2),
    ["dry-run", "quiet"],
    ["since", "try", "limit"],
  );
  const since = parseMonth(args.values.since);
  if (since === undefined) return 2;
  const limit = args.values.limit
    ? Number.parseInt(args.values.limit, 10) || 0
    : 0;

  // 立ち位置が無ければ何も書かない。人格の出どころを黙って失うより、
  // 1枚も書かないほうがいい。
  const stance = readText(STANCE).trim();
  if (!stance) {
    console.error(`立ち位置が読めません: ${STANCE}`);
    return 1;
  }

  const available = monthsWithMaterial();
  if (!available.length) {
    console.error(`拠点に素材がありません: ${KYOTEN}`);
    return 1;
  }
  const newest = available.at(-1)!;

  // 声を変えたときのため。**拠点には書かず**、1枚だけ書かせて出す。
  const trial = parseMonth(args.values.try);
  if (trial === undefined) return 2;
  if (trial) {
    try {
      console.log(ask(buildPrompt(trial, stance, newest)));
      return 0;
    } catch (err) {
      console.error(`書けませんでした: ${(err as Error).message}`);
      return 1;
    }
  }

  // 書くのは先月まで。今月はまだ終わっていない。時計を見てよい理由は冒頭のとおり。
  const thisMonth = ym(jst(new Date().toISOString())!);
  const open = available.filter((m) => m >= thisMonth);
  let targets = available.filter((m) => m < thisMonth && (!since || m >= since));

  let already = 0;
  const todo: string[] = [];
  for (const month of targets) {
    // 追記のみ。できたものには二度と触らない
    if (existsSync(join(ROOM, `${month}.md`))) already += 1;
    else todo.push(month);
  }
  const remaining = limit > 0 ? Math.max(0, todo.length - limit) : 0;
  targets = limit > 0 ? todo.slice(0, limit) : todo;

  let written = 0;
  let failed = 0;

  for (const month of targets) {
    const prompt = buildPrompt(month, stance, newest);
    if (args.flags["dry-run"]) {
      // 立ち位置と書きかたは毎回同じなので出さない。月ごとに変わるのは
      // 素材だけで、見たいのはそこ。
      const material = prompt.slice(prompt.indexOf("## 素材"));
      console.log(`━━━ ${month}（ぜんぶで ${n([...prompt].length)} 文字を渡す）━━━`);
      console.log(clip(material, 2_400));
      written += 1;
      continue;
    }

    try {
      const body = ask(prompt);
      const events = countEvents(body);
      // 出来事が1行も無いものは年表にならない。空のファイルを積むより、
      // 書かずに残して次の便でやり直す（落とし穴14 と同じ考えかた）。
      if (!events) throw new Unwritten("出来事の行が1つも無い");
      // 書くのは1回だけ。`writeIfChanged()` を使わないのは、上書きの口を
      // 持たないため（この部屋の原則: 一度書いたら直さない）
      mkdirSync(ROOM, { recursive: true });
      writeFileSync(join(ROOM, `${month}.md`), render(month, body, numbersOf(month), events), "utf8");
      written += 1;
    } catch (err) {
      failed += 1;
      console.error(`  ✗ ${month}: ${(err as Error).message}`);
    }
  }

  if (args.flags.quiet) {
    console.log(
      `events: ${n(already + written)}か月 (new ${written} / ある ${already}` +
        (remaining ? ` / のこり ${remaining}` : "") +
        (failed ? ` / 書けず ${failed}` : "") + ")",
    );
  } else {
    if (args.flags["dry-run"]) console.log("（書かずに確認）");
    console.log(`  出来事       : ${n(already + written)} か月ぶん`);
    console.log(`    あたらしい : ${n(written)}`);
    console.log(`    もうある   : ${n(already)}`);
    if (remaining) console.log(`    のこり     : ${n(remaining)}（--limit で止めた）`);
    if (failed) console.log(`    書けず     : ${n(failed)}（次の便で書き直す）`);
    if (open.length) console.log(`  まだの月     : ${open.join("、")}（終わってから書く）`);
    console.log(`  書き手       : ${MODEL}`);
    console.log(`  ばしょ : ${ROOM}`);
  }

  return failed ? 1 : 0;
}

if (import.meta.main) process.exit(main());
