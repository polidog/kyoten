#!/usr/bin/env node
/**
 * picks — アイボが見繕うおすすめ
 *
 * `ニュース/` に並んだその日の話題から、**拠点を根拠に**数本だけ選ぶ部屋。
 *
 * ## `ニュース/` との違い
 *
 * `news.ts` が集めるのは「その日、外で何が話されていたか」で、選ばずに
 * 全部置く。ここが置くのは「そのうち polidog に近いのはどれか」と、
 * **なぜ近いのか**。`株/` と `見立て/` の関係と同じ —— 数を並べる部屋と、
 * それを見て言う部屋を、同じ紙に混ぜない。
 *
 * だから **ここは外へ取りに行かない**。2階（拠点の中しか見ない）を
 * 割らずに済むし、同じ話題について違う一覧を持つ部屋も生まれない
 * （落とし穴21 と同じ形）。
 *
 * ## この部屋も原則1・2 が成り立たない
 *
 * 書き手が LLM なので `日記/` `見立て/` と同じ:
 *
 *   **追記のみ・一度書いたら直さない。**
 *
 * 書き直したいときは、そのファイルを手で消す。
 *
 * ## 立ち位置
 *
 * 声は `skills/aibo/stance.md`、おすすめのときの構えは `stance/osusume.md`。
 * 大事なのは **アイボは記事を読んでいない**こと —— `ニュース/` にあるのは
 * 題と URL だけで、本文はどこにも無い。「見た」「読んだ」のさらに外にいる。
 *
 * 使い方:
 *     picks.ts                # いちばん新しい `ニュース/` について見繕う
 *     picks.ts --dry-run      # 渡すものを見るだけ（書かせない）
 *     picks.ts --try          # 拠点に書かずに1枚だけ書かせる（声を見る）
 *     picks.ts --try 2026-09-04
 *     picks.ts --quiet        # 1行だけ（定時便用）
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseArgs } from "./cli.ts";
import {
  KYOTEN,
  clip,
  frontmatter,
  n,
  readText,
  splitFrontmatter,
  take,
  writeIfChanged,
} from "./util.ts";

const ROOM = join(KYOTEN, "おすすめ");
const NEWS = join(KYOTEN, "ニュース");
const READ = join(KYOTEN, "読んだ");
const ENTITIES = join(KYOTEN, "事典", "プロジェクト");
const WEEKLY = join(KYOTEN, "週報");

const CLAUDE = process.env.KYOTEN_CLAUDE ?? "claude";
const MODEL = process.env.KYOTEN_MODEL ?? "claude-opus-5";
const TIMEOUT = 180_000;

/** 素材に渡す上限（話題は大きくなるので頭打ちにする）。 */
const MATERIAL_LIMIT = 24_000;
/** 何日ぶん遡って「もう勧めた」を見るか。 */
const RECENT_DAYS = 14;
/** 「最近読んだもの」を何日ぶん渡すか。 */
const READ_DAYS = 30;

// ---------------------------------------------------------------- 拠点を読む

/** `<部屋>/<YYYY-MM>/<YYYY-MM-DD>.md` の形をしている日を古い順に。 */
function datesIn(room: string): string[] {
  const out: string[] = [];
  let months: string[];
  try {
    months = readdirSync(room);
  } catch {
    return out;
  }
  for (const month of months.sort()) {
    let files: string[];
    try {
      files = readdirSync(join(room, month));
    } catch {
      continue;
    }
    for (const f of files.sort()) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
      if (m) out.push(m[1]);
    }
  }
  return [...new Set(out)].sort();
}

function dayFile(room: string, date: string): string {
  const path = join(room, date.slice(0, 7), `${date}.md`);
  if (!existsSync(path)) return "";
  const [, body] = splitFrontmatter(readText(path));
  return body.trim();
}

