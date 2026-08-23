import "./style.css";
import * as game from "./game.ts";
import * as render from "./render.ts";
import * as ui from "./ui.ts";
import * as textalive from "./textalive.ts";

// タブが非アクティブになった後の巨大なジャンプを防ぐためのdtMsクランプ上限。
const MAX_DT_MS = 50;

// メニューからこのゲームが選ばれたときに一度だけ呼ぶ。DOM要素の取得やTextAlive Playerの
// 生成をここに閉じ込めることで、他のゲームが選ばれている間は初期化コスト（楽曲読み込み等）を
// 発生させない。onBackは「メニューに戻る」操作で呼ぶコールバック（メニュー側の画面切り替えを行う）。
// 水切リズムのindex.tsと同じ役割分担（配線のみ担当）。
export function init(onBack: () => void): void {
  const titleDescEl = document.querySelector<HTMLElement>(".bk-title-desc")!;
  const btnStartEl = document.querySelector<HTMLButtonElement>("#bk-btn-start")!;
  const btnMenuEl = document.querySelector<HTMLButtonElement>("#bk-btn-menu")!;
  const screenPlayEl = document.querySelector<HTMLElement>("#bk-screen-play")!;
  const canvas = document.querySelector<HTMLCanvasElement>("#bk-canvas")!;
  const ctx = canvas.getContext("2d")!;

  canvas.width = render.CANVAS_WIDTH;
  canvas.height = render.CANVAS_HEIGHT;
  // 表示サイズはCSSの.bk-canvas-wrap（aspect-ratio + min()によるフルードレイアウト）に
  // 委ねるため、水切リズムのresizeToFit相当のJS処理・resizeイベントリスナーは持たない。

  ui.showScreen("title");
  btnMenuEl.addEventListener("click", onBack);

  const token = import.meta.env.VITE_TEXTALIVE_TOKEN;

  if (!token) {
    titleDescEl.textContent =
      "エラー: VITE_TEXTALIVE_TOKEN が設定されていません。.env を確認してください。";
    console.error("[BlockKuzushi] VITE_TEXTALIVE_TOKEN is not set.");
    return;
  }

  let state = game.createInitialState([]);
  let paused = false;
  let lastFrameTime: number | null = null;

  // 曲の再生終了時に呼ぶ。textalive.ts内のonTimeUpdate／onStopイベントと、下のループからの
  // 毎フレームのポーリング（下のcheckSongEnd呼び出し）から呼ばれうる。
  function handleSongEnd(): void {
    game.finishChallenge(state);
    ui.showScreen("result");
    ui.showResult(state.wordResults, game.getScorePercent(state));
  }

  const player = textalive.createPlayer(
    token,
    () => {
      // onVideoReady/onTimerReady: 歌詞情報が確定し、プレイ可能になった
      const wordEntries = textalive.computeLyricWordEntries(player);
      state = game.createInitialState(wordEntries);
      btnStartEl.disabled = false;
    },
    handleSongEnd,
  );

  // クリックリスナーではなくmousemoveで、HUDを含む画面全体からパドル目標X座標を追従させる
  // （将来のタップ対応を見据え、入力方式を問わない「パドル目標X座標」への正規化はgame.ts側）。
  screenPlayEl.addEventListener("mousemove", (e) => {
    if (state.screen !== "play" || paused) return;
    const x = render.clientXToCanvasX(canvas, e.clientX);
    game.setPaddleTargetX(state, x);
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") game.setKeyHeld(state, "left", true);
    else if (e.key === "ArrowRight") game.setKeyHeld(state, "right", true);
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "ArrowLeft") game.setKeyHeld(state, "left", false);
    else if (e.key === "ArrowRight") game.setKeyHeld(state, "right", false);
  });

  btnStartEl.addEventListener("click", () => {
    state.screen = "play";
    ui.showScreen("play");
    textalive.startPlayback(player);
  });

  ui.bindPauseButton(() => {
    if (state.screen !== "play") return;
    paused = !paused;
    if (paused) player.requestPause();
    else player.requestPlay();
    ui.setPauseLabel(paused);
  });

  ui.bindResultButtons(
    () => {
      state = game.createInitialState(state.wordEntries);
      state.screen = "play";
      paused = false;
      ui.setPauseLabel(false);
      ui.showScreen("play");
      textalive.restartPlayback(player);
    },
    () => {
      player.requestStop();
      state = game.createInitialState(state.wordEntries);
      paused = false;
      ui.setPauseLabel(false);
      ui.showScreen("title");
    },
  );

  const loop = (now: number) => {
    // 一時停止中もlastFrameTimeを更新し続けることで、再開直後のdtMsが一時停止時間を
    // 含んだ巨大な値にならないようにする（水切りリズムのpauseStartedAt補正と異なる方式）。
    const dtMs = lastFrameTime === null ? 0 : Math.min(now - lastFrameTime, MAX_DT_MS);
    lastFrameTime = now;

    if (!paused) {
      const songPosition = player.timer.position;
      textalive.checkSongEnd(player, songPosition, handleSongEnd);

      if (state.screen === "play") {
        game.update(state, songPosition, dtMs);

        ui.updateScoreHud(game.getScorePercent(state));
        const nextEntry = state.wordEntries[state.wordCursor];
        ui.updateNextWordPreview(nextEntry ? nextEntry.text : null);

        render.drawFrame(ctx, state, songPosition);
      }
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
