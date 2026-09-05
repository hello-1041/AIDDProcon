import { Player, type PartialVideoEntry } from "textalive-app-api";
import { MAX_TARGET_LEN, buildFreqTable, isSymbolWord, normalizeWord, type FreqTable } from "./board.ts";

export interface SongOption {
  title: string;
  artist: string;
  url: string;
  video: PartialVideoEntry;
}

// タイトル画面の選曲候補（マジカルミライ2026 課題曲）。ボタンの並び順と一致させる。
// 歌詞コンソールのSONGS定義をそのまま流用する（計画書6章）。
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

// 1曲につき1回だけonSongEndを呼ぶための二重発火防止フラグ。
// スタート／リトライ操作のたびにstartPlaybackから必ずリセットする必要があるため、
// モジュールスコープに置く（既存3作と同じ設計）。
let ended = false;

// 実際に再生が始まった（onPlay）ことを確認できるまでは終了判定を行わない
// （position=0, endTime=0 の早すぎる誤検知を防ぐ）。
let started = false;

// 動画オブジェクトの構築完了（onVideoReady）と、再生用Timerの準備完了（onTimerReady）は
// 発火タイミングが異なりうるため、両方揃うまでスタートボタンを有効化しない。
// 片方だけで次のcreateFromSongUrlを撃つと読み込み要求が落ちる（計画書10章）。
let videoReady = false;
let timerReady = false;