function shift(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** 直近で読んだもの。題ごとそのまま渡す（何に関心があるかは題に出る）。 */
function recentlyRead(date: string): string {
  const from = shift(date, -READ_DAYS);
  // `読んだ/` はソースごとに `chrome-<日付>.md` `posts-<日付>.md` で分かれている
  const parts: string[] = [];
  for (const month of (() => {
    try { return readdirSync(READ).sort(); } catch { return []; }
  })()) {
    let files: string[];
    try { files = readdirSync(join(READ, month)).sort(); } catch { continue; }
    for (const f of files) {
      const m = f.match(/^(chrome|posts)-(\d{4}-\d{2}-\d{2})\.md$/);
      if (!m || m[2] < from || m[2] > date) continue;
      const [, body] = splitFrontmatter(readText(join(READ, month, f)));
      const lines = body.split("\n").filter((l) => l.startsWith("- ") || l.startsWith("## "));
      if (lines.length) parts.push(`（${m[2]} ${m[1]}）\n${lines.join("\n")}`);
    }
  }
  return parts.join("\n\n");
}

/** いま何を作っているか。事典の、最近さわったものだけ。 */
function making(limit = 12): string {
  let files: string[];
  try {
    files = readdirSync(ENTITIES).filter((f) => f.endsWith(".md"));
  } catch {
    return "";
  }
  const rows: { date: string; line: string }[] = [];
  for (const f of files) {
    const text = readText(join(ENTITIES, f));
    const [head] = splitFrontmatter(text.slice(0, 1200));
    const last = head.last ?? head.updated ?? head.date ?? "";
    const name = head.name ?? f.replace(/\.md$/, "");
    const lead = text.split("\n")
      .find((l) => l.trim() && !l.startsWith("#") && !l.startsWith("-") && !l.startsWith("|")) ?? "";
    rows.push({
      date: last,
      line: `- ${name}（最後にさわった ${last || "?"}）` +
        (lead ? ` — ${take(lead.trim(), 100)}` : ""),
    });
  }
  return rows.sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit)
    .map((r) => r.line).join("\n");
}

/** いちばん新しい週報。止まっているものが書いてある。 */
function thisWeek(): string {
  let files: string[];
  try {
    files = readdirSync(WEEKLY).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return "";
  }
  const last = files.at(-1);
  if (!last) return "";
  const [, body] = splitFrontmatter(readText(join(WEEKLY, last)));
  return `（${last.replace(/\.md$/, "")}）\n${clip(body.trim(), 3000)}`;
}

/** 前に勧めたもの。同じものを二度出さないため。 */
function alreadyPicked(date: string): string {
  const from = shift(date, -RECENT_DAYS);
  const parts: string[] = [];
  for (const day of datesIn(ROOM)) {
    if (day < from || day >= date) continue;
    parts.push(`（${day}）\n${dayFile(ROOM, day)}`);
  }
  return parts.join("\n\n");
}

// ---------------------------------------------------------------- 渡す

const WRITING = `
## 書きかた

きょうの話題から **3〜6本**選んで、1本ずつ次の形で書く。

- 題は渡されたものをそのまま（訳すなら「原題 → 訳」）
- リンクは渡された URL をそのまま。作らない・変えない
- そのあとに、**なぜ polidog に勧めるのか**を1〜2文

形:

    - [題](URL)
      なぜ勧めるか。拠点の何と繋がるか。

選び終えたら、最後に1〜2文だけ地の文を置いてよい（無理には置かない）。
見出しは付けない。前置きも締めの挨拶も要らない。

**渡されたものが全部。** 拠点を自分で読みにいく道具は持っていない。
下に無いものは「無い」のであって、読めなかったのではない。
`.trim();

/** 立ち位置から「喋りかた」の節だけ抜く（落とし穴53: 声は後ろにもう一度）。 */
function voiceOf(stance: string): string {
  const at = stance.indexOf("## 喋りかた");
  return at < 0 ? "" : stance.slice(at).trim();
}

function buildPrompt(date: string, stance: string, osusume: string): string {
  const parts: string[] = [stance, osusume, WRITING, `## きょうは ${date}`];
  const add = (head: string, body: string, whenEmpty = "") => {
    const text = body.trim() || whenEmpty;
    if (text) parts.push(`### ${head}\n\n${clip(text, MATERIAL_LIMIT)}`);
  };

  add("きょうの話題（題と URL だけ。本文はどこにも無い）", dayFile(NEWS, date));
  add("polidog が最近読んだもの", recentlyRead(date),
    "（`読んだ/` にまだ何も入っていない）");
  add("いま作っているもの", making());
  add("今週のようす", thisWeek());
  add(`この${RECENT_DAYS}日で、もう勧めたもの`, alreadyPicked(date),
    "（まだ1枚も書いていない。きょうが最初）");

  const voice = voiceOf(stance);
  if (voice) parts.push(`## もう一度 —— この声で書く\n\n${voice}`);

  return parts.join("\n\n");
}

