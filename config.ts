/**
 * config — 機械ごとに、どこまで走らせるか
 *
 * 拠点を複数の PC で共有するときの、唯一の手で書く設定。
 * 拠点（データ）ではなくリポジトリ（コード）側に置いてある ——
 * これは「どの機械が何をするか」であって、記録ではない。
 *
 * ## なぜ YAML ではないか
 *
 * 原則6（Node の標準ライブラリだけ）に当たる。Node に YAML の
 * パーサは無いので、依存を足すか自前で書くかになる。自前だと
 * **読めない行が黙って落ちる** —— `株/保有.md` を JSON から表にした
 * ときに踏んだのと同じ形（落とし穴70）。
 *
 * TypeScript ならパーサが要らず、コメントが書けて、壊れていれば
 * import した時点で落ちる。Node が直接読むので依存も増えない。
 *
 * ## 何を分けるのか
 *
 * 道具は3種類ある。
 *
 *   1. **機械ごと** —— 手元のログ・git・ブラウザ履歴を見る（sessions・me・
 *      aibo・work・reading）。**どの機械でも走らせる。** 走らせないと、
 *      その機械の記録は拠点に入らない。
 *   2. **外から** —— polidog.jp・SNS・Yahoo・HN を見る（posts・stock・
 *      news）。どの機械で走らせても同じものが取れるので、**1台でいい**。
 *   3. **拠点だけ** —— 畳む側と、LLM に書かせる側（entities・profile・
 *      weekly・trend・diary・events・outlook・guest・picks）。素材が
 *      揃っていれば、どの機械で走らせても同じ結果になる。**1台でいい**
 *      （書かせる側は API を叩くので、2台で走らせるのは無駄）。
 *
 * ## 母艦は切り替えられる
 *
 * 「1台でいい」ものを持っている側が母艦。切り替えるときは、この表の
 * 2行を書き換えるだけでいい —— 拠点の中身は動かさない。
 */

/** 機械ひとつぶんの設定。 */
export interface Machine {
  /** 走らせる道具。ここに無い名前は、その機械では飛ばす。 */
  readonly 走らせる: readonly string[];
  /** 全文検索の索引を刻み直すか。索引は同期されないので、読む機械では true。 */
  readonly 索引: boolean;
  /**
   * 拠点に git を打つか。
   *
   * Obsidian Sync は**ドットで始まるものを運ばない**ので、`.git` は機械ごとに
   * 別物になる。2台で打つと同じ内容について2本の履歴ができるので、**1台だけ**
   * true にする。もう1台は Obsidian のバージョン履歴に任せる。
   */
  readonly commit: boolean;
  /** git リポジトリの置き場。既定 `~/ghq`（環境変数 KYOTEN_GHQ が優先）。 */
  readonly ghq?: string;
  /** Chrome の設定ディレクトリ。既定 `~/.config/google-chrome`。 */
  readonly chrome?: string;
}

// ---------------------------------------------------------------- 道具の束

/** 手元のログ・git・ブラウザから集める。**どの機械でも走らせる。** */
export const あつめる = ["sessions", "me", "aibo", "work", "reading"] as const;

/** 外へ取りに行く。1台でいい。 */
export const そとから = ["posts", "stock", "news"] as const;

/** 拠点を畳む。1台でいい。 */
export const たたむ = ["entities", "profile", "weekly", "trend"] as const;

/** LLM に書かせる（追記のみ）。1台でいい。 */
export const かかせる = ["diary", "events", "outlook", "guest", "picks"] as const;

/** 全部入り。母艦の既定。 */
export const ぜんぶ: readonly string[] = [
  ...あつめる,
  ...そとから,
  ...たたむ,
  ...かかせる,
];

/**
 * 集めるだけ。畳みも、外からも、書かせもしない。
 *
 * 母艦でない機械の既定。この機械の記録は `素材/<hostname>/` に置かれ、
 * Obsidian Sync で母艦へ渡って、向こうで畳まれる。
 */
export const あつめるだけ: readonly string[] = [...あつめる];

// ---------------------------------------------------------------- 機械の表

/**
 * hostname で引く。
 *
 * 載っていない機械は `既定` で走る（集めるだけ・索引あり・commit なし）。
 * 黙って既定に落ちると気づけないので、走るたびに1行名指しする
 * （落とし穴65 —— 何もしなかったときも黙らない）。
 */
export const MACHINES: Record<string, Machine> = {
  poliomarchy: {
    走らせる: ぜんぶ,
    索引: true,
    commit: true,
  },

  // ノート側（Intel）。いまは集める側 —— 手元のログ・git・Chrome から
  // `素材/poli-omarchy-intel/` に落として、畳みは母艦に任せる。
  //
  // 母艦をこちらへ移すときは、この行と上の poliomarchy で
  // `ぜんぶ` / `あつめるだけ` と `commit` を入れ替える。拠点の中身は動かさない。
  "poli-omarchy-intel": {
    走らせる: あつめるだけ,
    索引: true,
    commit: false,
  },
};

/** 表に載っていない機械の既定。**安全側** —— 集めるだけで、何も畳まない。 */
export const 既定: Machine = {
  走らせる: あつめるだけ,
  索引: true,
  commit: false,
};
