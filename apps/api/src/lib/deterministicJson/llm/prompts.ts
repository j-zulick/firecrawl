export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

// System prompt for inner askLlm calls (the cheap model the extractor calls
// at runtime).
export const ASK_LLM_SYSTEM = [
  "You are a text-processing function in a data pipeline.",
  "Return only the requested value: no preamble, no markdown.",
  "You may summarize, classify, translate, or reformat the supplied text,",
  "but stay grounded in it: never invent facts or do outside lookups.",
  'If a JSON schema is provided and the text lacks what you need, return null, "" or [] as allowed by the schema.',
  "If no schema is provided and the text lacks what you need, return an empty string.",
].join(" ");

// Phase 1: pick short verbatim snippets from the markdown that sit next to the
// data the extractor will need. Each snippet is later located in the raw HTML so
// we can hand the codegen model a tight window instead of the whole page.
const ANCHOR_PICKER_SYSTEM = `You are a planning step in a web-extraction pipeline. Given a page's markdown, a target JSON Schema, and a task, pick short text snippets from the markdown that sit next to the data the extractor will need to read.

Rules:
- Each snippet must appear VERBATIM in the markdown.
- Prefer short (5-80 char) distinctive phrases.
- Prefer stable labels, headings, column names, semantic section text, or nearby static text over sample-specific values.
- Use values as snippets only when they are the most distinctive way to locate the relevant region in the sample page.
- Pick one snippet near each field the schema asks for. For a list/array schema, pick 2-4 snippets that hit DIFFERENT items.
- Prefer coverage of distinct schema fields over multiple snippets for the same field.
- Return at most 12 snippets.
- Avoid generic phrases ("Home", "Menu", "Read more") and very long quotes.
- Skip fields whose data clearly is not on the page.

Return only JSON of the form {"snippets": ["...", "..."]} - no markdown fences, no commentary.`;

// Phase 2: write the reusable extractor. Kept generic on purpose - the sandbox
// (a browser-like DOM with no network) enforces the environment, so the prompt
// describes intent, not an inventory of available globals.
const EXTRACTOR_SYSTEM = `You write ONE reusable JavaScript function that extracts structured data from a web page.

    async function extract(doc, askLlm) { ... }

- \`doc\` is a standard DOM Document: querySelector / querySelectorAll, document.evaluate (XPath), textContent, getAttribute, etc.
- \`askLlm(prompt)\` returns a string; \`askLlm(prompt, jsonSchema)\` returns a value of that shape. It can fail and return null, so guard its result.

This function is generated once from ONE sample page, cached, then re-run on OTHER pages of the same shape. Therefore:

- Read every value from the DOM at runtime. NEVER return a literal you saw in the sample page - the values differ on other pages. Literals are only allowed in selectors, attribute names, regexes, and the returned object's keys.
- The returned value must match the target JSON Schema exactly: include required fields, use the correct types, and do not add extra keys.
- For required schema fields or fields central to the task, throw if the expected anchor/container is missing.
- Return null or [] only when the surrounding container was found and the specific optional value is genuinely absent. Do not treat a missing primary container as optional absence.
- Do NOT hide breakage. Use one primary extraction strategy per value. Do not silently fall back to broader whole-page scraping when it fails. If you handle known explicit variants, branch on a specific container or page-state check, and throw when none match.
- Anchor every value to a specific element. Never fish for a value by matching a pattern (e.g. a price, a date, an email) over doc.body.innerText or the whole page - you will match an unrelated occurrence and return a confident, wrong value.
- For arrays/lists, first select the repeated item/container elements, then extract each field relative to that item. Do not query the whole document for per-item fields inside the loop.
- When a value is present, coerce it to the schema's type (e.g. strip non-numerics for numbers). Keep dates as the page displays them unless the task asks for a specific format.
- Do not use network, storage, timers, randomness, browser navigation, mutation observers, external libraries, or DOM mutation.

Selectors:
- Anchor on stable, meaningful things: labels, semantic attributes (itemprop, role, data-*), heading text. Avoid fragile position (:nth-child, sibling chains).
- Prefer descendant combinators over child combinators (\`>\`); an unseen wrapper element breaks \`>\`. A selector that matches 0 elements is usually too strict, not proof the data is absent.
- Read URLs from href/src, not from link text.
- Only standard CSS selectors work. To match by visible text, select structurally then filter in JS, e.g. \`[...doc.querySelectorAll('tr')].find(r => r.textContent.includes('Total'))\`.

askLlm:
- If the data is already structured (a JSON body, a <script type="application/ld+json">, an inline state blob), JSON.parse it and read the field directly. Never ask askLlm to parse JSON you could parse deterministically.
- Use it for what selectors and parsing cannot do - summarize, classify, translate, disambiguate by meaning. It transforms the text you pass it (no outside lookups like currency conversion; returns null when the text lacks the answer), so pass the DOM text it needs - for a summary, the article body, not a bare title or label. If a field has a fixed value set, include it in the prompt.
- When you call askLlm once per item over a list, issue the calls concurrently with Promise.all rather than awaiting one at a time.

Return only the function source, beginning with \`async function extract\`.`;

export function buildAnchorPickerMessages(args: {
  userPrompt: string;
  schemaJson: string;
  markdownPreview: string;
}): ChatMessage[] {
  return [
    { role: "system", content: ANCHOR_PICKER_SYSTEM },
    {
      role: "user",
      content: `### Page markdown

${args.markdownPreview}

### Target JSON Schema

${args.schemaJson}

### Task

${args.userPrompt}

### Output

Return {"snippets": [...]} with short verbatim fragments from the markdown above.`,
    },
  ];
}

export function buildExtractorMessages(args: {
  userPrompt: string;
  schemaJson: string;
  markdownPreview: string;
  anchorHtml: string;
  rejectionFeedback?: string;
  previousCode?: string;
}): ChatMessage[] {
  // Bulky reference first, the task last - long-context models answer better
  // when the question follows the documents it refers to.
  const markdown = args.markdownPreview.trim()
    ? `### Page markdown (one sample page - the values shown are NOT your output)

${args.markdownPreview}

`
    : "";

  // When we have the prior extractor, ask for a minimal repair rather than a
  // cold rewrite: a page usually drifts in one selector, so the fix should keep
  // the field mappings and structure identical and touch only what broke.
  const fix = args.previousCode?.trim()
    ? `Here is that function:

\`\`\`js
${args.previousCode.trim()}
\`\`\`

Repair it: change only what is needed to fix the issue above - usually a single selector or parse step. Keep the field mappings, structure, and everything that still works identical; do not rewrite from scratch.`
    : `Write the function again, fixing the issue above.`;

  const retry = args.rejectionFeedback?.trim()
    ? `

### Your previous attempt was rejected

${args.rejectionFeedback}

${fix} Every value must still come from a runtime DOM read or askLlm, and the result must match the schema exactly.`
    : "";

  return [
    { role: "system", content: EXTRACTOR_SYSTEM },
    {
      role: "user",
      content: `${markdown}### HTML snippets around the target fields

${args.anchorHtml}

### Target JSON Schema

${args.schemaJson}

### Task

${args.userPrompt}${retry}`,
    },
  ];
}
