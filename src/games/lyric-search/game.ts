import {
  ACTIVE_PHRASE_MAX,
  Board,
  DEFAULT_SELECTION_MODE,
  GRID_N,
  LEAD_MS,
  PLACE_MAX,
  TAIL_MS,
  isAdjacent,
  sameDirection,
  type BoardChanges,
  type PlaceTarget,
  type SelectionMode,
} from "./board.ts";
import { DEFAULT_SONG, type SongOption, type SongTargets, type TargetWord } from "./textalive.ts";

export type Screen = "title" | "play" | "result";

export interface GameSettings {
  song: SongOption;
  selectionMode: SelectionMode;
}

/** 選択の照合結果（計画書3.5）。 */
export interface MatchResult {
  /** 取得が成立した対象語。不一致ならnull。 */
  word: TargetWord | null;
  /** 盤面の変化（取得が成立した場合のみ。演出に使う）。 */
  changes: BoardChanges;
}

export interface GameState {
  screen: Screen;
  settings: GameSettings;
  /** 楽曲の実データ。読み込みが完了するまではnull。 */
  targets: SongTargets | null;
  board: Board;
  /**
   * 取得済みの対象語ID -> 取得順（0始まり）。
   *
   * Setではなく順序を持つMapにしているのは、ガイドチップの「取得済み」の塗りを
   * 取得順に6色巡回させる案（計画書4.3）に備えるため。後から足すと取得済み集合の
   * 型と、そこを読む全箇所を触ることになるが、今持たせればnumberが1つ増えるだけで
   * 費用はほぼゼロである。
   */
  acquired: Map<string, number>;
  /** 取り逃し確定の対象語ID。 */
  missed: Set<string>;
  /** 現在有効なフレーズの添字。**歌い出しが早い順**（＝ガイドの表示順）。 */
  activePhrases: number[];
  /** 選択中のセル添字（選択順）。空なら非選択。 */
  selection: number[];
  /** pointerdown〜pointerupの間だけtrue。 */
  selecting: boolean;
  /**
   * `pointerdown` の時点で有効だった対象語。
   *
   * なぞり始めた語が、指を離す直前に照合対象から外れるのを防ぐ（計画書3.4）。
   * 照合はこれと「現在有効な語」の和集合に対して行う。
   */
  selectionSnapshot: TargetWord[];
  /** 選択中に溜まった、セルを解放すべき対象語ID（取り逃し確定分）。 */
  pendingClearIds: string[];
  /** 選択中に溜まった、盤面を作り直す必要があるという要求。 */
  pendingRebuild: boolean;
  /** 直近に観測した再生位置。 */
  lastPosition: number;
  trackLoaded: boolean;
}

export function createInitialSettings(): GameSettings {
  return { song: DEFAULT_SONG, selectionMode: DEFAULT_SELECTION_MODE };
}

/**
 * 選曲やり直し・リトライのたびに呼ぶ。盤面・有効語プール・取得済み集合を
 * すべてリセットする（計画書10章。歌詞コンソールでフラグの引きずりによる
 * 早期発火が実際に発生している）。
 */
export function createInitialState(settings: GameSettings, targets: SongTargets | null): GameState {
  return {
    screen: "title",
    settings,
    targets,
    board: new Board(GRID_N),
    acquired: new Map(),
    missed: new Set(),
    activePhrases: [],
    selection: [],
    selecting: false,
    selectionSnapshot: [],
    pendingClearIds: [],
    pendingRebuild: false,
    lastPosition: 0,
    trackLoaded: targets !== null,
  };
}

export function setSong(state: GameState, song: SongOption): void {
  state.settings.song = song;
  // 曲が変われば実データは無効。読み込み直しを強制する。
  state.targets = null;
  state.trackLoaded = false;
}

export function setSelectionMode(state: GameState, mode: SelectionMode): void {
  state.settings.selectionMode = mode;
  // 規則が変わるため、進行中の選択は破棄する。
  state.selection = [];
  state.selecting = false;
}

/** 実データの到着。盤面を初期生成する（計画書5.5）。 */
export function completeTrackLoad(state: GameState, targets: SongTargets): void {
  state.targets = targets;
  state.trackLoaded = true;
  state.board.reset();
  state.acquired.clear();
  state.missed.clear();
  state.activePhrases = [];
  state.selection = [];
  state.selecting = false;
  state.selectionSnapshot = [];
  state.pendingClearIds = [];
  state.pendingRebuild = false;
  state.lastPosition = 0;
}

// ==================================================== 有効期間・有効語プール

