#!/usr/bin/env node
/**
 * work — 作ったもの・詰まったこと
 *
 * その日に何を作り、どこで詰まったかを日ごとに束ねる。
 *
 * 素材は2つ:
 *
 *   - **git** —— `~/ghq` 配下の全リポジトリから、自分のコミット。
 *     「何を作ったか」はコミットが一番正確で、しかも全部自分が書いた
 *     メッセージなので嘘がない。
 *   - **会話ログ** —— 失敗した道具呼び出し（`is_error` の tool_result）。
 *     コミットに残らない試行錯誤のうち、機械が確実に拾えるのはここだけ。
 *
 * 出力は `作業/<YYYY-MM>/<YYYY-MM-DD>.md`。プロジェクトごとに
 * 「つくった / さわった / つまずいた」の3つに分ける。
 *
 * 原則:
 *   - 決定論的: 同じ入力なら必ず同じ出力。コミット日時は JST 固定で読む
 *     （読む側のタイムゾーンで日付が変わると、束ねる日が動く）。
 *   - 冪等: 内容が変わらなければファイルに触れない。
 *   - 原文ママ: コミットメッセージもエラーも加工しない。長いものは末尾を
 *     省いて、省いたと書く。
 *
 * 使い方:
 *     work.ts                    # 全部
 *     work.ts --dry-run
 *     work.ts --since 2026-08-01
 *     work.ts --quiet
 */

import { execFileSync } from "node:child_process";
import { existsSync, globSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  CLAUDE_PROJECTS,
  CODEX_SESSIONS,
  KYOTEN,
  clip,
  frontmatter,
  hhmm,
  jst,
  n,
  readJsonl,
  slugFromCwd,
  take,
  writeIfChanged,
  ymd,
  type WriteState,
} from "./util.ts";
import { listFiles, parseArgs, parseSince } from "./cli.ts";

const GHQ = join(homedir(), "ghq");
const ROOM = join(KYOTEN, "作業");

/**
 * 自分のコミットの見分け方。git の --author は複数指定が OR になる。
 * 昔のリポジトリで別のアドレスを使っていても拾えるよう、名前とアドレスの
 * 両方を部分一致で当てる。
 */
const AUTHORS = ["polidog", "mochizuki"];

/**
 * 1日1プロジェクトあたり、並べるファイルの上限。巨大な一括コミット
 * （vendor の取り込みなど）で1日が数千行になるのを避ける。
 */
const FILES_SHOWN = 40;

/** しくじりの中身の上限。原本は jsonl に残る。 */
const TROUBLE_LIMIT = 600;

const STATUS_LABEL: Record<string, string> = {
  A: "新規", D: "削除", R: "改名", C: "複製",
};

/**
 * 道具は失敗を返したが、詰まったわけではないもの。人が「やめておこう」と
 * 言った回は方針が変わった記録であって、つまずきではない。
 */
const NOT_STUCK = [
  "The user doesn't want to proceed",
  "The user doesn't want to take this action",
  "[Request interrupted",
  "Tool ran without output",
];

/** 本当のしくじりの印。これが入っていれば長さを問わず残す。 */
const STUCK_MARKS = ["Traceback (most recent call last)", "<tool_use_error>"];

/**
 * `a && b && c` の途中で 1 つだけこけた回は、出力のほとんどが正常な結果で、
 * 最後に非ゼロが付いているだけ。エラー文だけの応答は短いので、長さで分ける。
 * （実測: 長さとエラー語の 2 つで絞ると 3 日ぶん 117 件が 41 件になり、
 * 残ったのは WebFetch のタイムアウト・SQLite の UNIQUE 制約違反・
 * Python の SyntaxError といった、読み返す価値のあるものだけだった）
 */
const NOISE_LENGTH = 400;

/**
 * しくじりを名乗る言葉。`Exit code 1` が付いていても、中身が普通の出力
 * （`grep` が 1 件も当たらなかった、など）ならつまずきではない。
 */
const ERROR_WORDS = [
  "error", "エラー", "not found", "no such", "failed", "failure",
  "cannot", "can't", "unable", "invalid", "denied", "refused",
  "timeout", "timed out", "fatal:", "not exist", "見つかりません",
];

// ---------------------------------------------------------------- git

