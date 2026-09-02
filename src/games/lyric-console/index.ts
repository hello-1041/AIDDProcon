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
  ui.updateSongOptionButtons(textalive.SONGS.indexOf(state.settings.song));

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
      // アプリ（TextAlive埋め込み）自体の起動完了。以降、選曲はローカルな状態
      // 更新のみでネットワーク通信を伴わないため、一度有効化すれば選び直す
      // たびに無効化し直す必要はない。
      ui.setStartEnabled(true);
      ui.setSongOptionButtonsEnabled(true);
    },
    () => {
      // 実データ（歌詞フレーズ）が届いた。ブート進行（waitingTrackからの復帰）は
      // updateBootPhase側で毎フレーム判定するため、ここでは値を保存するだけ。
      const phrases = textalive.computeLyricPhraseEntries(player);
      game.completeTrackLoad(state, phrases);
      // 新しい曲のクレジットに更新された後で表示する（Start押下時に隠している）。
      ui.setMediaVisible(true);
    },
    handleSongEnd,
  );

  ui.bindColorOptionButtons((color) => {
    game.setColor(state, color);
    ui.applyTheme(state.settings.color);
    ui.updateColorOptionButtons(color);
  });

  ui.bindSongOptionButtons((index) => {
    // 実データの読み込みはStart押下時まで遅延するため、ここではローカルな
    // 状態更新のみ（ネットワーク通信を伴わないため、選び直しても競合しない）。
    const song = textalive.SONGS[index];
    game.setSong(state, song);
    ui.updateSongOptionButtons(index);
  });

  ui.bindStartButton(() => {
    state.screen = "play";
    ui.showScreen("play");
    // showScreen("play")は#lc-mediaを無条件に表示状態へ戻すが、この時点では
    // まだ前の曲のクレジットが残っている（SDKが自前で書き換える要素のため）。
    // 新しい実データが届く（onSongReady）まで、改めて隠しておく。
    ui.setMediaVisible(false);
    // 読み込み済みの曲でも常に読み込み直す（単純さ優先）ため、古いtrackLoadedを
    // 先に破棄しておく。実際のtextalive.loadSong発行は、ブートが「loading
    // track」行のタイプを始めた瞬間まで遅延させる（下のループのpendingTrackLoad
    // 参照）。演出上「読み込んでいる」と主張するタイミングと、実際に読み込みを
    // 始めるタイミングを一致させるため。
    game.beginTrackLoad(state);
    // ブートは曲の再生と並行させない。「press any key to continue」表示後、
    // 入力を待ってから曲を再生する（フィードバック1.3：並行させるとイントロの
    // 短い曲で歌詞がバースト表示される不具合があったため）。
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
      // RETRY: 選択済みのColor・読み込み済みデータを引き継いだままブートから
      // 再生し直す（再読み込みはしない。読み込み待ちのスピナーも挟まない）。
      state = game.createInitialState(state.phrases, state.settings, true);
      state.screen = "play";
      ui.showScreen("play");
      game.startBoot(state);
    },
    () => {
      // TITLE: 選択済みのColor・読み込み済みデータを引き継いだままタイトルへ
      // 戻る（別の曲を選べばgame.setSongが読み込み済みフラグを破棄する）。
      player.requestStop();
      state = game.createInitialState(state.phrases, state.settings, true);
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
        ui.updateSpinner(now);
        // player.timer/player.videoは、実データ読み込み（trackLoaded）が完了する
        // までは安全にアクセスできない（Start押下直後・loadingTrack待機中は
        // 未読み込みでありうる）。songPositionは未読み込み時0のままでよい
        // （lyricsフェーズに到達するのは必ずtrackLoaded後のため、これによる
        // 不整合は起きない）。
        let songPosition = 0;
        if (state.trackLoaded) {
          songPosition = player.timer.position;
          ui.updateProgressBar(game.getProgressPercent(songPosition, player.video.duration));
          ui.updateVocalMeter(player.getVocalAmplitude(songPosition), player.getMaxVocalAmplitude());
          updateDebugSeek(songPosition);
        } else {
          // 実データ読み込み前でもステータスバーは0値で描き続ける。バーの描画まで
          // trackLoadedのガード内に入れてしまうと、ブート中だけ`PROG`とVOL
          // メーターの`[]`が消え、スピナーだけが残る（ラベル"VOL "はHTML側の静的
          // テキストのため、文字だけ残って見える）。
          ui.updateProgressBar(0);
          ui.updateVocalMeter(0, 0);
        }

        if (state.phase === "boot") {
          game.updateBootPhase(state, dtMs);
          // loading track行のタイプ開始と同時に実際の読み込みを発行する
          // （game.updateBootPhase内でpendingTrackLoadが立った直後に消費する）。
          if (game.takePendingTrackLoad(state)) {
            textalive.loadSong(player, state.settings.song);
          }
        } else if (state.phase === "lyrics") {
          textalive.checkSongEnd(player, songPosition, handleSongEnd);
          game.updateLyricTyping(state, songPosition);
        }
        // 読み込み待ちの間だけカーソルを消す（実CLIがスピナー表示中にカーソルを
        // 隠すのと同じ理由）。loading track行の末尾で回るスピナーと点滅周期が
        // 競合して見えること、および単独で点滅するカーソルは後段の
        // `press any key to continue`で使う「入力受付中」の合図と紛らわしく、
        // 本命の合図が鈍ることの2点による。
        const showCursor = cursorVisible && state.bootStage !== "waitingTrack";
        ui.renderConsole(state.consoleLines, state.currentLine, ui.getPlayTerminalEl(), showCursor);
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
