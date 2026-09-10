import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { createLoggerWithContext } from "@midday/logger";
import { generateObject } from "ai";
import type { z } from "zod/v4";
import type {
  ExtractionConfig,
  ModelConfig,
} from "../config/extraction-config";
import type { PromptComponents } from "../prompts/factory";
import { createFieldSpecificPrompt } from "../prompts/field-specific";
import { mapWithConcurrency } from "../utils/concurrency";
import type { DocumentFormat } from "../utils/format-detection";
import { extractTextFromPdf } from "../utils/pdf-text-extract";
import { retryCall } from "../utils/retry";

const google = createGoogleGenerativeAI({
  apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY!,
});

const mistral = createMistral({
  apiKey: process.env.MISTRAL_API_KEY!,
});

/**
 * How many single-field re-extractions may be in the air at once.
 *
 * Each one is a whole extraction: a request carrying the document, a response
 * to parse, and — if it throws — a stack to resolve against the worker's
 * source map, which on its own has been measured in the hundreds of megabytes.
 * One call per missing field, started together, is widest precisely when the
 * document has nothing on it, and that is what exhausted the worker.
 */
export const MAX_PARALLEL_FIELD_REEXTRACTIONS = 2;

/** Per-call timeout when re-extracting a field the document needs to be usable. */
const CRITICAL_FIELD_TIMEOUT = 90_000;

/** Per-call timeout when re-extracting a field that only adds detail. */
const OTHER_FIELD_TIMEOUT = 30_000;

/**
 * Check if an error is a rate limit error
 */
function isRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const message = error.message.toLowerCase();
  return (
    message.includes("rate limit") ||
    message.includes("rate_limit") ||
    message.includes("too many requests") ||
    message.includes("quota") ||
    message.includes("429") ||
    message.includes("resource_exhausted")
  );
}

export interface ExtractionResult<T> {
  data: T;
  qualityScore: {
    score: number;
    issues: string[];
    missingCriticalFields: string[];
    invalidFields: string[];
  };
}

export interface ExtractionOptions {
  companyName?: string | null;
  logger?: ReturnType<typeof createLoggerWithContext>;
}

/**
 * Base extraction engine that handles multi-pass extraction strategy
 * for both invoices and receipts
 */
export abstract class BaseExtractionEngine<T extends z.ZodSchema> {
  protected config: ExtractionConfig<T>;
  protected logger: ReturnType<typeof createLoggerWithContext>;

  constructor(
    config: ExtractionConfig<T>,
    logger?: ReturnType<typeof createLoggerWithContext>,
  ) {
    this.config = config;
    this.logger =
      logger ||
      createLoggerWithContext(`BaseExtractionEngine:${this.getDocumentType()}`);
  }

  protected getDocumentType(): string {
    return "unknown";
  }

  /**
   * Extract data using a specific provider and model
   */
  protected async extractWithProvider(
    documentUrl: string,
    prompt: string,
    modelConfig: ModelConfig,
    options: {
      timeout?: number;
      retries?: number;
      retryDelay?: number;
    } = {},
  ): Promise<z.infer<T>> {
    const contentField =
      this.config.contentType === "file"
        ? {
            type: "file" as const,
            data: documentUrl,
            mediaType: this.config.mediaType,
          }
        : {
            type: "image" as const,
            image: documentUrl,
          };

    const model =
      modelConfig.provider === "mistral"
        ? mistral(modelConfig.model)
        : google(modelConfig.model);

    // Provider-specific options
    const providerOptions =
      modelConfig.provider === "mistral"
        ? {
            mistral: {
              documentPageLimit: 10,
            },
          }
        : undefined;

    const result = await retryCall(
      () =>
        generateObject({
          model,
          schema: this.config.schema,
          temperature: 0.1,
          abortSignal: AbortSignal.timeout(options.timeout ?? this.config.timeout),
          messages: [
            {
              role: "system",
              content: prompt,
            },
            {
              role: "user",
              content: [contentField],
            },
          ],
          ...(providerOptions && { providerOptions }),
        }),
      options.retries ?? this.config.retries,
      options.retryDelay ?? 2000, // Start with 2s delay
    );

    return result.object as z.infer<T>;
  }

