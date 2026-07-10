// Cloudflare Worker - API Proxy for Rakutama Soroban School Forms
// Bridges static GitHub Pages forms → kintone (cybozu.com)

const KINTONE_BASE = "https://o81m0gfyv532.cybozu.com";

const APP = {
  SEITO: 8,        // 生徒名簿（旧）
  SEIKYUU: 9,      // 請求先マスタ（旧）
  JUGYO: 6,        // 授業マスタ
  GAKUHI: 10,      // 月謝マスタ
  KENTEI: 12,      // 検定申込
  FURIKAE: 14,     // 振替管理
  TAIKEN: 17,      // 体験参加名簿
  CLASS_CHANGE: 18, // クラス変更
  SEITO_NEW: 19,   // 生徒名簿（新・統合）
  SONOTA: 16,      // その他請求
  KYOSHITSU: 5,    // 教室マスタ
};

const ALLOWED_ORIGINS = [
  "https://form.rakutama-tokyo.com",
  "https://rakutama-tokyo.com",
  "https://form.rakutama-soroban.com",
  "https://amayira.github.io",
];

// ドメインごとの所属組織コード（kintoneシステム管理→組織のコード）
// 関西版を追加する際はここにドメインとコードを追記する
const DOMAIN_ORG_MAP = {
  "form.rakutama-tokyo.com":   "アルファーブレイン",
  "rakutama-tokyo.com":        "アルファーブレイン",
  "form.rakutama-soroban.com": "本部",
  "amayira.github.io":         "アルファーブレイン",  // 開発用
};

/** Originヘッダーからホスト名を抽出して組織コードを返す */
function getOrgCode(origin) {
  try {
    const host = new URL(origin).host;
    return DOMAIN_ORG_MAP[host] ?? "アルファーブレイン";
  } catch {
    return "アルファーブレイン";
  }
}

// ─── kintone helpers ────────────────────────────────────────────────────────

/**
 * kintoneクエリの文字列リテラル用エスケープ。
 * ユーザー入力（生徒番号・教室名など）に " や \ が含まれても
 * クエリが壊れないように無害化する。
 */
function escapeQueryValue(val) {
  return String(val).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Convert a flat { key: value } object into kintone record format.
 * { key: { value: value } }
 */
function buildRecord(fields) {
  const record = {};
  for (const [key, value] of Object.entries(fields)) {
    record[key] = { value };
  }
  return record;
}

/** POST /k/v1/record.json — create one record, returns { id, revision } */
async function kintonePost(appId, record, token) {
  const res = await fetch(`${KINTONE_BASE}/k/v1/record.json`, {
    method: "POST",
    headers: {
      "X-Cybozu-API-Token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ app: appId, record }),
  });
  const data = await res.json();
  if (!res.ok) {
    const detail = data.errors
      ? " / " + Object.entries(data.errors).map(([k,v]) => `${k}: ${v.messages?.join(",")}`).join(" | ")
      : "";
    throw new Error(
      `kintone POST app=${appId} failed: ${data.message || res.status}${detail}`
    );
  }
  return data; // { id: "123", revision: "1" }
}

/** PUT /k/v1/record.json — update one record by numeric ID */
async function kintoneUpdate(appId, recordId, record, token) {
  const res = await fetch(`${KINTONE_BASE}/k/v1/record.json`, {
    method: "PUT",
    headers: {
      "X-Cybozu-API-Token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ app: appId, id: String(recordId), record }),
  });
  const data = await res.json();
  if (!res.ok) {
    const detail = data.errors
      ? " / " + Object.entries(data.errors).map(([k, v]) => `${k}: ${v.messages?.join(",")}`).join(" | ")
      : "";
    throw new Error(
      `kintone PUT app=${appId} id=${recordId} failed: ${data.message || res.status}${detail}`
    );
  }
  return data;
}

/** GET /k/v1/records.json — query multiple records */
async function kintoneGet(appId, query, token) {
  const params = new URLSearchParams({
    app: String(appId),
    query,
  });
  const res = await fetch(`${KINTONE_BASE}/k/v1/records.json?${params}`, {
    method: "GET",
    headers: { "X-Cybozu-API-Token": token },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      `kintone GET app=${appId} failed: ${data.message || res.status}`
    );
  }
  return data; // { records: [...], totalCount: null }
}

/** GET /k/v1/record.json — fetch one record by numeric ID */
async function kintoneGetById(appId, recordId, token) {
  const params = new URLSearchParams({
    app: String(appId),
    id: String(recordId),
  });
  const res = await fetch(`${KINTONE_BASE}/k/v1/record.json?${params}`, {
    method: "GET",
    headers: { "X-Cybozu-API-Token": token },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      `kintone GET by id app=${appId} id=${recordId} failed: ${data.message || res.status}`
    );
  }
  return data; // { record: { ... } }
}

// ─── 時刻変換ヘルパー ────────────────────────────────────────────────────────
// "16時" / "16:00" / "16:00:00" → "16:00:00"（Kintone 時刻型フォーマット）
function toKintoneTime(val) {
  if (!val) return "";
  const mJp = String(val).match(/^(\d{1,2})時$/);
  if (mJp) return `${mJp[1].padStart(2, "0")}:00:00`;
  const mHM = String(val).match(/^(\d{1,2}):(\d{2})$/);
  if (mHM) return `${mHM[1].padStart(2, "0")}:${mHM[2]}:00`;
  return val; // すでに HH:MM:SS の場合はそのまま
}

// ─── 採番ヘルパー ─────────────────────────────────────────────────────────────

/**
 * kintoneアプリの指定フィールドから現在の最大連番を取得し、次のIDを返す
 * @param {number} appId - kintone App ID
 * @param {string} fieldCode - 採番対象フィールドコード（例: "請求先ID"）
 * @param {string} prefix - プレフィックス（例: "P"）
 * @param {string} separator - 接続語（例: "-"）
 * @param {number} digits - 桁数（例: 4）
 * @param {string} token - APIトークン
 */
async function generateNextId(appId, fieldCode, prefix, separator, digits, token) {
  const query = `order by ${fieldCode} desc limit 1`;
  const data = await kintoneGet(appId, query, token);
  let nextNum = 1;
  if (data.records && data.records.length > 0) {
    const lastId = data.records[0][fieldCode]?.value ?? "";
    // P-0001 → 1, S-00001 → 1
    const match = lastId.match(/(\d+)$/);
    if (match) {
      nextNum = parseInt(match[1], 10) + 1;
    }
  }
  // 生成したIDが既存レコードと重複していないか確認し、重複なら採番し直す
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = `${prefix}${separator}${String(nextNum).padStart(digits, "0")}`;
    const check = await kintoneGet(appId, `${fieldCode} = "${candidate}" limit 1`, token);
    if (!check.records || check.records.length === 0) {
      return candidate;
    }
    nextNum++;
  }
  throw new Error(`採番に失敗しました（${prefix}）`);
}

// ─── CORS helpers ────────────────────────────────────────────────────────────

function corsHeaders(origin) {
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin)
    ? origin
    : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function jsonResponse(body, status = 200, origin = "") {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      ...corsHeaders(origin),
    },
  });
}

