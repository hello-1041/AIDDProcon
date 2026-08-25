import type { LyricWordEntry } from "./textalive.ts";

export const CANVAS_WIDTH = 400;
export const CANVAS_HEIGHT = 620; // 情報バー分は含まない（CSS側の--bk-header-heightで別途確保）

// 以下、暫定パラメータ（すべて実装計画書に明記された初期値。実プレイでの調整が必要）
export const FALL_DURATION_MS = 4000;
export const MAX_CONCURRENT_BLOCKS = 3; // 3レーン固定レイアウトとして使う

export const PADDLE_WIDTH = 84;
export const PADDLE_HEIGHT = 12;
export const PADDLE_MAX_SPEED_PX_PER_MS = 3;
export const PADDLE_KEY_SPEED_PX_PER_MS = 0.5;
export const PADDLE_LINE_Y = CANVAS_HEIGHT - 40; // パドル上端のY座標

export const BALL_RADIUS = 7;
export const BALL_SPEED_PX_PER_MS = 0.35;
export const BALL_MAX_BOUNCE_ANGLE_DEG = 60;
export const BALL_RESPAWN_DELAY_MS = 800;

export const BLOCK_HEIGHT = 36;
export const BLOCK_MIN_WIDTH = 56;
export const BLOCK_PADDING_X = 10;
export const CHAR_WIDTH_PX = 20;

export type Screen = "title" | "play" | "result";

export interface WordResult {
  text: string;
  collected: boolean;
}

export interface WordBlock {
  wordIndex: number;
  text: string;
  hitPoints: number;
  maxHitPoints: number;
  lane: number;
  spawnSongTime: number;
  arrivalSongTime: number; // spawnSongTime + FALL_DURATION_MS（画面下端を完全に抜ける再生位置）
}

export interface BlockRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BallState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  alive: boolean;
  respawnAtSongTime: number;
}

