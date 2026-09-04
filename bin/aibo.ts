#!/usr/bin/env node
/**
 * aibo — アイボの行動記録（AI が何をしたか）
 *
 * `me.ts` の鏡像。あちらが polidog の発言だけを抜くなら、こちらは
 * **AI 側が何をしたか**を日ごとに束ねる。相棒は隣の眼なので、自分が何を
 * したかを持っていないとただの鏡になる。
 *
 * ## 発言の原文は写さない
 *
 * assistant の発言は実測 3,143 ブロック / 890,227 文字あるが、**全部
 * `会話/` に入っている**。ここへ写すと索引に同じ文が二重に載り、検索の
 * たびに同じものが2回出る。だからここが持つのは、`会話/` にも `作業/` にも
 * 無いものだけ:
 *
 *   - どれだけ動いたか（会話・発言・道具・モデルの内訳）
 *   - 手下（サブエージェント）を何回出して、向こうで何をしたか
 *   - **やったこと** —— 道具に付いている札
 *
 * 札は実測で 95% の呼び出しに付いている（`description` 84% ＋ パス 11%、
 * 平均 27 文字）。しかも AI 自身が書いた要約なので、生のコマンドより短く、
 * API キーの類が写り込む心配もない（生のコマンドは `会話/` にある）。
 *
 * 原文が要るときは `search.ts` で `会話/` を引く。
 *
 * 原則:
 *   - 決定論的: 同じ入力なら必ず同じ出力。
 *   - 冪等: 内容が変わらなければファイルに触れない。
 *   - 原文ママ: 札は加工しない。長いものだけ切る。
 *
 * 使い方:
 *     aibo.ts                 # 全部
 *     aibo.ts --dry-run       # 書かずに結果だけ
 *     aibo.ts --since 2026-08-01
 *     aibo.ts --quiet         # 1行だけ（定時便用）
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  CLAUDE_PROJECTS,
  CODEX_SESSIONS,
  KYOTEN,
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
import { fold, knownProjects } from "./work.ts";

const ROOM = join(KYOTEN, "アイボ");

/**
 * 1日1プロジェクトあたり、並べる「やったこと」の上限。
 *
 * 実測でいちばん多い日が 2,007 回。全部並べると1日 60KB を超えて読めない
 * （`work.ts` の `FILES_SHOWN` と同じ考え方）。全部の記録は `会話/` にある。
 */
const DEEDS_SHOWN = 60;

/** 札の長さの上限。平均 27 文字なので、まず切れない。 */
const LABEL_LIMIT = 120;

/**
 * 道具の入力から「何をしたか」の札を取る。
 *
 * `description` を先に見るのは、それが AI 自身の書いた要約だから。
 * **生のコマンドは取らない** —— `work.ts` の `targetOf()` と違って、ここは
 * 全呼び出しを並べるので、拠点に鍵の入ったコマンドが大量に写りうる。
 */
const LABEL_KEYS = ["description", "file_path", "path", "notebook_path", "pattern",
  "url", "skill", "query"] as const;

function labelOf(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const args = input as Record<string, unknown>;
  for (const key of LABEL_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      // 札は1行に収める。改行を含むものは先頭の行だけ。
      return take(value.trim().split("\n")[0], LABEL_LIMIT);
    }
  }
  return "";
}

// ---------------------------------------------------------------- 集める

interface Deed {
  readonly dt: Date;
  readonly project: string;
  readonly tool: string;
  readonly label: string;
  /** 札がパスなら backtick で括る。description は地の文のまま */
  readonly code: boolean;
  readonly key: string;
}

