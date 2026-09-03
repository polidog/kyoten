#!/usr/bin/env python3
"""otsuge — おつげ（週ごとの観測）

うらないババが週に1度、拠点を読んで告げる。数の羅列はステータスと年表に
あるので、こちらは**その週に何が起きて、先週と何が違ったか**を書く。

出力は `otsuge/<ISO年>-W<週>.md`（月曜はじまりの ISO 週）。

ふくろ・ステータスと同じく**拠点の中しか見ない**。走らせる順番は
… → teato → fukuro → status → otsuge。

## その週の目でだけ書く

「45日止まっている」のような話は、**その週の終わりの時点**で数える。
今日から数えると、過去のおつげが毎晩書き換わって、読み返したときに
「あのとき何と言われたか」が残らない。未来を知らないおつげは二度と
変わらないので、冪等が完全に保たれる。

掟:
  - 決定論的: 走らせた日で結果が変わらない。
  - 冪等: 内容が変わらなければファイルに触れない。
  - 手で書かせない: 素材が増えれば勝手に増える。

使い方:
    otsuge.py                   # 全部
    otsuge.py --dry-run
    otsuge.py --quiet
"""

from __future__ import annotations

import argparse
import re
import sys
from collections import Counter, defaultdict
from datetime import date, timedelta
from pathlib import Path

from dougu import KYOTEN, frontmatter, read_text, split_frontmatter, write_if_changed

ROOM = KYOTEN / "otsuge"

# ひさしぶりと見なす空き。1か月ぶりに戻ってきたら言う価値がある。
BACK_AFTER = 30

# 止まっていると見なす日数と、それを言うに値する重み。数コミットで
# 終わった実験まで並べると「止まっているもの」が数十行になる。
STALE_AFTER = 60
STALE_MIN_COMMITS = 10
STALE_SHOWN = 8

RE_COMMIT = re.compile(r"^- `([0-9a-f]{4,})` ")
RE_FILE = re.compile(r"^- `([^`]+)`")
RE_HEAD2 = re.compile(r"^## (.+)$")
RE_HEAD3 = re.compile(r"^### (.+)$")

EXT_IGNORE = {
    "png", "jpg", "jpeg", "gif", "svg", "ico", "webp", "avif", "pdf",
    "lock", "sum", "map", "min", "snap", "log", "txt", "csv",
}
ALIAS = {
    "ts": "typescript", "tsx": "typescript", "mts": "typescript",
    "js": "javascript", "mjs": "javascript", "cjs": "javascript", "jsx": "javascript",
    "go": "golang", "py": "python", "rb": "ruby", "rs": "rust",
    "md": "markdown", "sh": "shell", "bash": "shell", "yml": "yaml",
    "scss": "css", "sass": "css",
}


class Day:
    __slots__ = ("commits", "projects", "exts", "troubles", "trouble_tools",
                 "articles", "posts", "utterances", "sessions", "titles")

    def __init__(self) -> None:
        self.commits = 0
        self.projects: Counter = Counter()
        self.exts: Counter = Counter()
        self.troubles = 0
        self.trouble_tools: Counter = Counter()
        self.articles = 0
        self.posts = 0
        self.utterances = 0
        self.sessions = 0
        self.titles: list[str] = []


def ext_name(path: str) -> str:
    base = path.rsplit("/", 1)[-1]
    ext = base.rsplit(".", 1)[-1].lower() if "." in base else base.lower()
    if not ext or len(ext) > 12 or ext in EXT_IGNORE or not ext.isalnum():
        return ""
    return ALIAS.get(ext, ext)


def day_of(days: dict[str, Day], key: str) -> Day:
    if key not in days:
        days[key] = Day()
    return days[key]


