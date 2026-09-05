import type { BoardChanges, SelectionMode } from "./board.ts";
import type { Board } from "./board.ts";
import type { GameState, Screen } from "./game.ts";
import type { TargetPhrase } from "./textalive.ts";

const titleDescEl = document.querySelector<HTMLElement>(".ls-title-desc")!;

const screenEl: Record<Screen, HTMLElement> = {
  title: document.querySelector<HTMLElement>("#ls-screen-title")!,
  play: document.querySelector<HTMLElement>("#ls-screen-play")!,
  result: document.querySelector<HTMLElement>("#ls-screen-result")!,
};

// data-indexでtextalive.SONGSの添字と直結させる（曲名文字列の属性エスケープを
// 避ける）。歌詞コンソールの選曲UIと同じ方式。
const songOptionButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>('[data-ls-option="song"] .ls-option-btn'),
);

const btnStartEl = document.querySelector<HTMLButtonElement>("#ls-btn-start")!;
const btnMenuEl = document.querySelector<HTMLButtonElement>("#ls-btn-menu")!;
const btnPauseEl = document.querySelector<HTMLButtonElement>("#ls-btn-pause")!;
const btnRetryEl = document.querySelector<HTMLButtonElement>("#ls-btn-retry")!;
const btnTitleEl = document.querySelector<HTMLButtonElement>("#ls-btn-title")!;

const rootEl = document.querySelector<HTMLElement>("#game-lyric-search")!;
const guideEl = document.querySelector<HTMLElement>("#ls-guide")!;
const boardWrapEl = document.querySelector<HTMLElement>(".ls-board-wrap")!;
const boardEl = document.querySelector<HTMLElement>("#ls-board")!;
const pathEl = document.querySelector<SVGSVGElement>("#ls-path")!;

const hudScoreEl = document.querySelector<HTMLElement>("#ls-hud-score")!;
const hudTimeEl = document.querySelector<HTMLElement>("#ls-hud-time")!;

const debugEl = document.querySelector<HTMLElement>("#ls-debug")!;
const debugSeekEl = document.querySelector<HTMLInputElement>("#ls-debug-seek")!;
const debugModeEl = document.querySelector<HTMLButtonElement>("#ls-debug-mode")!;

const resultScoreEl = document.querySelector<HTMLElement>("#ls-result-score")!;
const resultWordsEl = document.querySelector<HTMLElement>("#ls-result-words")!;

let cellEls: HTMLElement[] = [];
let polylineEl: SVGPolylineElement | null = null;

// ==================================================================== 画面遷移

export function showScreen(screen: Screen): void {
  for (const [key, el] of Object.entries(screenEl)) {
    el.classList.toggle("screen--active", key === screen);
  }
}

export function showTokenError(message: string): void {
  titleDescEl.textContent = message;
}

// ================================================================ タイトル画面

export function setStartEnabled(enabled: boolean): void {
  btnStartEl.disabled = !enabled;
}

export function setSongButtonsEnabled(enabled: boolean): void {
  for (const button of songOptionButtons) button.disabled = !enabled;
}

export function updateSongButtons(selectedIndex: number): void {
  songOptionButtons.forEach((button, index) => {
    button.classList.toggle("ls-option-btn--selected", index === selectedIndex);
  });
}

export function bindSongButtons(onSelect: (index: number) => void): void {
  songOptionButtons.forEach((button) => {
    button.addEventListener("click", () => onSelect(Number(button.dataset.index)));
  });
}

export function bindStartButton(onStart: () => void): void {
  btnStartEl.addEventListener("click", onStart);
}

export function bindMenuButton(onBack: () => void): void {
  btnMenuEl.addEventListener("click", onBack);
}

// ====================================================================== 盤面

/**
 * 盤面のセル要素を一度だけ生成する。
 *
 * 一辺のマス数はCSSカスタムプロパティ経由でグリッドに渡す。コード中にもCSSにも
 * 5を直書きしない（計画書3.2）。
 */
export function buildBoard(n: number): void {
  rootEl.style.setProperty("--ls-grid-n", String(n));
  boardEl.innerHTML = "";
  cellEls = [];
  for (let i = 0; i < n * n; i++) {
    const el = document.createElement("div");
    el.className = "ls-cell";
    el.dataset.index = String(i);
    boardEl.appendChild(el);
    cellEls.push(el);
  }
}

export function renderBoard(board: Board): void {
  for (let i = 0; i < cellEls.length; i++) {
    const ch = board.charAt(i);
    if (cellEls[i].textContent !== ch) cellEls[i].textContent = ch;
  }
}

