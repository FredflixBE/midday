import { expect, test } from "bun:test";
import {
  transformAccount,
  transformBalance,
  transformTransaction,
} from "./transform";

test("Transform income transaction", () => {
  expect(
    transformTransaction({
      accountType: "depository",
      transaction: {
        entry_reference: "rtrhrth",
        merchant_category_code: null,
        transaction_amount: { currency: "SEK", amount: "25000.000" },
        creditor: null,
        creditor_account: {
          iban: "SE1750000000050401007804",
          other: {
            identification: "50401007804",
            scheme_name: "BBAN",
            issuer: null,
          },
        },
        creditor_agent: {
          bic_fi: "ESSESESSXXX",
          clearing_system_member_id: null,
          name: null,
        },
        debtor: null,
        debtor_account: null,
        debtor_agent: null,
        bank_transaction_code: {
          description: "Other",
          code: null,
          sub_code: null,
        },
        credit_debit_indicator: "CRDT",
        status: "BOOK",
        booking_date: "2024-04-04",
        value_date: "2024-04-04",
        transaction_date: null,
        balance_after_transaction: { currency: "XXX", amount: "25000.000" },
        reference_number: null,
        remittance_information: ["ÖVERF. SALDO"],
        debtor_account_additional_identification: null,
        creditor_account_additional_identification: null,
        exchange_rate: null,
        note: null,
        transaction_id: null,
      },
    }),
  ).toMatchSnapshot();
});

test("Transform expense transaction", () => {
  expect(
    transformTransaction({
      accountType: "depository",
      transaction: {
        entry_reference: "rtrhrth",
        merchant_category_code: null,
        transaction_amount: { currency: "SEK", amount: "25000.000" },
        creditor: null,
        creditor_account: {
          iban: "SE1750000000050401007804",
          other: {
            identification: "50401007804",
            scheme_name: "BBAN",
            issuer: null,
          },
        },
        creditor_agent: {
          bic_fi: "ESSESESSXXX",
          clearing_system_member_id: null,
          name: null,
        },
        debtor: null,
        debtor_account: null,
        debtor_agent: null,
        bank_transaction_code: {
          description: "Other",
          code: null,
          sub_code: null,
        },
        credit_debit_indicator: "CRDT",
        status: "BOOK",
        booking_date: "2024-04-04",
        value_date: "2024-04-04",
        transaction_date: null,
        balance_after_transaction: { currency: "XXX", amount: "25000.000" },
        reference_number: null,
        remittance_information: ["ÖVERF. SALDO"],
        debtor_account_additional_identification: null,
        creditor_account_additional_identification: null,
        exchange_rate: null,
        note: null,
        transaction_id: null,
      },
    }),
  ).toMatchSnapshot();
});

test("generateTransactionId - different nullable fields produce different IDs", () => {
  // Verifies fix for hash collision when different nullable fields have same value
  // e.g., reference_number="ABC" with null remittance_information should differ from
  // null reference_number with remittance_information=["ABC"]
  const baseTransaction = {
    entry_reference: null,
    transaction_id: null,
    merchant_category_code: null,
    transaction_amount: { currency: "SEK", amount: "100.00" },
    creditor: null,
    creditor_account: null,
    creditor_agent: null,
    debtor: null,
    debtor_account: null,
    debtor_agent: null,
    bank_transaction_code: null,
    credit_debit_indicator: "DBIT" as const,
    status: "BOOK",
    booking_date: "2024-01-01",
    value_date: "2024-01-01",
    transaction_date: null,
    balance_after_transaction: null,
    debtor_account_additional_identification: null,
    creditor_account_additional_identification: null,
    exchange_rate: null,
    note: null,
  };

  const txA = transformTransaction({
    accountType: "depository",
    transaction: {
      ...baseTransaction,
      reference_number: "ABC",
      remittance_information: null,
    },
  });

  const txB = transformTransaction({
    accountType: "depository",
    transaction: {
      ...baseTransaction,
      reference_number: null,
      remittance_information: ["ABC"],
    },
  });

  expect(txA.id).not.toBe(txB.id);
});