class Day {
  /** 元 jsonl のパス。`会話/` の1ファイル＝1本 に合わせて数える */
  readonly sources = new Set<string>();
  /**
   * 発言の数。**`会話/` の `replies` とは数え方が違う** —— あちらは jsonl の
   * 行を数えるので、思考も道具呼び出しも1つずつ数に入る。こちらが数えるのは
   * text ブロックだけ（実測 3,143）。同じ日について違う数を言うことになる
   * ので、名前も `replies` と分けてある。
   */
  speech = 0;
  tools = 0;
  helperSpeech = 0;
  helperTools = 0;
  readonly models = new Map<string, number>();
  readonly toolCounts = new Map<string, number>();
  /** プロジェクトごとの [発言, 道具] */
  readonly byProject = new Map<string, [number, number]>();
  readonly deeds: Deed[] = [];

  countProject(project: string, speech: number, tools: number): void {
    const got = this.byProject.get(project) ?? [0, 0];
    this.byProject.set(project, [got[0] + speech, got[1] + tools]);
  }
}

function bump(counter: Map<string, number>, key: string): void {
  counter.set(key, (counter.get(key) ?? 0) + 1);
}

function dayOf(days: Map<string, Day>, date: string): Day {
  let d = days.get(date);
  if (!d) {
    d = new Day();
    days.set(date, d);
  }
  return d;
}

/**
 * 手下（サブエージェント）か。
 *
 * 2通りで来る。親のログに `isSidechain` として混ざるものと、
 * `/subagents/` の別ファイルになるもの。どちらもアイボが自分で出した手なので
 * 数えるが、本体の返答とは分けて持つ（何回人を雇ったかは、それ自体が行動）。
 */
function isHelper(path: string, row: Record<string, unknown>): boolean {
  return row.isSidechain === true || path.includes("/subagents/");
}

function fromClaude(
  days: Map<string, Day>,
  path: string,
  seen: Set<string>,
  known: ReadonlySet<string>,
): void {
  for (const row of readJsonl(path)) {
    if (row.type !== "assistant") continue;
    const dt = jst(row.timestamp as string | undefined);
    if (!dt) continue;

    const date = ymd(dt);
    const day = dayOf(days, date);
    const helper = isHelper(path, row);
    const project = fold(slugFromCwd(row.cwd as string | undefined), known);
    const message = (row.message ?? {}) as Record<string, unknown>;
    const model = typeof message.model === "string" ? message.model : "";
    const blocks = Array.isArray(message.content) ? message.content : [];

    // --resume で同じ行が別ファイルに写ることがある（`me.ts` と同じ話）。
    // 鍵は **行の uuid**。`message.id` で重ねてはいけない —— Claude Code は
    // 1つの応答をブロックごとに別の行で書くので、同じ `message.id` を持つ行が
    // いくつも並ぶ。そこで重ねると道具呼び出しがまとめて消える（実測で
    // 8,041 回が 3,016 回に減った）。
    const ident = typeof row.uuid === "string" && row.uuid ? row.uuid : "";
    if (ident) {
      if (seen.has(ident)) continue;
      seen.add(ident);
    }

    let spoke = 0;
    let usedTools = 0;

    for (const raw of blocks) {
      if (!raw || typeof raw !== "object") continue;
      const block = raw as Record<string, unknown>;
      if (block.type === "text") {
        if (typeof block.text === "string" && block.text.trim()) spoke += 1;
      } else if (block.type === "tool_use") {
        usedTools += 1;
        if (helper) continue;
        const tool = typeof block.name === "string" && block.name ? block.name : "?";
        bump(day.toolCounts, tool);
        const label = labelOf(block.input);
        day.deeds.push({
          dt,
          project,
          tool,
          label,
          code: label !== "" && typeof (block.input as Record<string, unknown>)?.description !== "string",
          key: `${typeof block.id === "string" ? block.id : `${dt.toISOString()}:${tool}:${label}`}`,
        });
      }
    }

    if (helper) {
      day.helperSpeech += spoke;
      day.helperTools += usedTools;
      continue;
    }

    if (!spoke && !usedTools) continue;
    day.sources.add(path);
    day.speech += spoke;
    day.tools += usedTools;
    if (model && model !== "<synthetic>" && spoke) bump(day.models, model);
    day.countProject(project, spoke, usedTools);
  }
}

