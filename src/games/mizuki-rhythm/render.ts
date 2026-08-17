import type { GameState, JudgeResult, NoteType } from "./game.ts";

export const CANVAS_WIDTH = 800;
export const CANVAS_HEIGHT = 600;

export const HORIZON_Y = 350; // 水平線のY座標（画面上側=空、下側=水面）
export const STONE_SCREEN_X = 250; // 石を描画するX座標（画面左寄り、固定）

export const PX_PER_METER = 20; // 距離1mあたりの水面パターンの水平移動量 [px]
export const WATER_PATTERN_WIDTH = 100; // 水面の波線パターン1周期の幅 [px]
export const SKY_PARALLAX_FACTOR = 0.3; // 遠景は水面より遅くスクロールさせる係数
export const SKY_PATTERN_WIDTH = 400; // 遠景の図形を配置する周期幅 [px]

export const BOUNCE_HEIGHT = 60; // 跳躍時にY座標が水平線から上昇する量 [px]
export const BOUNCE_DURATION_MS = 250; // 1回の跳躍アニメーションの継続時間

export const SPARKLE_COUNT_GOOD = 5;
export const SPARKLE_COUNT_JUST = 14;
export const SPARKLE_DURATION_MS = 450;

// クリックしていない間も背景が流れ続けるように、実時間ベースで常時進行する
// アンビエントスクロール量 [px/ms]。currentDistance由来のスクロール量に加算される。
export const AMBIENT_SCROLL_SPEED_PX_PER_MS = 0.1;

// 投げ込み導入演出（スタート／リトライ時、着水するまでクリック不可）の継続時間。
// 曲の先頭からの導入（main.tsが最初の歌詞タイミングに合わせて可変長を渡す）のデフォルト値、
// および曲中のMiss後の自動続投（常にこの固定値を使う）の継続時間として使う。
export const INTRO_THROW_DURATION_MS = 850;
const THROW_ORIGIN_X = 40; // 岸付近から投げ出す開始X座標
const THROW_ORIGIN_Y_OFFSET = -50; // 投擲開始時のY座標（水平線からのオフセット、上が負）
// 投げ込み演出の飛行中の縦方向の振れ幅。水平方向の移動量(210px)に対して大きすぎると
// 山なりの放物線に見えてしまうため、水切りらしい水平に近い軌道になるよう低く抑える。
const THROW_ARC_HEIGHT = 25;

const SHORE_WIDTH_PX = 90; // 岸（陸地）の描画幅 [px]
// 岸の表示時間はアンビエントスクロール速度から独立させ、投げ込み演出（850ms）より
// 明確に長く見せる（アンビエントスクロール速度と連動させていると、速度を上げるたびに
// 岸の表示時間も連動して短くなり、演出が始まる前後で消えてしまうことがあるため）。
const SHORE_VISIBLE_MS = 1600;
const SHORE_EXIT_SPEED_PX_PER_MS = SHORE_WIDTH_PX / SHORE_VISIBLE_MS;

const RIPPLE_DURATION_MS = 500; // 波紋が消えるまでの時間（設計書に数値なし、実装用の初期値）
const SINK_DURATION_MS = 500; // Miss時に石が沈みきるまでの時間

// 明るい昼景色（ポップな配色）
const SKY_COLOR_TOP = "#38a9f0";
const SKY_COLOR_HORIZON = "#cdeeff";
const WATER_COLOR_NEAR = "#5fe0e8";
const WATER_COLOR_FAR = "#1f8fd8";
const SHORE_COLOR = "#d9b877";
const NOTE_COLOR = "#ffe27a";
const RIPPLE_COLOR = "10, 90, 130";
const SPARKLE_COLOR_JUST = "255, 226, 122";
const SPARKLE_COLOR_GOOD = "255, 255, 255";

interface BounceAnim {
  startY: number; // アニメーション開始時点のY座標（水平線からのオフセット。上が負）
  startSongTime: number; // アニメーション開始時点の再生位置 [ms]
  targetSongTime: number; // 着水目標の再生位置 [ms]（次のダウンビート等）
}

interface Ripple {
  x: number;
  spawnTime: number;
}

interface Sparkle {
  x: number;
  y: number;
  vx: number; // px/ms
  vy: number; // px/ms
  spawnTime: number;
  shape: "star" | "diamond";
  isJust: boolean;
}

type IntroPhase = "throwing" | "done";
interface IntroState {
  phase: IntroPhase;
  startSongTime: number; // 投げ込み開始時点の再生位置 [ms]
  targetSongTime: number; // 着水目標の再生位置 [ms]
}

