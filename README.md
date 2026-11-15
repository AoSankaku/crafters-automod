# Crafters Automod for Misskey

Misskeyのローカルタイムラインを監視する、サーバー運営者向けのモデレーションサービスです。人間が書いたポリシーを静的なルールへ変換し、投稿をT1/T2/T3に分類します。任意でStop Forum Spam（SFS）のアカウント評判も参照できます。

小規模では**Misskeyと同じホスト・SQLite・1プロセス**で動かせます。大規模では**Automod専用PostgreSQL・受信プロセス・複数ワーカー**に分離できます。MisskeyのDBやRedisへ直接接続する必要はありません。

**初期状態は`dry-run`、本文フィルター0件、SFS照会無効です。** 起動しただけで任意のスパムを検出する学習済みモデルではありません。サーバーの規約と確認済みの事例に基づいてルールを設定してください。

## 実装済みの機能と現在の制限

| 機能 | 状態 |
|---|---|
| 静的ルールによる分類、T1凍結、T2ロール付与、T3記録 | 実装済み。実際の制裁は`enforce`時のみ |
| 永続受信キュー、重複防止、ユーザー単位排他、再試行 | SQLite / PostgreSQLに対応 |
| 人間オーバーライド、操作ジャーナル、監査 | 実装済み |
| 共有APIレート制御、SFSのキャッシュ・日次予算 | 実装済み |
| 遅延LLM監査 | ジョブ保存と出力検証まで。実行ワーカーは未接続 |
| T1の過去投稿全削除 | ジョブ保存まで。Misskey側の検証済み管理API / ワーカーが必要 |

**凍結やロール付与は動作しますが、LLMによる再判定や過去投稿全削除は自動実行されません。** LLMプロバイダーを設定するだけで有効になる実装でもありません。

公開APIの`users/notes`で過去投稿全件の削除を代用する機能はありません。全削除の実行には、フォロワー限定・ダイレクト投稿も扱えるMisskey側の管理APIまたはサーバー内ワーカーを確認して接続する必要があります。

`localTimeline`には停止・切断中の遡及取得がなく、Home・フォロワー限定・ダイレクト投稿を全件網羅しません。永続化はDBへの保存成功後からです。全投稿の確実な検査にはMisskey側の永続イベント連携が別途必要です。

## 判断基準

| 区分 | 選ぶ基準 | `enforce`時の処理 | 遅延処理 |
|---|---|---|---|
| **T1** | 文脈判断がなくても明白な重大スパム・有害行為。人間のポリシーが明確に指定した場合 | ローカルアカウントを凍結し、成功確認後に過去投稿削除ジョブを保存 | 削除ジョブは現在未消費 |
| **T2** | 強い制限が必要とポリシーで指定された条件 | 設定済みの制限用手動ロールを付与。凍結・削除はしない | LLMレビュー用ジョブを保存 |
| **T3** | 不確実な兆候、経過観察、SFSの有効な一致 | 自動制限を行わず記録 | LLMレビュー用ジョブを保存 |

判断が曖昧なら、より影響の小さい区分を選びます。新規ルールは明確な上位指定がなければT3です。複数の本文ルールが一致した場合は`T1 > T2 > T3`の最も強い区分を使い、一致したルールID・理由を記録します。

優先順位は**人間の判断 > 既存のMisskey管理状態 > 静的ルール > LLM推奨**です。管理者・モデレーターを自動制裁しません。LLMはT1を発動できず、SFSの点数もT1/T2へ自動変換しません。