function errorResponse(message, status = 500, origin = "") {
  return jsonResponse({ success: false, error: message }, status, origin);
}

// ─── Route handlers ──────────────────────────────────────────────────────────

/**
 * POST /api/lookup
 * { studentNumber: "A0001" }
 * Returns student basic info + active 授業IDs.
 * 週2コース（A0001 + A0001-2）は両レコードをまとめて返す。
 */
async function handleLookup(body, env) {
  const { studentNumber } = body;
  if (!studentNumber) {
    return { success: false, error: "studentNumber は必須です", status: 400 };
  }

  // 完全一致 + サブ番号（A0001-2 など）を前方一致で取得
  const sn = escapeQueryValue(studentNumber);
  const query = `生徒番号 = "${sn}" or 生徒番号 like "${sn}-%" order by 生徒番号 asc limit 10`;
  const data = await kintoneGet(APP.SEITO_NEW, query, env.TOKEN_SEITO_NEW);

  if (!data.records || data.records.length === 0) {
    return { success: false, error: "生徒番号が見つかりません", status: 404 };
  }

  const firstRec = data.records[0];

  const records = data.records.map(rec => {
    const jugyoIds = ["コマ1", "コマ2", "コマ3", "コマ4"]
      .map(f => rec[f]?.value)
      .filter(v => v && v.trim() !== "");
    return {
      studentNumber: rec["生徒番号"]?.value ?? "",
      classroom: rec["教室名"]?.value ?? "",
      billingId: rec["請求先ID"]?.value ?? rec["請求ID"]?.value ?? "",
      jugyoIds,
    };
  });

  return {
    success: true,
    student: {
      familyName: firstRec["氏"]?.value ?? "",
      givenName: firstRec["名"]?.value ?? "",
      records,
    },
  };
}

// ─── Resend メール送信 ────────────────────────────────────────────────────────

async function sendConfirmationEmail(to, familyName, givenName, kyoshitsu, kiboDaiji, env) {
  if (!env.RESEND_API_KEY || !to) return;

  const namePart = familyName || givenName ? `${familyName} ${givenName}`.trim() + " さん" : "ご保護者様";
  const kyoshitsuLine = kyoshitsu ? `\n■ ご希望の教室：${kyoshitsu}` : "";
  const kiboLine = kiboDaiji ? `\n■ ご希望日時：${kiboDaiji}` : "";

  const textBody = `${namePart}

このたびは楽珠そろばん教室の体験授業にお申し込みいただき、ありがとうございます。

以下の内容でお申し込みを受け付けました。${kyoshitsuLine}${kiboLine}

担当者より **1営業日以内** に体験日時の確定メールをお送りします。
今しばらくお待ちください。

※ お急ぎの場合は、公式LINEまたはメールにてお問い合わせください。
　公式LINE：https://lin.ee/oW7wspr
　メール：info@rakutama-tokyo.com

━━━━━━━━━━━━━━━━━━━━━━
楽珠そろばん教室（東京・練馬）
運営：アルファーブレイン合同会社
━━━━━━━━━━━━━━━━━━━━━━`;

  const htmlBody = `<p>${namePart}</p>
<p>このたびは楽珠そろばん教室の体験授業にお申し込みいただき、ありがとうございます。</p>
<p>以下の内容でお申し込みを受け付けました。</p>
<table style="border-collapse:collapse;margin:16px 0;">
  ${kyoshitsu ? `<tr><td style="padding:4px 12px 4px 0;color:#555;white-space:nowrap;">ご希望の教室</td><td style="padding:4px 0;">${kyoshitsu}</td></tr>` : ""}
  ${kiboDaiji ? `<tr><td style="padding:4px 12px 4px 0;color:#555;white-space:nowrap;">ご希望日時</td><td style="padding:4px 0;">${kiboDaiji}</td></tr>` : ""}
</table>
<p>担当者より <strong>1営業日以内</strong> に体験日時の確定メールをお送りします。<br>今しばらくお待ちください。</p>
<hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
<p style="font-size:13px;color:#555;">
  お急ぎの場合は、公式LINEまたはメールにてお問い合わせください。<br>
  公式LINE：<a href="https://lin.ee/oW7wspr">https://lin.ee/oW7wspr</a><br>
  メール：<a href="mailto:info@rakutama-tokyo.com">info@rakutama-tokyo.com</a>
</p>
<p style="font-size:12px;color:#aaa;">楽珠そろばん教室（東京・練馬）｜運営：アルファーブレイン合同会社</p>`;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "楽珠そろばん教室 <info@rakutama-tokyo.com>",
      to: [to],
      subject: "【体験申込受付】楽珠そろばん教室 東京・練馬",
      text: textBody,
      html: htmlBody,
    }),
  });
}

// ─── フォーム受付完了メール（体験以外の全フォーム共通） ─────────────────────────
//
// 在学生・入会フォームは「フォーム入力完了メールが欲しい」という保護者要望を受けて
// 受付時に自動返信を送る（2026-07-06）。在学生フォームはメール欄を持たないため、
// worker 側で生徒番号 → 生徒名簿(App19) の保護者メールを引いて送信する。

const MAIL_FROM = "楽珠そろばん教室 <info@rakutama-tokyo.com>";
const MAIL_LINE = "https://lin.ee/oW7wspr";
const MAIL_ADDR = "info@rakutama-tokyo.com";

// 受付完了メールは自社（東京直営）のみ送信する。FC加盟店・本部には送らない。
const MAIL_ORG = "アルファーブレイン";

/**
 * 受付完了メールの汎用送信関数。
 * rows = [[ラベル, 値], ...]（値が空・null の行は自動で省略）。
 * RESEND_API_KEY 未設定 or 宛先無しなら何もしない。
 */