function notifyReadyIfComplete(onSongReady: () => void): void {
  if (videoReady && timerReady) onSongReady();
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
// すると、アウトロの手前で「曲が終わった」と誤検知する（既存3作と同じ対応）。
export function checkSongEnd(player: Player, songPosition: number, onSongEnd: () => void): void {
  if (!started || ended) return;
  const duration = player.video.duration;
  if (!Number.isFinite(duration) || duration <= 0) return;
  if (songPosition >= duration) finishSong(onSongEnd);
}

// createFromSongUrlを呼ぶ唯一の入口。videoReady/timerReadyは一度trueになった後
// 自然にはリセットされないため、選曲をやり直すたびにここで明示的にfalseへ戻さないと、
// 前の曲のready状態を引きずってnotifyReadyIfCompleteが早期発火する。
function beginLoad(player: Player, song: SongOption): void {
  videoReady = false;
  timerReady = false;
  player.createFromSongUrl(song.url, { video: song.video });
}

// onAppReadyはアプリ（TextAlive埋め込み）自体の起動完了、onSongReadyは実際の
// 楽曲データ（歌詞）の読み込み完了を表す。両者は発火タイミングが大きく
// 異なりうるため、別々のコールバックとして分離する。
export function createPlayer(
  token: string,
  onAppReady: () => void,
  onSongReady: () => void,
  onSongEnd: () => void,
): Player {
  const player = new Player({
    app: { token },
    // 水切リズムの#media、ブロック崩しの#bk-media、歌詞コンソールの#lc-mediaとは
    // 別IDに分離する。同一DOM上に複数Playerが共存するため、グローバル単一IDの
    // 奪い合いを避ける（計画書6章）。
    mediaElement: "#ls-media",
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
    // onStopは、ライブラリが内部でtimer.stop()→seek(0)する直前に発火する、
    // position比較に依存しない確実な終了シグナル。本命の検知経路とする。
    onStop: () => {
      finishSong(onSongEnd);
    },
  });

  return player;
}

// タイトル画面の選曲ボタンから呼ぶ、曲切り替え用の唯一の公開入口。
export function loadSong(player: Player, song: SongOption): void {
  beginLoad(player, song);
}

// ============================================================== 対象語の抽出

/** 取得対象となる歌詞の単位。TextAlive App APIのIWord1件に対応する（計画書3.1）。 */
export interface TargetWord {
  /** 対象語のインスタンスを一意に指すID。同じ文字列が曲中に複数回現れても別物として扱う。 */
  id: string;
  /** IWord.textの原文。リザルト画面の表示に使う（計画書3.9）。 */
  text: string;
  /** 照合用文字列（正規化済み）。盤面への配置と照合はこちらを使う。 */
  match: string;
  startTime: number;
  endTime: number;
  /** 所属フレーズの添字。IWord.parentから直接引く（時刻範囲での突き合わせは不要）。 */
  phraseIndex: number;
}

/** フレーズ1本。有効期間の判定単位（計画書3.3）。 */
export interface TargetPhrase {
  index: number;
  startTime: number;
  endTime: number;
  /** このフレーズに属する対象語（記号・除外語は含まない）。 */
  words: TargetWord[];
}

export interface SongTargets {
  phrases: TargetPhrase[];
  /** 曲全体の対象語。スコアの分母もこれを数える（計画書3.8）。 */
  words: TargetWord[];
  /** ダミー文字の重み付き抽選に使う、曲ごとの文字頻度表（計画書3.7）。 */
  freq: FreqTable;
}

/**
 * onSongReady後に一度だけ呼ぶ。player.video.wordsから対象語を抽出する（計画書3.1）。
 *
 * 除外するのは以下の3種。いずれも取得手段が存在しないため、スコアの分母にも
 * リザルト一覧にも含めない（計画書3.1・3.8・3.9）。
 *
 * - 品詞が記号（pos === "S"）の語。正規表現に頼らず品詞で判定する
 * - 正規化後に空文字列となる語
 * - 照合用文字列がMAX_TARGET_LENを超える語（経路として置けない。実測では0件）
 *
 * IWordは形態素単位であり、助詞・助動詞は独立した1語として得られる。したがって
 * 「助詞などは一文字でも取得される」という要件は、追加の分割処理なしに満たされる。
 */
export function computeTargetWords(player: Player): SongTargets {
  const video = player.video;

  // IPhraseのオブジェクト参照から添字を引く表。IWord.parentが返すのは
  // IPhraseの実体のため、参照で照合できる（実測で全1896語が親を持ち欠損ゼロ）。
  const phraseIndexOf = new Map<unknown, number>();
  video.phrases.forEach((phrase, index) => phraseIndexOf.set(phrase, index));

  const phrases: TargetPhrase[] = video.phrases.map((phrase, index) => ({
    index,
    startTime: phrase.startTime,
    endTime: phrase.endTime,
    words: [],
  }));

  const words: TargetWord[] = [];
  const charCounts = new Map<string, number>();

  video.words.forEach((word, wordIndex) => {
    if (isSymbolWord(word.pos)) return;
    const match = normalizeWord(word.text);
    if (match.length === 0 || match.length > MAX_TARGET_LEN) return;

    const phraseIndex = phraseIndexOf.get(word.parent);
    if (phraseIndex === undefined) return;

    const target: TargetWord = {
      id: `w${wordIndex}`,
      text: word.text,
      match,
      startTime: word.startTime,
      endTime: word.endTime,
      phraseIndex,
    };
    words.push(target);
    phrases[phraseIndex].words.push(target);

    // ダミー文字は「その楽曲の歌詞全文に出現する文字」から抽選する（計画書3.7）。
    // 歌詞に存在しない文字を混ぜないことで、盤面が「その曲の歌詞らしい」見た目を保つ。
    for (const ch of match) {
      charCounts.set(ch, (charCounts.get(ch) ?? 0) + 1);
    }
  });

  return {
    // 対象語を1つも持たないフレーズ（記号のみ等）は、ガイド表示の対象にならない
    // ため落とす。落とさないと「探す語が無いフレーズ」が表示中フレーズになる。
    phrases: phrases.filter((p) => p.words.length > 0),
    words,
    freq: buildFreqTable(charCounts),
  };
}

// ============================================================== 再生制御

// requestPlay()を呼んだあと、一定時間内にonPlay（startedフラグ）が発火しなければ
// 再試行する（初回起動で音楽が鳴らない不具合への保険。既存3作と同じ）。
function attemptPlay(player: Player, retriesLeft: number): void {
  player.requestPlay();
  if (retriesLeft <= 0) return;
  setTimeout(() => {
    if (!started) attemptPlay(player, retriesLeft - 1);
  }, 400);
}

/**
 * 「スタート」操作・「もう一度遊ぶ」操作、いずれからも呼ぶ唯一の再生開始経路。
 *
 * player.timer.positionは、準備完了から実際にここへ到達するまでに経過した
 * 壁時計時間をそのまま返してしまい、0にはリセットされない（実機で確認した
 * 不具合。歌詞の同期が最初からずれる形で顕在化する）。そのためrequestPlayの
 * 直前でTimer.seek(0)を呼び、明示的に0へ戻す。
 *
 * ここでrequestMediaSeek（IPlayer側のAPI）ではなくplayer.timer.seek（Timer自身の
 * API）を使うのは意図的。requestMediaSeekの直後にrequestPlayを呼ぶと、シークが
 * 内部的に発行するpause()とplay()が競合し、"The play() request was interrupted by
 * a call to pause()." で再生が失敗したまま固まる不具合を実機で確認している一方、
 * player.timer.seekはメディア要素のpause/playを経由しない純粋な内部時計のリセット
 * であり、同じ競合は起きない（歌詞コンソールで確認済み）。
 */
export function startPlayback(player: Player): void {
  ended = false;
  started = false;
  player.timer.seek(0);
  attemptPlay(player, 2);
}
