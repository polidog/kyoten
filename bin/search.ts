#!/usr/bin/env node
/**
 * search — 拠点の全文検索
 *
 * 写しを取った場所だけが引ける。拠点に無いものは検索でも出てこない。
 *
 * 刻む対象:
 *     会話/        会話の原文
 *     自分/        polidog の発言だけ
 *     アイボ/      AI が何をしたか
 *     日記/        アイボが書いた1日のまとめ
 *     投稿/ 作業/ 事典/ プロフィール/ 週報/
 *     ~/Documents/Obsidian/reading-notes/   読み専用の水源
 *
 * SQLite FTS5 の trigram トークナイザを使う。日本語を分かち書きせずに
 * そのまま引けるかわり、2文字以下の語は索引に入らない（その場合は素の
 * 部分一致に落ちる）。
 *
 * 使い方:
 *     search.ts "検索語"
 *     search.ts "検索語" --project polidog/kyoten
 *     search.ts "検索語" --room 自分 --since 2026-09-01
 *     search.ts --rebuild          # 刻み直すだけ
 *     search.ts --stats            # 索引の中身を数える
 *     search.ts --rebuild --quiet  # 刻み直して1行だけ（定時便用）
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";

import { KYOTEN, n, readText, splitFrontmatter } from "./util.ts";
import { listFiles, parseArgs, parseSince } from "./cli.ts";

export const DB = join(KYOTEN, ".search.db");
const READING_NOTES = process.env.KYOTEN_READING ??
  join(homedir(), "Documents/Obsidian/reading-notes");

/** 索引の形を変えたらここを上げる。合わなければ黙って刻み直す */
const SCHEMA = 1;

/** trigram は3文字未満を索引に入れられない */
export const TRIGRAM_MIN = 3;

const RE_HEADING = /^(#{1,6}) +([^\n]*)$/;
const RE_DATE = /(\d{4}-\d{2}-\d{2})/;
/** 「自分」の見出し: "09:12:03 polidog/kyoten（claude-code · /omarchy）" */
const RE_MINE_HEAD = /^\d\d:\d\d:\d\d +(.+?)（/;

/**
 * 「アイボ」でプロジェクト名ではない見出し。ここに無くて、しかも空白を
 * 含まないものをプロジェクト名とみなす（`# 2026-09-03 のアイボ` は空白で落ちる）。
 */
const AIBO_SECTIONS = new Set(["どれだけ動いたか", "つかった道具", "やったこと",
  "言われたこと"]);

export const ROOMS = ["会話", "自分", "アイボ", "日記", "出来事", "投稿", "作業",
  "事典", "プロフィール", "週報", "読書メモ"] as const;

function rooms(): [string, string][] {
  return [
    [join(KYOTEN, "会話"), "会話"],
    [join(KYOTEN, "自分"), "自分"],
    [join(KYOTEN, "アイボ"), "アイボ"],
    [join(KYOTEN, "日記"), "日記"],
    [join(KYOTEN, "出来事"), "出来事"],
    [join(KYOTEN, "投稿"), "投稿"],
    [join(KYOTEN, "作業"), "作業"],
    [join(KYOTEN, "事典"), "事典"],
    [join(KYOTEN, "プロフィール"), "プロフィール"],
    [join(KYOTEN, "週報"), "週報"],
    [READING_NOTES, "読書メモ"],
  ];
}

function displayPath(path: string, root: string, room: string): string {
  const rel = relative(root, path);
  return root.startsWith(KYOTEN) ? `${room}/${rel}` : `~/${relative(homedir(), path)}`;
}

// ---------------------------------------------------------------- 刻む

/** 見出しで切る。戻り値は [見出し, 開始行, 本文]。行番号は1始まり。 */
function* chunks(text: string): Generator<[string, number, string]> {
  const [, body, offset] = splitFrontmatter(text);
  const lines = body.split("\n");
  let head = "";
  let start = offset;
  let buf: string[] = [];

  const flush = (): [string, number, string] | null => {
    if (buf.some((s) => s.trim())) {
      return [head, start, buf.join("\n").replace(/^\n+|\n+$/g, "")];
    }
    return null;
  };

  for (let i = 0; i < lines.length; i++) {
    const got = RE_HEADING.exec(lines[i]);
    if (!got) {
      buf.push(lines[i]);
      continue;
    }
    const done = flush();
    if (done) yield done;
    head = got[2].trim();
    start = offset + i;
    buf = [lines[i]];
  }
  const done = flush();
  if (done) yield done;
}

function fileMeta(path: string, room: string, fields: Record<string, string>) {
  let date = fields.date || (fields.started ?? "").slice(0, 10);
  // `出来事/` は月ごとに1枚なので日を持たない。空のままにすると
  // `--since` が `c.date >= ?` で全部落とすので、月のはじめを置く
  // （並び順のための値で、その日に何かがあったという意味ではない）
  if (!date && /^\d{4}-\d{2}$/.test(fields.month ?? "")) date = `${fields.month}-01`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const got = RE_DATE.exec(path.slice(path.lastIndexOf("/") + 1)) ?? RE_DATE.exec(path);
    date = got ? got[1] : "";
  }
  return {
    date,
    project: fields.project ?? "",
    source: fields.source || room,
  };
}

