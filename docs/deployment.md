# 同居配置と別ホスト配置

Automod は Misskey の HTTP API と WebSocket に接続する独立サービスです。小規模では Misskey と同じ Linux ホストで動かし、リソース競合が増えたら Automod 専用ホストへ移せます。Misskey のプロセスへの組み込みや、Misskey のデータベース・Redis・ストレージへの直接アクセスは、現在の機能には必要ありません。

両配置で同じビルド成果物を使います。配置を切り替える専用のモード設定は不要で、接続先は `MISSKEY_URL`、状態の保存先は `AUTOMOD_DATA_DIR` で指定します。`AUTOMOD_MODE` は配置ではなく、`dry-run` / `enforce` の処理動作を選ぶ設定です。

## 配置の選択

| 配置 | 主な用途 | Misskey への接続例 | 現在の実行単位 |
|---|---|---|---|
| 同居 | Misskey とリソースを共有できる小規模運用 | `http://127.0.0.1:3000` | 独立した Automod 1プロセス |
| 別ホスト | Misskey とのCPU・メモリ・ディスクの競合を避ける運用 | `https://misskey.example` | 専用ホスト上の Automod 1プロセス |

登録ユーザー数だけで切替基準は決まりません。投稿頻度、ルール数、API呼び出しの頻度・応答時間、監査データ量を実測して判断してください。検証済みの処理件数上限や必要メモリ量はまだありません。

## 小規模: 同じ Linux ホストに置く

[systemd の運用手順](systemd.md)に従って、専用ユーザー、コード、永続データ、unit を配置します。環境ファイルには [同居用サンプル](../deploy/systemd/same-host.env.example)を使えます。

```sh
sudo install -o root -g root -m 0600 \
  deploy/systemd/same-host.env.example /etc/crafters-automod.env
sudoedit /etc/crafters-automod.env
```

`MISSKEY_URL` を実際の待受URLに、`MISSKEY_TOKEN` を専用アカウントのトークンに変更します。`enforce` で有効なT2ルールを使う場合は `T2_ROLE_ID` も設定します。最初は `dry-run` で接続、分類、監査ログを確認してください。

Misskey と Automod は別ユーザー・別サービスとして実行します。Automod の書き込み先は `/var/lib/crafters-automod` です。CPU・メモリ制限を設定する場合は実測後に調整し、Misskey の応答時間と Automod の待機件数を確認してください。

Misskey がループバックで待ち受けていない場合は、同居でも公開HTTPS URLなどを利用できます。API と WebSocket の両方へ接続できる必要があります。

## リソース分離: 別ホストに置く

Automod 専用ホストに、同じ Bun ランタイム、ビルド成果物、systemd unit を配置します。[別ホスト用サンプル](../deploy/systemd/separate-host.env.example)を環境ファイルとして使用します。

```sh
sudo install -o root -g root -m 0600 \
  deploy/systemd/separate-host.env.example /etc/crafters-automod.env
sudoedit /etc/crafters-automod.env
```

