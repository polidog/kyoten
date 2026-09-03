# kyoten（拠点）

記憶を保全して、そこから自分を見つけ出すための道具箱。

Claude Code と Codex の会話ログを Markdown に写し、検索できるようにして、
そこから「自分が何を作り、何に詰まり、何を繰り返しているか」を観測する。

下敷きは [kani.show](https://kani.show/)（カニ省の長屋）。
間取りの考え方と、性格を設定ファイルに書かず記憶で育てるという判断はそこから借りた。

## コードとデータは分ける

| | 置き場 | 公開 |
|---|---|---|
| コード（このリポジトリ） | `~/ghq/github.com/polidog/kyoten` | してよい |
| データ（拠点） | `~/Documents/Obsidian/kyoten` | **絶対に private** |

拠点には会話の原文がそのまま入る。仕事の Slack スレッド、取引先の実名、
メールアドレス、認証まわりの試行錯誤——全部入っている前提で扱うこと。
**この2つを同じリポジトリに混ぜてはいけない。**

## 間取り

```
~/Documents/Obsidian/kyoten/
  bouken/            ぼうけんのしょ — 会話原文の写し
    claude/<project>/<date>_<session>.md
    claude/<project>/subagents/...
    codex/<project>/<date>_<session>.md
  kotonoha/          ことのは — 自分の発言だけ
    <YYYY-MM>/<YYYY-MM-DD>.md
  soto/              そとのこえ — 外に出した言葉
    <YYYY-MM>/<DD>-<slug>.md          polidog.jp の記事 1 本
    <YYYY-MM>/bluesky-<YYYY-MM-DD>.md その日の Bluesky
    <YYYY-MM>/misskey-<YYYY-MM-DD>.md その日の Misskey
  .ruula.db          ルーラの索引（機械生成・git 管理外）
```

以降の部屋（てのあと・ふくろ・ステータス）はレベルが上がったら建てる。

道具は `bin/` に5本。共通の小道具は `bin/dougu.py` に置いてある。

| 道具 | 何をするか |
|---|---|
| `utsushi.py` | jsonl → ぼうけんのしょ |
| `kotonoha.py` | jsonl → ことのは |
| `sotonokoe.py` | polidog.jp・Bluesky・Misskey → そとのこえ |
| `ruula.py` | 上の3つと reading-notes を全文検索 |
| `yorunotobari.py` | 上を順に流して拠点をきょうかいする定時便 |

## utsushi — ぼうけんのしょの書き写し

```bash
bin/utsushi.py                    # 全部写す
bin/utsushi.py --dry-run          # 書かずに結果だけ見る
bin/utsushi.py --since 2026-08-01 # この日以降だけ
bin/utsushi.py --quiet            # 1行だけ報告する（定時便用）
```

環境変数 `KYOTEN` で拠点の場所を変えられる。既定は `~/Documents/Obsidian/kyoten`。

### 掟

- **決定論的** — 同じ入力なら必ず同じ出力。生成日時など揺れる値は書かない。
- **冪等** — 内容が変わらなければファイルに触れない（mtime も動かさない）。
- **原文ママ** — 発話は加工しない。長大なツール出力の末尾だけ省略し、その旨を明記する。
  原本の jsonl は残るので省略は復元できる。

### 実装で踏んだ落とし穴

あとから同じ罠を踏まないための記録。

1. **`session_id` の先頭8文字は一意ではない**
   `52de10eb` で始まる別セッションが実在した。さらにサブエージェントのログは
   親と同じ `sessionId` を持つ（最大18ファイルが同じ ID）。
   出力ファイル名は**元 jsonl と 1:1** になるよう、元ファイル名を鍵にする。

2. **`read_text()` の universal newlines で冪等性が壊れる**
   会話ログには CR を含むものがある（実測10件）。既定の読み方だと CRLF が LF に
   化けて、書いた本文と読み返した本文が永久に一致しない＝毎回 updated になる。
   読み書き両方で `newline=""` を明示する。

3. **MCP の戻り値は `\uXXXX` エスケープされた JSON**
   そのままでは Obsidian で読めず、全文検索でも日本語が引けない。
   JSON として開けるものは開いて `ensure_ascii=False` で書き直す。

4. **発言の「行数」と「件数」は桁が違う**
   `jq ... | wc -l` は行数を数える。実測で 30,887行 ＝ 888件。
   長文をまとめて投げるので1発言あたり平均25行になる。

5. **FTS5 trigram は3文字未満を索引に入れられない**
   日本語は「拠点」「記憶」「掟」のような2文字以下の語が多い。
   trigram の窓が3文字なので、これらは `MATCH` で1件も引けない。
   2文字以下が混ざったときは素の部分一致（全走査）に落とす。
   実測 24,660かたまり / 26MB で 40ms、実用上は問題ない。

6. **`snippet()` は trigram だと窓が狭すぎる**
   1トークン = 3文字なので上限の64トークンでも66文字ほどにしかならない。
   しかも部分一致に落ちたときは使えず、見た目が揃わない。抜粋は自前で切る。

## kotonoha — ことのは（自分の発言だけ）

```bash
bin/kotonoha.py                    # 全部抜く
bin/kotonoha.py --dry-run
bin/kotonoha.py --since 2026-08-01
bin/kotonoha.py --quiet
```

ぼうけんのしょ（写し）ではなく **jsonl の原本から直接抜く**。
写しの整形を変えても、ことのはは影響を受けない。

出力は `kotonoha/<YYYY-MM>/<YYYY-MM-DD>.md`。1発言 = 1見出し。

```markdown
## 09:12:03 polidog/kyoten（claude-code）

LV2をすすめてほしい
```

### 本人の発話だけを残す

Claude Code の「ユーザー行」には本人の入力でないものが大量に混ざる。
実測 1,066行のうち、本人が打ったのは約550。**フラグで落とせるものは
フラグで落とし、文面での判定は古いログ用の最後の砦にする。**

| 落とすもの | 見分け方 | 実測 |
|---|---|---|
| サブエージェントの会話 | `isSidechain` | — |
| スキル本文・画像・caveat の注入 | `isMeta` | 230 |
| compact の要約 | `isCompactSummary` | 6 |
| サブエージェント完了通知 | `origin.kind == "task-notification"` | 170 |
| 道具の操作（`/clear` `/compact` `/model`） | `<command-args>` が空 | 102 |
| Codex の内部承認プロンプト | 文面 | 14 |

`<command-args>` に中身があるとき（`/omarchy フォントを日本語に…` など）、
それは本人が打った言葉なので**拾う**。実測66件。見出しにコマンド名を残す。

## sotonokoe — そとのこえ（外に出した言葉）

```bash
bin/sotonokoe.py                    # 全部集める
bin/sotonokoe.py --dry-run
bin/sotonokoe.py --since 2026-08-01
bin/sotonokoe.py --quiet
bin/sotonokoe.py --source bluesky   # ソースを絞る（blog / bluesky / misskey）
bin/sotonokoe.py --site http://127.0.0.1:8000   # 手元の polidog.jp を見る
```

ぼうけんのしょとことのはが「閉じた場所での言葉」なのに対して、こちらは
**公開された言葉**。polidog.jp の記事と、Bluesky・Misskey の投稿を集める。

記事は 1 本 1 ファイル、SNS は日ごとに束ねる。長さが 2 桁違うので、
1 投稿 1 ファイルにすると数千の断片ができてルーラで引いても前後が見えない。

### polidog.jp から取る口を足した

**polidog.jp はもう Hugo ではない。** `polidog/website`（Hugo）は旧サイトで、
現行は `polidog/web` —— Relayer 製の自前 CMS（PHP / FrankenPHP / fly.io、
記事は SQLite）。ローカルの Hugo ソースは公開中の記事と一致しないので使えない。

RSS（`/index.xml`）は最新 20 件しか返さず、20 年ぶんを機械で読む手段が無かった
ので、web 側に JSON の口を足した（[polidog/web#5](https://github.com/polidog/web/pull/5)）。
**HTML と同じ URL** に `Accept: application/json` を付けたときだけ JSON になる。

```bash
curl -H 'Accept: application/json' https://polidog.jp/archives/            # 全記事の索引
curl -H 'Accept: application/json' https://polidog.jp/2026/09/01/git-dmb/  # 記事 1 本
```

索引は本文を持たない（1,300 件ぶんの Markdown は数 MB になる）。記事ごとの
`updatedAt` を版として、書き出したファイルの frontmatter と突き合わせ、
**変わった記事だけ**本文を取りに行く。状態ファイルは要らない。

### SNS は認証なしで全履歴が取れる

| | 口 | 遡り方 |
|---|---|---|
| Bluesky | `public.api.bsky.app` の `getAuthorFeed` | `cursor` |
| Misskey | `misskey.io/api/users/notes` | `untilId` |

どちらもトークン不要。リポスト・リノート（他人の言葉）は落とし、返信と引用は
自分の言葉なので拾って印を付ける。

### 実装で踏んだ落とし穴

7. **いいね数・リアクション数を書いてはいけない**
   過去の投稿でも増減するので、書くと毎回すべてのファイルが書き換わって
   冪等が壊れる。書くのは本文・時刻・ID だけ。

8. **Bluesky の本文は URL が省略表示になっている**
   `record.text` には `github.com/polidog/omar...` という**表示用の文字列**が
   入っていて、そのままでは辿れない。実 URL は `facets`（リッチテキスト注釈）と
   `embed` に別で入っている。本文は原文ママのまま、URL は後ろに `→` で添える。
   実測 100 件中 27 件が該当。Misskey は生の URL がそのまま入るので不要。

9. **日本語スラッグの URL は quote しないと urllib が落ちる**
   `/2012/03/19/父親` のような記事が 248 本ある。そのまま渡すと
   `UnicodeEncodeError`（`Unreachable` ではないので握りつぶされずクラッシュする）。
   セグメントごとに `quote(..., safe="/")` を通す。

10. **「取れなかった」と「0 件だった」を混同しない**
    落ちている日に空のファイルを書くと過去を消す。取りに行けなかったソースは
    ファイルに一切触れずに諦める（`Unreachable`）。ただし**記事は 1 本ずつ独立**
    しているので、1 本落ちても残りは書く —— 全体を捨てるのは、SNS のように
    ページングの途中で欠けると日次ファイルが不完全になるときだけ。

11. **Cloudflare は `Accept` をキャッシュキーに入れない**
    `Vary: Accept` も見ない（効くのは `Accept-Encoding` と Enterprise の
    Custom Cache Key だけ）。同じ URL で HTML と JSON を出し分けるには、
    JSON 側を `Cache-Control: no-store` にしたうえで、Cloudflare に
    「`Accept` が `application/json` を含むなら Bypass cache」の Cache Rule が
    要る。無いと、エッジにある HTML が JSON 要求にも HIT する。

    ルールは既存の「Eligible for cache」より**下**に置く。Cache Rules は
    最初に一致したところで止まらず、[最後に一致したルールが勝つ](https://developers.cloudflare.com/cache/how-to/cache-rules/order/)。
    上に置くと下のルールに上書きされて効かない（一度これで嵌まった）。

12. **`cf-cache-status: BYPASS` は Cache Rule が効いている証拠にならない**
    アプリが `no-store` を返しただけでも `BYPASS` と表示される。キャッシュに
    無い URL は必ずオリジンに届くので、そこだけ見ると「効いている」ように
    見えてしまう。確かめるなら、記事 URL を HTML で 2 回叩いて `HIT` にしてから
    同じ URL に `Accept: application/json` を送る。`HIT` + HTML が返るなら
    効いていない。

13. **索引に載っているのに取れない記事があった**
    記事 URL は 1 種類ではない。`/YYYY/MM/DD/slug`（Hugo 時代・1,294本）と
    `/blog/YYYY/MM/slug`（新しく書いたもの・12本）が同居していて、
    `/2006/10/16` のようにスラッグの無いものまである。URL の形で判定すると
    必ず取りこぼすので、索引と同じ条件で引けるかどうかだけを見る
    （[polidog/web#6](https://github.com/polidog/web/pull/6)）。

## ruula — ルーラ（全文検索）

```bash
bin/ruula.py "検索語"                        # 素材が新しければ勝手に刻み直す
bin/ruula.py "検索語" --room kotonoha
bin/ruula.py "検索語" --project polidog/kyoten
bin/ruula.py "検索語" --since 2026-09-01 -n 5
bin/ruula.py --rebuild                      # 刻み直すだけ
bin/ruula.py --stats                        # 索引の中身を数える
```

「行ったことのある場所にしか飛べない」。写しを取った場所だけが引ける。

- SQLite **FTS5 の trigram トークナイザ**。日本語を分かち書きせずそのまま引ける
- 索引は `~/Documents/Obsidian/kyoten/.ruula.db`（git 管理外）
- 刻む対象は `bouken/` `kotonoha/` `soto/`、それと読み専用の水源
  `~/Documents/Obsidian/reading-notes/`（`KYOTEN_READING` で変えられる）
- 見出し単位で切り、パス・日付・プロジェクト・行番号を持つ
- 増分ではなく作り直し。実測 968ファイル / 24,660かたまりで **3秒**、索引 87MB

## yorunotobari — よるのとばり（定時便）

盗賊が夜のうちに拾って回る。utsushi・kotonoha・sotonokoe を順に流し、
ルーラを刻み直して、拠点をきょうかい（git commit）する。

```bash
bin/yorunotobari.py              # 全部流す
bin/yorunotobari.py --dry-run    # 書かずに、きょうかいもせずに流す
bin/yorunotobari.py --no-commit  # 集めるけどきょうかいはしない
```

**1つが失敗しても次へ進む。** そとのこえが取りに行けない夜でも、手元の
ログからの写しは進められる。全部やってから、失敗があれば非ゼロで終わる。

**変化が無ければコミットしない。** 何も起きなかった日に空のきょうかいを
積まない。

### systemd に載せる

```bash
ln -sf ~/ghq/github.com/polidog/kyoten/systemd/kyoten.service ~/.config/systemd/user/
ln -sf ~/ghq/github.com/polidog/kyoten/systemd/kyoten.timer   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now kyoten.timer
```

symlink なので、`systemd/` を直せば `daemon-reload` だけで反映される。
リポジトリを別の場所に置いているなら `ExecStart=` のパスを直す。

```bash
systemctl --user list-timers kyoten.timer   # 次にいつ起きるか
systemctl --user start kyoten.service       # いま1回流す
systemctl --user status kyoten.service      # しくじっていないか
journalctl --user -u kyoten.service -o cat  # 何を言ったか
```

毎晩 03:00。`Persistent=true` にしてあるので、その時刻にラップトップが
閉じていても次に起きたときに取り戻す（`Persistent=` は `OnCalendar=` の
タイマーにしか効かない）。

**しくじった夜は failed のまま残す。** 消えると、取れていないことに
気づけない。拠点は壊れない（取りに行けなかったソースはファイルに触れずに
諦める）ので、次の便で直る。

**journald に拠点の中身を出さない。** 道具はどれも `--quiet` の1行だけを
返す。件数以上のものを出すと、会話の原文がシステムログに漏れる。

### 実装で踏んだ落とし穴

14. **ルーラの報告は stdout ではなく stderr に出る**
    `ruula.py 語 | grep …` としたときに刻み直しの行が混ざらないよう、
    検索結果だけを stdout に流している。定時便が「何も言わずに終わった」と
    言い出したらこれ。名前で分岐せず、stdout が空なら stderr、の順で拾う。

15. **user service の PATH は最小**
    `yorunotobari` は python を `sys.executable` で呼ぶので自分では困らないが、
    **きょうかいで `git` を呼ぶ**ので `/usr/bin` が要る。`Environment=PATH=` で
    明示する。

16. **`git status --porcelain` は未追跡ディレクトリを1行にまとめる**
    そのまま数えると「そとのこえ 1」という嘘のきょうかいになる。
    `--untracked-files=all` でファイル単位まで開かせる。

17. **`.obsidian/workspace.json` は Obsidian を開くたびに変わる**
    追跡すると、定時便が毎晩それだけをコミットする。拠点の `.gitignore` で
    外した（設定の3ファイルは残す —— 拠点を別の場所へ移したときに要る）。

## ログを消させない

Claude Code は `cleanupPeriodDays` 未設定だと **30日でログを消す**。
`~/.claude/settings.json` に設定済み:

```json
{ "cleanupPeriodDays": 3650 }
```

写しを取る仕組みが動いていても、取りこぼした期間の穴は埋められないので、
原本も残す。

## これから

- **LV4（残り）** てのあととふくろ — 作ったもの・詰まったことと、長期記憶
- **LV5** ステータス画面ととくぎ
- **LV6** うらないババ（週次のおつげ）と Discord への配達
