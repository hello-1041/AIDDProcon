/**
 * canvas描画（製造計画書4.2・4.3・4.4・4.6・5.3・5.4）。
 *
 * 投影はview.tsが済ませ、ここは受け取ったスクリーン座標を描くだけにする。投影と
 * 描画が同居すると、天球が裏返ったときに原因の切り分けができなくなる（9章）。
 */

import {
  AZ_COLS,
  CELL_DEG,
  EL_MAX,
  EL_MIN,
  PREVIEW_MS,
  ROWS,
  STAR_DELAY_MS,
  colToAzimuthDeg,
  rowToElevationDeg,
  wrapCol,
  type PlacedChar,
  type Placement,
} from "./sphere.ts";
import type { CharState } from "./game.ts";
import {
  createProjection,
  directionOf,
  project,
  projectAngles,
  visibleRange,
  type Projection,
  type ViewState,
} from "./view.ts";

// 配色（4.3）。style.cssのカスタムプロパティと同じ値を持つ。canvasはCSS変数を
// 直接解決しないため、ここに定数として置く（CSS側が正、ここが写し）。
const COLOR_BG = "#070d18";
const COLOR_GRID = "rgba(120,180,220,0.18)";
const COLOR_GRID_MAJOR = "rgba(150,200,235,0.38)";
const COLOR_HORIZON = "rgba(160,205,235,0.55)";
const COLOR_PENDING = "#6f8aa6";
const COLOR_LIT = "#39C5BB";
const COLOR_STAR = "rgba(200,235,240,0.55)";
const COLOR_LOST = "rgba(120,140,160,0.22)";

// 点灯時の粒子バースト（4.6）。6色を巡回させる。粒子は一瞬であり可読性に影響せず、
// 色に意味を持たせないため誤読も起きない。否定的な状態（lost）には使わない。
const PARTICLE_COLORS = [
  "#39C5BB", // 初音ミク
  "#FFE211", // 鏡音リン
  "#FF9900", // 鏡音レン
  "#FF7BAC", // 巡音ルカ
  "#00AEEF", // KAITO
  "#C9007A", // MEIKO
];

const FONT_FAMILY = '"DotGothic16", "Courier New", monospace';

/** 文字サイズはセル寸法の0.62倍（4.4）。投影後のセル幅から毎フレーム算出する。 */
const CHAR_SIZE_RATIO = 0.62;

const PARTICLE_MS = 420;
const LIGHT_ANIM_MS = 180; // 点灯の色遷移（4.6）
const STAR_FADE_MS = 800; // 星化のフェード（4.6）
const LOST_FADE_MS = 600; // 沈黙のフェード（4.6）

// ================================================================== canvas管理

export interface Canvas2D {
  el: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
}

export function attachCanvas(el: HTMLCanvasElement): Canvas2D {
  const ctx = el.getContext("2d")!;
  return { el, ctx, width: 0, height: 0 };
}

/**
 * canvasの実解像度をCSS表示サイズへ合わせる。
 *
 * devicePixelRatioは2で打ち止めにする（4.2）。高DPRのスマートフォンで実解像度の
 * まま描くと、得るものなく重くなる。resize/orientationchangeから呼び直すこと
 * （11章。横長固定の案内を出す都合上、回転は必ず起きる）。
 */
export function resizeCanvas(canvas: Canvas2D): void {
  const rect = canvas.el.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(rect.width));
  canvas.height = Math.max(1, Math.round(rect.height));
  canvas.el.width = Math.round(canvas.width * dpr);
  canvas.el.height = Math.round(canvas.height * dpr);
  canvas.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// ==================================================================== 粒子

interface Particle {
  x: number;
  y: number;
  angle: number;
  color: string;
  bornAt: number;
}

let particles: Particle[] = [];
let particleColorCursor = 0;

/** 点灯した文字の位置から粒子8個を放射する（4.6）。 */
export function spawnParticles(x: number, y: number, now: number): void {
  const color = PARTICLE_COLORS[particleColorCursor % PARTICLE_COLORS.length];
  particleColorCursor++;
  for (let i = 0; i < 8; i++) {
    particles.push({ x, y, angle: (i / 8) * Math.PI * 2, color, bornAt: now });
  }
}

export function clearParticles(): void {
  particles = [];
}

