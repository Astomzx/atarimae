/**
 * Response headers that limit what a browser will do with this origin.
 *
 * Written out rather than pulled from a library, because the value of each one
 * here is the failure it closes, and a header whose reason nobody can state is
 * a header nobody can safely change. There are eight of them and they are all
 * constants.
 *
 * The one that matters most for *this* product is `frame-ancestors 'none'`.
 * Atarimae's whole claim is that an acknowledgement means something: 確認 is a
 * record that a named person read a named revision at a named time, and
 * acknowledgement statistics are trustworthy because of it. A page that can be
 * framed can be covered by a transparent overlay, and then a click somewhere
 * else lands on 確認. Every constraint in announcement-model.md would still hold
 * — the row would be correct, the revision would be right, the timestamp would
 * be real — and the claim it exists to support would be false. Clickjacking is
 * not a generic web risk here; it is an attack on the product's thesis.
 */

import type { FastifyInstance } from "fastify";

import { DEFAULT_PROVIDER_ORDER } from "../services/call-providers.js";

/**
 * One policy for every response.
 *
 * Strict is affordable because the interface earns it: the built client loads
 * one external module script and one external stylesheet, uses no inline
 * `style` attributes and creates no blob URLs. Nothing here is a concession to
 * how the client happens to be written today, so a future concession would have
 * to be argued for rather than absorbed.
 */
function contentSecurityPolicy(callFrameOrigin?: string): string {
  return [
    "default-src 'self'",

    // No inline script and no eval. This is the difference between a stored XSS
    // being a bug and being an account takeover.
    "script-src 'self'",
    "style-src 'self'",

    // data: for the icons only. Attachments are served from this origin, and the
    // ones served inline are the formats whose bytes were verified on upload.
    "img-src 'self' data:",

    // The realtime socket. 'self' covers same-origin ws/wss in a current browser,
    // but not in every browser an office still has, and being explicit costs
    // nothing.
    "connect-src 'self' ws: wss:",

    "font-src 'self'",
    "manifest-src 'self'",

    // The PWA's service worker.
    "worker-src 'self'",

    // See the note at the top of this file. This is the important one, and it
    // does NOT move when a call provider is embedded — that is `frame-src`.
    "frame-ancestors 'none'",

    /*
     * One origin, and only when an administrator has marked a provider
     * embeddable. Not a wildcard, and the origin rather than the URL: a CSP
     * source carrying a path is ignored or misread depending on the directive,
     * and a provider URL contains the room id — which meeting is happening is
     * not a thing to put in a response header.
     */
    callFrameOrigin ? `frame-src ${callFrameOrigin}` : "frame-src 'none'",
    "object-src 'none'",

    // A <base> tag injected into the document would otherwise redirect every
    // relative URL on the page, including the ones the client posts to.
    "base-uri 'none'",

    // A form injected into the page cannot post the fields it collects anywhere
    // but back here.
    "form-action 'self'",
  ].join("; ");
}

export interface SecurityHeaderOptions {
  /** HSTS is only sent in production, where TLS is a documented requirement. */
  production: boolean;
  /**
   * Origin of an embeddable call provider, when an administrator has enabled
   * one. Widens `frame-src` and `permissions-policy`, and nothing else.
   *
   * Note which direction this is. `frame-src` says what *this* application may
   * put in a frame; `frame-ancestors` says who may put this application in
   * one. Only the first moves here — the clickjacking defence around 確認 is
   * `frame-ancestors 'none'` and it is untouched, which is the reason
   * embedding a call room turned out to be affordable at all.
   */
  callFrameOrigin?: string | undefined;
}

/**
 * What a CSP host-source can express: letters, digits, dots and hyphens.
 *
 * Stricter than what a URL parser will accept, and the gap is not theoretical.
 * `{` and `}` are not forbidden host code points, so
 * `https://{room}.meet.example.test/` parses happily and yields an "origin"
 * with braces in it — which as a CSP source matches nothing, in a header no
 * browser will complain about. An IPv6 literal is refused for the same reason:
 * `host-source` has no way to write one, so it could only be a directive that
 * quietly never matches.
 */
const CSP_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

/**
 * Scheme and host of a provider URL, or null if it is not a usable origin.
 *
 * Only the origin ever reaches a header. A CSP source carrying a path is
 * either ignored or misread depending on the directive, and a provider URL has
 * a room id in it — putting that in a response header would leak which meeting
 * is happening to anything that logs headers.
 */
