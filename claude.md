# Claude Code Instructions

## NPM Package Installation

When installing NPM packages, always pin to exact versions to prevent supply chain attacks from malicious updates:

```bash
npm install --save-exact <package-name>
```

Or when using shorthand:

```bash
npm i -E <package-name>
```

This ensures the `package.json` records the exact version (e.g., `1.2.3`) rather than a range (e.g., `^1.2.3`), preventing automatic installation of potentially compromised newer versions.

## Git Commits

Always use the [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) standard for commit messages.

**Important:** Never add "Co-authored-by: Claude Code", "Generated with Claude Code", or any similar AI attribution lines to commit messages.

### Commit Message Structure

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

### Types

| Type | Description | SemVer |
|------|-------------|--------|
| `feat` | A new feature | MINOR |
| `fix` | A bug fix | PATCH |
| `docs` | Documentation only changes | - |
| `style` | Changes that do not affect the meaning of the code (white-space, formatting, missing semi-colons, etc.) | - |
| `refactor` | A code change that neither fixes a bug nor adds a feature | - |
| `perf` | A code change that improves performance | PATCH |
| `test` | Adding missing tests or correcting existing tests | - |
| `build` | Changes that affect the build system or external dependencies (example scopes: gulp, broccoli, npm) | - |
| `ci` | Changes to CI configuration files and scripts (example scopes: Travis, Circle, BrowserStack, SauceLabs) | - |
| `chore` | Other changes that don't modify src or test files | - |
| `revert` | Reverts a previous commit | - |

### Scope

The scope provides additional contextual information and is contained within parentheses:

```
feat(parser): add ability to parse arrays
fix(api): handle null response from server
```

### Description

- Use imperative, present tense: "add" not "added" nor "adds"
- Don't capitalize the first letter
- No period (.) at the end

### Body

- Use imperative, present tense
- Should include motivation for the change and contrast with previous behavior
- Separated from description by a blank line

### Footer(s)

Footers follow the git trailer format: `token: value` or `token #value`

#### Breaking Changes

Breaking changes MUST be indicated by either:

1. `!` after type/scope: `feat(api)!: remove deprecated endpoints`
2. `BREAKING CHANGE:` footer (must be uppercase)

Breaking changes correlate with MAJOR in SemVer.

```
feat(api)!: send an email to the customer when a product is shipped

BREAKING CHANGE: `extends` key in config file is now used for extending other config files
```

#### Other Footers

```
Reviewed-by: Z
Refs: #123
Fixes: #456
Co-authored-by: Name <email>
```

### Examples

**Simple feature:**
```
feat: add hat wobble
```

**Feature with scope:**
```
feat(lang): add Polish language
```

**Fix with body:**
```
fix: prevent racing of requests

Introduce a request id and a reference to latest request. Dismiss
incoming responses other than from latest request.
```

**Breaking change with ! and footer:**
```
refactor!: drop support for Node 6

BREAKING CHANGE: refactor to use JavaScript features not available in Node 6.
```

**Commit with multi-paragraph body and multiple footers:**
```
fix: prevent racing of requests

Introduce a request id and a reference to latest request. Dismiss
incoming responses other than from latest request.

Remove timeouts which were used to mitigate the racing issue but are
obsolete now.

Reviewed-by: Z
Refs: #123
```

**Revert commit:**
```
revert: let us never again speak of the noodle incident

Refs: 676104e, a]]215868
```