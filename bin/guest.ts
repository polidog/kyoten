#!/usr/bin/env node
/**
 * guest — よその犬が書く、その日の日記
 *
 * `日記/` はアイボが**中から**書く。ここは同じ日を**外から**書く部屋。
 *
 * ## なぜ2枚めが要るか
 *
 * アイボは世の中を見ない。見るのは拠点だけで、それは意図してそうしてある
 * （夜に無人で走るので、外の当たり外れを持ち込まない —— `outlook.ts` と
 * 同じ構え）。だから日記には**その日、外で何が起きていたか**が一行も無い。
 *
 * ここはそこを引き受ける。渡すのは `ニュース/` と、その日の記録。
 * 同じ日について、中から1枚と外から1枚が並ぶ。
 *
 * ## `感想/` をここに建て替えた（2026-09-05）
 *
 * 前身は `comment.ts`（`感想/`）で、アイボの日記を読んで返す部屋だった。
 * 日記1枚だけを渡す作りから、素材も渡す作りへ替え、そのうえで**返事を
 * やめて日記にした**。
 *
 * 返事だったころは、いい所を突いても**アイボの一日の枠の中**でしか喋れない。
 * アイボが書かなかった話は指せても、**アイボが見ていない世界**は持ち出せない。
 * 日記にすると、そこが持ち場になる。
 *
 * **アイボの日記は渡さない。** 読むと、また返事に寄る。同じ日を、別々に書く。
 *
 * ## アイボは1匹のまま。よその犬も1匹
 *
 * 書き手を増やしても登場人物は増えない。モデルごとに個体を分けない ——
 * `アイボ/` が Claude Code と Codex の記録をまとめて食べるのと同じ考えかた。
 * 立ち位置は `stance/guest.md` に1枚だけ置く。
 *
 * ## この部屋も原則1・2が成り立たない
 *
 * 書き手が LLM なので、`日記/` `出来事/` `見立て/` と同じ:
 *
 *   **追記のみ・一度書いたら直さない。**
 *
 * 書き直したいときは、そのファイルを手で消す。
 *
 * ## 循環させない
 *
 * `codex exec` は既定でセッションを `~/.codex/sessions` に残す。そのままだと
 * **日記を書いたこと自体がその日の会話ログになり**、`会話/` と `アイボ/` に
 * 混ざる（落とし穴46 の Codex 版）。`--ephemeral` が要る。
 *
 * 出力は `--output-last-message` でファイルに取る —— stdout には起動情報も
 * hook の通知もトークン数も混ざるので、拾ってはいけない。
 *
 * **書き手を足すときは、その道具がログをどこに残すか先に見る。**
 * 残さない口が無ければ足さない。
 *
 * 使い方:
 *     guest.ts                  # 書けるところまで
 *     guest.ts --dry-run        # 渡すものを見るだけ（API を叩かない）
 *     guest.ts --since 2026-09-01
 *     guest.ts --quiet          # 1行だけ（定時便用）
 *     guest.ts --try 2026-09-02 # 拠点に書かずに1枚だけ書かせる（声を見る）
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KYOTEN, clip, frontmatter, jst, n, readText, splitFrontmatter, ymd } from "./util.ts";
import { listFiles, parseArgs, parseSince } from "./cli.ts";
import { appendLimit } from "./machine.ts";

const ROOM = join(KYOTEN, "よその日記");

/** よその犬の立ち位置。1枚だけ（原則7: 人格を道具の中に書かない）。 */
const STANCE = join(import.meta.dirname, "..", "stance", "guest.md");

/** 1日ぶんの素材の上限。1部屋あたり。`diary.ts` と同じ枠で渡す。 */
const MATERIAL_LIMIT = 30_000;

/** 1本にかける上限。日記に揃える。 */
const TIMEOUT = 180_000;

/**
 * 書き手に固有の決まりごとだけ。立ち位置は `STANCE` から読む。
 * ここにも口調と性格は書かない。
 */
const TASK = `その日の日記を書く。

渡すのは2つ。その日に外で話されていたこと（ニュース）と、その日ここに
残った記録。あなたはどちらも**あとから読んだ**だけで、その場にはいない。

ニュースは見出しだけ。中身は開いていない。

日記の本文だけを出力する。前置きも見出しも要らない。`;

