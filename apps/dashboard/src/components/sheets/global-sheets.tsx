"use client";

import { parseAsString, useQueryState } from "nuqs";
import { type ComponentType, useEffect, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { useCategoryParams } from "@/hooks/use-category-params";
import { useConnectParams } from "@/hooks/use-connect-params";
import { useCustomerParams } from "@/hooks/use-customer-params";
import { useDocumentParams } from "@/hooks/use-document-params";
import { useInboxParams } from "@/hooks/use-inbox-params";
import { useInvoiceParams } from "@/hooks/use-invoice-params";
import { useProductParams } from "@/hooks/use-product-params";
import { useTrackerParams } from "@/hooks/use-tracker-params";
import { useTransactionParams } from "@/hooks/use-transaction-params";
import { useSearchStore } from "@/store/search";
import { loadInvoiceSheet } from "./load-invoice-sheet";

// Every sheet is its own chunk, fetched the first time it opens instead of all
// of them after every page load.

/**
 * Like next/dynamic, without Suspense: React holds back a suspended boundary's
 * content for about 300 ms after its fallback shows, which a first open would
 * pay on top of the chunk itself. The component is kept in state instead and
 * renders as soon as its chunk has loaded.
 */
function lazySheet(load: () => Promise<ComponentType>) {
  let loaded: ComponentType | undefined;
  let loading: Promise<ComponentType> | undefined;

  const get = () => {
    loading ??= load().then((component) => {
      loaded = component;
      return component;
    });
    return loading;
  };

  return function LazySheet({ when }: { when: boolean }) {
    const [Component, setComponent] = useState(() => loaded);
    const [error, setError] = useState<unknown>();
    // Mounted from the first open on, so its close animation plays and a
    // second open is instant. `when` may be looser than the sheet's own open
    // state: that only fetches the chunk sooner, and the sheet still decides
    // whether it is open.
    const [opened, setOpened] = useState(when);

    if (when && !opened) {
      setOpened(true);
    }

    useEffect(() => {
      if (Component || !when) return;
      let current = true;
      get().then(
        (component) => {
          if (current) setComponent(() => component);
        },
        (reason: unknown) => {
          if (current) setError(reason);
        },
      );
      return () => {
        current = false;
      };
    }, [Component, when]);

    // The bundler's runtime keeps a failed chunk failed until the page
    // reloads, so there is nothing to retry here. Hand the error to the
    // nearest error boundary, as next/dynamic would.
    if (error) {
      throw error;
    }

    return Component && opened ? <Component /> : null;
  };
}

const ConnectTransactionsModal = lazySheet(() =>
  import("@/components/modals/connect-transactions-modal").then(
    (mod) => mod.ConnectTransactionsModal,
  ),
);
const ImportModal = lazySheet(() =>
  import("@/components/modals/import-modal").then((mod) => mod.ImportModal),
);
const SelectBankAccountsModal = lazySheet(() =>
  import("@/components/modals/select-bank-accounts").then(
    (mod) => mod.SelectBankAccountsModal,
  ),
);
const SearchModal = lazySheet(() =>
  import("@/components/search/search-modal").then((mod) => mod.SearchModal),
);
const AppDetailSheet = lazySheet(() =>
  import("./app-detail-sheet").then((mod) => mod.AppDetailSheet),
);
const CategoryCreateSheet = lazySheet(() =>
  import("./category-create-sheet").then((mod) => mod.CategoryCreateSheet),
);
const CategoryEditSheet = lazySheet(() =>
  import("./category-edit-sheet").then((mod) => mod.CategoryEditSheet),
);
const CustomerCreateSheet = lazySheet(() =>
  import("./customer-create-sheet").then((mod) => mod.CustomerCreateSheet),
);
const CustomerDetailsSheet = lazySheet(() =>
  import("./customer-details-sheet").then((mod) => mod.CustomerDetailsSheet),
);
const CustomerEditSheet = lazySheet(() =>
  import("./customer-edit-sheet").then((mod) => mod.CustomerEditSheet),
);
const DocumentSheet = lazySheet(() =>
  import("./document-sheet").then((mod) => mod.DocumentSheet),
);
const EditRecurringSheet = lazySheet(() =>
  import("./edit-recurring-sheet").then((mod) => mod.EditRecurringSheet),
);
const InboxDetailsSheet = lazySheet(() =>
  import("./inbox-details-sheet").then((mod) => mod.InboxDetailsSheet),
);
const InvoiceDetailsSheet = lazySheet(() =>
  import("./invoice-details-sheet").then((mod) => mod.InvoiceDetailsSheet),
);
const InvoiceSheet = lazySheet(() =>
  loadInvoiceSheet().then((mod) => mod.InvoiceSheet),
);
const ProductCreateSheet = lazySheet(() =>
  import("./product-create-sheet").then((mod) => mod.ProductCreateSheet),
);
const ProductEditSheet = lazySheet(() =>
  import("./product-edit-sheet").then((mod) => mod.ProductEditSheet),
);
const TrackerCreateSheet = lazySheet(() =>
  import("./tracker-create-sheet").then((mod) => mod.TrackerCreateSheet),
);
const TrackerScheduleSheet = lazySheet(() =>
  import("./tracker-schedule-sheet").then((mod) => mod.TrackerScheduleSheet),
);
const TrackerUpdateSheet = lazySheet(() =>
  import("./tracker-update-sheet").then((mod) => mod.TrackerUpdateSheet),
);
const TransactionCreateSheet = lazySheet(() =>
  import("./transaction-create-sheet").then(
    (mod) => mod.TransactionCreateSheet,
  ),
);
const TransactionEditSheet = lazySheet(() =>
  import("./transaction-edit-sheet").then((mod) => mod.TransactionEditSheet),
);
const TransactionSheet = lazySheet(() =>
  import("./transaction-sheet").then((mod) => mod.TransactionSheet),
);

function TrackerSheets() {
  const { update, create, projectId, range, selectedDate, eventId } =
    useTrackerParams();

  return (
    <>
      <TrackerUpdateSheet when={update !== null} />
      <TrackerCreateSheet when={Boolean(create)} />
      <TrackerScheduleSheet
        when={
          Boolean(projectId) ||
          Boolean(range?.length) ||
          Boolean(selectedDate) ||
          Boolean(eventId)
        }
      />
    </>
  );
}

function CategorySheets() {
  const { createCategory, categoryId } = useCategoryParams();

  return (
    <>
      <CategoryCreateSheet when={Boolean(createCategory)} />
      <CategoryEditSheet when={Boolean(categoryId)} />
    </>
  );
}

function CustomerSheets() {
  const { createCustomer, customerId } = useCustomerParams();

  return (
    <>
      <CustomerCreateSheet when={Boolean(createCustomer)} />
      <CustomerDetailsSheet when={Boolean(customerId)} />
      <CustomerEditSheet when={Boolean(customerId)} />
    </>
  );
}

function ProductSheets() {
  const { createProduct, productId } = useProductParams();

  return (
    <>
      <ProductCreateSheet when={Boolean(createProduct)} />
      <ProductEditSheet when={Boolean(productId)} />
    </>
  );
}

function TransactionSheets() {
  const { transactionId, createTransaction, editTransaction } =
    useTransactionParams();

  return (
    <>
      <TransactionSheet when={Boolean(transactionId)} />
      <TransactionCreateSheet when={Boolean(createTransaction)} />
      <TransactionEditSheet when={Boolean(editTransaction)} />
    </>
  );
}

function BankSheets() {
  const { step } = useConnectParams();

  return (
    <>
      <SelectBankAccountsModal when={step === "account"} />
      <ImportModal when={step === "import"} />
      <ConnectTransactionsModal when={step === "connect"} />
    </>
  );
}

function Search() {
  const isOpen = useSearchStore((state) => state.isOpen);
  const setOpen = useSearchStore((state) => state.setOpen);

  // Here rather than in the modal, which is not mounted until it first opens.
  useHotkeys("meta+k", () => setOpen(), {
    enableOnFormTags: true,
  });

  return <SearchModal when={isOpen} />;
}

function DocumentSheets() {
  const { params: documentParams } = useDocumentParams();
  const { params: inboxParams } = useInboxParams();

  return (
    <>
      <DocumentSheet
        when={Boolean(documentParams.filePath || documentParams.documentId)}
      />
      <InboxDetailsSheet when={inboxParams.inboxType === "details"} />
    </>
  );
}

function InvoiceSheets() {
  const { invoiceType, editRecurringId } = useInvoiceParams();

  return (
    <>
      <InvoiceDetailsSheet when={invoiceType === "details"} />
      <InvoiceSheet when={Boolean(invoiceType) && invoiceType !== "details"} />
      <EditRecurringSheet when={Boolean(editRecurringId)} />
    </>
  );
}

function AppSheets() {
  const [appId] = useQueryState("mcp-app", parseAsString);

  return <AppDetailSheet when={Boolean(appId)} />;
}

export function GlobalSheets() {
  return (
    <>
      <TrackerSheets />
      <CategorySheets />
      <CustomerSheets />
      <ProductSheets />
      <TransactionSheets />
      <BankSheets />
      <Search />
      <DocumentSheets />
      <InvoiceSheets />
      <AppSheets />
    </>
  );
}
