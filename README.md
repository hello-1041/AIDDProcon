# AIDDProcon

[TextAlive App API](https://developer.textalive.jp/) を利用した、楽曲同期型ミニゲーム集。
1つのメニュー画面から複数のゲームを選んで遊べる、Webブラウザ向けアプリケーション。

🎮 **Play**: https://hello-1041.github.io/AIDDProcon/

## 収録ゲーム

| ゲーム | 概要 |
|---|---|
| 水切リズム (MizukiRhythm) | 楽曲のビートに合わせてクリックし、石を湖面に跳ねさせて飛距離を競うリズムゲーム |
| ブロック崩し | 歌詞ブロックをボールで崩し、歌詞をすべて集めてクリアを目指すブロック崩し |
| Lyric-Console | 歌詞をターミナル風にタイプライター表示する、鑑賞体験寄りのコンソール演出 |
| Lyric-Search | 歌われている歌詞の語を、5×5の文字盤からなぞって探し出す単語探しゲーム |

## 技術スタック

- [Vite](https://vitejs.dev/) + TypeScript
- [textalive-app-api](https://developer.textalive.jp/)
- GitHub Actions による GitHub Pages への自動デプロイ（`main` ブランチへの push で発火）

## セットアップ

```bash
npm install
```

TextAlive App API のトークンを `.env` に設定する（`.env.example` を参照）。

```bash
cp .env.example .env
# .env を開き、VITE_TEXTALIVE_TOKEN= に取得したトークンを設定する
```

トークンは [TextAlive開発者サイト](https://developer.textalive.jp/) でアプリを登録して取得する。

## 開発

```bash
npm run dev      # 開発サーバー起動
npm run build    # 型チェック + 本番ビルド（dist/ に出力）
npm run preview  # ビルド結果のプレビュー
```

## ディレクトリ構成

```
.
├── docs/                 # 設計ドキュメント
├── src/
│   ├── main.ts           # エントリーポイント。メニュー画面とゲームの切り替えを制御
│   ├── style.css         # 全体共通スタイル
│   └── games/
│       ├── mizuki-rhythm/   # 水切リズム
│       ├── block-kuzushi/   # ブロック崩し
│       ├── lyric-console/   # Lyric-Console
│       └── lyric-search/    # Lyric-Search
├── public/               # 静的ファイル（favicon等）
└── index.html            # 各ゲームの画面（DOM）をすべて内包するシングルページ
```

各ゲームは `game.ts`（ロジック）・`render.ts` または `ui.ts`（描画・DOM操作）・`textalive.ts`（TextAlive連携）・`index.ts`（初期化エントリ）という構成で揃えている。Lyric-Search のみ、盤面の文字配置（対象語が必ず盤面上に存在するよう保証する処理）を `board.ts` に分けている。

## ドキュメント

`docs/` に設計ドキュメントを格納している。
