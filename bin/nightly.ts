#!/usr/bin/env node
/**
 * nightly — 定時便
 *
 * 夜のうちに拾って回る。sessions・me・aibo・posts・work・entities・profile・
 * weekly・trend・diary・events を順に流し、索引を刻み直して、拠点を git commit
 * する。diary と events は中で `claude` を呼ぶ（きのうの日記と、終わった月の
 * 出来事を書く）。
 * systemd user timer から呼ばれる。
 *
 * 原則:
 *   - **1つが失敗しても次へ進む。** 取りに行く先が落ちている日でも、
 *     手元のログからの写しは進められる。全部やってから、失敗があれば
 *     非ゼロで終わる（systemd の failed として残す）。
 *   - **変化が無ければコミットしない。** 何も起きなかった日に空の
 *     コミットを積まない。
 *   - 拠点の中身は出力しない。journald に会話原文が漏れる。
 *
 * 使い方:
 *     nightly.ts             # 全部流す
 *     nightly.ts --dry-run   # 書かずに、コミットもせずに流す
 *     nightly.ts --no-commit # 集めるけどコミットはしない
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { KYOTEN } from "./util.ts";
import { parseArgs } from "./cli.ts";

const BIN = dirname(fileURLToPath(import.meta.url));

/**
 * 1本あたりの上限。posts が SNS の全履歴を辿って実測 2 分弱なので、
 * その 5 倍を見ておく。ここで切れるのは「相手が応答を止めた」ときだけ。
 */
const STEP_TIMEOUT = 600_000;

/** 拠点の部屋。コミットのメッセージに数を出すのに使う。 */
const ROOMS: readonly string[] = ["会話", "自分", "アイボ", "日記", "投稿", "作業",
  "事典", "プロフィール", "週報"];

/**
 * 道具を1本流す。戻り値は [成功したか, 1行の報告]。
 *
 * 落ちても例外にしない —— 呼び出し側が次の道具へ進めるようにする。
 */