通信断などで制裁の送信結果が不明になった場合は、同じ操作を盲目的に繰り返さず、人間の確認が必要な監査記録を残します。Misskey管理画面の操作との完全な原子性は保証できないため、人間が処置する際は先に[オーバーライド](#人間による優先判断)を登録してください。

## 最短の導入手順：Misskeyと同居

必要なものはBun、接続可能なMisskey、専用のローカルモデレーターアカウントです。外部npm依存はありません。`package.json`とDockerfileはBun 1.3.14を指定し、直近の開発検証はBun 1.4.4で行っています。

### 1. 取得と環境設定

```sh
git clone https://github.com/AoSankaku/crafters-automod.git
cd crafters-automod
cp .env.example .env
```

PowerShellではコピーを次のように実行できます。

```powershell
Copy-Item -LiteralPath .env.example -Destination .env
```

プライベートリポジトリの取得にはGitHubの認証が必要です。`.env`を編集し、まず次の設定を確認してください。

```ini
MISSKEY_URL=http://127.0.0.1:3000
MISSKEY_TOKEN=replace-with-a-moderator-token
AUTOMOD_MODE=dry-run
AUTOMOD_BACKEND=sqlite
AUTOMOD_ROLE=all
WORKER_CONCURRENCY=1
AUTOMOD_DATA_DIR=data
SFS_ENABLED=false
```

`MISSKEY_URL`は実際のAPI・WebSocket両方へ到達できるURLに変更します。同居でもMisskeyがそのアドレスで待ち受けていなければ接続できません。

専用トークンには、ユーザー照会`admin/show-user`、T1を使う場合は`admin/suspend-user`、T2を使う場合は`admin/roles/assign`に必要な権限を用意します。T2の制限内容はMisskey側の手動ロールで設定し、IDを`T2_ROLE_ID`へ指定します。T2を有効なルールとして`enforce`する場合、このIDは必須です。

### 2. ルール設定とビルド

[ルールの設定方法](#ルールの設定方法)に従って`rules.md`と生成物を更新します。本文フィルターをまだ設定しない場合でも接続確認はできますが、SFSも無効なら分類対象はありません。

```sh
bun run build
bun start
```

Bunが作業ディレクトリの`.env`を読み込みます。ビルドは生成ポリシーの整合性を検査し、`dist/index.js`と管理用`dist/cli.js`を作ります。

### 3. 確認してから制裁を有効化

```sh
curl --fail http://127.0.0.1:8787/health
bun run status
```

ログと監査を見て、誤検知がないこと、T2ロールが意図した権限になっていることを確認します。最初はT3・dry-runで観察し、T1/T2は対象と理由を十分に確認してから使ってください。

`enforce`へ切り替える際は、受信を止め、旧モードのworkerで未完了ケースを処理してから、全プロセスの`AUTOMOD_MODE=enforce`をそろえて再起動します。**dry-runで受理済みの同じノートIDを、切り替え後に再制裁することはありません。** 新しいモードは新規に受理する投稿に適用します。

常駐化する場合は[systemd手順](docs/systemd.md)を使えます。Misskeyとは別サービス・専用ユーザーで実行します。

## ルールの設定方法

`rules.md`は人間向けのポリシー、`rules.generated.json`は唯一の実行用ルールです。サービスは実行時に自然言語を解釈せず、LLMへ投稿判定を依頼しません。

```text
rules.md
  → 静的生成・人間による確認
  → rules.generated.json（元ファイルのSHA-256付き）
  → テスト・ビルド・再起動
  → 受信時の固定ルール判定
```

専用の自動コンパイラコマンドはありません。`rules.md`を編集したら、Codex等の開発支援環境へ「rules.mdを反映し、生成物・テスト・ビルドを更新してください」と依頼し、生成結果を確認してください。生成物だけを手で変える運用は避けます。元ファイルとのハッシュ不一致はビルドで検出します。

ポリシーには、区分、対象、条件、除外対象、判定理由を書きます。例えば、最初は次のようなT3ルールから始められます。

```markdown
## 有効なルール

- T3: 本文またはCWに「フォロワー購入」という語句がある場合。
  trusted_user と official_bot は除外する。
  理由は、勧誘の文脈を人間が確認するため。
```

これは記述例で、READMEへ書かれた例は実行ルールにはなりません。文脈が必要な語句を、単独でT1の根拠にしないでください。

| フィールド | 判定対象 |
|---|---|
| `content` | 本文、CW、添付ファイル名・説明、アンケート選択肢 |
| `text` | 本文 |
| `cw` | CW |
| `username` | ローカルユーザー名 |
| `filename` | 添付ファイル名・説明 |

部分一致は大文字小文字を区別しません。同じルールの複数matcherはOR条件です。複数条件の同時成立が必要な場合は、その意図をポリシーと生成結果の両方で確認してください。正規表現は長さ500文字までで、バックリファレンス、後読み、代表的なネスト量指定子を拒否します。

稼働中のルール更新も、受信停止・旧ケース処理・全workerの同時更新を基本とします。ポリシーハッシュやモードが一致しないキューのケースは、別の基準で再解釈せずdeadへ送ります。

## Stop Forum Spamの基準と使い方

外部照会を許可する場合に限り、次を設定します。

```ini
SFS_ENABLED=true
SFS_CHECK_IP=false
```

確認済みメールをtrim・小文字化したMD5で照会します。平文メール、ユーザー名、ノート本文はSFSへ送りません。MD5は匿名化ではなく、Gmailの別名等の正規化を取りこぼす場合もあります。**dry-runでもSFSを有効にすると外部照会は実行します。**

現在の生成ポリシーでは、次の3条件すべてを満たす一致を加点します。

| 条件・得点 | 設定値 |
|---|---|
| 最終報告 | 90日以内 |
| 報告回数 | 3回以上 |
| SFS confidence | 75以上 |
| メール一致 | 40点 |
| IP一致 | 20点 |

有効な一致はT3の観察・レビュー対象です。点数が高くてもSFSだけでT2/T1にはしません。confidenceは本人がスパマーである確率とは扱いません。本文ルールがなくても、受信したローカル投稿のアカウントを確認できます。登録時の全件走査はしません。

IPを使う場合は`SFS_CHECK_IP=true`も必要です。専用の`admin/get-user-ips`が返す最近の公開IPを最大1件、SFSへHTTPS送信します。追加の管理者権限が必要で、共有IP・過去の利用者による誤検知もあり得ます。失敗ログインのIPは使いません。

照会結果は既定6時間再利用し、同じユーザーを投稿ごとに再照会・再レビューしません。SFSのAPI予算はMisskeyと別に全workerで共有し、既定は最小1100ms・UTC日単位5000回です。429/503は共有待機を設定します。障害や予算不足は未確認として記録し、静的判定を継続します。

[外部送信範囲、キャッシュ、日次上限、詳細な設定](docs/stop-forum-spam.md)を確認してから有効化してください。

## 人間による優先判断

人間が処置する前に、同じ環境設定で対象を登録します。

```sh
bun run override --scope user --id USER_ID --reason "Moderator resolved the case"
bun run override --scope case --id NOTE_ID --reason "Human decision"
```

scopeは`user`、`case`、`note`です。case IDはノートIDと同じです。これは以後の自動変更を禁止する判断で、完了した凍結・ロール付与を取り消すコマンドではありません。復元はMisskey側で行います。管理画面の変更を自動的に共有DBへ同期する機能は未実装です。

SQLite単体構成では`data/human-overrides.json`も各操作の直前に再読込します。不正なファイルは安全側に停止します。PostgreSQL構成では共有DBへ登録するCLIを使ってください。

```json
{
  "caseIds": [],
  "noteIds": [],
  "userIds": []
}
```

## 配置を選ぶ

| 構成 | 用途 | 設定 |
|---|---|---|
| SQLite単体 | Misskeyと同居、または専用ホストで1プロセス | `AUTOMOD_BACKEND=sqlite`、`AUTOMOD_ROLE=all`、並列数1 |
| PostgreSQL分散 | 受信と複数workerを分離 | `AUTOMOD_BACKEND=postgres`、共通DB・namespace、`ingest` / `worker` |

SQLiteはローカルディスクに置き、複数ホストやNFSで共有しません。PostgreSQLはMisskeyのDBから分けたAutomod専用DBを使います。全プロセスでルール、モード、トークンのアカウント、namespace、SFS設定、API間隔を統一します。

単体Docker:

```sh
docker compose up -d --build
```

分散Dockerは`.env`へ十分長いランダムな英数字の`AUTOMOD_POSTGRES_PASSWORD`も指定してから実行します。

```sh
docker compose -f compose.distributed.yaml up -d --build --scale worker=2
```

コンテナ内の`127.0.0.1`はコンテナ自身です。Misskeyも同じネットワークなら`http://misskey:3000`等のサービス名、ホストOSなら到達可能な`host.docker.internal`や公開HTTPS URLを使います。ホストのMisskeyがループバックだけで待ち受ける場合、host-gatewayからは接続できません。

単体構成の`./data:/app/data`は永続化が必要です。コンテナ内のBunユーザーに書き込み権限を与え、ヘルスチェック用ポートはホストのループバックへ限定しています。

詳細は[配置・停止移行・分散設定](docs/deployment.md)、[systemd](docs/systemd.md)、[Compose単体](compose.yaml)、[Compose分散](compose.distributed.yaml)を参照してください。

## 日常運用と主な設定

```sh
bun run status
curl --fail http://127.0.0.1:8787/health
```

| 設定 | 既定値・用途 |
|---|---|
| `AUTOMOD_MODE` | `dry-run`。`enforce`でT1/T2の変更を許可 |
| `T2_ROLE_ID` | T2で付与する手動ロールID |
| `AUTOMOD_DATA_DIR` | `data`。単体DBは`automod.sqlite` |
| `MAX_INBOX_JOBS` | 未完了・実行中・deadの合計10万件 |
| `MAX_QUEUED_JOBS` | レビュー・削除キューそれぞれ10万件 |
| `MAX_PENDING_NOTES` | DB保存待ちのメモリ上限1000件 |
| `WORK_MAX_ATTEMPTS` | 最大5回でdeadへ送る |
| `MIN_ACTION_INTERVAL_MS` | Misskey API全体で共有する最小間隔1100ms |
| `LLM_REVIEW_DELAY_MS` | レビュージョブの遅延15分。実行workerは未接続 |

全設定は[.env.example](.env.example)を参照してください。

ヘルスは必要なDB・worker・Streamingが稼働中なら200、接続不足は503です。worker専用ロールはStreamingを要求しません。HTTP 200だけでは処理の追従やSFS照会の成功を保証しません。

特に`queue.pending`、`queue.oldestPendingAt`、`queue.dead`、`reviewJobs` / `purgeJobs`、受信拒否・失敗数、`reputation`の当日予算と待機期限を監視します。結果不明の制裁は監査の`automation.skipped.uncertain`、SFS未確認は`reputation.assessed`の`unavailable`で確認できます。

保存済みの受信ケースは再起動後に再開し、完了IDと操作ジャーナルで重複を防ぎます。キュー上限や保存失敗時は受信を停止します。停止中・保存前の投稿の再取得はありません。deadの自動再投入はせず、人間が監査・判断します。

LLMレビューと削除のキューは現在自動消費されません。監査・完了IDの自動アーカイブも未実装なので、DB容量とバックアップを管理してください。ジョブ件数制限はディスク総バイト数の制限ではありません。

## 更新・バックアップ・移行

ソース更新後は`bun run build`を成功させてから再起動します。ルールやモードを変える場合は、前述の旧ケース処理も先に行います。

SQLiteのバックアップ・ホスト移動・PostgreSQLへの移行は全Automodを停止して行い、`AUTOMOD_DATA_DIR`全体を保存します。残存するWAL/SHMも含め、namespaceを引き継いでください。

PostgreSQLへは移行先の設定を用意し、未使用namespaceへコピーします。

```sh
bun run migrate
bun run status
```

人間判断、監査、未処理ケース、完了ID、両ジョブキュー、操作ジャーナル、SFSキャッシュ、API予算・待機期限を引き継ぎます。中断した移行は同じ移行元で再実行でき、件数・ダイジェストの検証完了まで通常処理を禁止します。[手順と注意点](docs/deployment.md#既存データの移行)を参照してください。

## 開発と検証

```sh
bun test
bun run build
```

通常のテストは外部SFS / 実Misskeyへユーザー情報を送りません。PostgreSQLテストは`AUTOMOD_TEST_DATABASE_URL`を指定した場合だけ実行します。専用の使い捨てテストDBを使ってください。coverageは`bun test --coverage`で確認できます。

実SQLite・PostgreSQLでの重複防止、共有予算、人間優先、障害復旧、移行はテスト済みです。実SFSには架空メールのハッシュで疎通を確認しています。**実Misskeyでの稼働・権限・負荷検証、Docker / systemdでの実配置は未検証です。**

設計は[architecture](docs/architecture.md)、検証記録は[初期実装](docs/testing/misskey-automod.tdd.md)、[永続化](docs/testing/durable-processing.tdd.md)、[SFS](docs/testing/stop-forum-spam.tdd.md)を参照してください。
