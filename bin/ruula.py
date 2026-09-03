#!/usr/bin/env python3
"""ruula — ルーラ（拠点の全文検索）

「行ったことのある場所にしか飛べない」。写しを取った場所だけが検索できる。

刻む対象:
    bouken/    ぼうけんのしょ（会話原文の写し）
    kotonoha/  ことのは（自分の発言）
    ~/Documents/Obsidian/reading-notes/   読み専用の水源

SQLite FTS5 の trigram トークナイザを使う。日本語を分かち書きせずに
そのまま引けるかわり、2文字以下の語は索引に入らない（その場合は素の
部分一致に落ちる）。

使い方:
    ruula.py "検索語"
    ruula.py "検索語" --project polidog/kyoten
    ruula.py "検索語" --room kotonoha --since 2026-09-01
    ruula.py --rebuild          # 刻み直すだけ
    ruula.py --stats            # 索引の中身を数える
    ruula.py --rebuild --quiet  # 刻み直して1行だけ（定時便用）
"""

from __future__ import annotations

import argparse
import os
import re
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

from dougu import KYOTEN, read_text, split_frontmatter

DB = KYOTEN / ".ruula.db"
READING_NOTES = Path(os.environ.get("KYOTEN_READING",
                                    Path.home() / "Documents/Obsidian/reading-notes"))

# 索引の形を変えたらここを上げる。合わなければ黙って刻み直す
SCHEMA = 1

# trigram は3文字未満を索引に入れられない
TRIGRAM_MIN = 3

RE_HEADING = re.compile(r"^(#{1,6}) +(.*)$")
RE_DATE = re.compile(r"(\d{4}-\d{2}-\d{2})")
# ことのはの見出し: "09:12:03 polidog/kyoten（claude-code · /omarchy）"
RE_KOTONOHA_HEAD = re.compile(r"^\d\d:\d\d:\d\d +(.+?)（")


def rooms() -> list[tuple[Path, str]]:
    return [
        (KYOTEN / "bouken", "bouken"),
        (KYOTEN / "kotonoha", "kotonoha"),
        (KYOTEN / "soto", "soto"),
        (READING_NOTES, "reading-notes"),
    ]


def display_path(path: Path, root: Path, room: str) -> str:
    rel = path.relative_to(root)
    return f"{room}/{rel}" if root.is_relative_to(KYOTEN) else f"~/{path.relative_to(Path.home())}"


# ---------------------------------------------------------------- 刻む

def chunks(text: str):
    """見出しで切る。戻り値は (見出し, 開始行, 本文)。行番号は1始まり。"""
    _, body, offset = split_frontmatter(text)
    lines = body.split("\n")
    head, start, buf = "", offset, []

    def flush():
        if any(s.strip() for s in buf):
            return (head, start, "\n".join(buf).strip("\n"))
        return None

    for i, line in enumerate(lines):
        m = RE_HEADING.match(line)
        if not m:
            buf.append(line)
            continue
        got = flush()
        if got:
            yield got
        head, start, buf = m.group(2).strip(), offset + i, [line]
    got = flush()
    if got:
        yield got


def file_meta(path: Path, room: str, fields: dict) -> dict:
    date = fields.get("date") or (fields.get("started") or "")[:10]
    if not RE_DATE.fullmatch(date or ""):
        m = RE_DATE.search(path.name) or RE_DATE.search(str(path))
        date = m.group(1) if m else ""
    return {
        "date": date,
        "project": fields.get("project") or "",
        "source": fields.get("source") or room,
    }


