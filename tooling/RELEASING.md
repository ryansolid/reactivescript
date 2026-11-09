# Releasing the editor tools

A release is a version bump merged to `main`. The `editor` workflow
(`.github/workflows/editor.yml`) builds and tests as on every change, then
publishes each package whose version is new, from the `release` environment,
and tags it:

| package | where | how it signs in | tag |
| --- | --- | --- | --- |
| `tooling/rx-language-server` | npm, `@reactivescript/language-server` | trusted publishing (OIDC), no token | `language-server-v<version>` |
| `tooling/vscode-rx` | VS Marketplace | a Microsoft Entra identity (OIDC), or the secret `VSCE_PAT` | `vscode-v<version>` |
| `tooling/vscode-rx` | Open VSX (Cursor, VSCodium) | the secret `OVSX_PAT` | (the same) |

Nothing is published until the repository variable `RELEASES` is `on`.

## Once

**npm.** Create the `reactivescript` org on npmjs.com. npm configures trusted
publishing only on a package that exists, so it needs a first version by hand:
a placeholder, with no build,

```sh
npm login
npx setup-npm-trusted-publish @reactivescript/language-server
```

It publishes `0.0.0`, marked as a placeholder; the workflow's first release is
`0.1.0`.

Then, on the package's **Settings › Trusted publishing**, add GitHub Actions:
owner `solidjs`, repository `reactivescript`, workflow `editor.yml`,
environment `release`. (The repository moved from `ryansolid` to `solidjs` before
any publisher was set up; if it moves again, change the owner here.) Every
later version is published by the workflow, with provenance.

**VS Marketplace.** Create the `solidjs` publisher (shared with Solid's other extensions)
(marketplace.visualstudio.com/manage). Then either:

- a token: an Azure DevOps personal access token with **Marketplace › Manage**
  for all accessible organizations, as the secret `VSCE_PAT` on the `release`
  environment. Azure DevOps retires such global tokens on 2026-12-01; or
- no token: a Microsoft Entra managed identity (or app registration) with a
  federated credential for GitHub Actions (issuer
  `https://token.actions.githubusercontent.com`, subject
  `repo:solidjs/reactivescript:environment:release`), added to an Azure
  DevOps organization in the same tenant (so that it has a Marketplace
  profile) and to the publisher's **Members** as a Contributor; then the
  repository variables `AZURE_CLIENT_ID` and `AZURE_TENANT_ID`. The workflow
  signs in with `azure/login` and runs `vsce publish --azure-credential`.

**Open VSX.** Sign in at open-vsx.org with GitHub, sign the publisher
agreement, create a token, run `npx ovsx create-namespace solidjs -p
<token>`, and store the token as the secret `OVSX_PAT` on the `release`
environment. (Open VSX's trusted publishing is server-side work in progress,
eclipse-openvsx/openvsx#1980; switch when `ovsx` supports it.)

Finally set the repository variable `RELEASES` to `on`.

## Each release

Bump `version` in `tooling/rx-language-server/package.json` and/or
`tooling/vscode-rx/package.json` (and their `package-lock.json`, with
`npm version <patch|minor|major> --no-git-tag-version` in that folder), and
merge. A channel whose secret or identity is unset is skipped, and its tag is
not made, so it publishes on a later run.
