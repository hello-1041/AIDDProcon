import "./style.css";
import * as game from "./game.ts";
import * as render from "./render.ts";
import * as ui from "./ui.ts";
import * as textalive from "./textalive.ts";

const titleDescEl = document.querySelector<HTMLElement>(".title-desc")!;
const btnStartEl = document.querySelector<HTMLButtonElement>("#btn-start")!;
const screenPlayEl = document.querySelector<HTMLElement>("#screen-play")!;
const canvas = document.querySelector<HTMLCanvasElement>("#game-canvas")!;
const ctx = canvas.getContext("2d")!;
const debugHudEl = document.querySelector<HTMLElement>("#debug-hud")!;
const debugSeekEl = document.querySelector<HTMLInputElement>("#debug-seek")!;

// デバッグ用タイミング表示・シークバーは非表示のまま運用する（CSS側の既定値
// display:noneのまま）。内部の計測・同期ロジック自体は継続して動作させる。
let lastClickDebugText = "";
let debugSeekDragging = false;

canvas.width = render.CANVAS_WIDTH;
canvas.height = render.CANVAS_HEIGHT;
render.resizeToFit(canvas);
window.addEventListener("resize", () => render.resizeToFit(canvas));

ui.showScreen("title");

// 跳躍アニメーションの長さ（次のダウンビートまでの時間）に掛けるクランプ範囲。
// 短すぎると瞬間移動に見え、長すぎると間延びするため上下限を設ける。
// クリック時／各着水直後に自動開始する跳躍の両方で使う。
const MIN_BOUNCE_DURATION_MS = 200;
const MAX_BOUNCE_DURATION_MS = 2200;

// 導入の投げ込み演出（曲の先頭から）の長さに掛けるクランプ範囲。
const MIN_INTRO_THROW_DURATION_MS = 600;
const MAX_INTRO_THROW_DURATION_MS = 5000;

const token = import.meta.env.VITE_TEXTALIVE_TOKEN;

