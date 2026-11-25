# 実験環境の設定

## 静的カタログ
READMEのローカル起動で確認し、Pagesを有効にする場合は main /docs を配信する。
公開ファイルは docs/ に限定する。設計資料は design/ に置く。

## GAS・Sheetsを新規作成する

1. 運営のGoogleアカウントで空のSpreadsheetを新規作成し、「即売会・実験用」などの名前を付ける。
   リンク共有は「制限付き」のままとし、出店者へ共有しない。本番ファイルを指定しない。
2. 新しい独立したApps Scriptプロジェクトを作る。
3. gas/ の全.gsファイル（Code、Store、Auth、Profile、Admin、Images、Publishing、AdminConsole）を同名のスクリプトファイルに貼る。
   Index.htmlはHTMLファイルIndex、AdminIndex.htmlはHTMLファイルAdminIndexに貼る。古い疎通確認用コードは置き換える。
   tests/ のファイルは配置しない。
4. プロジェクト設定でマニフェストを表示し、gas/appsscript.json の内容を設定する。
   Sheets・メール送信・Driveの権限を使う。Driveは画像保存先をIDで指定するためdriveスコープを使用する。

## Script Properties

Apps Scriptの「プロジェクトの設定 → スクリプト プロパティ」に次を登録する。
実際の値はソース・README・チャット・スクリーンショットへ貼らない。

| キー | 設定値 |
| --- | --- |
| HF_ENV | `experiment` 固定 |
| HF_SPREADSHEET_ID | 新規SpreadsheetのURLの `/d/` と `/edit` の間のID |
| HF_EVENT_ID | 例: `hf_experiment_2026`。英数字・`_`・`-`、64文字まで |
| HF_AUTH_SECRET | この実験専用に生成した32バイト以上のランダム秘密値（Base64等、43文字以上） |
| HF_TEST_EMAILS | テスト担当者が管理する受信可能な宛先のJSON配列。最大10件 |
| HF_BOOTSTRAP_JSON | 初期利用者と出店者の対応を表すJSON配列。下記参照 |
| HF_IMAGE_FOLDER_ID | 運営のみがアクセスする実験専用My DriveフォルダのID。画像を使う場合に必要 |
| HF_EDIT_DEADLINE | 運営画面の初期化前の編集終了日時・移行元。例: `2026-12-31T23:59:59+09:00` |
| HF_ADMIN_EMAILS | 運営の初期登録・許可宛先のJSON配列。最大5件。例: `["owner@example.invalid"]` |
| HF_EXPORT_FOLDER_ID | 画像元とは別の、運営所有者だけがアクセスする公開ZIP書き出し先のフォルダID |

初期化前のHF_EDIT_DEADLINEは未設定・不正・終了済みならプロフィールも含め読取専用。
運営画面の初期化後はEventSettingsの値に切り替わるため、以降の編集期限は運営画面から変更する。
この日時を変更すれば受付を再開できるが、終了済み開催回の再編集は原則行わない。

HF_AUTH_SECRETはPowerShellで次のコマンドを実行して生成し、Google側にだけ登録する。
出力や履歴を共有しない。他のシステムの秘密値を使い回さない。

```powershell
$hfBytes = New-Object byte[] 32
$hfRng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$hfRng.GetBytes($hfBytes)
$hfRng.Dispose()
[Convert]::ToBase64String($hfBytes)
```

次は構造の見本であり、そのままではメールを受信できない。宛先を自分が管理するテスト用宛先に置き換える。
出店名・作品等には架空データを使う。メールは英数字で始まる通常の形式を使用する。

HF_TEST_EMAILS:

```json
["tester-a@example.invalid", "tester-b@example.invalid"]
```

HF_BOOTSTRAP_JSON:

```json
[
  {"userId":"usr_test_a","exhibitorId":"exh_test_a","email":"tester-a@example.invalid","name":"架空出店者A"},
  {"userId":"usr_test_b","exhibitorId":"exh_test_b","email":"tester-b@example.invalid","name":"架空出店者B"}
]
```