interface Commit {
  readonly dt: Date;
  readonly project: string;
  readonly sha: string;
  readonly subject: string;
  readonly files: readonly (readonly [string, string])[];
}

/**
 * ghq の置き場から git リポジトリを拾う。
 *
 * `ghq list` を呼ばないのは、ghq が入っていない場所でも動くようにする
 * ため（原則6・依存を増やさない）。`aibo.ts` も同じ畳み方を借りる。ghq の構造は <host>/<user>/<repo> 固定。
 *
 * **worktree は数えない。** `git worktree add` で作った作業場所は本体と
 * 同じ履歴を持つので、両方を走査すると同じコミットを 2 回数える（実測で
 * 8,320 件のうち 524 件が二重だった。worktree を 1 つ片付けただけで
 * 数字が動いてしまう）。本体の `.git` はディレクトリ、worktree の
 * `.git` はファイルなので、そこで見分ける。
 */
export function repos(): string[] {
  if (!existsSync(GHQ)) return [];
  const found: string[] = [];
  for (const rel of globSync("*/*/*/.git", { cwd: GHQ })) {
    const full = join(GHQ, rel);
    try {
      if (statSync(full).isDirectory()) found.push(dirname(full));
    } catch {
      // 読めないものは飛ばす
    }
  }
  return found.sort();
}

/**
 * そのリポジトリの自分のコミットを、機械が読める形で吐かせる。
 *
 * 日付を `format-local` にしたうえで TZ=Asia/Tokyo を渡すのは決定論の
 * ため。既定の `%ad` はコミットに刻まれたタイムゾーンで表示するので、
 * 出先で打ったコミットが別の日に落ちる。
 */
function gitLog(repo: string, since: string | null): string {
  const args = [
    "-C", repo, "log", "--no-color",
    "--format=%x00%h%x1f%ad%x1f%s", "--date=format-local:%Y-%m-%d %H:%M:%S",
    "--name-status",
  ];
  for (const author of AUTHORS) args.push(`--author=${author}`);
  if (since) args.push(`--since=${since} 00:00:00`);

  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, TZ: "Asia/Tokyo", GIT_PAGER: "cat" },
      // コミットが1つも無いリポジトリで git が "does not have any commits yet"
      // を吐く。拾って捨てないと、定時便のたびに journald へ流れる。
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return "";
  }
}

function* commitsOf(repo: string, since: string | null): Generator<Commit> {
  const project = slugFromCwd(repo);
  for (const block of gitLog(repo, since).split("\0")) {
    if (!block.trim()) continue;
    const nl = block.indexOf("\n");
    const headLine = nl < 0 ? block : block.slice(0, nl);
    const rest = nl < 0 ? "" : block.slice(nl + 1);
    const parts = headLine.split("\x1f");
    if (parts.length !== 3) continue;
    const [sha, stamp, subject] = parts;

    const dt = jst(stamp.replace(" ", "T") + "+09:00");
    if (!dt) continue;

    const files: (readonly [string, string])[] = [];
    for (const line of rest.split("\n")) {
      if (!line.trim()) continue;
      const cols = line.split("\t");
      if (cols.length < 2) continue;
      // 改名は "R100\told\tnew"。新しい方だけ残す。
      files.push([cols[0].slice(0, 1), cols[cols.length - 1]] as const);
    }

    yield { dt, project, sha, subject: subject.trim(), files };
  }
}

// ---------------------------------------------------------------- しくじり

interface Trouble {
  dt: Date;
  project: string;
  readonly tool: string;
  readonly target: string;
  readonly body: string;
  readonly key: string;
}

/**
 * 道具の失敗が「詰まった」に値するか。
 *
 * `is_error` は落ちた合図でしかない。`ls … && wc -l …` のように繋げた
 * コマンドは、前半が正常に出力を返していても最後の 1 つがこければ
 * is_error になる。それを全部書き写すと、作業が端末のログになって
 * 読み返せなくなる。
 */
function looksStuck(body: string): boolean {
  if (STUCK_MARKS.some((m) => body.includes(m))) return true;
  if ([...body].length > NOISE_LENGTH) return false;
  const low = body.toLowerCase();
  return ERROR_WORDS.some((w) => low.includes(w));
}

