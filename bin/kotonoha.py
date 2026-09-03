#!/usr/bin/env python3
"""kotonoha — ことのは（自分の発言だけを抜き出す）

Claude Code と Codex の jsonl から polidog 本人の発話だけを拾い、
日付ごとに時系列で束ねる。ぼうけんのしょ (bouken/) の整形には依存せず、
原本の jsonl から直接抜く。

掟:
  - 決定論的: 同じ入力なら必ず同じ出力。生成日時などの揺れる値は書かない。
  - 冪等: 内容が変わらなければファイルに触れない (mtime も動かさない)。
  - 原文ママ: 発話は加工しない。

使い方:
    kotonoha.py                 # 全部を抜く
    kotonoha.py --dry-run       # 書かずに結果だけ
    kotonoha.py --since 2026-08-01
    kotonoha.py --quiet         # 1行だけ（定時便用）
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
from datetime import datetime
from pathlib import Path

from dougu import (
    CLAUDE_PROJECTS,
    CODEX_SESSIONS,
    KYOTEN,
    as_text,
    clip,
    frontmatter,
    hhmm,
    jst,
    read_jsonl,
    slug_from_cwd,
    write_if_changed,
)

# 発話がこれを超えたら省略する。原本は jsonl に残る
TEXT_LIMIT = 200_000

# ---------------------------------------------------------------- 混入の見分け
#
# 実測 (ログ全走査) で分かったこと。「ユーザー行」には本人の発話でないものが
# 大量に混ざる。フラグで落ちるものはフラグで落とし、フラグの無い古いログだけ
# 文面で落とす。文面判定は最後の砦であって、第一の関門ではない。
#
#   isMeta=True              スキル本文の注入・画像プレースホルダ・caveat (計 230)
#   isCompactSummary=True    "This session is being continued from…" (計 6)
#   origin.kind=task-notification / promptSource=system
#                            サブエージェント完了通知 (計 170)
#   isSidechain=True         サブエージェント側の会話
#
# 残るのは promptSource=typed / queued の本人発話 (計 442) と、
# フラグを持たない古い版の行。後者は下の前置きで落とす。

MACHINE_PREFIXES = (
    "<task-notification>",
    "<local-command-caveat>",
    "<local-command-stdout>",
    "<system-reminder>",
    "[Request interrupted",
    "[Image:",
    "Caveat: The messages below",
    "This session is being continued from",
    "Base directory for this skill:",
    # Codex: 承認判定用に Codex 自身が投げる内部プロンプト
    "The following is the Codex agent history",
    # Codex: クラッシュ通知から起動される diagnose-crash スキルの定型文
    "A process crashed on this Omarchy machine",
)

# <command-name>/clear</command-name> のようなスラッシュコマンド呼び出し。
# コマンド名だけのもの (/clear /compact /model) は道具の操作であって発話ではない。
# ただし <command-args> に中身があるとき、それは本人が打った言葉なので拾う。
RE_COMMAND_NAME = re.compile(r"<command-name>([^<]*)</command-name>")
RE_COMMAND_ARGS = re.compile(r"<command-args>(.*?)</command-args>", re.S)


def is_machine(text: str) -> bool:
    return text.startswith(MACHINE_PREFIXES)


def unwrap_command(text: str) -> tuple[str, str] | None:
    """スラッシュコマンド行なら (コマンド名, 本人が打った引数) を返す。

    引数が空なら None。コマンド行でなければ ("", text) ではなく False 相当の
    扱いをしたいので、呼び出し側で「コマンド行かどうか」を先に判定する。
    """
    name = RE_COMMAND_NAME.search(text)
    args = RE_COMMAND_ARGS.search(text)
    body = args.group(1).strip() if args else ""
    if not body:
        return None
    return (name.group(1).strip() if name else ""), body


# ---------------------------------------------------------------- 抜き出し

class Utterance:
    __slots__ = ("dt", "project", "source", "command", "text", "key")

    def __init__(self, dt, project, source, command, text, key):
        self.dt = dt
        self.project = project
        self.source = source
        self.command = command
        self.text = text
        self.key = key

    def sort_key(self):
        return (self.dt, self.project, self.source, self.command, self.text)


def digest(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8", "replace")).hexdigest()[:12]


def from_claude(path: Path):
    """Claude Code の jsonl から本人の発話だけ拾う。"""
    for row in read_jsonl(path):
        if row.get("type") != "user":
            continue
        if row.get("isSidechain") or row.get("isMeta") or row.get("isCompactSummary"):
            continue
        if (row.get("origin") or {}).get("kind") == "task-notification":
            continue
        if row.get("promptSource") == "system":
            continue

        content = (row.get("message") or {}).get("content")
        # tool_result はユーザー行として流れてくる。as_text は text ブロックだけ拾う
        text = as_text(content).strip()
        if not text or is_machine(text):
            continue

        command = ""
        if "<command-name>" in text[:400]:
            unwrapped = unwrap_command(text)
            if unwrapped is None:      # /clear /compact など、引数なしの道具操作
                continue
            command, text = unwrapped
            if is_machine(text):
                continue

        dt = jst(row.get("timestamp"))
        if not dt:
            continue
        project = slug_from_cwd(row.get("cwd"))
        key = row.get("uuid") or f"{dt.isoformat()}:{project}:{digest(text)}"
        yield Utterance(dt, project, "claude-code", command, text, key)


def from_codex(path: Path):
    """Codex の jsonl から本人の発話だけ拾う。

    2系統ある。item.type == "UserMessage" (content はブロック配列) と、
    payload.type == "user_message" (本文は message)。後者は実測すべて
    Codex 内部の承認判定プロンプトだったが、系統ごと落とさず文面で落とす。
    """
    cwd = ""
    for row in read_jsonl(path):
        payload = row.get("payload") or {}
        if row.get("type") == "session_meta":
            cwd = payload.get("cwd") or cwd
            continue
        if row.get("type") != "event_msg":
            continue

        item = payload.get("item")
        if isinstance(item, dict) and item.get("type") == "UserMessage":
            text = as_text(item.get("content") or item.get("text")).strip()
        elif payload.get("type") == "user_message":
            text = as_text(payload.get("message") or payload.get("text")).strip()
        else:
            continue

        if not text or is_machine(text):
            continue

        dt = jst(row.get("timestamp"))
        if not dt:
            continue
        project = slug_from_cwd(cwd)
        yield Utterance(dt, project, "codex", "",
                        text, f"{dt.isoformat()}:{project}:{digest(text)}")


# ---------------------------------------------------------------- 束ねる

def render_day(date: str, items: list[Utterance]) -> str:
    projects, sources = [], []
    body = []
    for u in items:
        if u.project not in projects:
            projects.append(u.project)
        if u.source not in sources:
            sources.append(u.source)
        label = f"{u.source} · {u.command}" if u.command else u.source
        body.append(f"## {hhmm(u.dt)} {u.project}（{label}）\n\n{clip(u.text, TEXT_LIMIT)}")

    head = frontmatter({
        "room": "kotonoha",
        "date": date,
        "utterances": len(items),
        "projects": ", ".join(sorted(projects)),
        "sources": ", ".join(sorted(sources)),
    })
    return head + f"\n\n# {date} ことのは\n\n" + "\n\n".join(body) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description="ことのは — 自分の発言だけを抜き出す")
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

    jobs: list[tuple[Path, object]] = []
    if CLAUDE_PROJECTS.is_dir():
        jobs += [(p, from_claude) for p in sorted(CLAUDE_PROJECTS.rglob("*.jsonl"))]
    if CODEX_SESSIONS.is_dir():
        jobs += [(p, from_codex) for p in sorted(CODEX_SESSIONS.rglob("*.jsonl"))]

    seen: set[str] = set()
    days: dict[str, list[Utterance]] = {}
    failed = 0
    for src, pull in jobs:
        try:
            found = list(pull(src))
        except Exception as exc:  # 1ファイルの失敗で全体を止めない
            failed += 1
            print(f"  ✗ {src.name}: {exc}", file=sys.stderr)
            continue
        for u in found:
            # --resume で同じ発話が別ファイルに写ることがある。1回だけ数える
            if u.key in seen:
                continue
            seen.add(u.key)
            date = u.dt.strftime("%Y-%m-%d")
            if since and u.dt.date() < since:
                continue
            days.setdefault(date, []).append(u)

    stats = {"new": 0, "updated": 0, "same": 0}
    total = 0
    for date, items in sorted(days.items()):
        items.sort(key=Utterance.sort_key)
        out = KYOTEN / "kotonoha" / date[:7] / f"{date}.md"
        stats[write_if_changed(out, render_day(date, items), args.dry_run)] += 1
        total += len(items)

    n_days = stats["new"] + stats["updated"] + stats["same"]
    if args.quiet:
        print(f"kotonoha: {n_days}日 (new {stats['new']} / upd {stats['updated']} "
              f"/ same {stats['same']}) 発言 {total:,}")
    else:
        if args.dry_run:
            print("（書かずに確認）")
        print(f"  ことのは     : {n_days:,} 日ぶん")
        print(f"    あたらしい : {stats['new']:,}")
        print(f"    かきかえ   : {stats['updated']:,}")
        print(f"    かわらず   : {stats['same']:,}")
        if failed:
            print(f"    しっぱい   : {failed:,}")
        print(f"  はつげん     : {total:,}")
        print(f"  ばしょ : {KYOTEN / 'kotonoha'}")

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