let currentBounce: BounceAnim | null = null;
let ripples: Ripple[] = [];
let sparkles: Sparkle[] = [];
let justRing: { spawnTime: number } | null = null;
let missAnimStartTime: number | null = null;
let prevLastJudge: JudgeResult | null = null;

let ambientScrollStartTime: number | null = null;
let intro: IntroState = { phase: "done", startSongTime: 0, targetSongTime: 0 };
let shoreScrollStartTime: number | null = null; // nullになったら以後岸は描画しない

interface DistanceRamp {
  fromValue: number;
  toValue: number;
  startSongTime: number; // 再生位置ベース。跳躍・沈み込みと同じ時間軸で同期させる
  targetSongTime: number;
}
let distanceRamp: DistanceRamp | null = null;
let lastKnownDistance = 0; // 直近に確定した表示距離（次のランプの起点や、ランプが無いときの値）

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function resizeToFit(canvas: HTMLCanvasElement): void {
  const scale = Math.min(
    window.innerWidth / CANVAS_WIDTH,
    window.innerHeight / CANVAS_HEIGHT,
  );
  canvas.style.width = `${CANVAS_WIDTH * scale}px`;
  canvas.style.height = `${CANVAS_HEIGHT * scale}px`;
}

function getAmbientPx(): number {
  if (ambientScrollStartTime === null) return 0;
  return (performance.now() - ambientScrollStartTime) * AMBIENT_SCROLL_SPEED_PX_PER_MS;
}

export function startAmbientScroll(): void {
  ambientScrollStartTime = performance.now();
}

// 背景スクロール計算に使う「表示用の距離」の現在値を返す（進行中のランプがあれば補間する）。
function getDisplayedDistance(songPosition: number): number {
  if (!distanceRamp) return lastKnownDistance;
  const span = distanceRamp.targetSongTime - distanceRamp.startSongTime;
  const t = span > 0 ? clamp((songPosition - distanceRamp.startSongTime) / span, 0, 1) : 1;
  return distanceRamp.fromValue + (distanceRamp.toValue - distanceRamp.fromValue) * t;
}

// 表示用の距離を、指定した再生位置の区間（startSongTime〜targetSongTime）でなめらかに
// toValueへ遷移させる。跳躍アニメーション・沈み込み演出と同じ区間を渡すことで、
// 「Justほど1回の跳躍で背景が大きく進む」ように着水演出とスクロールの伸びを同期させる
// （currentDistanceの飛び飛びの変化をそのまま反映すると、水面パターンの位相が瞬間的に
// 飛んで背景が途切れて見えてしまうため）。
function rampDisplayedDistanceTo(
  toValue: number,
  startSongTime: number,
  targetSongTime: number,
): void {
  const fromValue = getDisplayedDistance(startSongTime);
  distanceRamp = { fromValue, toValue, startSongTime, targetSongTime };
  lastKnownDistance = toValue;
}

export function getWaterOffsetX(currentDistance: number): number {
  const scrolledPx = currentDistance * PX_PER_METER + getAmbientPx();
  return scrolledPx % WATER_PATTERN_WIDTH;
}

export function getSkyOffsetX(currentDistance: number): number {
  const scrolledPx = (currentDistance * PX_PER_METER + getAmbientPx()) * SKY_PARALLAX_FACTOR;
  return scrolledPx % SKY_PATTERN_WIDTH;
}

// 進行中のバウンドアニメーションの現在のYオフセット（水平線からの相対値、上が負）を返す。
// performance.now()ではなく実際の再生位置(songPosition)から進捗を計算することで、
// 実時間クロックと音声再生クロックのズレによる蓄積誤差（跳躍を繰り返すたびに音楽と
// 徐々にズレていく不具合）を防ぐ。
function getBounceY(anim: BounceAnim, songPosition: number): number {
  const span = anim.targetSongTime - anim.startSongTime;
  const t = span > 0 ? clamp((songPosition - anim.startSongTime) / span, 0, 1) : 1;
  const arc = 4 * t * (1 - t); // 0→1→0 の放物線
  return -BOUNCE_HEIGHT * arc + anim.startY * (1 - t);
}

