#!/usr/bin/env node
/**
 * me — polidog の発言だけを抜き出す
 *
 * Claude Code と Codex の jsonl から polidog 本人の発話だけを拾い、
 * 日付ごとに時系列で束ねる。`会話/` の整形には依存せず、
 * 原本の jsonl から直接抜く。
 *
 * 原則:
 *   - 決定論的: 同じ入力なら必ず同じ出力。生成日時などの揺れる値は書かない。
 *   - 冪等: 内容が変わらなければファイルに触れない (mtime も動かさない)。
 *   - 原文ママ: 発話は加工しない。
 *
 * 使い方:
 *     me.ts                 # 全部を抜く
 *     me.ts --dry-run       # 書かずに結果だけ
 *     me.ts --since 2026-08-01
 *     me.ts --quiet         # 1行だけ（定時便用）
 *     me.ts --collect-only  # 素材に落とすだけ（母艦でない機械）
 *     me.ts --fold-only     # 素材から畳むだけ
 *
 * 拠点を複数の PC で共有するため、2段になっている（`machine.ts` を見る）:
 *
 *     手元の jsonl  →  素材/<hostname>/自分/…json   （集める・機械ごと）
 *     素材/ * /自分/ →  自分/…md                     （畳む・拠点だけ）
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  CLAUDE_PROJECTS,
  CODEX_SESSIONS,
  KYOTEN,
  asText,
  clip,
  frontmatter,
  hhmm,
  isoJst,
  jst,
  n,
  readJsonl,
  slugFromCwd,
  writeIfChanged,
  ymd,
  ym,
  type WriteState,
} from "./util.ts";
import { listFiles, parseArgs, parseSince } from "./cli.ts";
import { fleetNote, markCollected, readSozai, writeSozai } from "./machine.ts";

/** 発話がこれを超えたら省略する。原本は jsonl に残る */
const TEXT_LIMIT = 200_000;

// ---------------------------------------------------------------- 混入の見分け
//
// 実測 (ログ全走査) で分かったこと。「ユーザー行」には本人の発話でないものが
// 大量に混ざる。フラグで落ちるものはフラグで落とし、フラグの無い古いログだけ
// 文面で落とす。文面判定は最後の砦であって、第一の関門ではない。
//
//   isMeta=True              スキル本文の注入・画像プレースホルダ・caveat (計 230)
//   isCompactSummary=True    "This session is being continued from…" (計 6)
//   origin.kind=task-notification / promptSource=system
//                            サブエージェント完了通知 (計 170)
//   isSidechain=True         サブエージェント側の会話
//
// 残るのは promptSource=typed / queued の本人発話 (計 442) と、
// フラグを持たない古い版の行。後者は下の前置きで落とす。

const MACHINE_PREFIXES = [
  "<task-notification>",
  "<local-command-caveat>",
  "<local-command-stdout>",
  "<system-reminder>",
  "[Request interrupted",
  "[Image:",
  "Caveat: The messages below",
  "This session is being continued from",
  "Base directory for this skill:",
  // Codex: 承認判定用に Codex 自身が投げる内部プロンプト
  "The following is the Codex agent history",
  // Codex: クラッシュ通知から起動される diagnose-crash スキルの定型文
  "A process crashed on this Omarchy machine",
];

// <command-name>/clear</command-name> のようなスラッシュコマンド呼び出し。
// コマンド名だけのもの (/clear /compact /model) は道具の操作であって発話ではない。
// ただし <command-args> に中身があるとき、それは本人が打った言葉なので拾う。
const RE_COMMAND_NAME = /<command-name>([^<]*)<\/command-name>/;
const RE_COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;

export function isMachine(text: string): boolean {
  return MACHINE_PREFIXES.some((p) => text.startsWith(p));
}

/**
 * フラグで落とせるものを落とす。**文面を見る前の関門**。
 *
 * 「ユーザー行」には本人の入力でないものが大量に混ざる（実測 1,066 行の
 * うち本人は約 550）。ここを通ったものだけが本人の発話の候補になる。
 * 数える道具が増えても同じ関門を通すため、外から呼べるようにしてある。
 */
export function looksMine(row: Record<string, unknown>): boolean {
  if (row.type !== "user") return false;
  if (row.isSidechain || row.isMeta || row.isCompactSummary) return false;
  const origin = row.origin as Record<string, unknown> | undefined;
  if (origin && origin.kind === "task-notification") return false;
  if (row.promptSource === "system") return false;
  return true;
}

/**
 * スラッシュコマンド行なら [コマンド名, 本人が打った引数] を返す。
 * 引数が空なら null。
 */
export function unwrapCommand(text: string): [string, string] | null {
  const name = RE_COMMAND_NAME.exec(text);
  const args = RE_COMMAND_ARGS.exec(text);
  const body = args ? args[1].trim() : "";
  if (!body) return null;
  return [name ? name[1].trim() : "", body];
}

// ---------------------------------------------------------------- 抜き出し

