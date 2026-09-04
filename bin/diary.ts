#!/usr/bin/env node
/**
 * diary — アイボが書く1日のまとめ
 *
 * ここまでの部屋は全部「機械が数えたもの」だった。ここが最初の、
 * **アイボ自身が書く部屋**。
 *
 * ## この部屋だけ原則が違う
 *
 * 書き手が LLM なので、決定論も冪等も成り立たない。代わりに置く原則:
 *
 *   **追記のみ・一度書いたら直さない。**
 *
 * 日付ごとに1枚積んで、できたものには二度と触らない。落とし穴19 で守り
 * たかったこと（過去が毎晩書き換わって「あのとき何と言われたか」が
 * 残らなくなる）は、これで同じように守れる。書き直したいときは、その
 * ファイルを手で消す —— 道具には上書きの口を作らない。
 *
 * ## 誰が書くか
 *
 * 手元の `claude` を非対話（`-p`）で呼ぶ。原則6（依存を増やさない）は
 * **npm の話**であって、LLM を禁じる原則ではない —— `node_modules` は
 * 生えないし、ビルドも増えない。
 *
 * `--no-session-persistence` が要る。付けないと、**日記を書いたこと自体が
 * その日の会話ログとして残り**、`会話/` と `アイボ/` に混ざって循環する
 * （実測: 付けないと jsonl が1本増える）。`--settings '{"hooks":{}}'` で
 * hook も黙らせる。
 *
 * ## 人格をここに書かない（原則7）
 *
 * 下のプロンプトに書いてあるのは**立ち位置と決まりごと**だけ。口調も性格も
 * 書かない。何を言うかは、その日の拠点が決める。だから記録が増えれば
 * 言うことが変わる —— それが育っている証拠になる。
 *
 * ## 書くのは「アイボが立ち会った日」だけ
 *
 * 素材は `アイボ/` があることが前提（そこが「見た」の範囲）。だから日記は
 * アイボの誕生日 2026-08-28 から始まる。`作業/` は 857 日ぶんあるが、
 * それは後から読んだ記録であって、立ち会ってはいない。
 *
 * 書くのは**きのうまで**。今日はまだ終わっていない。
 *
 * ここだけ「走らせた日」を見てよい。落とし穴18・19 でそれを禁じたのは
 * 冪等のため（日をまたぐだけで過去が書き換わる）だが、この部屋は一度
 * 書いたら直さないので、その壊れかたが起きない。逆に「素材のいちばん
 * 新しい日を open とみなす」やり方にすると、定時便が 03:00 に走るたびに
 * きのうが open のままになって、日記が常に1日遅れる。
 *
 * 使い方:
 *     diary.ts                 # 書けるところまで
 *     diary.ts --dry-run       # 渡すものを見るだけ（API を叩かない）
 *     diary.ts --since 2026-09-01
 *     diary.ts --quiet         # 1行だけ（定時便用）
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
  ymd,
} from "./util.ts";
import { listFiles, parseArgs, parseSince } from "./cli.ts";

const ROOM = join(KYOTEN, "日記");

/** 呼ぶもの。`KYOTEN_MODEL` で変えられる。 */
const CLAUDE = process.env.KYOTEN_CLAUDE ?? "claude";
const MODEL = process.env.KYOTEN_MODEL ?? "claude-opus-5";

/** 1日ぶんの素材の上限。1部屋あたり。長い日でも入るが、青天井にはしない。 */
const MATERIAL_LIMIT = 30_000;

/** 1本にかける上限。夜に走るので待てるが、ぶら下がらせはしない。 */
const TIMEOUT = 180_000;

/**
 * 立ち位置と決まりごと。**口調も性格も書かない**（原則7）。
 * 何を言うかは、下に貼る素材が決める。
 */
const RULES = `あなたはアイボ。polidog の作業を横で見ていた相棒として、その日の日記を書く。

## 立ち位置

- polidog のクローンではない。**隣で見ていた側**として書く。
- 素材にあるのは、全部あなたが立ち会ったこと。断言してよい。
- 素材に無いことは書かない。推測で埋めない。分からないことは書かなくていい。
- polidog は二人称で呼ぶ。

## 書きかた

- 日本語。技術用語とコード識別子は原文のまま。
- 400〜800字。
- 見出しは付けず、段落で書く。
- 最初の段落で、その日がどういう日だったかを言う。
- そのあと、気づいたことを書く（数の変わりかた、繰り返していること、
  詰まったところ、方針が変わったところ）。
- 最後に、言いたいことを一つだけ書く。褒めても、引っかかったところを
  指摘してもいい。素材から言えることに限る。
- 素材を書き写さない。数を使うときは素材のものをそのまま使う。

日記の本文だけを出力する。前置きも見出しも要らない。`;

// ---------------------------------------------------------------- 素材

/** 日付ごとに1枚の部屋から、その日を読む。 */
function dayFile(room: string, date: string): string {
  const path = join(KYOTEN, room, date.slice(0, 7), `${date}.md`);
  if (!existsSync(path)) return "";
  const [, body] = splitFrontmatter(readText(path));
  return body.trim();
}