/** フレーズの有効期間の終端（計画書3.3）。この時刻を過ぎると取り逃し確定。 */
function phraseDeadline(state: GameState, phraseIndex: number): number {
  const phrase = state.targets!.phrases[phraseIndex];
  return phrase.endTime + TAIL_MS;
}

/**
 * 表示中フレーズ＝**今まさに歌われているフレーズ**（実装指摘4で定義を変更）。
 *
 * 初版は計画書2章の用語定義（「最も期限が早い有効フレーズ」）をそのまま実装していたが、
 * この定義はフレーズが重なる場面で必ず古い方を選ぶ。実測のフレーズ間隔は中央値
 * 114〜618ms（12.5）であり、`TAIL_MS = 1000` を足すと**歌が次のフレーズに入ってから
 * 約0.4〜0.9秒ガイドが前のフレーズを表示し続ける**。重なり率88〜97%からして、これは
 * 例外ではなく定常状態であり、「楽曲とずれている」という体感の主因だった。
 *
 * そこで「既に歌い始めているもののうち最も遅く始まったもの」を表示中とする。
 * まだどれも歌い始めていない場合（前奏中・先行提示のみ）はnullを返す。ガイドは
 * どの行も「歌唱中」とは表示しない。
 */
export function currentPhraseIndex(state: GameState): number | null {
  const phrases = effectivePhrases(state);
  if (phrases.length === 0 || !state.targets) return null;
  // 歌い出しが早い順に持っている。後ろから見て、最初に「もう歌い始めている」ものを採る。
  for (let i = phrases.length - 1; i >= 0; i--) {
    const index = phrases[i];
    if (state.targets.phrases[index].startTime <= state.lastPosition) return index;
  }
  // まだどのフレーズも歌い始めていない（前奏中）。
  return null;
}

/**
 * ガイドに並べるフレーズ（実装指摘6）。歌い出しが早い順、最大`ACTIVE_PHRASE_MAX`本。
 *
 * `ACTIVE_PHRASE_MAX = 2` により次フレーズの語は既に有効語プールに入っており、
 * 配置保証の対象にもなりうる（3.4）。初版はガイドに1本しか出しておらず、
 * 「盤面に置かれていて取れば得点になるのに、画面のどこにも表示されていない語」が
 * 常に存在していた。プールと表示を一致させる。
 */
export function guidePhrases(state: GameState): number[] {
  return effectivePhrases(state);
}

/**
 * 盤面とガイドが共通の対象とするフレーズ。
 *
 * 基本は有効フレーズそのものだが、**前奏中（第1フレーズの歌い出し前）に限り、
 * 第1フレーズを先出しする**（実装指摘7）。実測では6曲中3曲で第1フレーズの有効化が
 * 再生位置0より後にあり、こたえてでは17.5秒、世界最後の音楽隊では12.2秒に及ぶ。
 * この間を空の盤面で潰す理由はなく、前奏を探索時間として使えるようにする。
 *
 * **盤面とガイドで必ず同じものを使うこと。** 盤面にだけ先出しするとガイドが空になり、
 * 何を探せばよいか分からない。ガイドにだけ出すと配置保証されていない語を探させる。
 *
 * 曲の途中の間奏（有効フレーズが一時的に無くなる場面）には適用しない。そこで次の
 * フレーズを先出しすると、配置保証されていない語をガイドに出すことになる。
 */
function effectivePhrases(state: GameState): number[] {
  if (state.activePhrases.length > 0) return state.activePhrases;
  const first = state.targets?.phrases[0];
  if (first && state.lastPosition < first.startTime) return [first.index];
  return [];
}

/**
 * 現時点で取得可能な対象語。所属フレーズが有効期間内で、かつ未取得のもの。
 * **有効期限が早い順**に返す（照合で同一文字列の複数インスタンスを解決するため）。
 */
export function activeWords(state: GameState): TargetWord[] {
  if (!state.targets) return [];
  const byDeadline = [...effectivePhrases(state)].sort(
    (a, b) => phraseDeadline(state, a) - phraseDeadline(state, b),
  );
  return collectWords(state, byDeadline);
}

/**
 * 配置保証の優先順に並べた対象語（計画書3.4）。
 *
 * 表示中フレーズ（＝今歌われているフレーズ）の語を先頭に置き、残りを後ろに繋ぐ。
 * プレイヤーが今探している対象を、常に配置保証の優先対象とするため。
 */
function priorityWords(state: GameState): TargetWord[] {
  const phrases = effectivePhrases(state);
  const current = currentPhraseIndex(state);
  const order = current === null ? phrases : [current, ...phrases.filter((i) => i !== current)];
  return collectWords(state, order);
}

