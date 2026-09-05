// Lyric-Search の盤面モデルと配置保証アルゴリズム（製造計画書5章）。
//
// 本ゲームの技術的な核。「今表示されているフレーズの語が、盤面のどこかに必ず
// 存在する」という状態を維持するための、制約付きランダムDFSを実装する。
//
// このモジュールはDOM・TextAliveに一切依存しない純粋なデータ操作とする
// （計画書8章）。検証用プロトタイプ temp/Lyric-Search_prototype/board.mjs を
// 移植したもので、12章の実測値はその実装で取得されている。挙動を変える改変を
// 加える場合は、実測の前提が崩れる点に注意すること。

// ============================================================ 9章 パラメータ一覧
//
// 計画書9章の「実装時は1箇所にまとめて定義する」に従い、ゲーム全体のパラメータを
// ここに集約する。盤面に関係しない時間パラメータもここに置くのは、調整時に
// 複数ファイルを行き来しないため。

/** 盤面の一辺。実測により全6曲で下限値に張り付いたため固定（計画書3.2）。 */
export const GRID_N = 5;

/** 照合用文字列がこれを超える語は対象語から除外する（経路として置けないため）。 */
export const MAX_TARGET_LEN = GRID_N * GRID_N;

/**
 * 同時に配置保証する語数の上限（計画書3.4）。1文字語は枠を消費しない。
 *
 * 3を採ると、5セル以上の書き換えが4.3%→10.3%に悪化し、3.6・10章が求める
 * 「無関係なセルは動かさない」に抵触する（12.2-b）。上げる場合は要再計測。
 */
export const PLACE_MAX = 2;

/** 1回の再評価で、1文字語の保証のために差し替えるセル数の上限（計画書5.2）。 */
export const SINGLE_FIX_MAX = 2;

/** フレーズの先行提示時間（計画書3.3）。 */
export const LEAD_MS = 2000;

/** 歌い終わり後の猶予（計画書3.3）。 */
export const TAIL_MS = 1000;

// 同時に有効となるフレーズ数の上限（計画書3.3の `ACTIVE_PHRASE_MAX`）は廃止した。
// 有効フレーズを「今のフレーズ＋次のフレーズ」の2本のキューとして持つ方式に変えた
// ため、上限は構造的に2で固定され、調整の余地が無くなったことによる。
// 経緯と実測値は game.ts の recomputeActivePhrases を参照。

/** 選択規則。既定は経路方式（曲がってよい）。"line" は実機比較用のオプション。 */
export type SelectionMode = "path" | "line";
export const DEFAULT_SELECTION_MODE: SelectionMode = "path";

// DFSの探索ノード数上限。配置不能なケースで探索が発散するとフレームが止まるため、
// 必ず上限を設ける（計画書5.4・10章）。目的の文字による枝刈りが強く効くため、
// 実測では全6曲・980回の再評価が数秒で完了する。
const STAGE1_NODE_BUDGET = 40000;
const STAGE2_NODE_BUDGET = 4000;
const STAGE2_RESTARTS = 24;

// ==================================================================== 語の正規化

/**
 * 盤面に置かない文字（句読点・括弧・記号類）。
 * 長音符 ー(U+30FC) と 々(U+3005) は語の構成要素なので絶対に除去しない。
 */