function run(name: string, args: readonly string[]): [boolean, string] {
  // execFileSync ではなく spawnSync を使うのは、**成功したときの stderr が
  // 要る**ため。execFileSync が返すのは stdout だけで、検索のように
  // stderr へ報告する道具は「何も言わずに終わった」ことにされてしまう。
  const done = spawnSync(process.execPath, [join(BIN, `${name}.ts`), ...args], {
    encoding: "utf8",
    timeout: STEP_TIMEOUT,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (done.error) {
    const e = done.error as NodeJS.ErrnoException;
    if (e.code === "ETIMEDOUT") return [false, `${name}: 時間切れ（${STEP_TIMEOUT / 1000}秒）`];
    return [false, `${name}: 起動できない（${e.message}）`];
  }
  if (done.signal === "SIGTERM") {
    return [false, `${name}: 時間切れ（${STEP_TIMEOUT / 1000}秒）`];
  }

  const code = done.status ?? 1;
  const out = (done.stdout ?? "").trim().split("\n").filter(Boolean);
  const err = (done.stderr ?? "").trim().split("\n").filter(Boolean);

  // 報告は stdout から拾うのが基本。ただし **検索だけは stderr** に出す
  // —— 検索結果を `search.ts 語 | grep …` と流したときに、刻み直しの行が
  // 混ざらないようにしてあるため。名前で分岐せず、stdout が空なら stderr、
  // という順で見る。
  let report: string;
  if (out.length) report = out[out.length - 1];
  else if (err.length) report = err[err.length - 1];
  else report = `${name}: 何も言わずに終わった`;

  // posts は「1件取れなかった」でも非ゼロを返す。全部が駄目だったのか
  // 一部なのかは道具自身の1行が語っているので、しくじりの中身だけ足す。
  if (code !== 0 && err.length && err[err.length - 1] !== report) {
    report += ` ／ ${err[err.length - 1]}`;
  }

  return [code === 0, report];
}

/**
 * 拠点で git を呼ぶ。
 *
 * `core.quotepath=false` が要る。既定の git は ASCII でないパスを
 * `"\343\203\227…"` と8進エスケープして返すので、`プロフィール/` で
 * 始まるかを見ても当たらない（部屋の名前を日本語にした回に、変化を
 * ぜんぶ見落とした）。
 */
function git(...args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("git", ["-C", KYOTEN, "-c", "core.quotepath=false", ...args], {
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/**
 * 部屋ごとの、コミット待ちファイル数。
 *
 * `git status --porcelain` は未追跡のディレクトリを1行にまとめるので、
 * `--untracked-files=all` でファイル単位まで開かせる。まとめられたまま
 * 数えると「投稿 1」のような嘘になる。
 *
 * 改名は `R  <前> -> <後>` の1行で来る。前だけ見ると、部屋ごと名前を
 * 変えた回に「変化なし」と言ってコミットを飛ばす（実際にそうなった）。
 * 矢印があれば後ろを取る。
 */
function counted(): Map<string, number> {
  const done = git("status", "--porcelain", "--untracked-files=all");
  const counts = new Map<string, number>();
  if (done.code !== 0) return counts;

  for (const line of done.stdout.split("\n")) {
    const body = line.slice(3);
    const arrow = body.indexOf(" -> ");
    const path = (arrow < 0 ? body : body.slice(arrow + 4)).trim().replace(/^"|"$/g, "");
    for (const room of ROOMS) {
      if (path.startsWith(`${room}/`)) {
        counts.set(room, (counts.get(room) ?? 0) + 1);
        break;
      }
    }
  }
  return counts;
}

/** 拠点を git commit する。 */
function commit(dryRun: boolean): [boolean, string] {
  if (!existsSync(join(KYOTEN, ".git"))) {
    return [true, "記録: 拠点は git ではないので何もしない"];
  }

  const counts = counted();
  if (!counts.size) return [true, "記録: 変化なし"];

  const summary = ROOMS.filter((room) => counts.has(room))
    .map((room) => `${room} ${counts.get(room)}`)
    .join("・");

  if (dryRun) return [true, `記録: ${summary}（書かずに確認）`];

  const add = git("add", "-A");
  if (add.code !== 0) {
    return [false, `記録: add に失敗（${add.stderr.trim().split("\n").at(-1) ?? ""}）`];
  }

  const done = git("commit", "-m", `記録: ${summary}`);
  if (done.code !== 0) {
    const tail = done.stdout.trim().split("\n").at(-1) ??
      done.stderr.trim().split("\n").at(-1) ?? "";
    return [false, `記録: commit に失敗（${tail}）`];
  }

  return [true, `記録: ${summary}`];
}

function main(): number {
  const args = parseArgs(process.argv.slice(2), ["dry-run", "no-commit"]);
  const common = ["--quiet", ...(args.flags["dry-run"] ? ["--dry-run"] : [])];

  // 順番に意味がある。事典・プロフィール・週報・推移は拠点に書かれたもの
  // （会話・自分・投稿・作業）を素材に畳むので、1階を全部書き終えたあとに
  // 回す。推移は週報の scan/fold を借りるので、週報の次。
  const steps: [string, string[]][] = [
    ["sessions", common],
    ["me", common],
    ["aibo", common],
    ["posts", common],
    ["work", common],
    ["entities", common],
    ["profile", common],
    ["weekly", common],
    ["trend", common],
    // 日記は素材が全部そろってから。中で `claude` を呼ぶので、ここだけ
    // 外に出ていく（相手は API で、拠点の外へ書きはしない）。
    ["diary", common],
    // 出来事は日記まで読むので、いちばん最後。上限を付けてあるのは、
    // 書けていない月が溜まっていても夜が1時間走らないようにするため
    // （追記のみなので、次の便が続きから積む）
    ["events", [...common, "--limit", "12"]],
  ];
  // 索引は素材が新しければ検索時に自分で刻み直すが、そのぶん最初の
  // 1回を人が待つことになる。夜のうちに刻んでおく。--dry-run のときは
  // 素材が増えていないので触らない。
  if (!args.flags["dry-run"]) steps.push(["search", ["--rebuild", "--quiet"]]);

  const failed: string[] = [];
  for (const [name, argv] of steps) {
    const [ok, report] = run(name, argv);
    console.log(report);
    if (!ok) failed.push(name);
  }

  if (!args.flags["no-commit"]) {
    const [ok, report] = commit(args.flags["dry-run"]);
    console.log(report);
    if (!ok) failed.push("記録");
  }

  if (failed.length) {
    console.error(`しくじり: ${failed.join("・")}`);
    return 1;
  }
  return 0;
}

process.exit(main());
