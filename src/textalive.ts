import { Player, type IBeat, type IPlayerApp } from "textalive-app-api";

// 「ロンリーラン」 / 海風太陽（マジカルミライ2025 課題曲）
// TextAlive App API公式サンプル（textalive-app-basic）で使用されている動作確認済みの楽曲
export const SAMPLE_SONG_URL = "https://piapro.jp/t/CyPO/20250128183915";
export const SAMPLE_SONG_OPTIONS = {
  video: {
    // 音楽地図の訂正履歴リビジョンID（人手で修正済みのデータを使うことでビート・コード精度を上げる）
    beatId: 4694280,
    chordId: 2830735,
    repetitiveSegmentId: 2946483,
    lyricId: 67815,
    lyricDiffId: 20659,
  },
};

export const DEFAULT_VOLUME = 10; // 楽曲の再生音量 [0-100]

// 1曲につき1回だけ onSongEnd を呼ぶための二重発火防止フラグ。
// スタート／リトライ操作のたびに startPlayback から必ずリセットする必要があるため、
// モジュールスコープに置く。
let ended = false;

// onVideoReady は「動画オブジェクトの構築完了」時点で発火し、その時点では
// player.video.endTime がまだ確定していないことがある。onTimeUpdate の
// 早すぎる誤検知（position=0, endTime=0 で 0>=0 が成立してしまう等）を防ぐため、
// 実際に再生が始まった（onPlay）ことを確認できるまでは終了判定を行わない。
let started = false;

// 動画オブジェクトの構築完了（onVideoReady）と、再生用Timerの準備完了（onTimerReady）は
// 発火タイミングが異なりうる。どちらか一方だけでスタートボタンを有効化すると、実際には
// 再生開始できる状態になっていないうちにクリックされてしまい、requestPlay()が空振りする
// （初回起動で音楽が鳴らない不具合の一因と考えられる）ため、両方揃うまで待つ。
let videoReady = false;
let timerReady = false;

function notifyReadyIfComplete(onReady: () => void): void {
  if (videoReady && timerReady) onReady();
}

// 曲の終端に達したかどうかを判定し、達していれば一度だけonSongEndを呼ぶ。
// onTimeUpdateイベント任せだと、実際の再生が自然停止する直前の最後のイベントの時点で
// まだ position が endTime に届いておらず、以降イベントそのものが発火しなくなることが
// あり、終了を検知できずに画面がプレイ中のまま固まる不具合があった（クリックしても
// ビート情報が見つからずMissになり続け、着水先のビートも見つからないため既定の短い
// 跳躍間隔にフォールバックし続けて高速で上下運動して見える、という2つの不具合の原因
// だった）。onTimeUpdateからだけでなく、main.tsのrequestAnimationFrameループから毎フレーム
// 呼んでもらうことで、より確実に検知できるようにする。
export function checkSongEnd(player: Player, songPosition: number, onSongEnd: () => void): void {
  if (!started || ended) return;
  const endTime = player.video.endTime;
  if (!Number.isFinite(endTime) || endTime <= 0) return;
  if (songPosition >= endTime) {
    ended = true;
    onSongEnd();
  }
}

// player.video.endTimeが実際の再生時間と一致しない曲では、position >= endTimeが
// 一度も成立しないまま再生が止まってしまうことがある（checkSongEndのポーリング化だけ
// では解消しなかった不具合）。main.tsの再生位置停滞検知フォールバックが先に終了と
// 判定した場合に呼び、以後checkSongEndが（万が一遅れて条件を満たしても）二重に
// onSongEndを呼ばないようにする。
export function markSongEnded(): void {
  ended = true;
}

export function createPlayer(
  token: string,
  onReady: () => void,
  onSongEnd: () => void,
): Player {
  const player = new Player({
    app: { token },
    mediaElement: "#media",
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
  });

  return player;
}