export function build(verbose = true): number {
  const tmp = DB.replace(/\.db$/, ".db.tmp");
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    rmSync(tmp + suffix, { force: true });
  }
  mkdirSync(dirname(tmp), { recursive: true });

  const con = new DatabaseSync(tmp);
  con.exec(`
    PRAGMA journal_mode = OFF;
    PRAGMA synchronous = OFF;
    CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE chunk(
        id      INTEGER PRIMARY KEY,
        room    TEXT NOT NULL,
        path    TEXT NOT NULL,
        project TEXT NOT NULL,
        date    TEXT NOT NULL,
        source  TEXT NOT NULL,
        heading TEXT NOT NULL,
        line    INTEGER NOT NULL,
        body    TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE chunk_fts USING fts5(
        body, heading,
        content='chunk', content_rowid='id', tokenize='trigram'
    );
  `);

  let nFiles = 0;
  const rows: [string, string, string, string, string, string, number, string][] = [];

  for (const [root, room] of rooms()) {
    if (!existsSync(root)) continue;
    for (const path of listFiles(root, ".md")) {
      const text = readText(path);
      nFiles += 1;
      const [fields] = splitFrontmatter(text);
      const meta = fileMeta(path, room, fields);
      const shown = displayPath(path, root, room);
      // 「自分」と「アイボ」は1日1ファイルで、プロジェクトは見出しにしか
      // 書いていない。見出しの無いかたまりには直前の値を引き継ぐ
      let carried = meta.project;
      for (const [head, line, body] of chunks(text)) {
        let project = meta.project;
        if (room === "自分") {
          const got = RE_MINE_HEAD.exec(head);
          if (got) carried = got[1];
          project = carried;
        } else if (room === "アイボ") {
          if (head && !head.includes(" ") && !AIBO_SECTIONS.has(head)) carried = head;
          project = carried;
        }
        rows.push([room, shown, project, meta.date, meta.source, head, line, body]);
      }
    }
  }

  const insert = con.prepare(
    "INSERT INTO chunk(room,path,project,date,source,heading,line,body)" +
      " VALUES(?,?,?,?,?,?,?,?)",
  );
  con.exec("BEGIN");
  for (const row of rows) insert.run(...row);
  con.exec("COMMIT");

  con.exec("CREATE INDEX chunk_date ON chunk(date)");
  con.exec("CREATE INDEX chunk_project ON chunk(project)");
  con.exec("INSERT INTO chunk_fts(chunk_fts) VALUES('rebuild')");
  const meta = con.prepare("INSERT INTO meta(k,v) VALUES(?,?)");
  meta.run("schema", String(SCHEMA));
  meta.run("files", String(nFiles));
  meta.run("chunks", String(rows.length));
  con.close();

  renameSync(tmp, DB);
  if (verbose) {
    const mb = (statSync(DB).size / 1e6).toFixed(1);
    console.error(`検索: ${n(nFiles)} ファイル / ${n(rows.length)} かたまりを刻んだ （${mb} MB）`);
  }
  return rows.length;
}