export function frameOriginOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    if (!CSP_HOST.test(parsed.hostname)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function permissionsPolicy(callFrameOrigin?: string): string {
  if (!callFrameOrigin) {
    return "camera=(), microphone=(), geolocation=(), payment=()";
  }

  const only = `("${callFrameOrigin}")`;
  return [
    `camera=${only}`,
    `microphone=${only}`,
    `display-capture=${only}`,
    // Never, embedded or not.
    "geolocation=()",
    "payment=()",
  ].join(", ");
}

export function securityHeadersFor(
  options: SecurityHeaderOptions,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-security-policy": contentSecurityPolicy(options.callFrameOrigin),

    /*
     * The single most important header for a system that serves files somebody
     * else uploaded. The upload rules verify what a file is, and the download
     * route serves the type it determined rather than the one the uploader
     * claimed — but a browser that sniffs would second-guess both, and a .txt
     * whose contents are HTML would render as a page from this origin.
     *
     * The download route sets this itself as well. Deliberately duplicated: a
     * defence that exists in exactly one place is one refactor from existing in
     * none.
     */
    "x-content-type-options": "nosniff",

    /*
     * frame-ancestors already says this to anything from the last decade.
     * X-Frame-Options is here for whatever the office has that is older, and
     * because the cost is nineteen bytes.
     */
    "x-frame-options": "DENY",

    /*
     * Announcement and conversation URLs carry uuids that name real internal
     * things. There is nowhere off this origin they should be sent, and a
     * Referer header is a URL leaving the building in a request nobody looked
     * at.
     */
    "referrer-policy": "no-referrer",

    /** Nothing here is a plugin, and Flash's crossdomain.xml still gets read. */
    "x-permitted-cross-domain-policies": "none",

    /*
     * Camera and microphone are refused outright unless a call provider is
     * embedded, and then they are granted to *that origin only* — never to
     * this one. Atarimae itself never asks for either; the frame does.
     *
     * Without this the CSP would allow the frame and the browser would still
     * deny it a microphone, which is the worst of the three outcomes: a
     * meeting room that loads and cannot hear anybody, with nothing on screen
     * explaining why.
     */
    "permissions-policy": permissionsPolicy(options.callFrameOrigin),

    /** A cross-origin page cannot get a handle on this window. */
    "cross-origin-opener-policy": "same-origin",

    /** Nor load an attachment out of it as an image or a script. */
    "cross-origin-resource-policy": "same-origin",
  };

  if (options.production) {
    /*
     * One year, no includeSubDomains and no preload.
     *
     * includeSubDomains is the tempting one and it is the wrong default here:
     * this deployment is somebody's own domain, and the neighbouring subdomain
     * is as likely to be a printer's status page on plain HTTP as anything
     * else. Breaking an unrelated internal service from a header set by the
     * announcement board is not a trade this project gets to make on an
     * operator's behalf.
     */
    headers["strict-transport-security"] = "max-age=31536000";
  }

  return headers;
}

/**
 * The swagger UI is inline script and inline style by construction, and a
 * strict CSP makes it a blank page.
 *
 * It is only ever registered outside production, so the exemption cannot widen
 * a deployment's surface — but it is scoped to the prefix rather than skipped
 * globally in development, because "the headers are off in dev" is how a
 * missing header reaches production without anybody noticing it was missing.
 */
const DOCS_PREFIX = "/docs";

export function registerSecurityHeaders(app: FastifyInstance): void {
  /*
   * Built once and rebuilt when the call provider changes, rather than
   * assembled per request.
   *
   * A database read inside `onSend` would put a query on the path of every
   * response including the error ones — and a header that fails to be written
   * because a query failed is a security header that is missing exactly when
   * the system is unwell.
   */
  let headers = securityHeadersFor({
    production: app.config.NODE_ENV === "production",
  });

  /*
   * Readable as well as writable, because the join route has to answer "may
   * the client frame this?" and the only honest answer is the one the browser
   * will act on — which is this value, not the flag in the database.
   */
  let current: string | null = null;

  app.decorate("callFrameOrigin", { getter: () => current });

  app.decorate("refreshSecurityHeaders", (callFrameOrigin: string | null) => {
    current = callFrameOrigin;
    headers = securityHeadersFor({
      production: app.config.NODE_ENV === "production",
      callFrameOrigin: callFrameOrigin ?? undefined,
    });
  });

  app.addHook("onSend", async (request, reply) => {
    if (request.url === DOCS_PREFIX || request.url.startsWith(`${DOCS_PREFIX}/`)) {
      return;
    }
    for (const [name, value] of Object.entries(headers)) {
      reply.header(name, value);
    }
  });
}

/**
 * Reads the embeddable provider's origin, if there is one, and applies it.
 *
 * Called at startup and after a provider is written. Missing the refresh is a
 * frame that silently fails to load — or worse in the other direction, an
 * origin left in `frame-src` after the provider it belonged to was stopped —
 * so every call site matters. A failure here must never stop the server
 * starting: no origin means no embedding, which is the safe direction.
 *
 * The provider is chosen exactly as a call chooses one, and its `embeddable`
 * is read afterwards rather than being part of the WHERE clause. Filtering on
 * it instead would name the origin of an embeddable provider that calls do not
 * use, whenever an organisation has both kinds configured.
 */
export async function refreshCallFrameOrigin(app: FastifyInstance): Promise<void> {
  try {
    const { rows } = await app.db.query<{
      url_template: string | null;
      embeddable: boolean;
    }>(
      `SELECT url_template, embeddable FROM call_providers
        WHERE disabled_at IS NULL
        ${DEFAULT_PROVIDER_ORDER}
        LIMIT 1`,
    );

    const provider = rows[0];
    app.refreshSecurityHeaders(
      provider?.embeddable ? frameOriginOf(provider.url_template) : null,
    );
  } catch (error) {
    app.log.error({ err: error }, "could not read the call provider origin");
    app.refreshSecurityHeaders(null);
  }
}

/**
 * Whether a browser here would accept this URL in a frame.
 *
 * Compared against the origin currently in `frame-src` rather than read from
 * the provider row, because the two can differ and only one of them is what
 * the browser enforces: a call carries the join URL it was created with, and
 * the provider may have been changed or stopped since. Telling the client to
 * frame a URL the CSP refuses produces an empty panel and no explanation.
 */
export function mayBeFramed(
  /** Structural on purpose: the typed instance inside a route is not the plain one. */
  app: { readonly callFrameOrigin: string | null },
  joinUrl: string,
): boolean {
  const allowed = app.callFrameOrigin;
  return allowed !== null && frameOriginOf(joinUrl) === allowed;
}
