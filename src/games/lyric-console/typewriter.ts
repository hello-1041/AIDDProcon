// 歌詞コンソール（lyric-console）専用のタイプライター共有ロジック。
// ブートシーケンス・歌詞・シャットダウンログの3箇所すべてが、この1つの実装・
// 同一の打鍵速度(TYPE_INTERVAL_MS)を共有する（製造計画書2.2節で値の共有が
// 明記されているため、定数やロジックを複製しない）。
// DOM・TextAlive型に依存しない純粋関数群とし、他コンテンツからも流用しやすくする。

// 40文字/秒 = 25ms/文字。
export const TYPE_INTERVAL_MS = 25;

// 逐次型タイパー（ブート・シャットダウン）における行間の間。実装後に実機で
// 見た目を確認しながら調整する前提の初期値。
export const LINE_GAP_MS = 150;

// 経過msの時点で見えているべき文字数。文字送りは経過msをTYPE_INTERVAL_MSで
// 割った切り捨てで求める（フレーム番号ではなく経過時間そのものを基準にする
// ことで、フレームレートに依存せず一定速度に見える）。
export function computeRevealCount(elapsedMs: number, textLength: number): number {
  if (elapsedMs <= 0) return 0;
  const count = Math.floor(elapsedMs / TYPE_INTERVAL_MS);
  return Math.min(count, textLength);
}

export function isRevealComplete(elapsedMs: number, textLength: number): boolean {
  return computeRevealCount(elapsedMs, textLength) >= textLength;
}

// 固定行配列を順番にタイプする逐次型タイパー。ブートシーケンス・シャットダウン
// ログの両方がこれを使う。歌詞のフレーズ同期（startTime待ち受け・強制確定）は
// songPosition依存のドメインロジックのためgame.ts側に置くが、文字数計算は
// computeRevealCountを共有する。
export interface SequentialTyperState {
  lines: string[];
  lineIndex: number;
  // 現在行（lineIndexが指す行）がタイプ開始してからの経過ms。
  // 行が完了した後は、次の行へ移るまでのLINE_GAP_MS待ちの経過msとしても使う。
  elapsedMs: number;
  finished: boolean;
}

export function createSequentialTyper(lines: string[]): SequentialTyperState {
  return {
    lines,
    lineIndex: 0,
    elapsedMs: 0,
    finished: lines.length === 0,
  };
}

// 現在行のタイプ＋行間の間、合わせて何msで次の行へ進めるか。
function lineSlotDurationMs(line: string): number {
  return line.length * TYPE_INTERVAL_MS + LINE_GAP_MS;
}

export function advanceSequentialTyper(state: SequentialTyperState, dtMs: number): void {
  if (state.finished) return;

  state.elapsedMs += dtMs;

  // 1フレームのdtMsが複数行分を一気に消費するほど大きいケース（タブが長時間
  // バックグラウンドだった場合等）を想定し、追いつくまで行を送り続ける。
  while (!state.finished && state.elapsedMs >= lineSlotDurationMs(state.lines[state.lineIndex])) {
    state.elapsedMs -= lineSlotDurationMs(state.lines[state.lineIndex]);
    state.lineIndex++;
    if (state.lineIndex >= state.lines.length) {
      state.finished = true;
      state.elapsedMs = 0;
    }
  }
}

// 描画用に「確定済み行」と「現在タイプ中の部分文字列」を取り出す。
export function getVisibleLines(state: SequentialTyperState): {
  completed: string[];
  current: string;
} {
  if (state.finished) {
    return { completed: state.lines, current: "" };
  }
  const completed = state.lines.slice(0, state.lineIndex);
  const currentLine = state.lines[state.lineIndex];
  const revealCount = computeRevealCount(state.elapsedMs, currentLine.length);
  return { completed, current: currentLine.slice(0, revealCount) };
}
