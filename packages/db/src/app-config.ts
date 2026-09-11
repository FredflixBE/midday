export type UnknownAppConfig = Record<string, unknown>;

export type SlackAppConfig = {
  access_token: string;
  team_id: string;
  team_name: string;
  channel: string;
  channel_id: string;
  slack_configuration_url: string;
  url: string;
  bot_user_id: string;
};

export type XeroAppConfig = {
  provider: "xero";
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  tenantId: string;
  tenantName?: string;
  scope: string[];
};

export type QuickBooksAppConfig = {
  provider: "quickbooks";
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  realmId: string;
  companyName?: string;
  scope: string[];
};

export type FortnoxAppConfig = {
  provider: "fortnox";
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  companyId: string;
  companyName?: string;
  scope: string[];
};

/**
 * Written and read only by `@midday/yuki/team`. Unlike the OAuth tokens above,
 * the key is encrypted at rest: it is a long-lived credential for the books.
 */
export type YukiAppConfig = {
  encryptedAccessKey: string;
  region: "be" | "nl";
  administrationId: string;
  administrationName: string;
};

export type AppConfigById = {
  slack: SlackAppConfig;
  xero: XeroAppConfig;
  quickbooks: QuickBooksAppConfig;
  fortnox: FortnoxAppConfig;
  yuki: YukiAppConfig;
};

export type KnownAppId = keyof AppConfigById;

export type AppConfigFor<TAppId extends string> = TAppId extends KnownAppId
  ? AppConfigById[TAppId]
  : UnknownAppConfig;

export type AnyTypedAppConfig = AppConfigById[KnownAppId];
export type AnyAppConfig = AnyTypedAppConfig | UnknownAppConfig;
