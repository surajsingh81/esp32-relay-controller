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

function getLocalClock(epochMs, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epochMs));
  const part = (type) => Number(parts.find((item) => item.type === type).value);
  const year = part("year");
  const month = part("month");
  const day = part("day");
  const secondOfDay = part("hour") * 3600 + part("minute") * 60 + part("second");
  const dayNumber = Math.floor(Date.UTC(year, month - 1, day) / 86400000);
  return { absoluteSeconds: dayNumber * 86400 + secondOfDay, secondOfDay };
}

function getScheduledWindow(relay, localClock) {
  const [hours, minutes] = relay.startTime.split(":").map(Number);
  const startSeconds = hours * 3600 + minutes * 60;
  const startDay = localClock.secondOfDay >= startSeconds
    ? Math.floor(localClock.absoluteSeconds / 86400)
    : Math.floor(localClock.absoluteSeconds / 86400) - 1;
  const occurrenceStart = startDay * 86400 + startSeconds;
  const elapsed = localClock.absoluteSeconds - occurrenceStart;
  return {
    occurrenceStart,
    active: elapsed >= 0 && elapsed < relay.durationMinutes * 60,
  };
}

async function readRelaySettings(database) {
  const { results } = await database
    .prepare(
      `SELECT state.relay_id, state.is_on, settings.mode, settings.start_time,
              settings.duration_minutes, settings.schedule_enabled
       FROM relay_state AS state
       LEFT JOIN relay_settings AS settings ON settings.relay_id = state.relay_id
       ORDER BY state.relay_id`,
    )
    .all();
  return results.map((row) => ({
    id: row.relay_id,
    mode: row.mode ?? "manual",
    manualOn: row.is_on === 1,
    startTime: row.start_time ?? "08:00",
    durationMinutes: row.duration_minutes ?? 30,
    scheduleEnabled: row.schedule_enabled === 1,
  }));
}

async function readSkippedSchedules(database) {
  const { results } = await database
    .prepare("SELECT relay_id, occurrence_start FROM skipped_schedule")
    .all();
  return new Map(results.map((row) => [row.relay_id, row.occurrence_start]));
}

function makeRelayState(relays, skippedSchedules, timeZone, nowMs) {
  const localClock = getLocalClock(nowMs, timeZone);
  const state = { timezone: timeZone, relays: {} };

  for (const relay of relays) {
    const window = getScheduledWindow(relay, localClock);
    const scheduleSkipped = skippedSchedules.get(relay.id) === window.occurrenceStart;
    const isOn = relay.mode === "auto"
      ? relay.scheduleEnabled && window.active && !scheduleSkipped
      : relay.manualOn;

    state[`relay${relay.id}`] = isOn;
    state.relays[`relay${relay.id}`] = {
      mode: relay.mode,
      manualOn: relay.manualOn,
      startTime: relay.startTime,
      durationMinutes: relay.durationMinutes,
      scheduleEnabled: relay.scheduleEnabled,
      isOn,
    };
  }
  return state;
}

async function readStates(database, timeZone, nowMs = Date.now()) {
  const [relays, skippedSchedules] = await Promise.all([
    readRelaySettings(database),
    readSkippedSchedules(database),
  ]);
  return makeRelayState(relays, skippedSchedules, timeZone, nowMs);
}

