#!/usr/bin/env node
/**
 * utsushi — ぼうけんのしょの書き写し
 *
 * Claude Code と Codex の会話ログ (jsonl) を Markdown に決定論変換する。
 *
 * 掟:
 *   - 決定論的: 同じ入力なら必ず同じ出力。生成日時などの揺れる値は書かない。
 *   - 冪等: 内容が変わらなければファイルに触れない (mtime を動かさない)。
 *   - 原文ママ: 発話は加工しない。長大なツール出力だけ末尾を省略し、その旨を明記する。
 *     原本の jsonl は cleanupPeriodDays=3650 で手元に残るので、省略は復元可能。
 *
 * 使い方:
 *     utsushi.ts              # 全部を写す
 *     utsushi.ts --dry-run    # 何が書かれるかだけ見る
 *     utsushi.ts --since 2026-08-01
 *     utsushi.ts --file <jsonl>   # その1本だけ写す（すずのおとの SessionEnd 用）
 */

import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import {
  CLAUDE_PROJECTS,
  CODEX_SESSIONS,
  KYOTEN,
  asText,
  clip,
  fence,
  frontmatter,
  take,
  hhmm,
  isoJst,
  jst,
  n,
  readJsonl,
  safePath,
  slugFromCwd,
  sortedJson,
  unescapeJson,
  writeIfChanged,
  ymd,
  type WriteState,
} from "./dougu.ts";
import { listFiles, parseArgs, parseSince } from "./cli.ts";

/** ツール出力がこれを超えたら末尾を省略する (原本は jsonl に残る) */
const TOOL_OUTPUT_LIMIT = 4000;
/** 1メッセージのテキストがこれを超えたら省略する。発話は原則ここに達しない */
const TEXT_LIMIT = 200_000;

interface Meta {
  readonly slug: string;
  readonly date: string;
  readonly utterances: number;
}
type Rendered = readonly [string, Meta] | null;

