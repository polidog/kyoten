#!/usr/bin/env python3
"""yorunotobari — よるのとばり（定時便）

盗賊が夜のうちに拾って回る。utsushi・kotonoha・sotonokoe を順に流し、
ルーラを刻み直して、拠点をきょうかい（git commit）する。
systemd user timer から呼ばれる。

掟:
  - **1つが失敗しても次へ進む。** 取りに行く先が落ちている日でも、
    手元のログからの写しは進められる。全部やってから、失敗があれば
    非ゼロで終わる（systemd の failed として残す）。
  - **変化が無ければコミットしない。** 何も起きなかった日に空の
    きょうかいを積まない。
  - 拠点の中身は出力しない。journald に会話原文が漏れる。

使い方:
    yorunotobari.py             # 全部流す
    yorunotobari.py --dry-run   # 書かずに、コミットもせずに流す
    yorunotobari.py --no-commit # 集めるけどきょうかいはしない
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

from dougu import KYOTEN

BIN = Path(__file__).resolve().parent

# 1本あたりの上限。sotonokoe が SNS の全履歴を辿って実測 2 分弱なので、
# その 5 倍を見ておく。ここで切れるのは「相手が応答を止めた」ときだけ。
STEP_TIMEOUT = 600

# 拠点の部屋と、きょうかいのメッセージに出す呼び名。
ROOMS = [
    ("bouken", "ぼうけんのしょ"),
    ("kotonoha", "ことのは"),
    ("soto", "そとのこえ"),
    ("teato", "てのあと"),
    ("fukuro", "ふくろ"),
]


def run(name: str, args: list[str]) -> tuple[bool, str]:
    """道具を1本流す。戻り値は (成功したか, 1行の報告)。

    落ちても例外にしない —— 呼び出し側が次の道具へ進めるようにする。
    """
    try:
        done = subprocess.run(
            [sys.executable, str(BIN / f"{name}.py"), *args],
            capture_output=True,
            text=True,
            timeout=STEP_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        return False, f"{name}: 時間切れ（{STEP_TIMEOUT}秒）"
    except OSError as exc:
        return False, f"{name}: 起動できない（{exc}）"

    out = (done.stdout or "").strip().splitlines()
    err = (done.stderr or "").strip().splitlines()

    # 報告は stdout から拾うのが基本。ただし **ルーラだけは stderr** に出す
    # —— 検索結果を `ruula.py 語 | grep …` と流したときに、刻み直しの行が
    # 混ざらないようにしてあるため。名前で分岐せず、stdout が空なら stderr、
    # という順で見る。
    if out:
        report = out[-1]
    elif err:
        report = err[-1]
    else:
        report = f"{name}: 何も言わずに終わった"

    # sotonokoe は「1件取れなかった」でも非ゼロを返す。全部が駄目だったのか
    # 一部なのかは道具自身の1行が語っているので、しくじりの中身だけ足す。
    if done.returncode != 0 and err and err[-1] != report:
        report += f" ／ {err[-1]}"

    return done.returncode == 0, report


def git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(KYOTEN), *args],
        capture_output=True, text=True, timeout=120,
    )


def counted() -> dict[str, int]:
    """部屋ごとの、きょうかい待ちファイル数。

    `git status --porcelain` は未追跡のディレクトリを1行にまとめるので、
    `--untracked-files=all` でファイル単位まで開かせる。まとめられたまま
    数えると「そとのこえ 1」のような嘘になる。
    """
    done = git("status", "--porcelain", "--untracked-files=all")
    if done.returncode != 0:
        return {}

    counts: dict[str, int] = {}
    for line in done.stdout.splitlines():
        path = line[3:].strip().strip('"')
        for room, _ in ROOMS:
            if path.startswith(f"{room}/"):
                counts[room] = counts.get(room, 0) + 1
                break
    return counts


def kyoukai(dry_run: bool) -> tuple[bool, str]:
    """拠点をきょうかいする（git commit）。"""
    if not (KYOTEN / ".git").exists():
        return True, "きょうかい: 拠点は git ではないので何もしない"

    counts = counted()
    if not counts:
        return True, "きょうかい: 変化なし"

    parts = [f"{label} {counts[room]}" for room, label in ROOMS if room in counts]
    summary = "・".join(parts)

    if dry_run:
        return True, f"きょうかい: {summary}（書かずに確認）"

    add = git("add", "-A")
    if add.returncode != 0:
        return False, f"きょうかい: add に失敗（{add.stderr.strip().splitlines()[-1:]}）"

    commit = git("commit", "-m", f"きょうかい: {summary}")
    if commit.returncode != 0:
        tail = commit.stdout.strip().splitlines()[-1:] or commit.stderr.strip().splitlines()[-1:]
        return False, f"きょうかい: commit に失敗（{tail}）"

    return True, f"きょうかい: {summary}"


def main() -> int:
    ap = argparse.ArgumentParser(description="よるのとばり — 定時便")
    ap.add_argument("--dry-run", action="store_true", help="書かずに流す")
    ap.add_argument("--no-commit", action="store_true", help="きょうかいはしない")
    args = ap.parse_args()

    common = ["--quiet"] + (["--dry-run"] if args.dry_run else [])

    # 順番に意味がある。ふくろは拠点に書かれたもの（ぼうけんのしょ・
    # ことのは・てのあと・そとのこえ）を素材に畳むので、必ず最後。
    steps: list[tuple[str, list[str]]] = [
        ("utsushi", common),
        ("kotonoha", common),
        ("sotonokoe", common),
        ("teato", common),
        ("fukuro", common),
    ]
    # ルーラは素材が新しければ検索時に自分で刻み直すが、そのぶん最初の
    # 1回を人が待つことになる。夜のうちに刻んでおく。--dry-run のときは
    # 素材が増えていないので触らない。
    if not args.dry_run:
        steps.append(("ruula", ["--rebuild", "--quiet"]))

    failed: list[str] = []
    for name, argv in steps:
        ok, report = run(name, argv)
        print(report, flush=True)
        if not ok:
            failed.append(name)

    if not args.no_commit:
        ok, report = kyoukai(args.dry_run)
        print(report, flush=True)
        if not ok:
            failed.append("きょうかい")

    if failed:
        print(f"しくじり: {'・'.join(failed)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