async function sendReceiptEmail({ to, name, subject, lead, rows, env }) {
  if (!env.RESEND_API_KEY || !to) return;

  const namePart = name ? `${name} さん` : "ご保護者様";
  const filled = (rows || []).filter(([, v]) => v != null && String(v).trim() !== "");

  const textRows = filled.map(([k, v]) => `■ ${k}：${v}`).join("\n");
  const textBody = `${namePart}

${lead}

以下の内容で受け付けました。
${textRows}

内容を確認のうえ、必要に応じて担当者よりご連絡いたします。
※ このメールは送信専用の自動返信です。ご返信いただいてもお応えできません。

ご不明な点は、公式LINEまたはメールにてお問い合わせください。
　公式LINE：${MAIL_LINE}
　メール：${MAIL_ADDR}

━━━━━━━━━━━━━━━━━━━━━━
楽珠そろばん教室（東京・練馬）
運営：アルファーブレイン合同会社
━━━━━━━━━━━━━━━━━━━━━━`;

  const htmlRows = filled
    .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#555;white-space:nowrap;vertical-align:top;">${k}</td><td style="padding:4px 0;">${String(v).replace(/\n/g, "<br>")}</td></tr>`)
    .join("");
  const htmlBody = `<p>${namePart}</p>
<p>${lead}</p>
<p>以下の内容で受け付けました。</p>
<table style="border-collapse:collapse;margin:16px 0;">
  ${htmlRows}
</table>
<p>内容を確認のうえ、必要に応じて担当者よりご連絡いたします。<br>
<span style="color:#888;font-size:13px;">※ このメールは送信専用の自動返信です。ご返信いただいてもお応えできません。</span></p>
<hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
<p style="font-size:13px;color:#555;">
  ご不明な点は、公式LINEまたはメールにてお問い合わせください。<br>
  公式LINE：<a href="${MAIL_LINE}">${MAIL_LINE}</a><br>
  メール：<a href="mailto:${MAIL_ADDR}">${MAIL_ADDR}</a>
</p>
<p style="font-size:12px;color:#aaa;">楽珠そろばん教室（東京・練馬）｜運営：アルファーブレイン合同会社</p>`;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, text: textBody, html: htmlBody }),
  });
}

/**
 * 生徒番号から保護者の連絡先（メール・氏名）を生徒名簿(App19)から取得する。
 * 週2のサブ番号（A0001-2）でもメイン番号のレコードを引く。
 */
async function getStudentContact(studentNumber, env) {
  if (!studentNumber) return null;
  const main = String(studentNumber).split("-")[0];
  const query = `生徒番号 = "${escapeQueryValue(main)}" limit 1`;
  const data = await kintoneGet(APP.SEITO_NEW, query, env.TOKEN_SEITO_NEW);
  const rec = data.records?.[0];
  if (!rec) return null;
  return {
    email: rec["メールアドレス"]?.value ?? "",
    familyName: rec["氏"]?.value ?? "",
    givenName: rec["名"]?.value ?? "",
    org: rec["所属組織"]?.value?.[0]?.code ?? "",
  };
}

/**
 * 在学生フォームの受付完了メールを送る。
 * body に氏名が無い場合は生徒名簿から補完。メール送信の失敗は申込自体を止めない。
 */
async function sendStudentReceipt({ studentNumber, familyName, givenName, subject, lead, rows, env }) {
  try {
    const contact = await getStudentContact(studentNumber, env);
    if (!contact || !contact.email) return;
    // 自社（東京直営）のみ送信。所属組織が別組織なら送らない（空は東京扱い）。
    if (contact.org && contact.org !== MAIL_ORG) return;
    const name = `${familyName || contact.familyName || ""} ${givenName || contact.givenName || ""}`.trim();
    await sendReceiptEmail({ to: contact.email, name, subject, lead, rows, env });
  } catch (e) {
    console.error("受付メール送信エラー:", e);
  }
}

/**
 * POST /api/taiken
 * Creates a record in 体験参加名簿 (App 17).
 */
async function handleTaiken(body, env, origin) {
  // 教室名はルックアップ型のため、TOKEN_TAIKENとTOKEN_KYOSHITSUを両方渡して
  // 教室マスタへの閲覧権限を付与したマルチトークンで送信する
  const token = env.TOKEN_KYOSHITSU
    ? `${env.TOKEN_TAIKEN},${env.TOKEN_KYOSHITSU}`
    : env.TOKEN_TAIKEN;

  // 備考フィールドを組み立て（備考 → 紹介者）
  const referrer = body["紹介者"] ?? "";
  const bikoLines = [];
  if (body["備考"]) bikoLines.push(body["備考"]);
  if (referrer) bikoLines.push(`紹介者：${referrer}`);
  const biko = bikoLines.join("\n\n");

  const record = buildRecord({
    氏: body["氏"] ?? "",
    名: body["名"] ?? "",
    フリガナ: body["フリガナ"] ?? "",
    学年: body["学年"] ?? "",
    電話番号: body["電話番号"] ?? "",
    メールアドレス: body["メールアドレス"] ?? "",
    住所: body["住所"] ?? "",
    そろばん経験: body["そろばん経験"] ?? "",
    "級・段": body["級・段"] ?? "",
    教室名: body["教室名"] ?? "",
    希望日時: body["希望日時"] ?? "",
    備考: biko,
  });

  await kintonePost(APP.TAIKEN, record, token);

  // kintone登録成功後に確認メール送信（失敗しても申込自体はエラーにしない）
  // 自社（東京直営）のみ送信。加盟店・本部（form.rakutama-soroban.com）には送らない。
  try {
    if (getOrgCode(origin) === MAIL_ORG) {
      await sendConfirmationEmail(
        body["メールアドレス"],
        body["氏"] ?? "",
        body["名"] ?? "",
        body["教室名"] ?? "",
        body["希望日時"] ?? "",
        env,
      );
    }
  } catch (e) {
    console.error("確認メール送信エラー:", e);
  }

  return { success: true };
}

/**
 * POST /api/kesseki
 * Creates a record in 振替管理 (App 14).
 */
async function handleKesseki(body, env) {
  const record = buildRecord({
    生徒番号: body["生徒番号"] ?? "",
    請求ID: body["請求ID"] ?? "",
    教室名: body["教室名"] ?? "",
    氏: body["氏"] ?? "",
    名: body["名"] ?? "",
    欠席日: body["欠席日"] ?? "",
    振替期日_始_: body["振替期日_始_"] ?? "",
    振替期日_終_: body["振替期日_終_"] ?? "",
    振替受講日: body["振替受講日"] ?? "",
    振替教室名: body["振替教室名"] ?? "",
    時刻: toKintoneTime(body["時刻"]),
    備考: body["備考"] ?? "",
  });

  const furikaeToken = [env.TOKEN_FURIKAE, env.TOKEN_SEITO_NEW, env.TOKEN_KYOSHITSU].filter(Boolean).join(",");
  await kintonePost(APP.FURIKAE, record, furikaeToken);

  await sendStudentReceipt({
    studentNumber: body["生徒番号"],
    familyName: body["氏"],
    givenName: body["名"],
    subject: "【欠席受付】楽珠そろばん教室 東京・練馬",
    lead: "欠席のご連絡を受け付けました。",
    rows: [
      ["欠席日", body["欠席日"]],
      ["振替受講日", body["振替受講日"]],
      ["振替受講教室", body["振替教室名"]],
      ["時刻", body["時刻"]],
      ["備考", body["備考"]],
    ],
    env,
  });

  return { success: true };
}