def build(verbose: bool = True) -> int:
    tmp = DB.with_suffix(".db.tmp")
    for leftover in tmp.parent.glob(tmp.name + "*"):
        leftover.unlink()
    tmp.parent.mkdir(parents=True, exist_ok=True)

    con = sqlite3.connect(tmp)
    con.executescript("""
        PRAGMA journal_mode = OFF;
        PRAGMA synchronous = OFF;
        CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);
        CREATE TABLE chunk(
            id      INTEGER PRIMARY KEY,
            room    TEXT NOT NULL,
            path    TEXT NOT NULL,
            project TEXT NOT NULL,
            date    TEXT NOT NULL,
            source  TEXT NOT NULL,
            heading TEXT NOT NULL,
            line    INTEGER NOT NULL,
            body    TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE chunk_fts USING fts5(
            body, heading,
            content='chunk', content_rowid='id', tokenize='trigram'
        );
    """)

    n_files = 0
    rows = []
    for root, room in rooms():
        if not root.is_dir():
            continue
        for path in sorted(root.rglob("*.md")):
            try:
                text = read_text(path)
            except OSError:
                continue
            n_files += 1
            fields, _, _ = split_frontmatter(text)
            meta = file_meta(path, room, fields)
            shown = display_path(path, root, room)
            # ことのはは1日1ファイルで、プロジェクトは見出しにしか書いていない。
            # 発話本文に見出し記号が混ざったかたまりには直前の値を引き継ぐ
            carried = meta["project"]
            for head, line, body in chunks(text):
                project = meta["project"]
                if room == "kotonoha":
                    m = RE_KOTONOHA_HEAD.match(head)
                    if m:
                        carried = m.group(1)
                    project = carried
                rows.append((room, shown, project, meta["date"],
                             meta["source"], head, line, body))

    con.executemany(
        "INSERT INTO chunk(room,path,project,date,source,heading,line,body)"
        " VALUES(?,?,?,?,?,?,?,?)", rows)
    con.execute("CREATE INDEX chunk_date ON chunk(date)")
    con.execute("CREATE INDEX chunk_project ON chunk(project)")
    con.execute("INSERT INTO chunk_fts(chunk_fts) VALUES('rebuild')")
    con.executemany("INSERT INTO meta(k,v) VALUES(?,?)",
                    [("schema", str(SCHEMA)), ("files", str(n_files)),
                     ("chunks", str(len(rows)))])
    con.commit()
    con.close()

    os.replace(tmp, DB)
    if verbose:
        print(f"ルーラ: {n_files:,} ファイル / {len(rows):,} かたまりを刻んだ "
              f"（{DB.stat().st_size / 1e6:.1f} MB）", file=sys.stderr)
    return len(rows)


def stale() -> bool:
    """索引より新しい素材があるか。無ければ刻み直さない。"""
    if not DB.exists():
        return True
    db_mtime = DB.stat().st_mtime
    for root, _ in rooms():
        if not root.is_dir():
            continue
        for path in root.rglob("*.md"):
            if path.stat().st_mtime > db_mtime:
                return True
    return False


def connect() -> sqlite3.Connection:
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    return con


# ---------------------------------------------------------------- 引く

def fts_query(words: list[str]) -> str:
    """語を FTS5 のフレーズ検索に組む。空白区切りは AND。"""
    return " AND ".join('"' + w.replace('"', '""') + '"' for w in words)


def search(con, words, room, project, since, until, limit):
    where, params = [], []
    if room:
        where.append("c.room = ?")
        params.append(room)
    if project:
        where.append("c.project LIKE ?")
        params.append(f"%{project}%")
    if since:
        where.append("c.date >= ?")
        params.append(since)
    if until:
        where.append("c.date <= ?")
        params.append(until)

    short = [w for w in words if len(w) < TRIGRAM_MIN]
    if short:
        # trigram は3文字未満を索引に持たない。素の部分一致に落ちる
        cond = " AND ".join(["instr(c.body, ?) > 0"] * len(words))
        sql = ("SELECT c.* FROM chunk c "
               f"WHERE {cond}" + ("" if not where else " AND " + " AND ".join(where)) +
               " ORDER BY c.date DESC, c.id DESC LIMIT ?")
        return con.execute(sql, [*words, *params, limit]).fetchall(), True

    # 抜粋は snippet() を使わず自前で切る。trigram だと 1トークン=3文字で
    # 窓が狭すぎるうえ、部分一致に落ちたときと見た目が揃わない
    sql = ("SELECT c.*, bm25(chunk_fts, 1.0, 2.0) AS score"
           " FROM chunk_fts JOIN chunk c ON c.id = chunk_fts.rowid"
           " WHERE chunk_fts MATCH ?"
           + ("" if not where else " AND " + " AND ".join(where)) +
           " ORDER BY score LIMIT ?")
    return con.execute(sql, [fts_query(words), *params, limit]).fetchall(), False


def paint(s: str, code: str, tty: bool) -> str:
    return f"\x1b[{code}m{s}\x1b[0m" if tty else s


