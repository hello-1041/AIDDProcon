/**
 * 視点の状態・投影・入力（製造計画書3.5・3.6・5章）。
 *
 * 描画（render.ts）からは投影済みのスクリーン座標だけを渡す。投影と描画が同じ
 * 関数に同居すると、天球が裏返ったときに原因の切り分けができなくなるため
 * （9章）。このモジュールはcanvasの寸法だけを知り、描画コンテキストは持たない。
 */

import {
  AUTOPILOT_DPS,
  AUTOPILOT_IDLE_MS,
  AUTOPILOT_TRACK_DEADZONE,
  AUTOPILOT_TRACK_DPS,
  AUTOPILOT_TRACK_EL_MARGIN,
  AUTOPILOT_TRACK_GAIN,
  CELL_DEG,
  EL_MAX,
  EL_MIN,
  INERTIA_MS,
  LIGHT_INSET,
  SWIPE_DEG_PER_PX,
  horizontalFovDeg,
  wrapCol,
  AZ_COLS,
  ROWS,
} from "./sphere.ts";

const DEG = Math.PI / 180;

/** カメラ背後の点を投影すると裏返って現れるため、この値以下は描かない（5.2）。 */
const EPS = 0.05;

// ================================================================== 視点の状態

export interface ViewState {
  /** 水平角（度）。制限なし。何周でも回せる（3.5）。 */
  yawDeg: number;
  /** 仰角（度）。天球の外を見せないためクランプする（3.5）。 */
  pitchDeg: number;

  /** 慣性の残り角速度（度/ミリ秒）。離した瞬間の速度を指数減衰させる。 */
  velYaw: number;
  velPitch: number;

  /** 最後に入力（ポインター／ジャイロ）があった時刻。オートパイロットの判定用。 */
  lastInputAt: number;

  /** ジャイロ操作が有効か。ON中はポインター回転を無効化する（3.5）。 */
  gyroEnabled: boolean;
  /** ジャイロの原点（有効化した瞬間のalpha/beta）。相対回転に使う（3.5）。 */
  gyroOrigin: { alpha: number; beta: number } | null;
  /** 原点を取り直した直後の基準となるyaw/pitch。 */
  gyroBase: { yawDeg: number; pitchDeg: number };
}

/** 仰角のクランプ範囲（3.5）。天球の外を見せない。 */
const PITCH_MIN = EL_MIN - 10;
const PITCH_MAX = EL_MAX + 5;

/**
 * 垂直視野角（度）。水平視野角（4.5）とアスペクト比から導く。
 *
 * 可視範囲の算出・方角インジケータ・追尾の仰角クランプがいずれもこれを使うため、
 * 1箇所にまとめる。
 */
export function verticalFovDeg(width: number, height: number): number {
  const hFov = horizontalFovDeg(width);
  return (2 * Math.atan((height / width) * Math.tan((hFov * DEG) / 2))) / DEG;
}

export function createViewState(): ViewState {
  return {
    yawDeg: 0,
    // 曲開始時は水平線よりやや上を見る。文字は EL_MIN=6° から始まるため。
    pitchDeg: 20,
    velYaw: 0,
    velPitch: 0,
    // 曲の開始直後はオートパイロットを最初から作動させる（3.6）。触らずに眺める
    // だけの評価者が必ず存在するため、これは演出ではなく実務要件である。
    lastInputAt: Number.NEGATIVE_INFINITY,
    gyroEnabled: false,
    gyroOrigin: null,
    gyroBase: { yawDeg: 0, pitchDeg: 20 },
  };
}

/** 視点を初期状態へ戻す（選曲やり直し時。11章）。 */
export function resetView(view: ViewState): void {
  const gyroEnabled = view.gyroEnabled;
  Object.assign(view, createViewState());
  view.gyroEnabled = gyroEnabled;
  // 原点はプレイのたびに取り直す（座り直している可能性があるため）。
  view.gyroOrigin = null;
}

function clampPitch(deg: number): number {
  return Math.min(PITCH_MAX, Math.max(PITCH_MIN, deg));
}

// ====================================================================== 投影

export interface Projection {
  /** canvasの論理幅・高さ（CSSピクセル）。 */
  width: number;
  height: number;
  /** 焦点距離（ピクセル）。(W/2) / tan(H_FOV/2)（5.2）。 */
  fPx: number;
  /** カメラ基底。 */
  fwd: [number, number, number];
  right: [number, number, number];
  up: [number, number, number];
}

/**
 * 視点状態とcanvas寸法からカメラ基底と焦点距離を組む（5.2）。
 *
 * 回転行列の符号で悩まないため、基底ベクトル方式を採る。upはforward×rightで
 * 導くため、ロールは構造的に発生しない（3.5の「水平は常に保つ」）。
 */
