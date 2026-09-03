#!/usr/bin/env python3
"""fukuro — ふくろ（長期記憶）

拠点に溜まったものを、**プロジェクトごとに1枚**へ畳み直す。
ぼうけんのしょ・ことのは・てのあと・そとのこえは時間で並んでいるので、
「このプロジェクトで何をしていたのか」を見るには何十日ぶんも辿ることに
なる。ふくろはその横串。

出力は `fukuro/project/<name>.md`。素材はすべて**拠点の中**にある
（jsonl や git を直接見にいかない）—— 拠点が正本で、ふくろはその畳み方だ、
という関係を保つため。順番は utsushi → kotonoha → teato → fukuro。

掟:
  - 決定論的: 同じ拠点なら必ず同じ出力。
  - 冪等: 内容が変わらなければファイルに触れない。
  - 手で書かせない: ここに人が書き足す欄は作らない。増えるのは素材の側。

使い方:
    fukuro.py                   # 全部
    fukuro.py --dry-run
    fukuro.py --quiet
"""

from __future__ import annotations

import argparse
import re
import sys
from collections import Counter
from pathlib import Path

from dougu import (
    KYOTEN,
    frontmatter,
    read_text,
    safe_path,
    split_frontmatter,
    write_if_changed,
)

ROOM = KYOTEN / "fukuro" / "project"

# よく出てくる語の数と、拾う語の形。日本語を分かち書きせずに済ませるため、
# 「2文字以上のカタカナ」「2文字以上の漢字」「3文字以上の英数字」を語と
# みなす。形態素解析を入れれば精度は上がるが、依存を増やさない（掟6）。
WORDS_SHOWN = 20
RE_WORD = re.compile(r"[ァ-ヶー]{2,}|[一-龥]{2,}|[A-Za-z][A-Za-z0-9_.-]{2,}")

# どのプロジェクトでも上位に来てしまう語。残しても何も区別できない。
STOPWORDS = {
    "こと", "もの", "これ", "それ", "ため", "よう", "場合", "自分", "今回",
    "確認", "実装", "対応", "修正", "追加", "変更", "作成", "削除", "実行",
    "使用", "利用", "設定", "処理", "表示", "取得", "問題", "内容", "部分",
    "以下", "以上", "現在", "状態", "情報", "方法", "感じ", "気持", "説明",
    "the", "and", "for", "with", "that", "this", "you", "not", "are", "但",
    "http", "https", "com", "org", "www", "html", "json", "true", "false",
    "null", "して", "ください", "です", "ます", "した", "する", "ある",
    # GitHub が書く定型のコミット件名（"Merge pull request #12 from …"）。
    # どのリポジトリでも上位に来るので、区別の役に立たない。
    "merge", "pull", "request", "from", "into", "branch", "commit",
}

# そとのこえの本文でプロジェクトを探すときの手がかり。`polidog/kyoten` の
# 記事が `kyoten` としか書かれていないことが多いので、名前の末尾も見る。
# 短すぎる名前（`web` など）は普通の単語に当たるので使わない。
SHORT_NAME_MIN = 5


class Project:
    __slots__ = ("name", "sessions", "utterances", "replies", "sources", "models",
                 "first", "last", "commits", "troubles", "kotonoha_days", "soto")

    def __init__(self, name: str) -> None:
        self.name = name
        self.sessions = 0
        self.utterances = 0
        self.replies = 0
        self.sources: Counter = Counter()
        self.models: Counter = Counter()
        self.first = ""
        self.last = ""
        self.commits = 0
        self.troubles = 0
        self.kotonoha_days: list[str] = []
        self.soto: list[tuple[str, str, str]] = []   # (date, source, title)

    def absorb(self, other: "Project") -> None:
        """サブディレクトリで分かれていた自分を取り込む。"""
        self.sessions += other.sessions
        self.utterances += other.utterances
        self.replies += other.replies
        self.sources.update(other.sources)
        self.models.update(other.models)
        self.commits += other.commits
        self.troubles += other.troubles
        self.saw(other.first)
        self.saw(other.last)
        for date in other.kotonoha_days:
            if date not in self.kotonoha_days:
                self.kotonoha_days.append(date)
        self.soto.extend(other.soto)

    def saw(self, date: str) -> None:
        if not date:
            return
        if not self.first or date < self.first:
            self.first = date
        if not self.last or date > self.last:
            self.last = date


def get(projects: dict[str, Project], name: str) -> Project:
    if name not in projects:
        projects[name] = Project(name)
    return projects[name]


# ---------------------------------------------------------------- 素材を読む