// クリック（跳躍）のたびに main.ts から呼ばれる。
// 進行中のバウンドがあれば現在位置を引き継いで新しい弧を開始し、波紋を1つ発生させる。
// fromSongTime/targetSongTimeは、クリック時刻の再生位置と次のダウンビートの再生位置を
// main.ts が算出して渡す（すぐに着水せず、次の目標タイミングに合わせてゆっくり跳ねる
// ようにするため）。distanceToが渡された場合（Just/Good判定時）は、同じ区間で表示距離も
// この値へなめらかに遷移させ、着水演出と背景スクロールの伸びを同期させる
// （クリックしていない間の自動跳躍にはスコア変化がないため、distanceToは渡さない）。
export function triggerBounceAnimation(
  fromSongTime: number,
  targetSongTime: number,
  distanceTo?: number,
): void {
  const startY = currentBounce ? getBounceY(currentBounce, fromSongTime) : 0;
  currentBounce = { startY, startSongTime: fromSongTime, targetSongTime };
  ripples.push({ x: STONE_SCREEN_X, spawnTime: performance.now() });
  if (distanceTo !== undefined) {
    rampDisplayedDistanceTo(distanceTo, fromSongTime, targetSongTime);
  }
}

// Just/Good判定時に main.ts から呼ばれる。songPositionはクリック時刻の再生位置。
export function triggerSparkle(result: "just" | "good", songPosition: number): void {
  const isJust = result === "just";
  const count = isJust ? SPARKLE_COUNT_JUST : SPARKLE_COUNT_GOOD;
  const originY = HORIZON_Y + (currentBounce ? getBounceY(currentBounce, songPosition) : 0);

  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = isJust ? 0.15 + Math.random() * 0.25 : 0.08 + Math.random() * 0.12;
    sparkles.push({
      x: STONE_SCREEN_X,
      y: originY,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      spawnTime: performance.now(),
      shape: Math.random() < 0.5 ? "star" : "diamond",
      isJust,
    });
  }

  if (isJust) {
    justRing = { spawnTime: performance.now() };
  }
}

// 石を岸から投げ込む導入アニメーションを開始し、既存のバウンド／波紋／きらめき／沈み込み演出と
// アンビエントスクロール・岸の表示をリセットする。スタート／リトライ操作（startIntroThrow）と、
// Miss後の自動続投（drawFrame内、沈み込み完了時）の両方から呼ばれる共通処理。
// nowWallClockはアンビエントスクロール・岸の表示（実時間ベースの演出）のリセットにのみ使う。
// prevLastJudgeはここではリセットしない（リセットすると、Missが続いている間に翌フレームの
// 遷移検知が誤って再発火し、沈み込み演出が再トリガーされてしまうため）。
function beginIntroThrow(nowWallClock: number, startSongTime: number, targetSongTime: number): void {
  intro = { phase: "throwing", startSongTime, targetSongTime };
  currentBounce = null;
  ripples = [];
  sparkles = [];
  justRing = null;
  missAnimStartTime = null;
  ambientScrollStartTime = nowWallClock;
  shoreScrollStartTime = nowWallClock;
  distanceRamp = null;
  lastKnownDistance = 0;
}

// スタート／リトライ操作時に main.ts から呼ばれる。targetSongTimeは、曲の先頭から最初の
// 歌詞が始まるまでの再生位置に合わせて main.ts が算出する（未指定時はINTRO_THROW_DURATION_MS
// 後を目標とする）。導入アニメーションが終わるまでは isIntroFinished() が false を返す。
export function startIntroThrow(targetSongTime: number = INTRO_THROW_DURATION_MS): void {
  beginIntroThrow(performance.now(), 0, targetSongTime);
}

// 一時停止中も再生位置(songPosition)自体が進まなくなるため、跳躍・投げ込み演出
// （再生位置ベース）は特別な補正なしで自然に一時停止が効く。ここでは実時間ベースの
// 演出（アンビエントスクロール・波紋・きらめき・沈み込み・岸の表示）のみを補正する。
export function resumeAnimations(pausedDurationMs: number): void {
  if (ambientScrollStartTime !== null) ambientScrollStartTime += pausedDurationMs;
  for (const r of ripples) r.spawnTime += pausedDurationMs;
  for (const s of sparkles) s.spawnTime += pausedDurationMs;
  if (justRing) justRing.spawnTime += pausedDurationMs;
  if (missAnimStartTime !== null) missAnimStartTime += pausedDurationMs;
  if (shoreScrollStartTime !== null) shoreScrollStartTime += pausedDurationMs;
}

// main.tsのクリックゲートで使用。導入アニメーション終了後にtrueを返す（純粋な読み取りのみ）。
export function isIntroFinished(): boolean {
  return intro.phase === "done";
}

