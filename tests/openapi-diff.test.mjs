import assert from "node:assert/strict";
import test from "node:test";

import { diffOpenApi, renderOpenApiDiffMarkdown } from "../scripts/lib/openapi-diff.mjs";

const spec = (paths = {}, schemas = {}) => ({
  openapi: "3.0.3",
  info: { title: "Example", version: "1.0.0" },
  paths,
  components: { schemas },
});

const operation = (operationId, extra = {}) => ({
  operationId,
  responses: { 200: { description: "OK" } },
  ...extra,
});

test("renderOpenApiDiffMarkdown produces a compact deterministic PR summary", () => {
  const markdown = renderOpenApiDiffMarkdown({
    operations: {
      added: [
        { method: "POST", path: "/pets", operationId: "createPet", breaking: false },
      ],
      removed: [
        { method: "GET", path: "/old", operationId: null, breaking: true },
      ],
      changed: [
        { method: "GET", path: "/pets", operationId: "listPets", breaking: false },
      ],
      indirect: [
        {
          method: "GET",
          path: "/owners",
          operationId: "listOwners",
          schemas: ["Owner", "Pet"],
          breaking: false,
        },
      ],
    },
    changedSchemas: [
      { name: "Pet", change: "changed", breaking: false },
      { name: "Legacy", change: "removed", breaking: true },
    ],
    unresolvedReferences: [
      {
        method: "POST",
        path: "/pets",
        operationId: "createPet",
        reference: "#/components/schemas/Missing",
      },
    ],
    hasBreakingChanges: true,
    requiresEscalation: true,
  });

  assert.equal(
    markdown,
    [
      "### OpenAPI semantic diff",
      "",
      "| Change | Target | Breaking | Details |",
      "| --- | --- | :---: | --- |",
      "| Added | `POST /pets` | No | `createPet` |",
      "| Changed | `GET /pets` | No | `listPets` |",
      "| Removed | `GET /old` | **Yes** | — |",
      "| Schema changed | `Pet` | No | — |",
      "| Schema removed | `Legacy` | **Yes** | — |",
      "",
      "<details>",
      "<summary>Indirectly impacted operations (1)</summary>",
      "",
      "- `GET /owners` (`listOwners`) via `Owner`, `Pet`",
      "</details>",
      "",
      "<details>",
      "<summary>Unresolved references (1)</summary>",
      "",
      "- `POST /pets` (`createPet`): `#/components/schemas/Missing`",
      "</details>",
      "",
      "> **Escalation required:** breaking changes or unresolved references detected.",
    ].join("\n"),
  );
});

test("diffOpenApi escalates unresolved operation references", () => {
  const before = spec({
    "/pets": { get: operation("getPets") },
  });
  const after = spec({
    "/pets": {
      get: operation("getPets", {
        responses: {
          200: {
            description: "OK",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Missing" },
              },
            },
          },
        },
      }),
    },
  });

  const result = diffOpenApi(before, after);

  assert.deepEqual(result.unresolvedReferences, [
    {
      method: "GET",
      path: "/pets",
      operationId: "getPets",
      reference: "#/components/schemas/Missing",
    },
  ]);
  assert.equal(result.hasBreakingChanges, false);
  assert.equal(result.requiresEscalation, true);
});

test("diffOpenApi lists changed schemas and indirect operation impact without direct duplicates", () => {
  const petBefore = { type: "object", properties: { name: { type: "string" } } };
  const petAfter = {
    type: "object",
    description: "A documented pet",
    properties: { name: { type: "string" } },
  };
  const response = {
    responses: {
      200: {
        description: "OK",
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/PetList" } },
        },
      },
    },
  };
  const before = spec(
    {
      "/indirect": { get: operation("getIndirect", response) },
      "/direct": { get: operation("getDirect", response) },
    },
    {
      Pet: petBefore,
      PetList: { type: "array", items: { $ref: "#/components/schemas/Pet" } },
      Removed: { type: "string" },
    },
  );
  const after = spec(
    {
      "/indirect": { get: operation("getIndirect", response) },
      "/direct": {
        get: operation("getDirect", { ...response, summary: "Changed directly" }),
      },
    },
    {
      Added: { type: "integer" },
      Pet: petAfter,
      PetList: { type: "array", items: { $ref: "#/components/schemas/Pet" } },
    },
  );

  const result = diffOpenApi(before, after);

  assert.deepEqual(result.changedSchemas, [
    { name: "Added", change: "added", breaking: false },
    { name: "Pet", change: "changed", breaking: false },
    { name: "Removed", change: "removed", breaking: true },
  ]);
  assert.deepEqual(result.operations.indirect, [
    {
      method: "GET",
      path: "/indirect",
      operationId: "getIndirect",
      schemas: ["Pet"],
      breaking: false,
    },
  ]);
  assert.deepEqual(result.operations.changed.map(({ path }) => path), ["/direct"]);
  assert.equal(result.hasBreakingChanges, true);
  assert.equal(result.requiresEscalation, true);
});

