# 実験環境の設定

## 静的カタログ
READMEのローカル起動で確認し、Pagesを有効にする場合は main /docs を配信する。
公開ファイルは docs/ に限定する。設計資料は design/ に置く。

## GAS・Sheetsを新規作成する

1. 運営のGoogleアカウントで空のSpreadsheetを新規作成し、「即売会・実験用」などの名前を付ける。
   リンク共有は「制限付き」のままとし、出店者へ共有しない。本番ファイルを指定しない。
2. 新しい独立したApps Scriptプロジェクトを作る。
3. gas/ の Code.gs、Store.gs、Auth.gs、Profile.gs、Admin.gs、Images.gs を、それぞれ同名のスクリプトファイルに貼る。
   Index.html はHTMLファイル Index に貼る。古い疎通確認用コードは置き換える。
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
| HF_EDIT_DEADLINE | 編集終了日時。例: `2026-12-31T23:59:59+09:00`。実際の実験期間に合わせて設定 |

HF_EDIT_DEADLINEは未設定・不正・終了済みならプロフィールも含め読取専用。
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
4. Images.gsを追加し、Code.gs・Store.gs・Profile.gs・Index（HTML）・appsscript.jsonを更新する。
   Auth.gs・Admin.gsは以前の内容を維持してよい。初期登録の再実行・Sheetsの列追加は不要。
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