// main.tsが「着水までにクリックがあったか」を判定するのに使う。
// 跳躍アニメーションが現在再生中（＝まだ着水していない）かどうかを返す。
export function isBounceActive(songPosition: number): boolean {
  if (!currentBounce) return false;
  return songPosition < currentBounce.targetSongTime;
}

// main.tsが次の跳躍の自動開始や自動Miss判定を行ってよいかの判定に使う。
// Missの沈み込み演出中はその間だけtrueを返す。
export function isMissSinking(): boolean {
  return missAnimStartTime !== null;
}

function updateIntroPhase(songPosition: number, nowWallClock: number): void {
  if (intro.phase === "throwing" && songPosition >= intro.targetSongTime) {
    intro.phase = "done";
    ripples.push({ x: STONE_SCREEN_X, spawnTime: nowWallClock }); // 着水の波紋
  }
}

function getIntroThrowPos(songPosition: number): { x: number; yOffset: number; scale: number } {
  const span = intro.targetSongTime - intro.startSongTime;
  const t = span > 0 ? clamp((songPosition - intro.startSongTime) / span, 0, 1) : 1;
  const arc = 4 * t * (1 - t); // 0→1→0 の放物線
  return {
    x: THROW_ORIGIN_X + (STONE_SCREEN_X - THROW_ORIGIN_X) * t,
    yOffset: THROW_ORIGIN_Y_OFFSET * (1 - t) - THROW_ARC_HEIGHT * arc,
    scale: 0.6 + 0.4 * t,
  };
}

