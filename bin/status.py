#!/usr/bin/env python3
"""status — ステータス・とくぎ・年表（観測結果の2階）

1階（ぼうけんのしょ・ことのは・そとのこえ・てのあと・ふくろ）に溜まった
ものを、**人が読むための形**に畳む。ふくろが「プロジェクトごとの横串」
なら、こちらは「技ごと」と「年ごと」と「いま」。

    status/status.md          いまの自分（1枚）
    status/tokugi/<name>.md   技ごと。いつ覚えて、いつ使ったか
    status/nenpyo/<YYYY>.md   年ごと。その年に何をしていたか

ふくろと同じく**拠点の中しか見ない**。jsonl も git も直接は読まない。
走らせる順番は … → teato → fukuro → status。

掟:
  - 決定論的: 同じ拠点なら必ず同じ出力。「今日から何日」のような、
    走らせた日で変わる数は書かない。
  - 冪等: 内容が変わらなければファイルに触れない。
  - 手で書かせない: 技の一覧も年表も、素材が増えれば勝手に増える。

使い方:
    status.py                   # 全部
    status.py --dry-run
    status.py --quiet
"""

from __future__ import annotations

import argparse
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

from dougu import KYOTEN, frontmatter, read_text, safe_path, split_frontmatter, write_if_changed

ROOM = KYOTEN / "status"

# とくぎとして1枚立てる下限。これを下回るものは、その年に一度触っただけの
# ものが大半で、並べても技には見えない。
MIN_ARTICLES = 5
MIN_FILES = 50

# 「いま」の窓。直近の日数ではなく**拠点にある最後の日から**遡る
# —— 走らせた日で結果が変わると決定論が崩れる。
RECENT_DAYS = 90

# 言語の名前と、手が動いたときに残る拡張子。タグと拡張子が同じ名前の
# ものは書かない（`php` ↔ `.php` は名前で結びつく）。ここに並ぶのは
# 「名前と拡張子が違う」ものだけ。
ALIAS = {
    "typescript": ["ts", "tsx", "mts", "cts"],
    "javascript": ["js", "mjs", "cjs", "jsx"],
    "golang": ["go"],
    "python": ["py"],
    "ruby": ["rb"],
    "rust": ["rs"],
    "markdown": ["md"],
    "shell": ["sh", "bash", "zsh"],
    "yaml": ["yml"],
    "docker": ["dockerfile"],
    "css": ["scss", "sass"],
    "actionscript": ["as"],
    "objective-c": ["m"],
    "kotlin": ["kt"],
    "sql": ["sql"],
    "terraform": ["tf"],
    "vue": ["vue"],
    "swift": ["swift"],
    "java": ["java"],
    "perl": ["pl", "pm"],
    "elixir": ["ex", "exs"],
}

# 拡張子から技の名前を引く逆引き。
EXT_TO_NAME = {ext: name for name, exts in ALIAS.items() for ext in exts}

# 数えても技にならないもの。画像やロックファイルは、どのプロジェクトでも
# 増えるだけで何も語らない。
EXT_IGNORE = {
    "png", "jpg", "jpeg", "gif", "svg", "ico", "webp", "avif", "pdf",
    "lock", "sum", "map", "min", "snap", "log", "txt", "csv",
}

RE_COMMIT = re.compile(r"^- `([0-9a-f]{4,})` (.*)$")
RE_FILE = re.compile(r"^- `([^`]+)`")
RE_HEAD2 = re.compile(r"^## (.+)$")
RE_HEAD3 = re.compile(r"^### (.+)$")


