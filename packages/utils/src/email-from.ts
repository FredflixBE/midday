/**
 * Who this deployment's email comes from.
 *
 * Every address has to be one whose domain you have verified with the email
 * provider, or the message fails DKIM and lands in spam. That makes the
 * sender deployment configuration, not something a template can hardcode.
 */

const IDENTITY = /^\s*(.*?)\s*<\s*([^>]+?)\s*>\s*$/;

// RFC 5322 specials: a display name containing any of these has to be quoted,
// which matters because team names ("Acme, Inc.") reach this function.
const NEEDS_QUOTING = /["(),:;<>@[\\\]]/;

function formatDisplayName(name: string) {
  if (!NEEDS_QUOTING.test(name)) {
    return name;
  }

  return `"${name.replace(/([\\"])/g, "\\$1")}"`;
}

/**
 * The `from` header for an outgoing email.
 *
 * `EMAIL_FROM` holds the address, optionally with a default display name
 * (`Midday <midday@example.com>`); `EMAIL_FROM_NAME` overrides that name.
 * Pass `displayName` to send on someone's behalf — an invoice goes out under
 * the team's name, from your verified address.
 */
export function getEmailFrom(displayName?: string): string {
  const configured = process.env.EMAIL_FROM?.trim();

  if (!configured) {
    throw new Error(
      "EMAIL_FROM is not set. Set it to the address this instance sends from, e.g. 'Midday <midday@example.com>'.",
    );
  }

  const match = IDENTITY.exec(configured);
  const address = match ? match[2]! : configured;
  const name =
    displayName?.trim() ||
    process.env.EMAIL_FROM_NAME?.trim() ||
    match?.[1] ||
    "";

  return name ? `${formatDisplayName(name)} <${address}>` : address;
}
