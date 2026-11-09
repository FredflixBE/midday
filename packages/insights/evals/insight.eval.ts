/**
 * Eval for weekly insight quality
 *
 * Tests that generated insights are personal, well-formatted, and have appropriate tone
 */
import "dotenv/config";
import { languageModel } from "@midday/ai";
import { generateText } from "ai";
import { evalite } from "evalite";
import {
  buildStoryPrompt,
  buildSummaryPrompt,
  buildTitlePrompt,
} from "../src/content/prompts/index";
import type { InsightSlots } from "../src/content/prompts/slots";
import { allFixtures } from "./fixtures";
import { allScorers } from "./scorers";

/** What production writes insights with. */
const model = languageModel("assistant");

/**
 * Generate a complete insight from slots
 */
async function generateInsight(slots: InsightSlots) {
  const [title, summary, story] = await Promise.all([
    generateText({
      model,
      prompt: buildTitlePrompt(slots),
    }),
    generateText({
      model,
      prompt: buildSummaryPrompt(slots),
    }),
    generateText({
      model,
      prompt: buildStoryPrompt(slots),
    }),
  ]);

  return {
    title: title.text.trim(),
    summary: summary.text.trim(),
    story: story.text.trim(),
  };
}

evalite("Weekly Insight Quality", {
  data: allFixtures.map((f) => ({
    input: f.slots,
    name: f.name,
  })),

  task: async (slots) => {
    return generateInsight(slots);
  },

  scorers: allScorers,
});
