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
const client = await yukiClientForTeam(db, teamId, {
  allowWriteOperations: ["UploadDocument"],
});
```

and gets that one operation and nothing else. Unknown operations fail closed,
on the grounds that an unclassified operation might be a write.

## Yuki belongs to a team

Yuki is an app a team connects in the app store, not a setting of the
installation (FF-1516). A team's access key, region and administration live in
its own `apps` row, with the key encrypted. A second team sees nothing from
Yuki until it connects an administration of its own.

Inside Midday there is one way to get a client:

```ts
import { yukiClientForTeam, YukiNotConnectedError } from "@midday/yuki/team";

const client = await yukiClientForTeam(db, teamId);
```

It throws `YukiNotConnectedError` for a team without a Yuki app, before
anything reaches the network. A scheduled Yuki job runs as **one** schedule
(the Trigger.dev free plan has no room for one per team) that fans out over
`getTeamIdsWithApp(db, "yuki")`, so an unconnected team is never in the list.
A per-team run that meets `YukiNotConnectedError` anyway — the team
disconnected in between — skips that team rather than failing.

`verifyAccess` is what the connect form calls: `Authenticate`,
`Administrations` and `DocumentFolders`, all reads. The last is there because a
wrong region passes the first two and fails only once the books are read.

## The archive

Yuki cannot be asked whether it already holds invoice number X. `SearchDocuments`
answers `Invalid Tab ID` for every tab tried, and there is no other keyed lookup.

It does not have to be asked. The whole archive is small enough to read entire —
**1,815 documents across 12 folders in 15 calls**, against a free allowance of
1,000 a day — so a job that needs the answer reads it, keeps it for the length of
its run, and asks it in memory (FF-1498):

```ts
const archive = await readYukiArchive(client);

