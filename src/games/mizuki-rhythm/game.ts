import type { Player } from "textalive-app-api";
import {
  getOffsetMs,
  isInterlude,
  type InterludeRange,
  type JudgeThresholds,
} from "./textalive.ts";

export type Screen = "title" | "play" | "result";
export type JudgeResult = "just" | "good" | "miss";
export type NoteType = "whole" | "quarter" | "eighth" | "quarterRest";

export interface GameState {
  screen: Screen;
  currentDistance: number;
  bestDistance: number;
  lastJudge: JudgeResult | null;
  noteType: NoteType;
}

export const JUST_MIN_DISTANCE = 8; // Justの最低保証距離 [m]
export const JUST_MAX_DISTANCE = 12; // ズレ0(パーフェクト)の距離 [m]
export const GOOD_MIN_DISTANCE = 3; // Goodの最低保証距離 [m]
export const GOOD_MAX_DISTANCE = 8; // Just境界(50ms)に近いGoodの距離 [m]

export const NOTE_REST_PROBABILITY = 0.15; // 間奏中のMiss時に四分休符が選ばれる確率

export function createInitialState(): GameState {
  return {
    screen: "title",
    currentDistance: 0,
    bestDistance: 0,
    lastJudge: null,
    noteType: "whole",
  };
}

function judge(offsetMs: number | null, thresholds: JudgeThresholds): JudgeResult {
  if (offsetMs === null) return "miss";
  if (offsetMs <= thresholds.justMs) return "just";
  if (offsetMs <= thresholds.goodMs) return "good";
  return "miss";
}

function calcDistance(
  result: JudgeResult,
  offsetMs: number,
  thresholds: JudgeThresholds,
): number {
  switch (result) {
    case "just": {
      const t = 1 - offsetMs / thresholds.justMs; // 1(ズレ0) 〜 0(Just境界)
      return JUST_MIN_DISTANCE + (JUST_MAX_DISTANCE - JUST_MIN_DISTANCE) * t;
    }
    case "good": {
      const t =
        1 - (offsetMs - thresholds.justMs) / (thresholds.goodMs - thresholds.justMs);
      return GOOD_MIN_DISTANCE + (GOOD_MAX_DISTANCE - GOOD_MIN_DISTANCE) * t;
    }
    case "miss":
      return 0;
  }
}

function pickNextNoteType(interludeRanges: InterludeRange[], time: number): NoteType {
  if (isInterlude(interludeRanges, time) && Math.random() < NOTE_REST_PROBABILITY) {
    return "quarterRest";
  }
  return Math.random() < 0.5 ? "quarter" : "eighth";
}

function updateBest(state: GameState): void {
  state.bestDistance = Math.max(state.bestDistance, state.currentDistance);
}

// クリックのたびに呼ばれる。判定・距離加算・状態更新を行う（stateを直接ミューテートする）。
// 描画・演出のトリガー（バウンドアニメーション、きらめき等）はここでは行わない。
// main.ts が呼び出し直後に state.lastJudge を見て、renderモジュールの演出をトリガーする。
export function handleClick(
  state: GameState,
  player: Player,
  clickTime: number,
  thresholds: JudgeThresholds,
  interludeRanges: InterludeRange[],
): void {
  const offset = getOffsetMs(player, clickTime);
  const result = judge(offset, thresholds);
  state.lastJudge = result;

  if (result === "miss") {
    updateBest(state);
    state.currentDistance = 0; // 石が沈み、次の石がすぐ投げられる
    state.noteType = pickNextNoteType(interludeRanges, clickTime);
  } else {
    state.currentDistance += calcDistance(result, offset!, thresholds);
  }
}

// 音楽終了時のみ呼ぶ。Missの処理と異なり、currentDistanceのリセットや
// 次の音符の決定は行わず、結果確定と画面遷移のみを行う。
export function finishChallenge(state: GameState): void {
  updateBest(state);
  state.screen = "result";
}
