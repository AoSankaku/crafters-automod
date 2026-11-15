# 短いコマンドで常駐化する

`pnpm start`は通常の前面起動です。常駐化には同梱のPM2設定と`pnpm daemon:*`を使うと、ターミナルへ操作を戻せます。PM2のグローバルインストールは不要です。Linux・macOS・Windowsで同じ操作を使えます。

## 初回の起動

Node.js 24以上と設定済みの`.env`を用意し、プロジェクトのディレクトリで実行します。

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm daemon:start
```

既に`pnpm start`で起動している場合は、その画面で**Ctrl+C**を押して停止してから実行してください。systemdやDockerとの同時起動も避けます。SQLiteは1プロセスで使います。

## 日常の操作

| 操作 | コマンド |
|---|---|
| バックグラウンド起動 | `pnpm daemon:start` |
| 状態確認 | `pnpm daemon:status` |
| ログを追う | `pnpm daemon:logs` |
| 再起動・`.env`更新の反映 | `pnpm daemon:restart` |
| 停止 | `pnpm daemon:stop` |
| PM2の登録も削除 | `pnpm daemon:remove` |

ログ画面は**Ctrl+C**で閉じてもサービスが動き続けます。`daemon:status`はプロセスの状態、従来の`pnpm run status`はDBのキュー件数を表示します。接続まで含む確認は`curl --fail http://127.0.0.1:8787/health`で行えます。

設定は`ecosystem.config.cjs`にまとめてあります。プロセス名は`crafters-automod`、実行数は1、ソース変更による自動再起動は無効です。異常終了時は10秒間隔で再試行し、30秒未満の終了が10回続いた場合は停止します。ログを確認して修正後に`daemon:restart`を実行してください。停止時は最大30秒、処理とDBの終了を待ちます。

トークンやDB接続情報は`.env`へ保存し、ecosystem設定には書き込みません。

## 更新

新しいソースの取得後に実行します。ルール・動作モード・DB配置を変えるときは、[停止移行の手順](deployment.md)も先に確認してください。

```sh
pnpm daemon:stop
pnpm install --frozen-lockfile
pnpm run build
pnpm daemon:restart
```

## Bunを使う場合

PM2本体にはNode.jsが必要です。Bun 1.4.4以上でビルドした後、起動と再起動だけBun用コマンドを使います。

```sh
bun run build:bun
pnpm daemon:start:bun
```

再起動は`pnpm daemon:restart:bun`です。状態・ログ・停止は共通コマンドを使います。Node版と同じプロセス名なので、選び直す際は先に停止してください。Node.jsを入れずBunだけで常駐させる場合は[systemd手順](systemd.md)を使います。

## OS再起動後にも自動起動する場合

通常のバックグラウンド起動とは別の設定です。Linuxでは既存の[systemd手順](systemd.md)も選べます。どちらか一方で管理してください。

PM2で自動起動を登録する場合は、[PM2公式の手順](https://pm2.keymetrics.io/docs/usage/startup/)に従い、`pnpm exec pm2 startup`が案内するOS固有のコマンドを実行してから`pnpm exec pm2 save`で保存します。`save`は同じユーザーがPM2で管理しているプロセス一覧全体を保存します。Windowsの自動起動登録も公式手順のWindows欄を参照してください。

接続・権限・負荷に関する制限は[README](../README.md)、Linux専用ユーザーや保護設定を含む配置は[systemdガイド](systemd.md)を参照してください。
