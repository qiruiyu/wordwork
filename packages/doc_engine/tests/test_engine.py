from __future__ import annotations

from pathlib import Path
import json
import tempfile
import unittest
import zipfile

from wordwork_doc_engine import (
    apply_decisions,
    compute_diff,
    generate_redline,
    merge_contributions,
    validate_docx,
)

CONTENT_TYPES = b'''<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'''
RELS = b'''<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'''


def make_docx(path: Path, paragraphs: list[str], cells: list[str] | None = None, *, external: bool = False) -> None:
    body = "".join(
        f'<w:p w14:paraId="{index:08X}"><w:r><w:t>{text}</w:t></w:r></w:p>'
        for index, text in enumerate(paragraphs, 1)
    )
    if cells:
        cell_xml = "".join(
            f'<w:tc><w:p w14:paraId="{(100 + index):08X}"><w:r><w:t>{text}</w:t></w:r></w:p></w:tc>'
            for index, text in enumerate(cells, 1)
        )
        body += f"<w:tbl><w:tr>{cell_xml}</w:tr></w:tbl>"
    document = f'''<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:body>{body}<w:sectPr/></w:body></w:document>'''.encode()
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("[Content_Types].xml", CONTENT_TYPES)
        archive.writestr("_rels/.rels", RELS)
        archive.writestr("word/document.xml", document)
        if external:
            archive.writestr("word/_rels/document.xml.rels", b'''<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Target="https://example.invalid" TargetMode="External" Type="x"/></Relationships>''')


def document_text(path: Path) -> str:
    with zipfile.ZipFile(path) as archive:
        return archive.read("word/document.xml").decode()


class EngineTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_chinese_diff_and_selected_decision(self) -> None:
        base, revised, result = self.root / "base.docx", self.root / "revised.docx", self.root / "clean.docx"
        make_docx(base, ["研究目标是提高效率。"])
        make_docx(revised, ["研究目标是显著提高效率。"])
        diff = compute_diff(base, revised, "张同学")
        self.assertTrue(diff.hunks)
        self.assertEqual(diff.hunks[0].author, "张同学")
        json.dumps(diff.to_dict(), ensure_ascii=False)
        apply_decisions(base, revised, diff, {diff.hunks[0].hunk_id: "accept"}, result)
        self.assertIn("显著", document_text(result))
        self.assertNotIn("w:ins", document_text(result))

    def test_table_cell_is_independent_block(self) -> None:
        base, revised = self.root / "base.docx", self.root / "revised.docx"
        make_docx(base, ["正文"], ["第一格", "第二格"])
        make_docx(revised, ["正文"], ["第一格", "已修改第二格"])
        diff = compute_diff(base, revised, "A")
        self.assertTrue(any(block.kind == "table_cell" for block in diff.revised_blocks))
        self.assertTrue(any("已修改" in hunk.revised_text for hunk in diff.hunks))

    def test_same_block_is_conflict_and_distinct_blocks_merge(self) -> None:
        base, one, two, merged = (self.root / name for name in ("base.docx", "one.docx", "two.docx", "merged.docx"))
        make_docx(base, ["甲", "乙"])
        make_docx(one, ["甲一", "乙"])
        make_docx(two, ["甲", "乙二"])
        result = merge_contributions(base, [(one, "甲同学"), (two, "乙同学")], merged)
        self.assertFalse(result.conflicts)
        self.assertIn("甲一", document_text(merged))
        self.assertIn("乙二", document_text(merged))
        make_docx(two, ["甲二", "乙"])
        conflict = merge_contributions(base, [(one, "甲同学"), (two, "乙同学")], self.root / "conflict.docx")
        self.assertEqual(1, len(conflict.conflicts))
        self.assertEqual("same_structural_block", conflict.conflicts[0].reason)
        resolved_path = self.root / "resolved.docx"
        resolved = merge_contributions(
            base,
            [(one, "甲同学"), (two, "乙同学")],
            resolved_path,
            {conflict.conflicts[0].match_key: "乙同学"},
        )
        self.assertFalse(resolved.conflicts)
        self.assertIn("甲二", document_text(resolved_path))

    def test_chinese_insertion_is_a_small_hunk(self) -> None:
        base, revised = self.root / "base.docx", self.root / "revised.docx"
        make_docx(base, ["研究目标是提高效率。"])
        make_docx(revised, ["研究目标是显著提高效率。"])
        diff = compute_diff(base, revised, "A")
        self.assertEqual("显著", diff.hunks[0].revised_text)

    def test_zip_slip_macro_and_external_relationships(self) -> None:
        bad = self.root / "bad.docx"
        with zipfile.ZipFile(bad, "w") as archive:
            archive.writestr("../escape.xml", "x")
            archive.writestr("word/vbaProject.bin", b"macro")
            archive.writestr("[Content_Types].xml", CONTENT_TYPES)
            archive.writestr("word/document.xml", b"<x/>")
        invalid = validate_docx(bad)
        self.assertFalse(invalid.valid)
        self.assertIn("zip_slip_path", invalid.errors)
        self.assertIn("macro_part_detected", invalid.errors)
        safe = self.root / "external.docx"
        make_docx(safe, ["文本"], external=True)
        warning = validate_docx(safe)
        self.assertTrue(warning.valid)
        self.assertTrue(any(item.startswith("external_relationship:") for item in warning.warnings))

    def test_builtin_redline_contains_native_revisions(self) -> None:
        base, revised, redline = self.root / "base.docx", self.root / "revised.docx", self.root / "redline.docx"
        make_docx(base, ["原句。"])
        make_docx(revised, ["新句。"])
        report = generate_redline(base, revised, "李", redline)
        self.assertEqual("builtin_ooxml", report.engine)
        xml = document_text(redline)
        self.assertIn("w:del", xml)
        self.assertIn("w:ins", xml)


if __name__ == "__main__":
    unittest.main()
