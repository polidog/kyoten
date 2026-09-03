/**
 * cli — 道具の入口まわり
 *
 * Python の argparse にあたるものが Node の標準ライブラリにも
 * (`node:util` の parseArgs) あるが、こちらは道具どうしで引数の形を
 * 揃えるための薄い層。`--dry-run` `--since` `--quiet` は全部の道具で
 * 同じ意味を持たせる。
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs as nodeParseArgs } from "node:util";

export interface Args {
  readonly flags: Record<string, boolean>;
  readonly values: Record<string, string | undefined>;
  readonly rest: readonly string[];
}

export function parseArgs(
  argv: readonly string[],
  flags: readonly string[],
  values: readonly string[] = [],
): Args {
  const options: Record<string, { type: "boolean" | "string" }> = {};
  for (const f of flags) options[f] = { type: "boolean" };
  for (const v of values) options[v] = { type: "string" };

  const parsed = nodeParseArgs({
    args: [...argv],
    options,
    allowPositionals: true,
    strict: false,
  });

  const gotFlags: Record<string, boolean> = {};
  for (const f of flags) gotFlags[f] = parsed.values[f] === true;
  const gotValues: Record<string, string | undefined> = {};
  for (const v of values) {
    const raw = parsed.values[v];
    gotValues[v] = typeof raw === "string" ? raw : undefined;
  }

  return { flags: gotFlags, values: gotValues, rest: parsed.positionals };
}

/**
 * `--since` を読む。読めなければ undefined を返す（呼び出し側は 2 で終わる）。
 * 無指定なら null。比較は文字列のまま行うので YYYY-MM-DD で返す。
 */
export function parseSince(raw: string | undefined): string | null | undefined {
  if (raw === undefined) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(raw))) {
    console.error(`--since の日付が読めません: ${raw}`);
    return undefined;
  }
  return raw;
}

/**
 * ディレクトリを再帰して、拡張子の合うファイルをパス順に返す。
 * Python の `sorted(root.rglob("*.jsonl"))` にあたる。
 */
export function listFiles(root: string, suffix: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root, { recursive: true, encoding: "utf8" }) as string[];
  } catch {
    return [];
  }
  return entries
    .filter((rel) => rel.endsWith(suffix))
    .map((rel) => join(root, rel))
    .sort();
}
