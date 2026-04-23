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
};

const ALLOWED_ORIGINS = [
  "https://form.rakutama-tokyo.com",
  "https://rakutama-tokyo.com",
  "https://form.rakutama-soroban.com",
  "http://form.rakutama-soroban.com",
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
    return DOMAIN_ORG_MAP[host] ?? "alphabrain";
  } catch {
    return "alphabrain";
  }
}

// ─── kintone helpers ────────────────────────────────────────────────────────

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

/**
 * 時刻フィールドを kintone が受け付ける "HH:MM" 形式に正規化する。
 * クラス名（例: "早宮校(火)16時クラス"）が送られてきた場合も変換する。
 */
function normalizeTime(val) {
  if (!val) return "";
  // HH:MM or HH:MM:SS → normalize to HH:MM:SS
  if (/^\d{2}:\d{2}/.test(val)) {
    const base = val.slice(0, 5);
    return base + ":00";
  }
  // 授業ID末尾の HHMM 形式: "早宮校-火1700" → "17:00:00"
  const mId = String(val).match(/(\d{2})(\d{2})$/);
  if (mId) return `${mId[1]}:${mId[2]}:00`;
  // クラス名中の "16時" → "16:00:00"
  const mName = String(val).match(/(\d{1,2})時/);
  if (mName) return `${mName[1].padStart(2, "0")}:00:00`;
  return "";
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
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(body, status = 200, origin = ALLOWED_ORIGIN) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      ...corsHeaders(origin),
    },
  });
}

function errorResponse(message, status = 500, origin = ALLOWED_ORIGIN) {
  return jsonResponse({ success: false, error: message }, status, origin);
}

// ─── Route handlers ──────────────────────────────────────────────────────────

/**
 * POST /api/lookup
 * { studentNumber: "S00001" }
 * Returns student basic info + active 授業IDs from 受講テーブル subtable.
 */
async function handleLookup(body, env) {
  const { studentNumber } = body;
  if (!studentNumber) {
    return { success: false, error: "studentNumber は必須です", status: 400 };
  }

  const query = `生徒番号 = "${studentNumber}"`;
  const data = await kintoneGet(APP.SEITO_NEW, query, env.TOKEN_SEITO_NEW);

  if (!data.records || data.records.length === 0) {
    return { success: false, error: "生徒番号が見つかりません", status: 404 };
  }

  const rec = data.records[0];

  // App 19 stores classes in コマ1〜コマ4 fields (no subtable)
  const jugyoIds = ["コマ1", "コマ2", "コマ3", "コマ4"]
    .map(f => rec[f]?.value)
    .filter(v => v && v.trim() !== "");

  return {
    success: true,
    student: {
      familyName: rec["氏"]?.value ?? "",
      givenName: rec["名"]?.value ?? "",
      classroom: rec["教室名"]?.value ?? "",
      billingId: rec["請求先ID"]?.value ?? rec["請求ID"]?.value ?? "",
      jugyoIds,
    },
  };
}

/**
 * POST /api/taiken
 * Creates a record in 体験参加名簿 (App 17).
 */
async function handleTaiken(body, env) {
  // 教室名はルックアップ型のため、TOKEN_TAIKENとTOKEN_KYOSHITSUを両方渡して
  // 教室マスタへの閲覧権限を付与したマルチトークンで送信する
  const token = env.TOKEN_KYOSHITSU
    ? `${env.TOKEN_TAIKEN},${env.TOKEN_KYOSHITSU}`
    : env.TOKEN_TAIKEN;

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
    備考: body["備考"] ?? "",
  });

  await kintonePost(APP.TAIKEN, record, token);
  return { success: true };
}

/**
 * POST /api/kesseki
 * Creates a record in 振替管理 (App 14).
 */