interface Utterance {
  readonly dt: Date;
  readonly project: string;
  readonly source: string;
  readonly command: string;
  readonly text: string;
  readonly key: string;
}

function digest(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex").slice(0, 12);
}

/** 並び順は Python 版の sort_key と同じ (dt, project, source, command, text)。 */
function compare(a: Utterance, b: Utterance): number {
  if (a.dt.getTime() !== b.dt.getTime()) return a.dt.getTime() - b.dt.getTime();
  // `key` まで見るのは、複数の機械から素材を集めたときに順が揺れないため。
  // 以前は 4 項目で同点になったら「読み込んだ順」で決まっていて、それは
  // jsonl を舐める順（＝その機械のファイル配置）に依っていた。
  for (const key of ["project", "source", "command", "text", "key"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return 0;
}

function pick(row: Record<string, unknown>, key: string): unknown {
  return row[key];
}

/** Claude Code の jsonl から本人の発話だけ拾う。 */
function* fromClaude(path: string): Generator<Utterance> {
  for (const row of readJsonl(path)) {
    if (!looksMine(row)) continue;

    const message = row.message as Record<string, unknown> | undefined;
    // tool_result はユーザー行として流れてくる。asText は text ブロックだけ拾う
    let text = asText(message?.content).trim();
    if (!text || isMachine(text)) continue;

    let command = "";
    if (text.slice(0, 400).includes("<command-name>")) {
      const unwrapped = unwrapCommand(text);
      if (unwrapped === null) continue; // /clear /compact など、引数なしの道具操作
      [command, text] = unwrapped;
      if (isMachine(text)) continue;
    }

    const dt = jst(row.timestamp as string | undefined);
    if (!dt) continue;
    const project = slugFromCwd(row.cwd as string | undefined);
    const key = (pick(row, "uuid") as string | undefined) ??
      `${dt.toISOString()}:${project}:${digest(text)}`;
    yield { dt, project, source: "claude-code", command, text, key };
  }
}

/**
 * Codex の jsonl から本人の発話だけ拾う。
 *
 * 2系統ある。item.type == "UserMessage" (content はブロック配列) と、
 * payload.type == "user_message" (本文は message)。後者は実測すべて
 * Codex 内部の承認判定プロンプトだったが、系統ごと落とさず文面で落とす。
 */
function* fromCodex(path: string): Generator<Utterance> {
  let cwd = "";
  for (const row of readJsonl(path)) {
    const payload = (row.payload as Record<string, unknown> | undefined) ?? {};
    if (row.type === "session_meta") {
      cwd = (payload.cwd as string | undefined) ?? cwd;
      continue;
    }
    if (row.type !== "event_msg") continue;

    const item = payload.item as Record<string, unknown> | undefined;
    let text: string;
    if (item && typeof item === "object" && item.type === "UserMessage") {
      text = asText(item.content ?? item.text).trim();
    } else if (payload.type === "user_message") {
      text = asText(payload.message ?? payload.text).trim();
    } else {
      continue;
    }

    if (!text || isMachine(text)) continue;

    const dt = jst(row.timestamp as string | undefined);
    if (!dt) continue;
    const project = slugFromCwd(cwd);
    yield {
      dt,
      project,
      source: "codex",
      command: "",
      text,
      key: `${dt.toISOString()}:${project}:${digest(text)}`,
    };
  }
}

// ---------------------------------------------------------------- 束ねる

function renderDay(date: string, items: readonly Utterance[]): string {
  const projects: string[] = [];
  const sources: string[] = [];
  const body: string[] = [];

  for (const u of items) {
    if (!projects.includes(u.project)) projects.push(u.project);
    if (!sources.includes(u.source)) sources.push(u.source);
    const label = u.command ? `${u.source} · ${u.command}` : u.source;
    body.push(`## ${hhmm(u.dt)} ${u.project}（${label}）\n\n${clip(u.text, TEXT_LIMIT)}`);
  }

  const head = frontmatter({
    room: "自分",
    date,
    utterances: items.length,
    projects: [...projects].sort().join(", "),
    sources: [...sources].sort().join(", "),
  });
  return head + `\n\n# ${date} の発言\n\n` + body.join("\n\n") + "\n";
}

// ---------------------------------------------------------------- 素材

/**
 * 素材に落とす形。`Utterance` の `dt` は Date なのでそのままでは書けない。
 *
 * 時刻は `isoJst()` の形（`2026-09-04T07:07:31+09:00`）で持つ。これは
 * `jst()` にそのまま渡すと元の Date に戻る —— 拠点の frontmatter と
 * 同じ表記なので、素材を覗いたときにも読める。
 */
interface Wire {
  readonly at: string;
  readonly project: string;
  readonly source: string;
  readonly command: string;
  readonly text: string;
  readonly key: string;
}

function toWire(u: Utterance): Wire {
  return {
    at: isoJst(u.dt),
    project: u.project,
    source: u.source,
    command: u.command,
    text: u.text,
    key: u.key,
  };
}

function fromWire(w: Wire): Utterance | null {
  const dt = jst(w.at);
  if (!dt) return null;
  return {
    dt,
    project: w.project ?? "",
    source: w.source ?? "",
    command: w.command ?? "",
    text: w.text ?? "",
    key: w.key ?? "",
  };
}

/** 手元の jsonl から拾って、`素材/<機械>/自分/` に置く。 */
function collect(since: string | null, dryRun: boolean): [number, number] {
  const jobs: [string, (p: string) => Generator<Utterance>][] = [];
  if (existsSync(CLAUDE_PROJECTS)) {
    for (const p of listFiles(CLAUDE_PROJECTS, ".jsonl")) jobs.push([p, fromClaude]);
  }
  if (existsSync(CODEX_SESSIONS)) {
    for (const p of listFiles(CODEX_SESSIONS, ".jsonl")) jobs.push([p, fromCodex]);
  }

  const seen = new Set<string>();
  const days = new Map<string, Utterance[]>();
  let failed = 0;

  for (const [src, pull] of jobs) {
    let found: Utterance[];
    try {
      found = [...pull(src)];
    } catch (err) {
      // 1ファイルの失敗で全体を止めない
      failed += 1;
      console.error(`  ✗ ${src.split("/").at(-1)}: ${(err as Error).message}`);
      continue;
    }
    for (const u of found) {
      // --resume で同じ発話が別ファイルに写ることがある。1回だけ数える
      if (seen.has(u.key)) continue;
      seen.add(u.key);
      const date = ymd(u.dt);
      if (since && date < since) continue;
      const list = days.get(date);
      if (list) list.push(u);
      else days.set(date, [u]);
    }
  }

  for (const date of [...days.keys()].sort()) {
    writeSozai("自分", date, days.get(date)!.sort(compare).map(toWire), dryRun);
  }
  markCollected(dryRun);
  return [days.size, failed];
}

/** 全機械ぶんの素材を畳んで `自分/` に置く。ここは拠点しか見ない。 */
function fold(since: string | null, dryRun: boolean): [Record<WriteState, number>, number] {
  const stats: Record<WriteState, number> = { new: 0, updated: 0, same: 0 };
  const days = readSozai<Wire>("自分");
  let total = 0;

  for (const date of [...days.keys()].sort()) {
    if (since && date < since) continue;
    // 同じセッションが2台に写っていても1回だけ数える（機械名の昇順で先勝ち）
    const seen = new Set<string>();
    const items: Utterance[] = [];
    for (const w of days.get(date)!) {
      const u = fromWire(w);
      if (!u) continue;
      if (u.key && seen.has(u.key)) continue;
      if (u.key) seen.add(u.key);
      items.push(u);
    }
    items.sort(compare);
    const out = join(KYOTEN, "自分", date.slice(0, 7), `${date}.md`);
    stats[writeIfChanged(out, renderDay(date, items), dryRun)] += 1;
    total += items.length;
  }
  return [stats, total];
}

function main(): number {
  const args = parseArgs(
    process.argv.slice(2),
    ["dry-run", "quiet", "collect-only", "fold-only"],
    ["since"],
  );
  const since = parseSince(args.values.since);
  if (since === undefined) return 2;
  const dryRun = args.flags["dry-run"];

  let failed = 0;
  let gathered = 0;
  if (!args.flags["fold-only"]) [gathered, failed] = collect(since, dryRun);

  if (args.flags["collect-only"]) {
    if (args.flags.quiet) console.log(`me: 集めた ${n(gathered)}日ぶん（畳まない）`);
    else {
      if (dryRun) console.log("（書かずに確認）");
      console.log(`  素材（自分） : ${n(gathered)} 日ぶん`);
      console.log(`  ばしょ : ${join(KYOTEN, "素材")}`);
    }
    return failed ? 1 : 0;
  }

  const [stats, total] = fold(since, dryRun);
  const nDays = stats.new + stats.updated + stats.same;

  if (args.flags.quiet) {
    console.log(
      `me: ${nDays}日 (new ${stats.new} / upd ${stats.updated} ` +
        `/ same ${stats.same}) 発言 ${n(total)} ${fleetNote()}`,
    );
  } else {
    if (dryRun) console.log("（書かずに確認）");
    console.log(`  自分         : ${n(nDays)} 日ぶん`);
    console.log(`    あたらしい : ${n(stats.new)}`);
    console.log(`    かきかえ   : ${n(stats.updated)}`);
    console.log(`    かわらず   : ${n(stats.same)}`);
    if (failed) console.log(`    しっぱい   : ${n(failed)}`);
    console.log(`  はつげん     : ${n(total)}`);
    console.log(`  ${fleetNote()}`);
    console.log(`  ばしょ : ${join(KYOTEN, "自分")}`);
  }

  return failed ? 1 : 0;
}

// 数える道具が looksMine/isMachine を借りるので、素で import しても走らせない
if (import.meta.main) process.exit(main());