/**
 * POST /api/flash-anzan
 * Creates a record in その他請求 (App 16).
 */
async function handleFlashAnzan(body, env) {
  const record = buildRecord({
    フォーム: "フラッシュ暗算申込フォーム",
    生徒番号: body["生徒番号"] ?? "",
    請求基準日: body["請求基準日"] ?? "",
    項目名: body["項目名"] ?? "",
    金額: body["金額"] ?? 0,
  });

  const sonotaToken = [env.TOKEN_SONOTA, env.TOKEN_SEITO_NEW].filter(Boolean).join(",");
  await kintonePost(APP.SONOTA, record, sonotaToken);

  await sendStudentReceipt({
    studentNumber: body["生徒番号"],
    subject: "【フラッシュ暗算申込受付】楽珠そろばん教室 東京・練馬",
    lead: "フラッシュ暗算のお申し込みを受け付けました。",
    rows: [
      ["項目", body["項目名"]],
      ["金額", body["金額"] ? `${String(body["金額"]).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}円` : ""],
    ],
    env,
  });

  return { success: true };
}

/**
 * 日本時間（Asia/Tokyo）での「今日」を YYYY-MM-DD で返す
 */
function tokyoToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** 指定年月（y, m: mは1-indexed）の末日を返す */
function lastDayOfMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * GET /api/absence-count?studentNumber=A0000
 * 今月・来月の欠席報告件数を 振替管理(App 14) から集計して返す。
 * 種別＝「自己都合」のレコードのみカウントする（体調不良・その他は対象外）。
 */
async function handleAbsenceCount(params, env) {
  const studentNumber = params.get("studentNumber");
  if (!studentNumber) {
    return { success: false, error: "studentNumber は必須です", status: 400 };
  }

  const today = tokyoToday();
  const [y, m] = today.split("-").map(Number);
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  const pad = (n) => String(n).padStart(2, "0");

  const thisMonthStart = `${y}-${pad(m)}-01`;
  const thisMonthEnd = `${y}-${pad(m)}-${pad(lastDayOfMonth(y, m))}`;
  const nextMonthStart = `${nextY}-${pad(nextM)}-01`;
  const nextMonthEnd = `${nextY}-${pad(nextM)}-${pad(lastDayOfMonth(nextY, nextM))}`;

  const sn = escapeQueryValue(studentNumber);
  const query = [
    `(生徒番号 = "${sn}" or 生徒番号 like "${sn}-%")`,
    `種別 in ("自己都合")`,
    `欠席日 >= "${thisMonthStart}"`,
    `欠席日 <= "${nextMonthEnd}"`,
  ].join(" and ") + " order by 欠席日 asc limit 100";

  const data = await kintoneGet(APP.FURIKAE, query, env.TOKEN_FURIKAE);
  const dates = (data.records ?? []).map((rec) => rec["欠席日"]?.value ?? "").filter(Boolean);

  const thisMonth = dates.filter((d) => d >= thisMonthStart && d <= thisMonthEnd).length;
  const nextMonth = dates.filter((d) => d >= nextMonthStart && d <= nextMonthEnd).length;

  return { success: true, thisMonth, nextMonth };
}

/**
 * GET /api/furikae-tickets?studentNumber=A0000&date=2026-04-17
 * Returns available 振替tickets from App 14 that cover the given date.
 */
async function handleFurikaeTickets(params, env) {
  const studentNumber = params.get("studentNumber");
  const date = params.get("date");
  if (!studentNumber || !date) {
    return { success: false, error: "studentNumber と date は必須です", status: 400 };
  }

  // メイン番号（A0001）＋サブ番号（A0001-2 など）の両チケットを取得
  const sn = escapeQueryValue(studentNumber);
  const dt = escapeQueryValue(date);
  const conditions = [
    `(生徒番号 = "${sn}" or 生徒番号 like "${sn}-%")`,
    `振替受講日 = ""`,
    `振替期日_始_ <= "${dt}"`,
    `振替期日_終_ >= "${dt}"`,
  ].join(" and ");
  const query = `${conditions} order by 欠席日 asc limit 50`;

  const data = await kintoneGet(APP.FURIKAE, query, env.TOKEN_FURIKAE);

  const tickets = (data.records ?? []).map(rec => ({
    id: rec["$id"]?.value ?? "",
    欠席日: rec["欠席日"]?.value ?? "",
    振替期日_始_: rec["振替期日_始_"]?.value ?? "",
    振替期日_終_: rec["振替期日_終_"]?.value ?? "",
  }));

  return { success: true, tickets };
}

/**
 * POST /api/furikae
 * Updates an existing App 14 record (ticket) with the substitute lesson date/time.
 */
async function handleFurikae(body, env) {
  const { ticketId } = body;
  if (!ticketId) {
    return { success: false, error: "ticketId は必須です", status: 400 };
  }

  const record = buildRecord({
    振替受講日: body["振替受講日"] ?? "",
    振替教室名: body["振替受講教室"] ?? "",
    時刻: toKintoneTime(body["時刻"]),
    備考: body["備考"] ?? "",
  });

  const furikaeToken = [env.TOKEN_FURIKAE, env.TOKEN_SEITO_NEW, env.TOKEN_KYOSHITSU].filter(Boolean).join(",");
  await kintoneUpdate(APP.FURIKAE, ticketId, record, furikaeToken);

  await sendStudentReceipt({
    studentNumber: body["生徒番号"],
    subject: "【振替受付】楽珠そろばん教室 東京・練馬",
    lead: "振替受講のお申し込みを受け付けました。",
    rows: [
      ["振替受講日", body["振替受講日"]],
      ["振替受講教室", body["振替受講教室"]],
      ["時刻", body["時刻"]],
      ["備考", body["備考"]],
    ],
    env,
  });

  return { success: true };
}

/**
 * POST /api/kentei
 * Creates a record in 検定申込 (App 12).
 * 暗算受験級 and 珠算受験級 are only set when non-empty.
 */
