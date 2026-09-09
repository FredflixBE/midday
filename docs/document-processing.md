# Document Processing Pipeline

## Overview

The Document Processing Pipeline automatically processes files uploaded to the Vault, extracting content, classifying documents using AI, and generating searchable metadata. The system is designed with **graceful degradation** - documents always reach a usable state even if AI classification fails, and users can retry processing at any time.

### Key Features

- **🤖 AI-Powered Classification**: Uses vision and text models to extract titles, summaries, dates, and tags
- **🔄 Graceful Degradation**: Documents complete even if AI fails - users can always access files and retry
- **⏱️ Stale Detection**: Identifies documents stuck in processing (>10 minutes) and allows recovery
- **🔁 Retry Functionality**: Users can reprocess failed or unclassified documents with one click
- **🖼️ HEIC Conversion**: Automatically converts HEIC/HEIF images to JPEG for compatibility
- **🏷️ Tag Embeddings**: Generates semantic embeddings for document tags for better search
- **🔐 Idempotency**: One processing run per stored file, however often it is uploaded
- **📊 Status Tracking**: Real-time visual feedback for processing, failed, and completed states

## Architecture

```mermaid
graph TB
    subgraph dashboard [Dashboard]
        Upload[File Upload]
        VaultItem[VaultItem Component]
        DataTable[Vault DataTable]
    end
    
    subgraph storage [Supabase Storage]
        Bucket[(vault bucket)]
        Trigger[Storage Trigger]
    end
    
    subgraph api [API Layer]
        ProcessAPI[processDocument]
        Reprocess[reprocessDocument]
    end
    
    subgraph db [Database]
        Documents[(documents table)]
        Tags[(document_tags)]
        Embeddings[(document_tag_embeddings)]
    end
    
    subgraph jobs [Trigger.dev tasks]
        ProcessDoc[process-document]
        ClassifyDoc[classify-document]
        ClassifyImg[classify-image]
        EmbedTags[embed-document-tags]
    end
    
    Upload --> Bucket
    Bucket --> Trigger
    Trigger --> Documents
    Upload -->|after upload| ProcessAPI
    ProcessAPI --> ProcessDoc
    
    ProcessDoc -->|PDF/text| ClassifyDoc
    ProcessDoc -->|image| ClassifyImg
    ClassifyDoc --> EmbedTags
    ClassifyImg --> EmbedTags
    
    ClassifyDoc --> Documents
    ClassifyImg --> Documents
    EmbedTags --> Tags
    EmbedTags --> Embeddings
    
    VaultItem -->|retry| Reprocess
    DataTable -->|retry| Reprocess
    Reprocess --> ProcessDoc
```

## Data Model

### Document Processing Status

The `documents` table tracks processing state:

| Status | Description | UI Display |
|--------|-------------|------------|
| `pending` | Processing in progress | Skeleton loading state |
| `completed` | Successfully processed | Shows title/summary or filename |
| `failed` | Processing failed | Red indicator + retry button |

### Document States and Visual Indicators

```mermaid
stateDiagram-v2
    [*] --> pending: File uploaded
    
    pending --> completed: Classification success
    pending --> completed: Classification failed (graceful)
    pending --> failed: Hard failure (retryable)
    pending --> failed: Stale timeout (>10 min)
    
    failed --> pending: User retry
    completed --> pending: User retry (unclassified)
    
    note right of pending
        Shows skeleton UI
        Fresh: < 10 minutes
        Stale: > 10 minutes (shows retry)
    end note
    
    note right of completed
        title=null: Amber indicator
        title!=null: Normal display
    end note
    
    note right of failed
        Red indicator
        Retry button shown
    end note
```

### Classification States

| State | processingStatus | title | Visual | User Action |
|-------|-----------------|-------|--------|-------------|
| Processing | `pending` | - | Skeleton | Wait |
| Stale Processing | `pending` (>10 min) | - | Amber + Retry | Click retry |
| Fully Processed | `completed` | Set | Normal | None needed |
| Needs Classification | `completed` | `null` | Amber + Retry | Click retry |
| Failed | `failed` | - | Red + Retry | Click retry |

