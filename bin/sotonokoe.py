#!/usr/bin/env python3
"""sotonokoe — そとのこえ（外に出した言葉を集める）

polidog.jp・Bluesky・Misskey から、自分が外に向けて出した言葉を拠点へ写す。
ぼうけんのしょ (会話) やことのは (自分の発言) が「閉じた場所での言葉」なのに
対して、こちらは公開された言葉。

出力:
    soto/<YYYY-MM>/<DD>-<slug>.md           polidog.jp の記事 1 本
    soto/<YYYY-MM>/bluesky-<YYYY-MM-DD>.md  その日の Bluesky
    soto/<YYYY-MM>/misskey-<YYYY-MM-DD>.md  その日の Misskey

記事が 1 本 1 ファイルで SNS が日ごとなのは、長さが 2 桁違うため。1 投稿
1 ファイルにすると数千の断片ができて、ルーラで引いたときに前後が見えない。

掟:
  - 決定論的: 同じ入力なら必ず同じ出力。取得日時のような揺れる値を書かない。
    **いいね数・リアクション数・リノート数は書かない** —— 過去の投稿でも
    増減するので、書くと毎回全ファイルが書き換わって冪等が壊れる。
  - 冪等: 内容が変わらなければファイルに触れない (mtime も動かさない)。
  - 原文ママ: 本文は加工しない。
  - 取りに行く先が落ちていても止まらない: 取れなかったソースは黙って飛ばし、
    他のソースは続ける。「取れなかった」と「空だった」を混同しないよう、
    失敗したソースのファイルには一切触れない。

使い方:
    sotonokoe.py                    # 全部集める
    sotonokoe.py --dry-run          # 書かずに結果だけ
    sotonokoe.py --since 2026-08-01
    sotonokoe.py --quiet            # 1行だけ（定時便用）
    sotonokoe.py --source bluesky   # ソースを絞る（blog / bluesky / misskey）
    sotonokoe.py --site http://127.0.0.1:8123   # 手元の polidog.jp を見る
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

from dougu import (
    KYOTEN,
    frontmatter,
    hhmm,
    jst,
    read_text,
    safe_path,
    split_frontmatter,
    write_if_changed,
)

SITE = "https://polidog.jp"
BLUESKY_API = "https://public.api.bsky.app/xrpc"
BLUESKY_ACTOR = "polidog.jp"
MISSKEY_API = "https://misskey.io/api"
MISSKEY_USER_ID = "9cw03lelar"

# 1 リクエストで取る件数と、遡る上限。上限は暴走よけで、実際は
# 「もう返ってこない」で止まる。
PAGE = 100
MAX_PAGES = 200

TIMEOUT = 30
UA = "kyoten/sotonokoe (+https://github.com/polidog/kyoten)"

ROOM = KYOTEN / "soto"


# ---------------------------------------------------------------- 取りに行く

class Unreachable(Exception):
    """取りに行けなかった。呼び出し側はそのソースを丸ごと諦める。

    「取れなかった」と「0 件だった」を取り違えると、落ちている日に
    空のファイルを書いて過去を消してしまう。例外で区別する。
    """


def fetch_json(url: str, payload: dict | None = None):
    """JSON を取る。落ちていたら Unreachable。

    途中まで取れたページを混ぜると欠けたまま完成したように見えるので、
    ページングの途中で失敗した場合も呼び出し側で丸ごと捨てる。
    """
    data = None
    headers = {"Accept": "application/json", "User-Agent": UA}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    request = urllib.request.Request(url, data=data, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            body = response.read()
    except (urllib.error.URLError, TimeoutError, OSError, UnicodeError) as exc:
        raise Unreachable(f"{url}: {exc}") from exc

    try:
        return json.loads(body)
    except (json.JSONDecodeError, ValueError) as exc:
        raise Unreachable(f"{url}: JSON として読めない ({exc})") from exc


# ---------------------------------------------------------------- 書き出す

class Writer:
    """書いた結果を数える。dry-run のときは数えるだけ。"""

    def __init__(self, dry_run: bool) -> None:
        self.dry_run = dry_run
        self.stats = {"new": 0, "updated": 0, "same": 0}
        # 1 件だけ取れなかったもの（ソース丸ごと諦めるのとは別）。
        self.failed = 0

    def write(self, path: Path, body: str) -> str:
        state = write_if_changed(path, body, self.dry_run)
        self.stats[state] += 1
        return state

    def skip(self) -> None:
        """取りに行くまでもなく前と同じだったもの。"""
        self.stats["same"] += 1

    @property
    def total(self) -> int:
        return sum(self.stats.values())


def head_fields(path: Path) -> dict:
    """既存ファイルの frontmatter だけ読む。無ければ空。"""
    if not path.exists():
        return {}
    try:
        fields, _, _ = split_frontmatter(read_text(path)[:2000])
    except OSError:
        return {}
    return fields


# ---------------------------------------------------------------- polidog.jp

def blog(writer: Writer, site: str, since: datetime | None) -> int:
    """polidog.jp の記事。索引を 1 本引き、変わったものだけ本文を取りに行く。

    索引には本文が入っていないので、1,300 件ぶんを毎回落とさずに済む。
    版は記事の `updatedAt`。書き出したファイルの frontmatter に控えてあるので、
    突き合わせるのに別の状態ファイルは要らない。

    諦めるのは索引が引けなかったときだけ。個々の記事が落ちても他は書く。
    """
    index = fetch_json(f"{site.rstrip('/')}/archives/")
    posts = index.get("posts") if isinstance(index, dict) else None
    if not isinstance(posts, list):
        raise Unreachable(f"{site}: 索引の形が違う")

    written = 0
    for post in posts:
        if not isinstance(post, dict):
            continue
        published = jst(post.get("publishedAt"))
        if not published or (since and published.date() < since.date()):
            continue

        path = str(post.get("path") or "")
        slug = safe_path(path.rstrip("/").rsplit("/", 1)[-1])
        if not slug:
            continue

        out = ROOM / published.strftime("%Y-%m") / f"{published.strftime('%d')}-{slug}.md"
        updated = str(post.get("updatedAt") or "")
        if updated and head_fields(out).get("updated") == updated:
            writer.skip()
            continue

        # 索引の `url` は本番の絶対 URL。手元の写しを見ているときに使えないので、
        # 取りに行く先は --site と path から組み立てる（url は frontmatter に残す）。
        # 日本語スラッグの記事が 248 本ある。そのまま urllib に渡すと
        # ascii に落とせず落ちるので、セグメントごとにエンコードする
        # （`/` は残す —— スラッシュを含む slug は記事側には無い）。
        url = f"{site.rstrip('/')}{urllib.parse.quote(path.rstrip('/'), safe='/')}/"
        try:
            detail = fetch_json(url)
            if not isinstance(detail, dict) or "markdown" not in detail:
                raise Unreachable(f"{url}: 記事の形が違う")
        except Unreachable as exc:
            # 記事は 1 本ずつ独立しているので、1 本落ちても残りは進める
            # （SNS のページングと違って、欠けても他の記事が壊れない）。
            writer.failed += 1
            print(f"  ✗ blog {path}: {exc}", file=sys.stderr)
            continue

        writer.write(out, render_post(detail, published))
        written += 1

    return written


def render_post(post: dict, published: datetime) -> str:
    tags = [str(t.get("slug") or "") for t in post.get("tags") or [] if isinstance(t, dict)]
    head = frontmatter({
        "room": "soto",
        "source": "polidog.jp",
        "date": published.strftime("%Y-%m-%d"),
        "updated": str(post.get("updatedAt") or ""),
        "url": str(post.get("url") or ""),
        "title": str(post.get("title") or ""),
        "tags": ", ".join(t for t in tags if t),
    })
    body = str(post.get("markdown") or "").strip("\n")
    return f"{head}\n\n# {post.get('title') or ''}\n\n{body}\n"


# ---------------------------------------------------------------- SNS

class Post:
    """SNS の 1 投稿。ソースが違っても同じ形に均してから束ねる。"""

    __slots__ = ("dt", "ident", "text", "note", "links")

    def __init__(self, dt: datetime, ident: str, text: str,
                 note: str = "", links: list[str] | None = None) -> None:
        self.dt = dt
        self.ident = ident
        self.text = text
        self.note = note
        # 本文から辿れない URL（Bluesky はリンクを省略表示するため）。
        self.links = links or []

    def sort_key(self):
        return (self.dt, self.ident)


def reached(oldest: datetime | None, since: datetime | None) -> bool:
    """`--since` の範囲を通り越したか。通り越したらもう遡らなくていい。

    投稿は新しい順に返るので、あるページの最古が since より前まで届いた
    なら、since 当日ぶんはそのページまでで出揃っている。ここで止めないと
    定時便が毎回 3 年ぶんを取りに行くことになる。

    境界は「日」で見る（since は日付指定で、時刻を持たない）。
    """
    if since is None or oldest is None:
        return False

    return oldest.date() < since.date()


def bluesky_links(record: dict) -> list[str]:
    """本文で省略されている URL を facets と embed から集める。

    並びは record に現れた順のまま（決定論のため並べ替えない）。同じ URL が
    facets と embed の両方に出ることがあるので、最初の 1 回だけ残す。
    """
    links: list[str] = []

    def add(uri) -> None:
        uri = str(uri or "")
        if uri.startswith(("http://", "https://")) and uri not in links:
            links.append(uri)

    for facet in record.get("facets") or []:
        if not isinstance(facet, dict):
            continue
        for feature in facet.get("features") or []:
            if isinstance(feature, dict):
                add(feature.get("uri"))

    embed = record.get("embed")
    if isinstance(embed, dict):
        external = embed.get("external")
        if isinstance(external, dict):
            add(external.get("uri"))

    return links


def bluesky(writer: Writer, since: datetime | None) -> int:
    """Bluesky。認証は要らない（public.api.bsky.app）。

    リポストは他人の言葉なので落とす（`reason` が付く）。返信は自分の言葉
    なので拾い、返信だと分かる印だけ付ける。

    本文の URL は `github.com/polidog/omar...` のように**省略された表示**が
    入っていて、そのままでは辿れない。実際の URL は facets（リッチテキストの
    注釈）と embed に別で入っているので、そちらから拾って本文の後ろに添える。
    本文自体は原文ママのまま触らない。
    """
    posts, cursor = [], None
    for _ in range(MAX_PAGES):
        url = (f"{BLUESKY_API}/app.bsky.feed.getAuthorFeed"
               f"?actor={BLUESKY_ACTOR}&limit={PAGE}")
        if cursor:
            url += f"&cursor={urllib.parse.quote(cursor)}"

        page = fetch_json(url)
        feed = page.get("feed") if isinstance(page, dict) else None
        if not isinstance(feed, list) or not feed:
            break

        oldest = None
        for item in feed:
            if not isinstance(item, dict) or item.get("reason"):
                continue  # リポスト
            post = item.get("post")
            if not isinstance(post, dict):
                continue
            record = post.get("record")
            if not isinstance(record, dict):
                continue
            text = str(record.get("text") or "").strip()
            if not text:
                continue
            dt = jst(record.get("createdAt"))
            if not dt:
                continue
            # at://did:.../app.bsky.feed.post/<rkey> の rkey が投稿の名前。
            ident = str(post.get("uri") or "").rsplit("/", 1)[-1]
            posts.append(Post(dt, ident, text,
                              "返信" if record.get("reply") else "",
                              bluesky_links(record)))
            oldest = dt if oldest is None else min(oldest, dt)

        if reached(oldest, since):
            break

        cursor = page.get("cursor")
        if not cursor:
            break

    return bundle(writer, "bluesky", posts, since)


def misskey(writer: Writer, since: datetime | None) -> int:
    """Misskey (misskey.io)。こちらも認証なしで公開ノートが取れる。

    純粋なリノートは `text` を持たないので自然に落ちる。引用リノートは
    自分のコメントがあるので拾う。cw（たたむ見出し）も本人の言葉なので残す。
    """
    posts, until = [], None
    for _ in range(MAX_PAGES):
        payload = {
            "userId": MISSKEY_USER_ID,
            "limit": PAGE,
            "withReplies": True,
            "withRenotes": False,
        }
        if until:
            payload["untilId"] = until

        page = fetch_json(f"{MISSKEY_API}/users/notes", payload)
        if not isinstance(page, list) or not page:
            break

        oldest = None
        for note in page:
            if not isinstance(note, dict):
                continue
            text = str(note.get("text") or "").strip()
            cw = str(note.get("cw") or "").strip()
            if not text and not cw:
                continue
            dt = jst(note.get("createdAt"))
            if not dt:
                continue

            marks = []
            if note.get("replyId"):
                marks.append("返信")
            if note.get("renoteId"):
                marks.append("引用")
            body = f"{cw}\n\n{text}".strip() if cw else text
            posts.append(Post(dt, str(note.get("id") or ""), body, " ".join(marks)))
            oldest = dt if oldest is None else min(oldest, dt)

        if reached(oldest, since):
            break

        until = str(page[-1].get("id") or "")
        if not until:
            break

    return bundle(writer, "misskey", posts, since)


def bundle(writer: Writer, source: str, posts: list[Post], since: datetime | None) -> int:
    """投稿を日ごとに束ねて書く。

    その日の投稿を全部持っていない状態で書くと過去を削ってしまうので、
    ここへ来るのは全ページ取り切ったあとだけ（途中で失敗したら Unreachable が
    上がって、この関数には来ない）。
    """
    days: dict[str, list[Post]] = {}
    for post in posts:
        if since and post.dt.date() < since.date():
            continue
        days.setdefault(post.dt.strftime("%Y-%m-%d"), []).append(post)

    for date, items in sorted(days.items()):
        items.sort(key=Post.sort_key)
        out = ROOM / date[:7] / f"{source}-{date}.md"
        writer.write(out, render_day(source, date, items))

    return len(days)


def render_day(source: str, date: str, items: list[Post]) -> str:
    head = frontmatter({
        "room": "soto",
        "source": source,
        "date": date,
        "posts": len(items),
    })
    body = []
    for post in items:
        label = f"{hhmm(post.dt)} {post.ident}"
        if post.note:
            label += f"（{post.note}）"
        block = f"## {label}\n\n{post.text}"
        if post.links:
            block += "\n\n" + "\n".join(f"→ {url}" for url in post.links)
        body.append(block)
    return head + f"\n\n# {date} {source}\n\n" + "\n\n".join(body) + "\n"


# ---------------------------------------------------------------- 入口

SOURCES = ("blog", "bluesky", "misskey")


def main() -> int:
    ap = argparse.ArgumentParser(description="そとのこえ — 外に出した言葉を集める")
    ap.add_argument("--dry-run", action="store_true", help="書かずに結果だけ出す")
    ap.add_argument("--since", metavar="YYYY-MM-DD", help="この日以降だけ")
    ap.add_argument("--quiet", action="store_true", help="1行だけ報告する")
    ap.add_argument("--source", choices=SOURCES, action="append",
                    help="集めるソース（繰り返し指定できる。既定は全部）")
    ap.add_argument("--site", default=SITE, help=f"polidog.jp の場所（既定 {SITE}）")
    args = ap.parse_args()

    since = None
    if args.since:
        try:
            since = datetime.strptime(args.since, "%Y-%m-%d")
        except ValueError:
            print(f"--since の日付が読めません: {args.since}", file=sys.stderr)
            return 2

    wanted = args.source or list(SOURCES)
    writer = Writer(args.dry_run)
    jobs = {
        "blog": lambda: blog(writer, args.site, since),
        "bluesky": lambda: bluesky(writer, since),
        "misskey": lambda: misskey(writer, since),
    }

    counts: dict[str, int] = {}
    unreachable: list[str] = []
    for name in SOURCES:
        if name not in wanted:
            continue
        before = dict(writer.stats)
        try:
            counts[name] = jobs[name]()
        except Unreachable as exc:
            # 取りに行けなかったソースは無かったことにする。この回に
            # 書いたぶんは残るが、書いていない日を空にはしない。
            writer.stats = before
            unreachable.append(name)
            print(f"  ✗ {name}: {exc}", file=sys.stderr)

    stats = writer.stats
    if args.quiet:
        got = " ".join(f"{k} {v}" for k, v in counts.items())
        line = (f"sotonokoe: {writer.total}ファイル (new {stats['new']} "
                f"/ upd {stats['updated']} / same {stats['same']}) {got}")
        if writer.failed:
            line += f" ／ とれず {writer.failed}"
        if unreachable:
            line += f" ／ とどかず {','.join(unreachable)}"
        print(line)
    else:
        if args.dry_run:
            print("（書かずに確認）")
        print(f"  そとのこえ   : {writer.total:,} ファイル")
        print(f"    あたらしい : {stats['new']:,}")
        print(f"    かきかえ   : {stats['updated']:,}")
        print(f"    かわらず   : {stats['same']:,}")
        for name in SOURCES:
            if name in counts:
                unit = "記事" if name == "blog" else "日ぶん"
                print(f"    {name:<9}: {counts[name]:,} {unit}")
        if writer.failed:
            print(f"    とれず     : {writer.failed:,} 件（次の便で取り直す）")
        for name in unreachable:
            print(f"    {name:<9}: とどかず（次の便で取り直す）")
        print(f"  ばしょ : {ROOM}")

    return 1 if (unreachable or writer.failed) else 0


if __name__ == "__main__":
    sys.exit(main())