export interface GameState {
  screen: Screen;
  wordEntries: LyricWordEntry[];
  wordResults: WordResult[];
  wordCursor: number; // 次に生成する単語のインデックス（player.video.words順）
  blocks: WordBlock[];
  collectedCount: number;
  paddleX: number;
  paddleTargetX: number;
  leftHeld: boolean;
  rightHeld: boolean;
  ball: BallState;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function createInitialBall(paddleX: number): BallState {
  return {
    x: paddleX,
    y: PADDLE_LINE_Y - BALL_RADIUS - 1,
    vx: 0,
    vy: -BALL_SPEED_PX_PER_MS,
    alive: true,
    respawnAtSongTime: 0,
  };
}

export function createInitialState(wordEntries: LyricWordEntry[]): GameState {
  const paddleX = CANVAS_WIDTH / 2;
  return {
    screen: "title",
    wordEntries,
    wordResults: wordEntries.map((w) => ({ text: w.text, collected: false })),
    wordCursor: 0,
    blocks: [],
    collectedCount: 0,
    paddleX,
    paddleTargetX: paddleX,
    leftHeld: false,
    rightHeld: false,
    ball: createInitialBall(paddleX),
  };
}

export function computeHitPoints(charCount: number, kanjiRatio: number): number {
  return 1 + Math.floor(charCount / 3) + (kanjiRatio >= 0.5 ? 1 : 0);
}

export function computeBlockWidth(charCount: number): number {
  return Math.max(BLOCK_MIN_WIDTH, charCount * CHAR_WIDTH_PX + BLOCK_PADDING_X * 2);
}

// 当たり判定（このファイル内）と描画（render.ts）の両方が、この関数から同じブロック矩形を
// 得る。「移動体専用アルゴリズム」は作らず、毎フレームここで現在位置を再計算してから
// 通常の静的AABB判定を行う（降ってくる、という性質は「毎フレーム座標が変わる」だけとして
// 扱う）。高速球によるすり抜け（トンネリング）は本実装のスコープ外。
export function computeBlockRect(block: WordBlock, songPosition: number): BlockRect {
  const width = computeBlockWidth(block.text.length);
  const laneWidth = CANVAS_WIDTH / MAX_CONCURRENT_BLOCKS;
  const x = laneWidth * (block.lane + 0.5) - width / 2;

  const span = block.arrivalSongTime - block.spawnSongTime;
  const t = span > 0 ? (songPosition - block.spawnSongTime) / span : 1;
  // 画面上端の外（-BLOCK_HEIGHT）から画面下端の外（CANVAS_HEIGHT、完全に抜けた位置）まで
  // 等速で移動させる。tは1を超えることもあるが、removeMissedBlocksが先に取り除く前提。
  const y = -BLOCK_HEIGHT + (CANVAS_HEIGHT + BLOCK_HEIGHT) * t;

  return { x, y, width, height: BLOCK_HEIGHT };
}

export function setPaddleTargetX(state: GameState, x: number): void {
  state.paddleTargetX = clamp(x, PADDLE_WIDTH / 2, CANVAS_WIDTH - PADDLE_WIDTH / 2);
}

export function setKeyHeld(state: GameState, key: "left" | "right", held: boolean): void {
  if (key === "left") state.leftHeld = held;
  else state.rightHeld = held;
}

// マウス（即座に目標を上書き）とキーボード（目標を押している間だけ連続的に動かす）の
// どちらも「パドル目標X座標」を書き換えるだけにし、実際のpaddleXはPADDLE_MAX_SPEED_PX_PER_MS
// で目標へ追従させる。入力方式を問わず同じ経路で処理されるため、両方を同時に使っても
// 干渉しない。
function updatePaddlePosition(state: GameState, dtMs: number): void {
  if (state.leftHeld) state.paddleTargetX -= PADDLE_KEY_SPEED_PX_PER_MS * dtMs;
  if (state.rightHeld) state.paddleTargetX += PADDLE_KEY_SPEED_PX_PER_MS * dtMs;
  state.paddleTargetX = clamp(state.paddleTargetX, PADDLE_WIDTH / 2, CANVAS_WIDTH - PADDLE_WIDTH / 2);

  const maxStep = PADDLE_MAX_SPEED_PX_PER_MS * dtMs;
  const delta = clamp(state.paddleTargetX - state.paddleX, -maxStep, maxStep);
  state.paddleX = clamp(state.paddleX + delta, PADDLE_WIDTH / 2, CANVAS_WIDTH - PADDLE_WIDTH / 2);
}

// 歌詞が密な区間では、startTimeから逆算した理想生成時刻ではなく、「空きスロットができた
// 瞬間に、まだ生成していない単語を順番に生成する」方式にする（製造計画書で合意済みの
// 簡略化。歌の発声タイミングとのズレが生じうる）。
// ただし、この「空きスロットができた瞬間」を無条件の生成条件にすると、ゲーム開始直後
// （イントロ中、歌詞がまだ始まっていない時刻）に全レーンが同時に空いているため、
// 最初の3単語が本来歌われるタイミングを無視して一斉に降り始めてしまう不具合があった。
// 単語の実際のstartTimeに落下時間（FALL_DURATION_MS）分だけ手前になるまでは生成を待つ
// ことで、この「イントロで先落ちする」問題を解消する（歌詞が密な区間では、この条件は
// 既に満たされているため、従来通り即時生成される）。
function trySpawnBlocks(state: GameState, songPosition: number): void {
  for (let lane = 0; lane < MAX_CONCURRENT_BLOCKS; lane++) {
    if (state.wordCursor >= state.wordEntries.length) return;
    if (state.blocks.some((b) => b.lane === lane)) continue;

    const entry = state.wordEntries[state.wordCursor];
    if (songPosition < entry.startTime - FALL_DURATION_MS) return;
    const hitPoints = computeHitPoints(entry.charCount, entry.kanjiRatio);
    state.blocks.push({
      wordIndex: state.wordCursor,
      text: entry.text,
      hitPoints,
      maxHitPoints: hitPoints,
      lane,
      spawnSongTime: songPosition,
      arrivalSongTime: songPosition + FALL_DURATION_MS,
    });
    state.wordCursor += 1;
  }
}

// ブロックが画面下端を完全に抜けたら、ペナルティなく静かに取り除く。
// ボールとの衝突判定（updateBall）より先に行うことで、既に抜けたブロックへ衝突判定を
// 行わないようにする。
function removeMissedBlocks(state: GameState, songPosition: number): void {
  state.blocks = state.blocks.filter(
    (b) => computeBlockRect(b, songPosition).y < CANVAS_HEIGHT,
  );
}

function resolveBallPaddleCollision(state: GameState): void {
  const { ball, paddleX } = state;
  if (ball.vy <= 0) return; // 上昇中はパドルと衝突しえない

  const paddleTop = PADDLE_LINE_Y;
  const paddleLeft = paddleX - PADDLE_WIDTH / 2;
  const paddleRight = paddleX + PADDLE_WIDTH / 2;

  const ballBottom = ball.y + BALL_RADIUS;
  if (ballBottom < paddleTop || ball.y > paddleTop + PADDLE_HEIGHT) return;
  if (ball.x + BALL_RADIUS < paddleLeft || ball.x - BALL_RADIUS > paddleRight) return;

  // パドル中心からのヒット位置（-1〜1）を反射角に変換する。中心ほど垂直に、端ほど
  // BALL_MAX_BOUNCE_ANGLE_DEGに近い角度で跳ね返る。
  const hitOffset = clamp((ball.x - paddleX) / (PADDLE_WIDTH / 2), -1, 1);
  const angleRad = (hitOffset * BALL_MAX_BOUNCE_ANGLE_DEG * Math.PI) / 180;
  ball.vx = BALL_SPEED_PX_PER_MS * Math.sin(angleRad);
  ball.vy = -BALL_SPEED_PX_PER_MS * Math.cos(angleRad);
  ball.y = paddleTop - BALL_RADIUS;
}

// X/Y貫通量比較で反射軸を決める簡易手法。衝突していればtrueを返す。
// 反射後、ボールをブロックの外側へ押し出す（位置補正）ことが重要：これを省略すると、
// 速度を反転させただけではボールが1フレームでブロックの外まで抜けきらず、次のフレームでも
// 同じブロックとの重なりが検出されて再度ヒット判定されてしまう。この「1回の跳ね返りで
// 複数フレームぶん多重にhitPointsが減る」不具合により、本来複数回当てないと壊れないはずの
// 漢字・多文字数のブロックが一度の接触で壊れて見えていた。
function resolveBallBlockCollision(ball: BallState, rect: BlockRect): boolean {
  const ballLeft = ball.x - BALL_RADIUS;
  const ballRight = ball.x + BALL_RADIUS;
  const ballTop = ball.y - BALL_RADIUS;
  const ballBottom = ball.y + BALL_RADIUS;
  const rectLeft = rect.x;
  const rectRight = rect.x + rect.width;
  const rectTop = rect.y;
  const rectBottom = rect.y + rect.height;

  const overlapping =
    ballRight > rectLeft && ballLeft < rectRight && ballBottom > rectTop && ballTop < rectBottom;
  if (!overlapping) return false;

  const overlapX = Math.min(ballRight, rectRight) - Math.max(ballLeft, rectLeft);
  const overlapY = Math.min(ballBottom, rectBottom) - Math.max(ballTop, rectTop);

  if (overlapX < overlapY) {
    ball.vx = -ball.vx;
    ball.x = ball.x < rectLeft + rect.width / 2 ? rectLeft - BALL_RADIUS : rectRight + BALL_RADIUS;
  } else {
    ball.vy = -ball.vy;
    ball.y = ball.y < rectTop + rect.height / 2 ? rectTop - BALL_RADIUS : rectBottom + BALL_RADIUS;
  }
  return true;
}

function updateBall(state: GameState, songPosition: number, dtMs: number): void {
  const { ball } = state;
  if (!ball.alive) return;

  ball.x += ball.vx * dtMs;
  ball.y += ball.vy * dtMs;

  if (ball.x - BALL_RADIUS < 0) {
    ball.x = BALL_RADIUS;
    ball.vx = -ball.vx;
  } else if (ball.x + BALL_RADIUS > CANVAS_WIDTH) {
    ball.x = CANVAS_WIDTH - BALL_RADIUS;
    ball.vx = -ball.vx;
  }
  if (ball.y - BALL_RADIUS < 0) {
    ball.y = BALL_RADIUS;
    ball.vy = -ball.vy;
  }

  resolveBallPaddleCollision(state);

  for (const block of state.blocks) {
    const rect = computeBlockRect(block, songPosition);
    if (!resolveBallBlockCollision(ball, rect)) continue;

    block.hitPoints -= 1;
    if (block.hitPoints <= 0) {
      state.blocks = state.blocks.filter((b) => b !== block);
      state.wordResults[block.wordIndex].collected = true;
      state.collectedCount += 1;
    }
    break; // 1フレームにつき1ブロックまでの衝突解決（多重反射を避ける）
  }

  // 取りこぼしはペナルティなし。一定時間後に新しいボールを再出現させる（respawnBallIfDue）。
  if (ball.y - BALL_RADIUS > CANVAS_HEIGHT) {
    ball.alive = false;
    ball.respawnAtSongTime = songPosition + BALL_RESPAWN_DELAY_MS;
  }
}

function respawnBallIfDue(state: GameState, songPosition: number): void {
  if (!state.ball.alive && songPosition >= state.ball.respawnAtSongTime) {
    state.ball = createInitialBall(state.paddleX);
  }
}

// 順序はミス判定（removeMissedBlocks）を衝突判定（updateBall）より先に行う：
// 既に画面外に抜けたブロックへボールが衝突しないようにするため。
export function update(state: GameState, songPosition: number, dtMs: number): void {
  updatePaddlePosition(state, dtMs);
  trySpawnBlocks(state, songPosition);
  removeMissedBlocks(state, songPosition);
  updateBall(state, songPosition, dtMs);
  respawnBallIfDue(state, songPosition);
}

export function getScorePercent(state: GameState): number {
  const total = state.wordEntries.length;
  if (total === 0) return 0;
  return Math.min(100, (state.collectedCount / total) * 100);
}

export function finishChallenge(state: GameState): void {
  state.screen = "result";
}