## Processing Flow

```mermaid
sequenceDiagram
    participant User
    participant Storage as Supabase Storage
    participant DB as Database
    participant Trigger as Trigger.dev
    participant Process as process-document
    participant Classify as classify-document/image
    participant Embed as embed-document-tags
    
    User->>Storage: Upload file
    Storage->>DB: Create document (pending)
    Storage->>Trigger: Trigger process-document
    
    Trigger->>Process: Run task
    
    alt PDF/Text Document
        Process->>Process: Extract text content
        Process->>Trigger: Trigger classify-document
        Trigger->>Classify: Run classification
        Classify->>Classify: AI classification (with timeout)
        
        alt AI Success
            Classify->>DB: Update title, summary, tags
            Classify->>DB: Set status = completed
            Classify->>Trigger: Trigger embed-document-tags
        else AI Failure (graceful)
            Classify->>DB: Set status = completed (title=null)
            Note over Classify,DB: User can still access file
        end
        
    else Image
        Process->>Process: Convert HEIC if needed
        Process->>Trigger: Trigger classify-image
        Trigger->>Classify: Run classification
        Classify->>Classify: Vision AI classification
        
        alt AI Success
            Classify->>DB: Update title, summary, content
            Classify->>DB: Set status = completed
            Classify->>Trigger: Trigger embed-document-tags
        else AI Failure (graceful)
            Classify->>DB: Set status = completed (title=null)
        end
    end
    
    opt Tags exist
        Trigger->>Embed: Run embedding
        Embed->>DB: Upsert tags and embeddings
    end
```

## Job Architecture

### Job Hierarchy

Every task below runs with `maxDuration: 660` (11 minutes) — the hard limit on
a single run, carried over from the 11 minute lock the BullMQ documents queue
held. The internal cap is what the work itself is allowed, enforced by
`withTimeout` inside the processor.

| Task | Parent | Purpose | Run limit | Internal cap |
|------|--------|---------|-----------|--------------|
| `process-document` | - | Orchestrates document processing | 11 min | 10 min content extraction |
| `classify-document` | process-document | AI text classification | 11 min | 90 sec AI call |
| `classify-image` | process-document | AI vision classification | 11 min | 90 sec AI call + 60 sec download |
| `embed-document-tags` | classify-* | Generate tag embeddings | 11 min | 30 sec embedding |

A run limit is a hard kill, where the BullMQ lock it replaced only decided when
a job was *suspected* of having stalled. The generous 11 minutes is deliberate:
it is the ceiling, not the expectation.

### Idempotency

Two of the four dispatches carry an idempotency key. Trigger returns the
existing run rather than starting a second one while the key is live:

```typescript
// One processing run per stored file
{ idempotencyKey: `process-doc_${teamId}_${filePath.join("/")}`, idempotencyKeyTTL: "24h" }

// One embedding run per document
{ idempotencyKey: `embed-tags_${teamId}_${documentId}`, idempotencyKeyTTL: "24h" }
```

The 24 hour window matches how long BullMQ used to retain a completed job,
which is what the old deterministic job ids relied on.

**The other two are deliberately not deduplicated.** `classify-document` and
`classify-image` are only ever triggered by `process-document`, which is itself
already deduplicated, so a second key there would buy nothing. Neither is
**reprocessing**: `reprocessDocument` passes no key at all, because a retry is
meant to be a fresh run — the old code had to defeat its own deduplication by
appending `Date.now()` to the job id to get the same effect.

### Task Configuration

There is no queue to configure any more; each task carries its own settings:

```typescript
export const processDocument = schemaTask({
  id: "process-document",
  schema: processDocumentSchema,
  maxDuration: 660,                 // 11 minutes, a hard limit on one run
  queue: { concurrencyLimit: 10 },  // conservative for memory + API rate limits
  retry: { maxAttempts: 3, minTimeoutInMs: 1000, factor: 2 },
  run: /* ... */,
  onFailure: /* mark the document failed once attempts are exhausted */,
});

// Sharp memory optimization (in image-processing.ts)
sharp.cache({ memory: 256, files: 20, items: 100 }); // 256MB cache limit
sharp.concurrency(2); // Limit internal parallelism

// File size limit for HEIC
const MAX_HEIC_FILE_SIZE = 15 * 1024 * 1024; // 15MB - larger files skip AI
```

