/**
 * 半球グリッドの定義と、歌詞の配置アルゴリズム（製造計画書3.1・3.2・6章）。
 *
 * このモジュールはDOM・TextAlive・canvasのいずれにも依存しない純粋関数だけで
 * 構成する。配置は体験の骨格そのもの（1.3(1)）であり、描画や再生と切り離して
 * 単体で検証できる状態を保つ必要があるため（Lyric-Searchのboard.tsと同じ方針）。
 */

// ============================================================ パラメータ（10章）
//
// 「確定」は13章の実測・検算に基づく。「暫定」は実機での調整を前提とするが、
// PREVIEW_MS・RECLAIM_MSだけは下げてはならない（11章。13.2の実測が要求する
// 成立条件であり、演出パラメータではない）。定義はこの1箇所にまとめる（10章）。

export const CELL_DEG = 3; // 確定: セルの角度寸法（方位角・仰角とも共通）
export const AZ_COLS = 120; // 確定: 360 / CELL_DEG
export const EL_MIN = 6; // 確定: 最下行の仰角。水平線ちょうどには置かない
export const EL_MAX = 72; // 確定: 最上行の仰角。天頂は使わない
export const ROWS = 23; // 確定: (EL_MAX - EL_MIN) / CELL_DEG + 1

export const ROW_CHARS_MAX = 20; // 確定: 1行の最大文字数。視野に1行が収まる上限
export const ROW_STEP = 5; // 暫定: フレーズごとに送る行数
export const AZ_SHIFT_DEG = 45; // 暫定: 次フレーズの開始方位のずらし量
export const AZ_SHIFT_CHORUS_DEG = 75; // 暫定: サビ中のずらし量（3.4）

export const PREVIEW_MS = 2000; // 暫定: 予兆の先行時間。下げてはならない（13.2）
export const RECLAIM_MS = 6000; // 暫定: 回収猶予。体験の成立条件（3.3・13.2）
export const STAR_DELAY_MS = 4000; // 暫定: 点灯から星化まで
export const LIGHT_INSET = 0.85; // 暫定: 視野内判定に使う画面領域（中心からの比率）

export const SWIPE_DEG_PER_PX = 0.25; // 暫定: スワイプ感度
export const INERTIA_MS = 250; // 暫定: 慣性の減衰時間。長くしない（酔いの主因）
export const AUTOPILOT_IDLE_MS = 5000; // 暫定: 無操作から自動回転までの待ち
// 暫定: 追尾する目標が無い間（間奏など）の漂流速度（度/秒）。
//
// 当初はこの一定回転だけでオートパイロットを構成していたが、実機で無操作のまま
// 流すとlostがlitの4倍近く出た（TAKEOVER 40秒でlit45対lost173、点灯率15%）。
// 速度を6→12へ倍にしても点灯率は13%で改善しなかった。原因は速度ではなく向きで、
// 一定回転（本定数）と、3.2規則3が左右ランダムに跳ばすフレーズ配置とは原理的に
// 同期しない。逆方向へ跳ばれれば315°回らねば追いつかず、速く回せば通り過ぎる。
// そのため追尾（AUTOPILOT_TRACK_*）を主とし、本定数は目標が無い間だけ使う。
export const AUTOPILOT_DPS = 12;

// 暫定: 追尾時の最大角速度（度/秒）。ずらし量の最大（AZ_SHIFT_CHORUS_DEG×1.3＝
// 97.5°）を、予兆の先行時間PREVIEW_MS（2000ms）のうちに回り切れる値を採る。
export const AUTOPILOT_TRACK_DPS = 60;

// 暫定: 追尾の比例ゲイン（1/秒）。目標までの角度差に比例した速度で寄せ、近づくほど
// 自然に減速させる。等速で寄せて目標で急停止する形は、3.5が避ける酔いの原因になる。
export const AUTOPILOT_TRACK_GAIN = 2.5;

// 暫定: 追尾を打ち切る角度差（度）。これ未満では動かさず、微振動を防ぐ。
export const AUTOPILOT_TRACK_DEADZONE = 0.5;

// 暫定: 追尾時に仰角を内側へ引き込む量（垂直視野半角に対する比）。
//
// 目標の仰角へそのまま寄せると、EL_MAX（72°）付近の行を追ったとき、天頂を空けて
// いる（3.1）ぶんの何も無い領域が画面の過半を占める。最下行でも同様に、水平線より
// 下の暗い領域が入る。そこで追尾の仰角を、視野の上下端が天球の内側に収まる範囲へ
// クランプする。目標は視野の中心からこの比のぶんだけずれるが、点灯判定の領域
// （LIGHT_INSET＝0.85）の内側に留まるため、点灯は妨げない。
export const AUTOPILOT_TRACK_EL_MARGIN = 0.5;

export const H_FOV_NARROW = 60; // 確定: 幅900px未満の水平視野角（4.5・13.4）
export const H_FOV_WIDE = 75; // 確定: 幅900px以上の水平視野角
export const H_FOV_SWITCH_PX = 900; // 確定: 切り替え閾値

