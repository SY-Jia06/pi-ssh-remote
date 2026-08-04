# Repository Instructions

## Commit convention

All commits must follow this format:

```text
<type>(<scope>): <description>
```

Examples:

```text
feat(remote): add connection retry support
fix(auth): handle expired SSH agent credentials
docs(readme): add release history
refactor(config): simplify endpoint loading
test(exec): cover command timeout behavior
chore(deps): update dependencies
```

Allowed types include `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `build`, `ci`, `perf`, `style`, and `revert`.

- Use a concise, lowercase, imperative description.
- Choose a short scope that identifies the affected component.
- Do not create commits whose subject does not follow this convention.

## Versioning

- Keep the package on the `0.1.x` line for small, backward-compatible features, behavior refinements, bug fixes, and documentation corrections.
- Increment the patch version for those release units, for example `0.1.4` to `0.1.5`.
- Use a new minor line such as `0.2.0` only for a substantial feature set or compatibility change that clearly warrants it.
- After `1.0.0`, follow standard Semantic Versioning: patch for fixes, minor for backward-compatible features, and major for breaking changes.
- Never create a version-only release. Every version bump must correspond to a tested, user-visible release unit.

## Required README release history

Every release must update both `README.md` and `README.zh-CN.md` in the same release commit.

- Add the newest version at the top of the release-history section.
- Record the exact npm publication date in `YYYY-MM-DD` format.
- Include separate `Added`, `Changed`, and `Fixed` sections in English and matching `新增`, `变更`, and `修复` sections in Chinese.
- Describe what was added, what observable behavior changed, and which bugs were fixed.
- Write `None` or `无` when a category has no entries; do not omit categories.
- Keep historical entries accurate. Never claim a code change when a release only changed package metadata.
- Do not publish until the README history describes the exact release artifact.

## Release alignment

For every release, keep all public release state aligned:

1. Update `README.md` and `README.zh-CN.md` release history.
2. Set the same version in `package.json` and `package-lock.json`.
3. Run extension-load validation, relevant tests, `git diff --check`, and `npm pack --dry-run`.
4. Commit the complete release unit using the commit convention.
5. Create an annotated Git tag named `v<version>` at that commit.
6. Push the release commit and tag to GitHub.
7. Publish the exact same version to npm.
8. Verify the npm version, Git commit, and Git tag all refer to the same release content.
9. Create a GitHub Release from the same tag when GitHub release credentials are available, using the matching README history entry as release notes.

## Release safety

- Do not publish to npm, push release commits/tags, or create GitHub Releases unless the user explicitly requests a release.
- Confirm the working tree contains only intended changes before committing or publishing.
- Do not reuse, overwrite, unpublish, or retag an existing released version to correct metadata; publish an appropriate subsequent version instead.
