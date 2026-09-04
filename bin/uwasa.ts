#!/usr/bin/env node
/**
 * uwasa — まちのうわさ（吟遊詩人の週報）
 *
 * おつげが「その週に何が起きたか」を告げるのに対して、うわさは
 * **ここまでで何が積み上がったか**を歌う。ステータスは「いまの自分」を
 * 1枚だけ持っていて、先週の自分は残らない。週ごとに置いておけば、
 * あとから「2026年9月の自分」を読める。
 *
 * 節は2つだけにしてある。
 *
 *     つもったもの        その週の終わりまでの累計（ステータスの差分）
 *     まだ書いていないもの  polidog.jp に名前が出ていないもの（ブログのネタ）
 *
 * 「何に時間を使い、何が止まったか」はおつげがすでに書いている。同じことを
 * 別の部屋でもう一度言うと、どちらも読まれなくなる。
 *
 * 素材の読み方はおつげから借りる（`scan` / `fold`）。同じ週について違う数を
 * 言う部屋を作らないため。走らせる順番は … → status → otsuge → uwasa。
 *
 * 掟:
 *   - 決定論的: 走らせた日で結果が変わらない。
 *   - 冪等: 内容が変わらなければファイルに触れない。
 *   - その週の目でだけ書く: 累計もネタも、その週の終わりまでしか知らない
 *     （罠22）。未来を知らないうわさは二度と変わらない。
 *
 * 使い方:
 *     uwasa.ts                # 全部
 *     uwasa.ts --dry-run
 *     uwasa.ts --quiet
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { KYOTEN, frontmatter, n, readText, splitFrontmatter, writeIfChanged, type WriteState }
  from "./dougu.ts";
import { listFiles, parseArgs } from "./cli.ts";
import { Day, Week, fold, scan } from "./otsuge.ts";

const ROOM = join(KYOTEN, "uwasa");

/** 累計コミットのふしめ。跨いだ週にだけ言う。 */
const FUSHIME = [10, 50, 100, 500, 1000, 5000] as const;

/**
 * ネタとして名前を照らす下限の長さ。
 *
 * 罠18 と同じ話で、短い名前はただの単語になる。`polidog/web` の `web` を
 * 記事本文と突き合わせても意味がない。ここで落ちたものはネタに挙がらない
 * ——「書いたことにする」側に倒しておく（黙るほうが、嘘のネタを積むより
 * ましなので）。
 */
const NAME_MIN = 4;

/** ネタに挙げる数の上限。落ちているネタが10本ある週は、たぶん数え方が悪い。 */
const NETA_SHOWN = 5;

// ---------------------------------------------------------------- 記事を引く

/**
 * リポジトリ名ごとに「その名前が polidog.jp にはじめて出た日」を作る。
 *
 * そとのこえのうち `source: polidog.jp` のものだけ見る。SNS を混ぜると
 * 「作った」と一度つぶやいただけで書いたことになってしまう。
 */
function whenWritten(names: ReadonlySet<string>): Map<string, string> {
  const first = new Map<string, string>();
  const soto = join(KYOTEN, "soto");
  if (!existsSync(soto) || !names.size) return first;

  for (const path of listFiles(soto, ".md")) {
    const text = readText(path);
    const [fields] = splitFrontmatter(text);
    if (fields.source !== "polidog.jp") continue;
    const date = fields.date ?? "";
    if (!date) continue;

    const low = text.toLowerCase();
    for (const name of names) {
      if (!low.includes(name)) continue;
      const before = first.get(name);
      if (before === undefined || date < before) first.set(name, date);
    }
  }
  return first;
}

/** `polidog/kyoten` → `kyoten`。照らす相手にならないものは空を返す。 */
function repoName(project: string): string {
  if (!project.includes("/")) return ""; // 罠18: `Work` や `_home` はただの単語
  const repo = project.slice(project.lastIndexOf("/") + 1).toLowerCase();
  return [...repo].length >= NAME_MIN ? repo : "";
}

// ---------------------------------------------------------------- 歌う

/** `335さつ（+262）` の形。増えていない週は括弧を出さない。 */
function grew(now: number, by: number, unit = ""): string {
  return `${n(now)}${unit}` + (by ? `（+${n(by)}）` : "");
}

class Tsumori {
  sessions = 0;
  utterances = 0;
  commits = 0;
  articles = 0;
  posts = 0;
  troubles = 0;
  readonly projects = new Set<string>();
  /** プロジェクトごとの累計コミット。ふしめを跨いだかを見るのに要る */
  readonly perProject = new Map<string, number>();
}

interface Neta {
  readonly project: string;
  readonly commits: number;
  readonly why: string;
}