利用者IDは `usr_`、出店者IDは `exh_` に英数字・`_`・`-`を続ける。
メール・利用者ID・出店者IDはそれぞれ重複させない。共同編集はこの段階の対象外。
許可宛先を登録するだけでは所属は作成されず、ログインできない。
HF_MAIL_BUDGETは送信制限用として自動作成されるため、手動設定・実験中のリセットは不要。

## 初期登録と配置

1. 初回デプロイ前に、GASの Admin.gs の末尾へ以下の一時関数を追加して保存する。
   `setupExperiment_` は末尾 _ の内部関数のため、エディタの実行一覧にも表示されない。
   一覧から `runSetupExperiment` を選んで実行し、必要なGoogle権限を承認する。

   ```javascript
   function runSetupExperiment() {
     return setupExperiment_();
   }
   ```

   実行が成功したら、この一時関数の3行を削除して保存する。
   一時関数はWeb画面からも呼べる名前のため、残したままデプロイしない。
   元の `setupExperiment_` の名前は変更しない。
2. Sheetsに Users、Memberships、Exhibitors、Sessions の4シートと見出しができ、
   Users・Memberships・ExhibitorsにA・Bが登録されたことを確認する。
   同じ設定で再実行しても保存内容は初期化しない。既存の形式やID対応が異なる場合は拒否する。
   初期設定中に失敗した場合は原因を直して同じ設定で再実行する。
3. 「デプロイ → 新しいデプロイ → ウェブアプリ」で、実行ユーザーを運営の「自分」にし、
   まずアクセスできるユーザーを「自分のみ」にして配置する。
4. 発行された `/exec` URLを開き、「接続を確認」でGAS・Sheets接続が成功することを確認する。
5. 許可したテスト宛先に確認コードを送り、受信・ログイン・保存・再読込・ログアウトを試す。
   初回は運営自身のテスト宛先1件で確認してもよい。A・B間の検証には別の2宛先が必要。
6. 第三者テストへ進むときだけ、Googleアカウントや組織で利用できるアクセス範囲を確認し、
   テスト参加者が開ける範囲へ変更する。誰でも開ける設定は入口を公開するため、この変更は運営が判断する。
   アプリ側では引き続き許可宛先・コード・所属を検証する。
7. ソース更新時はデプロイの管理から新しいバージョンへ更新する。エディタでの保存だけでは既存の `/exec` は更新されない。

この手順は運営が手動で行う。2026-11-24にユーザーから、実験環境での接続確認・認証・
編集権限確認まで実施したとの報告あり。残りの試験と確認範囲はTEST_PLAN.mdを参照。
Googleの承認画面に不明な警告が表示された場合は、内容を運営自身で確認する。
Session.getActiveUser().getEmail() が常に取得できるとは仮定しない。

## 運用上の確認

- コードは10分・最大5回入力・1回限り。再送は60秒後から、宛先ごと1時間5通・全体1時間20通。
  Google自身のメール送信割当が先に上限に達する場合もある。
- セッションは2時間、1利用者につき1件。別画面で再ログインすると前のログインは利用できなくなる。
  同じタブの再読み込み時はsessionStorageのトークンをGASで検証し、ログインと保存済み内容を復元する。
  再読み込みで期限は延長しない。未保存の入力は復元しない。確認コードの再利用はできない。
  復元時に通信が失敗したら「ログインの復元を再試行」を使う。
  ブラウザー設定等でStorageが使えない場合は案内を表示し、再読み込み後は再ログインが必要になる。
  タブの複製・復元ではブラウザーがStorageを引き継ぐ場合があるため、確実に終了するときはログアウトする。
- 停止は Users の enabled または Memberships の enabled を FALSE にする。
  TRUEに戻す前にSessionsの該当行のrevokedAtへ現在日時の数値（例: `1` でも失効）を入れれば、以前のログインは復活しない。
  メール・所属を変更する場合は、必ず旧セッションを失効させてから変更する。
  秘密値変更は全セッション・未使用コードを無効にする。
- 保存時に通信が切れたら「同じ保存を再試行・結果確認」を使う。
  その間の編集は止める。「保存済みの内容を読み直す」は未保存の入力を破棄するため確認が出る。
  更新競合や認証期限切れのときは、必要な入力を手元に控えてから再読込・再ログインする。