def scan(days: dict[str, Day]) -> None:
    """拠点の各部屋を日付ごとに集める。"""
    root = KYOTEN / "teato"
    if root.is_dir():
        for path in sorted(root.rglob("*.md")):
            fields, body, _ = split_frontmatter(read_text(path))
            date_key = fields.get("date", "")
            if not date_key:
                continue
            day = day_of(days, date_key)
            project = section = ""

            for line in body.split("\n"):
                got = RE_HEAD2.match(line)
                if got:
                    project = got.group(1).strip()
                    section = ""
                    continue
                got = RE_HEAD3.match(line)
                if got:
                    section = got.group(1).strip()
                    continue

                if section == "つくった" and RE_COMMIT.match(line):
                    day.commits += 1
                    if project:
                        day.projects[project] += 1
                elif section == "さわった":
                    got = RE_FILE.match(line)
                    if got:
                        name = ext_name(got.group(1))
                        if name:
                            day.exts[name] += 1
                elif section == "つまずいた" and line.startswith("- "):
                    day.troubles += 1
                    # "- 12:34:56 Bash `…`" の道具の名前だけ数える。
                    parts = line.split()
                    if len(parts) >= 3:
                        day.trouble_tools[parts[2]] += 1

    root = KYOTEN / "soto"
    if root.is_dir():
        for path in sorted(root.rglob("*.md")):
            fields, _, _ = split_frontmatter(read_text(path)[:3000])
            date_key = fields.get("date", "")
            if not date_key:
                continue
            day = day_of(days, date_key)
            if fields.get("source") == "polidog.jp":
                day.articles += 1
                if fields.get("title"):
                    day.titles.append(fields["title"])
            else:
                day.posts += 1

    root = KYOTEN / "kotonoha"
    if root.is_dir():
        for path in sorted(root.rglob("*.md")):
            fields, _, _ = split_frontmatter(read_text(path)[:2000])
            date_key = fields.get("date", "")
            if date_key:
                try:
                    day_of(days, date_key).utterances += int(fields.get("utterances", 0))
                except (TypeError, ValueError):
                    pass

    root = KYOTEN / "bouken"
    if root.is_dir():
        for path in sorted(root.rglob("*.md")):
            fields, _, _ = split_frontmatter(read_text(path)[:2000])
            date_key = (fields.get("started") or "")[:10]
            if date_key:
                day_of(days, date_key).sessions += 1


# ---------------------------------------------------------------- 週に畳む

def monday(day: date) -> date:
    return day - timedelta(days=day.weekday())


def week_key(day: date) -> str:
    iso = day.isocalendar()
    return f"{iso[0]}-W{iso[1]:02d}"


def parse(key: str) -> date | None:
    try:
        return date(int(key[:4]), int(key[5:7]), int(key[8:10]))
    except (ValueError, IndexError):
        return None


class Week:
    __slots__ = ("key", "start", "end", "commits", "projects", "exts",
                 "troubles", "trouble_tools", "articles", "posts",
                 "utterances", "sessions", "titles", "days_worked")

    def __init__(self, key: str, start: date) -> None:
        self.key = key
        self.start = start
        self.end = start + timedelta(days=6)
        self.commits = 0
        self.projects: Counter = Counter()
        self.exts: Counter = Counter()
        self.troubles = 0
        self.trouble_tools: Counter = Counter()
        self.articles = 0
        self.posts = 0
        self.utterances = 0
        self.sessions = 0
        self.titles: list[str] = []
        self.days_worked = 0

    def add(self, day: Day) -> None:
        self.commits += day.commits
        self.projects.update(day.projects)
        self.exts.update(day.exts)
        self.troubles += day.troubles
        self.trouble_tools.update(day.trouble_tools)
        self.articles += day.articles
        self.posts += day.posts
        self.utterances += day.utterances
        self.sessions += day.sessions
        self.titles.extend(day.titles)
        if day.commits:
            self.days_worked += 1

    def empty(self) -> bool:
        return not (self.commits or self.articles or self.posts
                    or self.utterances or self.sessions)


def fold(days: dict[str, Day]) -> list[Week]:
    weeks: dict[str, Week] = {}
    for key, day in days.items():
        got = parse(key)
        if not got:
            continue
        start = monday(got)
        week = weeks.setdefault(week_key(got), Week(week_key(got), start))
        week.add(day)
    return [w for _, w in sorted(weeks.items()) if not w.empty()]


# ---------------------------------------------------------------- 告げる

def diff(now: int, before: int | None) -> str:
    if before is None:
        return ""
    delta = now - before
    if delta == 0:
        return f"（先週 {before:,} / 同じ）"
    return f"（先週 {before:,} / {delta:+,}）"


