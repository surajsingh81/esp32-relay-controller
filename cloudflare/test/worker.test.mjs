import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.js";

class MockD1 {
  constructor() {
    this.relays = [1, 2].map((id) => ({
      id,
      isOn: 0,
      mode: "manual",
      startTime: "08:00",
      durationMinutes: 30,
      name: `Relay ${id}`,
    }));
    this.schedules = [];
    this.skippedSchedules = [];
    this.deviceLogs = [];
    this.lastPollMs = 0;
    this.nextScheduleId = 1;
    this.nextLogId = 1;
  }

  prepare(query) {
    const statement = {
      query,
      values: [],
      bind: (...values) => {
        statement.values = values;
        return statement;
      },
      all: async () => ({ results: this.execute(query, statement.values, "all") }),
      first: async () => this.execute(query, statement.values, "first"),
      run: async () => ({ success: this.execute(query, statement.values, "run") }),
    };
    return statement;
  }

  async batch(statements) {
    for (const statement of statements) await statement.run();
    return [];
  }

  execute(query, values, operation) {
    const sql = query.replace(/\s+/g, " ").trim().toUpperCase();
    if (sql.startsWith("SELECT STATE.RELAY_ID")) {
      return this.relays.map((relay) => ({
        relay_id: relay.id,
        is_on: relay.isOn,
        mode: relay.mode,
        start_time: relay.startTime,
        duration_minutes: relay.durationMinutes,
        name: relay.name,
      }));
    }
    if (sql.startsWith("SELECT ID, RELAY_ID, START_TIME, DURATION_MINUTES")) {
      return this.schedules
        .toSorted((left, right) =>
          left.relayId - right.relayId || left.startTime.localeCompare(right.startTime))
        .map((schedule) => ({
          id: schedule.id,
          relay_id: schedule.relayId,
          start_time: schedule.startTime,
          duration_minutes: schedule.durationMinutes,
        }));
    }
    if (sql.startsWith("SELECT RELAY_ID, SCHEDULE_ID, OCCURRENCE_START")) {
      return this.skippedSchedules.map((schedule) => ({
        relay_id: schedule.relayId,
        schedule_id: schedule.scheduleId,
        occurrence_start: schedule.occurrenceStart,
      }));
    }
    if (sql.startsWith("SELECT LAST_POLL_MS")) {
      return { last_poll_ms: this.lastPollMs };
    }
    if (sql.startsWith("SELECT MODE FROM RELAY_SETTINGS")) {
      return { mode: this.relays[values[0] - 1].mode };
    }
    if (sql.startsWith("SELECT ID, CREATED_AT, LEVEL, MESSAGE FROM DEVICE_LOGS")) {
      const limit = values[0];
      return this.deviceLogs
        .toSorted((left, right) => right.id - left.id)
        .slice(0, limit)
        .map((log) => ({
          id: log.id,
          created_at: log.createdAt,
          level: log.level,
          message: log.message,
        }));
    }
    if (operation !== "run") throw new Error(`Unexpected query: ${sql}`);

    if (sql.startsWith("DELETE FROM RELAY_SCHEDULES")) {
      const removedIds = new Set(
        this.schedules.filter((schedule) => schedule.relayId === values[0])
          .map((schedule) => schedule.id),
      );
      this.schedules = this.schedules.filter((schedule) => schedule.relayId !== values[0]);
      this.skippedSchedules = this.skippedSchedules.filter(
        (schedule) => !removedIds.has(schedule.scheduleId),
      );
      return true;
    }
    if (sql.startsWith("INSERT INTO RELAY_SCHEDULES")) {
      this.schedules.push({
        id: this.nextScheduleId++,
        relayId: values[0],
        startTime: values[1],
        durationMinutes: values[2],
      });
      return true;
    }
    if (sql.startsWith("UPDATE RELAY_SETTINGS SET START_TIME")) {
      const relay = this.relays[values[2] - 1];
      relay.startTime = values[0];
      relay.durationMinutes = values[1];
      relay.mode = "auto";
      return true;
    }
    if (sql.startsWith("UPDATE RELAY_SETTINGS SET MODE")) {
      this.relays[values[1] - 1].mode = values[0];
      return true;
    }
    if (sql.startsWith("UPDATE RELAY_METADATA")) {
      this.relays[values[1] - 1].name = values[0];
      return true;
    }
    if (sql.startsWith("UPDATE RELAY_STATE")) {
      this.relays[values[1] - 1].isOn = values[0];
      return true;
    }
    if (sql.startsWith("UPDATE DEVICE_POLL_STATE")) {
      this.lastPollMs = values[0];
      return true;
    }
    if (sql.startsWith("INSERT OR IGNORE INTO SKIPPED_SCHEDULE_OCCURRENCES")) {
      const duplicate = this.skippedSchedules.some((schedule) =>
        schedule.relayId === values[0] &&
        schedule.scheduleId === values[1] &&
        schedule.occurrenceStart === values[2]);
      if (!duplicate) {
        this.skippedSchedules.push({
          relayId: values[0],
          scheduleId: values[1],
          occurrenceStart: values[2],
        });
      }
      return true;
    }
    if (sql.startsWith("INSERT INTO DEVICE_LOGS")) {
      this.deviceLogs.push({
        id: this.nextLogId++,
        createdAt: values[0],
        level: values[1],
        message: values[2],
      });
      return true;
    }
    if (sql.startsWith("DELETE FROM DEVICE_LOGS")) {
      const keep = values[0];
      this.deviceLogs = this.deviceLogs.toSorted((left, right) => right.id - left.id)
        .slice(0, keep);
      return true;
    }
    throw new Error(`Unexpected mutation: ${sql}`);
  }
}

