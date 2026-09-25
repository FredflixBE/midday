"use client";

import { parseAsString, useQueryState } from "nuqs";
import { type ComponentType, type ReactNode, useEffect, useState } from "react";
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
// of them after every page load. A sheet stays mounted once it has opened, so
// its close animation plays and a second open is instant.

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
    loading ??= load().then(
      (component) => {
        loaded = component;
        return component;
      },
      (error: unknown) => {
        // Let the next open try again, and say why this one showed nothing.
        loading = undefined;
        console.error("A sheet failed to load", error);
        throw error;
      },
    );
    return loading;
  };

  return function LazySheet() {
    const [Component, setComponent] = useState(() => loaded);

    useEffect(() => {
      if (Component) return;
      let current = true;
      get().then(
        (component) => {
          if (current) setComponent(() => component);
        },
        () => {},
      );
      return () => {
        current = false;
      };
    }, [Component]);

    return Component ? <Component /> : null;
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

/**
 * Mounts its sheet the first time `when` is true and keeps it mounted.
 * `when` may be looser than the sheet's own open state: mounting early only
 * fetches the chunk sooner, while the sheet still decides whether it is open.
 */
function OnceOpened({
  when,
  children,
}: {
  when: boolean;
  children: ReactNode;
}) {
  const [opened, setOpened] = useState(when);

  if (when && !opened) {
    setOpened(true);
  }

  return opened || when ? children : null;
}

function TrackerSheets() {
  const { update, create, projectId, range, selectedDate, eventId } =
    useTrackerParams();

  return (
    <>
      <OnceOpened when={update !== null}>
        <TrackerUpdateSheet />
      </OnceOpened>
      <OnceOpened when={Boolean(create)}>
        <TrackerCreateSheet />
      </OnceOpened>
      <OnceOpened
        when={
          Boolean(projectId) ||
          Boolean(range?.length) ||
          Boolean(selectedDate) ||
          Boolean(eventId)
        }
      >
        <TrackerScheduleSheet />
      </OnceOpened>
    </>
  );
}

function CategorySheets() {
  const { createCategory, categoryId } = useCategoryParams();

  return (
    <>
      <OnceOpened when={Boolean(createCategory)}>
        <CategoryCreateSheet />
      </OnceOpened>
      <OnceOpened when={Boolean(categoryId)}>
        <CategoryEditSheet />
      </OnceOpened>
    </>
  );
}

function CustomerSheets() {
  const { createCustomer, customerId } = useCustomerParams();

  return (
    <>
      <OnceOpened when={Boolean(createCustomer)}>
        <CustomerCreateSheet />
      </OnceOpened>
      <OnceOpened when={Boolean(customerId)}>
        <CustomerDetailsSheet />
        <CustomerEditSheet />
      </OnceOpened>
    </>
  );
}

function ProductSheets() {
  const { createProduct, productId } = useProductParams();

  return (
    <>
      <OnceOpened when={Boolean(createProduct)}>
        <ProductCreateSheet />
      </OnceOpened>
      <OnceOpened when={Boolean(productId)}>
        <ProductEditSheet />
      </OnceOpened>
    </>
  );
}

function TransactionSheets() {
  const { transactionId, createTransaction, editTransaction } =
    useTransactionParams();

  return (
    <>
      <OnceOpened when={Boolean(transactionId)}>
        <TransactionSheet />
      </OnceOpened>
      <OnceOpened when={Boolean(createTransaction)}>
        <TransactionCreateSheet />
      </OnceOpened>
      <OnceOpened when={Boolean(editTransaction)}>
        <TransactionEditSheet />
      </OnceOpened>
    </>
  );
}

function BankSheets() {
  const { step } = useConnectParams();

  return (
    <>
      <OnceOpened when={step === "account"}>
        <SelectBankAccountsModal />
      </OnceOpened>
      <OnceOpened when={step === "import"}>
        <ImportModal />
      </OnceOpened>
      <OnceOpened when={step === "connect"}>
        <ConnectTransactionsModal />
      </OnceOpened>
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

  return (
    <OnceOpened when={isOpen}>
      <SearchModal />
    </OnceOpened>
  );
}

function DocumentSheets() {
  const { params: documentParams } = useDocumentParams();
  const { params: inboxParams } = useInboxParams();

  return (
    <>
      <OnceOpened
        when={Boolean(documentParams.filePath || documentParams.documentId)}
      >
        <DocumentSheet />
      </OnceOpened>
      <OnceOpened when={inboxParams.inboxType === "details"}>
        <InboxDetailsSheet />
      </OnceOpened>
    </>
  );
}

function InvoiceSheets() {
  const { invoiceType, editRecurringId } = useInvoiceParams();

  return (
    <>
      <OnceOpened when={invoiceType === "details"}>
        <InvoiceDetailsSheet />
      </OnceOpened>
      <OnceOpened when={Boolean(invoiceType) && invoiceType !== "details"}>
        <InvoiceSheet />
      </OnceOpened>
      <OnceOpened when={Boolean(editRecurringId)}>
        <EditRecurringSheet />
      </OnceOpened>
    </>
  );
}

function AppSheets() {
  const [appId] = useQueryState("mcp-app", parseAsString);

  return (
    <OnceOpened when={Boolean(appId)}>
      <AppDetailSheet />
    </OnceOpened>
  );
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
