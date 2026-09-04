#!/usr/bin/env node
/**
 * hook — 会話の合間に拠点を思い出させる
 *
 * 定時便が「溜める」係なら、こちらは「思い出させる」係。
 * 溜めた記憶は、引く動機がないと使われない。2階まで建てたのに、
 * こちらから見に行かないと何も返ってこないのでは、原則4で挙げた
 * 止まった3つと同じことになる。
 *
 * Claude Code の hooks から呼ばれる。stdin に来る JSON の
 * `hook_event_name` で鳴らし分ける。
 *
 *     SessionStart      拠点の地図といちばん新しい週報を配る
 *     UserPromptSubmit  過去を指す言い回しを見つけたら検索を促す
 *     SessionEnd        その場で `会話/` に写す（夜まで待たない）
 *
 * 原則:
 *   - 何があっても 0 で終わる。何も出ないのは構わないが、ここが原因で
 *     セッションが止まるのはいちばん困る。例外は全部飲んで黙る。
 *   - 拠点には書かない。写しは sessions.ts に渡す（原則5: 書き込み口を絞る）。
 *   - 拠点の中身をそのまま配るのは、週報の見出しと数だけにする。会話原文は
 *     渡さない（そこに実名もメールアドレスも入っている）。
 *
 * 使い方（手で確かめるとき）:
 *     echo '{"hook_event_name":"SessionStart"}' | bin/hook.ts
 *     echo '{"hook_event_name":"UserPromptSubmit","prompt":"あの話どこだっけ"}' | bin/hook.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { KYOTEN, n, slugFromCwd } from "./util.ts";
import { bullets, entityList, readDoc, section, weeklyList } from "./read.ts";
import { DB, ROOMS } from "./search.ts";
import { listFiles } from "./cli.ts";

const SEARCH = join(import.meta.dirname, "search.ts");
const SESSIONS = join(import.meta.dirname, "sessions.ts");

/**
 * 過去を指す言い回し。
 *
 * 「前に」「今日」のような、ふつうの文にいくらでも出てくる語は入れない
 * （`bin/hook.ts --check` で `自分/` に当てて数を見られる）。ここが
 * ゆるいと毎プロンプト鳴って、すぐ読み飛ばされるようになる。
 */
const PAST: readonly RegExp[] = [
  /だっけ/,
  /あの(?:話|とき|時|件|やつ|コード|ファイル|リポジトリ)/,
  /例の/,
  /以前/,
  /前回/,
  /この(?:まえ|前)/,
  /(?:いつ|なに|なん|どこ|どう)だった(?:っけ|か)/,
  /思い出せ/,
  /前にも/,
  /むかし|昔/,
  /どこ(?:に|へ)?(?:ある|あった|あります|置いた|書いた|入れた|やった)/,
];

function detect(prompt: string): string | null {
  for (const re of PAST) {
    const got = re.exec(prompt);
    if (got) return got[0];
  }
  return null;
}

// ---------------------------------------------------------------- 鳴らす

/** hooks の口に合わせて返す。additionalContext がそのまま会話に入る。 */
function ring(event: string, context: string): void {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }),
  );
}

function mapOfKyoten(): string[] {
  const lines: string[] = [];

  if (existsSync(DB)) {
    try {
      // 刻み直しはしない。ここは待たせてよい場所ではないので、あるものだけ読む
      const con = new DatabaseSync(DB, { readOnly: true });
      const meta = new Map<string, string>();
      for (const r of con.prepare("SELECT k, v FROM meta").all() as { k: string; v: string }[]) {
        meta.set(r.k, r.v);
      }
      const last = (con.prepare("SELECT MAX(date) d FROM chunk").get() as { d: string }).d ?? "";
      con.close();
      lines.push(
        `拠点: ${n(Number(meta.get("files") ?? 0))}ファイル / ` +
          `${n(Number(meta.get("chunks") ?? 0))}かたまり` +
          (last ? `（${last} まで刻んである）` : ""),
      );
    } catch {
      // 索引が壊れていても、週報は配れる
    }
  }
  return lines;
}

