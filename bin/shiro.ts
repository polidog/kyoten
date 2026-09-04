#!/usr/bin/env node
/**
 * shiro — 城（拠点をブラウザで歩く）
 *
 * Obsidian で眺めても、拠点は「日付順に並んだテキスト」でしかない。
 * ここは23年ぶんを**1枚のまとめ**にして返すだけの城。潜って読むのは
 * 端末（`tsuyosa.ts`）の仕事で、こちらは一覧も検索も持たない。
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

/** 外向きには開かない。拠点には取引先の実名も認証まわりの試行錯誤も入っている */
const HOST = "127.0.0.1";
const PORT = 8823;

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- 口

function api(u: URL): unknown {
  if (u.pathname === "/api/summary") return yomi.summary();
  return undefined;
}

function send(res: ServerResponse, code: number, type: string, body: string | Buffer): void {
  res.writeHead(code, {
    "content-type": type,
    "cache-control": "no-store",
    // 拠点の中身が外に出る口を塞ぐ。外を向いてよいのは字の形だけ
    "content-security-policy":
      "default-src 'self' 'unsafe-inline'; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com",
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
    send(res, 500, "application/json; charset=utf-8", JSON.stringify({ error: message }));
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
      console.error("  潜って読むなら bin/tsuyosa.ts");
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