/**
 * Codex。発言は `AgentMessage`、道具は `CommandExecution` / `McpToolCall` /
 * `FileChange`。札に生のコマンドを使わない方針は Claude Code 側と同じだが、
 * Codex は `description` を持たないので、道具の名前だけを残す。
 */
function fromCodex(
  days: Map<string, Day>,
  path: string,
  seen: Set<string>,
  known: ReadonlySet<string>,
): void {
  let cwd = "";
  let session = "";

  for (const row of readJsonl(path)) {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    if (row.type === "session_meta") {
      cwd = String(payload.cwd ?? "") || cwd;
      session = String(payload.session_id ?? payload.id ?? "") || session;
      continue;
    }
    if (row.type !== "event_msg") continue;
    const item = payload.item as Record<string, unknown> | undefined;
    if (!item || typeof item !== "object") continue;

    const dt = jst(row.timestamp as string | undefined);
    if (!dt) continue;
    const date = ymd(dt);
    const day = dayOf(days, date);
    const project = fold(slugFromCwd(cwd), known);
    const key = `codex:${session}:${String(item.id ?? `${dt.toISOString()}:${String(item.type)}`)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (item.type === "AgentMessage") {
      day.sources.add(path);
      day.speech += 1;
      bump(day.models, "codex");
      day.countProject(project, 1, 0);
      continue;
    }

    let tool = "";
    let label = "";
    if (item.type === "CommandExecution") {
      tool = "CommandExecution";
    } else if (item.type === "McpToolCall") {
      tool = `${String(item.server ?? "?")}.${String(item.tool ?? "?")}`;
    } else if (item.type === "FileChange") {
      tool = "FileChange";
      const changes = Array.isArray(item.changes) ? item.changes : [];
      label = take(changes
        .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
        .map((c) => String(c.path ?? "?")).join(", "), LABEL_LIMIT);
    } else {
      continue;
    }

    day.sources.add(path);
    day.tools += 1;
    bump(day.toolCounts, tool);
    day.countProject(project, 0, 1);
    day.deeds.push({ dt, project, tool, label, code: label !== "", key });
  }
}

// ---------------------------------------------------------------- 書く

/** 頻度降順、同数は名前順（同じ日で揺れないように）。 */
function ranked(counter: Map<string, number>, limit?: number): [string, number][] {
  const rows = [...counter.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return limit === undefined ? rows : rows.slice(0, limit);
}

function compare(a: Deed, b: Deed): number {
  if (a.dt.getTime() !== b.dt.getTime()) return a.dt.getTime() - b.dt.getTime();
  if (a.tool !== b.tool) return a.tool < b.tool ? -1 : 1;
  if (a.label !== b.label) return a.label < b.label ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function render(date: string, day: Day): string {
  const projects = [...day.byProject.keys()].sort();

  const head = frontmatter({
    room: "アイボ",
    date,
    sessions: day.sources.size,
    speech: day.speech,
    tools: day.tools,
    models: ranked(day.models).map(([m]) => m).join(", "),
    projects: projects.join(", "),
  });

  const body: string[] = [];

  const moved: string[] = [
    `- 会話 ${n(day.sources.size)}　発言 ${n(day.speech)}　道具 ${n(day.tools)}`,
  ];
  if (day.models.size) {
    moved.push("- モデル: " + ranked(day.models).map(([m, c]) => `${m} ${n(c)}`).join("、"));
  }
  if (day.helperSpeech || day.helperTools) {
    moved.push(`- 手下: 発言 ${n(day.helperSpeech)}　道具 ${n(day.helperTools)}`);
  }
  body.push("## どれだけ動いたか\n\n" + moved.join("\n"));

  if (day.toolCounts.size) {
    body.push("## つかった道具\n\n" +
      ranked(day.toolCounts, 15).map(([t, c]) => `${t} ${n(c)}`).join("、"));
  }

  for (const project of projects) {
    const [speech, tools] = day.byProject.get(project)!;
    const block: string[] = [`## ${project}`, `発言 ${n(speech)}　道具 ${n(tools)}`];

    const mine = day.deeds.filter((d) => d.project === project).sort(compare);
    if (mine.length) {
      const lines = mine.slice(0, DEEDS_SHOWN).map((d) => {
        const label = d.label ? (d.code ? ` — \`${d.label}\`` : ` — ${d.label}`) : "";
        return `- ${hhmm(d.dt)} ${d.tool}${label}`;
      });
      if (mine.length > DEEDS_SHOWN) {
        lines.push(`- … ほか ${n(mine.length - DEEDS_SHOWN)} 回（ぜんぶは 会話/ にある）`);
      }
      block.push("### やったこと\n\n" + lines.join("\n"));
    }
    body.push(block.join("\n\n"));
  }

  return head + `\n\n# ${date} のアイボ\n\n` + body.join("\n\n") + "\n";
}

