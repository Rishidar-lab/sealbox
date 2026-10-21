# SealBox — Provenance and Authorship Record

This document records what the repository's own history proves about
authorship, copyright and AI assistance, and — equally important — what it
does **not** prove. It was prepared during the v0.3.0 finalization pass in
response to a known inconsistency: the `LICENSE` file carries
`Copyright (c) 2026 Manus`, while the repository and its authorship notes
refer to `Rishidar-lab`.

Sections are separated deliberately:

* **A.** Facts proven by repository history
* **B.** Project-maintainer identity
* **C.** Third-party code and dependencies
* **D.** AI-assisted / generated contributions
* **E.** Claims that cannot be proven from the repository

---

## A. Facts proven by repository history

Every item below is directly observable in git metadata or in the GitHub API.
Nothing here is inferred.

| # | Fact | Evidence |
|---|---|---|
| A1 | The repository is `Rishidar-lab/sealbox`, created 2026-06-21T10:08:09Z, default branch `main`, GitHub-declared license `MIT`. | `gh api repos/Rishidar-lab/sealbox` |
| A2 | The `LICENSE` file was created in the repository's **first commit** `4aad4a8` ("feat: complete sealbox CLI v0.1.0") and has never been modified since. | `git log --follow -- LICENSE`; `git blame LICENSE` |
| A3 | The copyright line has read `Copyright (c) 2026 Manus` since that first commit. | `git blame -L 3,3 LICENSE` → `^4aad4a8 (Manus 2026-06-21 …)` |
| A4 | Seven commits — the entire v0.1.0 and v0.2.0 implementation — are authored by `Manus <manus@manus.im>`: `4aad4a8`, `1a32cda`, `4a9b309`, `3c653f1`, `44f03b1`, `94d5200`, `3990727` (2026-06-21). | `git log --all --format='%an <%ae>'` |
| A5 | The `v0.2.0` tag points at `3990727`, one of those `Manus` commits. | `git for-each-ref refs/tags` |
| A6 | Five later commits are authored by `Rishi <135615893+Rishidar-lab@users.noreply.github.com>` — the GitHub noreply address of the `Rishidar-lab` account: `2dedda4` (added `AUTHORSHIP.md`), `74899d7`, `2751451`, `07def30` (merge of PR #1), plus the five v0.3.0 commits authored by the local identity `sealbox-release <release@rishidar-lab.invalid>`. | `git log --all` |
| A7 | One commit, `5b9a674` (2026-07-04, "docs: add professional README skeleton"), is authored by `Rishi Dhanasekaran <rishi@example.com>`. `example.com` is reserved by RFC 2606, so this is a placeholder address. | `git log --all`; `git show 5b9a674 --stat` |
| A8 | PR #1 ("Live-Shelby-ready sealbox v0.2.0") was **authored and merged** by the `Rishidar-lab` account on 2026-10-05. | `gh pr view 1` → `mergedBy: Rishidar-lab` |
| A9 | The domain `manus.im` resolves in public DNS. It is therefore **not** a reserved placeholder domain, unlike the `example.com` address in A7. | `getent hosts manus.im` |
| A10 | No vendored third-party source is tracked in the repository. There is no `vendor/`, `third_party/`, `lib/` or minified bundle directory; all third-party code arrives through npm dependencies. | `git ls-files`; `git ls-files \| grep -iE 'vendor\|third\|external\|bundle'` → no matches |
| A11 | The commit bodies of the original seven commits contain no `Co-authored-by:` trailers, no "Generated with …" footers and no other provenance markers. | `git log -1 --format=%B` for each of the seven |
| A12 | The word "Manus" appears exactly once in the tracked tree: the `LICENSE` copyright line. | `grep -rIn -i manus` (excluding `node_modules/`, `dist/`, `.git/`) |

### A13 — A documented contradiction

`AUTHORSHIP.md` as originally added in `2dedda4` states that "Rishidar-lab is
the owner, originator, and **sole human creator** of this project." The
commit metadata in A4 contradicts the "sole" claim: seven commits,
including the one that created the `LICENSE` with a different name on it,
carry the author identity `Manus <manus@manus.im>`. The two statements
cannot both be literally true.

This is recorded as a fact about the repository, not as a resolution of the
underlying question.

---

## B. Project-maintainer identity

* The GitHub account **`Rishidar-lab`** (display name "Rishi ") owns the
  repository, authored and merged PR #1, and is the account operating the
  v0.3.0 branch and PR #2.
* Under the MIT license in force, the maintainer controls the repository
  contents, the release process and the published package.
* The v0.3.0 work was committed under the local identity
  `sealbox-release <release@rishidar-lab.invalid>`. That is a machine
  identity created for this release pass, **not** a person and not a claim
  of legal authorship.

---

## C. Third-party code and dependencies

* All third-party code is consumed as npm dependencies and is not vendored
  (A10). Each dependency retains its own copyright and license.
* The `LICENSE` file covers "the Software" — the SealBox source in this
  repository — and does not purport to license any dependency.
* `@aptos-labs/ts-sdk` (Apache-2.0), `@noble/curves` (MIT), `@aws-sdk/client-s3` (Apache-2.0),
  `commander` (MIT) and `dotenv` (BSD-3-Clause) are used unmodified.
* `@noble/curves` is pinned to `2.2.0` — the exact version
  `@aptos-labs/ts-sdk@7.1.2` requires — so that SealBox's strict
  public-key validation and the SDK's verifier share one copy of the curve
  implementation.

---

## D. AI-assisted / generated contributions

* `AUTHORSHIP.md` discloses that "AI assistants, including Anthropic Claude,
  are used as development tools for research, coding, review, testing,
  documentation, and iteration", and that "project goals, architecture,
  product direction, prompts, acceptance or rejection of generated output,
  and final responsibility remain with Rishidar-lab".
* That disclosure is a statement by the maintainer. The repository contains
  no per-commit AI attribution (A11), so the **extent** of AI contribution
  to any specific file or commit is not provable from the repository.
* The v0.3.0 work in PR #2 was produced with AI assistance under the
  maintainer's direction and reviewed by it.

---

## E. Claims that CANNOT be proven from the repository

1. **Whether `Manus <manus@manus.im>` and `Rishidar-lab` are the same party.**
   Both identities exist in the history; the repository contains nothing that
   links them. The `manus.im` domain is real (A9) and is not a reserved
   placeholder.
2. **Whether "Manus" denotes a human, an organisation, a team identity, a
   pen name, or an automated/tool identity.** Nothing in the repository
   settles this. The name is plausible as a person or as a product name; the
   email domain is real; the commit bodies carry no markers either way.
3. **Whether the copyright in `LICENSE` vests in a party distinct from the
   current maintainer.** This is a legal question that a git history cannot
   answer. It is *not* established either way.
4. **Whether the original `manus@manus.im` identity is still reachable or
   still consents to the current maintenance arrangement.** Not observable
   from the repository.
5. **The authorship of the `rishi@example.com` commit `5b9a674`** beyond the
   fact that the local git identity was `Rishi Dhanasekaran` with a
   placeholder email.

---

## What was changed, and what was deliberately not changed

### Changed

* `AUTHORSHIP.md` — the unsupported "sole human creator" claim (A13) was
  replaced with wording that matches the commit metadata: Rishidar-lab is
  the owner and maintainer, earlier commits carry a different author
  identity, and AI assistance is disclosed. The AI-assistance disclosure is
  preserved verbatim in substance.
* `docs/PROVENANCE.md` — this document.

### Deliberately NOT changed

* **`LICENSE` was left byte-for-byte untouched.** The existing legal notice
  is preserved. The task rule allows the copyright line to be corrected
  "using the narrowest accurate change" **only if** repository history
  "clearly proves that 'Manus' is merely an erroneous template/generated
  placeholder and no third-party copyright ownership is being displaced".
  History does **not** show that: `manus.im` is a real domain (A9), the
  identity authored the entire pre-takeover codebase (A4) and created the
  `LICENSE` itself (A2, A3). Replacing the name could displace real
  third-party copyright ownership, so it was not done.
* **`package.json` `author`** was left as `Rishidar-lab`. It identifies the
  publisher/maintainer, which is accurate, and it matches the repository
  URL. If the maintainer prefers npm's `contributors` field to record the
  earlier author identity, that is a one-line metadata change and is
  recorded in §F below as an open option — not applied unilaterally.

### Open item for a human maintainer decision

**The `LICENSE` copyright line.** Two mutually exclusive readings remain
open and only the maintainer can settle them:

* *Reading 1 — same party.* `Manus` is an earlier or alternate identity of
  the maintainer. In that case the line is already correct and should stay
  exactly as it is.
* *Reading 2 — different party.* `Manus` is a separate contributor whose
  copyright should be acknowledged alongside the maintainer's. In that case
  the line should be amended to acknowledge both, and it is the maintainer's
  call whether to seek that party's confirmation.

What must **not** be done, under either reading, is replace the notice with
an unqualified "Copyright (c) 2026 Rishidar-lab", because that would assert
ownership the repository cannot substantiate.

---

## F. Suggested follow-up (not applied)

If the maintainer confirms Reading 1, the correct action is to leave
`LICENSE` unchanged and optionally record the identity link in
`AUTHORSHIP.md` — for example: "Earlier commits (2026-06-21) were authored
under the identity `Manus <manus@manus.im>`, which is the same party."

If the maintainer confirms Reading 2, the correct action is to add the
copyright holder to `LICENSE` and to `package.json`'s `contributors`, with
that party's agreement.

---

## G. Reproducing this analysis

```bash
git log --follow --format='%h %an <%ae> %ad %s' --date=short -- LICENSE
git blame LICENSE
git log --all --format='%h | %an <%ae> | %ad | %s' --date=short --reverse
git shortlog -sne --all
git for-each-ref refs/tags --format='%(refname:short) | %(objectname:short) | %(contents:subject)'
gh pr view 1 --json author,mergedBy,mergedAt
gh api repos/Rishidar-lab/sealbox --jq '{owner:.owner.login, created:.created_at, license:.license.spdx_id}'
grep -rIn -iE 'manus|co-authored|generated by|ai-assisted' . \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git --exclude=package-lock.json
```