async function readDeviceState(database, timeZone) {
  const nowMs = Date.now();
  const lastPoll = await database
    .prepare("SELECT last_poll_ms FROM device_poll_state WHERE id = 1")
    .first();
  const lastPollMs = lastPoll?.last_poll_ms ?? 0;
  const relays = await readRelaySettings(database);
  const skippedSchedules = await readSkippedSchedules(database);
  const localClock = getLocalClock(nowMs, timeZone);
  const lastPollClock = lastPollMs
    ? getLocalClock(lastPollMs, timeZone)
    : null;

  for (const relay of relays) {
    if (relay.mode !== "auto" || !relay.scheduleEnabled) continue;

    const window = getScheduledWindow(relay, localClock);
    const pollWasInterrupted = !lastPollMs || nowMs - lastPollMs > 15000;
    const missedStart = lastPollClock === null ||
      lastPollClock.absoluteSeconds < window.occurrenceStart;
    if (window.active && pollWasInterrupted && missedStart) {
      await database.prepare(
        `INSERT INTO skipped_schedule (relay_id, occurrence_start) VALUES (?, ?)
         ON CONFLICT(relay_id) DO UPDATE SET occurrence_start = excluded.occurrence_start`,
      ).bind(relay.id, window.occurrenceStart).run();
      skippedSchedules.set(relay.id, window.occurrenceStart);
    }
  }

  await database.prepare(
    "UPDATE device_poll_state SET last_poll_ms = ? WHERE id = 1",
  ).bind(nowMs).run();

  return makeRelayState(relays, skippedSchedules, timeZone, nowMs);
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
        if (!env.CONTROL_PASSWORD || !env.SESSION_SECRET) {
          return jsonResponse({ error: "Authentication is not configured" }, 503, corsHeaders);
        }
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
        if (!env.DEVICE_TOKEN || !authorization.startsWith("Bearer ") ||
            !constantTimeEqual(authorization.slice(7), env.DEVICE_TOKEN)) {
          return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
        }
        return jsonResponse(await readDeviceState(env.DB, env.TIME_ZONE), 200, corsHeaders);
      }

      if (!(await hasValidSession(request, env.SESSION_SECRET))) {
        return jsonResponse({ error: "Authentication required" }, 401, corsHeaders);
      }

      if (url.pathname === "/api/state" && request.method === "GET") {
        return jsonResponse(await readStates(env.DB, env.TIME_ZONE), 200, corsHeaders);
      }

      const modeRoute = /^\/api\/relay\/([12])\/mode$/.exec(url.pathname);
      if (modeRoute && request.method === "POST") {
        const body = await request.json();
        if (!body || typeof body !== "object" ||
            !["manual", "auto"].includes(body.mode)) {
          return jsonResponse({ error: "Expected mode 'manual' or 'auto'" }, 400, corsHeaders);
        }
        await env.DB.prepare(
          "UPDATE relay_settings SET mode = ? WHERE relay_id = ?",
        ).bind(body.mode, Number(modeRoute[1])).run();
        return jsonResponse(await readStates(env.DB, env.TIME_ZONE), 200, corsHeaders);
      }

      const scheduleRoute = /^\/api\/relay\/([12])\/schedule$/.exec(url.pathname);
      if (scheduleRoute && request.method === "POST") {
        const body = await request.json();
        if (!body || typeof body !== "object" ||
            typeof body.startTime !== "string" ||
            !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(body.startTime) ||
            !Number.isInteger(body.durationMinutes) ||
            body.durationMinutes < 1 || body.durationMinutes > 1439) {
          return jsonResponse({
            error: "Use a 24-hour start time and a duration from 1 to 1439 minutes",
          }, 400, corsHeaders);
        }
        await env.DB.prepare(
          `UPDATE relay_settings
           SET start_time = ?, duration_minutes = ?, schedule_enabled = 1, mode = 'auto'
           WHERE relay_id = ?`,
        ).bind(body.startTime, body.durationMinutes, Number(scheduleRoute[1])).run();
        return jsonResponse(await readStates(env.DB, env.TIME_ZONE), 200, corsHeaders);
      }

      const command = /^\/api\/relay\/([12])$/.exec(url.pathname);
      if (command && request.method === "POST") {
        const body = await request.json();
        if (!body || typeof body !== "object" || typeof body.on !== "boolean") {
          return jsonResponse({ error: "Expected boolean 'on'" }, 400, corsHeaders);
        }
        const settings = await env.DB.prepare(
          "SELECT mode FROM relay_settings WHERE relay_id = ?",
        ).bind(Number(command[1])).first();
        if (settings?.mode !== "manual") {
          return jsonResponse({ error: "Switch this relay to Manual mode before toggling it" },
            409, corsHeaders);
        }
        await env.DB.prepare(
          "UPDATE relay_state SET is_on = ? WHERE relay_id = ?",
        ).bind(body.on ? 1 : 0, Number(command[1])).run();
        return jsonResponse(await readStates(env.DB, env.TIME_ZONE), 200, corsHeaders);
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
