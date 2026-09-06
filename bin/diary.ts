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
 * 立ち位置は `skills/aibo/stance.md` に1枚だけ置いてあり、ここはそれを読む。
 * `/aibo` も同じ1枚を読む —— 相棒が2人に割れないように。
 * この道具が足すのは**日記の書きかた**だけで、口調も性格も書かない。
 * 何を言うかは、その日の拠点が決める。
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
 *     diary.ts --try 2026-09-02   # 拠点に書かずに1枚だけ書かせる（声を見る）
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

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
import { appendLimit } from "./machine.ts";

const ROOM = join(KYOTEN, "日記");

/** 手帳。polidog が手で書く唯一の木（原則4 の例外）。 */
const NOTEBOOK = join(KYOTEN, "手帳");

/** 呼ぶもの。`KYOTEN_MODEL` で変えられる。 */
const CLAUDE = process.env.KYOTEN_CLAUDE ?? "claude";
const MODEL = process.env.KYOTEN_MODEL ?? "claude-opus-5";

/** 1日ぶんの素材の上限。1部屋あたり。長い日でも入るが、青天井にはしない。 */
const MATERIAL_LIMIT = 30_000;

/** 1本にかける上限。夜に走るので待てるが、ぶら下がらせはしない。 */
const TIMEOUT = 180_000;

/** 立ち位置。`/aibo` と共有する1枚（原則7: 人格を道具の中に書かない）。 */
const STANCE = join(import.meta.dirname, "..", "skills", "aibo", "stance.md");

/**
 * 日記に固有の決まりごとだけ。立ち位置は `STANCE` から読む。
 * ここにも口調と性格は書かない。
 */
