import * as typewriter from "./typewriter.ts";
import type { LyricPhraseEntry, SongOption } from "./textalive.ts";
import { DEFAULT_SONG } from "./textalive.ts";

export type Screen = "title" | "play" | "result";
// boot: ブートシーケンスをタイプ中（loading track行の実読み込み待ちも含む）
// / waitingForStart: ブート完了、入力待ち（曲は未再生） / lyrics: 曲再生中、
// 歌詞タイプ演出中
export type Phase = "boot" | "waitingForStart" | "lyrics";
export type ColorTheme = "GREEN" | "AMBER" | "WHITE";

export const COLOR_THEMES: ColorTheme[] = ["GREEN", "AMBER", "WHITE"];

// ブート内部の進行段階。pre/postは複数行を一括タイプ、trackは「loading
// track: ...」の1行のみ、waitingTrackはタイプすべき行がなくスピナーのみ
// 表示する待機区間。
type BootStage = "pre" | "track" | "waitingTrack" | "post";

// loading track行のタイプが終わってから、実データ（歌詞フレーズ）が届くまでの
// 最短表示時間。読み込みがこれより速く終わっても、体感上「読み込んでいる」と
// 分かる程度はスピナーを見せる。読み込みがこれより遅ければ、届くまで延長する。
const MIN_LOADING_TRACK_DISPLAY_MS = 1000;

function buildPreTrackLines(): string[] {
  return [
    "cd AIDDProcon",
    "booting AIDDProcon terminal...",
    "mounting /dev/lyrics...",
    "loading modules: TYPEWRITER, SCROLLBACK, THEME... OK",
    "handshake: TextAlive API... OK",
  ];
}

// 曲名・アーティスト名はSongOption側で決め打ちのデータのため、この行自体の
// テキストは開始時点で完全に確定する。この行のタイプ開始と同時に実際の
// 読み込み（textalive.loadSong）を発行することで、演出上「読み込んでいる」と
// 主張するタイミングと、実際に読み込みを始めるタイミングを一致させる。
function buildTrackLine(song: SongOption): string {
  return `loading track: ${song.title} — ${song.artist}`;
}

function buildPostTrackLines(color: ColorTheme): string[] {
  return [`color ${color}`, "mode AutoView", "calibrating cursor blink... OK"];
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
  trackLoaded: boolean;
  phraseCursor: number;
  activePhrase: LyricPhraseEntry | null;
  consoleLines: string[];
  currentLine: string | null;
  bootTyper: typewriter.SequentialTyperState | null;
  shutdownTyper: typewriter.SequentialTyperState | null;
  bootStage: BootStage;
  // 現在のbootTyperより前に確定済みの行。bootTyperを複数回作り直す（pre→track→
  // post）ため、typewriter.getVisibleLines().completedは直近のtyper内の行しか
  // 返さない。それより前の確定済み行をここに保持し、毎フレーム連結する。
  bootCommittedPrefix: string[];
  loadingTrackElapsedMs: number;
  // trueの間、実際の読み込み（textalive.loadSong）が未発行。loading track行の
  // タイプ開始と同時にtrueになる。index.ts側が毎フレーム確認し、発行したら
  // takePendingTrackLoadで消費する。
  pendingTrackLoad: boolean;
  // このブート試行で実際に読み込みを発行したか（RETRYのように読み込み済み
  // データを使い回す場合はfalseのまま）。falseならwaitingTrackの最低表示時間を
  // 適用せず、trackLoaded済みの行タイプ完了後すぐに次へ進む。
  trackLoadTriggered: boolean;
}

export function createInitialState(
  phrases: LyricPhraseEntry[],
  keepSettings?: GameSettings,
  trackLoaded = false,
): GameState {
  return {
    screen: "title",
    phase: "boot",
    settings: keepSettings ? { ...keepSettings } : { color: "GREEN", song: DEFAULT_SONG },
    phrases,
    trackLoaded,
    phraseCursor: 0,
    activePhrase: null,
    consoleLines: [],
    currentLine: null,
    bootTyper: null,
    shutdownTyper: null,
    bootStage: "pre",
    bootCommittedPrefix: [],
    loadingTrackElapsedMs: 0,
    pendingTrackLoad: false,
    trackLoadTriggered: false,
  };
}

export function setColor(state: GameState, color: ColorTheme): void {
  state.settings.color = color;
}

// 選曲・Start押下、いずれの経路でも読み込み済みデータを破棄するための共通処理。
function resetTrackData(state: GameState): void {
  state.trackLoaded = false;
  state.phrases = [];
}

export function setSong(state: GameState, song: SongOption): void {
  state.settings.song = song;
  resetTrackData(state);
}

// Start押下時に呼ぶ。読み込み済みの曲でも常に読み込み直す（単純さ優先）ため、
// 古いtrackLoadedを確実に落としておく。実際のtextalive.loadSong発行は、
// loading track行のタイプ開始と同時（updateBootPhase→pendingTrackLoad）まで
// 遅延される。RETRYからは呼ばない（読み込み済みデータをそのまま使い、最低
// 表示時間の待機を挟まないため）。
export function beginTrackLoad(state: GameState): void {
  resetTrackData(state);
}

