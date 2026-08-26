import type { Screen, ColorTheme, FontStyle } from "./game.ts";

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
const fontOptionButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>('[data-lc-option="font"] .lc-option-btn'),
);

const terminalPlayEl = document.querySelector<HTMLElement>("#lc-terminal-play")!;
const terminalResultEl = document.querySelector<HTMLElement>("#lc-terminal-result")!;
const progressEl = document.querySelector<HTMLElement>("#lc-progress")!;

const resultStatsEl = document.querySelector<HTMLElement>("#lc-result-stats")!;
const statPhrasesEl = document.querySelector<HTMLElement>("#lc-stat-phrases")!;
const statPlaytimeEl = document.querySelector<HTMLElement>("#lc-stat-playtime")!;
const statColorEl = document.querySelector<HTMLElement>("#lc-stat-color")!;
const statFontEl = document.querySelector<HTMLElement>("#lc-stat-font")!;
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
// グロー・letter-spacing）はCSS側の属性セレクタが担う（製造計画書2.6節）。
export function applyTheme(color: ColorTheme, font: FontStyle): void {
  rootEl.dataset.lcColor = color;
  rootEl.dataset.lcFont = font;
}

export function updateColorOptionButtons(selected: ColorTheme): void {
  for (const btn of colorOptionButtons) {
    btn.classList.toggle("lc-option-btn--active", btn.dataset.value === selected);
  }
}

export function updateFontOptionButtons(selected: FontStyle): void {
  for (const btn of fontOptionButtons) {
    btn.classList.toggle("lc-option-btn--active", btn.dataset.value === selected);
  }
}

export function bindColorOptionButtons(onSelect: (color: ColorTheme) => void): void {
  for (const btn of colorOptionButtons) {
    btn.addEventListener("click", () => onSelect(btn.dataset.value as ColorTheme));
  }
}

export function bindFontOptionButtons(onSelect: (font: FontStyle) => void): void {
  for (const btn of fontOptionButtons) {
    btn.addEventListener("click", () => onSelect(btn.dataset.value as FontStyle));
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
export function renderConsole(
  consoleLines: string[],
  currentLine: string | null,
  containerEl: HTMLElement,
): void {
  containerEl.innerHTML = "";
  for (const line of consoleLines) {
    const lineEl = document.createElement("div");
    lineEl.className = "lc-line";
    lineEl.textContent = line;
    containerEl.appendChild(lineEl);
  }
  if (currentLine !== null) {
    const lineEl = document.createElement("div");
    lineEl.className = "lc-line";
    lineEl.textContent = currentLine;
    const cursorEl = document.createElement("span");
    cursorEl.className = "lc-cursor";
    lineEl.appendChild(cursorEl);
    containerEl.appendChild(lineEl);
  }
  containerEl.scrollTop = containerEl.scrollHeight;
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

function formatMmSs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function showResult(
  phrasesDisplayedCount: number,
  playtimeMs: number,
  color: ColorTheme,
  font: FontStyle,
): void {
  statPhrasesEl.textContent = String(phrasesDisplayedCount);
  statPlaytimeEl.textContent = formatMmSs(playtimeMs);
  statColorEl.textContent = color;
  statFontEl.textContent = font;
  resultStatsEl.classList.add("lc-result-stats--visible");
}

export function bindResultButtons(onRetry: () => void, onTitle: () => void): void {
  btnRetryEl.addEventListener("click", onRetry);
  btnTitleEl.addEventListener("click", onTitle);
}
