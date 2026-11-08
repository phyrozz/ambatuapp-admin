import test from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { streamingGateway } from "./lambda-gateway.mjs";
import { dispatcher } from "./lambda-dispatcher.mjs";
import { LIMITS } from "./budget.mjs";

function output() {
  let body = "";
  const stream = new Writable({
    write(chunk, encoding, callback) {
      body += chunk.toString();
      callback();
    },
  });
  let response;
  return {
    stream,
    metadata: (target, data) => {
      response = data;
      return target;
    },
    get response() {
      return response;
    },
    get body() {
      return body;
    },
  };
}
test("Lambda gateway preserves ranged binary streaming and releases its invocation reservation", async () => {
  const result = output(),
    queries = [];
  const handle = streamingGateway({
    origin: async () => "http://127.0.0.1:1",
    metadata: result.metadata,
    query: async (sql, args) => {
      queries.push([sql, args]);
      return { rows: [{ lease: "lease-id" }] };
    },
    http: async (url, options) => {
      assert.equal(url.pathname, "/media/fixture");
      assert.equal(url.search, "?grant=private");
      assert.deepEqual(options.headers, { range: "bytes=2-4" });
      return new Response(new Uint8Array([0, 128, 255]), {
        status: 206,
        headers: {
          "Content-Range": "bytes 2-4/10",
          "Cache-Control": "private, no-store",
        },
      });
    },
  });
  await handle(
    {
      rawPath: "/media/fixture",
      rawQueryString: "grant=private",
      headers: { range: "bytes=2-4" },
      requestContext: { http: { method: "GET" } },
    },
    result.stream,
    {},
  );
  assert.equal(result.response.statusCode, 206);
  assert.equal(result.response.headers["content-range"], "bytes 2-4/10");
  assert.equal(queries.length, 2);
  assert.match(queries[1][0], /dream_media_finish/);
  assert.deepEqual(queries[1][1], ["lease-id"]);
});
test("gateway rejects exhausted shared budget before contacting S3 or local HTTP", async () => {
  const result = output();
  await streamingGateway({
    metadata: result.metadata,
    query: async () => ({ rows: [{ lease: null }] }),
    origin: async () => {
      throw new Error("must not call");
    },
  })({}, result.stream);
  assert.equal(result.response.statusCode, 429);
  assert.equal(JSON.parse(result.body).error, "MEDIA_UNAVAILABLE");
});
test("gateway sanitizes database failures without returning private diagnostics", async () => {
  const result = output();
  await streamingGateway({
    metadata: result.metadata,
    query: async () => {
      throw new Error("private database password");
    },
  })({}, result.stream);
  assert.equal(result.response.statusCode, 503);
  assert(!result.body.includes("password"));
});
test("dispatcher fails closed on database outage and stops only tasks in its own cluster", async () => {
  const oldCluster = process.env.WORKER_CLUSTER,
    oldGateway = process.env.GATEWAY_FUNCTION;
  process.env.WORKER_CLUSTER = "owned-cluster";
  process.env.GATEWAY_FUNCTION = "owned-gateway";
  try {
    const calls = [];
    const handle = dispatcher({
      connect: async () => {
        throw new Error("private DB config");
      },
      lambda: {
        send: async (command) => {
          calls.push(command);
          return {};
        },
      },
      ecs: {
        send: async (command) => {
          calls.push(command);
          return { taskArns: ["owned-task"] };
        },
      },
      s3: {
        send: async () => {
          throw new Error("unexpected storage");
        },
      },
    });
    await assert.rejects(handle({}), { message: "MEDIA_DATABASE_UNAVAILABLE" });
    assert.deepEqual(
      calls.map((command) => command.constructor.name),
      ["PutFunctionConcurrencyCommand", "ListTasksCommand", "StopTaskCommand"],
    );
    assert.equal(calls[0].input.ReservedConcurrentExecutions, 0);
    assert.equal(calls[0].input.FunctionName, "owned-gateway");
    for (const command of calls.slice(1))
      assert.equal(command.input.cluster, "owned-cluster");
    assert.equal(calls[2].input.task, "owned-task");
  } finally {
    if (oldCluster === undefined) delete process.env.WORKER_CLUSTER;
    else process.env.WORKER_CLUSTER = oldCluster;
    if (oldGateway === undefined) delete process.env.GATEWAY_FUNCTION;
    else process.env.GATEWAY_FUNCTION = oldGateway;
  }
});

test("dispatcher reopens the shared pool and only ever sets zero reservation for shutdown", async () => {
  const oldEnabled = process.env.GATEWAY_ENABLED;
  process.env.GATEWAY_ENABLED = "true";
  const calls = [];
  let budget = { requests: 0, delivery_bytes: 0, gateway_seconds: 0 };
  const db = {
    query: async (sql) => {
      if (sql.includes("SELECT * FROM app.dream_worker_control"))
        return { rows: [{ lease_id: null, task_arn: null }] };
      if (sql.includes("SELECT * FROM app.dream_media_costs"))
        return { rows: [budget] };
      return { rows: [], rowCount: 0 };
    },
  };
  const handle = dispatcher({
    connect: async () => ({
      pool: db,
      transaction: async (callback) => callback(db),
    }),
    ecs: {
      send: async () => {
        throw new Error("unexpected worker start");
      },
    },
    s3: {
      send: async () => {
        throw new Error("unexpected storage");
      },
    },
    lambda: {
      send: async (command) => {
        calls.push(command);
        return {};
      },
    },
  });
  try {
    await handle({ Records: [] });
    assert.equal(
      calls.at(-1).constructor.name,
      "DeleteFunctionConcurrencyCommand",
    );
    for (const exhausted of [
      { requests: LIMITS.requests },
      { delivery_bytes: LIMITS.deliveryBytes },
      { gateway_seconds: LIMITS.gatewaySeconds - 179 },
    ]) {
      budget = {
        requests: 0,
        delivery_bytes: 0,
        gateway_seconds: 0,
        ...exhausted,
      };
      await handle({ Records: [] });
      assert.equal(
        calls.at(-1).constructor.name,
        "PutFunctionConcurrencyCommand",
      );
      assert.equal(calls.at(-1).input.ReservedConcurrentExecutions, 0);
    }
    budget = { requests: 0, delivery_bytes: 0, gateway_seconds: 0 };
    await handle({ Records: [] });
    assert.equal(
      calls.at(-1).constructor.name,
      "DeleteFunctionConcurrencyCommand",
      "monthly reset reopens without reserving capacity",
    );
    process.env.GATEWAY_ENABLED = "false";
    await handle({ Records: [] });
    assert.equal(
      calls.at(-1).input.ReservedConcurrentExecutions,
      0,
      "disabled rollout stays shut down",
    );
    assert(
      calls.every(
        (command) =>
          command.input.ReservedConcurrentExecutions === undefined ||
          command.input.ReservedConcurrentExecutions === 0,
      ),
    );
  } finally {
    if (oldEnabled === undefined) delete process.env.GATEWAY_ENABLED;
    else process.env.GATEWAY_ENABLED = oldEnabled;
  }
});