// スタート／リトライ操作から呼ぶ。プレイ画面の疑似ターミナルが最初に流す
// ブートシーケンスを準備する。この時点ではまだ曲を再生しない（入力待ちを挟む）。
export function startBoot(state: GameState): void {
  state.phase = "boot";
  state.phraseCursor = 0;
  state.activePhrase = null;
  state.consoleLines = [];
  state.currentLine = null;
  state.bootStage = "pre";
  state.bootCommittedPrefix = [];
  state.loadingTrackElapsedMs = 0;
  state.trackLoadTriggered = false;
  state.bootTyper = typewriter.createSequentialTyper(buildPreTrackLines());
}

// 実際に読み込みを発行すべきタイミングになったかどうかを消費する。trueが
// 返るのは一度きり（呼んだ側でtextalive.loadSongを発行する責務を持つ）。
export function takePendingTrackLoad(state: GameState): boolean {
  if (!state.pendingTrackLoad) return false;
  state.pendingTrackLoad = false;
  return true;
}

export function updateBootPhase(state: GameState, dtMs: number, nowMs: number): void {
  if (state.bootStage === "waitingTrack") {
    state.loadingTrackElapsedMs += dtMs;
    // スピナーは新しい行としてではなく、loading track行そのものの続き
    // （アーティスト名の右に空白を挟んだ位置）として同一行に表示する。
    // 駆動源にはloadingTrackElapsedMs（0起点の経過ms）ではなくnowMs（rAFの
    // タイムスタンプ）を使う。ステータスバーの#lc-spinnerがnow駆動のため、
    // 0起点だと同じ記号列・同じ間隔でありながら位相がずれ、2つのスピナーが
    // 別々の向きを向いてしまう。
    state.currentLine =
      `${buildTrackLine(state.settings.song)} ${typewriter.computeSpinnerFrame(nowMs)}`;
    if (state.trackLoaded && state.loadingTrackElapsedMs >= MIN_LOADING_TRACK_DISPLAY_MS) {
      state.currentLine = null;
      state.bootCommittedPrefix = [...state.bootCommittedPrefix, buildTrackLine(state.settings.song)];
      state.consoleLines = state.bootCommittedPrefix;
      state.bootStage = "post";
      state.bootTyper = typewriter.createSequentialTyper(buildPostTrackLines(state.settings.color));
    }
    return;
  }

  if (!state.bootTyper) return;
  typewriter.advanceSequentialTyper(state.bootTyper, dtMs);
  const visible = typewriter.getVisibleLines(state.bootTyper);
  state.consoleLines = [...state.bootCommittedPrefix, ...visible.completed];
  state.currentLine = state.bootTyper.finished ? null : visible.current;
  if (!state.bootTyper.finished) return;

  state.bootTyper = null;

  if (state.bootStage === "pre") {
    state.bootCommittedPrefix = state.consoleLines;
    state.bootStage = "track";
    state.bootTyper = typewriter.createSequentialTyper([buildTrackLine(state.settings.song)]);
    if (!state.trackLoaded) {
      state.pendingTrackLoad = true;
      state.trackLoadTriggered = true;
    }
  } else if (state.bootStage === "track") {
    if (state.trackLoaded && !state.trackLoadTriggered) {
      // RETRY等、今回のブートで読み込みを発行していない（=読み込み済み
      // データをそのまま使う）場合は、最低表示時間を適用せず即座に進める。
      state.bootCommittedPrefix = state.consoleLines;
      state.bootStage = "post";
      state.bootTyper = typewriter.createSequentialTyper(buildPostTrackLines(state.settings.color));
    } else {
      // loading track行はまだconsoleLinesへ確定しない。waitingTrack中は
      // 「行全文＋空白＋スピナー」を同一行のcurrentLineとして表示し続ける
      // ため、いったんconsoleLinesから外す（bootCommittedPrefixは直前の
      // pre行群のまま据え置く）。
      state.consoleLines = state.bootCommittedPrefix;
      state.bootStage = "waitingTrack";
      state.loadingTrackElapsedMs = 0;
    }
  } else if (state.bootStage === "post") {
    state.consoleLines = [...state.consoleLines, WAITING_FOR_START_HINT];
    state.phase = "waitingForStart";
  }
}

// 実データ（歌詞フレーズ）到着時に呼ぶ。ブート進行中の状態を破壊しないよう、
// stateを丸ごと差し替えず必要な項目だけを更新する。ブート進行（waitingTrack
// からの復帰）はupdateBootPhase側で毎フレーム判定する。
export function completeTrackLoad(state: GameState, phrases: LyricPhraseEntry[]): void {
  state.phrases = phrases;
  state.trackLoaded = true;
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
