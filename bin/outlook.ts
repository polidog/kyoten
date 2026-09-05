#!/usr/bin/env node
/**
 * outlook — アイボが書く株の見立て
 *
 * `株/` は機械が数えた値だけ。ここはその値を見て、**アイボが言う**部屋。
 *
 * ## この部屋も原則1・2 が成り立たない
 *
 * 書き手が LLM なので、`日記/` `よその日記/` `出来事/` と同じ:
 *
 *   **追記のみ・一度書いたら直さない。**
 *
 * 株ではこれが特に効く。**あとで「そのとき何と言ったか」が読めないと、
 * 見立てはただの後知恵になる。** 毎晩書き換わる予想には値打ちが無い。
 * 書き直したいときは、そのファイルを手で消す。
 *
 * ## 素材に前の見立てを入れる
 *
 * 直前の1枚（声が続くように）と、**1か月ほど前の1枚**（答え合わせのため）を
 * 渡す。外れていたら外れたと言うのがこの部屋の一番の値打ちなので、
 * 前に何と言ったかを見せないと始まらない。
 *
 * ## 人格をここに書かない（原則7）
 *
 * 声は `skills/aibo/stance.md`。株のときの構えだけ `skills/kabu/stance.md`。
 * `/kabu` と subagent も同じ2枚を読む —— 相棒が2人に割れないように。
 *
 * ## 書くのは `株/` のある日だけ
 *
 * 値の無い日に見立ては書けない。`株/` は確定した終値しか持たないので、
 * ここも自動的に「確定した日」までになる。時計は見ない。
 *
 * 使い方:
 *     outlook.ts                 # 書けるところまで
 *     outlook.ts --dry-run       # 渡すものを見るだけ（API を叩かない）
 *     outlook.ts --since 2026-09-01
 *     outlook.ts --quiet         # 1行だけ（定時便用）
 *     outlook.ts --try 2026-09-03   # 拠点に書かずに1枚書かせる（声を見る）
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KYOTEN, clip, frontmatter, jst, n, readText, splitFrontmatter, ymd } from "./util.ts";
import { listFiles, parseArgs, parseSince } from "./cli.ts";
import { appendLimit } from "./machine.ts";

const ROOM = join(KYOTEN, "見立て");

const CLAUDE = process.env.KYOTEN_CLAUDE ?? "claude";
const MODEL = process.env.KYOTEN_MODEL ?? "claude-opus-5";

const MATERIAL_LIMIT = 20_000;
const TIMEOUT = 180_000;

/** 直前の何日ぶんを見せるか。動きの向きが見えるだけあればいい。 */
const RECENT_DAYS = 7;

/** 答え合わせに渡す1枚は、これくらい前のもの。 */
const LOOKBACK_DAYS = 30;

const STANCE = join(import.meta.dirname, "..", "skills", "aibo", "stance.md");
const KABU = join(import.meta.dirname, "..", "skills", "kabu", "stance.md");

/** 見立てに固有の決まりごとだけ。構えも口調も stance から読む。 */
const WRITING = `その日の株の見立てを書く。

## 書きかた

- 日本語。銘柄名と証券コードは原文のまま。
- **3〜6行。短く。** 長い分析文にしない。
- 見出しも箇条書きも使わない。段落で書く。
- その日いちばん目についた動きを1つ。数は素材のものをそのまま使う。
- 前に言ったことがあるなら、それに触れる。**外れていたら外れたと言う。**
- 最後は言い切らない。「ここにいる」までで止める。
- 動いていない日は「動いていない」と言って終わってよい。

見立ての本文だけを出力する。前置きも見出しも要らない。`;

// ---------------------------------------------------------------- 素材