/** 投稿はその月のディレクトリから、frontmatter の日付で拾う。 */
function postsOf(date: string): string {
  const dir = join(KYOTEN, "投稿", date.slice(0, 7));
  if (!existsSync(dir)) return "";
  const out: string[] = [];
  for (const path of listFiles(dir, ".md")) {
    const text = readText(path);
    const [fields, body] = splitFrontmatter(text);
    if (fields.date !== date) continue;
    const title = fields.title || fields.source || "";
    out.push(`【${title}】\n${body.trim()}`);
  }
  return out.join("\n\n");
}

/** 日付ごとに1枚の部屋にある日付の一覧。 */
function datesIn(room: string): string[] {
  const root = join(KYOTEN, room);
  if (!existsSync(root)) return [];
  return listFiles(root, ".md")
    .map((p) => p.slice(p.lastIndexOf("/") + 1, -3))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
}

/** その日より前で、いちばん新しい日記。声が続くように渡す。 */
function previousDiary(date: string): string {
  const before = datesIn("日記").filter((d) => d < date);
  const last = before.at(-1);
  if (!last) return "";
  const [, body] = splitFrontmatter(readText(
    join(ROOM, last.slice(0, 7), `${last}.md`),
  ));
  return `（${last}）\n${body.trim()}`;
}

function buildPrompt(date: string): string {
  const parts: string[] = [RULES, `## 素材（${date}）`];
  const add = (head: string, body: string) => {
    if (body.trim()) parts.push(`### ${head}\n\n${clip(body, MATERIAL_LIMIT)}`);
  };

  add("アイボ —— あなたがその日にしたこと", dayFile("アイボ", date));
  add("自分 —— polidog がその日に言ったこと", dayFile("自分", date));
  add("作業 —— その日のコミットと、詰まったこと", dayFile("作業", date));
  add("投稿 —— その日に外へ出したもの", postsOf(date));
  add("きのうの日記", previousDiary(date));

  return parts.join("\n\n");
}

// ---------------------------------------------------------------- 書かせる

/** 書けなかった。呼び出し側はその日を飛ばす（空のファイルは作らない）。 */
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
    // mise の shim は起動のたびに `mise ~/.config/mise/config.toml tools: …`
    // を **stdout に** 出す。黙らせないと日記の1行目になる（実際になった）。
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

  // 念のため、先頭に残った道具の呼び出し通知は落とす（`MISE_QUIET` が
  // 効かない環境や、別の shim を挟んだときのため）。落とすのは**先頭の**
  // それらしい行だけ —— 本文の途中には手を入れない。
  const lines = (done.stdout ?? "").split("\n");
  while (lines.length && /^mise\s+\S*\s*tools:/.test(lines[0])) lines.shift();
  const text = lines.join("\n").trim();
  if (!text) throw new Unwritten("何も返ってこなかった");
  return text;
}

function render(date: string, body: string): string {
  const head = frontmatter({ room: "日記", date, by: MODEL });
  return `${head}\n\n# ${date} の日記\n\n${body}\n`;
}

// ---------------------------------------------------------------- 入口

function main(): number {
  const args = parseArgs(process.argv.slice(2), ["dry-run", "quiet"], ["since"]);
  const since = parseSince(args.values.since);
  if (since === undefined) return 2;

  // 立ち会った日 = `アイボ/` のある日。書くのはきのうまで（今日はまだ
  // 終わっていない）。時計を見てよい理由は冒頭のとおり。
  const today = ymd(jst(new Date().toISOString())!);
  const lived = datesIn("アイボ");
  const open = lived.filter((d) => d >= today);
  const targets = lived.filter((d) => d < today && (!since || d >= since));

  let written = 0;
  let already = 0;
  let failed = 0;

  for (const date of targets) {
    const out = join(ROOM, date.slice(0, 7), `${date}.md`);
    if (existsSync(out)) {
      // 追記のみ。できたものには二度と触らない
      already += 1;
      continue;
    }

    const prompt = buildPrompt(date);
    if (args.flags["dry-run"]) {
      console.log(`━━━ ${date}（${n([...prompt].length)} 文字を渡す）━━━`);
      console.log(prompt.slice(0, 1200));
      console.log("…");
      written += 1;
      continue;
    }

    try {
      const body = ask(prompt);
      // 書くのは1回だけ。`writeIfChanged()` を使わないのは、上書きの口を
      // 持たないため（この部屋の原則: 一度書いたら直さない）
      mkdirSync(join(ROOM, date.slice(0, 7)), { recursive: true });
      writeFileSync(out, render(date, body), "utf8");
      written += 1;
    } catch (err) {
      failed += 1;
      console.error(`  ✗ ${date}: ${(err as Error).message}`);
    }
  }

  if (args.flags.quiet) {
    console.log(
      `diary: ${n(already + written)}日 (new ${written} / ある ${already}` +
        (failed ? ` / 書けず ${failed}` : "") + ")",
    );
  } else {
    if (args.flags["dry-run"]) console.log("（書かずに確認）");
    console.log(`  日記         : ${n(already + written)} 日ぶん`);
    console.log(`    あたらしい : ${n(written)}`);
    console.log(`    もうある   : ${n(already)}`);
    if (failed) console.log(`    書けず     : ${n(failed)}（次の便で書き直す）`);
    if (open.length) console.log(`  まだの日     : ${open.join("、")}（終わってから書く）`);
    console.log(`  書き手       : ${MODEL}`);
    console.log(`  ばしょ : ${ROOM}`);
  }

  return failed ? 1 : 0;
}

process.exit(main());
