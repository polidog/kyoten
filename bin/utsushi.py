#!/usr/bin/env python3
"""utsushi — ぼうけんのしょの書き写し

Claude Code と Codex の会話ログ (jsonl) を Markdown に決定論変換する。

掟:
  - 決定論的: 同じ入力なら必ず同じ出力。生成日時などの揺れる値は書かない。
  - 冪等: 内容が変わらなければファイルに触れない (mtime を動かさない)。
  - 原文ママ: 発話は加工しない。長大なツール出力だけ末尾を省略し、その旨を明記する。
    原本の jsonl は cleanupPeriodDays=3650 で手元に残るので、省略は復元可能。

使い方:
    utsushi.py              # 全部を写す
    utsushi.py --dry-run    # 何が書かれるかだけ見る
    utsushi.py --since 2026-08-01
"""

from __future__ import annotations

import argparse
import json
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
    fence,
    frontmatter,
    hhmm,
    jst,
    read_jsonl,
    safe_path,
    slug_from_cwd,
    unescape_json,
    write_if_changed,
)

# ツール出力がこれを超えたら末尾を省略する (原本は jsonl に残る)
TOOL_OUTPUT_LIMIT = 4000
# 1メッセージのテキストがこれを超えたら省略する。発話は原則ここに達しない
TEXT_LIMIT = 200_000


# ---------------------------------------------------------------- claude code

def render_claude(path: Path) -> tuple[str, dict] | None:
    rows = list(read_jsonl(path))
    if not rows:
        return None

    session_id = ""
    cwd = ""
    branch = ""
    version = ""
    models: list[str] = []
    times: list[datetime] = []
    body: list[str] = []
    n_user = n_asst = 0

    for row in rows:
        rtype = row.get("type")
        session_id = session_id or row.get("sessionId") or ""
        cwd = cwd or row.get("cwd") or ""
        branch = branch or row.get("gitBranch") or ""
        version = version or row.get("version") or ""
        dt = jst(row.get("timestamp"))
        if dt:
            times.append(dt)

        if rtype == "user":
            if row.get("isMeta") or row.get("isSidechain"):
                continue
            msg = row.get("message") or {}
            content = msg.get("content")

            # tool_result はユーザー行として流れてくる。発話と区別する
            tool_results = []
            if isinstance(content, list):
                tool_results = [b for b in content if isinstance(b, dict)
                                and b.get("type") == "tool_result"]
            text = as_text(content).strip()

            if text:
                n_user += 1
                body.append(f"## {hhmm(dt)} polidog\n\n{clip(text, TEXT_LIMIT)}")
            for tr in tool_results:
                out = unescape_json(as_text(tr.get("content")).strip())
                if not out:
                    continue
                flag = " ⚠️" if tr.get("is_error") else ""
                body.append(
                    f"<details><summary>↩︎ ツール結果{flag}</summary>\n\n"
                    f"{fence(clip(out, TOOL_OUTPUT_LIMIT))}\n\n</details>"
                )

        elif rtype == "assistant":
            msg = row.get("message") or {}
            model = msg.get("model") or ""
            if model and model not in models:
                models.append(model)
            blocks = msg.get("content") or []
            if not isinstance(blocks, list):
                blocks = []
            chunk: list[str] = []
            for blk in blocks:
                if not isinstance(blk, dict):
                    continue
                btype = blk.get("type")
                if btype == "text" and blk.get("text", "").strip():
                    chunk.append(clip(blk["text"].strip(), TEXT_LIMIT))
                elif btype == "thinking" and blk.get("thinking", "").strip():
                    chunk.append(
                        "<details><summary>💭 思考</summary>\n\n"
                        + clip(blk["thinking"].strip(), TEXT_LIMIT)
                        + "\n\n</details>"
                    )
                elif btype == "tool_use":
                    name = blk.get("name", "?")
                    args = blk.get("input") or {}
                    if isinstance(args, dict) and set(args) & {"command", "file_path", "pattern", "path"}:
                        head = args.get("command") or args.get("file_path") or args.get("pattern") or args.get("path")
                        summary = f"🔧 **{name}** — `{str(head)[:160]}`"
                    else:
                        summary = f"🔧 **{name}**"
                    dumped = json.dumps(args, ensure_ascii=False, indent=2, sort_keys=True)
                    chunk.append(
                        f"{summary}\n\n<details><summary>引数</summary>\n\n"
                        f"{fence(clip(dumped, TOOL_OUTPUT_LIMIT), 'json')}\n\n</details>"
                    )
            if chunk:
                n_asst += 1
                label = f"assistant（{model}）" if model else "assistant"
                body.append(f"## {hhmm(dt)} {label}\n\n" + "\n\n".join(chunk))

        elif rtype == "system" and row.get("subtype") == "compact_boundary":
            body.append("---\n\n> ⚠️ ここで会話が圧縮されています（compact）")

    if not body:
        return None

    started = min(times) if times else None
    ended = max(times) if times else None
    slug = slug_from_cwd(cwd)

    head = frontmatter({
        "source": "claude-code",
        "session": session_id or path.stem,
        "project": slug,
        "cwd": cwd,
        "branch": branch,
        "started": started.isoformat() if started else None,
        "ended": ended.isoformat() if ended else None,
        "models": ", ".join(models),
        "utterances": n_user,
        "replies": n_asst,
        "cli": version,
    })
    title = f"# {started.strftime('%Y-%m-%d') if started else '????-??-??'} {slug}"
    text = head + "\n\n" + title + "\n\n" + "\n\n".join(body) + "\n"

    return text, {
        "slug": slug,
        "date": started.strftime("%Y-%m-%d") if started else "0000-00-00",
        "sid": (session_id or path.stem)[:8],
        "utterances": n_user,
    }