// ---------------------------------------------------------------- 入口

function main(): number {
  const args = parseArgs(process.argv.slice(2), ["dry-run", "quiet"], ["since"]);
  const since = parseSince(args.values.since);
  if (since === undefined) return 2;

  const days = new Map<string, Day>();
  const seen = new Set<string>();
  let failed = 0;

  // モノレポの奥で作業した回を、リポジトリ1つに畳む（落とし穴15）。畳み方は
  // `work.ts` から借りる —— 同じ cwd について違う名前を言う部屋を作らないため。
  const known = knownProjects();

  const jobs: [
    string,
    (d: Map<string, Day>, p: string, s: Set<string>, k: ReadonlySet<string>) => void,
  ][] = [];
  if (existsSync(CLAUDE_PROJECTS)) {
    for (const p of listFiles(CLAUDE_PROJECTS, ".jsonl")) jobs.push([p, fromClaude]);
  }
  if (existsSync(CODEX_SESSIONS)) {
    for (const p of listFiles(CODEX_SESSIONS, ".jsonl")) jobs.push([p, fromCodex]);
  }

  for (const [path, pull] of jobs) {
    try {
      pull(days, path, seen, known);
    } catch (err) {
      // 1ファイルの失敗で全体を止めない
      failed += 1;
      console.error(`  ✗ ${path.split("/").at(-1)}: ${(err as Error).message}`);
    }
  }

  const stats: Record<WriteState, number> = { new: 0, updated: 0, same: 0 };
  let speech = 0;
  let tools = 0;

  for (const date of [...days.keys()].sort()) {
    if (since && date < since) continue;
    const day = days.get(date)!;
    if (!day.speech && !day.tools) continue;
    const out = join(ROOM, date.slice(0, 7), `${date}.md`);
    stats[writeIfChanged(out, render(date, day), args.flags["dry-run"])] += 1;
    speech += day.speech;
    tools += day.tools;
  }

  const nDays = stats.new + stats.updated + stats.same;
  if (args.flags.quiet) {
    console.log(
      `aibo: ${nDays}日 (new ${stats.new} / upd ${stats.updated} ` +
        `/ same ${stats.same}) 発言 ${n(speech)} 道具 ${n(tools)}`,
    );
  } else {
    if (args.flags["dry-run"]) console.log("（書かずに確認）");
    console.log(`  アイボ       : ${n(nDays)} 日ぶん`);
    console.log(`    あたらしい : ${n(stats.new)}`);
    console.log(`    かきかえ   : ${n(stats.updated)}`);
    console.log(`    かわらず   : ${n(stats.same)}`);
    if (failed) console.log(`    しっぱい   : ${n(failed)}`);
    console.log(`  発言         : ${n(speech)}`);
    console.log(`  道具         : ${n(tools)}`);
    console.log(`  ばしょ : ${ROOM}`);
  }

  return failed ? 1 : 0;
}

process.exit(main());
