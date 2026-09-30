///|
pub(all) struct CandidateStage {
  candidates : Array[Json]
  issues : Array[Json]
  unprocessed_left : Array[Int]
  unprocessed_right : Array[Int]
}

///|
priv struct CandidateBudget {
  pairs : Int
  edit_cells : Int
  max_component_side : Int
  max_edit_codepoints : Int
}

///|
fn candidate_field(config : Config, name : String) -> FieldConfig? {
  for field in config.fields {
    if field.name == name {
      return Some(field)
    }
  }
  None
}

///|
fn candidate_block_key(
  table : Table,
  record : Int,
  config : Config,
  group : Json,
  side : String,
) -> String? {
  let names = match group {
    Json::Array(values) => values
    _ => return None
  }
  let parts : Array[Json] = []
  for item in names {
    let name = match item {
      Json::String(value) => value
      _ => return None
    }
    let field = match candidate_field(config, name) {
      Some(value) => value
      None => return None
    }
    let source = if side == "left" { field.left } else { field.right }
    let col = match header_index(table, source) {
      Some(value) => value
      None => return None
    }
    let value = normalize_value(table.rows[record - 1][col], field, side)
    if value.invalid || value.missing || value.transformed.is_empty() {
      return None
    }
    parts.push(Json::string(value.canonical.unwrap()))
  }
  Some(Json::array(parts).stringify())
}

///| Internal injection point used by boundary tests. DP cells count recurrence