  /**
   * Extract with cascading fallback across providers
   * Tries primary -> secondary -> tertiary with rate limit detection
   */
  protected async extractWithCascadingFallback(
    documentUrl: string,
    prompt: string,
  ): Promise<{ result: z.infer<T>; usedModel: ModelConfig }> {
    const models = [
      { config: this.config.models.primary, name: "primary" },
      { config: this.config.models.secondary, name: "secondary" },
      { config: this.config.models.tertiary, name: "tertiary" },
    ];

    let lastError: Error | null = null;

    for (const { config: modelConfig, name } of models) {
      try {
        this.logger.info(`Attempting extraction with ${name} model`, {
          provider: modelConfig.provider,
          model: modelConfig.model,
        });

        const result = await this.extractWithProvider(
          documentUrl,
          prompt,
          modelConfig,
        );

        this.logger.info(`Extraction succeeded with ${name} model`, {
          provider: modelConfig.provider,
          model: modelConfig.model,
        });

        return { result, usedModel: modelConfig };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        const isRateLimit = isRateLimitError(error);
        this.logger.warn(`${name} model extraction failed`, {
          provider: modelConfig.provider,
          model: modelConfig.model,
          isRateLimit,
          error: lastError.message,
        });
        // Continue to next model on rate limit or any error
      }
    }

    // All models failed
    throw lastError || new Error("All extraction models failed");
  }

  /**
   * Extract with primary model (uses cascading fallback)
   */
  protected async extractWithPrimaryModel(
    documentUrl: string,
    prompt: string,
  ): Promise<z.infer<T>> {
    const { result } = await this.extractWithCascadingFallback(
      documentUrl,
      prompt,
    );
    return result;
  }

