/**
 * DOM操作（製造計画書4.1・4.5・4.7・3.5）。
 *
 * canvasの中身はrender.tsが描く。ここが扱うのは画面遷移・HUD・ボタン・方角
 * インジケータ・案内オーバーレイといったDOM側だけ。
 */

import type { Screen } from "./game.ts";
import { SWIPE_DEG_PER_PX } from "./sphere.ts";
import type { DirectionHint } from "./view.ts";

const rootEl = document.querySelector<HTMLElement>("#game-lyric-sphere")!;
const titleDescEl = document.querySelector<HTMLElement>(".lsp-title-desc")!;

const screenEl: Record<Screen, HTMLElement> = {
  title: document.querySelector<HTMLElement>("#lsp-screen-title")!,
  play: document.querySelector<HTMLElement>("#lsp-screen-play")!,
  result: document.querySelector<HTMLElement>("#lsp-screen-result")!,
};

const songSelectEl = document.querySelector<HTMLSelectElement>("#lsp-song-select")!;
const gyroToggleEl = document.querySelector<HTMLInputElement>("#lsp-gyro-toggle")!;

const btnStartEl = document.querySelector<HTMLButtonElement>("#lsp-btn-start")!;
const btnMenuEl = document.querySelector<HTMLButtonElement>("#lsp-btn-menu")!;
const btnPauseEl = document.querySelector<HTMLButtonElement>("#lsp-btn-pause")!;
const btnRecenterEl = document.querySelector<HTMLButtonElement>("#lsp-btn-recenter")!;
const btnRetryEl = document.querySelector<HTMLButtonElement>("#lsp-btn-retry")!;
const btnTitleEl = document.querySelector<HTMLButtonElement>("#lsp-btn-title")!;

const skyEl = document.querySelector<HTMLCanvasElement>("#lsp-sky")!;
const skyWrapEl = document.querySelector<HTMLElement>(".lsp-sky-wrap")!;
const skyMapEl = document.querySelector<HTMLCanvasElement>("#lsp-skymap")!;

const hudScoreEl = document.querySelector<HTMLElement>("#lsp-hud-score")!;
const hudTimeEl = document.querySelector<HTMLElement>("#lsp-hud-time")!;

const debugEl = document.querySelector<HTMLElement>("#lsp-debug")!;
const debugSeekEl = document.querySelector<HTMLInputElement>("#lsp-debug-seek")!;
const debugCountsEl = document.querySelector<HTMLElement>("#lsp-debug-counts")!;

const resultScoreEl = document.querySelector<HTMLElement>("#lsp-result-score")!;

// #lsp-mediaは#app直下にあり.game-sectionとは連動しない独立要素。隠さずに放置すると
// 他ゲームへ移った後もこの曲のバナーが残り、移動先のバナーと重なる。メニューへの
// 導線はタイトル画面にしか無いため、タイトル画面の間だけ隠せば足りる（既存2作と同じ）。
const mediaEl = document.querySelector<HTMLElement>("#lsp-media")!;

const arrowEls: Record<DirectionHint["side"], HTMLElement> = {
  left: document.querySelector<HTMLElement>(".lsp-arrow--left")!,
  right: document.querySelector<HTMLElement>(".lsp-arrow--right")!,
  top: document.querySelector<HTMLElement>(".lsp-arrow--top")!,
  bottom: document.querySelector<HTMLElement>(".lsp-arrow--bottom")!,
};

export function getSkyCanvas(): HTMLCanvasElement {
  return skyEl;
}

export function getSkyMapCanvas(): HTMLCanvasElement {
  return skyMapEl;
}

// ==================================================================== 画面遷移

export function showScreen(screen: Screen): void {
  for (const [key, el] of Object.entries(screenEl)) {
    el.classList.toggle("screen--active", key === screen);
  }
  mediaEl.classList.toggle("lsp-media--hidden", screen === "title");
}

// 新しい曲の実データが届くまでは前の曲のクレジットが残ったまま見えてしまうため、
// Start押下時に隠し、実データ到着後に再表示する。読み込み中にdisplay:noneで要素
// サイズを0にするとSDK側の位置追従処理が壊れるため、visibility:hiddenを使う。
export function setMediaVisible(visible: boolean): void {
  mediaEl.classList.toggle("lsp-media--reloading", !visible);
}

export function showTokenError(message: string): void {
  titleDescEl.textContent = message;
}

/** ジャイロの許可が拒否された理由などを、タイトル画面の説明欄へ出す（3.5）。 */
export function showNotice(message: string): void {
  titleDescEl.textContent = message;
}

// ================================================================ タイトル画面

export function setStartEnabled(enabled: boolean): void {
  btnStartEl.disabled = !enabled;
}

export function setSongSelectEnabled(enabled: boolean): void {
  songSelectEl.disabled = !enabled;
}

export function updateSongSelect(selectedIndex: number): void {
  songSelectEl.value = String(selectedIndex);
}

export function bindSongSelect(onSelect: (index: number) => void): void {
  songSelectEl.addEventListener("change", () => onSelect(Number(songSelectEl.value)));
}

export function bindStartButton(onStart: () => void): void {
  btnStartEl.addEventListener("click", onStart);
}

export function bindMenuButton(onBack: () => void): void {
  btnMenuEl.addEventListener("click", onBack);
}

/**
 * ジャイロのトグル（3.5）。
 *
 * ハンドラはchangeと同じコールスタックで許可要求を呼べるよう、同期のまま
 * index.ts側へ制御を渡す。awaitを挟んだ後ではiOSが許可要求を通さない（11章）。
 */
