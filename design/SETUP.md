# 実験環境の設定

## 静的カタログ
READMEのローカル起動で確認し、Pagesを有効にする場合は main /docs を配信する。
公開ファイルは docs/ に限定する。設計資料は design/ に置く。

## GAS疎通確認
1. 実験用の新しいApps Scriptプロジェクトを作る。
2. gas/Code.gs を Code.gs に、gas/Index.html をHTMLファイル Index に貼る。
3. プロジェクト設定でマニフェストを表示し、gas/appsscript.json の内容を設定する。
4. まず自分のみアクセス可能なテスト用Webアプリとして配置する。
5. 発行URLを開き「GASへの接続を確認」を押す。

この段階でSheets・Drive・メールの権限は要求しない。
第三者での本人確認実験は認証実装後にアクセス設定を再検討する。
Session.getActiveUser().getEmail() が常に取得できるとは仮定しない。

## 次段階で用意するもの
- 実験専用Spreadsheetと非公開Driveフォルダ
- テスト宛先制限と実験用認証秘密値
- スクリプトプロパティの設定項目と手順（保存・認証実装時に定義）

本番KHBのSpreadsheet ID、GAS URL、HMAC秘密値は流用しない。
GitHubトークン、メール、セッション、実申込データを公開repoへ保存しない。
claspは未導入。導入時も .clasp.json とログイン情報を追跡しない。