archive.findInvoices("#SBIE-1234");  // invoices carrying that number
archive.findDocuments("#SBIE-1234"); // anything carrying it, of any type
```

**Asking twice with the same client reads once.** The archive is held against
the client, so a step that wants it can just ask rather than have it threaded
through every signature — and a loop over 200 inbox documents costs fifteen
calls, not three thousand. Two steps starting concurrently share one read
instead of racing into two.

The reuse is keyed on the **client instance**, and `yukiClientForTeam` builds a
new client every time it is called. So get the client once per run and pass
*that* down: a job that fetches its own client per inbox document gets a fresh
archive each time and never hits the reuse at all.

A deliberate re-read says so, and replaces what the client holds:

```ts
await readYukiArchive(client, { refresh: true });
```

That case is real — FF-1458 re-reads immediately before an upload run so an
invoice that arrived over Peppol minutes ago is not missed — and it has to be
sayable, or the reuse above would quietly defeat the freshness this design
exists for. A read that *fails* is never kept: the next caller tries again, and
if Yuki is down it fails too, rather than being handed a cached failure.

**Ask both, and treat the gap as a refusal to decide.** `findInvoices` answers
the question the books care about; `findDocuments` catches the document Yuki is
holding but has not classified as an invoice yet. The purchase folder has 5 of
those, 3 carrying a reference, and the folder the team sorts by hand has 30 more
with 13 references — a delivered invoice sits in exactly that state before Yuki
books it. A caller that only asked `findInvoices` would be told "not in Yuki"
about a document Yuki has, and would deliver it a second time; Yuki has no
delete operation, so that duplicate is permanent. Something from `findDocuments`
and nothing from `findInvoices` means FF-1493's *Needs attention*, never *send*.

### Why it is not a table

The first design mirrored the archive into `yuki_archive_documents` and kept it
current with a per-folder cursor. That was dropped, and the reason is worth
keeping, because a table looks like the obvious answer:

**Nothing needs one.** Every consumer — the decision pass (FF-1493), the Peppol
pull (FF-1450), the period audit (FF-1460) — is a batch job with nobody waiting.
The one screen showing Yuki's state (FF-1499) reads the document id already
stored on Midday's inbox row plus `OutstandingCreditorItems`, not the archive.
No page load has to answer from it, so fifteen calls in a job costs nothing
anyone can feel.

**And a stale answer here cannot be taken back.** A wrong *no* to "does Yuki
already hold this invoice?" uploads a duplicate into live books that Yuki has no
delete operation to remove. A mirror answers from yesterday when Yuki is
unreachable; a live read simply fails and the run is retried. Refusing to decide
is the right behaviour, and only this shape gets it for free.

The ticket asked for the mirror to be refreshed immediately before every use,
which is a cache with a lifetime of zero. If a synchronous, user-facing read of
the archive ever appears, that is the fact that reopens this. Nothing else does.

### Four things that are easy to get wrong

**Ask which folders exist.** Not `YUKI_FOLDERS` — that is Yuki's system set. A
domain also has folders the team made, and on the measured one those held 44
documents, 14 carrying a reference. Folder 6 turned out to be a user folder too.
A folder you do not read is a document you upload twice.

**Read from the epoch, not from a date window.** `ModifiedDocumentsInFolder` with
`modifiedSince` at `2000-01-01T00:00:00` returns a folder entire — verified
against Aankoop, which answered with all 722 of its documents. The alternative,
`DocumentsInFolder`, takes a start and an end date, and a date window is a way to
miss a document: the spike's 120-day check of the purchase folder missed an
OpenAI invoice from January that Yuki already held.

**Only `Type` 2 and 6 are invoices.** The numeric code is stable and
language-independent; `TypeDescription` is a display label in the session's
language, like the outstanding-item labels. It matters: 884 documents carry a
reference, and 106 of those are not invoices — bank statements, VAT returns,
journal entries — with 9 of them sharing a number with a real invoice. Without
the type filter, "does Yuki already hold this invoice?" is sometimes answered by
a bank statement.

**A reference with nothing comparable in it is refused, not answered.** This
cuts two ways, and they are different. On the *index* side, a document whose
reference is blank or pure punctuation is never indexed: it would key on the
empty string, as would all 900 unnumbered documents, and one lookup would claim
Yuki holds every one of them. On the *ask* side, `findInvoices` and
`findDocuments` **throw** `YukiReferenceError` rather than answering empty —
because empty means "Yuki does not hold this", the caller acts on that by
delivering the invoice, and Yuki has no delete operation. "I cannot answer" is
not "no". A caller that might hold an unusable number checks
`comparableInvoiceReference` first; it returns `null` rather than `""` so the
case cannot be used by accident.

Yuki's timestamps (`2026-09-06T11:31:38`, no timezone) are kept **as the strings
Yuki sent**. A `Date` would be a claim about which clock wrote them, invisible
once made. Amounts and dates are text for a different reason: they are for
display only, and a string is a value nothing can accidentally decide on
(FF-1493).

### Reading the archive against a real domain

```sh
bun run --cwd packages/yuki archive
```

Prints what it found: documents per folder, the type breakdown, how many carry an
invoice number, how many of those are not unique, and how many documents carry a
number that no *invoice* carries — 97 of them, on the measured domain. It then
checks the lookup end to end: every invoice number in the archive, asked for
exactly as Yuki wrote it, must find the document it came from, because
normalisation that loses a document is what ends in a duplicate upload. Reads
only, writes nothing, and prints no supplier, amount or invoice number — this
repository is public.

### Reading it the way Midday will

```sh
set -a; . apps/api/.env; set +a
bun run --cwd packages/yuki team-archive
```

The script above builds its client from `packages/yuki/.env`, which is the one
thing Midday may never do. This one goes through the team's own connection
instead — `getTeamIdsWithApp` → `yukiClientForTeam` → `readYukiArchive`, with the
access key decrypted out of the `apps` row — so it exercises the exact chain the
first scheduled Yuki job will run.

It also checks the part of that chain which is easy to get wrong: the archive is
reused per **client instance**, and `yukiClientForTeam` builds a new client on
every call. Asked twice with one client it reads once; given a second client it
reads again, because a second client is a second run.

Needs `DATABASE_URL` and `MIDDAY_ENCRYPTION_KEY`, and the key must be the one the
connection was encrypted with. Read-only on both sides — `SELECT` on `apps`, and
Yuki operations that are all on the read allowlist. Team ids are truncated in the
output, for the same reason nothing else here prints a supplier or an invoice
number.

## Setup, for the scripts

The scripts below are the only code that reads credentials from the
environment; `configFromEnv` lives in `scripts/` so that nothing in Midday can
import it.

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

## The card the bank will not share

KBC's open-banking consent page offers the current account and not the business
Mastercard, so Midday sees the monthly settlement and none of the charges behind
it — 68 of the 81 payments the books are waiting on an invoice for were card
charges nothing in Midday could see. Yuki has them, because the accountant
receives the card statement every month (FF-1517).

`src/card.ts` reads them. A card charge is **one booking with two lines**: the
card line on the card's own GL account, and a counterpart line for whatever the
money was spent on. Pairing those two produces everything:

```ts
const [scheme, lines, outstanding] = await Promise.all([
  fetchGLAccountScheme(client),
  fetchLedgerLines(client, { from: "2025-09-01", to: "2026-09-12" }),
  fetchOutstandingCreditorItems(client),
]);

