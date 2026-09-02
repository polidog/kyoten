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
```

以降の部屋（ことのは・てのあと・そとのこえ・ふくろ・ステータス）は
レベルが上がったら建てる。

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

## ログを消させない

Claude Code は `cleanupPeriodDays` 未設定だと **30日でログを消す**。
`~/.claude/settings.json` に設定済み:

```json
{ "cleanupPeriodDays": 3650 }
```

写しを取る仕組みが動いていても、取りこぼした期間の穴は埋められないので、
原本も残す。

## これから

- **LV2** ことのは（自分の発言だけ抜き出す）とルーラ（SQLite FTS5 trigram の全文検索）
- **LV3** そとのこえ（polidog.jp の RSS と SNS）
- **LV4** 盗賊（systemd timer で夜まわり、てのあととふくろを育てる）
- **LV5** ステータス画面ととくぎ
- **LV6** うらないババ（週次のおつげ）と Discord への配達
