// Cloudflare Worker - API Proxy for Rakutama Soroban School Forms
// Bridges static GitHub Pages forms → kintone (cybozu.com)

const KINTONE_BASE = "https://o81m0gfyv532.cybozu.com";

const APP = {
  SEITO: 8,       // 生徒名簿
  SEIKYUU: 9,     // 請求先マスタ
  JUGYO: 6,       // 授業マスタ
  GAKUHI: 10,     // 月謝マスタ
  KENTEI: 12,     // 検定申込
  FURIKAE: 14,    // 振替管理
  TAIKEN: 17,     // 体験参加名簿
};

const ALLOWED_ORIGINS = [
  "https://form.rakutama-tokyo.com",
  "https://form.rakutama-soroban.com",
  "https://amayira.github.io",
];

// ドメインごとの所属組織コード（kintoneシステム管理→組織のコード）
// 関西版を追加する際はここにドメインとコードを追記する
const DOMAIN_ORG_MAP = {
  "form.rakutama-tokyo.com":   "アルファーブレイン",
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
  const paddedNum = String(nextNum).padStart(digits, "0");
  return `${prefix}${separator}${paddedNum}`;
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
  const data = await kintoneGet(APP.SEITO, query, env.TOKEN_SEITO);

  if (!data.records || data.records.length === 0) {
    return { success: false, error: "生徒番号が見つかりません", status: 404 };
  }

  const rec = data.records[0];

  // Extract subtable rows where 状態 = "受講中"
  const jugyoIds = [];
  const subtable = rec["受講テーブル"]?.value;
  if (Array.isArray(subtable)) {
    for (const row of subtable) {
      const rowFields = row.value;
      if (rowFields["状態"]?.value === "受講中") {
        const jugyoId = rowFields["授業ID"]?.value;
        if (jugyoId) jugyoIds.push(jugyoId);
      }
    }
  }

  return {
    success: true,
    student: {
      familyName: rec["氏"]?.value ?? "",
      givenName: rec["名"]?.value ?? "",
      classroom: rec["教室名"]?.value ?? "",
      billingId: rec["請求先ID"]?.value ?? "",
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
  const record = buildRecord({
    生徒番号: body["生徒番号"] ?? "",
    請求ID: body["請求ID"] ?? "",
    教室名: body["教室名"] ?? "",
    氏: body["氏"] ?? "",
    名: body["名"] ?? "",
    欠席日: body["欠席日"] ?? "",
    振替受講期日: body["振替受講期日"] ?? "",
    備考: body["備考"] ?? "",
  });

  await kintonePost(APP.FURIKAE, record, env.TOKEN_FURIKAE);
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
  if (body["珠算受験級"]) fields["珠算受験級"] = body["珠算受験級"];

  const record = buildRecord(fields);
  await kintonePost(APP.KENTEI, record, env.TOKEN_KENTEI);
  return { success: true };
}

/**
 * POST /api/nyukai
 * Enrollment flow:
 *   1. If isSibling=true → look up existing 請求先ID from sibling record.
 *   2. If isSibling=false → create 請求先マスタ record → get auto-generated 請求先ID.
 *   3. Create 生徒名簿 record with student data + 請求先ID.
 */
async function handleNyukai(body, env, origin) {
  const { isSibling, siblingStudentId, guardian, student } = body;
  const orgCode = getOrgCode(origin);

  let billingId;

  if (isSibling) {
    // ── Sibling path: reuse existing billing record ──────────────────────────
    if (!siblingStudentId) {
      return {
        success: false,
        error: "在籍中のお子様の生徒番号を入力してください",
        status: 400,
      };
    }

    const query = `生徒番号 = "${siblingStudentId}"`;
    const data = await kintoneGet(APP.SEITO, query, env.TOKEN_SEITO);

    if (!data.records || data.records.length === 0) {
      return {
        success: false,
        error: "在籍中のお子様の生徒番号が見つかりません",
        status: 404,
      };
    }

    billingId = data.records[0]["請求先ID"]?.value ?? "";

    if (!billingId) {
      return {
        success: false,
        error: "既存生徒の請求先IDを取得できませんでした",
        status: 500,
      };
    }
  } else {
    // ── New guardian: create 請求先マスタ record ─────────────────────────────
    if (!guardian) {
      return {
        success: false,
        error: "保護者情報が不足しています",
        status: 400,
      };
    }

    // Worker側で採番: P- + 4桁ゼロ埋め
    billingId = await generateNextId(
      APP.SEIKYUU, "請求先ID", "P", "-", 4, env.TOKEN_SEIKYUU
    );

    const guardianRecord = {
      ...buildRecord({
        請求先ID: billingId,
        保護者名: guardian["保護者名"] ?? "",
        フリガナ: guardian["フリガナ"] ?? "",
        電話番号1: guardian["電話番号1"] ?? "",
        電話番号2: guardian["電話番号2"] ?? "",
        メールアドレス: guardian["メールアドレス"] ?? "",
        郵便番号: guardian["郵便番号"] ?? "",
        住所: guardian["住所"] ?? "",
        "支払い方法": "新入会",
        口座名義人: guardian["口座名義人"] ?? "",
      }),
      // 組織選択型は特殊形式 { value: [{ code: "..." }] }
      所属組織: { value: [{ code: orgCode }] },
    };

    await kintonePost(APP.SEIKYUU, guardianRecord, env.TOKEN_SEIKYUU);
  }

  // ── Create 生徒名簿 record ──────────────────────────────────────────────────
  if (!student) {
    return { success: false, error: "生徒情報が不足しています", status: 400 };
  }

  // Worker側で採番: S- + 5桁ゼロ埋め
  const studentId = await generateNextId(
    APP.SEITO, "生徒番号", "S", "-", 5, env.TOKEN_SEITO
  );

  const studentRecord = buildRecord({
    生徒番号: studentId,
    氏: student["氏"] ?? "",
    名: student["名"] ?? "",
    フリガナ: student["フリガナ"] ?? "",
    生年月日: student["生年月日"] ?? "",
    学校名: student["学校名"] ?? "",
    学年: student["学年"] ?? "",
    教室名: student["教室名"] ?? "",
    請求先ID: billingId,
    // 月謝ID はルックアップ型（月謝マスタ参照）
    月謝ID: student["gakuhiId"] ?? "",
  });

  // 受講テーブル はサブテーブル型 — 複数クラス選択に対応（jugyoIds は配列）
  const today = new Date().toISOString().split("T")[0];
  const jugyoIds = Array.isArray(student["jugyoIds"]) ? student["jugyoIds"]
    : student["jugyoId"] ? [student["jugyoId"]] : [];
  studentRecord["受講テーブル"] = {
    value: jugyoIds.map(id => ({
      value: {
        授業ID: { value: id },
        受講開始日: { value: today },
        状態: { value: "受講中" },
      },
    })),
  };

  // 請求先ID（請求先マスタ）・教室名（教室マスタ）・月謝ID（月謝マスタ）のルックアップ用にマルチトークン
  const seitoToken = [env.TOKEN_SEITO, env.TOKEN_SEIKYUU, env.TOKEN_KYOSHITSU, env.TOKEN_GAKUHI]
    .filter(Boolean).join(",");
  await kintonePost(APP.SEITO, studentRecord, seitoToken);

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

  const query = `教室名 = "${classroom}" and 開講状況 in ("開講中") order by 曜日 asc, 開始時刻 asc limit 100`;
  const data = await kintoneGet(APP.JUGYO, query, env.TOKEN_JUGYO);

  const classes = (data.records ?? []).map((rec) => ({
    id: rec["授業ID"]?.value ?? "",
    name: rec["授業名"]?.value ?? "",
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
  const appId = env.CLASS_CHANGE_APP_ID;
  const token = env.TOKEN_CLASS_CHANGE;

  if (!appId) {
    // App not yet created — return success with a note so forms don't break.
    return { success: true, note: "app_not_configured" };
  }

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

  await kintonePost(Number(appId), record, token);
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
        if (path === "/api/jugyo") {
          result = await handleJugyo(params, env);
        } else if (path === "/api/gakuhi") {
          result = await handleGakuhi(params, env);
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