test("diffOpenApi treats required additions and enum removals as breaking schema changes", () => {
  const before = spec({}, {
    Account: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["pending", "active"] },
        note: { type: "string" },
      },
    },
  });
  const after = spec({}, {
    Account: {
      type: "object",
      required: ["status"],
      properties: {
        status: { type: "string", enum: ["active"] },
        note: { type: "string" },
      },
    },
  });

  const result = diffOpenApi(before, after);

  assert.deepEqual(result.changedSchemas, [
    { name: "Account", change: "changed", breaking: true },
  ]);
  assert.equal(result.hasBreakingChanges, true);
  assert.equal(result.requiresEscalation, true);
});

test("diffOpenApi reports directly changed operations semantically", () => {
  const before = spec({
    "/pets": {
      get: operation("listPets", {
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer" } },
        ],
      }),
    },
  });
  const after = spec({
    "/pets": {
      get: {
        responses: { 200: { description: "OK" } },
        operationId: "listPets",
        parameters: [
          { in: "query", name: "limit", schema: { type: "string" } },
        ],
      },
    },
  });

  const result = diffOpenApi(before, after);

  assert.deepEqual(result.operations.changed, [
    {
      method: "GET",
      path: "/pets",
      operationId: "listPets",
      breaking: true,
    },
  ]);
  assert.equal(result.hasBreakingChanges, true);
  assert.equal(result.requiresEscalation, true);
});

test("diffOpenApi escalates breaking inline response schema changes", () => {
  const before = spec({
    "/accounts": {
      get: operation("getAccounts", {
        responses: {
          200: {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { balance: { type: "string" } },
                },
              },
            },
          },
        },
      }),
    },
  });
  const after = structuredClone(before);
  after.paths["/accounts"].get.responses[200].content[
    "application/json"
  ].schema.properties.balance.type = "integer";

  const result = diffOpenApi(before, after);

  assert.equal(result.operations.changed[0].breaking, true);
  assert.equal(result.hasBreakingChanges, true);
  assert.equal(result.requiresEscalation, true);
});

test("diffOpenApi treats a newly required parameter as a breaking operation change", () => {
  const before = spec({ "/accounts": { get: operation("listAccounts") } });
  const after = spec({
    "/accounts": {
      get: operation("listAccounts", {
        parameters: [
          { name: "tenantId", in: "query", required: true, schema: { type: "string" } },
        ],
      }),
    },
  });

  const result = diffOpenApi(before, after);

  assert.deepEqual(result.operations.changed, [
    {
      method: "GET",
      path: "/accounts",
      operationId: "listAccounts",
      breaking: true,
    },
  ]);
  assert.equal(result.hasBreakingChanges, true);
  assert.equal(result.requiresEscalation, true);
});

test("diffOpenApi applies path-level parameters to every operation", () => {
  const before = spec({
    "/accounts/{accountId}": {
      parameters: [
        {
          name: "accountId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      get: operation("getAccount"),
      patch: operation("updateAccount"),
    },
  });
  const after = structuredClone(before);
  after.paths["/accounts/{accountId}"].parameters.push({
    name: "tenantId",
    in: "query",
    required: true,
    schema: { type: "string" },
  });

  const result = diffOpenApi(before, after);

  assert.deepEqual(
    result.operations.changed.map(({ method, breaking }) => ({ method, breaking })),
    [
      { method: "GET", breaking: true },
      { method: "PATCH", breaking: true },
    ],
  );
  assert.equal(result.requiresEscalation, true);
});

test("diffOpenApi treats a removed operation parameter as breaking", () => {
  const before = spec({
    "/accounts": {
      get: operation("listAccounts", {
        parameters: [
          { name: "cursor", in: "query", schema: { type: "string" } },
        ],
      }),
    },
  });
  const after = spec({ "/accounts": { get: operation("listAccounts") } });

  const result = diffOpenApi(before, after);

  assert.equal(result.operations.changed[0].breaking, true);
  assert.equal(result.requiresEscalation, true);
});

test("diffOpenApi treats changed schema reference targets as breaking", () => {
  const before = spec(
    {
      "/accounts": {
        get: operation("listAccounts", {
          responses: {
            200: {
              description: "OK",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/StringAccount" },
                },
              },
            },
          },
        }),
      },
    },
    { StringAccount: { type: "string" }, IntegerAccount: { type: "integer" } },
  );
  const after = structuredClone(before);
  after.paths["/accounts"].get.responses[200].content["application/json"].schema.$ref =
    "#/components/schemas/IntegerAccount";

  const result = diffOpenApi(before, after);

  assert.equal(result.operations.changed[0].breaking, true);
  assert.equal(result.requiresEscalation, true);
});