function bodyOf(path: string): string {
  if (!existsSync(path)) return "";
  const [, body] = splitFrontmatter(readText(path));
  return body.trim();
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

function dayFile(room: string, date: string): string {
  return bodyOf(join(KYOTEN, room, date.slice(0, 7), `${date}.md`));
}

/** その日を含む直近の `株/`。向きが見えるように何日か並べる。 */
function recentStock(date: string): string {
  const days = datesIn("株").filter((d) => d <= date).slice(-RECENT_DAYS);
  return days.map((d) => dayFile("株", d)).filter(Boolean).join("\n\n---\n\n");
}

/** その日より前で、いちばん新しい見立て。声が続くように渡す。 */
function previousOutlook(date: string): string {
  const last = datesIn("見立て").filter((d) => d < date).at(-1);
  if (!last) return "";
  return `（${last}）\n${bodyOf(join(ROOM, last.slice(0, 7), `${last}.md`))}`;
}

/**
 * だいたい1か月前の見立て1枚。答え合わせ用。
 *
 * 日付の引き算は文字列ではできないので Date を通すが、基準はその日の
 * 日付であって**いまの時計ではない**（落とし穴18・19）。
 */
function oldOutlook(date: string): string {
  const cutoff = new Date(`${date}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - LOOKBACK_DAYS);
  const target = cutoff.toISOString().slice(0, 10);

  const before = datesIn("見立て").filter((d) => d <= target);
  const pick = before.at(-1);
  if (!pick) return "";
  return `（${pick} —— ${LOOKBACK_DAYS}日ほど前。当たっていたか見る）\n` +
    bodyOf(join(ROOM, pick.slice(0, 7), `${pick}.md`));
}

/** 立ち位置から「喋りかた」の節だけ抜く（落とし穴53: 先頭で1回言っても薄まる）。 */
function voiceOf(stance: string): string {
  const at = stance.indexOf("## 喋りかた");
  return at < 0 ? "" : stance.slice(at).trim();
}

function buildPrompt(date: string, stance: string, kabu: string): string {
  const parts: string[] = [stance, kabu, WRITING, `## 素材（${date}）`];
  const add = (head: string, body: string) => {
    if (body.trim()) parts.push(`### ${head}\n\n${clip(body, MATERIAL_LIMIT)}`);
  };

  add(`株 —— 直近 ${RECENT_DAYS} 日ぶん（最後がその日）`, recentStock(date));
  add("その日の日記", dayFile("日記", date));
  add("その日の作業", dayFile("作業", date));
  add("前の見立て", previousOutlook(date));
  add("ずっと前の見立て", oldOutlook(date));

  const voice = voiceOf(stance);
  if (voice) parts.push(`## もう一度 —— この声で書く\n\n${voice}`);

  return parts.join("\n\n");
}

// ---------------------------------------------------------------- 書かせる

class Unwritten extends Error {}

function ask(prompt: string): string {
  const done = spawnSync(CLAUDE, [
    "-p",
    // 付けないと、見立てを書いたこと自体がその日の会話ログになり、
    // `会話/` と `アイボ/` に混ざって循環する（落とし穴46）
    "--no-session-persistence",
    "--settings", '{"hooks":{}}',
    "--model", MODEL,
  ], {
    input: prompt,
    encoding: "utf8",
    timeout: TIMEOUT,
    maxBuffer: 32 * 1024 * 1024,
    cwd: tmpdir(),
    // mise の shim は起動通知を stdout に出す（落とし穴47）
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
  const head = frontmatter({ room: "見立て", date, by: MODEL });
  return `${head}\n\n# ${date} の見立て\n\n${body}\n`;
}

// ---------------------------------------------------------------- 入口

function main(): number {
  const args = parseArgs(process.argv.slice(2), ["dry-run", "quiet"], ["since", "try"]);
  const since = parseSince(args.values.since);
  if (since === undefined) return 2;

  // 立ち位置が読めなければ1枚も書かない。人格の出どころを黙って失うより、
  // 何も書かないほうがいい（diary.ts と同じ判断）
  const stance = readText(STANCE).trim();
  const kabu = readText(KABU).trim();
  if (!stance || !kabu) {
    console.error(`立ち位置が読めません: ${!stance ? STANCE : KABU}`);
    return 1;
  }

  const trial = args.values.try;
  if (trial) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(trial)) {
      console.error(`日付は YYYY-MM-DD で: ${trial}`);
      return 2;
    }
    try {
      console.log(ask(buildPrompt(trial, stance, kabu)));
      return 0;
    } catch (err) {
      console.error(`書けませんでした: ${(err as Error).message}`);
      return 1;
    }
  }

  // 時計は見ない。`株/` が確定した日しか持っていないので、それがそのまま境になる。
  // 追記のみなので、全機械の素材が揃った日までしか書かない。値（`株/`）は
  // どの機械でも同じだが、見立てはその日の日記を読むので、日記と同じ門を通す。
  const { limit, held } = appendLimit(ymd(jst(new Date().toISOString())!));
  const priced = datesIn("株");
  const targets = priced.filter((d) => d < limit).filter((d) => !since || d >= since);
  if (targets.length === 0) {
    // 値がまだ無いだけ。失敗ではない（stock.ts と同じ分けかた）。
    // **「値が無い」と「門で止まった」を混ぜない** —— 混ぜると、相手の
    // 機械が遅れているだけの夜に「先に stock.ts を流せ」と嘘を言う
    // （落とし穴14 と同じ形で、原因の違うものを1つの文言にしない）。
    const why = priced.length && held
      ? `outlook: 書ける日がまだ無い ／ ${held}`
      : "outlook: 株/ に値がまだ無い（先に stock.ts）";
    // `--quiet` でも1行出す —— 黙ると定時便が「何も言わずに終わった」と言う
    if (args.flags.quiet) console.log(why);
    else console.log(`  見立て       : ${priced.length && held ? held : `${join(KYOTEN, "株")} に値がまだ無い`}`);
    return 0;
  }

  let written = 0;
  let already = 0;
  let failed = 0;

  for (const date of targets) {
    const out = join(ROOM, date.slice(0, 7), `${date}.md`);
    if (existsSync(out)) {
      already += 1;
      continue;
    }

    const prompt = buildPrompt(date, stance, kabu);
    if (args.flags["dry-run"]) {
      console.log(`━━━ ${date}（${n([...prompt].length)} 文字を渡す）━━━`);
      console.log(prompt.slice(0, 1200));
      console.log("…");
      written += 1;
      continue;
    }

    try {
      const body = ask(prompt);
      // 上書きの口を持たない（この部屋の原則: 一度書いたら直さない）
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
      `outlook: ${n(already + written)}日 (new ${written} / ある ${already}` +
        (failed ? ` / 書けず ${failed}` : "") + ")" + (held ? ` ／ ${held}` : ""),
    );
  } else {
    if (args.flags["dry-run"]) console.log("（書かずに確認）");
    console.log(`  見立て       : ${n(already + written)} 日ぶん`);
    console.log(`    あたらしい : ${n(written)}`);
    console.log(`    もうある   : ${n(already)}`);
    if (failed) console.log(`    書けず     : ${n(failed)}（次の便で書き直す）`);
    console.log(`  書き手       : ${MODEL}`);
    console.log(`  ばしょ : ${ROOM}`);
  }

  return failed ? 1 : 0;
}

process.exit(main());
