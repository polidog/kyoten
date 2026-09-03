#!/usr/bin/env python3
"""dougu — 拠点の道具箱

utsushi / kotonoha / ruula が共通で使う小道具。
ここに置くものは「掟」を守るための部品だけにする。

  - 決定論的: 同じ入力なら必ず同じ出力。生成日時などの揺れる値を書かない。
  - 冪等: 内容が変わらなければファイルに触れない (mtime も動かさない)。
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone, timedelta
from pathlib import Path

KYOTEN = Path(os.environ.get("KYOTEN", Path.home() / "Documents/Obsidian/kyoten"))
CLAUDE_PROJECTS = Path.home() / ".claude/projects"
CODEX_SESSIONS = Path.home() / ".codex/sessions"

JST = timezone(timedelta(hours=9))


def jst(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(JST)
    except (ValueError, AttributeError):
        return None


def hhmm(dt: datetime | None) -> str:
    return dt.strftime("%H:%M:%S") if dt else "--:--:--"


def slug_from_cwd(cwd: str | None) -> str:
    """cwd をプロジェクト名にする。ghq 配下ならホスト以降を使う。"""
    if not cwd:
        return "_unknown"
    p = Path(cwd)
    parts = p.parts
    if "ghq" in parts:
        i = parts.index("ghq")
        rest = parts[i + 2:]  # ghq/github.com/ を飛ばす
        if rest:
            return "/".join(rest)
    if str(p) == str(Path.home()):
        return "_home"
    return p.name or "_unknown"


def safe_path(slug: str) -> str:
    """スラッシュはディレクトリとして残し、危険な文字だけ落とす。"""
    parts = [re.sub(r"[^\w.\-]", "_", s) for s in slug.split("/") if s not in ("", ".", "..")]
    return "/".join(parts) or "_unknown"


def fence(body: str, lang: str = "") -> str:
    """本文に ``` が含まれていても壊れないコードフェンスを作る。"""
    longest = max((len(m) for m in re.findall(r"`+", body)), default=0)
    bar = "`" * max(3, longest + 1)
    return f"{bar}{lang}\n{body}\n{bar}"


def unescape_json(text: str) -> str:
    """ツール結果が JSON 文字列なら日本語が読める形に開く。

    MCP の戻り値などは \\uXXXX でエスケープされた JSON がそのまま入っている。
    そのままでは Obsidian で読めず、ルーラ (全文検索) でも日本語が引けないので、
    読める形に整形する。開けなければ原文のまま返す。原本は jsonl にある。
    """
    head = text.lstrip()[:1]
    if head not in ("{", "["):
        return text
    try:
        return json.dumps(json.loads(text), ensure_ascii=False, indent=2)
    except (json.JSONDecodeError, ValueError, RecursionError):
        return text


def clip(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    omitted = len(text) - limit
    return text[:limit] + f"\n… （{omitted:,} 文字省略。原本は jsonl にあります）"


def as_text(content) -> str:
    """content が文字列でも配列でも、テキストを取り出す。"""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        out = []
        for blk in content:
            if isinstance(blk, str):
                out.append(blk)
            elif isinstance(blk, dict):
                if blk.get("type") == "text" and blk.get("text"):
                    out.append(blk["text"])
                elif blk.get("text"):
                    out.append(blk["text"])
        return "\n\n".join(out)
    if isinstance(content, dict):
        return content.get("text", "") or ""
    return str(content)


def write_if_changed(path: Path, body: str, dry_run: bool = False) -> str:
    """内容が同じなら触れない。戻り値は new / updated / same。

    newline="" が要る。会話ログには CR を含むものがあり、既定の
    universal newlines で読むと CRLF が LF に化けて、書いた本文と
    読み返した本文が永久に一致しなくなる (毎回 updated になる)。
    """
    if path.exists():
        try:
            with path.open(encoding="utf-8", newline="") as fh:
                if fh.read() == body:
                    return "same"
        except UnicodeDecodeError:
            pass
        state = "updated"
    else:
        state = "new"
    if not dry_run:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", encoding="utf-8", newline="") as fh:
            fh.write(body)
    return state


def frontmatter(fields: dict) -> str:
    lines = ["---"]
    for k, v in fields.items():
        if v is None or v == "":
            continue
        if isinstance(v, str) and (":" in v or v.startswith("[") or "#" in v):
            v = json.dumps(v, ensure_ascii=False)
        lines.append(f"{k}: {v}")
    lines.append("---")
    return "\n".join(lines)


def split_frontmatter(text: str) -> tuple[dict, str, int]:
    """先頭の frontmatter を切り離す。戻り値は (辞書, 本体, 本体の開始行番号)。

    行番号は 1 始まり。frontmatter が無ければ ({}, text, 1)。
    """
    if not text.startswith("---"):
        return {}, text, 1
    lines = text.split("\n")
    if lines[0].strip() != "---":
        return {}, text, 1
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            fields = {}
            for raw in lines[1:i]:
                if ":" not in raw:
                    continue
                k, _, v = raw.partition(":")
                v = v.strip()
                if v.startswith('"') and v.endswith('"') and len(v) >= 2:
                    try:
                        v = json.loads(v)
                    except json.JSONDecodeError:
                        pass
                fields[k.strip()] = v
            return fields, "\n".join(lines[i + 1:]), i + 2
    return {}, text, 1


def read_jsonl(path: Path):
    with path.open(encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def read_text(path: Path) -> str:
    """CR を LF に化けさせずに読む。冪等性のため read_text() は使わない。"""
    with path.open(encoding="utf-8", errors="replace", newline="") as fh:
        return fh.read()
