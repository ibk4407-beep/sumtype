# サモナー特性診断 — セットアップ手順

直近の戦績（サモナーズリフト）から、プレイスタイル・得意/苦手ピック・伸びしろを診断する Web ツールです。
データは **Riot 公式 API** から取得します（日本サーバー JP1 対応）。

## 構成
- `index.html` … 画面（フロント）。1ファイル完結。
- `netlify/functions/analyze.js` … Riot API を中継・集計・診断するサーバー処理。APIキーはここで隠れます。
- `netlify.toml` … Netlify の設定。

---

## デプロイ手順（初めてでもOK）

### 1. Riot の開発者キーを取得（無料・2分）
1. https://developer.riotgames.com/ に Riot アカウントでログイン
2. トップページの「DEVELOPMENT API KEY」をコピー（`RGAPI-xxxx...`）
   - ※この開発用キーは **24時間で失効** します。試作中は失効したら貼り直してください。
   - 公開して常時運用する場合は、同サイトで「Register Product」から本番キーを申請します。

### 2. このフォルダを GitHub に上げる
- GitHub で空のリポジトリを作成 →「Add file > Upload files」で `index.html` / `netlify.toml` / `netlify` フォルダ一式をアップロード。
- （Git に慣れていれば `git init && git add . && git commit && git push` でもOK）

### 3. Netlify でサイトを作る
1. https://app.netlify.com/ にログイン →「Add new site > Import an existing project」
2. GitHub を選び、上で作ったリポジトリを選択
3. ビルド設定はそのまま（`netlify.toml` が自動で読まれます）→ Deploy

### 4. APIキーを環境変数に登録
1. Netlify のサイト画面 →「Site configuration > Environment variables」
2. `Add a variable` で **キー名：`RIOT_API_KEY`**、**値：手順1でコピーしたキー** を登録
3. 「Deploys」→ 最新のデプロイで「Trigger deploy > Deploy site」で再デプロイ

これで完成です。サイトURLを開いて Riot ID を入力すれば診断できます。

---

## ローカルで試したいとき（任意）
Node.js が入っていれば：
```bash
npm install -g netlify-cli
netlify dev
# 別ターミナルは不要。表示されたURL（例 http://localhost:8888）を開く
# 環境変数は「export RIOT_API_KEY=RGAPI-xxxx」または .env ファイルで
```

---

## 仕組みのメモ
- Riot ID（名前#タグ）→ `account-v1` で PUUID → `match-v5` で直近30試合 → 集計。
- サモナーズリフト（通常/ランク/Clash）のみ解析対象。ARAM などは性格判定が歪むため除外。
- 5軸（序盤/後半・キャリー/サポート・安定/リスク・スペシャリスト/ジェネラリスト・マクロ/ファイト）で
  スコア化し、最も尖った軸から暫定タイプを判定。
- **しきい値はJPソロキューのおおよその目安**で仮置きです。ロール別キャリブレーションで精度が上がります。
- summonertype の20タイプは、定義を差し込めば `decideType()` を置き換えるだけで連携できます。
