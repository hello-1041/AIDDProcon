import type { Screen, ColorTheme } from "./game.ts";

const rootEl = document.querySelector<HTMLElement>("#game-lyric-console")!;
const titleDescEl = document.querySelector<HTMLElement>(".lc-title-desc")!;

const screenEl: Record<Screen, HTMLElement> = {
  title: document.querySelector<HTMLElement>("#lc-screen-title")!,
  play: document.querySelector<HTMLElement>("#lc-screen-play")!,
  result: document.querySelector<HTMLElement>("#lc-screen-result")!,
};

const colorOptionButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>('[data-lc-option="color"] .lc-option-btn'),
);

const terminalPlayEl = document.querySelector<HTMLElement>("#lc-terminal-play")!;
const terminalResultEl = document.querySelector<HTMLElement>("#lc-terminal-result")!;
const progressEl = document.querySelector<HTMLElement>("#lc-progress")!;
const spinnerEl = document.querySelector<HTMLElement>("#lc-spinner")!;
const vocalMeterEl = document.querySelector<HTMLElement>("#lc-vocal-meter")!;

const resultStatsEl = document.querySelector<HTMLElement>("#lc-result-stats")!;
const statPlaytimeEl = document.querySelector<HTMLElement>("#lc-stat-playtime")!;
const statColorEl = document.querySelector<HTMLElement>("#lc-stat-color")!;
const btnRetryEl = document.querySelector<HTMLButtonElement>("#lc-btn-retry")!;
const btnTitleEl = document.querySelector<HTMLButtonElement>("#lc-btn-title")!;

export function showScreen(screen: Screen): void {
  for (const [key, el] of Object.entries(screenEl)) {
    el.classList.toggle("screen--active", key === screen);
  }
  if (screen !== "result") {
    resultStatsEl.classList.remove("lc-result-stats--visible");
  }
}

export function showTokenError(message: string): void {
  titleDescEl.textContent = message;
}

// #game-lyric-console要素のdata属性を書き換えるだけ。実際の見た目（文字色・
// グロー）はCSS側の属性セレクタが担う。
export function applyTheme(color: ColorTheme): void {
  rootEl.dataset.lcColor = color;
}

export function updateColorOptionButtons(selected: ColorTheme): void {
  for (const btn of colorOptionButtons) {
    btn.classList.toggle("lc-option-btn--active", btn.dataset.value === selected);
  }
}

export function bindColorOptionButtons(onSelect: (color: ColorTheme) => void): void {
  for (const btn of colorOptionButtons) {
    btn.addEventListener("click", () => onSelect(btn.dataset.value as ColorTheme));
  }
}

export function setStartEnabled(enabled: boolean): void {
  document.querySelector<HTMLButtonElement>("#lc-btn-start")!.disabled = !enabled;
}

export function bindStartButton(onStart: () => void): void {
  document.querySelector<HTMLButtonElement>("#lc-btn-start")!.addEventListener("click", onStart);
}

export function bindMenuButton(onBack: () => void): void {
  document.querySelector<HTMLButtonElement>("#lc-btn-menu")!.addEventListener("click", onBack);
}

// プレイ画面・リザルト画面の疑似ターミナル、両方から使う共通描画関数。
// 供給元（ブート／歌詞／シャットダウン）を区別せず、確定済み行の配列と
// タイプ中の1行だけを愚直に描画する。
//
// スクロールバーは常にコンソール内で最下部付近にいた場合のみ追従させる
// （フィードバック1.1）。市民が意図的に上へスクロールしている間は、
// 新しい行が来ても追従しない。
const AUTO_SCROLL_THRESHOLD_PX = 20;

// カーソルの点滅は、CSSのanimationではなくJS側で状態を計算して反映する。
// このコンテンツは毎フレーム（60fps）ターミナルのDOMを丸ごと作り直しており、
// CSS animationは要素ごとに独立したタイマーを持つため、要素が16msおきに
// 作り直されるたびにアニメーションが0秒目（不透明）へリセットされ続け、
// 実質「常に点灯したまま」になってしまう。呼び出し側（index.ts）で
// `requestAnimationFrame`のタイムスタンプから計算したon/off状態を渡してもらう。
export function renderConsole(
  consoleLines: string[],
  currentLine: string | null,
  containerEl: HTMLElement,
  cursorVisible: boolean,
): void {
  const wasNearBottom =
    containerEl.scrollHeight - containerEl.scrollTop - containerEl.clientHeight <=
    AUTO_SCROLL_THRESHOLD_PX;

  containerEl.innerHTML = "";
  for (const line of consoleLines) {
    const lineEl = document.createElement("div");
    lineEl.className = "lc-line";
    lineEl.textContent = line;
    containerEl.appendChild(lineEl);
  }

  // 打鍵中の行がなくても、常駐の点滅カーソルを最後の行に添える
  // （フィードバック3.2：待機中も端末が生きている感を出す）。
  const cursorLineEl = document.createElement("div");
  cursorLineEl.className = "lc-line";
  cursorLineEl.textContent = currentLine ?? "";
  const cursorEl = document.createElement("span");
  cursorEl.className = "lc-cursor";
  cursorEl.style.visibility = cursorVisible ? "visible" : "hidden";
  cursorLineEl.appendChild(cursorEl);
  containerEl.appendChild(cursorLineEl);

  if (wasNearBottom) {
    containerEl.scrollTop = containerEl.scrollHeight;
  }
}

export function getPlayTerminalEl(): HTMLElement {
  return terminalPlayEl;
}

export function getResultTerminalEl(): HTMLElement {
  return terminalResultEl;
}

const PROGRESS_BAR_LENGTH = 10;

export function updateProgressBar(percent: number): void {
  const filled = Math.round((percent / 100) * PROGRESS_BAR_LENGTH);
  const bar = "=".repeat(filled) + " ".repeat(PROGRESS_BAR_LENGTH - filled);
  progressEl.textContent = `Loading... [${bar}] ${Math.floor(percent)}%`;
}

const SPINNER_FRAMES = ["|", "/", "-", "\\"];
const SPINNER_INTERVAL_MS = 120;

// nowMsには`requestAnimationFrame`のタイムスタンプ等、単調増加するms値を渡す。
export function updateSpinner(nowMs: number): void {
  const frame = Math.floor(nowMs / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length;
  spinnerEl.textContent = SPINNER_FRAMES[frame];
}

const VOCAL_METER_LENGTH = 10;

// amplitude/maxAmplitudeは`Player.getVocalAmplitude`/`getMaxVocalAmplitude`の
// 戻り値をそのまま渡す想定。ボーカルの音量に反応するASCII風メーター
// （フィードバック3.2）。
export function updateVocalMeter(amplitude: number, maxAmplitude: number): void {
  const ratio = maxAmplitude > 0 ? Math.min(1, Math.max(0, amplitude / maxAmplitude)) : 0;
  const filled = Math.round(ratio * VOCAL_METER_LENGTH);
  const bar = "*".repeat(filled) + " ".repeat(VOCAL_METER_LENGTH - filled);
  vocalMeterEl.textContent = `VOL [${bar}]`;
}

function formatMmSs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function showResult(playtimeMs: number, color: ColorTheme): void {
  statPlaytimeEl.textContent = formatMmSs(playtimeMs);
  statColorEl.textContent = color;
  resultStatsEl.classList.add("lc-result-stats--visible");
}

export function bindResultButtons(onRetry: () => void, onTitle: () => void): void {
  btnRetryEl.addEventListener("click", onRetry);
  btnTitleEl.addEventListener("click", onTitle);
}
