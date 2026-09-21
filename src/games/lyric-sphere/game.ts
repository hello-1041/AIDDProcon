/**
 * 状態管理と点灯状態機械（製造計画書3.3・3.8）。
 *
 * 描画・投影は持たず、「いま各文字がどの状態か」だけを扱う。視野内判定に必要な
 * 投影はview.tsが担い、ここへは判定結果だけが渡る。
 */

import { RECLAIM_MS, STAR_DELAY_MS, type Placement } from "./sphere.ts";
import type { SongOption } from "./textalive.ts";
import { DEFAULT_SONG } from "./textalive.ts";

export type Screen = "title" | "play" | "result";

/**
 * セルの状態（3.3）。曲の再生に従って一方向に遷移する。
 *
 * - hidden: 文字は割り当て済み、まだ歌われていない
 * - pending: 歌われた。まだ視野に入っていない（回収可能）
 * - lit: 視野に入り、点灯が確定した
 * - star: 点灯からSTAR_DELAY_MSが経過し、背景化した
 * - lost: 回収猶予を過ぎ、点灯しなかった
 *
 * empty（文字が割り当てられていない）は配列に載らないため、型には含めない。
 */
export type CharState = "hidden" | "pending" | "lit" | "star" | "lost";

export interface GameSettings {
  song: SongOption;
  /** ジャイロ操作のトグル（3.5）。設定は状態の作り直しをまたいで引き継ぐ。 */
  gyroEnabled: boolean;
}

export interface GameState {
  screen: Screen;
  settings: GameSettings;

  /** 実データの読み込みが済んでいるか。済むまでプレイ画面は何も進めない。 */
  trackLoaded: boolean;

  /** 配置計画。ロード時に1回だけ作り、再生中は書き換えない（11章）。 */
  placement: Placement | null;

  /** 文字ごとの状態。placement.charsと同じ添字で引く。 */
  charStates: CharState[];
  /** 状態が切り替わった時刻（曲内位置ms）。演出の経過時間に使う（4.6）。 */
  changedAt: number[];

  /** 集計（3.8）。毎フレーム数え直さないよう、遷移のたびに増減させる。 */
  litCount: number;
  lostCount: number;
  pendingCount: number;

  /**
   * 次に歌われる文字の添字。hidden→pendingの走査をこの位置から進めるためのカーソル。
   * 毎フレーム全2760セルを走査しない（11章）。
   */
  nextCharCursor: number;

  /** pendingの文字の添字集合。点灯判定はこれだけを対象にする（11章）。 */
  pendingIndices: Set<number>;
}

export function createInitialSettings(): GameSettings {
  return { song: DEFAULT_SONG, gyroEnabled: false };
}

/**
 * 状態を作り直す。placementを渡せば引き継ぎ（RETRY）、nullなら未読込へ戻す。
 *
 * 選曲やり直し時は配置計画・全セルの状態・視点・オートパイロットのタイマーを
 * すべてリセットする必要がある（11章）。視点側はview.resetViewが担う。
 */
export function createInitialState(
  settings: GameSettings,
  placement: Placement | null,
): GameState {
  const count = placement?.chars.length ?? 0;
  return {
    screen: "title",
    settings,
    trackLoaded: placement !== null,
    placement,
    charStates: new Array<CharState>(count).fill("hidden"),
    changedAt: new Array<number>(count).fill(0),
    litCount: 0,
    lostCount: 0,
    pendingCount: 0,
    nextCharCursor: 0,
    pendingIndices: new Set(),
  };
}

export function setSong(state: GameState, song: SongOption): void {
  state.settings.song = song;
}

/** 実データが届いた時点で配置計画を受け取る。 */
export function completeTrackLoad(state: GameState, placement: Placement): void {
  state.placement = placement;
  state.trackLoaded = true;
  state.charStates = new Array<CharState>(placement.chars.length).fill("hidden");
  state.changedAt = new Array<number>(placement.chars.length).fill(0);
  state.litCount = 0;
  state.lostCount = 0;
  state.pendingCount = 0;
  state.nextCharCursor = 0;
  state.pendingIndices = new Set();
}

function transition(state: GameState, index: number, next: CharState, now: number): void {
  state.charStates[index] = next;
  state.changedAt[index] = now;
}

/**
 * 発声の進行を状態へ反映する（hidden → pending）。
 *
 * 文字はstartTime順に並んでいないため（フレーズ単位では昇順だが、配置の都合で
 * 配列順とは一致しうる）、カーソルによる線形前進だけに頼らず、カーソル以降の
 * 未到達分を見る。ただし走査はstartTimeが現在位置を超えた時点で打ち切る。
 */
function advanceVoicing(state: GameState, songPosition: number): void {
  const chars = state.placement!.chars;
  while (state.nextCharCursor < chars.length) {
    const index = state.nextCharCursor;
    if (chars[index].startTime > songPosition) break;
    if (state.charStates[index] === "hidden") {
      transition(state, index, "pending", songPosition);
      state.pendingIndices.add(index);
      state.pendingCount++;
    }
    state.nextCharCursor++;
  }
}

/**
 * 回収猶予の期限切れを処理する（pending → lost）。
 *
 * 空白にはせず、極薄のシルエットで残す（3.3）。何を見逃したかが形として分かる
 * 必要があるため（3.8）。
 */
