# Third-party notices

`wordwork-doc-engine` has no required runtime dependency beyond Python's standard
library.  It can be installed with the optional `redlines` and `revisions` extras
to evaluate the following independently licensed projects:

* [Python-Redlines](https://github.com/JSv4/Python-Redlines), MIT
* [docx-revisions](https://github.com/balalofernandez/docx-revisions), MIT

Neither optional project is imported by the deterministic fallback in this package.
Their precise installed versions must be recorded by the deploying application.
