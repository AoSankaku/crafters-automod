# 同居配置と分散配置

小規模ではMisskeyと同じホストで、Node.js標準SQLite（Bun選択時はBun内蔵SQLite）を使うAutomod 1プロセスを動かせます。追加のDBサーバーは不要です。大規模ではAutomod専用のPostgreSQLに状態を共有し、受信プロセスと複数の処理ワーカーを別ホストへ配置できます。MisskeyのDB・Redisへ直接アクセスする必要はありません。

| 構成 | 設定 | 保存先 | プロセス |
|---|---|---|---|
| 小規模・同居 | `AUTOMOD_BACKEND=sqlite`（既定） | `AUTOMOD_DATA_DIR/automod.sqlite` | `AUTOMOD_ROLE=all`、並列数1 |
| 別ホスト・単体 | 同上 | 専用ホストのSQLite | `all` |
| 大規模・分散 | `AUTOMOD_BACKEND=postgres` | Automod専用PostgreSQL | `ingest` と `worker`、または `all` |

同じMisskeyに接続する全プロセスで、`MISSKEY_URL`、トークンのアカウント、`AUTOMOD_NAMESPACE`、ルール生成物、`AUTOMOD_MODE`、`T2_ROLE_ID`、キュー上限、再試行設定、`MIN_ACTION_INTERVAL_MS`を統一してください。namespaceが異なると重複防止もAPI予算も共有されません。未指定のnamespaceは正規化したURLのSHA-256先頭32文字です。URL変更時も既存namespaceを引き継いでください。

## 小規模: Misskeyとの同居

