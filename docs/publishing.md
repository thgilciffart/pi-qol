# Publish to npm

Use Node.js 22.19 or later and Bun. Run these commands from the repository root.

## Publish the first release

1. Install the locked dependencies.

   ```sh
   npm ci
   ```

2. Sign in with an npm account that can publish under `@thgilciffart`.

   ```sh
   npm login --registry=https://registry.npmjs.org/
   npm whoami --registry=https://registry.npmjs.org/
   ```

3. Validate the release without uploading it.

   ```sh
   npm publish --dry-run
   ```

   The publish hook runs the typecheck and tests. Check the package file list in the output. It includes the extension entry point, source files, export assets, documentation, and license.

4. Publish version `0.1.0` as a public package.

   ```sh
   npm publish --access public
   ```

   Complete any authentication prompts in npm. The package manifest sets the public npm registry and public access.

5. Verify the published metadata.

   ```sh
   npm view @thgilciffart/pi-qol version keywords pi --json --registry=https://registry.npmjs.org/
   ```

6. Install the release in Pi.

   ```sh
   pi install npm:@thgilciffart/pi-qol
   ```

   Run `/reload` in an open Pi session.

## Check Pi package discovery

Keep `pi-package` in `package.json` under `keywords`. Pi's [package documentation](https://pi.dev/docs/latest/packages) identifies this keyword as the requirement for gallery discovery. The `pi.extensions` manifest points to `./index.ts`.

After npm indexes the release, search for `@thgilciffart/pi-qol` in the [Pi package catalog](https://pi.dev/packages). Catalog visibility can lag publication. Publishing to GitHub alone does not create an npm package listing.

## Publish an update

Commit your changes before you bump the version. Choose `patch`, `minor`, or `major` for the release.

```sh
npm version patch
npm publish --dry-run
npm publish --access public
git push origin main --follow-tags
```

npm does not allow reuse of a published name and version. See the [npm publish reference](https://docs.npmjs.com/cli/v11/commands/npm-publish/).