///|
/// cells (len(left) * len(right)); component IDs Pn/Qn are numeric-order IDs.
fn generate_candidates_with_budget(
  left : Table,
  right : Table,
  left_remaining : Array[Int],
  right_remaining : Array[Int],
  config : Config,
  budget : CandidateBudget,
) -> CandidateStage {
  let candidates : Array[Json] = []
  let issues : Array[Json] = []
  let unprocessed_left : Array[Int] = []
  let unprocessed_right : Array[Int] = []
  let specs = match config.candidates {
    Json::Object(object) => object
    _ => return { candidates, issues, unprocessed_left, unprocessed_right }
  }
  let fields = match json_array(specs.get("fields")) {
    Some(values) => values
    None => []
  }
  let threshold = match parse_int_json(specs.get("threshold"), "threshold") {
    Ok(value) => value
    Err(_) => 1
  }
  let blocking = match json_array(specs.get("blocking")) {
    Some(values) => values
    None => []
  }
  let count = Ref(0)
  if blocking.is_empty() {
    // Preflight the product before materializing any pairs.
    if right_remaining.length() > 0 &&
      left_remaining.length() > budget.pairs / right_remaining.length() {
      for record in left_remaining {
        unprocessed_left.push(record)
      }
      for record in right_remaining {
        unprocessed_right.push(record)
      }
      issues.push(
        Json::object({
          "code": Json::string("candidate_pair_budget_exceeded"),
          "phase": Json::string("candidate_generation"),
          "message": Json::string(
            "all-pairs candidate count exceeds remaining-pair budget",
          ),
        }),
      )
      return { candidates, issues, unprocessed_left, unprocessed_right }
    }
  }
  let pair_left : Array[Int] = []
  let pair_right : Array[Int] = []
  if blocking.is_empty() {
    for lrec in left_remaining {
      for rrec in right_remaining {
        pair_left.push(lrec)
        pair_right.push(rrec)
      }
    }
  } else {
    let seen_pairs : Map[String, Bool] = Map([])
    let per_left : Map[String, Array[Int]] = Map([])
    for group in blocking {
      let right_index : Map[String, Array[Int]] = Map([])
      for rrec in right_remaining {
        match candidate_block_key(right, rrec, config, group, "right") {
          Some(key) =>
            match right_index.get(key) {
              Some(bucket) => bucket.push(rrec)
              None => right_index[key] = [rrec]
            }
          None => ()
        }
      }
      for lrec in left_remaining {
        match candidate_block_key(left, lrec, config, group, "left") {
          Some(key) =>
            match right_index.get(key) {
              Some(bucket) =>
                for rrec in bucket {
                  let pair_key = "\{lrec}:\{rrec}"
                  if !seen_pairs.contains(pair_key) {
                    count.val += 1
                    if count.val > budget.pairs {
                      for record in left_remaining {
                        unprocessed_left.push(record)
                      }
                      for record in right_remaining {
                        unprocessed_right.push(record)
                      }
                      issues.push(
                        Json::object({
                          "code": Json::string("candidate_pair_budget_exceeded"),
                          "phase": Json::string("candidate_generation"),
                          "message": Json::string(
                            "deduplicated candidate union exceeds pair budget",
                          ),
                        }),
                      )
                      return {
                        candidates: [],
                        issues,
                        unprocessed_left,
                        unprocessed_right,
                      }
                    }
                    seen_pairs[pair_key] = true
                    match per_left.get("\{lrec}") {
                      Some(values) => values.push(rrec)
                      None => per_left["\{lrec}"] = [rrec]
                    }
                  }
                }
              None => ()
            }
          None => ()
        }
      }
    }
    for lrec in left_remaining {
      match per_left.get("\{lrec}") {
        Some(values) => {
          values.sort()
          for rrec in values {
            pair_left.push(lrec)
            pair_right.push(rrec)
          }
        }
        None => ()
      }
    }
  }
  count.val = pair_left.length()
  if !blocking.is_empty() {
    let covered_left = Array::make(left.rows.length() + 1, false)
    let covered_right = Array::make(right.rows.length() + 1, false)
    for ei in 0..<pair_left.length() {
      covered_left[pair_left[ei]] = true
      covered_right[pair_right[ei]] = true
    }
    for record in left_remaining {
      if !covered_left[record] {
        issues.push(
          Json::object({
            "code": Json::string("candidate_blocking_uncovered"),
            "phase": Json::string("candidate_coverage"),
            "side": Json::string("left"),
            "record": Json::number(record.to_double()),
            "message": Json::string(
              "no configured blocking group matched; record remains pending_review and was not scored",
            ),
          }),
        )
      }
    }
    for record in right_remaining {
      if !covered_right[record] {
        issues.push(
          Json::object({
            "code": Json::string("candidate_blocking_uncovered"),
            "phase": Json::string("candidate_coverage"),
            "side": Json::string("right"),
            "record": Json::number(record.to_double()),
            "message": Json::string(
              "no configured blocking group matched; record remains pending_review and was not scored",
            ),
          }),
        )
      }
    }
  }
  // Endpoint adjacency keeps component discovery linear in vertices and edges.
  let left_adjacency : Map[String, Array[Int]] = Map([])
  let right_adjacency : Map[String, Array[Int]] = Map([])
  for ei in 0..<pair_left.length() {
    match left_adjacency.get("\{pair_left[ei]}") {
      Some(values) => values.push(ei)
      None => left_adjacency["\{pair_left[ei]}"] = [ei]
    }
    match right_adjacency.get("\{pair_right[ei]}") {
      Some(values) => values.push(ei)
      None => right_adjacency["\{pair_right[ei]}"] = [ei]
    }
  }
  let pair_scored = Array::make(pair_left.length(), false)
  let score_by_pair : Array[Json] = Array::make(
    pair_left.length(),
    Json::null(),
  )
  let field_scores_by_pair : Array[Json] = Array::make(
    pair_left.length(),
    Json::array([]),
  )
  let diagnostics_by_pair : Array[Json] = Array::make(
    pair_left.length(),
    Json::array([]),
  )
  let pre_ids = Array::make(pair_left.length(), "")
  let component = Ref(0)
  let mut dp_used = 0
  for seed in 0..<pair_left.length() {
    if !pair_scored[seed] {
      component.val += 1
      let component_edges : Array[Int] = []
      let component_left : Array[Int] = []
      let component_right : Array[Int] = []
      component_edges.push(seed)
      pair_scored[seed] = true
      let component_left_seen = Array::make(left.rows.length() + 1, false)
      let component_right_seen = Array::make(right.rows.length() + 1, false)
      let expanded = Ref(0)
      while expanded.val < component_edges.length() {
        let ei = component_edges[expanded.val]
        if !component_left_seen[pair_left[ei]] {
          component_left_seen[pair_left[ei]] = true
          component_left.push(pair_left[ei])
          match left_adjacency.get("\{pair_left[ei]}") {
            Some(neighbors) =>
              for other in neighbors {
                if !pair_scored[other] {
                  pair_scored[other] = true
                  component_edges.push(other)
                }
              }
            None => ()
          }
        }
        if !component_right_seen[pair_right[ei]] {
          component_right_seen[pair_right[ei]] = true
          component_right.push(pair_right[ei])
          match right_adjacency.get("\{pair_right[ei]}") {
            Some(neighbors) =>
              for other in neighbors {
                if !pair_scored[other] {
                  pair_scored[other] = true
                  component_edges.push(other)
                }
              }
            None => ()
          }
        }
        expanded.val += 1
      }
      // Stable component id follows minimum (left record, then right record).
      let mut component_over_budget = false
      let mut component_cost = 0
      for ei in component_edges {
        pre_ids[ei] = "P\{component.val}"
        for spec_json in fields {
          let spec = match spec_json {
            Json::Object(value) => value
            _ => continue
          }
          if json_string(spec.get("metric")) == Some("edit") {
            let field_name = match json_string(spec.get("field")) {
              Some(value) => value
              None => continue
            }
            let field = match candidate_field(config, field_name) {
              Some(value) => value
              None => continue
            }
            let lc = match header_index(left, field.left) {
              Some(value) => value
              None => continue
            }
            let rc = match header_index(right, field.right) {
              Some(value) => value
              None => continue
            }
            let lv = normalize_value(
              left.rows[pair_left[ei] - 1][lc],
              field,
              "left",
            )
            let rv = normalize_value(
              right.rows[pair_right[ei] - 1][rc],
              field,
              "right",
            )
            if !lv.missing &&
              !rv.missing &&
              !lv.transformed.is_empty() &&
              !rv.transformed.is_empty() {
              let ll = lv.transformed.to_array().length()
              let rl = rv.transformed.to_array().length()
              if ll > budget.max_edit_codepoints ||
                rl > budget.max_edit_codepoints {
                component_over_budget = true
              }
              if component_cost > budget.edit_cells - dp_used ||
                (
                  rl > 0 &&
                  ll > (budget.edit_cells - dp_used - component_cost) / rl
                ) {
                component_over_budget = true
              } else {
                component_cost += ll * rl
              }
            }
          }
        }
      }
      if component_over_budget {
        for record in component_left {
          if !unprocessed_left.contains(record) {
            unprocessed_left.push(record)
          }
        }
        for record in component_right {
          if !unprocessed_right.contains(record) {
            unprocessed_right.push(record)
          }
        }
        issues.push(
          Json::object({
            "code": Json::string("candidate_scoring_budget_exceeded"),
            "phase": Json::string("candidate_scoring"),
            "component_id": Json::string("P\{component.val}"),
            "message": Json::string(
              "pre-score candidate component could not be fully scored within edit budget",
            ),
          }),
        )
        for ei in component_edges {
          pair_scored[ei] = true
          diagnostics_by_pair[ei] = Json::array([
            Json::object({
              "code": Json::string("component_unprocessed"),
              "message": Json::string("candidate component not scored"),
            }),
          ])
        }
      } else {
        dp_used += component_cost
        for ei in component_edges {
          pair_scored[ei] = true
          let scores : Array[Json] = []
          let diags : Array[Json] = []
          let weighted = Ref(@bigint.BigInt::from_int(0))
          let weight_total = Ref(0)
          let invalid = Ref(false)
          for spec_json in fields {
            let spec = match spec_json {
              Json::Object(value) => value
              _ => continue
            }
            let name = match json_string(spec.get("field")) {
              Some(value) => value
              None => continue
            }
            let metric = match json_string(spec.get("metric")) {
              Some(value) => value
              None => continue
            }
            let weight = match parse_int_json(spec.get("weight"), "weight") {
              Ok(value) => value
              Err(_) => 1
            }
            let field = match candidate_field(config, name) {
              Some(value) => value
              None => continue
            }
            let lc = match header_index(left, field.left) {
              Some(value) => value
              None => continue
            }
            let rc = match header_index(right, field.right) {
              Some(value) => value
              None => continue
            }
            let lv = normalize_value(
              left.rows[pair_left[ei] - 1][lc],
              field,
              "left",
            )
            let rv = normalize_value(
              right.rows[pair_right[ei] - 1][rc],
              field,
              "right",
            )
            let mut fs : Int? = Some(0)
            if lv.invalid || rv.invalid {
              fs = None
              invalid.val = true
              diags.push(
                Json::object({
                  "code": Json::string("invalid_identity_value"),
                  "field": Json::string(name),
                  "message": Json::string(
                    "typed identity value could not be parsed",
                  ),
                }),
              )
            } else if !lv.missing &&
              !rv.missing &&
              !lv.transformed.is_empty() &&
              !rv.transformed.is_empty() {
              if metric == "exact" {
                fs = Some(if lv.canonical == rv.canonical { 10000 } else { 0 })
              } else if metric == "edit" {
                fs = Some(edit_similarity(lv.transformed, rv.transformed))
              } else if metric == "decimal" {
                let a = decimal_parse(lv.transformed).unwrap()
                let b = decimal_parse(rv.transformed).unwrap()
                let delta = decimal_abs(decimal_subtract(a, b))
                let abs_tol = decimal_parse(field.abs_tol).unwrap()
                let rel_tol = decimal_parse(field.rel_tol).unwrap()
                let maxmag = if decimal_compare(decimal_abs(a), decimal_abs(b)) >=
                  0 {
                  decimal_abs(a)
                } else {
                  decimal_abs(b)
                }
                let rel = decimal_multiply(rel_tol, maxmag)
                let tol = if decimal_compare(abs_tol, rel) >= 0 {
                  abs_tol
                } else {
                  rel
                }
                fs = Some(
                  if decimal_compare(delta, tol) <= 0 {
                    10000
                  } else {
                    0
                  },
                )
              } else if metric == "date" {
                let a = date_parse(lv.transformed).unwrap().1
                let b = date_parse(rv.transformed).unwrap().1
                fs = Some(
                  if (a - b).abs() <= field.days_tol {
                    10000
                  } else {
                    0
                  },
                )
              }
            }
            scores.push(
              Json::object({
                "field": Json::string(name),
                "metric": Json::string(metric),
                "weight": Json::number(weight.to_double()),
                "score": match fs {
                  Some(value) => Json::number(value.to_double())
                  None => Json::null()
                },
              }),
            )
            weight_total.val += weight
            match fs {
              Some(value) =>
                weighted.val = weighted.val +
                  @bigint.BigInt::from_int(weight) *
                  @bigint.BigInt::from_int(value)
              None => ()
            }
          }
          let score = if invalid.val {
            Json::null()
          } else {
            Json::number(
              (weighted.val / @bigint.BigInt::from_int(weight_total.val))
              .to_int()
              .to_double(),
            )
          }
          score_by_pair[ei] = score
          field_scores_by_pair[ei] = Json::array(scores)
          diagnostics_by_pair[ei] = Json::array(diags)
        }
      }
    }
  }
  // Qualified graph components are independent solver admission units.
  let qualified = Array::make(pair_left.length(), false)
  let selected : Array[Int] = []
  let qseen = Array::make(pair_left.length(), false)
  let qid = Array::make(pair_left.length(), "")
  let qnumber = Ref(0)
  for i in 0..<pair_left.length() {
    qualified[i] = match score_by_pair[i] {
      Json::Number(value, ..) => value >= threshold.to_double()
      _ => false
    }
  }
  for seed in 0..<pair_left.length() {
    if qualified[seed] && !qseen[seed] {
      qnumber.val += 1
      let edges : Array[Int] = [seed]
      qseen[seed] = true
      let ls : Array[Int] = []
      let rs : Array[Int] = []
      let local_left_seen = Array::make(left.rows.length() + 1, false)
      let local_right_seen = Array::make(right.rows.length() + 1, false)
      let at = Ref(0)
      while at.val < edges.length() {
        let ei = edges[at.val]
        if !local_left_seen[pair_left[ei]] {
          local_left_seen[pair_left[ei]] = true
          ls.push(pair_left[ei])
          match left_adjacency.get("\{pair_left[ei]}") {
            Some(neighbors) =>
              for j in neighbors {
                if qualified[j] && !qseen[j] {
                  edges.push(j)
                  qseen[j] = true
                }
              }
            None => ()
          }
        }
        if !local_right_seen[pair_right[ei]] {
          local_right_seen[pair_right[ei]] = true
          rs.push(pair_right[ei])
          match right_adjacency.get("\{pair_right[ei]}") {
            Some(neighbors) =>
              for j in neighbors {
                if qualified[j] && !qseen[j] {
                  edges.push(j)
                  qseen[j] = true
                }
              }
            None => ()
          }
        }
        at.val += 1
      }
      let id = "Q\{qnumber.val}"
      for ei in edges {
        qid[ei] = id
      }
      if ls.length() > budget.max_component_side ||
        rs.length() > budget.max_component_side {
        for value in ls {
          if !unprocessed_left.contains(value) {
            unprocessed_left.push(value)
          }
        }
        for value in rs {
          if !unprocessed_right.contains(value) {
            unprocessed_right.push(value)
          }
        }
        issues.push(
          Json::object({
            "code": Json::string("candidate_component_limit_exceeded"),
            "phase": Json::string("assignment"),
            "component_id": Json::string(id),
            "message": Json::string(
              "qualified component exceeds per-side assignment limit",
            ),
          }),
        )
      } else {
        let local_edges : Array[WeightedEdge] = []
        for ei in edges {
          let li = ls.search(pair_left[ei]).unwrap()
          let ri = rs.search(pair_right[ei]).unwrap()
          let value = match score_by_pair[ei] {
            Json::Number(number, ..) => number.to_int()
            _ => 0
          }
          local_edges.push({ left: li, right: ri, weight: value })
        }
        let chosen = solve_assignment(ls.length(), rs.length(), local_edges)
        for pair in chosen {
          if pair.weight > 0 {
            for ei in edges {
              if ls[pair.left] == pair_left[ei] &&
                rs[pair.right] == pair_right[ei] {
                selected.push(ei)
              }
            }
          }
        }
      }
    }
  }
  for i in 0..<pair_left.length() {
    let cid = if qid[i] != "" { qid[i] } else { pre_ids[i] }
    candidates.push(
      Json::object({
        "left_id": Json::string(result_record_id("left", pair_left[i])),
        "right_id": Json::string(result_record_id("right", pair_right[i])),
        "score": score_by_pair[i],
        "field_scores": field_scores_by_pair[i],
        "diagnostics": diagnostics_by_pair[i],
        "suggested": Json::boolean(selected.contains(i)),
        "component_id": Json::string(cid),
      }),
    )
  }
  { candidates, issues, unprocessed_left, unprocessed_right }
}

