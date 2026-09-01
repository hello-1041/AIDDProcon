import * as typewriter from "./typewriter.ts";
import type { LyricPhraseEntry, SongInfo, SongOption } from "./textalive.ts";
import { DEFAULT_SONG } from "./textalive.ts";

export type Screen = "title" | "play" | "result";
// boot: ブートシーケンスをタイプ中 / waitingForStart: ブート完了、入力待ち（曲は未再生）
// / lyrics: 曲再生中、歌詞タイプ演出中
export type Phase = "boot" | "waitingForStart" | "lyrics";
export type ColorTheme = "GREEN" | "AMBER" | "WHITE";

export const COLOR_THEMES: ColorTheme[] = ["GREEN", "AMBER", "WHITE"];

// ブートシーケンス固定行。曲名・アーティスト名は、実際に読み込んだ楽曲
// データ（textalive.getSongInfo）をそのまま差し込む。固定フレーバー行の
// 中に実データを混ぜることで、「その場で読み込んでいる」感を出す狙い。
function buildBootLines(color: ColorTheme, songInfo: SongInfo | null): string[] {
  const trackLine = songInfo
    ? `loading track: ${songInfo.name} — ${songInfo.artist}`
    : "loading track: (no song loaded)";
  return [
    "cd AIDDProcon",
    "booting AIDDProcon terminal...",
    "mounting /dev/lyrics...",
    "loading modules: TYPEWRITER, SCROLLBACK, THEME... OK",
    "handshake: TextAlive API... OK",
    trackLine,
    `color ${color}`,
    "mode AutoView",
    "calibrating cursor blink... OK",
  ];
}

// ブート完了後、曲再生を開始する前に表示する入力待ちの一言。
// フィードバック1.3：ブートと曲再生を並行させると、イントロが短い曲で歌詞が
// バースト表示される不具合があったため、直列化（入力待ちを挟む）に変更した。
const WAITING_FOR_START_HINT = "press any key to continue";

const SHUTDOWN_LINES = [
  "saving session... (nothing to save)",
  "unmounting AIDDProcon...",
  "terminal closed.",
];

export interface GameSettings {
  color: ColorTheme;
  song: SongOption;
}

export interface GameState {
  screen: Screen;
  phase: Phase;
  settings: GameSettings;
  phrases: LyricPhraseEntry[];
  songInfo: SongInfo | null;
  phraseCursor: number;
  activePhrase: LyricPhraseEntry | null;
  consoleLines: string[];
  currentLine: string | null;
  bootTyper: typewriter.SequentialTyperState | null;
  shutdownTyper: typewriter.SequentialTyperState | null;
}

export function createInitialState(
  phrases: LyricPhraseEntry[],
  keepSettings?: GameSettings,
  songInfo: SongInfo | null = null,
): GameState {
  return {
    screen: "title",
    phase: "boot",
    settings: keepSettings ? { ...keepSettings } : { color: "GREEN", song: DEFAULT_SONG },
    phrases,
    songInfo,
    phraseCursor: 0,
    activePhrase: null,
    consoleLines: [],
    currentLine: null,
    bootTyper: null,
    shutdownTyper: null,
  };
}

export function setColor(state: GameState, color: ColorTheme): void {
  state.settings.color = color;
}

export function setSong(state: GameState, song: SongOption): void {
  state.settings.song = song;
}

// スタート／リトライ操作から呼ぶ。プレイ画面の疑似ターミナルが最初に流す
// ブートシーケンスを準備する。この時点ではまだ曲を再生しない（入力待ちを挟む）。
export function startBoot(state: GameState): void {
  state.phase = "boot";
  state.phraseCursor = 0;
  state.activePhrase = null;
  state.consoleLines = [];
  state.currentLine = null;
  state.bootTyper = typewriter.createSequentialTyper(
    buildBootLines(state.settings.color, state.songInfo),
  );
}

export function updateBootPhase(state: GameState, dtMs: number): void {
  if (!state.bootTyper) return;
  typewriter.advanceSequentialTyper(state.bootTyper, dtMs);
  const visible = typewriter.getVisibleLines(state.bootTyper);
  state.consoleLines = visible.completed;
  state.currentLine = state.bootTyper.finished ? null : visible.current;
  if (state.bootTyper.finished) {
    state.consoleLines = [...state.bootTyper.lines, WAITING_FOR_START_HINT];
    state.currentLine = null;
    state.phase = "waitingForStart";
    state.bootTyper = null;
  }
}

// waitingForStartからの入力受理を示す一言。press any key to continueに対する応答として
// 追記する（本物のターミナルはスクロールバックを自動で消さないため、ブートログを
// クリアするのではなく、応答を積み増す形で「入力待ちが終わった」ことを表す）。
const KEY_RECEIVED_LINE = "key received.";

// 入力待ち状態から、実際に曲の再生・歌詞タイプ演出を開始する。
export function confirmStart(state: GameState): void {
  if (state.phase !== "waitingForStart") return;
  state.consoleLines = [...state.consoleLines, KEY_RECEIVED_LINE];
  state.phase = "lyrics";
}

function finalizeActivePhrase(state: GameState): void {
  if (!state.activePhrase) return;
  state.consoleLines.push(state.activePhrase.text);
  state.activePhrase = null;
  state.currentLine = null;
}

// 歌詞のフレーズ同期タイプ演出。フレーズのstartTimeが songPosition に到達した
// 瞬間だけタイプ開始をトリガーし（開始タイミングのみ同期）、以降の打鍵速度は
// 歌唱区間長に関係なく固定（typewriter.computeRevealCountを共有）。
// 次フレーズのstartTimeが打鍵完了より先に到達した場合は、現在行を強制確定
// してから次へ進める。
export function updateLyricTyping(state: GameState, songPosition: number): void {
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

// totalMs には player.video.duration（実際の音声の長さ）を渡すこと。
// player.video.endTimeは歌詞・ビート等の解析データがカバーする区間の終了時刻に
// 過ぎず、曲によってはこれより後にアウトロが続くため、進捗の分母には使わない
// （フィードバック1.2）。
export function getProgressPercent(songPosition: number, totalMs: number): number {
  if (!Number.isFinite(totalMs) || totalMs <= 0) return 0;
  return Math.min(100, Math.max(0, (songPosition / totalMs) * 100));
}

// 曲終了時に呼ぶ。リザルト画面の疑似ターミナルが最初に流すシャットダウンログを
// 準備する。
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