// beatが小節頭（ダウンビート）かどうかを返す。
// 「小節中のビート位置」を表すbeat.positionが0始まりか1始まりかはAPIドキュメント上
// 明確でなく、実際には0始まりではなかった（常にMissになる不具合の原因だった）ため、
// 曲全体の通し番号(index)を小節あたりのビート数(length)で割った余りを使う。
// この式はpositionの起点の規約に依存しないため、より頑健。
function isDownbeat(beat: IBeat): boolean {
  return beat.length > 0 && beat.index % beat.length === 0;
}

// beatを起点に、ダウンビートになるまでprevious/nextを辿る。16ビート探索しても
// 見つからなければ（データの異常など）nullを返す。見つかったふりをして無関係に遠い
// ビートを返すと、常にMiss判定になる不具合につながるため、明示的に諦める。
function walkToDownbeat(beat: IBeat | null, direction: "previous" | "next"): IBeat | null {
  let b = beat;
  let guard = 0;
  while (b && !isDownbeat(b) && guard < 16) {
    b = direction === "previous" ? b.previous : b.next;
    guard++;
  }
  return b && isDownbeat(b) ? b : null;
}

// クリック時刻と直近のダウンビート（小節頭）とのズレ幅[ms]を返す。
// ビート情報の範囲外（イントロ前など）では null を返す。
//
// 跳躍アニメーション（着水演出）の着水タイミングはダウンビート基準（getNextDownbeatTime）
// になっているため、判定基準もダウンビートに揃える。以前は直近の「拍」境界を基準にしており
// （ダウンビートは拍のサブセットのため）、見た目上は着水していない拍でクリックしても
// Justになってしまう不具合があった。
export function getOffsetMs(player: Player, clickTime: number): number | null {
  const beat = player.findBeat(clickTime);
  if (!beat) return null;

  const prev = walkToDownbeat(beat, "previous");
  const next = walkToDownbeat(isDownbeat(beat) ? beat.next : beat, "next");

  const distances = [prev, next]
    .filter((b): b is IBeat => b !== null)
    .map((b) => Math.abs(clickTime - b.startTime));
  if (distances.length === 0) return null;

  return Math.min(...distances);
}

// 「間奏」とみなす、歌詞フレーズが存在しない区間の最短の長さ [ms]。
// フレーズとフレーズの間の小さな息継ぎの隙間まで「間奏」扱いしないための閾値。
const MIN_INTERLUDE_GAP_MS = 4000;

export interface InterludeRange {
  startTime: number;
  endTime: number;
}

// 曲読み込み時に一度だけ呼ぶ。歌詞フレーズ（player.video.phrases）の隙間のうち、
// MIN_INTERLUDE_GAP_MS以上続くものだけを「間奏区間」として洗い出す。
// 「その瞬間に歌詞があるか」ではなく「まとまった間奏区間にいるか」で休符の出現を
// 判定するために、isInterludeより前段でこの区間一覧を計算しておく。
export function computeInterludeRanges(player: Player): InterludeRange[] {
  const phrases = player.video.phrases;
  const ranges: InterludeRange[] = [];

  if (phrases.length === 0) {
    return [{ startTime: 0, endTime: player.video.endTime }];
  }

  if (phrases[0].startTime >= MIN_INTERLUDE_GAP_MS) {
    ranges.push({ startTime: 0, endTime: phrases[0].startTime });
  }
  for (let i = 0; i < phrases.length - 1; i++) {
    const gapStart = phrases[i].endTime;
    const gapEnd = phrases[i + 1].startTime;
    if (gapEnd - gapStart >= MIN_INTERLUDE_GAP_MS) {
      ranges.push({ startTime: gapStart, endTime: gapEnd });
    }
  }
  const last = phrases[phrases.length - 1];
  if (player.video.endTime - last.endTime >= MIN_INTERLUDE_GAP_MS) {
    ranges.push({ startTime: last.endTime, endTime: player.video.endTime });
  }
  return ranges;
}