/** 画面幅から水平視野角（度）を決める（4.5）。 */
export function horizontalFovDeg(widthPx: number): number {
  return widthPx < H_FOV_SWITCH_PX ? H_FOV_NARROW : H_FOV_WIDE;
}

// ================================================================== セルの座標

/** 行番号（0が最下行）からセル中心の仰角（度）を返す。 */
export function rowToElevationDeg(row: number): number {
  return EL_MIN + row * CELL_DEG;
}

/** 列番号からセル中心の方位角（度、[0,360)）を返す。 */
export function colToAzimuthDeg(col: number): number {
  return col * CELL_DEG;
}

/** 方位角（度）を列番号へ丸める。360°で巡回する。 */
export function azimuthDegToCol(azDeg: number): number {
  const wrapped = ((azDeg % 360) + 360) % 360;
  return Math.round(wrapped / CELL_DEG) % AZ_COLS;
}

/** 列番号を[0, AZ_COLS)へ巡回させる。方位角は360°で閉じているため常に有効。 */
export function wrapCol(col: number): number {
  return ((col % AZ_COLS) + AZ_COLS) % AZ_COLS;
}

// ==================================================================== 入出力の型

/** 配置対象の1文字。startTime/endTimeはTextAliveのIChar由来（ミリ秒）。 */
export interface SphereChar {
  text: string;
  startTime: number;
  endTime: number;
}

/** 配置対象の1フレーズ。chorusはロード時に判定して焼き込む（3.4）。 */
export interface SpherePhrase {
  chars: SphereChar[];
  startTime: number;
  endTime: number;
  chorus: boolean;
}

/** 配置が確定した1文字。rowは0が最下行、colは方位角方向。 */
export interface PlacedChar {
  text: string;
  startTime: number;
  endTime: number;
  row: number;
  col: number;
  /** 何番目のフレーズに属するか。星座は同じフレーズ内だけを結ぶ（3.7）。 */
  phraseIndex: number;
  /** フレーズ内での通し番号。星座線を歌唱順に引くために持つ。 */
  charIndex: number;
}

/** 曲1つ分の配置計画。ロード時に1回だけ算出し、再生中は書き換えない（11章）。 */
export interface Placement {
  chars: PlacedChar[];
  /** フレーズごとの先頭文字の添字。予兆（4.6）と方角インジケータ（4.1）が使う。 */
  phraseHeads: number[];
}

// ================================================================ 文字列の正規化

// 記号・句読点・括弧・空白は配置しない（3.2）。長音符ー(U+30FC)と々(U+3005)は
// 語の構成要素であり、除去しない（前作と同じ規定）。ハイフン・ダッシュ類とは
// コードポイントで区別する必要があるため、除外集合には入れずisPlaceableChar側で
// 先に拾う。
const DROP_CHARS = new Set([
  "、", "。", "，", "．", ",", ".", "!", "?", "！", "？",
  "「", "」", "『", "』", "（", "）", "(", ")", "[", "]",
  "｛", "｝", "{", "}", "・", ":", "：", ";", "；",
  "…", "‥", "-", "‐", "–", "—", "―", "~", "〜",
  "\"", "'", "“", "”", "‘", "’", "`",
]);

/** 1文字が配置対象かどうかを返す（3.2の正規化規定）。 */
export function isPlaceableChar(text: string): boolean {
  if (text.length === 0) return false;
  // 長音符と々は語の構成要素であり、見た目の似たダッシュ類と違って残す。
  if (text === "ー" || text === "々") return true;
  if (/\s/.test(text)) return false;
  return !DROP_CHARS.has(text);
}

// ====================================================================== 擬似乱数
//
// 曲ごとの乱数は固定シード＋曲インデックスとする（6.2）。同じ曲を選び直した
// ときに同じ天球が出る方が、「あの方角にあの歌詞があった」という空間の記憶
// （11章）と整合する。

const BASE_SEED = 0x9e3779b9;

/** mulberry32。外部依存を増やさないための、小さな決定論的乱数。 */
function createRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ================================================================ 配置アルゴリズム

/**
 * 占有マップ。row*AZ_COLS+col で引く。配置済みなら文字の通し番号、空きなら-1。
 *
 * 空き判定だけでなく「誰が占めているか」を持つのは、最終手段である
 * 「その行の最も古い文字を上書きする」（6.2）のため。実測では全6曲で配置失敗
 * 0件（13.3）であり、通常運転では通らない経路である。
 */
function createOccupancy(): Int32Array {
  const occ = new Int32Array(ROWS * AZ_COLS);
  occ.fill(-1);
  return occ;
}

function occIndex(row: number, col: number): number {
  return row * AZ_COLS + col;
}

/**
 * 指定行に、startColから始まるlength個の連続した空きがあるかを調べる。
 * 方位角は360°で巡回するため、列は端をまたいでよい。
 */
function isRunFree(occ: Int32Array, row: number, startCol: number, length: number): boolean {
  for (let i = 0; i < length; i++) {
    if (occ[occIndex(row, wrapCol(startCol + i))] !== -1) return false;
  }
  return true;
}