- メール送信失敗後は60秒以上おいて再送する。コード消費後の処理失敗・ログイン応答喪失も再送が必要。
- Sheetsを直接変更するのは運営のみ。自動処理中の手動編集は避ける。
  stateJson/authJsonの不正な編集は動作不良を起こすため、内容変更にはアプリを使う。
- この段階は1開催回用。開催回を追加するときは別の専用環境を用意する。
- 画像保存先は調整済み画像専用。元画像は端末から送信・保存しない。

## 画像機能を既存環境へ追加する

1. 運営のMy Drive直下に実験専用フォルダを新規作成する。共有ドライブ・共有フォルダ内には作らない。
   「アクセスを管理」でリンク共有を制限付き、アクセスできる人を運営の所有者だけにする。
   出店者・テスト担当者を直接共有へ追加しない。画像ファイルも個別共有しない。
2. フォルダURLの `/folders/` の後のIDをHF_IMAGE_FOLDER_IDに設定する。
3. HF_EDIT_DEADLINEにタイムゾーン付きISO日時を設定する。例は上記。
4. 下表の全6ファイルをGASへ反映する。既存ファイルは追記ではなく、ローカルの最新ファイルの全文で置き換える。

   | ローカルのファイル | GASエディタの反映先 | 操作 |
   | --- | --- | --- |
   | gas/Images.gs | スクリプト Images.gs | 左側「＋ → スクリプト」でImagesを新規作成し、全文を貼る |
   | gas/Code.gs | 既存のCode.gs | 全文を差し替える |
   | gas/Store.gs | 既存のStore.gs | 全文を差し替える |
   | gas/Profile.gs | 既存のProfile.gs | 全文を差し替える |
   | gas/Index.html | 既存のHTMLファイル Index | 全文を差し替える |
   | gas/appsscript.json | 既存のappsscript.json | 全文を差し替える。非表示ならプロジェクト設定でマニフェスト表示を有効にする |

   全ファイルを反映してから保存・実行・デプロイへ進む。Images.gsだけの追加では動かない。
   Auth.gs・Admin.gsは今回は変更不要。tests/・design/・README.mdはGASへ貼らない。
   初期登録の再実行・Sheetsの列追加は不要。
5. GASエディタのCode.gsでgetSystemStatusを実行し、追加のDrive権限を承認する。
   この関数は運営による実行でも設定と接続を確認する。失敗時はWeb画面の接続確認で案内を読む。
6. デプロイの管理から新しいバージョンへ更新する。
7. /execで接続確認・ログイン後、作品を保存してから画像を選択し、調整後のプレビューを確認して登録する。
   「画像を表示」で本人の画像を取得できること、再読込後も一覧が維持されることを確認する。
8. 3点上限、順序変更・削除、他者画像の取得拒否、編集期限後の変更拒否をTEST_PLAN.mdに沿って確認する。

元画像はJPEG・PNG・GIF・BMPの20MB以下。GIFは静止画になる。HEIC・WebP・AVIF・TIFF・SVG・PDFは対象外。
ブラウザーでPNG優先、容量が大きければ白背景JPEGへ変換し、長辺2,400px・1.5MB以内で送信する。
画像追加前に未保存の入力を保存する。追加はその場で確定、削除・先頭への移動は「保存」で確定する。
登録応答が不明なときは同じ登録要求を再試行するか、保存済みの内容を読み直す。
1出店者の登録はUTC日付ごと30回・合計30MBまで。選択20MBと送信1.5MBの上限は別。
Googleの変換割当・Drive容量等の上限にも影響される。

削除や途中失敗の画像ファイルは非公開Driveに残る。自動物理削除は未実装。
実験中はフォルダ容量を運営が確認し、Sheetsの参照と照合せずにファイルを削除しない。
Googleの実変換・Drive権限・画像の向き／文字の見え方はローカル代替では確認できないため、必ず実環境で確認する。

