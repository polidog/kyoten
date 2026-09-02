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

- **LV1 完了**（2026-09-03）— ぼうけんのしょ 293さつ / 20MB を保全。
  `~/.claude/settings.json` に `cleanupPeriodDays: 3650` を設定済み
  （未設定だと30日でログが消える）。
- **LV2 が次** — ことのは（自分の発言の抜き出し）とルーラ（全文検索）。

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

## 次にやること（LV2）

### ことのは — 自分の発言だけを抜き出す

`bin/kotonoha.py` を作る。

- 入力: `bouken/` ではなく **jsonl の原本**から直接抜く（写しの整形に依存しない）
- Claude Code: `type == "user"` かつ `isMeta`/`isSidechain` でない行のテキスト。
  `tool_result` は除く
- Codex: `event_msg` の `item.type == "UserMessage"`（本文は `content`）と
  `payload.type == "user_message"`（本文は `message`）の2系統
- 除外すべき混入: `/compact` などのスラッシュコマンド、
  `This session is being continued from...` の要約、
  Codex の内部評価プロンプト（`The following is the Codex agent history...` で始まる）、
  AGENTS.md / CLAUDE.md の注入内容
- 出力: `kotonoha/<YYYY-MM>/<YYYY-MM-DD>.md`。日付ごとに時系列で束ねる。
  1発言 = 1見出し（時刻・プロジェクト）+ 本文
- 掟は utsushi と同じ（決定論・冪等）

### ルーラ — 全文検索

`bin/ruula.py` を作る。

- SQLite **FTS5 の trigram トークナイザ**（日本語がそのまま引ける・動作確認済み）
- DB: `~/Documents/Obsidian/kyoten/.ruula.db`（拠点の .gitignore に入れる）
- 刻む対象: `bouken/` `kotonoha/`、および読み専用の水源として
  `~/Documents/Obsidian/reading-notes/`
- チャンク: 見出し単位で切る。パス・日付・プロジェクト・行番号をメタデータに持つ
- CLI: `ruula.py "検索語"` で結果を出す。`--project` `--since` で絞れると良い
- 再構築は数秒で終わる想定。増分ではなく作り直しでよい

### 確認すること

作ったら必ず:

```bash
bin/utsushi.py --quiet   # 2回流して upd 0 になるか（冪等性）
bin/kotonoha.py --quiet  # 同上
bin/ruula.py "検索語"     # 日本語が引けるか
```

## 使い方

```bash
bin/utsushi.py              # ぼうけんのしょを写す
bin/utsushi.py --dry-run    # 書かずに結果だけ
bin/utsushi.py --since 2026-08-01
bin/utsushi.py --quiet      # 1行だけ（定時便用）
```

`KYOTEN` 環境変数で拠点の場所を変えられる（既定 `~/Documents/Obsidian/kyoten`）。

## 応答

日本語で。技術用語とコード識別子は原文のまま。
