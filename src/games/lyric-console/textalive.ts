import { Player, type IPlayerApp } from "textalive-app-api";

// 既存2作（水切リズム・ブロック崩し）と同じサンプル楽曲を流用する（製造計画書2.1節）。
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
// モジュールスコープに置く（水切リズム・ブロック崩しと同じ設計）。
let ended = false;

// 実際に再生が始まった（onPlay）ことを確認できるまでは終了判定を行わない
// （position=0, endTime=0 の早すぎる誤検知を防ぐ）。
let started = false;

// 動画オブジェクトの構築完了（onVideoReady）と、再生用Timerの準備完了（onTimerReady）は
// 発火タイミングが異なりうるため、両方揃うまでスタートボタンを有効化しない。
let videoReady = false;
let timerReady = false;

function notifyReadyIfComplete(onReady: () => void): void {
  if (videoReady && timerReady) onReady();
}

// 一度だけonSongEndを呼ぶための共通ガード。checkSongEndとonStopの両方から
// 呼ばれうるため、ここに集約する。
function finishSong(onSongEnd: () => void): void {
  if (!started || ended) return;
  ended = true;
  onSongEnd();
}

// 曲の終端に達したかどうかを判定し、達していれば一度だけonSongEndを呼ぶ。
// onStopが本命の検知経路のため、こちらは補助的なポーリングに留める。
//
// 比較対象はplayer.video.endTimeではなくplayer.video.duration（実際の音声の
// 長さ）を使う。endTimeは歌詞・ビート等の解析データがカバーする区間の終了
// 時刻に過ぎず、曲によってはこれより後にアウトロが続く。endTimeを基準に
// すると、アウトロの手前で「曲が終わった」と誤検知し、リザルト画面が
// アウトロと被って表示されてしまう不具合があった（フィードバック1.2）。
export function checkSongEnd(player: Player, songPosition: number, onSongEnd: () => void): void {
  if (!started || ended) return;
  const duration = player.video.duration;
  if (!Number.isFinite(duration) || duration <= 0) return;
  if (songPosition >= duration) finishSong(onSongEnd);
}

export function createPlayer(
  token: string,
  onReady: () => void,
  onSongEnd: () => void,
): Player {
  const player = new Player({
    app: { token },
    // 水切リズムの#media、ブロック崩しの#bk-mediaとは別IDに分離する。
    // 同一DOM上に複数Playerが共存するため、グローバル単一IDの奪い合いを避ける。
    mediaElement: "#lc-media",
    // ボーカル音量メーター（フィードバック3.2）でgetVocalAmplitude/
    // getMaxVocalAmplitudeを使うために必要。省略すると常に0が返り、
    // メーターがまったく動かない。
    vocalAmplitudeEnabled: true,
  });

  player.volume = DEFAULT_VOLUME;

  player.addListener({
    onAppReady: (app: IPlayerApp) => {
      if (!app.managed) {
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
    // onStopは、ライブラリが内部でtimer.stop()→seek(0)する直前に発火する、
    // position比較に依存しない確実な終了シグナル。player.video.endTimeが
    // durationより大きい曲でcheckSongEndのposition>=endTime判定が一度も
    // 成立しないまま位置が0に戻るケースへの対策として、本命の検知経路にする
    // （水切リズム・ブロック崩し両方と同じ設計）。
    onStop: () => {
      finishSong(onSongEnd);
    },
  });

  return player;
}

export interface LyricPhraseEntry {
  text: string;
  startTime: number;
}

// onReady後に一度だけ呼ぶ。player.video.phrasesを走査し、タイプ演出に
// 必要な最小限の情報（本文とstartTime）だけを取り出す。
export function computeLyricPhraseEntries(player: Player): LyricPhraseEntry[] {
  return player.video.phrases
    .map((phrase) => ({ text: phrase.text, startTime: phrase.startTime }))
    .filter((entry) => entry.text.length > 0);
}

// requestPlay()を呼んだあと、一定時間内にonPlay（startedフラグ）が発火しなければ
// 再試行する（初回起動で音楽が鳴らない不具合への保険。水切リズム・ブロック崩しと同じ）。
function attemptPlay(player: Player, retriesLeft: number): void {
  player.requestPlay();
  if (retriesLeft <= 0) return;
  setTimeout(() => {
    if (!started) attemptPlay(player, retriesLeft - 1);
  }, 400);
}

// 「スタート」操作・「もう一度遊ぶ」操作、いずれからも呼ぶ唯一の再生開始経路。
// このコンテンツでは、waitingForStart（press any key to continue）へ到達する時点で
// 必ず再生位置が0になっている（初回はまだ再生していないため0。RETRY後の場合も、
// 結果画面には曲の終了（onStop、またはTITLE操作のrequestStop）を経てからしか
// 到達しないため、いずれも内部で位置0まで巻き戻し済み）。そのためrequestMediaSeekは
// 呼ばない。
//
// 呼ばない理由はもう一つある。requestMediaSeekの直後にrequestPlayを呼ぶと、
// シークが内部的に発行するpause()とplay()が競合し、
// "The play() request was interrupted by a call to pause()." で再生が失敗し、
// リトライを尽くしても再生が始まらないまま固まる不具合を実機で確認したため
// （水切リズム・ブロック崩しのrestartPlaybackと同じ実装だが、あちらはリトライ時のみ
// 踏む経路のため顕在化しにくかった。このコンテンツはブート→入力待ちを毎回挟む設計上、
// 常にこの経路を通るため、レースに晒される頻度が高かった）。
export function startPlayback(player: Player): void {
  ended = false;
  started = false;
  attemptPlay(player, 2);
}
