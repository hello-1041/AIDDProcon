import "./style.css";
import { Player, type IPlayerApp } from "textalive-app-api";

const statusEl = document.querySelector<HTMLParagraphElement>("#status")!;

function setStatus(text: string) {
  statusEl.textContent = text;
  console.log(`[TextAlive] ${text}`);
}

const token = import.meta.env.VITE_TEXTALIVE_TOKEN;

if (!token) {
  setStatus(
    "エラー: VITE_TEXTALIVE_TOKEN が設定されていません。.env を確認してください。",
  );
} else {
  const player = new Player({
    app: { token },
  });

  player.addListener({
    onAppLoad: (_app: IPlayerApp, error?: string) => {
      if (error) {
        setStatus(`TextAlive App API サーバとの接続に失敗しました: ${error}`);
      }
    },
    onAppReady: (app: IPlayerApp) => {
      setStatus(`アプリ準備完了（managed: ${app.managed}）`);
    },
    onVideoReady: () => {
      const song = player.data.song;
      setStatus(`楽曲データ準備完了: ${song.name} / ${song.artist.name}`);
    },
  });
}
