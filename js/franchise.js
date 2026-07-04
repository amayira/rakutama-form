// ─────────────────────────────────────────────────────────────────────────────
// 加盟店（FC）共通ロジック
//   form.rakutama-soroban.com 配下に加盟店ごとのフォルダを置き、
//   フォルダ名から kintone の組織コードを決定する。
//   各フォーム（体験・入会）は、インラインスクリプトより前にこれを読み込む：
//     <script src="/js/franchise.js"></script>
//
//   ★ 新しい加盟店を追加する手順
//     1. 既存の加盟店フォルダ（例: /koyomi）をフォルダごと複製し、フォルダ名を変える
//     2. 下の PATH_ORG_MAP に「フォルダ名: 'kintoneの組織コード'」を1行足す
//     3. 各HTMLのフッターの「運営会社：〇〇」をその加盟店名に書き換える
//     4. kintone 教室マスタ(App5)に「組織選択=その組織・開校日あり」の教室を登録
//   → 教室・クラス・月謝はフォーム無修正で自動反映される。
// ─────────────────────────────────────────────────────────────────────────────

const API_BASE = 'https://rakutama-kintone.k-ariyama.workers.dev';

// 加盟店フォルダ名 → kintone 組織コード
const PATH_ORG_MAP = {
  koyomi: 'KOYOMI',
  moderato: 'モデラート',
};

// URL 先頭のパスセグメント（/koyomi/taiken.html → "koyomi"）から組織を決める。
// 該当なし（＝ルート直下の従来フォーム）は本部にフォールバック。
const ORG_CODE = (() => {
  const seg = location.pathname.split('/').filter(Boolean)[0] || '';
  return PATH_ORG_MAP[seg] || '本部';
})();

// 教室名 → 開校日（YYYY-MM-DD）。開校日より前の日付をフォーム側でクランプする用。
window.classroomOpenDates = {};

// ── 教室一覧を教室マスタ(App5)から組織別に動的取得して <select> に流し込む ──
// 成功時のみ選択肢を差し替える。失敗時はプレースホルダのまま（誤った教室は出さない）。
async function loadClassroomsInto(selectId) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  try {
    const res = await fetch(`${API_BASE}/api/classrooms?orgCode=${encodeURIComponent(ORG_CODE)}`);
    const data = await res.json();
    if (!res.ok || !data.success || !Array.isArray(data.classrooms)) return;
    sel.innerHTML = '<option value="">選択してください</option>';
    window.classroomOpenDates = {};
    data.classrooms.forEach((c) => {
      const opt = document.createElement('option');
      opt.textContent = c.name;
      sel.appendChild(opt);
      if (c.openDate) window.classroomOpenDates[c.name] = c.openDate;
    });
  } catch { /* 取得失敗時はプレースホルダのまま */ }
}