All four document tasks use the same numbers.

**Why a concurrency limit of 10?**
- HEIC conversion is memory-intensive (~50-100MB per 12MP image)
- AI classification (Gemini) has rate limits - avoid 429 errors
- Matches the other API-heavy tasks (enrich-customer: 5, delete-team: 5, accounting: 10)

Note the free Trigger.dev plan allows 20 concurrent runs across *every* task, so
10 is a share of that budget rather than a ceiling reached in practice.

## Error Handling

### Error Categories

| Category | Retryable | Retry Delay | Examples |
|----------|-----------|-------------|----------|
| `ai_content_blocked` | No | - | Content filtered by AI safety |
| `ai_quota` | Yes | 60 sec | Quota exceeded, model overloaded |
| `rate_limit` | Yes | 30 sec | Too many requests |
| `timeout` | Yes | 5 sec | Operation timed out |
| `network` | Yes | 5 sec | Connection failed |
| `validation` | No | - | Invalid input |
| `unsupported_file_type` | No | - | ZIP, video, etc. |

### Graceful Degradation Strategy

The pipeline is designed so documents **always reach a usable state**:

```mermaid
flowchart TD
    A[Start Processing] --> B{Content Extraction}
    B -->|Success| C{AI Classification}
    B -->|Failure| D[Complete with null values]
    
    C -->|Success| E[Complete with metadata]
    C -->|Failure| D
    
    D --> F[User can access file]
    E --> F
    
    F --> G{User satisfied?}
    G -->|Yes| H[Done]
    G -->|No| I[Click Retry]
    I --> A
```

**Key Principle:** A document should never be stuck. Even if AI fails:
1. Document status → `completed`
2. Title → `null` (UI shows filename + amber indicator)
3. User can download/view file
4. User can click "Retry classification"

### Failure Handling

What the BullMQ queue's `onFailed` handler did is now split between the task's
`run` and its `onFailure` hook:

```typescript
run: async (payload, { ctx }) => {
  try {
    return await handleJob(processor, "process-document", payload, ctx);
  } catch (error) {
    // A file type we cannot read is not a failure: the file is stored and
    // downloadable, so title it and complete it rather than retrying.
    if (error instanceof UnsupportedFileTypeError) {
      await markDocumentUnsupported({ pathTokens, teamId, error });
      return;
    }
    throw toTaskError(error);
  }
},

// Runs once the run has definitively failed — after every attempt, not each one.
onFailure: async ({ payload }) => {
  await markDocumentFailed({ pathTokens: payload.filePath, teamId: payload.teamId });
},
```

