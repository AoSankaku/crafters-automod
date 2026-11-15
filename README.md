# Crafters Automod for Misskey

Misskey のローカルタイムラインを監視し、人間が記述した `rules.md` から静的生成したフィルタで T1/T2/T3 に分類する常駐サービスです。人間の管理判断を最優先し、T2/T3 は遅延 LLM 監査用キューへ送ります。ノート受信時の判定に LLM は使いません。

詳細な設計と現在の実装境界は [docs/architecture.md](docs/architecture.md) を参照してください。

小規模ではMisskeyと同じホストで、Bun内蔵SQLiteと1プロセスだけで実行できます。大規模ではAutomod専用PostgreSQLを共有し、受信と複数ワーカーを別ホストへ分離できます。[同居・分散配置と移行手順](docs/deployment.md)に設定例を用意しています。

## 判定モデル

| 区分 | 意味 | 即時処理 | 遅延処理 |
|---|---|---|---|
| T1 | 誰が見ても明白なスパム・迷惑行為 | アカウント凍結、削除ジョブ記録 | 運用監査 |
| T2 | 強い制限を必要とする疑い | 制限用ロール付与 | 利用規約に照らした LLM 監査 |
| T3 | 記録して経過を見る事象 | 監査記録のみ | 利用規約に照らした LLM 監査 |

権限の優先順位は「人間の管理判断 > 現在の Misskey 状態 > 静的ルール > LLM 推奨」です。LLM は T1 を決定できず、不確かな結果は人間レビューへ送る前提です。

```text
rules.md（人間向けの自然言語）
       ↓ この会話で確認・静的生成
rules.generated.json（固定フィルタ、T1/T2/T3）
       ↓ テスト・ビルド・再起動
Automod（LLMなしで即時分類）
       ├─ T1: 凍結 + 過去投稿削除キュー
       ├─ T2: 制限ロール + 遅延監査キュー
       └─ T3: 記録 + 遅延監査キュー
```

`rules.md` は実行時に読み込まれません。編集後は、この会話で「`rules.md` を反映してください」と依頼してください。生成物には元ファイルの SHA-256 が記録され、更新漏れがあるとビルドが失敗します。`rules.generated.json` は手動編集しないでください。

## 現在の実装範囲

静的分類、SQLite/PostgreSQLの永続受信キューと監査、ノートIDによる共有重複防止、リース付きワーカーとユーザー単位排他、T1凍結、T2ロール付与、T2/T3遅延監査ジョブ、人間判断の再確認、共有APIレート制御と429待機、有限回の遅延再試行を実装しています。本文は受信時に分類し、キューには本文を含まない固定の判定結果だけを保存します。

次の2つは安全上、キューへの永続化までで、ワーカーはまだ接続していません。

- LLM 監査: 利用するプロバイダー、モデル、実際の利用規約が未指定です。出力検証器は T1 推奨を拒否します。
- T1 の過去投稿全削除: 公開 API の `users/notes` ではモデレーターでもフォロワー限定・ダイレクト投稿を網羅できません。全削除を保証するには Misskey 本体側の管理 API またはサーバー内ワーカーが必要です。

この Automod が受信する `localTimeline` も、停止中・切断中の投稿を遡らず、Home、フォロワー限定、ダイレクト投稿をサーバー全体から網羅しません。全投稿検査が必要なら Misskey 本体に投稿フックを追加してください。

## Stop Forum Spamによる警戒

Stop Forum Spamの掲載情報を追加の警戒材料にできます。確認済みメールをハッシュ照会し、最近の十分な一致があればT3として観察します。一致だけではロール変更・凍結・削除を行いません。既定は外部送信なしで、`SFS_ENABLED=true`により有効化します。IP照会は別途明示的な設定と追加権限が必要です。キャッシュ・日次予算はSQLite/PostgreSQLの両構成で共有します。[照会範囲・基準・運用設定](docs/stop-forum-spam.md)を参照してください。

## セットアップ

1. Misskey 上に Automod 専用のローカルアカウントを作り、モデレーターに設定します。
2. 管理 API に必要な権限を持つアクセストークンを発行します。少なくともユーザー確認、凍結、ロール付与に対応する権限が必要です。
3. T2 用の制限ロールを Misskey に作成し、そのロール ID を `T2_ROLE_ID` に設定します。
4. `.env.example` を `.env` にコピーし、`MISSKEY_URL` と `MISSKEY_TOKEN` を設定します。
5. `rules.md` に自然な日本語でポリシーを書き、この会話に静的生成を依頼します。
6. 最初は `AUTOMOD_MODE=dry-run` のまま起動します。

ローカルで起動する場合:

```sh
bun run build
bun start
```

Docker で Misskey と一緒に常駐させる場合:

```sh
docker compose up -d --build
docker compose logs -f automod
```

Automod が Docker 内、Misskey がホスト上で動く場合、`.env` の URL はたとえば `http://host.docker.internal:3000` にします。同じ Compose ネットワークに組み込む場合は、Misskey のサービス名に合わせて `http://misskey:3000` のように設定してください。`restart: unless-stopped` により Docker 起動後と異常終了後に再起動します。`./data` はコンテナの `/app/data` に永続化されます。

### systemd で常駐させる場合

Dockerは必須ではありません。Misskeyをsystemdで運用している場合も、Automodを専用ユーザーの独立したsystemdサービスとして起動できます。Misskeyと同じプロセスや実行ユーザーにはせず、`MISSKEY_URL=http://127.0.0.1:3000` などでMisskeyのAPIへ接続します。

同梱unit、環境ファイル、権限、永続データ、起動・更新・監視の手順は [systemd での常駐運用](docs/systemd.md) を参照してください。

## `rules.md` の書き方

専用構文はありません。通常の日本語で次の情報を書いてください。

