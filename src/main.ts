import "./style.css";
import { init as initMizukiRhythm } from "./games/mizuki-rhythm/index.ts";

const screenMenuEl = document.querySelector<HTMLElement>("#screen-menu")!;

// ゲームごとの起動処理。追加するゲームが増えたら、対応するsrc/games/配下のモジュールと
// ここへのエントリを増やす。initは選択された時点で一度だけ呼ぶ（未選択のゲームの
// 初期化コストを発生させないため）。
const GAME_INIT: Record<string, (onBack: () => void) => void> = {
  "mizuki-rhythm": initMizukiRhythm,
};

const gameSectionEl: Record<string, HTMLElement> = {};
for (const gameId of Object.keys(GAME_INIT)) {
  gameSectionEl[gameId] = document.querySelector<HTMLElement>(`#game-${gameId}`)!;
}

const initializedGameIds = new Set<string>();

function showMenu(): void {
  screenMenuEl.classList.add("screen--active");
  for (const section of Object.values(gameSectionEl)) {
    section.classList.remove("game-section--active");
  }
}

function showGame(gameId: string): void {
  screenMenuEl.classList.remove("screen--active");
  gameSectionEl[gameId].classList.add("game-section--active");
}

document
  .querySelectorAll<HTMLButtonElement>(".game-entry[data-game]")
  .forEach((buttonEl) => {
    const gameId = buttonEl.dataset.game!;
    buttonEl.addEventListener("click", () => {
      if (!initializedGameIds.has(gameId)) {
        initializedGameIds.add(gameId);
        GAME_INIT[gameId](showMenu);
      }
      showGame(gameId);
    });
  });

showMenu();
