/**
 * TextAlive Playerの生成・選曲・文字抽出・終了検知（製造計画書7章）。
 *
 * 再生制御まわりは歌詞コンソール（lyric-console/textalive.ts）の構造をそのまま
 * 踏襲する。ready状態の二重管理・timer.seek(0)・attemptPlayのリトライは、いずれも
 * 実機で確認された不具合への対策であり、理由ごと引き継ぐ（7章）。
 *
 * 本作で新規なのは、文字（IChar）単位の抽出とサビ区間の焼き込み（3.4・9章）。
 */

import { Player, type PartialVideoEntry } from "textalive-app-api";
import type { SphereChar, SpherePhrase } from "./sphere.ts";

export interface SongOption {
  title: string;
  artist: string;
  url: string;
  video: PartialVideoEntry;
}

// タイトル画面の選曲候補（マジカルミライ2026 課題曲）。既存4作と同じ順・同じ表記
// で並べること（4.7）。
export const SONGS: SongOption[] = [
  {
    title: "こたえて",
    artist: "imie",
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
    artist: "Rulmry",
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
    artist: "夜未アガリ",
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
    artist: "夏山よつぎ×ど～ぱみん",
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
    artist: "鶴三",
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
    artist: "Twinfield",
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

// 1曲につき1回だけonSongEndを呼ぶための二重発火防止フラグ。スタート／リトライ操作の
// たびにstartPlaybackから必ずリセットする必要があるため、モジュールスコープに置く
// （既存4作と同じ設計）。
let ended = false;

// 実際に再生が始まった（onPlay）ことを確認できるまでは終了判定を行わない
// （position=0, endTime=0 の早すぎる誤検知を防ぐ）。
let started = false;

// 動画オブジェクトの構築完了（onVideoReady）と再生用Timerの準備完了（onTimerReady）は
// 発火タイミングが異なりうるため、両方揃うまで次の処理へ進まない（11章）。
let videoReady = false;
let timerReady = false;

function notifyReadyIfComplete(onSongReady: () => void): void {
  if (videoReady && timerReady) onSongReady();
}

function finishSong(onSongEnd: () => void): void {
  if (!started || ended) return;
  ended = true;
  onSongEnd();
}

// 曲の終端判定。比較対象はplayer.video.endTimeではなくplayer.video.duration（実際の
// 音声の長さ）を使う。endTimeは解析データがカバーする区間の終了時刻に過ぎず、曲に
// よってはこれより後にアウトロが続くため、endTime基準だとアウトロの手前でリザルトが
// 出てしまう（歌詞コンソールで確認済みの不具合）。
export function checkSongEnd(player: Player, songPosition: number, onSongEnd: () => void): void {
  if (!started || ended) return;
  const duration = player.video.duration;
  if (!Number.isFinite(duration) || duration <= 0) return;
  if (songPosition >= duration) finishSong(onSongEnd);
}

// createFromSongUrlを呼ぶ唯一の入口。videoReady/timerReadyは一度trueになった後
// 自然にはリセットされないため、選曲をやり直すたびにここで明示的にfalseへ戻す。
// 戻さないと前の曲のready状態を引きずってnotifyReadyIfCompleteが早期発火する。
function beginLoad(player: Player, song: SongOption): void {
  videoReady = false;
  timerReady = false;
  player.createFromSongUrl(song.url, { video: song.video });
}

export function createPlayer(
  token: string,
  onAppReady: () => void,
  onSongReady: () => void,
  onSongEnd: () => void,
): Player {
  const player = new Player({
    app: { token },
    // 既存4作の#media／#bk-media／#lc-media／#ls-mediaとは別IDに分離する。
    // 同一DOM上に複数Playerが共存するため、グローバル単一IDの奪い合いを避ける。
    mediaElement: "#lsp-media",
  });

  player.volume = DEFAULT_VOLUME;

  player.addListener({
    onAppReady: () => {
      onAppReady();
    },
    onVideoReady: () => {
      ended = false;
      started = false;
      videoReady = true;
      notifyReadyIfComplete(onSongReady);
    },
    onTimerReady: () => {
      timerReady = true;
      notifyReadyIfComplete(onSongReady);
    },
    onPlay: () => {
      started = true;
    },
    onTimeUpdate: (position: number) => {
      checkSongEnd(player, position, onSongEnd);
    },
    // onStopは、ライブラリが内部でtimer.stop()→seek(0)する直前に発火する、position
    // 比較に依存しない確実な終了シグナル。本命の検知経路として扱う。
    onStop: () => {
      finishSong(onSongEnd);
    },
  });

  return player;
}

export function loadSong(player: Player, song: SongOption): void {
  beginLoad(player, song);
}

/**
 * 配置対象のフレーズ・文字を取り出す（9章）。
 *
 * phrases → phrase.children（IWord[]） → word.children（IChar[]）と降りる。
 * IWord.posで記号を除外できるのは語の階層であるため、player.video.charsを平坦に
 * 走査してはならない（品詞が取れない）。
 *
 * サビ判定はここで済ませて配置計画に焼き込む（3.4）。配置は事前決定であり、
 * 再生中にサビ判定をやり直すことはない。
 */
export function computeSpherePhrases(player: Player): SpherePhrase[] {
  const phrases: SpherePhrase[] = [];

  for (const phrase of player.video.phrases) {
    const chars: SphereChar[] = [];

    for (const word of phrase.children) {
      // 記号（pos === "S"）の語はまるごと除外する（3.2）。
      if (word.pos === "S") continue;
      for (const char of word.children) {
        chars.push({ text: char.text, startTime: char.startTime, endTime: char.endTime });
      }
    }

    if (chars.length === 0) continue;

    phrases.push({
      chars,
      startTime: phrase.startTime,
      endTime: phrase.endTime,
      // フレーズの開始時点がサビ区間に入っているかで判定する。
      chorus: player.findChorus(phrase.startTime) !== null,
    });
  }

  return phrases;
}

// requestPlay()を呼んだあと、一定時間内にonPlay（startedフラグ）が発火しなければ
// 再試行する（初回起動で音楽が鳴らない不具合への保険。既存4作と同じ）。
function attemptPlay(player: Player, retriesLeft: number): void {
  player.requestPlay();
  if (retriesLeft <= 0) return;
  setTimeout(() => {
    if (!started) attemptPlay(player, retriesLeft - 1);
  }, 400);
}

/**
 * 「スタート」「もう一度遊ぶ」いずれからも呼ぶ唯一の再生開始経路。
 *
 * player.timer.positionは準備完了からここへ到達するまでの壁時計時間をそのまま返し、
 * 0にはリセットされない。そのためrequestPlayの直前でTimer.seek(0)を呼ぶ。
 * requestMediaSeekではなくplayer.timer.seekを使うのは意図的で、前者はシークが内部で
 * 発行するpause()とplay()が競合し "The play() request was interrupted by a call to
 * pause()." で固まる不具合を実機で確認しているため（歌詞コンソールの知見）。
 */
export function startPlayback(player: Player): void {
  ended = false;
  started = false;
  player.timer.seek(0);
  attemptPlay(player, 2);
}