def render(week: Week, before: Week | None, seen: dict[str, str],
           totals: dict[str, int]) -> str:
    """1週ぶんのおつげ。

    `seen` はその週に入る**前**までの、プロジェクトごとの最後の日。
    `totals` は同じくコミットの累計。どちらも未来を含まない。
    """
    head = frontmatter({
        "room": "otsuge",
        "week": week.key,
        "from": week.start.isoformat(),
        "to": week.end.isoformat(),
        "commits": week.commits,
    })

    body = [f"# {week.key} のおつげ", f"{week.start} 〜 {week.end}"]

    lines = []
    if week.commits:
        lines.append(f"- コミット {week.commits:,}"
                     f"{diff(week.commits, before.commits if before else None)}"
                     f"　手を動かした日 {week.days_worked}")
    if week.articles:
        lines.append(f"- 記事 {week.articles:,}"
                     f"{diff(week.articles, before.articles if before else None)}")
    if week.posts:
        lines.append(f"- SNS {week.posts:,} 日ぶん"
                     f"{diff(week.posts, before.posts if before else None)}")
    if week.sessions:
        lines.append(f"- 会話 {week.sessions:,}"
                     f"{diff(week.sessions, before.sessions if before else None)}"
                     + (f"　発言 {week.utterances:,}" if week.utterances else ""))
    if lines:
        body.append("## 今週\n\n" + "\n".join(lines))

    if week.projects:
        lines = []
        for name, n in week.projects.most_common(8):
            mark = ""
            if name not in seen:
                mark = "（はじめて）"
            else:
                gap = (week.start - date.fromisoformat(seen[name])).days
                if gap >= BACK_AFTER:
                    mark = f"（{gap}日ぶり）"
            lines.append(f"- {name} {n:,}{mark}")
        body.append("## よくいた場所\n\n" + "\n".join(lines))

    if week.exts:
        body.append("## 手が動いたもの\n\n" + "、".join(
            f"{name} {n:,}" for name, n in week.exts.most_common(8)))

    if week.troubles:
        detail = "、".join(f"{t} {n}" for t, n in week.trouble_tools.most_common(5))
        body.append(f"## つまずき\n\n{week.troubles} 件"
                    f"{diff(week.troubles, before.troubles if before else None)}"
                    + (f"\n\n{detail}" if detail else ""))

    if week.titles:
        body.append("## そとに出したもの\n\n" + "\n".join(f"- {t}" for t in week.titles))

    # 止まっているもの。**この週の終わりの時点で**数える。
    stale = []
    for name, last in seen.items():
        if name in week.projects:
            continue
        if totals.get(name, 0) < STALE_MIN_COMMITS:
            continue
        gap = (week.end - date.fromisoformat(last)).days
        if gap >= STALE_AFTER:
            stale.append((gap, name, totals.get(name, 0)))
    if stale:
        stale.sort(reverse=True)
        body.append("## 止まっているもの\n\n" + "\n".join(
            f"- {name} {gap}日（{n:,} コミット積んで）"
            for gap, name, n in stale[:STALE_SHOWN]))

    return head + "\n\n" + "\n\n".join(body) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description="おつげ — 週ごとの観測")
    ap.add_argument("--dry-run", action="store_true", help="書かずに結果だけ出す")
    ap.add_argument("--quiet", action="store_true", help="1行だけ報告する")
    args = ap.parse_args()

    days: dict[str, Day] = {}
    scan(days)
    weeks = fold(days)

    # 週を古い順に見ながら「その時点までに知っていること」を育てる。
    # 先に全部集めてしまうと、過去のおつげが未来を知ってしまう。
    seen: dict[str, str] = {}
    totals: dict[str, int] = {}
    stats = {"new": 0, "updated": 0, "same": 0}
    before: Week | None = None

    for week in weeks:
        out = ROOM / f"{week.key}.md"
        stats[write_if_changed(out, render(week, before, dict(seen), dict(totals)),
                               args.dry_run)] += 1

        # この週を見終えてから知識を更新する。
        for name, n in week.projects.items():
            seen[name] = week.end.isoformat()
            totals[name] = totals.get(name, 0) + n
        before = week

    total = sum(stats.values())
    if args.quiet:
        print(f"otsuge: {total}週 (new {stats['new']} / upd {stats['updated']} "
              f"/ same {stats['same']})")
    else:
        if args.dry_run:
            print("（書かずに確認）")
        print(f"  おつげ       : {total:,} 週")
        print(f"    あたらしい : {stats['new']:,}")
        print(f"    かきかえ   : {stats['updated']:,}")
        print(f"    かわらず   : {stats['same']:,}")
        if weeks:
            print(f"  期間         : {weeks[0].key} 〜 {weeks[-1].key}")
        print(f"  ばしょ : {ROOM}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
