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

  ui.applyTheme(state.settings.color, state.settings.font);
  ui.updateColorOptionButtons(state.settings.color);
  ui.updateFontOptionButtons(state.settings.font);

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
      // 既に選択済みのColor/Fontはそのまま引き継ぐ。
      const phrases = textalive.computeLyricPhraseEntries(player);
      state = game.createInitialState(phrases, state.settings);
      ui.setStartEnabled(true);
    },
    handleSongEnd,
  );

  ui.bindColorOptionButtons((color) => {
    game.setColor(state, color);
    ui.applyTheme(state.settings.color, state.settings.font);
    ui.updateColorOptionButtons(color);
  });
  ui.bindFontOptionButtons((font) => {
    game.setFont(state, font);
    ui.applyTheme(state.settings.color, state.settings.font);
    ui.updateFontOptionButtons(font);
  });

  ui.bindStartButton(() => {
    state.screen = "play";
    ui.showScreen("play");
    // ブート進行は壁時計dtMs基準、歌詞トリガーはsongPosition基準で、互いに
    // 待ち合わせず並行進行させる（製造計画書2.4節：演出都合で曲の頭出しを
    // ずらさない）。
    game.startBoot(state);
    textalive.startPlayback(player);
  });

  ui.bindResultButtons(
    () => {
      // RETRY: 選択済みのColor/Fontを引き継いだままブートから再生し直す。
      state = game.createInitialState(state.phrases, state.settings);
      state.screen = "play";
      ui.showScreen("play");
      game.startBoot(state);
      textalive.restartPlayback(player);
    },
    () => {
      // TITLE: 選択済みのColor/Fontを引き継いだままタイトルへ戻る。
      player.requestStop();
      state = game.createInitialState(state.phrases, state.settings);
      ui.showScreen("title");
    },
  );

  const loop = (now: number) => {
    const dtMs = lastFrameTime === null ? 0 : Math.min(now - lastFrameTime, MAX_DT_MS);
    lastFrameTime = now;

    // 1フレームの処理中に想定外の例外が起きても、requestAnimationFrame(loop)への
    // 再スケジュールだけは必ず行う（既存2作と同じ設計。1フレームの失敗で
    // コンテンツ全体を道連れにしない）。
    try {
      if (state.screen === "play") {
        const songPosition = player.timer.position;
        textalive.checkSongEnd(player, songPosition, handleSongEnd);

        if (state.phase === "boot") {
          game.updateBootPhase(state, dtMs);
        } else {
          game.updateLyricTyping(state, songPosition);
          ui.updateProgressBar(game.getProgressPercent(songPosition, player.video.endTime));
        }
        ui.renderConsole(state.consoleLines, state.currentLine, ui.getPlayTerminalEl());
      } else if (state.screen === "result") {
        game.updateShutdownPhase(state, dtMs);
        ui.renderConsole(state.consoleLines, state.currentLine, ui.getResultTerminalEl());

        if (!shutdownResultShown && state.shutdownTyper?.finished) {
          shutdownResultShown = true;
          ui.showResult(
            state.phrasesDisplayedCount,
            player.video.endTime,
            state.settings.color,
            state.settings.font,
          );
        }
      }
    } catch (error) {
      console.error("[LyricConsole] frame update failed:", error);
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
