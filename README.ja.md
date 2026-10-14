# Seanime 用 OpenList プロバイダー（日本語版 README）

[English README](README.md)

OpenList（115 / Aliyun Drive / Baidu / Quark / ローカル …）のディレクトリを
Seanime の動画ソースとして使う **オンラインストリーミングプロバイダー拡張**です。

仕組みの要点:

- Seanime が作品を要求 → この拡張が OpenList のディレクトリを検索して該当フォルダを特定
- フォルダ内の動画ファイルを「エピソード」として列挙
- 再生 URL は `<OpenList>/d/<パス>?sign=…` を返す。OpenList はこれを **HTTP 302** で
  実際のストレージ/CDN リンク（115 CDN 等）へリダイレクトするため、
  Seanime サーバーが中継（プロキシ）になることはありません。

```
Seanime (goja VM)               OpenList                       ストレージ
  search(query)     --POST /api/fs/list-->  ディレクトリ一覧
  findEpisodes(id)  --POST /api/fs/list-->  ファイル → エピソード
  findEpisodeServer --POST /api/fs/get ---> ファイル情報 + sign
        |
        v
  動画 URL = <OpenList>/d/<パス>?sign=…    （Seanime のプレイヤーへ渡される）
        クライアント --GET /d/…--> OpenList --302--> 115 CDN --> プレイヤー
```

## インストール

Seanime の「拡張機能」画面から次の URL をインストールしてください（マニフェストの URL）:

```
https://raw.githubusercontent.com/mushokumunou/seanime-openlist-provider/main/openlist-provider.json
```

ローカルファイルとして使いたい場合は `openlist-provider.json` と
`openlist-provider.ts` を任意のフォルダに置き、マニフェスト内の `payloadURI` を
`.ts` の**絶対パス**に、`isDevelopment` を `true` にしたうえで、
マニフェストだけを `<Seanime データディレクトリ>/extensions/` に配置してください。

対応バージョン: Seanime 3.x（3.10.3 で動作確認済み）。

## 設定項目

| 項目 | 既定値 | 説明 |
| --- | --- | --- |
| OpenList URL | `https://openlist.8w8.xyz` | 末尾スラッシュなし |
| OpenList API token | 空 | OpenList のマイページ → API トークン。`Authorization` ヘッダで送信。ゲストアクセス可なら空で良い |
| Root directory | `/` | 作品フォルダが並んでいるディレクトリ（例 `/115/anime`） |
| Scan depth | `3` | 作品フォルダ内を何階層まで走査するか |
| Min video size (MB) | `5` | サンプル動画などの小さすぎるファイルを除外 |
| Video extensions | `mkv,mp4,avi,…` | これ以外（ass / srt / jpg / torrent / nfo 等）は無視 |
| Expose raw link too | オフ | 生のストレージ/CDN リンクを 2 つ目の動画ソースとして追加 |
| Attach sidecar subtitles | オン | 同じフォルダの `.ass/.ssa/.srt` を字幕トラックとして添付 |
| Match strictness | `30` | 0–100。見つからないときは下げる / 誤マッチするときは上げる |
| Debug logging | オフ | サーバーログに `[openlist-provider] …` を出力 |

## 読み込みルール

- 構成: `<RootDirectory>/<作品フォルダ>/…動画`
- フィルタ: 指定拡張子かつ `Min video size` 以上のみ。`ass/jpg/torrent/nfo/sample` は出ません
- 話数はファイル名から `E01` / `第01話` / `[01]` / ` - 01` / `Episode 01` / 単独数字の順に解析
  （`1080p` 等の解像度・年号は除外、`02v2` は 2 話、同話が複数あれば最大サイズを採用）
- ファイル名は OpenList 上の表記をそのまま保持（全角・半角・CJK・`【】`・記号もそのまま）
- 検索は全角→半角の正規化、リリースタグ（`1080p/BDRip/HEVC/v2/簡繁` 等）除去、
  括弧や約物の無視、シーズン番号の厳密比較、bigram 類似度でマッチング

## 302 にするための OpenList 側設定

- そのストレージの **Web Proxy（プロキシURL使用）をオフ**にする
  （WebDAV ポリシー = 302_redirect）。オンにすると OpenList 自身が中継します。
  `Local` ドライバのように仕様上必ずプロキシになるドライバもあります（異常ではありません）
- 署名（Sign / SignAll）は既定のまま。拡張は `/api/fs/get` が返す `sign` を URL に付与します
- リンクが UA/IP に紐づくドライブでも、OpenList が `/d/` アクセス毎に新しいリンクを取得します

## 動作確認

```bash
# プロバイダー登録（ログイン不要）
curl -s http://<seanime>:43211/api/v1/extensions/list/onlinestream-provider

# 検索
curl -s -X POST http://<seanime>:43211/api/v1/onlinestream/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"Sousou no Frieren","provider":"openlist-provider","dub":false}'

# 再生 URL（AniList media 154587 / 第1話）
curl -s -X POST http://<seanime>:43211/api/v1/onlinestream/episode-source \
  -H 'Content-Type: application/json' \
  -d '{"mediaId":154587,"episodeNumber":1,"provider":"openlist-provider","dubbed":false}'
```

オフラインでのロジック検証（Seanime 不要）:

```bash
OL_BASE=http://127.0.0.1:5244 OL_TOKEN=<token> node dev/harness.mjs
```

Seanime が使うのと同じ esbuild 変換（`loader: ts`, `target: es2018`）を通し、
`new Provider()` でインスタンス化して search / findEpisodes / findEpisodeServer を検証します。

## トラブルシューティング

- ログの `Failed to load user config` は初回のみの警告（設定保存で消えます）
- 結果が出ない: `Root directory`、`Scan depth`、`Match strictness` を確認し、デバッグログを有効に
- ブラウザ再生だけ失敗: クロスオリジン（CORS）と MKV ヘッダ読み取りの制限。OpenList の CORS 許可
  オリジンに Seanime のオリジンを追加するか、mpv / デスクトップアプリを使ってください
- OpenList が 401: API トークンを設定（またはゲストアクセスを有効化）
- 新しいファイルが見えない: OpenList の一覧キャッシュ（既定 30 秒）

## ライセンス

MIT
