# 実験環境の設定

## カタログの初回表示を短縮する（今回）

出店者側の追加作業はいったん止め、HPを開いて本文と最初の書影が表示されるまでの待ちを対象にする。
従来の「非表示GAS画面の接続完了 → カタログRPC → 小画像RPC」という直列の処理をまとめる。
公開カタログと、条件を満たす最初の小画像1点を接続通知に同梱する。
実際の短縮秒数・描画は実GAS／実ブラウザーで確認する。通信回数の削減を固定の短縮秒数として扱わない。

### 更新する4ファイル

| 配置先 | repoのファイル | GASでの名前・操作 |
| --- | --- | --- |
| GAS | gas/Transport.gs | Transportを**置換**。初回公開応答の作成・安全なJSON埋め込み |
| GAS | gas/Bridge.html | HTMLファイルBridgeを**置換**。接続通知へ公開応答を同梱 |
| Pages | docs/rpc.js | **置換**。初回応答の受取・従来経路への互換処理 |
| Pages | docs/app.js | **置換**。本文と同梱画像を追加要求なしで表示 |

GASの2ファイルを保存して既存デプロイを新バージョンへ更新し、その後HPの2ファイルを配信する。
URL・Script Properties・権限・マニフェストの変更や初期化は不要。以前配置した他のファイルとDriveサービスv3は維持する。
配信完了後に公開カタログを再読み込みする。古いJSが残る場合は強制再読み込みで確認する。

### 動作と安全性

- 公開カタログを初回接続に要求した場合だけ同梱する。出店者・運営画面の通常接続では取得しない。
- 公開対象・保存済みデータの選別、保存時のキャッシュ世代更新を通した同じ公開APIを使う。
- origin・作成したiframeの子孫window・nonceを照合してから初期応答を受け取る。
- 紹介文等のHTML文字列でGASのscript要素を閉じられないようにJSONをエスケープする。HPでも公開スキーマを検証する。
- 最初の書影にサムネイルがあり30KB以内の場合だけ、非公開Driveの確認と内容検証を通して1点同梱する。
  大きい画像・サムネイルのない旧画像は後から取得する。同梱画像の失敗で本文の取得は失敗させない。
- 同梱画像は検証済みのカタログに含まれる画像IDだけを使い、後続・拡大画像は従来経路で取得する。
- 初期応答は1回だけ利用する。同じページで再度データ取得した際は現在の公開APIを呼び、古い初期データを返し続けない。
- 旧GASと新HPなどの段階更新では通常RPCへ戻る。接続・保存のエラーをサンプル表示で隠さない。

### 初回表示を測る

ページを再読み込みし、本文・先頭の書影が表示された後にConsoleで実行する。

```js
JSON.stringify(hfPerformance.snapshot(), null, 2)
```

ここではhfPerformance.clear()やgetPublicCatalogの連続呼出しを先に行わない。初期表示の記録を残す。

| operation・stage | 意味 |
| --- | --- |
| catalogInitial | 接続準備と同梱公開応答を受け取るまで。新しい初期表示経路 |
| catalogFallback | 同梱されなかったため従来のRPCで取得した。旧GASや既接続の場合 |
| catalogLoad | app.jsの読込処理開始から、本文のDOM準備完了まで |
| catalogTextReady | ブラウザーのnavigation時刻から本文のDOM準備完了まで。HTML・JS読込前の待ちも含む |
| catalogPreview | 同梱する先頭小画像の選別・取得に要したGAS内の時間 |
| imageLoad / source=memory | 同梱した書影または同じページ内の取得済み画像を利用した場合 |

catalogInitialとbridge、catalogLoad等は重なるので足し合わせない。catalogTextReadyはDOM準備の指標で、画面の実描画完了を厳密に測る値ではない。
初回にcatalogInitialがあり追加のgetPublicCatalogがなければ、接続後のカタログRPCを省けている。
先頭小画像を同梱できた場合は、その画像のための追加getPublicImagesも不要になる。
同梱画像の取得時間・転送量は初期応答へ移るので、元のRPC時間が丸ごと消えるわけではない。