export function createProjection(view: ViewState, width: number, height: number): Projection {
  const yaw = view.yawDeg * DEG;
  const pitch = view.pitchDeg * DEG;

  const fwd: [number, number, number] = [
    Math.cos(pitch) * Math.sin(yaw),
    Math.sin(pitch),
    Math.cos(pitch) * Math.cos(yaw),
  ];
  const right: [number, number, number] = [Math.cos(yaw), 0, -Math.sin(yaw)];
  const up: [number, number, number] = [
    fwd[1] * right[2] - fwd[2] * right[1],
    fwd[2] * right[0] - fwd[0] * right[2],
    fwd[0] * right[1] - fwd[1] * right[0],
  ];

  const fovDeg = horizontalFovDeg(width);
  const fPx = width / 2 / Math.tan((fovDeg * DEG) / 2);

  return { width, height, fPx, fwd, right, up };
}

export interface ScreenPoint {
  x: number;
  y: number;
  /** カメラ前方への射影。EPS以下なら描いてはならない（5.2）。 */
  z: number;
  /** セルの投影後の見かけの幅（ピクセル）。文字サイズの算出に使う（4.4）。 */
  scale: number;
}

/** 方位角・仰角（度）から単位方向ベクトルを作る（5.1）。 */
export function directionOf(azDeg: number, elDeg: number): [number, number, number] {
  const az = azDeg * DEG;
  const el = elDeg * DEG;
  const cosEl = Math.cos(el);
  return [cosEl * Math.sin(az), Math.sin(el), cosEl * Math.cos(az)];
}

/** 方向ベクトルをスクリーン座標へ投影する（5.2）。z<=EPSなら呼び出し側が捨てる。 */
export function project(proj: Projection, dir: [number, number, number]): ScreenPoint {
  const x = dir[0] * proj.right[0] + dir[1] * proj.right[1] + dir[2] * proj.right[2];
  const y = dir[0] * proj.up[0] + dir[1] * proj.up[1] + dir[2] * proj.up[2];
  const z = dir[0] * proj.fwd[0] + dir[1] * proj.fwd[1] + dir[2] * proj.fwd[2];

  if (z <= EPS) return { x: 0, y: 0, z, scale: 0 };

  return {
    x: proj.width / 2 + (proj.fPx * x) / z,
    y: proj.height / 2 - (proj.fPx * y) / z,
    z,
    // セル1つ分の角度が、この距離で何ピクセルに見えるか。正面ほど大きい。
    scale: (proj.fPx * CELL_DEG * DEG) / z,
  };
}

/** 方位角・仰角を直接投影する短縮形。 */
export function projectAngles(proj: Projection, azDeg: number, elDeg: number): ScreenPoint {
  return project(proj, directionOf(azDeg, elDeg));
}

/**
 * 点灯判定に使う「視野の内側」に入っているか（3.3・5.2）。
 *
 * 画面の端ぎりぎりで点灯すると「見た」という手応えが出ないため、判定領域は
 * 画面よりわずかに内側（LIGHT_INSET）に取る。
 */
export function isInsideLightArea(proj: Projection, p: ScreenPoint): boolean {
  if (p.z <= EPS) return false;
  const halfW = (proj.width / 2) * LIGHT_INSET;
  const halfH = (proj.height / 2) * LIGHT_INSET;
  return (
    Math.abs(p.x - proj.width / 2) <= halfW && Math.abs(p.y - proj.height / 2) <= halfH
  );
}

// ================================================================ 可視範囲の算出

export interface VisibleRange {
  rowMin: number;
  rowMax: number;
  /** 列は巡回するため、colMinから数えたcolCount個を見る（端をまたぐため）。 */
  colStart: number;
  colCount: number;
}

/**
 * yaw・pitchから可視の行・列の範囲を求める（5.3）。
 *
 * 毎フレーム2760セル全部を投影してはならない（11章）。視野角に余裕を持たせた
 * 矩形を返し、描画側はこの範囲だけを回す。
 */
export function visibleRange(view: ViewState, width: number, height: number): VisibleRange {
  const hFov = horizontalFovDeg(width);
  const vFov = verticalFovDeg(width, height);

  const azMargin = hFov / 2 + CELL_DEG * 3;
  const elMargin = vFov / 2 + CELL_DEG * 3;

  const elMin = view.pitchDeg - elMargin;
  const elMax = view.pitchDeg + elMargin;
  const rowMin = Math.max(0, Math.floor((elMin - EL_MIN) / CELL_DEG));
  const rowMax = Math.min(ROWS - 1, Math.ceil((elMax - EL_MIN) / CELL_DEG));

  const colCount = Math.min(AZ_COLS, Math.ceil((azMargin * 2) / CELL_DEG) + 1);
  const colStart = wrapCol(Math.floor((view.yawDeg - azMargin) / CELL_DEG));

  return { rowMin, rowMax, colStart, colCount };
}

