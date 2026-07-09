// ─────────────────────────────────────────────────────────────────────────────
// 本部フォーム（form.rakutama-soroban.com ルート直下の体験・入会）用の教室ローダー。
//   教室マスタ(App5)の「非閉校」の教室を /api/all-classrooms から取得して <select> に流し込む。
//   各 <option> に data-org（所属組織コード）を持たせる。
//     - 入会：送信時に選択教室の data-org を「所属組織」として送る
//     - 体験：教室名ルックアップで所属組織が自動転記されるため org 送信は不要
//   この方式なら、新しい教室・加盟店は教室マスタに登録するだけでフォームに反映される。
//
//   表示は「都道府県」ごとに <optgroup> でまとめる（オンライン→兵庫→大阪→その他の順）。
//   都道府県は教室マスタの「都道府県」フィールド由来（/api/all-classrooms の pref）。
//
//   loadHqClassrooms(selectId, opts)
//     opts.onlyOrg    … 指定した組織コードの教室だけに絞る（例：入会は本部のみ）。
//     opts.activeOnly … 授業マスタに「開講中」クラスがある教室だけに絞る（入会用。
//                       クラス未登録の行き止まり教室を隠す）。取得失敗時は絞らない。
// ─────────────────────────────────────────────────────────────────────────────

// 都道府県ごとにグループ化する。先頭の優先順（オンライン→兵庫県→大阪府）だけ固定し、
// それ以外の都道府県はその後ろに続く（並び順は不問）。空欄は「その他」に集約。
// 値は教室マスタ「都道府県」フィールドの実値に合わせる（兵庫県／大阪府と県・府つき）。
const PREF_ORDER = ['オンライン', '兵庫県', '大阪府'];
function prefRank(p) { const i = PREF_ORDER.indexOf(p); return i === -1 ? PREF_ORDER.length : i; }
function prefLabel(p) { return p || 'その他'; }

// 教室名 → 所属組織コード（入会の所属組織送信・月謝取得に使う）
window.classroomOrgMap = window.classroomOrgMap || {};
// 教室名 → 開校日（YYYY-MM-DD）。日付クランプ用（使う側があれば参照）。
window.classroomOpenDates = window.classroomOpenDates || {};

async function loadHqClassrooms(selectId, opts) {
  const onlyOrg = opts && opts.onlyOrg;
  const activeOnly = opts && opts.activeOnly;
  const sel = document.getElementById(selectId);
  if (!sel) return;
  try {
    const res = await fetch('https://rakutama-kintone.k-ariyama.workers.dev/api/all-classrooms');
    const data = await res.json();
    if (!res.ok || !data.success || !Array.isArray(data.classrooms) || !data.classrooms.length) return;

    // activeOnly: 授業マスタに開講中クラスがある教室名の集合を取得（失敗時は絞らない）
    let activeSet = null;
    if (activeOnly) {
      try {
        const ar = await fetch('https://rakutama-kintone.k-ariyama.workers.dev/api/active-classrooms');
        const ad = await ar.json();
        if (ar.ok && ad.success && Array.isArray(ad.classrooms)) activeSet = new Set(ad.classrooms);
      } catch { /* 取得失敗時は絞らない */ }
    }

    // /api/all-classrooms は閉校を除外済み。onlyOrg・activeOnly でさらに絞る。
    const items = data.classrooms.filter((c) =>
      c.name
      && (!onlyOrg || c.org === onlyOrg)
      && (!activeSet || activeSet.has(c.name))
    );
    items.forEach((c) => {
      window.classroomOrgMap[c.name] = c.org || '本部';
      if (c.openDate) window.classroomOpenDates[c.name] = c.openDate;
    });
    if (!items.length) return;

    const makeOption = (c) => {
      const opt = document.createElement('option');
      opt.value = c.name;
      opt.textContent = c.name;
      opt.dataset.org = c.org || '本部';
      if (c.openDate) opt.dataset.open = c.openDate;
      return opt;
    };

    // 成功時のみ選択肢を差し替える（失敗時はプレースホルダのまま＝誤った教室を出さない）
    sel.innerHTML = '<option value="">選択してください</option>';

    // 都道府県ごとに <optgroup> でまとめる（オンライン→兵庫→大阪→その他）
    const groups = new Map(); // ラベル → { rank, items: [] }
    items.forEach((c) => {
      const label = prefLabel(c.pref);
      if (!groups.has(label)) groups.set(label, { rank: prefRank(c.pref), items: [] });
      groups.get(label).items.push(c);
    });
    [...groups.keys()]
      .sort((a, b) => groups.get(a).rank - groups.get(b).rank)
      .forEach((label) => {
        const og = document.createElement('optgroup');
        og.label = label;
        groups.get(label).items.forEach((c) => og.appendChild(makeOption(c)));
        sel.appendChild(og);
      });
  } catch { /* 取得失敗時はプレースホルダのまま */ }
}