  /**
   * Extract with secondary/fallback model (skips primary)
   */
  protected async extractWithFallbackModel(
    documentUrl: string,
    prompt: string,
  ): Promise<z.infer<T>> {
    // Try secondary first, then tertiary
    try {
      return await this.extractWithProvider(
        documentUrl,
        prompt,
        this.config.models.secondary,
      );
    } catch (error) {
      this.logger.warn("Secondary model failed, trying tertiary", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return await this.extractWithProvider(
        documentUrl,
        prompt,
        this.config.models.tertiary,
      );
    }
  }

  /**
   * Extract using text fallback - extracts text from PDF and sends as text input
   * Used as last resort when PDF processing times out
   */
  protected async extractWithTextFallback(
    documentUrl: string,
    prompt: string,
    modelConfig: ModelConfig,
  ): Promise<z.infer<T>> {
    // Extract text from PDF
    const extractedText = await extractTextFromPdf(documentUrl);

    if (!extractedText) {
      throw new Error(
        "Failed to extract text from PDF - PDF may be image-based or corrupted",
      );
    }

    // Modify prompt to indicate text was extracted from PDF
    const modifiedPrompt = `${prompt}\n\nNOTE: The document content below was extracted as text from a PDF. Some formatting, layout, or visual elements may be missing. Please extract the requested information from the text content.`;

    const model =
      modelConfig.provider === "mistral"
        ? mistral(modelConfig.model)
        : google(modelConfig.model);

    // Send extracted text as text content (not file)
    const result = await retryCall(
      () =>
        generateObject({
          model,
          schema: this.config.schema,
          temperature: 0.1,
          abortSignal: AbortSignal.timeout(this.config.timeout),
          messages: [
            {
              role: "system",
              content: modifiedPrompt,
            },
            {
              role: "user",
              content: [
                {
                  type: "text" as const,
                  text: extractedText,
                },
              ],
            },
          ],
        }),
      this.config.retries,
      2000, // Start with 2s delay
    );

    return result.object as z.infer<T>;
  }

  /**
   * Analyze failure pattern to determine best refinement strategy
   */
  protected analyzeFailurePattern(
    result: z.infer<T>,
    qualityScore: {
      score: number;
      issues: string[];
      missingCriticalFields: string[];
      invalidFields: string[];
    },
  ): {
    strategy:
      | "field_specific"
      | "mathematical"
      | "format_aware"
      | "comprehensive";
    criticalFieldsMissing: boolean;
    consistencyIssues: boolean;
    formatIssues: boolean;
  } {
    const criticalFieldsMissing = qualityScore.missingCriticalFields.length > 0;
    const hasNumericFields = qualityScore.missingCriticalFields.some(
      (f) => f.includes("amount") || f.includes("rate"),
    );
    const detectedFormat = this.detectFormat(result);

    let strategy:
      | "field_specific"
      | "mathematical"
      | "format_aware"
      | "comprehensive" = "field_specific";

    if (criticalFieldsMissing && hasNumericFields && detectedFormat) {
      strategy = "comprehensive"; // Use both mathematical and format-aware
    } else if (hasNumericFields) {
      strategy = "mathematical"; // Focus on calculating missing numeric fields
    } else if (detectedFormat) {
      strategy = "format_aware"; // Use format-specific prompts
    }

    return {
      strategy,
      criticalFieldsMissing,
      consistencyIssues: qualityScore.invalidFields.length > 0,
      formatIssues: detectedFormat !== undefined,
    };
  }

  /**
   * Re-extract specific fields, a bounded number of calls at a time.
   *
   * Still batched by priority, so the fields that decide whether the document
   * is usable at all are asked for before the ones that only add detail.
   */
  protected async reExtractFields(
    documentUrl: string,
    fields: string[],
    companyName?: string | null,
    format?: DocumentFormat | undefined,
  ): Promise<Partial<z.infer<T>>> {
    if (fields.length === 0) {
      return {};
    }

    // Sort fields by priority (higher priority first)
    const sortedFields = [...fields].sort((a, b) => {
      const priorityA = this.config.fieldPriority[a] || 0;
      const priorityB = this.config.fieldPriority[b] || 0;
      return priorityB - priorityA;
    });

    // Batch critical fields (priority >= 8) separately from others
    const batches = [
      {
        label: "critical",
        timeout: CRITICAL_FIELD_TIMEOUT,
        fields: sortedFields.filter(
          (field) => (this.config.fieldPriority[field] || 0) >= 8,
        ),
      },
      {
        label: "other",
        timeout: OTHER_FIELD_TIMEOUT,
        fields: sortedFields.filter(
          (field) => (this.config.fieldPriority[field] || 0) < 8,
        ),
      },
    ];

    const reExtractedFields: Partial<z.infer<T>> = {};

    for (const batch of batches) {
      if (batch.fields.length === 0) {
        continue;
      }

      this.logger.info(`Re-extracting ${batch.label} fields`, {
        fields: batch.fields,
        count: batch.fields.length,
        maxParallel: MAX_PARALLEL_FIELD_REEXTRACTIONS,
      });

      const results = await mapWithConcurrency(
        batch.fields,
        MAX_PARALLEL_FIELD_REEXTRACTIONS,
        (field) =>
          this.reExtractField(documentUrl, field, {
            timeout: batch.timeout,
            companyName,
            format,
          }),
      );

      for (const result of results) {
        if (result) {
          (reExtractedFields as any)[result.field] = result.value;
        }
      }
    }

    return reExtractedFields;
  }

  /**
   * Ask for one field on its own.
   *
   * Never throws: a field that cannot be recovered is one field missing from
   * the result, not a failed extraction.
   */
  protected async reExtractField(
    documentUrl: string,
    field: string,
    options: {
      timeout: number;
      companyName?: string | null;
      format?: DocumentFormat | undefined;
    },
  ): Promise<{ field: string; value: unknown } | null> {
    try {
      // Use format-aware prompt if format is available
      let fieldPrompt = createFieldSpecificPrompt(
        field,
        this.getDocumentType() as "invoice" | "receipt",
        options.companyName,
      );

      // Enhance prompt with format hints if available
      if (options.format) {
        const formatHints = this.getFormatHintsForField(field, options.format);
        if (formatHints) {
          fieldPrompt = `${fieldPrompt}\n\n${formatHints}`;
        }
      }

      // Use secondary model (Google) for field re-extraction for reliability
      const result = await this.extractWithProvider(
        documentUrl,
        fieldPrompt,
        this.config.models.secondary,
        {
          timeout: options.timeout,
          retries: 1, // 1 retry (2 total attempts) for field-specific extraction
          retryDelay: 1000,
        },
      );

      const fieldValue = (result as Record<string, unknown>)[field];
      if (fieldValue !== null && fieldValue !== undefined) {
        return { field, value: fieldValue };
      }
      return null;
    } catch (error) {
      this.logger.warn(`Failed to re-extract field ${field}`, {
        field,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return null;
    }
  }

  /**
   * The model's own answer to whether this is a financial document at all.
   *
   * "other" is a legitimate result with nothing to extract, not a failed
   * extraction: every amount it is missing is missing because the document
   * has none.
   */
  protected isClassifiedAsOther(result: z.infer<T>): boolean {
    return (result as { document_type?: unknown }).document_type === "other";
  }

  /**
   * Whether the model read anything off the document, classification aside.
   *
   * The classification and the language are what a model returns for a blank
   * wall, so neither counts as content.
   */
  protected hasExtractedContent(result: z.infer<T>): boolean {
    const ignored = new Set(["document_type", "language"]);

    return Object.entries(result as Record<string, unknown>).some(
      ([field, value]) => {
        if (ignored.has(field) || value === null || value === undefined) {
          return false;
        }
        if (Array.isArray(value)) {
          return value.length > 0;
        }
        if (typeof value === "string") {
          return value.trim().length > 0;
        }
        return true;
      },
    );
  }

  /**
   * Main extraction method - implements multi-pass strategy
   */
  async extract(
    documentUrl: string,
    options: ExtractionOptions = {},
  ): Promise<ExtractionResult<z.infer<T>>> {
    const { companyName } = options;
    const logger = options.logger || this.logger;

    if (!documentUrl) {
      throw new Error("Document URL is required");
    }

    // Get prompt factory
    const promptFactory = this.config.promptFactory;

    // Pass 1: Extract with primary model and standard prompt
    let result: z.infer<T>;

    try {
      // Start with basic prompt (format will be detected after Pass 1)
      const promptComponents = promptFactory(companyName);
      const prompt = this.composePrompt(promptComponents, false);

      logger.info("Pass 1: Extracting with cascading fallback", {
        pass: 1,
        primaryModel: `${this.config.models.primary.provider}:${this.config.models.primary.model}`,
      });

      result = await this.extractWithPrimaryModel(documentUrl, prompt);
    } catch (error) {
      // Check if this is a timeout error and we're processing a PDF
      const isTimeoutError =
        (error instanceof DOMException && error.code === 23) ||
        (error instanceof Error &&
          (error.name === "TimeoutError" ||
            error.message.includes("timeout") ||
            error.message.includes("timed out")));

      const isPdfFile =
        this.config.contentType === "file" &&
        this.config.mediaType === "application/pdf";

      // If timeout error on PDF, try text extraction fallback as last resort
      if (isTimeoutError && isPdfFile) {
        logger.warn(
          "PDF extraction timed out, attempting text extraction fallback",
          {
            error: error instanceof Error ? error.message : "Unknown error",
          },
        );

        try {
          const promptComponents = promptFactory(companyName);
          const prompt = this.composePrompt(promptComponents, false);

          result = await this.extractWithTextFallback(
            documentUrl,
            prompt,
            this.config.models.secondary,
          );

          logger.info("Text extraction fallback succeeded", {
            pass: 1,
            fallback: "text-extraction",
          });

          return {
            data: result,
            qualityScore: this.calculateQualityScore(result),
          };
        } catch (textFallbackError) {
          logger.error("Text extraction fallback also failed", {
            error:
              textFallbackError instanceof Error
                ? textFallbackError.message
                : "Unknown error",
          });
          // Fall through to try fallback model
        }
      }

      logger.warn("Pass 1 failed, trying fallback model immediately", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      // If primary fails completely, try fallback model immediately
      const fallbackPromptComponents = promptFactory(companyName, undefined);
      const fallbackPrompt = this.composePrompt(fallbackPromptComponents, true);
      result = await this.extractWithFallbackModel(documentUrl, fallbackPrompt);
      return {
        data: result,
        qualityScore: this.calculateQualityScore(result),
      };
    }

    // Check data quality (subclasses will provide these functions)
    const qualityScore = this.calculateQualityScore(result);
    logger.info("Pass 1 quality score", {
      pass: 1,
      score: qualityScore.score,
      issues: qualityScore.issues,
      missingCriticalFields: qualityScore.missingCriticalFields,
    });

    // If quality is good, return result
    if (!this.isDataQualityPoor(result)) {
      return { data: result, qualityScore };
    }

    // A document the model itself classified as non-financial scores zero for
    // the same reason it is finished: it has no amounts on it. Escalating from
    // here spends a second whole pass plus one call per missing field
    // re-reading a photo of something else, which is the most expensive path
    // in the engine taken for the least useful input.
    if (this.isClassifiedAsOther(result)) {
      logger.info("Pass 1 classified the document as other, stopping", {
        pass: 1,
        score: qualityScore.score,
      });
      return { data: result, qualityScore };
    }

    // Pass 2: Re-extract with fallback model and chain-of-thought prompt
    logger.info(
      "Pass 1 quality poor, running Pass 2 with fallback model and chain-of-thought",
      {
        pass: 2,
        model: `${this.config.models.secondary.provider}:${this.config.models.secondary.model}`,
      },
    );
    try {
      // Detect format from initial extraction for adaptive prompts
      const detectedFormat = this.detectFormat(result);

      const chainOfThoughtPromptComponents = promptFactory(
        companyName,
        detectedFormat,
      );
      const chainOfThoughtPrompt = this.composePrompt(
        chainOfThoughtPromptComponents,
        true,
      );

      const fallbackResult = await this.extractWithFallbackModel(
        documentUrl,
        chainOfThoughtPrompt,
      );

      // Calculate confidence scores for both extractions
      const primaryQuality = this.calculateQualityScore(result);
      const fallbackQuality = this.calculateQualityScore(fallbackResult);
      const primaryConfidence = this.calculateConfidence(
        result,
        primaryQuality,
      );
      const fallbackConfidence = this.calculateConfidence(
        fallbackResult,
        fallbackQuality,
      );

      logger.info("Confidence scores for Pass 2 merge", {
        primaryConfidence: primaryConfidence.toFixed(2),
        fallbackConfidence: fallbackConfidence.toFixed(2),
      });

      // Merge results intelligently with confidence weighting
      result = this.mergeResultsWithConfidence(
        result,
        fallbackResult,
        primaryConfidence,
        fallbackConfidence,
      );

      // Re-check quality after merge
      const mergedQualityScore = this.calculateQualityScore(result);
      logger.info("Pass 2 merged quality score", {
        pass: 2,
        score: mergedQualityScore.score,
        issues: mergedQualityScore.issues,
      });

      // If quality is now good, return merged result
      if (!this.isDataQualityPoor(result)) {
        return { data: result, qualityScore: mergedQualityScore };
      }

      if (this.isClassifiedAsOther(result)) {
        logger.info("Pass 2 classified the document as other, stopping", {
          pass: 2,
          score: mergedQualityScore.score,
        });
        return { data: result, qualityScore: mergedQualityScore };
      }
    } catch (fallbackError) {
      logger.warn("Pass 2 fallback extraction failed", {
        error:
          fallbackError instanceof Error
            ? fallbackError.message
            : "Unknown error",
      });
      // Continue to Pass 3 even if Pass 2 fails
    }

    // Pass 3: Targeted field re-extraction for missing/invalid fields
    const fieldsToReExtract = this.getFieldsNeedingReExtraction(result);

    // Two passes, two models, and the result is still empty. Asking again one
    // field at a time is a request per missing field against the same empty
    // document, and the answer it is refining does not exist.
    const worthReExtracting =
      fieldsToReExtract.length > 0 && this.hasExtractedContent(result);

    if (fieldsToReExtract.length > 0 && !worthReExtracting) {
      logger.info("Skipping Pass 3: two passes read nothing off this document", {
        pass: 3,
        fields: fieldsToReExtract.length,
      });
    }

    if (worthReExtracting) {
      logger.info("Pass 3: Re-extracting specific fields", {
        pass: 3,
        fields: fieldsToReExtract,
        count: fieldsToReExtract.length,
      });
      try {
        const reExtractedFields = await this.reExtractFields(
          documentUrl,
          fieldsToReExtract,
          companyName,
        );

        // Merge re-extracted fields back into result
        result = this.mergeResults(result, reExtractedFields);

        const finalQualityScore = this.calculateQualityScore(result);
        logger.info("Pass 3 final quality score", {
          pass: 3,
          score: finalQualityScore.score,
          issues: finalQualityScore.issues,
        });
      } catch (reExtractError) {
        logger.warn("Pass 3 field re-extraction failed", {
          error:
            reExtractError instanceof Error
              ? reExtractError.message
              : "Unknown error",
        });
        // Return what we have even if re-extraction fails
      }
    }

    // Pass 4: Cross-field consistency validation and mathematical fixes
    const consistencyResult = this.validateConsistency(result);
    if (
      consistencyResult.issues.length > 0 ||
      consistencyResult.suggestedFixes.length > 0
    ) {
      logger.info("Pass 4: Cross-field consistency validation", {
        pass: 4,
        issues: consistencyResult.issues.length,
        suggestedFixes: consistencyResult.suggestedFixes.length,
      });

      // Apply suggested fixes
      if (consistencyResult.suggestedFixes.length > 0) {
        result = this.applyConsistencyFixes(
          result,
          consistencyResult.suggestedFixes,
        );
        logger.info("Applied consistency fixes", {
          fixesApplied: consistencyResult.suggestedFixes.map((f) => f.field),
        });
      }

      // Log consistency issues
      if (consistencyResult.issues.length > 0) {
        logger.warn("Cross-field consistency issues found", {
          issues: consistencyResult.issues.map((i) => ({
            field: i.field,
            issue: i.issue,
            severity: i.severity,
          })),
        });
      }
    }

    return {
      data: result,
      qualityScore: this.calculateQualityScore(result),
    };
  }

  /**
   * Get format-specific hints for a field
   */
  protected getFormatHintsForField(
    field: string,
    format: DocumentFormat,
  ): string | null {
    const hints: string[] = [];

    if (field.includes("amount") || field.includes("rate")) {
      if (format.numberFormat === "european") {
        hints.push(
          "NUMBER FORMAT: Use European format (1.234,56) - comma as decimal separator.",
        );
      }
    }

    if (field.includes("date")) {
      if (format.dateFormat === "european") {
        hints.push(
          "DATE FORMAT: Convert from DD/MM/YYYY to YYYY-MM-DD format.",
        );
      }
    }

    if (field.includes("tax")) {
      if (format.taxTerm === "vat") {
        hints.push("Look for VAT, MwSt, TVA, or IVA labels.");
      } else if (format.taxTerm === "gst") {
        hints.push("Look for GST labels.");
      }
    }

    return hints.length > 0 ? hints.join("\n") : null;
  }

  /**
   * Compose prompt from components
   */
  protected composePrompt(
    components: PromptComponents,
    useChainOfThought: boolean,
  ): string {
    const parts: string[] = [];

    parts.push(components.base);
    parts.push(
      "Extract structured data with maximum accuracy. Follow these instructions precisely:",
    );
    parts.push("");
    parts.push(components.examples);

    if (useChainOfThought && components.chainOfThought) {
      parts.push("");
      parts.push(components.chainOfThought);
    }

    if (components.context) {
      parts.push("");
      parts.push(components.context);
    }

    parts.push("");
    parts.push(components.requirements);
    parts.push("");
    parts.push(components.fieldRules);
    parts.push("");
    parts.push(components.accuracyGuidelines);
    parts.push("");
    parts.push(components.commonErrors);
    parts.push("");
    parts.push(components.validation);

    return parts.join("\n");
  }

  /**
   * Check if data quality is poor using configurable threshold
   */
  protected isDataQualityPoor(result: z.infer<T>): boolean {
    const qualityScore = this.calculateQualityScore(result);
    return (
      qualityScore.score < this.config.qualityThreshold ||
      qualityScore.missingCriticalFields.length > 0
    );
  }

  /**
   * Detect document format from extracted data
   */
  protected abstract detectFormat(
    result: z.infer<T>,
  ): DocumentFormat | undefined;

  /**
   * Validate cross-field consistency
   */
  protected abstract validateConsistency(result: z.infer<T>): {
    isValid: boolean;
    issues: Array<{
      field: string;
      issue: string;
      severity: "error" | "warning";
    }>;
    suggestedFixes: Array<{
      field: string;
      value: any;
      reason: string;
    }>;
  };

  /**
   * Apply consistency fixes
   */
  protected abstract applyConsistencyFixes(
    result: z.infer<T>,
    fixes: Array<{ field: string; value: any; reason: string }>,
  ): z.infer<T>;

  /**
   * Calculate confidence score for extraction result (0-1)
   */
  protected abstract calculateConfidence(
    result: z.infer<T>,
    qualityScore: {
      score: number;
      missingCriticalFields: string[];
    },
  ): number;

  /**
   * Merge results with confidence weighting
   */
  protected mergeResultsWithConfidence(
    primary: z.infer<T>,
    secondary: Partial<z.infer<T>>,
    _primaryConfidence: number,
    _secondaryConfidence: number,
  ): z.infer<T> {
    // Default implementation uses regular merge
    // Subclasses can override for confidence-weighted merging
    return this.mergeResults(primary, secondary);
  }

  /**
   * Abstract methods that subclasses must implement
   */
  protected abstract calculateQualityScore(result: z.infer<T>): {
    score: number;
    issues: string[];
    missingCriticalFields: string[];
    invalidFields: string[];
  };

  protected abstract getFieldsNeedingReExtraction(result: z.infer<T>): string[];

  protected abstract mergeResults(
    primary: z.infer<T>,
    secondary: Partial<z.infer<T>>,
  ): z.infer<T>;
}