- T1/T2/T3 のどれか
- 対象: 本文、CW、ユーザー名、添付ファイル名など
- 条件: 含まれる語句、表記揺れ、正規表現相当の条件など
- 除外対象: 管理者、公式 bot、特定ユーザーなど
- 判定理由: 後から人間が監査できる具体的な説明

例:

```markdown
## 有効なルール

- T1: 本文または CW に既知の大量投稿型スパム文言が含まれ、既知の誘導 URL も含む場合。
  trusted_user と official_bot は除外する。理由は複数の確定的指標が一致する宣伝スパム。
- T2: ユーザー名が spam_ で始まり、本文にフォロワー購入の勧誘がある場合。
  理由は強い制限を行い、後で利用規約に照らして監査するため。
- T3: 同一文面の短時間反復を示す語句がある場合。
  理由は自動制限せず傾向を記録するため。
```

重大度が曖昧な場合は静的生成前に確認します。特に指定がなければ、安全側の T3 として生成します。複数ルールが一致した場合は `T1 > T2 > T3` の順で最も強い区分を1回だけ適用します。

## 人間による優先判断

SQLite単体構成では`data/human-overrides.json`を各操作の直前に再読込します。共有DBへ判断を登録するCLIも両構成で利用できます。人間判断があるケースやユーザーは自動処理を中止します。オーバーライドファイルが壊れている場合も安全側に停止します。

```sh
bun run override --scope user --id USER_ID --reason "Moderator resolved the case"
```

分散構成では必ずこのCLIを使い、全プロセスで同じDBとnamespaceを指定します。Misskey管理画面の変更を自動同期する機能は未実装です。

```json
{
  "caseIds": [],
  "noteIds": [],
  "userIds": []
}
```

受信ケース、監査、遅延レビュー・削除ジョブ、完了ID、操作ジャーナル、人間判断、API予算を同じDBへ保存します。既定は`data/automod.sqlite`です。旧JSONLはSQLite初回起動時に取り込み、元ファイルも残します。本文やトークンは保存しません。

`MAX_INBOX_JOBS`（既定10万件）は未完了・処理中・deadの合計上限、`MAX_QUEUED_JOBS`はレビュー・削除キューそれぞれの上限です。`MAX_PENDING_NOTES`（既定1,000件）はDB保存待ちのメモリ上限で、到達や保存失敗時には受信を停止します。保存済みケースは再起動後に再開し、完了IDは重複防止用に保持します。監査・完了IDの自動アーカイブは未実装なので、DB総容量は別途監視してください。

大規模構成の例:

```ini
AUTOMOD_BACKEND=postgres
AUTOMOD_DATABASE_URL=postgresql://automod:replace-password@db.internal:5432/automod
AUTOMOD_NAMESPACE=misskey-production
AUTOMOD_ROLE=worker
WORKER_CONCURRENCY=4
```

同じ設定で`AUTOMOD_ROLE=ingest`の受信プロセスを配置します。新規Docker構成では`docker compose -f compose.distributed.yaml up -d --build --scale worker=2`も使用できます。既存SQLiteからの移行は全Automodを停止して`bun run migrate`で実施します。詳細は[配置ガイド](docs/deployment.md)を参照してください。

## ルールを更新する手順

1. `rules.md` を編集する。
2. この会話で「`rules.md` を反映してください」と依頼する。
3. 生成結果とテスト結果を確認する。
4. `docker compose up -d --build` または `bun run build` 後の再起動で反映する。

静的モデルなので、ファイル保存だけでは稼働中プロセスの挙動は変わりません。これは意図した安全境界です。

## 実行時フィルタ

| 対象 | 内容 |
|---|---|
| `content` | 本文、CW、添付ファイル名・説明、アンケート選択肢 |
| `text` | 本文のみ |
| `cw` | CW のみ |
| `username` | ローカルユーザー名 |
| `filename` | 添付ファイル名・説明 |

判定は大文字小文字を区別しない部分一致、または安全性検査済みの正規表現です。正規表現は500文字までで、バックリファレンス、後読み、代表的なネスト量指定子を拒否します。

## 動作確認と監視

```sh
bun run rules:check
bun test
bun test --coverage
bun run build
```

ヘルスチェック:

```sh
curl http://127.0.0.1:8787/health
```

必要なDB・ワーカー・Streamingが稼働中ならHTTP 200、必要な接続がない場合は503を返します。worker専用ロールはStreaming接続を要求しません。`queue`の待機・実行・dead・完了数、両ジョブ数、最古の待機時刻、API待機期限と、`noteProcessing`のDB保存待ち・拒否・失敗数を監視してください。HTTP 200だけでは処理の追従を保証しません。`bun run status`でもDBの状態を確認できます。

`MIN_ACTION_INTERVAL_MS`（既定1100ms）は認証・照会・制裁の全API呼び出しで共有します。429では全ワーカーに待機を適用します。結果不明の制裁は再送せず`automation.skipped.uncertain`を記録します。実際のMisskeyでの動作・負荷検証は未実施です。

## 安全な導入手順

1. すべての新規ルールを T3 として生成し、`dry-run` で誤検知を確認する。
2. 十分な証拠があるものだけ T2 に変更し、制限ロールの権限を確認する。
3. T1 は複数の確定的指標を要求し、モデレーター保護と人間オーバーライドを試験する。
4. バックアップ、監査ログ、キュー監視を確認してから `enforce` に切り替える。

公式仕様: [Misskey Streaming API](https://misskey-hub.net/en/docs/for-developers/api/streaming/)、[localTimeline チャンネル](https://misskey-hub.net/en/docs/for-developers/api/streaming/channel/local-timeline/)、[権限一覧](https://misskey-hub.net/en/docs/for-developers/api/permission/)