function dict(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// ---------------------------------------------------------------- claude code

function renderClaude(path: string): Rendered {
  const rows = [...readJsonl(path)];
  if (!rows.length) return null;

  let sessionId = "";
  let cwd = "";
  let branch = "";
  let version = "";
  const models: string[] = [];
  const times: Date[] = [];
  const body: string[] = [];
  let nUser = 0;
  let nAsst = 0;

  for (const row of rows) {
    const rtype = row.type;
    sessionId ||= str(row.sessionId);
    cwd ||= str(row.cwd);
    branch ||= str(row.gitBranch);
    version ||= str(row.version);
    const dt = jst(str(row.timestamp));
    if (dt) times.push(dt);

    if (rtype === "user") {
      if (row.isMeta || row.isSidechain) continue;
      const content = dict(row.message).content;

      // tool_result はユーザー行として流れてくる。発話と区別する
      const toolResults = Array.isArray(content)
        ? content.filter(
            (b): b is Record<string, unknown> =>
              !!b && typeof b === "object" && (b as Record<string, unknown>).type === "tool_result",
          )
        : [];
      const text = asText(content).trim();

      if (text) {
        nUser += 1;
        body.push(`## ${hhmm(dt)} polidog\n\n${clip(text, TEXT_LIMIT)}`);
      }
      for (const tr of toolResults) {
        const out = unescapeJson(asText(tr.content).trim());
        if (!out) continue;
        const flag = tr.is_error ? " ⚠️" : "";
        body.push(
          `<details><summary>↩︎ ツール結果${flag}</summary>\n\n` +
            `${fence(clip(out, TOOL_OUTPUT_LIMIT))}\n\n</details>`,
        );
      }
    } else if (rtype === "assistant") {
      const msg = dict(row.message);
      const model = str(msg.model);
      if (model && !models.includes(model)) models.push(model);
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      const chunk: string[] = [];

      for (const raw of blocks) {
        if (!raw || typeof raw !== "object") continue;
        const blk = raw as Record<string, unknown>;
        const btype = blk.type;
        if (btype === "text" && str(blk.text).trim()) {
          chunk.push(clip(str(blk.text).trim(), TEXT_LIMIT));
        } else if (btype === "thinking" && str(blk.thinking).trim()) {
          chunk.push(
            "<details><summary>💭 思考</summary>\n\n" +
              clip(str(blk.thinking).trim(), TEXT_LIMIT) +
              "\n\n</details>",
          );
        } else if (btype === "tool_use") {
          const name = str(blk.name) || "?";
          const args = dict(blk.input);
          const keys = ["command", "file_path", "pattern", "path"];
          const hit = keys.find((k) => k in args);
          const summary = hit
            ? `🔧 **${name}** — \`${take(String(args[hit]), 160)}\``
            : `🔧 **${name}**`;
          const dumped = sortedJson(blk.input ?? {});
          chunk.push(
            `${summary}\n\n<details><summary>引数</summary>\n\n` +
              `${fence(clip(dumped, TOOL_OUTPUT_LIMIT), "json")}\n\n</details>`,
          );
        }
      }
      if (chunk.length) {
        nAsst += 1;
        const label = model ? `assistant（${model}）` : "assistant";
        body.push(`## ${hhmm(dt)} ${label}\n\n` + chunk.join("\n\n"));
      }
    } else if (rtype === "system" && row.subtype === "compact_boundary") {
      body.push("---\n\n> ⚠️ ここで会話が圧縮されています（compact）");
    }
  }

  if (!body.length) return null;

  const started = times.length ? new Date(Math.min(...times.map((t) => t.getTime()))) : null;
  const ended = times.length ? new Date(Math.max(...times.map((t) => t.getTime()))) : null;
  const slug = slugFromCwd(cwd);
  const stem = basename(path, ".jsonl");

  const head = frontmatter({
    source: "claude-code",
    session: sessionId || stem,
    project: slug,
    cwd,
    branch,
    started: started ? isoJst(started) : null,
    ended: ended ? isoJst(ended) : null,
    models: models.join(", "),
    utterances: nUser,
    replies: nAsst,
    cli: version,
  });
  const title = `# ${started ? ymd(started) : "????-??-??"} ${slug}`;
  const text = head + "\n\n" + title + "\n\n" + body.join("\n\n") + "\n";

  return [text, { slug, date: started ? ymd(started) : "0000-00-00", utterances: nUser }];
}

// ---------------------------------------------------------------- codex

/** Codex のユーザー発話。UserMessage.content と user_message.message の2系統。 */
function codexUserText(payload: Record<string, unknown>): string {
  const item = payload.item;
  if (item && typeof item === "object" && (item as Record<string, unknown>).type === "UserMessage") {
    const it = item as Record<string, unknown>;
    return asText(it.content ?? it.text).trim();
  }
  if (payload.type === "user_message") {
    return asText(payload.message ?? payload.text).trim();
  }
  return "";
}

function renderCodex(path: string): Rendered {
  const rows = [...readJsonl(path)];
  if (!rows.length) return null;

  let sessionId = "";
  let cwd = "";
  let model = "";
  let cli = "";
  const times: Date[] = [];
  const body: string[] = [];
  let nUser = 0;
  let nAsst = 0;

  for (const row of rows) {
    const rtype = row.type;
    const payload = dict(row.payload);
    const dt = jst(str(row.timestamp));
    if (dt) times.push(dt);

    if (rtype === "session_meta") {
      sessionId = str(payload.session_id) || str(payload.id) || "";
      cwd = str(payload.cwd);
      cli = str(payload.cli_version);
      continue;
    }
    if (rtype === "turn_context") {
      model ||= str(payload.model);
      continue;
    }
    if (rtype !== "event_msg") continue;

    const text = codexUserText(payload);
    if (text) {
      nUser += 1;
      body.push(`## ${hhmm(dt)} polidog\n\n${clip(text, TEXT_LIMIT)}`);
      continue;
    }

    if (!payload.item || typeof payload.item !== "object") continue;
    const item = payload.item as Record<string, unknown>;
    const itype = item.type;

    if (itype === "AgentMessage" || payload.type === "agent_message") {
      const msg = asText(item.content ?? item.text).trim();
      if (msg) {
        nAsst += 1;
        body.push(`## ${hhmm(dt)} codex\n\n${clip(msg, TEXT_LIMIT)}`);
      }
    } else if (itype === "Reasoning") {
      const msg = asText(item.content ?? item.text).trim();
      if (msg) {
        body.push(
          "<details><summary>💭 思考</summary>\n\n" + clip(msg, TEXT_LIMIT) + "\n\n</details>",
        );
      }
    } else if (itype === "CommandExecution") {
      // command は ["/usr/bin/bash", "-lc", "…"] という配列で来ることがある。
      // 文字列でなければ JSON にする（空白なしの区切りで Python 版と揃える）。
      const rawCmd = item.command;
      const cmd = (typeof rawCmd === "string"
        ? rawCmd
        : rawCmd == null
          ? ""
          : JSON.stringify(rawCmd)).trim();
      const out = unescapeJson(str(item.aggregated_output ?? item.output).trim());
      const chunk = [`🔧 **CommandExecution** — \`${take(cmd, 160)}\``];
      if (out) {
        chunk.push(
          "<details><summary>↩︎ 出力</summary>\n\n" +
            fence(clip(out, TOOL_OUTPUT_LIMIT)) +
            "\n\n</details>",
        );
      }
      body.push(chunk.join("\n\n"));
    } else if (itype === "McpToolCall") {
      body.push(`🔧 **MCP** — \`${str(item.server) || "?"}.${str(item.tool) || "?"}\``);
    } else if (itype === "FileChange") {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const names = changes
        .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
        .map((c) => String(c.path ?? "?"))
        .join(", ");
      body.push(`✏️ **FileChange** — ${take(names, 300)}`);
    }
  }

  if (!body.length) return null;

  const started = times.length ? new Date(Math.min(...times.map((t) => t.getTime()))) : null;
  const ended = times.length ? new Date(Math.max(...times.map((t) => t.getTime()))) : null;
  const slug = slugFromCwd(cwd);
  const stem = basename(path, ".jsonl");

  const head = frontmatter({
    source: "codex",
    session: sessionId || stem,
    project: slug,
    cwd,
    started: started ? isoJst(started) : null,
    ended: ended ? isoJst(ended) : null,
    models: model,
    utterances: nUser,
    replies: nAsst,
    cli,
  });
  const title = `# ${started ? ymd(started) : "????-??-??"} ${slug}`;
  const text = head + "\n\n" + title + "\n\n" + body.join("\n\n") + "\n";

  return [text, { slug, date: started ? ymd(started) : "0000-00-00", utterances: nUser }];
}

// ---------------------------------------------------------------- main

/** Python の `re.sub(r"[^\w.\-]", "_", stem)` と同じ。 */
function safeName(stem: string): string {
  return stem.replace(/[^\p{L}\p{N}_.\-]/gu, "_");
}

function main(): number {
  const args = parseArgs(process.argv.slice(2), ["dry-run", "quiet"], ["since", "file"]);
  const since = parseSince(args.values.since);
  if (since === undefined) return 2;

  const jobs: [string, "claude" | "codex"][] = [];
  if (args.values.file !== undefined) {
    // 1本だけ写す。セッションが終わったその場で呼ぶための口で、
    // 名前の衝突（罠1）はここでは見ない —— 全部を写す夜の便が刻み直す。
    const one = resolve(args.values.file);
    if (!existsSync(one)) {
      console.error(`そのファイルがありません: ${one}`);
      return 2;
    }
    jobs.push([one, one.startsWith(CODEX_SESSIONS) ? "codex" : "claude"]);
  } else {
    if (existsSync(CLAUDE_PROJECTS)) {
      for (const p of listFiles(CLAUDE_PROJECTS, ".jsonl")) jobs.push([p, "claude"]);
    }
    if (existsSync(CODEX_SESSIONS)) {
      for (const p of listFiles(CODEX_SESSIONS, ".jsonl")) jobs.push([p, "codex"]);
    }
  }

  const stats: Record<string, number> = {
    new: 0, updated: 0, same: 0, skipped: 0, failed: 0, collided: 0,
  };
  const taken = new Map<string, string>();
  let utterances = 0;

  for (const [src, kind] of jobs) {
    let result: Rendered;
    try {
      result = kind === "claude" ? renderClaude(src) : renderCodex(src);
    } catch (err) {
      // 1ファイルの失敗で全体を止めない
      stats.failed += 1;
      console.error(`  ✗ ${basename(src)}: ${(err as Error).message}`);
      continue;
    }

    if (result === null) {
      stats.skipped += 1;
      continue;
    }

    const [text, meta] = result;
    if (since && meta.date !== "0000-00-00" && meta.date < since) {
      stats.skipped += 1;
      continue;
    }

    // 出力名は元 jsonl と1:1にする。session_id の先頭8文字は一意ではなく
    // (52de10eb で始まる別セッションが実在した)、サブエージェントは親と
    // 同じ sessionId を持つので、どちらも元ファイル名を鍵にするしかない。
    const sub = src.includes("/subagents/") ? "/subagents" : "";
    const stem = basename(src, ".jsonl");
    let key = safeName(stem);
    if (key.startsWith("rollout-")) key = key.slice("rollout-".length); // Codex は日時が名前に入っていて冗長

    let out = join(KYOTEN, "bouken", kind, safePath(meta.slug + sub), `${meta.date}_${key}.md`);

    // それでも衝突するなら元ファイル名を足す。入力はソート済みなので結果は安定する
    const owner = taken.get(out);
    if (owner !== undefined && owner !== src) {
      out = join(dirname(out), `${meta.date}_${key}_${safeName(stem)}.md`);
      stats.collided += 1;
    }
    taken.set(out, src);

    stats[writeIfChanged(out, text, args.flags["dry-run"]) as WriteState] += 1;
    utterances += meta.utterances;
  }

  const total = stats.new + stats.updated + stats.same;
  if (args.flags.quiet) {
    console.log(
      `utsushi: ${total}さつ (new ${stats.new} / upd ${stats.updated} ` +
        `/ same ${stats.same}) 発言 ${n(utterances)}`,
    );
  } else {
    console.log(args.flags["dry-run"] ? "（書かずに確認）" : "");
    console.log(`  ぼうけんのしょ : ${n(total)} さつ`);
    console.log(`    あたらしい   : ${n(stats.new)}`);
    console.log(`    かきかえ     : ${n(stats.updated)}`);
    console.log(`    かわらず     : ${n(stats.same)}`);
    console.log(`    なかみ なし  : ${n(stats.skipped)}`);
    if (stats.collided) console.log(`    なまえ衝突   : ${n(stats.collided)}`);
    if (stats.failed) console.log(`    しっぱい     : ${n(stats.failed)}`);
    console.log(`  じぶんの はつげん : ${n(utterances)}`);
    console.log(`  ばしょ : ${join(KYOTEN, "bouken")}`);
  }

  return stats.failed ? 1 : 0;
}

process.exit(main());