## 実測に基づく画像読取の改善を反映する（今回）

変更前の実測では、小画像22,014バイトでも約6.11秒／3.66秒かかり、毎回のDrive確認が約1.1〜1.9秒を占めた。
最初の画像要求ではSheetsの2回読取にも約2.09秒かかっていた。
画像をさらに圧縮する前に、確認情報の取得とカタログ／画像間の重複読取を改善する。
新経路の実GASでの短縮幅・API応答は反映後に確認する。模擬テストを実環境の速度保証にしない。

### 反映するファイル

| 配置先 | ファイル | 操作 |
| --- | --- | --- |
| GAS | gas/DriveMetadata.gs → DriveMetadata | **スクリプトを追加**。画像読取時の確認情報をDrive APIで取得 |
| GAS | gas/Images.gs → Images | **置換**。読取時のAPI経路・従来経路の選択 |
| GAS | gas/PublicCatalog.gs → PublicCatalog | **置換**。同じ正本読取から画像索引も用意 |
| GAS | gas/appsscript.json → appsscript.json | **置換**。高度なDriveサービスv3を有効化 |
| Pages | docs/rpc.js | **置換**。新しい計測区間を受け取る |

既存のGASファイルは残す。接続URL、Script Properties、画像・SpreadsheetのIDは維持し、初期設定は再実行しない。

### Drive APIを有効にして再デプロイする

1. GASで上の追加・置換を行い、保存する。
2. エディタ左の「サービス」に **Drive** があり、APIバージョンが **v3** であることを確認する。
   マニフェスト更新で追加される。表示されない場合は「サービス」の「＋」からGoogle Drive APIを選び、v3・識別子Driveで追加する。
3. Apps Scriptの既定のCloudプロジェクトなら、対応APIはサービス追加時に自動で有効になる。
   標準のGoogle Cloudプロジェクトに切り替えてある場合だけ、そのプロジェクトのGoogle Drive APIも有効にする。
4. 既存デプロイを新バージョンへ更新する。スコープは従来のdriveのままで、Spreadsheet・Driveの共有は変更しない。
5. HPのrpc.jsを配信して公開カタログを再読み込みする。

