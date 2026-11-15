# systemd での常駐運用

Automod は Docker に依存していないため、Misskey と同じ Linux ホスト上で独立した systemd サービスとして実行できます。Misskey のプロセスや実行ユーザーには同居させず、専用ユーザー、専用環境ファイル、専用データディレクトリを使用してください。

以下は一般的な Linux 配置例です。既存のディレクトリ構成、Bun の場所、Misskey の待受アドレスに合わせて変更してください。

同じunitをAutomod専用ホストにも配置できます。同居・別ホストの選択、設定サンプル、移行手順、規模に関する制約は [配置ガイド](deployment.md) を参照してください。

## 1. ビルド

Node.js・pnpmとBun 1.3.14以上を用意し、運用ホストまたは同等のビルド環境のソースディレクトリで、インストール・テスト・ビルドを実行します。pnpmの版はこのリポジトリの`packageManager`に従ってください。

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm run build
```

`rules.md` を変更した場合は、この会話で `rules.generated.json` を再生成してからビルドしてください。生成物が古い場合、ビルドは失敗します。

## 2. ユーザーと配置先

```sh
sudo useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin crafters-automod
sudo install -d -o root -g root -m 0755 /opt/crafters-automod
sudo install -d -o root -g root -m 0755 /opt/crafters-automod/dist
sudo install -d -o crafters-automod -g crafters-automod -m 0700 /var/lib/crafters-automod
sudo install -o root -g root -m 0644 dist/index.js /opt/crafters-automod/dist/index.js
sudo install -o root -g root -m 0644 dist/cli.js /opt/crafters-automod/dist/cli.js
sudo install -o root -g root -m 0644 README.md /opt/crafters-automod/README.md
```

既に同名ユーザーが存在する場合、`useradd` は不要です。アプリケーションコードは root 所有の読み取り専用、監査データだけを `crafters-automod` 所有にします。

人間の判断を優先するためのファイルを作成します。

```sh
sudo install -o crafters-automod -g crafters-automod -m 0600 \
  data/human-overrides.json /var/lib/crafters-automod/human-overrides.json
```

## 3. 環境ファイル

`/etc/crafters-automod.env` を root 所有、モード `0600` で作成します。アクセストークンを unit ファイルやリポジトリへ書かないでください。

[同居用サンプル](../deploy/systemd/same-host.env.example)と[別ホスト用サンプル](../deploy/systemd/separate-host.env.example)も利用できます。どちらもトークンなどを実際の値へ変更し、初回は `dry-run` で起動してください。

```ini
MISSKEY_URL=http://127.0.0.1:13000
MISSKEY_TOKEN=replace-with-a-moderator-token
AUTOMOD_MODE=dry-run
AUTOMOD_BACKEND=sqlite
AUTOMOD_ROLE=all
WORKER_CONCURRENCY=1
T2_ROLE_ID=
LLM_REVIEW_DELAY_MS=900000
AUTOMOD_DATA_DIR=/var/lib/crafters-automod
MAX_QUEUED_JOBS=100000
MAX_PENDING_NOTES=1000
HEALTH_HOST=127.0.0.1
HEALTH_PORT=8787
MIN_ACTION_INTERVAL_MS=1100
```

初期値は同居構成向けの`http://127.0.0.1:13000`です。Misskeyが別のアドレスやポートで待ち受けている場合は実際の接続先を指定します。別ホストなら公開HTTPS URLなど、運用ホストからAPIとWebSocketの両方へ到達できるURLを指定してください。初回導入は必ず`AUTOMOD_MODE=dry-run`にします。

```sh
sudo chown root:root /etc/crafters-automod.env
sudo chmod 0600 /etc/crafters-automod.env
```

## 4. unit のインストール

まずBunの絶対パスを確認します。

```sh
command -v bun
```

同梱unitは `/usr/local/bin/bun` を想定しています。結果が異なる場合は、[deploy/systemd/crafters-automod.service](../deploy/systemd/crafters-automod.service) の `ExecStart` を実際の絶対パスに変更します。

ソースディレクトリでの手動操作はpnpmを使います。常駐サービスの配置先にはビルド済みファイルを置き、unitはBunを直接起動します。サービス用ユーザーのPATHへpnpmやNode.jsを追加する必要はありません。Dockerイメージもビルド済みファイルをBunで直接起動します。

```sh
sudo install -o root -g root -m 0644 \
  deploy/systemd/crafters-automod.service /etc/systemd/system/crafters-automod.service
sudo systemctl daemon-reload
sudo systemctl enable --now crafters-automod.service
```

Misskey の systemd unit 名が分かっている場合は、`[Unit]` に次のような起動順序を追加できます。Automod は起動時にMisskeyへ接続できなければ終了し、`Restart=on-failure` により10秒後に再試行します。

```ini
After=network-online.target misskey.service
```

## 5. 状態確認

```sh
sudo systemctl status crafters-automod.service
sudo journalctl -u crafters-automod.service -f
curl --fail http://127.0.0.1:8787/health
```

単体・ingestではDBとStreaming、workerではDBと処理ループが稼働中ならHTTP 200になります。必要な接続の切断は503です。`queue.pending`と最古の待機時刻、`queue.dead`、API待機期限も監視してください。ログはjournaldにJSON Linesで出力されます。

## 6. 更新と停止

更新前に `pnpm install --frozen-lockfile`、`pnpm test`、`pnpm run build` を成功させ、新しい `dist/index.js` を配置してから再起動します。

```sh
sudo install -o root -g root -m 0644 dist/index.js /opt/crafters-automod/dist/index.js
sudo install -o root -g root -m 0644 dist/cli.js /opt/crafters-automod/dist/cli.js
sudo systemctl restart crafters-automod.service
```

停止と自動起動解除:

```sh
sudo systemctl disable --now crafters-automod.service
```

## リソース制限

実測後に必要であれば、`[Service]` に次のような制限を追加できます。

```ini
MemoryMax=256M
CPUQuota=25%
```

キューはDBに保持し、メモリには保存待ちと実行中のケースを制限付きで保持します。制限追加後は`systemctl status`、`journalctl`、`systemd-cgtop`でOOMや再起動ループがないことを確認してください。DB容量とバックアップも監視します。

## 分散構成と管理CLI

PostgreSQL構成は同じunitの環境設定を`ingest`または`worker`へ変更して別ホストで実行できます。同一ホストで複数unitを動かす場合はunit名・環境ファイル・ヘルスポートを分けてください。全プロセスで同じDB、namespace、ルール、動作モード、API間隔を使用します。詳細とSQLiteからの停止移行は[配置ガイド](deployment.md)を参照してください。

管理CLIは`/opt/crafters-automod/dist/cli.js`です。サービスと同じ環境変数を安全に読み込む管理用実行環境から、`bun /opt/crafters-automod/dist/cli.js status`、`override --scope user --id USER_ID --reason REASON`、停止移行時の`migrate`を実行します。systemdの`EnvironmentFile`は通常のシェル構文とは異なるため、そのまま`source`しないでください。トークンやDB URLをコマンド履歴へ直接書かないでください。

## 現在の機能境界

systemd化によって実装範囲が変わることはありません。T1凍結、T2ロール付与、T3記録、監査ログとジョブの永続化は利用できます。一方、LLM監査ワーカーとT1過去投稿削除ワーカーはまだ接続されていません。
