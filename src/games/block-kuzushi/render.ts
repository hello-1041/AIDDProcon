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

// 水切リズムの水辺配色とは別の配色だが、明るさの方向性は揃える
// （暗いアーケード配色は「暗い」との指摘を受けて、明るい配色に変更した）
const BG_COLOR = "#eaf7ff";
const BLOCK_COLOR_FULL = "#ff5da2";
const BLOCK_COLOR_DAMAGED = "#ffc2df";
const BLOCK_TEXT_COLOR = "#ffffff";
const PADDLE_COLOR = "#1c7ed6";
const BALL_COLOR = "#ff9f1c";

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

// 当たり判定はcomputeBlockRectのAABB（矩形）のまま変更しないが、見た目は素の矩形の
// 塗りつぶしではなく、文字を包む丸みのある「チップ」形状にする（「ブロックが正方形で
// 文字の形そのままであってほしい」という指摘への対応）。角の半径をrect.height/2にして
// 完全な丸みを持たせることで、単なる四角い箱ではなく単語そのものの見た目に近づける。
// 矩形はcomputeBlockRectと完全に同じものを使うため、見た目と当たり判定はズレない。
function drawBlock(ctx: CanvasRenderingContext2D, block: WordBlock, songPosition: number): void {
  const rect = computeBlockRect(block, songPosition);
  const damaged = block.hitPoints < block.maxHitPoints;
  const radius = rect.height / 2;

  ctx.fillStyle = damaged ? BLOCK_COLOR_DAMAGED : BLOCK_COLOR_FULL;
  ctx.beginPath();
  ctx.roundRect(rect.x, rect.y, rect.width, rect.height, radius);
  ctx.fill();

  ctx.fillStyle = BLOCK_TEXT_COLOR;
  ctx.font = `bold 18px ${FONT_FAMILY}`;
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