/**
 * 道具の呼び出しから「何に対して」だけを取り出す。
 *
 * 入力を丸ごと残すと、拠点に API キーの入ったコマンドが写りかねない。
 * ここで見るのは Bash のコマンドとファイルのパスだけにする。
 */
function targetOf(inputs: unknown): string {
  if (!inputs || typeof inputs !== "object") return "";
  const args = inputs as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "url"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * 失敗した道具呼び出しを拾う。
 *
 * `tool_use` と `tool_result` は別の行に出るので、先に id → 呼び出しの
 * 表を作ってから結果を見る。
 */
function* troublesFrom(path: string): Generator<Trouble> {
  const calls = new Map<string, readonly [string, string]>();
  const rows = [...readJsonl(path)];

  for (const row of rows) {
    const message = row.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const raw of content) {
      if (!raw || typeof raw !== "object") continue;
      const block = raw as Record<string, unknown>;
      if (block.type === "tool_use") {
        calls.set(String(block.id), [
          typeof block.name === "string" && block.name ? block.name : "?",
          targetOf(block.input ?? {}),
        ] as const);
      }
    }
  }

  for (const row of rows) {
    if (row.isSidechain) continue;
    const message = row.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) continue;

    for (const raw of content) {
      if (!raw || typeof raw !== "object") continue;
      const block = raw as Record<string, unknown>;
      if (block.type !== "tool_result" || !block.is_error) continue;

      const [tool, target] = calls.get(String(block.tool_use_id)) ?? ["?", ""];
      let body: unknown = block.content;
      if (Array.isArray(body)) {
        body = body
          .filter(
            (b): b is Record<string, unknown> =>
              !!b && typeof b === "object" && (b as Record<string, unknown>).type === "text",
          )
          .map((b) => (typeof b.text === "string" ? b.text : ""))
          .join("\n");
      }
      const text = String(body ?? "").trim();
      if (!text || NOT_STUCK.some((p) => text.startsWith(p)) || !looksStuck(text)) continue;

      const dt = jst(row.timestamp as string | undefined);
      if (!dt) continue;

      yield {
        dt,
        project: slugFromCwd(row.cwd as string | undefined),
        tool,
        target,
        body: text,
        key: String(block.tool_use_id ?? `${dt.toISOString()}:${target}`),
      };
    }
  }
}

/**
 * Codex のしくじりを拾う。
 *
 * Claude Code は「道具が失敗した」という一点しか教えてくれないが、Codex は
 * `status: "failed"` と `exit_code` を明示するので、落ちた合図はこちらのほうが
 * 確実。ただし **`exit_code` が非ゼロでも中身は普通の出力**ということは同じ
 * ように起きる（`a | b` の後半だけこけた回など）ので、絞り込みは Claude Code と
 * 同じ `looksStuck()` を通す。
 *
 * 見る本文は stderr が先。空なら aggregated_output に落ちる（実測では
 * stderr が空で出力だけあるものが多い）。`Exit code N` を頭に付けるのは、
 * Claude Code 側の tool_result がその形で来るのに揃えるため。
 */
function* troublesFromCodex(path: string): Generator<Trouble> {
  let cwd = "";
  let session = "";

  for (const row of readJsonl(path)) {
    const payload = (row.payload as Record<string, unknown> | undefined) ?? {};

    if (row.type === "session_meta") {
      cwd = String(payload.cwd ?? "") || cwd;
      session = String(payload.session_id ?? payload.id ?? "") || session;
      continue;
    }
    if (row.type !== "event_msg") continue;
    if (!payload.item || typeof payload.item !== "object") continue;
    const item = payload.item as Record<string, unknown>;

    let tool = "";
    let target = "";
    let body = "";

    if (item.type === "CommandExecution") {
      const code = item.exit_code;
      if (item.status !== "failed" && (code === 0 || code == null)) continue;
      tool = "CommandExecution";
      const raw = item.command;
      target = (typeof raw === "string" ? raw : raw == null ? "" : JSON.stringify(raw)).trim();
      const out = String(item.stderr ?? "").trim() || String(item.aggregated_output ?? "").trim();
      body = `Exit code ${code ?? "?"}` + (out ? `\n${out}` : "");
    } else if (item.type === "McpToolCall") {
      if (item.status !== "failed") continue;
      tool = `${String(item.server ?? "?")}.${String(item.tool ?? "?")}`;
      target = "";
      const err = item.error;
      body = (typeof err === "string" ? err : err == null ? "" : JSON.stringify(err)).trim();
      if (!body) body = "（失敗したが中身が無い）";
    } else {
      continue;
    }

    if (NOT_STUCK.some((prefix) => body.startsWith(prefix)) || !looksStuck(body)) continue;

    const dt = jst(row.timestamp as string | undefined);
    if (!dt) continue;

    yield {
      dt,
      project: slugFromCwd(cwd),
      tool,
      target,
      body,
      // Codex の item id はセッションの中で一意。--resume で同じログが
      // 分かれても二重に数えないよう、セッションと組にする。
      key: `codex:${session}:${String(item.id ?? `${dt.toISOString()}:${target}`)}`,
    };
  }
}