/** 索引より新しい素材があるか。無ければ刻み直さない。 */
export function stale(): boolean {
  if (!existsSync(DB)) return true;
  const dbMtime = statSync(DB).mtimeMs;
  for (const [root] of rooms()) {
    if (!existsSync(root)) continue;
    for (const path of listFiles(root, ".md")) {
      try {
        if (statSync(path).mtimeMs > dbMtime) return true;
      } catch {
        continue;
      }
    }
  }
  return false;
}

export function connect(): DatabaseSync {
  return new DatabaseSync(DB, { readOnly: true });
}

// ---------------------------------------------------------------- 引く

export interface Row {
  readonly room: string;
  readonly path: string;
  readonly project: string;
  readonly date: string;
  readonly source: string;
  readonly heading: string;
  readonly line: number;
  readonly body: string;
}

/** 語を FTS5 のフレーズ検索に組む。空白区切りは AND。 */
function ftsQuery(words: readonly string[]): string {
  return words.map((w) => '"' + w.replaceAll('"', '""') + '"').join(" AND ");
}

export function search(
  con: DatabaseSync,
  words: readonly string[],
  room: string | undefined,
  project: string | undefined,
  since: string | null,
  until: string | null,
  limit: number,
): [Row[], boolean] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (room) {
    where.push("c.room = ?");
    params.push(room);
  }
  if (project) {
    where.push("c.project LIKE ?");
    params.push(`%${project}%`);
  }
  if (since) {
    where.push("c.date >= ?");
    params.push(since);
  }
  if (until) {
    where.push("c.date <= ?");
    params.push(until);
  }

  const short = words.filter((w) => [...w].length < TRIGRAM_MIN);
  if (short.length) {
    // trigram は3文字未満を索引に持たない。素の部分一致に落ちる
    const cond = words.map(() => "instr(c.body, ?) > 0").join(" AND ");
    const sql = "SELECT c.* FROM chunk c " +
      `WHERE ${cond}` + (where.length ? " AND " + where.join(" AND ") : "") +
      " ORDER BY c.date DESC, c.id DESC LIMIT ?";
    return [con.prepare(sql).all(...words, ...params, limit) as unknown as Row[], true];
  }

  // 抜粋は snippet() を使わず自前で切る。trigram だと 1トークン=3文字で
  // 窓が狭すぎるうえ、部分一致に落ちたときと見た目が揃わない
  const sql = "SELECT c.*, bm25(chunk_fts, 1.0, 2.0) AS score" +
    " FROM chunk_fts JOIN chunk c ON c.id = chunk_fts.rowid" +
    " WHERE chunk_fts MATCH ?" +
    (where.length ? " AND " + where.join(" AND ") : "") +
    " ORDER BY score LIMIT ?";
  return [con.prepare(sql).all(ftsQuery(words), ...params, limit) as unknown as Row[], false];
}