class Skill:
    """1つの技。書いたもの（記事）と、手が動いたもの（ファイル）の両面。"""

    __slots__ = ("name", "articles", "first_wrote", "last_wrote",
                 "exts", "first_touched", "last_touched", "titles", "friends",
                 "by_month")

    def __init__(self, name: str) -> None:
        self.name = name
        self.articles = 0
        self.first_wrote = ""
        self.last_wrote = ""
        self.exts: Counter = Counter()
        self.first_touched = ""
        self.last_touched = ""
        self.titles: list[tuple[str, str]] = []
        self.friends: Counter = Counter()
        # 月ごとの内訳。「いま手が動いているもの」を全期間の合計で語ると
        # 「21年ぶんの php 3,620」が「直近90日」の欄に出てしまう。
        self.by_month: Counter = Counter()

    @property
    def files(self) -> int:
        return sum(self.exts.values())

    def since(self, cut: str) -> int:
        """cut（YYYY-MM-DD）以降に触ったファイル数。月の粒度で数える。"""
        return sum(n for month, n in self.by_month.items() if month >= cut[:7])

    def wrote(self, date: str) -> None:
        if not date:
            return
        if not self.first_wrote or date < self.first_wrote:
            self.first_wrote = date
        if not self.last_wrote or date > self.last_wrote:
            self.last_wrote = date

    def touched(self, date: str) -> None:
        if not date:
            return
        if not self.first_touched or date < self.first_touched:
            self.first_touched = date
        if not self.last_touched or date > self.last_touched:
            self.last_touched = date

    def first(self) -> str:
        return min(d for d in (self.first_wrote, self.first_touched) if d) \
            if (self.first_wrote or self.first_touched) else ""

    def last(self) -> str:
        return max(d for d in (self.last_wrote, self.last_touched) if d) \
            if (self.last_wrote or self.last_touched) else ""

    def worth_a_page(self) -> bool:
        return self.articles >= MIN_ARTICLES or self.files >= MIN_FILES


class Year:
    __slots__ = ("year", "commits", "days", "articles", "posts", "sessions",
                 "exts", "projects", "titles", "tags")

    def __init__(self, year: str) -> None:
        self.year = year
        self.commits = 0
        self.days = 0
        self.articles = 0
        self.posts = 0
        self.sessions = 0
        self.exts: Counter = Counter()
        self.projects: Counter = Counter()
        self.titles: list[tuple[str, str]] = []
        self.tags: Counter = Counter()


def skill_of(skills: dict[str, Skill], name: str) -> Skill:
    if name not in skills:
        skills[name] = Skill(name)
    return skills[name]


def year_of(years: dict[str, Year], year: str) -> Year:
    if year not in years:
        years[year] = Year(year)
    return years[year]


# ---------------------------------------------------------------- 素材

def scan_soto(skills: dict[str, Skill], years: dict[str, Year],
              span: list[str]) -> None:
    """そとのこえ。記事のタグが「書いたこと」、日付が年表の骨。"""
    root = KYOTEN / "soto"
    if not root.is_dir():
        return

    for path in sorted(root.rglob("*.md")):
        fields, _, _ = split_frontmatter(read_text(path)[:3000])
        date = fields.get("date", "")
        if not date:
            continue
        # ステータスの「いつから」は拠点にある最初の日。タグの付いた記事に
        # 限ると、タグを使い始める前（2004〜2005）が丸ごと落ちる。
        span.append(date)
        year = year_of(years, date[:4])

        if fields.get("source") != "polidog.jp":
            year.posts += 1
            continue

        year.articles += 1
        title = fields.get("title", "")
        if title:
            year.titles.append((date, title))

        tags = [t.strip().lower() for t in (fields.get("tags") or "").split(",")]
        tags = [t for t in tags if t]
        for tag in tags:
            year.tags[tag] += 1
            skill = skill_of(skills, tag)
            skill.articles += 1
            skill.wrote(date)
            if title:
                skill.titles.append((date, title))
            for other in tags:
                if other != tag:
                    skill.friends[other] += 1


def scan_teato(skills: dict[str, Skill], years: dict[str, Year],
               span: list[str]) -> None:
    """てのあと。触ったファイルの拡張子が「手が動いたもの」。"""
    root = KYOTEN / "teato"
    if not root.is_dir():
        return

    for path in sorted(root.rglob("*.md")):
        fields, body, _ = split_frontmatter(read_text(path))
        date = fields.get("date", "")
        if not date:
            continue
        span.append(date)
        year = year_of(years, date[:4])
        year.days += 1

        project = ""
        section = ""
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
                year.commits += 1
                if project:
                    year.projects[project] += 1
            elif section == "さわった":
                got = RE_FILE.match(line)
                if not got:
                    continue
                name = ext_name(got.group(1))
                if not name:
                    continue
                year.exts[name] += 1
                skill = skill_of(skills, name)
                skill.exts[ext_of(got.group(1))] += 1
                skill.by_month[date[:7]] += 1
                skill.touched(date)


def ext_of(path: str) -> str:
    base = path.rsplit("/", 1)[-1]
    if "." not in base:
        return base.lower()
    return base.rsplit(".", 1)[-1].lower()


