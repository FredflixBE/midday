# @midday/yuki

A SOAP client for the Yuki (now Nmbrs Accounting) web services.

## It cannot write

Yuki exposes **no delete operation** in any of its services — Archive,
AccountingInfo, Accounting and BackOffice were all checked — and offers **no
sandbox**. Anything uploaded or booked can only be removed by a human in the
Yuki UI, on the live books.

So the client refuses any operation that is not on the read allowlist in
`src/operations.ts`, and refuses before building a request. A caller that
genuinely needs a write names it:

```ts
const client = new YukiClient({ ...config, allowWriteOperations: ["UploadDocument"] });
```

and gets that one operation and nothing else. Unknown operations fail closed,
on the grounds that an unclassified operation might be a write.

## Setup

```sh
cp packages/yuki/.env.example packages/yuki/.env
# fill in YUKI_ACCESS_KEY and YUKI_ADMINISTRATION_ID
```

Create the access key in Yuki under **Settings → Web services → +**; the
administration ID is on the same screen. `YUKI_REGION` is `be` for Belgian
domains — the wrong region reports `Domain has no active database`, which reads
like a permissions problem rather than a wrong host.

Keep these in `packages/yuki/.env`. **Not** in `packages/db/.env`: `bun run`
auto-loads the nearest `.env`, and that file points at the live Frankfurt
Supabase project.

## Exploring the API

```sh
bun run --cwd packages/yuki explore
```

Runs the FF-1448 probes and writes raw responses to `.explore-output/`.

Some parameter names in the probes are inferred from Yuki's support
documentation rather than read off a published signature. A wrong name comes
back as a SOAP fault naming the parameter, so a first run is expected to have
failures; each probe reports and continues.

## Measuring the purchase backlog

```sh
bun run --cwd packages/yuki backlog
```

Counts the payments in Yuki that still have no invoice attached, by type and by
counterparty. This is the acceptance test for the FF-1446 purchase pipeline:
the count should fall as invoices are fetched, uploaded and matched. It will not
reach zero — some receipts are simply gone — but every item the pipeline can
resolve, it should. Read-only; prints to stdout and writes nothing.

It fails loudly on an outstanding-item type label it does not recognise. Those
labels are display strings in the session's language and payments carry no
stable id, so an unrecognised label means the classification can no longer be
trusted — see `OUTSTANDING_ITEM_TYPE_LABELS` in `src/types.ts`.

## Notes on the protocol

Classic ASMX, SOAP 1.1. Namespace `http://www.theyukicompany.com/`, SOAPAction
`"http://www.theyukicompany.com/{Operation}"`, `text/xml; charset=utf-8`,
posted to `/ws/{Service}.asmx`.

Parameters are emitted in the order given because ASMX validates against a
sequence — an out-of-order parameter is rejected even when every name is right.
`sessionID` always comes first, and is added automatically.

Several operations return a *string* containing further XML rather than nested
elements; call `parseXml` on those results to go a level deeper.

`sortOrder` parameters are **string enums**, not integers — see `src/types.ts`.
Not every operation takes `administrationID`: `DocumentsInFolder` and
`CostCategories` do not.

The GL account scheme spells one of its own fields `descripton`.

The free allowance is 1,000 calls a day per domain.
