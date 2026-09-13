import type { AccountType } from "./utils/account";

export type Providers = "gocardless" | "enablebanking";

export type ProviderParams = {
  provider: Providers;
};

export type Transaction = {
  id: string;
  amount: number;
  currency: string;
  date: string;
  status: "posted" | "pending";
  balance: number | null;
  category: string | null;
  counterparty_name: string | null;
  merchant_name: string | null;
  method: string;
  name: string;
  description: string | null;
  currency_rate: number | null;
  currency_source: string | null;
  /**
   * The identifiers the provider sends alongside the prose. A name is what a
   * human wrote; these are machine-issued and stable, which is what makes them
   * worth keeping. All nullable: not every provider sends them, and no
   * transaction stored before they were carried has them.
   */
  /** IBAN of the other party — never this account's own. */
  counterparty_iban: string | null;
  /** ISO 20022 bank transaction code family, e.g. `IDDT`, `ICDT`, `CCRD`. */
  bank_transaction_code: string | null;
  /** ISO 20022 sub-family, e.g. `PMDD`, `SALA`, `ESCT`. */
  bank_transaction_sub_code: string | null;
  /**
   * The bank's own identifier for the entry. Stored beside `id`, not as it:
   * `id` is the upsert key for everything already imported.
   */
  entry_reference: string | null;
};

export type Institution = {
  id: string;
  name: string;
  logo: string | null;
  provider: Providers;
};

export type Account = {
  id: string;
  name: string;
  currency: string;
  type: AccountType;
  institution: Institution;
  balance: Balance;
  enrollment_id: string | null;
  resource_id: string | null;
  expires_at: string | null;
  iban: string | null;
  subtype: string | null;
  bic: string | null;
  routing_number: string | null;
  wire_routing_number: string | null;
  account_number: string | null;
  sort_code: string | null;
  available_balance: number | null;
  credit_limit: number | null;
};

export type ConnectionStatus = {
  status: "connected" | "disconnected";
};

export type Balance = {
  amount: number;
  currency: string;
};

export type GetTransactionsRequest = {
  accountId: string;
  latest?: boolean;
  accessToken?: string;
  accountType: AccountType;
};

export type GetAccountsRequest = {
  id?: string;
  accessToken?: string;
  institutionId?: string;
};

export type GetAccountBalanceRequest = {
  accountId: string;
  accessToken?: string;
  accountType?: string;
};

export type GetAccountBalanceResponse = {
  currency: string;
  amount: number;
  available_balance: number | null;
  credit_limit: number | null;
};

export type DeleteAccountsRequest = {
  accountId?: string;
  accessToken?: string;
};

export type GetConnectionStatusRequest = {
  id?: string;
  accessToken?: string;
};

export type GetTransactionsResponse = Transaction[];

export type GetAccountsResponse = Account[];

export type GetInstitutionsResponse = {
  id: string;
  name: string;
  logo: string | null;
  provider: Providers;
}[];

export type GetInstitutionsRequest = {
  countryCode?: string;
};

export type HealthCheckResponse = {
  healthy: boolean;
};

export type GetHealthCheckResponse = {
  gocardless: HealthCheckResponse;
  enablebanking: HealthCheckResponse;
};

export type GetConnectionStatusResponse = ConnectionStatus;

export type DeleteConnectionRequest = {
  id: string;
  accessToken?: string;
};
