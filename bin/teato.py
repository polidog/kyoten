#!/usr/bin/env python3
"""teato — てのあと（作ったもの・詰まったこと）

その日に何を作り、どこで詰まったかを日ごとに束ねる。

素材は2つ:

  - **git** —— `~/ghq` 配下の全リポジトリから、自分のコミット。
    「何を作ったか」はコミットが一番正確で、しかも全部自分が書いた
    メッセージなので嘘がない。
  - **会話ログ** —— 失敗した道具呼び出し（`is_error` の tool_result）。
    コミットに残らない試行錯誤のうち、機械が確実に拾えるのはここだけ。

出力は `teato/<YYYY-MM>/<YYYY-MM-DD>.md`。プロジェクトごとに
「つくった / さわった / つまずいた」の3つに分ける。

掟:
  - 決定論的: 同じ入力なら必ず同じ出力。コミット日時は JST 固定で読む
    （読む側のタイムゾーンで日付が変わると、束ねる日が動く）。
  - 冪等: 内容が変わらなければファイルに触れない。
  - 原文ママ: コミットメッセージもエラーも加工しない。長いものは末尾を
    省いて、省いたと書く。

使い方:
    teato.py                    # 全部
    teato.py --dry-run
    teato.py --since 2026-08-01
    teato.py --quiet
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from dougu import (
    CLAUDE_PROJECTS,
    KYOTEN,
    clip,
    frontmatter,
    hhmm,
    jst,
    read_jsonl,
    slug_from_cwd,
    write_if_changed,
)

GHQ = Path.home() / "ghq"
ROOM = KYOTEN / "teato"

# 自分のコミットの見分け方。git の --author は複数指定が OR になる。
# 昔のリポジトリで別のアドレスを使っていても拾えるよう、名前とアドレスの
# 両方を部分一致で当てる。
AUTHORS = ["polidog", "mochizuki"]

# 1日1プロジェクトあたり、並べるファイルの上限。巨大な一括コミット
# （vendor の取り込みなど）で1日が数千行になるのを避ける。
FILES_SHOWN = 40

# しくじりの中身の上限。原本は jsonl に残る。
TROUBLE_LIMIT = 600

STATUS_LABEL = {"A": "新規", "D": "削除", "R": "改名", "C": "複製"}

# 道具は失敗を返したが、詰まったわけではないもの。人が「やめておこう」と
# 言った回は方針が変わった記録であって、つまずきではない。
NOT_STUCK = (
    "The user doesn't want to proceed",
    "The user doesn't want to take this action",
    "[Request interrupted",
    "Tool ran without output",
)

# 本当のしくじりの印。これが入っていれば長さを問わず残す。
STUCK_MARKS = (
    "Traceback (most recent call last)",
    "<tool_use_error>",
)

# `a && b && c` の途中で 1 つだけこけた回は、出力のほとんどが正常な結果で、
# 最後に非ゼロが付いているだけ。エラー文だけの応答は短いので、長さで分ける。
# （実測: 長さとエラー語の 2 つで絞ると 3 日ぶん 117 件が 41 件になり、
# 残ったのは WebFetch のタイムアウト・SQLite の UNIQUE 制約違反・
# Python の SyntaxError といった、読み返す価値のあるものだけだった）
NOISE_LENGTH = 400

# しくじりを名乗る言葉。`Exit code 1` が付いていても、中身が普通の出力
# （`grep` が 1 件も当たらなかった、など）ならつまずきではない。
ERROR_WORDS = (
    "error", "エラー", "not found", "no such", "failed", "failure",
    "cannot", "can't", "unable", "invalid", "denied", "refused",
    "timeout", "timed out", "fatal:", "not exist", "見つかりません",
)


# ---------------------------------------------------------------- git

class Commit:
    __slots__ = ("dt", "project", "sha", "subject", "files")

    def __init__(self, dt, project, sha, subject, files):
        self.dt = dt
        self.project = project
        self.sha = sha
        self.subject = subject
        self.files = files

    def sort_key(self):
        return (self.dt, self.sha)


def repos() -> list[Path]:
    """ghq の置き場から git リポジトリを拾う。

    `ghq list` を呼ばないのは、ghq が入っていない場所でも動くようにする
    ため（掟6・依存を増やさない）。ghq の構造は <host>/<user>/<repo> 固定。
    """
    if not GHQ.is_dir():
        return []
    return sorted(p.parent for p in GHQ.glob("*/*/*/.git"))


def fold(slug: str, known: set[str]) -> str:
    """サブディレクトリで作業していた回を、リポジトリ 1 つに丸める。

    `slug_from_cwd()` は cwd をそのまま名前にするので、モノレポの中で
    `apps/web` に降りて作業した日は `<repo>/apps/web` という別のプロジェクト
    に見える。git 側は常にリポジトリのルートを名乗るので、放っておくと
    「つくった」と「つまずいた」が同じ日の別々の見出しに割れる。
    """
    if slug in known:
        return slug
    parts = slug.split("/")
    for i in range(len(parts) - 1, 0, -1):
        head = "/".join(parts[:i])
        if head in known:
            return head
    return slug


def git_log(repo: Path, since: str | None) -> str:
    """その リポジトリの自分のコミットを、機械が読める形で吐かせる。

    日付を `format-local` にしたうえで TZ=Asia/Tokyo を渡すのは決定論の
    ため。既定の `%ad` はコミットに刻まれたタイムゾーンで表示するので、
    出先で打ったコミットが別の日に落ちる。
    """
    args = ["git", "-C", str(repo), "log", "--no-color",
            "--format=%x00%h%x1f%ad%x1f%s", "--date=format-local:%Y-%m-%d %H:%M:%S",
            "--name-status"]
    for author in AUTHORS:
        args.append(f"--author={author}")
    if since:
        args.append(f"--since={since} 00:00:00")

    env = dict(os.environ, TZ="Asia/Tokyo", GIT_PAGER="cat")
    try:
        done = subprocess.run(args, capture_output=True, text=True,
                              timeout=120, env=env)
    except (subprocess.TimeoutExpired, OSError):
        return ""
    return done.stdout if done.returncode == 0 else ""


def commits_of(repo: Path, since: str | None):
    project = slug_from_cwd(str(repo))
    for block in git_log(repo, since).split("\0"):
        if not block.strip():
            continue
        head, _, rest = block.partition("\n")
        parts = head.split("\x1f")
        if len(parts) != 3:
            continue
        sha, stamp, subject = parts

        dt = jst(stamp.replace(" ", "T") + "+09:00")
        if not dt:
            continue

        files = []
        for line in rest.splitlines():
            if not line.strip():
                continue
            cols = line.split("\t")
            if len(cols) < 2:
                continue
            # 改名は "R100\told\tnew"。新しい方だけ残す。
            files.append((cols[0][:1], cols[-1]))

        yield Commit(dt, project, sha, subject.strip(), files)


# ---------------------------------------------------------------- しくじり

class Trouble:
    __slots__ = ("dt", "project", "tool", "target", "body", "key")

    def __init__(self, dt, project, tool, target, body, key):
        self.dt = dt
        self.project = project
        self.tool = tool
        self.target = target
        self.body = body
        self.key = key

    def sort_key(self):
        return (self.dt, self.tool, self.target)


def looks_stuck(body: str) -> bool:
    """道具の失敗が「詰まった」に値するか。

    `is_error` は落ちた合図でしかない。`ls … && wc -l …` のように繋げた
    コマンドは、前半が正常に出力を返していても最後の 1 つがこければ
    is_error になる。それを全部書き写すと、てのあとが端末のログになって
    読み返せなくなる。
    """
    if any(mark in body for mark in STUCK_MARKS):
        return True
    if len(body) > NOISE_LENGTH:
        return False
    low = body.lower()
    return any(word in low for word in ERROR_WORDS)


def target_of(tool: str, inputs: dict) -> str:
    """道具の呼び出しから「何に対して」だけを取り出す。

    入力を丸ごと残すと、拠点に API キーの入ったコマンドが写りかねない。
    ここで見るのは Bash のコマンドとファイルのパスだけにする。
    """
    if not isinstance(inputs, dict):
        return ""
    for key in ("command", "file_path", "path", "pattern", "url"):
        value = inputs.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def troubles_from(path: Path):
    """失敗した道具呼び出しを拾う。

    `tool_use` と `tool_result` は別の行に出るので、先に id → 呼び出しの
    表を作ってから結果を見る。両者が同じファイルに無いことは（--resume で
    分かれない限り）無い。
    """
    calls: dict[str, tuple[str, str]] = {}
    rows = list(read_jsonl(path))

    for row in rows:
        content = (row.get("message") or {}).get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if isinstance(block, dict) and block.get("type") == "tool_use":
                calls[str(block.get("id"))] = (
                    str(block.get("name") or "?"),
                    target_of(str(block.get("name") or ""), block.get("input") or {}),
                )

    for row in rows:
        if row.get("isSidechain"):
            continue
        content = (row.get("message") or {}).get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "tool_result":
                continue
            if not block.get("is_error"):
                continue

            tool, target = calls.get(str(block.get("tool_use_id")), ("?", ""))
            body = block.get("content")
            if isinstance(body, list):
                body = "\n".join(
                    b.get("text", "") for b in body
                    if isinstance(b, dict) and b.get("type") == "text"
                )
            body = str(body or "").strip()
            if not body or body.startswith(NOT_STUCK) or not looks_stuck(body):
                continue

            dt = jst(row.get("timestamp"))
            if not dt:
                continue

            yield Trouble(dt, slug_from_cwd(row.get("cwd")), tool, target, body,
                          str(block.get("tool_use_id") or f"{dt.isoformat()}:{target}"))


# ---------------------------------------------------------------- 束ねる

def render_day(date: str, commits: list[Commit], troubles: list[Trouble]) -> str:
    projects: list[str] = []
    for item in [*commits, *troubles]:
        if item.project not in projects:
            projects.append(item.project)
    projects.sort()

    body = []
    for project in projects:
        mine = [c for c in commits if c.project == project]
        stuck = [t for t in troubles if t.project == project]
        block = [f"## {project}"]

        if mine:
            block.append("### つくった")
            block.append("\n".join(f"- `{c.sha}` {c.subject}" for c in mine))

            # ファイルはコミットをまたいで1つにまとめる。同じファイルを
            # 何度も直した日に、同じ行が並ぶのを避ける。
            touched: dict[str, str] = {}
            for commit in mine:
                for status, path in commit.files:
                    touched.setdefault(path, status)
            if touched:
                shown = sorted(touched)[:FILES_SHOWN]
                lines = []
                for path in shown:
                    label = STATUS_LABEL.get(touched[path], "")
                    lines.append(f"- `{path}`" + (f"（{label}）" if label else ""))
                if len(touched) > FILES_SHOWN:
                    lines.append(f"- … ほか {len(touched) - FILES_SHOWN} ファイル")
                block.append("### さわった")
                block.append("\n".join(lines))

        if stuck:
            block.append("### つまずいた")
            lines = []
            for trouble in stuck:
                head = f"- {hhmm(trouble.dt)} {trouble.tool}"
                if trouble.target:
                    head += f" `{trouble.target.splitlines()[0][:120]}`"
                lines.append(head)
                text = clip(trouble.body, TROUBLE_LIMIT)
                lines.append("\n".join("  " + s for s in text.splitlines()))
            block.append("\n\n".join(lines))

        body.append("\n\n".join(block))

    head = frontmatter({
        "room": "teato",
        "date": date,
        "commits": len(commits),
        "troubles": len(troubles),
        "projects": ", ".join(projects),
    })
    return head + f"\n\n# {date} てのあと\n\n" + "\n\n".join(body) + "\n"


# ---------------------------------------------------------------- 入口

def main() -> int:
    ap = argparse.ArgumentParser(description="てのあと — 作ったもの・詰まったこと")
    ap.add_argument("--dry-run", action="store_true", help="書かずに結果だけ出す")
    ap.add_argument("--since", metavar="YYYY-MM-DD", help="この日以降だけ")
    ap.add_argument("--quiet", action="store_true", help="1行だけ報告する")
    args = ap.parse_args()

    since = None
    if args.since:
        try:
            since = datetime.strptime(args.since, "%Y-%m-%d").date()
        except ValueError:
            print(f"--since の日付が読めません: {args.since}", file=sys.stderr)
            return 2

    days_commits: dict[str, list[Commit]] = {}
    found = 0
    for repo in repos():
        for commit in commits_of(repo, args.since):
            if since and commit.dt.date() < since:
                continue
            days_commits.setdefault(commit.dt.strftime("%Y-%m-%d"), []).append(commit)
            found += 1

    known = {slug_from_cwd(str(r)) for r in repos()}
    days_troubles: dict[str, list[Trouble]] = {}
    seen: set[str] = set()
    failed = 0
    if CLAUDE_PROJECTS.is_dir():
        for path in sorted(CLAUDE_PROJECTS.rglob("*.jsonl")):
            try:
                items = list(troubles_from(path))
            except Exception as exc:  # 1ファイルの失敗で全体を止めない
                failed += 1
                print(f"  ✗ {path.name}: {exc}", file=sys.stderr)
                continue
            for trouble in items:
                if trouble.key in seen:
                    continue
                seen.add(trouble.key)
                if since and trouble.dt.date() < since:
                    continue
                trouble.project = fold(trouble.project, known)
                days_troubles.setdefault(trouble.dt.strftime("%Y-%m-%d"), []).append(trouble)

    stats = {"new": 0, "updated": 0, "same": 0}
    for date in sorted(set(days_commits) | set(days_troubles)):
        commits = sorted(days_commits.get(date, []), key=Commit.sort_key)
        troubles = sorted(days_troubles.get(date, []), key=Trouble.sort_key)
        out = ROOM / date[:7] / f"{date}.md"
        stats[write_if_changed(out, render_day(date, commits, troubles), args.dry_run)] += 1

    n_days = sum(stats.values())
    n_troubles = sum(len(v) for v in days_troubles.values())
    if args.quiet:
        print(f"teato: {n_days}日 (new {stats['new']} / upd {stats['updated']} "
              f"/ same {stats['same']}) つくった {found:,} つまずいた {n_troubles:,}")
    else:
        if args.dry_run:
            print("（書かずに確認）")
        print(f"  てのあと     : {n_days:,} 日ぶん")
        print(f"    あたらしい : {stats['new']:,}")
        print(f"    かきかえ   : {stats['updated']:,}")
        print(f"    かわらず   : {stats['same']:,}")
        print(f"  つくった     : {found:,} コミット（{len(repos()):,} リポジトリ）")
        print(f"  つまずいた   : {n_troubles:,}")
        if failed:
            print(f"    しっぱい   : {failed:,}")
        print(f"  ばしょ : {ROOM}")

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