def make_snippet(body: str, words: list[str], tty: bool, width: int = 170) -> str:
    """部分一致で引いたときの抜粋。一致箇所のまわりを切り出して光らせる。"""
    flat = " ".join(body.split())
    low = flat.lower()
    hits = [i for i in (low.find(w.lower()) for w in words) if i >= 0]
    if not hits:
        return flat[:width]
    start = max(0, min(hits) - width // 3)
    end = min(len(flat), start + width)
    out = flat[start:end]
    if tty:
        # 置換で入れた制御文字を再び拾わないよう、1回のパスで塗る
        pat = re.compile("|".join(re.escape(w) for w in
                                  sorted(set(words), key=len, reverse=True)), re.I)
        out = pat.sub(lambda m: f"\x1b[1;33m{m.group(0)}\x1b[0m", out)
    return ("… " if start else "") + out + (" …" if end < len(flat) else "")


def show(rows, words: list[str], tty: bool) -> None:
    for i, r in enumerate(rows, 1):
        head = r["heading"] or "（見出しなし）"
        stamp = " · ".join(x for x in (r["date"], r["project"], r["room"]) if x)
        print(f"{paint(f'{i:>3}.', '1', tty)} {paint(stamp, '36', tty)}")
        print(f"     {paint(head[:110], '1', tty)}")
        print(f"     {make_snippet(r['body'], words, tty)}")
        where = "{}:{}".format(r["path"], r["line"])
        print(f"     {paint(where, '2', tty)}")
        print()


def main() -> int:
    ap = argparse.ArgumentParser(description="ルーラ — 拠点の全文検索")
    ap.add_argument("words", nargs="*", help="検索語（複数なら AND）")
    ap.add_argument("--rebuild", action="store_true", help="索引を刻み直す")
    ap.add_argument("--no-rebuild", action="store_true", help="古くても刻み直さない")
    ap.add_argument("--stats", action="store_true", help="索引の中身を数える")
    ap.add_argument("--quiet", action="store_true",
                    help="刻み直した1行だけ報告する（定時便用）")
    ap.add_argument("--room", choices=["bouken", "kotonoha", "soto", "reading-notes"],
                    help="部屋で絞る")
    ap.add_argument("--project", help="プロジェクト名で絞る（部分一致）")
    ap.add_argument("--since", metavar="YYYY-MM-DD")
    ap.add_argument("--until", metavar="YYYY-MM-DD")
    ap.add_argument("-n", "--limit", type=int, default=20, help="件数（既定 20）")
    args = ap.parse_args()

    for label, val in (("--since", args.since), ("--until", args.until)):
        if val:
            try:
                datetime.strptime(val, "%Y-%m-%d")
            except ValueError:
                print(f"{label} の日付が読めません: {val}", file=sys.stderr)
                return 2

    if args.rebuild or (not args.no_rebuild and stale()):
        build()

    if not DB.exists():
        print("索引がありません。ruula.py --rebuild を先に。", file=sys.stderr)
        return 1

    if args.stats or not args.words:
        # --quiet は定時便のため。刻み直した1行だけ残して、内訳は出さない。
        if args.quiet and not args.stats:
            return 0

        con = connect()
        meta = dict(con.execute("SELECT k, v FROM meta").fetchall())
        print(f"  ファイル : {int(meta.get('files', 0)):,}")
        print(f"  かたまり : {int(meta.get('chunks', 0)):,}")
        for row in con.execute(
                "SELECT room, COUNT(*) n, MIN(date) a, MAX(date) b"
                " FROM chunk GROUP BY room ORDER BY room"):
            span = f"{row['a']} 〜 {row['b']}" if row["a"] else ""
            print(f"    {row['room']:<14} {row['n']:>7,}  {span}")
        print(f"  索引 : {DB} ({DB.stat().st_size / 1e6:.1f} MB)")
        con.close()
        return 0

    con = connect()
    rows, fallback = search(con, args.words, args.room, args.project,
                            args.since, args.until, args.limit)
    tty = sys.stdout.isatty()
    if not rows:
        print("みつかりませんでした。", file=sys.stderr)
        return 1
    if fallback:
        print(f"（{TRIGRAM_MIN}文字未満の語があるので部分一致で引きました）",
              file=sys.stderr)
    show(rows, args.words, tty)
    print(f"{len(rows)} 件", file=sys.stderr)
    con.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
