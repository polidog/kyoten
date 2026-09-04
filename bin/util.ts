/**
 * util — 共通の部品
 *
 * 道具が共通で使う小道具。ここに置くものは「原則」を守るための部品だけにする。
 *
 *   - 決定論的: 同じ入力なら必ず同じ出力。生成日時などの揺れる値を書かない。
 *   - 冪等: 内容が変わらなければファイルに触れない (mtime も動かさない)。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const KYOTEN = process.env.KYOTEN ?? join(homedir(), "Documents/Obsidian/kyoten");
export const CLAUDE_PROJECTS = join(homedir(), ".claude/projects");
export const CODEX_SESSIONS = join(homedir(), ".codex/sessions");

/** 拠点の時刻はすべて JST。記事の URL が公開日から作られるので、ずれると住所が変わる。 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * ISO8601 の文字列を JST の時刻として読む。
 *
 * 返すのは「JST の壁掛け時計をそのまま UTC のつもりで持った Date」。
 * `getUTCHours()` で JST の時が取れる。実行環境の TZ に依存させないため
 * （`toLocaleString` は環境のロケールで表記が変わる）。
 */
export function jst(ts: string | null | undefined): Date | null {
  if (!ts) return null;
  const ms = Date.parse(ts.replace(/Z$/, "+00:00"));
  if (Number.isNaN(ms)) return null;
  return new Date(ms + JST_OFFSET_MS);
}

export function hhmm(dt: Date | null): string {
  if (!dt) return "--:--:--";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(dt.getUTCHours())}:${p(dt.getUTCMinutes())}:${p(dt.getUTCSeconds())}`;
}

/**
 * Python の `datetime.isoformat()` と同じ形の JST 時刻。
 *
 * 拠点の frontmatter には `2026-08-29T00:49:03.338000+09:00` の形で
 * 書かれている。Python はマイクロ秒6桁を出し、0 のときは省く。JS の Date は
 * ミリ秒しか持たないので、3桁に 000 を足して桁を合わせる（元のログが
 * ミリ秒精度なので情報は落ちない）。
 */
export function isoJst(dt: Date): string {
  const p = (v: number, w = 2) => String(v).padStart(w, "0");
  const base =
    `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}` +
    `T${p(dt.getUTCHours())}:${p(dt.getUTCMinutes())}:${p(dt.getUTCSeconds())}`;
  const ms = dt.getUTCMilliseconds();
  return `${base}${ms ? `.${p(ms, 3)}000` : ""}+09:00`;
}

/**
 * Python の `json.dumps(x, ensure_ascii=False, indent=2, sort_keys=True)` と
 * 同じ文字列を作る。キーの順で差が出ると、内容が同じでも毎回 updated になる。
 */
export function sortedJson(value: unknown, indent = 2): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) {
        out[k] = sort((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value), null, indent);
}

/** JST の日付 (YYYY-MM-DD)。 */
export function ymd(dt: Date): string {
  return dt.toISOString().slice(0, 10);
}

/** JST の年月 (YYYY-MM)。 */
export function ym(dt: Date): string {
  return dt.toISOString().slice(0, 7);
}

/** cwd をプロジェクト名にする。ghq 配下ならホスト以降を使う。 */
export function slugFromCwd(cwd: string | null | undefined): string {
  if (!cwd) return "_unknown";
  const parts = cwd.split("/").filter((s) => s !== "");
  const i = parts.indexOf("ghq");
  if (i >= 0) {
    const rest = parts.slice(i + 2); // ghq/github.com/ を飛ばす
    if (rest.length) return rest.join("/");
  }
  if (cwd === homedir()) return "_home";
  return parts.at(-1) ?? "_unknown";
}

/** スラッシュはディレクトリとして残し、危険な文字だけ落とす。 */
export function safePath(slug: string): string {
  const parts = slug
    .split("/")
    .filter((s) => s !== "" && s !== "." && s !== "..")
    // Python の \w は Unicode 対応。日本語スラッグを潰さないよう同じ範囲にする。
    .map((s) => s.replace(/[^\p{L}\p{N}_.\-]/gu, "_"));
  return parts.join("/") || "_unknown";
}

/** 本文に ``` が含まれていても壊れないコードフェンスを作る。 */
export function fence(body: string, lang = ""): string {
  const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const bar = "`".repeat(Math.max(3, longest + 1));
  return `${bar}${lang}\n${body}\n${bar}`;
}