async function handleKentei(body, env) {
  const fields = {
    生徒番号: body["生徒番号"] ?? "",
    請求ID: body["請求ID"] ?? "",
    教室名: body["教室名"] ?? "",
    氏: body["氏"] ?? "",
    名: body["名"] ?? "",
    受験日: body["受験日"] ?? "",
    受験会場: body["受験会場"] ?? "",
  };

  if (body["暗算受験級"]) fields["暗算受験級"] = body["暗算受験級"];
  if (body["珠算受験時刻"]) fields["珠算受験時刻"] = body["珠算受験時刻"];
  if (body["暗算受験時刻"]) fields["暗算受験時刻"] = body["暗算受験時刻"];
  if (body["珠算受験級"]) fields["珠算受験級"] = body["珠算受験級"];

  const record = buildRecord(fields);
  const kenteiToken = [env.TOKEN_KENTEI, env.TOKEN_SEITO_NEW].filter(Boolean).join(",");
  await kintonePost(APP.KENTEI, record, kenteiToken);

  await sendStudentReceipt({
    studentNumber: body["生徒番号"],
    familyName: body["氏"],
    givenName: body["名"],
    subject: "【検定申込受付】楽珠そろばん教室 東京・練馬",
    lead: "検定のお申し込みを受け付けました。",
    rows: [
      ["受験日", body["受験日"]],
      ["受験会場", body["受験会場"]],
      ["珠算 受験級", body["珠算受験級"]],
      ["暗算 受験級", body["暗算受験級"]],
    ],
    env,
  });

  return { success: true };
}

/**
 * POST /api/nyukai
 * Enrollment flow (app 19 のみ):
 *   1. If isSibling=true → look up existing 請求ID from sibling record (app 8 旧データ参照).
 *   2. Create one record in 生徒名簿新 (App 19) with all student + guardian fields.
 *   生徒番号 は「要修正&{5桁乱数}」で仮登録し、後で手動修正。
 */
async function handleNyukai(body, env, origin) {
  const { guardian, student } = body;
  // 加盟店サブフォルダ（form.rakutama-soroban.com/<店>/）は同一ホストで配信されるため
  // Origin ヘッダーだけでは組織を判別できない。フォームが body.所属組織 を送ってきたら優先する。
  const orgCode = body["所属組織"] || getOrgCode(origin);

  if (!student) {
    return { success: false, error: "生徒情報が不足しています", status: 400 };
  }

  // ── 必須項目チェック ─────────────────────────────────────────────────────
  // フォーム側のバリデーション漏れ・改変リクエストで空のまま登録される事故を防ぐ。
  // ここに追加する項目は「東京直営＋FC加盟店の全 nyukai フォームが必ず送るもの」に限ること
  // （worker は全組織共通のため、一部フォームにしかない項目を必須にすると他組織の申込が全滅する）。
  const requiredStudent = ["氏", "名", "教室名", "初回授業日"];
  const missing = requiredStudent.filter((f) => !String(student[f] ?? "").trim());
  if (missing.length > 0) {
    return {
      success: false,
      error: `必須項目が未入力です：${missing.join("・")}。お手数ですが入力のうえ再度送信してください。`,
      status: 400,
    };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(student["初回授業日"]).trim())) {
    return { success: false, error: "希望入会日の形式が不正です", status: 400 };
  }

  // ── 生徒番号: 「要修正&{5桁乱数}」で仮登録 ─────────────────────────────────
  const rand5 = String(Math.floor(Math.random() * 100000)).padStart(5, "0");
  const tempStudentId = `要修正&${rand5}`;

  // ── jugyoIds → コマ1〜コマ4 にマッピング ───────────────────────────────────
  // 授業ID例: "早宮校-火1700" → "火17" ([曜日][hh]形式)
  const jugyoIds = Array.isArray(student["jugyoIds"]) ? student["jugyoIds"]
    : student["jugyoId"] ? [student["jugyoId"]] : [];
  const toKoma = (id) => {
    // "中村校-月1600" → "月16"、"早宮校-火1700" → "火17"
    const m = String(id).match(/([月火水木金土日])(\d{2})/);
    return m ? `${m[1]}${m[2]}` : String(id);
  };

  // ── app 19 にレコード登録 ──────────────────────────────────────────────────
  const g = guardian ?? {};
  const referrer = g["紹介者"] ?? "";
  const sorobanOrders = Array.isArray(body["sorobanOrders"]) ? body["sorobanOrders"] : [];
  const userNotes = body["notes"] ?? "";

  // 備考フィールドを組み立て（そろばん購入希望 → 備考 → 紹介者）
  const bikoLines = [];
  if (student["そろばん経験"] === "あり") {
    const levelPart = student["級・段"] ? `（${student["級・段"]}）` : "";
    bikoLines.push(`そろばん経験：あり${levelPart}`);
  }
  if (sorobanOrders.length > 0) {
    bikoLines.push(`【そろばん購入希望】\n${sorobanOrders.join("\n")}`);
  }
  if (userNotes) bikoLines.push(userNotes);
  if (referrer) bikoLines.push(`紹介者：${referrer}`);
  const biko = bikoLines.join("\n\n");

  const record = buildRecord({
    生徒番号: tempStudentId,
    氏: student["氏"] ?? "",
    名: student["名"] ?? "",
    フリガナ: student["フリガナ"] ?? "",
    生年月日: student["生年月日"] ?? "",
    学校名: student["学校名"] ?? "",
    学年: student["学年"] ?? "",
    教室名: student["教室名"] ?? "",
    初回授業日: student["初回授業日"] ?? "",
    コマ1: jugyoIds[0] ? toKoma(jugyoIds[0]) : "",
    コマ2: jugyoIds[1] ? toKoma(jugyoIds[1]) : "",
    コマ3: jugyoIds[2] ? toKoma(jugyoIds[2]) : "",
    コマ4: jugyoIds[3] ? toKoma(jugyoIds[3]) : "",
    コース名: student["gakuhiName"] ?? "",
    保護者名: g["保護者名"] ?? "",
    電話番号1: g["電話番号1"] ?? "",
    電話番号2: g["電話番号2"] ?? "",
    メールアドレス: g["メールアドレス"] ?? "",
    郵便番号: g["郵便番号"] ?? "",
    住所: g["住所"] ?? "",
    口座名義人: g["口座名義人"] ?? "",
    備考: biko,
  });

  // 所属組織フィールド（組織選択型）
  record["所属組織"] = { value: [{ code: orgCode }] };

  const token = [env.TOKEN_SEITO_NEW, env.TOKEN_KYOSHITSU, env.TOKEN_GAKUHI]
    .filter(Boolean).join(",");
  await kintonePost(APP.SEITO_NEW, record, token);

  // 入会受付メール（東京直営のみ。加盟店は運営会社・連絡先が異なるため送らない）
  try {
    if (orgCode === MAIL_ORG && g["メールアドレス"]) {
      await sendReceiptEmail({
        to: g["メールアドレス"],
        name: `${student["氏"] ?? ""} ${student["名"] ?? ""}`.trim(),
        subject: "【入会申込受付】楽珠そろばん教室 東京・練馬",
        lead: "ご入会のお申し込みを受け付けました。担当者が内容を確認し、追ってご連絡いたします。",
        rows: [
          ["教室", student["教室名"]],
          ["初回授業日", student["初回授業日"]],
          ["コース", student["gakuhiName"]],
        ],
        env,
      });
    }
  } catch (e) {
    console.error("入会受付メール送信エラー:", e);
  }

  return { success: true };
}

