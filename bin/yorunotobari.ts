#!/usr/bin/env node
/**
 * yorunotobari — よるのとばり（定時便）
 *
 * 盗賊が夜のうちに拾って回る。utsushi・kotonoha・sotonokoe・teato・fukuro・
 * status・otsuge・uwasa を順に流し、ルーラを刻み直して、拠点をきょうかい
 * （git commit）する。systemd user timer から呼ばれる。
 *
 * 掟:
 *   - **1つが失敗しても次へ進む。** 取りに行く先が落ちている日でも、
 *     手元のログからの写しは進められる。全部やってから、失敗があれば
 *     非ゼロで終わる（systemd の failed として残す）。
 *   - **変化が無ければコミットしない。** 何も起きなかった日に空の
 *     きょうかいを積まない。
 *   - 拠点の中身は出力しない。journald に会話原文が漏れる。
 *
 * 使い方:
 *     yorunotobari.ts             # 全部流す
 *     yorunotobari.ts --dry-run   # 書かずに、コミットもせずに流す
 *     yorunotobari.ts --no-commit # 集めるけどきょうかいはしない
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { KYOTEN } from "./dougu.ts";
import { parseArgs } from "./cli.ts";

const BIN = dirname(fileURLToPath(import.meta.url));

/**
 * 1本あたりの上限。sotonokoe が SNS の全履歴を辿って実測 2 分弱なので、
 * その 5 倍を見ておく。ここで切れるのは「相手が応答を止めた」ときだけ。
 */
const STEP_TIMEOUT = 600_000;

/** 拠点の部屋と、きょうかいのメッセージに出す呼び名。 */
const ROOMS: [string, string][] = [
  ["bouken", "ぼうけんのしょ"],
  ["kotonoha", "ことのは"],
  ["soto", "そとのこえ"],
  ["teato", "てのあと"],
  ["fukuro", "ふくろ"],
  ["status", "ステータス"],
  ["otsuge", "おつげ"],
  ["uwasa", "まちのうわさ"],
];

/**
 * 道具を1本流す。戻り値は [成功したか, 1行の報告]。
 *
 * 落ちても例外にしない —— 呼び出し側が次の道具へ進めるようにする。
 */
function run(name: string, args: readonly string[]): [boolean, string] {
  // execFileSync ではなく spawnSync を使うのは、**成功したときの stderr が
  // 要る**ため。execFileSync が返すのは stdout だけで、ルーラのように
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

  // 報告は stdout から拾うのが基本。ただし **ルーラだけは stderr** に出す
  // —— 検索結果を `ruula.ts 語 | grep …` と流したときに、刻み直しの行が
  // 混ざらないようにしてあるため。名前で分岐せず、stdout が空なら stderr、
  // という順で見る。
  let report: string;
  if (out.length) report = out[out.length - 1];
  else if (err.length) report = err[err.length - 1];
  else report = `${name}: 何も言わずに終わった`;

  // sotonokoe は「1件取れなかった」でも非ゼロを返す。全部が駄目だったのか
  // 一部なのかは道具自身の1行が語っているので、しくじりの中身だけ足す。
  if (code !== 0 && err.length && err[err.length - 1] !== report) {
    report += ` ／ ${err[err.length - 1]}`;
  }

  return [code === 0, report];
}

function git(...args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("git", ["-C", KYOTEN, ...args], {
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
 * 部屋ごとの、きょうかい待ちファイル数。
 *
 * `git status --porcelain` は未追跡のディレクトリを1行にまとめるので、
 * `--untracked-files=all` でファイル単位まで開かせる。まとめられたまま
 * 数えると「そとのこえ 1」のような嘘になる。
 */
function counted(): Map<string, number> {
  const done = git("status", "--porcelain", "--untracked-files=all");
  const counts = new Map<string, number>();
  if (done.code !== 0) return counts;

  for (const line of done.stdout.split("\n")) {
    const path = line.slice(3).trim().replace(/^"|"$/g, "");
    for (const [room] of ROOMS) {
      if (path.startsWith(`${room}/`)) {
        counts.set(room, (counts.get(room) ?? 0) + 1);
        break;
      }
    }
  }
  return counts;
}

/** 拠点をきょうかいする（git commit）。 */
function kyoukai(dryRun: boolean): [boolean, string] {
  if (!existsSync(join(KYOTEN, ".git"))) {
    return [true, "きょうかい: 拠点は git ではないので何もしない"];
  }

  const counts = counted();
  if (!counts.size) return [true, "きょうかい: 変化なし"];

  const summary = ROOMS.filter(([room]) => counts.has(room))
    .map(([room, label]) => `${label} ${counts.get(room)}`)
    .join("・");

  if (dryRun) return [true, `きょうかい: ${summary}（書かずに確認）`];

  const add = git("add", "-A");
  if (add.code !== 0) {
    return [false, `きょうかい: add に失敗（${add.stderr.trim().split("\n").at(-1) ?? ""}）`];
  }

  const commit = git("commit", "-m", `きょうかい: ${summary}`);
  if (commit.code !== 0) {
    const tail = commit.stdout.trim().split("\n").at(-1) ??
      commit.stderr.trim().split("\n").at(-1) ?? "";
    return [false, `きょうかい: commit に失敗（${tail}）`];
  }

  return [true, `きょうかい: ${summary}`];
}

function main(): number {
  const args = parseArgs(process.argv.slice(2), ["dry-run", "no-commit"]);
  const common = ["--quiet", ...(args.flags["dry-run"] ? ["--dry-run"] : [])];

  // 順番に意味がある。ふくろ・ステータス・おつげは拠点に書かれたもの
  // （ぼうけんのしょ・ことのは・そとのこえ・てのあと）を素材に畳むので、
  // 1階を全部書き終えたあとに回す。
  const steps: [string, string[]][] = [
    ["utsushi", common],
    ["kotonoha", common],
    ["sotonokoe", common],
    ["teato", common],
    ["fukuro", common],
    ["status", common],
    ["otsuge", common],
    ["uwasa", common],
  ];
  // ルーラは素材が新しければ検索時に自分で刻み直すが、そのぶん最初の
  // 1回を人が待つことになる。夜のうちに刻んでおく。--dry-run のときは
  // 素材が増えていないので触らない。
  if (!args.flags["dry-run"]) steps.push(["ruula", ["--rebuild", "--quiet"]]);

  const failed: string[] = [];
  for (const [name, argv] of steps) {
    const [ok, report] = run(name, argv);
    console.log(report);
    if (!ok) failed.push(name);
  }

  if (!args.flags["no-commit"]) {
    const [ok, report] = kyoukai(args.flags["dry-run"]);
    console.log(report);
    if (!ok) failed.push("きょうかい");
  }

  if (failed.length) {
    console.error(`しくじり: ${failed.join("・")}`);
    return 1;
  }
  return 0;
}

process.exit(main());