// ---------------------------------------------------------------- 書かせる

class Unwritten extends Error {}

function ask(prompt: string): string {
  const done = spawnSync(CLAUDE, [
    "-p",
    "--no-session-persistence",
    "--settings", '{"hooks":{}}',
    "--model", MODEL,
    // 道具を持たせない。持たせると拠点を直に読みにいって、許可が下りない
    // まま「読み取りの許可が下りてなかった」と前置きを書く（実測 2026-09-05）。
    // 渡した素材が全部、を機構のほうで保証する。
    "--disallowed-tools",
    "Read,Write,Edit,Bash,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit,TodoWrite",
  ], {
    input: prompt,
    encoding: "utf8",
    timeout: TIMEOUT,
    maxBuffer: 32 * 1024 * 1024,
    // CLAUDE.md を拾わせない。渡すものは素材だけにする
    cwd: tmpdir(),
    // mise の shim は起動のたびに stdout へ1行出す（落とし穴47）
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

function render(date: string, body: string): string {
  const head = frontmatter({ room: "おすすめ", date, by: MODEL });
  return `${head}\n\n# ${date} のおすすめ\n\n${body}\n`;
}

// ---------------------------------------------------------------- 入口

function main(): number {
  const args = parseArgs(process.argv.slice(2), ["dry-run", "quiet"], ["try"]);

  const stance = (() => {
    try {
      return readText(join(import.meta.dirname, "..", "skills", "aibo", "stance.md"));
    } catch {
      return "";
    }
  })();
  const osusume = (() => {
    try {
      return readText(join(import.meta.dirname, "..", "stance", "osusume.md"));
    } catch {
      return "";
    }
  })();
  // 立ち位置が無ければ何も書かない。人格の出どころを黙って失うより、
  // 1枚も書かないほうがいい（`diary.ts` と同じ）。
  if (!stance || !osusume) {
    console.error("立ち位置が読めません（skills/aibo/stance.md, stance/osusume.md）");
    return 1;
  }

  const news = datesIn(NEWS);
  if (!news.length) {
    const line = "picks: ニュース/ が空（先に news.ts を流す）";
    if (args.flags.quiet) console.log(line);
    else console.log(`  ${line}`);
    return 0;
  }

  // 選ぶのはいちばん新しい話題についてだけ。過去の日を埋め戻さない
  // （きのうのニュースを今さら勧めても仕方がない。落とし穴61 と同じ形）
  const date = args.values.try ?? news.at(-1)!;
  const path = join(ROOM, date.slice(0, 7), `${date}.md`);

  if (!args.values.try && existsSync(path)) {
    const line = `picks: new 0 / ある 1（${date} は書いてある）`;
    if (args.flags.quiet) console.log(line);
    else console.log(`  ${date} は書いてある。触らない（書き直すなら手で消す）`);
    return 0;
  }

  if (!dayFile(NEWS, date)) {
    console.error(`ニュース/${date} が空です`);
    return 1;
  }

  const prompt = buildPrompt(date, stance, osusume);

  if (args.flags["dry-run"]) {
    console.log(prompt);
    console.error(`${date} ／ ${n(prompt.length)} 字`);
    return 0;
  }

  let body: string;
  try {
    body = ask(prompt);
  } catch (err) {
    console.error(`  ✗ ${date}: ${(err as Error).message}`);
    return 1;
  }

  if (args.values.try !== undefined) {
    console.log(body);
    return 0;
  }

  mkdirSync(join(ROOM, date.slice(0, 7)), { recursive: true });
  writeIfChanged(path, render(date, body));

  if (args.flags.quiet) console.log(`picks: new 1（${date}）`);
  else {
    console.log(`  おすすめ : ${date}`);
    console.log(`  ばしょ   : ${path}`);
  }
  return 0;
}

// import しただけで走らせない（落とし穴21）
if (import.meta.main) process.exit(main());
