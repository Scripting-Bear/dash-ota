/**
 * Modular security plug-in interfaces. The core OTA flow depends only on these interfaces,
 * never on a concrete pinning/attestation implementation — so TLS pinning and device
 * attestation can be added later without touching the core (a hard requirement).
 *
 * v1 ships no-op implementations; drop in real ones later.
 */

/** Transport hardening (e.g. certificate / public-key pinning) applied to OTA requests. */
export interface TransportSecurity {
  /**
   * Wrap or replace `fetch` for OTA traffic. v1 returns the platform fetch unchanged; a
   * pinning implementation returns a fetch that rejects forged certificates.
   */
  fetch: typeof fetch;
}

/** Device/app integrity attestation (Play Integrity / App Attest). */
export interface IntegrityAttestor {
  /**
   * Produce an attestation token to attach to OTA requests, or null when unavailable.
   * v1 returns null (no attestation).
   */
  getAttestationToken: () => Promise<string | null>;
}

/** v1 no-op transport security: the platform fetch, unpinned. */
export const noopTransportSecurity: TransportSecurity = {
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
};

/** v1 no-op attestor: no token. */
export const noopIntegrityAttestor: IntegrityAttestor = {
  getAttestationToken: async () => null,
};