function paint(s: string, code: string, tty: boolean): string {
  return tty ? `\x1b[${code}m${s}\x1b[0m` : s;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 部分一致で引いたときの抜粋。一致箇所のまわりを切り出して光らせる。 */
export function makeSnippet(body: string, words: readonly string[], tty: boolean, width = 170): string {
  const flat = body.split(/\s+/).filter(Boolean).join(" ");
  const low = flat.toLowerCase();
  const hits = words.map((w) => low.indexOf(w.toLowerCase())).filter((i) => i >= 0);
  if (!hits.length) return flat.slice(0, width);
  const start = Math.max(0, Math.min(...hits) - Math.floor(width / 3));
  const end = Math.min(flat.length, start + width);
  let out = flat.slice(start, end);
  if (tty) {
    // 置換で入れた制御文字を再び拾わないよう、1回のパスで塗る
    const pat = new RegExp([...new Set(words)]
      .sort((a, b) => b.length - a.length).map(escapeRe).join("|"), "gi");
    out = out.replace(pat, (m) => `\x1b[1;33m${m}\x1b[0m`);
  }
  return (start ? "… " : "") + out + (end < flat.length ? " …" : "");
}

function show(rows: readonly Row[], words: readonly string[], tty: boolean): void {
  rows.forEach((r, i) => {
    const head = r.heading || "（見出しなし）";
    const stamp = [r.date, r.project, r.room].filter(Boolean).join(" · ");
    console.log(`${paint(String(i + 1).padStart(3) + ".", "1", tty)} ${paint(stamp, "36", tty)}`);
    console.log(`     ${paint(head.slice(0, 110), "1", tty)}`);
    console.log(`     ${makeSnippet(r.body, words, tty)}`);
    console.log(`     ${paint(`${r.path}:${r.line}`, "2", tty)}`);
    console.log();
  });
}

function main(): number {
  const args = parseArgs(
    process.argv.slice(2),
    ["rebuild", "no-rebuild", "stats", "quiet"],
    ["room", "project", "since", "until", "limit"],
  );

  const room = args.values.room;
  if (room && !(ROOMS as readonly string[]).includes(room)) {
    console.error(`--room は ${ROOMS.join(" / ")} のどれか: ${room}`);
    return 2;
  }
  const since = parseSince(args.values.since);
  const until = parseSince(args.values.until);
  if (since === undefined || until === undefined) return 2;
  const limit = Number.parseInt(args.values.limit ?? "20", 10) || 20;

  if (args.flags.rebuild || (!args.flags["no-rebuild"] && stale())) {
    build();
  }

  if (!existsSync(DB)) {
    console.error("索引がありません。search.ts --rebuild を先に。");
    return 1;
  }

  if (args.flags.stats || !args.rest.length) {
    // --quiet は定時便のため。刻み直した1行だけ残して、内訳は出さない。
    if (args.flags.quiet && !args.flags.stats) return 0;

    const con = connect();
    const meta = new Map<string, string>();
    for (const r of con.prepare("SELECT k, v FROM meta").all() as { k: string; v: string }[]) {
      meta.set(r.k, r.v);
    }
    console.log(`  ファイル : ${n(Number(meta.get("files") ?? 0))}`);
    console.log(`  かたまり : ${n(Number(meta.get("chunks") ?? 0))}`);
    const grouped = con.prepare(
      "SELECT room, COUNT(*) n, MIN(date) a, MAX(date) b FROM chunk GROUP BY room ORDER BY room",
    ).all() as { room: string; n: number; a: string; b: string }[];
    for (const row of grouped) {
      const span = row.a ? `${row.a} 〜 ${row.b}` : "";
      // 部屋の名前は日本語なので、`padEnd`（UTF-16 の単位）では枠が揃わない。
      // かな・漢字・カタカナを幅2として数え直す（落とし穴24 と同じ話）。
      const w = [...row.room].reduce((a, c) => a + ((c.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1), 0);
      console.log(`    ${row.room}${" ".repeat(Math.max(1, 14 - w))} ${n(row.n).padStart(7)}  ${span}`);
    }
    console.log(`  索引 : ${DB} (${(statSync(DB).size / 1e6).toFixed(1)} MB)`);
    con.close();
    return 0;
  }

  const con = connect();
  const [rows, fallback] = search(con, args.rest, room, args.values.project, since, until, limit);
  const tty = process.stdout.isTTY === true;
  if (!rows.length) {
    console.error("みつかりませんでした。");
    con.close();
    return 1;
  }
  if (fallback) {
    console.error(`（${TRIGRAM_MIN}文字未満の語があるので部分一致で引きました）`);
  }
  show(rows, args.rest, tty);
  console.error(`${rows.length} 件`);
  con.close();
  return 0;
}

if (import.meta.main) process.exit(main());
