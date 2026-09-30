// Deterministic rendering of engine produced Result data. Nothing here
// recomputes a score, a status or a difference: every value is copied from the
// locked Result, and nested evidence is emitted as compact JSON cells so no
// information is dropped.

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : String(value);
  if (text.includes('"') || text.includes(",") || text.includes("\n") || text.includes("\r")) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

export function renderCsv(header, rows) {
  const lines = [header.map(csvCell).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  return `${lines.join("\n")}\n`;
}

function jsonCell(value) {
  return JSON.stringify(value);
}

export function renderReportJson(result) {
  return `${JSON.stringify(result, null, 2)}\n`;
}

export function renderPairsCsv(result) {
  return renderCsv(
    ["left_id", "right_id", "source", "reason", "override"],
    result.pairs.map((pair) => [pair.left_id, pair.right_id, pair.source, pair.reason, pair.override]),
  );
}

export function renderFieldsCsv(result) {
  return renderCsv(
    [
      "left_id",
      "right_id",
      "field",
      "type",
      "left_raw",
      "right_raw",
      "left_transformed",
      "right_transformed",
      "left_canonical",
      "right_canonical",
      "status",
      "rules",
      "difference",
      "tolerance",
      "explanation",
      "evidence",
    ],
    result.fields.map((field) => [
      field.left_id,
      field.right_id,
      field.field,
      field.type,
      field.left_raw,
      field.right_raw,
      field.left_transformed,
      field.right_transformed,
      field.left_canonical,
      field.right_canonical,
      field.status,
      jsonCell(field.rules),
      field.difference,
      field.tolerance,
      field.explanation,
      jsonCell(field),
    ]),
  );
}

export function renderCandidatesCsv(result) {
  return renderCsv(
    ["left_id", "right_id", "score", "component_id", "suggested", "field_scores", "diagnostics", "evidence"],
    result.candidates.map((candidate) => [
      candidate.left_id,
      candidate.right_id,
      candidate.score,
      candidate.component_id,
      candidate.suggested,
      jsonCell(candidate.field_scores),
      jsonCell(candidate.diagnostics),
      jsonCell(candidate),
    ]),
  );
}

export function renderUnresolvedCsv(result) {
  return renderCsv(
    ["side", "id", "record", "status", "reason"],
    result.records
      .filter((record) => record.status === "pending_review" || record.status === "unprocessed")
      .map((record) => [record.side, record.id, record.record, record.status, record.reason]),
  );
}

// The editable cumulative decision table. Applied decisions are preserved so a
// replay never loses earlier review, and every remaining opportunity is a blank
// action row: a suggestion is never prefilled as a new recommendation.
export function renderDecisionsCsv(result) {
  const rows = [];
  const seen = new Set();
  const decidedPairs = new Set();
  const decidedRecords = new Set();
  const push = (row) => {
    const key = JSON.stringify(row);
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(row);
  };

  for (const decision of result.decisions) {
    push([decision.action, decision.left_id ?? "", decision.right_id ?? "", decision.reason ?? ""]);
    if (decision.action !== "reject") {
      if (decision.left_id) decidedRecords.add(decision.left_id);
      if (decision.right_id) decidedRecords.add(decision.right_id);
    }
    if (decision.left_id && decision.right_id) {
      decidedPairs.add(JSON.stringify([decision.left_id, decision.right_id]));
    }
  }
  for (const candidate of result.candidates) {
    if (!candidate.suggested) continue;
    if (decidedPairs.has(JSON.stringify([candidate.left_id, candidate.right_id]))) continue;
    push(["", candidate.left_id, candidate.right_id, ""]);
  }
  for (const record of result.records) {
    if (record.status !== "pending_review" && record.status !== "unprocessed") continue;
    if (decidedRecords.has(record.id)) continue;
    push(record.side === "left" ? ["", record.id, "", ""] : ["", "", record.id, ""]);
  }
  return renderCsv(["action", "left_id", "right_id", "reason"], rows);
}

function mdEscape(value) {
  const markdownPunctuation = new Set("*_`[]()!|#");
  const escaped = [...String(value)]
    .map((character) => character === "\\" ? "\\\\" : markdownPunctuation.has(character) ? `\\${character}` : character)
    .join("");
  return escaped
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\r\n", "<br>")
    .replaceAll("\n", "<br>")
    .replaceAll("\r", "<br>");
}

function listOrNone(values) {
  return values.length === 0 ? "none" : values.map(mdEscape).join(", ");
}

export function renderSummaryMarkdown(result, { runId }) {
  const { per_side: perSide, fields } = result.summary;
  const lines = [
    "# Reconciliation summary",
    "",
    `- run ID: ${mdEscape(runId)}`,
    `- engine version: ${mdEscape(result.engine_version)}`,
    `- computation status: ${mdEscape(result.computation.status)}`,
    `- unresolved records: ${result.summary.unresolved_count}`,
    `- candidates: ${result.summary.candidate_count}`,
    `- exit code: ${result.exit_code}`,
    "",
    "## Computation coverage",
    "",
    "Computation coverage describes whether the configured algorithms ran to",
    "completion. It is reported separately from review status and from",
    "unresolved business differences.",
    "",
  ];
  if (result.computation.issues.length === 0) {
    lines.push("No resource budget interruptions were recorded.");
  } else {
    for (const issue of result.computation.issues) {
      lines.push(`- ${mdEscape(issue.code)} (${mdEscape(issue.phase)}): ${mdEscape(issue.message)}`);
    }
  }
  lines.push(
    "",
    "## Record accounting",
    "",
    "| side | total | paired | unmatched | pending_review | unprocessed |",
    "| --- | --- | --- | --- | --- | --- |",
    `| left | ${perSide.left.total} | ${perSide.left.paired} | ${perSide.left.unmatched} | ${perSide.left.pending_review} | ${perSide.left.unprocessed} |`,
    `| right | ${perSide.right.total} | ${perSide.right.paired} | ${perSide.right.unmatched} | ${perSide.right.pending_review} | ${perSide.right.unprocessed} |`,
    "",
    "## Field comparison",
    "",
    "| status | count |",
    "| --- | --- |",
    `| equal | ${fields.equal} |`,
    `| equivalent_by_rule | ${fields.equivalent_by_rule} |`,
    `| different | ${fields.different} |`,
    `| invalid_value | ${fields.invalid_value} |`,
    "",
    "## Structure and key issues",
    "",
    `- unmapped left: ${listOrNone(result.structure.unmapped_left)}`,
    `- unmapped right: ${listOrNone(result.structure.unmapped_right)}`,
    `- ignored left: ${listOrNone(result.structure.ignored_left)}`,
    `- ignored right: ${listOrNone(result.structure.ignored_right)}`,
    `- structure issues: ${result.summary.structural_issue_count}`,
    `- key issues: ${result.summary.key_issue_count}`,
    "",
    "## Review",
    "",
    `- applied decisions: ${result.decisions.length}`,
    `- paired by exact key: ${result.pairs.filter((pair) => pair.source === "exact_key").length}`,
    `- paired by human review: ${result.pairs.filter((pair) => pair.source === "human_review").length}`,
    "",
    "Human confirmed unmatched records remain business differences and are not",
    "removed from this report.",
    "",
  );
  return lines.join("\n");
}