/**
 * GET /api/jugyo?classroom=教室名
 * Returns list of active classes for the given classroom from 授業マスタ (App 6).
 */
async function handleJugyo(params, env) {
  const classroom = params.get("classroom");
  if (!classroom) {
    return { success: false, error: "classroom は必須です", status: 400 };
  }

  const query = `教室名 = "${escapeQueryValue(classroom)}" and 開講状況 in ("開講中") order by 曜日 asc, 開始時刻 asc limit 100`;
  const data = await kintoneGet(APP.JUGYO, query, env.TOKEN_JUGYO);

  const classes = (data.records ?? []).map((rec) => ({
    id: rec["授業ID"]?.value ?? "",
    name: rec["授業名"]?.value ?? "",
  }));

  return { success: true, classes };
}

/**
 * GET /api/active-classrooms
 * 授業マスタ(App6)に「開講中」クラスが1件以上ある教室名の一覧を返す。
 * 本部フォームのハードコード教室リストから、閉校（＝開講中クラスなし）を隠す用。
 */
async function handleActiveClassrooms(env) {
  const query = `開講状況 in ("開講中") order by 教室名 asc limit 500`;
  const data = await kintoneGet(APP.JUGYO, query, env.TOKEN_JUGYO);

  const classrooms = [...new Set(
    (data.records ?? [])
      .map((rec) => rec["教室名"]?.value ?? "")
      .filter(Boolean)
  )];

  return { success: true, classrooms };
}

/**
 * GET /api/all-classrooms
 * 教室マスタ(App5)の全組織・非閉校の教室を、所属組織コード付きで返す。
 * 本部フォームで本部＋全FC加盟店の教室を組織ごとにまとめて表示する用。
 * 入会はこの org を所属組織として登録し、体験は教室名ルックアップで自動転記される。
 */
async function handleAllClassrooms(env) {
  const query = `開校日 != "" order by レコード番号 asc limit 500`;
  const data = await kintoneGet(APP.KYOSHITSU, query, env.TOKEN_KYOSHITSU);

  const classrooms = (data.records ?? [])
    .filter((rec) => !String(rec["開校状況"]?.value ?? "").includes("閉"))
    .map((rec) => ({
      name: rec["教室名"]?.value ?? "",
      org: rec["組織選択"]?.value?.[0]?.code ?? "",
      orgName: rec["組織選択"]?.value?.[0]?.name ?? "",
      pref: rec["都道府県"]?.value ?? "",
      openDate: rec["開校日"]?.value ?? "",
    }))
    .filter((c) => c.name);

  return { success: true, classrooms };
}

/**
 * GET /api/classrooms?orgCode=所属組織コード
 * Returns classrooms for the given org from 教室マスタ (App 7).
 * openDate（開校日）より前の日付はフォーム側で選択不可になる。
 */
async function handleClassrooms(params, env) {
  const orgCode = params.get("orgCode");
  if (!orgCode) {
    return { success: false, error: "orgCode は必須です", status: 400 };
  }

  // 教室マスタは全組織共通（関西等も含む）のため組織選択で絞る。
  // 開校日が未入力の教室（開校日未定の準備中など）はフォームに出さない。
  const query = `組織選択 in ("${escapeQueryValue(orgCode)}") and 開校日 != "" order by レコード番号 asc limit 100`;
  const data = await kintoneGet(APP.KYOSHITSU, query, env.TOKEN_KYOSHITSU);

  const classrooms = (data.records ?? [])
    .filter((rec) => !String(rec["開校状況"]?.value ?? "").includes("閉"))
    .map((rec) => ({
      name: rec["教室名"]?.value ?? "",
      openDate: rec["開校日"]?.value ?? "",
    }))
    .filter((c) => c.name);

  return { success: true, classrooms };
}

/**
 * GET /api/gakuhi?orgCode=所属組織コード
 * Returns list of fee courses for the given org from 月謝マスタ (App 10).
 */
async function handleGakuhi(params, env) {
  const orgCode = params.get("orgCode");
  if (!orgCode) {
    return { success: false, error: "orgCode は必須です", status: 400 };
  }

  const query = `所属組織 in ("${escapeQueryValue(orgCode)}") order by コース名 asc limit 100`;
  const data = await kintoneGet(APP.GAKUHI, query, env.TOKEN_GAKUHI);

  const fees = (data.records ?? []).map((rec) => ({
    id: rec["月謝ID"]?.value ?? "",
    name: rec["コース名"]?.value ?? "",
  }));

  return { success: true, fees };
}

/**
 * POST /api/class-change
 * Creates a record in the class-change kintone app.
 * Gracefully no-ops if CLASS_CHANGE_APP_ID is not configured.
 */
async function handleClassChange(body, env) {
  const token = [env.TOKEN_CLASS_CHANGE, env.TOKEN_SEITO_NEW].filter(Boolean).join(",");

  const record = buildRecord({
    生徒番号: body["生徒番号"] ?? "",
    請求ID: body["請求ID"] ?? "",
    教室名: body["教室名"] ?? "",
    氏: body["氏"] ?? "",
    名: body["名"] ?? "",
    現在の授業ID: body["現在の授業ID"] ?? "",
    変更希望内容: body["変更希望内容"] ?? "",
    希望時期: body["希望時期"] ?? "",
    備考: body["備考"] ?? "",
  });

  await kintonePost(APP.CLASS_CHANGE, record, token);

  await sendStudentReceipt({
    studentNumber: body["生徒番号"],
    familyName: body["氏"],
    givenName: body["名"],
    subject: "【クラス変更申込受付】楽珠そろばん教室 東京・練馬",
    lead: "クラス変更のお申し込みを受け付けました。",
    rows: [
      ["変更希望内容", body["変更希望内容"]],
      ["希望時期", body["希望時期"]],
      ["備考", body["備考"]],
    ],
    env,
  });

  return { success: true };
}