test("Transform credit card payment - should be credit-card-payment", () => {
  expect(
    transformTransaction({
      accountType: "credit",
      transaction: {
        entry_reference: "payment123",
        merchant_category_code: null,
        transaction_amount: { currency: "SEK", amount: "5000.00" },
        creditor: null,
        creditor_account: null,
        creditor_agent: null,
        debtor: { name: "BANK PAYMENT" },
        debtor_account: null,
        debtor_agent: null,
        bank_transaction_code: {
          description: "Payment",
          code: null,
          sub_code: null,
        },
        credit_debit_indicator: "CRDT",
        status: "BOOK",
        booking_date: "2024-04-04",
        value_date: "2024-04-04",
        transaction_date: null,
        balance_after_transaction: null,
        reference_number: null,
        remittance_information: ["Credit Card Payment"],
        debtor_account_additional_identification: null,
        creditor_account_additional_identification: null,
        exchange_rate: null,
        note: null,
        transaction_id: null,
      },
    }),
  ).toMatchSnapshot();
});

test("Transform account", () => {
  expect(
    transformAccount({
      account_id: { iban: "SE234234234" },
      all_account_ids: [],
      account_servicer: {
        bic_fi: "SEB",
        clearing_system_member_id: {
          clearing_system_id: "SEB",
          member_id: 1234567890,
        },
        name: "Example AB",
      },
      name: "Example AB",
      details: "Example AB",
      usage: "Example AB",
      cash_account_type: "CACC",
      product: "Enkla sparkontot företag",
      currency: "SEK",
      psu_status: "Authorized",
      credit_limit: { currency: "SEK", amount: "1000000" },
      postal_address: {
        address_type: "Example AB",
        department: "Example AB",
        sub_department: "Example AB",
        street_name: "Example AB",
        building_number: "Example AB",
        post_code: "Example AB",
        town_name: "Example AB",
        country_sub_division: "Example AB",
        country: "Example AB",
        address_line: ["Example AB"],
      },
      uid: "83435345-d61cb425f293",
      identification_hash: "3234.3GP8GRsZp9MO9sZwxoW/Fy+5rUBIsFLHcrXP8GZ/rv4=",
      identification_hashes: [
        "WwpbCiJhY2NvdW50IiwKImFjY291bnRfaWQiLAoiaWJhbiIKXQpd.KkjllfGbO16fy8adk4+6HI8PXQeZx7pBd+Fnir6svTU=",
      ],
      institution: { name: "SEB", country: "SE" },
      balance: {
        name: "",
        balance_amount: { currency: "SEK", amount: "90737.960" },
        balance_type: "ITAV",
        last_change_date_time: "2024-03-06",
        reference_date: "2024-03-06",
        last_committed_transaction: "1234567890",
      },
      legal_age: true,
      valid_until: "2024-03-06",
    }),
  ).toMatchSnapshot();
});

test("Transform account balance - depository", () => {
  expect(
    transformBalance({
      balance: {
        name: "",
        balance_amount: { currency: "SEK", amount: "90737.960" },
        balance_type: "ITAV",
        last_change_date_time: "2024-03-06",
        reference_date: "2024-03-06",
        last_committed_transaction: "1234567890",
      },
      accountType: "depository",
    }),
  ).toMatchSnapshot();
});

test("Transform account balance - credit with negative balance (normalized)", () => {
  // Safety: if Enable Banking ever returns negative credit balance, normalize it
  expect(
    transformBalance({
      balance: {
        name: "",
        balance_amount: { currency: "EUR", amount: "-1500.00" },
        balance_type: "CLBD",
        last_change_date_time: "2024-03-06",
        reference_date: "2024-03-06",
        last_committed_transaction: "1234567890",
      },
      accountType: "credit",
    }),
  ).toEqual({
    amount: 1500,
    currency: "EUR",
    available_balance: null, // CLBD is not an available balance type
    credit_limit: null,
  });
});

test("Transform account balance - credit with positive balance (stays positive)", () => {
  expect(
    transformBalance({
      balance: {
        name: "",
        balance_amount: { currency: "EUR", amount: "2000.00" },
        balance_type: "CLBD",
        last_change_date_time: "2024-03-06",
        reference_date: "2024-03-06",
        last_committed_transaction: "1234567890",
      },
      accountType: "credit",
    }),
  ).toEqual({
    amount: 2000,
    currency: "EUR",
    available_balance: null,
    credit_limit: null,
  });
});

test("Transform account balance - interimAvailable returns available_balance", () => {
  // interimAvailable is an available balance type and should populate available_balance
  expect(
    transformBalance({
      balance: {
        name: "",
        balance_amount: { currency: "EUR", amount: "5000.00" },
        balance_type: "interimAvailable",
        last_change_date_time: "2024-03-06",
        reference_date: "2024-03-06",
        last_committed_transaction: "1234567890",
      },
      accountType: "depository",
    }),
  ).toEqual({
    amount: 5000,
    currency: "EUR",
    available_balance: 5000,
    credit_limit: null,
  });
});