def ext_name(path: str) -> str:
    """ファイルの名前から技の名前を出す。技でなければ空。"""
    ext = ext_of(path)
    if not ext or len(ext) > 12 or ext in EXT_IGNORE:
        return ""
    if not ext.isalnum():
        return ""
    return EXT_TO_NAME.get(ext, ext)


def scan_rooms() -> dict[str, int]:
    """各部屋の大きさ。ステータスの「つよさ」になる。"""
    counts: dict[str, int] = {}
    for room in ("bouken", "kotonoha", "soto", "teato"):
        root = KYOTEN / room
        counts[room] = len(list(root.rglob("*.md"))) if root.is_dir() else 0
    fukuro = KYOTEN / "fukuro" / "project"
    counts["fukuro"] = len(list(fukuro.glob("*.md"))) if fukuro.is_dir() else 0
    return counts


# ---------------------------------------------------------------- 書く

def render_skill(skill: Skill) -> str:
    head = frontmatter({
        "room": "status",
        "kind": "tokugi",
        "name": skill.name,
        "first": skill.first(),
        "last": skill.last(),
        "articles": skill.articles,
        "files": skill.files,
    })

    span = ""
    first, last = skill.first(), skill.last()
    if first and last:
        span = f"{first} 〜 {last}"
        held = int(last[:4]) - int(first[:4]) + 1
        span += f"（{held}年）"

    body = [f"# {skill.name}", span or "（記録なし）"]

    if skill.articles:
        lines = [f"記事 {skill.articles:,} 本　{skill.first_wrote} 〜 {skill.last_wrote}"]
        for date, title in sorted(skill.titles, reverse=True)[:10]:
            lines.append(f"- {date} {title}")
        if len(skill.titles) > 10:
            lines.append(f"- … ほか {len(skill.titles) - 10} 本")
        body.append("## 書いた\n\n" + "\n".join(lines))

    if skill.files:
        lines = [f"ファイル {skill.files:,}　{skill.first_touched} 〜 {skill.last_touched}"]
        for ext, n in skill.exts.most_common(8):
            lines.append(f"- `.{ext}` {n:,}")
        body.append("## 手が動いた\n\n" + "\n".join(lines))

    if skill.friends:
        body.append("## となりにいるもの\n\n" + "、".join(
            f"{name}({n})" for name, n in skill.friends.most_common(12)))

    return head + "\n\n" + "\n\n".join(body) + "\n"


def render_year(year: Year) -> str:
    head = frontmatter({
        "room": "status",
        "kind": "nenpyo",
        "year": year.year,
        "commits": year.commits,
        "articles": year.articles,
    })

    counts = []
    if year.commits:
        counts.append(f"コミット {year.commits:,}")
    if year.days:
        counts.append(f"手を動かした日 {year.days:,}")
    if year.articles:
        counts.append(f"記事 {year.articles:,}")
    if year.posts:
        counts.append(f"SNS {year.posts:,}日ぶん")

    body = [f"# {year.year}", " / ".join(counts) or "（記録なし）"]

    if year.exts:
        body.append("## 手が動いたもの\n\n" + "\n".join(
            f"- {name} {n:,}" for name, n in year.exts.most_common(10)))
    if year.tags:
        body.append("## 書いたこと\n\n" + "、".join(
            f"{tag}({n})" for tag, n in year.tags.most_common(15)))
    if year.projects:
        body.append("## いた場所\n\n" + "\n".join(
            f"- {name} {n:,}" for name, n in year.projects.most_common(10)))
    if year.titles:
        lines = [f"- {d} {t}" for d, t in sorted(year.titles, reverse=True)[:15]]
        if len(year.titles) > 15:
            lines.append(f"- … ほか {len(year.titles) - 15} 本")
        body.append("## そとに出したもの\n\n" + "\n".join(lines))

    return head + "\n\n" + "\n\n".join(body) + "\n"