// ==================================================================== 入力処理

/**
 * ポインタードラッグによる回転（3.5）。ジャイロON中は無効化する（併用すると
 * 視点が二重に動き、確実に酔う）。
 */
export function applyDrag(view: ViewState, dxPx: number, dyPx: number, now: number): void {
  if (view.gyroEnabled) return;
  view.yawDeg -= dxPx * SWIPE_DEG_PER_PX;
  view.pitchDeg = clampPitch(view.pitchDeg + dyPx * SWIPE_DEG_PER_PX);
  view.lastInputAt = now;
  view.velYaw = 0;
  view.velPitch = 0;
}

/** 指を離した瞬間の速度を慣性として渡す（度/ミリ秒）。 */
export function releaseDrag(view: ViewState, velYaw: number, velPitch: number, now: number): void {
  if (view.gyroEnabled) return;
  view.velYaw = velYaw;
  view.velPitch = velPitch;
  view.lastInputAt = now;
}

/**
 * ジャイロの姿勢を反映する（3.5）。
 *
 * 絶対方位（コンパス）は使わず、有効化した瞬間のalpha/betaを原点として保持し、
 * 以後の差分をyaw/pitchへ写す（相対回転）。gamma（ロール）は使わない。
 */
export function applyOrientation(
  view: ViewState,
  alpha: number,
  beta: number,
  now: number,
): void {
  if (!view.gyroEnabled) return;
  if (view.gyroOrigin === null) {
    view.gyroOrigin = { alpha, beta };
    view.gyroBase = { yawDeg: view.yawDeg, pitchDeg: view.pitchDeg };
    return;
  }

  // alphaは0-360で巡回するため、差分を±180へ畳む（原点をまたいだ瞬間に視点が
  // 一周する事故を防ぐ）。
  let dAlpha = alpha - view.gyroOrigin.alpha;
  dAlpha = ((dAlpha + 180) % 360 + 360) % 360 - 180;
  const dBeta = beta - view.gyroOrigin.beta;

  view.yawDeg = view.gyroBase.yawDeg - dAlpha;
  view.pitchDeg = clampPitch(view.gyroBase.pitchDeg + dBeta);
  view.lastInputAt = now;
}

/** 「正面リセット」（3.5）。原点を取り直す。プレイ中に座り直せば必要になる。 */
export function resetGyroOrigin(view: ViewState): void {
  view.gyroOrigin = null;
  view.gyroBase = { yawDeg: view.yawDeg, pitchDeg: view.pitchDeg };
}

/** オートパイロットが向かう先（次フレーズの開始セル）。無ければnull。 */
export interface AutopilotTarget {
  azDeg: number;
  elDeg: number;
}

/**
 * 目標までの角度差を、この1フレームで詰める量へ変換する。
 *
 * 差に比例した速度（上限つき）で寄せ、近づくほど減速させる。等速で寄せて目標で
 * 急停止する形は、3.5が避ける酔いの原因になる。行き過ぎないよう差でクランプする。
 */
function approach(diffDeg: number, dtMs: number): number {
  const abs = Math.abs(diffDeg);
  if (abs < AUTOPILOT_TRACK_DEADZONE) return 0;
  const dps = Math.min(abs * AUTOPILOT_TRACK_GAIN, AUTOPILOT_TRACK_DPS);
  const step = Math.min(abs, (dps * dtMs) / 1000);
  return Math.sign(diffDeg) * step;
}

/**
 * 毎フレームの視点更新（慣性とオートパイロット）。
 *
 * 慣性は長くしない（3.5）。視点が滑り続ける実装は酔いの主因である。
 *
 * オートパイロット（3.6）は、targetが与えられていればその方角へ最短方向で旋回し、
 * 無ければ一定方向へ漂流する。当初は漂流だけで構成していたが、一定回転と、
 * 3.2規則3が左右ランダムに跳ばすフレーズ配置とは原理的に同期せず、無操作では
 * lostがlitの4倍近く出た（sphere.tsのAUTOPILOT_DPS参照）。速度ではなく向きの
 * 問題であるため、追尾を主とする。
 */