/**
 * ツール結果が JSON 文字列なら日本語が読める形に開く。
 *
 * MCP の戻り値などは \uXXXX でエスケープされた JSON がそのまま入っている。
 * そのままでは Obsidian で読めず、全文検索でも日本語が引けない。
 * 開けなければ原文のまま返す。原本は jsonl にある。
 */
export function unescapeJson(text: string): string {
  const head = text.trimStart()[0];
  if (head !== "{" && head !== "[") return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/**
 * 先頭 n 文字。Python の `text[:n]` と同じ数え方（コードポイント）。
 *
 * JS の `slice()` は UTF-16 の単位で切るので、絵文字や Nerd Font の
 * 私用領域文字が入ると Python より手前で切れる。見出しの `— \`…\`` が
 * 1 文字ずれて、内容が同じなのに毎回 updated になる。
 */
export function take(text: string, limit: number): string {
  const chars = [...text];
  return chars.length <= limit ? text : chars.slice(0, limit).join("");
}

export function clip(text: string, limit: number): string {
  // Python 版と同じ数え方にするため、コードポイントで数える
  // （JS の length は UTF-16 の単位なので、絵文字で食い違う）。
  const chars = [...text];
  if (chars.length <= limit) return text;
  const omitted = chars.length - limit;
  return chars.slice(0, limit).join("") +
    `\n… （${omitted.toLocaleString("en-US")} 文字省略。原本は jsonl にあります）`;
}

/** content が文字列でも配列でも、テキストを取り出す。 */
export function asText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const out: string[] = [];
    for (const block of content) {
      if (typeof block === "string") {
        out.push(block);
      } else if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string" && b.text) out.push(b.text);
        else if (typeof b.text === "string" && b.text) out.push(b.text);
      }
    }
    return out.join("\n\n");
  }
  if (typeof content === "object") {
    const c = content as Record<string, unknown>;
    return typeof c.text === "string" ? c.text : "";
  }
  return String(content);
}

export type WriteState = "new" | "updated" | "same";

/**
 * 内容が同じなら触れない。戻り値は new / updated / same。
 *
 * Node は改行を変換しないので Python の newline="" にあたる指定は要らない
 * （Python 版はここで CRLF が LF に化けて冪等が壊れた）。読み書きとも
 * バイト列のまま扱う。
 */
export function writeIfChanged(path: string, body: string, dryRun = false): WriteState {
  let state: WriteState = "new";
  if (existsSync(path)) {
    try {
      if (readFileSync(path, "utf8") === body) return "same";
    } catch {
      // 読めないものは書き直す
    }
    state = "updated";
  }
  if (!dryRun) {
    mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    writeFileSync(path, body, "utf8");
  }
  return state;
}

export type Fields = Record<string, string | number | null | undefined>;

export function frontmatter(fields: Fields): string {
  const lines = ["---"];
  for (const [k, raw] of Object.entries(fields)) {
    if (raw == null || raw === "") continue;
    let v: string | number = raw;
    if (typeof v === "string" && (v.includes(":") || v.startsWith("[") || v.includes("#"))) {
      v = JSON.stringify(v);
    }
    lines.push(`${k}: ${v}`);
  }
  lines.push("---");
  return lines.join("\n");
}

/**
 * 先頭の frontmatter を切り離す。戻り値は [辞書, 本体, 本体の開始行番号]。
 * 行番号は 1 始まり。frontmatter が無ければ [{}, text, 1]。
 */
export function splitFrontmatter(text: string): [Record<string, string>, string, number] {
  if (!text.startsWith("---")) return [{}, text, 1];
  const lines = text.split("\n");
  if (lines[0].trim() !== "---") return [{}, text, 1];

  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() !== "---") continue;
    const fields: Record<string, string> = {};
    for (const rawLine of lines.slice(1, i)) {
      const at = rawLine.indexOf(":");
      if (at < 0) continue;
      const key = rawLine.slice(0, at).trim();
      let value = rawLine.slice(at + 1).trim();
      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        try {
          value = JSON.parse(value) as string;
        } catch {
          // クォートが壊れていれば原文のまま
        }
      }
      fields[key] = value;
    }
    return [fields, lines.slice(i + 1).join("\n"), i + 2];
  }
  return [{}, text, 1];
}

/** jsonl を1行ずつ読む。壊れた行は黙って飛ばす（原本は残る）。 */
export function* readJsonl(path: string): Generator<Record<string, unknown>> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const row: unknown = JSON.parse(s);
      if (row && typeof row === "object") yield row as Record<string, unknown>;
    } catch {
      continue;
    }
  }
}

export function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** 数を 1,234 の形にする。ロケールに依存させない。 */
export function n(value: number): string {
  return value.toLocaleString("en-US");
}
