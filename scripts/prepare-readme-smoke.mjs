import { readFile, writeFile } from "node:fs/promises";

const [draftPath, rulesPath] = process.argv.slice(2);
if (!draftPath || !rulesPath) throw new Error("usage: prepare-readme-smoke.mjs DRAFT OUTPUT");
const draft = JSON.parse(await readFile(draftPath, "utf8"));
const authored = JSON.parse(await readFile("examples/orders/rules.json", "utf8"));
// Simulate a human editing the generated mapping draft with the reviewed fixture contract.
draft.draft = false;
draft.fields = authored.fields;
draft.key = authored.key;
draft.candidates = authored.candidates;
await writeFile(rulesPath, `${JSON.stringify(draft, null, 2)}\n`, { flag: "wx" });
