# kyoten — 作業のきまり

記憶を保全して、そこから自分（polidog）を見つけ出すための道具箱。
下敷きは [kani.show](https://kani.show/)（カニ省の長屋）。世界観はドラクエ。

設計図: https://claude.ai/code/artifact/08ea4f4f-4ebf-4764-a404-69a1fb8ed669

## 何より先に: コードとデータを混ぜない

| | 場所 | 公開 |
|---|---|---|
| コード（このリポジトリ） | `~/ghq/github.com/polidog/kyoten` | してよい |
| データ（拠点） | `~/Documents/Obsidian/kyoten` | **絶対に private** |

拠点には会話の原文がそのまま入っている。取引先の実名、メールアドレス、
Slack スレッド全文、認証まわりの試行錯誤——全部入っている前提で扱う。

**このリポジトリに拠点の中身を貼らない。コミットしない。ログとして出力しない。**
動作確認で拠点の中身を見るのは構わないが、会話に長く引用しないこと。

## いまどこまで来たか

- **LV1 完了**（2026-09-03）— ぼうけんのしょ 296さつ / 20MB を保全。
  `~/.claude/settings.json` に `cleanupPeriodDays: 3650` を設定済み
  （未設定だと30日でログが消える）。
- **LV2 完了**（2026-09-03）— ことのは 550発言 / 7日ぶん、
  ルーラ 968ファイル / 24,660かたまり（索引 87MB・刻み直し3秒）。
  共通の小道具は `bin/dougu.py` に切り出し済み。
- **LV3 完了**（2026-09-03）— そとのこえ 2,424ファイル / 11MB。
  polidog.jp の記事 1,307本（2004-12-26 〜。索引の件数と一致し、取りこぼしゼロ）、
  Bluesky 373日ぶん、Misskey 744日ぶん（どちらも 2023年3月から全履歴）。
  polidog.jp 側には JSON の口を足した（[polidog/web#5](https://github.com/polidog/web/pull/5)・
  [#6](https://github.com/polidog/web/pull/6)、マージ済み）。
  Cloudflare の Cache Rule も設定済み。
- **LV4 完了**（2026-09-03）— 盗賊。
  - **よるのとばり** `bin/yorunotobari.py` を systemd user timer
    （`kyoten.timer`、毎晩 03:00・`Persistent=true`）に載せた。
  - **てのあと** 856日ぶん / 8,320コミット（62リポジトリ・2018-11-16 〜）と、
    会話ログから拾ったつまずき 90件。
  - **ふくろ** 66プロジェクトの台帳。
  - ルーラは 39,624かたまり / 索引 114MB。拠点は全部きょうかい済み。
- **LV5 完了**（2026-09-03）— ステータス・とくぎ 71枚・年表 23年
  （2004 〜 2026）。ルーラは 40,774かたまり。
- **LV6 が次** — うらないババ（週次のおつげ）と配達。

## 語彙

| ことば | 意味 |
|---|---|
| 拠点 | `~/Documents/Obsidian/kyoten`。記憶の正本 |
| ぼうけんのしょ | `bouken/` 会話原文の写し |
| ことのは | `kotonoha/` 自分の発言だけ |
| てのあと | `teato/` 作ったもの・詰まったこと |
| そとのこえ | `soto/` polidog.jp と SNS |
| ふくろ | `fukuro/` 長期記憶（人物・概念・プロジェクト） |
| ステータス / とくぎ / おつげ | 観測結果。2階部分 |
| ルーラ | 全文検索。「行ったことのある場所にしか飛べない」 |
| きょうかい | git commit（セーブ） |
| よるのとばり | systemd user timer の定時便 |

役者: 勇者 polidog（人間・観測される側）/ 賢者（対話）/ 盗賊（拾い屋）/
うらないババ（おつげ）/ 吟遊詩人（週報）。

## 掟

1. **決定論的** — 同じ入力なら必ず同じ出力。生成日時など揺れる値を書かない。
2. **冪等** — 内容が変わらなければファイルに触れない（mtime も動かさない）。
3. **原文ママ** — 発話は加工しない。長大なツール出力の末尾だけ省略し、明記する。
4. **手で書かせない** — 拠点に人間が手入力する部屋を作らない。過去に3回、
   手書き前提の仕組みを作って全部止まっている（`00_思考`、Discord秘書、agent-tracer）。
   素材はすべてログから機械が起こす。
5. **書き込み口を絞る** — 1つの部屋の書き手は1つ。読みは全開。
6. **依存を増やさない** — `uv` は入っていない。Python は標準ライブラリだけで書く。

## 踏んだ罠（同じところを踏まない）

1. **`session_id` の先頭8文字は一意ではない。** `52de10eb` で始まる別セッションが
   実在した。サブエージェントは親と同じ `sessionId` を持つ（最大18ファイル）。
   出力ファイル名は**元 jsonl と 1:1** にする。
2. **`read_text()` の universal newlines で冪等性が壊れる。** CR を含むログがある
   （実測10件）。読み書き両方で `newline=""` を明示する。
3. **MCP の戻り値は `\uXXXX` エスケープされた JSON。** 開かないと Obsidian で読めず、
   全文検索でも日本語が引けない。`json.loads` → `ensure_ascii=False` で書き直す。
4. **`jq ... | wc -l` は行数であって件数ではない。** 実測 30,887行 = 888件。
   数を報告する前に、何を数えているか確かめる。
5. **「ユーザー行」は本人の発話ではない。** 実測1,066行のうち本人の入力は約550。
   `isMeta` / `isCompactSummary` / `isSidechain` / `origin.kind` / `promptSource`
   で落ちるものはフラグで落とす。文面判定はフラグの無い古いログ用の最後の砦。
6. **スラッシュコマンドの `<command-args>` は本人の言葉。** `/omarchy フォントを…`
   のように引数に本文が入る（実測66件）。コマンド名だけの行は捨て、引数は拾う。
7. **FTS5 trigram は3文字未満を索引に入れられない。** 日本語は「拠点」「記憶」
   のような2文字語が多く、`MATCH` では1件も引けない。素の部分一致に落とす
   （24,660かたまり / 26MB で 40ms）。`snippet()` も 1トークン=3文字で窓が
   狭すぎるので抜粋は自前で切る。

7. **polidog.jp は Hugo ではない。** `polidog/website`（Hugo）は旧サイトで、
   公開中の記事と 1 本も一致しない（実測: サイトの 8月記事 11本 vs ローカル 3本、
   重なり 0）。現行は `polidog/web` —— Relayer 製の自前 CMS、記事は SQLite。
8. **Cloudflare は `Accept` をキャッシュキーに入れない。** `Vary: Accept` も
   見ない。同じ URL で HTML と JSON を出し分けるなら、JSON を `no-store` に
   したうえで Cloudflare 側に bypass ルールが要る。無いとエッジの HTML が
   JSON 要求にも HIT する（実測: `cf-cache-status: HIT` で HTML が返った）。
   ルールは「Eligible for cache」より**下**に置く（最後に一致したものが勝つ）。
   そして **`cf-cache-status: BYPASS` は効いている証拠にならない** ——
   アプリが `no-store` を返しただけでも BYPASS と表示される。確かめるには
   記事 URL を HTML で 2 回叩いて `HIT` にしてから JSON を要求する。
13. **索引に載っているのに取れない記事があった。** 記事 URL には
    `/YYYY/MM/DD/slug`（1,294本）と `/blog/YYYY/MM/slug`（12本）が同居していて、
    `/2006/10/16` のようなものまである。web 側が URL の形で判定していたので
    12本が HTML を返していた（[polidog/web#6](https://github.com/polidog/web/pull/6) で修正）。
9. **SNS のいいね数・リアクション数を書かない。** 過去の投稿でも増減するので、
   書くと毎回全ファイルが書き換わって冪等が壊れる。
10. **Bluesky の `record.text` は URL が省略表示。** 実 URL は `facets` と
    `embed` にある。本文は原文ママのまま、URL を後ろに添える（実測 100件中 27件）。
11. **日本語スラッグの URL は `quote` が要る。** 248本ある。そのまま urllib に
    渡すと `UnicodeEncodeError` で、これは `Unreachable` ではないのでクラッシュする。
12. **「取れなかった」と「0件だった」を混同しない。** 落ちている日に空ファイルを
    書くと過去が消える。取りに行けなかったソースはファイルに触れずに諦める。
    ただし記事は 1本ずつ独立なので、1本落ちても残りは書く。

14. **ルーラの報告は stdout ではなく stderr に出る。** 検索結果だけを stdout に
    流す作りなので、`| grep` しても混ざらない。定時便が「何も言わずに終わった」と
    言い出したらこれ。
15. **systemd user service の PATH は最小。** きょうかいで `git` を呼ぶので
    `/usr/bin` が要る。`Environment=PATH=` で明示する。
16. **`git status --porcelain` は未追跡ディレクトリを1行にまとめる。**
    そのまま数えると「そとのこえ 1」という嘘のきょうかいになる。
    `--untracked-files=all` を付ける。

17. **モノレポの奥で作業した日は別プロジェクトに見える。** `slug_from_cwd()` は
    cwd をそのまま名前にするので `<repo>/apps/web` と `<repo>` に割れる。
    git 側は常にルートを名乗るので、放っておくと同じ日の別々の見出しになる。
18. **擬似プロジェクトの名前で全文検索しない。** `Work` や `_home` は名前が
    ただの単語なので、そとのこえを部分一致で総なめにする（実測: `Work` が
    "work" を含む記事87本を拾っていた）。探すのは `<user>/<repo>` の形だけ。
19. **`is_error` は「詰まった」ではない。** `ls … && wc …` の後半だけこけても
    is_error になる。長さとエラー語で絞る（実測 117件 → 41件）。

20. **git worktree を二重に数える。** worktree は本体と同じ履歴を持つので、
    両方走査すると同じコミットが2回入る（実測 8,320件中 524件）。本体の
    `.git` はディレクトリ、worktree はファイルなので `is_dir()` で分ける。
21. **「直近N日」を今日から数えない。** 素材が変わっていないのに日をまたぐ
    だけで中身が動き、冪等が壊れる。拠点にある最後の日から遡る。

## 次にやること

### LV6 — うらないババ（おつげ）と配達

週に1度、拠点を読んで「おつげ」を書く。素材は2階（ふくろ・ステータス）
まで揃っている。何を告げるか、どこへ配るかはまだ決めていない。

### 残していること

- **ふくろの人物・概念。** いまのふくろはプロジェクト台帳だけ
  （`fukuro/project/`）。人物と概念は分かち書きが要るので、依存を
  増やさずどこまでやるかを決めてから。
- **Codex のログからつまずきを拾う。** てのあとが読むのは Claude Code の
  `is_error` だけ。Codex は形式が違うので手つかず。

### よるのとばりを触るとき

```bash
systemctl --user list-timers kyoten.timer   # 次にいつ起きるか
systemctl --user start kyoten.service       # いま1回流す
journalctl --user -u kyoten.service -o cat  # 何を言ったか
```

unit は `systemd/` にあり、`~/.config/systemd/user/` から symlink して
ある。直したら `systemctl --user daemon-reload`。

### 確認すること

作ったら必ず（2回流して `upd 0` になるか＝冪等）:

```bash
bin/utsushi.py --quiet
bin/kotonoha.py --quiet
bin/sotonokoe.py --quiet
bin/teato.py --quiet
bin/fukuro.py --quiet
bin/status.py --quiet
bin/ruula.py --rebuild && bin/ruula.py "検索語"
```

まとめて流すなら `bin/yorunotobari.py`。順番に意味がある（ふくろは
拠点に書かれたものを畳むので必ず最後）。

ことのはを触ったら、混入が戻っていないかも見る:

```bash
grep -c '<command-name>\|<local-command\|<task-notification>' \
  ~/Documents/Obsidian/kyoten/kotonoha/*/*.md   # すべて 0 であること
```

## 使い方

```bash
bin/utsushi.py              # ぼうけんのしょを写す
bin/utsushi.py --dry-run    # 書かずに結果だけ
bin/utsushi.py --since 2026-08-01
bin/utsushi.py --quiet      # 1行だけ（定時便用）

bin/kotonoha.py             # ことのはを抜く（引数は utsushi と同じ）

bin/sotonokoe.py            # そとのこえを集める（引数は utsushi と同じ）
bin/sotonokoe.py --source bluesky            # ソースを絞る
bin/sotonokoe.py --site http://127.0.0.1:8000  # 手元の polidog.jp を見る

bin/teato.py                # てのあと（引数は utsushi と同じ）
bin/fukuro.py               # ふくろ（--dry-run / --quiet）
bin/status.py               # ステータス・とくぎ・年表（同上）

bin/yorunotobari.py         # 定時便（全部流してきょうかいまで）
bin/yorunotobari.py --dry-run
bin/yorunotobari.py --no-commit

bin/ruula.py "検索語"        # ルーラ。素材が新しければ勝手に刻み直す
bin/ruula.py "検索語" --room kotonoha --project polidog/kyoten --since 2026-09-01
bin/ruula.py --rebuild      # 刻み直すだけ
bin/ruula.py --stats        # 索引の中身を数える
bin/ruula.py --rebuild --quiet  # 刻み直して1行だけ（定時便用）
```

`KYOTEN` 環境変数で拠点の場所を変えられる（既定 `~/Documents/Obsidian/kyoten`）。
reading-notes の場所は `KYOTEN_READING`。

## 応答

日本語で。技術用語とコード識別子は原文のまま。
