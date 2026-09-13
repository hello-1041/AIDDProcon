import { Player, type PartialVideoEntry } from "textalive-app-api";
import {
  MAX_TARGET_LEN,
  buildFreqTable,
  isSymbolWord,
  normalizeWord,
  toChars,
  type FreqTable,
} from "./board.ts";

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

// 再生開始時にライブラリ内部で起きる play() → pause() → play() の連打によって、
// 最初のplay()のPromiseが AbortError で拒否される。これを握り潰す。
//
// 実測（msedge / スタート押下直後）:
//
//   play   @4014ms  api.songle.jp/v2/api.js
//   pause  @4015ms  api.songle.jp/v2/api.js
//   play   @4038ms  api.songle.jp/v2/api.js
//   → 1本目のplay()が "The play() request was interrupted by a call to pause()."
//
// 3件とも発生元はライブラリ内部であり、24ms以内に完結している（attemptPlayの
// 再送間隔400msとは無関係で、シークを一切行わない経路でも再現する）。ライブラリが
// このPromiseにcatchを付けていないため、未処理のrejectionとしてページまで飛ぶ。
// アプリ側から連打そのものを止める手段は無い。
//
// 握り潰す対象は、この症状に一致するAbortErrorだけに限る。自動再生がブロック
// された場合のNotAllowedError等は名前が異なるため、従来どおり表面化する。
// また、本当に再生が始まらなかった場合はattemptPlayの再送（onPlay未発火を
// 400msで検知）が保険として働くため、実害のある失敗を隠すことにはならない。
let rejectionGuardInstalled = false;