// ─── Staff portal handlers ───────────────────────────────────────────────────

/** Validate staff password from Authorization: Bearer <password> header */
function isValidStaffAuth(request, env) {
  const auth = request.headers.get("Authorization") ?? "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return key.length > 0 && key === env.STAFF_PASSWORD;
}

/**
 * POST /api/staff/auth
 * { password } → { success: true } or 401
 */
async function handleStaffAuth(body, env) {
  if (body.password && body.password === env.STAFF_PASSWORD) {
    return { success: true };
  }
  return { success: false, error: "パスワードが違います", status: 401 };
}

/**
 * GET /api/staff/taiken?school=all|早宮校|氷川台校|中村校
 * Returns 体験参加名簿 (App 17) records.
 * Fields: 体験参加日, 時刻, 氏, 名, フリガナ, 学年, そろばん経験, 教室名
 */
async function handleStaffTaiken(params, env) {
  const school = params.get("school") ?? "all";
  const conditions = [`所属組織 in ("アルファーブレイン")`, `(体験参加日 >= TODAY() or 体験参加日 = "")`];
  if (school !== "all") conditions.unshift(`教室名 = "${escapeQueryValue(school)}"`);
  const query = `${conditions.join(" and ")} order by 体験参加日 asc, 教室名 asc, 時刻 asc limit 500`;

  const data = await kintoneGet(APP.TAIKEN, query, env.TOKEN_TAIKEN);
  const records = (data.records ?? [])
    .filter(rec => !(rec["出欠"]?.value ?? []).includes("欠席"))
    .map(rec => ({
    体験参加日: rec["体験参加日"]?.value ?? "",
    時刻: rec["時刻"]?.value ?? "",
    氏: rec["氏"]?.value ?? "",
    名: rec["名"]?.value ?? "",
    フリガナ: rec["フリガナ"]?.value ?? "",
    学年: rec["学年"]?.value ?? "",
    そろばん経験: rec["そろばん経験"]?.value ?? "",
    教室名: rec["教室名"]?.value ?? "",
  }));

  return { success: true, records };
}

/**
 * GET /api/staff/seito?school=all|早宮校|氷川台校|中村校
 * Returns active 生徒名簿 (App 19) records.
 * Excludes records where 退会日 is set and in the past.
 * Fields: 生徒番号, コース名, 氏, 名, フリガナ, 学年, クラス, 初回授業日, 退会日, 教室名
 */
async function handleStaffSeito(params, env) {
  const school = params.get("school") ?? "all";
  const conditions = [
    `所属組織 in ("アルファーブレイン")`,
    `(退会日 = "" or 退会日 >= TODAY())`,
  ];
  if (school !== "all") conditions.unshift(`教室名 = "${escapeQueryValue(school)}"`);
  const query = `${conditions.join(" and ")} order by 生徒番号 asc limit 500`;

  const data = await kintoneGet(APP.SEITO_NEW, query, env.TOKEN_SEITO_NEW);
  const records = (data.records ?? []).map(rec => ({
    生徒番号: rec["生徒番号"]?.value ?? "",
    コース名: rec["コース名"]?.value ?? "",
    氏: rec["氏"]?.value ?? "",
    名: rec["名"]?.value ?? "",
    フリガナ: rec["フリガナ"]?.value ?? "",
    学年: rec["学年"]?.value ?? "",
    クラス: rec["クラス"]?.value ?? "",
    初回授業日: rec["初回授業日"]?.value ?? "",
    退会日: rec["退会日"]?.value ?? "",
    教室名: rec["教室名"]?.value ?? "",
    コマ1: rec["コマ1"]?.value ?? "",
    コマ2: rec["コマ2"]?.value ?? "",
    コマ3: rec["コマ3"]?.value ?? "",
    コマ4: rec["コマ4"]?.value ?? "",
    コマ5: rec["コマ5"]?.value ?? "",
  }));

  return { success: true, records };
}

/**
 * GET /api/staff/kesseki?school=all|早宮校|氷川台校|中村校
 * Returns 振替管理 (App 14) records where 欠席日 >= TODAY() or 振替受講日 >= TODAY().
 * Fields: 生徒番号, 氏, 名, 教室名, 欠席日, 振替受講日, 振替教室名, 振替期日_終_, 時刻
 */
async function handleStaffKesseki(params, env) {
  const school = params.get("school") ?? "all";
  const conditions = [`(欠席日 >= TODAY() or 振替受講日 >= TODAY())`];
  if (school !== "all") conditions.unshift(`教室名 = "${escapeQueryValue(school)}"`);
  const query = `${conditions.join(" and ")} order by 欠席日 asc limit 500`;

  const data = await kintoneGet(APP.FURIKAE, query, env.TOKEN_FURIKAE);
  const records = (data.records ?? []).map(rec => ({
    生徒番号: rec["生徒番号"]?.value ?? "",
    氏: rec["氏"]?.value ?? "",
    名: rec["名"]?.value ?? "",
    教室名: rec["教室名"]?.value ?? "",
    欠席日: rec["欠席日"]?.value ?? "",
    振替受講日: rec["振替受講日"]?.value ?? "",
    振替教室名: rec["振替教室名"]?.value ?? "",
    振替期日_終_: rec["振替期日_終_"]?.value ?? "",
    時刻: rec["時刻"]?.value ?? "",
  }));

  return { success: true, records };
}

const BREAKEVEN_TOTAL = 30; // 全社黒字化ライン（生徒数）

/**
 * GET /api/staff/stats
 * Returns KPI stats:
 *   - seito_count: { total, 早宮校, 氷川台校, 中村校 }
 *   - monthly: [ { month: "2026-06", 全体: {taiken, nyukai}, 早宮校: {...}, ... } ]
 */
