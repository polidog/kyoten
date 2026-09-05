/**
 * machine — 機械ごとの素材置き場
 *
 * 拠点を複数の PC で共有するための配管。
 *
 * ## なぜ要るのか
 *
 * `会話/` は元 jsonl と 1:1（名前は UUID）なので、2台が同じ拠点へ書いても
 * **足し算になる**。ところが `自分/` `アイボ/` `作業/` `読んだ/` は**日ごとに
 * 1枚へ畳む**ので、A が「A ぶんだけの 09-05」を書き、同期のあと B が
 * 「B ぶんだけの 09-05」で上書きする —— 毎晩ピンポンする。
 *
 * jsonl そのものを拠点に載せて解決はできない。実測 `~/.claude/projects`
 * が 261MB・`~/.codex/sessions` が 20MB で、拠点（61MB）の4倍を超える。
 *
 * ## どうするか —— 道具を2段に割る
 *
 *     1階（機械ごと）  jsonl / git / Chrome  →  素材/<hostname>/<部屋>/…json
 *     2階（拠点だけ）  素材/ * /<部屋>/…      →  <部屋>/…md
 *
 * 運ぶのは素材だけ（実測 11MB）。畳むのは拠点しか見ないので、
 * **どの機械で走らせても同じ結果**になる —— 母艦が切り替えられる。
 * 原則5（1つの部屋の書き手は1つ）も守れる: `自分/` を書くのは畳む側
 * ひとつ、`素材/<hostname>/` を書くのはその機械ひとつ。
 *
 * ## Obsidian Sync の都合
 *
 *   - **ドットで始まるものを運ばない。** だから `素材/` にドットを付けない
 *     （付けると同期されず、ここでの工夫が全部無駄になる）。逆に
 *     `.search.db`（148MB）と `.git`（19MB）は運ばれないので好都合。
 *   - **`.json` は「その他すべての形式」を on にしないと運ばれない。**
 *     off のままだと相手の素材が永久に届かず、しかも**黙って**片肺で畳む
 *     ことになる。だから名簿（`machines()`）と `見た.json` を置いて、
 *     何台ぶんを見て畳んだのかを毎回言えるようにしてある（落とし穴14 ——
 *     「取れなかった」を「0件だった」にしない）。
 *
 * ## 名簿は手で書かない
 *
 * どの機械が居るかは `素材/` を見れば分かる（原則4）。機械を引退させる
 * ときは `素材/<hostname>/` を手で消す —— 追記のみの部屋を書き直すときと
 * 同じ作法。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { hostname, homedir } from "node:os";
import { join } from "node:path";

import { KYOTEN, sortedJson, writeIfChanged, ymd } from "./util.ts";
import { MACHINES, 既定, type Machine } from "../config.ts";

/**
 * この機械の名前。
 *
 * `hostname()` をそのまま使う。ドメイン付きで返す環境があるので最初の
 * ラベルだけ取り、ディレクトリ名にできない文字は落とす。`KYOTEN_MACHINE`
 * で差し替えられる（偽の機械を建てて畳みを試すときに要る）。
 */
export const MACHINE: string = (() => {
  const raw = process.env.KYOTEN_MACHINE ?? hostname();
  const name = raw.split(".")[0].replace(/[^\p{L}\p{N}_.\-]/gu, "_");
  return name || "_unknown";
})();

/** 素材の置き場。**ドットを付けない**（Obsidian Sync が運ばなくなる）。 */
export const SOZAI = join(KYOTEN, "素材");

/** この機械ぶんの素材の根。 */
export const MINE = join(SOZAI, MACHINE);

/** この機械の設定。表に無ければ既定（集めるだけ）。 */
export const CONFIG: Machine = MACHINES[MACHINE] ?? 既定;

/** 表に載っているか。載っていなければ、走るたびに名指しする側の判断に使う。 */
export const KNOWN: boolean = MACHINE in MACHINES;

/** この機械はその道具を走らせるか。 */
export function runs(tool: string): boolean {
  return CONFIG.走らせる.includes(tool);
}

/** git リポジトリの置き場。 */
export function ghqRoot(): string {
  return process.env.KYOTEN_GHQ ?? CONFIG.ghq ?? join(homedir(), "ghq");
}

/** Chrome の設定ディレクトリ。 */
export function chromeRoot(): string {
  return process.env.KYOTEN_CHROME ?? CONFIG.chrome ?? join(homedir(), ".config/google-chrome");
}

// ---------------------------------------------------------------- 素材の読み書き

/** `素材/<機械>/<部屋>/<YYYY-MM>/<YYYY-MM-DD>.json` */
function sozaiPath(machine: string, room: string, date: string): string {
  return join(SOZAI, machine, room, date.slice(0, 7), `${date}.json`);
}

/**
 * この機械ぶんの素材を1日ぶん書く。
 *
 * 中身は `sortedJson` で並べる —— キーの順で差が出ると、内容が同じでも
 * 毎回 updated になって、同期が毎晩全ファイルを運ぶことになる。
 */
