# Writing Hypervisor in Zig

![Lint](https://github.com/smallkirby/writing-hypervisor-in-zig/actions/workflows/lint.yml/badge.svg)
![Deploy](https://github.com/smallkirby/writing-hypervisor-in-zig/actions/workflows/deploy.yml/badge.svg)

Blog series where we write a hypervisor from scratch in Zig language, that can finally boot Linux kernel.

Refer to [smallkirby/ymir](https://github.com/smallkirby/ymir)'s `whiz-*` branches for the reference implementation.
Note that these branches might be not necessarily up-to-date.
Please refer to `master` branch to check available fixes and updates.

## Development

```sh
# Japanese
./scripts/serve.sh ja book
# English
./scripts/serve.sh en book/en
```

## Contributions

Request an update when you:

- Find a technical error in the description
- Find an expression that is hard to understand
- Find a typo or misspelling
- Find that the provided code does not work or is hard to understand
- Want to add a new topic that is not covered in this series
- Want to read the blog in a different language

You can create an issue or pull request to request an update or fix.
You don't need to create an issue before creating a pull request.
We welcome any requests or fixes.

## Translations

This blog series is available in the following languages:

- Japanese (Original)
- English

We use [google/mdbook-i18n-helpers](https://github.com/google/mdbook-i18n-helpers) to support multiple languages.
To update translations, use below commands:

```sh
# When original (Japanese) version is updated, run below command to update the POT file.
MDBOOK_OUTPUT='{"xgettext": {}}' mdbook build -d po
# Update translations
TARGET_LANG=en
msgmerge --update po/$TARGET_LANG.po po/messages.pot
```

`po` files can be edited using PO editors like [Poedit](https://poedit.net/).

## LICENSE

[CC0-1.0](LICENSE) except where otherwise [noted](./src/license.md).
