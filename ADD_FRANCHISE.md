# 加盟店（FC）フォームの追加手順

`form.rakutama-soroban.com` 配下に加盟店ごとのフォルダ（例: `/koyomi`, `/moderato`）を置き、
各加盟店の教室・クラス・月謝を kintone から組織別に動的取得して表示する仕組み。

このドキュメントは **新しい加盟店を1つ追加する**ための手順書。Claude Code に本ファイルを読ませれば、
誰でも同じ手順で追加できる。

---

## 0. 前提：仕組みの要点（先に読む）

- **このリポジトリ（amayira/rakutama-form）** = 加盟店フォーム本体。GitHub Pages で `form.rakutama-soroban.com` に自動公開。
- **組織の判定はフォルダ名で行う**。URL先頭のフォルダ名 → kintone組織コードを [`js/franchise.js`](js/franchise.js) の `PATH_ORG_MAP` で対応づける。
- 各フォームは以下のkintone APIを叩く（Cloudflare Workers 経由。エンドポイントは `https://rakutama-kintone.k-ariyama.workers.dev`）：
  - `GET /api/classrooms?orgCode=<組織>` … 教室マスタ(App5)から**開校日ありの教室のみ**
  - `GET /api/gakuhi?orgCode=<組織>` … 月謝マスタ(App10)
  - `GET /api/jugyo?classroom=<教室名>` … 授業マスタ(App6)のクラス
- **Worker のデプロイは不要**。読み取りAPIは任意の組織コードを受け付け、CORSは同一ホスト（`form.rakutama-soroban.com`）で許可済み、入会の組織スタンプはフォームが送る `所属組織` で決まる（すべて加盟店非依存）。
  - Worker本体（正）は別リポジトリ `amayira/rakutama-lp-Tokyo` の `form/worker.js`。**加盟店追加では触らない**。
- 加盟店フォームは**新規向けのみ**（体験 `taiken.html`・入会 `nyukai.html`・メニュー `index.html` の3枚）。在学生向けフォームは含めない。

---

## 1. 必要な情報（依頼者に確認する）

| 項目 | 例 | 用途 |
|------|-----|------|
| **フォルダ名（URLスラッグ）** | `moderato` | `form.rakutama-soroban.com/moderato/`。英小文字推奨 |
| **kintone組織コード** | `モデラート` | 教室・月謝マスタの「組織選択／所属組織」の値と**完全一致**させる |
| **加盟店名（運営会社名）** | `株式会社モデラート` | フッターの「運営会社：〇〇」表示 |

> ⚠️ フォルダ名と組織コードは**別物**（フォルダは英小文字スラッグ、組織コードはkintoneの実値）。混同しない。

---

## 2. 実装手順（コード側）

以下は例として `フォルダ名=moderato / 組織コード=モデラート / 運営会社=株式会社モデラート` を追加する場合。
`<folder>` `<org>` `<company>` を実際の値に置き換える。

### 2-1. 既存の加盟店フォルダを複製する

```bash
cd rakutama-form
cp -r koyomi <folder>          # 例: cp -r koyomi moderato
```

> `koyomi` は雛形として複製元にする（`moderato` など既存の他店でも可）。中身は index / taiken / nyukai の3枚。

### 2-2. フッターの運営会社名を書き換える

複製直後は複製元の会社名（例: `運営会社：KOYOMI`）が入っているので、3ファイルとも置換する。

```bash
# 複製元がkoyomiの場合
sed -i '' 's/運営会社：KOYOMI/運営会社：<company>/g' <folder>/index.html <folder>/taiken.html <folder>/nyukai.html
# 例: sed -i '' 's/運営会社：KOYOMI/運営会社：株式会社モデラート/g' moderato/index.html moderato/taiken.html moderato/nyukai.html
```

確認：

```bash
grep -rn "運営会社" <folder>/          # 3ファイルとも新しい会社名になっていること
grep -rni "koyomi" <folder>/           # 複製元の名残が無いこと（該当なしが正常）
```

### 2-3. `js/franchise.js` の `PATH_ORG_MAP` に1行追加

[`js/franchise.js`](js/franchise.js) を開き、`PATH_ORG_MAP` に「フォルダ名: '組織コード'」を足す。