function drawParticles(ctx: CanvasRenderingContext2D, now: number): void {
  if (particles.length === 0) return;
  const alive: Particle[] = [];

  for (const p of particles) {
    const t = (now - p.bornAt) / PARTICLE_MS;
    if (t >= 1) continue;
    alive.push(p);
    const radius = 20 * t;
    ctx.globalAlpha = 1 - t;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x + Math.cos(p.angle) * radius, p.y + Math.sin(p.angle) * radius, 1.6, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.globalAlpha = 1;
  particles = alive;
}

// ================================================================== 格子の描画

/**
 * 緯線・経線を描く（5.3）。
 *
 * 両端がともにカメラ前方にある線分だけを描く。視野内に欠けは生じない（Z<=0と
 * なるのは視線から90°離れた位置であり、視野の端は最大37.5°に過ぎない）。
 */
function drawGrid(
  ctx: CanvasRenderingContext2D,
  proj: Projection,
  view: ViewState,
  beatGlow: number,
): void {
  const range = visibleRange(view, proj.width, proj.height);

  ctx.lineWidth = 1;

  // 緯線（仰角固定）。水平線（EL_MIN - CELL_DEG/2 の高さ）は別に描く。
  for (let row = range.rowMin; row <= range.rowMax; row++) {
    const el = rowToElevationDeg(row) - CELL_DEG / 2;
    const major = Math.abs((rowToElevationDeg(row) % 15) - 0) < 0.001;
    ctx.strokeStyle = major ? COLOR_GRID_MAJOR : COLOR_GRID;
    ctx.globalAlpha = beatGlow;
    strokeArc(ctx, proj, range, (az) => directionOf(az, el));
  }

  // 経線（方位角固定）。
  const elLo = rowToElevationDeg(range.rowMin) - CELL_DEG / 2;
  const elHi = rowToElevationDeg(range.rowMax) + CELL_DEG / 2;
  for (let i = 0; i < range.colCount; i++) {
    const col = wrapCol(range.colStart + i);
    const az = colToAzimuthDeg(col) - CELL_DEG / 2;
    const major = colToAzimuthDeg(col) % 15 === 0;
    ctx.strokeStyle = major ? COLOR_GRID_MAJOR : COLOR_GRID;
    ctx.globalAlpha = beatGlow;

    ctx.beginPath();
    let started = false;
    for (let el = elLo; el <= elHi + 0.001; el += CELL_DEG) {
      const p = projectAngles(proj, az, el);
      if (p.z <= 0.05) {
        started = false;
        continue;
      }
      if (started) ctx.lineTo(p.x, p.y);
      else {
        ctx.moveTo(p.x, p.y);
        started = true;
      }
    }
    ctx.stroke();
  }

  // 水平線（4.4）。天球の下端を明示する。
  ctx.strokeStyle = COLOR_HORIZON;
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 1;
  strokeArc(ctx, proj, range, (az) => directionOf(az, 0));
  ctx.lineWidth = 1;
  ctx.globalAlpha = 1;
}

/** 可視範囲の方位角を CELL_DEG 刻みで進めた点列を結ぶ（5.3）。 */
function strokeArc(
  ctx: CanvasRenderingContext2D,
  proj: Projection,
  range: { colStart: number; colCount: number },
  dirOf: (azDeg: number) => [number, number, number],
): void {
  ctx.beginPath();
  let started = false;
  for (let i = 0; i <= range.colCount; i++) {
    const az = colToAzimuthDeg(wrapCol(range.colStart + i));
    const p = project(proj, dirOf(az));
    if (p.z <= 0.05) {
      started = false;
      continue;
    }
    if (started) ctx.lineTo(p.x, p.y);
    else {
      ctx.moveTo(p.x, p.y);
      started = true;
    }
  }
  ctx.stroke();
}

// ================================================================== 文字の描画

/** 状態ごとの色と不透明度を決める（4.3・4.6）。 */
function charAppearance(
  state: CharState,
  elapsed: number,
): { color: string; alpha: number; scale: number } | null {
  switch (state) {
    case "hidden":
      return null;
    case "pending": {
      // 淡く拍動する芽（3.3）。
      const pulse = 0.55 + 0.25 * Math.sin(elapsed / 260);
      return { color: COLOR_PENDING, alpha: pulse, scale: 0.85 };
    }
    case "lit": {
      // scaleを0.8→1.15→1.0とバウンドさせる（4.6。等速フェードは使わない）。
      const t = Math.min(1, elapsed / LIGHT_ANIM_MS);
      const scale = t < 0.5 ? 0.8 + 0.7 * (t / 0.5) : 1.15 - 0.15 * ((t - 0.5) / 0.5);
      return { color: COLOR_LIT, alpha: 1, scale };
    }
    case "star": {
      // 800msかけて輝度とサイズを落とす（4.6）。
      const t = Math.min(1, elapsed / STAR_FADE_MS);
      return { color: COLOR_STAR, alpha: 1 - 0.45 * t, scale: 1 - 0.3 * t };
    }
    case "lost": {
      // 600msで沈める。色で叱責しない（4.6。無彩色で表現する）。
      const t = Math.min(1, elapsed / LOST_FADE_MS);
      return { color: COLOR_LOST, alpha: 0.35 + 0.65 * (1 - t) * 0.3, scale: 1 };
    }
  }
}

interface CharDrawContext {
  placement: Placement;
  charStates: CharState[];
  changedAt: number[];
  songPosition: number;
  /** サビ中のみ文字スケール+3%（3.4）。 */
  beatScale: number;
}

/**
 * 可視範囲のセルに載っている文字だけを描く（5.3・5.4）。
 *
 * 毎フレーム全2760セルを走査しない（11章）。行列→文字の逆引きを事前に作って
 * おき、可視矩形だけを回す。
 */
function drawChars(
  ctx: CanvasRenderingContext2D,
  proj: Projection,
  view: ViewState,
  cellMap: Int32Array<ArrayBuffer>,
  dc: CharDrawContext,
): void {
  const range = visibleRange(view, proj.width, proj.height);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (let row = range.rowMin; row <= range.rowMax; row++) {
    const el = rowToElevationDeg(row);
    for (let i = 0; i < range.colCount; i++) {
      const col = wrapCol(range.colStart + i);
      const charIndex = cellMap[row * AZ_COLS + col];
      if (charIndex === -1) continue;

      const state = dc.charStates[charIndex];
      const look = charAppearance(state, dc.songPosition - dc.changedAt[charIndex]);
      if (look === null) continue;

      const p = projectAngles(proj, colToAzimuthDeg(col), el);
      if (p.z <= 0.05) continue;

      const size = p.scale * CHAR_SIZE_RATIO * look.scale * dc.beatScale;
      if (size < 4) continue; // 読めない大きさなら描かない（5.4の描画量削減も兼ねる）

      ctx.globalAlpha = look.alpha;
      ctx.fillStyle = look.color;
      ctx.font = `${size.toFixed(1)}px ${FONT_FAMILY}`;
      ctx.fillText(dc.placement.chars[charIndex].text, p.x, p.y);
    }
  }
  ctx.globalAlpha = 1;
}

/** 行列からの逆引き表を作る。配置計画と同じく、ロード時に1回だけ作る。 */
export function buildCellMap(placement: Placement): Int32Array<ArrayBuffer> {
  const map = new Int32Array(ROWS * AZ_COLS);
  map.fill(-1);
  placement.chars.forEach((char, index) => {
    map[char.row * AZ_COLS + char.col] = index;
  });
  return map;
}

// ==================================================================== 予兆

/**
 * 次フレーズの開始セルに、発声PREVIEW_MS前からリング状のパルスを出す（4.6）。
 * 画面外の場合の方角インジケータはui.ts側（DOM）が担当する。
 */
function drawPreviewRing(
  ctx: CanvasRenderingContext2D,
  proj: Projection,
  char: PlacedChar,
  songPosition: number,
): void {
  const remain = char.startTime - songPosition;
  if (remain < 0 || remain > PREVIEW_MS) return;

  const p = projectAngles(proj, colToAzimuthDeg(char.col), rowToElevationDeg(char.row));
  if (p.z <= 0.05) return;

  // 発声が近づくほど速く、小さく締まるリング。
  const phase = 1 - remain / PREVIEW_MS;
  const pulse = (songPosition / 500) % 1;
  const radius = p.scale * (1.6 - 0.6 * phase) * (1 + 0.25 * pulse);

  ctx.strokeStyle = COLOR_LIT;
  ctx.globalAlpha = (0.25 + 0.5 * phase) * (1 - pulse);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

// ================================================================ 星座（3.7）

/**
 * 点灯・星化した文字を、フレーズ内だけ歌唱順に結ぶ（3.7）。
 *
 * フレーズ間は結ばない。歌唱順に全部を繋ぐと、折れ線が天球を何周も横断して
 * 汚くなる。
 */
export function buildConstellation(
  placement: Placement,
  charStates: CharState[],
): number[][] {
  const lines: number[][] = [];
  let current: number[] = [];
  let currentPhrase = -1;

  placement.chars.forEach((char, index) => {
    const litOrStar = charStates[index] === "lit" || charStates[index] === "star";
    if (char.phraseIndex !== currentPhrase) {
      if (current.length >= 2) lines.push(current);
      current = [];
      currentPhrase = char.phraseIndex;
    }
    if (litOrStar) current.push(index);
    else {
      // 点灯していない文字で線を切る（見た範囲だけが繋がる）。
      if (current.length >= 2) lines.push(current);
      current = [];
    }
  });
  if (current.length >= 2) lines.push(current);

  return lines;
}

function drawConstellation(
  ctx: CanvasRenderingContext2D,
  proj: Projection,
  placement: Placement,
  lines: number[][],
): void {
  ctx.strokeStyle = COLOR_STAR;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 1;

  for (const line of lines) {
    ctx.beginPath();
    let started = false;
    for (const index of line) {
      const char = placement.chars[index];
      const p = projectAngles(proj, colToAzimuthDeg(char.col), rowToElevationDeg(char.row));
      if (p.z <= 0.05) {
        started = false;
        continue;
      }
      if (started) ctx.lineTo(p.x, p.y);
      else {
        ctx.moveTo(p.x, p.y);
        started = true;
      }
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

// ============================================================== プレイ画面の描画

export interface FrameInput {
  placement: Placement;
  cellMap: Int32Array<ArrayBuffer>;
  charStates: CharState[];
  changedAt: number[];
  songPosition: number;
  /** ビートに合わせた格子輝度（±25%）と文字スケール（サビ中のみ+3%）（3.4）。 */
  beatGlow: number;
  beatScale: number;
  /** 予兆を出すフレーズ頭の添字。無ければnull。 */
  previewIndex: number | null;
  /** 曲終了後の星座線。プレイ中はnull。 */
  constellation: number[][] | null;
}

/** 1フレーム描く。投影はここで組み、view.tsの関数へ渡すだけにする。 */
export function drawFrame(canvas: Canvas2D, view: ViewState, input: FrameInput): Projection {
  const { ctx } = canvas;
  const proj = createProjection(view, canvas.width, canvas.height);

  ctx.fillStyle = COLOR_BG;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  drawGrid(ctx, proj, view, input.beatGlow);

  if (input.constellation) {
    drawConstellation(ctx, proj, input.placement, input.constellation);
  }

  drawChars(ctx, proj, view, input.cellMap, {
    placement: input.placement,
    charStates: input.charStates,
    changedAt: input.changedAt,
    songPosition: input.songPosition,
    beatScale: input.beatScale,
  });

  if (input.previewIndex !== null) {
    drawPreviewRing(ctx, proj, input.placement.chars[input.previewIndex], input.songPosition);
  }

  drawParticles(ctx, input.songPosition);

  return proj;
}

// ================================================================ 全天図（3.8）

/**
 * 天球を真上から見た円形の投影を1枚描く（3.8）。
 *
 * 天頂を中心、水平線を外周とし、半径は (EL_MAX - el) / (EL_MAX - EL_MIN)。
 * 見なかった方角は空白として残る。これが本作の持ち帰りの絵である。
 */
export function drawSkyMap(
  canvas: Canvas2D,
  placement: Placement,
  charStates: CharState[],
  lines: number[][],
): void {
  const { ctx } = canvas;
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const radius = Math.min(cx, cy) * 0.92;

  ctx.fillStyle = COLOR_BG;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 外周（水平線）と、15°ごとの目安円。
  ctx.strokeStyle = COLOR_HORIZON;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = COLOR_GRID;
  ctx.lineWidth = 1;
  for (let el = EL_MIN + 15; el < EL_MAX; el += 15) {
    const r = radius * ((EL_MAX - el) / (EL_MAX - EL_MIN));
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  const pointOf = (char: PlacedChar): [number, number] => {
    const el = rowToElevationDeg(char.row);
    const r = radius * ((EL_MAX - el) / (EL_MAX - EL_MIN));
    const az = colToAzimuthDeg(char.col) * (Math.PI / 180);
    return [cx + r * Math.sin(az), cy - r * Math.cos(az)];
  };

  // 星座線（3.7と同じものを使う）。
  ctx.strokeStyle = COLOR_STAR;
  ctx.globalAlpha = 0.45;
  for (const line of lines) {
    ctx.beginPath();
    line.forEach((index, i) => {
      const [x, y] = pointOf(placement.chars[index]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // 点灯した文字を点で描く。見なかった方角は空白のまま残す。
  placement.chars.forEach((char, index) => {
    const state = charStates[index];
    if (state !== "lit" && state !== "star") return;
    const [x, y] = pointOf(char);
    ctx.fillStyle = COLOR_LIT;
    ctx.beginPath();
    ctx.arc(x, y, 1.6, 0, Math.PI * 2);
    ctx.fill();
  });
}

export { STAR_DELAY_MS };