function collectWords(state: GameState, phraseOrder: readonly number[]): TargetWord[] {
  const out: TargetWord[] = [];
  for (const phraseIndex of phraseOrder) {
    for (const word of state.targets!.phrases[phraseIndex].words) {
      if (!state.acquired.has(word.id)) out.push(word);
    }
  }
  return out;
}

/**
 * 有効フレーズの集合を再計算する。変化があればtrueを返す。
 *
 * 有効期間 = [ startTime - LEAD_MS , endTime + TAIL_MS ]（計画書3.3）。
 * 判定の粒度を語ではなくフレーズにしているのは、IWord1語の発声時間が概ね
 * 0.3〜0.8秒であり、語単位では盤面から探し始める前に取り逃しが確定して
 * ゲームとして成立しないため。
 */
function recomputeActivePhrases(state: GameState, songPosition: number): boolean {
  if (!state.targets) return false;

  const next: number[] = [];
  for (const phrase of state.targets.phrases) {
    const from = phrase.startTime - LEAD_MS;
    const to = phrase.endTime + TAIL_MS;
    if (songPosition >= from && songPosition <= to) next.push(phrase.index);
  }
  // 上限で切る際は「有効期限が早い＝先に消えるもの」を優先して残す。
  next.sort((a, b) => phraseDeadline(state, a) - phraseDeadline(state, b));
  const capped = next.slice(0, ACTIVE_PHRASE_MAX);
  // 保持は歌い出し順にする。ガイドの表示順（実装指摘6）がこの並びになる。
  capped.sort((a, b) => state.targets!.phrases[a].startTime - state.targets!.phrases[b].startTime);

  const same =
    capped.length === state.activePhrases.length &&
    capped.every((v, i) => v === state.activePhrases[i]);
  if (same) return false;

  state.activePhrases = capped;
  return true;
}

// ======================================================= 配置保証の対象選定

/**
 * 配置保証すべき語を選ぶ（計画書3.4）。
 *
 * 表示中フレーズの未取得語から、有効期限が早い順に最大PLACE_MAX語。足りない
 * 場合に限り、次フレーズの未取得語で残り枠を埋める。プレイヤーが探している対象
 * （表示中フレーズの語）を常に優先するため。
 *
 * 1文字語は枠を消費しない。盤面のどのセルにあっても成立するため枠を割り当てる
 * のは無駄であり、探し甲斐のある2文字以上の語が盤面に載らなくなる害がある。
 * 1文字語はensureSingleCharsで別途保証する。
 */
function placeTargetsOf(state: GameState, words: readonly TargetWord[]): PlaceTarget[] {
  const out: PlaceTarget[] = [];
  const lineMode = state.settings.selectionMode === "line";
  for (const word of words) {
    if (out.length >= PLACE_MAX) break;
    if (word.match.length < 2) continue;
    // 直線モードでは一列に収まらない語を配置保証の対象外とする
    // （計画書3.1。分割機構は経路方式の採用に伴い全廃している）。
    if (lineMode && word.match.length > GRID_N) continue;
    out.push({ id: word.id, text: word.match });
  }
  return out;
}

/**
 * 1文字語の軽い保証の対象（優先順）。
 *
 * 対象語を文節単位に連結した結果（実装指摘8）、1文字語は44.2%から4.4%へ減った。
 * ただし残った1文字語は「し」「今」「影」のような低頻度の語であり、ダミー抽選で
 * 盤面に現れる確率はむしろ下がる（フォールバック発火率 20.9%→34.8%）。削除不可。
 */
function singleCharsOf(words: readonly TargetWord[]): string[] {
  const out: string[] = [];
  for (const word of words) {
    if (word.match.length === 1) out.push(word.match);
  }
  return out;
}

// ============================================ 5.6 選択から補充までのシーケンス

/**
 * 計画書5.6 の ④→⑤→⑥→⑦ を1本にまとめたもの。
 *
 * 取得成立と取り逃し確定は、必ずこの同じ経路を通す。別経路を書くと、必ず片方で
 * 盤面と有効語プールの同期漏れが起きる（計画書10章）。
 *
 * **順序は仕様である。** 空いたセルを先にダミーで埋めてはならない。盤面が満杯の
 * 状態では「全セルが空または一致」がほぼ成立せず、第1段階の成功率が
 * 65.6%→16.9%まで落ちる（計画書5.3）。
 *
 * ④〜⑦は同一フレーム内の同期処理であり、時間的な遅延を挟まない。セルが空のまま
 * でいるのは⑤〜⑥の計算が終わるまでの一瞬で、フレームをまたがない。
 */
