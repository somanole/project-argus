# Third-party notices

Argus's source code is original work released under the [MIT License](LICENSE). The only
third-party material bundled in this repository is the two font families below, which
carry their own licence.

---

## Fonts

**Files:** `apps/web/src/styles/theme/fonts/` —
`InterVariable.woff2`, `InterVariable-Italic.woff2`, `CommitMonoVariable.woff2`

| Font | Copyright | Licence |
|---|---|---|
| **Inter** | © The Inter Project Authors (Rasmus Andersson) | SIL Open Font License 1.1 |
| **Commit Mono** | © Eigil Nikolajsen | SIL Open Font License 1.1 |

Both are redistributable under the [SIL Open Font License 1.1](https://openfontlicense.org/),
which requires that the copyright and licence notice accompany the font files and that the
fonts are not sold on their own. Neither font may be redistributed under a Reserved Font
Name that has been changed.

To remove them entirely, delete `apps/web/src/styles/theme/fonts/`, drop the `@font-face`
rules in `apps/web/src/styles/theme/fonts.scss`, and point `--font-family` /
`--font-family--monospace` in `apps/web/src/styles/theme/tokens.scss` at system fonts.
Nothing else references them.

---

## Runtime dependencies

npm dependencies are not vendored into this repository; each retains its own licence as
declared in its package metadata. Generate a current inventory with:

```bash
pnpm licenses list
```

---

## Trademarks

**n8n** is a trademark of n8n GmbH. Argus is an independent project and is not affiliated
with, endorsed by, or sponsored by n8n GmbH. The n8n name is used only to describe
interoperability. Argus contains no n8n source code.
