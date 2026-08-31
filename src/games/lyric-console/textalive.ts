import { Player, type IPlayerApp, type PartialVideoEntry } from "textalive-app-api";

export interface SongOption {
  title: string;
  url: string;
  video: PartialVideoEntry;
}

// タイトル画面の選曲候補（マジカルミライ2026 課題曲）。ボタンの並び順と一致させる。
export const SONGS: SongOption[] = [
  {
    title: "こたえて",
    url: "https://piapro.jp/t/6W2N/20251215164617",
    video: {
      beatId: 4827293,
      chordId: 2963754,
      repetitiveSegmentId: 3086261,
      lyricId: 126519,
      lyricDiffId: 28645,
    },
  },
  {
    title: "アフター・ザ・カーテン",
    url: "https://piapro.jp/t/zoqO/20251214200738",
    video: {
      beatId: 4827294,
      chordId: 2963755,
      repetitiveSegmentId: 3086262,
      lyricId: 126591,
      lyricDiffId: 28627,
    },
  },
  {
    title: "シャッターチャンス",
    url: "https://piapro.jp/t/PNpQ/20251209170719",
    video: {
      beatId: 4827295,
      chordId: 2963756,
      repetitiveSegmentId: 3086263,
      lyricId: 126542,
      lyricDiffId: 28628,
    },
  },
  {
    title: "世界最後の音楽隊",
    url: "https://piapro.jp/t/B3yJ/20251215061727",
    video: {
      beatId: 4827296,
      chordId: 2963757,
      repetitiveSegmentId: 3086264,
      lyricId: 126594,
      lyricDiffId: 28629,
    },
  },
  {
    title: "トリツクロジー",
    url: "https://piapro.jp/t/QBdL/20251215094303",
    video: {
      beatId: 4827297,
      chordId: 2963758,
      repetitiveSegmentId: 3086265,
      lyricId: 126593,
      lyricDiffId: 28630,
    },
  },
  {
    title: "TAKEOVER",
    url: "https://piapro.jp/t/E2i3/20251215092113",
    video: {
      beatId: 4827298,
      chordId: 2963759,
      repetitiveSegmentId: 3086266,
      lyricId: 126533,
      lyricDiffId: 28631,
    },
  },
];

export const DEFAULT_SONG: SongOption = SONGS[0];

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

// createFromSongUrlを呼ぶ唯一の入口。videoReady/timerReadyは一度trueになった後
// 自然にはリセットされないため、選曲をやり直すたびにここで明示的にfalseへ戻さないと、
// 前の曲のready状態を引きずってnotifyReadyIfCompleteが早期発火する（曲切り替え機能を
// 追加した際に発覚した競合）。
function beginLoad(player: Player, song: SongOption): void {
  videoReady = false;
  timerReady = false;
  player.createFromSongUrl(song.url, { video: song.video });
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
        beginLoad(player, DEFAULT_SONG);
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

// タイトル画面の選曲ボタンから呼ぶ、曲切り替え用の唯一の公開入口。
// onVideoReady/onTimerReadyはcreatePlayerで一度だけ登録済みのリスナーがそのまま
// 再発火するため、コールバックを渡し直す必要はない。
export function loadSong(player: Player, song: SongOption): void {
  beginLoad(player, song);
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

export interface SongInfo {
  name: string;
  artist: string;
}

// onReady後に一度だけ呼ぶ。ブートシーケンスの表示用に、曲名・アーティスト名を
// player.data.songから取り出す（楽曲クレジット自体は.textalive-bannerが別途
// 担うため、ここでは純粋にフレーバー表示として使う）。
export function getSongInfo(player: Player): SongInfo {
  const song = player.data.song;
  return { name: song.name, artist: song.artist.name };
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
//
// player.timer.positionは、準備完了（onVideoReady/onTimerReady）から実際にここへ
// 到達するまでに経過した壁時計時間をそのまま返してしまい、0にはリセットされない
// （実機で確認した不具合。ブートシーケンス＋入力待ちで数秒〜十数秒空くと、その分
// だけ歌詞の同期が最初からずれ、複数フレーズが一気に表示される形で顕在化した）。
// そのためrequestPlayの直前でTimer.seek(0)を呼び、明示的に0へ戻す。
//
// ここでrequestMediaSeek（IPlayer側のAPI）ではなくplayer.timer.seek（Timer自身の
// API）を使うのは意図的。requestMediaSeekの直後にrequestPlayを呼ぶと、シークが
// 内部的に発行するpause()とplay()が競合し、"The play() request was interrupted by
// a call to pause()." で再生が失敗したまま固まる不具合を実機で確認している一方、
// player.timer.seekはメディア要素のpause/playを経由しない純粋な内部時計のリセット
// であり、同じ競合は起きない（実機で確認済み）。
export function startPlayback(player: Player): void {
  ended = false;
  started = false;
  player.timer.seek(0);
  attemptPlay(player, 2);
}
