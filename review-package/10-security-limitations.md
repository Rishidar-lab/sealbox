# 10 — Security limitations

## What SealBox establishes when verification succeeds

* **Byte-level integrity relative to the signed digest** — the retrieved
  bytes hash to the SHA-256 in the signed record and match its recorded
  length.
* **Possession and use of the matching signing key** — the Ed25519
  signature over the canonical signed record verifies under the stored
  public key.
* **Integrity of the signed canonical manifest fields** — the digest,
  size, blob name, timestamp, network and public key are all covered by
  the signature.
* **Signer-address consistency** — the stored address is derived from the
  stored public key and compared. This is a *consistency* property.
* **Detection of post-signing modifications** to anything covered by the
  signed representation, or to the derived values.

## What SealBox does NOT establish

* **The legal identity of the human or operator behind the key.** The
  address is derived from the key; it says nothing about who holds it or
  whether they were authorised to sign.
* **Independent trusted timestamping.** `sealedAt` is the time the
  signing machine believed it was. The signature proves "the signer
  attested to this value" — not that a trusted authority witnessed the
  artifact's existence.
* **The truthfulness of statements inside a signed manifest.** A signed
  record faithfully carries what the signer put in it.
* **Permanent storage.** Shelby's "immutable blob" is the *provider's*
  model, not a SealBox guarantee.
* **Continuous Shelby availability**, or that the network, gateway or
  account remains reachable or solvent.
* **Third-party notarization.** No independent notary, attestation
  service or transparency log is involved.
* **Malware safety.** No content scanning or safety analysis of any kind.
* **Copyright or ownership.** A signature attests that a key signed a
  record; it settles nothing about who owns the content or whether the
  signer had the right to sign it.
* **Provenance predating the seal.** SealBox can only attest from the
  moment of signing; it cannot show the artifact existed, or who created
  it, before that.
* **Non-repudiation against the signer.** A signer can discard the key.
* **That the software has been externally audited.** The cryptography is
  implemented on top of `@aptos-labs/ts-sdk` and `@noble/curves` and
  exercised by this repository's own adversarial suite, but no third party
  has reviewed it.
* **That the key material is erased from memory.** `clear()` is a
  best-effort measure; JavaScript cannot guarantee erasure (immutable
  strings, GC copies, `BigInt` intermediates, register/stack residue).
* **Live Shelby interoperability** — see `07-live-shelby-evidence.md`.