# ---------------------------------------------------------------- codex

def codex_user_text(payload: dict) -> str:
    """Codex のユーザー発話。UserMessage.content と user_message.message の2系統。"""
    item = payload.get("item")
    if isinstance(item, dict) and item.get("type") == "UserMessage":
        return as_text(item.get("content") or item.get("text")).strip()
    if payload.get("type") == "user_message":
        return as_text(payload.get("message") or payload.get("text")).strip()
    return ""


def render_codex(path: Path) -> tuple[str, dict] | None:
    rows = list(read_jsonl(path))
    if not rows:
        return None

    session_id = ""
    cwd = ""
    model = ""
    cli = ""
    times: list[datetime] = []
    body: list[str] = []
    n_user = n_asst = 0

    for row in rows:
        rtype = row.get("type")
        payload = row.get("payload") or {}
        dt = jst(row.get("timestamp"))
        if dt:
            times.append(dt)

        if rtype == "session_meta":
            session_id = payload.get("session_id") or payload.get("id") or ""
            cwd = payload.get("cwd") or ""
            cli = payload.get("cli_version") or ""
            continue

        if rtype == "turn_context":
            model = model or payload.get("model") or ""
            continue

        if rtype != "event_msg":
            continue

        text = codex_user_text(payload)
        if text:
            n_user += 1
            body.append(f"## {hhmm(dt)} polidog\n\n{clip(text, TEXT_LIMIT)}")
            continue

        item = payload.get("item")
        if not isinstance(item, dict):
            continue
        itype = item.get("type")

        if itype == "AgentMessage" or payload.get("type") == "agent_message":
            msg = as_text(item.get("content") or item.get("text")).strip()
            if msg:
                n_asst += 1
                body.append(f"## {hhmm(dt)} codex\n\n{clip(msg, TEXT_LIMIT)}")
        elif itype == "Reasoning":
            msg = as_text(item.get("content") or item.get("text")).strip()
            if msg:
                body.append(
                    "<details><summary>💭 思考</summary>\n\n"
                    + clip(msg, TEXT_LIMIT) + "\n\n</details>"
                )
        elif itype == "CommandExecution":
            cmd = str(item.get("command") or "").strip()
            out = unescape_json(str(item.get("aggregated_output") or item.get("output") or "").strip())
            chunk = [f"🔧 **CommandExecution** — `{cmd[:160]}`"]
            if out:
                chunk.append(
                    "<details><summary>↩︎ 出力</summary>\n\n"
                    + fence(clip(out, TOOL_OUTPUT_LIMIT)) + "\n\n</details>"
                )
            body.append("\n\n".join(chunk))
        elif itype == "McpToolCall":
            name = f"{item.get('server', '?')}.{item.get('tool', '?')}"
            body.append(f"🔧 **MCP** — `{name}`")
        elif itype == "FileChange":
            changes = item.get("changes") or []
            names = ", ".join(str(c.get("path", "?")) for c in changes if isinstance(c, dict))
            body.append(f"✏️ **FileChange** — {names[:300]}")

    if not body:
        return None

    started = min(times) if times else None
    ended = max(times) if times else None
    slug = slug_from_cwd(cwd)

    head = frontmatter({
        "source": "codex",
        "session": session_id or path.stem,
        "project": slug,
        "cwd": cwd,
        "started": started.isoformat() if started else None,
        "ended": ended.isoformat() if ended else None,
        "models": model,
        "utterances": n_user,
        "replies": n_asst,
        "cli": cli,
    })
    title = f"# {started.strftime('%Y-%m-%d') if started else '????-??-??'} {slug}"
    text = head + "\n\n" + title + "\n\n" + "\n\n".join(body) + "\n"

    return text, {
        "slug": slug,
        "date": started.strftime("%Y-%m-%d") if started else "0000-00-00",
        "sid": (session_id or path.stem)[:8],
        "utterances": n_user,
    }


