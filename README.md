# 文芸同人誌即売会システム（実験用）

KLEAの既存サイト・KHBとは独立した試作です。実際の申込者の個人情報・本番の接続先・秘密情報は使いません。
メール確認にはテスト担当者が管理する受信可能な宛先を使い、Google側にだけ設定します。

## 現在できること
- 架空の出店者2組・頒布物4点の公開カタログ表示
- 出店名・作品名・紹介文の検索、ジャンル絞り込み
- 画像未登録時の代替表示
- GAS HTML Serviceの出店者編集画面・Sheetsへの接続確認（手動配置・設定後）
- 登録済みテスト宛先へのメール確認コードと、期限付きログイン
- 本人のプロフィール・複数頒布物の保存・再取得・編集・削除
- 他者IDの拒否、セッション失効、更新競合検知、同じ保存要求の再送
- 同じタブの再読み込み時、GASで再検証してログインと保存済み内容を復元
- JPEG・PNG・GIF・BMPの画像選択と調整、1作品3点までの非公開Drive保存・本人限定表示
- 画像の並べ替え・削除、編集期限終了後の変更・削除の拒否
- 運営が選択した出店者の公開用JSON・画像をZIPへ書き出し、ローカルで確認・反映・切り戻し
- 公開カタログの代表画像と補足・試し読み画像の表示
- 運営専用ログイン、開催設定・配置・公開対象の管理、公開前確認、ZIP書き出し・履歴

上記GAS機能はローカルの代替サービスによる自動テスト済みです。
Google上の実験環境は作成済みで、接続確認・認証・編集権限確認までユーザーが実施しています（2026-11-24）。
既存機能のテストもユーザー確認済みとの報告があります。具体的な試験内訳はdesign/TEST_PLAN.mdを参照してください。
ログイン復元と画像機能もユーザー確認済みです。
公開版の書き出し・取り込みと運営画面はローカル自動テスト済みで、実GAS・GitHub Pagesへの反映確認は未実施です。
申込受付、共同編集、次回開催へのコピー、自動公開同期は未実装です。
設定・本人確認・所属検証を通らない保存は拒否します。公開版を取り込むまではサンプルJSONを表示します。

## ローカル確認
Node.jsがある環境で、このrepo内から実行します。追加パッケージのインストールは不要です。

    node scripts/serve.mjs

http://127.0.0.1:8080/ を開きます。file:// での直開きはJSON読込が動かないため避けます。

## GitHub Pages
Settings → Pages → Deploy from a branch → main /docs を選択します。
公開URL: https://kleaex.github.io/hf_test/

コード作成だけでは公開されません。コミット・pushとPages設定が必要です。
静的カタログは外部への送信を行いません。GASは配置・設定後、許可されたテスト宛先への
確認コード送信・専用Sheetsへの保存・専用非公開Driveへの画像保存を行います。

## 配置
- docs/: Pagesに配信するHTML/CSS/JS・公開サンプルJSONのみ
- gas/: GASの手動配置用ソース
- design/: 要件・実装方針・試験手順

公開repoなので、gas/とdesign/もソースとして一般に閲覧できます。
秘密値や実データはrepoのどの場所にも保存しません。
GAS設定手順は design/SETUP.md、検証項目は design/TEST_PLAN.md を参照してください。

## GASのローカル検証

追加パッケージは不要です。Googleサービスを代替するテストで、実メールは送信しません。

    node --test tests/gas.test.mjs tests/session.test.mjs tests/images.test.mjs tests/publishing.test.mjs tests/admin.test.mjs

編集画面を模擬環境で操作する場合は次を実行し、http://127.0.0.1:8081/ を開きます。

    node tests/serve-experiment.mjs

画面上部に模擬メールの確認コードが表示されます。これはローカル専用の検証機能です。
tests/ をGASやPagesに配置しないでください。実環境の確認とは区別します。
模擬環境はGoogleの画像デコーダーとDriveを代替するため、実変換・権限の証明にはなりません。
模擬運営画面は http://127.0.0.1:8081/?view=admin 。テスト宛先はops@example.invalidです。

## 運営画面

実際のGAS WebアプリのURLに `?view=admin` を付けて開きます。
出店者用とは別のメール確認・1時間セッションで、運営として登録した利用者だけが使えます。
現在の1開催回のカタログ名・開催日・会場・編集期限、ブース番号と公開対象、公開前確認・ZIP書き出し履歴を管理します。

初回のみHF_ADMIN_EMAILSを設定し、setupAdminConsole_を一時関数経由で実行します。
Admins・AdminSessions・EventSettingsが作られ、旧HF_PUBLICATION_CONFIG_JSON・HF_EDIT_DEADLINEから初期値を移行します。
以降、日常の設定は運営画面から保存し、Script Propertiesの公開設定JSONを手編集する必要はありません。
移行済みの設定は再初期化で上書きしません。出店者の既存データ・セッションは保持します。
反映する全ファイルと初回手順はdesign/SETUP.md「運営画面を既存環境へ追加する」を参照してください。

## 画像機能を既存GASへ反映する

gas/Images.gsを追加し、Code.gs・Store.gs・Profile.gs・Index.html・appsscript.jsonを更新します。
Script PropertiesにHF_IMAGE_FOLDER_IDとHF_EDIT_DEADLINEを設定し、Drive権限を承認して
新しいバージョンへデプロイします。Sheetsの再初期化は不要です。
編集期限が未設定の場合は、プロフィールを含めて読取専用になります。
具体的な設定値・更新手順はdesign/SETUP.mdを参照してください。

## 登録内容を公開カタログへ反映する

1. 運営画面に必要なGASファイル一式を反映し、運営宛先の初回登録を行う。
2. 運営画面で開催設定・公開対象を保存し、公開前確認を経てZIPを書き出す。
3. ZIPをrepo内のtmp/へ展開し、次のコマンドで確認用カタログを作る。

       node scripts/install-catalog.mjs tmp/catalog-export

4. 表示された配置先を `node scripts/serve.mjs <配置先>` で開いて確認する。
5. 確認した同じ展開先を `node scripts/install-catalog.mjs tmp/catalog-export --apply` でdocs/へ反映する。
6. docs/の変更と版ディレクトリをコミット・pushし、Pagesの配信完了を確認する。

書き出し・確認用作成だけでは一般公開されません。画像元ファイルや書出し先Driveを共有する必要はありません。
HF_EXPORT_FOLDER_IDは引き続きScript Propertiesへ設定します。DriveのZIPは保存先の所有者アカウントで取得します。
GAS・ローカルそれぞれの反映ファイル一覧、設定例、切り戻しはdesign/SETUP.mdを参照してください。
