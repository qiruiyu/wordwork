# wordwork DOCX engine

`wordwork_doc_engine` is the small, cross-platform DOCX safety, comparison and
merge layer used by wordwork. It deliberately does not automate Microsoft Word,
WPS, or Office COM. Its default implementation uses only Python's standard
library and changes only the OOXML part and paragraph/cell selected by a review
decision; all unrelated ZIP members are copied byte-for-byte.

## Install and test

```powershell
cd packages/doc_engine
py -3.12 -m pip install -e ".[test]"
py -3.12 -m pytest
```

Optional, separately licensed engines can be evaluated with
`pip install -e ".[redlines,revisions]"`. The built-in redline writer always
remains available and emits Word-native `w:ins` / `w:del` elements.

## API

```python
from wordwork_doc_engine import compute_diff, apply_decisions, merge_contributions

diff = compute_diff("base.docx", "student.docx", author="Li")
accepted = {h.hunk_id: "accept" for h in diff.hunks}
apply_decisions("base.docx", "student.docx", diff, accepted, "li-clean.docx")
result = merge_contributions("base.docx", [("li.docx", "Li")], "merged.docx")
```

Every returned value is a dataclass with `to_dict()` and contains only JSON-safe
values. `decisions` accepts a mapping of hunk IDs to `accept`, `reject`, booleans,
or objects containing a `decision` key.

## Safety boundary

The validator rejects non-DOCX ZIPs, macro parts (including macro content types),
encrypted entries, Zip Slip paths, over-100 MB inputs and suspicious compression.
External OOXML relationships are warnings: they are never fetched. This engine
does not treat successful validation as a malware scan.

The first release intentionally treats changed drawings, equations, fields,
charts, hyperlinks, content controls, headers/footers and footnotes as
high-risk structural changes. It reports them instead of silently merging them.
