import type { Screen, WordResult } from "./game.ts";

const screenEl = {
  title: document.querySelector<HTMLElement>("#bk-screen-title")!,
  play: document.querySelector<HTMLElement>("#bk-screen-play")!,
  result: document.querySelector<HTMLElement>("#bk-screen-result")!,
};

const hudScoreEl = document.querySelector<HTMLElement>("#bk-hud-score")!;
const hudNextWordEl = document.querySelector<HTMLElement>("#bk-hud-next-word")!;
const resultScoreEl = document.querySelector<HTMLElement>("#bk-result-score")!;
const resultWordsEl = document.querySelector<HTMLElement>("#bk-result-words")!;
const btnRetryEl = document.querySelector<HTMLButtonElement>("#bk-btn-retry")!;
const btnTitleEl = document.querySelector<HTMLButtonElement>("#bk-btn-title")!;
const btnPauseEl = document.querySelector<HTMLButtonElement>("#bk-btn-pause")!;

export function showScreen(screen: Screen): void {
  for (const [key, el] of Object.entries(screenEl)) {
    el.classList.toggle("screen--active", key === screen);
  }
}

export function updateScoreHud(percent: number): void {
  hudScoreEl.textContent = `${Math.floor(percent)}%`;
}

export function updateNextWordPreview(text: string | null): void {
  hudNextWordEl.textContent = text ?? "-";
}

export function showResult(wordResults: WordResult[], percent: number): void {
  resultScoreEl.textContent = `${Math.floor(percent)}%`;

  resultWordsEl.innerHTML = "";
  for (const result of wordResults) {
    const el = document.createElement("span");
    el.className = "bk-result-word";
    if (result.collected) el.classList.add("bk-result-word--collected");
    el.textContent = result.text;
    resultWordsEl.appendChild(el);
  }
}

export function bindResultButtons(onRetry: () => void, onTitle: () => void): void {
  btnRetryEl.addEventListener("click", onRetry);
  btnTitleEl.addEventListener("click", onTitle);
}

export function bindPauseButton(onToggle: () => void): void {
  // #bk-btn-pauseは#bk-screen-playの子要素。水切リズムの#btn-pauseと同じガードを踏襲し、
  // 将来#bk-screen-play全体にクリック/タップリスナーを貼る場合の二重発火を予防する。
  btnPauseEl.addEventListener("click", (e) => {
    e.stopPropagation();
    onToggle();
  });
}

export function setPauseLabel(paused: boolean): void {
  btnPauseEl.textContent = paused ? "▶ 再生" : "⏸ 一時停止";
}
