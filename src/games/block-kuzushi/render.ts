import {
  computeBlockRect,
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  PADDLE_LINE_Y,
  PADDLE_WIDTH,
  PADDLE_HEIGHT,
  BALL_RADIUS,
  type GameState,
  type WordBlock,
} from "./game.ts";

export { CANVAS_WIDTH, CANVAS_HEIGHT };

export const FONT_FAMILY = '"DotGothic16", "Courier New", monospace';

// 水切リズムの水辺配色とは別の、暗めのアーケード配色
const BG_COLOR = "#12121c";
const BLOCK_COLOR_FULL = "#ff5da2";
const BLOCK_COLOR_DAMAGED = "#7a3157";
const BLOCK_TEXT_COLOR = "#fff6fb";
const PADDLE_COLOR = "#4de2ff";
const BALL_COLOR = "#ffe066";

// 表示サイズのfit処理はCSS側（.bk-canvas-wrap の aspect-ratio + min()）に委譲するため、
// 水切リズムのresizeToFit相当のJS関数・resizeイベントリスナーはここでは持たない。

// マウス座標→Canvas内部座標変換。canvas.getBoundingClientRect()の表示サイズと
// Canvas内部解像度（CANVAS_WIDTH）の比率から算出する（CSSでの表示サイズが内部解像度と
// 異なることを前提とした実装。水切リズムはカーソル座標を使わないため前例なし）。
export function clientXToCanvasX(canvas: HTMLCanvasElement, clientX: number): number {
  const rect = canvas.getBoundingClientRect();
  const scaleX = CANVAS_WIDTH / rect.width;
  return (clientX - rect.left) * scaleX;
}

function drawBackground(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
}

function drawBlock(ctx: CanvasRenderingContext2D, block: WordBlock, songPosition: number): void {
  const rect = computeBlockRect(block, songPosition);
  const damaged = block.hitPoints < block.maxHitPoints;

  ctx.fillStyle = damaged ? BLOCK_COLOR_DAMAGED : BLOCK_COLOR_FULL;
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);

  ctx.fillStyle = BLOCK_TEXT_COLOR;
  ctx.font = `18px ${FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(block.text, rect.x + rect.width / 2, rect.y + rect.height / 2);
}

function drawPaddle(ctx: CanvasRenderingContext2D, paddleX: number): void {
  ctx.fillStyle = PADDLE_COLOR;
  ctx.fillRect(paddleX - PADDLE_WIDTH / 2, PADDLE_LINE_Y, PADDLE_WIDTH, PADDLE_HEIGHT);
}

function drawBall(ctx: CanvasRenderingContext2D, state: GameState): void {
  if (!state.ball.alive) return;
  ctx.fillStyle = BALL_COLOR;
  ctx.beginPath();
  ctx.arc(state.ball.x, state.ball.y, BALL_RADIUS, 0, Math.PI * 2);
  ctx.fill();
}

export function drawFrame(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  songPosition: number,
): void {
  drawBackground(ctx);
  for (const block of state.blocks) {
    drawBlock(ctx, block, songPosition);
  }
  drawPaddle(ctx, state.paddleX);
  drawBall(ctx, state);
}