test("Transform account balance - interimBooked does NOT return available_balance", () => {
  // interimBooked is a booked/posted balance, NOT available funds
  // This test verifies the fix for the bug where .includes("interim") incorrectly matched interimBooked
  expect(
    transformBalance({
      balance: {
        name: "",
        balance_amount: { currency: "EUR", amount: "5000.00" },
        balance_type: "interimBooked",
        last_change_date_time: "2024-03-06",
        reference_date: "2024-03-06",
        last_committed_transaction: "1234567890",
      },
      accountType: "depository",
    }),
  ).toEqual({
    amount: 5000,
    currency: "EUR",
    available_balance: null, // Should be null - interimBooked is NOT an available balance
    credit_limit: null,
  });
});

test("Transform account balance - closingAvailable returns available_balance", () => {
  expect(
    transformBalance({
      balance: {
        name: "",
        balance_amount: { currency: "EUR", amount: "3000.00" },
        balance_type: "closingAvailable",
        last_change_date_time: "2024-03-06",
        reference_date: "2024-03-06",
        last_committed_transaction: "1234567890",
      },
      accountType: "depository",
    }),
  ).toEqual({
    amount: 3000,
    currency: "EUR",
    available_balance: 3000,
    credit_limit: null,
  });
});

test("Transform account balance - closingBooked does NOT return available_balance", () => {
  expect(
    transformBalance({
      balance: {
        name: "",
        balance_amount: { currency: "EUR", amount: "3000.00" },
        balance_type: "closingBooked",
        last_change_date_time: "2024-03-06",
        reference_date: "2024-03-06",
        last_committed_transaction: "1234567890",
      },
      accountType: "depository",
    }),
  ).toEqual({
    amount: 3000,
    currency: "EUR",
    available_balance: null,
    credit_limit: null,
  });
});

const xxxTestAccountBase = {
  all_account_ids: [],
  account_servicer: {
    bic_fi: "TESTBIC",
    clearing_system_member_id: { clearing_system_id: "TEST", member_id: 1 },
    name: "Test Bank",
  },
  name: "Test Account",
  details: "Test",
  usage: "PRIV",
  cash_account_type: "CACC",
  product: "Current Account",
  currency: "XXX",
  psu_status: "Authorized",
  postal_address: {
    address_type: "",
    department: "",
    sub_department: "",
    street_name: "",
    building_number: "",
    post_code: "",
    town_name: "",
    country_sub_division: "",
    country: "DE",
    address_line: [],
  },
  identification_hashes: [],
  institution: { name: "Test Bank", country: "DE" },
  legal_age: true,
  valid_until: "2024-06-06",
};

test("Transform account - XXX currency resolved from balance", () => {
  const result = transformAccount({
    ...xxxTestAccountBase,
    account_id: { iban: "DE89370400440532013000" },
    uid: "xxx-test-uid",
    identification_hash: "xxx-hash",
    balance: {
      name: "",
      balance_amount: { currency: "EUR", amount: "5000.00" },
      balance_type: "interimAvailable",
      last_change_date_time: "2024-03-06",
      reference_date: "2024-03-06",
      last_committed_transaction: "1234567890",
    },
  });

  expect(result.currency).toBe("EUR");
  expect(result.balance.currency).toBe("EUR");
});

test("Transform account - XXX preserved when balance also XXX", () => {
  const result = transformAccount({
    ...xxxTestAccountBase,
    account_id: { iban: "DE89370400440532013001" },
    uid: "xxx-test-uid-2",
    identification_hash: "xxx-hash-2",
    balance: {
      name: "",
      balance_amount: { currency: "XXX", amount: "3000.00" },
      balance_type: "interimBooked",
      last_change_date_time: "2024-03-06",
      reference_date: "2024-03-06",
      last_committed_transaction: "1234567890",
    },
  });

  expect(result.currency).toBe("XXX");
  expect(result.balance.currency).toBe("XXX");
});