// 指定した再生位置が、computeInterludeRangesで洗い出した間奏区間内かどうかを返す。
export function isInterlude(ranges: InterludeRange[], time: number): boolean {
  return ranges.some((r) => time >= r.startTime && time < r.endTime);
}

// timeより後の、直近のダウンビート（小節頭）の開始時刻を返す。
// 跳躍アニメーションの目標着水位置を、次の小節頭に合わせるために使う
// （クリック時／クリックしていない間のアイドルホップの両方から呼ばれる）。
export function getNextDownbeatTime(player: Player, time: number): number | null {
  const beat = player.findBeat(time);
  if (!beat) return null;
  const next = walkToDownbeat(isDownbeat(beat) ? beat.next : beat, "next");
  return next ? next.startTime : null;
}

export interface JudgeThresholds {
  justMs: number;
  goodMs: number;
}

export const DEFAULT_JUST_THRESHOLD_MS = 50;
export const DEFAULT_GOOD_THRESHOLD_MS = 150;
export const DEFAULT_THRESHOLDS: JudgeThresholds = {
  justMs: DEFAULT_JUST_THRESHOLD_MS,
  goodMs: DEFAULT_GOOD_THRESHOLD_MS,
};

// getOffsetMsが返しうる最大値は「小節（ダウンビート間隔）長/2」であるため、楽曲の
// 小節間隔が短いと固定閾値ではMissに到達できなくなる（プレイテストで報告された不具合）。
// 楽曲読み込み時に小節長の中央値からGood/Just閾値を導出し、常にMissゾーンが
// 残るようにする（既存の固定値150ms/50msより緩くはしない）。
// 係数（0.4 / 40ms下限 / Just:Good=1:3比）は初期値であり、実プレイでの調整が必要。
const GOOD_FRACTION_OF_BAR = 0.4;
const GOOD_MS_MIN = 40;
const JUST_GOOD_RATIO = DEFAULT_JUST_THRESHOLD_MS / DEFAULT_GOOD_THRESHOLD_MS;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function computeJudgeThresholds(player: Player): JudgeThresholds {
  const beats = player.getBeats().filter((b) => Number.isFinite(b.duration) && b.duration > 0);
  if (beats.length === 0) return DEFAULT_THRESHOLDS;

  const durations = beats.map((b) => b.duration).sort((a, b) => a - b);
  const medianBeatDuration = durations[Math.floor(durations.length / 2)];
  const beatsPerBar = beats[0].length || 4;
  const barDuration = medianBeatDuration * beatsPerBar;

  const goodMs = clamp(barDuration * GOOD_FRACTION_OF_BAR, GOOD_MS_MIN, DEFAULT_GOOD_THRESHOLD_MS);
  const justMs = goodMs * JUST_GOOD_RATIO;
  return { justMs, goodMs };
}

// requestPlay()を呼んだあと、一定時間内にonPlay（startedフラグ）が発火しなければ
// 再試行する。原因を確定できなくても結果的に必ず再生が始まるようにするための保険
// （初回起動で音楽が鳴らない不具合が、シーク省略だけでは解消しなかったため追加）。
function attemptPlay(player: Player, retriesLeft: number): void {
  player.requestPlay();
  if (retriesLeft <= 0) return;
  setTimeout(() => {
    if (!started) attemptPlay(player, retriesLeft - 1);
  }, 400);
}

// 「スタート」操作から呼ぶ。位置は既に0のため、非同期な requestMediaSeek は呼ばない。
// ended/started フラグをここで必ずリセットすることで、onTimeUpdateの誤検知や
// 再生終了検知が二度と発火しなくなる不具合を防ぐ。
export function startPlayback(player: Player): void {
  ended = false;
  started = false;
  attemptPlay(player, 2);
}

// 「もう一度遊ぶ」操作から呼ぶ。曲を先頭まで巻き戻してから再生する。
export function restartPlayback(player: Player): void {
  ended = false;
  started = false;
  player.requestMediaSeek(0);
  attemptPlay(player, 2);
}