function render(week: Week, t: Tsumori, fresh: number, neta: readonly Neta[]): string {
  const head = frontmatter({
    room: "uwasa",
    week: week.key,
    from: week.start,
    to: week.end,
    sessions: t.sessions,
    commits: t.commits,
    projects: t.projects.size,
  });

  const body: string[] = [`# ${week.key} のうわさ`, `${week.start} 〜 ${week.end}`];

  const tsumotta: string[] = [];
  if (t.sessions) tsumotta.push(`- ぼうけんのしょ ${grew(t.sessions, week.sessions, "さつ")}`);
  if (t.utterances) tsumotta.push(`- はつげん ${grew(t.utterances, week.utterances)}`);
  if (t.commits) tsumotta.push(`- コミット ${grew(t.commits, week.commits)}`);
  if (t.projects.size) {
    tsumotta.push(`- さわったリポジトリ ${grew(t.projects.size, fresh)}`);
  }
  if (t.articles) tsumotta.push(`- 記事 ${grew(t.articles, week.articles)}`);
  if (t.posts) tsumotta.push(`- SNS ${grew(t.posts, week.posts, "日ぶん")}`);
  if (t.troubles) tsumotta.push(`- つまずき ${grew(t.troubles, week.troubles)}`);
  if (tsumotta.length) body.push("## つもったもの\n\n" + tsumotta.join("\n"));

  if (neta.length) {
    body.push(
      "## まだ書いていないもの\n\n" +
        neta.slice(0, NETA_SHOWN).map((x) => `- ${x.project} ${x.why}`).join("\n"),
    );
  }

  return head + "\n\n" + body.join("\n\n") + "\n";
}

// ---------------------------------------------------------------- main

function main(): number {
  const args = parseArgs(process.argv.slice(2), ["dry-run", "quiet"]);

  const days = new Map<string, Day>();
  scan(days);
  const weeks = fold(days);

  // 名前を照らす相手を先に集める。記事は1回だけ読む
  const names = new Map<string, string>(); // repo名 → プロジェクト名
  for (const week of weeks) {
    for (const project of week.projects.keys()) {
      const repo = repoName(project);
      if (repo) names.set(repo, project);
    }
  }
  const written = whenWritten(new Set(names.keys()));

  const t = new Tsumori();
  const stats: Record<WriteState, number> = { new: 0, updated: 0, same: 0 };
  let netaTotal = 0;

  for (const week of weeks) {
    // この週ぶんを足してから歌う。累計はその週の終わりまでを指す
    let fresh = 0;
    const neta: Neta[] = [];

    for (const [project, count] of week.projects) {
      const before = t.perProject.get(project) ?? 0;
      const after = before + count;
      t.perProject.set(project, after);
      if (!t.projects.has(project)) {
        t.projects.add(project);
        fresh += 1;
      }

      // ネタになるのは「はじめて現れた週」と「ふしめを跨いだ週」だけ。
      // 毎週ぜんぶ並べると、書いていないものが延々と並ぶだけになる
      let why = "";
      if (before === 0) why = `はじめて手が動いた（${n(after)} コミット）`;
      else {
        const crossed = FUSHIME.find((m) => before < m && after >= m);
        if (crossed !== undefined) why = `${n(crossed)} コミットをこえた`;
      }
      if (!why) continue;

      const repo = repoName(project);
      if (!repo) continue;
      // その週の終わりまでに書かれていれば、ネタではない（罠22: 未来を見ない）
      const when = written.get(repo);
      if (when !== undefined && when <= week.end) continue;
      neta.push({ project, commits: after, why });
    }

    t.sessions += week.sessions;
    t.utterances += week.utterances;
    t.commits += week.commits;
    t.articles += week.articles;
    t.posts += week.posts;
    t.troubles += week.troubles;

    // 並びを決める。同じ週で揺れないよう、数のあとは名前で決める
    neta.sort((a, b) => b.commits - a.commits || (a.project < b.project ? -1 : 1));
    netaTotal += Math.min(neta.length, NETA_SHOWN);

    const out = join(ROOM, `${week.key}.md`);
    stats[writeIfChanged(out, render(week, t, fresh, neta), args.flags["dry-run"])] += 1;
  }

  const total = stats.new + stats.updated + stats.same;
  if (args.flags.quiet) {
    console.log(
      `uwasa: ${total}週 (new ${stats.new} / upd ${stats.updated} / same ${stats.same})` +
        ` ネタ ${n(netaTotal)}`,
    );
  } else {
    if (args.flags["dry-run"]) console.log("（書かずに確認）");
    console.log(`  うわさ       : ${n(total)} 週`);
    console.log(`    あたらしい : ${n(stats.new)}`);
    console.log(`    かきかえ   : ${n(stats.updated)}`);
    console.log(`    かわらず   : ${n(stats.same)}`);
    if (weeks.length) {
      console.log(`  期間         : ${weeks[0].key} 〜 ${weeks[weeks.length - 1].key}`);
    }
    console.log(`  ネタ         : ${n(netaTotal)}`);
    console.log(`  ばしょ : ${ROOM}`);
  }
  return 0;
}

process.exit(main());
