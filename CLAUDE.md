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
  共通の小道具は `bin/dougu.ts` に切り出し済み。
- **LV3 完了**（2026-09-03）— そとのこえ 2,424ファイル / 11MB。
  polidog.jp の記事 1,307本（2004-12-26 〜。索引の件数と一致し、取りこぼしゼロ）、
  Bluesky 373日ぶん、Misskey 744日ぶん（どちらも 2023年3月から全履歴）。
  polidog.jp 側には JSON の口を足した（[polidog/web#5](https://github.com/polidog/web/pull/5)・
  [#6](https://github.com/polidog/web/pull/6)、マージ済み）。
  Cloudflare の Cache Rule も設定済み。
- **LV4 完了**（2026-09-03）— 盗賊。
  - **よるのとばり** `bin/yorunotobari.ts` を systemd user timer
    （`kyoten.timer`、毎晩 03:00・`Persistent=true`）に載せた。
  - **てのあと** 856日ぶん / 8,320コミット（62リポジトリ・2018-11-16 〜）と、
    会話ログから拾ったつまずき 90件。
  - **ふくろ** 66プロジェクトの台帳。
  - ルーラは 39,624かたまり / 索引 114MB。拠点は全部きょうかい済み。
- **LV5 完了**（2026-09-03）— ステータス・とくぎ 71枚・年表 23年
  （2004 〜 2026）。ルーラは 40,774かたまり。
- **Codex のつまずきも拾う**（2026-09-04）— てのあとのつまずきが 92 → 119件。
  Codex は `status: "failed"` と `exit_code` を明示するので合図は確実だが、
  「非ゼロでも中身は普通の出力」は同じなので絞り込みは共通のものを通す。
- **TypeScript へ移行**（2026-09-03）— 9本 3,600行を Python から書き直した。
  1本ずつ「同じ拠点に対して1バイトも違わない出力か」を `diff -r` で確かめて
  ある。Node の標準ライブラリだけで、ビルドも npm も無い。
- **LV6 完了**（2026-09-03）— おつげ 776週（2004-W52 〜 2026-W36）。
  配達はせず拠点に置くだけにした（掟4の3例はどれも外に出す口を持っていた）。
  ルーラは 43,759かたまり / 5,209ファイル。
- **見る口を建てた**（2026-09-04）— 城 `bin/shiro.ts` と つよさ
  `bin/tsuyosa.ts`。どちらも拠点を**読むだけ**で、素材は `bin/yomi.ts`。
  **城はまとめ1枚**（口は `/api/summary` だけ・127.0.0.1 固定・見た目は
  設計図に合わせた）、**潜って読むのは端末**、という分け方にした。
- **すずのおとを建てた**（2026-09-04）— `bin/suzu.ts`。Claude Code の hooks
  から鳴って、拠点を思い出させる。`SessionStart`（拠点の大きさ・いま居る
  場所のふくろ・いちばん新しいおつげ・ルーラの呼び方）、`UserPromptSubmit`
  （過去参照の言い回しを見つけたらルーラを促す。ことのは609発言に当てて
  実測1.5%）、`SessionEnd`（その場でぼうけんのしょに写す。`utsushi.ts --file`
  を足した）。何があっても 0 で終わる。`~/.claude/settings.json` に
  登録済み（SessionStart は `matcher: "*"`、UserPromptSubmit と SessionEnd
  はマッチャ無しで 1本ずつ）。外すときはその3つを消すだけ。
- **1階と2階は建て終わった。** 次にやることは下の「残していること」。

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
| 城 | `bin/shiro.ts` 拠点のまとめをブラウザに出す。読むだけ |
| つよさ | `bin/tsuyosa.ts` 拠点を端末で歩く。潜って読むのはこちら |
| すずのおと | `bin/suzu.ts` hooks から鳴って拠点を思い出させる |

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
6. **依存を増やさない** — TypeScript を **Node の標準ライブラリだけ**で書く。
   `npm install` は要らないし `node_modules` も無い。ビルドもしない
   （Node 24+ が `.ts` の型注釈を剥がして直接実行する）。そのぶん
   **実行時の意味を持つ構文は使えない** —— `enum`・`namespace`・
   `constructor(readonly x)`・decorator は落ちる。型検査は走らせていない
   （`tsc` を入れると依存が増える）ので、正しさは出力の突き合わせで見る。

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

22. **「N日ぶり」「N日止まっている」を今日から数えない。** 過去の週の
    おつげが毎晩書き換わり、「あのとき何と言われたか」が残らなくなる。
    週を古い順に見て、その週の終わりまでに分かっていたことだけで書く。

23. **JS の `.` は `\r` にマッチしない**（Python の `.` はする）。会話ログには
    CR があるので `^## (.+)$` だと見出しを取りこぼす。`[^\n]` で書く。
24. **`.slice(0, n)` は UTF-16 単位。** Python の `[:n]` はコードポイント。
    絵文字が混ざると1文字ずれる。`dougu.ts` の `take()` を使う。
25. **`execFileSync` は成功時の stderr を返さない。** ルーラは stderr に報告
    するので、定時便から呼ぶと黙って終わったことにされる。`spawnSync` を使う。

26. **端末は複数のキーを1回の `data` で渡してくる。** 速く打つと `↓↓q` が
    1つの塊で届く。塊のまま比べるとどのキーにも当たらず、**全部無視される**。
    キーに割ってから1つずつ流す。割るときは `[...chunk]` で数える（罠24）。
27. **描くのを最後の1回にまとめると、キーの処理が古い画面を見る。** 塊で
    届いた `Enter` が、前の画面のカーソル行を開いた。キーごとに、いま居る
    場所のページを引き直す（同じ場所ならメモが効くので安い）。
28. **`listen()` は非同期。** ほかの道具と同じ `process.exit(main())` の形で
    書くと、城は建った端から閉じる。対話するものは戻り値で終わらせない。
29. **拠点の中身を画面に描くときは必ずエスケープする。** 会話原文には HTML も
    `<script>` も普通に入っている。検索語を光らせるところも、印を入れてから
    エスケープすると印まで消えるので、一致箇所で切って組み立てる。

30. **`.ts` は ESM なので `require` が無い。** Node が型注釈を剥がして直接
    実行するだけで、中身は ESM。`require("node:sqlite")` は
    `ReferenceError` になる。すずのおとは例外を全部飲むので、落ちても
    「なぜか鳴らない」としか見えない。静的 import に揃える。

31. **すずは全プロジェクトのセッションで鳴る。** 仕事のリポジトリでも鳴る
    ので、配ってよいのは数と見出しまで。会話の原文は渡さない。原文が要る
    ときは賢者がルーラを叩いて取りに行く。

32. **鳴りすぎるすずは、鳴っていないのと同じ。** `前に＋動詞` を過去参照に
    入れると「この行の前に書いて」のような指示文で鳴る。語彙は
    `bin/suzu.ts --tameshi` でことのはに当てて決める（実測1.5%）。

33. **「何があっても 0 で終わる」は `main` の中だけでは守れない。** 読み込み
    時に落ちるもの（構文エラー・import の失敗）は try/catch の外で、
    終了コード 1 になる。`UserPromptSubmit` が非ゼロで終わると**そのプロンプト
    自体が止まる**ので、すずを直したら登録する前に必ず1回叩く（実際に一度
    壊して、全部のセッションが止まる形になるのを見た）。

## 次にやること

### 残していること

- **まちのうわさ（吟遊詩人の週報）。** 2階の4部屋のうち、これだけ無い。
  素材はおつげと同じなので、罠22（今日から数えない）をそのまま使える。
- **ふくろの人物・概念。** いまのふくろはプロジェクト台帳だけ
  （`fukuro/project/`）。人物と概念は分かち書きが要るので、依存を
  増やさずどこまでやるかを決めてから。
- **おつげの配達。** いまは `otsuge/` に置くだけ。外に出す口は、掟4に並ぶ
  3例（`00_思考`・Discord秘書・agent-tracer）がどれもそこで止まっているので、
  読む習慣がついてから考える。
- **型検査を走らせていない。** `tsc` は npm 依存になるので入れていない。
  エディタの LSP 頼み。CI を建てるなら `npx -y typescript` を検討する。

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
bin/utsushi.ts --quiet
bin/kotonoha.ts --quiet
bin/sotonokoe.ts --quiet
bin/teato.ts --quiet
bin/fukuro.ts --quiet
bin/status.ts --quiet
bin/otsuge.ts --quiet
bin/ruula.ts --rebuild && bin/ruula.ts "検索語"
```

まとめて流すなら `bin/yorunotobari.ts`。順番に意味がある（ふくろは
拠点に書かれたものを畳むので必ず最後）。

見る道具（城・つよさ）は拠点に書かないので、冪等ではなく描けるかを見る:

```bash
bin/tsuyosa.ts --plain つよさ        # 枠と数が揃っているか
bin/tsuyosa.ts --plain ルーラ 冪等    # 抜粋に検索語が残っているか
bin/shiro.ts --no-open &             # 城を建てて
curl -s localhost:8823/api/summary | head -c 200
fuser -k 8823/tcp                    # 止めるとき（pkill は自分も殺す）
```

すずのおとは拠点に書かないので、鳴るかと、黙って終わるかを見る:

```bash
echo '{"hook_event_name":"SessionStart","cwd":"'$PWD'"}' | bin/suzu.ts
echo '{"hook_event_name":"UserPromptSubmit","prompt":"あの話どこだっけ"}' | bin/suzu.ts
echo 'こわれた JSON' | bin/suzu.ts; echo "終了コード $?"   # 0 であること
bin/suzu.ts --tameshi                                     # 鳴りすぎていないか
```

ことのはを触ったら、混入が戻っていないかも見る:

```bash
grep -c '<command-name>\|<local-command\|<task-notification>' \
  ~/Documents/Obsidian/kyoten/kotonoha/*/*.md   # すべて 0 であること
```

## 使い方

```bash
bin/utsushi.ts              # ぼうけんのしょを写す
bin/utsushi.ts --dry-run    # 書かずに結果だけ
bin/utsushi.ts --since 2026-08-01
bin/utsushi.ts --quiet      # 1行だけ（定時便用）

bin/kotonoha.ts             # ことのはを抜く（引数は utsushi と同じ）

bin/sotonokoe.ts            # そとのこえを集める（引数は utsushi と同じ）
bin/sotonokoe.ts --source bluesky            # ソースを絞る
bin/sotonokoe.ts --site http://127.0.0.1:8000  # 手元の polidog.jp を見る

bin/teato.ts                # てのあと（引数は utsushi と同じ）
bin/fukuro.ts               # ふくろ（--dry-run / --quiet）
bin/status.ts               # ステータス・とくぎ・年表（同上）
bin/otsuge.ts               # 週ごとのおつげ（同上）

bin/yorunotobari.ts         # 定時便（全部流してきょうかいまで）
bin/yorunotobari.ts --dry-run
bin/yorunotobari.ts --no-commit

bin/ruula.ts "検索語"        # ルーラ。素材が新しければ勝手に刻み直す
bin/ruula.ts "検索語" --room kotonoha --project polidog/kyoten --since 2026-09-01
bin/ruula.ts --rebuild      # 刻み直すだけ
bin/ruula.ts --stats        # 索引の中身を数える
bin/ruula.ts --rebuild --quiet  # 刻み直して1行だけ（定時便用）

bin/shiro.ts                # 城。拠点のまとめを出す（127.0.0.1 固定）
bin/shiro.ts --port 9999 --no-open

bin/tsuyosa.ts              # つよさ。端末で拠点を歩く
bin/tsuyosa.ts とくぎ php    # 部屋と行き先を指して始める
bin/tsuyosa.ts --plain おつげ        # 対話せず1回だけ描く
bin/tsuyosa.ts --plain ルーラ 冪等

bin/suzu.ts                 # 呼び方だけ出す（hooks から stdin で呼ばれる）
bin/suzu.ts --tameshi       # ことのはに当てて、何割で鳴るか数える
```

`KYOTEN` 環境変数で拠点の場所を変えられる（既定 `~/Documents/Obsidian/kyoten`）。
reading-notes の場所は `KYOTEN_READING`。

## 応答

日本語で。技術用語とコード識別子は原文のまま。