/**
 * サブディレクトリで作業していた回を、リポジトリ 1 つに丸める。
 *
 * `slugFromCwd()` は cwd をそのまま名前にするので、モノレポの中で
 * `apps/web` に降りて作業した日は `<repo>/apps/web` という別のプロジェクト
 * に見える。git 側は常にリポジトリのルートを名乗るので、放っておくと
 * 「つくった」と「つまずいた」が同じ日の別々の見出しに割れる。
 */
export function fold(slug: string, known: ReadonlySet<string>): string {
  if (known.has(slug)) return slug;
  const parts = slug.split("/");
  for (let i = parts.length - 1; i > 0; i--) {
    const head = parts.slice(0, i).join("/");
    if (known.has(head)) return head;
  }
  return slug;
}

// ---------------------------------------------------------------- 束ねる

function renderDay(
  date: string,
  commits: readonly Commit[],
  troubles: readonly Trouble[],
): string {
  const projects: string[] = [];
  for (const item of [...commits, ...troubles]) {
    if (!projects.includes(item.project)) projects.push(item.project);
  }
  projects.sort();

  const body: string[] = [];
  for (const project of projects) {
    const mine = commits.filter((c) => c.project === project);
    const stuck = troubles.filter((t) => t.project === project);
    const block: string[] = [`## ${project}`];

    if (mine.length) {
      block.push("### つくった");
      block.push(mine.map((c) => `- \`${c.sha}\` ${c.subject}`).join("\n"));

      // ファイルはコミットをまたいで1つにまとめる。同じファイルを
      // 何度も直した日に、同じ行が並ぶのを避ける。
      const touched = new Map<string, string>();
      for (const commit of mine) {
        for (const [status, path] of commit.files) {
          if (!touched.has(path)) touched.set(path, status);
        }
      }
      if (touched.size) {
        const all = [...touched.keys()].sort();
        const lines = all.slice(0, FILES_SHOWN).map((path) => {
          const label = STATUS_LABEL[touched.get(path)!] ?? "";
          return `- \`${path}\`` + (label ? `（${label}）` : "");
        });
        if (touched.size > FILES_SHOWN) {
          lines.push(`- … ほか ${touched.size - FILES_SHOWN} ファイル`);
        }
        block.push("### さわった");
        block.push(lines.join("\n"));
      }
    }

    if (stuck.length) {
      block.push("### つまずいた");
      const lines: string[] = [];
      for (const trouble of stuck) {
        let head = `- ${hhmm(trouble.dt)} ${trouble.tool}`;
        if (trouble.target) {
          head += ` \`${take(trouble.target.split("\n")[0], 120)}\``;
        }
        lines.push(head);
        const text = clip(trouble.body, TROUBLE_LIMIT);
        lines.push(text.split("\n").map((s) => "  " + s).join("\n"));
      }
      block.push(lines.join("\n\n"));
    }

    body.push(block.join("\n\n"));
  }

  const head = frontmatter({
    room: "作業",
    date,
    commits: commits.length,
    troubles: troubles.length,
    projects: projects.join(", "),
  });
  return head + `\n\n# ${date} の作業\n\n` + body.join("\n\n") + "\n";
}

// ---------------------------------------------------------------- 入口

