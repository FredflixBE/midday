import { SCOPES } from "@api/utils/scopes";
import { OpenAPIHono } from "@hono/zod-openapi";
import { getApiUrl, getAppUrl } from "@midday/utils/envs";

const app = new OpenAPIHono();

const apiUrl = getApiUrl();
const dashboardUrl = getAppUrl();

const supportedScopes = SCOPES.filter(
  (s) => !s.startsWith("apis."),
) as string[];

const protectedResourceMetadata = {
  resource: apiUrl,
  authorization_servers: [apiUrl],
  scopes_supported: supportedScopes,
  // The API serves its own OpenAPI reference at the root.
  resource_documentation: apiUrl,
};

// RFC 9728: clients try the path-suffixed URL first (e.g. /oauth-protected-resource/mcp)
app.get("/oauth-protected-resource/*", (c) => {
  return c.json(protectedResourceMetadata);
});

app.get("/oauth-protected-resource", (c) => {
  return c.json(protectedResourceMetadata);
});

app.get("/oauth-authorization-server", (c) => {
  return c.json({
    issuer: apiUrl,
    authorization_endpoint: `${dashboardUrl}/oauth/authorize`,
    token_endpoint: `${apiUrl}/oauth/token`,
    registration_endpoint: `${apiUrl}/oauth/register`,
    revocation_endpoint: `${apiUrl}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: supportedScopes,
  });
});

export { app as wellKnownRouter };