def render_status(rooms: dict[str, int], skills: dict[str, Skill],
                  years: dict[str, Year], span: tuple[str, str]) -> str:
    start, today = span

    head = frontmatter({
        "room": "status",
        "kind": "status",
        "first": start,
        "last": today,
        "tokugi": sum(1 for s in skills.values() if s.worth_a_page()),
    })

    body = ["# ステータス"]

    if start and today:
        body.append(f"{start} から {today} まで。{int(today[:4]) - int(start[:4]) + 1} 年。")

    body.append("## つよさ\n\n" + "\n".join([
        f"- ぼうけんのしょ　{rooms.get('bouken', 0):,} さつ",
        f"- ことのは　　　　{rooms.get('kotonoha', 0):,} 日ぶん",
        f"- そとのこえ　　　{rooms.get('soto', 0):,}",
        f"- てのあと　　　　{rooms.get('teato', 0):,} 日ぶん",
        f"- ふくろ　　　　　{rooms.get('fukuro', 0):,} プロジェクト",
    ]))

    # 「いま」は拠点の最後の日から遡る。走らせた日を使うと、同じ拠点でも
    # 日をまたぐたびに中身が変わって冪等が壊れる。
    if today:
        cut = shift_days(today, -RECENT_DAYS)
        now = [(s, s.since(cut)) for s in skills.values() if s.last() >= cut]
        now = [(s, n) for s, n in now if n]
        now.sort(key=lambda pair: (-pair[1], pair[0].name))
        if now:
            body.append(f"## いま手が動いているもの（{cut} 以降）\n\n" + "\n".join(
                f"- {s.name} {n:,}" for s, n in now[:10]))

    long = [s for s in skills.values() if s.worth_a_page() and s.first() and s.last()]
    long.sort(key=lambda s: (int(s.last()[:4]) - int(s.first()[:4]), s.files), reverse=True)
    if long:
        body.append("## 長くいっしょにいるもの\n\n" + "\n".join(
            f"- {s.name} {s.first()[:7]} 〜 {s.last()[:7]}"
            f"（{int(s.last()[:4]) - int(s.first()[:4]) + 1}年）"
            for s in long[:10]))

    if years:
        rows = []
        for key in sorted(years):
            y = years[key]
            top = "、".join(n for n, _ in y.exts.most_common(3)) or \
                  "、".join(t for t, _ in y.tags.most_common(3))
            rows.append(f"| {key} | {y.commits:,} | {y.articles:,} | {top} |")
        body.append("## あゆみ\n\n| 年 | コミット | 記事 | 主に |\n|---|---:|---:|---|\n"
                    + "\n".join(rows))

    return head + "\n\n" + "\n\n".join(body) + "\n"


def shift_days(date: str, delta: int) -> str:
    from datetime import date as D, timedelta
    try:
        base = D(int(date[:4]), int(date[5:7]), int(date[8:10]))
    except (ValueError, IndexError):
        return date
    return (base + timedelta(days=delta)).isoformat()


def main() -> int:
    ap = argparse.ArgumentParser(description="ステータス — 観測結果の2階")
    ap.add_argument("--dry-run", action="store_true", help="書かずに結果だけ出す")
    ap.add_argument("--quiet", action="store_true", help="1行だけ報告する")
    args = ap.parse_args()

    skills: dict[str, Skill] = {}
    years: dict[str, Year] = {}
    span: list[str] = []
    scan_soto(skills, years, span)
    scan_teato(skills, years, span)
    rooms = scan_rooms()
    period = (min(span), max(span)) if span else ("", "")

    stats = {"new": 0, "updated": 0, "same": 0}

    kept = {name: s for name, s in skills.items() if s.worth_a_page()}
    for name, skill in sorted(kept.items()):
        out = ROOM / "tokugi" / (safe_path(name).replace("/", "-") + ".md")
        stats[write_if_changed(out, render_skill(skill), args.dry_run)] += 1

    for key, year in sorted(years.items()):
        out = ROOM / "nenpyo" / f"{key}.md"
        stats[write_if_changed(out, render_year(year), args.dry_run)] += 1

    stats[write_if_changed(ROOM / "status.md",
                           render_status(rooms, skills, years, period),
                           args.dry_run)] += 1

    total = sum(stats.values())
    if args.quiet:
        print(f"status: {total}枚 (new {stats['new']} / upd {stats['updated']} "
              f"/ same {stats['same']}) とくぎ {len(kept)} 年 {len(years)}")
    else:
        if args.dry_run:
            print("（書かずに確認）")
        print(f"  ステータス   : {total:,} 枚")
        print(f"    あたらしい : {stats['new']:,}")
        print(f"    かきかえ   : {stats['updated']:,}")
        print(f"    かわらず   : {stats['same']:,}")
        print(f"  とくぎ       : {len(kept):,}（候補 {len(skills):,}）")
        print(f"  年表         : {len(years):,} 年")
        print(f"  ばしょ : {ROOM}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