test("Transform account balance - credit with negative balance and available type normalizes both amount and available_balance", () => {
  expect(
    transformBalance({
      balance: {
        name: "",
        balance_amount: { currency: "EUR", amount: "-1500.00" },
        balance_type: "interimAvailable",
        last_change_date_time: "2024-03-06",
        reference_date: "2024-03-06",
        last_committed_transaction: "1234567890",
      },
      accountType: "credit",
    }),
  ).toEqual({
    amount: 1500,
    currency: "EUR",
    available_balance: 1500,
    credit_limit: null,
  });
});

test("Transform balance - available_balance from balances array when primary is booked", () => {
  expect(
    transformBalance({
      balance: {
        name: "",
        balance_amount: { currency: "SEK", amount: "273048.86" },
        balance_type: "ITBD",
        last_change_date_time: "2024-03-06",
        reference_date: "2024-03-06",
        last_committed_transaction: "1234567890",
      },
      balances: [
        {
          name: "",
          balance_amount: { currency: "SEK", amount: "273048.86" },
          balance_type: "ITBD",
          last_change_date_time: "2024-03-06",
          reference_date: "2024-03-06",
          last_committed_transaction: "1234567890",
        },
        {
          name: "",
          balance_amount: { currency: "SEK", amount: "270206.25" },
          balance_type: "ITAV",
          last_change_date_time: "2024-03-06",
          reference_date: "2024-03-06",
          last_committed_transaction: "1234567890",
        },
      ],
      accountType: "depository",
    }),
  ).toEqual({
    amount: 273048.86,
    currency: "SEK",
    available_balance: 270206.25,
    credit_limit: null,
  });
});

test("Transform balance - ITAV primary returns available_balance directly", () => {
  expect(
    transformBalance({
      balance: {
        name: "",
        balance_amount: { currency: "SEK", amount: "90737.96" },
        balance_type: "ITAV",
        last_change_date_time: "2024-03-06",
        reference_date: "2024-03-06",
        last_committed_transaction: "1234567890",
      },
      accountType: "depository",
    }),
  ).toEqual({
    amount: 90737.96,
    currency: "SEK",
    available_balance: 90737.96,
    credit_limit: null,
  });
});

test("Transform balance - multi-currency available_balance matches primary currency", () => {
  expect(
    transformBalance({
      balance: {
        name: "",
        balance_amount: { currency: "EUR", amount: "9436.86" },
        balance_type: "ITBD",
        last_change_date_time: "2024-03-06",
        reference_date: "2024-03-06",
        last_committed_transaction: "1234567890",
      },
      balances: [
        {
          name: "",
          balance_amount: { currency: "DKK", amount: "9.76" },
          balance_type: "ITAV",
          last_change_date_time: "2024-03-06",
          reference_date: "2024-03-06",
          last_committed_transaction: "1234567890",
        },
        {
          name: "",
          balance_amount: { currency: "EUR", amount: "9200.00" },
          balance_type: "ITAV",
          last_change_date_time: "2024-03-06",
          reference_date: "2024-03-06",
          last_committed_transaction: "1234567890",
        },
      ],
      accountType: "depository",
    }),
  ).toEqual({
    amount: 9436.86,
    currency: "EUR",
    available_balance: 9200,
    credit_limit: null,
  });
});

test("Transform balance - XXX currency resolved from balances array", () => {
  expect(
    transformBalance({
      balance: {
        name: "",
        balance_amount: { currency: "XXX", amount: "1000.00" },
        balance_type: "interimBooked",
        last_change_date_time: "2024-03-06",
        reference_date: "2024-03-06",
        last_committed_transaction: "1234567890",
      },
      balances: [
        {
          name: "",
          balance_amount: { currency: "XXX", amount: "1000.00" },
          balance_type: "interimBooked",
          last_change_date_time: "2024-03-06",
          reference_date: "2024-03-06",
          last_committed_transaction: "1234567890",
        },
        {
          name: "",
          balance_amount: { currency: "EUR", amount: "1000.00" },
          balance_type: "closingBooked",
          last_change_date_time: "2024-03-06",
          reference_date: "2024-03-06",
          last_committed_transaction: "1234567890",
        },
      ],
    }),
  ).toEqual({
    amount: 1000,
    currency: "EUR",
    available_balance: null,
    credit_limit: null,
  });
});

