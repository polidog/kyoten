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
 *     aibo.ts --collect-only  # 素材に落とすだけ（母艦でない機械）
 *     aibo.ts --fold-only     # 素材から畳むだけ
 *
 * 拠点を複数の PC で共有するため、2段になっている（`machine.ts` を見る）。
 * **プロジェクトの畳み方（落とし穴15）は集める側でやる** —— `knownProjects()`
 * が手元の `~/ghq` を見るので、畳む側では答えが出せない。
 */

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
  take,
  writeIfChanged,
  ymd,
  type WriteState,
} from "./util.ts";
import { listFiles, parseArgs, parseSince } from "./cli.ts";
import { fold, knownProjects } from "./work.ts";
import { fleetNote, markCollected, readSozai, writeSozai } from "./machine.ts";

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
 * 「言われたこと」の中身の上限。AskUserQuestion の答えは実測で
 * 中央値 230 文字・90% が 514 文字・最長 986。600 で切ると 19/106 だけが
 * 末尾を落とす（落とした旨は `clip()` が書く。原本は `会話/` にある）。
 */
const TOLD_LIMIT = 600;

/** 1日1プロジェクトあたり、並べる「言われたこと」の上限。 */
const TOLD_SHOWN = 20;

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

/** polidog に進路を変えられた記録。文面ではなく、機械的な合図だけ拾う */
interface Told {
  readonly dt: Date;
  readonly project: string;
  readonly kind: "選ばせた" | "止められた" | "断られた";
  readonly body: string;
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
  readonly told: Told[] = [];

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

/**
 * その行が「polidog に進路を変えられた」記録なら拾う。
 *
 * **文面では探さない。** 「違う」「やめて」「直して」を数えてみたが、実測
 * 645 発言中 51 件当たったうち、本物は 1〜2 割だった。日本語では AI への
 * 依頼と AI の訂正が同じ動詞で書かれる（「直して」も「消して」も普通の依頼）。
 * ひらがなの部分一致はさらに悪く、「まって」が「溜まって」に当たった。
 * 落とし穴19（`is_error` は「詰まった」ではない）と同じ形。
 *
 * 代わりに拾うのは、機械的に確実な3つだけ（実測 8日で 141 件）:
 *
 *     選ばせた   AskUserQuestion に答えが返った   106
 *     止められた Esc で中断された                  22
 *     断られた   道具の実行を拒否された            13
 *
 * とくに AskUserQuestion の答えは、**いまどの部屋にも入っていない polidog の
 * 言葉**。`自分/` は user 行の text しか見ず、答えは tool_result で来るため。
 */
function readTold(
  day: Day,
  dt: Date,
  project: string,
  message: Record<string, unknown>,
  blocks: readonly unknown[],
  calls: ReadonlyMap<string, string>,
  ident: string,
  state: { running: string },
): void {
  const text = asText(message.content).trim();
  if (text.startsWith("[Request interrupted")) {
    day.told.push({
      dt,
      project,
      kind: "止められた",
      body: state.running ? `${state.running} を止められた` : "止められた",
      key: ident || `${dt.toISOString()}:stop`,
    });
    state.running = "";
    return;
  }

  for (const raw of blocks) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as Record<string, unknown>;
    if (block.type !== "tool_result") continue;
    const id = String(block.tool_use_id ?? "");
    const tool = calls.get(id) ?? "?";
    // 道具が返ってきたら「動いている」を降ろす。降ろさないと、あとで来た
    // 中断が、とっくに終わった道具のせいにされる。
    if (tool === state.running) state.running = "";

    const body = asText(block.content).trim();
    if (!body) continue;

    if (body.startsWith("The user doesn't want to")) {
      // 拒否も `is_error` で来る（`work.ts` の `NOT_STUCK` と同じ文面）。
      // 先に見るのはそのため —— 順番を逆にすると拒否まで落ちる。
      day.told.push({
        dt, project, kind: "断られた", body: `${tool} を断られた`, key: `${ident}:${id}`,
      });
    } else if (tool === "AskUserQuestion" && !block.is_error) {
      // 質問そのものが失敗した回（`<tool_use_error>` のバリデーション落ち）は
      // 答えではない。選ばせたことにすると、決めていないものを決めたことになる。
      day.told.push({
        dt, project, kind: "選ばせた", body: clip(body, TOLD_LIMIT), key: `${ident}:${id}`,
      });
    }
  }
}