function installPlayRejectionGuard(): void {
  if (rejectionGuardInstalled) return;
  rejectionGuardInstalled = true;
  window.addEventListener("unhandledrejection", (event) => {
    const reason: unknown = event.reason;
    if (!(reason instanceof DOMException) || reason.name !== "AbortError") return;
    if (!reason.message.includes("play()") || !reason.message.includes("pause()")) return;
    event.preventDefault();
  });
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
  installPlayRejectionGuard();

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

/**
 * 取得対象となる歌詞の単位（計画書3.1、実装指摘8）。
 *
 * `IWord`（形態素）1件ではなく、**付属語を連結した文節に近い単位**である。
 * 形態素のままでは「なっ」「た」「い」「て」「も」のように分割されて直観に反し、
 * 実測でも対象語の44.2%が1文字語になっていた（12.1）。連結規則は`mergeUnits`参照。
 */
export interface TargetWord {
  /** 対象語のインスタンスを一意に指すID。同じ文字列が曲中に複数回現れても別物として扱う。 */
  id: string;
  /** 連結元の原文をそのまま繋いだもの。リザルト画面とガイドの表示に使う（計画書3.9）。 */
  text: string;
  /** 照合用文字列（正規化済み）。照合（文字列比較）はこちらを使う。 */
  match: string;
  /**
   * `match`をセル単位へ分解したもの（board.toChars）。盤面への配置と長さ判定は
   * こちらを使う。`match.length`で数えるとUTF-16コードユニット単位になり、
   * 基本多言語面外の文字を含む語の必要セル数がずれる。
   */
  matchChars: readonly string[];
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

/** 付属語。直前の語に必ず連結する（P: 助詞、M: 助動詞）。 */
const DEPENDENT_POS = new Set(["P", "M"]);

/**
 * 1文字のときだけ直前に連結する品詞（用言・付属語）。
 *
 * 「過ぎ｜て｜く」の「く」のような1文字の用言を拾うための規則。**名詞(N)は
 * 含めない。** 1文字の名詞まで吸収すると「あなたは手を」「集まる人」のように
 * 文節境界を越えて繋がり、今度は語が不自然に長くなる（実装指摘8の規則比較）。
 */
const CONJUGATABLE_POS = new Set(["V", "J", "M", "P"]);

/** 直前の語に連結すべきか（実装指摘8の採用規則R2b）。 */
function shouldAttach(pos: string, matchLength: number): boolean {
  return DEPENDENT_POS.has(pos) || (matchLength === 1 && CONJUGATABLE_POS.has(pos));
}

/**
 * onSongReady後に一度だけ呼ぶ。player.video.wordsから対象語を抽出する（計画書3.1）。
 *
 * `IWord`は形態素単位であり、助詞・助動詞が独立した1語として得られる。そのままでは
 * 「なっ」「た」「い」「て」「も」のように分割されて直観に反するため、**付属語と
 * 1文字の用言を直前の語へ連結し、文節に近い単位へ畳む**（実装指摘8）。実データでの
 * 効果は、1文字語が44.2%→4.4%、対象語数が1896→1136。最長語は10文字のまま変わらず、
 * 配置保証も破綻しない（諦め・全再生成とも0件）。
 *
 * 連結の障壁（またいで繋がないもの）は次の3つ。
 *
 * - 品詞が記号（pos === "S"）の語。正規表現に頼らず品詞で判定する
 * - 正規化後に空文字列となる語
 * - フレーズの切れ目
 *
 * 連結後の照合用文字列がMAX_TARGET_LENを超える語は除外する（経路として置けない。
 * 実測では0件）。除外した語は取得手段が無いため、スコアの分母にもリザルト一覧にも
 * 含めない（計画書3.1・3.8・3.9）。
 */
export function computeTargetWords(player: Player): SongTargets {
  const video = player.video;

  // IPhraseのオブジェクト参照から添字を引く表。IWord.parentが返すのは
  // IPhraseの実体のため、参照で照合できる（実測で全語が親を持ち欠損ゼロ）。
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

  // 連結中の単位。障壁に当たるか、連結できない語が来た時点で確定させる。
  // matchChars は連結が終わってからでないと確定しないため、ここでは持たせない。
  let pending: Omit<TargetWord, "matchChars"> | null = null;

  const flush = (): void => {
    if (!pending) return;
    const built = pending;
    pending = null;
    // 長さはコードポイント数＝必要セル数で数える。String.lengthで数えると、
    // 基本多言語面外の文字を含む語の必要セル数を過小評価する（board.toChars）。
    const matchChars = toChars(built.match);
    if (matchChars.length === 0 || matchChars.length > MAX_TARGET_LEN) return;
    const target: TargetWord = { ...built, matchChars };
    words.push(target);
    phrases[target.phraseIndex].words.push(target);
    // ダミー文字は「その楽曲の歌詞全文に出現する文字」から抽選する（計画書3.7）。
    // 歌詞に存在しない文字を混ぜないことで、盤面が「その曲の歌詞らしい」見た目を保つ。
    for (const ch of matchChars) {
      charCounts.set(ch, (charCounts.get(ch) ?? 0) + 1);
    }
  };

  video.words.forEach((word, wordIndex) => {
    const phraseIndex = phraseIndexOf.get(word.parent);
    const match = normalizeWord(word.text);

    // 障壁：記号・正規化で消える語・親フレーズが引けない語
    if (isSymbolWord(word.pos) || match.length === 0 || phraseIndex === undefined) {
      flush();
      return;
    }

    if (pending && pending.phraseIndex === phraseIndex && shouldAttach(word.pos, match.length)) {
      pending.text += word.text;
      pending.match += match;
      pending.endTime = word.endTime;
      return;
    }

    flush();
    pending = {
      id: `u${wordIndex}`,
      text: word.text,
      match,
      startTime: word.startTime,
      endTime: word.endTime,
      phraseIndex,
    };
  });
  flush();

  // 対象語を1つも持たないフレーズ（記号のみ等）は、ガイド表示の対象にならないため
  // 落とす。落とさないと「探す語が無いフレーズ」が表示中フレーズになる。
  //
  // 落とした後は**必ず添字を振り直すこと。** `TargetPhrase.index` と
  // `TargetWord.phraseIndex` は game.ts 側で `targets.phrases[i]` の添字として
  // 直接使われる。元の`video.phrases`上の位置のまま残すと、1本でも落ちた時点で
  // 配列位置とずれ、別のフレーズを参照する。
  const kept = phrases.filter((p) => p.words.length > 0);
  kept.forEach((phrase, index) => {
    phrase.index = index;
    for (const word of phrase.words) word.phraseIndex = index;
  });

  return {
    phrases: kept,
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