function expireReclaim(state: GameState, songPosition: number): void {
  const chars = state.placement!.chars;
  for (const index of state.pendingIndices) {
    if (songPosition - chars[index].startTime <= RECLAIM_MS) continue;
    transition(state, index, "lost", songPosition);
    state.pendingIndices.delete(index);
    state.pendingCount--;
    state.lostCount++;
  }
}

/** 星化（lit → star）。文字は消さず、輝度を落として背景の星として残す（3.3）。 */
function advanceStars(state: GameState, songPosition: number, litIndices: number[]): void {
  for (const index of litIndices) {
    if (state.charStates[index] !== "lit") continue;
    if (songPosition - state.changedAt[index] < STAR_DELAY_MS) continue;
    transition(state, index, "star", songPosition);
  }
}

/**
 * 点灯（pending → lit）。視野内判定の結果を受け取って確定させる。
 *
 * isVisibleはview側の投影を使ったコールバック。pendingのセルだけを対象にする
 * （11章）。戻り値は、この呼び出しで新たに点灯した文字の添字（点灯演出の
 * トリガに使う。4.6）。
 */
export function applyLighting(
  state: GameState,
  songPosition: number,
  isVisible: (index: number) => boolean,
): number[] {
  if (!state.placement) return [];
  const litNow: number[] = [];

  for (const index of state.pendingIndices) {
    if (!isVisible(index)) continue;
    transition(state, index, "lit", songPosition);
    litNow.push(index);
  }

  for (const index of litNow) {
    state.pendingIndices.delete(index);
    state.pendingCount--;
    state.litCount++;
  }

  return litNow;
}

/**
 * 毎フレームの状態更新。点灯（applyLighting）はview側の投影が要るため分けてある。
 * 呼び出し順は advanceVoicing → 点灯 → 期限切れ・星化 とする（発声と同フレームで
 * 視野内にあれば即座に点灯し、lostへは落とさない）。
 */
export function updateBefore(state: GameState, songPosition: number): void {
  if (!state.placement) return;
  advanceVoicing(state, songPosition);
}

export function updateAfter(
  state: GameState,
  songPosition: number,
  visibleLitIndices: number[],
): void {
  if (!state.placement) return;
  expireReclaim(state, songPosition);
  advanceStars(state, songPosition, visibleLitIndices);
}

/**
 * 点灯率（3.8）。「見た範囲」として提示するものであり、合否の判定には使わない。
 */
export function getLightPercent(state: GameState): number {
  const total = state.placement?.chars.length ?? 0;
  if (total === 0) return 0;
  return Math.round((state.litCount / total) * 100);
}

/**
 * いま予兆を出すべきフレーズの先頭文字の添字を返す（4.6）。無ければnull。
 *
 * 予兆は前のフレーズを歌っている最中から重ねて出す必要があるため（1.3(3)）、
 * 「まだ歌われていない直近のフレーズ頭」をPREVIEW_MSの窓で拾う。
 */
export function previewHeadIndex(
  state: GameState,
  songPosition: number,
  previewMs: number,
): number | null {
  const placement = state.placement;
  if (!placement) return null;

  for (const head of placement.phraseHeads) {
    const startTime = placement.chars[head].startTime;
    if (startTime < songPosition) continue;
    // 先頭から順に見るため、最初に見つかった未来のフレーズ頭が直近のもの。
    return startTime - songPosition <= previewMs ? head : null;
  }
  return null;
}

/**
 * オートパイロットが向かう文字の添字を返す（3.6）。無ければnull。
 *
 * 向かう先は「いま読ませたいフレーズ」の中央の文字とする。先頭に向けると、続く
 * 文字が視野の端から流れ出る（ROW_CHARS_MAX＝20文字は方位角60°を占め、狭い側の
 * 水平視野と同じ幅であるため。3.2）。中央へ向ければ1行が視野に収まる。
 *
 * 対象フレーズの選び方は予兆（4.6）と揃える。すなわち、次フレーズの発声が
 * previewMs以内に迫っていればそちらへ移り、そうでなければ現に歌っているフレーズに
 * 留まる。前奏中は第1フレーズを向き続ける（4.1。何も出ない時間を作らない）。
 */
export function autopilotTargetIndex(
  state: GameState,
  songPosition: number,
  previewMs: number,
): number | null {
  const placement = state.placement;
  if (!placement) return null;
  const heads = placement.phraseHeads;
  if (heads.length === 0) return null;

  // 既に始まっている最後のフレーズを探しつつ、次フレーズが予兆窓に入っていれば
  // そちらへ乗り換える。
  let target = -1;
  for (let i = 0; i < heads.length; i++) {
    const startTime = placement.chars[heads[i]].startTime;
    if (startTime <= songPosition) {
      target = i;
      continue;
    }
    if (startTime - songPosition <= previewMs) target = i;
    break;
  }
  if (target < 0) target = 0; // 前奏中

  const start = heads[target];
  const end = target + 1 < heads.length ? heads[target + 1] : placement.chars.length;
  return start + Math.floor((end - start - 1) / 2);
}

/**
 * 前奏中に示し続ける第1フレーズの先頭（4.1）。
 *
 * 第1フレーズの歌い出しが再生位置の十数秒後にある曲が実在するため、前奏中に
 * 何も出ない時間を作らない（11章）。
 */
export function introHeadIndex(state: GameState, songPosition: number): number | null {
  const placement = state.placement;
  if (!placement || placement.phraseHeads.length === 0) return null;
  const head = placement.phraseHeads[0];
  return songPosition < placement.chars[head].startTime ? head : null;
}