async function handleKesseki(body, env) {
  const fields = {
    生徒番号: body["生徒番号"] ?? "",
    請求ID: body["請求ID"] ?? "",
    教室名: body["教室名"] ?? "",
    氏: body["氏"] ?? "",
    名: body["名"] ?? "",
    欠席日: body["欠席日"] ?? "",
    振替期日_始_: body["振替期日_始_"] ?? "",
    振替期日_終_: body["振替期日_終_"] ?? "",
    振替受講日: body["振替受講日"] ?? "",
    備考: body["備考"] ?? "",
  };
  const jikoku = normalizeTime(body["時刻"]);
  if (jikoku) fields["時刻"] = jikoku;
  const record = buildRecord(fields);

  const furikaeToken = [env.TOKEN_FURIKAE, env.TOKEN_SEITO_NEW].filter(Boolean).join(",");
  await kintonePost(APP.FURIKAE, record, furikaeToken);
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
  return { success: true };
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

  const conditions = [
    `生徒番号 = "${studentNumber}"`,
    `振替受講日 = ""`,
    `振替期日_始_ <= "${date}"`,
    `振替期日_終_ >= "${date}"`,
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

  const furikaeFields = {
    振替受講日: body["振替受講日"] ?? "",
    備考: body["備考"] ?? "",
  };
  const furikaeJikoku = normalizeTime(body["時刻"]);
  if (furikaeJikoku) furikaeFields["時刻"] = furikaeJikoku;
  const record = buildRecord(furikaeFields);

  const furikaeToken = [env.TOKEN_FURIKAE, env.TOKEN_SEITO_NEW].filter(Boolean).join(",");
  await kintoneUpdate(APP.FURIKAE, ticketId, record, furikaeToken);
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
  const orgCode = getOrgCode(origin);

  if (!student) {
    return { success: false, error: "生徒情報が不足しています", status: 400 };
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
  const coupon = g["クーポンコード"] ?? "";
  const sorobanOrders = Array.isArray(body["sorobanOrders"]) ? body["sorobanOrders"] : [];
  const userNotes = body["notes"] ?? "";

  // 備考フィールドを組み立て（そろばん購入希望 → 備考 → クーポンコード）
  const bikoLines = [];
  if (student["そろばん経験"] === "あり") {
    const levelPart = student["級・段"] ? `（${student["級・段"]}）` : "";
    bikoLines.push(`そろばん経験：あり${levelPart}`);
  }
  if (sorobanOrders.length > 0) {
    bikoLines.push(`【そろばん購入希望】\n${sorobanOrders.join("\n")}`);
  }
  if (userNotes) bikoLines.push(userNotes);
  if (coupon) bikoLines.push(`クーポンコード：${coupon}`);
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

  return { success: true };
}

/**
 * GET /api/active-classrooms
 * Returns list of classroom names that have at least one active class in 授業マスタ (App 6).
 */
async function handleActiveClassrooms(env) {
  const query = `開講状況 in ("開講中") order by 教室名 asc limit 500`;
  const data = await kintoneGet(APP.JUGYO, query, env.TOKEN_JUGYO);
  const seen = new Set();
  (data.records ?? []).forEach(rec => {
    const name = rec["教室名"]?.value;
    if (name) seen.add(name);
  });
  return { success: true, classrooms: [...seen] };
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

  const query = `教室名 = "${classroom}" and 開講状況 in ("開講中") order by 曜日 asc, 開始時刻 asc limit 100`;
  const data = await kintoneGet(APP.JUGYO, query, env.TOKEN_JUGYO);

  const classes = (data.records ?? []).map((rec) => ({
    id: rec["授業ID"]?.value ?? "",
    name: rec["授業名"]?.value ?? "",
    startTime: rec["開始時刻"]?.value ?? "",
  }));

  return { success: true, classes };
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

  const query = `所属組織 in ("${orgCode}") order by コース名 asc limit 100`;
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
    変更種別: body["変更種別"] ?? "",
    変更希望内容: body["変更希望内容"] ?? "",
    希望変更時期: body["希望時期"] ?? "",
    備考: body["備考"] ?? "",
  });

  await kintonePost(APP.CLASS_CHANGE, record, token);
  return { success: true };
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
        if (path === "/api/active-classrooms") {
          result = await handleActiveClassrooms(env);
        } else if (path === "/api/jugyo") {
          result = await handleJugyo(params, env);
        } else if (path === "/api/gakuhi") {
          result = await handleGakuhi(params, env);
        } else if (path === "/api/furikae-tickets") {
          result = await handleFurikaeTickets(params, env);
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
          result = await handleTaiken(body, env);
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