# ---------------------------------------------------------------- main

def main() -> int:
    ap = argparse.ArgumentParser(description="ぼうけんのしょの書き写し")
    ap.add_argument("--dry-run", action="store_true", help="書かずに結果だけ出す")
    ap.add_argument("--since", metavar="YYYY-MM-DD", help="この日以降のセッションだけ")
    ap.add_argument("--quiet", action="store_true", help="1行だけ報告する")
    args = ap.parse_args()

    since = None
    if args.since:
        try:
            since = datetime.strptime(args.since, "%Y-%m-%d").date()
        except ValueError:
            print(f"--since の日付が読めません: {args.since}", file=sys.stderr)
            return 2

    jobs: list[tuple[Path, str]] = []
    if CLAUDE_PROJECTS.is_dir():
        jobs += [(p, "claude") for p in sorted(CLAUDE_PROJECTS.rglob("*.jsonl"))]
    if CODEX_SESSIONS.is_dir():
        jobs += [(p, "codex") for p in sorted(CODEX_SESSIONS.rglob("*.jsonl"))]

    stats = {"new": 0, "updated": 0, "same": 0, "skipped": 0, "failed": 0, "collided": 0}
    taken: dict[Path, Path] = {}
    utterances = 0

    for src, kind in jobs:
        try:
            result = render_claude(src) if kind == "claude" else render_codex(src)
        except Exception as exc:  # 1ファイルの失敗で全体を止めない
            stats["failed"] += 1
            print(f"  ✗ {src.name}: {exc}", file=sys.stderr)
            continue

        if result is None:
            stats["skipped"] += 1
            continue

        text, meta = result
        if since and meta["date"] != "0000-00-00":
            try:
                if datetime.strptime(meta["date"], "%Y-%m-%d").date() < since:
                    stats["skipped"] += 1
                    continue
            except ValueError:
                pass

        # 出力名は元 jsonl と1:1にする。session_id の先頭8文字は一意ではなく
        # (52de10eb で始まる別セッションが実在した)、サブエージェントは親と
        # 同じ sessionId を持つので、どちらも元ファイル名を鍵にするしかない。
        is_sub = "/subagents/" in str(src)
        sub = "/subagents" if is_sub else ""
        key = re.sub(r"[^\w.\-]", "_", src.stem)
        if key.startswith("rollout-"):          # Codex は日時が名前に入っていて冗長
            key = key[len("rollout-"):]
        out = (KYOTEN / "bouken" / kind / safe_path(meta["slug"] + sub)
               / f"{meta['date']}_{key}.md")

        # それでも衝突するなら元ファイル名を足す。入力はソート済みなので結果は安定する
        if out in taken and taken[out] != src:
            out = out.with_name(f"{meta['date']}_{key}_{re.sub(r'[^\w.\-]', '_', src.stem)}.md")
            stats["collided"] += 1
        taken[out] = src

        state = write_if_changed(out, text, args.dry_run)
        stats[state] += 1
        utterances += meta["utterances"]

    total = stats["new"] + stats["updated"] + stats["same"]
    if args.quiet:
        print(f"utsushi: {total}さつ (new {stats['new']} / upd {stats['updated']} "
              f"/ same {stats['same']}) 発言 {utterances:,}")
    else:
        print(f"{'（書かずに確認）' if args.dry_run else ''}")
        print(f"  ぼうけんのしょ : {total:,} さつ")
        print(f"    あたらしい   : {stats['new']:,}")
        print(f"    かきかえ     : {stats['updated']:,}")
        print(f"    かわらず     : {stats['same']:,}")
        print(f"    なかみ なし  : {stats['skipped']:,}")
        if stats["collided"]:
            print(f"    なまえ衝突   : {stats['collided']:,}")
        if stats["failed"]:
            print(f"    しっぱい     : {stats['failed']:,}")
        print(f"  じぶんの はつげん : {utterances:,}")
        print(f"  ばしょ : {KYOTEN / 'bouken'}")

    return 1 if stats["failed"] else 0


if __name__ == "__main__":
    sys.exit(main())