function fromClaude(
  days: Map<string, Day>,
  path: string,
  seen: Set<string>,
  known: ReadonlySet<string>,
): void {
  const rows = [...readJsonl(path)];

  // tool_use と tool_result は別の行に出るので、先に id → 道具名の表を作る
  // （`work.ts` の `troublesFrom()` と同じ形）。拒否された呼び出しが
  // 「何を拒否されたか」を名乗るのに要る。
  const calls = new Map<string, string>();
  for (const row of rows) {
    const message = (row.message ?? {}) as Record<string, unknown>;
    for (const raw of Array.isArray(message.content) ? message.content : []) {
      if (!raw || typeof raw !== "object") continue;
      const block = raw as Record<string, unknown>;
      if (block.type === "tool_use" && typeof block.id === "string") {
        calls.set(block.id, typeof block.name === "string" && block.name ? block.name : "?");
      }
    }
  }

  /** 中断されたときに動いていた道具。Esc は「何を止めたか」まで含めて記録になる */
  const state = { running: "" };

  for (const row of rows) {
    if (row.type !== "assistant" && row.type !== "user") continue;
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

    if (row.type === "user") {
      if (!helper) readTold(day, dt, project, message, blocks, calls, ident, state);
      continue;
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
        state.running = tool;
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

function compareTold(a: Told, b: Told): number {
  if (a.dt.getTime() !== b.dt.getTime()) return a.dt.getTime() - b.dt.getTime();
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function render(date: string, day: Day): string {
  // 言われたことしか無いプロジェクトもありうるので、両方の顔ぶれを合わせる
  const projects = [...new Set([
    ...day.byProject.keys(),
    ...day.told.map((t) => t.project),
  ])].sort();

  const head = frontmatter({
    room: "アイボ",
    date,
    sessions: day.sources.size,
    speech: day.speech,
    tools: day.tools,
    told: day.told.length,
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
  if (day.told.length) {
    const kinds = new Map<string, number>();
    for (const t of day.told) kinds.set(t.kind, (kinds.get(t.kind) ?? 0) + 1);
    moved.push("- 言われたこと: " +
      ranked(kinds).map(([k, c]) => `${k} ${n(c)}`).join("　"));
  }
  body.push("## どれだけ動いたか\n\n" + moved.join("\n"));

  if (day.toolCounts.size) {
    body.push("## つかった道具\n\n" +
      ranked(day.toolCounts, 15).map(([t, c]) => `${t} ${n(c)}`).join("、"));
  }

  for (const project of projects) {
    const [speech, tools] = day.byProject.get(project) ?? [0, 0];
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

    const told = day.told.filter((t) => t.project === project).sort(compareTold);
    if (told.length) {
      const lines: string[] = [];
      for (const t of told.slice(0, TOLD_SHOWN)) {
        if (t.kind === "選ばせた") {
          lines.push(`- ${hhmm(t.dt)} 選ばせた`);
          lines.push(t.body.split("\n").map((l) => "  " + l).join("\n"));
        } else {
          lines.push(`- ${hhmm(t.dt)} ${t.body}`);
        }
      }
      if (told.length > TOLD_SHOWN) {
        lines.push(`- … ほか ${n(told.length - TOLD_SHOWN)} 件`);
      }
      block.push("### 言われたこと\n\n" + lines.join("\n\n"));
    }

    body.push(block.join("\n\n"));
  }

  return head + `\n\n# ${date} のアイボ\n\n` + body.join("\n\n") + "\n";
}

// ---------------------------------------------------------------- 素材

/**
 * 素材に落とす形。`Day` はカウンタと Map の塊なので、そのままでは書けない。
 *
 * 1日につき**機械1台ぶんが1件**。畳む側で足し合わせる（数は和、顔ぶれは
 * 和集合、並びは key で重複を落としてから並べ直す）。
 */
interface Wire {
  /**
   * 元 jsonl の名前（UUID）。**素材は1本のセッションにつき1件**にしてある。
   *
   * 日ごとにまとめて1件にしていたら、同じセッションを2台が持っていたとき
   * （`~/.claude` を写した、`--resume` が両方に残った）に、数を**そのまま
   * 2回足してしまう**。実測で発言 3,554 が 7,112 になった —— worktree を
   * 二重に数えた落とし穴17 と同じ形。deeds は key で落ちるのに、カウンタ
   * だけ鍵を持っていなかった。
   *
   * 絶対パスではなく名前にするのは、機械ごとに home が違っても同じ
   * セッションだと分かるようにするため。
   */
  readonly session: string;
  readonly sources: string[];
  readonly speech: number;
  readonly tools: number;
  readonly helperSpeech: number;
  readonly helperTools: number;
  readonly models: [string, number][];
  readonly toolCounts: [string, number][];
  readonly byProject: [string, [number, number]][];
  readonly deeds: { at: string; project: string; tool: string; label: string; code: boolean; key: string }[];
  readonly told: { at: string; project: string; kind: Told["kind"]; body: string; key: string }[];
}

function toWire(session: string, day: Day): Wire {
  return {
    session,
    sources: [session],
    speech: day.speech,
    tools: day.tools,
    helperSpeech: day.helperSpeech,
    helperTools: day.helperTools,
    models: [...day.models.entries()].sort(),
    toolCounts: [...day.toolCounts.entries()].sort(),
    byProject: [...day.byProject.entries()].sort(),
    deeds: day.deeds.map((d) => ({
      at: isoJst(d.dt), project: d.project, tool: d.tool, label: d.label, code: d.code, key: d.key,
    })),
    told: day.told.map((t) => ({
      at: isoJst(t.dt), project: t.project, kind: t.kind, body: t.body, key: t.key,
    })),
  };
}

/** 機械ぶんの Wire を1つの Day に足し合わせる。 */
function merge(wires: readonly Wire[]): Day {
  const day = new Day();
  const seenDeed = new Set<string>();
  const seenTold = new Set<string>();
  const seenSession = new Set<string>();

  for (const w of wires) {
    // 同じセッションが2台にあれば、**数ごと**1回だけ数える（機械名の昇順で先勝ち）
    if (w.session) {
      if (seenSession.has(w.session)) continue;
      seenSession.add(w.session);
    }
    for (const s of w.sources ?? []) day.sources.add(s);
    day.speech += w.speech ?? 0;
    day.tools += w.tools ?? 0;
    day.helperSpeech += w.helperSpeech ?? 0;
    day.helperTools += w.helperTools ?? 0;
    for (const [k, v] of w.models ?? []) day.models.set(k, (day.models.get(k) ?? 0) + v);
    for (const [k, v] of w.toolCounts ?? []) {
      day.toolCounts.set(k, (day.toolCounts.get(k) ?? 0) + v);
    }
    for (const [k, [sp, tl]] of w.byProject ?? []) day.countProject(k, sp, tl);

    for (const d of w.deeds ?? []) {
      // 同じセッションが2台に写っていても1回だけ（機械名の昇順で先勝ち）
      if (seenDeed.has(d.key)) continue;
      seenDeed.add(d.key);
      const dt = jst(d.at);
      if (!dt) continue;
      day.deeds.push({ dt, project: d.project, tool: d.tool, label: d.label, code: d.code, key: d.key });
    }
    for (const t of w.told ?? []) {
      if (seenTold.has(t.key)) continue;
      seenTold.add(t.key);
      const dt = jst(t.at);
      if (!dt) continue;
      day.told.push({ dt, project: t.project, kind: t.kind, body: t.body, key: t.key });
    }
  }
  return day;
}

/** 手元の jsonl から拾って、`素材/<機械>/アイボ/` に置く。 */
function collect(since: string | null, dryRun: boolean): [number, number] {
  // **1本ずつ別の Day に集める。** 日ごとにまとめてしまうと、セッションを
  // 鍵にした重複落としができなくなる（上の `Wire.session` を見る）。
  const perDate = new Map<string, Wire[]>();
  const seen = new Set<string>();
  let failed = 0;

  // モノレポの奥で作業した回を、リポジトリ1つに畳む（落とし穴15）。畳み方は
  // `work.ts` から借りる —— 同じ cwd について違う名前を言う部屋を作らないため。
  // **ここでやる**のが要点。`knownProjects()` は手元の `~/ghq` を見るので、
  // 畳む側（拠点しか見ない）では同じ答えが出せない。
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
    const one = new Map<string, Day>();
    try {
      pull(one, path, seen, known);
    } catch (err) {
      // 1ファイルの失敗で全体を止めない
      failed += 1;
      console.error(`  ✗ ${path.split("/").at(-1)}: ${(err as Error).message}`);
      continue;
    }
    const session = path.split("/").at(-1)!.replace(/\.jsonl$/, "");
    for (const [date, day] of one) {
      if (!day.speech && !day.tools) continue;
      const list = perDate.get(date);
      if (list) list.push(toWire(session, day));
      else perDate.set(date, [toWire(session, day)]);
    }
  }

  let wrote = 0;
  for (const date of [...perDate.keys()].sort()) {
    if (since && date < since) continue;
    // セッション名で並べる —— 読み込んだ順（＝その機械のファイル配置）に
    // 依らせない
    const wires = perDate.get(date)!.sort((a, b) => (a.session < b.session ? -1 : 1));
    writeSozai("アイボ", date, wires, dryRun);
    wrote += 1;
  }
  markCollected(dryRun);
  return [wrote, failed];
}

/** 全機械ぶんの素材を畳んで `アイボ/` に置く。ここは拠点しか見ない。 */
function foldDays(
  since: string | null,
  dryRun: boolean,
): [Record<WriteState, number>, number, number] {
  const stats: Record<WriteState, number> = { new: 0, updated: 0, same: 0 };
  const wires = readSozai<Wire>("アイボ");
  let speech = 0;
  let tools = 0;

  for (const date of [...wires.keys()].sort()) {
    if (since && date < since) continue;
    const day = merge(wires.get(date)!);
    if (!day.speech && !day.tools) continue;
    day.deeds.sort(compare);
    day.told.sort(compareTold);
    const out = join(ROOM, date.slice(0, 7), `${date}.md`);
    stats[writeIfChanged(out, render(date, day), dryRun)] += 1;
    speech += day.speech;
    tools += day.tools;
  }
  return [stats, speech, tools];
}

// ---------------------------------------------------------------- 入口

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
    if (args.flags.quiet) console.log(`aibo: 集めた ${n(gathered)}日ぶん（畳まない）`);
    else {
      if (dryRun) console.log("（書かずに確認）");
      console.log(`  素材（アイボ）: ${n(gathered)} 日ぶん`);
      console.log(`  ばしょ : ${join(KYOTEN, "素材")}`);
    }
    return failed ? 1 : 0;
  }

  const [stats, speech, tools] = foldDays(since, dryRun);
  const nDays = stats.new + stats.updated + stats.same;

  if (args.flags.quiet) {
    console.log(
      `aibo: ${nDays}日 (new ${stats.new} / upd ${stats.updated} ` +
        `/ same ${stats.same}) 発言 ${n(speech)} 道具 ${n(tools)} ${fleetNote()}`,
    );
  } else {
    if (dryRun) console.log("（書かずに確認）");
    console.log(`  アイボ       : ${n(nDays)} 日ぶん`);
    console.log(`    あたらしい : ${n(stats.new)}`);
    console.log(`    かきかえ   : ${n(stats.updated)}`);
    console.log(`    かわらず   : ${n(stats.same)}`);
    if (failed) console.log(`    しっぱい   : ${n(failed)}`);
    console.log(`  発言         : ${n(speech)}`);
    console.log(`  道具         : ${n(tools)}`);
    console.log(`  ${fleetNote()}`);
    console.log(`  ばしょ : ${ROOM}`);
  }

  return failed ? 1 : 0;
}

process.exit(main());