export function updateView(
  view: ViewState,
  now: number,
  dtMs: number,
  target: AutopilotTarget | null,
  width: number,
  height: number,
): void {
  if (view.gyroEnabled) return;

  // 慣性：離した瞬間の速度を指数減衰させる。
  if (view.velYaw !== 0 || view.velPitch !== 0) {
    view.yawDeg += view.velYaw * dtMs;
    view.pitchDeg = clampPitch(view.pitchDeg + view.velPitch * dtMs);
    const decay = Math.exp(-dtMs / INERTIA_MS);
    view.velYaw *= decay;
    view.velPitch *= decay;
    // 微小な残速度で永久に動き続けないよう、閾値で打ち切る。
    if (Math.abs(view.velYaw) < 1e-4) view.velYaw = 0;
    if (Math.abs(view.velPitch) < 1e-4) view.velPitch = 0;
    return;
  }

  // 最後の入力からAUTOPILOT_IDLE_MS無操作なら作動する（3.6）。
  if (now - view.lastInputAt < AUTOPILOT_IDLE_MS) return;

  if (target !== null) {
    // 方位角は360°で巡回するため、差を±180°へ畳んで最短方向へ回す。
    let dAz = target.azDeg - view.yawDeg;
    dAz = ((dAz + 180) % 360 + 360) % 360 - 180;
    view.yawDeg += approach(dAz, dtMs);

    // 仰角は目標へそのまま寄せず、視野の上下端が天球の内側に収まる範囲へ引き込む。
    // 天頂を空けている（3.1）ぶんの空白が画面を占めるのを避けるため。
    const elMargin = (verticalFovDeg(width, height) / 2) * AUTOPILOT_TRACK_EL_MARGIN;
    const wantEl = Math.min(
      EL_MAX - elMargin,
      Math.max(EL_MIN + elMargin, target.elDeg),
    );
    view.pitchDeg = clampPitch(view.pitchDeg + approach(wantEl - view.pitchDeg, dtMs));
    return;
  }

  // 目標が無い間（間奏など）は一定方向へ漂流する。止めてしまうと、触らずに眺める
  // だけの評価者に対して画面が静止する（3.6が禁じる状態）。
  view.yawDeg += (AUTOPILOT_DPS * dtMs) / 1000;
  // pitchは周期30秒のサイン波で緩やかに上下させる。
  const center = (EL_MIN + EL_MAX) / 2;
  const amp = (EL_MAX - EL_MIN) / 4;
  view.pitchDeg = clampPitch(center + amp * Math.sin((now / 30000) * 2 * Math.PI));
}

/** 入力があったことだけを記録する（オートパイロットの解除。3.6）。 */
export function noteInput(view: ViewState, now: number): void {
  view.lastInputAt = now;
}

// ============================================================== 方角インジケータ

/**
 * 目標セルが画面外にある場合、どの辺に矢印を出すかと、その濃さを返す（4.1）。
 * 画面内にあるならnull。
 *
 * これは演出ではなく必須の機能である。これが無ければ、プレイヤーは見当違いの
 * 方角を眺めたまま曲を終える。
 */
export interface DirectionHint {
  side: "left" | "right" | "top" | "bottom";
  /** ズレ角に応じた不透明度 0.3〜1.0（4.4）。 */
  opacity: number;
}

export function directionHint(
  proj: Projection,
  view: ViewState,
  azDeg: number,
  elDeg: number,
): DirectionHint | null {
  const p = projectAngles(proj, azDeg, elDeg);
  const inFront = p.z > EPS;
  const inside =
    inFront && p.x >= 0 && p.x <= proj.width && p.y >= 0 && p.y <= proj.height;
  if (inside) return null;

  // 水平方向のズレは、カメラ背後でも符号が取れる方位角の差分から決める
  // （投影後のxは背後で反転するため、それには頼らない）。
  let dAz = azDeg - view.yawDeg;
  dAz = ((dAz + 180) % 360 + 360) % 360 - 180;
  const dEl = elDeg - view.pitchDeg;

  const hFov = horizontalFovDeg(proj.width);
  const vFov = verticalFovDeg(proj.width, proj.height);

  // 水平のズレが視野半角を超えていれば左右、そうでなければ上下を指す。
  const horizontalOut = Math.abs(dAz) > hFov / 2;
  const side: DirectionHint["side"] = horizontalOut
    ? dAz > 0
      ? "right"
      : "left"
    : dEl > 0
      ? "top"
      : "bottom";

  const excess = horizontalOut
    ? (Math.abs(dAz) - hFov / 2) / (180 - hFov / 2)
    : Math.min(1, (Math.abs(dEl) - vFov / 2) / vFov);
  const opacity = 0.3 + 0.7 * Math.min(1, Math.max(0, excess));

  return { side, opacity };
}
