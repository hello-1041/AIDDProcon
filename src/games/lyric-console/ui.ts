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

// data-indexでtextalive.SONGSの添字と直結させる（曲名文字列の属性エスケープを避ける）。
const songOptionButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>('[data-lc-option="song"] .lc-option-btn'),
);

const terminalPlayEl = document.querySelector<HTMLElement>("#lc-terminal-play")!;
const terminalResultEl = document.querySelector<HTMLElement>("#lc-terminal-result")!;
const progressEl = document.querySelector<HTMLElement>("#lc-progress")!;
const spinnerEl = document.querySelector<HTMLElement>("#lc-spinner")!;
const vocalBarEl = document.querySelector<HTMLElement>("#lc-vocal-bar")!;

// #lc-media（TextAliveのクレジットバナー表示先）は#app直下にあり、.screen--active
// とは連動しない独立要素。タイトル画面ではSongボタンが曲名を既に表示しており、
// バナーの曲名表示と被って見づらいため、タイトル画面の間だけ隠す。
const lcMediaEl = document.querySelector<HTMLElement>("#lc-media")!;

const resultStatsEl = document.querySelector<HTMLElement>("#lc-result-stats")!;
const statPlaytimeEl = document.querySelector<HTMLElement>("#lc-stat-playtime")!;
const statColorEl = document.querySelector<HTMLElement>("#lc-stat-color")!;
const btnRetryEl = document.querySelector<HTMLButtonElement>("#lc-btn-retry")!;
const btnTitleEl = document.querySelector<HTMLButtonElement>("#lc-btn-title")!;