`MISSKEY_URL` を対象Misskeyの実際のHTTPS URLに変更します。専用ホストからAPIとWebSocketへ到達でき、経路上のリバースプロキシがWebSocket接続を通す必要があります。WebSocketの接続方法は [Misskey公式Streaming API仕様](https://misskey-hub.net/en/docs/for-developers/api/streaming/)も参照してください。

接続は Automod 側から開始します。通常の動作のために、MisskeyからAutomodへの受信用APIを公開する必要はありません。ヘルスチェックはサンプルどおり `127.0.0.1:8787` に置き、必要に応じて専用ホスト内の監視エージェントで確認します。

監査ログ、ジョブキュー、人間オーバーライドは専用ホストの `AUTOMOD_DATA_DIR` に保存します。現在のJSONL永続化は単一プロセスを前提としており、複数ホストが同じファイルを共有して処理する構成には対応していません。

## Docker を使う場合

既存の [compose.yaml](../compose.yaml) は、同居・別ホストのどちらにも利用できます。リポジトリ直下の `.env` に接続先を設定し、`./data` を永続化します。上記のsystemd用環境ファイルは絶対パスを含むため、そのままコンテナ用に流用せず [.env.example](../.env.example) を使ってください。

| Misskey の配置 | `MISSKEY_URL` の例・条件 |
|---|---|
| Automodコンテナと同じホストのホストOS上 | `http://host.docker.internal:3000`。ホストゲートウェイから到達できる待受設定が必要 |
| 同じDockerネットワークの別コンテナ | `http://misskey:3000`。サービス名とネットワークを実際の構成に合わせる |
| 別ホスト | `https://misskey.example` |

コンテナ内の `127.0.0.1` は Automod コンテナ自身を指します。ホストのMisskeyがループバックのみで待ち受けている場合、`host.docker.internal` への変更だけでは接続できないことがあります。その場合は到達できる公開HTTPS URLなどを使ってください。

Composeの `./data:/app/data` を使う場合、コンテナ内の `AUTOMOD_DATA_DIR` は既定の `data` または `/app/data` とします。`HEALTH_HOST=0.0.0.0` とすれば、既存のホスト側ループバックへのポート公開設定で監視できます。

## 同居から別ホストへ移す手順

1. 新ホストに同じルールを含むビルド成果物を配置し、unit と環境ファイルを準備する。この時点では自動起動しない。
2. 旧ホストの Automod を停止し、停止完了を確認する。Misskey 自体を停止する必要はない。
3. 旧ホストの `AUTOMOD_DATA_DIR` 全体を新ホストへ安全に転送し、専用ユーザーが読み書きできる所有者・権限にする。監査ログ、キュー、人間オーバーライドを引き継ぐ。
4. 新ホストの接続URLと保存先を確認し、`dry-run` で起動する。ヘルスチェック、監査ログ、キュー件数を確認する。
5. 確認後、必要に応じて `enforce` へ変更して再起動する。旧ホストは自動起動を解除し、同時稼働させない。

現在の受信キューはメモリ上にあり、Streaming は停止・切断中の投稿を再取得しません。この移行は取りこぼしゼロを保証しません。複数インスタンスの同時稼働による無停止移行も、分散重複防止がないため想定していません。

## 大規模運用で追加設計が必要な範囲

別ホスト化はリソース分離として利用できますが、処理能力を複数台へ分散する機能はまだありません。現在は次の制約があります。

- ノート処理は直列で、処理中を含む既定1,000件を超えた受信ノートは拒否され、自動再取得されません。
- 監査ログとジョブキューはローカルJSONLです。監査ログのローテーション・保持期間管理と、完了ケース索引のメモリ削減は未実装です。
- 各永続キューは既定10万ジョブで上限に達します。LLM監査・過去投稿削除ワーカーは未接続で、自動消費されません。
- リアルタイムAPI操作には自前のレート制御と自動再試行スケジューラがありません。`MIN_ACTION_INTERVAL_MS` は現在のリアルタイム処理には適用されません。
- `localTimeline` に届かない公開範囲や停止・切断中の投稿は検査できません。

処理待ち `noteProcessing.pending` の継続的な増加、`rejected` の増加、API失敗の監査記録を確認してください。`failed` は処理中に外へ伝播した例外の件数であり、すべてのAPI操作失敗を網羅するものではありません。HTTP 200はStreaming接続中であることを示し、処理の追従や監査ワーカーの動作まで保証しません。

単一プロセスで追従できない規模には、再開可能な永続受信キュー、共有状態と分散重複防止、ユーザー単位の操作直列化、全体で共有するAPIレート制御、保持期間管理が必要です。全投稿を検査する場合は、Misskey側に信頼できる投稿イベント連携も追加する設計になります。

同居・別ホストとも、実際のMisskeyサーバーでの稼働・負荷検証はまだ行っていません。配置方法だけで、未接続のLLM監査や過去投稿全削除が有効になることはありません。