function rebuildBoard(
  state: GameState,
  clearIds: readonly string[],
  words: readonly TargetWord[],
): BoardChanges {
  const board = state.board;
  const freq = state.targets?.freq ?? null;

  // ④ セル解放。ここで補充してはならない。
  for (const id of clearIds) board.clearTarget(id);

  // ⑤ 配置保証の再評価
  const changes = board.placeAll(placeTargetsOf(state, words), state.settings.selectionMode);

  // ⑥ 補充（残った空セルをダミー文字で埋める）
  changes.written.push(...board.fillEmpty(freq));

  // ⑦ 1文字語の保証。⑥の後でなければ「盤面に文字が無い」の判定ができない。
  changes.overwritten.push(...board.ensureSingleChars(singleCharsOf(words)));

  return changes;
}

/**
 * 初期盤面の生成（計画書5.5・3.4のトリガ1）。
 *
 * **時刻判定を経由せず、第1フレーズの語を配置保証の対象として渡す**（実装指摘7）。
 * 初版は再生位置0で有効フレーズを計算していたが、第1フレーズが有効になるのは
 * `startTime - LEAD_MS` 以降であり、実測では6曲中3曲でこの時刻が0より後にある。
 * 該当曲では初期盤面が純ダミーになり、直後（シャッターチャンスでは0.5秒後）に
 * 盤面が丸ごと書き換わっていた。
 *
 * 第1フレーズの語を最初から置いておけば、その後で当該フレーズが有効化されても
 * `isPlaced` が成立するため盤面は動かない。前奏が長い曲（こたえて17.5秒、
 * 世界最後の音楽隊12.2秒）では、歌い出しまでを探索時間として使えるようになる。
 */
export function generateInitialBoard(state: GameState, songPosition = 0): BoardChanges {
  state.lastPosition = songPosition;
  recomputeActivePhrases(state, songPosition);
  return rebuildBoard(state, [], priorityWords(state));
}

/**
 * 有効語プールを現在位置まで進め、必要なら盤面を作り直す。
 *
 * 有効期間を過ぎたフレーズの未取得語は、すべて取り逃し確定となる。取り逃しも
 * 取得成立と同じ ④→⑤→⑥→⑦ の経路を通す（計画書5.6・10章）。
 *
 * 変化が何も無ければnullを返し、盤面には一切触れない。不一致時に「補充も
 * 起きない」（5.6 ②'）を守るため。
 */
function settle(state: GameState, extraClearIds: readonly string[]): BoardChanges | null {
  if (!state.targets) return null;

  const before = new Set(state.activePhrases);
  if (recomputeActivePhrases(state, state.lastPosition)) {
    const nowActive = new Set(state.activePhrases);
    for (const phraseIndex of before) {
      if (nowActive.has(phraseIndex)) continue;
      for (const word of state.targets.phrases[phraseIndex].words) {
        if (state.acquired.has(word.id)) continue;
        state.missed.add(word.id);
        state.pendingClearIds.push(word.id);
      }
    }
    state.pendingRebuild = true;
  }
  if (extraClearIds.length > 0) {
    state.pendingClearIds.push(...extraClearIds);
    state.pendingRebuild = true;
  }

  // 選択中は盤面だけ据え置く（実装指摘3）。有効語プールとガイドは上で既に進めている。
  if (state.selecting) return null;
  if (!state.pendingRebuild) return null;

  const clearIds = state.pendingClearIds;
  state.pendingClearIds = [];
  state.pendingRebuild = false;
  return rebuildBoard(state, clearIds, priorityWords(state));
}

/**
 * 毎フレーム呼ぶ進行更新。有効語プールの変化を検出し、必要なら再評価する。
 *
 * 配置保証の再評価は計画書3.4の3タイミングでのみ行う。毎フレームは実行しない。
 *
 * **選択中（pointerdown〜pointerup）に据え置くのは盤面の書き換えだけである**
 * （実装指摘3）。フレーズの失効はプレイヤーの指の動きと無関係に起き、実測の
 * フレーズ間隔は中央値114〜618ms（12.5）であるため、「なぞっている最中に指の下の
 * セルが書き換わる」ことは日常的に起きる。これは防がねばならない。
 *
 * 初版はこれを有効語プールの更新ごと止めることで実現していたが、ガイド表示まで
 * 巻き添えにして固まっていた。現在はプールとガイドは進め、なぞり始めた語が
 * 照合対象から外れる問題は`selectionSnapshot`との和集合で防いでいる。
 */
export function update(state: GameState, songPosition: number): BoardChanges | null {
  state.lastPosition = songPosition;
  if (state.selecting) return null;
  return settle(state, []);
}

// ================================================== 3.5 選択状態機械と照合

