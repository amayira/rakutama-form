// Cloudflare Worker - API Proxy for Rakutama Soroban School Forms
// Bridges static GitHub Pages forms → kintone (cybozu.com)

const KINTONE_BASE = "https://o81m0gfyv532.cybozu.com";

const APP = {
  SEITO: 8,       // 生徒名簿
  SEIKYUU: 9,     // 請求先マスタ
  KENTEI: 12,     // 検定申込
  FURIKAE: 14,    // 振替管理
  TAIKEN: 17,     // 体験参加名簿
};

const ALLOWED_ORIGINS = [
  "https://form.rakutama-tokyo.com",
  "https://amayira.github.io",
];

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
    throw new Error(
      `kintone POST app=${appId} failed: ${data.message || res.status}`
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

  await kintonePost(APP.TAIKEN, record, env.TOKEN_TAIKEN);
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
async function handleNyukai(body, env) {
  const { isSibling, siblingStudentId, guardian, student } = body;

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

    const guardianRecord = buildRecord({
      保護者名: guardian["保護者名"] ?? "",
      フリガナ: guardian["フリガナ"] ?? "",
      電話番号1: guardian["電話番号1"] ?? "",
      電話番号2: guardian["電話番号2"] ?? "",
      メールアドレス: guardian["メールアドレス"] ?? "",
      郵便番号: guardian["郵便番号"] ?? "",
      住所: guardian["住所"] ?? "",
      "支払い方法": guardian["支払い方法"] ?? "",
      口座名義人: guardian["口座名義人"] ?? "",
    });

    const postResult = await kintonePost(
      APP.SEIKYUU,
      guardianRecord,
      env.TOKEN_SEIKYUU
    );

    // postResult.id is the internal record ID ($id); we need the
    // auto-generated 請求先ID field value, so we fetch the record.
    const getResult = await kintoneGetById(
      APP.SEIKYUU,
      postResult.id,
      env.TOKEN_SEIKYUU
    );
    billingId = getResult.record["請求先ID"]?.value ?? "";

    if (!billingId) {
      return {
        success: false,
        error: "請求先IDを取得できませんでした",
        status: 500,
      };
    }
  }

  // ── Create 生徒名簿 record ──────────────────────────────────────────────────
  if (!student) {
    return { success: false, error: "生徒情報が不足しています", status: 400 };
  }

  const studentRecord = buildRecord({
    氏: student["氏"] ?? "",
    名: student["名"] ?? "",
    フリガナ: student["フリガナ"] ?? "",
    生年月日: student["生年月日"] ?? "",
    学校名: student["学校名"] ?? "",
    学年: student["学年"] ?? "",
    教室名: student["教室名"] ?? "",
    請求先ID: billingId,
  });

  await kintonePost(APP.SEITO, studentRecord, env.TOKEN_SEITO);

  return { success: true };
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

    // ── Only POST for API routes ─────────────────────────────────────────────
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
          result = await handleNyukai(body, env);
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