export function writeSozai(
  room: string,
  date: string,
  items: unknown,
  dryRun = false,
): void {
  writeIfChanged(sozaiPath(MACHINE, room, date), sortedJson(items) + "\n", dryRun);
}

/**
 * 全機械ぶんの素材を、日付ごとに束ねて返す。
 *
 * 並べる順は **機械名の昇順** —— これが決まっていないと、同じ素材から
 * 違う md が出る（読み取りの順が OS 任せになる）。
 */
export function readSozai<T>(room: string): Map<string, T[]> {
  const days = new Map<string, T[]>();
  for (const m of machines()) {
    const root = join(SOZAI, m, room);
    if (!existsSync(root)) continue;
    let rels: string[];
    try {
      rels = readdirSync(root, { recursive: true, encoding: "utf8" }) as string[];
    } catch {
      continue;
    }
    for (const rel of rels.sort()) {
      if (!rel.endsWith(".json")) continue;
      const date = rel.slice(-("YYYY-MM-DD.json".length)).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(join(root, rel), "utf8"));
      } catch {
        // 壊れた素材は飛ばす。原本はその機械の jsonl に残っていて、
        // 次に向こうで集め直せば入る。
        continue;
      }
      if (!Array.isArray(parsed)) continue;
      const list = days.get(date);
      if (list) list.push(...(parsed as T[]));
      else days.set(date, [...(parsed as T[])]);
    }
  }
  return days;
}

// ---------------------------------------------------------------- 名簿と、揃った日

/** 素材を置いている機械の一覧（名前の昇順）。 */
export function machines(): string[] {
  try {
    return readdirSync(SOZAI, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

interface Manifest {
  readonly 機械: string;
  /** 最後に集めた日（JST）。**この日より前は揃っている**と読む。 */
  readonly 集めた: string;
}

function manifestPath(machine: string): string {
  return join(SOZAI, machine, "見た.json");
}

/**
 * 「きょう集めた」と記す。
 *
 * ここは拠点の部屋ではなく素材なので、原則1（揺れる値を書かない）の外。
 * 日付までしか持たないので、同じ日に何度流しても内容は変わらない。
 */
export function markCollected(dryRun = false): void {
  const body: Manifest = { 機械: MACHINE, 集めた: ymd(new Date(Date.now() + 9 * 3600_000)) };
  writeIfChanged(manifestPath(MACHINE), sortedJson(body) + "\n", dryRun);
}

function collectedOn(machine: string): string | null {
  try {
    const m = JSON.parse(readFileSync(manifestPath(machine), "utf8")) as Manifest;
    return /^\d{4}-\d{2}-\d{2}$/.test(m.集めた ?? "") ? m.集めた : null;
  } catch {
    return null;
  }
}

/**
 * **全機械が見終わった日**。この日より前なら、素材が揃っている。
 *
 * 追記のみの部屋（日記・出来事・見立て・よその日記・おすすめ）は、
 * 一度書いたら直せない。片肺の素材で書くと、**その日は永久に片肺のまま**
 * 残る。だから `株/` と同じ構えを取る —— **揃った日しか書かない**
 * （落とし穴69「遅れるだけ、抜けはしない」）。
 *
 * 冪等な部屋（自分・アイボ・作業・読んだ）はこの門を通さない。あとで
 * 相手の素材が届けば、そのとき書き直せばいいだけなので。
 *
 * 素材がまだ1台ぶんも無ければ null（門を建てない）—— 1台で使っている
 * ときに、いまと同じに動かすため。
 */
export function settledThrough(): string | null {
  const list = machines();
  if (!list.length) return null;
  let min: string | null = null;
  for (const m of list) {
    const on = collectedOn(m);
    if (on === null) return null; // 見た.json が読めない機械が居るなら門は建てない
    if (min === null || on < min) min = on;
  }
  return min;
}

/**
 * 追記のみの部屋が書いてよい上限（その日は**含まない**）。
 *
 * `today` と「全機械が見終わった日」の小さいほうを返す。相手の機械が
 * 遅れているあいだは、そこで止める —— **遅れるだけで、抜けはしない**
 * （`株/` の落とし穴69 と同じ）。止めた理由は `held` に入れて、呼んだ側が
 * 黙らずに言えるようにする（落とし穴65）。
 */
export function appendLimit(today: string): { limit: string; held: string | null } {
  const settled = settledThrough();
  if (settled === null || settled >= today) return { limit: today, held: null };
  const late = machines()
    .filter((m) => (collectedOn(m) ?? "9999-99-99") === settled)
    .join(" / ");
  return {
    limit: settled,
    held: `素材が揃っているのは ${settled} まで（${late} が遅れている）`,
  };
}

/**
 * 畳むとき・書かせるときに出す1行。
 *
 * 何台ぶんを見て畳んだのかを毎回言う。Obsidian Sync の「その他すべての
 * 形式」が off だと相手の素材が届かないが、**それは黙って起きる**ので、
 * ここで台数を言わないと気づけない（落とし穴65 の形）。
 */
export function fleetNote(): string {
  const list = machines();
  if (!list.length) return "素材 なし（この機械のログから直に畳む）";
  return `素材 ${list.length}台（${list.join(" / ")}）`;
}
