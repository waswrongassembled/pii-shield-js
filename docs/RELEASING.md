# Releasing

Releases are staged on npm as `@waswrongassembled/pii-shield` by `.github/workflows/release.yml` when a tag `v<version>` is pushed, and go live when a maintainer approves them with 2FA ([staged publishing](https://docs.npmjs.com/staged-publishing)). The workflow uses npm Trusted Publishing (OIDC): there is no `NPM_TOKEN` secret, and every release gets a provenance attestation that links it to the commit and workflow run.

## One-time setup

1. **npm account and scope.** The scope `@waswrongassembled` is the npm user (or organization) `waswrongassembled`. Create that account on npmjs.com if it does not exist and enable two-factor authentication.
2. **Public GitHub repository.** Provenance needs a public repository; `repository.url` in `package.json` must stay `git+https://github.com/waswrongassembled/pii-shield-js.git`.
3. **Trusted publisher on npmjs.com.** In the package settings ("Trusted Publisher", GitHub Actions) enter:
   - organization or user: `waswrongassembled`
   - repository: `pii-shield-js`
   - workflow filename: `release.yml`
   - environment: `npm`
   - permissions: `npm stage publish` only (the workflow runs `npm stage publish`; a plain `npm publish` from it is rejected)

   A new configuration must be validated by a successful publish from the workflow within 2 days, otherwise it expires and has to be created again. The configuration for this package was created on 21.11.2026.

   If npmjs.com only offers these settings for a package that already exists, publish 0.1.0 once by hand from a clean checkout of the tagged commit (`npm ci && npm run check && npm publish --access public`, logged in as `waswrongassembled`), then configure the trusted publisher; every later release goes through the workflow. The workflow skips publishing a version that is already on npm, so the tag of a hand-published version still runs green (0.1.0 was published this way). Check the current npm documentation on trusted publishing for this.

4. **GitHub environment `npm`.** Created on the first run; under Settings → Environments add yourself as required reviewer and limit it to tags `v*`, so a publish needs an approval.
5. Optional, after the first trusted release: in the npm package settings require two-factor authentication and disallow tokens, so only the workflow can publish.

## Release steps

1. On a branch: set the version (`npm version <x.y.z> --no-git-tag-version`), move the entries under "Unreleased" in `CHANGELOG.md` to a new section with the version and the release date (`YYYY-MM-DD`, as Keep a Changelog wants it) and update the compare links at the bottom.
2. Run `npm run check && npm run check:package && npm run test:package`, open a PR, merge it after CI is green.
3. Tag the merge commit on `main` and push the tag:

   ```sh
   git switch main && git pull
   git tag -a v0.1.0 -m "v0.1.0"
   git push origin v0.1.0
   ```

4. The workflow checks that the tag equals `v` + the `package.json` version and runs all checks and the tarball smoke test. Then it waits for the `npm` environment approval: Actions → the run → **Review deployments** → tick `npm` → **Approve and deploy**. It stages the version with `npm stage publish`. A run started by hand (`workflow_dispatch`) must be started on the tag.
5. Approve the staged version with 2FA: npmjs.com → account settings → **Staged Packages** → **Approve**, or `npm stage list @waswrongassembled/pii-shield` and `npm stage approve <stage-id>`. Approving needs an interactive login, OIDC tokens cannot approve.
6. Check the result: `npm view @waswrongassembled/pii-shield version`, and the provenance badge on npmjs.com. Create the GitHub release from the tag with the CHANGELOG section as notes.

A version cannot be published twice. If the publish step fails after npm accepted the package, do not re-tag: fix forward with the next patch version.