async function handleStaffStats(env) {
  const SCHOOLS = ["早宮校", "氷川台校", "中村校"];

  // 体験参加名簿（過去・当日のみ）。欠席除外はJS側で処理
  const taikenQuery = `所属組織 in ("アルファーブレイン") and 体験参加日 <= TODAY() order by 体験参加日 asc limit 500`;
  const taikenData = await kintoneGet(APP.TAIKEN, taikenQuery, env.TOKEN_TAIKEN);
  const taikenRecs = (taikenData.records ?? []).filter(r => !(r["出欠"]?.value ?? []).includes("欠席"));

  // 在籍生徒（退会していないもの全件）
  const seitoQuery = `所属組織 in ("アルファーブレイン") and (退会日 = "" or 退会日 >= TODAY()) order by 生徒番号 asc limit 500`;
  const seitoData = await kintoneGet(APP.SEITO_NEW, seitoQuery, env.TOKEN_SEITO_NEW);
  const seitoRecs = seitoData.records ?? [];

  // ── 生徒数集計（生徒番号に"-"を含むサブ番号レコードは除外）──────────────
  const countableRecs = seitoRecs.filter(r => !String(r["生徒番号"]?.value ?? "").includes("-"));
  const seitoCount = { total: countableRecs.length };
  for (const school of SCHOOLS) {
    seitoCount[school] = countableRecs.filter(r => r["教室名"]?.value === school).length;
  }

  // ── 月別集計 ────────────────────────────────────────────────────
  // 体験: 2回目を除く（反響媒体に「2回目」を含まない）
  const monthSet = new Set();

  // { "2026-06_早宮校": { taiken: N, nyukai: N } }
  const byMonthSchool = {};

  for (const rec of taikenRecs) {
    const date = rec["体験参加日"]?.value ?? "";
    const media = rec["反響媒体"]?.value ?? "";
    if (!date || media.includes("2回目")) continue;
    const month = date.slice(0, 7); // "YYYY-MM"
    const school = rec["教室名"]?.value ?? "";
    monthSet.add(month);
    const keys = [`${month}_全体`, `${month}_${school}`];
    for (const k of keys) {
      if (!byMonthSchool[k]) byMonthSchool[k] = { taiken: 0, nyukai: 0 };
      byMonthSchool[k].taiken++;
    }
  }

  // サブ番号（"-"含む）を除外して入会数を集計
  for (const rec of countableRecs) {
    const date = rec["作成日時"]?.value ?? "";
    if (!date) continue;
    const month = date.slice(0, 7); // "2026-06T..." → "2026-06"
    const school = rec["教室名"]?.value ?? "";
    monthSet.add(month);
    const keys = [`${month}_全体`, `${month}_${school}`];
    for (const k of keys) {
      if (!byMonthSchool[k]) byMonthSchool[k] = { taiken: 0, nyukai: 0 };
      byMonthSchool[k].nyukai++;
    }
  }

  const months = [...monthSet].sort();
  const monthly = months.map(month => {
    const row = { month };
    for (const label of ["全体", ...SCHOOLS]) {
      const d = byMonthSchool[`${month}_${label}`] ?? { taiken: 0, nyukai: 0 };
      row[label] = d;
    }
    return row;
  });

  return {
    success: true,
    seito_count: seitoCount,
    breakeven: BREAKEVEN_TOTAL,
    monthly,
  };
}

// ─── Main fetch handler ──────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") ?? "";
    const url = new URL(request.url);
    const path = url.pathname;

    // ── Preflight ────────────────────────────────────────────────────────────
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin),
      });
    }

    // ── GET routes (query-param based) ──────────────────────────────────────
    if (request.method === "GET") {
      const params = url.searchParams;
      let result;
      try {
        if (path === "/api/jugyo") {
          result = await handleJugyo(params, env);
        } else if (path === "/api/active-classrooms") {
          result = await handleActiveClassrooms(env);
        } else if (path === "/api/all-classrooms") {
          result = await handleAllClassrooms(env);
        } else if (path === "/api/classrooms") {
          result = await handleClassrooms(params, env);
        } else if (path === "/api/gakuhi") {
          result = await handleGakuhi(params, env);
        } else if (path === "/api/furikae-tickets") {
          result = await handleFurikaeTickets(params, env);
        } else if (path === "/api/absence-count") {
          result = await handleAbsenceCount(params, env);
        } else if (path === "/api/staff/taiken") {
          if (!isValidStaffAuth(request, env)) {
            return jsonResponse({ success: false, error: "認証が必要です" }, 401, origin);
          }
          result = await handleStaffTaiken(params, env);
        } else if (path === "/api/staff/seito") {
          if (!isValidStaffAuth(request, env)) {
            return jsonResponse({ success: false, error: "認証が必要です" }, 401, origin);
          }
          result = await handleStaffSeito(params, env);
        } else if (path === "/api/staff/kesseki") {
          if (!isValidStaffAuth(request, env)) {
            return jsonResponse({ success: false, error: "認証が必要です" }, 401, origin);
          }
          result = await handleStaffKesseki(params, env);
        } else if (path === "/api/staff/stats") {
          if (!isValidStaffAuth(request, env)) {
            return jsonResponse({ success: false, error: "認証が必要です" }, 401, origin);
          }
          result = await handleStaffStats(env);
        } else {
          return errorResponse("Not Found", 404, origin);
        }
      } catch (err) {
        console.error("Worker error:", err);
        return errorResponse(err.message || "サーバーエラーが発生しました", 500, origin);
      }
      if (result.success === false) {
        return jsonResponse({ success: false, error: result.error }, result.status ?? 400, origin);
      }
      return jsonResponse(result, 200, origin);
    }

    // ── Only POST for remaining API routes ───────────────────────────────────
    if (request.method !== "POST") {
      return errorResponse("Method Not Allowed", 405, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return errorResponse("リクエストのJSONが不正です", 400, origin);
    }

    try {
      let result;

      switch (path) {
        case "/api/lookup":
          result = await handleLookup(body, env);
          break;
        case "/api/taiken":
          result = await handleTaiken(body, env, origin);
          break;
        case "/api/kesseki":
          result = await handleKesseki(body, env);
          break;
        case "/api/kentei":
          result = await handleKentei(body, env);
          break;
        case "/api/nyukai":
          result = await handleNyukai(body, env, origin);
          break;
        case "/api/class-change":
          result = await handleClassChange(body, env);
          break;
        case "/api/furikae":
          result = await handleFurikae(body, env);
          break;
        case "/api/flash-anzan":
          result = await handleFlashAnzan(body, env);
          break;
        case "/api/staff/auth":
          result = await handleStaffAuth(body, env);
          break;
        default:
          return errorResponse("Not Found", 404, origin);
      }

      // Handlers can return { success: false, error, status } for user errors.
      if (result.success === false) {
        const status = result.status ?? 400;
        return jsonResponse(
          { success: false, error: result.error },
          status,
          origin
        );
      }

      return jsonResponse(result, 200, origin);
    } catch (err) {
      console.error("Worker error:", err);
      return errorResponse(
        err.message || "サーバーエラーが発生しました",
        500,
        origin
      );
    }
  },
};