function sessionStart(payload: Record<string, unknown>): void {
  if (!existsSync(KYOTEN)) return;

  const lines = mapOfKyoten();

  // いま居る場所について拠点が何を憶えているか。ここが「引く動機」になる。
  // 事典の名前は `<user>/<repo>` の形のものだけ見る（落とし穴18: `Work` や
  // `_home` はただの単語なので、名前で照らし合わせる相手にならない）
  const slug = slugFromCwd(typeof payload.cwd === "string" ? payload.cwd : "");
  if (slug.includes("/")) {
    const here = entityList().find((f) => f.name === slug);
    if (here) {
      lines.push(
        `ここ（${here.name}）は拠点にある: ${here.first} 〜 ${here.last}・` +
          `会話 ${n(here.sessions)}・コミット ${n(here.commits)} → ${here.path}`,
      );
    }
  }

  const head = weeklyList().at(-1);
  if (head) {
    const doc = readDoc(join(KYOTEN, head.path));
    lines.push(`いちばん新しい週報 ${head.week}（${head.from} 〜 ${head.to}）`);
    const now = bullets(section(doc, "今週"))[0];
    if (now) lines.push(`  ${now}`);
    const stale = bullets(section(doc, "止まっているもの"))[0];
    if (stale) lines.push(`  止まっているもの: ${stale}`);
    lines.push(`  ぜんぶ読む: ${head.path}`);
  }

  if (!lines.length) return;

  lines.push(
    "過去を引くときは拠点の全文検索を使う（写した場所だけが引ける）:",
    `  ${SEARCH} "語" [--room ${ROOMS.join("|")}] [--project polidog/kyoten] [--since YYYY-MM-DD]`,
  );

  ring("SessionStart", lines.join("\n"));
}

function userPromptSubmit(payload: Record<string, unknown>): void {
  const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
  if (!prompt || !existsSync(DB)) return;
  const hit = detect(prompt);
  if (!hit) return;

  ring(
    "UserPromptSubmit",
    `過去を指す言い回しがある（「${hit}」）。\n` +
      `拠点に写しがあるので、憶測で答える前に引くこと:\n` +
      `  ${SEARCH} "語" [--room ${ROOMS.join("|")}] [--project <user>/<repo>] [--since YYYY-MM-DD]\n` +
      "引けなかったら「拠点には無い」と言う。無いことも観測結果になる。",
  );
}

/**
 * 終わったその場で `会話/` に写す。
 *
 * 定時便は毎晩 03:00 に全部を写し直すので、ここが落ちても写しは
 * いずれ取れる。それでもここで写すのは、`cleanupPeriodDays` を落とした
 * 機械や、写す前にログを消される場合に備えるため。
 */
function sessionEnd(payload: Record<string, unknown>): void {
  const path = typeof payload.transcript_path === "string" ? payload.transcript_path : "";
  if (!path || !existsSync(path) || !existsSync(KYOTEN)) return;

  // 落とし穴25: execFileSync は成功時の stderr を返さない。ここでは出力を使わないが
  // 作法を揃えておく。失敗しても黙る（夜が拾う）
  spawnSync(process.execPath, [SESSIONS, "--file", path, "--quiet"], {
    stdio: "ignore",
    timeout: 20_000,
  });
}

// ---------------------------------------------------------------- ためし

/** `自分/` に当てて、UserPromptSubmit が何割で鳴るかを数える。 */
function check(): number {
  const paths = listFiles(join(KYOTEN, "自分"), ".md");
  let total = 0;
  let hit = 0;
  const counts = new Map<string, number>();

  for (const p of paths) {
    for (const doc of readFileSync(p, "utf8").split(/^## /m).slice(1)) {
      total += 1;
      const got = detect(doc);
      if (got) {
        hit += 1;
        counts.set(got, (counts.get(got) ?? 0) + 1);
      }
    }
  }
  console.log(`発言 ${n(total)} 件中 ${n(hit)} 件で鳴る（${(hit / total * 100).toFixed(1)}%）`);
  for (const [k, v] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(12)} ${n(v)}`);
  }
  return 0;
}

// ---------------------------------------------------------------- main

function main(): number {
  if (process.argv.includes("--check")) return check();

  if (process.stdin.isTTY) {
    // 端末から素で叩かれた。stdin を待つと黙って止まって見える
    console.log("hook.ts は Claude Code の hooks から stdin で呼ばれます。");
    console.log("  echo '{\"hook_event_name\":\"SessionStart\"}' | bin/hook.ts");
    console.log("  bin/hook.ts --check   # `自分/` に当てて、何割で鳴るか数える");
    return 0;
  }

  let payload: Record<string, unknown> = {};
  try {
    const raw = readFileSync(0, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") payload = parsed as Record<string, unknown>;
  } catch {
    return 0; // stdin が無い・壊れている。黙る
  }

  const event = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";
  try {
    if (event === "SessionStart") sessionStart(payload);
    else if (event === "UserPromptSubmit") userPromptSubmit(payload);
    else if (event === "SessionEnd") sessionEnd(payload);
  } catch {
    // ここが原因でセッションを止めない
  }
  return 0;
}

process.exit(main());
