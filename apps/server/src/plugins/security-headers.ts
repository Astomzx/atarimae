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

/**
 * One policy for every response.
 *
 * Strict is affordable because the interface earns it: the built client loads
 * one external module script and one external stylesheet, uses no inline
 * `style` attributes and creates no blob URLs. Nothing here is a concession to
 * how the client happens to be written today, so a future concession would have
 * to be argued for rather than absorbed.
 */
const CONTENT_SECURITY_POLICY = [
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

  // See the note at the top of this file. This is the important one.
  "frame-ancestors 'none'",

  // Nothing in this application embeds anything, or needs a plugin.
  "frame-src 'none'",
  "object-src 'none'",

  // A <base> tag injected into the document would otherwise redirect every
  // relative URL on the page, including the ones the client posts to.
  "base-uri 'none'",

  // A form injected into the page cannot post the fields it collects anywhere
  // but back here.
  "form-action 'self'",
].join("; ");

export interface SecurityHeaderOptions {
  /** HSTS is only sent in production, where TLS is a documented requirement. */
  production: boolean;
}

export function securityHeadersFor(
  options: SecurityHeaderOptions,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-security-policy": CONTENT_SECURITY_POLICY,

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

    /** No camera, microphone or location is ever asked for. Calls are external. */
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",

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
  const headers = securityHeadersFor({
    production: app.config.NODE_ENV === "production",
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
