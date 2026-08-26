import * as typewriter from "./typewriter.ts";
import type { LyricPhraseEntry } from "./textalive.ts";

export type Screen = "title" | "play" | "result";
export type ColorTheme = "GREEN" | "AMBER" | "WHITE" | "CYAN";
export type FontStyle = "STANDARD" | "WIDE" | "COMPACT";

export const COLOR_THEMES: ColorTheme[] = ["GREEN", "AMBER", "WHITE", "CYAN"];
export const FONT_STYLES: FontStyle[] = ["STANDARD", "WIDE", "COMPACT"];

// ブートシーケンス固定行（製造計画書2.4節で確定済み）。実設定2行（color/font）を
// はさみ込んで組み立てる。
const BOOT_FIXED_LINES = ["booting AIDDProcon terminal...", "cd AIDDProcon"];
const BOOT_TAIL_LINES = ["mode AutoView", "ready."];

function buildBootLines(color: ColorTheme, font: FontStyle): string[] {
  return [...BOOT_FIXED_LINES, `color ${color}`, `font ${font}`, ...BOOT_TAIL_LINES];
}

// シャットダウンログ固定行（製造計画書2.5節で確定済み）。
const SHUTDOWN_LINES = [
  "saving session... (nothing to save)",
  "unmounting AIDDProcon...",
  "terminal closed.",
];

export interface GameSettings {
  color: ColorTheme;
  font: FontStyle;
}

export interface GameState {
  screen: Screen;
  phase: "boot" | "lyrics";
  settings: GameSettings;
  phrases: LyricPhraseEntry[];
  // phrasesのうち、まだ開始していない先頭のインデックス。
  phraseCursor: number;
  activePhrase: LyricPhraseEntry | null;
  // 確定済み（打鍵完了済み）の行。ブート・歌詞・シャットダウンいずれの由来かを
  // 問わない共通の描画用バッファ。
  consoleLines: string[];
  // 現在タイプ中の行の、タイプ済み部分文字列。タイプ中の行がなければnull。
  currentLine: string | null;
  bootTyper: typewriter.SequentialTyperState | null;
  shutdownTyper: typewriter.SequentialTyperState | null;
  phrasesDisplayedCount: number;
}

export function createInitialState(
  phrases: LyricPhraseEntry[],
  keepSettings?: GameSettings,
): GameState {
  return {
    screen: "title",
    phase: "boot",
    settings: keepSettings ? { ...keepSettings } : { color: "GREEN", font: "STANDARD" },
    phrases,
    phraseCursor: 0,
    activePhrase: null,
    consoleLines: [],
    currentLine: null,
    bootTyper: null,
    shutdownTyper: null,
    phrasesDisplayedCount: 0,
  };
}

export function setColor(state: GameState, color: ColorTheme): void {
  state.settings.color = color;
}

export function setFont(state: GameState, font: FontStyle): void {
  state.settings.font = font;
}

// スタートボタン押下時に呼ぶ。プレイ画面の疑似ターミナルが最初に流す
// ブートシーケンスを準備する（製造計画書2.1節：ブート演出はタイトルではなく
// プレイ画面に内包する構成）。
export function startBoot(state: GameState): void {
  state.phase = "boot";
  state.phraseCursor = 0;
  state.activePhrase = null;
  state.phrasesDisplayedCount = 0;
  state.consoleLines = [];
  state.currentLine = null;
  state.bootTyper = typewriter.createSequentialTyper(
    buildBootLines(state.settings.color, state.settings.font),
  );
}

export function updateBootPhase(state: GameState, dtMs: number): void {
  if (!state.bootTyper) return;
  typewriter.advanceSequentialTyper(state.bootTyper, dtMs);
  const visible = typewriter.getVisibleLines(state.bootTyper);
  state.consoleLines = visible.completed;
  state.currentLine = state.bootTyper.finished ? null : visible.current;
  if (state.bootTyper.finished) {
    state.phase = "lyrics";
    state.bootTyper = null;
  }
}

function finalizeActivePhrase(state: GameState): void {
  if (!state.activePhrase) return;
  state.consoleLines.push(state.activePhrase.text);
  state.phrasesDisplayedCount++;
  state.activePhrase = null;
  state.currentLine = null;
}

// 歌詞のフレーズ同期タイプ演出。フレーズのstartTimeが songPosition に到達した
// 瞬間だけタイプ開始をトリガーし（開始タイミングのみ同期）、以降の打鍵速度は
// 歌唱区間長に関係なく固定（typewriter.computeRevealCountを共有）。
// 次フレーズのstartTimeが打鍵完了より先に到達した場合は、現在行を強制確定
// してから次へ進める（製造計画書2.2節）。
export function updateLyricTyping(state: GameState, songPosition: number): void {
  // phrasesの数を超えて回り続けることはないため、ループの上限は自然に収束する。
  for (;;) {
    if (state.activePhrase) {
      const nextDue = state.phrases[state.phraseCursor];
      const elapsed = songPosition - state.activePhrase.startTime;
      const forcedByNextPhrase = !!nextDue && songPosition >= nextDue.startTime;
      const naturallyComplete = typewriter.isRevealComplete(
        elapsed,
        state.activePhrase.text.length,
      );
      if (forcedByNextPhrase || naturallyComplete) {
        finalizeActivePhrase(state);
        continue;
      }
      state.currentLine = state.activePhrase.text.slice(
        0,
        typewriter.computeRevealCount(elapsed, state.activePhrase.text.length),
      );
      return;
    }

    const next = state.phrases[state.phraseCursor];
    if (next && songPosition >= next.startTime) {
      state.activePhrase = next;
      state.phraseCursor++;
      continue;
    }
    return;
  }
}

export function getProgressPercent(songPosition: number, endTime: number): number {
  if (!Number.isFinite(endTime) || endTime <= 0) return 0;
  return Math.min(100, Math.max(0, (songPosition / endTime) * 100));
}

// 曲終了時に呼ぶ。リザルト画面の疑似ターミナルが最初に流すシャットダウンログを
// 準備する（製造計画書2.5節：シャットダウン演出はリザルト画面に内包する構成）。
export function startShutdown(state: GameState): void {
  state.screen = "result";
  state.consoleLines = [];
  state.currentLine = null;
  state.shutdownTyper = typewriter.createSequentialTyper([...SHUTDOWN_LINES]);
}

export function updateShutdownPhase(state: GameState, dtMs: number): void {
  if (!state.shutdownTyper) return;
  typewriter.advanceSequentialTyper(state.shutdownTyper, dtMs);
  const visible = typewriter.getVisibleLines(state.shutdownTyper);
  state.consoleLines = visible.completed;
  state.currentLine = state.shutdownTyper.finished ? null : visible.current;
}
