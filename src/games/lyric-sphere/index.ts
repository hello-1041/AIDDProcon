import "./style.css";
import * as game from "./game.ts";
import * as render from "./render.ts";
import * as sphere from "./sphere.ts";
import * as textalive from "./textalive.ts";
import * as ui from "./ui.ts";
import * as view from "./view.ts";

/**
 * メニューからこのゲームが選ばれたときに一度だけ呼ぶ。DOM要素の取得とPlayerの生成を
 * ここに閉じ込め、他のゲームが選ばれている間は初期化コストを発生させない
 * （既存4作のindex.tsと同じ役割分担。配線のみ担当）。
 */
export function init(onBack: () => void): void {
  ui.showScreen("title");
  ui.bindMenuButton(onBack);

  const token = import.meta.env.VITE_TEXTALIVE_TOKEN;

  if (!token) {
    ui.showTokenError(
      "エラー: VITE_TEXTALIVE_TOKEN が設定されていません。.env を確認してください。",
    );
    console.error("[LyricSphere] VITE_TEXTALIVE_TOKEN is not set.");
    return;
  }

  const settings = game.createInitialSettings();
  let state = game.createInitialState(settings, null);
  const viewState = view.createViewState();

  const sky = render.attachCanvas(ui.getSkyCanvas());
  const skyMap = render.attachCanvas(ui.getSkyMapCanvas());

  // 行列→文字の逆引き。配置計画と同じく、ロード時に1回だけ作る。
  let cellMap = new Int32Array(0) as Int32Array<ArrayBuffer>;
  // 曲終了時に一度だけ組む星座線（3.7）。プレイ中はnull。
  let constellation: number[][] | null = null;

  // 星化待ちの文字（lit のまま残っているもの）。点灯した時点で加え、星化した時点で
  // 外す。毎フレーム全2760セルを走査しないための集合（11章）。
  let litPending: number[] = [];

  let paused = false;
  let lastFrameAt = performance.now();

  // findChorus／findBeatは1フレームに1回だけ呼び、結果をキャッシュする（11章）。
  // 描画の各所から呼ぶ実装にしてはならない。
  let beatGlow = 1;
  let beatScale = 1;

  ui.updateSongSelect(textalive.SONGS.indexOf(settings.song));
  ui.setPauseLabel(false);
  ui.setGyroToggleEnabled(typeof DeviceOrientationEvent !== "undefined");

  function handleSongEnd(): void {
    if (state.screen === "result") return;
    state.screen = "result";
    // 星座は曲の終わりに一度だけ組む（3.7）。同じものを天球と全天図の双方で使う。
    if (state.placement) {
      constellation = render.buildConstellation(state.placement, state.charStates);
    }
    ui.showScreen("result");
    ui.showResult(game.getLightPercent(state));
    // リザルト画面が表示された後でなければ、canvasの表示サイズが確定しない。
    render.resizeCanvas(skyMap);
    if (state.placement && constellation) {
      render.drawSkyMap(skyMap, state.placement, state.charStates, constellation);
    }
  }

  const player = textalive.createPlayer(
    token,
    () => {
      // アプリ（TextAlive埋め込み）自体の起動完了。以降の選曲はローカルな状態更新
      // のみでネットワーク通信を伴わないため、一度有効化すれば足りる。
      ui.setStartEnabled(true);
      ui.setSongSelectEnabled(true);
    },
    () => {
      // 実データ（歌詞）が届いた。配置計画を作ってから再生を始める。onVideoReadyと
      // onTimerReadyが両方揃うまでここは呼ばれない（textalive.ts）。
      const phrases = textalive.computeSpherePhrases(player);
      const songIndex = textalive.SONGS.indexOf(state.settings.song);
      const placement = sphere.buildPlacement(phrases, songIndex);
      game.completeTrackLoad(state, placement);
      cellMap = render.buildCellMap(placement);
      constellation = null;
      render.clearParticles();
      litPending = [];
      // 新しい曲のクレジットに更新された後で表示する（Start押下時に隠している）。
      ui.setMediaVisible(true);
      textalive.startPlayback(player);
    },
    handleSongEnd,
  );

  // ------------------------------------------------------------ タイトル画面

  ui.bindSongSelect((index) => {
    // 実データの読み込みはStart押下時まで遅延するため、ここではローカルな状態更新
    // のみ（表示はプルダウン自身が既に切り替えている）。
    game.setSong(state, textalive.SONGS[index]);
  });

  /**
   * ジャイロのトグル（3.5）。
   *
   * requestPermissionはトグル操作と同じコールスタックで呼ぶ必要があり、awaitを
   * 挟んだ後では通らない（11章）。そのため許可要求は即座に発行し、結果の反映だけを
   * thenで行う。
   */
  ui.bindGyroToggle((checked) => {
    if (!checked) {
      settings.gyroEnabled = false;
      viewState.gyroEnabled = false;
      ui.setRecenterVisible(false);
      return;
    }

    const anyEvent = DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<PermissionState>;
    };

    if (typeof anyEvent?.requestPermission !== "function") {
      // 許可要求が不要な環境（Android等）。そのまま有効化する。
      enableGyro();
      return;
    }

    anyEvent
      .requestPermission()
      .then((result) => {
        if (result === "granted") {
          enableGyro();
          return;
        }
        // 拒否された場合はトグルを自動でOFFへ戻し、理由を説明欄に表示する（3.5）。
        // 無反応の行き止まりを作らない。
        ui.setGyroToggle(false);
        settings.gyroEnabled = false;
        viewState.gyroEnabled = false;
        ui.showNotice("端末の向きを使う許可が得られませんでした。スワイプで見回せます。");
      })
      .catch(() => {
        ui.setGyroToggle(false);
        settings.gyroEnabled = false;
        viewState.gyroEnabled = false;
        ui.showNotice("端末の向きを取得できませんでした。スワイプで見回せます。");
      });
  });

  function enableGyro(): void {
    settings.gyroEnabled = true;
    viewState.gyroEnabled = true;
    // 原点は最初のイベントで取り直す（3.5。絶対方位は使わない）。
    view.resetGyroOrigin(viewState);
    viewState.gyroOrigin = null;
    ui.setRecenterVisible(state.screen === "play");
  }

  window.addEventListener("deviceorientation", (e) => {
    if (!viewState.gyroEnabled || state.screen !== "play" || paused) return;
    if (e.alpha === null || e.beta === null) return;
    // gamma（ロール）は使わない。水平は常に保つ（3.5。傾けると酔う）。
    view.applyOrientation(viewState, e.alpha, e.beta, performance.now());
  });

  ui.bindRecenterButton(() => view.resetGyroOrigin(viewState));

  ui.bindStartButton(() => {
    // 配置計画・全セルの状態・視点・オートパイロットのタイマーをすべて捨ててから
    // 読み込む（11章。前の曲の状態を引きずらせない）。
    state = game.createInitialState(settings, null);
    state.screen = "play";
    view.resetView(viewState);
    viewState.gyroEnabled = settings.gyroEnabled;
    constellation = null;
    render.clearParticles();
    litPending = [];
    paused = false;
    ui.setPauseLabel(false);
    ui.showScreen("play");
    // showScreen("play")は#lsp-mediaを表示状態へ戻すが、この時点ではまだ前の曲の
    // クレジットが残っている。新しい実データが届くまで隠しておく。
    ui.setMediaVisible(false);
    ui.setRecenterVisible(settings.gyroEnabled);
    ui.updateDirectionHint(null);
    render.resizeCanvas(sky);
    textalive.loadSong(player, settings.song);
  });

  // ---------------------------------------------------------------- プレイ

  ui.bindSkyPointer({
    onDrag: (dx, dy) => {
      if (state.screen !== "play" || paused) return;
      view.applyDrag(viewState, dx, dy, performance.now());
    },
    onRelease: (velYaw, velPitch) => {
      if (state.screen !== "play" || paused) return;
      view.releaseDrag(viewState, velYaw, velPitch, performance.now());
    },
  });

  ui.bindPauseButton(() => {
    if (state.screen !== "play" || !state.trackLoaded) return;
    paused = !paused;
    if (paused) player.requestPause();
    else player.requestPlay();
    ui.setPauseLabel(paused);
  });

  ui.bindResultButtons(
    () => {
      // RETRY: 読み込み済みの配置計画を引き継いだまま、点灯状態だけを捨てる。
      // 同じ曲では同じ天球が出る（6.2の固定シード）ため、作り直す必要もない。
      const placement = state.placement;
      state = game.createInitialState(settings, placement);
      state.screen = "play";
      view.resetView(viewState);
      viewState.gyroEnabled = settings.gyroEnabled;
      constellation = null;
      render.clearParticles();
      litPending = [];
      paused = false;
      ui.setPauseLabel(false);
      ui.showScreen("play");
      ui.setRecenterVisible(settings.gyroEnabled);
      ui.updateDirectionHint(null);
      render.resizeCanvas(sky);
      textalive.startPlayback(player);
    },
    () => {
      // TITLE: 再生を止め、読み込み済みの実データを破棄してタイトルへ戻る。
      // Start押下時は常に読み込み直すため、ここで保持していても使われない。
      player.requestStop();
      state = game.createInitialState(settings, null);
      cellMap = new Int32Array(0) as Int32Array<ArrayBuffer>;
      constellation = null;
      render.clearParticles();
      litPending = [];
      paused = false;
      ui.setPauseLabel(false);
      ui.setRecenterVisible(false);
      ui.showScreen("title");
    },
  );

  // canvasの実解像度はCSS表示サイズから決めるため、回転・リサイズのたびに取り直す
  // （11章。f_px・H_FOVもcreateProjectionが毎フレーム計算し直す）。
  ui.bindResize(() => {
    if (!ui.isActive()) return;
    render.resizeCanvas(sky);
    if (state.screen === "result") {
      render.resizeCanvas(skyMap);
      if (state.placement && constellation) {
        render.drawSkyMap(skyMap, state.placement, state.charStates, constellation);
      }
    }
  });

  // ---------------------------------------------------------------- 開発用

  let updateDebug: (songPosition: number) => void = () => {};

  if (import.meta.env.DEV) {
    ui.setDebugVisible(true);
    ui.bindDebugSeek((positionMs) => player.requestMediaSeek(positionMs));
    updateDebug = (songPosition: number) => {
      ui.updateDebugSeek(songPosition, player.video.duration);
      ui.updateDebugCounts(state.pendingCount, state.litCount, state.lostCount);
    };
  }

  // ------------------------------------------------------------------ ループ

  const loop = (): void => {
    // 1フレームの処理中に想定外の例外が起きても、requestAnimationFrame(loop)への
    // 再スケジュールだけは必ず行う（既存4作と同じ設計）。
    try {
      const now = performance.now();
      const dtMs = Math.min(100, now - lastFrameAt);
      lastFrameAt = now;

      if (state.screen === "play" && state.trackLoaded && state.placement) {
        const songPosition = player.timer.position;
        textalive.checkSongEnd(player, songPosition, handleSongEnd);

        if (!paused) {
          // オートパイロットの向かう先（3.6）。予兆と同じフレーズを対象にし、その
          // 中央の文字へ寄せる。無操作でも歌詞が視野に入るのはこの追尾による。
          const targetIndex = game.autopilotTargetIndex(state, songPosition, sphere.PREVIEW_MS);
          const target =
            targetIndex === null
              ? null
              : {
                  azDeg: sphere.colToAzimuthDeg(state.placement.chars[targetIndex].col),
                  elDeg: sphere.rowToElevationDeg(state.placement.chars[targetIndex].row),
                };
          view.updateView(viewState, now, dtMs, target, sky.width, sky.height);
          game.updateBefore(state, songPosition);
        }

        // ビート（3.4）。findBeat／findChorusはこの1回だけ呼び、結果を使い回す。
        const beat = player.findBeat(songPosition);
        const inChorus = player.findChorus(songPosition) !== null;
        if (beat) {
          const progress = beat.progress(songPosition);
          // 拍頭で明るく、拍内で落ちる（グリッド線の輝度±25%）。
          beatGlow = 1.25 - 0.5 * progress;
          beatScale = inChorus ? 1 + 0.03 * (1 - progress) : 1;
        } else {
          beatGlow = 1;
          beatScale = 1;
        }

        // 予兆（4.6）。前奏中は第1フレーズの方角を常時示す（4.1）。
        const previewIndex =
          game.introHeadIndex(state, songPosition) ??
          game.previewHeadIndex(state, songPosition, sphere.PREVIEW_MS);

        const proj = render.drawFrame(sky, viewState, {
          placement: state.placement,
          cellMap,
          charStates: state.charStates,
          changedAt: state.changedAt,
          songPosition,
          beatGlow,
          beatScale,
          previewIndex,
          constellation: null,
        });

        if (!paused) {
          // 点灯判定はpendingのセルだけを対象にする（11章）。判定には描画と同じ
          // フレームの投影を使う。
          const chars = state.placement.chars;
          const litNow = game.applyLighting(state, songPosition, (index) => {
            const char = chars[index];
            const p = view.projectAngles(
              proj,
              sphere.colToAzimuthDeg(char.col),
              sphere.rowToElevationDeg(char.row),
            );
            return view.isInsideLightArea(proj, p);
          });

          for (const index of litNow) {
            const char = chars[index];
            const p = view.projectAngles(
              proj,
              sphere.colToAzimuthDeg(char.col),
              sphere.rowToElevationDeg(char.row),
            );
            render.spawnParticles(p.x, p.y, songPosition);
          }

          // 星化の対象は「lit のまま残っている文字」だけ（11章。全2760セルを毎
          // フレーム走査しない）。点灯した時点で加え、星化した時点で外す。
          litPending.push(...litNow);
          game.updateAfter(state, songPosition, litPending);
          litPending = litPending.filter((index) => state.charStates[index] === "lit");
        }

        // 方角インジケータ（4.1）。目標が画面内にあるならnullで全部消える。
        if (previewIndex !== null) {
          const char = state.placement.chars[previewIndex];
          ui.updateDirectionHint(
            view.directionHint(
              proj,
              viewState,
              sphere.colToAzimuthDeg(char.col),
              sphere.rowToElevationDeg(char.row),
            ),
          );
        } else {
          ui.updateDirectionHint(null);
        }

        ui.updateScoreHud(game.getLightPercent(state));
        ui.updateTimeHud(songPosition, player.video.duration);
        updateDebug(songPosition);
      }
    } catch (error) {
      console.error("[LyricSphere] frame update failed:", error);
    }
    requestAnimationFrame(loop);
  };

  requestAnimationFrame(loop);
}
