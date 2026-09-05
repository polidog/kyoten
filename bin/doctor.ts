#!/usr/bin/env node
/**
 * doctor — この機械の具合を見る
 *
 * 拠点を新しい PC で使いはじめるとき、そして「なんか入っていない」と
 * 思ったときに叩く。**読むだけ**（拠点にも設定にも一切書かない）。
 *
 * ## なぜ道具にしたか
 *
 * セットアップの判定は、ほとんど**機械にできる**。hostname が `config.ts` に
 * 載っているか、timer が enabled か、`.gitignore` に `素材/` があるか ——
 * どれも読めば分かる。分かることを人に確かめさせない（原則4 と同じ考え）。
 *
 * 人にしかできないのは2つだけで、そこは名指しして渡す:
 *
 *   - Obsidian Sync の選択同期（GUI）
 *   - hostname を何にするか
 *
 * ## 「まだ」と「壊れている」を分ける
 *
 * 新しい機械では、ほとんどが「まだ」。それを赤くしても意味が無いので
 * 3つに分ける（落とし穴64 と同じ形）:
 *
 *   ✓ できている　　… そのまま
 *   ・ まだ　　　　　… これからやる。直しかたを添える
 *   ✗ 食い違い　　　… 設定どうしが噛み合っていない。放っておくと黙って壊れる
 *
 * 使い方:
 *     doctor.ts            # 全部見る
 *     doctor.ts --quiet    # 足りないものだけ
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CLAUDE_PROJECTS, CODEX_SESSIONS, KYOTEN, n, readText } from "./util.ts";
import { parseArgs } from "./cli.ts";
import { CONFIG, KNOWN, MACHINE, SOZAI, machines, runs, settledThrough } from "./machine.ts";
import { MACHINES, たたむ } from "../config.ts";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

type Mark = "ok" | "todo" | "bad";

interface Line {
  readonly mark: Mark;
  readonly what: string;
  readonly note: string;
  /** 直しかた。人が打つ1行。 */
  readonly fix?: string;
}

const lines: Line[] = [];
const ok = (what: string, note: string) => lines.push({ mark: "ok", what, note });
const todo = (what: string, note: string, fix?: string) =>
  lines.push({ mark: "todo", what, note, fix });
const bad = (what: string, note: string, fix?: string) =>
  lines.push({ mark: "bad", what, note, fix });