export function showScreen(screen: Screen): void {
  for (const [key, el] of Object.entries(screenEl)) {
    el.classList.toggle("screen--active", key === screen);
  }
  lcMediaEl.classList.toggle("lc-media--hidden", screen === "title");
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

export function updateSongOptionButtons(selectedIndex: number): void {
  for (const btn of songOptionButtons) {
    btn.classList.toggle("lc-option-btn--active", Number(btn.dataset.index) === selectedIndex);
  }
}

export function bindSongOptionButtons(onSelect: (index: number) => void): void {
  for (const btn of songOptionButtons) {
    btn.addEventListener("click", () => onSelect(Number(btn.dataset.index)));
  }
}

// 選曲中（createFromSongUrlの応答待ち）は、二重クリックによる競合を避けるため
// Startボタンと一緒に無効化する（index.ts側で対にして呼ぶ）。
export function setSongOptionButtonsEnabled(enabled: boolean): void {
  for (const btn of songOptionButtons) {
    btn.disabled = !enabled;
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
// 新しい行が来ても追従しない。閾値はごく小さくし、少しでも上へ動かせば
// 追従を解除する（フィードバック：以前は20pxの遊びがあり、かつ後述の毎フレーム
// DOM再構築と相まって、上へスクロールしようとしても引き戻される不具合があった）。
const AUTO_SCROLL_THRESHOLD_PX = 1;

interface TerminalRenderState {
  renderedLineCount: number;
  lastCurrentLine: string | null;
  lastCursorVisible: boolean | null;
  cursorLineEl: HTMLElement;
  cursorTextEl: HTMLElement;
  cursorGlyphEl: HTMLElement;
}

// 描画済み状態をコンテナ（プレイ画面／リザルト画面、それぞれの疑似ターミナル）
// ごとに記憶する。以前はこれを持たず、毎フレーム無条件にDOMを丸ごと作り直して
// いたため、市民が手動スクロール中でも常にDOMが再構築され続け、スクロール操作
// そのものを阻害していた（特にタッチ操作でのスクロール慣性と相性が悪い）。
const terminalRenderStates = new WeakMap<HTMLElement, TerminalRenderState>();

function createCursorLine(): Pick<TerminalRenderState, "cursorLineEl" | "cursorTextEl" | "cursorGlyphEl"> {
  const cursorLineEl = document.createElement("div");
  cursorLineEl.className = "lc-line";
  const cursorTextEl = document.createElement("span");
  // 点滅はCSSのanimationではなくJS側で状態を計算して反映する（下のcursorGlyphEl参照）。
  const cursorGlyphEl = document.createElement("span");
  cursorGlyphEl.className = "lc-cursor";
  cursorLineEl.appendChild(cursorTextEl);
  cursorLineEl.appendChild(cursorGlyphEl);
  return { cursorLineEl, cursorTextEl, cursorGlyphEl };
}

function appendCompletedLine(containerEl: HTMLElement, beforeEl: HTMLElement, text: string): void {
  const lineEl = document.createElement("div");
  lineEl.className = "lc-line";
  lineEl.textContent = text;
  containerEl.insertBefore(lineEl, beforeEl);
}

export function renderConsole(
  consoleLines: string[],
  currentLine: string | null,
  containerEl: HTMLElement,
  cursorVisible: boolean,
): void {
  const prev = terminalRenderStates.get(containerEl);
  // 行数が減っていたら、それはstartBoot/startShutdown等でconsoleLinesが
  // リセットされたということ（consoleLinesは末尾への追記でしか変化しないため）。
  const isReset = !prev || consoleLines.length < prev.renderedLineCount;
  const linesAdded = !isReset && consoleLines.length > prev.renderedLineCount;
  const currentLineChanged = isReset || prev.lastCurrentLine !== currentLine;
  const cursorChanged = isReset || prev.lastCursorVisible !== cursorVisible;

  if (!isReset && !linesAdded && !currentLineChanged && !cursorChanged) {
    // 前回の描画から何も変わっていない。DOM操作もスクロール追従判定も一切行わない
    // （ここで毎フレーム触ってしまうと、市民が手動でスクロールしている最中の
    // scrollTopまで意図せず読み書きしてしまい、スクロール操作を阻害する）。
    return;
  }

  // wasNearBottomは、この後の行追加でscrollHeightが変わる前に判定する必要がある。
  const wasNearBottom =
    containerEl.scrollHeight - containerEl.scrollTop - containerEl.clientHeight <=
    AUTO_SCROLL_THRESHOLD_PX;

  let state: TerminalRenderState;
  if (isReset) {
    containerEl.innerHTML = "";
    const built = createCursorLine();
    for (const line of consoleLines) {
      appendCompletedLine(containerEl, built.cursorLineEl, line);
    }
    containerEl.appendChild(built.cursorLineEl);
    state = {
      renderedLineCount: consoleLines.length,
      lastCurrentLine: null,
      lastCursorVisible: null,
      ...built,
    };
    terminalRenderStates.set(containerEl, state);
  } else {
    state = prev;
    if (linesAdded) {
      for (let i = state.renderedLineCount; i < consoleLines.length; i++) {
        appendCompletedLine(containerEl, state.cursorLineEl, consoleLines[i]);
      }
      state.renderedLineCount = consoleLines.length;
    }
  }

  if (currentLineChanged) {
    // 打鍵中の行がなくても、常駐の点滅カーソルを最後の行に添える
    // （フィードバック3.2：待機中も端末が生きている感を出す）。
    state.cursorTextEl.textContent = currentLine ?? "";
    state.lastCurrentLine = currentLine;
  }
  if (cursorChanged) {
    state.cursorGlyphEl.style.visibility = cursorVisible ? "visible" : "hidden";
    state.lastCursorVisible = cursorVisible;
  }

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

// モノスペースフォント前提で、VOLメーター側のラベル（updateVocalMeter参照）と
// `[`の位置を文字数で揃える。ステータスバーが折り返して2行になったとき
// （.lc-status-readout参照）、両方のバーの開始位置が縦に揃って見える。
const PROGRESS_LABEL = "Loading... ";

export function updateProgressBar(percent: number): void {
  const filled = Math.round((percent / 100) * PROGRESS_BAR_LENGTH);
  const bar = "=".repeat(filled) + " ".repeat(PROGRESS_BAR_LENGTH - filled);
  progressEl.textContent = `${PROGRESS_LABEL}[${bar}] ${Math.floor(percent)}%`;
}

const SPINNER_FRAMES = ["|", "/", "-", "\\"];
const SPINNER_INTERVAL_MS = 120;

// nowMsには`requestAnimationFrame`のタイムスタンプ等、単調増加するms値を渡す。
export function updateSpinner(nowMs: number): void {
  const frame = Math.floor(nowMs / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length;
  spinnerEl.textContent = SPINNER_FRAMES[frame];
}

const VOCAL_METER_LENGTH = 10;

// ラベル（"VOL "）と`[`の位置合わせはCSS側（.lc-vol-label、コンテナクエリ）に委ねる。
// ここではバー本体（[...]）だけを書き込む。JS側で折り返し状態を判定して文言を
// 出し分ける方式は、判定対象の幅自体が出し分けた文言の幅に左右されてしまい
// （表示中の文言によって折り返し判定が変わり、判定結果によってまた文言が変わる）、
// 一度折り返すと戻すときだけ閾値がずれるヒステリシスを引き起こしていたため廃止した。
export function updateVocalMeter(amplitude: number, maxAmplitude: number): void {
  const ratio = maxAmplitude > 0 ? Math.min(1, Math.max(0, amplitude / maxAmplitude)) : 0;
  const filled = Math.round(ratio * VOCAL_METER_LENGTH);
  const bar = "*".repeat(filled) + " ".repeat(VOCAL_METER_LENGTH - filled);
  vocalBarEl.textContent = `[${bar}]`;
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