function createEnvironment() {
  return {
    DB: new MockD1(),
    CONTROL_PASSWORD: "test-control-password",
    SESSION_SECRET: "test-session-secret",
    DEVICE_TOKEN: "test-device-token",
    WEB_ORIGIN: "https://control.test",
    TIME_ZONE: "Asia/Kolkata",
    LOGIN_LIMITER: { limit: async () => ({ success: true }) },
  };
}

async function request(env, path, {
  method = "GET",
  body,
  token,
  device = false,
  origin = env.WEB_ORIGIN,
} = {}) {
  const headers = {};
  if (origin) headers.Origin = origin;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  if (device) headers.Authorization = `Bearer ${env.DEVICE_TOKEN}`;
  const response = await worker.fetch(new Request(`https://api.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  return { response, data: await response.json() };
}

async function signIn(env) {
  const { response, data } = await request(env, "/api/login", {
    method: "POST",
    body: { password: env.CONTROL_PASSWORD },
  });
  assert.equal(response.status, 200);
  return data.token;
}

function activeDailyWindows() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const hour = Number(parts.find((part) => part.type === "hour").value);
  const minute = Number(parts.find((part) => part.type === "minute").value);
  const currentMinute = hour * 60 + minute;
  const toTime = (minutes) =>
    `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

  if (currentMinute >= 11) {
    return [
      { startTime: toTime(currentMinute - 10), durationMinutes: 30 },
      { startTime: toTime(currentMinute - 5), durationMinutes: 30 },
    ];
  }
  return [
    { startTime: "23:50", durationMinutes: 1439 },
    { startTime: "23:51", durationMinutes: 1439 },
  ];
}

test("authentication, CORS, and manual relay commands", async () => {
  const env = createEnvironment();
  const unauthorized = await request(env, "/api/state");
  assert.equal(unauthorized.response.status, 401);

  const blockedOrigin = await request(env, "/api/state", {
    origin: "https://attacker.test",
  });
  assert.equal(blockedOrigin.response.status, 403);

  const preflight = await worker.fetch(new Request("https://api.test/api/state", {
    method: "OPTIONS",
    headers: { Origin: env.WEB_ORIGIN },
  }), env);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), env.WEB_ORIGIN);

  const invalidLogin = await request(env, "/api/login", {
    method: "POST",
    body: { password: "wrong" },
  });
  assert.equal(invalidLogin.response.status, 401);

  const token = await signIn(env);
  const turnedOn = await request(env, "/api/relay/1", {
    method: "POST",
    body: { on: true },
    token,
  });
  assert.equal(turnedOn.response.status, 200);
  assert.equal(turnedOn.data.relay1, true);

  await request(env, "/api/relay/1/mode", {
    method: "POST",
    body: { mode: "auto" },
    token,
  });
  const manualCommandInAuto = await request(env, "/api/relay/1", {
    method: "POST",
    body: { on: false },
    token,
  });
  assert.equal(manualCommandInAuto.response.status, 409);
});

