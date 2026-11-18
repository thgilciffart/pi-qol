# Publish to npm

## Publish an update

1. Push changes to `main` with Conventional Commit messages. Use `fix:` for a patch release, `feat:` for a minor release, and `!` for a breaking change. Before version 1.0, breaking changes bump the minor version.

2. Review the release PR that Release Please opens or updates. It changes `package.json`, `package-lock.json`, `CHANGELOG.md`, and `.release-please-manifest.json`.

3. Merge the release PR. The `publish.yml` workflow creates the version tag and GitHub release, then checks out that tag and publishes to npm. The publish hook runs type checking and the Bun test suite before publication.

4. Verify the published version after npm finishes processing the package.

   ```sh
	npm view @thgilciffart/pi-qol version --registry=https://registry.npmjs.org/
   ```

5. Install the release in Pi.

   ```sh
	pi install npm:@thgilciffart/pi-qol
   ```

   Run `/reload` in an open Pi session.

## Configure trusted publishing

In the npm package settings, create a GitHub Actions trusted publisher with these values:

- Organization or user: `thgilciffart`
- Repository: `pi-qol`
- Workflow filename: `publish.yml`
- Environment name: leave blank
- Allow `npm publish`: enabled

GitHub Actions must be allowed to create pull requests in the repository's Actions settings. No npm token or additional GitHub token is required. Publishing runs in the same workflow that creates the release.

A new npm trusted publisher must complete its first successful publish within two days. If the connection expires before that happens, delete it, recreate it, and rerun publication. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

## Retry a failed publication

Rerun the failed publish job from its workflow run. You can also run `publish.yml` manually against the release tag.

Each published npm version is immutable. Publish subsequent changes through a new release PR.

## Validate a package locally

Use Node.js 22.19 or later and Bun 1.4.4. Run these commands from the repository root:

```sh
	npm ci
	npm publish --dry-run
```

The publish hook runs type checking and tests. Check that the package includes the extension entry point, source files, export assets, documentation, and license.

## Check Pi package discovery

Keep `pi-package` in `package.json` under `keywords`. The `pi.extensions` manifest points to `./index.ts`.

After npm indexes the release, search for `@thgilciffart/pi-qol` in the [Pi package catalog](https://pi.dev/packages). Catalog visibility can lag publication. Publishing to GitHub alone does not create an npm package listing.