参考: [高度なGoogleサービスの有効化](https://developers.google.com/apps-script/guides/services/advanced)、
[Driveサービス](https://developers.google.com/apps-script/advanced/drive)。

### 確認する

同じConsoleコマンドで再計測する。

```js
JSON.stringify(await hfPerformance.measureImages(), null, 2)
```

- 画像読取のstages.driveMetadataApiが2回なら、フォルダ・画像をそれぞれ1回のAPI要求で確認した経路。
- 画像読取でdriveMetadataLegacyだけが出る場合、従来経路で動作している。最新デプロイのDriveサービスとマニフェストを確認する。
- APIサービスが未有効なら従来経路へ戻る。有効なAPIからのエラーや必要情報の欠落は、確認を省略して続行しない。
- カタログを再構築した際、同じ正本読取の結果でGAS内部の画像索引も作る。保持されていれば最初の画像要求にsheetReadは出ない。
  その分の索引作成・キャッシュ保存時間はカタログ側のimageIndexSeedに含まれる。追加のSheets読取は行わない。
- 小画像の2回目は、共有画像キャッシュが保持されていればdriveReadが消える。毎回の現在の公開判定とDrive確認は残る。

APIで取得する情報は、所有者・共有・権限一覧・ゴミ箱状態・保存先・更新日時・種類に限定する。
所有者本人の単独所有、所有者以外の権限なし、非共有・非ゴミ箱、画像の保存先一致を必要とする。
共有ドライブ、ショートカット、必要な権限情報が返らないケースも拒否する。内容のHMAC・容量検証は維持する。
権限・Drive IDはGAS内部だけで扱い、公開カタログへ渡さない。
画像の登録処理は今回の高速API経路へ切り替えていない。登録の速度は別のログで確認する。

根拠: [Drive files.get](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get)、
[Fileのpermissions・ownedByMe等](https://developers.google.com/workspace/drive/api/reference/rest/v3/files)。

## 画像表示・画像登録を計測する（今回）

カタログの追加高速化はいったん区切る。画像の実測に必要なブラウザー側の記録を追加した。
今回はGASのプログラム・接続設定・共有状態を変更しない。

| 配置先 | 置換するファイル |
| --- | --- |
| GitHub Pages | docs/rpc.js、docs/app.js、docs/exhibitor/index.html |

HPの3ファイルを配信してから対象ページを再読み込みする。GASの再デプロイは不要。
HF_PERFORMANCEは `true` のまま使う。接続URLやScript Propertiesを追加変更する必要はない。

### 公開画像の取得・復号を比較する

公開カタログのページで、Consoleに次を入力する。

```js
JSON.stringify(await hfPerformance.measureImages(), null, 2)
```

公開中の最初の画像1点について、一覧用・拡大用を順に2回ずつ読み、ブラウザーで復号する。
カタログ取得1回と画像取得4回だけで、プロフィール・画像の保存・削除・共有変更は行わない。
結果は画像内容・ファイル名・画像ID・Drive URL・メール・認証トークンを含まない。

- imagesFoundが0なら公開対象に画像がない。通常の編集・運営画面で公開画像を用意してから確認する。
- 各measurementのdetails.passが1回目／2回目、variantがthumbnail／fullを示す。
- bytesは受信した画像バイト数。rpcMsは画像要求の往復、unpackMsはBase64からBlobへ展開する時間、decodeMsはブラウザーで復号する時間。
- serverMsとstagesは既存のGAS計測。driveMetadata、driveRead、sharedImageCache等からサーバー内の待ちを区別する。
- このコマンドはブラウザー内の画像保存を経由せずGASを呼ぶ。既存の画像キャッシュは削除しない。GAS側の共有キャッシュは利用され得る。
- 1回目でもGAS側が既に温まっている場合がある。pass=1をキャッシュなしと断定しない。
- 画面外の画像要素で復号を測るため、スクロール・一覧の待機列・実際の描画完了までの時間は含まない。
- 画像の復号に対応しないブラウザーや取得失敗時は、成功値を作らずエラーにする。

### 通常表示とブラウザー内キャッシュを調べる

通常どおり一覧をスクロールし、画像を押して拡大した後に次を実行する。

```js
JSON.stringify(hfPerformance.snapshot(), null, 2)
```

| operation・details | 意味 |
| --- | --- |
| imageLoad / source=memory | 同じページ内で取得済みの画像を再利用 |
| imageLoad / source=inflight | 既に進行中の同じ画像要求の結果を待った |
| imageLoad / source=browser | 前回までのブラウザー保存画像を再利用 |
| imageLoad / source=gas | GASへ要求して取得。時間には待機列も含む |
| imageQueue | 同時実行枠が空くまで待った時間 |
| imageUnpack | 画像のBase64をブラウザー内でBlobへ展開した時間 |
| imageReady | 画像取得開始または拡大クリックから復号完了まで。画面切替・拡大を閉じた後の完了は除外 |

imageReadyは画像を表示可能になった時点で、ブラウザーの描画完了を厳密に測るものではない。
画像がブラウザー内から表示された場合も記録が残るので、GASの画像要求がないことを「画像未表示」と判断しない。
計測値の区間は入れ子になるため足し合わせない。

### 登録を測る

1. HPの出店者画面でログインした後、Consoleで `hfPerformance.clear()` を実行する。
2. 実験用の作品で画像を1点選択し、プレビューを確認して仮保存する。その後、必要な最終保存を行う。
3. `JSON.stringify(hfPerformance.snapshot(), null, 2)` の結果を確認する。

imagePrepareは選択画像の読込・調整・小画像作成の時間。detailsには元画像sourceBytes、調整後bytes、小画像thumbnailBytes、主画像の圧縮試行回数encodesを記録する。
stagePublicationImageはGASへの画像登録要求。imageValidate／thumbnailValidate／driveSave／imageCommit等はサーバー内の区間。
imageUploadは「この画像を登録」を押してから仮保存成功・作品欄の再構築まで。画像選択後に利用者が確認している時間は含めない。
imageUploadにはピクセルの復号・描画完了は含めず、結果未確認・失敗時は成功として記録しない。

まず取得元・容量・往復時間・サーバーの各区間を比較して、次の最適化対象を選ぶ。
今回は計測の整備であり、実GAS・実ブラウザーでの画像速度が改善したという測定結果ではない。
参考: [画像のdecode()](https://developer.mozilla.org/en-US/docs/Web/API/HTMLImageElement/decode)。

## カタログの共有キャッシュ診断を反映する（今回の追加修正）

60秒以内の再表示でもcatalogBuildが残る場合の切り分けと、小さいカタログの保存処理の簡素化を追加した。
現行ログでは例外・未保存・期限切れ等を区別できず、実環境の原因はまだ確定していない。

| 配置先 | 置換するファイル |
| --- | --- |
| GAS | PublicCache.gs、Performance.gs、Code.gs |
| GitHub Pages | docs/rpc.js |

GASの3ファイルを更新して既存デプロイを新バージョンへ更新した後、HPのrpc.jsを配信する。
前回までの他のファイル・接続URLは維持。HF_PERFORMANCEは `true` のまま使う。新たな設定値は不要。
小さい公開JSONは1項目に保存し、大きいデータのみ分割保存する。旧分割形式も読み出せる。

HPを再読み込みした後、同じページのConsoleで以下を実行する。カタログの公開情報を読むだけで保存はしない。

```js
hfPerformance.clear();
await hfRpc('getPublicCatalog');
await hfRpc('getPublicCatalog');
hfPerformance.snapshot();
```

2回目の `cache` と `stages` を確認する。キー・画像・認証情報・生の例外文は診断へ出さない。

| cache内の値 | 意味 |
| --- | --- |
| jsonHit | 既存のキャッシュを利用した |
| jsonMiss | メタデータがなかった。初回・期限切れ・早期消失・保存等による世代変更の可能性があり、これだけで原因確定はできない |
| jsonStored | 保存APIが例外なしで完了した |
| jsonWriteVerified | 計測時の確認で、保存直後にメタデータを読み出せた |
| jsonWriteMissing | 保存APIは完了したが、直後の確認では読み出せなかった |
| jsonWriteError | 保存APIで例外が発生した |
| jsonReadError / jsonReadbackError | 通常の読取／保存直後の読取確認で例外が発生した |
| jsonPartial / jsonInvalid / jsonOversize | 分割データの一部欠落／形式不正／対応する保存容量の超過 |

`cacheWrite` は共有JSONの保存と、計測有効時だけ行う直後の読取確認の時間。
2回目がjsonHitでcatalogBuildがなければキャッシュ利用を確認できる。サービスの保持自体は保証されず、消失時は正本へ戻る。
参考: [Google Cache Service](https://developers.google.com/apps-script/reference/cache/cache-service)、
[保存制限・保持期間](https://developers.google.com/apps-script/reference/cache/cache)。

## カタログ・登録速度とプレビューの改善を反映する（今回）

HP移行・前回の画像表示高速化を反映済みの環境では、次を配置する。
接続先URL、秘密値、既存のデータ・IDは維持する。Sheetsの初期化は再実行しない。

| 配置先 | ファイル | 操作 |
| --- | --- | --- |
| GAS | gas/Performance.gs → Performance | **スクリプトを追加**。要求内の設定・読取の再利用と計測 |
| GAS | gas/PublicCache.gs → PublicCache | **スクリプトを追加**。GAS内の共有キャッシュ |
| GAS | gas/Code.gs → Code | **置換**。登録の二段階処理・本人用小画像取得・計測 |
| GAS | gas/Store.gs → Store | **置換**。一括読取・キャッシュ世代の更新 |
| GAS | gas/AdminConsole.gs → AdminConsole | **置換**。開催設定の要求内再利用・一括読取 |
| GAS | gas/Publishing.gs → Publishing | **置換**。出店者一覧の一括読取 |
| GAS | gas/PublicCatalog.gs → PublicCatalog | **置換**。公開カタログ・画像索引の共有キャッシュ |
| GAS | gas/Images.gs → Images | **置換**。登録予約・ロック外の変換／保存・小画像キャッシュ |
| Pages | docs/rpc.js | **置換**。ブラウザー側の処理時間記録 |
| Pages | docs/app.js | **置換**。代表画像の優先取得・拡大時の先行表示 |
| Pages | docs/exhibitor/index.html | **置換**。プレビュー保持・小画像自動表示・画像調整 |

Auth.gs、Profile.gs、Admin.gs、Transport.gs、Bridge.html、旧Index.html／AdminIndex.html、appsscript.jsonは継続使用する。
権限追加は不要。GASの全ファイルを配置して既存デプロイを新バージョンへ更新し、その後HPの3ファイルを配信する。
docs/connection.jsにある実験用GAS URLは変更しない。
配信完了後、利用中のページを再読み込みする。古いJavaScriptが残る場合は強制再読み込みで確認する。

### 時間を確認する

計測を有効にする場合だけ、Script Propertiesに `HF_PERFORMANCE` = `true` を追加する。
各応答に、GAS処理全体と固定した処理区間のミリ秒・回数だけを付ける。入力・認証情報・画像・ID・URLは記録しない。
無効化は値を `false` にするかプロパティを削除する。無効時も機能は使える。

HPの対象ページで操作した後、開発者ツールのConsoleで次を実行すると直近100件までの計測値を確認できる。

```js
hfPerformance.snapshot()
```

記録を消す場合は `hfPerformance.clear()`。Consoleへ自動出力したり、外部へ計測値を送信したりはしない。

| 値・区間 | 意味 |
| --- | --- |
| bridge / elapsedMs | iframe接続準備。ページを再読み込みすると再計測 |
| 各API / elapsedMs | 接続準備後のGAS要求から応答まで |
| serverMs | GAS関数に入ってから応答を作るまで |
| sheetRead / sheetWrite | Sheets一括読取／書込・flush。countは区間実行回数 |
| lockWait / lockHeld | 共通ロックの取得待ち／保持中。保持時間には内部処理も含まれる |
| imageValidate / thumbnailValidate | 画像／小画像のサーバー変換検証 |
| driveSave / driveRead | Driveファイル作成・再利用／バイト読取 |
| driveMetadata | フォルダ・ファイルの非公開状態、保存先、更新日時の確認 |
| catalogBuild / catalogCache / sharedImageCache | カタログ構築／共有キャッシュの参照 |
| imagePrepare | ブラウザー側の画像読込・圧縮・小画像作成 |
| catalogPaint | DOMを作成する処理。ブラウザーの実描画完了時刻ではない |

区間は入れ子なので合計しない。elapsedMsとserverMsの差には通信・Google側の起動や処理待ち等も含まれ、通信時間だけとは断定しない。
初回・再読み込み後・画像登録時を分けて確認する。公開カタログでcatalogBuildがなくcatalogCacheだけなら、共有キャッシュを利用した応答。
ローカルの模擬時計はGoogleの実時間を測れない。テスト成功や0msを実環境での速さの証明としない。

### 今回の動作と確認点

- カタログは最大10組でも設定・出店者シートの一括読取2回で構築する。共有キャッシュ命中時はSheetsを読まない。
- カタログと公開画像索引の共有キャッシュは最大60秒。ただしアプリからの保存前に世代を変え、保存成功後の取得に旧版を使わない。
  世代変更に失敗した場合は保存前に停止する。キャッシュ自体の消失・障害・容量超過は正本読取へ戻る。
- **Sheetsを直接手編集した内容は、キャッシュ期限まで最大60秒残る場合がある。** 日常操作はHPの編集・運営画面を使う。
- 小画像の共有キャッシュも、現在の公開対象・Driveの非公開状態・保存先・更新日時を確認してから使う。非公開化でキャッシュ画像を新たに取得できない。
- 最初の代表画像2枚は各1枚ずつ先に要求し、後続は最大3枚ずつ。拡大時は小画像を先に表示して高画質画像を待つ。
- 新規アップロードの小画像は長辺240px・30KB以内。サーバーは旧400px・120KBの画像も受け付ける。既存画像を自動変換はしない。
- JPEG入力はJPEGを先に圧縮し、PNG等はPNGを優先する。元画像の容量・画素数、調整後1.5MBの制限とサーバーでの実変換検証は維持する。
- 仮保存中は選択画像を表示し続け、仮保存成功後・最終保存後も作品欄にプレビューを残す。再読込時は本人用の小画像を位置に応じて自動取得する。
- 登録は短い予約、ロック外の変換・Drive保存、短い最終確定に分ける。最終確定で本人・停止・所属・締切・更新番号・容量・再送を再検証する。
- 同じ出店者の登録処理は1件ずつ。強制終了で予約が残った場合は10分で失効する。確定済みの同じ要求は予約より先に結果確認する。
- `HF_PUBLIC_GENERATION` と `HF_UPLOAD_…` は自動管理のScript Properties。手入力・共有・処理中の削除は不要。

確認は、カタログ初回／再表示、画像登録前後のプレビュー、画像差し替え、他画面からの競合、編集終了後、運営の非公開化を含める。
GASを経由する初回接続の待ち時間は残る。実環境の秒数は、この反映後の計測で確認する。

## 画像表示の高速化を既存環境へ反映する

以下は前回分。上の今回手順を済ませた環境では、古いファイルへ戻さない。

HP移行済みの環境は、次のファイルだけを更新する。

| 配置先 | 置換するファイル |
| --- | --- |
| GAS | Code.gs、PublicCatalog.gs、Images.gs、Bridge.html |
| GitHub Pages | docs/app.js |

GASは各ファイルを置き換えて既存デプロイを新バージョンへ更新し、その後HPのapp.jsを配信する。
新しいHPから追加APIを使うため、GAS側の更新を先に行う。設定値の追加・初期化・権限追加は不要。
docs/connection.jsに設定済みの接続URLは維持する。

一覧画像を最大3枚ずつ取得し、Sheetsの一覧読取と公開対象の確認を共有する。
Drive読取は共通ロックの外で実行するため、別の画像読取や保存を長時間待たせない。
公開判定は各要求の開始時点で行い、その後非公開化されても既に開始した応答を回収する仕組みではない。

取得した画像をブラウザーのCache Storageにも保存し、次回の表示で再利用する。
カタログと公開対象は毎回取得し直す。画像の追加・差し替えは新しいIDになるため旧画像と混同しない。
保存先GAS URLと画像ID・種類で区別し、有効期間は7日、小画像160点・拡大画像8点まで。
小画像として120KBを超える旧画像は永続保存しない。保存機能が制限されるブラウザーでも通常取得は続ける。
一度表示済みの公開画像はブラウザー内に残る場合がある。非公開化は既に渡ったデータの回収ではない。

反映後は初回表示と再読み込み後を比べ、一覧・拡大・画像差し替え・非公開化も確認する。
初回のGAS起動・Drive読取そのものは残る。旧画像にサムネイルがない場合は初回に元画像を取得するため、
その画像をHP編集画面から追加し直して保存すると、400px以下の一覧画像を利用できる。
実環境の秒数による改善幅は未計測。ローカルテストで確認するのは呼出し回数・ロック範囲・キャッシュ動作。

## HP内の画面と自動反映へ移行する

今回はこちらの手順を使う。後半のGAS画面・ZIP手動公開の説明は旧方式の互換用で、通常操作には使わない。
実験専用GAS・Sheets・非公開Driveをそのまま使用し、既存の利用者ID・作品ID・認証秘密値を変更しない。

### 1. GASへ追加・更新するファイル

| repoのファイル | GASでの名前 | 操作 |
| --- | --- | --- |
| gas/Transport.gs | Transport（スクリプト） | **追加**。許可originを検証して通信HTMLを生成 |
| gas/Bridge.html | Bridge（HTML） | **追加**。HPとの通信専用 |
| gas/PublicCatalog.gs | PublicCatalog（スクリプト） | **追加**。保存済みカタログ・公開画像の取得 |
| gas/Code.gs | Code | **置換**。bridge入口・公開取得・仮保存API |
| gas/Profile.gs | Profile | **置換**。仮保存画像を含む最終保存 |
| gas/Images.gs | Images | **置換**。画像・サムネイルの非公開仮保存 |
| gas/Publishing.gs | Publishing | **置換**。公開項目の選別処理をライブ取得と共用 |
| gas/Store.gs / Auth.gs / Admin.gs / AdminConsole.gs | 各同名 | 継続使用。未配置・古い場合はrepo版を配置 |
| gas/Index.html / AdminIndex.html | 各同名HTML | 旧画面の互換用。通常はHPの画面を使う |
| gas/appsscript.json | appsscript.json | 今回の権限追加なし。既存のSheets・メール・Drive権限を維持 |

Transportはスクリプトファイル、BridgeはHTMLファイルとして追加する。
tests/ は配置しない。既存のデータ行やシートを削除・初期化し直さない。
Admins・AdminSessions・EventSettingsが未作成の場合だけ、後半「運営画面を既存環境へ追加する」の初回設定を先に行う。

### 2. Script Propertiesを1件追加

`HF_FRONTEND_ORIGINS` に、HPの**originだけ**のJSON配列を指定する。

```json
["https://kleaex.github.io"]
```

`/hf_test/` 等のパスや末尾の `/` は付けない。ローカルから実GASを確認する場合だけ、使用するoriginも追加する。

```json
["https://kleaex.github.io","http://127.0.0.1:8080"]
```

`localhost` と `127.0.0.1`、ポート違いは別origin。必要なものだけを登録する。
同じGitHub Pages origin上の別ページとはブラウザー上の権限境界を分けられない。許可するoriginの管理下にあるページを信頼する構成である。
HF_AUTH_SECRET等の既存値は維持する。HF_EXPORT_FOLDER_IDは旧ZIP書き出しを使う場合だけ必要で、自動反映には不要。
HF_EDIT_DEADLINE・旧HF_PUBLICATION_CONFIG_JSONは初期移行用。EventSettings作成後の日常設定はHPの運営画面で行う。

### 3. GASを新しいバージョンへ更新

「デプロイ → デプロイを管理 → 編集 → 新バージョン → デプロイ」。
実行するユーザーは所有者の「自分」、アクセスできるユーザーはGoogleログインを求めない「全員」。
アプリ自身が出店者・運営のメール確認とセッション検証を行う。Spreadsheet・Driveのリンク共有は制限付きのまま。
更新後の `/exec` URLを確認する。既存デプロイの更新なら通常はURLを維持できる。`/dev` URLは使用しない。

### 4. HPの接続設定とファイルを配信

`docs/connection.js` の空欄に、この実験用GASの `/exec` URLを設定する。

```js
window.HF_CONNECTION = Object.freeze({ gasUrl: 'https://script.google.com/macros/s/実際のデプロイID/exec' });
```

このURLは公開可能な通信先。認証秘密値・Spreadsheet ID・Drive ID・メール宛先を記載しない。
次のファイルをすべてPagesへ配信する。

| ファイル | 操作 |
| --- | --- |
| docs/connection.js | **追加・接続URL設定** |
| docs/rpc.js | **追加**。非表示iframe経由の通信 |
| docs/exhibitor/index.html | **追加**。出店者画面 |
| docs/admin/index.html | **追加**。運営画面 |
| docs/index.html | **置換**。共通通信の読込とHP内リンク |
| docs/app.js | **置換**。ライブカタログ・画像取得・HP内拡大 |
| docs/catalog-schema.mjs | **置換**。ライブ／保存版を別条件で検証 |
| docs/styles.css | **置換**。画像拡大表示 |
| docs/data/catalog.json | 未接続時のサンプルとして維持 |

ローカル確認後、変更をコミット・pushし、Pages配信完了を確認する。この初回配信は必要。
以降、出店者のデータ保存・運営設定の変更にpushは不要。プログラム自体の修正には引き続きGAS・Pages両側の更新が必要。

### 5. HPから動作確認

1. `https://kleaex.github.io/hf_test/admin/` で運営としてログインし、公開対象と編集期限を確認して設定を保存する。
   旧設定の公開対象を引き継ぐ。未選択の出店者を自動的に全公開しない。
2. `/hf_test/exhibitor/` で本人としてログインする。旧GAS画面のログインはHPへ自動移行しないため、初回は再ログインする。
3. 作品と文章を入力し、画像を選択→見え方を確認→仮保存する。新規作品も同じ流れで扱える。
   この段階ではカタログへ出ない。仮保存した画像も、最後の「保存して公開」を押す。
4. `/hf_test/` を再読み込みし、保存内容と画像が反映されたことを確認する。承認・ZIP取得は不要。
5. 画像を押し、HP内で拡大→閉じる。GAS・Driveのページへ移動しないことを確認する。
6. 編集画面再読み込みでログイン復元、別出店者からの更新拒否、編集期限後の変更拒否も確認する。
7. 運営画面で非公開にして保存し、次回の公開取得で対象・画像を取得できなくなることを確認する。
   既に閲覧者へ渡った画像・開いている画面の表示は遡って回収できない。

接続失敗時は、HF_FRONTEND_ORIGINSの値、接続URL、最新バージョンの配置、Webアプリのアクセス設定を確認する。
接続準備は30秒、各要求は60秒で結果未確認として案内する。保存が未確認なら同じ要求で再試行する。
Googleの実iframe／ブラウザーの制限で接続できない場合、`no-cors`で成功扱いにせず、この移行の実環境確認は未完了とする。

既存画像にはサムネイルがないため、次の差し替えまでは元画像を遅延取得する。新たに追加した画像から小画像を利用する。
仮保存は24時間有効・出店者ごと10点まで。最終保存時に1作品3点を検証する。
仮保存期限切れや削除済みのDriveファイルを一括削除する機能は未実装。非公開のまま残り、公開APIからは取得できない。
旧ZIPを公開した履歴がある場合、その静的画像・Git履歴は今回の非公開化では消えない。必要な撤回は別途扱う。

仕様上の根拠: [GASのiframe許可設定](https://developers.google.com/apps-script/reference/html/x-frame-options-mode)、
[postMessageのorigin/source照合](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage)。

## 静的カタログ
READMEのローカル起動で確認し、Pagesを有効にする場合は main /docs を配信する。
公開ファイルは docs/ に限定する。設計資料は design/ に置く。

## GAS・Sheetsを新規作成する

1. 運営のGoogleアカウントで空のSpreadsheetを新規作成し、「即売会・実験用」などの名前を付ける。
   リンク共有は「制限付き」のままとし、出店者へ共有しない。本番ファイルを指定しない。
2. 新しい独立したApps Scriptプロジェクトを作る。
3. gas/ の全.gsファイル（Code、Store、Auth、Profile、Admin、Images、Publishing、AdminConsole、Transport、PublicCatalog）を同名のスクリプトファイルに貼る。
   Bridge.htmlはHTMLファイルBridge、Index.htmlはHTMLファイルIndex、AdminIndex.htmlはHTMLファイルAdminIndexに貼る。古い疎通確認用コードは置き換える。
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
