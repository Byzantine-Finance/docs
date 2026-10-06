const HTTP_METHODS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);

function operationKey(path, method) {
  return `${method.toUpperCase()} ${path}`;
}

function parameterKey(parameter) {
  if (typeof parameter?.$ref === "string") return `$ref:${parameter.$ref}`;
  return `${parameter?.in ?? ""}:${parameter?.name ?? ""}`;
}

function effectiveOperation(pathItem, operation) {
  const pathParameters = Array.isArray(pathItem?.parameters) ? pathItem.parameters : [];
  const operationParameters = Array.isArray(operation?.parameters) ? operation.parameters : [];
  if (pathParameters.length === 0 && operationParameters.length === 0) return operation;

  const parameters = new Map(pathParameters.map((parameter) => [parameterKey(parameter), parameter]));
  for (const parameter of operationParameters) {
    parameters.set(parameterKey(parameter), parameter);
  }
  return { ...operation, parameters: [...parameters.values()] };
}

function resolvePathItem(spec, pathItem, visited = new Set()) {
  const reference = pathItem?.$ref;
  if (typeof reference !== "string") return { value: pathItem, unresolved: [] };
  if (visited.has(reference)) return { value: {}, unresolved: [reference] };

  const resolved = resolveLocalReference(spec, reference);
  if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) {
    return { value: {}, unresolved: [reference] };
  }

  const nested = resolvePathItem(spec, resolved, new Set([...visited, reference]));
  const siblings = Object.fromEntries(
    Object.entries(pathItem).filter(([key]) => key !== "$ref"),
  );
  return {
    value: { ...nested.value, ...siblings },
    unresolved: nested.unresolved,
  };
}

function collectOperations(spec) {
  const operations = new Map();
  const unresolved = [];
  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    const resolvedPathItem = resolvePathItem(spec, pathItem);
    for (const reference of resolvedPathItem.unresolved) {
      unresolved.push({ method: "PATH", path, operationId: null, reference });
    }
    for (const [method, value] of Object.entries(resolvedPathItem.value ?? {})) {
      if (!HTTP_METHODS.has(method.toLowerCase()) || !value || typeof value !== "object") {
        continue;
      }
      const effectiveValue = effectiveOperation(resolvedPathItem.value, value);
      operations.set(operationKey(path, method), {
        method: method.toUpperCase(),
        path,
        operationId: value.operationId ?? null,
        value: effectiveValue,
      });
    }
  }
  return { operations, unresolved };
}

function publicOperation(operation, breaking) {
  return {
    method: operation.method,
    path: operation.path,
    operationId: operation.operationId,
    breaking,
  };
}

function sortOperations(operations) {
  return operations.sort(
    (left, right) =>
      left.path.localeCompare(right.path) || left.method.localeCompare(right.method),
  );
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function semanticEqual(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

const NON_BREAKING_SCHEMA_ANNOTATIONS = new Set([
  "$comment",
  "description",
  "example",
  "examples",
  "externalDocs",
  "title",
]);

function schemaSemantics(value) {
  if (Array.isArray(value)) return value.map(schemaSemantics);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !NON_BREAKING_SCHEMA_ANNOTATIONS.has(key))
      .map(([key, child]) => [key, schemaSemantics(child)]),
  );
}

function isPotentiallyBreakingSchemaChange(before, after) {
  if (!before || !after || typeof before !== "object" || typeof after !== "object") {
    return before !== after;
  }
  return !semanticEqual(schemaSemantics(before), schemaSemantics(after));
}

function hasBreakingContentChange(before, after) {
  const beforeContent = before?.content ?? {};
  const afterContent = after?.content ?? {};
  for (const [mediaType, media] of Object.entries(beforeContent)) {
    const nextMedia = afterContent[mediaType];
    if (!nextMedia) return true;
    if (Boolean(media.schema) !== Boolean(nextMedia.schema)) return true;
    if (
      media.schema &&
      nextMedia.schema &&
      isPotentiallyBreakingSchemaChange(media.schema, nextMedia.schema)
    ) {
      return true;
    }
  }
  return false;
}