test("saves multiple timings, computes overlapping windows, and skips missed starts individually", async () => {
  const env = createEnvironment();
  const token = await signIn(env);
  const schedules = activeDailyWindows();
  const save = await request(env, "/api/relay/1/schedules", {
    method: "POST",
    body: { schedules },
    token,
  });
  assert.equal(save.response.status, 200);
  assert.deepEqual(
    save.data.relays.relay1.schedules,
    schedules.toSorted((left, right) => left.startTime.localeCompare(right.startTime)),
  );
  assert.equal(save.data.relay1, true);

  env.DB.lastPollMs = Date.now();
  const onlinePoll = await request(env, "/api/device/state", { device: true });
  assert.equal(onlinePoll.response.status, 200);
  assert.equal(onlinePoll.data.relay1, true);

  const duplicate = await request(env, "/api/relay/1/schedules", {
    method: "POST",
    body: { schedules: [schedules[0], schedules[0]] },
    token,
  });
  assert.equal(duplicate.response.status, 400);
  assert.equal(env.DB.schedules.length, 2);

  const twentySchedules = Array.from({ length: 20 }, (_, index) => ({
    startTime: `${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}`,
    durationMinutes: 1,
  }));
  const atLimit = await request(env, "/api/relay/1/schedules", {
    method: "POST",
    body: { schedules: twentySchedules },
    token,
  });
  assert.equal(atLimit.response.status, 200);
  assert.equal(atLimit.data.relays.relay1.schedules.length, 20);
  const overLimit = await request(env, "/api/relay/1/schedules", {
    method: "POST",
    body: { schedules: [...twentySchedules, { startTime: "00:20", durationMinutes: 1 }] },
    token,
  });
  assert.equal(overLimit.response.status, 400);

  const restore = await request(env, "/api/relay/1/schedules", {
    method: "POST",
    body: { schedules },
    token,
  });
  assert.equal(restore.response.status, 200);
  env.DB.lastPollMs = 0;
  const missedPoll = await request(env, "/api/device/state", { device: true });
  assert.equal(missedPoll.response.status, 200);
  assert.equal(missedPoll.data.relay1, false);
  assert.equal(env.DB.skippedSchedules.length, 2);
});

test("validates and returns relay names in signed-in and device state", async () => {
  const env = createEnvironment();
  const token = await signIn(env);
  const saved = await request(env, "/api/relay/2/name", {
    method: "POST",
    body: { name: "  Water Pump  " },
    token,
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.data.relays.relay2.name, "Water Pump");
  assert.equal(saved.data.relay2, false);

  for (const name of ["", "x".repeat(25), "bad\nname"]) {
    const invalid = await request(env, "/api/relay/2/name", {
      method: "POST",
      body: { name },
      token,
    });
    assert.equal(invalid.response.status, 400);
  }

  const deviceState = await request(env, "/api/device/state", { device: true });
  assert.equal(deviceState.response.status, 200);
  assert.equal(deviceState.data.relays.relay2.name, "Water Pump");
});

test("device logs are token-protected, validated, and readable to signed-in users", async () => {
  const env = createEnvironment();
  const token = await signIn(env);
  const unauthorized = await request(env, "/api/device/logs", {
    method: "POST",
    body: { events: [{ level: "info", message: "boot" }] },
  });
  assert.equal(unauthorized.response.status, 401);

  const accepted = await request(env, "/api/device/logs", {
    method: "POST",
    body: { events: [{ level: "info", message: "boot" }, { level: "warning", message: "wifi retry" }] },
    device: true,
  });
  assert.equal(accepted.response.status, 202);
  assert.equal(accepted.data.accepted, 2);

  const read = await request(env, "/api/logs?limit=10", { token });
  assert.equal(read.response.status, 200);
  assert.deepEqual(read.data.logs.map((log) => log.message), ["boot", "wifi retry"]);

  const invalid = await request(env, "/api/device/logs", {
    method: "POST",
    body: { events: [{ level: "debug", message: "not allowed" }] },
    device: true,
  });
  assert.equal(invalid.response.status, 400);
});