const { charges, settlements } = readCardLedger({
  lines,
  cardAccountCode: findCardGLAccounts(scheme)[0].code,
  scheme,
  outstandingItemIds: new Set(
    outstanding.filter((i) => i.kind === "payment_awaiting_invoice").map((i) => i.id),
  ),
});
```

### Four things that are easy to get wrong here too

**Decide on the sub-type, never on the words.** `GetGLAccountScheme` gives every
account a numeric `subtype` — 52 is a credit card, 2 suppliers, 4 internal
transfers, 49 the current account — and those are stable and language
independent. The account's `descripton` (Yuki's own spelling) and the
description on a line ("Kaartverrichtingen", "Betaling — Uitgavenstaat") are
display strings in the session's language, the same trap as the outstanding-item
labels. Which card lines are charges and which are the monthly settlement is
decided on the counterpart account's sub-type alone.

**Pair against the adjacent line whatever account it landed on.** Two of 147
measured charges were booked straight to a cost account with no supplier line at
all. Pairing only against suppliers leaves those two unpaired, and unpaired means
*Needs attention* — someone asked to look at something perfectly in order.

**Read the ledger entire, not per account.** It follows from the above: the
counterpart can be anywhere. A year of a small company's books is 1,750 lines
and under a megabyte, in well under a second, so asking for everything costs one
call rather than two.

**The outstanding item's `ID` is the supplier line's id.** That is the whole
mechanism behind the status, verified across all 68: no amount is ever compared
across systems, because both lines come from one Yuki booking and the link into
the backlog is an identifier. The pair is still checked for an identical
description and exactly opposite amounts, and a failed check sends the charge to
*Needs attention* rather than guessing — the `hID` adjacency is observed rather
than documented, which is exactly why the verification stays.

`documentMatched.matchDate` is empty on every line. It is **not** an invoice
flag; do not read it. Nor is `foreignCurrency`: on all 159 measured card lines it
answered `EUR` at rate 1.000000, *including* the 59 charges made in dollars,
because it describes the booking rather than the card transaction. The original
currency is in the description and nowhere else.

### Checking it against a real domain

```sh
bun run --cwd packages/yuki card
```

Reports the cards it found, how each charge came out, and two cross-checks: that
nothing landed in Needs attention, and that the charges with no invoice are
exactly the card payments `backlog` counts. Exits non-zero if either fails.
Read-only, three calls, and it prints no merchant, supplier or invoice number.

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
Not every operation takes `administrationID`: `DocumentsInFolder`,
`ModifiedDocumentsInFolder`, `DocumentFolders` and `CostCategories` do not.

A list of one comes back as the element itself rather than an array of one, and
an empty list as `""` rather than an absent element — `{ "Documents": "" }`. Any
parser of a Yuki list has to handle all three.

The GL account scheme spells one of its own fields `descripton`.

The free allowance is 1,000 calls a day per domain.
