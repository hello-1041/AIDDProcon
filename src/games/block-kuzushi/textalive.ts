import { Player, type IPlayerApp } from "textalive-app-api";

// 「ロンリーラン」 / 海風太陽（マジカルミライ2025 課題曲）
// TextAlive App API公式サンプル（textalive-app-basic）で使用されている動作確認済みの楽曲。
// 水切リズム（../mizuki-rhythm/textalive.ts）と同じ値。ゲーム間でコード共有はしない方針
// （モジュール独立性を優先）のため、値のみ複製する。
export const SAMPLE_SONG_URL = "https://piapro.jp/t/CyPO/20250128183915";
export const SAMPLE_SONG_OPTIONS = {
  video: {
    beatId: 4694280,
    chordId: 2830735,
    repetitiveSegmentId: 2946483,
    lyricId: 67815,
    lyricDiffId: 20659,
  },
};

export const DEFAULT_VOLUME = 10; // 楽曲の再生音量 [0-100]

// 1曲につき1回だけonSongEndを呼ぶための二重発火防止フラグ。
// スタート／リトライ操作のたびにstartPlaybackから必ずリセットする必要があるため、
// モジュールスコープに置く（水切リズムのtextalive.tsと同じ構造）。
let ended = false;

// 実際に再生が始まった（onPlay）ことを確認できるまでは終了判定を行わない
// （onVideoReady直後はplayer.video.endTimeが未確定なことがあるため）。
let started = false;

// 動画オブジェクトの構築完了（onVideoReady）と、再生用Timerの準備完了（onTimerReady）は
// 発火タイミングが異なりうるため、両方揃うまでonReadyを呼ばない。
let videoReady = false;
let timerReady = false;

function notifyReadyIfComplete(onReady: () => void): void {
  if (videoReady && timerReady) onReady();
}

function finishSong(onSongEnd: () => void): void {
  if (!started || ended) return;
  ended = true;
  onSongEnd();
}

export function checkSongEnd(player: Player, songPosition: number, onSongEnd: () => void): void {
  if (!started || ended) return;
  const endTime = player.video.endTime;
  if (!Number.isFinite(endTime) || endTime <= 0) return;
  if (songPosition >= endTime) finishSong(onSongEnd);
}

export function createPlayer(
  token: string,
  onReady: () => void,
  onSongEnd: () => void,
): Player {
  const player = new Player({
    app: { token },
    // 水切リズムの#mediaとは別要素。同一DOM上に両ゲームのPlayerが共存するため、
    // グローバル単一IDの奪い合いを避けて完全に分離する。
    mediaElement: "#bk-media",
  });

  player.volume = DEFAULT_VOLUME;

  player.addListener({
    onAppReady: (app: IPlayerApp) => {
      if (!app.managed) {
        // Customizer外の単独起動時は、仮の楽曲を明示的に読み込む
        player.createFromSongUrl(SAMPLE_SONG_URL, SAMPLE_SONG_OPTIONS);
      }
    },
    onVideoReady: () => {
      ended = false;
      started = false;
      videoReady = true;
      notifyReadyIfComplete(onReady);
    },
    onTimerReady: () => {
      timerReady = true;
      notifyReadyIfComplete(onReady);
    },
    onPlay: () => {
      started = true;
    },
    onTimeUpdate: (position: number) => {
      checkSongEnd(player, position, onSongEnd);
    },
    // 水切リズムのtextalive.ts（createPlayer内onStop）と同じ根拠：textalive-app-apiの
    // 内部実装は、再生位置がplayer.video.duration（実際の音声の長さ）に達すると自ら
    // timer.stop()を呼び、onStop発火直前にseek(0)で再生位置を0へ巻き戻す。endTimeが
    // durationより大きい曲ではcheckSongEndの`position >= endTime`が一度も成立しないまま
    // 位置が0に戻ってしまい終了を検知できなくなるため、この巻き戻し前にライブラリ自身が
    // 発火するonStopを、position比較に依存しない本命の終了検知経路として使う。
    onStop: () => {
      finishSong(onSongEnd);
    },
  });

  return player;
}

export interface LyricWordEntry {
  text: string;
  startTime: number;
  charCount: number;
  kanjiRatio: number; // U+4E00–U+9FFF判定による漢字文字の比率 [0-1]
}

const KANJI_RANGE_START = 0x4e00;
const KANJI_RANGE_END = 0x9fff;

function isKanji(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code >= KANJI_RANGE_START && code <= KANJI_RANGE_END;
}

// onReady後に1回だけ呼ぶ。player.video.wordsを走査し、各単語の文字数・漢字比率を
// 事前計算しておく（水切リズムのcomputeInterludeRangesと同じ「起動時に1回だけ
// 事前計算する」パターン）。
export function computeLyricWordEntries(player: Player): LyricWordEntry[] {
  return player.video.words.map((word) => {
    const charCount = word.charCount;
    const kanjiCount = word.children.filter((c) => isKanji(c.text)).length;
    const kanjiRatio = charCount > 0 ? kanjiCount / charCount : 0;
    return {
      text: word.text,
      startTime: word.startTime,
      charCount,
      kanjiRatio,
    };
  });
}

// requestPlay()を呼んだあと、一定時間内にonPlay（startedフラグ）が発火しなければ
// 再試行する（水切リズムのattemptPlayと同じリトライガード）。
function attemptPlay(player: Player, retriesLeft: number): void {
  player.requestPlay();
  if (retriesLeft <= 0) return;
  setTimeout(() => {
    if (!started) attemptPlay(player, retriesLeft - 1);
  }, 400);
}

export function startPlayback(player: Player): void {
  ended = false;
  started = false;
  attemptPlay(player, 2);
}

export function restartPlayback(player: Player): void {
  ended = false;
  started = false;
  player.requestMediaSeek(0);
  attemptPlay(player, 2);
}
