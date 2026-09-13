import "./style.css";
import { GRID_N } from "./board.ts";
import * as game from "./game.ts";
import * as ui from "./ui.ts";
import * as textalive from "./textalive.ts";

// メニューからこのゲームが選ばれたときに一度だけ呼ぶ。DOM要素の取得やTextAlive
// Playerの生成をここに閉じ込めることで、他のゲームが選ばれている間は初期化コスト
// （楽曲読み込み等）を発生させない。onBackは「メニューに戻る」操作で呼ぶ
// コールバック。既存3作のindex.tsと同じ役割分担（配線のみ担当）。
export function init(onBack: () => void): void {
  ui.showScreen("title");
  ui.bindMenuButton(onBack);
  ui.buildBoard(GRID_N);

  const token = import.meta.env.VITE_TEXTALIVE_TOKEN;

  if (!token) {
    ui.showTokenError(
      "エラー: VITE_TEXTALIVE_TOKEN が設定されていません。.env を確認してください。",
    );
    console.error("[LyricSearch] VITE_TEXTALIVE_TOKEN is not set.");
    return;
  }

  // 設定は状態の作り直しをまたいで引き継ぐ（選曲・選択モードは保持したまま
  // 盤面と取得済み集合だけを捨てる）。
  const settings = game.createInitialSettings();
  let state = game.createInitialState(settings, null);
  let paused = false;
  // ガイドの再描画は毎フレーム行わず、内容が変わったときだけ行う。
  let guideSignature = "";

  ui.updateSongButtons(textalive.SONGS.indexOf(settings.song));
  ui.setPauseLabel(false);
  ui.setDebugModeLabel(settings.selectionMode);

  // 曲の再生終了時に呼ぶ。textalive.ts内のonTimeUpdate／onStopイベントと、下の
  // ループからの毎フレームのポーリング（checkSongEnd呼び出し）から呼ばれうる。
  function handleSongEnd(): void {
    if (state.screen === "result") return;
    state.screen = "result";
    ui.showScreen("result");
    ui.showResult(state);
  }

  const player = textalive.createPlayer(
    token,
    () => {
      // アプリ（TextAlive埋め込み）自体の起動完了。以降、選曲はローカルな状態
      // 更新のみでネットワーク通信を伴わないため、一度有効化すれば選び直す
      // たびに無効化し直す必要はない。
      ui.setStartEnabled(true);
      ui.setSongButtonsEnabled(true);
    },
    () => {
      // 実データ（歌詞）が届いた。対象語を抽出し、初期盤面を作ってから再生を始める。
      // onVideoReadyとonTimerReadyが両方揃うまでここは呼ばれない（textalive.ts）。
      const targets = textalive.computeTargetWords(player);
      game.completeTrackLoad(state, targets);
      const changes = game.generateInitialBoard(state);
      ui.renderBoard(state.board);
      ui.applyCellChanges(changes);
      guideSignature = "";
      // 新しい曲のクレジットに更新された後で表示する（Start押下時に隠している）。
      ui.setMediaVisible(true);
      textalive.startPlayback(player);
    },
    handleSongEnd,
  );

  ui.bindSongButtons((index) => {
    // 実データの読み込みはStart押下時まで遅延するため、ここではローカルな
    // 状態更新のみ（ネットワーク通信を伴わないため、選び直しても競合しない）。
    game.setSong(state, textalive.SONGS[index]);
    ui.updateSongButtons(index);
  });

  ui.bindStartButton(() => {
    // 盤面・有効語プール・取得済み集合をすべて捨ててから読み込む（計画書10章）。
    state = game.createInitialState(settings, null);
    state.screen = "play";
    paused = false;
    ui.setPauseLabel(false);
    ui.showScreen("play");
    // showScreen("play")は#ls-mediaを表示状態へ戻すが、この時点ではまだ前の曲の
    // クレジットが残っている。新しい実データが届く（onSongReady）まで隠しておく。
    ui.setMediaVisible(false);
    ui.renderGuide([]);
    ui.renderSelection([]);
    textalive.loadSong(player, settings.song);
  });

  ui.bindPauseButton(() => {
    if (state.screen !== "play" || !state.trackLoaded) return;
    paused = !paused;
    if (paused) player.requestPause();
    else player.requestPlay();
    ui.setPauseLabel(paused);
    // 一時停止中に指が残っていると選択状態が宙に浮くため、必ず破棄する。
    game.cancelSelection(state);
    ui.renderSelection([]);
  });

  ui.bindResultButtons(
    () => {
      // RETRY: 読み込み済みの実データを引き継いだまま、盤面と取得状況だけを捨てる。
      const targets = state.targets;
      state = game.createInitialState(settings, targets);
      state.screen = "play";
      paused = false;
      ui.setPauseLabel(false);
      ui.showScreen("play");
      const changes = game.generateInitialBoard(state);
      ui.renderBoard(state.board);
      ui.applyCellChanges(changes);
      guideSignature = "";
      textalive.startPlayback(player);
    },
    () => {
      // TITLE: 再生を止め、読み込み済みの実データを破棄してタイトルへ戻る。
      // Start押下時は常に読み込み直すため、ここで保持していても使われない。
      // バナーはshowScreen("title")が隠す。プレイ画面から直接メニューへ戻る導線は
      // 持たない（計画書4.7）。
      player.requestStop();
      state = game.createInitialState(settings, null);
      paused = false;
      ui.setPauseLabel(false);
      ui.showScreen("title");
    },
  );

  // ------------------------------------------------------------ 盤面の入力

  ui.bindBoardPointer({
    onStart: (index) => {
      if (state.screen !== "play" || paused || !state.trackLoaded) return;
      game.beginSelection(state, index);
      ui.renderSelection(state.selection);
    },
    onMove: (index) => {
      if (!state.selecting) return;
      if (game.extendSelection(state, index)) ui.renderSelection(state.selection);
    },
    onEnd: () => {
      if (!state.selecting) return;
      // 不一致演出の対象を、照合前に控えておく（endSelectionが選択を空にするため）。
      const attempted = [...state.selection];
      const result = game.endSelection(state);
      ui.renderSelection([]);
      if (result.word) {
        ui.renderBoard(state.board);
        ui.applyCellChanges(result.changes);
        ui.updateScoreHud(game.getScorePercent(state));
        guideSignature = "";
      } else {
        ui.flashMiss(attempted);
        // 選択中に保留していた再評価が消化された場合は、盤面の描画も追随させる。
        if (result.changes.written.length > 0 || result.changes.overwritten.length > 0) {
          ui.renderBoard(state.board);
          ui.applyCellChanges(result.changes);
          guideSignature = "";
        }
      }
    },
    onCancel: () => {
      game.cancelSelection(state);
      ui.renderSelection([]);
    },
  });

  // ------------------------------------------------------------------ 開発用

  // 開発用の再生位置シークバーと選択モードトグル（DEV環境限定）。
  // シークは9章の暫定パラメータ調整に、モードトグルは11.4が求める経路方式と
  // 直線方式の実機比較に使う。DEV以外ではno-opのままにしておき、下のループ側は
  // 分岐なしで呼べるようにする。
  let updateDebugSeek: (songPosition: number) => void = () => {};

  if (import.meta.env.DEV) {
    ui.setDebugVisible(true);
    ui.bindDebugSeek((positionMs) => player.requestMediaSeek(positionMs));
    ui.bindDebugMode(() => {
      const next = state.settings.selectionMode === "path" ? "line" : "path";
      game.setSelectionMode(state, next);
      ui.setDebugModeLabel(next);
      ui.renderSelection([]);
    });
    updateDebugSeek = (songPosition: number) => {
      ui.updateDebugSeek(songPosition, player.video.duration);
    };
  }

  // -------------------------------------------------------------------- ループ

  const loop = (): void => {
    // 1フレームの処理中に想定外の例外が起きても、requestAnimationFrame(loop)への
    // 再スケジュールだけは必ず行う（既存3作と同じ設計。1フレームの失敗で
    // コンテンツ全体を道連れにしない）。
    try {
      if (state.screen === "play" && !paused && state.trackLoaded) {
        const songPosition = player.timer.position;
        textalive.checkSongEnd(player, songPosition, handleSongEnd);

        // 有効語プールの変化を検出したときだけ、盤面の再評価と再描画を行う
        // （計画書3.4。毎フレームは実行しない）。
        const changes = game.update(state, songPosition);
        if (changes) {
          ui.renderBoard(state.board);
          ui.applyCellChanges(changes);
        }

        renderGuideIfChanged();
        ui.updateScoreHud(game.getScorePercent(state));
        ui.updateTimeHud(songPosition, player.video.duration);
        updateDebugSeek(songPosition);
      }
    } catch (error) {
      console.error("[LyricSearch] frame update failed:", error);
    }
    requestAnimationFrame(loop);
  };

  function renderGuideIfChanged(): void {
    const phrases = game.guidePhrases(state);
    const current = game.currentPhraseIndex(state);
    const signature = `${phrases.join(",")}/${current}/${state.acquired.size}/${state.missed.size}`;
    if (signature === guideSignature) return;
    guideSignature = signature;

    if (!state.targets) {
      ui.renderGuide([]);
      return;
    }
    ui.renderGuide(
      phrases.map((phraseIndex) => ({
        current: phraseIndex === current,
        chips: state.targets!.phrases[phraseIndex].words.map((word) => ({
          text: word.text,
          state: state.acquired.has(word.id)
            ? ("got" as const)
            : state.missed.has(word.id)
              ? ("missed" as const)
              : ("pending" as const),
        })),
      })),
    );
  }

  requestAnimationFrame(loop);
}