/** 外の道具を1回叩く。落ちたら null（入っていないことも普通にある）。 */
function sh(cmd: string, args: readonly string[]): string | null {
  try {
    return execFileSync(cmd, [...args], {
      encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 見るところ

function checkNode(): void {
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 24) ok("node", `v${process.versions.node}（.ts をそのまま走らせられる）`);
  else {
    bad("node", `v${process.versions.node} —— 24 以上が要る（型注釈を剥がして直接実行する）`,
      "mise use -g node@24");
  }
}

function checkKyoten(): void {
  if (!existsSync(KYOTEN)) {
    todo("拠点", `${KYOTEN} がまだ無い`,
      "Obsidian Sync を張って、拠点が降りてくるのを待つ（KYOTEN で場所を変えられる）");
    return;
  }
  const rooms = readdirSync(KYOTEN).filter((f) => !f.startsWith(".")).length;
  ok("拠点", `${KYOTEN}（${rooms} 個の入れもの）`);
}

function checkMachine(): void {
  const raw = sh("hostname", []) ?? "";
  const feeder = !たたむ.some((t) => runs(t));
  if (!KNOWN) {
    todo("機械の名前", `${MACHINE}（hostname: ${raw}）—— config.ts に無いので既定＝集めるだけ`,
      `config.ts に  "${MACHINE}": { 走らせる: あつめるだけ, 索引: true, commit: false },`);
    return;
  }
  ok("機械の名前", `${MACHINE} ／ ${feeder ? "集める側" : "畳む側"}` +
    `${CONFIG.commit ? "・拠点に記録する" : ""} ／ 道具 ${CONFIG.走らせる.length}本`);
}

/** 拠点の git を打つ機械は、1台でなければならない。 */
function checkCommitOwner(): void {
  const owners = Object.entries(MACHINES).filter(([, m]) => m.commit).map(([k]) => k);
  if (owners.length === 1) {
    ok("記録する機械", `${owners[0]} の1台だけ`);
  } else if (owners.length === 0) {
    todo("記録する機械", "どの機械も拠点に git を打たない（Obsidian のバージョン履歴だけが頼り）",
      "config.ts のどれか1台を commit: true にする");
  } else {
    bad("記録する機械", `${owners.join(" / ")} の ${owners.length} 台が打つ —— ` +
      "Obsidian Sync は .git を運ばないので、同じ内容について履歴が割れる",
      "config.ts で commit: true を1台に絞る");
  }
}

function checkLogs(): void {
  const claude = existsSync(CLAUDE_PROJECTS)
    ? readdirSync(CLAUDE_PROJECTS, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".jsonl")).length
    : -1;
  if (claude < 0) todo("Claude Code のログ", `${CLAUDE_PROJECTS} がまだ無い`);
  else ok("Claude Code のログ", `${n(claude)} 本`);

  const codex = existsSync(CODEX_SESSIONS)
    ? readdirSync(CODEX_SESSIONS, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".jsonl")).length
    : -1;
  if (codex < 0) todo("Codex のログ", `${CODEX_SESSIONS} がまだ無い（使っていなければそれでよい）`);
  else ok("Codex のログ", `${n(codex)} 本`);
}

/**
 * 会話ログの保存期間。**未設定だと 30 日で消える。**
 * `会話/` は拠点で唯一つくり直せない部屋なので、ここが要。
 */
function checkCleanup(): void {
  const path = join(homedir(), ".claude/settings.json");
  let days: unknown;
  try {
    days = (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>).cleanupPeriodDays;
  } catch {
    todo("ログの保存期間", `${path} が読めない —— 未設定だと 30 日で会話ログが消える`,
      `${path} に  "cleanupPeriodDays": 3650`);
    return;
  }
  if (typeof days === "number" && days >= 365) ok("ログの保存期間", `${n(days)} 日`);
  else {
    bad("ログの保存期間", `${days ?? "未設定"} —— 短いと会話ログが消える。` +
      "`会話/` は拠点で唯一つくり直せない",
      `${path} に  "cleanupPeriodDays": 3650`);
  }
}

function checkGhq(): void {
  const ghq = join(homedir(), "ghq");
  if (!existsSync(ghq)) {
    todo("ghq", `${ghq} がまだ無い（\`作業/\` が空になるだけで、壊れはしない）`);
    return;
  }
  let count = 0;
  try {
    for (const rel of readdirSync(ghq, { recursive: true, encoding: "utf8" }) as string[]) {
      if (rel.endsWith("/.git") && rel.split("/").length === 4) count += 1;
    }
  } catch { /* 読めないものは数えない */ }
  ok("ghq", `${ghq}（リポジトリ ${n(count)}）`);
}

/**
 * 素材の届き具合。**Obsidian Sync が `.json` を運んでいるかは、ここでしか見えない。**
 * 設定が off でもエラーは出ない —— 相手の機械が名簿に現れないだけ（落とし穴77）。
 */
function checkSozai(): void {
  const here = machines();
  const wanted = Object.keys(MACHINES);

  if (!here.length) {
    todo("素材", `${SOZAI} がまだ無い`, "bin/nightly.ts --dry-run --no-commit で一度流す");
    return;
  }

  const missing = wanted.filter((m) => !here.includes(m));
  const extra = here.filter((m) => !wanted.includes(m));

  if (missing.length) {
    bad("素材", `名簿は ${here.length}台（${here.join(" / ")}）。` +
      `**${missing.join(" / ")} が届いていない**`,
      "Obsidian Sync の選択同期で .json（その他の形式）を on にする／" +
      "向こうの機械でまだ一度も流していないなら、流す");
  } else {
    ok("素材", `${here.length}台（${here.join(" / ")}）`);
  }
  if (extra.length) {
    todo("名簿にある余りもの", `${extra.join(" / ")} は config.ts に無い`,
      `config.ts に足すか、rm -rf ${join(SOZAI, extra[0])}`);
  }

  const settled = settledThrough();
  const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
  if (settled === null) {
    todo("揃った日", "見た.json が読めない機械が居る（門は建てない）");
  } else if (settled >= today) {
    // **「名簿にある機械」でしかない。** 届いていない機械は門が待たないので、
    // ここで「全機械」と言うと、その上の ✗ と食い違う
    ok("揃った日", `${settled}（名簿の ${here.length}台は今日ぶんまで見ている）`);
  } else {
    todo("揃った日", `${settled} まで —— 追記のみの部屋（日記・よその日記・出来事・見立て）は` +
      "ここで止まる。遅れるだけで、抜けはしない");
  }
}

function checkVaultGit(): void {
  if (!existsSync(join(KYOTEN, ".git"))) {
    if (CONFIG.commit) {
      todo("拠点の git", "まだ init されていない（この機械は記録する側）",
        `git -C ${KYOTEN} init`);
    } else {
      ok("拠点の git", "この機械では打たない（config.ts の commit が false）");
    }
    return;
  }
  const ignore = readText(join(KYOTEN, ".gitignore"));
  const holes: string[] = [];
  if (!/^素材\/?$/m.test(ignore)) holes.push("素材/");
  if (!/\*\.db/m.test(ignore)) holes.push("*.db");
  if (holes.length) {
    bad("拠点の .gitignore", `${holes.join(" と ")} が抜けている —— 索引や中間物が履歴に入る` +
      "（前に 144MB を5世代ぶん積んだ）",
      `${join(KYOTEN, ".gitignore")} に足す`);
  } else {
    ok("拠点の .gitignore", "素材/ と *.db を落としている");
  }
}

function checkTimer(): void {
  const unit = join(homedir(), ".config/systemd/user/kyoten.timer");
  if (!existsSync(unit)) {
    todo("定時便", "unit がまだ置かれていない",
      `ln -s ${join(REPO, "systemd")}/kyoten.{service,timer} ~/.config/systemd/user/`);
    return;
  }
  const enabled = sh("systemctl", ["--user", "is-enabled", "kyoten.timer"]);
  if (enabled !== "enabled") {
    todo("定時便", `unit はあるが ${enabled ?? "止まっている"}`,
      "systemctl --user enable --now kyoten.timer");
    return;
  }
  const next = sh("systemctl", ["--user", "show", "kyoten.timer",
    "--property=NextElapseUSecRealtime", "--value"]);
  ok("定時便", `enabled${next ? `（つぎ ${next}）` : ""}`);
}

function checkSkills(): void {
  const missing: string[] = [];
  for (const name of readdirSync(join(REPO, "skills"))) {
    const link = join(homedir(), ".claude/skills", name);
    let good = false;
    try {
      good = statSync(link).isDirectory();
    } catch { /* 無い */ }
    if (!good) missing.push(name);
  }
  if (missing.length) {
    todo("skill", `${missing.join(" / ")} が張られていない`,
      `for s in ${missing.join(" ")}; do ln -s ${join(REPO, "skills")}/$s ~/.claude/skills/$s; done`);
  } else {
    ok("skill", `${readdirSync(join(REPO, "skills")).join(" / ")} が張ってある`);
  }
}

/** `読んだ/` は Chrome の履歴を読む。走らせない機械では見ない。 */
function checkChrome(): void {
  if (!runs("reading")) return;
  const root = process.env.KYOTEN_CHROME ?? CONFIG.chrome ??
    join(homedir(), ".config/google-chrome");
  if (existsSync(root)) ok("Chrome の履歴", root);
  else todo("Chrome の履歴", `${root} が無い（\`読んだ/\` の chrome 側が空になるだけ）`,
    "KYOTEN_CHROME か config.ts の chrome で場所を指す");
}

// ---------------------------------------------------------------- 入口

function main(): number {
  const args = parseArgs(process.argv.slice(2), ["quiet"]);

  checkNode();
  checkKyoten();
  checkMachine();
  checkCommitOwner();
  checkLogs();
  checkCleanup();
  checkGhq();
  checkChrome();
  checkSozai();
  checkVaultGit();
  checkTimer();
  checkSkills();

  const mark = { ok: "✓", todo: "・", bad: "✗" } as const;
  const shown = args.flags.quiet ? lines.filter((l) => l.mark !== "ok") : lines;

  for (const l of shown) {
    console.log(`${mark[l.mark]} ${l.what}　${l.note}`);
    if (l.fix && l.mark !== "ok") console.log(`    → ${l.fix}`);
  }

  const bads = lines.filter((l) => l.mark === "bad").length;
  const todos = lines.filter((l) => l.mark === "todo").length;

  console.log();
  if (!bads && !todos) console.log("ぜんぶそろっている。");
  else {
    console.log(
      `${bads ? `食い違い ${bads}　` : ""}${todos ? `まだ ${todos}　` : ""}` +
      `／ できている ${lines.length - bads - todos}`,
    );
    // Obsidian の設定だけは機械から見えない。毎回そう言う
    console.log(
      "Obsidian Sync の選択同期で **.json（その他の形式）** が on になっているかは、" +
      "ここからは見えない。素材の台数で判じる。",
    );
  }
  return bads ? 1 : 0;
}

process.exit(main());