`onFailure` fires only when the run is finished failing, so the "only on the
final attempt" check the old handler needed is gone. `embed-document-tags` has
no `onFailure` at all — see [the design note below](#why-fire-and-forget-for-embed-document-tags).

Both helpers live in [`packages/jobs/src/utils/document-status.ts`](../packages/jobs/src/utils/document-status.ts)
and open their own database connection, because a lifecycle hook runs outside
the middleware that gives a run its own.

## Reprocessing Flow

### User-Initiated Retry

```mermaid
sequenceDiagram
    participant User
    participant UI as VaultItem/DataTable
    participant API as reprocessDocument
    participant DB as Database
    participant Trigger as Trigger.dev
    
    User->>UI: Click "Retry" button
    UI->>UI: Set isReprocessing = true
    UI->>API: mutate({ id })
    
    API->>DB: Get document by ID
    API->>API: Validate pathTokens exist
    API->>API: Check mimetype supported
    
    alt Unsupported mimetype
        API->>DB: Set status = completed
        API-->>UI: { skipped: true }
    else Supported
        API->>DB: Set status = pending
        API->>Trigger: Trigger process-document (no idempotency key)
        API-->>UI: { success: true, jobId }
    end
    
    UI->>UI: Show skeleton (isReprocessing || isPending)
    
    Note over Trigger: Task runs...
    
    Trigger->>DB: Update document
    DB-->>UI: React Query invalidation
    UI->>UI: Clear isReprocessing
    UI->>UI: Show result
```

### UI State Management

```typescript
// VaultItem component state management
const [isReprocessing, setIsReprocessing] = useState(false);

// Clear local state when document updates
useEffect(() => {
  if (isReprocessing) {
    if (isCompleted || isFailed || isLoading) {
      setIsReprocessing(false);
    }
  }
}, [isReprocessing, isLoading, isFailed, data.processingStatus]);

// Handle mutation errors
const reprocessMutation = useMutation({
  onSuccess: () => invalidateQueries(),
  onError: () => setIsReprocessing(false), // Allow retry
});
```

## Stale Document Detection

Documents pending >10 minutes are considered "stale" and show retry option in the UI:

```typescript
const isStaleProcessing =
  data.processingStatus === "pending" &&
  data.createdAt &&
  Date.now() - new Date(data.createdAt).getTime() > 10 * 60 * 1000;

// Show skeleton only for fresh pending (not stale)
const isLoading = data.processingStatus === "pending" && !isStaleProcessing;

// Show retry for stale processing
const showRetry = isFailed || needsClassification || isStaleProcessing;
```

This client-side detection allows users to manually retry documents that appear stuck without requiring a server-side cleanup job.

## Image Optimization

All images are resized before AI processing to optimize for speed, cost, and OCR quality.

### Why 2048px?

The `IMAGE_SIZES.MAX_DIMENSION` constant (2048px) was chosen based on research:

| Factor | Consideration |
|--------|---------------|
| **OCR Quality** | Text x-height ≥20px required for accurate OCR. 2048px preserves legibility for receipt small print (~400 DPI equivalent) |
| **AI Model Limits** | Within optimal ranges: Gemini (≤3072), GPT-4V (≤2048), Claude (≤1568) |
| **Performance** | Smaller images = fewer tokens = faster response + lower costs |
| **Aspect Ratio** | Uses `fit: "inside"` to maintain proportions without cropping |

### Image Processing Flow

```mermaid
flowchart TD
    A[Image Uploaded] --> B{Is HEIC?}
    B -->|Yes| C[convertHeicToJpeg]
    B -->|No| D[resizeImage]
    
    C --> E[Two-stage conversion]
    E --> F{Try Sharp}
    F -->|Success| G[JPEG @ 2048px]
    F -->|Failure| H[heic-convert fallback]
    H --> I[Sharp resize]
    I --> G
    
    D --> J{Size > 2048px?}
    J -->|Yes| K[Resize to fit 2048px]
    J -->|No| L[Keep original]
    K --> M[Continue to AI]
    L --> M
    G --> M
```

### Implementation

```typescript
// image-processing.ts - Centralized image utilities

// Resize any image to fit within max dimensions
export async function resizeImage(
  inputBuffer: ArrayBuffer,
  mimetype: string,
  logger: Logger,
  options?: { maxSize?: number }
): Promise<{ buffer: Buffer; mimetype: string }> {
  const maxSize = options?.maxSize ?? IMAGE_SIZES.MAX_DIMENSION; // 2048px
  
  // Skip unsupported formats
  if (!RESIZABLE_MIMETYPES.has(mimetype)) {
    return { buffer: Buffer.from(inputBuffer), mimetype };
  }
  
  // Skip if already within size limits
  const metadata = await sharp(Buffer.from(inputBuffer)).metadata();
  if (metadata.width <= maxSize && metadata.height <= maxSize) {
    return { buffer: Buffer.from(inputBuffer), mimetype };
  }
  
  // Resize maintaining aspect ratio
  const buffer = await sharp(Buffer.from(inputBuffer))
    .rotate()
    .resize({ width: maxSize, height: maxSize, fit: "inside" })
    .toBuffer();
  
  return { buffer, mimetype };
}

// HEIC conversion with resize
export async function convertHeicToJpeg(
  inputBuffer: ArrayBuffer,
  logger: Logger,
  options?: { maxSize?: number }
): Promise<HeicConversionResult> {
  const maxSize = options?.maxSize ?? IMAGE_SIZES.MAX_DIMENSION; // 2048px
  
  // Try sharp first (handles HEIF/HEIC + mislabeled files)
  try {
    const buffer = await sharp(Buffer.from(inputBuffer))
      .rotate()
      .resize({ width: maxSize, height: maxSize, fit: "inside" })
      .toFormat("jpeg")
      .toBuffer();
    return { buffer, mimetype: "image/jpeg" };
  } catch (sharpError) {
    // Fall back to heic-convert for edge cases
    // Note: heic-convert decodes to raw pixels - memory intensive!
    // 12MP photo = ~48MB raw RGBA. Quality 0.8 reduces output size.
    const decodedImage = await convert({
      buffer: new Uint8Array(inputBuffer),
      format: "JPEG",
      quality: 0.8, // Reduced from 1.0 to save memory
    });
    
    const buffer = await sharp(Buffer.from(decodedImage))
      .rotate()
      .resize({ width: maxSize, height: maxSize, fit: "inside" })
      .toFormat("jpeg")
      .toBuffer();
    return { buffer, mimetype: "image/jpeg" };
  }
}

// In process-document.ts - graceful degradation for HEIC
// If conversion fails (e.g., OOM), document completes with fallback
try {
  const { buffer: image } = await convertHeicToJpeg(buffer, logger);
  // ... upload and continue
} catch (conversionError) {
  // Complete with fallback - user can still see file and retry
  await updateDocument({ title: filename, status: "completed" });
  return;
}
```

### Supported Image Types

| Mimetype | Resize | HEIC Conversion |
|----------|--------|-----------------|
| `image/jpeg` | ✅ | - |
| `image/png` | ✅ | - |
| `image/webp` | ✅ | - |
| `image/gif` | ✅ | - |
| `image/tiff` | ✅ | - |
| `image/heic` | Via conversion | ✅ |
| `image/heif` | Via conversion | ✅ |

## Timeout Configuration

```typescript
// timeout.ts - Centralized timeout constants
export const TIMEOUTS = {
  DOCUMENT_PROCESSING: 600_000,  // 10 minutes - content extraction
  AI_CLASSIFICATION: 90_000,     // 90 seconds - AI calls
  FILE_DOWNLOAD: 60_000,         // 1 minute - storage downloads
  FILE_UPLOAD: 60_000,           // 1 minute - storage uploads
  EMBEDDING: 30_000,             // 30 seconds - embedding generation
} as const;

// Image size constants
export const IMAGE_SIZES = {
  MAX_DIMENSION: 2048,  // Optimal for vision models + OCR
} as const;

// Usage with timeout wrapper
const result = await withTimeout(
  classifier.classifyDocument({ content }),
  TIMEOUTS.AI_CLASSIFICATION,
  `Classification timed out after ${TIMEOUTS.AI_CLASSIFICATION}ms`
);
```

**These bound the work, not the run.** A task's `maxDuration` bounds the run;
the constants above bound individual calls inside it, so a hung model or a slow
download fails with a useful message instead of burning the whole 11 minutes.

`process-document` waits on classification with `triggerAndWait`, and that wait
is bounded by the child's own `maxDuration`. There is no separate constant for
it — the old `CLASSIFICATION_JOB_WAIT` existed because BullMQ's wait needed a
timeout of its own, and keeping the two in step was a standing hazard.

## Key Files Reference

| File | Purpose |
|------|---------|
| [`apps/dashboard/src/components/vault/vault-item.tsx`](../apps/dashboard/src/components/vault/vault-item.tsx) | Document card with status indicators and retry button |
| [`apps/dashboard/src/components/tables/vault/columns.tsx`](../apps/dashboard/src/components/tables/vault/columns.tsx) | Table columns with status styling and dropdown retry |
| [`apps/dashboard/src/components/tables/vault/data-table.tsx`](../apps/dashboard/src/components/tables/vault/data-table.tsx) | Table with reprocess mutation |
| [`apps/api/src/trpc/routers/documents.ts`](../apps/api/src/trpc/routers/documents.ts) | tRPC router with reprocessDocument endpoint |
| [`packages/jobs/src/tasks/document/process-document.ts`](../packages/jobs/src/tasks/document/process-document.ts) | Main orchestrator job |
| [`packages/jobs/src/tasks/document/classify-document.ts`](../packages/jobs/src/tasks/document/classify-document.ts) | AI text classification with graceful degradation |
| [`packages/jobs/src/tasks/document/classify-image.ts`](../packages/jobs/src/tasks/document/classify-image.ts) | AI vision classification with graceful degradation |
| [`packages/jobs/src/tasks/document/embed-document-tags.ts`](../packages/jobs/src/tasks/document/embed-document-tags.ts) | Tag embedding generation |
| [`packages/jobs/src/utils/document-status.ts`](../packages/jobs/src/utils/document-status.ts) | Failure handlers (queue options now live on each task) |
| [`packages/jobs/src/utils/image-processing.ts`](../packages/jobs/src/utils/image-processing.ts) | Image resize and HEIC conversion utilities |
| [`packages/jobs/src/utils/document-update.ts`](../packages/jobs/src/utils/document-update.ts) | Document update with retry for race conditions |
| [`packages/jobs/src/utils/error-classification.ts`](../packages/jobs/src/utils/error-classification.ts) | Error categorization and retry strategies |
| [`packages/jobs/src/utils/timeout.ts`](../packages/jobs/src/utils/timeout.ts) | Timeout constants and wrapper utility |
| [`packages/documents/src/classifier/classifier.ts`](../packages/documents/src/classifier/classifier.ts) | AI classification implementation |

## Design Decisions

### Why graceful degradation?

Documents should **never** be stuck in an inaccessible state. Even if AI fails:
- Users can still view/download their files
- The filename is displayed (not "Processing...")
- A clear retry option is provided
- No data is lost

This prioritizes user access over perfect metadata.

### Why mark AI failures as "completed" instead of "failed"?

We distinguish between:
- **Hard failures**: File doesn't exist, unsupported format, storage errors → `failed`
- **Soft failures**: AI classification failed → `completed` with `title=null`

Soft failures still result in a usable document. The UI shows these with an amber indicator and "Retry classification" button, differentiating them from hard failures (red indicator, "Retry processing" button).

### Why an idempotency key on the upload path?

Without one, the same file could be processed several times:
- Supabase storage trigger retry
- User clicking retry rapidly
- Network issues causing duplicate API calls

`process-doc_${teamId}_${path}` with a 24 hour TTL means Trigger returns the
run already in flight instead of starting a second one.

Reprocessing deliberately omits it. A retry is a request for a *fresh* run, and
the previous key would still be live — under BullMQ the same problem was solved
by appending `Date.now()` to the job id, which meant that path never
deduplicated anything at all.

### Why 10-minute stale threshold?

The processing pipeline has these timeouts:
- Full pipeline: 10 minutes
- AI classification: 90 seconds
- File operations: 60 seconds each

If a document is still "pending" after 10 minutes, something went wrong. The threshold gives ample time for legitimate processing while catching stuck jobs.

### Why separate classify-document and classify-image jobs?

Different processing requirements:
- **Documents**: Text extraction → AI text classification
- **Images**: Direct vision API classification (no text extraction)

Separating them allows:
- Different timeout configurations
- Different error handling
- Independent scaling
- Clearer job logs

### Why fire-and-forget for embed-document-tags?

Tag embedding is an **enrichment** step, not a critical path:
- Document is already classified and usable
- Tag embedding improves search but isn't required
- Failure shouldn't mark the document as failed
- Can be retried independently in the future

The failure handler explicitly skips status updates for `documentId`-based jobs (embed-document-tags).
