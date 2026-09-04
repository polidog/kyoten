#!/usr/bin/env node
/**
 * comment — アイボの日記に、よそのモデルが返す感想
 *
 * 日記はアイボが書く。ここはそれを**あとから読んだ人**が返す部屋。
 *
 * ## なぜ別の口が要るか
 *
 * アイボは自分の日記を批評できない。書いたのが自分だからで、
 * 「読んで分からなかったところ」は原理的に出てこない。
 * だから**その日を知らない相手**に読ませる。
 *
 * これは役者表（勇者・賢者・うらないババ）とは違う。あれは名前だけで
 * 機構が無かったが、読者は**本当に別のプロセスで、本当に何も知らない**。
 * 渡すのは日記1枚だけで、拠点も素材も渡さない。知らないことが役どころ
 * そのものになっている。
 *
 * ## アイボは1匹のまま
 *
 * 読者を増やしても登場人物は増えない。読者は読者で、モデルごとに個体を
 * 分けない —— `アイボ/` が Claude Code と Codex の記録をまとめて食べるのと
 * 同じ考えかた。立ち位置は `stance/reader.md` に1枚だけ置く。
 *
 * ## この部屋も原則1・2が成り立たない
 *
 * 書き手が LLM なので、`日記/` `出来事/` と同じ:
 *
 *   **追記のみ・一度書いたら直さない。**
 *
 * 書き直したいときは、そのファイルを手で消す。
 *
 * ## 循環させない
 *
 * `codex exec` は既定でセッションを `~/.codex/sessions` に残す。そのままだと
 * **感想を書いたこと自体がその日の会話ログになり**、`会話/` と `アイボ/` に
 * 混ざる（落とし穴46 の Codex 版）。`--ephemeral` が要る。
 *
 * 出力は `--output-last-message` でファイルに取る —— stdout には起動情報も
 * hook の通知もトークン数も混ざるので、拾ってはいけない。
 *
 * **読者を足すときは、その道具がログをどこに残すか先に見る。** `sessions.ts`
 * が読んでいる場所（Claude Code と `~/.codex/sessions`）に残るなら、
 * 残さない口を探す。無ければ足さない。
 *
 * 使い方:
 *     comment.ts                  # 書けるところまで
 *     comment.ts --dry-run        # 渡すものを見るだけ（API を叩かない）
 *     comment.ts --since 2026-09-01
 *     comment.ts --quiet          # 1行だけ（定時便用）
 *     comment.ts --try 2026-09-02 # 拠点に書かずに1枚だけ書かせる（声を見る）
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KYOTEN, clip, frontmatter, n, readText, splitFrontmatter } from "./util.ts";
import { listFiles, parseArgs, parseSince } from "./cli.ts";

const ROOM = join(KYOTEN, "感想");
const DIARY = join(KYOTEN, "日記");

/** 読者の立ち位置。1枚だけ（原則7: 人格を道具の中に書かない）。 */
const STANCE = join(import.meta.dirname, "..", "stance", "reader.md");

/** 日記1枚の上限。ふつう 400〜800字なので余裕はあるが、青天井にはしない。 */
const DIARY_LIMIT = 10_000;

/** 1本にかける上限。日記より短いものを書かせるので、日記の半分。 */
const TIMEOUT = 120_000;

/**
 * 読者に固有の決まりごとだけ。立ち位置は `STANCE` から読む。
 * ここにも口調と性格は書かない。
 */
const TASK = `この日記を読んで、思ったことを返す。

あなたが読んだのは、下にある1枚だけ。ほかの記録は無いし、調べる先も無い。

感想の本文だけを出力する。前置きも見出しも要らない。`;

// ---------------------------------------------------------------- 読者

type Reader = {
  /** ファイル名と frontmatter に入る名前。 */
  key: string;
  /** 実行ファイル。環境変数で差し替えられる。 */
  cmd: string;
  /** 引数を組む。`out` に最後の返事を書かせる。 */
  args: (out: string) => string[];
};

