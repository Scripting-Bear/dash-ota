import type { NativeVersionPolicy, OtaLogger } from './types';

/**
 * The force-update policy travels **outside** the signed manifest — it is a sibling of it in the
 * `/check` response, not a field within it. Everything in it is therefore attacker-controllable
 * by whoever runs the update server, and `storeUrl` is the dangerous one: the gate that opens it
 * is a blocking, full-screen prompt, so a hostile value is a phishing redirect on every install.
 *
 * @module policy
 */

/** Schemes an app store link may use. Anything else is refused. */
const ALLOWED_STORE_SCHEMES = ['https://', 'market://', 'itms-apps://'];

/** True if `url` looks like an app store link rather than an arbitrary destination. */
export function isStoreUrl(url: string | undefined): url is string {
  return typeof url === 'string' && ALLOWED_STORE_SCHEMES.some((scheme) => url.startsWith(scheme));
}

/**
 * Replace the server's `storeUrl` with the one the app was built with.
 *
 * Fail-closed on purpose: a server-supplied URL is never passed through, even when it looks
 * harmless, because a scheme check cannot tell `https://your-store-listing` from
 * `https://attacker.example`. An app that configures nothing gets `undefined` and renders a gate
 * with no link, which is recoverable; a phishing redirect is not.
 *
 * `severity` and `minSupportedNativeVersion` are still the server's word — see the threat model.
 *
 * @param policy - the policy exactly as the server sent it.
 * @param configured - {@link OtaConfig.storeUrl}, the app's own listing.
 * @param logger - warned when a value is dropped, so the cause is visible in a release build.
 * @returns the policy with a trustworthy `storeUrl`, or none at all.
 */
export function resolvePolicy(
  policy: NativeVersionPolicy,
  configured: string | undefined,
  logger: OtaLogger,
): NativeVersionPolicy {
  if (configured !== undefined && !isStoreUrl(configured)) {
    logger.error(`config.storeUrl must start with ${ALLOWED_STORE_SCHEMES.join(', ')} — ignoring ${configured}`);
  }

  const trusted = isStoreUrl(configured) ? configured : undefined;

  if (trusted === undefined && policy.storeUrl !== undefined) {
    logger.warn(
      'the server sent a storeUrl but the policy is not signed, so it was dropped. ' +
        'Set config.storeUrl to your own store listing to give the update gate a link.',
    );
  }

  const { storeUrl: _ignored, ...rest } = policy;
  return trusted === undefined ? rest : { ...rest, storeUrl: trusted };
}
