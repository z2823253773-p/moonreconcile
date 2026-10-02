# Final review scope and evidence dispositions

Recorded 2026-10-03 against the whole-product review at `c24ff158e6699ba5d7c2fde4018f7fab9b69ba92`. This responds to every item in that review's “Declined to judge” and “Cannot verify” lists. These are explicit scope/evidence boundaries, not claims that absent evidence exists.

| Review item | Executor disposition and reason |
| --- | --- |
| Real-user accuracy, saved effort, adoption, competitor performance | Keep unverified, V05 pending. Synthetic truth and documentation cannot establish real benefits. |
| XLSX ingestion, date/leading-zero conversion, formulas | Keep outside CSV v1 and V06 pending; a real export inspection is still needed. |
| Many-to-many settlement, ML, GUI, database, collaborative editing, timezone values | Maintain explicit v1 exclusions; no new promise or requirement. |
| Scores as probabilities; optimum as identity proof | Maintain deterministic scores and suggestions requiring review; no calibration claim. |
| Re-solving after reject; rejecting noncandidate pairs | Existing cumulative-decision ruling stands: negative human evidence is allowed without mandatory solver rerun. |
| Override exact-key matches; infer unmatched from absent candidates | Existing contract stands: exact matches lock; no correspondence requires explicit action. |
| Merge omitted prior actions automatically | Full supplied cumulative table remains authoritative; omission intentionally removes prior action on replay. |
| Hostile tampering, hostile concurrent path replacement, power-loss durability | No stronger guarantee advertised. Fingerprints establish consistency, checked writes/no-overwrite cover ordinary failures. |
| Spreadsheet formula interpretation of exported CSV | Preserve literal CSV; no spreadsheet-specific safe-import or formula guarantee certified. |
| Invalid manually constructed helper values | Supported validated JSON boundary is invoke; no expanded defensive contract for arbitrary low-level constructors. |
| Native/Wasm, other runtimes, future toolchain releases | JS path only; CI records actual installed versions, future compatibility requires fresh evidence. |
| Literal maximum capacity and worst-case decision latency | Limits remain guardrails. Identify injected and actual-size tests separately; no SLA or maximum-throughput claim. |
| Simultaneous transactional two-source snapshot | Fingerprint actual read bytes; no cross-file atomic snapshot guarantee. |
| Filesystems without no-overwrite primitive | Existing safe-failure portability ruling stands; no unsafe overwrite fallback. |
| Undocumented hello scaffold | Leave optional scaffold; supported entrypoints remain documented CLI and invoke. |
| Earlier benchmark host/path metadata | Current tree is sanitized; earlier public history remains. No history erasure or comprehensive secret audit claimed. |
| Public push, exact remote SHA/README, both-OS CI, matrix closure | Root-owned external gates remain pending until actual observations are recorded. |
| Contest eligibility, application, organizer approval/acceptance | Dated official requirement research is evidence; actual application and acceptance remain unverified and unperformed. |
| Mooncakes publication | Separate optional activity; external library consumer is not registry publication. |
| Literal 64MiB/max-DP/full-combined-bound execution, runtime/memory and user benefit | Not inferred from smaller tests or guard proof. Preserve limitation disclosures. |

R1 export/import closure is a real implementation defect, separately dispatched for correction. None of these scope dispositions is used to dismiss it.
