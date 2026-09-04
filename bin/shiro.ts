#!/usr/bin/env node
/**
 * shiro — 城（拠点をブラウザで歩く）
 *
 * Obsidian で眺めても、拠点は「日付順に並んだテキスト」でしかない。
 * 23年ぶんの数はステータス画面に、とくぎ71枚は一覧に、おつげ776週は
 * 年ごとの帯にしたほうが速く見つかる。ここはその見せ方だけを持つ。
 *
 * 掟に沿って:
 *   - 依存を増やさない  `node:http` だけ。npm も build も要らない
 *   - 書き込み口を絞る  拠点には一切書かない。読むだけ
 *   - 外に出さない      127.0.0.1 に固定。--host は用意しない
 *
 * 使い方:
 *     shiro.ts                 # 立ち上げてブラウザを開く
 *     shiro.ts --port 9999
 *     shiro.ts --no-open       # 開かない
 */

import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { KYOTEN, n } from "./dougu.ts";
import { parseArgs } from "./cli.ts";
import * as yomi from "./yomi.ts";
import { connect, DB, makeSnippet, ROOMS, search, stale } from "./ruula.ts";

/** 断り。頼みが悪いので 400 で返す（こちらが壊れたわけではない） */
class Kotowaru extends Error {}

/** 外向きには開かない。拠点には取引先の実名も認証まわりの試行錯誤も入っている */
const HOST = "127.0.0.1";
const PORT = 8823;

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- 口

function ruula(u: URL) {
  const words = (u.searchParams.get("q") ?? "").split(/\s+/).filter(Boolean);
  if (!words.length) return { rows: [], fallback: false };

  const room = u.searchParams.get("room") ?? undefined;
  if (room && !(ROOMS as readonly string[]).includes(room)) {
    throw new Kotowaru(`知らない部屋です: ${room}`);
  }
  const limit = Math.min(200, Number.parseInt(u.searchParams.get("limit") ?? "40", 10) || 40);

  const con = connect();
  try {
    const [rows, fallback] = search(
      con,
      words,
      room,
      u.searchParams.get("project") ?? undefined,
      u.searchParams.get("since") || null,
      u.searchParams.get("until") || null,
      limit,
    );
    // 本文をそのまま返すと 1 件で数万字になる。抜粋だけ渡して、
    // 続きは原文（/api/raw）に取りに行かせる
    return {
      fallback,
      rows: rows.map((r) => ({
        room: r.room,
        path: r.path,
        project: r.project,
        date: r.date,
        source: r.source,
        heading: r.heading,
        line: r.line,
        snippet: makeSnippet(r.body, words, false, 220),
      })),
    };
  } finally {
    con.close();
  }
}

/** ルーラの結果の `bouken/…` を拠点の実パスに戻す。reading-notes は拠点の外 */
function rawOf(u: URL) {
  const rel = u.searchParams.get("path") ?? "";
  const got = yomi.raw(rel);
  if (!got) throw new Kotowaru(`読めません: ${rel}`);
  return got;
}

function api(u: URL): unknown {
  switch (u.pathname) {
    case "/api/status":
      return yomi.status();
    case "/api/tokugi": {
      const name = u.searchParams.get("name");
      return name ? yomi.tokugi(name) : yomi.tokugiList();
    }
    case "/api/nenpyo": {
      const year = u.searchParams.get("year");
      return year ? yomi.nenpyo(year) : yomi.nenpyoList();
    }
    case "/api/otsuge": {
      const week = u.searchParams.get("week");
      return week ? yomi.otsuge(week) : yomi.otsugeList();
    }
    case "/api/fukuro": {
      const path = u.searchParams.get("path");
      return path ? yomi.raw(path) : yomi.fukuroList();
    }
    case "/api/ruula":
      return ruula(u);
    case "/api/raw":
      return rawOf(u);
    default:
      return undefined;
  }
}

function send(res: ServerResponse, code: number, type: string, body: string | Buffer): void {
  res.writeHead(code, {
    "content-type": type,
    "cache-control": "no-store",
    // 拠点の中身をブラウザの外に出させない
    "content-security-policy": "default-src 'self' 'unsafe-inline'",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const u = new URL(req.url ?? "/", `http://${HOST}`);
  try {
    if (u.pathname === "/" || u.pathname === "/index.html") {
      // 立ち上げっぱなしで直しても効くよう、毎回読む（1ファイルなので安い）
      send(res, 200, "text/html; charset=utf-8", readFileSync(join(HERE, "shiro.html")));
      return;
    }
    if (u.pathname.startsWith("/api/")) {
      const got = api(u);
      if (got === undefined) {
        send(res, 404, "application/json; charset=utf-8", JSON.stringify({ error: "ない口です" }));
        return;
      }
      send(res, 200, "application/json; charset=utf-8", JSON.stringify(got));
      return;
    }
    send(res, 404, "text/plain; charset=utf-8", "ここには何もない");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof Kotowaru ? 400 : 500;
    send(res, code, "application/json; charset=utf-8", JSON.stringify({ error: message }));
  }
}

// ---------------------------------------------------------------- 入口

function open(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    // 開けなくても城は建っている。住所は下に出してある
  }
}

function main(): number {
  const args = parseArgs(process.argv.slice(2), ["no-open", "quiet"], ["port"]);
  const port = Number.parseInt(args.values.port ?? String(PORT), 10) || PORT;

  const s = yomi.status();
  if (!s) {
    console.error(`拠点にステータスがありません: ${KYOTEN}`);
    console.error("bin/status.ts を先に流してください。");
    return 1;
  }

  const server = createServer(handle);
  server.listen(port, HOST, () => {
    const url = `http://${HOST}:${port}/`;
    if (!args.flags.quiet) {
      console.error(`城: ${url}`);
      console.error(
        `  ${s.first} 〜 ${s.last}（${s.span}年）　とくぎ ${n(s.tokugi)}　` +
          `おつげ ${n(yomi.otsugeList().length)}週`,
      );
      if (stale()) console.error(`  （ルーラの索引が素材より古いです: ${DB}）`);
    }
    if (!args.flags["no-open"]) open(url);
  });
  server.on("error", (err) => {
    console.error(`城が建ちません: ${err.message}`);
    process.exit(1);
  });
  return 0;
}

if (import.meta.main) {
  // listen は非同期なので、そのまま process.exit に渡すと建った端から閉じる
  const code = main();
  if (code !== 0) process.exit(code);
}