参考: [Blobの画像変換](https://developers.google.com/apps-script/reference/base/blob#getAs(String))、
[Driveフォルダの操作と共有](https://developers.google.com/apps-script/reference/drive/folder)。

## 運営画面を既存環境へ追加する

現在の1開催回について、開催名・開催日・会場・編集期限、ブース・公開対象、公開前確認・ZIP書き出し・履歴を管理する。
出店者用のログインとは別の運営認証を使う。新規申込・入金管理・複数回の作成やコピーはこの画面にはまだない。

### 反映するファイル

| ローカルのファイル | GASの反映先 | 操作 |
| --- | --- | --- |
| gas/AdminConsole.gs | スクリプトAdminConsole.gs | 新規追加して全文を貼る |
| gas/AdminIndex.html | HTMLファイルAdminIndex | 「＋ → HTML」でAdminIndexを追加し、全文を貼る |
| gas/Code.gs | Code.gs | 全文を差し替える。運営URL・APIの入口を追加 |
| gas/Auth.gs | Auth.gs | 全文を差し替える。確認コード送信の共通処理を追加 |
| gas/Store.gs | Store.gs | 全文を差し替える。運営用テーブル・開催設定への接続を追加 |
| gas/Publishing.gs | Publishing.gs | 全文を差し替える。未配置なら新規追加 |
| gas/Images.gs | Images.gs | 公開版実装時の最新ファイルへ差し替える。公開用画像読込の内部関数が必要 |

全対象を反映してから保存・実行する。Profile.gs・Admin.gs・Index・appsscript.jsonは画像機能実装時の最新版を維持してよい。
新しいOAuthスコープは不要。出店者の初期登録やSheetsの再作成は行わない。
公開カタログの開催日・会場表示には、docs/index.html・docs/app.js・docs/catalog-schema.mjsの更新も必要。

### 初回だけ行う設定と移行

1. HF_ADMIN_EMAILSへ、運営が管理する受信可能な宛先をJSON配列で設定する。
   最初はGAS・Driveの所有者である自分のGoogleアカウントのメールを使う。
   出店者用HF_TEST_EMAILSへ運営を追加したり、運営の出店者登録を作ったりする必要はない。
2. HF_EXPORT_FOLDER_IDを設定する。書き出し先は画像元と別のMy Driveフォルダで、所有者だけがアクセスする状態にする。
3. AdminConsole.gsの末尾へ以下を一時追加して保存し、関数一覧からrunSetupAdminConsoleを手動実行する。

   ```javascript
   function runSetupAdminConsole() {
     return setupAdminConsole_();
   }
   ```

4. 実行後にこの一時関数の3行を削除して保存する。残したままデプロイしない。
5. SheetsにAdmins・AdminSessions・EventSettingsの3シートが増え、Adminsに運営、EventSettingsに開催設定が入ったことを確認する。
   既存のUsers・Memberships・Exhibitors・Sessionsは変更しない。
6. 初回は旧HF_PUBLICATION_CONFIG_JSONがあればカタログ名・公開対象・ブースを、HF_EDIT_DEADLINEから期限を移行する。
   公開設定がなければ、全出店者を非公開の初期状態にする。開催日・会場は画面から入力する。
   再実行しても、作成済みの開催設定や出店者データは上書きしない。
7. デプロイの管理から新しいバージョンへ更新する。公開範囲は以前の設定を維持する。
8. 発行済みの `/exec` URLの末尾へ `?view=admin` を付けて開く。
   運営宛先へ専用コードを送り、ログインできることを確認する。

EventSettings作成後は、日常の開催設定・配置・公開対象を画面で保存する。
旧HF_PUBLICATION_CONFIG_JSONとHF_EDIT_DEADLINEは移行元であり、後からScript Propertiesを書き換えても運用値は変わらない。
HF_ENV・HF_EVENT_ID・接続先ID・秘密値・運営宛先の許可は引き続き所有者が環境設定として管理する。

### 日常の操作

1. 「開催設定・配置」でカタログ名、開催日、会場、編集期限（日本時間）、ブースと公開対象を入力して保存する。
   編集期限を空にすると出店者の編集は停止する。設定保存だけでは公開ページは更新されない。
2. 「保存済みの公開内容を確認」を押し、出店者・作品・価格・紹介文と各画像を確認する。
3. 「掲載内容と公開対象を確認しました」にチェックしてZIPを書き出す。
   確認は10分間有効。確認後に設定や選択された出店者の保存内容が変わると、再確認が必要になる。
4. 書き出し履歴の「DriveでZIPを開く」から取得し、次のローカル確認・適用へ進む。

運営セッションは1時間。再読み込み時は運営専用sessionStorageの値をGASで検証して復元する。
出店者ログインとは別にログアウトする。通信結果が不明なら、同じ設定保存・書き出しを再試行する。
別の運営がプレビューを作成すると、前のプレビューは置き換わる。

ZIPは非公開Driveに置いたままで共有設定を自動変更しない。
Driveリンクは所有者として開く。所有者以外の運営宛先を登録した場合、画面操作はできても
そのGoogleアカウントにDrive権限がなければZIPは取得できない。初期実験は所有者の運営アカウントで行う。

運営を停止するには、HF_ADMIN_EMAILSから外すかAdmins.enabledをFALSEにする。
再許可前にAdminSessionsの該当行のrevokedAtへ`1`等の失効印を入れ、以前のセッションが復活しないようにする。
運営権限の追加・変更を画面から行う機能は用意しない。

## 公開カタログへの手動反映

この操作は「GASから非公開ZIPを書き出す → ローカルで表示を確認する → docs/へ反映する → コミット・push」の4段階。
書き出しや確認用作成だけでは一般公開されない。GAS・Driveの実データをこのrepoに一括コピーしない。

### 今回反映するファイル

| 対象 | ファイル | 操作 |
| --- | --- | --- |
| GAS | AdminConsole.gs・AdminIndex.html・Code.gs・Auth.gs・Store.gs・Publishing.gs・Images.gs | 上の「運営画面を既存環境へ追加する」の一覧に従い追加・全文差し替えする |
| 公開画面 | docs/index.html、docs/app.js、docs/styles.css | ローカルの変更を確認し、公開時のコミットへ含める |
| 公開画面 | docs/catalog-schema.mjs | 新規ファイル。app.jsと一緒に公開する |
| ローカル操作 | scripts/install-catalog.mjs、scripts/serve.mjs | repo内でNode.jsから使用する。GASへ貼らない |
| 公開データ | docs/data/catalog.json、docs/data/releases/以下 | 取り込みコマンドが生成する。画像を含め公開時のコミットへ含める |

GAS側の更新は、上の「運営画面を既存環境へ追加する」の全対象を先に反映する。
運営画面の追加時にはWebアプリを新しいバージョンへ更新する。Sheetsの再初期化・新しいOAuthスコープは不要。

### 1. 運営専用の書き出し設定

1. My Drive直下に画像元とは別の「即売会・公開版書き出し」等のフォルダを作る。
   運営の所有者だけがアクセスできる状態にし、リンク共有や個別共有を行わない。
2. そのフォルダIDをScript PropertiesのHF_EXPORT_FOLDER_IDに設定する。
3. 運営画面でカタログ名・ブース番号・公開対象を設定して保存する。設定JSONの手編集は不要。
   ブース番号が空なら「配置未定」と表示する。空でないブース番号は重複不可。
   公開対象に選んだ出店者の保存済みプロフィール・全作品・全登録画像が対象となる。
   編集途中でも書き出せるため、対象を運営が確認して実行する。上限は10組・画像合計20MB。

### 2. 運営画面からZIPを書き出す

1. 公開前確認のプレビューを作り、掲載内容と画像を確認する。
2. 確認チェックを入れ、「確認した内容をZIPへ書き出す」を押す。
3. 書き出し履歴で公開版IDを確認し、Driveリンクから該当ZIPをダウンロードする。
   ZIPも元画像もDrive上で公開しない。GASエディタの一時関数は日常の書き出しには不要。

ZIPの内容はcatalog.json、manifest.json、images/の公開用コピーだけ。
元画像Drive ID・メール・セッション・内部メモ等は出力しない。
ただし、公開用の紹介文などに本人が連絡先を書いた場合は自動検出しない。ローカル確認で内容を確認する。
manifestのSHA-256は欠落・改変の検出用で、配布元を保証する署名ではない。自分の運営用Driveから取得したZIPだけを使う。

### 3. ローカルで公開内容を確認する

1. このrepo内のtmp/に、今回のZIP用の空フォルダを作って展開する。
   以下は展開先をtmp/catalog-exportとした例。フォルダ直下にcatalog.json・manifest.json・images/がある状態にする。
   次回は別の空フォルダへ展開し、前回の画像等を混ぜない。
2. repoのルートで実行する。

   ```text
   node scripts/install-catalog.mjs tmp/catalog-export
   ```

3. 検証成功後に表示される配置先を使い、次を実行する。`rel_…` は実際に表示された公開版IDへ置き換える。

   ```text
   node scripts/serve.mjs tmp/catalog-preview/rel_…
   ```

4. http://127.0.0.1:8080/ を開き、出店名・作品・価格・ブース・代表画像・補足画像・検索と公開版IDを確認する。
   画像のリンク先も開いて確認する。紹介文等に公開したくない情報があればGAS側の内容を直して新しいZIPを書き出す。
   この段階ではdocs/data/catalog.jsonや一般公開ページは変更されない。
5. 確認後はCtrl+Cでローカルサーバーを停止する。

既に8080番を使用中の場合は、PowerShellで `$env:HF_PREVIEW_PORT = '8082'` を設定してから起動し、
実際に表示されたURLを開く。既存の別作業のサーバーは停止しない。

### 4. 確認した版を公開対象へ反映する

1. 確認したのと同じ展開先で、次を実行する。

   ```text
   node scripts/install-catalog.mjs tmp/catalog-export --apply
   ```

2. docs/data/releases/<公開版ID>/にJSON・manifest・画像が入り、最後にdocs/data/catalog.jsonが切り替わる。
   エラーなら現行データは切り替わらない。同じ版IDの中身は変更できない。
3. `node scripts/serve.mjs` でdocs/の表示を確認する。
4. 公開画面の4ファイルと、生成されたdocs/data/catalog.json・docs/data/releases/<公開版ID>/一式を
   コミット・pushする。tmp/やダウンロードしたZIPはコミットしない。
5. GitHub Pagesの配信完了後、https://kleaex.github.io/hf_test/ を開く。
   画面の公開版IDが今回のIDであることと、画像が表示されることを確認する。

GASにGitHubトークンは設定しない。ローカル反映とpush・Pages配信成功は別の確認とする。
公開画像はPagesの版ディレクトリから配信し、非公開Driveへ来場者がアクセスすることはない。

### 切り戻し

公開済みの旧版ディレクトリを入力にして、まず確認用作成、確認後に適用する。
`rel_…` は戻したい実際の旧版IDへ置き換える。

```text
node scripts/install-catalog.mjs docs/data/releases/rel_…
node scripts/install-catalog.mjs docs/data/releases/rel_… --apply
```

その後docs/data/catalog.jsonの変更をコミット・pushして、公開ページの版IDを確認する。
切り戻しは現行表示を戻す操作で、旧版ディレクトリやGit履歴の削除ではない。
過去の掲載情報・画像は旧版に残るため、誤公開の全版からの撤回は別途運営で対応する。

## ログイン復元変更の配置・確認

今回の復元処理はIndex.htmlの変更。GASのHTMLファイル Index を更新し、
デプロイの管理から新しいバージョンへ更新する。Sheetsの初期設定の再実行は不要。
ログイン → 保存 → ブラウザー再読み込みで、コードを再送せずに保存済み内容が表示されることを確認する。
続いてログアウト → 再読み込みでログイン画面になること、失効済みトークンが復元されないことを確認する。
GAS HTML Serviceはiframe内で動くため、実際の /exec と利用するブラウザーでStorageの保持・利用可否を確認する。

参考: [sessionStorageの保持期間と制限](https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage)、
[GAS HTML Serviceの制約](https://developers.google.com/apps-script/guides/html/restrictions)。

参考: [GAS Webアプリ](https://developers.google.com/apps-script/guides/web)、
[HTML Serviceの呼出しと内部関数](https://developers.google.com/apps-script/guides/html/communication)、
[メール送信と割当](https://developers.google.com/apps-script/reference/mail/mail-app)。

本番KHBのSpreadsheet ID、GAS URL、HMAC秘密値は流用しない。
GitHubトークン、メール、セッション、実申込データを公開repoへ保存しない。
claspは未導入。導入時も .clasp.json とログイン情報を追跡しない。