def scan_bouken(projects: dict[str, Project]) -> None:
    """ぼうけんのしょ。1ファイル = 1セッション。"""
    root = KYOTEN / "bouken"
    if not root.is_dir():
        return

    for path in sorted(root.rglob("*.md")):
        fields, _, _ = split_frontmatter(read_text(path)[:2000])
        name = fields.get("project")
        if not name:
            continue

        project = get(projects, name)
        project.sessions += 1
        project.utterances += int_of(fields.get("utterances"))
        project.replies += int_of(fields.get("replies"))
        if fields.get("source"):
            project.sources[fields["source"]] += 1
        for model in (fields.get("models") or "").split(","):
            model = model.strip()
            if model:
                project.models[model] += 1
        project.saw((fields.get("started") or "")[:10])
        project.saw((fields.get("ended") or "")[:10])


def scan_teato(projects: dict[str, Project], texts: dict[str, list[str]]) -> None:
    """てのあと。日ごとのファイルを、プロジェクトの見出しで割って数える。

    frontmatter の `projects` はその日に触れた顔ぶれしか持たないので、
    件数は本文から数える（`## <project>` の下の `- \\`sha\\` 件名` の数）。
    """
    root = KYOTEN / "teato"
    if not root.is_dir():
        return

    head_project = re.compile(r"^## (.+)$")
    head_section = re.compile(r"^### (.+)$")
    commit_line = re.compile(r"^- `[0-9a-f]{4,}` ")

    for path in sorted(root.rglob("*.md")):
        fields, body, _ = split_frontmatter(read_text(path))
        date = fields.get("date", "")
        name = ""
        section = ""

        for line in body.split("\n"):
            got = head_project.match(line)
            if got:
                name = got.group(1).strip()
                section = ""
                if name:
                    get(projects, name).saw(date)
                continue
            got = head_section.match(line)
            if got:
                section = got.group(1).strip()
                continue
            if not name:
                continue
            if section == "つくった" and commit_line.match(line):
                get(projects, name).commits += 1
                # コミットの件名も本人が書いた言葉。ことのはと同じ資格で
                # 「よく出てくる語」の素材にする（発言が少ないプロジェクトほど、
                # 何をしていたかはコミットの側に残っている）。
                texts.setdefault(name, []).append(line.split("` ", 1)[-1])
            elif section == "つまずいた" and line.startswith("- "):
                get(projects, name).troubles += 1


def scan_kotonoha(projects: dict[str, Project]) -> dict[str, list[str]]:
    """ことのは。プロジェクトごとの日数と、頻出語のための本文を集める。

    見出しは `## HH:MM:SS <project>（source · command）`。プロジェクト名に
    括弧は入らないので、最初の `（` までを名前として切る。
    """
    root = KYOTEN / "kotonoha"
    texts: dict[str, list[str]] = {}
    if not root.is_dir():
        return texts

    head = re.compile(r"^## \d\d:\d\d:\d\d +(.+?)（")

    for path in sorted(root.rglob("*.md")):
        fields, body, _ = split_frontmatter(read_text(path))
        date = fields.get("date", "")
        name = ""

        for line in body.split("\n"):
            got = head.match(line)
            if got:
                name = got.group(1).strip()
                project = get(projects, name)
                project.saw(date)
                if date and date not in project.kotonoha_days:
                    project.kotonoha_days.append(date)
                continue
            if name and line.strip() and not line.startswith("#"):
                texts.setdefault(name, []).append(line)

    return texts


def scan_soto(projects: dict[str, Project]) -> None:
    """そとのこえ。プロジェクトの名前が出てくる記事・投稿を拾う。

    素朴な部分一致。`polidog/kyoten` は記事の中で `kyoten` としか書かれない
    ので末尾の名前でも探すが、短い名前（`web` `shares`）は普通の単語に
    当たるので使わない。
    """
    root = KYOTEN / "soto"
    if not root.is_dir():
        return

    needles: list[tuple[str, list[str]]] = []
    for name in projects:
        # 探すのは ghq のリポジトリ（`<user>/<repo>`）だけ。`Work` や
        # `_home` は「そのディレクトリで作業した」という擬似プロジェクトで、
        # 名前が普通の単語なので部分一致が総なめになる（実測: `Work` が
        # "work" を含む記事 87 本を、`_home` が 4 本を拾っていた）。
        if "/" not in name:
            continue
        tail = name.rsplit("/", 1)[-1]
        keys = [name]
        if len(tail) >= SHORT_NAME_MIN:
            keys.append(tail)
        needles.append((name, keys))

    for path in sorted(root.rglob("*.md")):
        text = read_text(path)
        fields, body, _ = split_frontmatter(text)
        low = body.lower()
        date = fields.get("date", "")
        source = fields.get("source", "")
        title = fields.get("title", "") or path.stem

        for name, keys in needles:
            if any(key.lower() in low for key in keys):
                projects[name].soto.append((date, source, title))