/**
 * 希望行・希望列から距離順に探索し、length個の連続した空きセルの先頭を返す。
 * 見つからなければnull。
 *
 * 探索は希望位置からの距離順であり、乱択の再試行は行わない（6.2）。行は上下へ
 * 交互に、列は左右へ交互に広げる。
 */
function findRun(
  occ: Int32Array,
  preferredRow: number,
  preferredCol: number,
  length: number,
): { row: number; col: number } | null {
  for (let dRow = 0; dRow < ROWS; dRow++) {
    for (const rowSign of dRow === 0 ? [0] : [1, -1]) {
      const row = preferredRow + rowSign * dRow;
      if (row < 0 || row >= ROWS) continue;

      // 列は半周ぶん見れば全列を覆う（左右へ交互に離れるため）。
      for (let dCol = 0; dCol <= AZ_COLS / 2; dCol++) {
        for (const colSign of dCol === 0 ? [0] : [1, -1]) {
          const col = wrapCol(preferredCol + colSign * dCol);
          if (isRunFree(occ, row, col, length)) return { row, col };
        }
      }
    }
  }
  return null;
}

/**
 * 最終手段（6.2）。その行の最も古い文字（通し番号が最小）の位置を潰して場所を
 * 空ける。文字を捨てる分岐は作らない。
 */
function evictRun(occ: Int32Array, row: number, length: number): { row: number; col: number } {
  let oldestCol = 0;
  let oldestSerial = Number.POSITIVE_INFINITY;
  for (let col = 0; col < AZ_COLS; col++) {
    const serial = occ[occIndex(row, col)];
    if (serial !== -1 && serial < oldestSerial) {
      oldestSerial = serial;
      oldestCol = col;
    }
  }
  for (let i = 0; i < length; i++) {
    occ[occIndex(row, wrapCol(oldestCol + i))] = -1;
  }
  return { row, col: oldestCol };
}

/**
 * 曲1つ分の配置計画を作る（6章）。
 *
 * 呼ぶのはロード時の1回だけであり、再生中は絶対に呼び直さない（11章）。
 * プレイヤーは「あの方角にあの歌詞があった」という空間の記憶で見回すため、
 * 配置が動けばその記憶が無効になり、本作の骨格（1.3(2)）が崩れる。
 */
export function buildPlacement(phrases: SpherePhrase[], songIndex: number): Placement {
  const random = createRandom(BASE_SEED + songIndex * 0x85ebca6b);
  const occ = createOccupancy();
  const chars: PlacedChar[] = [];
  const phraseHeads: number[] = [];

  let cursorAz = random() * 360;
  let rowPref = Math.floor(ROWS / 2);

  phrases.forEach((phrase, phraseIndex) => {
    const placeable = phrase.chars.filter((c) => isPlaceableChar(c.text));
    if (placeable.length === 0) return;

    // ROW_CHARS_MAXごとに折り返す（3.2 規則2）。通常の文章の折り返しと同じ扱い。
    const segs: SphereChar[][] = [];
    for (let i = 0; i < placeable.length; i += ROW_CHARS_MAX) {
      segs.push(placeable.slice(i, i + ROW_CHARS_MAX));
    }

    // 次のフレーズは前のフレーズとは別の方位から始める（3.2 規則3）。これが
    // 「見回す理由」を作る唯一の仕組みであり、ずらし量に±30%の揺らぎを持たせる。
    const baseShift = phrase.chorus ? AZ_SHIFT_CHORUS_DEG : AZ_SHIFT_DEG;
    const shift = baseShift * (0.7 + random() * 0.6);
    const dir = random() < 0.5 ? -1 : 1;
    const targetCol = azimuthDegToCol(cursorAz + dir * shift);

    const headIndex = chars.length;
    let headCol: number | null = null;
    let charIndex = 0;

    segs.forEach((seg, segIndex) => {
      // i番目のsegはrowPref + iの行を希望する（6.2）。折り返しは1つ上の行へ。
      const wantRow = Math.min(rowPref + segIndex, ROWS - 1);
      const found =
        findRun(occ, wantRow, targetCol, seg.length) ?? evictRun(occ, wantRow, seg.length);

      seg.forEach((char, i) => {
        const col = wrapCol(found.col + i);
        occ[occIndex(found.row, col)] = chars.length;
        chars.push({
          text: char.text,
          startTime: char.startTime,
          endTime: char.endTime,
          row: found.row,
          col,
          phraseIndex,
          charIndex: charIndex++,
        });
      });

      if (segIndex === 0) headCol = found.col;
    });

    // カーソルは先頭segの確定方位へ進める（6.2）。希望と確定位置は探索の結果
    // ずれうるため、希望値ではなく確定値を次の基準にする。
    if (headCol !== null) {
      cursorAz = colToAzimuthDeg(headCol);
      phraseHeads.push(headIndex);
    }
    rowPref = (rowPref + ROW_STEP) % ROWS;
  });

  return { chars, phraseHeads };
}
