# discuss-maronn-openid-connect-apps

[maronn-openid-connect](https://github.com/maronnjapan/maronn-openid-connect) に追加したい機能の実装計画書を、Claude Code に作らせるための 2 つのアプリです。
どちらも Cloudflare Workers で動き、pnpm のワークスペースで管理しています。

| アプリ | ディレクトリ | 役割 |
| --- | --- | --- |
| **IdP** | `apps/idp` | ユーザーがログインする OpenID Provider。maronn-openid-connect の CLI で生成したコードに、D1 への保存と日本語の画面を足したもの |
| **planner** | `apps/planner` | IdP でログインしたユーザーが使う、実装計画書づくりのアプリ。依頼を Claude Code のルーチンに送り、返ってきた計画書や質問を Markdown として表示する。計画書の編集とコメント、URL による共有、生成 AI に渡す実装用プロンプトへの整形もできる |

planner が依頼を送る先は、claude.ai/code/routines に保存した Claude Code の設定（以下 **ルーチン**）です。
ルーチンは maronn-openid-connect のリポジトリをクラウドのセッションで読み、計画書か質問を planner に送り返します。
ルーチンは専用の **実行環境**（Cloud environment）で動きます。実行環境は通信できるドメインと、planner へのリクエストに Bearer トークンを付ける network secret（種類は Bearer）を持ちます。

## 処理の流れ

```mermaid
sequenceDiagram
  actor User as ユーザー
  participant Planner as planner
  participant IdP
  participant API as Routines API
  participant CC as Claude Code（ルーチンのセッション）
  participant Proxy as エージェントのプロキシ

  User->>Planner: 計画一覧を開く
  Planner->>IdP: 認可リクエスト（PKCE、state、nonce）
  User->>IdP: ログインと同意
  IdP->>Planner: 認可コード → トークン、UserInfo
  User->>Planner: 作りたい機能を送る
  Planner->>API: POST /fire（依頼の JSON：run_id、run トークン、会話）
  API-->>Planner: セッションの URL
  API->>CC: セッションを開始
  CC->>CC: 依頼の形を確かめる
  CC->>Proxy: GET /api/routine/ping（Authorization は付けない）
  Proxy->>Planner: network secret の Bearer トークンを Authorization に付けて転送
  Planner-->>CC: 200（トークンが届いている）
  CC->>CC: リポジトリと仕様を読み、計画書か質問を書く
  CC->>Proxy: POST /api/routine/runs/{run_id}/messages（run トークン、計画書か質問）
  Proxy->>Planner: Authorization: Bearer を付けて転送
  Planner-->>User: Markdown で表示（質問なら回答フォーム）
```

Routines API の `/fire` はセッションを作るだけで、結果を待たずに応答します。
そのため結果は、Claude Code が planner の受け口に POST して返します。
受け口は 2 つの資格情報を求めます。
1 つは、実行環境の network secret に入れた **Bearer トークン** で、結果がルーチンの実行環境から来たことを示します。
もう 1 つは、planner が依頼ごとに発行して依頼に含めた **run トークン** で、結果がどの依頼への応答かを示します。
Bearer トークンは、エージェントのプロキシが VM の外で planner へのリクエストに付けます。
そのため、トークンはルーチンの Claude からは見えません。planner はトークンの SHA-256 だけを持ちます。
ルーチンは IdP を使わず、planner の受け口を直接呼びます。

質問が返ってきた場合、ユーザーが回答すると、planner は会話を含めてルーチンを起動し直します。
やり取りが何往復続いても、依頼に入れる計画書は最新版の 1 版だけです（次の節）。

## 計画書の版と、ルーチンに渡す内容

計画書は、Claude Code が返すたび、また人が編集するたびに新しい版（v1、v2…）として残ります。
ルーチンを起動し直すとき、過去の版をすべて渡すと、同じ計画書が何度もコンテキストに入って無駄に増えます。
そこで依頼の JSON（version 3）には、計画書の本文を最新版の 1 版だけ入れ、過去の版は変更の経緯だけを入れます。

| 入れるもの | 中身 |
| --- | --- |
| `current_plan` | 最新版の全文。人が編集した版なら `edited_by_user` が true で、`user_changes` に Claude Code が最後に返した版からの変更（変わった節と unified diff）が入る |
| 会話の中の計画書 | 本文を省き（`body_omitted`）、版の番号、変更点（Claude Code の要約か、編集した人のメモ）、前の版から変わった節だけを入れる |
| `comments` | 計画書に付いた未解決のコメント（版、節、コメントした場所の行とそのブロックの冒頭、引用、本文、書いた人） |
| 会話のほかの発言 | 依頼、回答、質問、エラーは本文ごと入れる |

古い版の本文は、ユーザーが古い版に触れたとき（「v1 の案に戻して」など）だけ、ルーチンが `GET /api/routine/runs/{run_id}/plans/{版}` で 1 版ずつ取得します。
保存プロンプトは、複数の版をまとめて取得しないよう指示しています。
依頼が 65,536 文字に収まらないときは、差分、途中の発言、コメント、最新版の本文の順に省き、ルーチンは省いたものを `GET .../context`（計画書は最新版だけを含む）か `GET .../plans/{版}` で取得します。

## 計画書の編集とコメント

計画書の作成者は、最新版を Markdown のまま編集し、新しい版として保存できます。
保存した版が最新版になり、次にルーチンを起動したときは、この版と、作成者が変えた箇所の差分を元に作業します。保存プロンプトは、人が書き換えた箇所を元に戻さないよう指示しています。
編集している間に計画書が更新された場合（Claude Code の新しい版、別の編集）や、Claude Code が作業中の場合は保存しません。
各版は前の版との差分（変わった節と行ごとの差分）を画面で確かめられます。古い版は折りたたんで表示します。

最新版には、その場所でコメントを付けられます。

| 書き方 | 操作 | コメントを書く欄 |
| --- | --- | --- |
| 見出し、段落、リストの項目、表、コードブロックへ | ブロックにポインタを合わせると右端に出るボタンを押す（タッチ操作では、ブロックをタップすると出る） | そのブロックのすぐ下に開く |
| 選んだ文章へ | 本文の一部を選ぶと出る「この部分にコメント」を押す | 選択の終わりがあるブロックの下に、選んだ文章を引用して開く |
| 計画書全体へ | 計画書の末尾の「計画書全体にコメントする」から書く | 末尾。見出しを選ぶと、その見出しへのコメントになる（ポインタやスクリプトを使わない書き方） |

コメントは、付けたブロックのすぐ下に表示します（リストの項目なら、その項目の文の下、入れ子のリストの前）。
引用した文章は本文の中で色を付けて示し、解決したコメントは「解決済みのコメント」に折りたたみます。
古い版のコメントも、その版の本文の中の同じ場所に残ります。

コメントは、付けた版の Markdown でブロックが始まる行（`comments.anchor_line`）で場所を持ちます。版の本文は変わらないので、行で場所が決まります。
planner はコメントを受け取るときに、その行が最新版のブロックの始まりであることを確かめ、節（そのブロックの上の `##` の見出し）もそこから決めます。
場所を持たない以前のコメント（節と引用だけを持つ）は、その節の見出しの下に表示します。
Claude Code の作業中に書きかけのコメントがあると、結果が届いてもページを自動で読み込み直さず、知らせだけを出します。

未解決のコメントは、次にルーチンを起動するときに計画書と一緒に渡ります。メッセージを空にして送ると、コメントの反映だけを頼めます。
ブロックへのコメントには、その行（`line`）とブロックの Markdown の冒頭（`excerpt`）を付けるので、ルーチンはコメントした版の本文を読まなくても場所が分かります。
Claude Code は計画書を返すたびに、コメントごとに反映したか（`resolved`）とその説明（`reply`）を返し、planner は反映したコメントを解決済みにします。人もコメントを解決にしたり、未解決に戻したりできます。

## 共有リンク

スレッドの作成者は、共有リンク（`/s/<トークン>`）を作れます。
URL を知っている人は、ログインせずにそのスレッドだけを閲覧し、メッセージの投稿（ルーチンの起動）、コメント、実装用プロンプトの依頼ができます。計画書の編集、コメントの削除、共有の管理、スレッドの削除は作成者だけができます。
ログインしていない人は、投稿に表示名を付けられます（ブラウザに覚える）。名前には「（ゲスト）」が付き、ログインしたユーザーと区別します。

| 項目 | 内容 |
| --- | --- |
| トークン | 256 ビットの乱数。作成者があとから何度でも URL をコピーできるよう、D1 にそのまま持つ |
| 無効化 | 「URL を作り直す」で以前の URL を無効にする。「共有をやめる」で共有リンクをなくす |
| 起動の上限 | 共有リンクからの投稿で起動したルーチンも、作成者の 1 時間あたりの上限（`RUNS_PER_HOUR_LIMIT`）に数える。1 スレッドで同時に動く run は 1 つまで。発言と run は、この 2 つを条件にした 1 回の書き込みで作るので、同時に何件送っても条件を超えない（D1 の部分 UNIQUE インデックスでも念押しする） |
| コメントの上限 | 1 スレッドに 1 時間あたり 60 件（同じく書き込みの条件で確かめる） |
| 応答 | `Cache-Control: no-store` と `X-Robots-Tag: noindex, nofollow` を付ける。ルーチンのセッションへのリンクは作成者にだけ出す |

## 実装用プロンプト

計画書が固まったら、「実装用プロンプトを作る」で、Claude Code などの生成 AI にそのまま渡せる実装の指示に整形できます。
整形はルーチン（Claude Code）が行います。task が `implementation_prompt` の依頼として同じルーチンを起動するので、ルーチンも API トリガーも実行環境も追加しません。
整形の指示（渡す相手の AI、言語、粒度など）を添えられます。指示が無ければ、Claude Code に渡す前提で日本語で書きます。

保存プロンプトが指示する実装用プロンプトの見出しは次のとおりです。計画書の内容は変えず、計画書の変更前・変更後のコードとシーケンス図はそのまま残します。

| 見出し | 内容 |
| --- | --- |
| `# <機能名>を実装する` | |
| 目的 | 何を、なぜ実装するか |
| 前提 | リポジトリ、最初に読む README の節、守るルール |
| 仕様の要件 | 仕様の節番号と MUST、SHOULD、MAY の別 |
| 変更の内容 | ファイルごとの変更前・変更後のコードと理由 |
| 作業手順 | 計画書の機能（F-n）ごとに、先に書くテストケースと実装を並べたタスクリストと、各段階の確認 |
| 完了の条件 | 通すべきテスト、型チェック、ドキュメント |
| やらないこと | 範囲外の変更、秘密情報や外部への送信 |
| 判断に迷ったとき | 未決事項、未解決のコメント、計画書と今のコードの食い違い |

できたプロンプトは「プロンプトをコピー」か `.md` で取り出します。計画書がその後で更新されると、どの版から作ったものかを表示します。

## 計画書の形式

計画書は GitHub Flavored Markdown で返り、planner は CommonMark に従って表示します。
ルーチンに保存するプロンプトが、次の見出しをこの順で書くよう指示しています。

| 見出し | 内容 |
| --- | --- |
| 概要 | 何を、なぜ実装するか |
| ユースケース | 実装によって生まれる利用場面。ID（UC-1…）、利用者、場面、操作、結果の表。成功する場面も失敗する場面もそれぞれ ID を分け、すべてを 1 つずつ Mermaid のシーケンス図で示す（失敗の場面は、どこで何を検証して失敗し、どの応答を返すかまで） |
| 関連する仕様 | RFC や OpenID の仕様の節番号と要件（MUST、SHOULD、MAY の別） |
| 現状の実装 | 関係するファイルと関数、今の挙動、足りない点 |
| 実装方針 | 設計の判断と理由、採らなかった案。変更する箇所ごとに、リポジトリから引用した今のコード、変更後のコード、何がどう変わるかを並べる |
| 仕様から外れる独自実装 | 仕様に定めがない部分の独自の決定、MAY の選択、仕様と異なる振る舞い。項目、仕様の扱い、根拠の節、振る舞い、理由、相互運用への影響の表。MUST を満たさない箇所は必ずここに書く |
| 変更するファイル | パス、変更の種類、内容 |
| 実装ステップ | テストを先に書く順序のタスクリスト |
| テスト計画 | 「ユースケースの整理」「ユースケースを満たす機能」「機能ごとのテストケース」の順に書く。ユースケース（UC-n）を満たす機能を F-1、F-2… と列挙し、機能ごとに単体テスト、conformance テスト、E2E のテストケース（失敗の場面を含む）を、確かめるユースケースと独自実装とともに示す |
| CLI・samples・ドキュメントへの影響 | 生成コードのテンプレート、changeset、README |
| リスクと対策、未決事項 | |

## ディレクトリ

```txt
apps/
  idp/
    src/oidc-provider/      CLI の生成コード（db/instance.ts だけは手で書くファイル）
    src/index.ts            設定、署名鍵、クライアント登録、画面の差し込み
    src/views.tsx           ログイン、同意、ログアウトの日本語画面
    scripts/users.ts        ユーザーの追加、一覧、削除
  planner/
    src/auth/               OIDC のログイン、セッション、ルーチンの Bearer トークンの検証
    src/routine/            /fire の呼び出し、依頼の JSON、返却の検証、ルーチンのプロンプトと実行環境の設定値
    src/routes/thread.tsx   スレッドの画面と操作（作成者の /plans/{id} と、共有リンクの /s/{token}）
    src/plan-diff.ts        計画書の版どうしの比較（変わった節、行ごとの差分）
    src/markdown.ts         Markdown の表示（markdown-it）。計画書のブロックに行の番号とコメントの差し込み位置を付ける
    public/assets/app.js    ブラウザの動作（図、コードの色付け、その場所でのコメント、作業中の待機）
    migrations/             D1 のテーブル
    scripts/mock-routine.mjs  ローカル用のルーチンの代役
scripts/
  setup-local.mjs  ローカル開発の準備
  dev.mjs          3 つのサーバーの起動
  e2e.mjs          ブラウザ操作を再現する通しテスト
  deploy.mjs       Cloudflare へのデプロイ
  routine-guide.mjs  デプロイ時に表示する、ルーチンと実行環境の設定手順
  destroy.mjs      Cloudflare のリソースの削除
```

## ローカルで動かす

Node.js 22.18 以上と pnpm を使います。

```bash
pnpm install
pnpm setup:local
pnpm dev
```

`pnpm setup:local` は、署名鍵、planner のクライアントシークレット、ルーチンの Bearer トークンを生成して両アプリの `.dev.vars` に書き（planner にはトークンのハッシュだけ）、planner のローカル D1 にマイグレーションを適用します。
`pnpm dev` は IdP（`http://localhost:8787`）、planner（`http://localhost:8788`）、ルーチンの代役（`http://localhost:8790`）を順に起動します。

ブラウザで `http://localhost:8788` を開き、開発用ユーザー `testuser`（パスワード `password`）でログインします。
開発用ユーザーは `.dev.vars` の `REGISTER_DEVELOPMENT_USERS=1` によって登録され、デプロイ先には登録されません。

ローカルでは本物のルーチンを使えません。
Claude Code の結果は planner の URL に送られるので、その URL がインターネットから届く必要があるためです。
代わりに `apps/planner/scripts/mock-routine.mjs` が、保存プロンプトの手順どおりに動きます。
`/fire` と同じ形で依頼を受け、依頼の JSON（version 3 と 2）を確かめ、ping でトークンが届くことを確かめてから、run トークンを付けて質問と計画書を返します。2 回目以降は、最新版（人が編集した版を含む）を元にした次の版を、変更点とコメントへの返答を付けて返し、実装用プロンプトの依頼には実装用プロンプトを返します。
Bearer トークンは、代役の中のエージェントのプロキシ役が付けます。network secret の代わりに `apps/planner/.dev.vars.mock-routine` のトークンを、planner へのリクエストにだけ付けます。
テキストなしで起動すると、本物のルーチンと同じく設定の確認（ping）だけを行います。
環境変数 `MOCK_ROUTINE_MODE` に `plan`、`error`、`silent` を指定すると、計画書を直接返す、エラーを返す、何も返さない、の各動作を試せます。

## デプロイ

```bash
pnpm run deploy
```

`pnpm deploy` は pnpm 組み込みの別のコマンドなので、`run` を付けます。
スクリプトは次の順に進み、何度実行しても既存のものを再利用します。

1. wrangler のログインを確認する（未ログインなら `wrangler login` を起動する）
2. Worker 名と公開 URL を決める（workers.dev のサブドメインは Cloudflare API から取得する）
3. 実行環境とルーチンの設定手順を表示し、API トリガーの URL とトークン、network secret の Bearer トークンの入力を受け付ける。2 回目以降も入力を受け付け、空のまま Enter を押した値は登録済みのものを使う。claude.ai 側の値が前回から変わったときは、直す手順だけを表示する（次の節を参照）
4. D1 データベースを 2 つ（`maronn-idp`、`maronn-planner`）作成または再利用する
5. 各アプリの `wrangler.deploy.jsonc` を書き出す（実際の database_id、URL、planner から IdP へのサービスバインディング）
6. Secret を用意する（IdP の署名鍵、planner のクライアント登録、ルーチンの URL とトークン、Bearer トークンのハッシュ）
7. IdP のテーブルを作成し、planner のマイグレーションを適用する
8. Secret と一緒に IdP と planner をデプロイする。以前の構成（client credentials）のルーチン用クライアントが IdP に残っていれば、その Secret（`OIDC_SERVICE_CLIENTS_JSON`）と D1 の登録を削除する
9. IdP にユーザーがいなければ、最初のユーザーを作成する
10. 公開された Discovery と planner の応答を確認する

| オプション | 内容 |
| --- | --- |
| `--yes` | 確認せずに進める。入力は環境変数と前回の値から取る |
| `--dry-run` | Cloudflare を変更せず、両アプリのバンドルだけを確認する |
| `--routine` | 登録済みでも、ルーチンと実行環境の設定手順をすべて表示してから入力を受け付ける |
| `--rotate-client-secret` | planner のクライアントシークレットを発行し直す |
| `--rotate-signing-key` | IdP の署名鍵を作り直す（発行済みのトークンは検証できなくなる） |
| `--idp-origin`、`--planner-origin` | workers.dev の代わりにカスタムドメインを使う |
| `--allowed-subs a,b` | planner を使えるユーザーを IdP のユーザー ID で絞る |
| `--skip-user` | 最初のユーザーの作成を省く |

非対話で実行するときは、`ROUTINE_FIRE_URL`、`ROUTINE_TOKEN`、`ROUTINE_BEARER_TOKEN`、`ADMIN_USER_ID`、`ADMIN_USER_NAME`、`ADMIN_USER_EMAIL`、`ADMIN_USER_PASSWORD` を環境変数で渡せます。
ルーチンの 3 つの値は、渡したものだけを登録し直し、渡さなかったものは登録済みの値を使います（未登録なら何も作らずに止まる）。
解決したアカウント、Worker 名、URL、Bearer トークンのハッシュ、claude.ai に設定した値の指紋（`routineSetup`）は `.deploy/state.json` に、各アプリの実際のリソース ID は `wrangler.deploy.jsonc` に保存されます（どちらも gitignore 済み）。

## ルーチンと実行環境の設定

デプロイスクリプトは、Cloudflare に何かを作る前に、次の手順と値を表示します。
実行環境の Network access と network secret、API トリガーのトークンは claude.ai の画面でしか設定できない（API と CLI が無い）ため、自動化せずに手で設定します。

1. ルーチン専用の実行環境を作る。Network access を Custom にし、表示された許可ドメインを入れ、「Also include default list of common package managers」を有効にする
2. 同じ実行環境の Network secrets で Add secret を選び、planner へ送る Bearer トークンを追加する（下の表）
3. ルーチンを開き、リポジトリ `maronnjapan/maronn-openid-connect`、モデル Opus、手順 1 の実行環境を選び、表示されたプロンプトを保存する。コネクタはすべて外す（ルーチンを作ると、接続済みのコネクタが自動で付くため）
4. トリガーに API を追加し、表示された URL とトークンを控えて、手順 2 の Bearer トークンと一緒にスクリプトに入力する
5. デプロイ後、ルーチンの詳細ページで「Run now」をテキストなしで実行する。ルーチンは `/api/routine/ping` を呼んで結果を報告するので、セッションに HTTP 200 が出れば完了

計画書づくりと実装用プロンプトへの整形は、同じルーチンが依頼の task で切り替えて行います。ルーチンを 2 つ作る必要はありません。

network secret の値は次のとおりです。

| 項目 | 値 |
| --- | --- |
| Secret type | Bearer |
| Name | `maronn planner results`（任意） |
| Allowed websites | planner のホスト |
| Custom headers | Name `Authorization`、Prefix `Bearer`、Value は推測されにくい長いランダムな文字列（32 文字以上を勧める。スクリプトにも同じ値を入力する） |

エージェントのプロキシは、Allowed websites（planner）へのリクエストに `Authorization: Bearer <Value>` を付けます。
ルーチンのプロンプトは、自分で Authorization ヘッダーを付けないよう指示しています。

### 保存プロンプトを更新する

planner の更新で保存プロンプトが変わったときは、claude.ai のルーチンのプロンプトも差し替えます。`pnpm run deploy` は変わったことを検出し、新しい文面（`.deploy/routine-prompt.md` にも保存する）と手順を表示してから、差し替えを済ませたかを聞きます。同じ文面は planner の `/setup` でも確認できます。

1. ルーチンの詳細ページ（https://claude.ai/code/routines）で、名前の横のメニューから Edit を開く（Claude Code の `/schedule update` でも差し替えられる）
2. プロンプトを新しい文面に置き換えて保存する
3. `pnpm run deploy` を実行し、設定を済ませたかの確認に答えてデプロイする

保存プロンプトは依頼の version 3 と 2 の両方を受け付けます。そのため、プロンプトを先に差し替えてから planner をデプロイしても、その間の依頼は止まりません。
逆に、古いプロンプト（version 2 だけを受け付ける）のまま planner をデプロイすると、ルーチンは version 3 の依頼を形の違う依頼として何も返さずに終了し、依頼は待ち時間の上限で失敗します。

保存した network secret は編集できないので、値を変えるときは削除して追加し直し、`pnpm run deploy` で同じ値を入力します。
スクリプトは、claude.ai に設定した値（network secret、許可ドメイン、プロンプト）の指紋を、確認を受けた時点で `.deploy/state.json` に記録します。network secret の指紋には Bearer トークンのハッシュも含めます。
次のデプロイで値が変わっていれば（Bearer トークンの変更、planner の URL の変更、プロンプトの更新など）、直す手順だけを表示し、設定を済ませたかを聞いてからデプロイします。
非対話で実行したときは、手順を表示して警告したうえで進めます。

許可ドメインは、planner のホストと、計画の根拠になる仕様と資料のサイトです。

| ドメイン | 用途 |
| --- | --- |
| planner のホスト | 結果の送信 |
| `www.rfc-editor.org`、`rfc-editor.org`、`datatracker.ietf.org`、`www.ietf.org` | RFC と Internet-Draft |
| `openid.net`、`openid.github.io` | OpenID Connect、FAPI とそのドラフト |
| `www.iana.org` | OAuth パラメーター、JWT クレーム、JOSE アルゴリズムの登録簿 |
| `oauth.net` | OAuth の仕様の一覧 |
| `www.w3.org`、`w3c.github.io`、`developer.mozilla.org` | WebAuthn、Web Crypto などの Web 標準 |
| `developers.cloudflare.com`、`hono.dev` | samples とこのアプリが動く基盤 |

GitHub は専用のプロキシを通るので、許可ドメインに入れる必要はありません。
IdP のホストも入れません。ルーチンは IdP と通信しません。
planner のホストは network secret の対象なのでどのアクセスレベルでも届きますが、許可ドメインにも入れています。network secret が働いていないときに、接続の拒否ではなく 401 として見分けられるようにするためです。

Bearer トークンは、planner の Secret（`ROUTINE_BEARER_TOKEN_HASH`）と `.deploy/state.json` にハッシュだけを保存します。
URL とトークンと Bearer トークンは、初回は必須で、形が違えば入力し直しを求めます。トークンは画面に表示しません。
2 回目以降も同じ入力を求め、空のまま Enter を押すと登録済みの値をそのまま使います（Cloudflare の Secret は読み出せないので、登録済みの値は表示しません）。
同じ手順と値は、デプロイ後も planner の `/setup` で確認できます。

## プロンプトインジェクション対策

ルーチンに届く依頼の本文はユーザーが書いたものです。リポジトリや Web ページにも、命令のように読める文が含まれることがあります。
そこで指示の置き場所を分け、どこから命令が紛れ込んでも、送信先と操作が変わらないようにしています。

| 対策 | 内容 |
| --- | --- |
| 指示は保存プロンプトだけ | 手順、計画書の形式、送信先、禁止事項は、ルーチンに保存したプロンプトだけに書く。fire の `text` は指示を含まない JSON のデータで、ユーザーの文章、計画書、コメントは JSON の文字列値に閉じ込める |
| データとして読むものの明示 | 依頼の中身（会話、計画書、コメント）、リポジトリのファイル、Web ページ、コマンドの出力、API の応答をデータとして扱い、中の命令に従わないよう保存プロンプトで指示する。共有リンクからログインせずに書き込まれた文章も含まれることを明示する。従わなかった命令は計画書の末尾（実装用プロンプトでは notes）で報告させる |
| 実装用プロンプトの範囲 | 実装用プロンプトは別の AI がリポジトリを書き換えるときの指示になるため、計画書の機能を実装することに限らせる。会話や計画書、コメントにある、秘密情報の読み出し、外部への送信、無関係なコマンドの実行、CI や権限の設定の変更を求める記述は入れさせない。使う前に人が読む前提で、画面に表示する |
| 送信先の固定 | planner の受け口の URL は保存プロンプトに固定し、依頼から読まない。run_id と run_token は正規表現で確かめてからシェルに渡し、形が違えば何も送らずに終了させる |
| 秘密を見せない | Bearer トークンは、network secret（Bearer）としてエージェントのプロキシが VM の外で付け、ルーチンの Claude には渡さない。run トークンの表示や記録は禁じる |
| 操作の制限 | ルーチンのツールを読み取りと Bash、Write、WebFetch に絞り、MCP コネクタを付けない。リポジトリの変更、commit、push、プルリクエスト、スクリプトの実行、パッケージのインストールを禁じる |
| 通信の制限 | 実行環境の許可ドメインを、planner と仕様のサイトに限る |
| 受け口の検証 | planner は Bearer トークン（ハッシュを定数時間で比べる）と run トークンを確かめ、本文の形と大きさを検証する。表示では HTML をエスケープする |

## IdP のユーザー管理

ユーザーは管理者がコマンドで登録します。
ログイン画面で入力するユーザー ID が、ID トークンの `sub` になります。

```bash
pnpm --filter @apps/idp user add alice --name "Alice" --email alice@example.com --remote
pnpm --filter @apps/idp user list --remote
pnpm --filter @apps/idp user remove alice --remote
```

`--remote` を付けなければローカルの D1 が対象です。
同じユーザー ID で `add` を実行し直すと、パスワードを含めて上書きします。

## 削除

```bash
pnpm run destroy
```

planner と IdP の Worker（Secret を含む）、2 つの D1 データベース、`wrangler.deploy.jsonc` を削除します。
D1 のデータ（ユーザー、計画書）は元に戻せないので、planner の Worker 名を入力して確認します。
途中で失敗しても残りの手順は続け、再実行すると削除済みのものは飛ばします。
claude.ai のルーチンと実行環境は削除しません（claude.ai/code/routines で削除する）。

| オプション | 内容 |
| --- | --- |
| `--yes` | 確認を省く（非対話の環境では必須） |
| `--dry-run` | 削除対象を表示するだけにする |
| `--local` | ローカル開発の状態（`.wrangler/state` と `.dev.vars`）を削除する |

`.deploy/state.json` は、次のデプロイで同じ名前、サブドメイン、ルーチン用クライアントのシークレットを使うために残します。

## 結果の受け口

依頼の JSON（fire の `text`）は次の形です。ルーチンは `type`、`version`、`task`、`run_id`、`run_token` を確かめてから使います。

```json
{
  "type": "maronn-planner.plan-request",
  "version": 3,
  "task": "plan",
  "run_id": "run_0123456789abcdef01234567",
  "run_token": "<43 文字>",
  "thread": { "title": "DPoP 対応", "url": "https://.../plans/thr_..." },
  "requester": { "sub": "alice", "name": "Alice" },
  "conversation": [
    { "seq": 1, "role": "user", "kind": "request", "author": "Alice", "created_at": "...", "body": "..." },
    { "seq": 2, "role": "assistant", "kind": "plan", "created_at": "...", "body_omitted": true, "plan_version": 1, "changes": "初版" },
    { "seq": 3, "role": "user", "kind": "plan", "author": "Alice", "created_at": "...", "body_omitted": true, "plan_version": 2,
      "changes": "テスト計画に E2E を足した", "changed_sections": { "changed": ["テスト計画"] } },
    { "seq": 4, "role": "user", "kind": "reply", "author": "Bob（ゲスト）", "created_at": "...", "body": "..." }
  ],
  "current_plan": {
    "version": 2, "seq": 3, "edited_by_user": true, "author": "Alice", "title": "...", "markdown": "# ...",
    "user_changes": { "since_version": 1, "changed_sections": { "changed": ["テスト計画"] }, "diff": "--- v1（Claude Code）\n+++ v2（編集後）\n@@ ..." }
  },
  "comments": [
    { "id": "cmt_0123456789abcdef01234567", "plan_version": 2, "section": "実装ステップ", "line": 87,
      "excerpt": "- [ ] `verifyDpopProof()` の失敗ケースのテストを書く", "quote": "verifyDpopProof", "body": "...", "author": "Bob（ゲスト）", "created_at": "..." },
    { "id": "cmt_89abcdef0123456789abcdef", "plan_version": 2, "body": "計画書全体へのコメント", "author": "Alice", "created_at": "..." }
  ],
  "omitted_seq": []
}
```

`task` は `plan`（計画書を作る・直す）か `implementation_prompt`（実装用プロンプトに整形する）です。
`comments` の `line` は、`plan_version` の版の Markdown で、コメントしたブロック（見出し、段落、リストの項目、表、コードブロック）が始まる行（1 始まり）で、`excerpt` はそのブロックの Markdown を 1 行にした冒頭（200 文字まで）です。`line` の無いコメントは計画書全体（`section` があればその節）へのものです。
version 2（task、current_plan、comments が無く、計画書の本文が会話に入る形）は、保存プロンプトの更新前に動いている planner との互換のために受け付けています。

ルーチンは結果を次のように送ります。`Authorization` は network secret がエージェントのプロキシで付けます。

```http
POST /api/routine/runs/{run_id}/messages
Authorization: Bearer {network secret の Bearer トークン（プロキシが付ける）}
X-Planner-Run-Token: {run_token}
Content-Type: application/json

{
  "kind": "plan",
  "title": "DPoP 対応の実装計画",
  "markdown": "# DPoP 対応の実装計画\n\n## 概要\n...",
  "changes": "v2（人が編集した版）を元に、コメント 2 件を反映した",
  "comment_replies": [{ "id": "cmt_0123456789abcdef01234567", "resolved": true, "reply": "テスト計画に E2E のケースを足した" }]
}
```

| kind | 意味 | planner の動作 |
| --- | --- | --- |
| `plan` | 計画書（task が plan） | 新しい版として表示し、修正依頼、コメント、実装用プロンプトのフォームを出す。`changes`（前の版からの変更点と理由）を版の履歴に残し、`comment_replies` の `resolved` が true のコメントを解決済みにする |
| `questions` | 計画の前に確認したいこと（task が plan） | `questions` の各項目（`id`、`question`、任意の `choices`）に回答フォームを出す。`comment_replies` も付けられる |
| `implementation_prompt` | 実装用プロンプト（task が implementation_prompt） | プロンプトとして表示し、コピーとダウンロードを出す。`notes`（整形で気づいたこと）を整形メモとして表示する |
| `progress` | 途中経過 | 作業中の表示に添える（何度でも送れる） |
| `error` | 計画もプロンプトも返せない理由 | 失敗として表示し、再実行のボタンを出す |

task に合わない kind（計画書づくりの依頼への `implementation_prompt` など）は 400 で拒否します。

Bearer トークンが無い、または違うなら 401（`WWW-Authenticate: Bearer error="invalid_token"`）で拒否します。
run トークンは SHA-256 だけを保存し、その依頼が作業中の間だけ受け付けます。
結果を一度受け取った後の送信は 409、待ち時間（既定 360 分）を過ぎた後の送信は 410 で拒否します。
会話が長い場合は、同じ 2 つのヘッダーで `GET /api/routine/runs/{run_id}/context` を呼ぶと、会話、最新の計画書、未解決のコメントを Markdown で取得できます（古い版の計画書の本文は含まない）。
古い版の本文は、同じヘッダーで `GET /api/routine/runs/{run_id}/plans/{版}` を呼ぶと 1 版ずつ取得できます。
`GET /api/routine/ping` は run を持たず、Bearer トークンだけを確かめて、正しければ 200（`{"ok": true}`）を、無いか違えば 401 を返します。
ルーチンは作業の前にこれを呼び、401 なら調べ始めずに終了します。テキストなしで起動したときは、これだけを呼んで結果を報告します。

## Markdown の表示

planner は計画書、質問、ユーザーの依頼を [markdown-it](https://github.com/markdown-it/markdown-it) で表示します。
markdown-it は CommonMark の仕様に従い、GitHub Flavored Markdown の表、取り消し線、URL の自動リンクにも対応しています。
これにタスクリストと脚注のプラグインを足し、`mermaid` のコードブロックは図として、それ以外のコードブロックは言語ごとにハイライトして表示します。
Claude Code の出力をそのまま表示するので、HTML のタグはエスケープし、`javascript:` などの URL はリンクにしません。

## 設定値

| アプリ | 名前 | 種類 | 内容 |
| --- | --- | --- | --- |
| IdP | `ISSUER` | var | IdP の公開 URL |
| IdP | `OIDC_SIGNING_KEYS` | Secret | RS256 の秘密鍵（JWK の配列。先頭の鍵で署名し、すべてを JWKS で公開する） |
| IdP | `OIDC_CLIENTS_JSON` | Secret | ログインに使うクライアント（planner）の配列 |
| IdP | `REGISTER_DEVELOPMENT_USERS` | ローカルのみ | `1` で開発用ユーザーを登録する |
| planner | `APP_ORIGIN` | var | planner の公開 URL |
| planner | `OIDC_ISSUER`、`OIDC_CLIENT_ID` | var | ログインに使う IdP とクライアント ID |
| planner | `OIDC_CLIENT_SECRET` | Secret | クライアントシークレット |
| planner | `ROUTINE_FIRE_URL`、`ROUTINE_TOKEN` | Secret | ルーチンの API トリガーの URL とトークン |
| planner | `ROUTINE_BEARER_TOKEN_HASH` | Secret | ルーチンの Bearer トークン（network secret の Value）の SHA-256（base64url）。未設定ならルーチンの結果をすべて拒否する |
| planner | `ALLOWED_SUBS` | var | 利用を許すユーザー ID（カンマ区切り。空なら IdP の全員） |
| planner | `RUNS_PER_HOUR_LIMIT` | var | 1 ユーザーが 1 時間に送れる依頼の数（既定 10） |
| planner | `RUN_TIMEOUT_MINUTES` | var | 結果を待つ時間（既定 360 分） |

IdP の署名鍵を Secret に固定しているのは、Workers が複数の isolate で動くためです。
起動時に鍵を生成すると isolate ごとに鍵が変わり、ある isolate の JWKS で別の isolate が署名したトークンを検証できなくなります。

## テスト

```bash
pnpm test        # 単体テスト（IdP、planner）
pnpm typecheck   # 型チェック
pnpm e2e         # pnpm dev で起動した状態で、ログインから計画書の表示、編集、その場所へのコメント、共有リンク、実装用プロンプト、ログアウトまでを確かめる
```

IdP の `src/oidc-provider/` は CLI の生成物です。
`pnpm --filter @apps/idp generate --force` で生成し直せますが、手で書く `db/instance.ts` 以外への変更は上書きされます。