function isPotentiallyBreakingOperationChange(before, after) {
  const beforeParameters = new Map(
    (before.parameters ?? []).map((parameter) => [parameterKey(parameter), parameter]),
  );
  const afterParameters = new Map(
    (after.parameters ?? []).map((parameter) => [parameterKey(parameter), parameter]),
  );
  for (const key of beforeParameters.keys()) {
    if (!afterParameters.has(key)) return true;
  }
  for (const parameter of after.parameters ?? []) {
    const previous = beforeParameters.get(parameterKey(parameter));
    if (parameter.required === true && previous?.required !== true) return true;
    if (previous && Boolean(previous.schema) !== Boolean(parameter.schema)) return true;
    if (
      previous?.schema &&
      parameter.schema &&
      isPotentiallyBreakingSchemaChange(previous.schema, parameter.schema)
    ) {
      return true;
    }
  }

  if (after.requestBody?.required === true && before.requestBody?.required !== true) return true;
  if (hasBreakingContentChange(before.requestBody, after.requestBody)) return true;
  const beforeResponses = before.responses ?? {};
  const afterResponses = after.responses ?? {};
  for (const [status, response] of Object.entries(beforeResponses)) {
    if (/^(?:2\d\d|default)$/u.test(status) && !(status in afterResponses)) return true;
    if (status in afterResponses && hasBreakingContentChange(response, afterResponses[status])) {
      return true;
    }
  }
  return false;
}

function changedComponentSchemas(before, after) {
  const beforeSchemas = before.components?.schemas ?? {};
  const afterSchemas = after.components?.schemas ?? {};
  const names = new Set([...Object.keys(beforeSchemas), ...Object.keys(afterSchemas)]);
  const changes = [];

  for (const name of [...names].sort((left, right) => left.localeCompare(right))) {
    if (!(name in beforeSchemas)) {
      changes.push({ name, change: "added", breaking: false });
    } else if (!(name in afterSchemas)) {
      changes.push({ name, change: "removed", breaking: true });
    } else if (!semanticEqual(beforeSchemas[name], afterSchemas[name])) {
      changes.push({
        name,
        change: "changed",
        breaking: isPotentiallyBreakingSchemaChange(beforeSchemas[name], afterSchemas[name]),
      });
    }
  }
  return changes;
}

function decodePointerToken(token) {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

function resolveLocalReference(spec, reference) {
  if (!reference.startsWith("#/")) {
    return undefined;
  }
  let value = spec;
  for (const token of reference.slice(2).split("/").map(decodePointerToken)) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, token)) {
      return undefined;
    }
    value = value[token];
  }
  return value;
}

function referencedSchemas(spec, value) {
  const schemas = new Set();
  const unresolved = new Set();
  const visitedReferences = new Set();
  const visitedObjects = new WeakSet();

  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (visitedObjects.has(node)) return;
    visitedObjects.add(node);

    if (typeof node.$ref === "string") {
      const reference = node.$ref;
      const schemaPrefix = "#/components/schemas/";
      if (reference.startsWith(schemaPrefix)) {
        schemas.add(decodePointerToken(reference.slice(schemaPrefix.length)));
      }
      if (!visitedReferences.has(reference)) {
        visitedReferences.add(reference);
        const resolved = resolveLocalReference(spec, reference);
        if (resolved === undefined) unresolved.add(reference);
        else visit(resolved);
      }
    }

    for (const child of Object.values(node)) {
      visit(child);
    }
  }

  visit(value);
  return {
    schemas: [...schemas].sort((left, right) => left.localeCompare(right)),
    unresolved: [...unresolved].sort((left, right) => left.localeCompare(right)),
  };
}

function indirectOperations(spec, operations, directlyChangedKeys, changedSchemaNames) {
  const indirect = [];
  for (const [key, operation] of operations) {
    if (directlyChangedKeys.has(key)) continue;
    const references = referencedSchemas(spec, operation.value);
    const schemas = references.schemas.filter((name) => changedSchemaNames.has(name));
    if (schemas.length > 0) {
      indirect.push({
        ...publicOperation(operation, false),
        schemas,
      });
    }
  }
  return sortOperations(indirect);
}

function unresolvedOperationReferences(spec, operations) {
  const unresolved = [];
  for (const operation of operations.values()) {
    for (const reference of referencedSchemas(spec, operation.value).unresolved) {
      unresolved.push({
        method: operation.method,
        path: operation.path,
        operationId: operation.operationId,
        reference,
      });
    }
  }
  return unresolved.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.method.localeCompare(right.method) ||
      left.reference.localeCompare(right.reference),
  );
}

function markdownCode(value) {
  return `\`${String(value).replaceAll("`", "\\`")}\``;
}

function operationLabel(operation) {
  return markdownCode(`${operation.method} ${operation.path}`);
}