if (!token) {
  titleDescEl.textContent =
    "エラー: VITE_TEXTALIVE_TOKEN が設定されていません。.env を確認してください。";
  console.error("[MizukiRhythm] VITE_TEXTALIVE_TOKEN is not set.");
} else {
  const state = game.createInitialState();
  let judgeThresholds: textalive.JudgeThresholds = textalive.DEFAULT_THRESHOLDS;
  let interludeRanges: textalive.InterludeRange[] = [];
  let introThrowDuration = render.INTRO_THROW_DURATION_MS;
  let paused = false;
  let pauseStartedAt: number | null = null;

  // player.video.endTimeが実際の再生時間と一致しない曲があり、position >= endTimeが
  // 一度も成立しないまま自然に再生が止まってしまうことがある（checkSongEndをループで
  // 毎フレーム呼ぶだけでは解消しなかった）。再生位置が一定時間変化しなくなったことを
  // もって「曲が終了した（もしくは何らかの理由で止まった）」とみなすフォールバック。
  const SONG_STALL_TIMEOUT_MS = 800;
  let lastObservedPosition = -1;
  let lastPositionChangeAt = 0;

  // クリック時／アイドルホップ時、共通で使う跳躍アニメーションの着水目標（再生位置）を求める。
  // 次のダウンビートの再生位置に合わせ、すぐに着水せずゆっくり跳ねるようにする。
  function computeBounceTarget(fromSongTime: number): number {
    const nextDownbeat = textalive.getNextDownbeatTime(player, fromSongTime);
    const duration =
      nextDownbeat !== null
        ? Math.min(
            Math.max(nextDownbeat - fromSongTime, MIN_BOUNCE_DURATION_MS),
            MAX_BOUNCE_DURATION_MS,
          )
        : render.BOUNCE_DURATION_MS;
    return fromSongTime + duration;
  }

  // 曲の再生終了時に呼ぶ。textalive.ts内のonTimeUpdateイベントと、main.tsのループからの
  // 毎フレームのポーリング（下のcheckSongEnd呼び出し）の両方から呼ばれうる
  // （textalive.checkSongEndが二重発火を防ぐため、ここでは呼ばれた分だけそのまま処理してよい）。
  function handleSongEnd(): void {
    game.finishChallenge(state);
    ui.showScreen("result");
    ui.showResult(state.bestDistance);
  }

  const player = textalive.createPlayer(
    token,
    () => {
      // onVideoReady/onTimerReady: ビート情報が確定し、プレイ可能になった
      judgeThresholds = textalive.computeJudgeThresholds(player);
      interludeRanges = textalive.computeInterludeRanges(player);
      // 最初の歌詞が始まる時刻に合わせ、導入の投げ込み演出の長さを決める
      // （曲によって異なるイントロの長さに、着水タイミングを揃えるため）。
      const firstPhrase = player.video.firstPhrase;
      introThrowDuration = firstPhrase
        ? Math.min(
            Math.max(firstPhrase.startTime, MIN_INTRO_THROW_DURATION_MS),
            MAX_INTRO_THROW_DURATION_MS,
          )
        : render.INTRO_THROW_DURATION_MS;
      btnStartEl.disabled = false;
    },
    handleSongEnd,
  );

  if (import.meta.env.DEV) {
    // #debug-seekは#screen-playの子要素で、ゲームプレイ用のクリックリスナーが
    // #screen-play全体に貼られているため、そのままだとドラッグ操作がクリック判定として
    // 二重に処理されてしまう（一時停止ボタンで一度踏んだのと同じ問題）ため止める。
    debugSeekEl.addEventListener("click", (e) => e.stopPropagation());
    // ドラッグ中はループ側からのvalue更新と競合しないようにする
    debugSeekEl.addEventListener("pointerdown", () => {
      debugSeekDragging = true;
    });
    debugSeekEl.addEventListener("pointerup", () => {
      debugSeekDragging = false;
    });
    debugSeekEl.addEventListener("input", () => {
      player.requestMediaSeek(Number(debugSeekEl.value));
    });
  }

  btnStartEl.addEventListener("click", () => {
    state.screen = "play";
    ui.showScreen("play");
    render.startIntroThrow(introThrowDuration);
    textalive.startPlayback(player);
  });

  // クリックリスナーはCanvas単体ではなく、HUD・判定ポップアップを含む
  // #screen-play全体に貼る（HUD等の上をクリックしてもバブリングで拾うため）。
  screenPlayEl.addEventListener("click", () => {
    if (state.screen !== "play") return;
    if (paused) return; // 一時停止中はクリック無効
    if (!render.isIntroFinished()) return; // 投げ込み演出中はクリック無効

    const clickTime = player.timer.position;
    game.handleClick(state, player, clickTime, judgeThresholds, interludeRanges);

    const result = state.lastJudge;
    if (result === "just" || result === "good") {
      // 跳躍アニメーションと同じ開始・目標の再生位置でdisplayed distanceの遷移も
      // 進めることで、背景スクロールの伸びが着水演出と同期する（Justほど大きく伸びる）。
      render.triggerBounceAnimation(
        clickTime,
        computeBounceTarget(clickTime),
        state.currentDistance,
      );
      render.triggerSparkle(result, clickTime);
    }
    if (result) {
      ui.showJudgePopup(result);
    }
    if (import.meta.env.DEV && result) {
      const offset = textalive.getOffsetMs(player, clickTime);
      lastClickDebugText = `${result} (${offset !== null ? offset.toFixed(0) : "-"}ms)`;
    }
  });

  ui.bindPauseButton(() => {
    if (state.screen !== "play") return;
    paused = !paused;
    if (paused) {
      pauseStartedAt = performance.now();
      player.requestPause();
    } else {
      render.resumeAnimations(performance.now() - (pauseStartedAt ?? performance.now()));
      pauseStartedAt = null;
      player.requestPlay();
    }
    ui.setPauseLabel(paused);
  });

  ui.bindResultButtons(
    () => {
      Object.assign(state, game.createInitialState());
      state.screen = "play";
      paused = false;
      pauseStartedAt = null;
      ui.setPauseLabel(false);
      ui.showScreen("play");
      render.startIntroThrow(introThrowDuration);
      textalive.restartPlayback(player);
    },
    () => {
      player.requestStop();
      Object.assign(state, game.createInitialState());
      paused = false;
      pauseStartedAt = null;
      ui.setPauseLabel(false);
      ui.showScreen("title");
    },
  );

  const loop = () => {
    if (!paused) {
      const songPosition = player.timer.position;

      // onTimeUpdateイベント任せだと曲の終端ぴったりで発火しないことがあるため、
      // 毎フレームここでもポーリングして確実に検知する（textalive.checkSongEnd参照）。
      if (state.screen === "play") {
        textalive.checkSongEnd(player, songPosition, handleSongEnd);

        // 上のcheckSongEndだけでは解消しなかった曲があったため、position >= endTimeに
        // 依存しないフォールバックとして、再生位置そのものが動かなくなったことでも
        // 終了とみなす（endTimeが実際の再生時間と一致しない曲への対策）。
        if (songPosition !== lastObservedPosition) {
          lastObservedPosition = songPosition;
          lastPositionChangeAt = performance.now();
        } else if (
          songPosition > 0 &&
          !debugSeekDragging &&
          performance.now() - lastPositionChangeAt > SONG_STALL_TIMEOUT_MS
        ) {
          textalive.markSongEnded();
          handleSongEnd();
        }
      }

      // クリックしていない間も、石が常時ダウンビートに向けて跳ね続ける（自動で跳ねるだけで
      // 判定は行わない。着水までにクリックがなければ何も起きず、次のダウンビートへ向けて
      // また跳ね直す）。跳躍アニメーションが今何もなく（着水済み）、投げ込み演出やMiss
      // 沈み込み中でもないときにだけ、次の跳躍を自動的に開始する。
      if (
        state.screen === "play" &&
        render.isIntroFinished() &&
        !render.isMissSinking() &&
        !render.isBounceActive(songPosition)
      ) {
        render.triggerBounceAnimation(songPosition, computeBounceTarget(songPosition));
      }

      render.drawFrame(ctx, state, songPosition);

      if (import.meta.env.DEV) {
        // player.videoはonVideoReadyが発火するまで存在しない（アクセスすると例外になり、
        // ループ全体が停止して画面が固まってしまう）ため、存在チェックしてから読む。
        // player.video.endTime自体もonVideoReady/onTimerReady発火直後はまだ確定して
        // いないことがあり、一度きりの設定だとmax=0のままスライダーが一切動かせなく
        // なる不具合があったため、有効な値になり次第反映されるよう毎フレーム更新する。
        const endTime: number | undefined = player.video?.endTime;
        if (typeof endTime === "number" && Number.isFinite(endTime) && endTime > 0) {
          debugSeekEl.max = String(endTime);
        }
        if (state.screen === "play") {
          debugHudEl.textContent = `pos: ${Math.round(songPosition)}ms  last: ${lastClickDebugText}`;
          // ドラッグ中はユーザー操作を上書きしないよう、値の更新を止める
          if (!debugSeekDragging) {
            debugSeekEl.value = String(songPosition);
          }
        }
      }
    }
    ui.updateHud(state);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