const STRIP =
  /[\s　、。，．,.・‥…「」『』（）()［］[\]｛｝{}〈〉《》【】〔〕！!？?"'“”‘’`´＝=＋+＊*＆&％%＃#＠@／/＼\\｜|〜～;；:：♪★☆＜＞<>\-–—_]/g;

/** 全角英数字を半角へ寄せ、英字は大文字に統一する。 */
function widthAndCase(text: string): string {
  return text
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toUpperCase();
}

/** 照合用文字列を作る。空文字が返った語は対象語に含めない（計画書3.1）。 */
export function normalizeWord(text: string): string {
  return widthAndCase(String(text ?? "")).replace(STRIP, "");
}

/** 品詞が記号（pos: "S"）の語は、正規化前に対象外とする（計画書3.1）。 */
export function isSymbolWord(pos: string): boolean {
  return pos === "S";
}

// ============================================================== ダミー文字の抽選

/** 文字 -> 出現数 から作る累積重みテーブル。 */
export interface FreqTable {
  chars: string[];
  cum: number[];
  total: number;
}

export function buildFreqTable(counts: Map<string, number>): FreqTable {
  const chars: string[] = [];
  const cum: number[] = [];
  let total = 0;
  for (const [ch, n] of counts) {
    total += n;
    chars.push(ch);
    cum.push(total);
  }
  return { chars, cum, total };
}

/**
 * 出現頻度に応じた重み付き抽選（計画書3.7）。
 *
 * 歌詞に存在しない文字を混ぜないことで、盤面全体が「その曲の歌詞らしい」
 * 見た目を保ち、かつ紛らわしくなる。1文字語の軽い保証（3.4）は、この抽選が
 * 頻度分布に従うことに依存している（一様抽選に変えると発火率が上がる）。
 */
export function pickWeighted(freq: FreqTable | null, rng: () => number): string {
  if (!freq || freq.total === 0) return "？";
  const x = rng() * freq.total;
  let lo = 0;
  let hi = freq.cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (freq.cum[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return freq.chars[lo];
}

function shuffled<T>(arr: readonly T[], rng: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ========================================================================= 盤面

const EMPTY = null;
type Cell = string | null;

/** 配置保証の対象1件。id は対象語のインスタンスを一意に指す。 */
export interface PlaceTarget {
  id: string;
  /** 照合用文字列（正規化済み）。 */
  text: string;
}

/** 盤面を書き換えたセルの一覧（演出用。計画書5.1）。 */
export interface BoardChanges {
  /** 文字が新しく入ったセル。補充のフェードイン演出を付ける。 */
  written: number[];
  /**
   * 無関係な既存文字を潰したセル（5.2 第2段階）。補充演出に加えてフラッシュを
   * 付け、プレイヤーの探索対象でないセルが変化したことを明示する（4.6）。
   */
  overwritten: number[];
}

function emptyChanges(): BoardChanges {
  return { written: [], overwritten: [] };
}

interface PlaceOneResult {
  /** 1 = 既存を壊さず配置、2 = 上書きあり、0 = 失敗 */
  stage: 0 | 1 | 2;
  changes: BoardChanges;
}

export class Board {
  readonly n: number;
  /** 各セルの文字。null は空。 */
  readonly cells: Cell[];
  /** 各セルの所有者（配置保証中の対象語ID）。ダミー・期限切れは null。 */
  readonly owner: (string | null)[];
  /** 対象語ID -> セル添字の配列（選択順）。 */
  private readonly placed = new Map<string, number[]>();
  private readonly rng: () => number;
  private neighbors: number[][] | null = null;
  private readonly segCache = new Map<number, number[][]>();

  constructor(n: number = GRID_N, rng: () => number = Math.random) {
    this.n = n;
    this.rng = rng;
    this.cells = new Array<Cell>(n * n).fill(EMPTY);
    this.owner = new Array<string | null>(n * n).fill(null);
  }

  reset(): void {
    this.cells.fill(EMPTY);
    this.owner.fill(null);
    this.placed.clear();
  }

  /** 盤面に指定の文字が1つでも存在するか（1文字語の保証で使う）。 */
  hasChar(ch: string): boolean {
    return this.cells.includes(ch);
  }

  /** 対象語が今も経路（または線分）として成立しているか。 */
  isPlaced(id: string, text: string): boolean {
    const cells = this.placed.get(id);
    if (!cells || cells.length !== text.length) return false;
    for (let i = 0; i < cells.length; i++) {
      if (this.cells[cells[i]] !== text[i]) return false;
    }
    return true;
  }

  /**
   * 配置保証の対象から外れた語を解放する。
   * 文字は盤面に残し、以後ダミー扱いにする（計画書5.2）。
   */
  release(id: string): void {
    const cells = this.placed.get(id);
    if (!cells) return;
    for (const idx of cells) {
      if (this.owner[idx] === id) this.owner[idx] = null;
    }
    this.placed.delete(id);
  }

  /**
   * 取得成立・取り逃し確定で、対象語の占めるセルを空にする（5.6 ④）。
   *
   * ここで空いた穴が、次の配置保証（⑤）の第1段階の成功率を支えている。
   * 直後に補充してはならない（5.3。順序を崩すと成功率が65.6%→16.9%に落ちる）。
   */
  clearTarget(id: string): number[] {
    const cells = this.placed.get(id);
    if (!cells) return [];
    const cleared: number[] = [];
    for (const idx of cells) {
      if (this.owner[idx] === id) {
        this.cells[idx] = EMPTY;
        this.owner[idx] = null;
        cleared.push(idx);
      }
    }
    this.placed.delete(id);
    return cleared;
  }

  // ------------------------------------------------------------------ 隣接・線分

  /** 4近傍（上下左右）。斜めは不可（計画書3.5）。 */
  private neighborsOf(idx: number): number[] {
    if (!this.neighbors) {
      const n = this.n;
      const nb: number[][] = [];
      for (let i = 0; i < n * n; i++) {
        const r = (i / n) | 0;
        const c = i % n;
        const ns: number[] = [];
        if (r > 0) ns.push(i - n);
        if (r < n - 1) ns.push(i + n);
        if (c > 0) ns.push(i - 1);
        if (c < n - 1) ns.push(i + 1);
        nb.push(ns);
      }
      this.neighbors = nb;
    }
    return this.neighbors[idx];
  }

  /** 長さ len の線分をすべて列挙する（直線モード専用）。 */
  private segments(len: number): number[][] {
    const cached = this.segCache.get(len);
    if (cached) return cached;
    const n = this.n;
    const out: number[][] = [];
    if (len <= n) {
      for (let r = 0; r < n; r++) {
        for (let c = 0; c + len <= n; c++) {
          const fwd: number[] = [];
          for (let k = 0; k < len; k++) fwd.push(r * n + c + k);
          out.push(fwd, fwd.slice().reverse());
        }
      }
      for (let c = 0; c < n; c++) {
        for (let r = 0; r + len <= n; r++) {
          const fwd: number[] = [];
          for (let k = 0; k < len; k++) fwd.push((r + k) * n + c);
          out.push(fwd, fwd.slice().reverse());
        }
      }
    }
    this.segCache.set(len, out);
    return out;
  }

  // ---------------------------------------------------------------- 経路の探索

  /**
   * 経路方式の配置探索。自己交差しない4近傍の経路を、制約付きDFSで探す。
   *
   * 線分の全列挙は経路では成立しない（長さ5だけで972本、10文字では数十万本規模）
   * ため、目的の文字で枝刈りしながら深さ優先で探す（計画書5.2）。
   */
  private findPath(text: string, id: string): number[] | null {
    const n = this.n;
    const used = new Array<boolean>(n * n).fill(false);
    const path: number[] = [];
    let budget = STAGE1_NODE_BUDGET;

    // 各セルは「空」または「target の同位置の文字と一致」であること、かつ
    // 他の配置保証中の語が所有していないこと（セル共有＝交差配置の禁止。5.2）。
    const ok = (idx: number, i: number): boolean => {
      const c = this.cells[idx];
      if (c === EMPTY) return true;
      if (c !== text[i]) return false;
      const o = this.owner[idx];
      return o === null || o === id;
    };

    const dfs = (i: number): boolean => {
      if (i === text.length) return true;
      if (--budget < 0) return false;
      for (const nx of shuffled(this.neighborsOf(path[path.length - 1]), this.rng)) {
        if (used[nx] || !ok(nx, i)) continue;
        used[nx] = true;
        path.push(nx);
        if (dfs(i + 1)) return true;
        path.pop();
        used[nx] = false;
      }
      return false;
    };

    // 開始セルと隣接セルの探索順はランダム化する（計画書5.2）。
    for (const s of shuffled([...Array(n * n).keys()], this.rng)) {
      if (!ok(s, 0)) continue;
      used[s] = true;
      path.push(s);
      if (dfs(1)) return path.slice();
      path.pop();
      used[s] = false;
      if (budget < 0) break;
    }
    return null;
  }

  /**
   * 第2段階の経路探索。上書きを許すが、他の配置保証中の語が占めるセルは避ける。
   * 厳密な最小化は行わず、ランダム再スタートを重ねて上書き数最小の経路を採る。
   */
  private findPathOverwrite(text: string, id: string): number[] | null {
    const n = this.n;
    let best: number[] | null = null;
    let bestCost = Infinity;

    for (let t = 0; t < STAGE2_RESTARTS && bestCost > 0; t++) {
      const used = new Array<boolean>(n * n).fill(false);
      const path: number[] = [];
      let budget = STAGE2_NODE_BUDGET;

      const ok = (idx: number): boolean => {
        const o = this.owner[idx];
        return o === null || o === id;
      };

      // 空セル・一致セルを優先して辿る（結果的に上書きが減る）。
      const order = (cands: number[], i: number): number[] =>
        shuffled(cands, this.rng)
          .map((idx) => {
            const c = this.cells[idx];
            return { idx, w: c === EMPTY || c === text[i] ? 0 : 1 };
          })
          .sort((a, b) => a.w - b.w)
          .map((s) => s.idx);

      const dfs = (i: number): boolean => {
        if (i === text.length) return true;
        if (--budget < 0) return false;
        for (const nx of order(this.neighborsOf(path[path.length - 1]), i)) {
          if (used[nx] || !ok(nx)) continue;
          used[nx] = true;
          path.push(nx);
          if (dfs(i + 1)) return true;
          path.pop();
          used[nx] = false;
        }
        return false;
      };

      for (const s of shuffled([...Array(n * n).keys()], this.rng)) {
        if (!ok(s)) continue;
        used[s] = true;
        path.push(s);
        if (dfs(1)) break;
        path.pop();
        used[s] = false;
        if (budget < 0) break;
      }

      if (path.length === text.length) {
        const cost = this.overwriteCost(path, text);
        if (cost < bestCost) {
          bestCost = cost;
          best = path.slice();
        }
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- 線分の判定

  /**
   * 第1段階の判定（直線モード）：全セルが「空」または「同じ文字」。
   * 同じ文字であっても、他の配置保証中の語が所有するセルは共有しない。
   */
  private compatible(seg: number[], text: string, id: string): boolean {
    for (let i = 0; i < seg.length; i++) {
      const idx = seg[i];
      const c = this.cells[idx];
      if (c === EMPTY) continue;
      if (c !== text[i]) return false;
      const o = this.owner[idx];
      if (o !== null && o !== id) return false;
    }
    return true;
  }

  private overlapsOther(seg: number[], id: string): boolean {
    for (const idx of seg) {
      const o = this.owner[idx];
      if (o !== null && o !== id) return true;
    }
    return false;
  }

  private overwriteCost(seg: number[], text: string): number {
    let n = 0;
    for (let i = 0; i < seg.length; i++) {
      const c = this.cells[seg[i]];
      if (c !== EMPTY && c !== text[i]) n++;
    }
    return n;
  }

  private write(id: string, seg: number[], text: string): BoardChanges {
    const changes = emptyChanges();
    for (let i = 0; i < seg.length; i++) {
      const idx = seg[i];
      if (this.cells[idx] !== text[i]) {
        if (this.cells[idx] !== EMPTY) changes.overwritten.push(idx);
        else changes.written.push(idx);
        this.cells[idx] = text[i];
      }
      this.owner[idx] = id;
    }
    this.placed.set(id, seg.slice());
    return changes;
  }

  // ---------------------------------------------------------------- 配置の本体

  private placeOne(target: PlaceTarget, mode: SelectionMode): PlaceOneResult {
    return mode === "line" ? this.placeOneLine(target) : this.placeOnePath(target);
  }

  /**
   * 経路方式の配置。第1〜3段階の構造は計画書5.2の疑似コードどおり。
   *
   * なお「既存文字の使い回しを優先する」最適化（配置前にstrictな全一致経路を
   * 探す）は実装しない。直線方式では上書き平均が 0.95 vs 1.02 で有利だったが、
   * 経路方式では 0.96 vs 0.97・盤面無変化 60.2% vs 60.4% と差が消えるため、
   * 実装を1つ減らす判断をしている（計画書5.2・11.1・12.3）。
   */
  private placeOnePath(target: PlaceTarget): PlaceOneResult {
    // 第1段階：既存の文字を壊さずに置ける経路
    const p1 = this.findPath(target.text, target.id);
    if (p1) return { stage: 1, changes: this.write(target.id, p1, target.text) };

    // 第2段階：上書きが避けられない場合
    const p2 = this.findPathOverwrite(target.text, target.id);
    if (p2) return { stage: 2, changes: this.write(target.id, p2, target.text) };

    return { stage: 0, changes: emptyChanges() };
  }

  /**
   * 直線モードの配置（実機比較用のオプション。計画書11.4）。
   *
   * 一列に収まらない6文字以上の語（実測で1.8%）は配置保証の対象外とする。
   * 分割機構は経路方式の採用に伴い全廃したため、直線モードのためだけに
   * 実装し直すことはしない（計画書3.1）。
   */
  private placeOneLine(target: PlaceTarget): PlaceOneResult {
    const segs = shuffled(this.segments(target.text.length), this.rng);
    if (segs.length === 0) return { stage: 0, changes: emptyChanges() };

    for (const seg of segs) {
      if (this.compatible(seg, target.text, target.id)) {
        return { stage: 1, changes: this.write(target.id, seg, target.text) };
      }
    }

    let best: number[] | null = null;
    let bestCost = Infinity;
    for (const seg of segs) {
      if (this.overlapsOther(seg, target.id)) continue;
      const cost = this.overwriteCost(seg, target.text);
      if (cost < bestCost) {
        bestCost = cost;
        best = seg;
        if (cost === 0) break;
      }
    }
    if (best) return { stage: 2, changes: this.write(target.id, best, target.text) };

    return { stage: 0, changes: emptyChanges() };
  }

  /**
   * 配置保証の再評価（計画書3.4のトリガで呼ぶ唯一の入口）。
   *
   * targets は優先度（有効期限）順。1文字語は含めないこと（枠を消費させない。
   * 3.4）。1文字語は ensureSingleChars で別途保証する。
   */
  placeAll(targets: readonly PlaceTarget[], mode: SelectionMode): BoardChanges {
    const changes = emptyChanges();

    // 配置保証の対象から外れた語を解放する（文字は盤面に残し、以後ダミー扱い）
    const ids = new Set(targets.map((t) => t.id));
    for (const id of [...this.placed.keys()]) {
      if (!ids.has(id)) this.release(id);
    }

    const criticalFailed = this.attempt(targets, mode, changes);

    // 第3段階：最優先の語が置けなかった場合のみ、盤面を全再生成して置き直す。
    // 実測では全6曲・980回の再評価で一度も発生しなかったが、保険として残す。
    if (criticalFailed) {
      this.reset();
      const regen = emptyChanges();
      this.attempt(targets, mode, regen);
      // 全再生成では盤面全体が変わるため、個別のセル演出は付けない
      // （全セルにフラッシュが走ると、かえって何が変わったか読めなくなる）。
      return emptyChanges();
    }

    return changes;
  }

  private attempt(
    targets: readonly PlaceTarget[],
    mode: SelectionMode,
    changes: BoardChanges,
  ): boolean {
    let criticalFailed = false;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      // 既に成立済みなら何もしない（探索中の語の文字を動かさないため）
      if (this.isPlaced(t.id, t.text)) continue;
      const r = this.placeOne(t, mode);
      changes.written.push(...r.changes.written);
      changes.overwritten.push(...r.changes.overwritten);
      // 諦めた語も、偶然成立していれば取得できる（計画書3.4）
      if (r.stage === 0 && i === 0) criticalFailed = true;
    }
    return criticalFailed;
  }

  /**
   * 空いているセルをダミー文字で埋める（計画書3.7・5.6 ⑥）。
   *
   * 必ず placeAll の「後」に呼ぶこと。先に埋めると第1段階の成功率が
   * 65.6%→16.9%まで落ち、あらゆる配置が既存文字の上書きに落ちる（5.3）。
   */
  fillEmpty(freq: FreqTable | null): number[] {
    const filled: number[] = [];
    for (let i = 0; i < this.cells.length; i++) {
      if (this.cells[i] === EMPTY) {
        this.cells[i] = pickWeighted(freq, this.rng);
        filled.push(i);
      }
    }
    return filled;
  }

  /**
   * 1文字語の軽い保証（計画書3.4・5.2・5.6 ⑦）。
   *
   * 1文字語は盤面のどのセルにあっても成立するため、PLACE_MAX の枠を割り当てる
   * のは無駄であり、探し甲斐のある2文字以上の語が盤面に載らなくなるという害が
   * ある。そこで枠から外し、「該当文字が盤面に1つも存在しない場合にのみ、
   * ダミーセル1つを差し替える」という軽い保証に格下げしている。
   *
   * 実プレイ相当のシミュレーションでの発火率は20〜25%（12.2-b）。4〜5回に1回は
   * 実際に走るため、省略すれば1文字語の取り逃しが目に見えて増える。
   *
   * **fillEmpty の「後」に呼ぶこと。** 盤面に空セルが残った状態では
   * 「該当文字が盤面に存在しない」の判定ができず、空セルを「文字が無い」と
   * 誤読して不要な差し替えを起こす（5.6 ⑦）。
   *
   * @param singles 有効な未取得の1文字語の照合用文字列（有効期限が早い順）
   * @returns 差し替えたセルの添字
   */
  ensureSingleChars(singles: readonly string[]): number[] {
    const replaced: number[] = [];
    for (const ch of singles) {
      if (replaced.length >= SINGLE_FIX_MAX) break;
      if (this.hasChar(ch)) continue;

      // 差し替え先は配置保証中でないセル（ダミー・期限切れの文字）に限る。
      // 配置保証中のセルを潰せば、その語の配置保証が即座に壊れる。
      const free: number[] = [];
      for (let i = 0; i < this.cells.length; i++) {
        if (this.owner[i] === null && !replaced.includes(i)) free.push(i);
      }
      // 盤面が配置保証で埋まっている異常系。この語は諦める
      // （諦めた語も、偶然盤面にあれば取得できる）。
      if (free.length === 0) break;

      const idx = free[Math.floor(this.rng() * free.length)];
      this.cells[idx] = ch;
      replaced.push(idx);
    }
    return replaced;
  }

  /** 盤面の文字を読み出す（UI描画用）。空セルは空文字列を返す。 */
  charAt(idx: number): string {
    return this.cells[idx] ?? "";
  }

  /** 選択された添字列から、照合用の文字列を組み立てる（計画書3.5）。 */
  textOf(indices: readonly number[]): string {
    let s = "";
    for (const idx of indices) s += this.cells[idx] ?? "";
    return s;
  }
}

/** 4近傍で隣接しているか（選択状態機械が使う。計画書3.5）。 */
export function isAdjacent(a: number, b: number, n: number = GRID_N): boolean {
  const ra = (a / n) | 0;
  const ca = a % n;
  const rb = (b / n) | 0;
  const cb = b % n;
  return Math.abs(ra - rb) + Math.abs(ca - cb) === 1;
}

/** 同じ行または同じ列に並んでいるか（直線モードの方向一貫性の判定に使う）。 */
export function sameDirection(prev: number, from: number, to: number, n: number = GRID_N): boolean {
  const dr1 = ((from / n) | 0) - ((prev / n) | 0);
  const dc1 = (from % n) - (prev % n);
  const dr2 = ((to / n) | 0) - ((from / n) | 0);
  const dc2 = (to % n) - (from % n);
  return dr1 === dr2 && dc1 === dc2;
}