const WRITING = `その日の日記を書く。素材にあるのは全部あなたが立ち会ったこと。

## 何を書くか

**あったことは書かない。思ったことを書く。**
あったことは \`アイボ/\` \`自分/\` \`作業/\` に機械が書いてある。日記でもう一度
並べ直しても、同じものが二枚できるだけ。日記に書くのは、その記録を見て
**あなたが思ったこと**。

- 段落は「思ったこと」から始める。事実は、その根拠として1つか2つ添える
  （時刻か数を付けて）。根拠の無い感想は書かない。
- **感想の無い段落は書かない。** 事実だけが並んだ段落ができたら消す。
  「何時に何をして、そのあと何をした」は記録であって日記ではない。
- 感想の材料: 引っかかったこと、続いていること、前と違ったこと、
  うまくいったと思うこと、変だと思うこと、よかったと思うこと。
  褒めてもいい。指摘してもいい。どちらも根拠つきで。
- polidog がしたこと・言ったことは断言してよい。**気持ちは断言しない**
  —— 「〜に見えた」「〜なのかなと思った」まで。
- 数は素材のものをそのまま使う。自分で数え直さない。会話・発言・道具の
  数は、言いたいことの根拠になるときだけ出す。数を並べる段落を作らない。
- **手帳はその日の記録ではない。** polidog が手で書いている、いま抱えて
  いることの控え。**その日の記録と繋がっていなければ触れない** ——
  繋げるために「奇しくも同じ日に」のようなこじつけを書かない。
- **「読んだ」にあるのは、polidog が開いたページの題と URL だけ。** 中身は
  あなたも読んでいない。「開いてたね」までは言えるが、何が書いてあったかは
  言えない。
- **これまでの日記は話のつながりのために渡している。口調も書き出しも
  まねしない** —— 声は「喋りかた」に従う。続いていることがあれば
  「きのうも」「3日続けて」と言ってよい。数えるのは渡した日記の中だけ。

## 形

- 日本語。技術用語とコード識別子は原文のまま。
- 300〜700字。見出しは付けず、段落で書く。

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

/**
 * 手帳 —— polidog が手で書いている紙（原則4 の例外）。
 *
 * ほかの素材と違って**日付ごとに畳んだ部屋ではない**ので、その日のぶんだけを
 * 切り出せない。だから全部を**背景**として渡す。日付で絞る手は取らなかった:
 * 更新日を frontmatter に手で書かせると、書き忘れた紙が黙って落ちる
 * （落とし穴70 と同じ形）。mtime は機械ごとに動くので使えない。
 *
 * 渡すだけだと、繋がっていない日にこじつけを書く（`guest.ts` で踏んだ形）。
 * 「その日の記録ではない」は `WRITING` で名指ししてある。
 */
function notebook(): string {
  if (!existsSync(NOTEBOOK)) return "";
  const out: string[] = [];
  for (const path of listFiles(NOTEBOOK, ".md")) {
    const [fields, body] = splitFrontmatter(readText(path));
    const rel = relative(NOTEBOOK, path).replace(/\.md$/, "");
    out.push(`【${fields.title || rel}】（手帳/${rel}）\n${body.trim()}`);
  }
  return out.join("\n\n");
}

/**
 * 読んだもの。ソースごとに1枚（`chrome-<日付>.md` `posts-<日付>.md`）なので
 * 月のディレクトリから日付で拾う。あるのは題と URL だけで、本文は無い ——
 * アイボも読んでいない、は `WRITING` で名指ししてある。
 */
function readingOf(date: string): string {
  const dir = join(KYOTEN, "読んだ", date.slice(0, 7));
  if (!existsSync(dir)) return "";
  const out: string[] = [];
  for (const path of listFiles(dir, ".md")) {
    if (!path.endsWith(`-${date}.md`)) continue;
    const [fields, body] = splitFrontmatter(readText(path));
    out.push(`【${fields.source || "?"}】\n${body.trim()}`);
  }
  return out.join("\n\n");
}

/** 1枚の日記から、最後の段落（言いたいこと）だけ。 */
function lastParagraph(body: string): string {
  const paras = body.trim().split(/\n{2,}/).filter((p) => p.trim());
  return paras.at(-1) ?? "";
}

/**
 * これまでの日記。いちばん新しい1枚は全文、その前の6日ぶんは締めの段落だけ。
 *
 * きのう1枚だけ渡していたころは、「二日続けて」までしか言えなかった。
 * 相棒らしさは数の多さより覚えていることから出るので、1週間ぶん渡す。
 * 全文を7枚渡すと素材が日記に食われて声が薄まる（落とし穴53）ので、
 * 古いぶんは「言いたいこと」だけにする。
 */
const LOOKBACK = 7;

function pastDiaries(date: string): string {
  const before = datesIn("日記").filter((d) => d < date).slice(-LOOKBACK);
  if (!before.length) return "";
  const out: string[] = [];
  for (const d of before) {
    const [, body] = splitFrontmatter(readText(join(ROOM, d.slice(0, 7), `${d}.md`)));
    const full = d === before.at(-1);
    out.push(`（${d}${full ? "" : "・締めだけ"}）\n${full ? body.trim() : lastParagraph(body)}`);
  }
  return out.join("\n\n");
}

/**
 * 立ち位置から「喋りかた」の節だけ抜く。
 *
 * 素材は 3万字まで渡すので、声のことを先頭で1回言っただけだと薄まる
 * （実測: 口調を足した直後に書かせたら、きのうの日記の声のまま出た）。
 * 同じ文を二度持たずに、最後にもう一度置くために stance から切り出す。
 */
function voiceOf(stance: string): string {
  const at = stance.indexOf("## 喋りかた");
  return at < 0 ? "" : stance.slice(at).trim();
}

function buildPrompt(date: string, stance: string): string {
  const parts: string[] = [stance, WRITING, `## 素材（${date}）`];
  const add = (head: string, body: string) => {
    if (body.trim()) parts.push(`### ${head}\n\n${clip(body, MATERIAL_LIMIT)}`);
  };

  add("アイボ —— あなたがその日にしたこと", dayFile("アイボ", date));
  add("自分 —— polidog がその日に言ったこと", dayFile("自分", date));
  add("作業 —— その日のコミットと、詰まったこと", dayFile("作業", date));
  add("投稿 —— その日に外へ出したもの", postsOf(date));
  add("読んだ —— polidog がその日に開いたページ（題と URL だけ。中身は無い）",
    readingOf(date));
  add("手帳 —— polidog がいま抱えていること（その日の記録ではない。背景）",
    notebook());
  add("これまでの日記 —— いちばん新しい1枚は全文、その前は締めだけ", pastDiaries(date));

  // 声は最後にもう一度。素材のあとに置かないと、これまでの日記に引っぱられる
  const voice = voiceOf(stance);
  if (voice) parts.push(`## もう一度 —— この声で書く\n\n${voice}`);

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
  const args = parseArgs(process.argv.slice(2), ["dry-run", "quiet"], ["since", "try"]);
  const since = parseSince(args.values.since);
  if (since === undefined) return 2;

  // 立ち会った日 = `アイボ/` のある日。書くのはきのうまで（今日はまだ
  // 終わっていない）。時計を見てよい理由は冒頭のとおり。
  // 立ち位置が無ければ何も書かない。人格の出どころを黙って失うより、
  // 1枚も書かないほうがいい。
  const stance = readText(STANCE).trim();
  if (!stance) {
    console.error(`立ち位置が読めません: ${STANCE}`);
    return 1;
  }

  // 声を変えたときのため。**拠点には書かず**、その日を1枚だけ書かせて出す。
  // 日記は追記のみなので、書いてある日の声は試し書きでしか見られない。
  const trial = args.values.try;
  if (trial) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(trial)) {
      console.error(`日付は YYYY-MM-DD で: ${trial}`);
      return 2;
    }
    try {
      console.log(ask(buildPrompt(trial, stance)));
      return 0;
    } catch (err) {
      console.error(`書けませんでした: ${(err as Error).message}`);
      return 1;
    }
  }

  const today = ymd(jst(new Date().toISOString())!);
  // 拠点を複数の PC で共有しているときは、**全機械の素材が揃った日まで**
  // しか書かない。日記は追記のみなので、片肺の素材で書くとその日は
  // 永久に片肺のまま残る（`株/` の落とし穴69 と同じ構え。遅れるだけで、
  // 抜けはしない）。1台で使っているうちは `today` のまま。
  const { limit, held } = appendLimit(today);
  const lived = datesIn("アイボ");
  const open = lived.filter((d) => d >= limit);
  const targets = lived.filter((d) => d < limit && (!since || d >= since));

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

    const prompt = buildPrompt(date, stance);
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
        (failed ? ` / 書けず ${failed}` : "") + ")" + (held ? ` ／ ${held}` : ""),
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