function operationDetails(operation) {
  return operation.operationId ? markdownCode(operation.operationId) : "—";
}

function breakingLabel(breaking) {
  return breaking ? "**Yes**" : "No";
}

export function renderOpenApiDiffMarkdown(diff) {
  const lines = [
    "### OpenAPI semantic diff",
    "",
    "| Change | Target | Breaking | Details |",
    "| --- | --- | :---: | --- |",
  ];

  const operationGroups = [
    ["Added", diff.operations.added],
    ["Changed", diff.operations.changed],
    ["Removed", diff.operations.removed],
  ];
  for (const [change, operations] of operationGroups) {
    for (const operation of operations) {
      lines.push(
        `| ${change} | ${operationLabel(operation)} | ${breakingLabel(operation.breaking)} | ${operationDetails(operation)} |`,
      );
    }
  }
  for (const schema of diff.changedSchemas) {
    lines.push(
      `| Schema ${schema.change} | ${markdownCode(schema.name)} | ${breakingLabel(schema.breaking)} | — |`,
    );
  }

  if (diff.operations.indirect.length > 0) {
    lines.push(
      "",
      "<details>",
      `<summary>Indirectly impacted operations (${diff.operations.indirect.length})</summary>`,
      "",
    );
    for (const operation of diff.operations.indirect) {
      const via = operation.schemas.map(markdownCode).join(", ");
      lines.push(`- ${operationLabel(operation)} (${operationDetails(operation)}) via ${via}`);
    }
    lines.push("</details>");
  }

  if (diff.unresolvedReferences.length > 0) {
    lines.push(
      "",
      "<details>",
      `<summary>Unresolved references (${diff.unresolvedReferences.length})</summary>`,
      "",
    );
    for (const unresolved of diff.unresolvedReferences) {
      lines.push(
        `- ${operationLabel(unresolved)} (${operationDetails(unresolved)}): ${markdownCode(unresolved.reference)}`,
      );
    }
    lines.push("</details>");
  }

  if (diff.requiresEscalation) {
    lines.push(
      "",
      "> **Escalation required:** breaking changes or unresolved references detected.",
    );
  }

  return lines.join("\n");
}

export function diffOpenApi(before, after) {
  const beforeCollection = collectOperations(before);
  const afterCollection = collectOperations(after);
  const beforeOperations = beforeCollection.operations;
  const afterOperations = afterCollection.operations;
  const added = [];
  const removed = [];
  const changed = [];
  const directlyChangedKeys = new Set();

  for (const [key, value] of afterOperations) {
    const previous = beforeOperations.get(key);
    if (!previous) {
      added.push(publicOperation(value, false));
      directlyChangedKeys.add(key);
    } else if (!semanticEqual(previous.value, value.value)) {
      changed.push(
        publicOperation(
          value,
          isPotentiallyBreakingOperationChange(previous.value, value.value),
        ),
      );
      directlyChangedKeys.add(key);
    }
  }
  for (const [key, value] of beforeOperations) {
    if (!afterOperations.has(key)) {
      removed.push(publicOperation(value, true));
    }
  }

  const changedSchemas = changedComponentSchemas(before, after);
  const changedSchemaNames = new Set(changedSchemas.map(({ name }) => name));
  const indirect = indirectOperations(
    after,
    afterOperations,
    directlyChangedKeys,
    changedSchemaNames,
  );
  const unresolvedCandidates = [
    ...beforeCollection.unresolved,
    ...unresolvedOperationReferences(before, beforeOperations),
    ...afterCollection.unresolved,
    ...unresolvedOperationReferences(after, afterOperations),
  ];
  const unresolvedReferences = [
    ...new Map(
      unresolvedCandidates.map((entry) => [
        `${entry.method}\u0000${entry.path}\u0000${entry.reference}`,
        entry,
      ]),
    ).values(),
  ].sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.method.localeCompare(right.method) ||
      left.reference.localeCompare(right.reference),
  );
  const hasBreakingChanges =
    removed.length > 0 ||
    changed.some(({ breaking }) => breaking) ||
    changedSchemas.some(({ breaking }) => breaking);

  return {
    operations: {
      added: sortOperations(added),
      removed: sortOperations(removed),
      changed: sortOperations(changed),
      indirect,
    },
    changedSchemas,
    unresolvedReferences,
    hasBreakingChanges,
    requiresEscalation: hasBreakingChanges || unresolvedReferences.length > 0,
  };
}