/**
 * 変化したセルに演出を付ける（計画書4.6・5.6 ⑧）。
 *
 * 第2段階で上書きされた無関係なセルにもフラッシュを付け、プレイヤーが探して
 * いない場所が変化したことを明示する。
 */
export function applyCellChanges(changes: BoardChanges): void {
  playOnce(changes.written, "ls-cell--refill", 180);
  playOnce(changes.overwritten, "ls-cell--overwritten", 180);
}

/** 不一致の演出。色を使わず動きで表現する（計画書4.6・4.3 制約2）。 */
export function flashMiss(indices: readonly number[]): void {
  playOnce(indices, "ls-cell--miss", 120);
}

// アニメーションは同じクラスの付け直しでは再生されないため、一度外してから
// 次のフレームで付け直す。重複発火に備え、タイマーで確実に剥がす。
function playOnce(indices: readonly number[], className: string, durationMs: number): void {
  for (const idx of indices) {
    const el = cellEls[idx];
    if (!el) continue;
    el.classList.remove(className);
    // リフローを強制してアニメーションを確実に再生させる
    void el.offsetWidth;
    el.classList.add(className);
    window.setTimeout(() => el.classList.remove(className), durationMs + 40);
  }
}

/**
 * 選択中のセル塗りと経路線を更新する（計画書4.4）。
 *
 * 線だけでは指に隠れて見えず、塗りだけでは通った順序が分からない。経路方式は
 * 同じセル集合でも順序によって別の語になるため、順序の可視化は必須である。
 */
export function renderSelection(indices: readonly number[]): void {
  const selected = new Set(indices);
  for (let i = 0; i < cellEls.length; i++) {
    cellEls[i].classList.toggle("ls-cell--selected", selected.has(i));
  }
  renderPath(indices);
}

function renderPath(indices: readonly number[]): void {
  if (indices.length < 2) {
    if (polylineEl) {
      polylineEl.remove();
      polylineEl = null;
    }
    return;
  }
  if (!polylineEl) {
    polylineEl = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    pathEl.appendChild(polylineEl);
  }
  // 座標はSVG自身の矩形を基準に取る。viewBoxを持たせていないため、ここで
  // 求めた値がそのままピクセル座標になる（stroke-widthも実ピクセル）。
  const base = pathEl.getBoundingClientRect();
  const points: string[] = [];
  for (const idx of indices) {
    const el = cellEls[idx];
    if (!el) continue;
    const r = el.getBoundingClientRect();
    points.push(`${r.left - base.left + r.width / 2},${r.top - base.top + r.height / 2}`);
  }
  polylineEl.setAttribute("points", points.join(" "));
}

// ========================================================= ポインター入力

export interface BoardPointerHandlers {
  onStart: (index: number) => void;
  onMove: (index: number) => void;
  onEnd: () => void;
  onCancel: () => void;
}

/**
 * 盤面のポインター入力を配線する（計画書3.5）。
 *
 * 既存3作のポインター利用はいずれも単発のクリック・タップであり、ドラッグ操作の
 * 前例がリポジトリ内に無い。以下はいずれも欠けると実機で操作が成立しない。
 *
 * - setPointerCapture：盤面の外で指を離してもpointerupを受け取るため。張らないと
 *   選択状態が固まったまま残る
 * - pointercancel：着信・システムジェスチャ・ブラウザの介入で発火する。ここでも
 *   状態が残らないよう破棄する
 * - isPrimary：2本目以降の指を無視し、複数の経路が同時に伸びる状態を作らない
 * - touch-action: none（style.css側）：指定しないとブラウザがスクロールと解釈し、
 *   pointermoveが打ち切られて選択そのものが成立しない
 *
 * 座標からセルを引くのにelementFromPointを使うのは、setPointerCapture中は
 * pointermoveのtargetが捕捉元の要素に固定され、セル要素が入ってこないため。
 */
export function bindBoardPointer(handlers: BoardPointerHandlers): void {
  const cellIndexAt = (clientX: number, clientY: number): number | null => {
    const el = document.elementFromPoint(clientX, clientY);
    const cell = el instanceof Element ? el.closest<HTMLElement>(".ls-cell") : null;
    if (!cell || !boardEl.contains(cell)) return null;
    const index = Number(cell.dataset.index);
    return Number.isInteger(index) ? index : null;
  };

  boardWrapEl.addEventListener("pointerdown", (e) => {
    if (!e.isPrimary) return;
    const index = cellIndexAt(e.clientX, e.clientY);
    if (index === null) return;
    e.preventDefault();
    boardWrapEl.setPointerCapture(e.pointerId);
    handlers.onStart(index);
  });

  boardWrapEl.addEventListener("pointermove", (e) => {
    if (!e.isPrimary) return;
    const index = cellIndexAt(e.clientX, e.clientY);
    // 盤面の外へ出た入力は無視する（間を勝手に補間して繋がない。計画書3.5）
    if (index === null) return;
    handlers.onMove(index);
  });

  boardWrapEl.addEventListener("pointerup", (e) => {
    if (!e.isPrimary) return;
    handlers.onEnd();
  });

  boardWrapEl.addEventListener("pointercancel", (e) => {
    if (!e.isPrimary) return;
    handlers.onCancel();
  });
}