test("diffOpenApi fails closed for tightened and previously absent schema constraints", () => {
  const before = spec({
    "/accounts": {
      get: operation("listAccounts", {
        parameters: [
          { name: "query", in: "query", schema: { type: "string" } },
          { name: "legacy", in: "query", schema: { type: "string" } },
        ],
      }),
    },
  });
  const after = structuredClone(before);
  after.paths["/accounts"].get.parameters[0].schema.maxLength = 32;
  delete after.paths["/accounts"].get.parameters[1].schema;

  const result = diffOpenApi(before, after);

  assert.equal(result.operations.changed[0].breaking, true);
  assert.equal(result.requiresEscalation, true);
});

test("diffOpenApi fails closed for composition and additional-properties changes", () => {
  const before = spec({}, {
    Account: {
      type: "object",
      additionalProperties: true,
      properties: { id: { type: "string" } },
    },
  });
  const after = spec({}, {
    Account: {
      type: "object",
      additionalProperties: false,
      allOf: [{ properties: { id: { type: "string", format: "uuid" } } }],
      properties: { id: { type: "string" } },
    },
  });

  const result = diffOpenApi(before, after);

  assert.deepEqual(result.changedSchemas, [
    { name: "Account", change: "changed", breaking: true },
  ]);
  assert.equal(result.requiresEscalation, true);
});

test("diffOpenApi resolves referenced Path Item Objects before comparing operations", () => {
  const before = spec();
  before.openapi = "3.1.0";
  before.paths = {
    "/accounts": { $ref: "#/components/pathItems/Accounts" },
  };
  before.components.pathItems = {
    Accounts: { get: operation("listAccounts") },
  };
  const after = structuredClone(before);
  after.components.pathItems.Accounts.get.parameters = [
    { name: "tenantId", in: "query", required: true, schema: { type: "string" } },
  ];

  const result = diffOpenApi(before, after);

  assert.deepEqual(result.operations.changed, [
    {
      method: "GET",
      path: "/accounts",
      operationId: "listAccounts",
      breaking: true,
    },
  ]);
  assert.equal(result.requiresEscalation, true);
});

test("diffOpenApi treats XML serialization changes as breaking", () => {
  const before = spec({}, {
    Account: { type: "object", xml: { name: "account", wrapped: false } },
  });
  const after = spec({}, {
    Account: { type: "object", xml: { name: "customer", wrapped: true } },
  });

  const result = diffOpenApi(before, after);

  assert.deepEqual(result.changedSchemas, [
    { name: "Account", change: "changed", breaking: true },
  ]);
  assert.equal(result.requiresEscalation, true);
});

test("diffOpenApi escalates unresolved Path Item references from the baseline document", () => {
  const before = spec({
    "/accounts": { $ref: "#/components/pathItems/Missing" },
  });
  before.openapi = "3.1.0";
  const after = spec();
  after.openapi = "3.1.0";

  const result = diffOpenApi(before, after);

  assert.deepEqual(result.unresolvedReferences, [
    {
      method: "PATH",
      path: "/accounts",
      operationId: null,
      reference: "#/components/pathItems/Missing",
    },
  ]);
  assert.equal(result.requiresEscalation, true);
});

test("diffOpenApi rejects inherited and non-object Path Item reference targets", () => {
  const before = spec();
  const after = spec({
    "/inherited": { $ref: "#/__proto__" },
    "/array": { $ref: "#/components/pathItems/ArrayTarget" },
  });
  after.openapi = "3.1.0";
  after.components.pathItems = { ArrayTarget: [] };

  const result = diffOpenApi(before, after);

  assert.deepEqual(
    result.unresolvedReferences.map(({ path, reference }) => ({ path, reference })),
    [
      { path: "/array", reference: "#/components/pathItems/ArrayTarget" },
      { path: "/inherited", reference: "#/__proto__" },
    ],
  );
  assert.equal(result.requiresEscalation, true);
});

test("diffOpenApi ignores object key ordering", () => {
  const before = spec({
    "/pets": { get: operation("listPets") },
  });
  const after = spec({
    "/pets": {
      get: {
        responses: { 200: { description: "OK" } },
        operationId: "listPets",
      },
    },
  });

  assert.deepEqual(diffOpenApi(before, after).operations.changed, []);
});

test("diffOpenApi reports added and removed operations in stable order", () => {
  const before = spec({
    "/zebra": { post: operation("removeZebra") },
    "/shared": { get: operation("keepShared") },
  });
  const after = spec({
    "/alpha": { put: operation("addAlpha") },
    "/shared": { get: operation("keepShared") },
  });

  const result = diffOpenApi(before, after);

  assert.deepEqual(result.operations.added, [
    {
      method: "PUT",
      path: "/alpha",
      operationId: "addAlpha",
      breaking: false,
    },
  ]);
  assert.deepEqual(result.operations.removed, [
    {
      method: "POST",
      path: "/zebra",
      operationId: "removeZebra",
      breaking: true,
    },
  ]);
  assert.deepEqual(result.operations.changed, []);
  assert.deepEqual(result.operations.indirect, []);
  assert.equal(result.hasBreakingChanges, true);
  assert.equal(result.requiresEscalation, true);
});
