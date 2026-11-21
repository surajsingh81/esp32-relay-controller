const encoder = new TextEncoder();

function jsonResponse(data, status, corsHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders,
    },
  });
}

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Url(value) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function constantTimeEqual(left, right) {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

async function sign(payload, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
}

async function createSession(secret) {
  const payload = encodeBase64Url(encoder.encode(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 6 * 60 * 60,
  })));
  return `${payload}.${encodeBase64Url(await sign(payload, secret))}`;
}

async function hasValidSession(request, secret) {
  const authorization = request.headers.get("Authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(authorization);
  if (!match) return false;

  const [payload, signature, extra] = match[1].split(".");
  if (!payload || !signature || extra) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      decodeBase64Url(signature),
      encoder.encode(payload),
    );
    if (!valid) return false;
    const claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload)));
    return Number.isInteger(claims.exp) && claims.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

async function readStates(database) {
  const { results } = await database
    .prepare("SELECT relay_id, is_on FROM relay_state ORDER BY relay_id")
    .all();
  return {
    relay1: results.some((row) => row.relay_id === 1 && row.is_on === 1),
    relay2: results.some((row) => row.relay_id === 2 && row.is_on === 1),
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const corsHeaders = origin === env.WEB_ORIGIN
      ? {
          "Access-Control-Allow-Origin": env.WEB_ORIGIN,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
          "Access-Control-Max-Age": "600",
          Vary: "Origin",
        }
      : {};

    if (origin && origin !== env.WEB_ORIGIN) {
      return jsonResponse({ error: "Origin not allowed" }, 403, {});
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/login" && request.method === "POST") {
        const clientIp = request.headers.get("CF-Connecting-IP") ?? "unknown";
        const rateLimit = await env.LOGIN_LIMITER.limit({ key: clientIp });
        if (!rateLimit.success) {
          return jsonResponse({ error: "Too many sign-in attempts. Try again later." }, 429, corsHeaders);
        }
        const body = await request.json();
        if (!body || typeof body !== "object" || typeof body.password !== "string" ||
            body.password.length > 256 ||
            !constantTimeEqual(body.password, env.CONTROL_PASSWORD)) {
          return jsonResponse({ error: "Invalid password" }, 401, corsHeaders);
        }
        return jsonResponse(
          { token: await createSession(env.SESSION_SECRET) },
          200,
          corsHeaders,
        );
      }

      if (url.pathname === "/api/device/state" && request.method === "GET") {
        const authorization = request.headers.get("Authorization") ?? "";
        if (!authorization.startsWith("Bearer ") ||
            !constantTimeEqual(authorization.slice(7), env.DEVICE_TOKEN)) {
          return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
        }
        return jsonResponse(await readStates(env.DB), 200, corsHeaders);
      }

      if (!(await hasValidSession(request, env.SESSION_SECRET))) {
        return jsonResponse({ error: "Authentication required" }, 401, corsHeaders);
      }

      if (url.pathname === "/api/state" && request.method === "GET") {
        return jsonResponse(await readStates(env.DB), 200, corsHeaders);
      }

      const command = /^\/api\/relay\/([12])$/.exec(url.pathname);
      if (command && request.method === "POST") {
        const body = await request.json();
        if (!body || typeof body !== "object" || typeof body.on !== "boolean") {
          return jsonResponse({ error: "Expected boolean 'on'" }, 400, corsHeaders);
        }
        await env.DB.prepare(
          "UPDATE relay_state SET is_on = ? WHERE relay_id = ?",
        ).bind(body.on ? 1 : 0, Number(command[1])).run();
        return jsonResponse(await readStates(env.DB), 200, corsHeaders);
      }

      return jsonResponse({ error: "Not found" }, 404, corsHeaders);
    } catch (error) {
      if (error instanceof SyntaxError) {
        return jsonResponse({ error: "Invalid JSON" }, 400, corsHeaders);
      }
      console.error("API request failed:", error);
      return jsonResponse({ error: "Internal server error" }, 500, corsHeaders);
    }
  },
};