///|
pub fn generate_candidates(
  left : Table,
  right : Table,
  left_remaining : Array[Int],
  right_remaining : Array[Int],
  config : Config,
) -> CandidateStage {
  generate_candidates_with_budget(
    left,
    right,
    left_remaining,
    right_remaining,
    config,
    {
      pairs: 100000,
      edit_cells: 20000000,
      max_component_side: 100,
      max_edit_codepoints: 512,
    },
  )
}

///|
fn edit_similarity(left : String, right : String) -> Int {
  let a = left.to_array()
  let b = right.to_array()
  if a.is_empty() && b.is_empty() {
    return 0
  }
  let previous = Array::make(b.length() + 1, 0)
  for j in 0..<=b.length() {
    previous[j] = j
  }
  for i0 in 0..<a.length() {
    let i = i0 + 1
    let current = Array::make(b.length() + 1, 0)
    current[0] = i
    for j0 in 0..<b.length() {
      let j = j0 + 1
      let substitution = previous[j - 1] +
        (if a[i - 1] == b[j - 1] { 0 } else { 1 })
      let deletion = previous[j] + 1
      let insertion = current[j - 1] + 1
      let edit = if deletion < insertion { deletion } else { insertion }
      current[j] = if edit < substitution { edit } else { substitution }
    }
    for j in 0..<=b.length() {
      previous[j] = current[j]
    }
  }
  let maxlen = if a.length() > b.length() { a.length() } else { b.length() }
  (maxlen - previous[b.length()]) * 10000 / maxlen
}
