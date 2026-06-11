// Eval: did removing freshness/sourceQuality lose protection?
// Runs the same adversarial cases through the OLD verdict contract (separate
// freshness/sourceQuality fields + mechanical gates) and the NEW one (folded
// into alertAction via the prompt), with real Gemini calls approximating the
// in-scrape judge (system = judge prompt, user = page content).
//   npx tsx scripts/eval-verdict-removal.ts
import { config as dotenv } from "dotenv";
dotenv({ path: ".env" });
import { generateObject } from "ai";
import { google } from "@ai-sdk/google";
import { z } from "zod";
import {
  buildJudgePrompt,
  verdictToDecision,
} from "../src/services/monitoring/search/judge";
import { googleProviderOptions } from "../src/services/monitoring/search/tuning";

const MODEL = "gemini-3-flash-preview";

const GOAL = "Alert me when OpenAI releases a new AI model";
const SUBJECT = "OpenAI";
const WINDOW = "24h";

type Case = {
  name: string;
  url: string;
  title: string;
  page: string;
  expectAlert: boolean;
};

const CASES: Case[] = [
  {
    name: "rumor on a random blog",
    url: "https://ai-insider-buzz.xyz/gpt6-rumors",
    title: "OpenAI secretly preparing GPT-6, sources say",
    page: "Multiple unnamed sources suggest OpenAI may be preparing to release GPT-6 soon. Insiders hint the model could arrive within months. Nothing has been confirmed by the company. Subscribe for more AI rumors!",
    expectAlert: false,
  },
  {
    name: "forum post claiming a release",
    url: "https://forum.example.com/thread/91283",
    title: "GPT-6 IS OUT!!! (thread)",
    page: "user4234: guys gpt-6 just dropped, my friend at openai confirmed it. user9921: source? user4234: trust me bro, it's happening. user5512: nothing on their site yet.",
    expectAlert: false,
  },
  {
    name: "old news resurfacing (dated 2024 content)",
    url: "https://technews.example.com/openai-gpt4o-launch",
    title: "OpenAI releases GPT-4o",
    page: "May 13, 2024 — OpenAI today released GPT-4o, its new flagship model. The launch event in May 2024 showcased real-time voice. This article was originally published in May 2024.",
    expectAlert: false,
  },
  {
    name: "upcoming/planned, not completed",
    url: "https://news.example.com/openai-plans",
    title: "OpenAI expected to release new model next month",
    page: "According to people familiar with the matter, OpenAI is expected to release its next model in the coming weeks. The company declined to comment. Analysts anticipate a launch event soon.",
    expectAlert: false,
  },
  {
    name: "SEO content-farm rewrite",
    url: "https://dailytechpulse-aggregator.com/openai-new-model-2026",
    title: "OpenAI New Model 2026: Everything You Need To Know",
    page: "OpenAI new model 2026 release date features pricing. Many people search for OpenAI new model. In this article we cover everything about OpenAI models. OpenAI has released many models. Click here for the best AI tools of 2026. Related: top 10 chatbots.",
    expectAlert: false,
  },
  {
    name: "listing/tracker page",
    url: "https://modeltracker.example.com/releases",
    title: "AI Model Release Tracker (updated daily)",
    page: "Tracking all AI model releases: [GPT-4o](link) [Claude Fable 5](link) [Gemini 3](link) [Llama 5](link) [Mistral Large 3](link) and 40 more entries. Filter by vendor, date, modality. Updated daily.",
    expectAlert: false,
  },
  {
    name: "legit wire coverage, today",
    url: "https://www.reuters.com/technology/openai-releases-new-model",
    title: "OpenAI releases new flagship AI model",
    page: "OpenAI on Thursday released a new flagship artificial intelligence model, the company announced. The model is available to developers via the API starting today, OpenAI said in a statement. Pricing was also disclosed.",
    expectAlert: true,
  },
  {
    name: "first-party announcement, today",
    url: "https://openai.com/blog/introducing-new-model",
    title: "Introducing our newest model",
    page: "Today we're releasing our newest flagship model, available now in the API and ChatGPT. The model improves reasoning and is rolling out to all paid tiers starting today.",
    expectAlert: true,
  },
];

// NEW contract: minimal fields, recency/credibility folded into alertAction.
const newSchema = z.object({
  relevant: z.boolean(),
  alertAction: z.enum(["alert", "watch", "ignore"]),
  concept: z.string(),
  rationale: z.string(),
});

// OLD contract: replicated from the pre-removal code.
const oldSchema = newSchema.extend({
  freshness: z.enum(["fresh", "stale", "unknown"]),
  sourceQuality: z.enum([
    "first-party",
    "authoritative",
    "unverified",
    "resale",
    "unclear",
  ]),
});
const OLD_PROMPT = [
  `Monitor goal: ${GOAL}`,
  `Monitored subject: ${SUBJECT}.`,
  `Search window: ${WINDOW}.`,
  "Judge ONLY this page's visible content against the goal, not the query wording.",
  "Set relevant true and alertAction alert only when the page materially satisfies the exact goal and is fresh for the window. Competitors, look-alikes, listings, stale or unconfirmed pages are watch/ignore.",
  "Never pair freshness stale/unknown with alertAction alert.",
  "concept: a short reusable label naming the real-world event (company/product/event).",
].join("\n");
function oldDecision(
  v: z.infer<typeof oldSchema>,
): "notify" | "watch" | "ignore" {
  if (!v.relevant || v.alertAction === "ignore") return "ignore";
  if (v.alertAction === "watch") return "watch";
  if (v.freshness !== "fresh") return "watch";
  if (v.sourceQuality === "unverified" || v.sourceQuality === "unclear")
    return "watch";
  if (!v.concept.trim()) return "watch";
  return "notify";
}

async function judge<S extends z.ZodTypeAny>(
  schema: S,
  system: string,
  testCase: Case,
): Promise<z.infer<S>> {
  const { object } = await generateObject({
    model: google(MODEL),
    schema,
    system: `${system}\nReturn structured JSON only.`,
    prompt: JSON.stringify({
      page: {
        url: testCase.url,
        title: testCase.title,
        content: testCase.page,
      },
    }),
    temperature: 0,
    ...googleProviderOptions(MODEL),
  });
  return object;
}

async function main() {
  const rows: string[] = [];
  let newPass = 0;
  let oldPass = 0;
  for (const c of CASES) {
    const [newV, oldV] = await Promise.all([
      judge(newSchema, buildJudgePrompt(GOAL, SUBJECT, WINDOW), c),
      judge(oldSchema, OLD_PROMPT, c),
    ]);
    const newAlert = verdictToDecision(newV) === "notify";
    const oldAlert = oldDecision(oldV) === "notify";
    const newOk = newAlert === c.expectAlert;
    const oldOk = oldAlert === c.expectAlert;
    if (newOk) newPass += 1;
    if (oldOk) oldPass += 1;
    rows.push(
      `${newOk ? "PASS" : "FAIL"}(new) ${oldOk ? "PASS" : "FAIL"}(old)  ${c.name}` +
        `\n    expect=${c.expectAlert ? "alert" : "no-alert"} new=${newAlert ? "alert" : `no(${newV.alertAction})`} old=${oldAlert ? "alert" : `no(${oldV.alertAction}/${oldV.freshness}/${oldV.sourceQuality})`}`,
    );
  }
  console.log(rows.join("\n"));
  console.log(
    `\nnew contract: ${newPass}/${CASES.length}   old contract: ${oldPass}/${CASES.length}`,
  );
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
