# 文芸同人誌即売会システム（実験用）

KLEAの既存サイト・KHBとは独立した試作です。実在の個人情報・本番の接続先・秘密情報は使いません。

## 現在できること
- 架空の出店者2組・頒布物4点の公開カタログ表示
- 出店名・作品名・紹介文の検索、ジャンル絞り込み
- 画像未登録時の代替表示
- GAS HTML Serviceの画面表示・サーバー疎通確認（手動配置後）

申込保存、本人確認、編集権限、画像アップロード、Sheets連携、公開同期は未実装です。
GASへの書き込み入口は、認証実装まで拒否します。静的カタログはサンプルJSONを読みます。

## ローカル確認
Node.jsがある環境で、このrepo内から実行します。追加パッケージのインストールは不要です。

    node scripts/serve.mjs

http://127.0.0.1:8080/ を開きます。file:// での直開きはJSON読込が動かないため避けます。

## GitHub Pages
Settings → Pages → Deploy from a branch → main /docs を選択します。
公開URL: https://kleaex.github.io/hf_test/

コード作成だけでは公開されません。コミット・pushとPages設定が必要です。
このひな形では外部への送信、メール、アップロードを行いません。

## 配置
- docs/: Pagesに配信するHTML/CSS/JS・公開サンプルJSONのみ
- gas/: GASの手動配置用ソース
- design/: 要件・実装方針・試験手順

公開repoなので、gas/とdesign/もソースとして一般に閲覧できます。
秘密値や実データはrepoのどの場所にも保存しません。
GAS設定手順は design/SETUP.md、検証項目は design/TEST_PLAN.md を参照してください。
