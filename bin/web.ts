#!/usr/bin/env node
/**
 * web — 拠点をブラウザで読む
 *
 * Obsidian で眺めても、拠点は「日付順に並んだテキスト」でしかない。
 * ここは23年ぶんを1枚のまとめにしたうえで、**潜って原文まで読める**。
 * 端末（`browse.ts`）と同じものを、同じ読み取り層（`read.ts`）から出す。
 *
 * 原則に沿って:
 *   - 依存を増やさない  `node:http` だけ。npm も build も要らない
 *   - 書き込み口を絞る  拠点には一切書かない。読むだけ
 *   - 外に出さない      127.0.0.1 に固定。--host は用意しない
 *
 * 使い方:
 *     web.ts                 # 立ち上げてブラウザを開く
 *     web.ts --port 9999
 *     web.ts --no-open       # 開かない
 */

import { spawn, spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { KYOTEN, n } from "./util.ts";
import { parseArgs } from "./cli.ts";
import * as vault from "./read.ts";
import { connect, makeSnippet, ROOMS, search } from "./search.ts";

/** 外向きには開かない。拠点には取引先の実名も認証まわりの試行錯誤も入っている */
const HOST = "127.0.0.1";
const PORT = 8823;

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- 口

/** 一覧を持っている部屋。ここに無いものは `tree` で置いてあるとおりに歩く */
function list(room: string): unknown {
  switch (room) {
    case "skill":
      return vault.skillList();
    case "timeline":
      return vault.timelineList();
    case "diary":
      return vault.diaryList();
    case "stock":
      return vault.stockList();
    case "news":
      return vault.newsList();
    case "reading":
      return vault.readingList();
    case "events":
      return vault.eventList();
    case "weekly":
      return vault.weeklyList();
    case "trend":
      return vault.trendList();
    case "entity":
      return vault.entityList();
    default:
      return undefined;
  }
}

export interface Hit {
  readonly room: string;
  readonly path: string;
  readonly project: string;
  readonly date: string;
  readonly heading: string;
  readonly line: number;
  readonly snippet: string;
}

/**
 * 拠点を引く。
 *
 * 索引は `search.ts` が刻む。ここは読むだけなので、無ければ刻み直さずに
 * そう言って返す（原則5: 書き込み口を絞る）。
 */
function find(u: URL): unknown {
  const words = (u.searchParams.get("q") ?? "").split(/\s+/).filter(Boolean);
  if (!words.length) return { words, hits: [], fallback: false, note: "" };

  const room = u.searchParams.get("room") ?? "";
  const project = u.searchParams.get("project") ?? "";
  const since = u.searchParams.get("since") ?? "";
  const limit = Math.min(200, Number.parseInt(u.searchParams.get("limit") ?? "60", 10) || 60);

  let con;
  try {
    con = connect();
  } catch {
    return { words, hits: [], fallback: false, note: "索引がまだありません（bin/search.ts --rebuild）" };
  }
  try {
    const [rows, fallback] = search(
      con,
      words,
      room && (ROOMS as readonly string[]).includes(room) ? room : undefined,
      project || undefined,
      since || null,
      null,
      limit,
    );
    const hits: Hit[] = rows.map((r) => ({
      room: r.room,
      path: r.path,
      project: r.project,
      date: r.date,
      heading: r.heading,
      line: r.line,
      snippet: makeSnippet(r.body, words, false, 220),
    }));
    return { words, hits, fallback, note: "" };
  } finally {
    con.close();
  }
}

/**
 * 定時便がつぎにいつ起きるか。
 *
 * これは拠点に無い —— 日記を書かせるのは systemd のタイマーなので、
 * 予定はそっちにしか無い。だから `read.ts`（拠点を読む層）ではなく
 * ここで聞く。
 *
 * 聞けなかったものは埋めない（落とし穴14 と同じ形で、「分からなかった」を
 * 「無い」にしない）。状態は3つある —— systemd に聞けない（null。画面は
 * 何も言わない）、タイマーが入っていない（`armed: false`）、動いている。
 */
export interface Nightly {
  /** タイマーが入っていて、次が決まっているか */
  readonly armed: boolean;
  /** `OnCalendar` の時刻（"03:00"）。毎晩これに起きる予定 */
  readonly at: string;
  /** 次に起きる時刻（"2026-09-06 03:01"）。`RandomizedDelaySec` のずれ込み */
  readonly next: string;
  /** 最後に起きた時刻（"2026-09-05 03:07"）。一度も起きていなければ "" */
  readonly last: string;
}

function nightly(): Nightly | null {
  let out: string;
  try {
    const got = spawnSync(
      "systemctl",
      [
        "--user",
        "show",
        "kyoten.timer",
        "--property=LoadState",
        "--property=ActiveState",
        "--property=TimersCalendar",
        "--property=NextElapseUSecRealtime",
        "--property=LastTriggerUSec",
      ],
      { encoding: "utf8", timeout: 3000 },
    );
    if (got.error || got.status !== 0) return null;
    out = got.stdout;
  } catch {
    return null;
  }

  const prop = (key: string): string =>
    new RegExp(`^${key}=([^\n]*)$`, "m").exec(out)?.[1]?.trim() ?? "";

  if (prop("LoadState") !== "loaded") return { armed: false, at: "", next: "", last: "" };
  // `TimersCalendar` は `{ OnCalendar=*-*-* 03:00:00 ; next_elapse=… }` の形
  const at = /OnCalendar=\S+ (\d{2}:\d{2})/.exec(prop("TimersCalendar"))?.[1] ?? "";
  // `NextElapseUSecRealtime` は `Sun 2026-09-06 03:01:04 JST`。止めてあれば n/a
  const stamp = (key: string): string => {
    const m = /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/.exec(prop(key));
    return m ? `${m[1]} ${m[2]}` : "";
  };
  // `LastTriggerUSec` は起きた時刻であって、無事に終わった時刻ではない
  // （結果は service 側にあり、ここでは聞かない）。一度も起きていなければ n/a
  const last = stamp("LastTriggerUSec");
  const next = stamp("NextElapseUSecRealtime");
  if (prop("ActiveState") !== "active" || !next) return { armed: false, at, next: "", last };
  return { armed: true, at, next, last };
}

function api(u: URL): unknown {
  switch (u.pathname) {
    case "/api/summary": {
      const s = vault.summary();
      // 日記のとなりに「つぎはいつ書かれるか」を添える。拠点の外の話なので
      // まとめに混ぜず、別の名前で持たせる
      return s ? { ...s, nightly: nightly() } : s;
    }
    case "/api/list":
      return list(u.searchParams.get("room") ?? "");
    case "/api/doc": {
      const path = u.searchParams.get("path") ?? "";
      const doc = vault.docAt(path);
      if (!doc) return undefined;
      // 日記を開いたときは、同じ日のよその日記も添える。2回叩かせない
      // ——「日記のとなりにアイボが座る」のと同じで、返事は同じ画面に出す
      const day = /^日記\/\d{4}-\d{2}\/(\d{4}-\d{2}-\d{2})\.md$/.exec(path);
      const said = day ? vault.guestOn(day[1]) : [];
      if (said.length) return { ...doc, comments: said };
      // 株を開いたときは、その日の見立ても添える。日記とよそと同じ考えかたで、
      // 値の一部ではなく「それを見てアイボが言ったもの」なので別に持たせる
      const priced = /^株\/\d{4}-\d{2}\/(\d{4}-\d{2}-\d{2})\.md$/.exec(path);
      const seen = priced ? vault.outlookOn(priced[1]) : null;
      if (seen) return { ...doc, outlook: seen };
      // ニュースを開いたときは、その日のおすすめも添える。株と見立てと
      // まったく同じ形 —— 話題は機械が集めたもので、おすすめはそれを見て
      // アイボが言ったものなので、同じ紙に混ぜない
      const topics = /^ニュース\/\d{4}-\d{2}\/(\d{4}-\d{2}-\d{2})\.md$/.exec(path);
      const chose = topics ? vault.picksOn(topics[1]) : null;
      return chose ? { ...doc, outlook: chose } : doc;
    }
    case "/api/raw":
      return vault.raw(u.searchParams.get("path") ?? "") ?? undefined;
    case "/api/tree":
      return vault.tree(u.searchParams.get("path") ?? "") ?? undefined;
    case "/api/search":
      return find(u);
    default:
      return undefined;
  }
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
      send(res, 200, "text/html; charset=utf-8", readFileSync(join(HERE, "web.html")));
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
    // 開けなくても立ち上がってはいる。住所は下に出してある
  }
}

function main(): number {
  const args = parseArgs(process.argv.slice(2), ["no-open", "quiet"], ["port"]);
  const port = Number.parseInt(args.values.port ?? String(PORT), 10) || PORT;

  const s = vault.profile();
  if (!s) {
    console.error(`拠点にプロフィールがありません: ${KYOTEN}`);
    console.error("bin/profile.ts を先に流してください。");
    return 1;
  }

  const server = createServer(handle);
  server.listen(port, HOST, () => {
    const url = `http://${HOST}:${port}/`;
    if (!args.flags.quiet) {
      console.error(`まとめ: ${url}`);
      console.error(
        `  ${s.first} 〜 ${s.last}（${s.span}年）　スキル ${n(s.skills)}　` +
          `週報 ${n(vault.weeklyList().length)}週`,
      );
      console.error("  端末で読むなら bin/browse.ts");
    }
    if (!args.flags["no-open"]) open(url);
  });
  server.on("error", (err) => {
    console.error(`立ち上がりません: ${err.message}`);
    process.exit(1);
  });
  return 0;
}

if (import.meta.main) {
  // listen は非同期なので、そのまま process.exit に渡すと立ち上がった端から閉じる
  const code = main();
  if (code !== 0) process.exit(code);
}
