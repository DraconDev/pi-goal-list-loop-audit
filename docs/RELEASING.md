# Releasing to npm

This repository publishes `pi-goal-list-loop-audit` through the GitHub Release
workflow at `.github/workflows/publish.yml`.

## One-time npm setup

In npm package settings, add a **Trusted Publisher** for:

- GitHub owner/repository: `DraconDev/pi-goal-list-loop-audit`
- workflow file: `.github/workflows/publish.yml`
- environment: leave unset unless the repository deliberately protects the job
  with an npm environment

The workflow uses npm OIDC provenance. Do not add a long-lived `NPM_TOKEN` to
the repository.

## Release checklist

Accumulated changes since the last release live under an `## Unreleased`
section at the top of `CHANGELOG.md`; each milestone gets its own
`## <version> — <one-line title> (<date>)` header plus `###` topic
subsections (e.g. `## 0.35.3 — live auditor clock and clearer recovery
timing (2026-08-15)`). The release commit promotes the `Unreleased` section
to the released version and leaves one empty `Unreleased` section for future
work. Update docs/INDEX.md to the new package version at the same time. Do not invent version headers for work that was
never tagged — untagged work stays under `Unreleased` until the release
commit.

```bash
npm version <major.minor.patch> --no-git-tag-version
npm run release:check
# review package.json + package-lock.json + changelog; let dracon-sync checkpoint
# verify the tested tree is committed before tagging (AGENTS.md history rules)
# create and push the matching tag, for example:
git tag v<major.minor.patch>
git push origin main v<major.minor.patch>
```

The sync daemon owns source/evidence commits. Do not amend, reset or rebase
its commits; a release tag must point at the reviewed, validated source. If the
daemon is paused, follow AGENTS.md's repo-local checkpoint identity rule.

When changing the Pi store thumbnail, update the SVG source and its PNG,
point `package.json`'s `pi.image` at the public asset, and inspect it at small
sizes. Use a new asset URL when replacing cached artwork. README and metadata
changes reach the store through the published npm tarball; a git push alone
does not update that package metadata.

Create a GitHub Release from that tag. Publishing happens only after the
release is marked **published**; the workflow checks that the tag equals the
`package.json` version, runs the complete test/typecheck/package inspection,
and then runs:

```bash
npm publish --provenance --access public
```

Verify availability from a separate machine or shell:

```bash
npm view pi-goal-list-loop-audit version dist-tags.latest
npm install -g pi-goal-list-loop-audit
# or in pi:
pi install npm:pi-goal-list-loop-audit
```

After installing in pi, run `/glla version` to confirm which package version
that running extension loaded. The command also prints the `npm view` check so
a stale global/package install is easy to spot; the registry query remains the
authoritative published-version check.

`publishConfig.access=public` is necessary for the scoped/public policy, but
it does not publish anything by itself. A commit, tag, or GitHub Release alone
is not proof that npm has the package; the registry check above is the proof.