test("Transform balance - XXX preserved when all balances are XXX", () => {
  expect(
    transformBalance({
      balance: {
        name: "",
        balance_amount: { currency: "XXX", amount: "500.00" },
        balance_type: "interimBooked",
        last_change_date_time: "2024-03-06",
        reference_date: "2024-03-06",
        last_committed_transaction: "1234567890",
      },
      balances: [
        {
          name: "",
          balance_amount: { currency: "XXX", amount: "500.00" },
          balance_type: "interimBooked",
          last_change_date_time: "2024-03-06",
          reference_date: "2024-03-06",
          last_committed_transaction: "1234567890",
        },
      ],
    }),
  ).toEqual({
    amount: 500,
    currency: "XXX",
    available_balance: null,
    credit_limit: null,
  });
});

// The identifiers Enable Banking sends on every transaction. These used to be
// dropped: a name was kept and the machine-readable key beside it thrown away.
// FF-1557.
const sepaDirectDebit = {
  entry_reference: "2026061800123456",
  merchant_category_code: null,
  transaction_amount: { currency: "EUR", amount: "142.50" },
  creditor: { name: "XERIUS VZW" },
  creditor_account: { iban: "BE68539007547034" },
  creditor_agent: null,
  debtor: null,
  debtor_account: { iban: "BE71096123456769" },
  debtor_agent: null,
  bank_transaction_code: {
    description: "Domiciliëring",
    code: "IDDT",
    sub_code: "PMDD",
  },
  credit_debit_indicator: "DBIT" as const,
  status: "BOOK",
  booking_date: "2026-06-18",
  value_date: "2026-06-18",
  transaction_date: null,
  balance_after_transaction: { currency: "EUR", amount: "4200.00" },
  reference_number: null,
  remittance_information: ["Sociale bijdragen Q2"],
  debtor_account_additional_identification: null,
  creditor_account_additional_identification: null,
  exchange_rate: null,
  note: null,
  transaction_id: null,
};

test("Outgoing payment carries the creditor IBAN, the SEPA code and the entry reference", () => {
  const transaction = transformTransaction({
    accountType: "depository",
    transaction: sepaDirectDebit,
  });

  // The party paid, not our own account.
  expect(transaction.counterparty_iban).toBe("BE68539007547034");
  expect(transaction.bank_transaction_code).toBe("IDDT");
  expect(transaction.bank_transaction_sub_code).toBe("PMDD");
  expect(transaction.entry_reference).toBe("2026061800123456");
});

test("Incoming payment carries the debtor IBAN as the counterparty", () => {
  const transaction = transformTransaction({
    accountType: "depository",
    transaction: {
      ...sepaDirectDebit,
      credit_debit_indicator: "CRDT",
      creditor: null,
      creditor_account: { iban: "BE71096123456769" },
      debtor: { name: "EXAMPLE CUSTOMER BV" },
      debtor_account: { iban: "BE62510007547061" },
      bank_transaction_code: {
        description: "Overschrijving",
        code: "RCDT",
        sub_code: "ESCT",
      },
    },
  });

  expect(transaction.counterparty_iban).toBe("BE62510007547061");
  expect(transaction.bank_transaction_code).toBe("RCDT");
  expect(transaction.bank_transaction_sub_code).toBe("ESCT");
});

test("The identifiers are null when the bank sends none of them", () => {
  const transaction = transformTransaction({
    accountType: "depository",
    transaction: {
      ...sepaDirectDebit,
      entry_reference: null,
      creditor_account: null,
      debtor_account: null,
      bank_transaction_code: null,
    },
  });

  expect(transaction.counterparty_iban).toBeNull();
  expect(transaction.bank_transaction_code).toBeNull();
  expect(transaction.bank_transaction_sub_code).toBeNull();
  expect(transaction.entry_reference).toBeNull();
});

test("A bank transaction code with no sub code keeps the family on its own", () => {
  const transaction = transformTransaction({
    accountType: "depository",
    transaction: {
      ...sepaDirectDebit,
      bank_transaction_code: {
        description: "Other",
        code: "FTDP",
        sub_code: null,
      },
    },
  });

  expect(transaction.bank_transaction_code).toBe("FTDP");
  expect(transaction.bank_transaction_sub_code).toBeNull();
});

test("The entry reference is kept beside the transaction id, not instead of it", () => {
  // The id is the upsert key for every transaction already stored. Carrying the
  // entry reference must not change how it is derived.
  const withoutReference = transformTransaction({
    accountType: "depository",
    transaction: { ...sepaDirectDebit, entry_reference: null },
  });

  expect(withoutReference.entry_reference).toBeNull();
  expect(withoutReference.id).not.toBe("2026061800123456");
  expect(withoutReference.id).toMatch(/^[0-9a-f]{32}$/);
});