// ================================================================ 歌詞ガイド

/** ガイドチップ1件の状態（計画書4.1）。 */
export type ChipState = "pending" | "got" | "missed";

export interface GuideChip {
  text: string;
  state: ChipState;
}

/**
 * 表示中フレーズを語チップとして描画する。
 *
 * このエリアは演出ではなく必須の機能である。「フレーズを表示中に、その中の語を
 * 盤面から探す」という基本サイクルそのものを担う部分であり、これが無ければ何を
 * 探せばよいか分からずゲームが成立しない（計画書4.1）。
 */
export function renderGuide(chips: readonly GuideChip[]): void {
  guideEl.innerHTML = "";
  for (const chip of chips) {
    const el = document.createElement("span");
    el.className = "ls-chip";
    if (chip.state === "got") el.classList.add("ls-chip--got");
    else if (chip.state === "missed") el.classList.add("ls-chip--missed");
    el.textContent = chip.text;
    guideEl.appendChild(el);
  }
}

// ============================================================ ステータスエリア

export function updateScoreHud(percent: number): void {
  hudScoreEl.textContent = `${Math.floor(percent)}%`;
}

export function updateTimeHud(positionMs: number, durationMs: number): void {
  hudTimeEl.textContent = `${formatTime(positionMs)} / ${formatTime(durationMs)}`;
}

function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0:00";
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function bindPauseButton(onToggle: () => void): void {
  // 将来#ls-screen-play全体にリスナーを貼る場合の二重発火を予防する
  // （既存2作の一時停止ボタンと同じガード）。
  btnPauseEl.addEventListener("click", (e) => {
    e.stopPropagation();
    onToggle();
  });
}

export function setPauseLabel(paused: boolean): void {
  btnPauseEl.textContent = paused ? "▶ 再生" : "⏸ 一時停止";
}

// ================================================================ 開発用UI

export function setDebugVisible(visible: boolean): void {
  debugEl.classList.toggle("ls-debug--visible", visible);
}

export function bindDebugSeek(onSeek: (positionMs: number) => void): void {
  debugSeekEl.addEventListener("input", () => onSeek(Number(debugSeekEl.value)));
}

export function updateDebugSeek(positionMs: number, durationMs: number): void {
  if (Number.isFinite(durationMs) && durationMs > 0) {
    debugSeekEl.max = String(durationMs);
  }
  debugSeekEl.value = String(positionMs);
}

export function bindDebugMode(onToggle: () => void): void {
  debugModeEl.addEventListener("click", (e) => {
    e.stopPropagation();
    onToggle();
  });
}

export function setDebugModeLabel(mode: SelectionMode): void {
  debugModeEl.textContent = mode === "line" ? "選択: 直線" : "選択: 経路";
}

// ============================================================== リザルト画面

/**
 * 曲全体の対象語をフレーズごとに並べ、取得済みは通常表示、未取得は半透明にする
 * （計画書3.9）。表示はIWord.textの原文を使う。
 *
 * 一覧に並ぶのはスコアの分母に含まれる対象語だけであり、記号・除外語は
 * そもそもTargetPhrase.wordsに入っていない。
 */
export function showResult(state: GameState): void {
  const percent = state.targets ? (state.acquired.size / state.targets.words.length) * 100 : 0;
  resultScoreEl.textContent = `${Math.floor(percent)}%`;

  resultWordsEl.innerHTML = "";
  for (const phrase of state.targets?.phrases ?? []) {
    resultWordsEl.appendChild(buildResultPhrase(phrase, state));
  }
}

function buildResultPhrase(phrase: TargetPhrase, state: GameState): HTMLElement {
  const line = document.createElement("div");
  line.className = "ls-result-phrase";
  for (const word of phrase.words) {
    const el = document.createElement("span");
    el.className = "ls-result-word";
    if (state.acquired.has(word.id)) el.classList.add("ls-result-word--collected");
    el.textContent = word.text;
    line.appendChild(el);
  }
  return line;
}

export function bindResultButtons(onRetry: () => void, onTitle: () => void): void {
  btnRetryEl.addEventListener("click", onRetry);
  btnTitleEl.addEventListener("click", onTitle);
}