def fold(projects: dict[str, Project], texts: dict[str, list[str]]) -> None:
    """`<repo>/apps/web` のような枝を `<repo>` に畳む。

    `slug_from_cwd()` は cwd をそのまま名前にするので、モノレポの奥で
    作業した回は別のプロジェクトに見える。台帳が分かれると「このリポジトリを
    どれだけ触ったか」が分からなくなるので、親が実在するなら合流させる。
    長い名前から順に畳むのは、2 段以上ネストした枝を取りこぼさないため。
    """
    for name in sorted(projects, key=len, reverse=True):
        if name not in projects:
            continue
        parts = name.split("/")
        for i in range(len(parts) - 1, 0, -1):
            head = "/".join(parts[:i])
            if head in projects and head != name:
                projects[head].absorb(projects.pop(name))
                if name in texts:
                    texts.setdefault(head, []).extend(texts.pop(name))
                break


def int_of(value) -> int:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return 0


def frequent(lines: list[str]) -> list[tuple[str, int]]:
    counts: Counter = Counter()
    for line in lines:
        for word in RE_WORD.findall(line):
            key = word.lower() if word.isascii() else word
            if key in STOPWORDS or len(key) < 2:
                continue
            counts[key] += 1
    # 1 回しか出てこない語はその日の偶然。2 回以上だけ残す。
    return [(w, n) for w, n in counts.most_common(WORDS_SHOWN * 2) if n >= 2][:WORDS_SHOWN]


# ---------------------------------------------------------------- 書く

def render(project: Project, words: list[tuple[str, int]]) -> str:
    head = frontmatter({
        "room": "fukuro",
        "kind": "project",
        "name": project.name,
        "first": project.first,
        "last": project.last,
        "sessions": project.sessions,
        "commits": project.commits,
    })

    counts = []
    if project.sessions:
        counts.append(f"会話 {project.sessions:,}")
    if project.utterances:
        counts.append(f"発言 {project.utterances:,}")
    if project.commits:
        counts.append(f"コミット {project.commits:,}")
    if project.troubles:
        counts.append(f"つまずき {project.troubles:,}")

    body = [f"# {project.name}", " / ".join(counts) or "（まだ何もない）"]

    span = []
    if project.first:
        span.append(f"- はじめて: {project.first}")
    if project.last:
        span.append(f"- さいご  : {project.last}")
    if project.sources:
        span.append("- どこから: " + "、".join(
            f"{k} {v}" for k, v in sorted(project.sources.items())))
    if project.models:
        span.append("- だれと  : " + "、".join(
            f"{k} {v}" for k, v in sorted(project.models.items())))
    if span:
        body.append("## いつ・どこで\n\n" + "\n".join(span))

    if project.soto:
        seen: set[tuple[str, str]] = set()
        lines = []
        for date, source, title in sorted(project.soto, reverse=True):
            key = (date, title)
            if key in seen:
                continue
            seen.add(key)
            lines.append(f"- {date} {source}: {title}")
        body.append("## そとに出したもの\n\n" + "\n".join(lines[:30]))

    if project.kotonoha_days:
        days = sorted(project.kotonoha_days, reverse=True)
        shown = "、".join(days[:10])
        more = f"（ほか {len(days) - 10} 日）" if len(days) > 10 else ""
        body.append(f"## しゃべった日\n\n{shown}{more}")

    if words:
        body.append("## よく出てくる語\n\n" + "、".join(
            f"{w}({n})" for w, n in words))

    return head + "\n\n" + "\n\n".join(body) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description="ふくろ — 長期記憶（プロジェクト台帳）")
    ap.add_argument("--dry-run", action="store_true", help="書かずに結果だけ出す")
    ap.add_argument("--quiet", action="store_true", help="1行だけ報告する")
    args = ap.parse_args()

    projects: dict[str, Project] = {}
    scan_bouken(projects)
    texts = scan_kotonoha(projects)
    scan_teato(projects, texts)
    fold(projects, texts)
    scan_soto(projects)

    stats = {"new": 0, "updated": 0, "same": 0}
    for name, project in sorted(projects.items()):
        out = ROOM / (safe_path(name).replace("/", "-") + ".md")
        stats[write_if_changed(out, render(project, frequent(texts.get(name, []))),
                               args.dry_run)] += 1

    total = sum(stats.values())
    if args.quiet:
        print(f"fukuro: {total}プロジェクト (new {stats['new']} "
              f"/ upd {stats['updated']} / same {stats['same']})")
    else:
        if args.dry_run:
            print("（書かずに確認）")
        print(f"  ふくろ       : {total:,} プロジェクト")
        print(f"    あたらしい : {stats['new']:,}")
        print(f"    かきかえ   : {stats['updated']:,}")
        print(f"    かわらず   : {stats['same']:,}")
        print(f"  ばしょ : {ROOM}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