/**
 * いまは1人。増やすときは「ログをどこに残すか」を先に見る（上の「循環させない」）。
 *
 * gemini も試したが、いまは動かない —— 無料枠の Gemini Code Assist が
 * このクライアントを切っていて（`IneligibleTierError`）、Antigravity への
 * 移行を求められる。認証が通るようになったら、ここに1行足せば入る。
 */
const READERS: Reader[] = [
  {
    key: "codex",
    cmd: process.env.KYOTEN_CODEX ?? "codex",
    args: (out) => [
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox", "read-only",
      "--output-last-message", out,
    ],
  },
];

// ---------------------------------------------------------------- 素材

/** 日付ごとに1枚の部屋にある日付の一覧。 */
function datesIn(room: string): string[] {
  const root = join(KYOTEN, room);
  if (!existsSync(root)) return [];
  return listFiles(root, ".md")
    .map((p) => p.slice(p.lastIndexOf("/") + 1, -3))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
}

/** その日の日記の本文。 */
function diaryOf(date: string): string {
  const path = join(DIARY, date.slice(0, 7), `${date}.md`);
  if (!existsSync(path)) return "";
  const [, body] = splitFrontmatter(readText(path));
  // 見出し（`# 2026-09-03 の日記`）は落とす。読ませるのは本文だけ
  return body.replace(/^#[^\n]*\n+/, "").trim();
}

function buildPrompt(date: string, stance: string): string {
  return [
    stance,
    TASK,
    `## 読む日記（${date}）`,
    clip(diaryOf(date), DIARY_LIMIT),
  ].join("\n\n");
}

// ---------------------------------------------------------------- 書かせる

/** 書けなかった。呼び出し側はその読者を諦める（空のファイルは作らない）。 */
class Unwritten extends Error {}

function ask(reader: Reader, prompt: string): string {
  // 専用の空ディレクトリで走らせる。手元の AGENTS.md を拾わせない
  // —— 渡すものは日記1枚だけにする。
  const box = mkdtempSync(join(tmpdir(), "kyoten-comment-"));
  const out = join(box, "answer.txt");
  try {
    const done = spawnSync(reader.cmd, reader.args(out), {
      input: prompt,
      encoding: "utf8",
      timeout: TIMEOUT,
      maxBuffer: 32 * 1024 * 1024,
      cwd: box,
      // 返事はファイルから取るので stdout は汚れてもいいが、こけた理由は
      // stderr の最後の行から取る。mise の shim の通知を混ぜない（落とし穴47）。
      env: { ...process.env, MISE_QUIET: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (done.error) {
      const e = done.error as NodeJS.ErrnoException;
      if (e.code === "ENOENT") throw new Unwritten(`${reader.cmd} が見つからない`);
      if (e.code === "ETIMEDOUT") throw new Unwritten(`時間切れ（${TIMEOUT / 1000}秒）`);
      throw new Unwritten(e.message);
    }
    if (done.signal === "SIGTERM") throw new Unwritten(`時間切れ（${TIMEOUT / 1000}秒）`);
    if ((done.status ?? 1) !== 0) {
      throw new Unwritten(
        (done.stderr ?? "").trim().split("\n").filter(Boolean).at(-1) ?? "非ゼロで終わった",
      );
    }

    if (!existsSync(out)) throw new Unwritten("返事のファイルができなかった");
    const text = readFileSync(out, "utf8").trim();
    if (!text) throw new Unwritten("何も返ってこなかった");
    return text;
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
}

function render(date: string, reader: Reader, body: string): string {
  const head = frontmatter({
    room: "感想",
    date,
    by: reader.key,
    about: `日記/${date.slice(0, 7)}/${date}.md`,
  });
  // 読んだのはシェパード（1匹）。`reader.key` は**走らせた機械**の名前で、
  // 日記の `by: claude-opus-5` と同じ扱い。読者を走らせる機械が増えても
  // 犬は増えない（CLAUDE.md「犬は増やしてよい。ただし機構1つにつき1匹」）。
  return `${head}\n\n# ${date} の日記を読んで（シェパード・${reader.key}）\n\n${body}\n`;
}

function outPath(date: string, reader: Reader): string {
  return join(ROOM, date.slice(0, 7), `${date}-${reader.key}.md`);
}

// ---------------------------------------------------------------- 入口

function main(): number {
  const args = parseArgs(process.argv.slice(2), ["dry-run", "quiet"], ["since", "try"]);
  const since = parseSince(args.values.since);
  if (since === undefined) return 2;

  // 立ち位置が無ければ何も書かない。人格の出どころを黙って失うより、
  // 1枚も書かないほうがいい。
  const stance = readText(STANCE).trim();
  if (!stance) {
    console.error(`立ち位置が読めません: ${STANCE}`);
    return 1;
  }

  // 声を変えたときのため。**拠点には書かず**、その日を書かせて出す。
  // 感想も追記のみなので、書いてある日の声は試し書きでしか見られない。
  const trial = args.values.try;
  if (trial) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(trial)) {
      console.error(`日付は YYYY-MM-DD で: ${trial}`);
      return 2;
    }
    if (!diaryOf(trial)) {
      console.error(`その日の日記が拠点に無い: ${trial}`);
      return 1;
    }
    const prompt = buildPrompt(trial, stance);
    let failed = 0;
    for (const reader of READERS) {
      if (READERS.length > 1) console.log(`━━━ ${reader.key} ━━━`);
      try {
        console.log(ask(reader, prompt));
      } catch (err) {
        failed += 1;
        console.error(`書けませんでした: ${(err as Error).message}`);
      }
    }
    return failed === READERS.length ? 1 : 0;
  }

  // 感想を書けるのは日記のある日だけ。日記が「きのうまで」を守るので、
  // ここで時計を見る必要は無い。
  const targets = datesIn("日記").filter((d) => !since || d >= since);

  let written = 0;
  let already = 0;
  /** 一度こけた読者は、その実行では諦める（認証切れなら全日で同じ結果になる）。 */
  const broken = new Map<string, string>();

  for (const date of targets) {
    let prompt: string | null = null;

    for (const reader of READERS) {
      if (broken.has(reader.key)) continue;

      const out = outPath(date, reader);
      if (existsSync(out)) {
        // 追記のみ。できたものには二度と触らない
        already += 1;
        continue;
      }

      prompt ??= buildPrompt(date, stance);

      if (args.flags["dry-run"]) {
        console.log(`━━━ ${date} / ${reader.key}（${n([...prompt].length)} 文字を渡す）━━━`);
        console.log(prompt.slice(0, 1200));
        console.log("…");
        written += 1;
        continue;
      }

      try {
        const body = ask(reader, prompt);
        // 書くのは1回だけ。`writeIfChanged()` を使わないのは、上書きの口を
        // 持たないため（この部屋の原則: 一度書いたら直さない）
        mkdirSync(join(ROOM, date.slice(0, 7)), { recursive: true });
        writeFileSync(out, render(date, reader, body), "utf8");
        written += 1;
      } catch (err) {
        broken.set(reader.key, (err as Error).message);
      }
    }
  }

  if (args.flags.quiet) {
    const lost = [...broken.keys()];
    console.log(
      `comment: ${n(already + written)}枚 (new ${written} / ある ${already}` +
        (lost.length ? ` / 書けず ${lost.join("・")}` : "") + ")",
    );
  } else {
    if (args.flags["dry-run"]) console.log("（書かずに確認）");
    console.log(`  感想         : ${n(already + written)} 枚`);
    console.log(`    あたらしい : ${n(written)}`);
    console.log(`    もうある   : ${n(already)}`);
    for (const [key, why] of broken) {
      console.log(`    書けず     : ${key} —— ${why}`);
    }
    console.log(`  読者         : ${READERS.map((r) => r.key).join("、")}`);
    console.log(`  ばしょ : ${ROOM}`);
  }

  // 全員こけたときだけ非ゼロ（一部が使えないのは普通の状態）
  return broken.size === READERS.length ? 1 : 0;
}

process.exit(main());
