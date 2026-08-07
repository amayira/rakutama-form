# CLAUDE.md — rakutama-form

楽珠そろばん教室のFC加盟店向け申込フォーム。GitHub Pages（amayira/rakutama-form・mainブランチ自動公開）で `form.rakutama-soroban.com` に配信。

---

## 構成の要点

- 加盟店ごとにフォルダを切る（`/koyomi`＝KOYOMI、`/moderato`＝株式会社モデラート）。ルート直下のフォームは東京直営用の旧配置。
- 組織判定はURLのフォルダ名で行う：`js/franchise.js` の `PATH_ORG_MAP`（フォルダ名→kintone組織コード）。
- 加盟店フォームは**新規向けのみ**（`taiken.html`・`nyukai.html`・`index.html` の3枚）。在学生向けフォームは置かない。
- API は Cloudflare Workers（`https://rakutama-kintone.k-ariyama.workers.dev`）経由で kintone に読み書きする。

## ⚠️ worker.js について

このリポジトリ直下の `worker.js` は**参照コピー**。正（デプロイ元）は別リポジトリ `~/dev/rakutama-lp-tokyo/form/worker.js`。API仕様・トークン・kintoneフィールド仕様もそちらの CLAUDE.md が正。**加盟店追加では worker を触らない**（読み取りAPIは組織コード非依存・CORS許可済み）。

## 新規加盟店の追加

手順書 [ADD_FRANCHISE.md](ADD_FRANCHISE.md) に従う。要点：既存加盟店フォルダを複製 → `PATH_ORG_MAP` に1行追加 → kintone教室マスタ（App5）に組織・開校日つきで教室登録 → git push。授業マスタ（App6）のクラス登録は加盟店側の作業。

## デプロイ

`git push origin main` → GitHub Pages に自動反映。worker の変更が必要になった場合のみ rakutama-lp-tokyo 側で `wrangler deploy`。