function main(): number {
  const args = parseArgs(process.argv.slice(2), ["dry-run", "quiet"], ["since"]);
  const since = parseSince(args.values.since);
  if (since === undefined) return 2;

  const allRepos = repos();
  const daysCommits = new Map<string, Commit[]>();
  let found = 0;

  for (const repo of allRepos) {
    for (const commit of commitsOf(repo, args.values.since ?? null)) {
      const date = ymd(commit.dt);
      if (since && date < since) continue;
      const list = daysCommits.get(date);
      if (list) list.push(commit);
      else daysCommits.set(date, [commit]);
      found += 1;
    }
  }

  const known = new Set(allRepos.map((r) => slugFromCwd(r)));
  const daysTroubles = new Map<string, Trouble[]>();
  const seen = new Set<string>();
  let failed = 0;

  const logs: [string, (p: string) => Generator<Trouble>][] = [];
  if (existsSync(CLAUDE_PROJECTS)) {
    for (const p of listFiles(CLAUDE_PROJECTS, ".jsonl")) logs.push([p, troublesFrom]);
  }
  if (existsSync(CODEX_SESSIONS)) {
    for (const p of listFiles(CODEX_SESSIONS, ".jsonl")) logs.push([p, troublesFromCodex]);
  }

  {
    for (const [path, pull] of logs) {
      let items: Trouble[];
      try {
        items = [...pull(path)];
      } catch (err) {
        // 1ファイルの失敗で全体を止めない
        failed += 1;
        console.error(`  ✗ ${basename(path)}: ${(err as Error).message}`);
        continue;
      }
      for (const trouble of items) {
        if (seen.has(trouble.key)) continue;
        seen.add(trouble.key);
        const date = ymd(trouble.dt);
        if (since && date < since) continue;
        trouble.project = fold(trouble.project, known);
        const list = daysTroubles.get(date);
        if (list) list.push(trouble);
        else daysTroubles.set(date, [trouble]);
      }
    }
  }

  const stats: Record<WriteState, number> = { new: 0, updated: 0, same: 0 };
  const dates = [...new Set([...daysCommits.keys(), ...daysTroubles.keys()])].sort();

  for (const date of dates) {
    const commits = (daysCommits.get(date) ?? []).sort((a, b) =>
      a.dt.getTime() !== b.dt.getTime() ? a.dt.getTime() - b.dt.getTime()
        : a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0,
    );
    const troubles = (daysTroubles.get(date) ?? []).sort((a, b) => {
      if (a.dt.getTime() !== b.dt.getTime()) return a.dt.getTime() - b.dt.getTime();
      if (a.tool !== b.tool) return a.tool < b.tool ? -1 : 1;
      return a.target < b.target ? -1 : a.target > b.target ? 1 : 0;
    });
    const out = join(ROOM, date.slice(0, 7), `${date}.md`);
    stats[writeIfChanged(out, renderDay(date, commits, troubles), args.flags["dry-run"])] += 1;
  }

  const nDays = stats.new + stats.updated + stats.same;
  const nTroubles = [...daysTroubles.values()].reduce((a, v) => a + v.length, 0);

  if (args.flags.quiet) {
    console.log(
      `work: ${nDays}日 (new ${stats.new} / upd ${stats.updated} ` +
        `/ same ${stats.same}) つくった ${n(found)} つまずいた ${n(nTroubles)}`,
    );
  } else {
    if (args.flags["dry-run"]) console.log("（書かずに確認）");
    console.log(`  作業         : ${n(nDays)} 日ぶん`);
    console.log(`    あたらしい : ${n(stats.new)}`);
    console.log(`    かきかえ   : ${n(stats.updated)}`);
    console.log(`    かわらず   : ${n(stats.same)}`);
    console.log(`  つくった     : ${n(found)} コミット（${n(allRepos.length)} リポジトリ）`);
    console.log(`  つまずいた   : ${n(nTroubles)}`);
    if (failed) console.log(`    しっぱい   : ${n(failed)}`);
    console.log(`  ばしょ : ${ROOM}`);
  }

  return failed ? 1 : 0;
}

/** 畳む相手の一覧。`aibo.ts` が `fold()` と組で借りる。 */
export function knownProjects(): ReadonlySet<string> {
  return new Set(repos().map((r) => slugFromCwd(r)));
}

// `aibo.ts` が repos/fold を借りるので、素で import しても走らせない
// （守らないと import した瞬間に 857 日ぶんを書き直しにいく）
if (import.meta.main) process.exit(main());
