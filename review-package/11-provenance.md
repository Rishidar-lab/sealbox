# 11 — Provenance

Full forensic record: `docs/PROVENANCE.md`. Summary here.

## Facts proven by repository history

* The repository `Rishidar-lab/sealbox` was created 2026-06-21; the
  GitHub account `Rishidar-lab` owns it.
* The `LICENSE` file was created in the repository's **first commit**
  (`4aad4a8`) and has read `Copyright (c) 2026 Manus` since. It has
  never been modified.
* **Seven commits** — the whole v0.1.0 and v0.2.0 implementation — are
  authored by `Manus <manus@manus.im>`, including the one that created
  the `LICENSE`.
* The `v0.2.0` tag points at one of those commits.
* Five later commits are authored by `Rishi
  <135615893+Rishidar-lab@users.noreply.github.com>` — the GitHub
  noreply address of the `Rishidar-lab` account — including the commit
  that added `AUTHORSHIP.md` and the v0.2.0 merge.
* One commit (`5b9a674`) is authored by `Rishi Dhanasekaran
  <rishi@example.com>`; `example.com` is RFC 2606-reserved, so that is a
  placeholder address.
* The domain `manus.im` resolves in public DNS — it is **not** a reserved
  placeholder domain.
* No third-party source is vendored; all third-party code arrives through
  npm and retains its own licence.
* The word "Manus" appears exactly once in the tracked tree: the
  `LICENSE` copyright line.
* `AUTHORSHIP.md` as originally written claimed Rishidar-lab was the
  "sole human creator" — which the commit metadata contradicts.

## What was changed

* `AUTHORSHIP.md` — the unsupported "sole human creator" claim was
  replaced with wording that matches the commit metadata: Rishidar-lab
  maintains the repository, earlier commits carry a different author
  identity, AI assistance is disclosed.
* `docs/PROVENANCE.md` — the full record, separating what is proven from
  what is not.

## What was deliberately NOT changed

* **`LICENSE` is byte-for-byte untouched.** The rule allowing the
  copyright line to be corrected applies only when the history *clearly*
  shows "Manus" to be an erroneous template/generated placeholder and no
  third-party copyright ownership is displaced. It shows the opposite: a
  real domain, and an identity that authored the entire pre-takeover
  codebase and the `LICENSE` itself. Replacing the name could displace
  real ownership.
* **`package.json` `author`** was left as `Rishidar-lab` — the publisher
  and maintainer, which is accurate and matches the repository URL.

## Open item for a human maintainer

Two mutually exclusive readings remain, and only the maintainer can settle
them:

* **Same party** — "Manus" is an earlier or alternate identity of the
  maintainer. The notice is then already correct and should stay exactly
  as it is.
* **Different party** — "Manus" is a separate contributor whose copyright
  should be acknowledged alongside the maintainer's, with that party's
  agreement.

What must not happen under either reading is replacing the notice with an
unqualified "Copyright (c) 2026 Rishidar-lab", because the repository
cannot substantiate that.

The v0.3.0 release document is marked as carrying an **open provenance
question**, so the release is not represented as settled on this point.