export function bindGyroToggle(onToggle: (checked: boolean) => void): void {
  gyroToggleEl.addEventListener("change", () => onToggle(gyroToggleEl.checked));
}

export function setGyroToggle(checked: boolean): void {
  gyroToggleEl.checked = checked;
}

/** DeviceOrientationEventが無い環境ではトグル自体を無効化する（3.5）。 */
export function setGyroToggleEnabled(enabled: boolean): void {
  gyroToggleEl.disabled = !enabled;
}

export function setRecenterVisible(visible: boolean): void {
  btnRecenterEl.classList.toggle("lsp-btn-recenter--visible", visible);
}

export function bindRecenterButton(onRecenter: () => void): void {
  btnRecenterEl.addEventListener("click", onRecenter);
}

// ====================================================================== HUD

export function updateScoreHud(percent: number): void {
  hudScoreEl.textContent = `${percent}%`;
}

function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function updateTimeHud(positionMs: number, durationMs: number): void {
  hudTimeEl.textContent = `${formatTime(positionMs)} / ${formatTime(durationMs)}`;
}

export function bindPauseButton(onToggle: () => void): void {
  btnPauseEl.addEventListener("click", onToggle);
}

export function setPauseLabel(paused: boolean): void {
  btnPauseEl.textContent = paused ? "▶ 再開" : "⏸ 一時停止";
}

/**
 * 方角インジケータ（4.1）。目標が画面内にあるならhintはnullで、全部消す。
 */
export function updateDirectionHint(hint: DirectionHint | null): void {
  for (const [side, el] of Object.entries(arrowEls)) {
    const active = hint !== null && hint.side === side;
    el.style.opacity = active ? String(hint!.opacity) : "0";
  }
}

// ================================================================ 視点の入力

export interface DragHandlers {
  onDrag: (dxPx: number, dyPx: number) => void;
  onRelease: (velYawDegPerMs: number, velPitchDegPerMs: number) => void;
}

/**
 * 天球のポインタードラッグ（3.5）。
 *
 * Lyric-Searchの盤面と同じ地ならしを踏む。setPointerCaptureは天球の外で指を
 * 離してもpointerupを受け取るため、pointercancelはシステムジェスチャで状態が
 * 残らないため、isPrimaryは2本目以降の指で視点が二重に動かないために要る。
 * touch-action: noneはstyle.css側。
 */
export function bindSkyPointer(handlers: DragHandlers): void {
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let lastAt = 0;
  // 離した瞬間の速度は、直前1フレーム分の移動量から求める（度/ミリ秒）。
  let velYaw = 0;
  let velPitch = 0;

  skyWrapEl.addEventListener("pointerdown", (e) => {
    if (!e.isPrimary) return;
    e.preventDefault();
    skyWrapEl.setPointerCapture(e.pointerId);
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    lastAt = e.timeStamp;
    velYaw = 0;
    velPitch = 0;
  });

  skyWrapEl.addEventListener("pointermove", (e) => {
    if (!dragging || !e.isPrimary) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    const dt = Math.max(1, e.timeStamp - lastAt);
    lastX = e.clientX;
    lastY = e.clientY;
    lastAt = e.timeStamp;

    // 慣性へ渡す速度は、view側の符号（yawは左方向へ回す）と揃えておく。
    velYaw = (-dx * SWIPE_DEG_PER_PX) / dt;
    velPitch = (dy * SWIPE_DEG_PER_PX) / dt;
    handlers.onDrag(dx, dy);
  });

  const end = (e: PointerEvent): void => {
    if (!dragging || !e.isPrimary) return;
    dragging = false;
    handlers.onRelease(velYaw, velPitch);
  };

  skyWrapEl.addEventListener("pointerup", end);
  skyWrapEl.addEventListener("pointercancel", (e) => {
    if (!dragging || !e.isPrimary) return;
    dragging = false;
    // 中断時は慣性を渡さない（意図しない滑走を作らない）。
    handlers.onRelease(0, 0);
  });
}

// ==================================================================== 開発用

export function setDebugVisible(visible: boolean): void {
  debugEl.classList.toggle("lsp-debug--visible", visible);
}

export function bindDebugSeek(onSeek: (positionMs: number) => void): void {
  debugSeekEl.addEventListener("input", () => onSeek(Number(debugSeekEl.value)));
}

export function updateDebugSeek(positionMs: number, durationMs: number): void {
  if (Number.isFinite(durationMs) && durationMs > 0) {
    debugSeekEl.max = String(Math.floor(durationMs));
  }
  if (document.activeElement !== debugSeekEl) {
    debugSeekEl.value = String(Math.floor(positionMs));
  }
}

/** pending / lit / lost の件数（4.7）。RECLAIM_MSの調整に使う。 */
export function updateDebugCounts(pending: number, lit: number, lost: number): void {
  debugCountsEl.textContent = `P${pending} / L${lit} / X${lost}`;
}

// ==================================================================== リザルト

export function showResult(percent: number): void {
  resultScoreEl.textContent = `${percent}%`;
}

export function bindResultButtons(onRetry: () => void, onTitle: () => void): void {
  btnRetryEl.addEventListener("click", onRetry);
  btnTitleEl.addEventListener("click", onTitle);
}

// ================================================================== 画面サイズ

/**
 * canvasの表示サイズが変わったときに呼ぶコールバックを登録する。
 *
 * resizeとorientationchangeの両方を拾う（11章）。横長固定の案内を出す都合上、
 * 回転は必ず起きる。
 */
export function bindResize(onResize: () => void): void {
  window.addEventListener("resize", onResize);
  window.addEventListener("orientationchange", onResize);
}

export function isActive(): boolean {
  return rootEl.classList.contains("game-section--active");
}