```js
const PATH_ORG_MAP = {
  koyomi: 'KOYOMI',
  moderato: 'モデラート',
  // <folder>: '<org>',   ← ここに1行追加
};
```

構文チェック：

```bash
node --check js/franchise.js
```

### 2-4. これで完了（フォーム側の修正はこれだけ）

教室・クラス・月謝はすべて `PATH_ORG_MAP` の組織コードで自動取得されるため、HTMLの中身を触る必要はない。

---

## 3. 検証（push前）

### 3-1. 組織コードが正しいか（ライブWorkerで確認）

月謝が返れば組織コードは正しい。教室は「開校日あり」がまだ無ければ空（それは正常、`4.` で登録する）。

```bash
# <org> は日本語ならURLエンコードして渡す。-G + --data-urlencode が簡単
curl -s -G "https://rakutama-kintone.k-ariyama.workers.dev/api/gakuhi" --data-urlencode "orgCode=<org>"
curl -s -G "https://rakutama-kintone.k-ariyama.workers.dev/api/classrooms" --data-urlencode "orgCode=<org>"
```

- `gakuhi` が `{"success":true,"fees":[...]}` で**コース名が返る** → 組織コードOK。
- 空配列や別組織のデータが返る → 組織コードの綴りが違う。`2-3` を見直す。

### 3-2. ブラウザで組織判定・表示を確認（任意）

ローカル配信して `http://localhost:8788/<folder>/taiken.html` を開く。
※ ローカルからのAPI呼び出しはCORSで弾かれる（許可オリジンが本番ドメインのみ）ため、**教室が空でも異常ではない**。組織判定とフッターだけ見る。

```bash
python3 -m http.server 8788 --directory rakutama-form
```

ページのコンソールで `ORG_CODE` が `<org>` になっていること、フッターに「運営会社：<company>」が出ることを確認。

---

## 4. kintone側のデータ登録（依頼者／管理者の作業）

コードを公開しても、kintoneにデータが無ければフォームは空になる。以下を登録する。

| アプリ | 登録内容 | 必須ポイント |
|--------|---------|-------------|
| **App5 教室マスタ** | その加盟店の教室 | `組織選択 = <org>` かつ **`開校日` を入力**（空だとフォームに出ない）。`開校状況` に「閉」を含めない |
| **App6 授業マスタ** | 各教室のクラス（曜日・開始時刻） | `教室名` を上記教室にひも付け。`開講状況 = 開講中` |
| **App10 月謝マスタ** | 月謝コース | `所属組織 = <org>` |

> **教室が出ない時の典型原因は「開校日の未入力」**。開校日を入れると自動でドロップダウンに反映される（コード修正不要）。

---

## 5. コミット & 公開

```bash
cd rakutama-form
git add js/franchise.js <folder>/
git commit -m "加盟店追加: <folder>（<company> / 組織コード <org>）"
git push origin main
```

`git push` で GitHub Pages が自動公開 → `https://form.rakutama-soroban.com/<folder>/` で利用可能。

---

## 6. チェックリスト（この順で確認）

- [ ] `<folder>/` に index / taiken / nyukai の3枚がある
- [ ] 3枚のフッターが「運営会社：<company>」になっている
- [ ] 複製元の会社名・スラッグの名残が残っていない
- [ ] `js/franchise.js` の `PATH_ORG_MAP` に `<folder>: '<org>'` を追加した
- [ ] `node --check js/franchise.js` が通る
- [ ] `curl .../api/gakuhi?orgCode=<org>` でコース名が返る（組織コード一致）
- [ ] kintone: App5に「組織選択=<org>・開校日あり」の教室、App6にクラス、App10に月謝を登録
- [ ] `git push origin main` 済み
- [ ] `https://form.rakutama-soroban.com/<folder>/` で教室が表示される

---

## 補足：ドメインを別サブドメインにする場合（通常は不要）

同一ホスト `form.rakutama-soroban.com` の配下に置く限り、CORS設定の変更は不要。
もし新しいサブドメイン（例: `lp.rakutama-soroban.com`）で公開したい場合のみ、
別リポジトリ `amayira/rakutama-lp-Tokyo` の `form/worker.js` の `ALLOWED_ORIGINS` に
そのオリジンを追加し、`wrangler deploy` が必要になる。
