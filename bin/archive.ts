#!/usr/bin/env node
/**
 * archive — 古い Obsidian 保管庫を拠点へしまう
 *
 * `reading-notes` の中身を、ファイルの形を変えずに
 * `アーカイブ/reading-notes/` へ写す。元の保管庫は消さない。
 *
 * 原則:
 *   - 決定論的: パス順に写す
 *   - 冪等: 内容が同じファイルには触れない
 *   - 原文ママ: Markdown だけでなく画像・PDF・Obsidian の設定もそのまま写す
 *   - 追記的: 元から消えたファイルもアーカイブ側からは消さない
 *
 * 使い方:
 *     archive.ts
 *     archive.ts --dry-run
 *
 * 環境変数 `KYOTEN_READING` で元の場所を変えられる。
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

import { KYOTEN, n } from "./util.ts";
import { parseArgs } from "./cli.ts";

const SOURCE = process.env.KYOTEN_READING ??
  join(homedir(), "Documents/Obsidian/reading-notes");
const DEST = join(KYOTEN, "アーカイブ", "reading-notes");

interface Count {
  new: number;
  updated: number;
  same: number;
  skipped: number;
}

function inside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent + sep);
}

function sameFile(source: string, dest: string): boolean {
  if (!existsSync(dest)) return false;
  const got = lstatSync(dest);
  if (!got.isFile()) return false;
  const src = statSync(source);
  if (src.size !== got.size) return false;
  return readFileSync(source).equals(readFileSync(dest));
}

function copyTree(source: string, dest: string, dryRun: boolean, count: Count): void {
  if (!dryRun) mkdirSync(dest, { recursive: true });

  const entries = readdirSync(source, { withFileTypes: true })
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const entry of entries) {
    const src = join(source, entry.name);
    const out = join(dest, entry.name);
    if (entry.isDirectory()) {
      if (existsSync(out) && !lstatSync(out).isDirectory()) {
        throw new Error(`しまう先がディレクトリではありません: ${out}`);
      }
      copyTree(src, out, dryRun, count);
      continue;
    }
    if (!entry.isFile()) {
      // シンボリックリンクを辿ると、保管庫の外まで意図せず写しうる。
      count.skipped += 1;
      continue;
    }
    if (sameFile(src, out)) {
      count.same += 1;
      continue;
    }
    const existed = existsSync(out);
    if (existed && !lstatSync(out).isFile()) {
      throw new Error(`しまう先がファイルではありません: ${out}`);
    }
    count[existed ? "updated" : "new"] += 1;
    if (dryRun) continue;

    mkdirSync(resolve(out, ".."), { recursive: true });
    copyFileSync(src, out);
    const meta = statSync(src);
    chmodSync(out, meta.mode);
    utimesSync(out, meta.atime, meta.mtime);
  }
}

function main(): number {
  const args = parseArgs(process.argv.slice(2), ["dry-run", "quiet"]);
  const source = resolve(SOURCE);
  const dest = resolve(DEST);

  if (!existsSync(source) || !statSync(source).isDirectory()) {
    console.error(`reading-notes がありません: ${source}`);
    return 1;
  }
  if (inside(source, dest) || inside(dest, source)) {
    console.error("元の保管庫とアーカイブ先が重なっています");
    return 1;
  }

  const count: Count = { new: 0, updated: 0, same: 0, skipped: 0 };
  try {
    copyTree(source, dest, args.flags["dry-run"], count);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`アーカイブできません: ${message}`);
    return 1;
  }

  const total = count.new + count.updated + count.same;
  const bits = [`新規 ${n(count.new)}`, `更新 ${n(count.updated)}`, `同じ ${n(count.same)}`];
  if (count.skipped) bits.push(`対象外 ${n(count.skipped)}`);
  const trial = args.flags["dry-run"] ? "（書かずに確認）" : "";
  console.log(
    `アーカイブ: ${n(total)} ファイル（${bits.join("・")}）` +
      ` → アーカイブ/reading-notes${trial}`,
  );
  return 0;
}

process.exit(main());
