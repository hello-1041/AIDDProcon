import "./style.css";
import * as game from "./game.ts";
import * as ui from "./ui.ts";
import * as textalive from "./textalive.ts";

// タブが非アクティブになった後の巨大なジャンプを防ぐためのdtMsクランプ上限
// （既存2作と同じ方針）。
const MAX_DT_MS = 50;

// メニューからこのコンテンツが選ばれたときに一度だけ呼ぶ。既存2作と同じく
// 配線のみを担当し、状態はgame.tsに、DOM操作はui.tsに委ねる。
export function init(onBack: () => void): void {
  ui.showScreen("title");
  ui.bindMenuButton(onBack);

  const token = import.meta.env.VITE_TEXTALIVE_TOKEN;

  if (!token) {
    ui.showTokenError(
      "エラー: VITE_TEXTALIVE_TOKEN が設定されていません。.env を確認してください。",
    );
    console.error("[LyricConsole] VITE_TEXTALIVE_TOKEN is not set.");
    return;
  }

  let state = game.createInitialState([]);
  let lastFrameTime: number | null = null;
  let shutdownResultShown = false;

  ui.applyTheme(state.settings.color);
  ui.updateColorOptionButtons(state.settings.color);

  // 曲の再生終了時に呼ぶ。textalive.ts内のonTimeUpdate／onStopイベントと、下の
  // ループからの毎フレームのポーリング（checkSongEnd呼び出し）から呼ばれうる。
  function handleSongEnd(): void {
    shutdownResultShown = false;
    game.startShutdown(state);
    ui.showScreen("result");
  }

  const player = textalive.createPlayer(
    token,
    () => {
      // onVideoReady/onTimerReady: 歌詞情報が確定し、プレイ可能になった。
      // 既に選択済みのColorはそのまま引き継ぐ。
      const phrases = textalive.computeLyricPhraseEntries(player);
      state = game.createInitialState(phrases, state.settings);
      ui.setStartEnabled(true);
    },
    handleSongEnd,
  );

  ui.bindColorOptionButtons((color) => {
    game.setColor(state, color);
    ui.applyTheme(state.settings.color);
    ui.updateColorOptionButtons(color);
  });

  ui.bindStartButton(() => {
    state.screen = "play";
    ui.showScreen("play");
    // ブートは曲の再生と並行させない。「ready.」表示後、入力を待ってから
    // 曲を再生する（フィードバック1.3：並行させるとイントロの短い曲で
    // 歌詞がバースト表示される不具合があったため）。
    game.startBoot(state);
  });

  // ブート完了後の入力待ち（waitingForStart）から、実際に曲の再生を始める。
  // クリックまたは任意キー入力で進む（「Press any key to continue」の慣習）。
  function tryConfirmStart(): void {
    if (state.phase !== "waitingForStart") return;
    game.confirmStart(state);
    // RETRYの場合も含め、この時点では再生位置が必ず0のため頭出し（シーク）は不要
    // （理由はtextalive.startPlaybackのコメント参照。シークを挟むと再生開始に
    // 失敗したまま固まる不具合があったため、あえて省略している）。
    textalive.startPlayback(player);
  }
  ui.getPlayTerminalEl().addEventListener("click", tryConfirmStart);
  window.addEventListener("keydown", (e) => {
    if (state.phase !== "waitingForStart") return;
    e.preventDefault();
    tryConfirmStart();
  });

  ui.bindResultButtons(
    () => {
      // RETRY: 選択済みのColorを引き継いだままブートから再生し直す。
      state = game.createInitialState(state.phrases, state.settings);
      state.screen = "play";
      ui.showScreen("play");
      game.startBoot(state);
    },
    () => {
      // TITLE: 選択済みのColorを引き継いだままタイトルへ戻る。
      player.requestStop();
      state = game.createInitialState(state.phrases, state.settings);
      ui.showScreen("title");
    },
  );

  // 開発用の一時停止・シークUI（DEV環境限定、簡易実装。フィードバック3.4）。
  // DEV以外ではno-opのままにしておき、下のループ側は分岐なしで呼べるようにする。
  let updateDebugSeek: (songPosition: number) => void = () => {};

  if (import.meta.env.DEV) {
    const debugSeekEl = document.querySelector<HTMLInputElement>("#lc-debug-seek")!;
    const debugPauseEl = document.querySelector<HTMLButtonElement>("#lc-debug-pause")!;
    debugSeekEl.style.display = "block";
    debugPauseEl.style.display = "inline-block";

    let devPaused = false;
    debugPauseEl.addEventListener("click", () => {
      devPaused = !devPaused;
      if (devPaused) player.requestPause();
      else player.requestPlay();
      debugPauseEl.textContent = devPaused ? "▶ 再生" : "⏸ 一時停止";
    });
    debugSeekEl.addEventListener("input", () => {
      player.requestMediaSeek(Number(debugSeekEl.value));
    });

    updateDebugSeek = (songPosition: number) => {
      const duration = player.video.duration;
      if (Number.isFinite(duration) && duration > 0) {
        debugSeekEl.max = String(duration);
      }
      debugSeekEl.value = String(songPosition);
    };
  }

  const CURSOR_BLINK_INTERVAL_MS = 530;

  const loop = (now: number) => {
    const dtMs = lastFrameTime === null ? 0 : Math.min(now - lastFrameTime, MAX_DT_MS);
    lastFrameTime = now;
    // 点滅カーソルのon/off状態を、経過時間から直接計算する（ui.renderConsole参照）。
    const cursorVisible = Math.floor(now / CURSOR_BLINK_INTERVAL_MS) % 2 === 0;

    // 1フレームの処理中に想定外の例外が起きても、requestAnimationFrame(loop)への
    // 再スケジュールだけは必ず行う（既存2作と同じ設計。1フレームの失敗で
    // コンテンツ全体を道連れにしない）。
    try {
      if (state.screen === "play") {
        const songPosition = player.timer.position;
        ui.updateSpinner(now);
        ui.updateProgressBar(game.getProgressPercent(songPosition, player.video.duration));
        ui.updateVocalMeter(player.getVocalAmplitude(songPosition), player.getMaxVocalAmplitude());
        updateDebugSeek(songPosition);

        if (state.phase === "boot") {
          game.updateBootPhase(state, dtMs);
        } else if (state.phase === "lyrics") {
          textalive.checkSongEnd(player, songPosition, handleSongEnd);
          game.updateLyricTyping(state, songPosition);
        }
        ui.renderConsole(state.consoleLines, state.currentLine, ui.getPlayTerminalEl(), cursorVisible);
      } else if (state.screen === "result") {
        game.updateShutdownPhase(state, dtMs);
        ui.renderConsole(state.consoleLines, state.currentLine, ui.getResultTerminalEl(), cursorVisible);

        if (!shutdownResultShown && state.shutdownTyper?.finished) {
          shutdownResultShown = true;
          ui.showResult(player.video.duration, state.settings.color);
        }
      }
    } catch (error) {
      console.error("[LyricConsole] frame update failed:", error);
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
