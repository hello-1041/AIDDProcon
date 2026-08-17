import type { GameState, JudgeResult, Screen } from "./game.ts";

const JUDGE_LABEL: Record<JudgeResult, string> = {
  just: "Just!",
  good: "Good",
  miss: "Miss",
};

const screenEl = {
  title: document.querySelector<HTMLElement>("#screen-title")!,
  play: document.querySelector<HTMLElement>("#screen-play")!,
  result: document.querySelector<HTMLElement>("#screen-result")!,
};

const hudBestEl = document.querySelector<HTMLElement>("#hud-best")!;
const hudCurrentEl = document.querySelector<HTMLElement>("#hud-current")!;
const judgePopupEl = document.querySelector<HTMLElement>("#judge-popup")!;
const resultScoreEl = document.querySelector<HTMLElement>("#result-score")!;
const btnRetryEl = document.querySelector<HTMLButtonElement>("#btn-retry")!;
const btnTitleEl = document.querySelector<HTMLButtonElement>("#btn-title")!;
const btnPauseEl = document.querySelector<HTMLButtonElement>("#btn-pause")!;

export function showScreen(screen: Screen): void {
  for (const [key, el] of Object.entries(screenEl)) {
    el.classList.toggle("screen--active", key === screen);
  }
}

export function updateHud(state: GameState): void {
  hudBestEl.textContent = `${Math.floor(state.bestDistance)}m`;
  hudCurrentEl.textContent = `${Math.floor(state.currentDistance)}m`;
}

export function showJudgePopup(result: JudgeResult): void {
  judgePopupEl.textContent = JUDGE_LABEL[result];
  // 常時受付方式のため、フェード中に次の判定が来ることがある。
  // クラスを一度外してreflowを強制してから付け直すことで、アニメーションを毎回頭から再生する。
  judgePopupEl.classList.remove("judge-popup--visible");
  void judgePopupEl.offsetWidth;
  judgePopupEl.classList.add("judge-popup--visible");
}

export function showResult(bestDistance: number): void {
  resultScoreEl.textContent = `最高記録: ${Math.floor(bestDistance)}m`;
}

export function bindResultButtons(onRetry: () => void, onTitle: () => void): void {
  btnRetryEl.addEventListener("click", onRetry);
  btnTitleEl.addEventListener("click", onTitle);
}

export function bindPauseButton(onToggle: () => void): void {
  // #btn-pause は #screen-play の子要素で、gameplay用のクリックリスナーが
  // #screen-play全体に貼られているため、バブリングでそちらも発火してしまう。
  // 一時停止の操作がゲームプレイのクリック判定として二重に処理されないよう止める。
  btnPauseEl.addEventListener("click", (e) => {
    e.stopPropagation();
    onToggle();
  });
}

export function setPauseLabel(paused: boolean): void {
  btnPauseEl.textContent = paused ? "▶ 再生" : "⏸ 一時停止";
}