通常はNode.js 24以上とpnpmを用意します。pnpmの版はこのリポジトリの`packageManager`に従ってください。ビルド・起動・管理CLIにBunは不要です。任意でBun 1.4.4以上も使えます。[ランタイムの選択](../README.md#bunで動かす場合任意)を参照してください。

`.env.example`を`.env`へコピーし、URLとトークンを設定します。

```ini
MISSKEY_URL=http://127.0.0.1:13000
MISSKEY_TOKEN=replace-with-a-moderator-token
AUTOMOD_BACKEND=sqlite
AUTOMOD_ROLE=all
AUTOMOD_MODE=dry-run
WORKER_CONCURRENCY=1
AUTOMOD_DATA_DIR=data
```

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm start
```

[systemdの手順](systemd.md)と[同居用環境ファイル](../deploy/systemd/same-host.env.example)も使用できます。Misskeyと別サービス・専用ユーザーで動かしてください。SQLiteはローカルディスクに置き、NFSや複数ホストで共有せず、1プロセスで使用します。WALとFULL同期で、保存済みの未完了ケースを再起動後に再開します。

コンソールを空けて動かす簡単な方法は[PM2の短い常駐化コマンド](daemon.md)です。`pnpm daemon:start`で起動し、`pnpm daemon:stop`で停止できます。systemd・Docker・前面起動との重複実行を避けてください。

Dockerは既存の`compose.yaml`を使います。

```sh
docker compose up -d --build
```

既定のDockerfileはNode版です。Bun版を選ぶ場合は単体構成の`services.automod.build`、分散構成の`x-automod.build`を次に変更してビルドします。

```yaml
build:
  context: .
  dockerfile: Dockerfile.bun
```

初期値`http://127.0.0.1:13000`は同じホストでの直接実行向けです。コンテナ内の`127.0.0.1`はコンテナ自身です。同じDockerネットワークなら`http://misskey:3000`などのサービス名、ホストなら到達可能な`http://host.docker.internal:13000`やHTTPS URLを使用します。ホストのMisskeyがループバックのみで待つ場合は、host-gatewayから到達できません。ホスト側の公開ポートとコンテナ内の待受ポートは異なる場合があります。`./data:/app/data`を永続化し、コンテナから書き込める所有者・権限にしてください。

## 大規模: PostgreSQLと受信・処理の分離

Node版は`postgres`ドライバーを使い、Bun版は内蔵SQLクライアントを使います。Nodeビルドにはドライバーを同梱し、実行先のRedisや追加のネイティブDBアドオンは不要です。検証にはPostgreSQL 18.6を使用しています。DBはMisskeyのスキーマと分け、Automod専用DB・ユーザーを用意します。別ホスト間ではDB接続のTLSとアクセス制限を設定してください。

DB接続プールはAutomodの各プロセスにつき最大5本です。受信プロセス、worker、管理CLI、監視の分を合計してPostgreSQLの接続枠を確保してください。同じPostgreSQLサーバーにMisskey等も接続する場合、その接続数も`max_connections`を共有します。接続枠不足をworker数だけ増やして解消することはできません。

```ini
MISSKEY_URL=https://misskey.example
MISSKEY_TOKEN=replace-with-a-moderator-token
AUTOMOD_BACKEND=postgres
AUTOMOD_DATABASE_URL=postgresql://automod:replace-password@db.internal:5432/automod
AUTOMOD_NAMESPACE=misskey-production
AUTOMOD_ROLE=ingest
AUTOMOD_MODE=dry-run
MIN_ACTION_INTERVAL_MS=1100
```

処理ホストでは同じ設定を使い、`AUTOMOD_ROLE=worker`、`WORKER_CONCURRENCY=4`などを指定します。各プロセスで`pnpm start`を実行します。複数ワーカーは同じDBからリース付きで取得し、同じユーザーへの同時処理を防ぎます。受信プロセスを複数起動した場合も同じノートIDは1ケースになります。

Dockerの新規分散構成例は`compose.distributed.yaml`です。`.env`に設定した`AUTOMOD_POSTGRES_PASSWORD`にはURL中でも安全な十分長い英数字を使います（例: ランダムな64桁の16進数）。この例はDBをホストのポートへ公開しません。

```sh
docker compose -f compose.distributed.yaml up -d --build --scale worker=2
docker compose -f compose.distributed.yaml logs -f ingest worker
```

`ingest`のヘルスはホストの`127.0.0.1:8787`、workerは各コンテナ内の8787で確認します。workerは固定ホストポートを持たず複数起動できます。別マシンへ増設する場合は、同じPostgreSQLへ接続するworkerを配置してください。Docker例のPostgreSQL 18のボリューム配置は[公式イメージ仕様](https://hub.docker.com/_/postgres)に従っています。Docker実行自体はこの開発環境では未検証です。

## 既存データの移行

旧JSONL形式はSQLite単体起動時に自動取り込みします。完了ケース、監査、人間判断、レビュー・削除ジョブを引き継ぎ、元ファイルは残します。壊れた行や未知のフィールドは黙って捨てず起動を止めます。エラーを修復して再起動すれば、取り込み済みの行は重複しません。

SQLiteからPostgreSQLへ切り替えるときは、次の順序で行います。

旧版のJSONLしかなく`automod.sqlite`がまだ存在しない場合は、先に新バージョンをSQLite構成で一度起動し、自動取り込み後に停止してください。その後、以下の停止移行を行います。

1. 全Automodの受信・処理プロセスを停止する。Misskey本体は停止不要。
2. `AUTOMOD_DATA_DIR`全体をバックアップする。SQLiteのWAL/SHMが残る場合も含める。移行元を再稼働させない。
3. 新しいビルドを作り、移行元ディレクトリと**既存と同じnamespace**を指定する。接続URLを変更する場合は旧URLから生成されたnamespaceを明示する。
4. `AUTOMOD_BACKEND=postgres`と移行先DB URLを設定し、未使用の移行先namespaceに対して`pnpm run migrate`を実行する。
5. 成功後に`pnpm run status`で件数を確認し、受信とworkerを同じ設定で起動する。移行前と同じルール・動作モードで残存ケースを処理する。

```sh
pnpm run build
pnpm run migrate
pnpm run status
```

完了ID、監査、未処理ケース、両ジョブキュー、人間オーバーライド、制裁ジャーナル、APIクールダウンを転送します。`human-overrides.json`も移行元DBへ反映してからコピーします。実行中だったケースは古いリースを捨てて再処理待ちへ戻します。通信・プロセス停止で中断した移行は同じ移行元から再実行できます。件数とダイジェストを検証し、移行完了まで移行先での通常処理を禁止します。使用済みnamespaceへの混在を拒否します。待機期限は絶対時刻で引き継ぐため、移行元・先の時刻をNTP等で同期してください。移行後に旧SQLiteへ単純に戻すと判断履歴が分岐するため、旧プロセスの自動起動も解除してください。

SQLiteのまま別ホストへ移す場合も全プロセスを止め、データディレクトリ全体と同じnamespace・設定を転送します。

## 人間の判断とルール更新

分散構成の人間判断は、全プロセスが使う共有DBへ登録します。ビルド済みCLIを同じ環境設定で実行してください。

```sh
pnpm run override --scope user --id USER_ID --reason "Moderator resolved the case"
pnpm run override --scope case --id NOTE_ID --reason "Human decision"
```

`case`、`note`、`user`に対応します。操作を取り消すコマンドではなく、以後の自動変更を禁止する判断です。SQLite構成では従来の`human-overrides.json`も操作直前に再読込します。PostgreSQL構成ではローカルファイルを共有しないため、必ずCLIで登録してください。Misskey管理画面の操作が自動的にこのDBへ同期される機能はありません。人間が処置する前にオーバーライドを登録し、必要な復元はMisskey側で実施してください。

ルールや`dry-run/enforce`を切り替える際は受信を止め、旧設定のworkerで未完了ケースを処理してから全プロセスを同時に更新します。ポリシーハッシュ・モードが違うケースは誤った制裁を避けるためdeadへ移り、自動再解釈しません。dry-runで受け付けた同じノートIDをenforceで再制裁することもありません。

## 監視と限界

`/health`の`queue`には`pending`、`running`、`dead`、`completed`、`reviewJobs`、`purgeJobs`、`oldestPendingAt`、`apiRequests`、`apiBlockedUntil`を返します。`noteProcessing`はDB保存待ち、受理・重複・拒否・失敗数、`worker`は稼働中・完了・失敗・リース喪失数です。`pnpm run status`でもDBの件数を確認できます。

- `MAX_INBOX_JOBS`はpending/running/dead合計の上限（既定10万）。deadも枠を消費し、黙って消去しません。到達・保存失敗・保存待ちメモリ上限では受信を停止し、監督プロセスに失敗を返します。
- `WORK_MAX_ATTEMPTS`（既定5）で再試行を制限し、指数バックオフ後も失敗するケースはdeadに保存します。DBから消さず人間が監査・判断してください。自動dead再投入はありません。
- APIの最小間隔（既定1100ms）は認証・ユーザー照会・制裁の全呼び出しに適用します。429の`Retry-After`を最大1時間まで共有して待ちます。ワーカーを増やしてもこの予算は増えません。
- 長いAPI待機でユーザー照会結果が古くなった場合は、制裁を送らず再試行へ戻します。照会から変更までの競合時間は残るため、人間が処置する際は先に共有オーバーライドを登録してください。
- HTTP操作をMisskeyのDBと同じトランザクションにはできません。送信結果が不明な制裁は`automation.skipped.uncertain`として監査し、再制裁やT1削除を行わず人間確認へ回します。API送信後の人間操作やリース失効を完全に原子的に遮断するにはMisskey側の条件付き管理APIが必要です。
- 完了IDと監査は保持し続けます。重複防止の保持期間・監査の自動アーカイブは未実装なので、DB容量・バックアップ・監査保持方針を管理してください。ジョブ数制限はDB総バイト数の制限ではありません。
- LLMレビューと過去投稿全削除のワーカーは未接続です。キューは各`MAX_QUEUED_JOBS`まで蓄積します。

永続化の保証はDBへの保存成功後からです。`localTimeline`には再送確認・遡及取得がなく、切断・停止・保存前の障害や上限超過時の投稿、Home/フォロワー限定/ダイレクト投稿は網羅できません。全件保証にはMisskey側の信頼できる永続イベント連携が別途必要です。実Misskeyでの稼働・負荷試験は未実施で、登録ユーザー数による規模の境界もまだ測定していません。