/** pointerdown。選択の起点を確定し、この時点の有効語を控える（計画書3.4）。 */
export function beginSelection(state: GameState, idx: number): void {
  state.selecting = true;
  state.selection = [idx];
  state.selectionSnapshot = activeWords(state);
}

/**
 * pointermove。選択を伸ばす／取り消す。戻り値は選択内容が変化したかどうか。
 *
 * - 現在の末尾セルと上下左右に隣接するセルにのみ伸ばせる（斜めは不可）
 * - 既に選択済みのセルへは進めない（自己交差の禁止）
 * - 直前のセルへ戻る動きは、選択の取り消しとして扱う
 * - 隣接していないセルへ指が飛んだ場合、その入力は無視する。間を勝手に補間して
 *   繋がない（意図しない文字の混入を避けるため。計画書3.5・10章）
 */
export function extendSelection(state: GameState, idx: number): boolean {
  if (!state.selecting || state.selection.length === 0) return false;

  const last = state.selection[state.selection.length - 1];
  if (idx === last) return false;

  // 直前のセルへ戻る動き＝取り消し
  if (state.selection.length >= 2 && idx === state.selection[state.selection.length - 2]) {
    state.selection.pop();
    return true;
  }

  if (state.selection.includes(idx)) return false;
  if (!isAdjacent(last, idx, state.board.n)) return false;

  // 直線モード：2セル目で確定した方向を維持すること（計画書3.5のオプション）
  if (state.settings.selectionMode === "line" && state.selection.length >= 2) {
    const prev = state.selection[state.selection.length - 2];
    if (!sameDirection(prev, last, idx, state.board.n)) return false;
  }

  state.selection.push(idx);
  return true;
}

/** 選択を破棄する（pointercancel等）。据え置いていた盤面の更新は次のupdateで消化される。 */
export function cancelSelection(state: GameState): void {
  state.selection = [];
  state.selecting = false;
  state.selectionSnapshot = [];
}

/**
 * pointerup。照合を行い、成立すれば取得処理まで進める（計画書3.5・5.6）。
 *
 * 選択セルの文字を選択順に連結した文字列Sを作り、有効語プール内の各未取得語の
 * 照合用文字列Wと比較する。S === W または reverse(S) === W であれば一致
 * （word searchの慣例に従い、逆順一致も認める）。
 *
 * 一致する語が複数ある場合（同一文字列の別インスタンス）、有効期限が最も早い
 * インスタンスを1件だけ取得済みにする。
 */
export function endSelection(state: GameState): MatchResult {
  const empty: MatchResult = { word: null, changes: { written: [], overwritten: [] } };
  if (!state.selecting || !state.targets) {
    cancelSelection(state);
    return empty;
  }

  const s = state.board.textOf(state.selection);
  const reversed = [...s].reverse().join("");
  state.selecting = false;

  // 照合の対象は「なぞり始めた時点で有効だった語」と「現在有効な語」の和集合
  // （計画書3.4）。なぞっている最中にフレーズが失効しても、始めた時点で狙えた語は
  // 取れる。有効期限が早い順に見て、最初の一致を採る（同一文字列の複数インスタンスは
  // 期限が最も早いものを1件だけ取得する。計画書3.5）。
  let hit: TargetWord | null = null;
  if (s.length > 0) {
    const byId = new Map<string, TargetWord>();
    for (const word of [...activeWords(state), ...state.selectionSnapshot]) {
      if (!state.acquired.has(word.id)) byId.set(word.id, word);
    }
    const candidates = [...byId.values()].sort((a, b) => a.endTime - b.endTime);
    hit = candidates.find((w) => w.match === s || w.match === reversed) ?? null;
  }

  state.selection = [];
  state.selectionSnapshot = [];

  // 取得確定なら取得済みに記録する。不一致でもペナルティは設けない（計画書3.5）。
  if (hit) state.acquired.set(hit.id, state.acquired.size);

  // 凍結していた有効語プールを、ここでまとめて現在位置まで進める。取り逃しが
  // 確定していればその解放も、この1回で片付く（計画書3.4・5.6）。
  const changes = settle(state, hit ? [hit.id] : []);
  return { word: hit, changes: changes ?? { written: [], overwritten: [] } };
}

// ================================================================== スコア

/**
 * 取得率（計画書3.8）。分母は3.1の抽出を通過した対象語のみを数える。
 * 記号・除外語は取得手段が存在しないため、含めれば100%が到達不能になる。
 */
export function getScorePercent(state: GameState): number {
  const total = state.targets?.words.length ?? 0;
  if (total === 0) return 0;
  return (state.acquired.size / total) * 100;
}