function drawSky(ctx: CanvasRenderingContext2D, skyOffsetX: number): void {
  const gradient = ctx.createLinearGradient(0, 0, 0, HORIZON_Y);
  gradient.addColorStop(0, SKY_COLOR_TOP);
  gradient.addColorStop(1, SKY_COLOR_HORIZON);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, CANVAS_WIDTH, HORIZON_Y);

  // 遠景の山（単純な三角形）と雲を周期的に配置し、水面よりゆっくりスクロールさせる
  const count = Math.ceil(CANVAS_WIDTH / SKY_PATTERN_WIDTH) + 2;
  for (let i = -1; i < count; i++) {
    const baseX = i * SKY_PATTERN_WIDTH - skyOffsetX;

    ctx.fillStyle = "rgba(90, 150, 200, 0.35)";
    ctx.beginPath();
    ctx.moveTo(baseX, HORIZON_Y);
    ctx.lineTo(baseX + SKY_PATTERN_WIDTH * 0.3, HORIZON_Y - 90);
    ctx.lineTo(baseX + SKY_PATTERN_WIDTH * 0.6, HORIZON_Y);
    ctx.closePath();
    ctx.fill();

    // 雲（楕円）
    ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
    ctx.beginPath();
    ctx.ellipse(
      baseX + SKY_PATTERN_WIDTH * 0.8,
      HORIZON_Y - 180,
      40,
      16,
      0,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
}

function drawWater(ctx: CanvasRenderingContext2D, waterOffsetX: number): void {
  const gradient = ctx.createLinearGradient(0, HORIZON_Y, 0, CANVAS_HEIGHT);
  gradient.addColorStop(0, WATER_COLOR_NEAR);
  gradient.addColorStop(1, WATER_COLOR_FAR);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, HORIZON_Y, CANVAS_WIDTH, CANVAS_HEIGHT - HORIZON_Y);

  // 横方向に周期的な波線
  ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
  ctx.lineWidth = 1.5;
  const lineSpacing = 40;
  for (let ly = HORIZON_Y + 20; ly < CANVAS_HEIGHT; ly += lineSpacing) {
    ctx.beginPath();
    for (let x = 0; x <= CANVAS_WIDTH; x += 8) {
      const y = ly + Math.sin((x + waterOffsetX) * ((Math.PI * 2) / WATER_PATTERN_WIDTH)) * 4;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

// 画面左端の岸（陸地）。startIntroThrow()からの経過時間に応じて、他の背景と同じ速度で
// 左へスクロールアウトさせ、画面外に出た後は描画しない（常時表示すると静止して見えるため、
// スタート直後の「投擲の起点」としてのみ機能させる）。
function getShoreScreenX(now: number): number | null {
  if (shoreScrollStartTime === null) return null;
  const elapsed = now - shoreScrollStartTime;
  const scrolledPx = elapsed * SHORE_EXIT_SPEED_PX_PER_MS;
  const x = -scrolledPx;
  if (x + SHORE_WIDTH_PX < 0) {
    shoreScrollStartTime = null;
    return null;
  }
  return x;
}

function drawShore(ctx: CanvasRenderingContext2D, now: number): void {
  const x = getShoreScreenX(now);
  if (x === null) return;

  ctx.fillStyle = SHORE_COLOR;
  ctx.beginPath();
  ctx.moveTo(x, HORIZON_Y - 70);
  ctx.lineTo(x + SHORE_WIDTH_PX, HORIZON_Y - 20);
  ctx.lineTo(x + SHORE_WIDTH_PX - 20, HORIZON_Y + 10);
  ctx.lineTo(x, HORIZON_Y + 10);
  ctx.closePath();
  ctx.fill();
}

function drawRipple(ctx: CanvasRenderingContext2D, x: number, age: number): void {
  const t = clamp(age / RIPPLE_DURATION_MS, 0, 1);
  const radius = 6 + t * 46;
  const alpha = 1 - t;
  ctx.beginPath();
  ctx.ellipse(x, HORIZON_Y, radius, radius * 0.35, 0, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(${RIPPLE_COLOR}, ${alpha * 0.6})`;
  ctx.lineWidth = 2;
  ctx.stroke();
}

function drawNote(
  ctx: CanvasRenderingContext2D,
  noteType: NoteType,
  x: number,
  yOffset: number,
  scale: number,
  alpha: number,
): void {
  const y = HORIZON_Y + yOffset;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  ctx.scale(scale, scale);

  // 影：符頭（ノートヘッド）と同じ向き・比率の楕円にすることで「この音符の影」だと
  // 伝わるようにする（符幹・符尾は水面から離れているため影を持たせない）。
  // 水面に近いほど大きく濃く、高く跳ねているほど小さく薄くする。
  const height = Math.max(0, -yOffset);
  const heightRatio = clamp(height / BOUNCE_HEIGHT, 0, 1);
  const shadowScale = 1 - heightRatio * 0.5;
  const shadowShape =
    noteType === "quarterRest"
      ? { rx: 6, ry: 3, rotation: 0 }
      : { rx: 9, ry: 6.5, rotation: -0.35 };

  ctx.save();
  ctx.globalAlpha = alpha * 0.4 * (1 - heightRatio * 0.6);
  ctx.fillStyle = "#0b3550";
  ctx.beginPath();
  ctx.ellipse(
    0,
    HORIZON_Y - y,
    shadowShape.rx * shadowScale,
    shadowShape.ry * shadowScale,
    shadowShape.rotation,
    0,
    Math.PI * 2,
  );
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = NOTE_COLOR;
  ctx.strokeStyle = NOTE_COLOR;
  ctx.lineWidth = 3;

  if (noteType === "quarterRest") {
    // 四分休符：ジグザグ状の曲線パスで簡略化して表現
    ctx.beginPath();
    ctx.moveTo(-4, -14);
    ctx.lineTo(4, -6);
    ctx.lineTo(-4, 2);
    ctx.lineTo(4, 8);
    ctx.quadraticCurveTo(-6, 12, -2, 16);
    ctx.stroke();
    ctx.restore();
    return;
  }

  // 符頭（ノートヘッド）：やや傾いた楕円
  ctx.save();
  ctx.rotate(-0.35);
  ctx.beginPath();
  ctx.ellipse(0, 12, 9, 6.5, 0, 0, Math.PI * 2);
  if (noteType === "whole") {
    ctx.lineWidth = 2.5;
    ctx.stroke();
  } else {
    ctx.fill();
  }
  ctx.restore();

  if (noteType === "quarter" || noteType === "eighth") {
    // 符幹（ステム）
    ctx.beginPath();
    ctx.moveTo(8, 8);
    ctx.lineTo(8, -28);
    ctx.stroke();
  }

  if (noteType === "eighth") {
    // 符尾（フラグ）
    ctx.beginPath();
    ctx.moveTo(8, -28);
    ctx.quadraticCurveTo(22, -22, 18, -10);
    ctx.quadraticCurveTo(14, -18, 8, -18);
    ctx.fill();
  }

  ctx.restore();
}

function drawStar(ctx: CanvasRenderingContext2D, size: number): void {
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const outerAngle = (Math.PI * 2 * i) / 5 - Math.PI / 2;
    const innerAngle = outerAngle + Math.PI / 5;
    const ox = Math.cos(outerAngle) * size;
    const oy = Math.sin(outerAngle) * size;
    const ix = Math.cos(innerAngle) * size * 0.45;
    const iy = Math.sin(innerAngle) * size * 0.45;
    if (i === 0) ctx.moveTo(ox, oy);
    else ctx.lineTo(ox, oy);
    ctx.lineTo(ix, iy);
  }
  ctx.closePath();
  ctx.fill();
}

function drawDiamond(ctx: CanvasRenderingContext2D, size: number): void {
  ctx.beginPath();
  ctx.moveTo(0, -size);
  ctx.lineTo(size * 0.7, 0);
  ctx.lineTo(0, size);
  ctx.lineTo(-size * 0.7, 0);
  ctx.closePath();
  ctx.fill();
}

function drawSparkles(ctx: CanvasRenderingContext2D, songPosition: number): void {
  const now = performance.now();

  ripples = ripples.filter((r) => now - r.spawnTime < RIPPLE_DURATION_MS);

  if (justRing) {
    const age = now - justRing.spawnTime;
    if (age < SPARKLE_DURATION_MS) {
      const t = clamp(age / SPARKLE_DURATION_MS, 0, 1);
      const y = HORIZON_Y + (currentBounce ? getBounceY(currentBounce, songPosition) : 0);
      ctx.save();
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = `rgb(${SPARKLE_COLOR_JUST})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(STONE_SCREEN_X, y, 10 + t * 30, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    } else {
      justRing = null;
    }
  }

  sparkles = sparkles.filter((s) => now - s.spawnTime < SPARKLE_DURATION_MS);
  for (const s of sparkles) {
    const age = now - s.spawnTime;
    const t = clamp(age / SPARKLE_DURATION_MS, 0, 1);
    const x = s.x + s.vx * age;
    const y = s.y + s.vy * age;
    const size = (s.isJust ? 7 : 4.5) * (1 - t * 0.6);

    ctx.save();
    ctx.globalAlpha = 1 - t;
    ctx.fillStyle = `rgb(${s.isJust ? SPARKLE_COLOR_JUST : SPARKLE_COLOR_GOOD})`;
    ctx.translate(x, y);
    if (s.shape === "star") drawStar(ctx, size);
    else drawDiamond(ctx, size);
    ctx.restore();
  }
}

export function drawFrame(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  songPosition: number,
): void {
  const now = performance.now();
  updateIntroPhase(songPosition, now);

  // Missへの遷移をここで検知し、沈み込み演出を開始する。表示距離も沈み込みと同じ
  // 区間で0へなめらかに戻す（Missした時点で距離の伸びが止まり、沈むにつれて背景の
  // 進みも戻っていくように見せるため）。
  if (state.lastJudge === "miss" && prevLastJudge !== "miss") {
    missAnimStartTime = now;
    currentBounce = null;
    rampDisplayedDistanceTo(0, songPosition, songPosition + SINK_DURATION_MS);
  }
  prevLastJudge = state.lastJudge;

  ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  const displayedDistance = getDisplayedDistance(songPosition);
  drawSky(ctx, getSkyOffsetX(displayedDistance));
  drawWater(ctx, getWaterOffsetX(displayedDistance));
  drawShore(ctx, now);

  for (const r of ripples) {
    drawRipple(ctx, r.x, now - r.spawnTime);
  }

  if (intro.phase === "throwing") {
    const { x, yOffset, scale } = getIntroThrowPos(songPosition);
    drawNote(ctx, state.noteType, x, yOffset, scale, 1);
  } else {
    let yOffset: number;
    let scale = 1;
    let alpha = 1;

    if (state.lastJudge === "miss" && missAnimStartTime !== null) {
      const t = clamp((now - missAnimStartTime) / SINK_DURATION_MS, 0, 1);
      yOffset = t * 24; // 水平線より下へ沈んでいく
      scale = 1 - t * 0.6;
      alpha = 1 - t;

      if (t >= 1) {
        // 沈み切ったら、クリックを待たずに自動で岸からの投げ込み演出を再開する
        beginIntroThrow(now, songPosition, songPosition + INTRO_THROW_DURATION_MS);
      }
    } else {
      yOffset = currentBounce ? getBounceY(currentBounce, songPosition) : 0;
    }

    if (alpha > 0) {
      drawNote(ctx, state.noteType, STONE_SCREEN_X, yOffset, scale, alpha);
    }
  }

  drawSparkles(ctx, songPosition);
}