// ---------------------------------------------------------------- 書き手

type Writer = {
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
const WRITERS: Writer[] = [
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

/** 日付ごとに1枚の部屋から、その日を読む。`diary.ts` と同じ取りかた。 */
function dayFile(room: string, date: string): string {
  const path = join(KYOTEN, room, date.slice(0, 7), `${date}.md`);
  if (!existsSync(path)) return "";
  const [, body] = splitFrontmatter(readText(path));
  // 見出し（`# 2026-09-02 の話題`）は落とす。読ませるのは中身だけ
  return body.replace(/^#[^\n]*\n+/, "").trim();
}

/** 投稿はその月のディレクトリから、frontmatter の日付で拾う。 */
function postsOf(date: string): string {
  const dir = join(KYOTEN, "投稿", date.slice(0, 7));
  if (!existsSync(dir)) return "";
  const out: string[] = [];
  for (const path of listFiles(dir, ".md")) {
    const [fields, body] = splitFrontmatter(readText(path));
    if (fields.date !== date) continue;
    const title = fields.title || fields.source || "";
    out.push(`【${title}】\n${body.trim()}`);
  }
  return out.join("\n\n");
}

/** その日より前で、いちばん新しいよその日記。声が続くように渡す。 */
function previous(date: string, writer: Writer): string {
  const before = datesIn("よその日記")
    .filter((d) => d < date)
    .filter((d) => existsSync(outPath(d, writer)));
  const last = before.at(-1);
  if (!last) return "";
  const [, body] = splitFrontmatter(readText(outPath(last, writer)));
  return `（${last}）\n${body.replace(/^#[^\n]*\n+/, "").trim()}`;
}

/**
 * 立ち位置から「喋りかた」の節だけ抜く（`diary.ts` と同じ理由・落とし穴53）。
 * 素材を数万字渡すので、先頭で1回言った声は薄まる。
 */
function voiceOf(stance: string): string {
  const at = stance.indexOf("## 喋りかた");
  return at < 0 ? "" : stance.slice(at).trim();
}

function buildPrompt(date: string, stance: string, writer: Writer): string {
  const parts: string[] = [stance, TASK];
  const add = (head: string, body: string) => {
    if (body.trim()) parts.push(`### ${head}\n\n${clip(body, MATERIAL_LIMIT)}`);
  };

  parts.push(`## その日、外で（${date}）`);
  add("ニュース —— 見出しだけ", dayFile("ニュース", date));

  parts.push(`## その日、ここで（${date}）`);
  // アイボが日記を書いたときと同じ4つ。**アイボの日記は渡さない**
  // —— 読ませると、日記ではなく返事になる
  add("アイボ —— アイボがその日にしたこと", dayFile("アイボ", date));
  add("自分 —— polidog がその日に言ったこと", dayFile("自分", date));
  add("作業 —— その日のコミットと、詰まったこと", dayFile("作業", date));
  add("投稿 —— その日に外へ出したもの", postsOf(date));

  add("きのう、あなたが書いた日記（話のつながりのために渡している）", previous(date, writer));

  // 声は最後にもう一度。素材に埋もれると、アイボの常体に引っぱられる
  const voice = voiceOf(stance);
  if (voice) parts.push(`## もう一度 —— この声で書く\n\n${voice}`);

  return parts.join("\n\n");
}

// ---------------------------------------------------------------- 書かせる

/** 書けなかった。呼び出し側はその書き手を諦める（空のファイルは作らない）。 */
class Unwritten extends Error {}

function ask(writer: Writer, prompt: string): string {
  // 専用の空ディレクトリで走らせる。手元の AGENTS.md を拾わせない
  // —— 渡すものは、こちらで組んだ素材だけにする。
  const box = mkdtempSync(join(tmpdir(), "kyoten-guest-"));
  const out = join(box, "answer.txt");
  try {
    const done = spawnSync(writer.cmd, writer.args(out), {
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
      if (e.code === "ENOENT") throw new Unwritten(`${writer.cmd} が見つからない`);
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

function render(date: string, writer: Writer, body: string): string {
  const head = frontmatter({
    room: "よその日記",
    date,
    by: writer.key,
  });
  // 書いたのはレトリバー（1匹）。`writer.key` は**走らせた機械**の名前で、
  // 日記の `by: claude-opus-5` と同じ扱い。機械が増えても犬は増えない
  // （CLAUDE.md「犬は増やしてよい。ただし機構1つにつき1匹」）。
  return `${head}\n\n# ${date} の日記（よそから・${writer.key}）\n\n${body}\n`;
}

function outPath(date: string, writer: Writer): string {
  return join(ROOM, date.slice(0, 7), `${date}-${writer.key}.md`);
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
  // ここも追記のみなので、書いてある日の声は試し書きでしか見られない。
  const trial = args.values.try;
  if (trial) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(trial)) {
      console.error(`日付は YYYY-MM-DD で: ${trial}`);
      return 2;
    }
    if (!dayFile("アイボ", trial)) {
      console.error(`その日の記録が拠点に無い: ${trial}`);
      return 1;
    }
    let failed = 0;
    for (const writer of WRITERS) {
      if (WRITERS.length > 1) console.log(`━━━ ${writer.key} ━━━`);
      try {
        console.log(ask(writer, buildPrompt(trial, stance, writer)));
      } catch (err) {
        failed += 1;
        console.error(`書けませんでした: ${(err as Error).message}`);
      }
    }
    return failed === WRITERS.length ? 1 : 0;
  }

  // 書けるのは**ニュースと記録がそろった日**。ニュースが無い日は外が
  // 空になるので、この部屋の値打ちが消える —— 書かずに待つ
  // 追記のみなので、全機械の素材が揃った日までしか書かない（`diary.ts` と同じ）
  const { limit, held } = appendLimit(ymd(jst(new Date().toISOString())!));
  const targets = datesIn("ニュース")
    .filter((d) => d < limit)
    .filter((d) => !since || d >= since)
    .filter((d) => dayFile("アイボ", d));

  let written = 0;
  let already = 0;
  /** 一度こけた書き手は、その実行では諦める（認証切れなら全日で同じ結果になる）。 */
  const broken = new Map<string, string>();

  for (const date of targets) {
    for (const writer of WRITERS) {
      if (broken.has(writer.key)) continue;

      const out = outPath(date, writer);
      if (existsSync(out)) {
        // 追記のみ。できたものには二度と触らない
        already += 1;
        continue;
      }

      const prompt = buildPrompt(date, stance, writer);

      if (args.flags["dry-run"]) {
        console.log(`━━━ ${date} / ${writer.key}（${n([...prompt].length)} 文字を渡す）━━━`);
        console.log(prompt.slice(0, 1200));
        console.log("…");
        written += 1;
        continue;
      }

      try {
        const body = ask(writer, prompt);
        // 書くのは1回だけ。`writeIfChanged()` を使わないのは、上書きの口を
        // 持たないため（この部屋の原則: 一度書いたら直さない）
        mkdirSync(join(ROOM, date.slice(0, 7)), { recursive: true });
        writeFileSync(out, render(date, writer, body), "utf8");
        written += 1;
      } catch (err) {
        broken.set(writer.key, (err as Error).message);
      }
    }
  }

  if (args.flags.quiet) {
    const lost = [...broken.keys()];
    console.log(
      `guest: ${n(already + written)}枚 (new ${written} / ある ${already}` +
        (lost.length ? ` / 書けず ${lost.join("・")}` : "") + ")" + (held ? ` ／ ${held}` : ""),
    );
  } else {
    if (args.flags["dry-run"]) console.log("（書かずに確認）");
    console.log(`  よその日記   : ${n(already + written)} 枚`);
    console.log(`    あたらしい : ${n(written)}`);
    console.log(`    もうある   : ${n(already)}`);
    for (const [key, why] of broken) {
      console.log(`    書けず     : ${key} —— ${why}`);
    }
    console.log(`  書き手       : ${WRITERS.map((w) => w.key).join("、")}`);
    console.log(`  ばしょ : ${ROOM}`);
  }

  // 全員こけたときだけ非ゼロ（一部が使えないのは普通の状態）
  return broken.size === WRITERS.length ? 1 : 0;
}

process.exit(main());
